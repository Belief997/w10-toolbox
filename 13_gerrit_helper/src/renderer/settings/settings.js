'use strict';

(function main() {
  const api = window.gerritSettings;
  const $ = (id) => document.getElementById(id);
  const NEWLINE = String.fromCharCode(10);
  let saved = {};
  // 日志目录留空时主进程会用的那个路径（只用来做占位提示）
  let defaultLogDir = '';

  // 左栏切换：同一时间只显示一个分栏
  const navItems = [...document.querySelectorAll('.side-item')];
  const panes = [...document.querySelectorAll('.pane')];
  function selectPane(name) {
    for (const item of navItems) item.classList.toggle('is-active', item.dataset.pane === name);
    for (const pane of panes) pane.classList.toggle('is-active', pane.dataset.pane === name);
    const scroller = document.querySelector('.pane-scroll');
    if (scroller) scroller.scrollTop = 0;
  }
  for (const item of navItems) item.addEventListener('click', () => selectPane(item.dataset.pane));
  // 支持 ?pane=track 直接打开指定分栏（截图/自检用）
  const initialPane = new URLSearchParams(location.search).get('pane');
  if (initialPane) selectPane(initialPane);
  $('close').addEventListener('click', () => window.close());

  const trackToLines = (track) => (track || [])
    .map((item) => (item.kind === 'query' ? `q:${item.ref}` : item.ref))
    .join('\n');

  const linesToTrack = (text) => String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  // 背景不透明度和悬浮层用同一个映射，直接算成 rgba 画在外壳上。
  // （透明窗口里 `background: var(--glass)` 这种嵌套变量解析不稳定，见 README）
  // 设置窗自身的不透明度，独立于悬浮层。
  // 不靠 CSS 变量（透明窗口里嵌套 rgba 解析不稳定），JS 算好写进 style。
  function applyShellOpacity(percent) {
    const shell = $('shell');
    if (!shell) return;
    // 线性：100 = 完全不透明，0 = 全透
    const alpha = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
    shell.style.backgroundColor = `rgba(20, 24, 30, ${alpha.toFixed(3)})`;
  }

  function setResult(node, text, tone = '') {
    node.textContent = text;
    if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
  }

  function renderDiscovery(found) {
    const bar = $('discoveryBar');
    // 没识别到服务器时不挂横幅 —— "没找到"这种话不如直接让人填
    if (!found || !found.host) { bar.hidden = true; return; }
    bar.hidden = false;
    const notes = (found.notes || []).join(' · ');
    const hints = (found.hints || []).map((hint) => hint.text).join(' ');
    bar.innerHTML = `<b>已从本机配置识别</b><br><em>${notes}</em>`
      + (hints ? `<span class="banner-hint">${hints}</span>` : '');
  }

  function fill(config, configPath, demo, discovery, secrets = {}) {
    saved = config;
    // 凭据不会下发到渲染层：留空表示"不修改"，填了才覆盖
    $('password').value = '';
    $('password').placeholder = secrets.hasPassword ? '已保存 · 留空则不修改' : '未保存';
    $('jkToken').value = '';
    $('jkToken').placeholder = secrets.hasJenkinsToken ? '已保存 · 留空则不修改' : '未保存';
    $('server').value = config.server || '';
    $('username').value = config.username || '';
    $('track').value = trackToLines(config.track);
    $('mode').value = config.mode || 'always';
    $('snap').checked = config.snap !== false;
    $('sort').value = config.sort || 'urgency';
    $('material').value = config.material === 'tint' ? 'tint' : 'auto';
    $('glassAlpha').value = String(config.glassAlpha ?? 70);
    $('settingsAlpha').value = String(config.settingsAlpha ?? 92);
    $('settingsAlphaValue').textContent = `${$('settingsAlpha').value}%`;
    applyShellOpacity(config.settingsAlpha ?? 92);
    setRecentDays(config.recentDays ?? 14);
    $('alphaValue').textContent = `${$('glassAlpha').value}%`;
    $('interval').value = String(config.intervalSec || 60);
    $('notifyCr').checked = config.notify?.cr !== false;
    $('notifyStatus').checked = config.notify?.status !== false;
    $('notifyCi').checked = config.notify?.ci !== false;
    $('notifyReview').checked = config.notify?.review !== false;
    $('notifyComment').checked = config.notify?.comment !== false;
    $('notifyPatchset').checked = config.notify?.patchset === true;
    $('scanRoots').value = (config.scanRoots || []).join(NEWLINE);
    const jenkins = config.jenkins || {};
    $('jkUrl').value = jenkins.url || '';
    $('jkUser').value = jenkins.username || '';
    $('jkJobs').value = (jenkins.jobs || []).join(NEWLINE);
    $('jkLogDir').value = jenkins.logDir || '';
    $('jkLogDir').placeholder = defaultLogDir || '留空 = 程序目录下的 build_log';
    // 没存过密码、又检测到 ~/.gitcookies 时，预选 SSO 模式（还得点保存才生效）
    const hasCookieHint = (discovery?.hints || []).some((hint) => hint.kind === 'gitcookies');
    const authMode = config.authMode
      || (hasCookieHint && !config.password ? 'gitcookies' : 'basic');
    $('authMode').value = authMode;
    $('transport').value = config.transport || 'auto';
    $('sshPort').value = config.sshPort || '29418';
    $('sshUser').value = config.sshUser || '';
    $('sshKey').value = config.sshKey || '';
    renderDiscovery(discovery);
    $('allowInsecureCert').checked = config.allowInsecureCert === true;
    $('demoMode').checked = config.demo === true || demo === true;
    setResult($('configPath'), configPath);
  }

  function collect() {
    return {
      server: $('server').value.trim(),
      username: $('username').value.trim(),
      // 空字符串不外发 —— 主进程会把它当成"不修改"
      password: $('password').value,
      clearSecrets: false,
      track: linesToTrack($('track').value),
      mode: $('mode').value,
      snap: $('snap').checked,
      sort: $('sort').value,
      material: $('material').value,
      glassAlpha: Number($('glassAlpha').value),
      settingsAlpha: Number($('settingsAlpha').value),
      recentDays: Number($('recentDaysInput').value) || 0,
      intervalSec: Number($('interval').value) || 60,
      authMode: $('authMode').value,
      transport: $('transport').value,
      sshPort: $('sshPort').value.trim() || '29418',
      sshUser: $('sshUser').value.trim(),
      sshKey: $('sshKey').value.trim(),
      scanRoots: linesToTrack($('scanRoots').value),
      jenkinsToken: $('jkToken').value.trim(),
      jenkins: {
        url: $('jkUrl').value.trim(),
        username: $('jkUser').value.trim(),
        jobs: linesToTrack($('jkJobs').value),
        logDir: $('jkLogDir').value.trim()
      },
      notify: {
        cr: $('notifyCr').checked,
        status: $('notifyStatus').checked,
        ci: $('notifyCi').checked,
        review: $('notifyReview').checked,
        comment: $('notifyComment').checked,
        patchset: $('notifyPatchset').checked
      },
      allowInsecureCert: $('allowInsecureCert').checked,
      demo: $('demoMode').checked
    };
  }

  // ---- 显示类设置：拖动即生效（不落盘，关掉设置窗自动复原） --------------
  //
  // 用事件委托挂在 document 上：不依赖每个控件的 id 是否正确，
  // 也不会因为某个控件被重排/替换而丢事件。
  const PREVIEW_FIELDS = ['mode', 'snap', 'sort', 'glassAlpha', 'settingsAlpha', 'material'];
  let previewTimer = 0;

  function readDisplay() {
    return {
      mode: $('mode').value,
      snap: $('snap').checked,
      sort: $('sort').value,
      glassAlpha: Number($('glassAlpha').value),
      settingsAlpha: Number($('settingsAlpha').value),
      recentDays: Number($('recentDaysInput').value) || 0,
      material: $('material').value
    };
  }

  function emitPreview(event) {
    const id = event?.target?.id;
    if (id && !PREVIEW_FIELDS.includes(id)) return;
    clearTimeout(previewTimer);
    // 40ms 节流：滑杆会连续触发 input，没必要每次都重排窗口
    previewTimer = setTimeout(() => {
      const patch = readDisplay();
      try {
        api.preview(patch);
        // 自报状态：用户能一眼看出"渲染层到底发没发出去"
        const state = $('previewState');
        if (state) {
          state.textContent = `预览已应用：悬浮层 ${patch.glassAlpha}% · 设置窗 ${patch.settingsAlpha}%`;
          state.dataset.tone = 'ok';
        }
      } catch (error) {
        const state = $('previewState');
        if (state) { state.textContent = `预览发送失败：${error.message}`; state.dataset.tone = 'bad'; }
      }
    }, 40);
  }

  document.addEventListener('input', emitPreview, true);
  document.addEventListener('change', emitPreview, true);

  // 滑杆和数字框双向同步：滑杆最快，输天数最准
  function setRecentDays(value) {
    const days = Math.max(0, Math.min(365, Math.round(Number(value) || 0)));
    $('recentDays').value = String(Math.min(60, days));
    $('recentDaysInput').value = String(days);
    $('recentValue').textContent = days === 0 ? '不限' : String(days);
    return days;
  }

  $('recentDays').addEventListener('input', () => setRecentDays($('recentDays').value));
  $('recentDaysInput').addEventListener('input', () => {
    const days = setRecentDays($('recentDaysInput').value);
    // 数字框超过 60 天时滑杆停在末端，但数值以数字框为准
    if (days > 60) $('recentDays').value = '60';
  });

  $('glassAlpha').addEventListener('input', () => {
    $('alphaValue').textContent = `${$('glassAlpha').value}%`;
  });

  // 设置窗自己的不透明度：拖动即时生效，同时把值发给主进程记进补丁
  $('settingsAlpha').addEventListener('input', () => {
    $('settingsAlphaValue').textContent = `${$('settingsAlpha').value}%`;
    applyShellOpacity($('settingsAlpha').value);
  });

  // 主进程推来的外观（预览或保存后），设置窗自己也跟着变
  api.onAppearance((payload) => {
    if (payload?.settingsAlpha === undefined) return;
    applyShellOpacity(payload.settingsAlpha);
    if (document.activeElement?.id !== 'settingsAlpha') {
      $('settingsAlpha').value = String(payload.settingsAlpha);
      $('settingsAlphaValue').textContent = `${payload.settingsAlpha}%`;
    }
  });

  $('exportConfig').addEventListener('click', async () => {
    const button = $('exportConfig');
    button.disabled = true;
    try {
      const result = await api.exportConfig();
      if (result.canceled) setResult($('configResult'), '已取消');
      else if (result.ok) setResult($('configResult'), `已导出到 ${result.path}`, 'ok');
      else setResult($('configResult'), result.error || '导出失败', 'bad');
    } finally { button.disabled = false; }
  });

  $('importConfig').addEventListener('click', async () => {
    const button = $('importConfig');
    button.disabled = true;
    try {
      const result = await api.importConfig();
      if (result.canceled) { setResult($('configResult'), '已取消'); return; }
      if (!result.ok) { setResult($('configResult'), result.error || '导入失败', 'bad'); return; }
      fill(result.config, result.configPath, result.config.demo, undefined, {
        hasPassword: result.hasPassword, hasJenkinsToken: result.hasJenkinsToken,
        layers: result.layers
      });
      setResult($('configResult'), '已导入并应用', 'ok');
    } finally { button.disabled = false; }
  });

  $('test').addEventListener('click', async () => {
    const button = $('test');
    button.disabled = true;
    setResult($('testResult'), '连接中…');
    try {
      const result = await api.test(collect());
      if (result.ok) {
        const who = result.account ? `${result.account.name || result.account.id}` : '匿名（未认证）';
        const channel = result.transport === 'ssh' ? 'SSH' : 'HTTP';
        setResult($('testResult'),
          `连通 ✓ ${channel} · ${result.server}${result.version ? ` · Gerrit ${result.version}` : ''} · ${who}`, 'ok');
      } else {
        selectPane('server');
        setResult($('testResult'), result.error || '连接失败', 'bad');
      }
    } catch (error) {
      setResult($('testResult'), error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('save').addEventListener('click', async () => {
    const button = $('save');
    button.disabled = true;
    try {
      const result = await api.save(collect());
      if (result?.config) {
        fill(result.config, result.configPath, result.config.demo, undefined, {
          hasPassword: result.hasPassword,
          hasJenkinsToken: result.hasJenkinsToken,
          layers: result.layers
        });
      }
      // 证书策略是 session 级的，改完要立刻重装
      api.certPolicyChanged();
      setResult($('saveResult'), '已保存', 'ok');
      setTimeout(() => setResult($('saveResult'), ''), 2400);
    } catch (error) {
      setResult($('saveResult'), `保存失败：${error.message}`, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('testJenkins').addEventListener('click', async () => {
    const button = $('testJenkins');
    button.disabled = true;
    setResult($('jkResult'), '连接中…');
    try {
      const result = await api.testJenkins(collect());
      if (result.ok) {
        const ok = result.results.filter((entry) => entry.ok);
        const line = ok.map((entry) => `${entry.job} #${entry.number} ${entry.state}`).join(' · ');
        const bad = result.results.filter((entry) => !entry.ok);
        setResult($('jkResult'), `连通 ✓ ${line}${bad.length ? `　失败 ${bad.length} 个：${bad[0].error}` : ''}`, 'ok');
      } else {
        selectPane('build');
        setResult($('jkResult'), result.error || result.results?.[0]?.error || '连接失败', 'bad');
      }
    } catch (error) {
      setResult($('jkResult'), error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('discover').addEventListener('click', async () => {
    const button = $('discover');
    button.disabled = true;
    setResult($('discoverResult'), '检测中…');
    try {
      const found = await api.discover(linesToTrack($('scanRoots').value));
      renderDiscovery(found);
      // 只补空字段，不覆盖用户已经填过的
      if (found?.host && !$('server').value.trim()) $('server').value = `https://${found.host}`;
      if (found?.username && !$('username').value.trim()) $('username').value = found.username;
      if (found?.host && !$('track').value.trim()) {
        $('track').value = ['q:owner:self status:open', 'q:reviewer:self is:open'].join('\n');
      }
      if ((found?.hints || []).some((hint) => hint.kind === 'gitcookies') && !$('password').value) {
        $('authMode').value = 'gitcookies';
      }
      setResult($('discoverResult'), found?.host ? `识别到 ${found.host}` : '没找到 Gerrit 配置', found?.host ? 'ok' : 'bad');
    } catch (error) {
      setResult($('discoverResult'), error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('clearSecrets').addEventListener('click', async () => {
    if (!confirm('清除已保存的 Gerrit 密码和 Jenkins Token？')) return;
    const patch = collect();
    patch.clearSecrets = true;
    const result = await api.save(patch);
    if (result?.config) {
      fill(result.config, result.configPath, result.config.demo, undefined, {
        hasPassword: result.hasPassword, hasJenkinsToken: result.hasJenkinsToken,
        layers: result.layers
      });
    }
    selectPane('server');
    setResult($('saveResult'), '凭据已清除', 'ok');
  });

  $('revealConfig').addEventListener('click', () => api.revealConfig());

  // 「选择…」：走系统目录选择框，只取路径，不建目录
  $('jkLogDirPick').addEventListener('click', async () => {
    const result = await api.pickDir();
    if (result?.ok && result.path) $('jkLogDir').value = result.path;
  });

  api.load().then(({ config, configPath, demo, discovery, hasPassword, hasJenkinsToken,
    layers, version, startedAt, logDir }) => {
    defaultLogDir = logDir || '';
    fill(config, configPath, demo, discovery, { hasPassword, hasJenkinsToken, layers });
    // 标题栏显示版本和启动时刻：一眼看出这个设置窗是不是刚启动的实例
    const stamp = document.querySelector('.titlebar-sub');
    if (stamp && startedAt) {
      const at = new Date(startedAt);
      const hh = String(at.getHours()).padStart(2, '0');
      const mm = String(at.getMinutes()).padStart(2, '0');
      stamp.textContent = `设置 · v${version || '?'} · ${hh}:${mm} 启动`;
    }
  })
    .catch((error) => setResult($('saveResult'), error.message, 'bad'));
})();
