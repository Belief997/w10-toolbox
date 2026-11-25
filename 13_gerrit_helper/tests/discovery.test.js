'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  hostFromBase, parseGitreview, parseRemoteUrl, parseSshConfig, parseUrlRewrites,
  scanRootsForReview, toConfigPatch
} = require('../src/main/discovery');
const { cookieHeaderFor, parseCookieFile } = require('../src/main/credentials');

test('parseGitreview 读 [gerrit] 段', () => {
  const parsed = parseGitreview([
    '[gerrit]',
    'host=gerrit.example.com',
    'port=29418',
    'project=platform/frameworks/base.git',
    'defaultbranch=main'
  ].join('\n'));
  assert.deepStrictEqual(parsed, {
    host: 'gerrit.example.com', port: '29418',
    project: 'platform/frameworks/base.git', branch: 'main'
  });
});

test('parseRemoteUrl 认三种写法', () => {
  assert.deepStrictEqual(
    parseRemoteUrl('ssh://alice@gerrit.example.com:29418/platform/base'),
    { scheme: 'ssh', user: 'alice', host: 'gerrit.example.com', port: '29418', project: 'platform/base' }
  );
  assert.deepStrictEqual(
    parseRemoteUrl('git@gerrit.example.com:platform/base'),
    { scheme: 'ssh', user: '', host: 'gerrit.example.com', port: '', project: 'platform/base' }
  );
  assert.deepStrictEqual(
    parseRemoteUrl('https://gerrit.example.com/platform/base'),
    { scheme: 'https', user: '', host: 'gerrit.example.com', port: '', project: 'platform/base' }
  );
  assert.strictEqual(parseRemoteUrl('not a url'), null);
});

test('parseSshConfig 把 HostName 补到 alias 上', () => {
  const hosts = parseSshConfig([
    'Host gerrit',
    '  HostName gerrit.example.com',
    '  User alice',
    '  Port 29418',
    '',
    'Host *',
    '  ServerAliveInterval 30'
  ].join('\n'));
  assert.deepStrictEqual(hosts, [{ alias: 'gerrit', host: 'gerrit.example.com', user: 'alice', port: '29418' }]);
});

test('toConfigPatch 只产出服务器/用户/默认订阅，绝不含凭据', () => {
  const patch = toConfigPatch({ host: 'gerrit.example.com', port: '29418', username: 'alice' });
  assert.deepStrictEqual(patch, {
    server: 'https://gerrit.example.com',
    username: 'alice',
    track: ['q:owner:self status:open', 'q:reviewer:self is:open']
  });
  // 探测结果里就算带了密码字段，也不该被搬进配置
  const tainted = toConfigPatch({ host: 'g.example.com', username: 'x', password: 'secret', cookie: 'SID=1' });
  assert.ok(!('password' in tainted));
  assert.ok(!('cookie' in tainted));
  assert.strictEqual(toConfigPatch({}), null);
});

test('scanRootsForReview 在有界深度内找到 .gitreview', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gerrit-scan-'));
  try {
    const deep = path.join(root, 'work', 'android', 'frameworks');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, '.gitreview'), [
      '[gerrit]', 'host=gerrit.corp.example', 'port=29418', 'project=platform/base.git', ''
    ].join('\n'));
    // 这些目录要被跳过，否则扫描会跑进别人的代码库
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'x', '.gitreview'),
      ['[gerrit]', 'host=wrong.example', ''].join('\n'));

    const found = scanRootsForReview([root], { maxDepth: 3 });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].host, 'gerrit.corp.example');
    assert.strictEqual(found[0].project, 'platform/base.git');

    // 深度 2 之内找不到，说明确实是有界扫描
    assert.deepStrictEqual(scanRootsForReview([root], { maxDepth: 2 }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseUrlRewrites 认 insteadOf 和 pushInsteadOf', () => {
  const rewrites = parseUrlRewrites({
    'url.ssh://gerrit.example.com:29418.pushinsteadof': 'ssh://gerrit-mirror.example.com:29418',
    'url.https://gerrit.example.com/.insteadof': 'https://old.example.com/',
    'user.email': 'x@y.z'
  });
  assert.deepStrictEqual(rewrites, [
    { base: 'ssh://gerrit.example.com:29418', target: 'ssh://gerrit-mirror.example.com:29418' },
    { base: 'https://gerrit.example.com', target: 'https://old.example.com/' }
  ]);
});

test('hostFromBase 拆出 ssh / https 的 host 三件套', () => {
  assert.deepStrictEqual(hostFromBase('ssh://alice@gerrit.example.com:29418'),
    { scheme: 'ssh', user: 'alice', host: 'gerrit.example.com', port: '29418' });
  assert.deepStrictEqual(hostFromBase('ssh://gerrit.example.com:29418/'),
    { scheme: 'ssh', user: '', host: 'gerrit.example.com', port: '29418' });
  assert.deepStrictEqual(hostFromBase('https://gerrit.example.com'),
    { scheme: 'https', user: '', host: 'gerrit.example.com', port: '' });
  assert.strictEqual(hostFromBase('not a base'), null);
});

test('parseCookieFile 过滤过期项并去掉前导点', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const past = Math.floor(Date.now() / 1000) - 3600;
  const cookies = parseCookieFile([
    `.gerrit.example.com\tTRUE\t/\tFALSE\t${future}\tSID\tgood`,
    `.gerrit.example.com\tTRUE\t/\tFALSE\t${past}\tOLD\tdead`,
    'other.example.com\tFALSE\t/\tTRUE\t0\tX\tkeep'
  ].join('\n'));
  assert.deepStrictEqual(cookies.map((cookie) => cookie.name), ['SID', 'X']);
  assert.strictEqual(cookies[0].domain, 'gerrit.example.com');
});

test('cookieHeaderFor 只带匹配域名的 cookie', () => {
  const cookies = [
    { domain: 'gerrit.example.com', name: 'SID', value: 'a' },
    { domain: 'gerrit.example.com', name: 'CSRF', value: 'b' },
    { domain: 'example.org', name: 'OTHER', value: 'c' }
  ];
  assert.strictEqual(cookieHeaderFor(cookies, 'gerrit.example.com'), 'SID=a; CSRF=b');
  assert.strictEqual(cookieHeaderFor(cookies, 'sub.gerrit.example.com'), 'SID=a; CSRF=b');
  assert.strictEqual(cookieHeaderFor(cookies, 'nothing.test'), '');
});
