const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  onState: fn => ipcRenderer.on('state', (_, s) => fn(s)),
  call: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
})
