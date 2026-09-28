const { app, Tray, Menu, BrowserWindow, ipcMain, shell, nativeImage, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { Project, ROOT } = require('./src/engine')
const { fetchSchema } = require('./src/remote')

const SYNC_EVERY_MS = 30_000 // backstop: offline reconnects and tables missing from the Realtime publication
const projects = new Map()
const broken = new Map() // project name -> why it couldn't start
let tray, win, tableWin
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
function forgetKey(name) {
  const keys = loadKeys()
  delete keys[name]
  fs.writeFileSync(keysFile(), JSON.stringify(keys), { mode: 0o600 })
}

// Settings the table window changes. layout: 'both' (sidebar + details on click), 'sidebar' (no details panel),
// 'inspector' (details always shown, tables as tabs). openWith: what the menu bar's Open button does.
const DEFAULTS = { layout: 'both', openWith: 'app' }
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const loadSettings = () => { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } } catch { return { ...DEFAULTS } } }
function saveSettings(change) {
  const s = loadSettings()
  if ('layout' in change && ['both', 'sidebar', 'inspector'].includes(change.layout)) s.layout = change.layout
  if ('openWith' in change && ['app', 'external'].includes(change.openWith)) s.openWith = change.openWith
  fs.writeFileSync(settingsFile(), JSON.stringify(s))
  tableWin?.webContents.send('settings', s)
  return s
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
  tableWin?.webContents.send('state', s)
}

function openExternal(file) {
  if (file.endsWith('.json')) execFile('open', ['-a', 'Visual Studio Code', file], err => err && shell.openPath(file))
  else shell.openPath(file)
}

// One table window; opening another table just switches it. The Dock icon shows while it's open so it can be Cmd-Tabbed to.
function openTableWindow(name, table) {
  if (tableWin) {
    tableWin.webContents.send('select', { name, table })
    return tableWin.show()
  }
  tableWin = new BrowserWindow({
    width: 1120, height: 700, minWidth: 720, minHeight: 420, show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 }, vibrancy: 'sidebar', visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  tableWin.loadFile('table.html', { query: { name, table } })
  tableWin.once('ready-to-show', () => { app.dock?.show(); tableWin.show() })
  tableWin.on('closed', () => { tableWin = null; app.dock?.hide() })
}

function startProject(name) {
  let key
  try { key = getKey(name) } catch { return broken.set(name, 'No saved key. Remove the folder and add the project again.') }
  const p = new Project(name, key, refresh)
  projects.set(name, p)
  // A corrupt config.json (crash mid-write) throws here; it shouldn't stop the other projects from starting.
  try { p.start() } catch (e) {
    p.stop()
    projects.delete(name)
    broken.set(name, `Couldn't start (${e.message}). Remove the folder and add the project again.`)
  }
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
  if (loadSettings().openWith === 'app') { win?.hide(); openTableWindow(name, table) }
  else openExternal(file)
})
ipcMain.handle('open-external', (_, name, table) => openExternal(getTable(name, table).file(table)))
ipcMain.handle('state', () => state())
ipcMain.handle('rows', (_, name, table) => getTable(name, table).readRows(table))
ipcMain.handle('save-rows', (_, name, table, rows) => {
  if (!Array.isArray(rows)) throw new Error('Rows must be a list')
  return getTable(name, table).writeRows(table, rows)
})
ipcMain.handle('settings', (_, change) => change ? saveSettings(change) : loadSettings())
ipcMain.handle('confirm', (_, name, table) => getTable(name, table).sync(table, { confirmDeletes: true }))
ipcMain.handle('restore', (_, name, logId) => get(name).restore(logId))
ipcMain.handle('format', (_, name, table, format) => {
  if (format !== 'xlsx' && format !== 'json') throw new Error(`Unknown format ${format}`)
  return getTable(name, table).switchFormat(table, format)
})
ipcMain.handle('log', (_, name) => get(name).readLog())
ipcMain.handle('reveal', () => shell.openPath(ROOT))
ipcMain.handle('resize', (_, height) => win.setContentSize(WIDTH, Math.min(Math.max(Math.round(height) || 0, 120), 640)))
// Deliberately hard to reach: right-click menu only, and the renderer must send back the typed folder name.
// Never touches Supabase. Unlink trashes .sync (files stay as plain files); delete trashes the whole folder.
ipcMain.handle('remove', async (_, name, typed, trashFolder) => {
  if (!projects.has(name) && !broken.has(name)) throw new Error(`No project called ${name}`)
  if (typed !== name) throw new Error('Type the folder name exactly to confirm.')
  const tables = projects.get(name)?.summary().tables ?? []
  // Only 'offline' counts local edits in pending ('waiting' counts pulls, and the file already has every local edit).
  const waiting = tables.reduce((n, t) => n + (t.state === 'offline' ? t.pending : 0), 0)
  if (waiting) throw new Error(`${waiting} ${waiting === 1 ? 'change hasn\'t' : 'changes haven\'t'} reached Supabase yet. Get back online and sync first.`)
  // Paused and needs-attention tables can hold edits Supabase never got; trashing the folder would lose them.
  const stuck = tables.filter(t => t.state === 'paused' || t.state === 'attention').map(t => t.table)
  if (trashFolder && stuck.length) throw new Error(`${stuck.join(', ')} may have edits that never reached Supabase. Fix ${stuck.length === 1 ? 'it' : 'them'} first, or disconnect without moving the folder to the Trash.`)
  await projects.get(name)?.stop() // let a sync already running land first, so it can't recreate the folder after it's trashed
  projects.delete(name)
  broken.delete(name)
  forgetKey(name)
  try { await shell.trashItem(trashFolder ? path.join(ROOT, name) : path.join(ROOT, name, '.sync')) }
  finally { refresh() } // the project is gone either way; show that even if the Trash step failed
})
ipcMain.handle('add', async (_, { name, url, key }) => {
  name = name.trim()
  key = key.trim()
  url = url.trim()
  try { url = new URL(url).origin } catch {} // drop a pasted path like /rest/v1; a bad URL fails the check below
  if (!/^\w[\w .-]*$/.test(name)) throw new Error('Pick a folder name: letters, numbers, spaces, - . _')
  // Checked on disk, not in the maps: ~/Backend is case-insensitive, so "qweb" would land in "QWeb", and a broken project is in neither.
  if (fs.existsSync(path.join(ROOT, name, '.sync'))) throw new Error(`${name} is already connected. Pick a new folder name.`)
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
  const show = () => {
    const b = tray.getBounds()
    win.setPosition(Math.round(b.x + b.width / 2 - WIDTH / 2), b.y + b.height + 4)
    win.show()
    refresh()
  }
  tray.on('click', () => win.isVisible() ? win.hide() : show())
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate([
    { label: 'Sync now', click: () => projects.forEach(p => p.syncAll()) },
    { label: 'Open Backend folder', click: () => shell.openPath(ROOT) },
    { label: 'Open a table', enabled: state().some(p => p.tables.length), submenu: state().flatMap(p => p.tables.map(t => ({
      label: `${p.name} › ${t.table}`, click: () => openTableWindow(p.name, t.table),
    }))) },
    { type: 'separator' },
    { label: 'Disconnect a project', enabled: state().length > 0, submenu: state().map(p => ({
      label: `${p.name}…`, click: () => { show(); win.webContents.send('remove', p.name) },
    })) },
    { type: 'separator' },
    { label: 'Quit SupaBaseFolder', accelerator: 'Command+Q', click: () => app.quit() },
  ])))
  for (const name of Project.list()) startProject(name)
  if (firstRun) shell.openPath(ROOT) // no API adds a sidebar favourite; the window tells Zac to drag it in
  setInterval(() => projects.forEach(p => p.syncAll()), SYNC_EVERY_MS)
  refresh()
})
