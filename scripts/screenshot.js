// Renders the menu bar window and the table window with sample data into docs/ for the README.
// Run: npx electron scripts/screenshot.js
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const t = (table, format, state, extra = {}) => ({ table, format, state, pending: 0, rejected: [], warnings: [], ...extra })
const sample = [
  { name: 'Test', offline: null, tables: [
    t('events', 'xlsx', 'ok'),
    t('sponsors', 'json', 'attention', { rejected: ['Row 4 was rejected: name is required'] }),
    t('members', 'xlsx', 'paused', { needsConfirm: true, reason: 'This save would delete 7 rows from Supabase.' }),
  ] },
  { name: 'QWeb', offline: 'fetch failed', tables: [t('projects', 'xlsx', 'offline', { pending: 2 })] },
]

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light'
  const root = path.join(__dirname, '..')
  const win = new BrowserWindow({
    width: 360, height: 200, show: false, frame: false, backgroundColor: '#ececec',
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, sandbox: true },
  })
  ipcMain.handle('resize', (_, h) => win.setContentSize(360, Math.min(Math.max(Math.round(h), 120), 640)))
  ipcMain.handle('log', () => [])
  await win.loadFile(path.join(root, 'window.html'))
  win.webContents.send('state', sample)
  await new Promise(r => setTimeout(r, 800)) // let render + resize settle
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(root, 'docs', 'menu-bar.png'), image.toPNG())

  // The table window, 'both' layout, with a row picked so the details panel shows.
  const at = h => new Date(Date.UTC(2026, 9, h[0], h[1])).toISOString()
  const rows = [
    { id: 1, title: 'Tutorial 1', starts_at: at([1, 22]), capacity: 60, published: true, meta: { room: 'Kin 100', topic: 'Intro to the web' } },
    { id: 2, title: 'Tutorial 2', starts_at: at([8, 22]), capacity: 60, published: true, meta: { room: 'Kin 100', topic: 'CSS layout' } },
    { id: 3, title: 'Tutorial 3', starts_at: at([15, 22]), capacity: 60, published: false, meta: { room: 'Kin 100', topic: 'JavaScript' } },
    { id: 4, title: 'Hack night', starts_at: at([17, 23]), capacity: 40, published: false, meta: { room: 'Goodwin 247', topic: 'Build anything' } },
    { id: 5, title: 'Sponsor talk', starts_at: at([29, 22]), capacity: 80, published: false, meta: { room: 'Stirling A', speaker: 'TBD' } },
  ]
  const columns = { id: { type: 'integer', format: 'bigint' }, title: { type: 'string', format: 'text' },
    starts_at: { type: 'string', format: 'timestamp with time zone' }, capacity: { type: 'integer', format: 'integer' },
    published: { type: 'boolean', format: 'boolean' }, meta: { format: 'jsonb' } }
  ipcMain.handle('settings', () => ({ layout: 'both', openWith: 'app' }))
  ipcMain.handle('state', () => sample)
  ipcMain.handle('rows', () => ({ columns, required: ['id', 'title'], rows, file: path.join('/Users/you/Backend/Test/events.xlsx'), mtime: 1, locked: false }))
  const tw = new BrowserWindow({
    width: 1120, height: 560, show: false, titleBarStyle: 'hiddenInset', backgroundColor: '#ececec',
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, sandbox: true },
  })
  await tw.loadFile(path.join(root, 'table.html'), { query: { name: 'Test', table: 'events' } })
  await new Promise(r => setTimeout(r, 500))
  await tw.webContents.executeJavaScript("document.querySelectorAll('tbody tr')[2].click()")
  await new Promise(r => setTimeout(r, 400))
  fs.writeFileSync(path.join(root, 'docs', 'table-window.png'), (await tw.webContents.capturePage()).toPNG())

  // A JSON column opened as a tree: a one-row content table, the way a site keeps its copy.
  const content = {
    hero: { title: 'Northside Bakery', tagline: 'Sourdough, every morning at 7.' },
    menu: [
      { item: 'Country loaf', price: 9, available: true },
      { item: 'Cinnamon bun', price: 4.5, available: true },
      { item: 'Rye', price: 10, available: false },
    ],
    hours: { weekdays: '7am – 6pm', weekends: '8am – 3pm' },
    faq: [
      { q: 'Do you take orders?', a: 'Yes, until 4pm the day before.' },
      { q: 'Gluten-free?', a: 'Not yet. Our kitchen shares flour.' },
    ],
  }
  ipcMain.removeHandler('rows')
  ipcMain.removeHandler('state')
  ipcMain.handle('state', () => [{ name: 'Bakery', offline: null, tables: [t('site_content', 'json', 'ok')] }])
  ipcMain.handle('rows', () => ({ columns: { id: { type: 'string', format: 'text' }, data: { format: 'jsonb' } }, required: ['id', 'data'],
    rows: [{ id: 'live', data: content }], file: path.join('/Users/you/Backend/Bakery/site_content.json'), mtime: 1, locked: false }))
  await tw.loadFile(path.join(root, 'table.html'), { query: { name: 'Bakery', table: 'site_content' } })
  await new Promise(r => setTimeout(r, 500))
  await tw.webContents.executeJavaScript("document.querySelectorAll('tbody tr')[0].click(); for (const p of ['data/menu', 'data/menu/0', 'data/hero']) treeOpen.add(p); renderInsp()")
  await new Promise(r => setTimeout(r, 400))
  fs.writeFileSync(path.join(root, 'docs', 'json-tree.png'), (await tw.webContents.capturePage()).toPNG())
  app.quit() // closing the menu bar window earlier would have quit the app before this window loaded
})
