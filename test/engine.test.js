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
