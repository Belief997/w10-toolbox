'use strict';

// 可选的 ~/.gitcookies 支持。
//
// 只在用户于设置里显式选择「复用 ~/.gitcookies 会话」时才会被调用；
// cookie 每次请求现读，不复制进配置、不写日志、不落盘。
//
// 为什么需要它：走 SSO 门户登录的 Gerrit 没有 HTTP password，
// git 本身也是靠这个文件鉴权的（`git config http.cookieFile`）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function cookieFileCandidates(home = os.homedir()) {
  return [path.join(home, '.gitcookies'), path.join(home, '_gitcookies')];
}

// Netscape cookie 文件：7 列 tab 分隔
//   domain  includeSubdomains  path  secure  expiry  name  value
function parseCookieFile(text) {
  const cookies = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const columns = line.split('\t');
    if (columns.length < 7) continue;
    const [domain, , , , expiry, name, value] = columns;
    const expires = Number(expiry);
    if (Number.isFinite(expires) && expires > 0 && expires * 1000 < Date.now()) continue;
    cookies.push({ domain: String(domain).replace(/^\./, '').toLowerCase(), name, value });
  }
  return cookies;
}

// 只取属于这台服务器的 cookie，拼成请求头
function cookieHeaderFor(cookies, hostname) {
  const target = String(hostname || '').replace(/^\./, '').toLowerCase();
  if (!target) return '';
  return cookies
    .filter((cookie) => target === cookie.domain || target.endsWith(`.${cookie.domain}`))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

// 供主进程在每次请求时调用。找不到文件或没有匹配项就返回空串（不报错）。
function readCookieHeader(serverUrl, home = os.homedir()) {
  let hostname = '';
  try { hostname = new URL(serverUrl).hostname; } catch (_) { return ''; }
  for (const file of cookieFileCandidates(home)) {
    try {
      if (!fs.statSync(file).isFile()) continue;
      const header = cookieHeaderFor(parseCookieFile(fs.readFileSync(file, 'utf8')), hostname);
      if (header) return header;
    } catch (_) { /* 没权限或没文件：当作没有 */ }
  }
  return '';
}

module.exports = { cookieFileCandidates, cookieHeaderFor, parseCookieFile, readCookieHeader };
