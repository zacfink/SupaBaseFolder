# Backend Sync — design

Date: 2026-09-22 · Status: approved in chat, awaiting spec review

## Goal

A macOS menu bar app that makes Supabase tables live as plain files in `~/Backend`. Zac (or AI) edits
a table in Excel or a JSON file in VS Code, saves, and the change reaches Supabase within seconds.
When a site writes to Supabase, the local file updates live. Offline edits queue and upload on
reconnect. Local files are how you edit; Supabase stays the cloud copy the sites read and write.

## Scope

**v1 (this spec):** one Mac, the Finder sidebar entry, two-way live sync, the menu bar window.

**Later:** other Macs signing in to the same projects, a phone/web table editor, creating tables and
columns from the app, and a native macOS File Provider (OneDrive-style cloud icons).

**Out of scope:** replacing Supabase auth, storage buckets, or RLS; files too big to keep locally.

## Stack

- **Electron** menu bar app (tray icon + small window), packaged as a `.app`.
- **@supabase/supabase-js** for reads, writes and Realtime change events.
- **SheetJS (xlsx)** to read and write `.xlsx`.
- **chokidar** (or `fs.watch`) for file watching.

Swift was considered and rejected: there's no solid way to write `.xlsx` from Swift, and writing it is the core feature.

## Folder layout

```
~/Backend/                    added to the Finder sidebar on first run
  <Project>/                  one per linked Supabase project
    events.xlsx               table "events" (Excel form)
    sponsors.json             table "sponsors" (JSON form)
    _schema.md                auto-generated; tables, columns, types, required fields
    .sync/
      config.json             project URL, table→format map (key stored in macOS Keychain)
      snapshots/<table>.json  last synced copy of each table
      pending/<table>.json    remote changes waiting on a file that's open in Excel
      log.jsonl               activity + overwritten versions (for restore)
```

`~/Backend` must not be inside iCloud Drive or the Desktop (iCloud would sync the same files and fight
the app).

## File ↔ table mapping

- **One file per table.** Its format (`.xlsx` or `.json`) is set per table and can be switched.
- **xlsx:** first sheet only; row 1 = column names; each later row = one record.
- **json:** an array of objects, one per record.
- **`id` is required** and is the match key. A local row with no `id` gets one (from the insert
  result) written back to the file.
- **Columns must already exist in Supabase.** An unknown column triggers a warning on that table,
  and the column is ignored. Nothing crashes.
- **Values** are converted using the column types from Supabase (number, bool, text, timestamp,
  jsonb → JSON string in a cell).

## Sync engine

The core is one pure function, `diff(snapshot, local, remote) → {push, pull, conflicts}`, per table.
Everything else is plumbing around it.

**Startup / Sync now:** for each table, fetch remote rows, read the local file and the snapshot, then
run `diff` and apply it both ways. After a successful sync, write the snapshot.

**Local save:** the watcher debounces for about 1s, then parses the file, diffs it against the
snapshot, and pushes the inserts, updates and deletes (upsert/delete by `id`). Then it updates the
snapshot.

**Remote change (Realtime):** if the table's file isn't open, rewrite it and update the snapshot. If
it's open in Excel (lock file `~$name.xlsx` present, or the write fails), append the change to
`pending/`. When the lock clears, apply what's pending. JSON files are always rewritten immediately.

**Conflicts:** only when the same `id` changed both locally and remotely since the snapshot. The newer
edit wins (local file mtime vs. the row's `updated_at`; a table with no `updated_at` means local wins).
The losing version goes to `log.jsonl`, and the window offers a one-click restore. Changes to
different rows never conflict.

**Offline:** local saves queue, since the snapshot is only updated after a push succeeds. On
reconnect, a full Startup-style sync runs. The menu bar shows "Offline, N changes waiting".

## Safety

- **Delete guard:** a single sync that would delete more than 5 remote records pauses that table
  and asks for confirmation. This applies to every editor, AI included.
- **Parse failure** (bad JSON, malformed sheet): the table pauses with ⚠ and a plain-English reason.
  Nothing is pushed until the file parses.
- **Rejected row** (type error, constraint): that row is flagged and the rest keep syncing.
- The Supabase key lives in the Keychain, never in the project folder.

## AI editing

- Files are plain, so Claude Code edits JSON tables directly. xlsx edits go through a script.
  Prefer JSON for AI-heavy tables.
- Cloud AI (routines) writes to Supabase, and changes flow down like any site edit.
- `_schema.md` is regenerated on every sync, so AI knows the columns, types and required fields
  before it edits.

## Menu bar window

Status (✓ synced / ↻ syncing / ⚠ attention / offline + count) · projects → tables with "Open"
(Excel/VS Code) · pending changes · activity log with restore · Add project (URL + key + folder,
then pulls every public table) · Sync now.

## Testing

- `diff` and the conflict rules get one small automated test file. It's the part that can corrupt
  data: inserts, updates, deletes, both-sides-changed, missing `id`, delete-guard threshold.
- Everything else is tested by hand against a **throwaway Supabase project**, never QWeb's or the
  personal site's real database, until v1 is proven.
