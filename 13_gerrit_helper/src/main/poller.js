'use strict';

// 拉取循环。一次 poll = 把配置里的跟踪项解析成 cells。
//
// 两类跟踪项走两条路：
//   change  → 每条一次（REST 走 /changes/{id}/detail，SSH 走 change:<n> 查询）
//   query   → 一条查询拿一批
//
// **身份靠查询来源判断**：从 `owner:self` 查回来的就是我提交的，
// 从 `reviewer:self` 查回来的是等我评审的。SSH 通道拿不到自己的 account id，
// REST 的 /accounts/self 也可能被关掉 —— 用来源标记比查身份更稳，
// 而且同一套逻辑两个通道都能用。
//
// 手动项用逐条请求而不是 `q=(change:1 OR change:2)`：OR 语法要 Gerrit 2.16+，
// 括号和空格的写法各版本有出入。逐条 + 限并发 4 在哪都能跑。

const { mapLimit } = require('./gerrit/client');
const { sortCells } = require('../shared/diff');
const { toBuildCell } = require('../shared/build');
const { toCell, toEvents } = require('../shared/model');
const { withRecency } = require('../shared/recency');
const { muteKey, mutedKeySet } = require('../shared/home-list');

// 前面加 (?<!-) 是为了不把 `-owner:self`（排除）当成"我的"
const ROLE_PATTERNS = [
  [/(?<!-)\bowner\s*:\s*self\b/i, 'owner'],
  [/(?<!-)\breviewer\s*:\s*self\b/i, 'reviewer']
];

function roleOfQuery(text) {
  for (const [pattern, role] of ROLE_PATTERNS) if (pattern.test(String(text || ''))) return role;
  return null;
}

// 同一条 change 从两条查询里都出现时，owner 优先：
// "我提交的"比"等我评审的"更能决定这一格的语义
function mergeRole(current, next) {
  if (!next) return current;
  if (!current) return next;
  return current === 'owner' || next === 'owner' ? 'owner' : current;
}

function createPoller({ getConfig, getClient, getJenkins, onCells, logger = console }) {
  let timer = null;
  let running = false;
  let busy = false;
  let failures = 0;
  // 上一轮成功的格子：拉取失败时继续显示，而不是把面板清空
  let lastGood = [];

  function nextDelay() {
    const base = getConfig().intervalSec * 1000;
    if (failures === 0) return base;
    // 失败退避：1× → 2× → 4×，封顶 5 分钟
    return Math.min(base * 2 ** Math.min(failures - 1, 3), 300000);
  }

  function schedule(delay) {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(poll, delay === undefined ? nextDelay() : delay);
  }

  async function poll() {
    timer = null;
    if (!running || busy) { schedule(); return; }
    busy = true;
    try {
      const result = await collect();
      failures = result.ok ? 0 : failures + 1;
      if (result.ok) {
        lastGood = result.cells || [];
        onCells?.(lastGood, result);
      } else {
        // 拉取失败**不清空面板**。以前这里推的是空数组，一次 SSH 超时就会让
        // 竖条上的圆环全部消失、变成"还没有跟踪的 change"，而退避最长 5 分钟
        // 才重试 —— 看起来就像项目丢了。保留上一轮的数据，只记日志。
        onCells?.(lastGood, { ...result, cells: lastGood, stale: true });
        logger.warn(`[poll] ${result.error}（保留上一轮 ${lastGood.length} 条）`);
      }
    } catch (error) {
      failures += 1;
      logger.warn(`[poll] 未捕获：${error.message}（保留上一轮 ${lastGood.length} 条）`);
      onCells?.(lastGood, { ok: false, error: error.message, cells: lastGood, stale: true });
    } finally {
      busy = false;
      // 一条数据都没有、又刚失败过：6 秒后就重试。
      // 启动那几秒最容易超时，按退避等下去面板会一直是空的。
      // 注意只在"失败"时加速 —— 成功但确实没有跟踪项，别去打扰 Gerrit。
      schedule(!lastGood.length && failures > 0 ? 6000 : undefined);
    }
  }

  async function collect() {
    const config = getConfig();
    const client = getClient();
    const jenkinsReady = Boolean(getJenkins?.());
    // 只配了 Jenkins、没配 Gerrit 也算可用
    if (!client && !jenkinsReady) return { ok: false, error: '未配置服务器', cells: [] };

    let selfId = null;
    if (client) {
      try {
        const self = await client.self();
        selfId = self?._account_id ?? null;
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          return { ok: false, error: error.message, cells: [], authFailed: true };
        }
      }
    }

    const changeRefs = client ? config.track.filter((item) => item.kind === 'change').map((item) => item.ref) : [];
    // 查询类跟踪项统一套上"最近 N 天"的过滤（用户自己写了日期条件的不动）
    const queries = client
      ? config.track.filter((item) => item.kind === 'query')
        .map((item) => withRecency(item.ref, config.recentDays))
      : [];
    const changes = new Map();
    const roles = new Map();
    const errors = [];

    const detailResults = await mapLimit(changeRefs, 4, (ref) => client.change(ref));
    for (const entry of detailResults) {
      if (entry.ok && entry.value) changes.set(entry.value._number, entry.value);
      else if (!entry.ok) errors.push(entry.error.message);
    }

    for (const query of queries) {
      const role = roleOfQuery(query);
      try {
        const list = await client.query(query);
        logger.info?.(`[poll] ${query} → ${(list || []).length} 条`);
        for (const change of list || []) {
          if (!changes.has(change._number)) changes.set(change._number, change);
          roles.set(change._number, mergeRole(roles.get(change._number), role));
        }
      } catch (error) {
        errors.push(error.message);
      }
    }

    // 链接用**网页**地址：SSH 通道的 base 是 ssh://user@host:29418，拼出来的链接
    // 浏览器打不开（"在 Gerrit 打开"会静默失败）。配置里有 http(s) 地址就用它。
    const webServer = /^https?:\/\//i.test(config.server || '') ? config.server : client.base;
    const allChangeCells = [...changes.values()].map((change) => {
      const cell = toCell(change, {
        server: webServer,
        selfId,
        role: roles.get(change._number) || null
      });
      cell.events = toEvents(change, 40);
      return cell;
    });
    // Jenkins 构建：和 Gerrit change 混排在同一根竖条里。
    // 构建挂了不影响 Gerrit 那部分照常显示。
    const buildCells = [];
    const jenkins = getJenkins?.();
    const jobs = config.jenkins?.jobs || [];
    if (jenkins && jobs.length) {
      const results = await mapLimit(jobs, 3, (job) => jenkins.status(job));
      for (const entry of results) {
        if (!entry.ok) { errors.push(`Jenkins: ${entry.error.message}`); continue; }
        const cell = toBuildCell(entry.value, { base: jenkins.base });
        if (cell) buildCells.push(cell);
      }
    }

    // 取消订阅的条目：不进竖条（也就不会再弹通知）。主界面要用**未过滤**的列表，
    // 所以两份都留着 —— allCells 里带 muted 标记的由主界面自己区分
    const muted = mutedKeySet(config.mutedItems);
    const allCells = sortCells([...allChangeCells, ...buildCells], config.sort);
    const cells = allCells.filter((cell) => !muted.has(muteKey(cell.id)));

    const authFailed = errors.some((message) => /认证失败|Permission denied|publickey|Unauthorized/i.test(message));
    return {
      ok: errors.length === 0 || cells.length > 0,
      authFailed,
      error: errors[0] || '',
      errors,
      selfId,
      transport: client?.kind || 'rest',
      cells,
      // 未过滤的（含已取消订阅的），主界面用
      allCells
    };
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      schedule(0);
    },
    stop() {
      running = false;
      clearTimeout(timer);
      timer = null;
    },
    pollNow() {
      if (!running) return;
      clearTimeout(timer);
      schedule(0);
    },
    restart() {
      this.stop();
      this.start();
    }
  };
}

module.exports = { createPoller, mergeRole, roleOfQuery };
