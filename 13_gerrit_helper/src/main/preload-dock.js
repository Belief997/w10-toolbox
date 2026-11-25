'use strict';

// 悬浮层的桥做得很窄：只能渲染主进程推来的东西 + 报告几个意图。
// 没有设置写入、没有凭据；打开链接也要过主进程的 https 白名单。

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => { try { callback(payload); } catch (_) { /* 渲染层出错不拖累主进程 */ } };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('gerritDock', {
  click: (index) => ipcRenderer.send('dock:click', { index }),
  reportCardSize: (height) => ipcRenderer.send('dock:cardSize', { height }),
  openUrl: (url) => ipcRenderer.send('dock:openUrl', { url }),
  refresh: () => ipcRenderer.send('dock:manualRefresh'),
  dragStart: () => ipcRenderer.send('dock:dragStart'),
  dragEnd: () => ipcRenderer.send('dock:dragEnd'),
  scroll: (delta) => ipcRenderer.send('dock:scroll', { delta }),
  openSettings: () => ipcRenderer.send('dock:openSettings'),
  onCells: (callback) => subscribe('dock:cells', callback),
  onFocus: (callback) => subscribe('dock:focus', callback),
  onShape: (callback) => subscribe('dock:shape', callback),
  onRevealed: (callback) => subscribe('dock:revealed', callback),
  onMaterial: (callback) => subscribe('dock:material', callback),
  onAppearance: (callback) => subscribe('dock:appearance', callback),
  onCard: (callback) => subscribe('card:cell', callback)
});
