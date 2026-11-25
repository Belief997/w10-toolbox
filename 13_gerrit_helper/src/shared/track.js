'use strict';

// 跟踪项的解析与配置收敛。纯逻辑，不碰 electron，可以直接 node --test。

const DEFAULTS = Object.freeze({
  server: '',
  username: '',
  intervalSec: 60,
  // [{ kind: 'change'|'query', ref: '10231' | 'reviewer:self is:open' }]
  track: [],
  // always = 竖条常驻；autoHide = 只在光标靠边时露出
  mode: 'always',
  // 吸附到屏幕边缘；关掉后可以拖到任意位置
  snap: true,
  // 竖条左上角（DIP）。null = 自动放在右侧并垂直居中
  position: null,
  // urgency = 紧急度优先；recent = 最近更新优先
  sort: 'urgency',
  // auto = Win11 上用真亚克力；tint = 只用半透明底色
  material: 'auto',
  // 背景不透明度（0-100）。竖条直接用，卡片自动加厚保证文字可读。
  glassAlpha: 70,
  // 只看最近多少天的改动（0 = 不限）。默认两周
  recentDays: 14,
  // 设置窗自身的不透明度（0-100），和悬浮层分开调
  settingsAlpha: 92,
  // Jenkins 构建监控（可选）；logDir 留空 = 程序目录下的 build_log
  jenkins: { url: '', username: '', jobs: [], logDir: '' },
  // basic = HTTP password；gitcookies = 复用 ~/.gitcookies 的 SSO 会话；none = 匿名
  authMode: 'basic',
  // auto = 本机有 ssh 就走 SSH，否则回落 REST；ssh = 只用 SSH；rest = 只用 HTTP
  transport: 'auto',
  // SSH 通道用；留空则分别取 username 和 29418
  sshUser: '',
  sshPort: '29418',
  sshKey: '',
  // 自动检测时去这些目录找 .gitreview（深度 ≤3，最多扫 2 秒）
  scanRoots: [],
  notify: { cr: true, status: true, ci: true, review: true, comment: true, patchset: false },
  allowInsecureCert: false,
  demo: false
});

// 一行一个跟踪项：纯数字/Change-Id/URL 当 change，带查询关键字或 q: 前缀的当 query
const QUERY_HINTS = /\b(status|is|owner|reviewer|project|branch|label|message|subject|before|after|author|assignee|cc|star|hashtag|file|draft|wip|limit|age)\s*:/i;

function parseTrackLine(line) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('#')) return null;
  if (text.startsWith('q:')) return { kind: 'query', ref: text.slice(2).trim() };
  if (QUERY_HINTS.test(text) || /\s(OR|AND)\s/.test(text)) return { kind: 'query', ref: text };
  return { kind: 'change', ref: text };
}

function normalize(config) {
  const next = { ...DEFAULTS, ...(config || {}) };
  next.intervalSec = Math.max(20, Math.min(3600, Number(next.intervalSec) || 60));
  next.mode = next.mode === 'autoHide' ? 'autoHide' : 'always';

  next.sort = next.sort === 'recent' ? 'recent' : 'urgency';
  next.material = next.material === 'tint' ? 'tint' : 'auto';
  const settingsAlpha = Number(next.settingsAlpha);
  next.settingsAlpha = Number.isFinite(settingsAlpha)
    ? Math.max(0, Math.min(100, Math.round(settingsAlpha))) : 92;
  const days = Number(next.recentDays);
  next.recentDays = Number.isFinite(days) ? Math.max(0, Math.min(365, Math.round(days))) : 14;
  const alpha = Number(next.glassAlpha);
  next.glassAlpha = Number.isFinite(alpha) ? Math.max(0, Math.min(100, Math.round(alpha))) : 70;
  const jenkins = next.jenkins || {};
  next.jenkins = {
    url: String(jenkins.url || '').trim(),
    username: String(jenkins.username || '').trim(),
    // 一行一个 job 路径；folder 用 / 分隔
    jobs: (Array.isArray(jenkins.jobs) ? jenkins.jobs : [])
      .map((job) => String(job).trim()).filter(Boolean),
    // 控制台日志下载目录；空串 = 程序目录下的 build_log（见 main/index.js）
    logDir: String(jenkins.logDir || '').trim()
  };
  // 旧版本的位置字段，读到时顺手清掉（位置改由 position + snap 表达）
  delete next.offset;
  delete next.side;
  next.snap = next.snap !== false;
  // edge 记录"贴在哪个边"，顶部吸附要横排，靠它区分 ——
  // 只靠 x/y 猜的话，角上（顶部 + 侧边同时贴合）永远分不清该用哪种形态。
  const pos = next.position;
  const posEdge = pos?.edge;
  next.position = pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))
    ? {
      x: Math.round(Number(pos.x)),
      y: Math.round(Number(pos.y)),
      edge: ['top', 'left', 'right'].includes(posEdge) ? posEdge : null
    }
    : null;
  next.authMode = ['basic', 'gitcookies', 'none'].includes(next.authMode) ? next.authMode : 'basic';
  next.transport = ['auto', 'ssh', 'rest'].includes(next.transport) ? next.transport : 'auto';
  next.sshUser = String(next.sshUser || '').trim();
  next.sshPort = String(next.sshPort || '29418').trim() || '29418';
  next.sshKey = String(next.sshKey || '').trim();
  next.notify = { ...DEFAULTS.notify, ...(next.notify || {}) };
  next.scanRoots = (Array.isArray(next.scanRoots) ? next.scanRoots : [])
    .map((dir) => String(dir).trim())
    .filter(Boolean);
  next.track = (Array.isArray(next.track) ? next.track : [])
    .map((item) => (typeof item === 'string' ? parseTrackLine(item) : item))
    .filter((item) => item && item.kind && item.ref)
    .map((item) => ({ kind: item.kind === 'query' ? 'query' : 'change', ref: String(item.ref) }));
  delete next._comment;
  return next;
}

module.exports = { DEFAULTS, QUERY_HINTS, normalize, parseTrackLine };
