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
  // 下载这一格的构建控制台日志（只有 build 格子有用）
  downloadLog: (cellId) => ipcRenderer.send('dock:downloadLog', { cellId }),
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
  onCard: (callback) => subscribe('card:cell', callback),
  // 日志下载的结果（进度谈不上，只有开始/成功/失败三态）
  onLogState: (callback) => subscribe('dock:logState', callback),
  // 手动刷新的进度：running → done
  onRefreshState: (callback) => subscribe('dock:refreshState', callback)
});
