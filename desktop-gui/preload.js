// preload.js
// Minimal preload script for the DeepSeek Harness GUI.
// Runs in an isolated context and only exposes a tiny, safe bridge to the page.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('dshGui', {
  version: '1.0.0',
  platform: process.platform,
  isElectron: true,
});
