const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  onState: fn => ipcRenderer.on('state', (_, s) => fn(s)),
  onRemove: fn => ipcRenderer.on('remove', (_, name) => fn(name)),
  onSelect: fn => ipcRenderer.on('select', (_, which) => fn(which)),
  onSettings: fn => ipcRenderer.on('settings', (_, s) => fn(s)),
  call: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
})
