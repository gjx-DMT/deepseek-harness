// preload.js v2.0
// Preload script for the DeepSeek Harness GUI.
// Exposes a safe IPC bridge to the renderer for runtime status and hidden command execution.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshGui', {
  version: '2.0.0',
  platform: process.platform,
  isElectron: true,

  // Runtime status
  getStatus: () => ipcRenderer.invoke('pm:getStatus'),
  getRuntimes: () => ipcRenderer.invoke('pm:getRuntimes'),

  // Hidden command execution (no black window)
  runPython: (scriptPath, args, options) =>
    ipcRenderer.invoke('pm:runPython', scriptPath, args, options),
  runPowerShell: (command, options) =>
    ipcRenderer.invoke('pm:runPowerShell', command, options),

  // Health monitoring
  onHealthStatus: (callback) => {
    ipcRenderer.on('health-status', (event, data) => callback(data));
  },
});
