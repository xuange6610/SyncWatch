'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');
const { waitForChromeDebugTarget } = require('./chrome-debug-target');

const browserCandidates = [
  process.env.SYNCWATCH_CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
].filter(Boolean);
const chromePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
if (!chromePath) throw new Error('Chrome 或 Edge 不存在，无法运行 UI 文案浏览器验收。');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function connect(baseUrl) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
    const timer = setTimeout(() => { socket.close(); reject(new Error('Socket.IO 连接超时')); }, 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (error) => { clearTimeout(timer); socket.close(); reject(error); });
  });
}

function ack(socket, event, payload = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 响应超时`)), timeout);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result || {}); });
  });
}

function once(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 事件超时`)), timeout);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

async function acceptAgreement(socket, result) {
  if (!result?.success || !result.capabilities?.agreementRequired) return result;
  const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: result.agreement.version });
  assert.equal(accepted.success, true, accepted.error);
  return result;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

class CdpClient {
  constructor(url) { this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); }
  async open() {
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
    this.socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result || {});
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  close() { try { this.socket.close(); } catch (_) {} }
}

async function evaluate(cdp, expression) {
  // Keep the page-side promise strongly reachable while CDP awaits it. Chrome can
  // otherwise collect a transient promise under the full test suite's load.
  const heldExpression = `window.__syncwatchCdpEval = (async () => await (0, eval)(${JSON.stringify(expression)}))(); window.__syncwatchCdpEval`;
  const result = await cdp.send('Runtime.evaluate', { expression: heldExpression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '浏览器脚本执行失败');
  return result.result?.value;
}

async function waitFor(cdp, expression, description, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await evaluate(cdp, expression)) return; } catch (_) {}
    await delay(100);
  }
  throw new Error(`等待“${description}”超时`);
}

async function stopProcess(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', resolve); killer.once('error', resolve);
    });
  } else child.kill('SIGTERM');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-ui-copy-browser-'));
  const dataDir = path.join(root, 'data');
  const sockets = [];
  let server; let chrome; let cdp; let profile; let chromeStderr = '';
  try {
    server = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir, discovery: false, publicDir: path.resolve(__dirname, '..', 'public'), ffprobePath: '', ffmpegPath: '', hostControlToken: 'ui-copy-browser-host' });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    const bootstrapAdmin = await connect(baseUrl); sockets.push(bootstrapAdmin);
    const adminLogin = await acceptAgreement(bootstrapAdmin, await ack(bootstrapAdmin, 'host-admin-login', {
      adminPassword: 'admin888', hostToken: 'ui-copy-browser-host', roomId: publicConfig.roomId,
      deviceId: 'ui-copy-browser-admin', deviceName: 'UI Copy Browser Admin'
    }));
    assert.equal(adminLogin.success, true, adminLogin.error);
    assert.ok(adminLogin.token, '管理员浏览器令牌缺失');
    bootstrapAdmin.close(); sockets.splice(sockets.indexOf(bootstrapAdmin), 1);

    const member = await connect(baseUrl); sockets.push(member);
    const registration = await ack(member, 'user-register', { username: 'CopyBrowserMember', password: 'copy-browser-pass' });
    assert.equal(registration.success, true, registration.error);
    const memberLogin = await acceptAgreement(member, await ack(member, 'user-login', {
      username: 'CopyBrowserMember', password: 'copy-browser-pass', roomId: publicConfig.roomId,
      deviceId: 'ui-copy-browser-member', deviceName: 'UI Copy Browser Member'
    }));
    assert.equal(memberLogin.success, true, memberLogin.error);

    const debugPort = await availablePort();
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-ui-copy-chrome-'));
    chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    chrome.stderr?.on('data', (chunk) => { chromeStderr = `${chromeStderr}${chunk}`.slice(-12000); });
    const target = await waitForChromeDebugTarget({
      port: debugPort,
      child: chrome,
      stderrTail: () => chromeStderr
    });
    cdp = new CdpClient(target.webSocketDebuggerUrl); await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      if (location.origin === ${JSON.stringify(baseUrl)}) {
        localStorage.setItem('syncwatchToken', ${JSON.stringify(adminLogin.token)});
        localStorage.setItem('syncwatchDeviceId', 'ui-copy-browser-admin');
      }
    ` });
    await cdp.send('Page.navigate', { url: `${baseUrl}/` });
    await waitFor(cdp, 'document.readyState === "complete" && Boolean(window.SyncWatchUiCopy)', '界面文案运行时加载');
    await waitFor(cdp, 'window.SyncWatchUiCopy.coverage().catalogEntries > 100', '自动文案目录建立');
    await waitFor(cdp, 'Boolean(state.authenticated && state.capabilities.serverHost)', '管理员浏览器登录');

    const desktop = await evaluate(cdp, 'window.SyncWatchUiCopy.coverage()');
    assert.ok(desktop.catalogEntries > 100, `稳定文案键太少：${desktop.catalogEntries}`);
    assert.ok(desktop.totalButtons > 300, `页面按钮统计异常：${desktop.totalButtons}`);
    assert.equal(await evaluate(cdp, `document.querySelector('#playbackQualitySelect option:checked').value`), 'original');
    if (desktop.buttonCoveragePercent < 100) {
      const uncovered = await evaluate(cdp, `[...document.querySelectorAll('button')].filter((button) => {
        if (button.closest('[data-copy-ignore="true"]') || button.matches('[data-chat-emoji], [data-reaction], [data-emoji]')) return false;
        const text = button.textContent.trim();
        if (!/[\\p{L}\\p{N}]/u.test(text) && /[\\p{Extended_Pictographic}\\p{Emoji_Presentation}\\p{Emoji_Modifier}\\u200d\\ufe0f]/u.test(text)) return false;
        const own = button.dataset?.uiCopyTextKey || button.dataset?.uiCopyAttributeKeys;
        const child = [...button.querySelectorAll('*')].some((element) => element.dataset?.uiCopyTextKey || element.dataset?.uiCopyAttributeKeys);
        return !own && !child;
      }).slice(0, 120).map((button) => ({ id: button.id, text: button.textContent.trim(), html: button.outerHTML.slice(0, 240) }))`);
      throw new Error(`按钮覆盖率不足：${desktop.buttonCoveragePercent}%\n${JSON.stringify(uncovered, null, 2)}`);
    }

    const changed = await evaluate(cdp, `(() => {
      const button = [...document.querySelectorAll('button[id]')].find((candidate) => candidate.dataset.uiCopyTextKey || candidate.querySelector('[data-ui-copy-text-key]'));
      const key = button.dataset.uiCopyTextKey || button.querySelector('[data-ui-copy-text-key]').dataset.uiCopyTextKey;
      const before = button.textContent;
      window.SyncWatchUiCopy.apply({ [key]: '浏览器文案验收' });
      const after = button.textContent;
      window.SyncWatchUiCopy.apply({});
      return { key, before, after };
    })()`);
    assert.match(changed.key, /^ui\.(?:auto|)/);
    assert.equal(changed.after.includes('浏览器文案验收'), true);

    const stability = await evaluate(cdp, `(async () => {
      const button = document.getElementById('fullscreenSendBtn');
      const beforeKey = button.dataset.uiCopyTextKey;
      const beforeCount = window.SyncWatchUiCopy.entries().length;
      button.textContent = '发送消息';
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { beforeKey, afterKey: button.dataset.uiCopyTextKey, beforeCount, afterCount: window.SyncWatchUiCopy.entries().length };
    })()`);
    assert.equal(stability.afterKey, stability.beforeKey, '默认文案变化后稳定键不能变化');
    assert.equal(stability.afterCount, stability.beforeCount, '同一槽位改字不能产生新键');

    const dynamicSafety = await evaluate(cdp, `(async () => {
      const before = window.SyncWatchUiCopy.entries().length;
      const action = document.createElement('button');
      action.type = 'button'; action.dataset.fileAction = 'remove'; action.textContent = '删除影片';
      const privateName = document.createElement('span'); privateName.textContent = 'PrivateMovieName-203.0.113.42.mkv';
      document.getElementById('fileList').append(action, privateName);
      const toast = document.createElement('div'); toast.textContent = 'PrivateToast-203.0.113.42'; document.getElementById('toastRegion').appendChild(toast);
      document.getElementById('currentDeviceIp').textContent = '203.0.113.42';
      await new Promise((resolve) => setTimeout(resolve, 40));
      const entries = window.SyncWatchUiCopy.entries();
      const result = {
        before,
        after: entries.length,
        actionKey: action.dataset.uiCopyTextKey || '',
        leaked: entries.some((entry) => /PrivateMovieName|PrivateToast|203\\.0\\.113\\.42/.test(entry.defaultText)),
        exportBytes: new Blob([JSON.stringify({ version: 2, uiCopy: Object.fromEntries(entries.map((entry) => [entry.key, window.SyncWatchUiCopy.defaultText(entry.key)])) })]).size
      };
      action.remove(); privateName.remove(); toast.remove();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return result;
    })()`);
    assert.match(dynamicSafety.actionKey, /^ui\.auto\./, '动态列表中的固定操作按钮必须进入文案目录');
    assert.equal(dynamicSafety.leaked, false, '房间/IP/文件名/toast 等运行数据不能进入系统文案目录');
    assert.ok(dynamicSafety.exportBytes < 2 * 1024 * 1024, `完整文案导出超过 2 MB：${dynamicSafety.exportBytes}`);

    const dynamicDialogSafety = await evaluate(cdp, `(async () => {
      const secret = 'SecretMovie-203.0.113.9.mkv';
      const pending = showAppConfirm(secret, { title: '删除 ' + secret });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const entries = window.SyncWatchUiCopy.entries();
      const leaked = entries.some((entry) => entry.defaultText.includes(secret));
      const fixedKeys = ['dialog.close', 'dialog.fillRisk', 'dialog.back', 'dialog.cancel', 'dialog.confirm'];
      const catalogKeys = new Set(entries.map((entry) => entry.key));
      document.getElementById('appDialogCancelBtn').click();
      await pending;
      return { leaked, fixedKeysPresent: fixedKeys.every((key) => catalogKeys.has(key)), missingKeys: fixedKeys.filter((key) => !catalogKeys.has(key)) };
    })()`);
    assert.equal(dynamicDialogSafety.leaked, false, '动态确认框中的影片名和 IP 不能进入可导出的文案目录');
    assert.equal(dynamicDialogSafety.fixedKeysPresent, true, `动态对话框的固定操作仍必须支持统一文案配置：${JSON.stringify(dynamicDialogSafety)}`);

    const customDialogCopy = await evaluate(cdp, `(async () => {
      applyUiCopy({
        'dialog.close': '自定义关闭',
        'dialog.fillRisk': '自定义填入',
        'dialog.back': '自定义返回',
        'dialog.cancel': '自定义取消',
        'dialog.confirm': '自定义确定'
      });
      window.__customDialogCopyPromise = openAppDialog({ mode: 'confirm', allowBack: true, fillValue: 'DELETE' });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const actual = {
        close: document.getElementById('appDialogCloseBtn').getAttribute('aria-label'),
        fillRisk: document.getElementById('appDialogFillRiskBtn').textContent,
        back: document.getElementById('appDialogBackBtn').textContent,
        cancel: document.getElementById('appDialogCancelBtn').textContent,
        confirm: document.getElementById('appDialogConfirmBtn').textContent
      };
      document.getElementById('appDialogCancelBtn').click();
      await Promise.resolve();
      delete window.__customDialogCopyPromise;
      applyUiCopy({});
      return actual;
    })()`);
    assert.deepEqual(customDialogCopy, {
      close: '自定义关闭', fillRisk: '自定义填入', back: '自定义返回',
      cancel: '自定义取消', confirm: '自定义确定'
    }, '通用对话框打开后必须保留服务器统一文案配置');

    const generatedEditor = await evaluate(cdp, `(() => {
      state.adminSettings = { serverAdmin: true };
      renderUiCopySettings(state.uiCopy);
      const row = [...document.querySelectorAll('#uiCopyEditorList [data-ui-copy-key]')].find((item) => item.dataset.uiCopyKey.startsWith('ui.auto.'));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return { key: row.dataset.uiCopyKey, dialogVisible: !document.getElementById('appDialog').classList.contains('is-hidden'), title: document.getElementById('appDialogTitle').textContent };
    })()`);
    assert.equal(generatedEditor.dialogVisible, true, '自动生成键必须支持设置列表双击编辑');
    assert.equal(generatedEditor.title.includes(generatedEditor.key), true);
    await evaluate(cdp, `document.getElementById('appDialogCancelBtn').click()`);

    const saveEvent = once(member, 'ui-copy-state');
    await evaluate(cdp, `(() => {
      state.adminSettings = { ...(state.adminSettings || {}), serverAdmin: true };
      window.__uiCopySavePromise = editUiCopyKey('login.title');
      return true;
    })()`);
    await waitFor(cdp, `!document.getElementById('appDialog').classList.contains('is-hidden')`, '双击文案编辑窗口');
    await evaluate(cdp, `(() => {
      document.getElementById('appDialogInput').value = '浏览器实时同步标题';
      document.getElementById('appDialogConfirmBtn').click();
      return true;
    })()`);
    await evaluate(cdp, `window.__uiCopySavePromise`);
    const savedEvent = await saveEvent;
    assert.equal(savedEvent.uiCopy['login.title'], '浏览器实时同步标题');
    await waitFor(cdp, `document.getElementById('authTitle').textContent === '浏览器实时同步标题'`, '保存后当前浏览器实时应用文案');

    const exported = await evaluate(cdp, `(async () => {
      const originalCreateObjectURL = URL.createObjectURL;
      const originalAnchorClick = HTMLAnchorElement.prototype.click;
      let exportedBlob = null;
      let filename = '';
      URL.createObjectURL = (blob) => { exportedBlob = blob; return originalCreateObjectURL(blob); };
      HTMLAnchorElement.prototype.click = function captureDownload() { filename = this.download; };
      try {
        await exportUiCopy();
        return { filename, json: exportedBlob ? await exportedBlob.text() : '' };
      } finally {
        URL.createObjectURL = originalCreateObjectURL;
        HTMLAnchorElement.prototype.click = originalAnchorClick;
      }
    })()`);
    assert.match(exported.filename, /^SyncWatch-ui-copy-v\d+\.\d+\.\d+\.json$/);
    assert.equal(JSON.parse(exported.json).uiCopy['login.title'], '浏览器实时同步标题');

    const importEvent = once(member, 'ui-copy-state');
    await evaluate(cdp, `(async () => {
      const payload = { version: 2, uiCopy: { 'login.title': '浏览器导入同步标题' } };
      const transfer = new DataTransfer();
      transfer.items.add(new File([JSON.stringify(payload)], 'ui-copy.json', { type: 'application/json' }));
      elements.importUiCopyInput.files = transfer.files;
      await importUiCopyFile();
      return true;
    })()`);
    assert.equal((await importEvent).uiCopy['login.title'], '浏览器导入同步标题');
    await waitFor(cdp, `document.getElementById('authTitle').textContent === '浏览器导入同步标题'`, '导入后当前浏览器实时应用文案');

    const resetEvent = once(member, 'ui-copy-state');
    await evaluate(cdp, `(() => { window.__uiCopyResetPromise = resetUiCopy(); return true; })()`);
    await waitFor(cdp, `!document.getElementById('appDialog').classList.contains('is-hidden')`, '恢复默认确认窗口');
    await evaluate(cdp, `document.getElementById('appDialogConfirmBtn').click()`);
    await evaluate(cdp, `window.__uiCopyResetPromise`);
    assert.equal((await resetEvent).uiCopy['login.title'], '登录 SyncWatch同步观影');
    await waitFor(cdp, `document.getElementById('authTitle').textContent === '登录 SyncWatch同步观影'`, '恢复默认后当前浏览器实时应用文案');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const mobile = await evaluate(cdp, 'window.SyncWatchUiCopy.coverage()');
    assert.ok(mobile.totalButtons > 300, `移动端按钮统计异常：${mobile.totalButtons}`);
    assert.equal(mobile.buttonCoveragePercent, 100, `移动端按钮覆盖率不足：${mobile.buttonCoveragePercent}%`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    console.log(`统一文案浏览器验收通过：${desktop.catalogEntries} 个稳定键，按钮覆盖率 ${desktop.buttonCoveragePercent}%，桌面/390px 移动视口均可应用纯文本覆盖。`);
  } finally {
    cdp?.close();
    for (const socket of sockets) socket.close();
    await stopProcess(chrome);
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
    if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
