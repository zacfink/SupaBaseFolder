# Backend Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A macOS menu bar app that keeps each Supabase table live as an `.xlsx` or `.json` file in `~/Backend/<Project>/`, syncing both ways within seconds.

**Architecture:** One pure function, `diff(snapshot, local, remote)`, decides what to push, pull or flag. A per-project `Project` engine wraps it: it reads the file, fetches the table, calls `diff`, writes to Supabase row by row, rewrites the file and saves the snapshot. Every trigger runs that same full-table sync: a file save (fs.watch, 1s debounce), a Realtime event, the Excel lock clearing, or a 30s backstop timer. An Electron tray app hosts the engines and shows their status.

**Tech Stack:** Node 22, Electron (CommonJS), `@supabase/supabase-js` v2, SheetJS `xlsx` 0.20.3 (CDN build), `node:test` for tests, `@electron/packager` to build the `.app`.

**Spec:** `docs/superpowers/specs/2026-09-22-backend-sync-design.md`

## Global Constraints

- Sync folder is fixed at `~/Backend` (not iCloud Drive, not the Desktop).
- `id` is required and is the match key. Tables without an `id` column are skipped and listed in `_schema.md`.
- Local save debounce: about 1s (`DEBOUNCE_MS = 1000`).
- Delete guard: a sync that would delete **more than 5** remote rows pauses that table until confirmed (`DELETE_LIMIT = 5`).
- The Supabase key never goes in the project folder.
- All manual testing runs against a **throwaway Supabase project**, never QWeb's or the personal site's real database, until v1 is proven.
- Runtime dependencies are limited to `@supabase/supabase-js` and `xlsx`. Dev dependencies are limited to `electron` and `@electron/packager`.

## Deliberate deviations from the spec

1. **Finder sidebar:** macOS has no public API for adding a sidebar favourite. On first run the app opens `~/Backend` in Finder and the window shows a tip to drag it into the sidebar.
2. **No `pending/` folder.** While Excel holds the file, the snapshot only takes on the rows we pushed. Remote changes therefore keep showing up as "pull" on every sync until the file can be written. Held changes are recomputed each time instead of stored, and the behaviour is the same as the spec's.
3. **Key storage:** Electron `safeStorage` encrypts the key with a key held in the macOS Keychain. The encrypted blob sits in the app's data folder, outside `~/Backend`.
4. **Edit vs delete:** when one side edits a row and the other side deletes it, the edit wins (rather than newer-wins), so nothing is lost. It's logged as a conflict.
5. **A bad local cell** (for example "abc" in a number column) pauses the table with the row and column named. Rows that Supabase rejects are flagged one by one, as the spec says.
6. **A 30s full sync** also runs on a timer. It covers offline reconnects and tables that aren't in the Realtime publication.
7. **`fs.watch`** replaces chokidar. The "xlsx edits through a script" helper for AI is skipped; `_schema.md` tells AI to prefer JSON tables.

## File structure

```
package.json            scripts: test, start, package
.gitignore
src/diff.js             pure sync decisions: diff, arrange, applyChanges, tooManyDeletes, stable
src/formats.js          file <-> canonical rows: coerceRows, readTable, writeTable
src/remote.js           Supabase: fetchSchema, connect() -> { fetchAll, upsert, remove, subscribe, close }
src/engine.js           Project class: per-project watcher, queue, syncTable, log, restore, switchFormat
test/sync.test.js       the one automated test file (diff + formats)
scripts/headless.js     runs one project's engine without Electron (manual testing)
scripts/test-project.sql  schema for the throwaway Supabase project
main.js                 Electron tray, window, IPC, key storage
preload.js              exposes window.api
window.html             the menu bar window UI
```

---

### Task 1: Scaffold + the pure sync core (`src/diff.js`)

**Files:**
- Create: `package.json`, `.gitignore`, `src/diff.js`
- Test: `test/sync.test.js`

**Interfaces:**
- Produces:
  - `diff(snapshot: Row[], local: Row[], remote: Row[], opts?: { localMtime: number }) -> { push: { inserts: Row[], updates: Row[], deletes: string[] }, pull: { upserts: Row[], deletes: string[] }, conflicts: { id: string, kept: 'local'|'remote', lost: Row|null, reason?: string }[] }`. The rows in `push.inserts`/`push.updates` are the **same objects** that were passed in `local`.
  - `arrange(local: Row[], remote: Row[], opts?: { inserted: Map<Row, Row>, rejected: Set<Row> }) -> Row[]`
  - `applyChanges(rows: Row[], changes: (Row | { id, _deleted: true })[]) -> Row[]`
  - `tooManyDeletes(d) -> boolean`, `DELETE_LIMIT = 5`, `stable(value) -> string`

- [ ] **Step 1: Scaffold**

`package.json`:
```json
{
  "name": "backend-sync",
  "version": "0.1.0",
  "private": true,
  "main": "main.js",
  "scripts": {
    "test": "node --test",
    "start": "electron .",
    "package": "electron-packager . \"Backend Sync\" --platform=darwin --out=dist --overwrite --ignore=\"^/(dist|test|docs|scripts)\""
  }
}
```

`.gitignore`:
```
node_modules/
dist/
```

- [ ] **Step 2: Write the failing tests**

`test/sync.test.js`:
```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { diff, arrange, applyChanges, tooManyDeletes } = require('../src/diff')

const row = (id, name, extra = {}) => ({ id, name, ...extra })

test('local edit pushes an update', () => {
  const d = diff([row(1, 'a')], [row(1, 'b')], [row(1, 'a')])
  assert.deepEqual(d.push.updates, [row(1, 'b')])
  assert.deepEqual(d.pull.upserts, [])
  assert.deepEqual(d.conflicts, [])
})

test('remote edit pulls', () => {
  const d = diff([row(1, 'a')], [row(1, 'a')], [row(1, 'b')])
  assert.deepEqual(d.pull.upserts, [row(1, 'b')])
  assert.deepEqual(d.push.updates, [])
})

test('deletes go the right way', () => {
  assert.deepEqual(diff([row(1, 'a')], [], [row(1, 'a')]).push.deletes, ['1'])
  assert.deepEqual(diff([row(1, 'a')], [row(1, 'a')], []).pull.deletes, ['1'])
})

test('row without id is an insert; new remote row is pulled', () => {
  const d = diff([], [row(null, 'new')], [row(2, 'theirs')])
  assert.deepEqual(d.push.inserts, [row(null, 'new')])
  assert.deepEqual(d.pull.upserts, [row(2, 'theirs')])
})

test('same row changed on both sides: newer wins, loser kept for restore', () => {
  const s = [row(1, 'a', { updated_at: '2026-09-22T10:00:00.000Z' })]
  const l = [row(1, 'local', { updated_at: '2026-09-22T10:00:00.000Z' })]
  const r = [row(1, 'remote', { updated_at: '2026-09-22T12:00:00.000Z' })]
  const older = diff(s, l, r, { localMtime: Date.parse('2026-09-22T11:00:00Z') })
  assert.deepEqual(older.pull.upserts, r)
  assert.deepEqual(older.conflicts, [{ id: '1', kept: 'remote', lost: l[0] }])
  const newer = diff(s, l, r, { localMtime: Date.parse('2026-09-22T13:00:00Z') })
  assert.deepEqual(newer.push.updates, l)
  assert.deepEqual(newer.conflicts, [{ id: '1', kept: 'local', lost: r[0] }])
})

test('no updated_at column: local wins', () => {
  const d = diff([row(1, 'a')], [row(1, 'local')], [row(1, 'remote')], { localMtime: 0 })
  assert.deepEqual(d.push.updates, [row(1, 'local')])
  assert.equal(d.conflicts[0].kept, 'local')
})

test('different rows changed on each side never conflict', () => {
  const s = [row(1, 'a'), row(2, 'b')]
  const d = diff(s, [row(1, 'A'), row(2, 'b')], [row(1, 'a'), row(2, 'B')])
  assert.deepEqual(d.push.updates, [row(1, 'A')])
  assert.deepEqual(d.pull.upserts, [row(2, 'B')])
  assert.deepEqual(d.conflicts, [])
})

test('identical edits on both sides do nothing; key order does not matter', () => {
  const d = diff([row(1, 'a')], [{ name: 'b', id: 1 }], [row(1, 'b')])
  assert.deepEqual(d, { push: { inserts: [], updates: [], deletes: [] }, pull: { upserts: [], deletes: [] }, conflicts: [] })
})

test('edit beats delete', () => {
  const localEdit = diff([row(1, 'a')], [row(1, 'b')], [])
  assert.deepEqual(localEdit.push.inserts, [row(1, 'b')])
  assert.equal(localEdit.conflicts[0].kept, 'local')
  const remoteEdit = diff([row(1, 'a')], [], [row(1, 'b')])
  assert.deepEqual(remoteEdit.pull.upserts, [row(1, 'b')])
  assert.deepEqual(remoteEdit.push.deletes, [])
})

test('delete guard trips above 5', () => {
  const rows = n => Array.from({ length: n }, (_, i) => row(i + 1, 'x'))
  assert.equal(tooManyDeletes(diff(rows(5), [], rows(5))), false)
  assert.equal(tooManyDeletes(diff(rows(6), [], rows(6))), true)
})

test('arrange keeps file order, fills new ids, keeps rejected rows, appends remote-only rows', () => {
  const fresh = row(null, 'new'), bad = row(3, 'bad edit')
  const local = [row(2, 'b'), fresh, bad, row(9, 'deleted remotely')]
  const remote = [row(1, 'remote only'), row(2, 'B'), row(3, 'server'), row(5, 'new')]
  const out = arrange(local, remote, { inserted: new Map([[fresh, row(5, 'new')]]), rejected: new Set([bad]) })
  assert.deepEqual(out, [row(2, 'B'), row(5, 'new'), bad, row(1, 'remote only')])
})

test('applyChanges upserts and deletes by id', () => {
  const out = applyChanges([row(1, 'a'), row(2, 'b')], [row(2, 'B'), row(3, 'c'), { id: 1, _deleted: true }])
  assert.deepEqual(out, [row(2, 'B'), row(3, 'c')])
})
```

- [ ] **Step 3: Run the tests to check they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/diff'`

- [ ] **Step 4: Implement `src/diff.js`**

```js
// The sync decision, as pure functions. A row is a canonical object (see coerceRows) keyed by `id`.

const DELETE_LIMIT = 5

// Deterministic JSON, so rows with the same values compare equal whatever their key order.
const stable = v =>
  Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  : String(JSON.stringify(v))
const same = (a, b) => stable(a) === stable(b)
const byId = rows => new Map(rows.filter(r => r.id != null).map(r => [String(r.id), r]))

// snapshot = the last state both sides agreed on. Returns what to send up, what to bring down,
// and the rows that changed on both sides (with the losing version, for restore).
function diff(snapshot, local, remote, { localMtime = 0 } = {}) {
  const S = byId(snapshot), L = byId(local), R = byId(remote)
  const push = { inserts: local.filter(r => r.id == null), updates: [], deletes: [] }
  const pull = { upserts: [], deletes: [] }
  const conflicts = []
  for (const id of new Set([...S.keys(), ...L.keys(), ...R.keys()])) {
    const s = S.get(id), l = L.get(id), r = R.get(id)
    const localChanged = !same(s, l), remoteChanged = !same(s, r)
    if (!localChanged && !remoteChanged) continue
    if (!remoteChanged) {
      if (!l) push.deletes.push(id)
      else if (!r) push.inserts.push(l)
      else push.updates.push(l)
    } else if (!localChanged) {
      if (!r) pull.deletes.push(id)
      else pull.upserts.push(r)
    } else if (same(l, r)) {
      // Both sides made the same change (or both deleted it).
    } else if (!l || !r) {
      // Edited on one side, deleted on the other: the edit wins so nothing is lost.
      if (l) push.inserts.push(l)
      else pull.upserts.push(r)
      conflicts.push({ id, kept: l ? 'local' : 'remote', lost: null, reason: l ? 'deleted in Supabase, edited in the file' : 'deleted in the file, edited in Supabase' })
    } else {
      const remoteTime = Date.parse(r.updated_at ?? '')
      if (Number.isNaN(remoteTime) || localMtime >= remoteTime) {
        push.updates.push(l)
        conflicts.push({ id, kept: 'local', lost: r })
      } else {
        pull.upserts.push(r)
        conflicts.push({ id, kept: 'remote', lost: l })
      }
    }
  }
  return { push, pull, conflicts }
}

const tooManyDeletes = d => d.push.deletes.length > DELETE_LIMIT

// Lay rows on top of a row list by id. A change of { id, _deleted: true } removes that row.
function applyChanges(rows, changes) {
  const m = byId(rows)
  for (const c of changes) c._deleted ? m.delete(String(c.id)) : m.set(String(c.id), c)
  return [...m.values()]
}

// What the file holds after a sync: the file's row order, each row's remote version, new rows
// with their new ids, rejected rows exactly as typed, then rows that only exist remotely.
function arrange(local, remote, { inserted = new Map(), rejected = new Set() } = {}) {
  const R = byId(remote), used = new Set(), out = []
  for (const row of local) {
    if (rejected.has(row)) {
      out.push(row)
      if (row.id != null) used.add(String(row.id))
      continue
    }
    const id = row.id ?? inserted.get(row)?.id
    if (id != null && R.has(String(id)) && !used.has(String(id))) {
      out.push(R.get(String(id)))
      used.add(String(id))
    }
  }
  for (const [id, r] of R) if (!used.has(id)) out.push(r)
  return out
}

module.exports = { diff, arrange, applyChanges, tooManyDeletes, stable, DELETE_LIMIT }
```

- [ ] **Step 5: Run the tests to check they pass**

Run: `npm test`
Expected: all 12 tests PASS

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore src/diff.js test/sync.test.js
git commit -m "Sync core: diff, arrange, delete guard, with tests"
```

---

### Task 2: File formats (`src/formats.js`)

**Files:**
- Create: `src/formats.js`
- Modify: `test/sync.test.js` (append)

**Interfaces:**
- Consumes: none
- Produces:
  - `columns` shape everywhere: `{ [name]: { type?: string, format?: string } }`, taken straight from PostgREST OpenAPI `definitions[table].properties`
  - `coerceRows(rows: object[], columns, firstRow = 1) -> { rows: Row[], warnings: string[] }`. Every output row has exactly the schema's columns (missing values become `null`). It throws `Error("Row N, col: reason")` on an uncoercible value.
  - `readTable(file, columns) -> { rows, warnings }` (`.json` or `.xlsx`)
  - `writeTable(file, rows, columns)`: atomic (writes `file.tmp`, then renames it)

- [ ] **Step 1: Install SheetJS** (the npm registry copy is stale; use the official CDN build)

Run: `npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`

- [ ] **Step 2: Append the failing tests to `test/sync.test.js`**

```js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { coerceRows, readTable, writeTable } = require('../src/formats')

const cols = {
  id: { type: 'integer', format: 'bigint' },
  title: { type: 'string', format: 'text' },
  capacity: { type: 'integer', format: 'integer' },
  published: { type: 'boolean', format: 'boolean' },
  starts_at: { type: 'string', format: 'timestamp with time zone' },
  meta: { format: 'jsonb' },
}

test('coerceRows converts values, fills missing columns, warns on unknown ones', () => {
  const { rows, warnings } = coerceRows([{ id: '4', title: 'T', capacity: '60', published: 'TRUE', starts_at: '2026-09-24T18:00:00-04:00', meta: '{"a":1}', extra: 1 }], cols)
  assert.deepEqual(rows, [{ id: 4, title: 'T', capacity: 60, published: true, starts_at: '2026-09-24T22:00:00.000Z', meta: { a: 1 } }])
  assert.deepEqual(warnings, ['Column "extra" isn\'t in Supabase, so it\'s ignored'])
  assert.deepEqual(coerceRows([{ title: 'x' }], cols).rows[0], { id: null, title: 'x', capacity: null, published: null, starts_at: null, meta: null })
})

test('coerceRows names the row and column it cannot read', () => {
  assert.throws(() => coerceRows([{ id: 1 }, { id: 2, capacity: 'abc' }], cols, 2), /Row 3, capacity: "abc" is not a number/)
})

test('xlsx and json round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsync-'))
  const rows = [
    { id: 1, title: 'Tutorial', capacity: 60, published: true, starts_at: '2026-09-24T22:00:00.000Z', meta: { tags: ['web'] } },
    { id: 2, title: 'Empty', capacity: null, published: false, starts_at: null, meta: null },
  ]
  for (const file of ['t.xlsx', 't.json'].map(f => path.join(dir, f))) {
    writeTable(file, rows, cols)
    assert.deepEqual(readTable(file, cols).rows, rows)
  }
  writeTable(path.join(dir, 'empty.xlsx'), [], cols)
  assert.deepEqual(readTable(path.join(dir, 'empty.xlsx'), cols).rows, [])
})
```

- [ ] **Step 3: Run the tests to check they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/formats'`

- [ ] **Step 4: Implement `src/formats.js`**

```js
const fs = require('node:fs')
const XLSX = require('xlsx')

const isJson = ({ type, format }) => format === 'jsonb' || format === 'json' || type === 'array'

// Turn whatever a file holds into the value Supabase would return, so rows compare cleanly.
function coerceValue(v, col) {
  if (v === null || v === undefined || v === '') return null
  const { type, format = '' } = col
  if (isJson(col)) {
    if (typeof v !== 'string') return v
    try { return JSON.parse(v) } catch { throw new Error('is not valid JSON') }
  }
  if (type === 'integer' || type === 'number') {
    const n = Number(v)
    if (Number.isNaN(n)) throw new Error(`"${v}" is not a number`)
    return n
  }
  if (type === 'boolean') {
    if (typeof v === 'boolean') return v
    const s = String(v).trim().toLowerCase()
    if (s === 'true' || s === 'false') return s === 'true'
    throw new Error(`"${v}" is not true or false`)
  }
  if (format === 'timestamp with time zone') {
    const d = new Date(v)
    if (Number.isNaN(+d)) throw new Error(`"${v}" is not a date and time`)
    return d.toISOString()
  }
  if (v instanceof Date) {
    // Excel typed a date into a column with no time zone: keep the wall-clock time as written.
    const wall = new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString()
    return format === 'date' ? wall.slice(0, 10) : wall.slice(0, 19)
  }
  return String(v)
}

// firstRow is the row number people see for rows[0]: 2 in a sheet (row 1 is headers), 1 in JSON.
function coerceRows(rows, columns, firstRow = 1) {
  const warnings = new Set()
  const out = rows.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Row ${i + firstRow} is not an object`)
    for (const k of Object.keys(raw)) if (!Object.hasOwn(columns, k)) warnings.add(`Column "${k}" isn't in Supabase, so it's ignored`)
    return Object.fromEntries(Object.entries(columns).map(([name, col]) => {
      try { return [name, coerceValue(raw[name], col)] }
      catch (e) { throw new Error(`Row ${i + firstRow}, ${name}: ${e.message}`) }
    }))
  })
  return { rows: out, warnings: [...warnings] }
}

function readTable(file, columns) {
  if (file.endsWith('.json')) {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(rows)) throw new Error('the file must be a JSON array of rows')
    return coerceRows(rows, columns, 1)
  }
  const wb = XLSX.read(fs.readFileSync(file), { cellDates: true })
  return coerceRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null }), columns, 2)
}

// Written to a temp file and renamed, so a half-written file is never read.
function writeTable(file, rows, columns) {
  const names = Object.keys(columns)
  let data
  if (file.endsWith('.json')) {
    data = JSON.stringify(rows, null, 2) + '\n'
  } else {
    const cell = (v, col) => (v !== null && isJson(col) ? JSON.stringify(v) : v)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([names, ...rows.map(r => names.map(n => cell(r[n], columns[n])))]), 'Sheet1')
    data = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  }
  fs.writeFileSync(file + '.tmp', data)
  fs.renameSync(file + '.tmp', file)
}

module.exports = { coerceRows, readTable, writeTable }
```

- [ ] **Step 5: Run the tests to check they pass**

Run: `npm test`
Expected: all 15 tests PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/formats.js test/sync.test.js
git commit -m "File formats: xlsx/json read, write and type coercion"
```

---

### Task 3: Supabase client (`src/remote.js`) + throwaway test project

**Files:**
- Create: `src/remote.js`, `scripts/test-project.sql`

**Interfaces:**
- Produces:
  - `fetchSchema(url, key) -> Promise<{ [table]: { columns, required: string[] } }>`
  - `connect(url, key) -> { fetchAll(table): Promise<object[]>, upsert(table, row): Promise<object>, remove(table, id): Promise<void>, subscribe(onTable: (table) => void), close() }`. All of them throw `Error(message)` on failure.

- [ ] **Step 1: Install**

Run: `npm i @supabase/supabase-js`

- [ ] **Step 2: Write `src/remote.js`**

```js
const { createClient } = require('@supabase/supabase-js')

const PAGE = 1000
// Legacy keys are JWTs and also go in Authorization; new sb_secret_ keys only go in apikey.
const headers = key => (key.startsWith('eyJ') ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key })

// Tables and column types from PostgREST's OpenAPI description. Needs the service_role / secret key.
async function fetchSchema(url, key) {
  const res = await fetch(`${url}/rest/v1/`, { headers: headers(key) })
  if (!res.ok) throw new Error(`Supabase answered ${res.status} ${res.statusText}`)
  const { definitions = {} } = await res.json()
  return Object.fromEntries(Object.entries(definitions).map(([table, d]) => [table, { columns: d.properties ?? {}, required: d.required ?? [] }]))
}

function connect(url, key) {
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const check = ({ data, error }) => {
    if (error) throw new Error(error.message)
    return data
  }
  return {
    async fetchAll(table) {
      const rows = []
      for (let from = 0; ; from += PAGE) {
        const page = check(await db.from(table).select('*').order('id').range(from, from + PAGE - 1))
        rows.push(...page)
        if (page.length < PAGE) return rows
      }
    },
    upsert: async (table, row) => check(await db.from(table).upsert(row).select().single()),
    remove: async (table, id) => { check(await db.from(table).delete().eq('id', id)) },
    subscribe: onTable => db.channel('backend-sync').on('postgres_changes', { event: '*', schema: 'public' }, p => onTable(p.table)).subscribe(),
    close: () => db.removeAllChannels(),
  }
}

module.exports = { fetchSchema, connect }
```

- [ ] **Step 3: Write `scripts/test-project.sql`**

```sql
-- Throwaway Supabase project ONLY. Never run this against QWeb's or the personal site's database.
drop table if exists events, sponsors cascade;
create table events (
  id bigint generated by default as identity primary key,
  title text not null,
  starts_at timestamptz,
  capacity int,
  published boolean default false,
  meta jsonb,
  updated_at timestamptz not null default now()
);
create table sponsors (
  id bigint generated by default as identity primary key,
  name text not null,
  tier text
);
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger events_touch before update on events for each row execute function touch_updated_at();
alter publication supabase_realtime add table events, sponsors;
insert into events (title, starts_at, capacity, published) values
  ('Tutorial 1', '2026-09-17 18:00-04', 60, true),
  ('Tutorial 2', '2026-09-24 18:00-04', 60, false);
insert into sponsors (name, tier) values ('Acme', 'gold'), ('Globex', 'silver');
```

- [ ] **Step 4: Zac creates the throwaway project** (a human step)

At supabase.com, create a new project named `backend-sync-test`, run `scripts/test-project.sql` in the SQL editor, and copy the Project URL and the service_role (or secret) key. Export them in the shell for the next steps:
```bash
export SUPABASE_URL=https://<ref>.supabase.co SUPABASE_KEY=<service_role key>
```

- [ ] **Step 5: Check it against the test project**

Run:
```bash
node -e "
const { fetchSchema, connect } = require('./src/remote')
;(async () => {
  const s = await fetchSchema(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  console.log(Object.keys(s), Object.keys(s.events.columns))
  const db = connect(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  console.log(await db.fetchAll('sponsors'))
  const r = await db.upsert('sponsors', { name: 'Temp' }); console.log(r)
  await db.remove('sponsors', r.id); console.log((await db.fetchAll('sponsors')).length)
  db.close()
})()"
```
Expected: `[ 'events', 'sponsors' ]` and the events columns, then 2 sponsors, a new row with an `id`, and a final count of `2`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/remote.js scripts/test-project.sql
git commit -m "Supabase client: schema, paged fetch, upsert, delete, realtime"
```

---

### Task 4: The sync engine (`src/engine.js`) + headless runner

**Files:**
- Create: `src/engine.js`, `scripts/headless.js`

**Interfaces:**
- Consumes: `diff`, `arrange`, `applyChanges`, `tooManyDeletes`, `stable` (Task 1); `coerceRows`, `readTable`, `writeTable` (Task 2); `fetchSchema`, `connect` (Task 3)
- Produces:
  - `ROOT` (`~/Backend`)
  - `Project.create(name, url)` and `Project.list() -> string[]`
  - `new Project(name, key, onChange)` with `start()`, `stop()`, `syncAll()`, `sync(table, { confirmDeletes })`, `file(table)`, `readLog(limit) -> entries[]` (each entry has `logId`, `at`, `table`, `type: 'conflict'|'sync'|'restore'`), `restore(logId)`, `switchFormat(table, 'xlsx'|'json')`, and `summary() -> { name, offline: string|null, tables: { table, format, state: 'ok'|'syncing'|'waiting'|'attention'|'paused'|'offline', reason?, pending, rejected: string[], warnings: string[], needsConfirm? }[] }`

- [ ] **Step 1: Write `src/engine.js`**

```js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { diff, arrange, applyChanges, tooManyDeletes, stable } = require('./diff')
const { coerceRows, readTable, writeTable } = require('./formats')
const { fetchSchema, connect } = require('./remote')

const ROOT = path.join(os.homedir(), 'Backend')
const DEBOUNCE_MS = 1000

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
// New rows leave out empty columns so database defaults (id, created_at...) apply.
const noNulls = row => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null))

class Project {
  static create(name, url) { writeJson(path.join(ROOT, name, '.sync', 'config.json'), { url, tables: {} }) }
  static list() {
    try { return fs.readdirSync(ROOT).filter(n => fs.existsSync(path.join(ROOT, n, '.sync', 'config.json'))) } catch { return [] }
  }

  constructor(name, key, onChange = () => {}) {
    this.name = name
    this.dir = path.join(ROOT, name)
    this.meta = path.join(this.dir, '.sync')
    this.config = readJson(path.join(this.meta, 'config.json'))
    this.key = key
    this.onChange = onChange
    this.schema = readJson(path.join(this.meta, 'schema.json'), null) // last known, so an offline start still works
    this.skipped = []
    this.offline = null
    this.status = {}
    this.queues = {}
    this.timers = {}
  }

  start() {
    this.remote = connect(this.config.url, this.key)
    this.watcher = fs.watch(this.dir, (_, name) => this.onFile(name))
    return this.syncAll()
  }

  stop() {
    this.watcher?.close()
    this.remote?.close()
    Object.values(this.timers).forEach(clearTimeout)
  }

  async syncAll() {
    try {
      await this.loadSchema()
      this.offline = null
    } catch (e) {
      this.offline = e.message
    }
    this.onChange()
    if (this.schema) await Promise.all(Object.keys(this.schema).map(t => this.sync(t)))
  }

  async loadSchema() {
    const all = await fetchSchema(this.config.url, this.key)
    this.schema = {}
    this.skipped = []
    for (const [table, def] of Object.entries(all)) {
      if (!def.columns.id) { this.skipped.push(table); continue }
      this.schema[table] = def
      this.config.tables[table] ??= 'xlsx'
    }
    writeJson(path.join(this.meta, 'config.json'), this.config)
    writeJson(path.join(this.meta, 'schema.json'), this.schema)
    this.writeSchemaMd()
    this.channel ??= this.remote.subscribe(table => this.schedule(table))
  }

  file(table) { return path.join(this.dir, `${table}.${this.config.tables[table]}`) }
  locked(table) { return this.config.tables[table] === 'xlsx' && fs.existsSync(path.join(this.dir, `~$${table}.xlsx`)) }
  snapFile(table) { return path.join(this.meta, 'snapshots', `${table}.json`) }

  // Saves, Excel's ~$ lock file appearing or clearing, and our own writes all land here.
  onFile(name) {
    const m = name?.replace(/^~\$/, '').match(/^(.+)\.(xlsx|json)$/)
    if (m && this.config.tables[m[1]] === m[2]) this.schedule(m[1])
  }

  schedule(table) {
    if (!this.schema?.[table]) return
    clearTimeout(this.timers[table])
    this.timers[table] = setTimeout(() => this.sync(table), DEBOUNCE_MS)
  }

  // One job at a time per table.
  enqueue(table, fn) {
    const next = (this.queues[table] ?? Promise.resolve()).then(fn)
    this.queues[table] = next.catch(() => {})
    return next
  }

  sync(table, opts) {
    return this.enqueue(table, () => this.syncTable(table, opts).catch(e => this.set(table, { state: 'paused', reason: e.message })))
  }

  set(table, status) {
    this.status[table] = { pending: 0, rejected: [], warnings: [], ...status }
    this.onChange()
  }

  async syncTable(table, { confirmDeletes = false } = {}) {
    const { columns } = this.schema[table]
    const file = this.file(table)
    const snap = readJson(this.snapFile(table), [])
    const exists = fs.existsSync(file)
    this.status[table] = { ...this.status[table], state: 'syncing' }
    this.onChange()

    let local
    try {
      local = exists ? readTable(file, columns) : { rows: snap, warnings: [] } // a missing file is recreated, never read as "delete everything"
    } catch (e) {
      return this.set(table, { state: 'paused', reason: `${path.basename(file)} can't be read (${e.message}). Nothing syncs until it's fixed and saved.` })
    }
    const { warnings } = local

    let fetched
    try {
      fetched = await this.remote.fetchAll(table)
    } catch (e) {
      const { push } = diff(snap, local.rows, snap)
      return this.set(table, { state: 'offline', reason: e.message, warnings, pending: push.inserts.length + push.updates.length + push.deletes.length })
    }
    const remote = coerceRows(fetched, columns).rows

    const d = diff(snap, local.rows, remote, { localMtime: exists ? fs.statSync(file).mtimeMs : 0 })
    if (tooManyDeletes(d) && !confirmDeletes) {
      return this.set(table, { state: 'paused', needsConfirm: true, warnings, reason: `This save would delete ${d.push.deletes.length} rows from Supabase.` })
    }

    const locked = this.locked(table)
    const canon = row => coerceRows([row], columns).rows[0]
    const saved = [], sent = [], inserted = new Map(), rejected = new Set(), errors = []
    const attempt = async (row, write) => {
      try { return await write() } catch (e) {
        rejected.add(row)
        errors.push(`Row ${row.id ?? '(new)'} was rejected: ${e.message}`)
      }
    }
    for (const row of d.push.inserts) {
      if (row.id == null && locked) continue // new rows wait for Excel to close, so their id can be written back
      const result = await attempt(row, () => this.remote.upsert(table, noNulls(row)))
      if (result) { const r = canon(result); inserted.set(row, r); saved.push(r); sent.push(row) }
    }
    for (const row of d.push.updates) {
      const result = await attempt(row, () => this.remote.upsert(table, row))
      if (result) { saved.push(canon(result)); sent.push(row) }
    }
    for (const id of d.push.deletes) {
      if (await attempt({ id }, () => this.remote.remove(table, id).then(() => true))) {
        saved.push({ id, _deleted: true })
        sent.push({ id, _deleted: true })
      }
    }

    const status = { warnings, rejected: errors, state: errors.length ? 'attention' : 'ok' }
    if (!locked) {
      const after = applyChanges(remote, saved)
      const rows = arrange(local.rows, after, { inserted, rejected })
      let wrote = true
      try {
        if (!exists || stable(rows) !== stable(local.rows)) writeTable(file, rows, columns)
      } catch {
        wrote = false // another app holds the file: handle it like an Excel lock below
      }
      if (wrote) return this.finish(table, after, d.conflicts, { pushed: sent.length, pulled: d.pull.upserts.length + d.pull.deletes.length }, status)
    }
    // Can't write the file: the snapshot takes only what we pushed (as the file has it), so the
    // remote changes show up again as "pull" on every sync until the file is free.
    const pending = d.pull.upserts.length + d.pull.deletes.length
    this.finish(table, applyChanges(snap, sent), d.conflicts.filter(c => c.kept === 'local'), { pushed: sent.length, pulled: 0 },
      { ...status, pending, state: pending && !errors.length ? 'waiting' : status.state })
  }

  finish(table, snapshot, conflicts, counts, status) {
    writeJson(this.snapFile(table), snapshot)
    for (const c of conflicts) this.log({ table, type: 'conflict', ...c })
    if (counts.pushed || counts.pulled) this.log({ table, type: 'sync', ...counts })
    this.set(table, status)
  }

  log(entry) {
    const line = { logId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), ...entry }
    fs.appendFileSync(path.join(this.meta, 'log.jsonl'), JSON.stringify(line) + '\n')
  }

  readLog(limit = 50) {
    try {
      return fs.readFileSync(path.join(this.meta, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).slice(-limit).reverse()
    } catch {
      return []
    }
  }

  async restore(logId) {
    const entry = this.readLog(Infinity).find(e => e.logId === logId)
    if (!entry?.lost) throw new Error('Nothing to restore for that entry')
    await this.remote.upsert(entry.table, entry.lost)
    this.log({ table: entry.table, type: 'restore', restored: logId })
    return this.sync(entry.table)
  }

  async switchFormat(table, format) {
    await this.sync(table)
    return this.enqueue(table, () => {
      if (this.status[table]?.state !== 'ok' || this.locked(table)) throw new Error(`Get ${table} synced with no problems and closed first, then switch.`)
      const old = this.file(table)
      this.config.tables[table] = format
      writeJson(path.join(this.meta, 'config.json'), this.config)
      writeTable(this.file(table), readJson(this.snapFile(table), []), this.schema[table].columns)
      fs.rmSync(old, { force: true })
      this.writeSchemaMd()
      this.onChange()
    })
  }

  writeSchemaMd() {
    const lines = [
      `# ${this.name}`, '',
      'Each file here is a Supabase table. Edit it and save; the change reaches Supabase within seconds.', '',
      '- Every row needs an `id`. Leave it empty on a new row and the app fills it in.',
      '- Only the columns below exist. A new column has to be created in Supabase first.',
      '- AI editing: prefer the `.json` tables. Write every column on every row; a missing column means empty.',
      '- A save that deletes more than 5 rows pauses the table until it is confirmed in the menu bar app.',
      '- Live updates from Supabase need the table in the `supabase_realtime` publication; without it they arrive within 30 seconds.', '',
    ]
    for (const [t, { columns, required }] of Object.entries(this.schema)) {
      lines.push(`## ${t} (\`${t}.${this.config.tables[t]}\`)`, '', '| column | type | required |', '|---|---|---|')
      for (const [c, def] of Object.entries(columns)) lines.push(`| ${c} | ${def.format ?? def.type} | ${required.includes(c) ? 'yes' : ''} |`)
      lines.push('')
    }
    if (this.skipped.length) lines.push(`Not synced (no \`id\` column): ${this.skipped.join(', ')}`, '')
    fs.writeFileSync(path.join(this.dir, '_schema.md'), lines.join('\n'))
  }

  summary() {
    return {
      name: this.name,
      offline: this.offline,
      tables: Object.keys(this.schema ?? {}).map(table => ({
        table, format: this.config.tables[table], state: 'syncing', pending: 0, rejected: [], warnings: [], ...this.status[table],
      })),
    }
  }
}

module.exports = { Project, ROOT }
```

- [ ] **Step 2: Write `scripts/headless.js`**

```js
// Sync one project without the menu bar app, for testing the engine.
// First run:  SUPABASE_KEY=... node scripts/headless.js Test https://<ref>.supabase.co
// After that: SUPABASE_KEY=... node scripts/headless.js Test
const { Project } = require('../src/engine')

const [name, url] = process.argv.slice(2)
if (url) Project.create(name, url)
const p = new Project(name, process.env.SUPABASE_KEY, () => console.log(new Date().toLocaleTimeString(), JSON.stringify(p.summary().tables.map(t => [t.table, t.state, t.reason ?? '', t.pending]))))
p.start()
setInterval(() => p.syncAll(), 30_000)
```

- [ ] **Step 3: Check the engine by hand against the throwaway project**

Run: `node scripts/headless.js Test "$SUPABASE_URL"` and leave it running. Then work through these and confirm each one:
1. `~/Backend/Test/` has `events.xlsx`, `sponsors.xlsx`, `_schema.md` and `.sync/`. Both tables report `ok`.
2. Change a title in `events.xlsx` in Excel and save, keeping Excel open. Within about 2s the row changes in the Supabase table editor.
3. With Excel still open, edit a different event in the Supabase dashboard. The table reports `waiting` with pending 1. Close Excel; within about 2s the file has the change.
4. Add a row with an empty `id` and save. After the sync, the file's row has an `id`.
5. Delete all rows but one in `sponsors.xlsx` after adding rows until there are 7. The table reports `paused` with "would delete 6 rows", and Supabase still has 7.
6. Type `abc` in a `capacity` cell and save. The table reports `paused` with "Row N, capacity". Fix it and save; it goes back to `ok`.
7. Blank a `title` (`not null`) and save. That row is reported in `rejected`, other edits in the same save still reach Supabase, and the blank stays in the file.

Stop it with Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git add src/engine.js scripts/headless.js
git commit -m "Sync engine: per-table sync, Excel lock, delete guard, log, restore, format switch"
```

---

### Task 5: Menu bar app (`main.js`, `preload.js`, `window.html`)

**Files:**
- Create: `main.js`, `preload.js`, `window.html`

**Interfaces:**
- Consumes: `Project`, `ROOT` (Task 4), `fetchSchema` (Task 3)
- Produces: IPC channels `sync`, `open(name, table)`, `confirm(name, table)`, `restore(name, logId)`, `format(name, table, fmt)`, `log(name)`, `add({ name, url, key })`, `reveal`; renderer event `state` (an array of `summary()`)

- [ ] **Step 1: Install Electron**

Run: `npm i -D electron`

- [ ] **Step 2: Write `main.js`**

```js
const { app, Tray, BrowserWindow, ipcMain, shell, nativeImage, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { Project, ROOT } = require('./src/engine')
const { fetchSchema } = require('./src/remote')

const SYNC_EVERY_MS = 30_000 // backstop: offline reconnects and tables missing from the Realtime publication
const projects = new Map()
const broken = new Map() // project name -> why it couldn't start
let tray, win

// Keys are encrypted with safeStorage (its key lives in the macOS Keychain) and kept out of ~/Backend.
const keysFile = () => path.join(app.getPath('userData'), 'keys.json')
const loadKeys = () => { try { return JSON.parse(fs.readFileSync(keysFile(), 'utf8')) } catch { return {} } }
const getKey = name => safeStorage.decryptString(Buffer.from(loadKeys()[name], 'base64'))
function saveKey(name, key) {
  const keys = loadKeys()
  keys[name] = safeStorage.encryptString(key).toString('base64')
  fs.writeFileSync(keysFile(), JSON.stringify(keys), { mode: 0o600 })
}

const state = () => [
  ...[...projects.values()].map(p => p.summary()),
  ...[...broken].map(([name, why]) => ({ name, offline: why, tables: [] })),
]

function title(list) {
  const tables = list.flatMap(p => p.tables)
  if (tables.some(t => t.state === 'paused' || t.state === 'attention')) return '⚠'
  if (tables.some(t => t.state === 'syncing')) return '↻'
  if (list.some(p => p.offline) || tables.some(t => t.state === 'offline')) {
    const waiting = tables.reduce((n, t) => n + (t.state === 'offline' ? t.pending : 0), 0)
    return waiting ? `Offline, ${waiting} changes waiting` : 'Offline'
  }
  return '✓'
}

function refresh() {
  const s = state()
  tray?.setTitle(`⇅ ${title(s)}`)
  win?.webContents.send('state', s)
}

function startProject(name) {
  let key
  try { key = getKey(name) } catch { return broken.set(name, 'No saved key. Remove the folder and add the project again.') }
  const p = new Project(name, key, refresh)
  projects.set(name, p)
  p.start()
}

const get = name => {
  const p = projects.get(name)
  if (!p) throw new Error(`No project called ${name}`)
  return p
}

ipcMain.handle('sync', () => Promise.all([...projects.values()].map(p => p.syncAll())))
ipcMain.handle('open', (_, name, table) => {
  const file = get(name).file(table)
  if (file.endsWith('.json')) execFile('open', ['-a', 'Visual Studio Code', file], err => err && shell.openPath(file))
  else shell.openPath(file)
})
ipcMain.handle('confirm', (_, name, table) => get(name).sync(table, { confirmDeletes: true }))
ipcMain.handle('restore', (_, name, logId) => get(name).restore(logId))
ipcMain.handle('format', (_, name, table, format) => get(name).switchFormat(table, format))
ipcMain.handle('log', (_, name) => get(name).readLog())
ipcMain.handle('reveal', () => shell.openPath(ROOT))
ipcMain.handle('add', async (_, { name, url, key }) => {
  name = name.trim()
  url = url.trim().replace(/\/$/, '')
  if (!/^\w[\w .-]*$/.test(name) || projects.has(name)) throw new Error('Pick a new folder name: letters, numbers, spaces, - . _')
  if (!/^https:\/\/\S+$/.test(url)) throw new Error('The URL should look like https://xyz.supabase.co')
  await fetchSchema(url, key) // fails fast on a wrong URL or key
  Project.create(name, url)
  saveKey(name, key)
  startProject(name)
})

app.whenReady().then(() => {
  app.dock?.hide()
  const firstRun = !fs.existsSync(ROOT)
  fs.mkdirSync(ROOT, { recursive: true })
  tray = new Tray(nativeImage.createEmpty())
  win = new BrowserWindow({
    width: 380, height: 560, show: false, frame: false, resizable: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile('window.html')
  win.on('blur', () => win.hide())
  tray.on('click', () => {
    if (win.isVisible()) return win.hide()
    const b = tray.getBounds()
    win.setPosition(Math.round(b.x + b.width / 2 - 190), b.y + b.height + 4)
    win.show()
    refresh()
  })
  for (const name of Project.list()) startProject(name)
  if (firstRun) shell.openPath(ROOT) // no API adds a sidebar favourite; the window tells Zac to drag it in
  setInterval(() => projects.forEach(p => p.syncAll()), SYNC_EVERY_MS)
  refresh()
})
```

- [ ] **Step 3: Write `preload.js`**

```js
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  onState: fn => ipcRenderer.on('state', (_, s) => fn(s)),
  call: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
})
```

- [ ] **Step 4: Write `window.html`**

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Backend Sync</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: light dark; font: 13px -apple-system, system-ui, sans-serif; }
  body { margin: 0; padding: 12px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  h2 { font-size: 13px; margin: 16px 0 4px; }
  .t { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; padding: 6px 0; border-top: 1px solid #8884; }
  .why { grid-column: 1 / -1; color: #c60; }
  .muted { color: #888; }
  button, input { font: inherit; }
  form { display: grid; gap: 6px; margin-top: 8px; }
  details { margin-top: 8px; }
  .log div { padding: 3px 0; }
</style>
</head>
<body>
<header>
  <strong>Backend Sync</strong>
  <span><button id="reveal">Open folder</button> <button id="sync">Sync now</button></span>
</header>
<div id="list"></div>
<details>
  <summary>Add project</summary>
  <form id="add">
    <input name="name" placeholder="Folder name, e.g. QWeb" required>
    <input name="url" placeholder="https://xyz.supabase.co" required>
    <input name="key" type="password" placeholder="service_role or secret key" required>
    <button>Add and pull every table</button>
    <span id="err" class="why"></span>
  </form>
</details>
<script>
const $ = s => document.querySelector(s)
const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e }
const ICON = { ok: '✓', syncing: '↻', waiting: '⏸', attention: '⚠', paused: '⚠', offline: '⌁' }
let openLog = null

function describe(e) {
  const when = new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  if (e.type === 'sync') return `${when} · ${e.table}: ${e.pushed} up, ${e.pulled} down`
  if (e.type === 'restore') return `${when} · ${e.table}: restored an overwritten version`
  return `${when} · ${e.table} row ${e.id}: kept the ${e.kept === 'local' ? 'file' : 'Supabase'} version${e.reason ? ` (${e.reason})` : ''}`
}

async function showLog(name, el) {
  const entries = await api.call('log', name)
  el.querySelectorAll('div').forEach(d => d.remove())
  if (!entries.length) el.append(h('div', { className: 'muted', textContent: 'Nothing yet.' }))
  for (const e of entries) {
    const line = h('div', { textContent: describe(e) + ' ' })
    if (e.lost) line.append(h('button', { textContent: 'Restore', onclick: () => api.call('restore', name, e.logId).then(() => showLog(name, el)) }))
    el.append(line)
  }
}

function render(projects) {
  const list = $('#list')
  list.replaceChildren()
  if (!projects.length) list.append(h('p', { className: 'muted', textContent: 'No projects yet. Add one below. Tip: drag the Backend folder into Finder’s sidebar.' }))
  for (const p of projects) {
    list.append(h('h2', { textContent: p.name }))
    if (p.offline) list.append(h('div', { className: 'why', textContent: `Can't reach Supabase: ${p.offline}` }))
    for (const t of p.tables) {
      const other = t.format === 'xlsx' ? 'json' : 'xlsx'
      const row = h('div', { className: 't' },
        h('span', { textContent: `${ICON[t.state] ?? ''} ${t.table}.${t.format}${t.pending ? ` · ${t.pending} waiting` : ''}` }),
        h('span', {},
          h('button', { textContent: 'Open', onclick: () => api.call('open', p.name, t.table) }), ' ',
          h('button', { textContent: `→ .${other}`, onclick: () => api.call('format', p.name, t.table, other).catch(e => alert(e.message)) })))
      for (const msg of [t.reason, ...t.warnings, ...t.rejected].filter(Boolean)) row.append(h('div', { className: 'why', textContent: msg }))
      if (t.needsConfirm) row.append(h('div', { className: 'why' }, h('button', { textContent: 'Confirm deletes', onclick: () => api.call('confirm', p.name, t.table) })))
      list.append(row)
    }
    const log = h('details', { className: 'log', open: openLog === p.name }, h('summary', { textContent: 'Activity' }))
    log.addEventListener('toggle', () => { openLog = log.open ? p.name : null; if (log.open) showLog(p.name, log) })
    list.append(log)
  }
}

api.onState(render)
$('#sync').onclick = () => api.call('sync')
$('#reveal').onclick = () => api.call('reveal')
$('#add').onsubmit = async e => {
  e.preventDefault()
  $('#err').textContent = ''
  try {
    await api.call('add', Object.fromEntries(new FormData(e.target)))
    e.target.reset()
  } catch (err) {
    $('#err').textContent = err.message.replace(/^Error invoking remote method 'add': (Error: )?/, '')
  }
}
</script>
</body>
</html>
```

- [ ] **Step 5: Run it and check by hand**

Run: `npm start`
1. `⇅` appears in the menu bar with no Dock icon. The first run opens `~/Backend` in Finder.
2. Click the tray icon. The window shows the "No projects yet" tip. Add `Test2` with the throwaway URL and key. A wrong key shows an error in red and creates no folder.
3. With the right key, `~/Backend/Test2/` fills with files and the window lists `events.xlsx` and `sponsors.xlsx` with ✓.
4. Click `→ .json` on sponsors. `sponsors.json` replaces `sponsors.xlsx`, and "Open" opens it in VS Code.
5. Edit the same sponsor in `sponsors.json` and in the Supabase dashboard, dashboard first, then save the file. Activity shows "kept the file version" with a Restore button. Restore brings the dashboard value back into the file.
6. Trip the delete guard (delete 6+ rows). The ⚠ title shows, and "Confirm deletes" appears and works.
7. Turn Wi-Fi off, edit and save a row. Within 30s the title reads `⇅ Offline, 1 changes waiting`. Turn Wi-Fi on; within 30s it's back to ✓ and Supabase has the edit.
8. Quit and relaunch. The project comes back without asking for the key.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json main.js preload.js window.html
git commit -m "Menu bar app: tray status, project list, activity with restore, add project"
```

---

### Task 6: Package the `.app`

**Files:**
- Modify: `package.json` (devDependency only)

- [ ] **Step 1: Install the packager**

Run: `npm i -D @electron/packager`

- [ ] **Step 2: Build**

Run: `npm run package`
Expected: `dist/Backend Sync-darwin-arm64/Backend Sync.app`

- [ ] **Step 3: Check the built app**

Quit any `npm start` instance. Move `Backend Sync.app` to `/Applications`, then right-click it and choose Open (it's unsigned). Confirm that the existing `~/Backend` projects start syncing, and repeat Task 5 check 2.

Keys saved by the `npm start` build may not decrypt in the packaged app, since the app identity differs. If a project shows "No saved key", remove its folder and add it again.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "Package Backend Sync.app"
```

Skipped for v1, add when needed: code signing, launch at login (`app.setLoginItemSettings({ openAtLogin: true })`), and a tray icon image.
