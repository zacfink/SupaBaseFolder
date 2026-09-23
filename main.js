const { app, Tray, Menu, BrowserWindow, ipcMain, shell, nativeImage, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { Project, ROOT } = require('./src/engine')
const { fetchSchema } = require('./src/remote')

const SYNC_EVERY_MS = 30_000 // backstop: offline reconnects and tables missing from the Realtime publication
const projects = new Map()
const broken = new Map() // project name -> why it couldn't start
let tray, win
const WIDTH = 360

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
  const need = tables.filter(t => t.state === 'paused' || t.state === 'attention').length
  if (need) return `${need} to check`
  if (list.some(p => p.offline) || tables.some(t => t.state === 'offline')) {
    const waiting = tables.reduce((n, t) => n + (t.state === 'offline' ? t.pending : 0), 0)
    return waiting ? `Offline · ${waiting} waiting` : 'Offline'
  }
  return ''
}

function refresh() {
  const s = state()
  tray?.setTitle(title(s), { fontType: 'monospacedDigit' })
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
// Renderer-supplied name/table/format all get checked here before they reach a path or shell call.
const getTable = (name, table) => {
  const p = get(name)
  if (!p.summary().tables.some(t => t.table === table)) throw new Error(`No table called ${table} in ${name}`)
  return p
}

ipcMain.handle('sync', () => Promise.all([...projects.values()].map(p => p.syncAll())))
ipcMain.handle('open', (_, name, table) => {
  const file = getTable(name, table).file(table)
  if (file.endsWith('.json')) execFile('open', ['-a', 'Visual Studio Code', file], err => err && shell.openPath(file))
  else shell.openPath(file)
})
ipcMain.handle('confirm', (_, name, table) => getTable(name, table).sync(table, { confirmDeletes: true }))
ipcMain.handle('restore', (_, name, logId) => get(name).restore(logId))
ipcMain.handle('format', (_, name, table, format) => {
  if (format !== 'xlsx' && format !== 'json') throw new Error(`Unknown format ${format}`)
  return getTable(name, table).switchFormat(table, format)
})
ipcMain.handle('log', (_, name) => get(name).readLog())
ipcMain.handle('reveal', () => shell.openPath(ROOT))
ipcMain.handle('resize', (_, height) => win.setContentSize(WIDTH, Math.min(Math.max(Math.round(height) || 0, 120), 640)))
ipcMain.handle('add', async (_, { name, url, key }) => {
  name = name.trim()
  key = key.trim()
  url = url.trim()
  try { url = new URL(url).origin } catch {} // drop a pasted path like /rest/v1; a bad URL fails the check below
  if (!/^\w[\w .-]*$/.test(name) || projects.has(name)) throw new Error('Pick a new folder name: letters, numbers, spaces, - . _')
  if (!/^https:\/\/\S+$/.test(url)) throw new Error('The URL should look like https://xyz.supabase.co')
  await fetchSchema(url, key) // fails fast on a wrong URL or key
  Project.create(name, url)
  saveKey(name, key)
  startProject(name)
})

// A second copy would run a second sync engine over the same folders.
if (!app.requestSingleInstanceLock()) app.quit()
else app.whenReady().then(() => {
  app.dock?.hide()
  const firstRun = !fs.existsSync(ROOT)
  fs.mkdirSync(ROOT, { recursive: true })
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png')))
  tray.setToolTip('SupaBaseFolder')
  win = new BrowserWindow({
    width: WIDTH, height: 200, show: false, frame: false, resizable: false, skipTaskbar: true,
    transparent: true, vibrancy: 'popover', visualEffectState: 'active',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.loadFile('window.html')
  win.on('blur', () => win.hide())
  win.webContents.on('before-input-event', (_, input) => input.key === 'Escape' && win.hide())
  tray.on('click', () => {
    if (win.isVisible()) return win.hide()
    const b = tray.getBounds()
    win.setPosition(Math.round(b.x + b.width / 2 - WIDTH / 2), b.y + b.height + 4)
    win.show()
    refresh()
  })
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate([
    { label: 'Sync now', click: () => projects.forEach(p => p.syncAll()) },
    { label: 'Open Backend folder', click: () => shell.openPath(ROOT) },
    { type: 'separator' },
    { label: 'Quit SupaBaseFolder', accelerator: 'Command+Q', click: () => app.quit() },
  ])))
  for (const name of Project.list()) startProject(name)
  if (firstRun) shell.openPath(ROOT) // no API adds a sidebar favourite; the window tells Zac to drag it in
  setInterval(() => projects.forEach(p => p.syncAll()), SYNC_EVERY_MS)
  refresh()
})
