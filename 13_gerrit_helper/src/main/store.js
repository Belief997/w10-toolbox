'use strict';

// 配置读写。数据跟着程序走（便携版语义）：打包后放 exe 同级 data/，
// 开发时放项目里的 data/ —— 拷走整个文件夹就能换机器。
//
// 凭据不落明文：password 和 jenkinsToken 一起塞进一个 JSON，
// 用 safeStorage（Windows 上是 DPAPI）加密后存成 secret 字段。
//
// 三条防丢措施：
//   1. 原子写（先写 .tmp 再 rename），进程被杀不会留下半截文件
//   2. 解析失败时把坏文件改名成 .broken 保留，不静默丢弃
//   3. 加密不可用时**不保存凭据**，绝不退回明文

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { DEFAULTS, normalize, parseTrackLine } = require('../shared/track');

let logger = { info: () => {}, warn: () => {} };
function setLogger(next) { if (next) logger = next; }

function dataDir() {
  const dir = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'data')
    : path.join(__dirname, '..', '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function configPath() {
  return path.join(dataDir(), 'config.json');
}

// 同目录 rename 在 Windows 上是原子的：要么是旧文件，要么是新文件
function writeAtomic(file, text) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

let cached = null;

function readSecrets(raw) {
  const empty = { password: '', jenkinsToken: '' };
  if (!raw.secret || !safeStorage.isEncryptionAvailable()) {
    // 兼容早期直接把凭据写在顶层字段里的配置
    return { password: raw.password || '', jenkinsToken: raw.jenkinsToken || '' };
  }
  let text = '';
  try { text = safeStorage.decryptString(Buffer.from(raw.secret, 'base64')); }
  catch (_) {
    logger.warn('[store] 凭据解密失败（换过 Windows 账号？），需要重新填写');
    return empty;
  }
  try {
    const parsed = JSON.parse(text);
    return {
      password: String(parsed?.password || ''),
      jenkinsToken: String(parsed?.jenkinsToken || '')
    };
  } catch (_) {
    // 老格式：secret 里只有密码
    return { password: text, jenkinsToken: '' };
  }
}

function load() {
  if (cached) return cached;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // 别静默丢掉用户的配置：坏文件留个副本，下次还能人工捞回来
      const broken = `${configPath()}.broken`;
      try { fs.renameSync(configPath(), broken); } catch (_) { /* 挪不动就算了 */ }
      logger.warn(`[store] 配置解析失败（${error.message}），已备份到 ${broken}`);
    }
  }
  const config = normalize(raw);
  Object.assign(config, readSecrets(raw));
  cached = config;
  return config;
}

function save(patch) {
  const config = normalize({ ...(cached || load()), ...(patch || {}) });
  const { password, jenkinsToken, ...rest } = config;
  const out = { ...rest };
  const secrets = { password: password || '', jenkinsToken: jenkinsToken || '' };

  if (secrets.password || secrets.jenkinsToken) {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        out.secret = safeStorage.encryptString(JSON.stringify(secrets)).toString('base64');
      } catch (error) {
        // 宁可不存，也不写明文
        logger.warn(`[store] 凭据加密失败，本次不保存凭据：${error.message}`);
      }
    } else {
      logger.warn('[store] 系统不支持加密存储，凭据不会落盘');
    }
  }

  writeAtomic(configPath(), `${JSON.stringify(out, null, 2)}\n`);
  cached = { ...config };
  return cached;
}

function get() { return cached || load(); }

// 有没有存下来的凭据：设置页用来显示"已保存"
function hasSecrets() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return Boolean(raw.secret) || Boolean(raw.password) || Boolean(raw.jenkinsToken);
  } catch (_) { return false; }
}

module.exports = {
  DEFAULTS, configPath, dataDir, get, hasSecrets, load, normalize, parseTrackLine, save, setLogger
};
