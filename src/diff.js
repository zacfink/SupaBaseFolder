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
