// Renders the menu bar window with sample data into docs/screenshot.png for the README.
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
  fs.writeFileSync(path.join(root, 'docs', 'screenshot.png'), image.toPNG())
  app.quit()
})
