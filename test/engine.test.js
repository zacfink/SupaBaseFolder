const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// engine.js fixes ROOT from the home dir when it's first required, so point HOME at a scratch dir first.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bsync-home-'))
const { Project, ROOT } = require('../src/engine')

function stoppedProject() {
  Project.create('T', 'https://example.supabase.co')
  const p = new Project('T', 'key')
  p.schema = { t: { columns: { id: { type: 'integer' } }, required: [] } }
  p.config.tables.t = 'json'
  return p
}

test('a stopped project starts no new work and writes nothing', async () => {
  const p = stoppedProject()
  await p.stop()
  p.schedule('t')
  assert.equal(p.timers.t, undefined)
  await p.sync('t')
  await p.syncAll()
  assert.ok(!fs.existsSync(path.join(ROOT, 'T', 't.json')))
  assert.ok(!fs.existsSync(path.join(ROOT, 'T', '.sync', 'snapshots')))
})

test('stop() waits for a job already running, so trashing after it is safe', async () => {
  const p = stoppedProject()
  let landed = false
  p.enqueue('t', () => new Promise(r => setTimeout(() => { landed = true; r() }, 50)))
  await p.stop()
  assert.ok(landed)
})

test('a job that never settles is abandoned, so the table keeps syncing', async () => {
  const p = stoppedProject()
  p.stallMs = 30
  p.enqueue('t', () => new Promise(() => {})) // hangs forever
  let ran = false
  await p.enqueue('t', () => { ran = true })
  assert.ok(ran)
  assert.equal(p.status.t.state, 'attention')
  const log = fs.readFileSync(path.join(ROOT, 'T', '.sync', 'log.jsonl'), 'utf8')
  assert.match(log, /"type":"stalled"/)
})

test('the table window reads typed rows and writes them back as the file', () => {
  Project.create('W', 'https://example.supabase.co')
  const p = new Project('W', 'key')
  p.schema = { e: { columns: { id: { type: 'integer' }, title: { type: 'string' }, capacity: { type: 'integer' }, published: { type: 'boolean' }, meta: { type: 'object', format: 'jsonb' } }, required: ['title'] } }
  p.config.tables.e = 'xlsx'
  p.writeRows('e', [{ id: 1, title: 'Tutorial', capacity: '60', published: 'true', meta: '{"room":"Kin 100"}' }, { id: null, title: 'New' }])
  const { rows, required, locked } = p.readRows('e')
  assert.deepEqual(rows[0], { id: 1, title: 'Tutorial', capacity: 60, published: true, meta: { room: 'Kin 100' } })
  assert.equal(rows[1].id, null)
  assert.deepEqual(required, ['title'])
  assert.equal(locked, false)
  assert.throws(() => p.writeRows('e', [{ id: 1, title: 'x', capacity: 'lots' }]), /Row 1, capacity: "lots" is not a number/)
  fs.writeFileSync(path.join(ROOT, 'W', '~$e.xlsx'), '')
  assert.throws(() => p.writeRows('e', rows), /open in Excel/)
})
