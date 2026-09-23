const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { diff, arrange, applyChanges, tooManyDeletes, stable } = require('./diff')
const { coerceRows, readTable, writeTable } = require('./formats')
const { fetchSchema, connect } = require('./remote')

const ROOT = path.join(os.homedir(), 'Backend')
const DEBOUNCE_MS = 1000
const TIMEOUT_MS = 30_000

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
// New rows leave out empty columns so database defaults (id, created_at...) apply.
const noNulls = row => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null))
// A hung remote call (sleep/wake, dead connection) shouldn't stall a table forever.
const withTimeout = p => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new TypeError('fetch failed (timed out)')), TIMEOUT_MS))])
// A network-class failure (offline, DNS, timeout) vs. a real rejection from Supabase (bad data, RLS...).
const isNetworkError = e => e instanceof TypeError || /fetch failed/i.test(e.message)
// Has the file moved since we read it (another save landed mid-sync)?
const changedSince = (file, before) => {
  if (!before) return false
  try { const s = fs.statSync(file); return s.mtimeMs !== before.mtimeMs || s.size !== before.size }
  catch { return true }
}

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
    this.pending = {}
    this.timers = {}
    this.watchError = null
  }

  start() {
    this.remote = connect(this.config.url, this.key)
    this.watcher = fs.watch(this.dir, (_, name) => this.onFile(name))
    // EMFILE and friends land here; the watcher just stops working, so the 30s poll (headless.js /
    // the menu bar app's timer) carries syncing instead of the process going down.
    this.watcher.on('error', e => { this.watchError = e.message; this.onChange() })
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
    const run = () => this.enqueue(table, () => this.syncTable(table, opts).catch(e => this.set(table, { state: 'paused', reason: e.message })))
    if (opts) return run() // an explicit call (confirming a delete/wipe) always gets its own run
    // Plain autosyncs (debounce, the 30s poll) coalesce: at most one more queued behind the running one.
    if (!this.pending[table]) this.pending[table] = run().finally(() => { delete this.pending[table] })
    return this.pending[table]
  }

  set(table, status) {
    this.status[table] = { pending: 0, rejected: [], warnings: [], ...status }
    this.onChange()
  }

  async syncTable(table, { confirmDeletes = false } = {}) {
    const { columns } = this.schema[table]
    const file = this.file(table)
    const snap = coerceRows(readJson(this.snapFile(table), []), columns).rows // compare under the current columns, not whatever shape it was saved with
    const exists = fs.existsSync(file)
    const statBefore = exists ? fs.statSync(file) : null
    this.status[table] = { ...this.status[table], state: 'syncing' }
    this.onChange()

    let local
    try {
      local = exists ? readTable(file, columns) : { rows: snap, warnings: [], keys: null } // a missing file is recreated, never read as "delete everything"
    } catch (e) {
      return this.set(table, { state: 'paused', reason: `${path.basename(file)} can't be read (${e.message}). Nothing syncs until it's fixed and saved.` })
    }
    const { warnings } = local

    if (exists && local.rows.length) {
      // A copied row that kept its id would push over the original and the copy would vanish, unlogged.
      const firstRow = file.endsWith('.json') ? 1 : 2
      const seenAt = new Map()
      for (const [i, row] of local.rows.entries()) {
        if (row.id == null) continue
        if (seenAt.has(row.id)) {
          return this.set(table, { state: 'paused', warnings, reason: `Rows ${seenAt.get(row.id)} and ${i + firstRow} both have id ${row.id}. Give the new row an empty id, then save.` })
        }
        seenAt.set(row.id, i + firstRow)
      }
      // A column deleted from the header (or dropped from every JSON row) would silently wipe it in Supabase.
      if (!confirmDeletes) {
        const wiped = Object.keys(columns).find(col => !local.keys.has(col) && snap.some(r => r[col] != null))
        if (wiped) {
          return this.set(table, { state: 'paused', needsConfirm: true, warnings, reason: `The column "${wiped}" is missing from the file, so this save would empty it in Supabase.` })
        }
      }
    }

    let fetched
    try {
      fetched = await withTimeout(this.remote.fetchAll(table))
    } catch (e) {
      const { push } = diff(snap, local.rows, snap)
      return this.set(table, { state: 'offline', reason: e.message, warnings, pending: push.inserts.length + push.updates.length + push.deletes.length })
    }
    const remote = coerceRows(fetched, columns).rows

    const d = diff(snap, local.rows, remote, { localMtime: statBefore ? statBefore.mtimeMs : 0 })
    if (tooManyDeletes(d) && !confirmDeletes) {
      return this.set(table, { state: 'paused', needsConfirm: true, warnings, reason: `This save would delete ${d.push.deletes.length} rows from Supabase.` })
    }

    const locked = this.locked(table)
    const canon = row => coerceRows([row], columns).rows[0]
    const saved = [], sent = [], inserted = new Map(), rejected = new Set(), errors = []
    let networkError = null
    const attempt = async (row, write) => {
      try { return await withTimeout(write()) } catch (e) {
        if (isNetworkError(e)) { networkError ??= e; return } // offline mid-push: stop, don't flag rows as rejected
        rejected.add(row)
        errors.push(`Row ${row.id ?? '(new)'} was rejected: ${e.message}`)
      }
    }
    for (const row of d.push.inserts) {
      if (networkError) break
      if (row.id == null && locked) continue // new rows wait for Excel to close, so their id can be written back
      const result = await attempt(row, () => this.remote.upsert(table, noNulls(row)))
      if (result) { const r = canon(result); inserted.set(row, r); saved.push(r); sent.push(row) }
    }
    for (const row of d.push.updates) {
      if (networkError) break
      const result = await attempt(row, () => this.remote.upsert(table, row))
      if (result) { saved.push(canon(result)); sent.push(row) }
    }
    const failedDeletes = new Set() // keep these out of the file and the snapshot's view, so the delete retries next sync
    for (const id of d.push.deletes) {
      if (networkError) break
      if (await attempt({ id }, () => this.remote.remove(table, id).then(() => true))) {
        saved.push({ id, _deleted: true })
        sent.push({ id, _deleted: true })
      } else if (!networkError) {
        failedDeletes.add(String(id))
      }
    }

    if (networkError) {
      const { push } = diff(snap, local.rows, snap)
      return this.set(table, { state: 'offline', reason: networkError.message, warnings, pending: push.inserts.length + push.updates.length + push.deletes.length })
    }

    const status = { warnings, rejected: errors, state: errors.length ? 'attention' : 'ok' }
    let raced = false
    if (!locked) {
      const after = applyChanges(remote, saved)
      const forFile = after.filter(r => !failedDeletes.has(String(r.id)))
      const rows = arrange(local.rows, forFile, { inserted, rejected })
      let wrote = true
      if (this.locked(table) || changedSince(file, statBefore)) {
        wrote = false // a fresh edit (or Excel opening the file) landed while we were syncing: don't clobber it
        raced = true
      } else {
        try {
          if (!exists || stable(rows) !== stable(local.rows)) writeTable(file, rows, columns)
        } catch {
          wrote = false // another app holds the file: handle it like an Excel lock below
        }
      }
      if (wrote) return this.finish(table, after, d.conflicts, { pushed: sent.length, pulled: d.pull.upserts.length + d.pull.deletes.length }, status)
    }
    // Can't write the file: the snapshot takes only what we pushed (as the file has it), so the
    // remote changes show up again as "pull" on every sync until the file is free.
    if (raced) this.schedule(table) // make sure the edit we skipped over still gets synced
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
    await this.enqueue(entry.table, async () => {
      await withTimeout(this.remote.upsert(entry.table, entry.lost))
      this.log({ table: entry.table, type: 'restore', restored: logId })
    })
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
      '- AI editing: prefer the `.json` tables. Write every column on every row; a missing column pauses the table.',
      '- A save that deletes more than 5 rows pauses the table until it is confirmed in the menu bar app.',
      '- Live updates from Supabase need the table in the `supabase_realtime` publication; without it they arrive within 30 seconds.',
      '- Re-read a table file right before editing it; the app rewrites it when Supabase changes.', '',
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
      watchError: this.watchError,
      tables: Object.keys(this.schema ?? {}).map(table => ({
        table, format: this.config.tables[table], state: 'syncing', pending: 0, rejected: [], warnings: [], ...this.status[table],
      })),
    }
  }
}

module.exports = { Project, ROOT }
