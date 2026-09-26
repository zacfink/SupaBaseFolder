const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  onState: fn => ipcRenderer.on('state', (_, s) => fn(s)),
  onRemove: fn => ipcRenderer.on('remove', (_, name) => fn(name)),
  call: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
})
