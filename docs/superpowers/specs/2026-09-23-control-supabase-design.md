# Backend Sync v2: control all of Supabase from ~/Backend

Date: 2026-09-23 · Status: draft for Zac's review · Builds on `2026-09-22-backend-sync-design.md`

## Intent

**What Zac said:** Backend Sync should do more than sync rows. It should control everything: create
tables, change the schema, create whole projects, and manage auth users, storage, RLS and SQL. It will
be used by both Zac and AI agents, **mostly AI agents**. Additive changes can happen freely.
**Destructive changes wait for Zac to approve them** (answer "a"). The interface is the folder, with a
SQL inbox as the catch-all (approach B).

**Assumptions:** there is one Mac and one Supabase account. The first real targets are QWeb's database
and the personal site's; the throwaway `backend-sync-test` project is where everything gets tried first.

**Success:** an agent (or Zac) can create a table, add a column, add a user, upload a file or add an RLS
policy just by writing a file in `~/Backend`, and can read back what happened. Nothing that loses data
happens without a click in the menu window. Zac never has to copy an API key again.

## The one rule: additive runs, destructive waits

"Destructive" means an action that loses existing data or structure and can't be undone from the app's
own restore log. Destructive actions are held in the **approval queue** until Zac clicks Approve in the
menu window. Everything else runs at once.

| Runs at once | Waits for Approve |
|---|---|
| New table, new column, new index, view, policy, function, trigger | Drop or rename a table, column, policy or function |
| New rows; row edits (the old version is already logged for Restore) | Deleting rows: all of them now, not only saves that delete more than 5 |
| New auth user (no email sent) and metadata edits | Deleting a user |
| New bucket; new or changed storage file (old version snapshotted) | Deleting a file or a bucket |
| SQL whose statements are all on the allowlist (see SQL inbox) | Any other SQL, including anything that fails to parse |
| — | **Creating a project** (it may cost money) *(default; Zac can flip this)* |

The rule lives in one module (`src/gate.js`). Each feature asks it for a verdict; none decides for itself.
When Zac uses a destructive button himself in the menu, a native confirm dialog counts as the approval.

Tightening the delete rule (every row delete now waits, not only saves that delete more than 5 rows)
follows from answer "a". It's also the change existing users will notice most.

## Section 1: Account connection

- **One-time setup:** in the window, paste a Supabase **personal access token** (Account → Access
  Tokens). It's encrypted with `safeStorage` like today's keys and is never written anywhere under
  `~/Backend`.
- **Project picker:** the app calls `GET /v1/organizations` and `GET /v1/projects` and lists every
  project with a checkbox. Ticking one fetches its secret key through `GET /v1/projects/:ref/api-keys`
  (with `reveal`), stores it the same way the current keys are stored, and starts syncing into
  `~/Backend/<project name>/`.
- **Existing projects** connected with a raw key (like `Test`) keep working unchanged. Once a token is
  set, "Add a project" becomes the picker. The raw-key form stays reachable as "Connect with a key
  instead".
- **New project:** the menu has "New project…" with name, organization, region (default `ca-central-1`)
  and plan. The database password is generated and stored in the Keychain. An agent can request one by
  writing `~/Backend/_new-project.json` (`{"name": …, "region": …}`). Either way the request lands in
  the approval queue, then `POST /v1/projects` runs, the app polls until the project is healthy, and
  syncing starts.
- **Credentials boundary:** agents never see the token or any key. They only touch files, and the app is
  the only thing holding credentials.

## Section 2: What the folder looks like

```
~/Backend/
  _new-project.json            agent request for a new project (consumed and moved to _requests/done)
  <Project>/
    _schema.md                 generated: tables, columns, types, RLS on/off, policies, functions,
                               buckets, and how to use every file below. Agents read this first.
    <table>.xlsx | .json       rows, as today
    _sql/inbox/*.sql           agents drop SQL here
    _sql/waiting/              held for approval (with a .why.txt beside each)
    _sql/done/                 <time>-<name>.sql plus <time>-<name>.result.json
    _auth/users.json           auth users, synced like a table
    _storage/<bucket>/…        each bucket is a folder of real files
    .sync/                     app state, as today
```

`_schema.md` is rewritten after every schema change, so an agent can always re-read the current state
before acting.

## Section 3: Features

### Tables and columns from files
- **New file:** a new `<name>.xlsx` or `<name>.json` in a project folder creates table `<name>`.
  - Column types are inferred from the values: whole numbers become `bigint`, decimals `numeric`,
    true/false `boolean`, ISO dates `timestamptz`, objects and arrays `jsonb`, anything else `text`.
    An empty column becomes `text`.
  - If the file has no `id` column, one is added: `bigint generated by default as identity primary key`.
  - **RLS is on by default, with no policies.** The site's publishable key can't read the table until an
    agent adds a policy through the SQL inbox. `_schema.md` says so next to the table.
  - The table is added to the `supabase_realtime` publication, then the file's rows are pushed.
- **New column header:** a new header in `.xlsx`, or a new key in `.json`, adds that column
  (`ALTER TABLE … ADD COLUMN`) with the inferred type.
- **Removed column header:** the column is dropped, after Approve. This replaces today's "pause until
  confirmed".
- **Deleted table file:** the table is dropped, after Approve. Until then the app leaves Supabase alone and
  shows the item in the queue. Rejecting it recreates the file from Supabase.
- **Renamed file:** a missing file plus a new file with the same columns and ids in the same scan is
  proposed as a rename, after Approve. Renames break any site code that uses the old name, which is why
  they wait.
- The schema DDL runs through the Management API's SQL endpoint, one transaction per change.

### SQL inbox
- Agents write `<Project>/_sql/inbox/<name>.sql`. The app picks it up within seconds.
- **Classifier (fail-safe allowlist):** the file is split into statements by a small tokenizer that
  understands quotes, `$$` bodies and comments. The file runs at once only if **every** statement is one
  of:
  - `CREATE TABLE | INDEX | VIEW | SCHEMA | TYPE | SEQUENCE | POLICY | TRIGGER | EXTENSION`
  - `CREATE FUNCTION`, but not `CREATE OR REPLACE`
  - `INSERT`, `SELECT`, `COMMENT ON`, `GRANT`
  - `ALTER TABLE … ADD COLUMN | ADD CONSTRAINT | ENABLE ROW LEVEL SECURITY`
  - `ALTER PUBLICATION supabase_realtime ADD TABLE`

  Everything else waits, including `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER … DROP | RENAME | TYPE`,
  `REVOKE`, `CREATE OR REPLACE`, `DO` blocks, and anything the tokenizer can't split.
- **Running:** `POST /v1/projects/:ref/database/query`, with the whole file wrapped in one transaction so
  it all applies or none of it does.
- **Result:** the file moves to `_sql/done/` next to `<name>.result.json`:
  `{ status: "ran" | "failed" | "rejected", classification, ran_at, rows (first 100), error }`.
  A held file moves to `_sql/waiting/` with a `.why.txt` naming the statement that caused the hold.

### Auth users
- `_auth/users.json` syncs through the Auth admin API using the project's secret key.
- **Columns:** `id`, `email`, `phone`, `user_metadata`, `app_metadata`, and read-only `created_at`,
  `last_sign_in_at` and `confirmed_at`.
- A new entry with an `email` and no `id` creates the user **without sending an email**. Sending invites
  is out of scope for v2, since it's outward-facing.
- Editing metadata updates the user. Removing an entry deletes the user, after Approve.

### Storage
- Each bucket is a folder under `_storage/`. A new folder creates a **private** bucket.
- A new or changed file uploads. The previous version is snapshotted in `.sync/` first, so Restore works
  the same as it does for rows.
- Deleting a file or a bucket folder waits for Approve.
- Files over 50 MB are skipped and noted in `_schema.md`, so big buckets don't fill the disk.
- Remote changes come down on the 30-second poll. Storage has no Realtime.

### Menu window
- A **"Waiting for you"** section appears at the top whenever the queue has items. Each item shows what
  will happen in plain words ("Drop column `tier` from `sponsors`, 2 rows have values"), a "Show SQL"
  disclosure, and Approve and Reject buttons. The tray title already shows "N to check".
- Each table row gets a "⋯" menu with Rename, Delete table, and Realtime on/off. Destructive items open
  a native confirm dialog.
- Each project gets "New table" (creates an empty `.xlsx` with an `id` column), "Open SQL inbox" and a
  "Storage" folder link.
- The header gets an account area: signed in or not, and "New project…".

## Section 4: How it fits the existing code

- `src/account.js`: the Management API client (token, organizations, projects, keys, SQL, project
  creation), rate-limited to stay under 120 requests a minute.
- `src/gate.js`: the approval queue. `propose(action)` either runs the action or persists it to
  `.sync/queue.json`. `approve(id)` re-checks it against current state before running (see Errors).
- `src/sqlclass.js`: tokenizer and allowlist classifier. Pure functions, heavily unit-tested.
- `src/schema.js`: type inference, DDL for new, dropped and renamed tables and columns, and generation of
  `_schema.md`.
- `src/auth.js` and `src/storage.js`: each is one more "surface" the engine syncs, and each routes
  destructive actions through the gate.
- `src/engine.js` keeps row sync. Its existing delete-guard and header-removal pause become calls to
  `gate.propose`.
- `main.js` gains IPC for the account, the queue and the new menu actions. `window.html` gains the
  sections above.

## Errors

- Every agent-visible action leaves a readable trace: a `.result.json` for SQL, and an Activity log line
  for everything else. The message says what failed and what to do next.
- **Approval re-validation:** when Zac approves, the gate checks the target still looks the way it did when
  the action was held (same table, columns and row count). If it changed, the item is re-shown with the
  new details instead of running blind.
- **Offline or rate-limited:** actions stay queued and retry with backoff. The window shows "Offline ·
  N waiting" as it does today.
- **A failed DDL** leaves the file in place, marks the table "Needs attention" with Postgres's error, and
  changes nothing else, because each DDL change is one transaction.

## Testing

- **Unit tests** (`node --test`, as today):
  - the SQL classifier against a large table of cases: case, comments, `$$` bodies, multi-statement
    files, `CREATE OR REPLACE`, and unparseable input
  - type inference
  - DDL generation for add, drop and rename
  - the gate: propose, approve, reject and re-validation
- **Engine tests** use the existing fake-remote pattern, extended with a fake Management API.
- **Live checklist, against `backend-sync-test` only:** create a table from a file, add a column, remove a
  column (it gets held; approve it), run allowlisted and held SQL, create and delete a user, round-trip a
  storage file, and create a project (held; approve it; wait until it's healthy).
- **Never** run the checklist against QWeb's or the personal site's database. They get connected only
  after the checklist passes.

## Build order

Each phase ships on its own and gets its own plan:

1. **Account and picker:** token, project list, automatic keys. This fixes setup straight away.
2. **Gate and SQL inbox:** the approval queue that every later phase uses, plus the catch-all.
3. **Tables and columns from files,** plus the table "⋯" menu.
4. **Auth users.**
5. **Storage.**
6. **New projects.**

## Out of scope for v2

Edge Functions, branching, billing, organization members, sending auth invites, more than one Mac, and
two-way sync of SQL-defined objects (functions and policies are created through the inbox and shown in
`_schema.md`, but aren't editable as files).
