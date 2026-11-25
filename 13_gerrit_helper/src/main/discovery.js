'use strict';

// 本机 Gerrit 配置探测。目标：第一次运行时不用手填服务器和用户名。
//
// 只读**非敏感**信息：host / port / project / 用户名。
// 密码和会话 cookie 一律不碰 —— 这里最多只报告"某个凭据文件存在"，
// 要不要用它由用户在设置里显式勾选，且由客户端在请求时现读，不复制、不落盘。
//
// 线索按可靠性排序：
//   1. 仓库里的 .gitreview        —— host + port + project，最权威
//   2. git remote -v 的 URL       —— ssh://user@host:29418/... 或 https://host/...
//   3. ~/.ssh/config 的 Host 块   —— Port 29418 或 HostName 含 gerrit
//   4. git config --global        —— gitreview.username / user.email 前缀
//
// 解析函数都是纯的，能直接 node --test；只有 collect() 碰文件系统和 git。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GERRIT_SSH_PORT = '29418';

// ---- 纯解析 --------------------------------------------------------------

// 逐行扫 [section] / key=value，足够对付 .gitreview 这种极简 ini
function parseGitreview(text) {
  const result = {};
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) { section = header[1].toLowerCase(); continue; }
    const pair = line.match(/^([^=]+)=(.*)$/);
    if (!pair) continue;
    const key = pair[1].trim().toLowerCase();
    const value = pair[2].trim();
    if (section === 'gerrit' || key === 'host') result[key] = value;
  }
  return {
    host: result.host || '',
    port: result.port || '',
    project: result.project || '',
    branch: result.defaultbranch || ''
  };
}

// ssh://user@host:29418/project  /  https://host/project  /  git@host:project
function parseRemoteUrl(url) {
  const text = String(url || '').trim();
  if (!text) return null;
  let match = text.match(/^ssh:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?\/(.+)$/);
  if (match) {
    return {
      scheme: 'ssh',
      user: match[1] && match[1] !== 'ssh' ? match[1] : '',
      host: match[2],
      port: match[3] || '',
      project: match[4]
    };
  }
  match = text.match(/^(?:git@)([^:]+):(.+)$/);
  if (match) return { scheme: 'ssh', user: '', host: match[1], port: '', project: match[2] };
  match = text.match(/^(https?):\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?\/(.+)$/);
  if (match) {
    return {
      scheme: match[1],
      user: match[2] || '',
      host: match[3],
      port: match[4] || '',
      project: match[5]
    };
  }
  return null;
}

function looksLikeGerrit(entry) {
  if (!entry) return false;
  if (entry.port === GERRIT_SSH_PORT) return true;
  return /gerrit/i.test(entry.host || '');
}

// git 的 URL 重写：~/.gitconfig 里的
//   [url "ssh://host:29418"]  insteadOf / pushInsteadOf = <别的地址>
// 是"我确实往这台 Gerrit 推过东西"的强证据，而且全局唯一，不用满盘找 .gitreview。
// git config --list 会把 key 小写成 url.<base>.insteadof 这种形式。
function parseUrlRewrites(config) {
  const rewrites = [];
  for (const [key, value] of Object.entries(config || {})) {
    const match = key.match(/^url\.(.+?)\.(insteadof|pushinsteadof)$/);
    if (!match) continue;
    rewrites.push({ base: match[1].replace(/\/+$/, ''), target: value });
  }
  return rewrites;
}

// ssh://user@host:29418/  /  https://host/  → 拆成 host 三件套
function hostFromBase(base) {
  const text = String(base || '');
  let match = text.match(/^ssh:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?\/?$/);
  if (match) return { scheme: 'ssh', user: match[1] || '', host: match[2], port: match[3] || '' };
  match = text.match(/^(https?):\/\/([^/:]+)(?::(\d+))?\/?$/);
  if (match) return { scheme: match[1], user: '', host: match[2], port: match[3] || '' };
  return null;
}

// ~/.ssh/config：只认带 HostName / Port 29418 / 名字含 gerrit 的块
function parseSshConfig(text) {
  const hosts = [];
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...rest] = line.split(/\s+/);
    const value = rest.join(' ');
    if (/^host$/i.test(key)) {
      current = { alias: value, host: '', user: '', port: '' };
      hosts.push(current);
    } else if (current) {
      if (/^hostname$/i.test(key)) current.host = value;
      else if (/^user$/i.test(key)) current.user = value;
      else if (/^port$/i.test(key)) current.port = value;
    }
  }
  return hosts
    .map((entry) => ({ ...entry, host: entry.host || entry.alias }))
    .filter((entry) => entry.host && !entry.host.includes('*'));
}

// ---- 落盘探测 ------------------------------------------------------------

function readIfExists(file, limit = 256 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > limit) return '';
    return fs.readFileSync(file, 'utf8');
  } catch (_) { return ''; }
}

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

function gitOutput(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 4000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (_) { return ''; }
}

function globalGitConfig() {
  const map = {};
  for (const line of gitOutput(['config', '--global', '--list']).split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) map[line.slice(0, index).toLowerCase()] = line.slice(index + 1);
  }
  return map;
}

// 从 cwd 往上找第一个 .gitreview / 仓库根，顺手读它的 git remote
function scanUpward(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (let depth = 0; depth < 12; depth += 1) {
    const review = readIfExists(path.join(dir, '.gitreview'));
    const isRepo = fs.existsSync(path.join(dir, '.git'));
    if (review || isRepo) {
      const remotes = isRepo ? gitOutput(['remote', '-v'], dir) : '';
      return { dir, review, remotes };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// 在有界深度内找一个 .gitreview。应用自己的工作目录通常是工具目录，
// 用户的 Gerrit 仓库在别处，所以需要给几个扫描根。
// 带时间预算：宁可少扫一层，也不要让启动卡住。
const SKIP_DIRS = new Set(['node_modules', 'out', 'build', 'dist', 'target', 'vendor']);

function scanRootsForReview(roots, options = {}) {
  const { maxDepth = 3, budgetMs = 2000 } = options;
  const started = Date.now();
  const queue = (roots || []).filter(Boolean).map((dir) => ({ dir: path.resolve(dir), depth: 0 }));
  const found = [];
  const seen = new Set();
  while (queue.length && Date.now() - started < budgetMs) {
    const { dir, depth } = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    const review = readIfExists(path.join(dir, '.gitreview'));
    if (review) {
      const parsed = parseGitreview(review);
      if (parsed.host) { found.push({ dir, ...parsed }); continue; }
    }
    if (depth >= maxDepth) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      // 跳过隐藏目录（.git/.repo/.gradle）和构建产物目录
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return found;
}

// 凭据文件只报告存在性，不解析内容 —— 用不用由用户决定
function credentialHints(home) {
  const hints = [];
  if (exists(path.join(home, '.gitcookies')) || exists(path.join(home, '_gitcookies'))) {
    hints.push({ kind: 'gitcookies', text: '检测到 ~/.gitcookies：SSO 门户登录的环境可以直接复用它，不用另生成 HTTP password' });
  }
  if (exists(path.join(home, '.netrc'))) {
    hints.push({ kind: 'netrc', text: '检测到 ~/.netrc：如果里面有这台服务器的条目，用户名一般也在这里' });
  }
  return hints;
}

function collect({ cwd = process.cwd(), home = os.homedir(), scanRoots = [], logger } = {}) {
  const notes = [];
  const config = globalGitConfig();
  const sshHosts = parseSshConfig(readIfExists(path.join(home, '.ssh', 'config')));

  // 先按用户给的扫描根找 .gitreview；找不到再沿 cwd 往上走
  const fromRoots = scanRootsForReview(scanRoots);
  const scan = fromRoots.length
    ? { dir: fromRoots[0].dir, review: readIfExists(path.join(fromRoots[0].dir, '.gitreview')), remotes: '' }
    : scanUpward(cwd);

  // 服务器：.gitreview → remote URL → ssh config
  let host = '';
  let port = '';
  let remoteUser = '';
  let project = '';
  let source = '';

  if (scan?.review) {
    const parsed = parseGitreview(scan.review);
    if (parsed.host) {
      host = parsed.host;
      port = parsed.port || GERRIT_SSH_PORT;
      project = parsed.project;
      source = path.join(scan.dir, '.gitreview');
      notes.push(`仓库 .gitreview：${parsed.project || '(无 project)'}`);
    }
  }

  if (!host && scan?.remotes) {
    for (const line of scan.remotes.split(/\r?\n/)) {
      const match = line.match(/^\S+\s+(\S+)/);
      const entry = match && parseRemoteUrl(match[1]);
      if (entry && looksLikeGerrit(entry)) {
        host = entry.host;
        port = entry.port;
        remoteUser = entry.user;
        project = entry.project;
        source = 'git remote';
        notes.push(`git remote：${entry.scheme}://${entry.host}/${entry.project}`);
        break;
      }
    }
  }

  // ~/.gitconfig 的 url 重写：全局、最省事的一条线索
  if (!host) {
    const rewrite = parseUrlRewrites(config)
      .map((entry) => hostFromBase(entry.base))
      .find((entry) => looksLikeGerrit(entry));
    if (rewrite) {
      host = rewrite.host;
      port = rewrite.port || GERRIT_SSH_PORT;
      remoteUser = rewrite.user;
      source = '~/.gitconfig url 重写';
      notes.push(`git url 重写：${rewrite.scheme}://${rewrite.host}${rewrite.port ? `:${rewrite.port}` : ''}`);
    }
  }

  if (!host) {
    const sshEntry = sshHosts.find((entry) => looksLikeGerrit(entry));
    if (sshEntry) {
      host = sshEntry.host;
      port = sshEntry.port || '';
      remoteUser = sshEntry.user;
      source = '~/.ssh/config';
      notes.push(`ssh 配置：${sshEntry.alias} → ${sshEntry.host}`);
    }
  }

  // 用户名：gitreview.username → remote URL → ssh user → user.email 前缀
  let username = config['gitreview.username'] || '';
  if (username) notes.push('git config gitreview.username');
  if (!username && remoteUser) { username = remoteUser; notes.push('remote/ssh 里的用户'); }
  if (!username && config['user.email']) {
    username = String(config['user.email']).split('@')[0];
    notes.push('git config user.email 前缀');
  }

  const hints = credentialHints(home);
  notes.unshift(host ? `服务器：${host}` : '没找到 Gerrit 服务器');

  logger?.info(`[discovery] ${notes.join(' / ')}`);
  return {
    host, port, username, project, source, notes,
    hints,
    scannedDir: scan?.dir || ''
  };
}

// 探测结果 → 建议的配置补丁。知道"我是谁"之后，默认就把该看的两类都订上，
// 不用再一行行填 change 号。注意这里**不含任何凭据**。
function toConfigPatch(found) {
  if (!found?.host) return null;
  const portSuffix = found.port && found.port !== GERRIT_SSH_PORT
    && found.port !== '443' && found.port !== '80'
    ? `:${found.port}` : '';
  return {
    server: `https://${found.host}${portSuffix}`,
    username: found.username || '',
    track: ['q:owner:self status:open', 'q:reviewer:self is:open']
  };
}

module.exports = {
  GERRIT_SSH_PORT,
  collect,
  hostFromBase,
  parseUrlRewrites,
  scanRootsForReview,
  looksLikeGerrit,
  parseGitreview,
  parseRemoteUrl,
  parseSshConfig,
  toConfigPatch
};
