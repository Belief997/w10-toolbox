'use strict';

// Gerrit REST 客户端。跑在主进程：网页里做这件事会被 CORS 挡死，
// 而且凭据不该进渲染层。
//
// 用 Electron 的 net.fetch 而不是 Node 的 fetch：它走 Chromium 的网络栈，
// 能吃到系统代理设置，也能通过 session 的证书校验口子放行公司自签 CA。

const { net } = require('electron');

class GerritError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GerritError';
    this.status = status;
  }
}

// 用户粘进来的可能是 "host" / "host/gerrit" / "https://host/gerrit/#/c/proj/+/123"
function normalizeBase(input) {
  let text = String(input || '').trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const parsed = new URL(text);
    const path = parsed.pathname.replace(/\/+$/, '').replace(/\/a$/, '');
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch (_) { return ''; }
}

// 响应首行是防 JSON 劫持的前缀，必须丢掉才能 JSON.parse
function stripMagic(text) {
  if (!text.startsWith(")]}'")) return text;
  const index = text.indexOf('\n');
  return index < 0 ? '' : text.slice(index + 1);
}

// 从一个 URL/编号/Change-Id 里认出要查什么
function parseChangeRef(input) {
  const text = String(input || '').trim();
  const urlMatch = text.match(/\/c\/(.+?)\/\+?\/(\d+)/);
  if (urlMatch) return { project: urlMatch[1], number: urlMatch[2] };
  const hashMatch = text.match(/#?\/c\/(\d+)/);
  if (hashMatch) return { number: hashMatch[1] };
  if (/^\d+$/.test(text)) return { number: text };
  return { id: text };
}

// cookieProvider 是可选的：只在设置里选了「复用 ~/.gitcookies 会话」时才传进来，
// 每次请求现取，避免把会话凭据留在内存配置里。
function createClient({ baseUrl, username, password, cookieProvider = null, timeoutMs = 15000 }) {
  const base = normalizeBase(baseUrl);
  const auth = username
    ? `Basic ${Buffer.from(`${username}:${password || ''}`).toString('base64')}`
    : '';

  function authHeaders() {
    if (auth) return { Authorization: auth };
    const cookie = cookieProvider ? cookieProvider() : '';
    return cookie ? { Cookie: cookie } : {};
  }

  async function request(path, options = {}) {
    if (!base) throw new GerritError('未配置 Gerrit 服务器');
    const url = `${base}/a${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await net.fetch(url, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          ...authHeaders(),
          ...(options.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: options.body,
        signal: controller.signal,
        cache: 'no-store'
      });
    } catch (error) {
      clearTimeout(timer);
      if (error.name === 'AbortError') throw new GerritError(`超时（${timeoutMs}ms）`, 0);
      throw new GerritError(`连不上 ${base}：${error.message}`, 0);
    }
    clearTimeout(timer);

    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new GerritError('认证失败：检查用户名与 HTTP password', response.status);
    }
    if (!response.ok) {
      throw new GerritError(`HTTP ${response.status} ${text.slice(0, 160).trim()}`, response.status);
    }
    const body = stripMagic(text);
    if (!body.trim()) return null;
    try { return JSON.parse(body); } catch (_) {
      throw new GerritError('响应不是 JSON（是不是把首页地址填成了 REST 地址？）', response.status);
    }
  }

  // 列表不带 MESSAGES：一条查询可能回 25 个 change，带上评论整包会很大
  const DETAIL_LIST = 'o=CURRENT_REVISION&o=LABELS&o=DETAILED_ACCOUNTS';
  // 单条要带：卡片的时间线就是 messages
  const DETAIL_ONE = `${DETAIL_LIST}&o=MESSAGES`;

  return {
    base,
    hasAuth: Boolean(username),

    async self() {
      return request('/accounts/self');
    },

    async version() {
      const info = await request('/config/server/version').catch(() => null);
      return typeof info === 'string' ? info : info?.version || '';
    },

    // 单条 change 的完整信息。detail 端点比列表端点多给 submit 状态等，
    // 但每个跟踪项一次请求，数量可控（工具里通常十几个）。
    async change(ref) {
      const parsed = parseChangeRef(ref);
      const id = parsed.number || parsed.id || parsed.project;
      if (!id) throw new GerritError('空的 change 引用');
      return request(`/changes/${encodeURIComponent(id)}/detail?${DETAIL_ONE}`);
    },

    // 订阅式查询：一条 q 拿一批
    async query(q, limit = 25) {
      const query = String(q || '').trim();
      if (!query) return [];
      const params = new URLSearchParams({ q: query, n: String(limit), ...{} });
      for (const option of DETAIL_LIST.split('&')) {
        const [key, value] = option.split('=');
        params.append(key, value);
      }
      return request(`/changes/?${params.toString()}`);
    }
  };
}

// 限并发地跑一批异步任务。对 Gerrit 太凶会被限流，4 是个安全的数。
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = { ok: true, value: await worker(items[index], index) }; }
      catch (error) { results[index] = { ok: false, error }; }
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = { GerritError, createClient, mapLimit, normalizeBase, parseChangeRef, stripMagic };
