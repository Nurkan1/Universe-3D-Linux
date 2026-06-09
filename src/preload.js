// Preload: safe bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('universe', {
  scanApps: () => ipcRenderer.invoke('apps:scan'),
  launchApp: (appInfo) => ipcRenderer.invoke('apps:launch', appInfo),
  iconData: (iconPath) => ipcRenderer.invoke('apps:iconData', iconPath),
  saveVideo: (arrayBuffer) => ipcRenderer.invoke('video:save', arrayBuffer),
  showInFolder: (filePath) => ipcRenderer.invoke('video:showInFolder', filePath),
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (prefs) => ipcRenderer.invoke('prefs:set', prefs),
  closeWindow: () => ipcRenderer.send('window:close'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
});
