'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gerritSettings', {
  load: () => ipcRenderer.invoke('settings:load'),
  preview: (patch) => ipcRenderer.send('settings:preview', patch),
  onAppearance: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('settings:appearance', listener);
    return () => ipcRenderer.removeListener('settings:appearance', listener);
  },
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  test: (patch) => ipcRenderer.invoke('settings:test', patch),
  testJenkins: (patch) => ipcRenderer.invoke('settings:testJenkins', patch),
  discover: (scanRoots) => ipcRenderer.invoke('settings:discover', scanRoots),
  pickDir: () => ipcRenderer.invoke('settings:pickDir'),
  revealConfig: () => ipcRenderer.send('settings:reveal'),
  exportConfig: () => ipcRenderer.invoke('settings:export'),
  importConfig: () => ipcRenderer.invoke('settings:import'),
  certPolicyChanged: () => ipcRenderer.send('settings:certPolicy'),
  openExternal: (url) => ipcRenderer.send('settings:openExternal', url)
});
