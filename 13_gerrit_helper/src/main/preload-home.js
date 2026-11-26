'use strict';

// 主界面的桥：只做"读项目列表 / 切换跟踪 / 刷新 / 关窗"，没有凭据、没有任意 URL。

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => { try { callback(payload); } catch (_) { /* 渲染层出错不拖累主进程 */ } };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('gerritHome', {
  load: () => ipcRenderer.invoke('home:load'),
  toggle: (id, tracked) => ipcRenderer.invoke('home:toggle', { id, tracked }),
  refresh: () => ipcRenderer.send('home:refresh'),
  close: () => ipcRenderer.send('home:close'),
  // 悬浮气泡：把这一行的位置报给主进程，气泡是**窗口外**的独立窗口
  hover: (id, rect) => ipcRenderer.send('home:hover', { id, rect }),
  unhover: () => ipcRenderer.send('home:unhover'),
  onState: (callback) => subscribe('home:state', callback)
});
