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
