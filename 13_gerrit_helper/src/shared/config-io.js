'use strict';

// 配置导入导出。纯函数，不碰文件系统也不碰 electron —— 可以直接 node --test。
//
// 一条铁律：**凭据永远不进导出文件，也永远不从导入文件里读**。
// 换机器后重新填一次密码/Token，比让凭据躺在明文 JSON 里安全得多。

const EXPORT_VERSION = 1;
const SECRET_KEYS = ['password', 'jenkinsToken', 'secret'];
const META_KEYS = ['_app', '_version', '_exportedAt'];

function toExportable(config, { now = () => new Date().toISOString() } = {}) {
  const out = { _app: 'gerrit-helper', _version: EXPORT_VERSION, _exportedAt: now() };
  for (const [key, value] of Object.entries(config || {})) {
    if (SECRET_KEYS.includes(key) || META_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function sanitizeImport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('文件内容不是一个配置对象');
  }
  const out = { ...raw };
  for (const key of [...SECRET_KEYS, ...META_KEYS]) delete out[key];
  return out;
}

// 导入时给出人话摘要，设置页用来显示"导入了什么"
function summarize(config) {
  const parts = [];
  if (config.server) parts.push(config.server);
  if (config.track?.length) parts.push(`${config.track.length} 个跟踪项`);
  if (config.jenkins?.jobs?.length) parts.push(`${config.jenkins.jobs.length} 个构建 job`);
  return parts.join(' · ') || '空配置';
}

module.exports = { EXPORT_VERSION, SECRET_KEYS, sanitizeImport, summarize, toExportable };
