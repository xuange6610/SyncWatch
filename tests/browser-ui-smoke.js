'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const WebSocket = require('ws');
const { startSyncWatchServer } = require('../server');
const releaseVersion = String(require('../package.json').version);
const publicReleaseVersion = `v${releaseVersion}`;

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
  path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
].filter(Boolean);
const chromePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
if (!chromePath) throw new Error('Chrome or Microsoft Edge is required for the browser UI smoke test.');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const androidApkPath = path.join(__dirname, '..', 'dist', `SyncWatch-Android-${publicReleaseVersion}-universal.apk`);
const expectedAndroidDownloadAvailable = fs.existsSync(androidApkPath);

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.unref();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(fn, description, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const result = await fn(); if (result) return result; } catch (_) {}
    await delay(100);
  }
  throw new Error(`等待“${description}”超时`);
}

function socketAck(socket, event, payload = {}) {
  return new Promise((resolve) => socket.timeout(15000).emit(event, payload, (error, result) => resolve(error ? { success: false, error: error.message } : result)));
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
    this.socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id); this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result || {});
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.socket.close(); } catch (_) {} }
}

async function evaluate(cdp, expression) {
  let result;
  try {
    // Keep asynchronous page expressions reachable until CDP has resolved them.
    const heldExpression = `window.__syncwatchCdpEval = (async () => await (0, eval)(${JSON.stringify(expression)}))(); window.__syncwatchCdpEval`;
    result = await cdp.send('Runtime.evaluate', { expression: heldExpression, awaitPromise: true, returnByValue: true });
  } catch (error) {
    const preview = String(expression).replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(`${error.message} [Runtime.evaluate: ${preview}]`);
  }
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本执行失败');
  return result.result?.value;
}

async function capture(cdp, target) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
}

async function stopProcessTree(child) {
  if (!child || child.killed || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
  } else {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1000)]);
  }
}

async function removeDirectoryEventually(directory) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try { fs.rmSync(directory, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code) || attempt === 11) throw error;
      await delay(150);
    }
  }
}

async function main() {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
  const qualityOnly = process.argv.includes('--quality-only');
  const avatarOnly = process.argv.includes('--avatar-only');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-browser-ui-'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-chrome-profile-'));
  const outputDir = path.join(os.tmpdir(), 'syncwatch-ui-review');
  fs.mkdirSync(outputDir, { recursive: true });
  const images = [];
  let server; let authSocket; let chrome; let cdp;
  const sentMails = [];
  const originalFetch = global.fetch;
  global.fetch = (input, options) => {
    const url = String(input?.url || input);
    if (url === 'https://api.github.com/repos/xuange6610/SyncWatch/releases/latest') {
      return Promise.resolve(new Response(JSON.stringify({ tag_name: publicReleaseVersion, name: `SyncWatch同步观影 ${publicReleaseVersion}` }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }));
    }
    return originalFetch(input, options);
  };
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir: path.resolve(__dirname, '..', 'public'),
      ffprobePath: '', ffmpegPath: '', androidApkPath, hostControlToken: 'browser-ui-host',
      mailSender: async (message) => { sentMails.push(message); return { messageId: `browser-ui-mail-${sentMails.length}` }; }
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    authSocket = io(baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { 'cf-connecting-ip': '203.0.113.88' } });
    await new Promise((resolve, reject) => { authSocket.once('connect', resolve); authSocket.once('connect_error', reject); });
    assert.equal((await socketAck(authSocket, 'user-register', { username: 'BrowserUiOwner', password: '123456' })).success, true);
    const login = await socketAck(authSocket, 'room-create', {
      username: 'BrowserUiOwner', password: '123456', customRoomId: 'BROWSER1', roomName: '浏览器界面测试房间', maxUsers: 8,
      hostToken: 'browser-ui-host', deviceId: 'browser-ui-device'
    });
    assert.equal(login.success, true, login.error);
    const lockedRoomSocket = io(baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true });
    await new Promise((resolve, reject) => { lockedRoomSocket.once('connect', resolve); lockedRoomSocket.once('connect_error', reject); });
    const lockedRoom = await socketAck(lockedRoomSocket, 'room-create', {
      username: 'admin', password: 'admin888', customRoomId: 'LOCKED1', roomName: '浏览器密码房间', maxUsers: 8,
      roomPassword: 'browser-room-pass', deviceId: 'browser-locked-owner-device'
    });
    lockedRoomSocket.close();
    assert.equal(lockedRoom.success, true, lockedRoom.error);
    if (login.capabilities?.agreementRequired) {
      const accepted = await socketAck(authSocket, 'agreement-accept', { accepted: true, version: login.agreement?.version });
      assert.equal(accepted.success, true, accepted.error);
    }
    const mailSettings = await socketAck(authSocket, 'admin-action', {
      action: 'set-mail-settings', adminPassword: 'admin888', enabled: true,
      user: 'browser-ui@qq.com', authCode: 'browser-ui-smtp-secret', fromName: 'SyncWatch同步观影 测试'
    });
    assert.equal(mailSettings.success, true, mailSettings.error);
    const novelText = `第一章 同步阅读开始\n\n${'这是一段通过鉴权 Range 读取并同步翻页的 TXT 小说预览。\n'.repeat(180)}`;
    const novelForm = new FormData();
    novelForm.append('file', new Blob([Buffer.from(novelText)], { type: 'text/plain' }), '浏览器小说预览.txt');
    const novelUploadResponse = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.token}` }, body: novelForm
    });
    assert.equal(novelUploadResponse.status, 200);
    const novelFile = (await novelUploadResponse.json()).file;
    assert.equal(novelFile.category, 'text');
    assert.equal(novelFile.size, Buffer.byteLength(novelText), 'uploaded novel metadata must retain the complete byte length');
    const novelRangeResponse = await fetch(`${baseUrl}${novelFile.originalUrl}`, {
      headers: { Authorization: `Bearer ${login.token}`, Range: 'bytes=0-10485759' }
    });
    assert.equal(novelRangeResponse.status, 206);
    const novelRangeBytes = Buffer.from(await novelRangeResponse.arrayBuffer());
    assert.equal(novelRangeBytes.length, novelFile.size, 'authenticated text Range must return the complete novel below the preview limit');
    assert.equal(novelRangeBytes.toString('utf8'), novelText, 'authenticated text Range must preserve every character');
    authSocket.close(); authSocket = null;

    const debugPort = await findAvailablePort();
    chrome = spawn(chromePath, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--window-size=1365,860',
      '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, 'about:blank'
    ], { stdio: 'ignore', windowsHide: true });
    const targets = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      return response.ok ? response.json() : null;
    }, 'Chrome 调试页面');
    const target = targets.find((entry) => entry.type === 'page');
    if (!target?.webSocketDebuggerUrl) throw new Error('没有可用的 Chrome 页面');
    cdp = new CdpClient(target.webSocketDebuggerUrl); await cdp.open();
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__syncWatchSmokeErrors = [];
      window.addEventListener('error', (event) => window.__syncWatchSmokeErrors.push(String(event.error?.stack || event.message || 'error')));
      window.addEventListener('unhandledrejection', (event) => window.__syncWatchSmokeErrors.push(String(event.reason?.stack || event.reason || 'rejection')));
      if (location.origin === ${JSON.stringify(baseUrl)}) {
        if (sessionStorage.getItem('syncwatchSkipSmokeAutologin') === '1') localStorage.removeItem('syncwatchToken');
        else localStorage.setItem('syncwatchToken', ${JSON.stringify(login.token)});
        localStorage.setItem('syncwatchDeviceId', 'browser-ui-device');
        localStorage.removeItem('syncwatchPlaybackQuality');
        localStorage.removeItem('syncwatchUiTheme');
      }
    ` });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1365, height: 860, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${baseUrl}/?room=${encodeURIComponent(login.room.id)}` });
    try {
      await waitFor(() => evaluate(cdp, `Boolean(
        (document.getElementById('agreementModal') && !document.getElementById('agreementModal').classList.contains('is-hidden')) ||
        (typeof state !== 'undefined' && state.authenticated && !document.getElementById('mainPage')?.classList.contains('is-hidden'))
      )`), '浏览器首次协议或主界面');
      if (await evaluate(cdp, `Boolean(document.getElementById('agreementModal') && !document.getElementById('agreementModal').classList.contains('is-hidden'))`)) {
        await evaluate(cdp, `document.getElementById('agreementCheck').click(); document.getElementById('acceptAgreementBtn').click(); true`);
      }
      await waitFor(() => evaluate(cdp, `Boolean(typeof state !== 'undefined' && state.authenticated && !document.getElementById('mainPage')?.classList.contains('is-hidden'))`), '浏览器进入主界面');
    } catch (error) {
      const diagnostic = await evaluate(cdp, `({ href: location.href, token: localStorage.getItem('syncwatchToken'), device: localStorage.getItem('syncwatchDeviceId'), ready: document.readyState, stateReady: typeof state !== 'undefined', socketCreated: typeof state !== 'undefined' && Boolean(state.socket), connected: typeof state !== 'undefined' && Boolean(state.socket?.connected), authenticated: typeof state !== 'undefined' && state.authenticated, socketAuthenticated: typeof state !== 'undefined' && state.socketAuthenticated, lastError: typeof state !== 'undefined' && state.lastConnectionError, errors: window.__syncWatchSmokeErrors, loginStatus: document.getElementById('loginStatus')?.textContent, body: document.body?.innerText?.slice(0, 500) })`);
      throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`);
    }
    await delay(500);
    const desktopPlaybackQuality = await evaluate(cdp, `({
      state: state.playbackQuality,
      select: elements.playbackQualitySelect.value,
      saved: localStorage.getItem('syncwatchPlaybackQuality'),
      publicDefault: state.publicConfig.defaultPlaybackQuality
    })`);
    assert.equal(desktopPlaybackQuality.state, 'original', JSON.stringify(desktopPlaybackQuality));
    assert.equal(desktopPlaybackQuality.select, 'original', JSON.stringify(desktopPlaybackQuality));
    assert.equal(desktopPlaybackQuality.saved, null, JSON.stringify(desktopPlaybackQuality));
    assert.equal(desktopPlaybackQuality.publicDefault, 'original', JSON.stringify(desktopPlaybackQuality));
    const desktopMenuInteraction = await evaluate(cdp, `(() => {
      document.body.classList.add('topbar-compact');
      const menu = document.querySelector('.topbar-scroll-actions .topbar-menu');
      menu.open = true;
      const panel = menu.querySelector('.topbar-menu-panel');
      const button = panel?.querySelector('#masterMuteBtn');
      const label = button?.querySelector('.button-label');
      const rect = panel?.getBoundingClientRect();
      return {
        open: menu?.open === true,
        label: label ? getComputedStyle(label).display : '',
        labelText: label?.textContent || '',
        panelWithinViewport: Boolean(rect && rect.left >= 0 && rect.right <= innerWidth + 1)
      };
    })()`);
    assert.equal(desktopMenuInteraction.open, true, JSON.stringify(desktopMenuInteraction));
    assert.notEqual(desktopMenuInteraction.label, 'none', JSON.stringify(desktopMenuInteraction));
    assert.equal(desktopMenuInteraction.labelText, '全部静音', JSON.stringify(desktopMenuInteraction));
    assert.equal(desktopMenuInteraction.panelWithinViewport, true, JSON.stringify(desktopMenuInteraction));
    const desktopAutoCollapse = await evaluate(cdp, `(async () => {
      const menu = document.querySelector('.topbar-scroll-actions .topbar-menu');
      const trigger = menu.querySelector(':scope > summary');
      const nativeMatchMedia = window.matchMedia;
      window.matchMedia = (query) => query === '(hover: hover) and (pointer: fine)'
        ? { matches: true, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } }
        : nativeMatchMedia.call(window, query);
      menu.open = false; menu.dataset.menuPinned = 'false';
      trigger.click();
      const clickPinned = menu.open && menu.dataset.menuPinned === 'true';
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const outsideClosed = !menu.open;
      menu.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }));
      const hoverOpened = menu.open;
      menu.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, pointerType: 'mouse' }));
      await new Promise((resolve) => setTimeout(resolve, 180));
      window.matchMedia = nativeMatchMedia;
      return { clickPinned, outsideClosed, hoverOpened, hoverClosed: !menu.open };
    })()`);
    assert.deepEqual(desktopAutoCollapse, { clickPinned: true, outsideClosed: true, hoverOpened: true, hoverClosed: true }, JSON.stringify(desktopAutoCollapse));

    const memberPanelCollapse = await evaluate(cdp, `(() => {
      state.membersPanelCollapsed = false; applyMembersPanelCollapsed();
      const button = elements.collapseMembersPanelBtn;
      const before = button.getBoundingClientRect();
      button.click();
      const after = button.getBoundingClientRect();
      const result = {
        visibleBefore: before.width > 0 && before.height > 0,
        collapsed: document.querySelector('.workspace').classList.contains('members-panel-collapsed'),
        visibleAfter: after.width > 0 && after.height > 0,
        expandedAria: button.getAttribute('aria-expanded'),
        label: button.getAttribute('aria-label')
      };
      button.click();
      return result;
    })()`);
    assert.equal(memberPanelCollapse.visibleBefore, true, JSON.stringify(memberPanelCollapse));
    assert.equal(memberPanelCollapse.collapsed, true, JSON.stringify(memberPanelCollapse));
    assert.equal(memberPanelCollapse.visibleAfter, true, JSON.stringify(memberPanelCollapse));
    assert.equal(memberPanelCollapse.expandedAria, 'false');
    assert.match(memberPanelCollapse.label, /展开成员栏/);
    await evaluate(cdp, `(() => {
      if (typeof activeAppDialog !== 'undefined' && activeAppDialog) settleAppDialog(false);
      document.querySelectorAll('.modal:not(.is-hidden)').forEach((modal) => modal.classList.add('is-hidden'));
      if (typeof clearAllToasts === 'function') clearAllToasts();
      elements.clearAllToastsBtn?.classList.add('is-hidden');
      return true;
    })()`);
    const memberPanelPath = path.join(outputDir, 'member-panel-collapse-button-desktop.png'); await capture(cdp, memberPanelPath); images.push(memberPanelPath);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    const wideRoomHeader = await evaluate(cdp, `(() => {
      const header = document.getElementById('roomHeader');
      const headerRect = header?.getBoundingClientRect();
      const fields = [...(header?.querySelectorAll(':scope > span') || [])]
        .filter((field) => getComputedStyle(field).display !== 'none')
        .map((field) => {
          const value = field.querySelector('strong');
          const rect = field.getBoundingClientRect();
          const style = getComputedStyle(field);
          return { label: field.querySelector('small')?.textContent || '', text: value?.textContent || '', width: rect.width, right: rect.right, valueWidth: value?.getBoundingClientRect().width || 0, cssWidth: style.width, minWidth: style.minWidth, gridColumn: style.gridColumn };
        });
      return { hidden: header?.classList.contains('is-hidden'), width: headerRect?.width || 0, right: headerRect?.right || 0, display: header ? getComputedStyle(header).display : '', grid: header ? getComputedStyle(header).gridTemplateColumns : '', fields };
    })()`);
    assert.equal(wideRoomHeader.hidden, false, JSON.stringify(wideRoomHeader));
    assert.ok(wideRoomHeader.width > 0, JSON.stringify(wideRoomHeader));
    assert.ok(wideRoomHeader.fields.length >= 3, JSON.stringify(wideRoomHeader));
    assert.ok(wideRoomHeader.fields.every((field) => field.width > 0 && field.valueWidth > 0 && field.right <= wideRoomHeader.right + 1), JSON.stringify(wideRoomHeader));

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const mobileMenuInteraction = await evaluate(cdp, `(() => {
      document.body.classList.add('android-client', 'mobile-actions-open');
      const menu = document.querySelector('.topbar-scroll-actions .topbar-menu');
      menu.open = true;
      const panel = menu.querySelector('.topbar-menu-panel');
      const button = panel?.querySelector('#masterMuteBtn');
      const label = button?.querySelector('.button-label');
      const panelRect = panel?.getBoundingClientRect();
      const actionsRect = document.getElementById('topbarActions')?.getBoundingClientRect();
      return {
        position: panel ? getComputedStyle(panel).position : '',
        label: label ? getComputedStyle(label).display : '',
        panelWidth: panelRect?.width || 0,
        actionsWidth: actionsRect?.width || 0,
        panelWithinActions: Boolean(panelRect && actionsRect && panelRect.left >= actionsRect.left - 1 && panelRect.right <= actionsRect.right + 1)
      };
    })()`);
    assert.equal(mobileMenuInteraction.position, 'static', JSON.stringify(mobileMenuInteraction));
    assert.notEqual(mobileMenuInteraction.label, 'none', JSON.stringify(mobileMenuInteraction));
    assert.ok(mobileMenuInteraction.panelWidth > 0 && mobileMenuInteraction.panelWidth <= mobileMenuInteraction.actionsWidth + 1, JSON.stringify(mobileMenuInteraction));
    assert.equal(mobileMenuInteraction.panelWithinActions, true, JSON.stringify(mobileMenuInteraction));
    const mobileAccordionLayout = await evaluate(cdp, `(() => {
      const actions = document.getElementById('topbarActions');
      const menu = document.querySelector('.topbar-scroll-actions .topbar-menu');
      const panel = menu.querySelector('.topbar-menu-panel');
      const items = [...panel.querySelectorAll(':scope > button')].filter((item) => getComputedStyle(item).display !== 'none');
      const actionRect = actions.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const columns = items.map((item) => Math.round(item.getBoundingClientRect().left));
      const fixedLabels = [elements.serverSettingsLoginBtn, elements.copyAddressBtn]
        .filter((button) => button && getComputedStyle(button).display !== 'none')
        .map((button) => button.querySelector('.button-label'));
      return {
        menuFullWidth: menuRect.width >= actionRect.width - 22,
        panelFullWidth: panelRect.width >= menuRect.width - 2,
        singleColumn: new Set(columns).size <= 1,
        allLabelsVisible: items.every((item) => item.textContent.trim() && item.getBoundingClientRect().height >= 44),
        fixedLabelsVisible: fixedLabels.length === 2 && fixedLabels.every((label) => label?.textContent.trim() && getComputedStyle(label).display !== 'none')
      };
    })()`);
    assert.deepEqual(mobileAccordionLayout, { menuFullWidth: true, panelFullWidth: true, singleColumn: true, allLabelsVisible: true, fixedLabelsVisible: true }, JSON.stringify(mobileAccordionLayout));
    await evaluate(cdp, `(() => {
      if (typeof activeAppDialog !== 'undefined' && activeAppDialog) settleAppDialog(false);
      document.querySelectorAll('.modal:not(.is-hidden)').forEach((modal) => modal.classList.add('is-hidden'));
      if (typeof clearAllToasts === 'function') clearAllToasts();
      elements.clearAllToastsBtn?.classList.add('is-hidden');
      return true;
    })()`);
    const mobileAccordionPath = path.join(outputDir, 'mobile-topbar-accordion.png'); await capture(cdp, mobileAccordionPath); images.push(mobileAccordionPath);
    const endpointInteraction = await evaluate(cdp, `(() => {
      window.SyncWatchPlatform = { serverApp: true };
      state.hostToken = 'browser-ui-host';
      state.authenticated = true;
      state.capabilities.serverHost = true;
      state.publicConfigKnown = true;
      state.publicConfig.addresses = ['http://127.0.0.1:${server.port}'];
      renderServerEndpointStatus();
      const badge = elements.serverEndpointBadge;
      badge.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return { visible: !elements.serverEndpointDetailsModal.classList.contains('is-hidden'), address: elements.serverEndpointDetailsAddress.textContent };
    })()`);
    assert.equal(endpointInteraction.visible, true, JSON.stringify(endpointInteraction));
    assert.match(endpointInteraction.address, /127\.0\.0\.1/);
    const endpointCopyFallback = await evaluate(cdp, `(async () => {
      const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      const desktopDescriptor = Object.getOwnPropertyDescriptor(window, 'SyncWatchDesktop');
      let copied = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
      Object.defineProperty(window, 'SyncWatchDesktop', { configurable: true, value: { writeClipboardText: async (value) => { copied = value; return { success: true }; } } });
      await copyServerEndpointDetails();
      if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor); else delete navigator.clipboard;
      if (desktopDescriptor) Object.defineProperty(window, 'SyncWatchDesktop', desktopDescriptor); else delete window.SyncWatchDesktop;
      return { copied, toast: elements.toastRegion.textContent };
    })()`);
    assert.match(endpointCopyFallback.copied, /127\.0\.0\.1/);
    assert.match(endpointCopyFallback.toast, /局域网地址已复制/);
    await evaluate(cdp, `document.body.classList.remove('topbar-compact', 'android-client', 'mobile-actions-open'); document.querySelectorAll('.topbar-menu').forEach((menu) => { menu.open = false; }); elements.serverEndpointDetailsModal.classList.add('is-hidden'); true`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    const defaultPlaybackSource = await evaluate(cdp, `mediaSourceFor({
      url: '/media/compatible-example.mp4',
      originalUrl: '/media/original-example.mp4',
      compatibility: { required: true, ready: true },
      metadata: { videoCodec: 'HEVC' }
    })`);
    assert.deepEqual(defaultPlaybackSource, {
      url: '/media/original-example.mp4', variant: 'original'
    }, JSON.stringify(defaultPlaybackSource));
    const savedPlaybackQuality = await evaluate(cdp, `(async () => {
      localStorage.setItem('syncwatchPlaybackQuality', 'smooth');
      state.playbackQuality = 'smooth';
      elements.playbackQualitySelect.value = 'smooth';
      await loadPublicConfig();
      const result = {
        state: state.playbackQuality,
        select: elements.playbackQualitySelect.value,
        saved: localStorage.getItem('syncwatchPlaybackQuality'),
        publicDefault: state.publicConfig.defaultPlaybackQuality
      };
      localStorage.removeItem('syncwatchPlaybackQuality');
      state.playbackQuality = 'original';
      elements.playbackQualitySelect.value = 'original';
      return result;
    })()`);
    assert.deepEqual(savedPlaybackQuality, {
      state: 'smooth', select: 'smooth', saved: 'smooth', publicDefault: 'original'
    }, JSON.stringify(savedPlaybackQuality));
    if (qualityOnly) {
      await evaluate(cdp, `(() => {
        if (typeof activeAppDialog !== 'undefined' && activeAppDialog) settleAppDialog(false);
        document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('is-hidden'));
        elements.toastRegion.replaceChildren();
        elements.playbackQualitySelect.scrollIntoView({ block: 'center' });
        return true;
      })()`);
      await delay(120);
      const desktopPath = path.join(outputDir, 'playback-quality-original-desktop.png');
      await capture(cdp, desktopPath);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await evaluate(cdp, `elements.playbackQualitySelect.scrollIntoView({ block: 'center' }); true`);
      await delay(200);
      const mobilePlaybackQuality = await evaluate(cdp, `({
        state: state.playbackQuality,
        select: elements.playbackQualitySelect.value,
        publicDefault: state.publicConfig.defaultPlaybackQuality,
        bodyWidth: document.body.scrollWidth,
        viewport: innerWidth
      })`);
      assert.equal(mobilePlaybackQuality.state, 'original', JSON.stringify(mobilePlaybackQuality));
      assert.equal(mobilePlaybackQuality.select, 'original', JSON.stringify(mobilePlaybackQuality));
      assert.equal(mobilePlaybackQuality.publicDefault, 'original', JSON.stringify(mobilePlaybackQuality));
      assert.ok(mobilePlaybackQuality.bodyWidth <= mobilePlaybackQuality.viewport + 2, JSON.stringify(mobilePlaybackQuality));
      const mobilePath = path.join(outputDir, 'playback-quality-original-mobile.png');
      await capture(cdp, mobilePath);
      console.log(JSON.stringify({ success: true, desktopPlaybackQuality, defaultPlaybackSource, mobilePlaybackQuality, images: [desktopPath, mobilePath] }));
      return;
    }
    await evaluate(cdp, `if (typeof activeAppDialog !== 'undefined' && activeAppDialog) settleAppDialog(false); true`);
    await delay(120);
    await evaluate(cdp, `openDownloadCenter(true); true`);
    await waitFor(() => evaluate(cdp, `document.getElementById('downloadUpdateStatus')?.textContent.includes(${JSON.stringify(`GitHub 最新正式版本 ${publicReleaseVersion}`)})`), '同源检查 GitHub Latest');
    assert.equal(await evaluate(cdp, `document.getElementById('downloadCenterModal').classList.contains('is-hidden')`), false);
    await evaluate(cdp, `document.getElementById('closeDownloadCenterBtn').click(); true`);
    const browserNovelTransfer = await evaluate(cdp, `(async () => {
      const response = await fetch(mediaUrlWithSessionToken(${JSON.stringify(novelFile.originalUrl)}), {
        credentials: 'same-origin', headers: { Range: 'bytes=0-10485759' }
      });
      const buffer = await response.arrayBuffer();
      return { status: response.status, bytes: buffer.byteLength, contentRange: response.headers.get('content-range'), characters: decodeTextPreview(buffer).length };
    })()`);
    assert.equal(browserNovelTransfer.status, 206, JSON.stringify(browserNovelTransfer));
    assert.equal(browserNovelTransfer.bytes, novelFile.size, JSON.stringify(browserNovelTransfer));
    assert.equal(browserNovelTransfer.characters, novelText.length, JSON.stringify(browserNovelTransfer));
    await evaluate(cdp, `(async () => { await selectFile(${JSON.stringify(novelFile.id)}); return true; })()`);
    await waitFor(() => evaluate(cdp, `document.getElementById('textViewer')?.textContent.includes('通过鉴权 Range 读取')`), 'TXT 小说预览');
    const textPreview = await evaluate(cdp, `({
      visible: !document.getElementById('textViewer').classList.contains('is-hidden'),
      controlsVisible: !document.getElementById('textReaderControls').classList.contains('is-hidden'),
      fileId: document.getElementById('textViewer').dataset.fileId,
      iframeHidden: document.getElementById('documentViewer').classList.contains('is-hidden'),
      content: document.getElementById('textViewer').textContent,
      pageCount: Number(document.getElementById('textReaderPageCount').textContent),
      currentFile: { size: state.currentFile?.size, url: state.currentFile?.url, originalUrl: state.currentFile?.originalUrl },
      viewerLength: document.getElementById('textViewer').textContent.length
    })`);
    assert.equal(textPreview.visible, true, JSON.stringify(textPreview));
    assert.equal(textPreview.controlsVisible, true, JSON.stringify(textPreview));
    assert.equal(textPreview.fileId, novelFile.id);
    assert.equal(textPreview.iframeHidden, true);
    assert.ok(textPreview.pageCount > 1, JSON.stringify(textPreview));
    assert.match(textPreview.content, /第一章 同步阅读开始/);
    const secondPageOffset = 1200;
    await evaluate(cdp, `goToTextReaderPage(2)`);
    try {
      await waitFor(() => evaluate(cdp, `state.room?.textReading?.fileId === ${JSON.stringify(novelFile.id)}
        && state.room?.textReading?.page === 2
        && state.room?.textReading?.characterOffset === ${secondPageOffset}`), '同步小说页码与精确字符锚点');
    } catch (error) {
      const readingDiagnostic = await evaluate(cdp, `({
        authenticated: state.authenticated, socketAuthenticated: state.socketAuthenticated, connected: state.socket?.connected,
        canControl: canControlPlayback(), roomReading: state.room?.textReading, localReading: state.textReading,
        pageValue: elements.textReaderPage?.value, pageCount: textReaderPageCount(), viewerLength: textViewerCharacterLength(),
        applying: state.applyingTextReading, blockedUntil: state.textReadingScrollBlockUntil, now: performance.now(),
        currentFile: { id: state.currentFile?.id, category: state.currentFile?.category, size: state.currentFile?.size },
        errors: window.__syncWatchSmokeErrors
      })`);
      throw new Error(`${error.message}: ${JSON.stringify(readingDiagnostic)}`);
    }
    const secondPageState = await evaluate(cdp, `({
      roomOffset: state.room?.textReading?.characterOffset,
      localOffset: state.textReading?.characterOffset,
      targetOffset: (2 - 1) * TEXT_READER_CHARACTERS_PER_PAGE,
      visualLineStart: textCharacterOffsetAtScroll()
    })`);
    assert.equal(secondPageState.roomOffset, secondPageOffset, JSON.stringify(secondPageState));
    assert.equal(secondPageState.localOffset, secondPageOffset, JSON.stringify(secondPageState));
    assert.equal(secondPageState.roomOffset, secondPageState.targetOffset, JSON.stringify(secondPageState));
    assert.notEqual(secondPageState.visualLineStart, secondPageOffset, 'fixture must prove page navigation does not echo the local wrapped-line start');
    const finalPage = await evaluate(cdp, `textReaderPageCount()`);
    await evaluate(cdp, `goToTextReaderPage(${finalPage})`);
    await waitFor(() => evaluate(cdp, `state.room?.textReading?.page === ${finalPage}`), '同步小说最后一页');
    const finalTextAnchor = await evaluate(cdp, `({
      page: Number(elements.textReaderPage.value),
      expectedPage: textReaderPageCount(),
      offset: state.room?.textReading?.characterOffset,
      charactersPerPage: TEXT_READER_CHARACTERS_PER_PAGE,
      targetOffset: Math.min(Math.max(0, textViewerCharacterLength() - 1), (${finalPage} - 1) * TEXT_READER_CHARACTERS_PER_PAGE)
    })`);
    assert.equal(finalTextAnchor.page, finalTextAnchor.expectedPage, JSON.stringify(finalTextAnchor));
    assert.equal(finalTextAnchor.page, finalPage, JSON.stringify(finalTextAnchor));
    assert.equal(Number.isSafeInteger(finalTextAnchor.offset), true, JSON.stringify(finalTextAnchor));
    assert.equal(finalTextAnchor.offset, finalTextAnchor.targetOffset, JSON.stringify(finalTextAnchor));
    const staleCrossFileState = await evaluate(cdp, `(() => {
      const before = { ...state.textReading };
      applyTextReadingState({ fileId: 'stale-other-file', position: 0.01, page: 1, characterOffset: 4, revision: Math.max(0, before.revision - 1) });
      return { before, after: { ...state.textReading } };
    })()`);
    assert.deepEqual(staleCrossFileState.after, staleCrossFileState.before, JSON.stringify(staleCrossFileState));

    const arbitraryAnchorOffset = 1234;
    const arbitraryUpdate = await evaluate(cdp, `(async () => {
      const characterOffset = ${arbitraryAnchorOffset};
      const result = await emitAck('text-reading-update', {
        fileId: ${JSON.stringify(novelFile.id)},
        position: textReadingPositionForCharacterOffset(characterOffset),
        page: 1 + Math.floor(characterOffset / TEXT_READER_CHARACTERS_PER_PAGE),
        characterOffset
      });
      return { success: result.success, offset: result.textReading?.characterOffset, revision: result.textReading?.revision };
    })()`);
    assert.equal(arbitraryUpdate.success, true, JSON.stringify(arbitraryUpdate));
    assert.equal(arbitraryUpdate.offset, arbitraryAnchorOffset, JSON.stringify(arbitraryUpdate));
    await waitFor(() => evaluate(cdp, `state.room?.textReading?.characterOffset === ${arbitraryAnchorOffset}
      && state.textReading?.characterOffset === ${arbitraryAnchorOffset}`), '桌面端应用任意精确字符锚点');
    await delay(650);
    const desktopTextAnchor = await evaluate(cdp, `(() => {
      const node = textViewerTextNode();
      const authoritativeOffset = state.room?.textReading?.characterOffset;
      const rect = textRangeRectAt(node, authoritativeOffset);
      const lineHeight = Number.parseFloat(getComputedStyle(elements.textViewer).lineHeight) || 0;
      return {
        authoritativeOffset,
        localStateOffset: state.textReading?.characterOffset,
        visualLineStart: textCharacterOffsetAtScroll(),
        anchorCharacter: node?.data.slice(authoritativeOffset, authoritativeOffset + 1),
        anchorText: node?.data.slice(authoritativeOffset, authoritativeOffset + 48),
        anchorTopDelta: rect ? rect.top - textViewerContentTop(elements.textViewer) : null,
        lineHeight,
        scrollTop: elements.textViewer.scrollTop
      };
    })()`);
    assert.equal(desktopTextAnchor.authoritativeOffset, arbitraryAnchorOffset, JSON.stringify(desktopTextAnchor));
    assert.equal(desktopTextAnchor.localStateOffset, arbitraryAnchorOffset, JSON.stringify(desktopTextAnchor));
    assert.equal(desktopTextAnchor.anchorCharacter, novelText.slice(arbitraryAnchorOffset, arbitraryAnchorOffset + 1), JSON.stringify(desktopTextAnchor));
    assert.equal(desktopTextAnchor.anchorText, novelText.slice(arbitraryAnchorOffset, arbitraryAnchorOffset + 48), JSON.stringify(desktopTextAnchor));
    assert.notEqual(desktopTextAnchor.visualLineStart, arbitraryAnchorOffset, 'desktop fixture must use a non-line-start anchor');
    assert.ok(desktopTextAnchor.anchorTopDelta >= -2 && desktopTextAnchor.anchorTopDelta <= desktopTextAnchor.lineHeight + 2, JSON.stringify(desktopTextAnchor));

    await evaluate(cdp, `document.body.classList.add('android-client'); true`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await delay(420);
    const mobileTextAnchor = await evaluate(cdp, `(() => {
      applyTextReadingState(state.room.textReading);
      const node = textViewerTextNode();
      const authoritativeOffset = state.room?.textReading?.characterOffset;
      const rect = textRangeRectAt(node, authoritativeOffset);
      const lineHeight = Number.parseFloat(getComputedStyle(elements.textViewer).lineHeight) || 0;
      return {
        authoritativeOffset,
        localStateOffset: state.textReading?.characterOffset,
        visualLineStart: textCharacterOffsetAtScroll(),
        anchorCharacter: node?.data.slice(authoritativeOffset, authoritativeOffset + 1),
        anchorText: node?.data.slice(authoritativeOffset, authoritativeOffset + 48),
        anchorTopDelta: rect ? rect.top - textViewerContentTop(elements.textViewer) : null,
        lineHeight,
        scrollTop: elements.textViewer.scrollTop
      };
    })()`);
    assert.equal(mobileTextAnchor.authoritativeOffset, arbitraryAnchorOffset, JSON.stringify({ desktopTextAnchor, mobileTextAnchor }));
    assert.equal(mobileTextAnchor.localStateOffset, arbitraryAnchorOffset, JSON.stringify({ desktopTextAnchor, mobileTextAnchor }));
    assert.equal(mobileTextAnchor.anchorCharacter, desktopTextAnchor.anchorCharacter, JSON.stringify({ desktopTextAnchor, mobileTextAnchor }));
    assert.equal(mobileTextAnchor.anchorText, desktopTextAnchor.anchorText, JSON.stringify({ desktopTextAnchor, mobileTextAnchor }));
    assert.notEqual(mobileTextAnchor.visualLineStart, arbitraryAnchorOffset, 'mobile fixture must use a non-line-start anchor');
    assert.ok(mobileTextAnchor.anchorTopDelta >= -2 && mobileTextAnchor.anchorTopDelta <= mobileTextAnchor.lineHeight + 2, JSON.stringify(mobileTextAnchor));

    await evaluate(cdp, `goToTextReaderPage(2)`);
    await waitFor(() => evaluate(cdp, `state.room?.textReading?.page === 2
      && state.room?.textReading?.characterOffset === ${secondPageOffset}`), '移动端页码跳转保持精确页边界');
    await delay(650);
    const mobilePageJump = await evaluate(cdp, `({
      roomOffset: state.room?.textReading?.characterOffset,
      localOffset: state.textReading?.characterOffset,
      targetOffset: (2 - 1) * TEXT_READER_CHARACTERS_PER_PAGE,
      visualLineStart: textCharacterOffsetAtScroll()
    })`);
    assert.equal(mobilePageJump.roomOffset, secondPageOffset, JSON.stringify(mobilePageJump));
    assert.equal(mobilePageJump.localOffset, secondPageOffset, JSON.stringify(mobilePageJump));
    assert.equal(mobilePageJump.roomOffset, mobilePageJump.targetOffset, JSON.stringify(mobilePageJump));
    assert.notEqual(mobilePageJump.visualLineStart, secondPageOffset, 'mobile page jump must not publish its wrapped-line start');
    await evaluate(cdp, `document.body.classList.remove('android-client'); true`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await evaluate(cdp, `(async () => { await clearPlayback(); return true; })()`);
    await waitFor(() => evaluate(cdp, `state.currentFile === null && document.getElementById('textViewer').classList.contains('is-hidden')`), '清空 TXT 预览');
    await evaluate(cdp, `openAccount('home')`);
    await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('[data-default-avatar-picker]')?.querySelector('[data-avatar-id="7"]'))`), '默认头像选择器');
    const defaultAvatarSurface = await evaluate(cdp, `(() => {
      const picker = document.querySelector('[data-default-avatar-picker]');
      const option = picker.querySelector('[data-avatar-id="7"]');
      option.click();
      const heroImage = document.querySelector('#accountContent .profile-avatar img');
      heroImage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      return {
        groups: picker.querySelectorAll('[data-avatar-group]').length,
        visibleOptions: picker.querySelectorAll('[data-avatar-id]').length,
        inputValue: document.getElementById('profileAvatarInput').value,
        selected: option.classList.contains('is-selected'),
        saveReady: document.querySelector('[data-profile-action="save-profile"]').classList.contains('avatar-save-ready'),
        previewVisible: !document.querySelector('.avatar-preview-overlay').classList.contains('is-hidden'),
        previewSource: document.querySelector('[data-avatar-preview-image]').getAttribute('src')
      };
    })()`);
    assert.equal(defaultAvatarSurface.groups, 5, JSON.stringify(defaultAvatarSurface));
    assert.equal(defaultAvatarSurface.visibleOptions, 20, JSON.stringify(defaultAvatarSurface));
    assert.equal(defaultAvatarSurface.inputValue, '/default-avatar/7.svg');
    assert.equal(defaultAvatarSurface.selected, true);
    assert.equal(defaultAvatarSurface.saveReady, true);
    assert.equal(defaultAvatarSurface.previewVisible, true);
    assert.match(defaultAvatarSurface.previewSource || '', /\/default-avatar\/7\.svg$/);
    await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await waitFor(() => evaluate(cdp, `document.querySelector('.avatar-preview-overlay')?.classList.contains('is-hidden')`), 'Esc 关闭头像预览');
    const mailCountBeforeBinding = sentMails.length;
    await evaluate(cdp, `(async () => {
      document.getElementById('profileEmail').value = 'browser-owner@example.com';
      document.getElementById('profileSignature').value = '邮箱验证交互已完成';
      elements.accountContent.querySelector('[data-profile-action="save-profile"]').click();
      return true;
    })()`);
    await waitFor(() => sentMails.length > mailCountBeforeBinding, '浏览器发送邮箱绑定验证码');
    await waitFor(() => evaluate(cdp, `Boolean(activeAppDialog && elements.appDialogTitle.textContent === '验证新邮箱' && elements.appDialogInput.autocomplete === 'one-time-code')`), '显示邮箱验证码对话框');
    const bindingCode = String(sentMails.at(-1)?.text || '').match(/验证码：(\d{6})/)?.[1];
    assert.match(bindingCode || '', /^\d{6}$/);
    await evaluate(cdp, `elements.appDialogInput.value = ${JSON.stringify(bindingCode)}; elements.appDialogForm.requestSubmit(); true`);
    await waitFor(() => evaluate(cdp, `state.profile?.email === 'browser-owner@example.com' && state.profile?.signature === '邮箱验证交互已完成'`), '邮箱验证后保存完整资料');
    const emailBindingSurface = await evaluate(cdp, `({
      email: state.profile.email,
      avatar: state.profile.avatar,
      signature: state.profile.signature,
      hint: elements.accountContent.querySelector('.form-hint')?.textContent || '',
      dialogHidden: elements.appDialog.classList.contains('is-hidden')
    })`);
    assert.equal(emailBindingSurface.email, 'browser-owner@example.com');
    assert.equal(emailBindingSurface.avatar, '/default-avatar/7.svg');
    assert.equal(emailBindingSurface.signature, '邮箱验证交互已完成');
    assert.match(emailBindingSurface.hint, /6 位验证码/);
    assert.equal(emailBindingSurface.dialogHidden, true);
    await evaluate(cdp, `elements.accountModal.classList.add('is-hidden'); true`);
    await waitFor(() => evaluate(cdp, `document.querySelector('.user-card[data-username="BrowserUiOwner"] .member-avatar img')?.getAttribute('src') === '/default-avatar/7.svg'`), '成员列表同步默认头像');
    const memberAvatarPreview = await evaluate(cdp, `(() => {
      const image = document.querySelector('.user-card[data-username="BrowserUiOwner"] .member-avatar img');
      image.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, view: window }));
      image.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2, view: window }));
      image.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2, view: window }));
      return {
        previewVisible: !document.querySelector('.avatar-preview-overlay').classList.contains('is-hidden'),
        profileHidden: elements.memberProfileModal.classList.contains('is-hidden')
      };
    })()`);
    assert.equal(memberAvatarPreview.previewVisible, true, JSON.stringify(memberAvatarPreview));
    assert.equal(memberAvatarPreview.profileHidden, true, JSON.stringify(memberAvatarPreview));
    await evaluate(cdp, `document.querySelector('[data-avatar-preview-close]').click(); true`);
    await delay(450);
    const memberAvatarSingleClick = await evaluate(cdp, `(async () => {
      const image = document.querySelector('.user-card[data-username="BrowserUiOwner"] .member-avatar img');
      const control = image.closest('.member-avatar');
      const delegatedClicks = [];
      const recordClick = (event) => delegatedClicks.push({ detail: event.detail, trusted: event.isTrusted });
      elements.userList.addEventListener('click', recordClick);
      image.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, view: window }));
      renderUsers();
      await new Promise((resolve) => setTimeout(resolve, 500));
      elements.userList.removeEventListener('click', recordClick);
      return {
        profileVisible: !elements.memberProfileModal.classList.contains('is-hidden'),
        originalControlConnected: control.isConnected,
        currentControlIsOriginal: document.querySelector('.user-card[data-username="BrowserUiOwner"] .member-avatar') === control,
        delegatedClicks
      };
    })()`);
    assert.equal(memberAvatarSingleClick.profileVisible, true, `成员头像单击仍应打开成员名片: ${JSON.stringify(memberAvatarSingleClick)}`);
    assert.equal(memberAvatarSingleClick.originalControlConnected, false, JSON.stringify(memberAvatarSingleClick));
    assert.equal(memberAvatarSingleClick.currentControlIsOriginal, false, JSON.stringify(memberAvatarSingleClick));
    assert.equal(memberAvatarSingleClick.delegatedClicks.length, 1, JSON.stringify(memberAvatarSingleClick));
    await evaluate(cdp, `elements.memberProfileModal.classList.add('is-hidden'); true`);
    const memberAvatarTouchDouble = await evaluate(cdp, `(async () => {
      const currentImage = () => document.querySelector('.user-card[data-username="BrowserUiOwner"] .member-avatar img');
      const dispatchTouch = (image) => {
        image.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch' }));
        image.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, view: window }));
      };
      dispatchTouch(currentImage());
      await new Promise((resolve) => setTimeout(resolve, 300));
      dispatchTouch(currentImage());
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        previewVisible: !document.querySelector('.avatar-preview-overlay').classList.contains('is-hidden'),
        profileHidden: elements.memberProfileModal.classList.contains('is-hidden')
      };
    })()`);
    assert.equal(memberAvatarTouchDouble.previewVisible, true, JSON.stringify(memberAvatarTouchDouble));
    assert.equal(memberAvatarTouchDouble.profileHidden, true, '300ms 触摸双击不能先打开成员名片');
    await evaluate(cdp, `document.querySelector('[data-avatar-preview-close]').click(); true`);
    if (avatarOnly) {
      console.log(JSON.stringify({ success: true, memberAvatarPreview, memberAvatarSingleClick, memberAvatarTouchDouble }));
      return;
    }
    const original = await evaluate(cdp, `({ theme: document.documentElement.dataset.uiTheme || '', count: UI_THEMES.length, bodyWidth: document.body.scrollWidth, viewport: innerWidth })`);
    assert.equal(original.theme, 'silver-screen'); assert.equal(original.count, 21); assert.ok(original.bodyWidth <= original.viewport + 2);
    const friendFloatingSurface = await evaluate(cdp, `(() => {
      const layer = elements.friendVideoNoticeLayer;
      layer.replaceChildren();
      const api = window.SyncWatchFriendAccountUi;
      api.showVideoNotice(layer, { from: 'FloatingFriendA', fromName: '好友甲', text: '甲的消息' });
      api.showVideoNotice(layer, { from: 'FloatingFriendB', fromName: '好友乙', text: '乙的消息' });
      const before = [...layer.querySelectorAll('[data-friend-video-notice]')].map((item) => item.dataset.friendVideoNotice).sort();
      api.dismissVideoNotice(layer, 'FloatingFriendA');
      const after = [...layer.querySelectorAll('[data-friend-video-notice]')].map((item) => item.dataset.friendVideoNotice);
      const layerVisibleAfterOneDismiss = !layer.classList.contains('is-hidden');
      const savedProfile = state.profile; const savedFriendChatUser = state.friendChatUser;
      state.profile = { ...state.profile, friends: [{ username: 'FloatingFriendB', displayName: '好友乙', floatingNotice: false }] };
      state.friendChatUser = 'FloatingFriendB'; renderFriendChatFloatingButton();
      const button = { text: elements.friendChatFloatingBtn.textContent, pressed: elements.friendChatFloatingBtn.getAttribute('aria-pressed') };
      state.profile = savedProfile; state.friendChatUser = savedFriendChatUser; layer.replaceChildren(); layer.classList.add('is-hidden');
      return { before, after, layerVisibleAfterOneDismiss, button };
    })()`);
    assert.deepEqual(friendFloatingSurface.before, ['FloatingFriendA', 'FloatingFriendB']);
    assert.deepEqual(friendFloatingSurface.after, ['FloatingFriendB']);
    assert.equal(friendFloatingSurface.layerVisibleAfterOneDismiss, true);
    assert.deepEqual(friendFloatingSurface.button, { text: '开启悬浮提示', pressed: 'false' });
    const selfHighlight = await evaluate(cdp, `(() => {
      const enabledCard = elements.userList.querySelector('.user-card.self');
      const enabled = {
        present: Boolean(enabledCard),
        highlighted: enabledCard?.classList.contains('self-highlight') || false,
        animation: enabledCard ? getComputedStyle(enabledCard).animationName : ''
      };
      state.selfMemberHighlight = false; renderUsers();
      const disabledCard = elements.userList.querySelector('.user-card.self');
      const disabled = {
        highlighted: disabledCard?.classList.contains('self-highlight') || false,
        animation: disabledCard ? getComputedStyle(disabledCard).animationName : ''
      };
      state.selfMemberHighlight = true; renderUsers();
      return { enabled, disabled };
    })()`);
    assert.equal(selfHighlight.enabled.present, true, JSON.stringify(selfHighlight));
    assert.equal(selfHighlight.enabled.highlighted, true, JSON.stringify(selfHighlight));
    const reducedMotion = await evaluate(cdp, `window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true`);
    if (reducedMotion) assert.equal(selfHighlight.enabled.animation, 'none', JSON.stringify(selfHighlight));
    else assert.match(selfHighlight.enabled.animation, /self-member-highlight/, JSON.stringify(selfHighlight));
    assert.equal(selfHighlight.disabled.highlighted, false, JSON.stringify(selfHighlight));
    assert.doesNotMatch(selfHighlight.disabled.animation, /self-member-highlight/, JSON.stringify(selfHighlight));
    const themeChoices = await evaluate(cdp, `Array.from(elements.themeGrid.querySelectorAll('.theme-choice')).map((choice) => ({ code: choice.querySelector('.theme-code')?.textContent.trim(), name: choice.querySelector('strong')?.textContent.trim() }))`);
    assert.equal(themeChoices.length, 21);
    assert.deepEqual(themeChoices.map((choice) => choice.code), Array.from({ length: 21 }, (_, index) => `编号 ${String(index).padStart(2, '0')}`));
    assert.equal(`${themeChoices[0].code} ${themeChoices[0].name}`, '编号 00 原版界面');
    assert.ok(themeChoices.slice(1).every((choice) => /^编号 (0[1-9]|1\d|20)$/.test(choice.code) && choice.name));
    const originalPath = path.join(outputDir, 'original-desktop.png'); await capture(cdp, originalPath); images.push(originalPath);
    const aiConfigLayout = await evaluate(cdp, `(() => {
      aiOpenWorkbench();
      if (elements.aiConfigPanel.classList.contains('is-hidden')) aiToggleConfig();
      const imported = aiImportConfigText('OPENAI_BASE_URL=https://relay.example/v1\\nOPENAI_API_KEY=sk-browser-smoke-123456\\nOPENAI_MODEL=gpt-browser-smoke', '烟雾测试配置');
      elements.aiConfigPanel.scrollTop = elements.aiConfigPanel.scrollHeight;
      const modal = elements.aiWorkbenchModal.getBoundingClientRect();
      const panel = elements.aiConfigPanel.getBoundingClientRect();
      const actions = elements.aiConfigPanel.querySelector('.ai-config-command-row').getBoundingClientRect();
      const buttons = [...elements.aiConfigPanel.querySelectorAll('.ai-config-command-row button')].map((button) => ({ id: button.id, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height }));
      return {
        imported, hidden: elements.aiWorkbenchModal.classList.contains('is-hidden'), baseUrl: elements.aiBaseUrl.value,
        apiKey: elements.aiApiKey.value, model: elements.aiChatModel.value, panelOverflow: elements.aiConfigPanel.scrollWidth - elements.aiConfigPanel.clientWidth,
        modal: [modal.left, modal.top, modal.right, modal.bottom], panel: [panel.left, panel.right], actions: [actions.left, actions.right], buttons
      };
    })()`);
    assert.equal(aiConfigLayout.imported, true, JSON.stringify(aiConfigLayout));
    assert.equal(aiConfigLayout.hidden, false, JSON.stringify(aiConfigLayout));
    assert.equal(aiConfigLayout.baseUrl, 'https://relay.example/v1');
    assert.equal(aiConfigLayout.apiKey, 'sk-browser-smoke-123456');
    assert.equal(aiConfigLayout.model, 'gpt-browser-smoke');
    assert.ok(aiConfigLayout.panelOverflow <= 2, JSON.stringify(aiConfigLayout));
    assert.ok(aiConfigLayout.modal[0] >= 0 && aiConfigLayout.modal[1] >= 0 && aiConfigLayout.modal[2] <= 1365 && aiConfigLayout.modal[3] <= 860, JSON.stringify(aiConfigLayout));
    assert.ok(aiConfigLayout.actions[0] >= aiConfigLayout.panel[0] - 1 && aiConfigLayout.actions[1] <= aiConfigLayout.panel[1] + 1, JSON.stringify(aiConfigLayout));
    assert.deepEqual(aiConfigLayout.buttons.map((button) => button.id), ['saveAiConfigBtn', 'testAiConnectionBtn', 'syncAiConfigBtn', 'exportAiConfigBtn', 'importAiConfigBtn', 'pasteAiConfigBtn']);
    assert.ok(aiConfigLayout.buttons.every((button) => button.width >= 76 && button.height >= 32), JSON.stringify(aiConfigLayout));
    await evaluate(cdp, `(() => {
      const originalFetch = window.fetch;
      window.__syncWatchAiModelFlow = { status: 'pending' };
      window.fetch = async (url, options) => String(url) === '/api/ai/models'
        ? new Response(JSON.stringify({ success: true, endpoint: '/v1/models', models: ['gpt-compat-a', 'gpt-compat-b', 'gpt-compat-a'] }), { status: 200, headers: { 'content-type': 'application/json' } })
        : originalFetch(url, options);
      window.__syncWatchAiModelFlowPromise = Promise.resolve()
        .then(() => aiRefreshModels(false))
        .then(() => {
        elements.aiModelPicker.value = 'gpt-compat-b';
        elements.aiModelPicker.dispatchEvent(new Event('change', { bubbles: true }));
        const saved = JSON.parse(localStorage.getItem('syncwatchAiWorkbenchConfigV2') || '{}');
          window.__syncWatchAiModelFlow = { status: 'done', value: {
          models: [...state.aiWorkbench.models], options: [...elements.aiModelPicker.options].map((option) => option.value),
          selected: elements.aiModelPicker.value, active: elements.aiActiveModel.value, chatModel: state.aiWorkbench.config.chatModel,
          savedCatalog: saved.modelCatalog, summary: elements.aiModelSummary.textContent
          } };
        })
        .catch((error) => { window.__syncWatchAiModelFlow = { status: 'error', error: String(error?.stack || error) }; })
        .finally(() => { window.fetch = originalFetch; });
      return true;
    })()`);
    await waitFor(() => evaluate(cdp, `window.__syncWatchAiModelFlow?.status !== 'pending'`), '刷新 AI 模型目录');
    const aiModelFlowResult = await evaluate(cdp, `window.__syncWatchAiModelFlow`);
    if (aiModelFlowResult.status !== 'done') throw new Error(`AI 模型刷新失败: ${aiModelFlowResult.error || JSON.stringify(aiModelFlowResult)}`);
    const aiModelFlow = aiModelFlowResult.value;
    assert.deepEqual(aiModelFlow.models, ['gpt-compat-a', 'gpt-compat-b'], JSON.stringify(aiModelFlow));
    assert.ok(aiModelFlow.options.includes('gpt-compat-a') && aiModelFlow.options.includes('gpt-compat-b'), JSON.stringify(aiModelFlow));
    assert.equal(aiModelFlow.selected, 'gpt-compat-b', JSON.stringify(aiModelFlow));
    assert.equal(aiModelFlow.active, 'gpt-compat-b', JSON.stringify(aiModelFlow));
    assert.equal(aiModelFlow.chatModel, 'gpt-compat-b', JSON.stringify(aiModelFlow));
    assert.deepEqual(aiModelFlow.savedCatalog, ['gpt-compat-a', 'gpt-compat-b'], JSON.stringify(aiModelFlow));
    assert.match(aiModelFlow.summary, /2 个模型/);
    await delay(120);
    const aiConfigPath = path.join(outputDir, 'ai-config-desktop.png'); await capture(cdp, aiConfigPath); images.push(aiConfigPath);
    await evaluate(cdp, `state.aiWorkbench.config.apiKey = ''; aiPersist(); aiCloseWorkbench(); elements.toastRegion.innerHTML = ''; true`);
    const f11CountdownStart = await evaluate(cdp, `(() => {
      localStorage.removeItem('syncwatchF11Prompt');
      showF11PromptIfNeeded();
      return { connected: elements.f11PromptCountdown.isConnected, text: elements.f11PromptCountdown.textContent };
    })()`);
    assert.equal(f11CountdownStart.connected, true, JSON.stringify(f11CountdownStart));
    assert.match(f11CountdownStart.text, /10 秒/);
    await delay(1150);
    const f11CountdownNext = await evaluate(cdp, `elements.f11PromptCountdown.textContent`);
    assert.match(f11CountdownNext, /[89] 秒/);
    await evaluate(cdp, `elements.f11PromptModal.classList.add('is-hidden'); elements.adminPassword.value = 'admin888'; true`);
    const managementLoaded = await evaluate(cdp, `(async () => { await loadAdminSettings({ silent: true }); openManagementHub('permissions'); return Boolean(state.adminSettings?.serverAdmin); })()`);
    assert.equal(managementLoaded, true);
    await delay(180);
    const managementLayout = await evaluate(cdp, `(() => {
      const navigation = [...document.querySelectorAll('[data-management-section]')].map((button) => button.dataset.managementSection);
      const visiblePanels = [...elements.adminTab.querySelectorAll('[data-management-panel]')].filter((panel) => !panel.classList.contains('management-filtered') && !panel.classList.contains('is-hidden'));
      const checkbox = elements.permissionGroupList.closest('[data-management-panel]').querySelector('input[type="checkbox"]') || elements.permControl;
      return { navigation, visiblePanels: visiblePanels.length, room: elements.permissionContextRoom.textContent, owner: elements.permissionContextOwner.textContent, checkboxWidth: checkbox.getBoundingClientRect().width, bodyWidth: document.body.scrollWidth, viewport: innerWidth };
    })()`);
    for (const section of ['applications', 'tiers', 'notices', 'mail', 'logs']) assert.ok(managementLayout.navigation.includes(section), JSON.stringify(managementLayout));
    assert.ok(managementLayout.visiblePanels >= 2, JSON.stringify(managementLayout));
    assert.equal(managementLayout.room, 'BROWSER1'); assert.match(managementLayout.owner, /BrowserUiOwner/i);
    assert.ok(managementLayout.checkboxWidth >= 17, JSON.stringify(managementLayout));
    assert.ok(managementLayout.bodyWidth <= managementLayout.viewport + 2, JSON.stringify(managementLayout));
    const managementPath = path.join(outputDir, 'management-permissions-desktop.png'); await capture(cdp, managementPath); images.push(managementPath);
    await evaluate(cdp, `showManagementSection('mail'); true`); await delay(160);
    const mailLayout = await evaluate(cdp, `(() => {
      const card = elements.mailSettingsCard.getBoundingClientRect();
      const editor = elements.mailTemplateHtml.getBoundingClientRect();
      const preview = elements.mailTemplatePreview.getBoundingClientRect();
      return {
        visible: !elements.mailSettingsCard.classList.contains('management-filtered') && !elements.mailSettingsCard.classList.contains('is-hidden'),
        cardWidth: card.width, editorWidth: editor.width, previewWidth: preview.width,
        overflow: elements.managementContentHost.scrollWidth - elements.managementContentHost.clientWidth,
        previewSandbox: elements.mailTemplatePreview.getAttribute('sandbox')
      };
    })()`);
    assert.equal(mailLayout.visible, true, JSON.stringify(mailLayout));
    assert.ok(mailLayout.cardWidth > 500 && mailLayout.editorWidth > 200 && mailLayout.previewWidth > 200, JSON.stringify(mailLayout));
    assert.ok(mailLayout.overflow <= 2, JSON.stringify(mailLayout));
    assert.equal(mailLayout.previewSandbox, '', JSON.stringify(mailLayout));
    const mailPresetInteraction = await evaluate(cdp, `(() => {
      const select = elements.mailTemplatePreset;
      const target = [...select.options].find((option) => option.value === 'preset-02') || select.options[1];
      if (!target) return { selected: '', subject: '', preview: '' };
      select.value = target.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        selected: select.value,
        subject: elements.mailTemplatePreviewSubject.textContent,
        preview: elements.mailTemplatePreview.srcdoc
      };
    })()`);
    assert.equal(mailPresetInteraction.selected, 'preset-02', JSON.stringify(mailPresetInteraction));
    assert.match(mailPresetInteraction.subject, /验证|Verify/, JSON.stringify(mailPresetInteraction));
    assert.match(mailPresetInteraction.preview, /银幕黑金|SyncWatch同步观影/, JSON.stringify(mailPresetInteraction));
    const mailSettingsPath = path.join(outputDir, 'mail-settings-desktop.png'); await capture(cdp, mailSettingsPath); images.push(mailSettingsPath);
    await evaluate(cdp, `closeManagementHub(); true`);
    await evaluate(cdp, `elements.toastRegion.innerHTML = ''; elements.themeModal.classList.remove('is-hidden'); true`); await delay(120);
    const themeModalLayout = await evaluate(cdp, `(() => {
      const names = [...elements.themeGrid.querySelectorAll('.theme-name')];
      const close = elements.themeModal.querySelector('.modal-close').getBoundingClientRect();
      const actions = elements.themeModal.querySelector('.theme-modal-actions').getBoundingClientRect();
      return {
        namesVisible: names.every((name) => {
          const nameRect = name.getBoundingClientRect();
          const cardRect = name.closest('.theme-choice').getBoundingClientRect();
          return name.textContent.trim() && nameRect.height > 0 && nameRect.top >= cardRect.top && nameRect.bottom <= cardRect.bottom;
        }),
        closeOverlapsActions: !(close.right <= actions.left || close.left >= actions.right || close.bottom <= actions.top || close.top >= actions.bottom),
        bodyWidth: document.body.scrollWidth, viewport: innerWidth
      };
    })()`);
    assert.equal(themeModalLayout.namesVisible, true, JSON.stringify(themeModalLayout));
    assert.equal(themeModalLayout.closeOverlapsActions, false, JSON.stringify(themeModalLayout));
    assert.ok(themeModalLayout.bodyWidth <= themeModalLayout.viewport + 2, JSON.stringify(themeModalLayout));
    const themeModalPath = path.join(outputDir, 'theme-modal-desktop.png'); await capture(cdp, themeModalPath); images.push(themeModalPath);
    await evaluate(cdp, `elements.themeModal.classList.add('is-hidden'); clearLocalWebViews(); openWebShare(); true`); await delay(120);
    const webShareLayout = await evaluate(cdp, `(() => {
      const card = elements.webShareModal.querySelector('.web-share-card');
      const close = elements.webShareModal.querySelector('.modal-close').getBoundingClientRect();
      const actions = elements.webShareModal.querySelector('.web-share-actions').getBoundingClientRect();
      const buttons = [...elements.webShareModal.querySelectorAll('.web-share-actions button, .web-address-actions button')];
      return {
        cardWidth: card.clientWidth, cardScrollWidth: card.scrollWidth,
        closeOverlapsActions: !(close.right <= actions.left || close.left >= actions.right || close.bottom <= actions.top || close.top >= actions.bottom),
        minButtonHeight: Math.min(...buttons.map((button) => button.getBoundingClientRect().height)),
        inputValue: elements.webUrlInput.value,
        emptyVisible: !elements.webShareEmpty.classList.contains('is-hidden'),
        frameHidden: elements.webFrame.classList.contains('is-hidden')
      };
    })()`);
    assert.ok(webShareLayout.cardScrollWidth <= webShareLayout.cardWidth + 2, JSON.stringify(webShareLayout));
    assert.equal(webShareLayout.closeOverlapsActions, false, JSON.stringify(webShareLayout));
    assert.ok(webShareLayout.minButtonHeight >= 35.5, JSON.stringify(webShareLayout));
    assert.equal(webShareLayout.inputValue, '', JSON.stringify(webShareLayout));
    assert.equal(webShareLayout.emptyVisible, true, JSON.stringify(webShareLayout));
    assert.equal(webShareLayout.frameHidden, true, JSON.stringify(webShareLayout));
    const clipboardFallback = await evaluate(cdp, `(async () => {
      const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      const desktopDescriptor = Object.getOwnPropertyDescriptor(window, 'SyncWatchDesktop');
      elements.toastRegion.innerHTML = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
      await pasteWebUrl();
      const focused = document.activeElement === elements.webUrlInput;
      const fallbackPrompt = elements.toastRegion.textContent;
      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', { value: { getData: (type) => type === 'text/plain' ? 'https://example.com/watch?episode=20#player' : '' } });
      elements.webUrlInput.dispatchEvent(pasteEvent);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const manualValue = elements.webUrlInput.value;
      const manualFrame = elements.webFrame.src;
      Object.defineProperty(window, 'SyncWatchDesktop', { configurable: true, value: { readClipboardText: async () => ({ success: true, text: 'owned99' }) } });
      elements.switchRoomId.value = '';
      await pasteIntoInput(elements.switchRoomId, true);
      const bridgeValue = elements.switchRoomId.value;
      if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor); else delete navigator.clipboard;
      if (desktopDescriptor) Object.defineProperty(window, 'SyncWatchDesktop', desktopDescriptor); else delete window.SyncWatchDesktop;
      clearLocalWebViews();
      return { focused, fallbackPrompt, manualValue, manualFrame, bridgeValue, oldFailureShown: fallbackPrompt.includes('无法读取剪贴板') };
    })()`);
    assert.equal(clipboardFallback.focused, true, JSON.stringify(clipboardFallback));
    assert.match(clipboardFallback.fallbackPrompt, /Ctrl\+V|Command\+V|长按/);
    assert.equal(clipboardFallback.oldFailureShown, false, JSON.stringify(clipboardFallback));
    assert.equal(clipboardFallback.manualValue, 'https://example.com/watch?episode=20#player');
    assert.match(clipboardFallback.manualFrame, /^https:\/\/example\.com\/watch\?episode=20#player$/);
    assert.equal(clipboardFallback.bridgeValue, 'OWNED99');
    const firstVideoAttention = await evaluate(cdp, `(() => {
      const originalFiles = state.files;
      state.files = new Map(); renderFiles();
      const empty = { highlighted: elements.chooseFileBtn.classList.contains('needs-first-video'), animation: getComputedStyle(elements.chooseFileBtn).animationName };
      state.files.set('__first_video__', { id: '__first_video__', roomId: state.room.id, category: 'video', status: 'approved', originalName: '第一部影片.mp4', size: 1024, uploadedBy: state.user.username, uploadedByName: state.user.displayName, collection: '未分类', relativePath: '第一部影片.mp4', metadata: {}, compatibility: {} });
      renderFiles();
      const withVideo = { highlighted: elements.chooseFileBtn.classList.contains('needs-first-video'), animation: getComputedStyle(elements.chooseFileBtn).animationName };
      state.files = originalFiles; renderFiles();
      return { empty, withVideo };
    })()`);
    assert.equal(firstVideoAttention.empty.highlighted, true, JSON.stringify(firstVideoAttention));
    if (reducedMotion) assert.equal(firstVideoAttention.empty.animation, 'none', JSON.stringify(firstVideoAttention));
    else assert.match(firstVideoAttention.empty.animation, /first-video-upload-attention/);
    assert.equal(firstVideoAttention.withVideo.highlighted, false, JSON.stringify(firstVideoAttention));
    assert.doesNotMatch(firstVideoAttention.withVideo.animation, /first-video-upload-attention/);
    await evaluate(cdp, `openSwitchRoom(); true`);
    await waitFor(() => evaluate(cdp, `!state.switchOwnedRoomsLoading`), '刷新我的房间列表');
    await evaluate(cdp, `(() => {
      const originalProfile = state.profile;
      const originalSwitch = switchToRoomDirect;
      const currentRooms = Array.isArray(state.profile?.recentRooms) ? state.profile.recentRooms : [];
      state.profile = { ...(state.profile || {}), recentRooms: [...currentRooms.filter((room) => room.id !== 'OWNED99'), { id: 'OWNED99', name: '备用放映厅', owned: true, online: 0, maxUsers: 8 }] };
      renderSwitchOwnedRooms(state.profile.recentRooms);
      window.__syncWatchOwnedRoomSwitcher = { called: null, originalProfile, originalSwitch };
      switchToRoomDirect = async (roomId, options) => {
        window.__syncWatchOwnedRoomSwitcher.called = { roomId, source: options?.source };
        return false;
      };
      elements.switchOwnedRoomList.querySelector('[data-switch-owned-room="OWNED99"]')?.click();
      return true;
    })()`);
    await waitFor(() => evaluate(cdp, `Boolean(window.__syncWatchOwnedRoomSwitcher?.called)`), '切换我的房间');
    await delay(40);
    const ownedRoomSwitcher = await evaluate(cdp, `(() => {
      const record = window.__syncWatchOwnedRoomSwitcher;
      const currentButton = elements.switchOwnedRoomList.querySelector('[data-switch-owned-room="' + state.room.id + '"]');
      const result = { called: record.called, currentDisabled: Boolean(currentButton?.disabled), visibleRows: elements.switchOwnedRoomList.querySelectorAll('.switch-owned-room').length, modalVisible: !elements.switchRoomModal.classList.contains('is-hidden') };
      switchToRoomDirect = record.originalSwitch; state.profile = record.originalProfile; delete window.__syncWatchOwnedRoomSwitcher; elements.switchRoomModal.classList.add('is-hidden');
      return result;
    })()`);
    assert.deepEqual(ownedRoomSwitcher.called, { roomId: 'OWNED99', source: '我的房间' }, JSON.stringify(ownedRoomSwitcher));
    assert.equal(ownedRoomSwitcher.currentDisabled, true, JSON.stringify(ownedRoomSwitcher));
    assert.ok(ownedRoomSwitcher.visibleRows >= 2, JSON.stringify(ownedRoomSwitcher));
    assert.equal(ownedRoomSwitcher.modalVisible, true, JSON.stringify(ownedRoomSwitcher));
    const webSharePath = path.join(outputDir, 'web-share-desktop.png'); await capture(cdp, webSharePath); images.push(webSharePath);
    await evaluate(cdp, `elements.webShareModal.classList.add('is-hidden'); true`);
    for (const theme of ['cinema-deck', 'living-room', 'conversation-first', 'arcade-room']) {
      await evaluate(cdp, `selectUiTheme(${JSON.stringify(theme)}); elements.themeModal.classList.add('is-hidden'); true`);
      await delay(160);
      await evaluate(cdp, `if (typeof activeAppDialog !== 'undefined' && activeAppDialog) settleAppDialog(false); elements.toastRegion.innerHTML = ''; true`);
      await delay(80);
      const targetPath = path.join(outputDir, `${theme}-desktop.png`); await capture(cdp, targetPath); images.push(targetPath);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(cdp, `selectUiTheme('modular-windows'); elements.themeModal.classList.add('is-hidden'); if (typeof activeAppDialog !== 'undefined' && activeAppDialog) settleAppDialog(false); elements.toastRegion.innerHTML = ''; true`); await delay(200);
    const mobile = await evaluate(cdp, `({ bodyWidth: document.body.scrollWidth, viewport: innerWidth, quality: elements.playbackQualitySelect.value, syncNotice: elements.syncNoticeToggle.checked, theme: document.documentElement.dataset.uiTheme })`);
    assert.ok(mobile.bodyWidth <= mobile.viewport + 2, JSON.stringify(mobile)); assert.equal(mobile.theme, 'modular-windows');
    assert.equal(mobile.quality, 'original', JSON.stringify(mobile));
    const mobilePath = path.join(outputDir, 'modular-windows-mobile.png'); await capture(cdp, mobilePath); images.push(mobilePath);
    await evaluate(cdp, `openAccount('home')`);
    await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('[data-default-avatar-picker]')?.querySelector('[data-avatar-id]'))`), '手机默认头像选择器');
    await evaluate(cdp, `document.querySelector('[data-default-avatar-picker]').scrollIntoView({ block: 'center' }); true`);
    await delay(100);
    const mobileAvatarPickerPath = path.join(outputDir, 'default-avatar-picker-mobile.png'); await capture(cdp, mobileAvatarPickerPath); images.push(mobileAvatarPickerPath);
    const mobileAvatar = await evaluate(cdp, `(() => {
      const picker = document.querySelector('[data-default-avatar-picker]');
      const option = picker.querySelector('[data-avatar-id]');
      const optionRect = option.getBoundingClientRect();
      document.querySelector('#accountContent .profile-avatar img').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      const overlay = document.querySelector('.avatar-preview-overlay');
      const shellRect = overlay.querySelector('.avatar-preview-shell').getBoundingClientRect();
      const closeRect = overlay.querySelector('[data-avatar-preview-close]').getBoundingClientRect();
      return {
        bodyOverflow: document.body.scrollWidth - innerWidth,
        optionSize: [optionRect.width, optionRect.height],
        shell: [shellRect.left, shellRect.top, shellRect.right, shellRect.bottom],
        closeSize: [closeRect.width, closeRect.height]
      };
    })()`);
    assert.ok(mobileAvatar.bodyOverflow <= 2, JSON.stringify(mobileAvatar));
    assert.ok(mobileAvatar.optionSize[0] >= 48 && mobileAvatar.optionSize[1] >= 48, JSON.stringify(mobileAvatar));
    assert.ok(mobileAvatar.shell[0] >= 0 && mobileAvatar.shell[1] >= 0 && mobileAvatar.shell[2] <= 390 && mobileAvatar.shell[3] <= 844, JSON.stringify(mobileAvatar));
    assert.ok(mobileAvatar.closeSize[0] >= 44 && mobileAvatar.closeSize[1] >= 44, JSON.stringify(mobileAvatar));
    const mobileAvatarPath = path.join(outputDir, 'default-avatar-mobile.png'); await capture(cdp, mobileAvatarPath); images.push(mobileAvatarPath);
    await evaluate(cdp, `document.querySelector('[data-avatar-preview-close]').click(); elements.accountModal.classList.add('is-hidden'); true`);
    await evaluate(cdp, `elements.chatToggleBtn.scrollIntoView({ block: 'center' }); true`); await delay(120);
    const mobileLocationToast = await evaluate(cdp, `(() => {
      elements.toastRegion.innerHTML = '';
      const item = toastWithActions('Location permission denied', [
        { label: '\u91cd\u65b0\u6388\u6743', callback: () => {} },
        { label: '\u6c38\u4e45\u4e0d\u518d\u63d0\u793a', callback: () => {} }
      ], 0, 'error');
      const toastRect = item.getBoundingClientRect();
      const toggleRect = elements.chatToggleBtn.getBoundingClientRect();
      const controls = [...item.querySelectorAll('button')];
      const overlaps = !(
        toastRect.right <= toggleRect.left || toastRect.left >= toggleRect.right ||
        toastRect.bottom <= toggleRect.top || toastRect.top >= toggleRect.bottom
      );
      return {
        collapsed: elements.chatPanel.classList.contains('mobile-chat-collapsed'), overlaps,
        toast: [toastRect.left, toastRect.top, toastRect.right, toastRect.bottom],
        toggle: [toggleRect.left, toggleRect.top, toggleRect.right, toggleRect.bottom],
        labels: controls.map((button) => button.getAttribute('aria-label') || button.textContent.trim()),
        minControlHeight: Math.min(...controls.map((button) => button.getBoundingClientRect().height)),
        role: item.getAttribute('role')
      };
    })()`);
    assert.equal(mobileLocationToast.collapsed, true, JSON.stringify(mobileLocationToast));
    assert.equal(mobileLocationToast.overlaps, false, JSON.stringify(mobileLocationToast));
    assert.deepEqual(mobileLocationToast.labels, ['\u91cd\u65b0\u6388\u6743', '\u6c38\u4e45\u4e0d\u518d\u63d0\u793a', '\u5173\u95ed\u63d0\u793a']);
    assert.ok(mobileLocationToast.minControlHeight >= 43.5, JSON.stringify(mobileLocationToast));
    assert.equal(mobileLocationToast.role, 'alert', JSON.stringify(mobileLocationToast));
    assert.ok(mobileLocationToast.toast[0] >= 7.5 && mobileLocationToast.toast[2] <= 382.5, JSON.stringify(mobileLocationToast));
    await delay(240);
    const mobileLocationToastPath = path.join(outputDir, 'location-toast-mobile.png'); await capture(cdp, mobileLocationToastPath); images.push(mobileLocationToastPath);
    await evaluate(cdp, `elements.chatToggleBtn.click(); true`);
    await delay(80);
    const chatExpandedWithToast = await evaluate(cdp, `elements.chatToggleBtn.getAttribute('aria-expanded') === 'true'`);
    assert.equal(chatExpandedWithToast, true, JSON.stringify(mobileLocationToast));
    const locationToastClosed = await evaluate(cdp, `(() => {
      elements.chatToggleBtn.click();
      elements.toastRegion.querySelector('.toast-close')?.click();
      return !elements.toastRegion.querySelector('.toast') && elements.chatToggleBtn.getAttribute('aria-expanded') === 'false';
    })()`);
    assert.equal(locationToastClosed, true);
    const mobileWebActions = await evaluate(cdp, `(() => {
      toggleMobileActionMenu(true);
      const menu = elements.mobileMenuBtn.getBoundingClientRect();
      const actions = document.querySelector('.topbar-actions');
      const targets = [...actions.querySelectorAll('button:not(.is-hidden)')]
        .filter((target) => target.getBoundingClientRect().width > 0 && target.getBoundingClientRect().height > 0);
      const accountLabels = [...elements.accountDropdown.querySelectorAll('button')].map((button) => button.textContent.trim());
      const clientDownloadIndex = accountLabels.indexOf('下载 Windows 客户端');
      const androidDownloadIndex = accountLabels.indexOf('下载安卓客户端');
      return {
        android: document.body.classList.contains('android-client'), open: document.body.classList.contains('mobile-actions-open'),
        menuDisplay: getComputedStyle(elements.mobileMenuBtn).display, menuWidth: menu.width, menuHeight: menu.height,
        actionWidth: actions.clientWidth, actionScrollWidth: actions.scrollWidth,
        minTargetHeight: Math.min(...targets.map((target) => target.getBoundingClientRect().height)),
        outside: targets.filter((target) => { const rect = target.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1; }).length,
        bodyWidth: document.body.scrollWidth, viewport: innerWidth,
        clientDownloadIndex, androidDownloadIndex, androidDownloadAvailable: !elements.androidApkBtn.classList.contains('is-hidden')
      };
    })()`);
    assert.equal(mobileWebActions.android, false, JSON.stringify(mobileWebActions));
    assert.equal(mobileWebActions.open, true, JSON.stringify(mobileWebActions));
    assert.equal(mobileWebActions.menuDisplay, 'grid', JSON.stringify(mobileWebActions));
    assert.ok(mobileWebActions.menuWidth >= 43.5 && mobileWebActions.menuHeight >= 43.5, JSON.stringify(mobileWebActions));
    assert.ok(mobileWebActions.actionScrollWidth <= mobileWebActions.actionWidth + 2, JSON.stringify(mobileWebActions));
    assert.ok(mobileWebActions.minTargetHeight >= 43.5, JSON.stringify(mobileWebActions));
    assert.equal(mobileWebActions.outside, 0, JSON.stringify(mobileWebActions));
    assert.ok(mobileWebActions.bodyWidth <= mobileWebActions.viewport + 2, JSON.stringify(mobileWebActions));
    assert.equal(mobileWebActions.androidDownloadAvailable, expectedAndroidDownloadAvailable, JSON.stringify(mobileWebActions));
    assert.equal(mobileWebActions.androidDownloadIndex, mobileWebActions.clientDownloadIndex + 1, JSON.stringify(mobileWebActions));
    const mobileWebActionsPath = path.join(outputDir, 'mobile-web-actions.png'); await capture(cdp, mobileWebActionsPath); images.push(mobileWebActionsPath);
    await evaluate(cdp, `toggleMobileActionMenu(false); true`);
    await evaluate(cdp, `elements.webShareModal.classList.remove('is-hidden'); true`); await delay(120);
    const mobileWebShare = await evaluate(cdp, `(() => {
      const card = elements.webShareModal.querySelector('.web-share-card');
      const buttons = [...elements.webShareModal.querySelectorAll('.web-share-actions button, .web-address-actions button')];
      return { width: card.clientWidth, scrollWidth: card.scrollWidth, minButtonHeight: Math.min(...buttons.map((button) => button.getBoundingClientRect().height)) };
    })()`);
    assert.ok(mobileWebShare.scrollWidth <= mobileWebShare.width + 2, JSON.stringify(mobileWebShare));
    assert.ok(mobileWebShare.minButtonHeight >= 43.5, JSON.stringify(mobileWebShare));
    const mobileWebSharePath = path.join(outputDir, 'web-share-mobile.png'); await capture(cdp, mobileWebSharePath); images.push(mobileWebSharePath);
    await evaluate(cdp, `elements.webShareModal.classList.add('is-hidden'); true`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const conciseDesktop = await evaluate(cdp, `(() => {
      document.body.classList.add('concise-mode');
      const workspace = elements.mainPage.querySelector('.workspace');
      const theater = elements.theater.getBoundingClientRect();
      const result = {
        columns: getComputedStyle(workspace).gridTemplateColumns.trim().split(/\\s+/).length,
        fileDisplay: getComputedStyle(elements.filePanel).display,
        userDisplay: getComputedStyle(elements.userPanel).display,
        theaterWidth: theater.width,
        viewport: innerWidth
      };
      document.body.classList.remove('concise-mode');
      elements.chatPanel.classList.remove('mobile-chat-collapsed');
      result.chatRows = getComputedStyle(elements.chatPanel).gridTemplateRows;
      result.voiceRow = getComputedStyle(elements.liveVoiceBar).gridRow;
      result.historyRow = getComputedStyle(elements.chatHistory).gridRow;
      result.chatDisplay = getComputedStyle(elements.chatPanel).display;
      return result;
    })()`);
    assert.equal(conciseDesktop.columns, 1, JSON.stringify(conciseDesktop));
    assert.equal(conciseDesktop.fileDisplay, 'none', JSON.stringify(conciseDesktop));
    assert.equal(conciseDesktop.userDisplay, 'none', JSON.stringify(conciseDesktop));
    assert.ok(conciseDesktop.theaterWidth >= conciseDesktop.viewport - 24, JSON.stringify(conciseDesktop));
    assert.equal(conciseDesktop.chatRows.trim().split(/\s+/).length, 8, JSON.stringify(conciseDesktop));
    assert.equal(conciseDesktop.voiceRow, '4', JSON.stringify(conciseDesktop));
    assert.equal(conciseDesktop.historyRow, '5', JSON.stringify(conciseDesktop));
    assert.equal(conciseDesktop.chatDisplay, 'grid', JSON.stringify(conciseDesktop));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 812, height: 375, deviceScaleFactor: 1, mobile: true });
    await evaluate(cdp, `localStorage.removeItem(fullscreenChatHintStorageKey()); state.pseudoFullscreen = true; handleFullscreenChange(); true`); await delay(140);
    const fullscreenInitial = await evaluate(cdp, `(() => {
      const player = elements.playerContainer.getBoundingClientRect();
      const actions = elements.fullscreenOverlay.querySelector('.fullscreen-actions');
      const actionsRect = actions.getBoundingClientRect();
      const videoWasHidden = elements.videoPlayer.classList.contains('is-hidden');
      const emptyWasHidden = elements.emptyStage.classList.contains('is-hidden');
      elements.emptyStage.classList.add('is-hidden'); elements.videoPlayer.classList.remove('is-hidden');
      const video = elements.videoPlayer.getBoundingClientRect();
      if (videoWasHidden) elements.videoPlayer.classList.add('is-hidden');
      if (!emptyWasHidden) elements.emptyStage.classList.remove('is-hidden');
      return {
        controls: elements.playerContainer.classList.contains('controls-visible'), showHidden: elements.fullscreenShowBtn.classList.contains('is-hidden'), hintVisible: !elements.fullscreenShortcutHint.classList.contains('is-hidden'), lockSize: [elements.fullscreenLockBtn.getBoundingClientRect().width, elements.fullscreenLockBtn.getBoundingClientRect().height],
        player: [player.left, player.top, player.width, player.height], video: [video.left, video.top, video.width, video.height],
        actionsPosition: getComputedStyle(actions).position, actions: [actionsRect.left, actionsRect.top, actionsRect.right, actionsRect.bottom],
        viewport: [innerWidth, innerHeight], bodyWidth: document.body.scrollWidth
      };
    })()`);
    assert.equal(fullscreenInitial.controls, true, JSON.stringify(fullscreenInitial));
    assert.equal(fullscreenInitial.showHidden, true, JSON.stringify(fullscreenInitial));
    assert.equal(fullscreenInitial.hintVisible, true, JSON.stringify(fullscreenInitial));
    assert.ok(fullscreenInitial.lockSize[0] >= 44 && fullscreenInitial.lockSize[1] >= 44, JSON.stringify(fullscreenInitial));
    assert.deepEqual(fullscreenInitial.player.map(Math.round), [0, 0, 812, 375], JSON.stringify(fullscreenInitial));
    assert.deepEqual(fullscreenInitial.video.map(Math.round), [0, 0, 812, 375], JSON.stringify(fullscreenInitial));
    assert.equal(fullscreenInitial.actionsPosition, 'absolute', JSON.stringify(fullscreenInitial));
    assert.ok(fullscreenInitial.actions[0] >= 0 && fullscreenInitial.actions[1] >= 0 && fullscreenInitial.actions[2] <= 813 && fullscreenInitial.actions[3] <= 376, JSON.stringify(fullscreenInitial));
    assert.ok(fullscreenInitial.bodyWidth <= 813, JSON.stringify(fullscreenInitial));
    await delay(3150);
    const fullscreenControlsHidden = await evaluate(cdp, `(() => {
      const style = getComputedStyle(elements.fullscreenShowBtn);
      return { controls: elements.playerContainer.classList.contains('controls-visible'), classHidden: elements.fullscreenShowBtn.classList.contains('is-hidden'), visibility: style.visibility, pointerEvents: style.pointerEvents };
    })()`);
    assert.equal(fullscreenControlsHidden.controls, false, JSON.stringify(fullscreenControlsHidden));
    assert.equal(fullscreenControlsHidden.classHidden, false, JSON.stringify(fullscreenControlsHidden));
    assert.equal(fullscreenControlsHidden.visibility, 'visible', JSON.stringify(fullscreenControlsHidden));
    await delay(3100);
    const fullscreenButtonTimedOut = await evaluate(cdp, `(() => { const style = getComputedStyle(elements.fullscreenShowBtn); return { opacity: Number(style.opacity), visibility: style.visibility, pointerEvents: style.pointerEvents }; })()`);
    assert.ok(fullscreenButtonTimedOut.opacity <= 0.01, JSON.stringify(fullscreenButtonTimedOut));
    assert.equal(fullscreenButtonTimedOut.visibility, 'hidden', JSON.stringify(fullscreenButtonTimedOut));
    assert.equal(fullscreenButtonTimedOut.pointerEvents, 'none', JSON.stringify(fullscreenButtonTimedOut));
    await evaluate(cdp, `elements.playerContainer.dispatchEvent(new MouseEvent('click', { bubbles: true })); true`); await delay(120);
    const fullscreenRestored = await evaluate(cdp, `({ controls: elements.playerContainer.classList.contains('controls-visible'), showHidden: elements.fullscreenShowBtn.classList.contains('is-hidden'), overlayHidden: elements.fullscreenOverlay.getAttribute('aria-hidden') })`);
    assert.deepEqual(fullscreenRestored, { controls: true, showHidden: true, overlayHidden: 'false' });
    const fullscreenV226Controls = await evaluate(cdp, `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
      const f2Focused = document.activeElement === elements.fullscreenChatInput;
      const hintHidden = elements.fullscreenShortcutHint.classList.contains('is-hidden');
      elements.videoPlayer.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const enterFocused = document.activeElement === elements.fullscreenChatInput;
      elements.videoPlayer.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
      const keyboardLocked = state.fullscreenInteractionLocked && elements.playerContainer.classList.contains('fullscreen-interaction-locked');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', bubbles: true, cancelable: true }));
      const keyboardUnlocked = !state.fullscreenInteractionLocked && !elements.playerContainer.classList.contains('fullscreen-interaction-locked');
      elements.fullscreenLockBtn.click();
      const locked = state.fullscreenInteractionLocked && elements.playerContainer.classList.contains('fullscreen-interaction-locked') && elements.playerSeekSlider.disabled && !elements.videoPlayer.controls;
      elements.fullscreenLockBtn.click();
      const unlocked = !state.fullscreenInteractionLocked && !elements.playerContainer.classList.contains('fullscreen-interaction-locked') && elements.videoPlayer.controls;
      beginFullscreenAdjustmentGesture({ isPrimary: true, button: 0, target: elements.videoPlayer, pointerId: 77, clientX: 100, clientY: 250 });
      updateFullscreenAdjustmentGesture({ pointerId: 77, clientX: 100, clientY: 120, preventDefault() {} });
      const brightnessRaised = state.fullscreenBrightness > 1 && /brightness/.test(elements.videoPlayer.style.filter);
      endFullscreenAdjustmentGesture({ pointerId: 77 });
      return { f2Focused, enterFocused, hintHidden, keyboardLocked, keyboardUnlocked, locked, unlocked, brightnessRaised };
    })()`);
    assert.deepEqual(fullscreenV226Controls, { f2Focused: true, enterFocused: true, hintHidden: true, keyboardLocked: true, keyboardUnlocked: true, locked: true, unlocked: true, brightnessRaised: true }, JSON.stringify(fullscreenV226Controls));
    const fullscreenLandscapePath = path.join(outputDir, 'fullscreen-812x375.png'); await capture(cdp, fullscreenLandscapePath); images.push(fullscreenLandscapePath);
    await evaluate(cdp, `state.pseudoFullscreen = false; handleFullscreenChange(); true`);
    const fullscreenCleanup = await evaluate(cdp, `(() => {
      const first = {
        body: document.body.classList.contains('fullscreen-open'),
        active: elements.playerContainer.classList.contains('fullscreen-active'),
        controls: elements.playerContainer.classList.contains('controls-visible'),
        locked: state.fullscreenInteractionLocked,
        rotation: state.viewRotation,
        zoom: state.viewZoom,
        brightness: state.fullscreenBrightness,
        filter: elements.videoPlayer.style.filter
      };
      state.pseudoFullscreen = true; handleFullscreenChange();
      const sameDayHintHidden = elements.fullscreenShortcutHint.classList.contains('is-hidden');
      state.pseudoFullscreen = false; handleFullscreenChange();
      return { first, sameDayHintHidden };
    })()`);
    assert.deepEqual(fullscreenCleanup.first, { body: false, active: false, controls: false, locked: false, rotation: 0, zoom: 1, brightness: 1, filter: '' }, JSON.stringify(fullscreenCleanup));
    assert.equal(fullscreenCleanup.sameDayHintHidden, true, JSON.stringify(fullscreenCleanup));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const aiMobileLayout = await evaluate(cdp, `(() => {
      document.body.classList.add('android-client');
      aiOpenWorkbench();
      if (elements.aiConfigPanel.classList.contains('is-hidden')) aiToggleConfig();
      elements.aiConfigPanel.scrollTop = elements.aiConfigPanel.scrollHeight;
      const card = elements.aiWorkbenchModal.querySelector('.ai-workbench-card').getBoundingClientRect();
      const panel = elements.aiConfigPanel.querySelector('.ai-config-command-row');
      const conversations = elements.aiWorkbenchModal.querySelector('.ai-conversation-panel').getBoundingClientRect();
      const composer = elements.aiComposer.getBoundingClientRect();
      const buttons = [...panel.querySelectorAll('button')].map((button) => ({ id: button.id, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height }));
      return { bodyWidth: document.body.scrollWidth, viewport: innerWidth, viewportHeight: innerHeight, card: [card.left, card.top, card.right, card.bottom], conversations: [conversations.left, conversations.top, conversations.right, conversations.bottom, conversations.height], composer: [composer.left, composer.top, composer.right, composer.bottom], rowWidth: panel.scrollWidth, rowClientWidth: panel.clientWidth, buttons };
    })()`);
    assert.ok(aiMobileLayout.bodyWidth <= aiMobileLayout.viewport + 2, JSON.stringify(aiMobileLayout));
    assert.ok(aiMobileLayout.card[0] >= -1 && aiMobileLayout.card[1] >= -1 && aiMobileLayout.card[2] <= 391 && aiMobileLayout.card[3] <= 845, JSON.stringify(aiMobileLayout));
    assert.ok(aiMobileLayout.conversations[0] >= -1 && aiMobileLayout.conversations[2] <= 391 && aiMobileLayout.conversations[4] <= 62, JSON.stringify(aiMobileLayout));
    assert.ok(aiMobileLayout.composer[3] <= aiMobileLayout.viewportHeight + 1, JSON.stringify(aiMobileLayout));
    assert.ok(aiMobileLayout.rowWidth <= aiMobileLayout.rowClientWidth + 2, JSON.stringify(aiMobileLayout));
    assert.ok(aiMobileLayout.buttons.every((button) => button.width >= 80 && button.height >= 47.5), JSON.stringify(aiMobileLayout));
    const aiConfigMobilePath = path.join(outputDir, 'ai-config-mobile.png'); await capture(cdp, aiConfigMobilePath); images.push(aiConfigMobilePath);
    const aiChatLayout = await evaluate(cdp, `(() => {
      if (!elements.aiConfigPanel.classList.contains('is-hidden')) aiToggleConfig();
      const conversation = aiActiveConversation();
      conversation.messages = Array.from({ length: 36 }, (_, index) => ({ id: 'mobile-ai-' + index, role: index % 2 ? 'assistant' : 'user', content: '移动端 AI 对话布局回归消息 ' + (index + 1), createdAt: new Date(Date.now() + index * 1000).toISOString() }));
      aiRenderMessages();
      const messages = elements.aiMessages.getBoundingClientRect(); const composer = elements.aiComposer.getBoundingClientRect(); const send = elements.sendAiPromptBtn.getBoundingClientRect();
      return { bodyWidth: document.body.scrollWidth, viewport: innerWidth, messages: [messages.left, messages.top, messages.right, messages.bottom], composer: [composer.left, composer.top, composer.right, composer.bottom], send: [send.left, send.top, send.right, send.bottom, send.height], scrollHeight: elements.aiMessages.scrollHeight, clientHeight: elements.aiMessages.clientHeight, atBottom: elements.aiMessages.scrollHeight - elements.aiMessages.scrollTop - elements.aiMessages.clientHeight };
    })()`);
    assert.ok(aiChatLayout.bodyWidth <= aiChatLayout.viewport + 2, JSON.stringify(aiChatLayout));
    assert.ok(aiChatLayout.scrollHeight > aiChatLayout.clientHeight && aiChatLayout.atBottom <= 2, JSON.stringify(aiChatLayout));
    assert.ok(aiChatLayout.messages[3] <= aiChatLayout.composer[1] + 1 && aiChatLayout.composer[3] <= 845 && aiChatLayout.send[3] <= 845 && aiChatLayout.send[4] >= 47.5, JSON.stringify(aiChatLayout));
    const aiChatMobilePath = path.join(outputDir, 'ai-chat-mobile.png'); await capture(cdp, aiChatMobilePath); images.push(aiChatMobilePath);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 1, mobile: true }); await delay(120);
    const aiSmallPortrait = await evaluate(cdp, `(() => { const card = elements.aiWorkbenchModal.querySelector('.ai-workbench-card').getBoundingClientRect(); const composer = elements.aiComposer.getBoundingClientRect(); const send = elements.sendAiPromptBtn.getBoundingClientRect(); return { bodyWidth: document.body.scrollWidth, viewport: innerWidth, viewportHeight: innerHeight, card: [card.left, card.top, card.right, card.bottom], composer: [composer.left, composer.top, composer.right, composer.bottom], send: [send.left, send.top, send.right, send.bottom, send.height] }; })()`);
    assert.ok(aiSmallPortrait.bodyWidth <= aiSmallPortrait.viewport + 2, JSON.stringify(aiSmallPortrait));
    assert.ok(aiSmallPortrait.card[2] <= 376 && aiSmallPortrait.card[3] <= 668 && aiSmallPortrait.composer[3] <= aiSmallPortrait.viewportHeight + 1 && aiSmallPortrait.send[3] <= aiSmallPortrait.viewportHeight + 1 && aiSmallPortrait.send[4] >= 47.5, JSON.stringify(aiSmallPortrait));
    const aiSmallPortraitPath = path.join(outputDir, 'ai-chat-375x667.png'); await capture(cdp, aiSmallPortraitPath); images.push(aiSmallPortraitPath);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 812, height: 375, deviceScaleFactor: 1, mobile: true }); await delay(120);
    const aiLandscape = await evaluate(cdp, `(() => { const card = elements.aiWorkbenchModal.querySelector('.ai-workbench-card').getBoundingClientRect(); const composer = elements.aiComposer.getBoundingClientRect(); const messages = elements.aiMessages.getBoundingClientRect(); const send = elements.sendAiPromptBtn.getBoundingClientRect(); return { bodyWidth: document.body.scrollWidth, viewport: innerWidth, viewportHeight: innerHeight, card: [card.left, card.top, card.right, card.bottom], messages: [messages.left, messages.top, messages.right, messages.bottom], composer: [composer.left, composer.top, composer.right, composer.bottom], send: [send.left, send.top, send.right, send.bottom, send.height] }; })()`);
    assert.ok(aiLandscape.bodyWidth <= aiLandscape.viewport + 2, JSON.stringify(aiLandscape));
    assert.ok(aiLandscape.card[2] <= 813 && aiLandscape.card[3] <= 376 && aiLandscape.messages[3] <= aiLandscape.composer[1] + 1 && aiLandscape.composer[3] <= aiLandscape.viewportHeight + 1 && aiLandscape.send[3] <= aiLandscape.viewportHeight + 1 && aiLandscape.send[4] >= 47.5, JSON.stringify(aiLandscape));
    const aiLandscapePath = path.join(outputDir, 'ai-chat-812x375.png'); await capture(cdp, aiLandscapePath); images.push(aiLandscapePath);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await delay(120);
    await evaluate(cdp, `aiCloseWorkbench(); true`);
    await evaluate(cdp, `document.body.classList.add('android-client'); mountAccountDropdownForViewport(); elements.toastRegion.innerHTML = ''; elements.mobileMenuBtn.click(); true`); await delay(200);
    const androidAccountActions = await evaluate(cdp, `(() => {
      const actions = document.querySelector('.topbar-actions');
      const mainBefore = elements.mainPage.getBoundingClientRect();
      const initialRect = actions.getBoundingClientRect();
      const initialColumns = getComputedStyle(actions).gridTemplateColumns.split(' ').filter(Boolean).length;
      elements.accountMenuBtn.click();
      const dropdown = elements.accountDropdown;
      const dropdownRect = dropdown.getBoundingClientRect();
      const keep = elements.logoutKeepCredentialsBtn.getBoundingClientRect();
      const plain = elements.logoutBtn.getBoundingClientRect();
      const profile = dropdown.querySelector('[data-account-page="home"]').getBoundingClientRect();
      const visibleButtons = [...dropdown.querySelectorAll('button:not(.is-hidden)')]
        .filter((button) => button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0);
      const mainAfter = elements.mainPage.getBoundingClientRect();
      return {
        open: document.body.classList.contains('mobile-actions-open'),
        parentClass: dropdown.parentElement?.className || '',
        dropdownVisible: !dropdown.classList.contains('is-hidden'),
        accountExpanded: elements.accountMenuBtn.getAttribute('aria-expanded'),
        accountControls: elements.accountMenuBtn.getAttribute('aria-controls'),
        accountHasPopup: elements.accountMenuBtn.hasAttribute('aria-haspopup'),
        dropdownRole: dropdown.getAttribute('role'),
        initialColumns,
        initialHeight: initialRect.height,
        expandedHeight: actions.getBoundingClientRect().height,
        dropdownWidth: dropdownRect.width,
        dropdownScrollWidth: dropdown.scrollWidth,
        minDropdownTarget: Math.min(...visibleButtons.map((button) => button.getBoundingClientRect().height)),
        logoutSameRow: Math.abs(keep.top - plain.top) <= 2,
        logoutBeforeProfile: Math.max(keep.bottom, plain.bottom) <= profile.top + 2,
        noMainResize: Math.abs(mainBefore.height - mainAfter.height) <= 1,
        bodyWidth: document.body.scrollWidth,
        viewport: innerWidth
      };
    })()`);
    assert.equal(androidAccountActions.open, true, JSON.stringify(androidAccountActions));
    assert.match(androidAccountActions.parentClass, /topbar-actions/, JSON.stringify(androidAccountActions));
    assert.equal(androidAccountActions.dropdownVisible, true, JSON.stringify(androidAccountActions));
    assert.equal(androidAccountActions.accountExpanded, 'true', JSON.stringify(androidAccountActions));
    assert.equal(androidAccountActions.accountControls, 'accountDropdown', JSON.stringify(androidAccountActions));
    assert.equal(androidAccountActions.accountHasPopup, false, JSON.stringify(androidAccountActions));
    assert.equal(androidAccountActions.dropdownRole, 'group', JSON.stringify(androidAccountActions));
    assert.equal(androidAccountActions.initialColumns, 1, JSON.stringify(androidAccountActions));
    assert.ok(androidAccountActions.initialHeight <= 480, JSON.stringify(androidAccountActions));
    assert.ok(androidAccountActions.expandedHeight < 762, JSON.stringify(androidAccountActions));
    assert.ok(androidAccountActions.dropdownScrollWidth <= androidAccountActions.dropdownWidth + 2, JSON.stringify(androidAccountActions));
    assert.ok(androidAccountActions.minDropdownTarget >= 47.5, JSON.stringify(androidAccountActions));
    assert.equal(androidAccountActions.logoutSameRow, false, JSON.stringify(androidAccountActions));
    assert.equal(androidAccountActions.logoutBeforeProfile, true, JSON.stringify(androidAccountActions));
    assert.equal(androidAccountActions.noMainResize, true, JSON.stringify(androidAccountActions));
    assert.ok(androidAccountActions.bodyWidth <= androidAccountActions.viewport + 2, JSON.stringify(androidAccountActions));
    const androidAccountActionsPath = path.join(outputDir, 'android-account-actions-390x844.png'); await capture(cdp, androidAccountActionsPath); images.push(androidAccountActionsPath);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 1, mobile: true }); await delay(140);
    const androidSmallAccountActions = await evaluate(cdp, `(() => {
      const actions = document.querySelector('.topbar-actions'); const rect = actions.getBoundingClientRect();
      return {
        columns: getComputedStyle(actions).gridTemplateColumns.split(' ').filter(Boolean).length,
        maxHeight: Number.parseFloat(getComputedStyle(actions).maxHeight),
        height: rect.height,
        scrollable: actions.scrollHeight > actions.clientHeight,
        inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
        bodyWidth: document.body.scrollWidth,
        viewport: innerWidth
      };
    })()`);
    assert.equal(androidSmallAccountActions.columns, 1, JSON.stringify(androidSmallAccountActions));
    assert.equal(androidSmallAccountActions.inside, true, JSON.stringify(androidSmallAccountActions));
    assert.ok(androidSmallAccountActions.height <= androidSmallAccountActions.maxHeight + 1, JSON.stringify(androidSmallAccountActions));
    assert.equal(androidSmallAccountActions.scrollable, true, JSON.stringify(androidSmallAccountActions));
    assert.ok(androidSmallAccountActions.bodyWidth <= androidSmallAccountActions.viewport + 2, JSON.stringify(androidSmallAccountActions));
    const androidSmallAccountActionsPath = path.join(outputDir, 'android-account-actions-375x667.png'); await capture(cdp, androidSmallAccountActionsPath); images.push(androidSmallAccountActionsPath);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await delay(140);
    await evaluate(cdp, `elements.accountMenuBtn.click(); true`);
    const androidToastClearance = await evaluate(cdp, `(() => {
      const item = toastWithActions('Location permission denied', [
        { label: '\u91cd\u65b0\u6388\u6743', callback: () => {} },
        { label: '\u6c38\u4e45\u4e0d\u518d\u63d0\u793a', callback: () => {} }
      ], 0, 'error');
      const controls = [...item.querySelectorAll('button')];
      const result = {
        bottom: Number.parseFloat(getComputedStyle(elements.toastRegion).bottom),
        labels: controls.map((button) => button.getAttribute('aria-label') || button.textContent.trim()),
        minControlHeight: Math.min(...controls.map((button) => button.getBoundingClientRect().height))
      };
      item.querySelector('.toast-close')?.click();
      return result;
    })()`);
    assert.ok(androidToastClearance.bottom >= 63.5, JSON.stringify(androidToastClearance));
    assert.deepEqual(androidToastClearance.labels, ['\u91cd\u65b0\u6388\u6743', '\u6c38\u4e45\u4e0d\u518d\u63d0\u793a', '\u5173\u95ed\u63d0\u793a']);
    assert.ok(androidToastClearance.minControlHeight >= 43.5, JSON.stringify(androidToastClearance));
    const androidPortrait = await evaluate(cdp, `(() => {
      const actions = document.querySelector('.topbar-actions');
      const targets = [...document.querySelectorAll('.topbar-actions button:not(.is-hidden), .theater-toolbar button:not(.is-hidden), .chat-form button:not(.is-hidden)')]
        .filter((target) => target.getBoundingClientRect().width > 0 && target.getBoundingClientRect().height > 0);
      return {
        bodyWidth: document.body.scrollWidth, viewport: innerWidth,
        actionWidth: actions?.clientWidth || 0, actionScrollWidth: actions?.scrollWidth || 0,
        minTargetHeight: Math.min(...targets.map((target) => target.getBoundingClientRect().height))
      };
    })()`);
    assert.ok(androidPortrait.bodyWidth <= androidPortrait.viewport + 2, JSON.stringify(androidPortrait));
    assert.ok(androidPortrait.actionScrollWidth <= androidPortrait.actionWidth + 2, JSON.stringify(androidPortrait));
    assert.ok(androidPortrait.minTargetHeight >= 47.5, JSON.stringify(androidPortrait));
    const mobileModuleScroll = await evaluate(cdp, `(async () => {
      const nav = document.querySelector('.mobile-module-nav');
      const originalBodyMinHeight = document.body.style.minHeight;
      document.body.style.minHeight = '1600px';
      scrollTo(0, 0); await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const before = nav.getBoundingClientRect().top;
      const target = Math.min(220, Math.max(0, document.documentElement.scrollHeight - innerHeight));
      scrollTo(0, target); await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const after = nav.getBoundingClientRect().top;
      const result = { position: getComputedStyle(nav).position, before, after, scrollY, target };
      scrollTo(0, 0); document.body.style.minHeight = originalBodyMinHeight; return result;
    })()`);
    assert.equal(mobileModuleScroll.position, 'static', JSON.stringify(mobileModuleScroll));
    assert.ok(mobileModuleScroll.target > 0 && mobileModuleScroll.after < mobileModuleScroll.before - 40, JSON.stringify(mobileModuleScroll));
    const mobileChatFeed = await evaluate(cdp, `(async () => {
      const originalMessages = state.messages; const originalFilter = state.chatViewFilter;
      globalThis.__uiSmokeChatRestore = { messages: originalMessages, filter: originalFilter };
      toggleMobileActionMenu(false);
      state.chatViewFilter = { channel: '', username: '', userMode: 'include', query: '' };
      state.messages = Array.from({ length: 80 }, (_, index) => ({ id: 'mobile-chat-' + index, type: index % 3 ? 'public' : 'system', from: 'browser-ui-owner', fromName: '布局测试成员', text: '移动端聊天与房间动态 ' + (index + 1), timestamp: new Date(Date.now() + index * 1000).toISOString() }));
      state.mobileChatCollapsed = false; applyMobileChatCollapsed(); renderChat();
      elements.chatHistory.scrollTop = 0; openMobileModule('chat');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const history = elements.chatHistory.getBoundingClientRect(); const form = elements.chatForm.getBoundingClientRect();
      const switchedToBottom = elements.chatHistory.scrollHeight - elements.chatHistory.scrollTop - elements.chatHistory.clientHeight;
      elements.chatHistory.scrollTop = 0;
      addChatMessage({ id: 'mobile-chat-reader', type: 'public', from: 'browser-ui-owner', fromName: '布局测试成员', text: '阅读历史时不抢滚动位置', timestamp: new Date(Date.now() + 100000).toISOString() });
      const readerTop = elements.chatHistory.scrollTop;
      elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
      addChatMessage({ id: 'mobile-chat-latest', type: 'public', from: 'browser-ui-owner', fromName: '布局测试成员', text: '位于底部时跟随最新消息', timestamp: new Date(Date.now() + 101000).toISOString() });
      const latestBottom = elements.chatHistory.scrollHeight - elements.chatHistory.scrollTop - elements.chatHistory.clientHeight;
      const result = { panelMode: elements.theater.dataset.mobileModuleActive, history: [history.left, history.top, history.right, history.bottom, history.height], form: [form.left, form.top, form.right, form.bottom], scrollHeight: elements.chatHistory.scrollHeight, clientHeight: elements.chatHistory.clientHeight, switchedToBottom, readerTop, latestBottom, overflowY: getComputedStyle(elements.chatHistory).overflowY };
      return result;
    })()`);
    assert.equal(mobileChatFeed.panelMode, 'chat', JSON.stringify(mobileChatFeed));
    assert.equal(mobileChatFeed.overflowY, 'auto', JSON.stringify(mobileChatFeed));
    assert.ok(mobileChatFeed.scrollHeight > mobileChatFeed.clientHeight && mobileChatFeed.history[4] <= 421, JSON.stringify(mobileChatFeed));
    assert.ok(Math.abs(mobileChatFeed.form[1] - mobileChatFeed.history[3]) <= 2, JSON.stringify(mobileChatFeed));
    assert.ok(mobileChatFeed.switchedToBottom <= 2 && mobileChatFeed.readerTop <= 2 && mobileChatFeed.latestBottom <= 2, JSON.stringify(mobileChatFeed));
    await evaluate(cdp, `elements.chatPanel.scrollIntoView({ block: 'start' }); true`); await delay(120);
    const mobileChatPath = path.join(outputDir, 'mobile-chat-scroll.png'); await capture(cdp, mobileChatPath); images.push(mobileChatPath);
    await evaluate(cdp, `(() => { const restore = globalThis.__uiSmokeChatRestore; if (restore) { state.messages = restore.messages; state.chatViewFilter = restore.filter; delete globalThis.__uiSmokeChatRestore; } renderChat(); openMobileModule('watch'); return true; })()`);
    const androidFullscreenLayers = await evaluate(cdp, `(() => {
      const videoWasHidden = elements.videoPlayer.classList.contains('is-hidden');
      const emptyWasHidden = elements.emptyStage.classList.contains('is-hidden');
      elements.emptyStage.classList.add('is-hidden'); elements.videoPlayer.classList.remove('is-hidden');
      state.pseudoFullscreen = true; handleFullscreenChange();
      const danmaku = getComputedStyle(elements.danmakuContainer);
      const reactions = getComputedStyle(elements.reactionLayer);
      const player = elements.playerContainer.getBoundingClientRect();
      const video = elements.videoPlayer.getBoundingClientRect();
      const result = { danmakuDisplay: danmaku.display, danmakuZ: Number(danmaku.zIndex), reactionDisplay: reactions.display, reactionZ: Number(reactions.zIndex), player: [player.left, player.top, player.width, player.height], video: [video.left, video.top, video.width, video.height], viewport: [innerWidth, innerHeight] };
      state.pseudoFullscreen = false; handleFullscreenChange();
      if (videoWasHidden) elements.videoPlayer.classList.add('is-hidden');
      if (!emptyWasHidden) elements.emptyStage.classList.remove('is-hidden');
      return result;
    })()`);
    assert.notEqual(androidFullscreenLayers.danmakuDisplay, 'none', JSON.stringify(androidFullscreenLayers));
    assert.notEqual(androidFullscreenLayers.reactionDisplay, 'none', JSON.stringify(androidFullscreenLayers));
    assert.ok(androidFullscreenLayers.danmakuZ >= 2147483643 && androidFullscreenLayers.reactionZ >= 2147483643, JSON.stringify(androidFullscreenLayers));
    assert.deepEqual(androidFullscreenLayers.player.map(Math.round), [0, 0, 390, 844], JSON.stringify(androidFullscreenLayers));
    assert.deepEqual(androidFullscreenLayers.video.map(Math.round), [0, 0, 390, 844], JSON.stringify(androidFullscreenLayers));
    const androidPortraitPath = path.join(outputDir, 'android-portrait.png'); await capture(cdp, androidPortraitPath); images.push(androidPortraitPath);
    await evaluate(cdp, `toggleMobileActionMenu(false); true`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true }); await delay(180);
    const androidLandscape = await evaluate(cdp, `(() => {
      const videoWasHidden = elements.videoPlayer.classList.contains('is-hidden');
      const emptyWasHidden = elements.emptyStage.classList.contains('is-hidden');
      elements.emptyStage.classList.add('is-hidden'); elements.videoPlayer.classList.remove('is-hidden');
      state.pseudoFullscreen = true; handleFullscreenChange();
      const player = elements.playerContainer.getBoundingClientRect(); const video = elements.videoPlayer.getBoundingClientRect();
      const fullscreen = { player: [player.left, player.top, player.width, player.height], video: [video.left, video.top, video.width, video.height] };
      state.pseudoFullscreen = false; handleFullscreenChange();
      if (videoWasHidden) elements.videoPlayer.classList.add('is-hidden');
      if (!emptyWasHidden) elements.emptyStage.classList.remove('is-hidden');
      return { bodyWidth: document.body.scrollWidth, viewport: innerWidth, bodyHeight: document.body.scrollHeight, fullscreen };
    })()`);
    assert.ok(androidLandscape.bodyWidth <= androidLandscape.viewport + 2, JSON.stringify(androidLandscape));
    assert.deepEqual(androidLandscape.fullscreen.player.map(Math.round), [0, 0, 844, 390], JSON.stringify(androidLandscape));
    assert.deepEqual(androidLandscape.fullscreen.video.map(Math.round), [0, 0, 844, 390], JSON.stringify(androidLandscape));
    const androidLandscapePath = path.join(outputDir, 'android-landscape.png'); await capture(cdp, androidLandscapePath); images.push(androidLandscapePath);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await delay(120);
    await evaluate(cdp, `(() => {
      sessionStorage.setItem('syncwatchSkipSmokeAutologin', '1');
      sessionStorage.removeItem('syncwatchRoomId');
      elements.username.value = 'BrowserUiOwner'; elements.password.value = '123456';
      toggleMobileActionMenu(true);
      if (elements.accountDropdown.classList.contains('is-hidden')) elements.accountMenuBtn.click();
      elements.logoutKeepCredentialsBtn.click();
      return true;
    })()`);
    await waitFor(() => evaluate(cdp, `!elements.ownerExitModal.classList.contains('is-hidden')`), '保留凭据退出时显示房主处理选择');
    assert.equal(await evaluate(cdp, `document.activeElement?.dataset?.ownerExit || ''`), 'leave', '房主退出弹窗应聚焦安全的只退出操作');
    assert.equal(await evaluate(cdp, `(() => { const cancel = elements.ownerExitModal.querySelector('[data-owner-exit="cancel"]'); cancel.focus(); cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); return document.activeElement?.dataset?.ownerExit || ''; })()`), 'leave', 'Tab 应从最后一个操作回到第一个操作');
    assert.equal(await evaluate(cdp, `(() => { const leave = elements.ownerExitModal.querySelector('[data-owner-exit="leave"]'); leave.focus(); leave.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); return document.activeElement?.dataset?.ownerExit || ''; })()`), 'cancel', 'Shift+Tab 应从第一个操作回到最后一个操作');
    await evaluate(cdp, `elements.ownerExitModal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await waitFor(() => evaluate(cdp, `elements.ownerExitModal.classList.contains('is-hidden') && document.activeElement === elements.mobileMenuBtn`), 'Escape 取消退出并恢复到手机功能菜单按钮');
    await evaluate(cdp, `toggleMobileActionMenu(true); elements.accountMenuBtn.click(); elements.logoutKeepCredentialsBtn.click(); true`);
    await waitFor(() => evaluate(cdp, `!elements.ownerExitModal.classList.contains('is-hidden') && document.activeElement?.dataset?.ownerExit === 'leave'`), '再次打开保留凭据退出选择');
    await evaluate(cdp, `elements.ownerExitModal.querySelector('[data-owner-exit="leave"]').click(); true`);
    await waitFor(() => evaluate(cdp, `Boolean(typeof state !== 'undefined' && state.socket?.connected && !state.authenticated && !elements.loginPage.classList.contains('is-hidden'))`), '保留凭据退出并返回登录页');
    const retainedLogout = await evaluate(cdp, `({
      username: elements.username.value,
      password: elements.password.value,
      token: localStorage.getItem('syncwatchToken'),
      retainedStorage: sessionStorage.getItem('syncwatchRetainedLogin'),
      notice: elements.loginStatus.textContent
    })`);
    assert.deepEqual(retainedLogout, {
      username: 'BrowserUiOwner', password: '123456', token: null, retainedStorage: null,
      notice: '已保留上次登录的账号密码，可直接选择房间再登录。'
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1365, height: 860, deviceScaleFactor: 1, mobile: false });
    await evaluate(cdp, `document.body.classList.remove('android-client'); window.scrollTo(0, 0); true`);
    const loginAttentionFields = await evaluate(cdp, `(() => {
      const ids = ['username', 'password', 'roomIdInput'];
      return ids.map((id) => {
        const field = elements[id];
        const target = field.closest('.password-field') || field;
        const style = getComputedStyle(target);
        return { id, highlighted: field.closest('label')?.classList.contains('login-attention-field') === true, animation: style.animationName, boxShadow: style.boxShadow };
      });
    })()`);
    assert.ok(loginAttentionFields.every((field) => field.highlighted && field.animation !== 'none' && field.boxShadow !== 'none'), JSON.stringify(loginAttentionFields));
    await evaluate(cdp, `(() => { elements.roomIdInput.value = 'BROWSER1'; elements.roomIdInput.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await waitFor(() => evaluate(cdp, `state.loginRoomPasswordRoomId === 'BROWSER1' && state.loginRoomPasswordRequired === false`), '登录页实时显示无密码房间状态');
    assert.equal(await evaluate(cdp, `elements.loginRoomPasswordState.textContent`), '无密码');
    await evaluate(cdp, `(() => { elements.roomIdInput.value = 'LOCKED1'; elements.roomIdInput.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await waitFor(() => evaluate(cdp, `state.loginRoomPasswordRoomId === 'LOCKED1' && state.loginRoomPasswordRequired === true`), '登录页实时显示有密码房间状态');
    assert.equal(await evaluate(cdp, `elements.loginRoomPasswordState.textContent`), '有密码');
    await evaluate(cdp, `elements.loginRoomPassword.value = ''; elements.loginForm.requestSubmit(); true`);
    await waitFor(() => evaluate(cdp, `elements.loginStatus.textContent === '请输入房间密码' && document.activeElement === elements.loginRoomPassword`), '空房间密码显示明确输入提示');
    assert.equal(await evaluate(cdp, `elements.loginRoomPassword.getAttribute('aria-invalid')`), 'true');
    await evaluate(cdp, `(() => {
      if (typeof activeAppDialog !== 'undefined' && activeAppDialog) settleAppDialog(false);
      document.querySelectorAll('.modal:not(.is-hidden)').forEach((modal) => modal.classList.add('is-hidden'));
      if (typeof clearAllToasts === 'function') clearAllToasts();
      elements.clearAllToastsBtn?.classList.add('is-hidden');
      window.scrollTo(0, 0);
      return true;
    })()`);
    const loginPasswordStatePath = path.join(outputDir, 'login-room-password-state-desktop.png'); await capture(cdp, loginPasswordStatePath); images.push(loginPasswordStatePath);
    await evaluate(cdp, `elements.loginRoomPassword.value = 'wrong-room-pass'; elements.loginForm.requestSubmit(); true`);
    await waitFor(() => evaluate(cdp, `/房间密码错误/.test(elements.loginStatus.textContent)`), '非空错误房间密码显示密码错误');
    assert.equal(await evaluate(cdp, `state.authenticated`), false);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(cdp, `document.body.classList.remove('android-client'); window.scrollTo(0, 0); true`);
    await delay(180);
    const plainMobileLoginScroll = await evaluate(cdp, `(() => {
      const main = document.querySelector('main');
      const page = elements.loginPage;
      const before = window.scrollY;
      const metrics = {
        bodyHeight: document.body.scrollHeight,
        viewportHeight: innerHeight,
        bodyOverflowY: getComputedStyle(document.body).overflowY,
        mainHeight: main?.getBoundingClientRect().height || 0,
        mainOverflowY: main ? getComputedStyle(main).overflowY : '',
        pageHeight: page?.getBoundingClientRect().height || 0,
        pageOverflowY: page ? getComputedStyle(page).overflowY : '',
        pageTouchAction: page ? getComputedStyle(page).touchAction : ''
      };
      return { before, metrics };
    })()`);
    assert.ok(plainMobileLoginScroll.metrics.bodyHeight > plainMobileLoginScroll.metrics.viewportHeight, JSON.stringify(plainMobileLoginScroll));
    assert.equal(plainMobileLoginScroll.metrics.bodyOverflowY, 'auto', JSON.stringify(plainMobileLoginScroll));
    assert.equal(plainMobileLoginScroll.metrics.mainOverflowY, 'visible', JSON.stringify(plainMobileLoginScroll));
    assert.equal(plainMobileLoginScroll.metrics.pageOverflowY, 'visible', JSON.stringify(plainMobileLoginScroll));
    assert.equal(plainMobileLoginScroll.metrics.pageTouchAction, 'pan-y', JSON.stringify(plainMobileLoginScroll));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 720, radiusX: 8, radiusY: 8, force: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 250, radiusX: 8, radiusY: 8, force: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await delay(120);
    const plainMobileLoginAfterSwipe = await evaluate(cdp, `window.scrollY`);
    assert.ok(plainMobileLoginAfterSwipe > 8, JSON.stringify({ plainMobileLoginScroll, plainMobileLoginAfterSwipe }));
    const retainedCredentialsAfterRoomPasswordError = await evaluate(cdp, `({
      username: elements.username.value,
      password: elements.password.value,
      token: localStorage.getItem('syncwatchToken'),
      retainedStorage: sessionStorage.getItem('syncwatchRetainedLogin')
    })`);
    assert.deepEqual(retainedCredentialsAfterRoomPasswordError, {
      username: 'BrowserUiOwner', password: '123456', token: null, retainedStorage: null
    });
    await evaluate(cdp, `(() => {
      elements.roomIdInput.value = 'BROWSER1'; elements.loginRoomPassword.value = ''; elements.autoLogin.checked = false;
      elements.loginForm.requestSubmit(); return true;
    })()`);
    await waitFor(() => evaluate(cdp, `Boolean(state.authenticated && !elements.mainPage.classList.contains('is-hidden'))`), '使用保留凭据重新登录');
    await evaluate(cdp, `(() => {
      document.body.classList.add('android-client'); mountAccountDropdownForViewport();
      toggleMobileActionMenu(true); elements.accountMenuBtn.click(); elements.logoutBtn.click(); return true;
    })()`);
    await waitFor(() => evaluate(cdp, `!elements.ownerExitModal.classList.contains('is-hidden')`), '普通退出时显示房主处理选择');
    await evaluate(cdp, `elements.ownerExitModal.querySelector('[data-owner-exit="leave"]').click(); true`);
    await waitFor(() => evaluate(cdp, `Boolean(typeof state !== 'undefined' && state.socket?.connected && !state.authenticated && !elements.loginPage.classList.contains('is-hidden'))`), '普通退出并返回登录页');
    const plainLogout = await evaluate(cdp, `({
      username: elements.username.value,
      password: elements.password.value,
      token: localStorage.getItem('syncwatchToken'),
      retainedStorage: sessionStorage.getItem('syncwatchRetainedLogin')
    })`);
    assert.deepEqual(plainLogout, { username: '', password: '', token: null, retainedStorage: null });
    const retiredPlatformUi = await evaluate(cdp, `({
      macServerButton: Boolean(document.getElementById('downloadMacServerBtn')),
      macClientButton: Boolean(document.getElementById('downloadMacClientBtn')),
      macDownloadModal: Boolean(document.getElementById('macDownloadModal'))
    })`);
    assert.deepEqual(retiredPlatformUi, { macServerButton: false, macClientButton: false, macDownloadModal: false });
    await evaluate(cdp, `elements.serverSettingsLoginBtn.click(); elements.adminUsername.value = 'admin'; elements.adminPassword.value = 'admin888'; elements.loadAdminBtn.click(); true`);
    await waitFor(() => evaluate(cdp, `Boolean(!elements.agreementModal.classList.contains('is-hidden') || state.authenticated)`), '超级管理员登录协议');
    if (await evaluate(cdp, `Boolean(!elements.agreementModal.classList.contains('is-hidden'))`)) {
      await evaluate(cdp, `elements.agreementCheck.click(); elements.acceptAgreementBtn.click(); true`);
    }
    await waitFor(() => evaluate(cdp, `Boolean(state.authenticated && state.adminSettings?.serverAdmin && elements.managementAuth.classList.contains('is-hidden'))`), '登录页验证并加载超级管理员设置');
    await evaluate(cdp, `if (typeof activeAppDialog !== 'undefined' && activeAppDialog) settleAppDialog(false); true`);
    const loginSettingsAuth = await evaluate(cdp, `({ username: state.user?.username, authHidden: elements.managementAuth.classList.contains('is-hidden'), usernameValue: elements.adminUsername.value, passwordValue: elements.adminPassword.value, loginVisible: !elements.loginPage.classList.contains('is-hidden'), roomVisible: !elements.mainPage.classList.contains('is-hidden'), managementVisible: !elements.managementHubModal.classList.contains('is-hidden'), section: state.managementSection })`);
    assert.deepEqual(loginSettingsAuth, { username: 'admin', authHidden: true, usernameValue: '', passwordValue: '', loginVisible: true, roomVisible: false, managementVisible: true, section: 'server' });
    await evaluate(cdp, `openManagementHub('notices'); true`);
    await waitFor(() => evaluate(cdp, `!elements.managementHubModal.classList.contains('is-hidden') && state.managementSection === 'notices'`), '打开通知通告设置中的登录立方体模块');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await delay(140);
    const cubeSettingsSurface = await evaluate(cdp, `(() => {
      const card = elements.loginCubeSettingsCard;
      const editors = [...elements.loginCubeSettingsGrid.querySelectorAll('[data-login-cube-face-editor]')];
      return {
        visible: Boolean(card && !card.classList.contains('is-hidden')),
        faceIds: editors.map((editor) => editor.dataset.loginCubeFaceEditor),
        noHorizontalOverflow: Boolean(card && card.scrollWidth <= card.clientWidth + 2 && document.body.scrollWidth <= innerWidth + 2),
        saveVisible: Boolean(elements.saveLoginCubeSettingsBtn?.getBoundingClientRect().height > 0),
        section: state.managementSection,
        cardDisplay: card ? getComputedStyle(card).display : '',
        buttonDisplay: elements.saveLoginCubeSettingsBtn ? getComputedStyle(elements.saveLoginCubeSettingsBtn).display : '',
        modalHidden: elements.managementHubModal.classList.contains('is-hidden')
      };
    })()`);
    assert.deepEqual(cubeSettingsSurface.faceIds, ['front', 'back', 'right', 'left', 'top', 'bottom']);
    assert.equal(cubeSettingsSurface.visible, true, JSON.stringify(cubeSettingsSurface));
    assert.equal(cubeSettingsSurface.noHorizontalOverflow, true, JSON.stringify(cubeSettingsSurface));
    assert.equal(cubeSettingsSurface.saveVisible, true, JSON.stringify(cubeSettingsSurface));
    await evaluate(cdp, `(() => {
      const editor = elements.loginCubeSettingsGrid.querySelector('[data-login-cube-face-editor="front"]');
      const title = editor.querySelector('[data-login-cube-field="title"]');
      title.value = '浏览器立方体验收';
      title.dispatchEvent(new Event('input', { bubbles: true }));
      elements.saveLoginCubeSettingsBtn.click();
      return true;
    })()`);
    await waitFor(() => evaluate(cdp, `state.publicConfig.loginCube?.faces?.find((face) => face.id === 'front')?.title === '浏览器立方体验收'`), '登录立方体六面设置保存');
    const cubeSettingsSaved = await evaluate(cdp, `({
      title: elements.loginCube.querySelector('[data-login-cube-face="front"] .login-cube-face-title')?.textContent,
      status: elements.loginCubeSettingsStatus?.textContent,
      disabled: elements.saveLoginCubeSettingsBtn?.disabled
    })`);
    assert.equal(cubeSettingsSaved.title, '浏览器立方体验收', JSON.stringify(cubeSettingsSaved));
    assert.equal(cubeSettingsSaved.disabled, false, JSON.stringify(cubeSettingsSaved));
    assert.match(cubeSettingsSaved.status, /已保存|同步/);
    await evaluate(cdp, `document.querySelectorAll('.modal').forEach((modal) => { if (modal !== elements.managementHubModal) modal.classList.add('is-hidden'); }); elements.toastRegion.replaceChildren(); elements.loginCubeSettingsCard.scrollIntoView({ block: 'start' }); true`);
    await delay(120);
    await evaluate(cdp, `localStorage.setItem('syncwatchF11Prompt', '-1'); closeF11Prompt(false); document.querySelectorAll('.modal').forEach((modal) => { if (modal !== elements.managementHubModal) modal.classList.add('is-hidden'); }); document.querySelectorAll('.toast').forEach((toast) => toast.remove()); elements.toastRegion.style.visibility = 'hidden'; elements.managementHubModal.classList.remove('is-hidden'); elements.loginCubeSettingsCard.scrollIntoView({ block: 'start' }); true`);
    const cubeSettingsPath = path.join(outputDir, 'login-cube-settings-mobile.png'); await capture(cdp, cubeSettingsPath); images.push(cubeSettingsPath);
    console.log(JSON.stringify({ success: true, images, original, mobile }));
  } finally {
    global.fetch = originalFetch;
    cdp?.close();
    await stopProcessTree(chrome);
    authSocket?.close();
    await server?.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
    await removeDirectoryEventually(profileDir);
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
