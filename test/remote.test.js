const test = require('node:test')
const assert = require('node:assert/strict')
const { fetchPages, PAGE } = require('../src/remote')

const table = n => Array.from({ length: n }, (_, i) => ({ id: i + 1 }))
const pager = rows => {
  const calls = []
  return { calls, get: async (from, to) => { calls.push(from); return rows.slice(from, to + 1) } }
}

test('fetches every row once, in order, for sizes around page boundaries', async () => {
  for (const n of [0, 1, PAGE - 1, PAGE, PAGE + 1, 7 * PAGE, 7 * PAGE + 5]) {
    const rows = table(n), p = pager(rows)
    assert.deepEqual(await fetchPages(p.get, n), rows, `n=${n}`)
  }
})

test('rows added after the count are still fetched', async () => {
  const rows = table(3 * PAGE + 10), p = pager(rows)
  assert.equal((await fetchPages(p.get, 2 * PAGE)).length, rows.length)
})

test('a row that shifts pages mid-fetch is not duplicated', async () => {
  const rows = table(2 * PAGE)
  const dup = async (from, to) => from === PAGE ? [rows[PAGE - 1], ...rows.slice(from, to)] : rows.slice(from, to + 1)
  const out = await fetchPages(dup, 2 * PAGE)
  assert.equal(new Set(out.map(r => r.id)).size, out.length)
})

test('pages run in parallel', async () => {
  let live = 0, peak = 0
  const rows = table(12 * PAGE)
  const slow = async (from, to) => { peak = Math.max(peak, ++live); await new Promise(r => setTimeout(r, 5)); live--; return rows.slice(from, to + 1) }
  await fetchPages(slow, rows.length)
  assert.ok(peak > 1, `peak concurrency ${peak}`)
})
