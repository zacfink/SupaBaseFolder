// Sync one project without the menu bar app, for testing the engine.
// First run:  SUPABASE_KEY=... node scripts/headless.js Test https://<ref>.supabase.co
// After that: SUPABASE_KEY=... node scripts/headless.js Test
const { Project } = require('../src/engine')

const [name, url] = process.argv.slice(2)
if (url) Project.create(name, url)
const p = new Project(name, process.env.SUPABASE_KEY, () => console.log(new Date().toLocaleTimeString(), JSON.stringify(p.summary().tables.map(t => [t.table, t.state, t.reason ?? '', t.pending]))))
p.start()
setInterval(() => p.syncAll(), 30_000)
