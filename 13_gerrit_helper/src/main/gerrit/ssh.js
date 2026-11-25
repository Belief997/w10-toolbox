'use strict';

// Gerrit 的 SSH 查询通道。
//
// 相比 REST 的好处：复用 ~/.ssh 里已经配好的密钥，不碰 HTTP 口令，
// 也不用管 SSO 门户 —— 企业内网里这是最省事的一条路。
//
// 输出是 JSON Lines，最后一行固定是 {"type":"stats"}，丢掉。
// 关键坑：
//   * `--current-patch-set` 在部分版本被弃用 → 启动时探测一次能力并缓存，
//     而不是每轮失败重试（那等于每轮多打一次 ssh 往返）
//   * 不传 `--comments` 就没有评论，卡片的时间线会是空的
//   * BatchMode=yes 保证密钥不可用时会立即失败，不会卡在一个要口令的提示上

const { execFile, execFileSync } = require('node:child_process');
const { parseChangeRef } = require('./client');

const DEFAULT_PORT = '29418';
const SSH_TIMEOUT_MS = 20000;

// 远端是 POSIX shell，用单引号包住并转义内部单引号最稳
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// 解析 JSON Lines：丢掉 stats 行，保留 change；遇到 error 行直接抛
function parseQueryOutput(text) {
  const changes = [];
  let stats = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (entry.type === 'stats') { stats = entry; continue; }
    if (entry.type === 'error') {
      const error = new Error(entry.message || 'Gerrit 查询失败');
      error.gerrit = true;
      throw error;
    }
    changes.push(entry);
  }
  return { changes, stats };
}

// SSH 的 change 对象 → REST 形状，好让上层的着色 / 角标 / 排序原样复用
function sshToRestShaped(change) {
  if (!change) return null;
  const patchSet = change.currentPatchSet || null;
  const labels = {};
  for (const approval of patchSet?.approvals || []) {
    const name = approval.type === 'CR' ? 'Code-Review'
      : approval.type === 'VRIF' ? 'Verified'
        : approval.type || 'Unknown';
    const value = Number(approval.value);
    if (!Number.isFinite(value)) continue;
    if (!labels[name]) labels[name] = { all: [] };
    labels[name].all.push({
      value,
      _account_id: null,
      name: approval.by?.name || approval.by?.username || ''
    });
  }
  return {
    _number: change.number,
    id: change.id,
    change_id: change.id,
    project: change.project,
    branch: change.branch,
    subject: change.subject,
    status: change.status,
    owner: change.owner,
    lastUpdated: change.lastUpdated,
    // toCell 走 parseGerritTime，数字按秒处理
    updated: change.lastUpdated,
    created: change.createdOn,
    current_revision: patchSet?.revision || null,
    revisions: patchSet ? { [patchSet.revision || 'current']: { _number: patchSet.number } } : {},
    labels,
    // --comments 给的是当前 patch set 的评论；时间线够用了
    messages: (change.comments || []).map((comment) => ({
      date: comment.timestamp,
      author: comment.reviewer || comment.author || {},
      message: comment.message || ''
    }))
  };
}

let sshChecked = null;

function sshAvailable() {
  if (sshChecked !== null) return sshChecked;
  try {
    execFileSync('ssh', ['-V'], { stdio: 'ignore', timeout: 4000, windowsHide: true });
    sshChecked = true;
  } catch (_) {
    sshChecked = false;
  }
  return sshChecked;
}

function createSshClient({ host, port = DEFAULT_PORT, user, keyFile = '', timeoutMs = SSH_TIMEOUT_MS }) {
  const target = user ? `${user}@${host}` : host;
  const baseArgs = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=8`, '-o', 'StrictHostKeyChecking=accept-new'];
  if (port) baseArgs.push('-p', String(port));
  if (keyFile) baseArgs.push('-i', keyFile);
  baseArgs.push(target);

  // 能力探测结果：{} → { patchSet: bool, comments: bool }
  let capabilities = null;

  function run(command, { timeout = timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      execFile('ssh', [...baseArgs, command], {
        timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8'
      }, (error, stdout, stderr) => {
        if (error) {
          const message = String(stderr || error.message || '').trim().split('\n').slice(-2).join(' ');
          const failure = new Error(message || 'ssh 执行失败');
          failure.code = error.code;
          failure.stderr = String(stderr || '');
          reject(failure);
          return;
        }
        resolve(stdout);
      });
    });
  }

  function queryCommand(text, { limit, patchSet, comments }) {
    const flags = ['--format=JSON'];
    if (patchSet) flags.push('--current-patch-set');
    if (comments) flags.push('--comments');
    const query = limit ? `${text} limit:${limit}` : text;
    // 末尾的 -- 是分隔符：查询里的减号不会被当成 ssh 选项
    return ['gerrit', 'query', ...flags, shellQuote(query), '--'].join(' ');
  }

  // 探测一次：带全部 flag 跑一个 limit:1 的空查询。
  // 某个 flag 不被支持就从 stderr 里认出来，之后一直用降级后的组合。
  async function ensureCapabilities() {
    if (capabilities) return capabilities;
    try {
      await run(queryCommand('status:open', { limit: 1, patchSet: true, comments: true }));
      capabilities = { patchSet: true, comments: true };
      return capabilities;
    } catch (error) {
      const stderr = String(error.stderr || '');
      const patchSetOk = !/current-patch-set/.test(stderr);
      const commentsOk = !/comments/.test(stderr);
      capabilities = { patchSet: patchSetOk, comments: commentsOk };
      if (!patchSetOk && !commentsOk) {
        // 两个都挂说明不是 flag 的问题（多半是密钥/主机不可达），把原始错误抛出去
        capabilities = null;
        throw error;
      }
      return capabilities;
    }
  }

  return {
    kind: 'ssh',
    base: `ssh://${target}:${port || DEFAULT_PORT}`,
    host,
    port,

    // SSH 通道没有 REST 的 /accounts/self；身份靠查询里的 owner:self 表达
    async self() { return null; },

    async version() {
      try {
        const output = await run('gerrit version', { timeout: 10000 });
        return String(output).trim().replace(/^gerrit version\s*/i, '');
      } catch (error) {
        throw new Error(error.message || 'ssh 连不上');
      }
    },

    async query(text, limit = 50) {
      const caps = await ensureCapabilities();
      const output = await run(queryCommand(String(text || '').trim(), {
        limit, patchSet: caps.patchSet, comments: caps.comments
      }));
      return parseQueryOutput(output).changes.map(sshToRestShaped).filter(Boolean);
    },

    // 和 REST 客户端的 change() 对齐，让轮询层不用按通道分支
    async change(ref) {
      const parsed = parseChangeRef(ref);
      const key = parsed.number || parsed.id;
      if (!key) return null;
      const list = await this.query(`change:${key}`, 1);
      return list[0] || null;
    }
  };
}

module.exports = {
  DEFAULT_PORT,
  createSshClient,
  parseQueryOutput,
  shellQuote,
  sshAvailable,
  sshToRestShaped
};
