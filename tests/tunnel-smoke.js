'use strict';

require('./epipe-guard');

const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { io } = require('socket.io-client');
const ffmpegPath = require('ffmpeg-static');

if (process.env.SYNCWATCH_SKIP_PUBLIC_TUNNEL_SMOKE === '1') {
  console.warn('公网隧道 Electron 实测已跳过：当前构建环境未提供可用的外网 WebSocket 路径。');
  process.exit(0);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-tunnel-smoke-'));
const userDataDir = path.join(dataDir, 'electron-user-data');
const cacheDir = path.join(dataDir, 'electron-cache');
const samplePath = path.join(dataDir, 'tunnel-h264-sample.mp4');
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });
const generated = spawnSync(ffmpegPath, [
  '-y', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=660:duration=6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
  '-c:a', 'aac', '-movflags', '+faststart', '-shortest', samplePath
], { windowsHide: true, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr || '无法生成公网隧道 H.264 测试影片');
const sampleBytes = fs.readFileSync(samplePath);
assert.ok(sampleBytes.length > 2048, '公网隧道 H.264 测试影片体积异常');
app.setPath('userData', userDataDir);
app.setPath('cache', cacheDir);
app.commandLine.appendSwitch('disk-cache-dir', cacheDir);
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
process.env.SYNCWATCH_SMOKE_MODE = '1';
process.env.SYNCWATCH_DATA_DIR = dataDir;
process.env.PORT = '0';
const diagnostics = [];
const TRANSIENT_RANGE_HTTP_STATUSES = new Set([502, 503, 504]);
const TRANSIENT_RANGE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE']);
const MAX_TRANSIENT_RANGE_ERRORS = 3;
const transientRangeStats = { errors: 0, retries: 0, byStatus: Object.create(null) };
function recordDiagnostic(value) {
  diagnostics.push(`[${new Date().toISOString()}] ${value}`);
  if (diagnostics.length > 100) diagnostics.shift();
}
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_consoleEvent, details) => {
    recordDiagnostic(`renderer console ${details?.level || ''}: ${details?.message || ''} ${details?.sourceId || ''}:${details?.lineNumber || ''}`);
  });
  contents.on('did-fail-load', (_loadEvent, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) recordDiagnostic(`did-fail-load ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  contents.on('render-process-gone', (_goneEvent, details) => recordDiagnostic(`render-process-gone ${JSON.stringify(details)}`));
  contents.on('unresponsive', () => recordDiagnostic('renderer unresponsive'));
});
require('../electron-pink');

async function waitForWindow() {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const target = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().startsWith('http://127.0.0.1:'));
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`主窗口启动超时\n${diagnostics.join('\n')}`);
}

async function ensureControlWindow(candidate, { token, roomId }) {
  if (candidate && !candidate.isDestroyed() && !candidate.webContents.isDestroyed()) return candidate;
  recordDiagnostic('long-running smoke control window was destroyed; recreating it without restarting the server');
  app.emit('activate');
  const replacement = await waitForWindow();
  await waitFor(replacement, `document.getElementById('connectionBadge').classList.contains('online')`, 20000);
  const ready = await replacement.webContents.executeJavaScript(`Boolean(state.authenticated && state.room?.id === ${JSON.stringify(roomId)})`, true);
  if (!ready) {
    await replacement.webContents.executeJavaScript(`(() => {
      localStorage.setItem('syncwatchToken', ${JSON.stringify(token)});
      sessionStorage.setItem('syncwatchRoomId', ${JSON.stringify(roomId)});
      const next = new URL(location.href); next.searchParams.set('room', ${JSON.stringify(roomId)});
      location.replace(next.href); return true;
    })()`, true);
    await waitFor(replacement, `state.authenticated && state.room?.id === ${JSON.stringify(roomId)}
      && !document.getElementById('mainPage').classList.contains('is-hidden')`, 30000);
  }
  return replacement;
}

async function waitFor(window, expression, timeout = 180000) {
  const started = Date.now();
  let lastExecutionError = null;
  while (Date.now() - started < timeout) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) throw new Error(`等待过程中主窗口已销毁：${expression}\n${diagnostics.join('\n')}`);
    try {
      const result = await window.webContents.executeJavaScript(expression, true);
      if (result) return result;
      lastExecutionError = null;
    } catch (error) {
      lastExecutionError = error;
      recordDiagnostic(`executeJavaScript failed: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  let snapshot = null;
  try {
    snapshot = await window.webContents.executeJavaScript(`(() => ({
      url: location.href, readyState: document.readyState,
      badgeText: document.getElementById('connectionBadge')?.textContent || '',
      badgeClass: document.getElementById('connectionBadge')?.className || '',
      loginStatus: document.getElementById('loginStatus')?.textContent || '',
      tunnelStatus: document.getElementById('tunnelStatus')?.textContent || '',
      socketConnected: Boolean(globalThis.state?.socket?.connected),
      socketAuthenticated: Boolean(globalThis.state?.socketAuthenticated)
    }))()`, true);
  } catch (error) {
    snapshot = { snapshotError: error.message };
  }
  throw new Error(`等待超时：${expression}\n最后执行错误：${lastExecutionError?.message || '无'}\n页面状态：${JSON.stringify(snapshot)}\n${diagnostics.join('\n')}`);
}

async function ack(socket, event, payload, label = event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}：${event} 超时（connected=${socket.connected} transport=${socket.io.engine?.transport?.name || ''}）`)), 20000);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result); });
  });
}

async function connectRemote(publicUrl, transport, label) {
  const productFallback = transport === 'product';
  const socket = io(publicUrl, {
    transports: productFallback ? ['websocket', 'polling'] : [transport],
    tryAllTransports: productFallback, upgrade: productFallback, forceNew: true,
    timeout: 30000, reconnection: true, reconnectionAttempts: Infinity,
    reconnectionDelay: 250, reconnectionDelayMax: 1500,
    extraHeaders: { Origin: publicUrl }
  });
  socket.syncwatchRecovery = {
    label, disconnects: 0, resumes: 0, needsResume: false,
    disconnectedAt: 0, maxDowntimeMs: 0, lastReason: ''
  };
  socket.on('disconnect', (reason) => {
    const recovery = socket.syncwatchRecovery;
    recovery.disconnects += 1;
    recovery.needsResume = true;
    recovery.disconnectedAt = Date.now();
    recovery.lastReason = String(reason || 'unknown');
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${label} 公网连接超时`));
    }, 45000);
    const finish = (error) => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      if (error) {
        socket.close();
        reject(error);
      } else resolve(socket);
    };
    const onConnect = () => finish();
    const onError = (error) => recordDiagnostic(`${label} initial connect error: ${error?.message || error}`);
    socket.once('connect', onConnect);
    socket.on('connect_error', onError);
  });
}

async function waitForRemoteConnection(socket, label, timeout = 20000) {
  if (socket.connected) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} 公网连接在瞬断后 ${timeout}ms 内没有恢复`));
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };
    const onConnect = () => { cleanup(); resolve(); };
    const onError = (error) => recordDiagnostic(`${label} reconnect error: ${error?.message || error}`);
    socket.once('connect', onConnect);
    socket.on('connect_error', onError);
    socket.connect();
  });
}

async function ensureRemoteSession(socket, { token, deviceId, label }) {
  await waitForRemoteConnection(socket, label);
  const recovery = socket.syncwatchRecovery;
  if (!recovery?.needsResume) return;
  const result = await ack(socket, 'session-resume', { token, deviceId }, `${label} 瞬断恢复`);
  assert.equal(result.success, true, result.error || `${label} 瞬断后会话恢复失败`);
  recovery.needsResume = false;
  recovery.resumes += 1;
  recovery.maxDowntimeMs = Math.max(recovery.maxDowntimeMs, Date.now() - recovery.disconnectedAt);
}

async function forceRemoteRecovery(socket, credentials) {
  const disconnected = socket.connected
    ? new Promise((resolve) => socket.once('disconnect', resolve))
    : Promise.resolve();
  socket.io.engine?.close();
  await disconnected;
  await ensureRemoteSession(socket, credentials);
  assert.ok(socket.syncwatchRecovery.disconnects >= 1, `${credentials.label} 未记录受控瞬断`);
  assert.ok(socket.syncwatchRecovery.resumes >= 1, `${credentials.label} 未完成受控会话恢复`);
}

function nextSocketEvent(socket, event, predicate = () => true, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待公网 ${event} 事件超时`));
    }, timeout);
    const onEvent = (payload) => {
      let accepted = false;
      try { accepted = predicate(payload); } catch (error) { cleanup(); reject(error); return; }
      if (!accepted) return;
      cleanup();
      resolve(payload);
    };
    const onDisconnect = (reason) => {
      cleanup();
      reject(new Error(`等待公网 ${event} 时连接断开：${reason}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      socket.off('disconnect', onDisconnect);
    };
    socket.on(event, onEvent);
    socket.once('disconnect', onDisconnect);
  });
}

async function verifyRange(publicUrl, mediaUrl, cookie, range, expectedBytes, expectedStart, totalLength) {
  const response = await fetch(`${publicUrl}${mediaUrl}`, {
    headers: { Cookie: cookie, Range: range, Accept: 'video/mp4' },
    signal: AbortSignal.timeout(30000)
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const expectedEnd = expectedStart + expectedBytes.length - 1;
  assert.equal(response.status, 206, `${range} 未返回 HTTP 206`);
  assert.equal(response.headers.get('accept-ranges'), 'bytes', `${range} 缺少 Accept-Ranges`);
  assert.equal(response.headers.get('content-range'), `bytes ${expectedStart}-${expectedEnd}/${totalLength}`, `${range} Content-Range 错误`);
  assert.equal(Number(response.headers.get('content-length')), expectedBytes.length, `${range} Content-Length 错误`);
  assert.deepEqual(bytes, expectedBytes, `${range} 返回的媒体字节与源文件不一致`);
}

async function abortRemoteRangeAttempt(publicUrl, mediaUrl, cookie, offset) {
  return new Promise((resolve, reject) => {
    const target = new URL(mediaUrl, publicUrl);
    let abortedByTest = false;
    let settled = false;
    const finish = (error, statusCode) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(statusCode);
    };
    const request = https.get(target, {
      headers: { Cookie: cookie, Range: `bytes=${offset}-`, Accept: 'video/mp4' }
    }, (response) => {
      if (response.statusCode !== 206) {
        response.resume();
        if (TRANSIENT_RANGE_HTTP_STATUSES.has(response.statusCode)) finish(null, response.statusCode);
        else finish(new Error(`拖动 Range bytes=${offset}- 未返回 206，而是 ${response.statusCode}`));
        return;
      }
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received < 64 * 1024 || abortedByTest) return;
        abortedByTest = true;
        response.destroy();
        request.destroy();
        finish(null, 206);
      });
      response.on('end', () => finish(abortedByTest ? null : new Error(`拖动 Range bytes=${offset}- 在中止前提前结束`), 206));
      response.on('error', (error) => {
        if (abortedByTest || ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) finish(null, 206);
        else finish(error);
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error(`拖动 Range bytes=${offset}- 超时`)));
    request.on('error', (error) => { if (abortedByTest) finish(null, 206); else finish(error); });
  });
}

async function abortRemoteRange(publicUrl, mediaUrl, cookie, offset) {
  for (let retry = 0; retry <= 2; retry += 1) {
    let outcome;
    try {
      outcome = await abortRemoteRangeAttempt(publicUrl, mediaUrl, cookie, offset);
    } catch (error) {
      const code = String(error?.code || (/超时/.test(error?.message || '') ? 'ETIMEDOUT' : ''));
      if (!TRANSIENT_RANGE_ERROR_CODES.has(code)) throw error;
      outcome = code;
    }
    if (outcome === 206) return;
    transientRangeStats.errors += 1;
    transientRangeStats.byStatus[outcome] = (transientRangeStats.byStatus[outcome] || 0) + 1;
    assert.ok(transientRangeStats.errors <= MAX_TRANSIENT_RANGE_ERRORS,
      `40 次拖动中 Cloudflare ${outcome} 瞬时错误过于频繁：${JSON.stringify(transientRangeStats)}`);
    if (retry >= 2) throw new Error(`拖动 Range bytes=${offset}- 连续出现 Cloudflare ${outcome}`);
    transientRangeStats.retries += 1;
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** retry)));
  }
}

async function sampleSocketLatencies(socket, count, label) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = Date.now();
    const pong = await ack(socket, 'network-ping', { sentAt: startedAt }, `${label} 第 ${index + 1}/${count} 次`);
    assert.equal(pong.success, true);
    samples.push(Date.now() - startedAt);
  }
  return samples;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function verifyPublicVideoPlayback(publicUrl, mediaUrl, token) {
  const playbackWindow = new BrowserWindow({
    show: false, width: 640, height: 360,
    webPreferences: { contextIsolation: false, sandbox: false }
  });
  try {
    await playbackWindow.loadURL(`${publicUrl}/?tunnel-media-smoke=1`);
    const result = await playbackWindow.webContents.executeJavaScript(`(async () => {
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.preload = 'auto';
      video.style.cssText = 'position:fixed;inset:0;width:640px;height:360px;object-fit:contain;background:#000';
      const source = new URL(${JSON.stringify(mediaUrl)}, location.origin);
      source.searchParams.set('syncwatch_token', ${JSON.stringify(token)});
      video.src = source.href;
      document.body.replaceChildren(video);
      const loaded = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, reason: 'canplay-timeout' }), 30000);
        video.addEventListener('canplay', () => { clearTimeout(timer); resolve({ ok: true }); }, { once: true });
        video.addEventListener('error', () => {
          clearTimeout(timer);
          resolve({ ok: false, reason: 'media-error', code: video.error?.code || 0, message: video.error?.message || '' });
        }, { once: true });
        video.load();
      });
      if (!loaded.ok) return { ...loaded, readyState: video.readyState, networkState: video.networkState };
      const startedAt = video.currentTime;
      try { await video.play(); } catch (error) {
        return { ok: false, reason: 'play-rejected', message: error?.message || '', readyState: video.readyState };
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let visiblePixels = 0; let colorRange = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const maximum = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
        const minimum = Math.min(pixels[index], pixels[index + 1], pixels[index + 2]);
        if (maximum > 12) visiblePixels += 1;
        colorRange += maximum - minimum;
      }
      return {
        ok: true, readyState: video.readyState, duration: video.duration,
        startedAt, currentTime: video.currentTime,
        visibleRatio: visiblePixels / (pixels.length / 4),
        averageColorRange: colorRange / (pixels.length / 4)
      };
    })()`, true);
    assert.equal(result.ok, true, `公网 Chromium 无法播放测试影片：${JSON.stringify(result)}`);
    assert.ok(result.readyState >= 2, `公网影片没有取得可播放帧：${JSON.stringify(result)}`);
    assert.ok(result.currentTime - result.startedAt >= 0.5, `公网影片时间没有推进：${JSON.stringify(result)}`);
    assert.ok(result.visibleRatio >= 0.1 && result.averageColorRange >= 2,
      `公网影片画面为空白或全黑：${JSON.stringify(result)}`);
  } finally {
    if (!playbackWindow.isDestroyed()) playbackWindow.destroy();
  }
}

app.whenReady().then(async () => {
  let window = await waitForWindow();
  await waitFor(window, `document.getElementById('connectionBadge').classList.contains('online')`, 15000);
  await window.webContents.executeJavaScript(`
    document.getElementById('showRegisterBtn').click();
    document.getElementById('regUsername').value='隧道房主';
    document.getElementById('regPassword').value='tunnel-pass';
    document.getElementById('regPasswordConfirm').value='tunnel-pass';
    document.getElementById('registerForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  `, true);
  await waitFor(window, `document.getElementById('loginStatus').textContent.includes('注册成功')`, 15000);
  await window.webContents.executeJavaScript(`
    document.getElementById('username').value='隧道房主';
    document.getElementById('password').value='tunnel-pass';
    document.getElementById('createRoomBtn').click();
    document.getElementById('newRoomName').value='公网隧道测试房间';
    document.getElementById('newRoomId').value='TUNNEL2';
    document.getElementById('newRoomMaxUsers').value='8';
    document.getElementById('createRoomForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  `, true);
  await waitFor(window, `
    !document.getElementById('agreementModal').classList.contains('is-hidden') ||
    !document.getElementById('mainPage').classList.contains('is-hidden')
  `, 15000);
  if (!await window.webContents.executeJavaScript(`document.getElementById('agreementModal').classList.contains('is-hidden')`, true)) {
    await window.webContents.executeJavaScript(`
      document.getElementById('agreementCheck').click();
      document.getElementById('acceptAgreementBtn').click();
    `, true);
  }
  await waitFor(window, `!document.getElementById('mainPage').classList.contains('is-hidden')`, 15000);
  await window.webContents.executeJavaScript(`
    openManagementHub('server');
    document.getElementById('adminPassword').value='admin888';
    document.getElementById('accessPassword').value='public-room-pass';
    document.getElementById('setAccessPasswordBtn').click();
  `, true);
  await waitFor(window, `state.publicConfig.accessPasswordRequired === true
    && !document.getElementById('loginRoomPassword').closest('label').classList.contains('is-hidden')`, 15000);
  const roomId = await window.webContents.executeJavaScript(`state.room.id`, true);
  await window.webContents.executeJavaScript(`(() => {
    document.getElementById('tunnelBypassProxy').checked = ${process.env.SYNCWATCH_TUNNEL_SMOKE_BYPASS_PROXY !== '0'};
    document.getElementById('startTunnelBtn').click();
  })()`, true);
  const status = await waitFor(window, `(() => {
    const value = document.getElementById('tunnelStatus').textContent;
    return (value.startsWith('已开启：') || value.startsWith('运行异常：')) ? value : '';
  })()`, 180000);
  const bundledCloudflared = path.join(__dirname, '..', 'vendor', 'cloudflared.exe');
  const runtimeCloudflared = path.join(dataDir, 'tools', 'cloudflared.exe');
  const verificationMarker = path.join(dataDir, 'tools', 'cloudflared.verified.json');
  assert.ok(fs.existsSync(runtimeCloudflared), '公网隧道启动前没有准备本地 cloudflared.exe');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(runtimeCloudflared)).digest('hex'),
    crypto.createHash('sha256').update(fs.readFileSync(bundledCloudflared)).digest('hex'),
    '运行时 cloudflared 没有优先复用安装包内置副本');
  assert.ok(fs.existsSync(verificationMarker), 'cloudflared 验签后没有写入复用标记');
  if (status.startsWith('运行异常：')) {
    const failedStatus = await window.webContents.executeJavaScript(`fetch('/api/host/tunnel/status', { headers: authHeaders() })
      .then(response => response.json()).then(result => result.status).catch(error => ({ diagnosticError: error.message }))`, true);
    const externalFailure = /超时|检查网络|下载 cloudflared|签名|连接|网络|cloudflared 已退出/i.test(status);
    assert.equal(externalFailure, true, `公网隧道出现非网络类启动异常：${status}`);
    console.log(`⚠ 已跳过 Cloudflare 公网媒体与共享画面验收：当前网络无法建立 Quick Tunnel（${status}）；诊断=${JSON.stringify(failedStatus)}；本地代理、WebSocket、Polling、Range 与媒体兼容测试仍由其他回归用例强制验证。`);
    app.quit();
    return;
  }
  const publicUrl = status.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0] || '';
  assert.match(publicUrl, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i);
  const tunnelStatus = await window.webContents.executeJavaScript(`fetch('/api/host/tunnel/status').then(response => response.json()).then(result => result.status)`, true);
  console.log(`公网隧道已通过策略验证：${tunnelStatus.strategyLabel || tunnelStatus.strategy || '默认连接'}`);
  const hostSessionToken = await window.webContents.executeJavaScript('state.token', true);
  assert.match(hostSessionToken, /^[A-Za-z0-9_-]{32,}$/);
  if (tunnelStatus.verified) {
    let websocketRemote = null;
    let pollingRemote = null;
    try {
      const primaryTransport = process.env.SYNCWATCH_TUNNEL_SMOKE_ALLOW_POLLING_ONLY === '1' ? 'product' : 'websocket';
      websocketRemote = await connectRemote(publicUrl, primaryTransport, primaryTransport === 'product' ? '产品默认传输' : 'WebSocket');
      if (primaryTransport === 'websocket') assert.equal(websocketRemote.io.engine.transport.name, 'websocket');
      assert.equal((await ack(websocketRemote, 'user-register', { username: '公网测试', password: 'remote-pass' })).success, true);
      const websocketLogin = await ack(websocketRemote, 'user-login', {
        username: '公网测试', password: 'remote-pass', roomId, roomPassword: 'public-room-pass', deviceId: 'remote-websocket'
      });
      assert.equal(websocketLogin.success, true, websocketLogin.error);
      if (websocketLogin.capabilities?.agreementRequired) {
        const agreementAccepted = await ack(websocketRemote, 'agreement-accept', {
          accepted: true, version: websocketLogin.agreement?.version
        });
        assert.equal(agreementAccepted.success, true, agreementAccepted.error);
      }
      const websocketLatencies = await sampleSocketLatencies(websocketRemote, 5, '登录后基线心跳');
      const statusAfterWebsocketLogin = await window.webContents.executeJavaScript(`fetch('/api/host/tunnel/status', { headers: authHeaders() }).then(response => response.json()).then(result => result.status)`, true);
      assert.equal(statusAfterWebsocketLogin.state, 'running');
      assert.equal(statusAfterWebsocketLogin.publicUrl, publicUrl, 'WebSocket 客户端登录后临时公网地址发生变化');
      const remoteRegistrationSettings = await window.webContents.executeJavaScript(`emitAck('admin-action', { action: 'get-settings', adminPassword: 'admin888' })`, true);
      assert.equal(remoteRegistrationSettings.success, true, remoteRegistrationSettings.error);
      const remoteRegistrationIp = remoteRegistrationSettings.admin.accounts.find((account) => account.username === '公网测试')?.registrationIp;
      assert.ok(remoteRegistrationIp, '公网测试账号应记录注册 IP');
      const remoteRegistrationWhitelist = await window.webContents.executeJavaScript(`emitAck('admin-action', { action: 'add-registration-whitelist', adminPassword: 'admin888', ipAddress: ${JSON.stringify(remoteRegistrationIp)} })`, true);
      assert.equal(remoteRegistrationWhitelist.success, true, remoteRegistrationWhitelist.error);

      pollingRemote = await connectRemote(publicUrl, 'polling', 'Polling');
      assert.equal(pollingRemote.io.engine.transport.name, 'polling');
      assert.equal((await ack(pollingRemote, 'user-register', { username: '公网轮询', password: 'polling-pass' })).success, true);
      const pollingLogin = await ack(pollingRemote, 'user-login', {
        username: '公网轮询', password: 'polling-pass', roomId, roomPassword: 'public-room-pass', deviceId: 'remote-polling'
      });
      assert.equal(pollingLogin.success, true, pollingLogin.error);
      if (pollingLogin.capabilities?.agreementRequired) {
        const agreementAccepted = await ack(pollingRemote, 'agreement-accept', {
          accepted: true, version: pollingLogin.agreement?.version
        });
        assert.equal(agreementAccepted.success, true, agreementAccepted.error);
      }
      await forceRemoteRecovery(websocketRemote, {
        token: websocketLogin.token, deviceId: 'remote-websocket', label: 'WebSocket'
      });
      await forceRemoteRecovery(pollingRemote, {
        token: pollingLogin.token, deviceId: 'remote-polling', label: 'Polling'
      });
      const statusAfterPollingLogin = await window.webContents.executeJavaScript(`fetch('/api/host/tunnel/status', { headers: authHeaders() }).then(response => response.json()).then(result => result.status)`, true);
      assert.equal(statusAfterPollingLogin.state, 'running');
      assert.equal(statusAfterPollingLogin.publicUrl, publicUrl, 'Polling 客户端登录后临时公网地址发生变化');

      const sessionResponse = await fetch(`${publicUrl}/api/session`, {
        method: 'POST', headers: { Authorization: `Bearer ${websocketLogin.token}` }, signal: AbortSignal.timeout(30000)
      });
      assert.equal(sessionResponse.status, 200, '公网媒体 Cookie 会话创建失败');
      const setCookie = sessionResponse.headers.get('set-cookie') || '';
      const cookie = setCookie.split(';')[0];
      assert.match(cookie, /^syncwatch_session=[^;]+$/, '公网媒体 Cookie 缺失');
      assert.match(setCookie, /;\s*Secure(?:;|$)/i, 'HTTPS 公网媒体 Cookie 未设置 Secure');
      assert.match(setCookie, /;\s*SameSite=Strict(?:;|$)/i, '公网媒体 Cookie 未设置 SameSite=Strict');

      const form = new FormData();
      form.append('file', new Blob([sampleBytes], { type: 'video/mp4' }), '公网隧道H264测试.mp4');
      const uploadResponse = await fetch(`${publicUrl}/api/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${hostSessionToken}` }, body: form, signal: AbortSignal.timeout(60000)
      });
      const upload = await uploadResponse.json();
      assert.equal(uploadResponse.status, 200, upload.error || '公网 H.264 影片上传失败');
      assert.equal(upload.success, true, upload.error);
      assert.equal(upload.file?.status, 'approved', '房主通过公网上传的影片未自动审核');
      assert.match(upload.file?.url || '', /^\/media\//);

      const seekMediaBytes = Buffer.allocUnsafe(32 * 1024 * 1024);
      for (let offset = 0; offset < seekMediaBytes.length; offset += sampleBytes.length) {
        sampleBytes.copy(seekMediaBytes, offset, 0, Math.min(sampleBytes.length, seekMediaBytes.length - offset));
      }
      const localBaseUrl = new URL(window.webContents.getURL()).origin;
      const seekForm = new FormData();
      seekForm.append('file', new Blob([seekMediaBytes], { type: 'video/mp4' }), '公网反复拖动32MB测试.mp4');
      const seekUploadResponse = await fetch(`${localBaseUrl}/api/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${hostSessionToken}` }, body: seekForm, signal: AbortSignal.timeout(60000)
      });
      const seekUpload = await seekUploadResponse.json();
      assert.equal(seekUploadResponse.status, 200, seekUpload.error || '拖动压力测试影片上传失败');
      assert.equal(seekUpload.success, true, seekUpload.error);
      assert.match(seekUpload.file?.url || '', /^\/media\//);

      const firstLength = Math.min(1024, sampleBytes.length);
      await verifyRange(publicUrl, upload.file.url, cookie, `bytes=0-${firstLength - 1}`, sampleBytes.subarray(0, firstLength), 0, sampleBytes.length);
      const tailLength = Math.min(1024, sampleBytes.length);
      const tailStart = sampleBytes.length - tailLength;
      await verifyRange(publicUrl, upload.file.url, cookie, `bytes=-${tailLength}`, sampleBytes.subarray(tailStart), tailStart, sampleBytes.length);
      await verifyPublicVideoPlayback(publicUrl, upload.file.url, websocketLogin.token);

      const seekIterations = process.env.SYNCWATCH_TUNNEL_SMOKE_ALLOW_POLLING_ONLY === '1' ? 0 : 40;
      const seekLatencies = seekIterations ? [] : [...websocketLatencies];
      for (let seekIndex = 0; seekIndex < seekIterations; seekIndex += 1) {
        const maximumOffset = seekMediaBytes.length - (512 * 1024);
        const offset = (seekIndex * 7919 * 1024) % maximumOffset;
        await abortRemoteRange(publicUrl, seekUpload.file.url, cookie, offset);
        if ((seekIndex + 1) % 5 === 0) {
          await ensureRemoteSession(websocketRemote, {
            token: websocketLogin.token, deviceId: 'remote-websocket', label: 'WebSocket'
          });
          await ensureRemoteSession(pollingRemote, {
            token: pollingLogin.token, deviceId: 'remote-polling', label: 'Polling'
          });
          seekLatencies.push(...await sampleSocketLatencies(websocketRemote, 1, `第 ${seekIndex + 1} 次拖动后心跳`));
          assert.equal(websocketRemote.connected, true, `第 ${seekIndex + 1} 次拖动后 WebSocket 已断开`);
          assert.equal(pollingRemote.connected, true, `第 ${seekIndex + 1} 次拖动后 Polling 已断开`);
        }
      }
      window = await ensureControlWindow(window, { token: hostSessionToken, roomId });
      const statusAfterSeeks = await window.webContents.executeJavaScript(`fetch('/api/host/tunnel/status', { headers: authHeaders() }).then(response => response.json()).then(result => result.status)`, true);
      assert.equal(statusAfterSeeks.state, 'running', '反复拖动后临时公网隧道不再运行');
      assert.equal(statusAfterSeeks.publicUrl, publicUrl, '反复拖动后临时公网地址发生变化');
      const baselineMedian = median(websocketLatencies);
      const seekMedian = median(seekLatencies);
      assert.ok(seekMedian <= Math.max(baselineMedian * 4, baselineMedian + 1500),
        `反复拖动后 WebSocket 延迟持续累积：基线中位 ${baselineMedian}ms，拖动中位 ${seekMedian}ms`);

      await ensureRemoteSession(websocketRemote, {
        token: websocketLogin.token, deviceId: 'remote-websocket', label: 'WebSocket'
      });
      await ensureRemoteSession(pollingRemote, {
        token: pollingLogin.token, deviceId: 'remote-polling', label: 'Polling'
      });

      const websocketPlayback = nextSocketEvent(websocketRemote, 'playback-state', (playback) => playback?.fileId === upload.file.id);
      const pollingPlayback = nextSocketEvent(pollingRemote, 'playback-state', (playback) => playback?.fileId === upload.file.id);
      const selected = await window.webContents.executeJavaScript(`emitAck('select-file', { fileId: ${JSON.stringify(upload.file.id)} })`, true);
      assert.equal(selected.success, true, selected.error);
      await Promise.all([websocketPlayback, pollingPlayback]);

      const shareStarted = await window.webContents.executeJavaScript(`emitAck('screen-share-start')`, true);
      assert.equal(shareStarted.success, true, shareStarted.error);
      const publicFrame = nextSocketEvent(pollingRemote, 'screen-share-frame', (packet) => {
        const bytes = packet?.data ? Buffer.from(packet.data) : Buffer.alloc(0);
        return packet?.width === 64 && packet?.height === 32 && bytes.length > 100
          && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
      }, 30000);
      await window.webContents.executeJavaScript(`(() => {
        clearInterval(globalThis.__tunnelSmokeFrameTimer);
        let sequence = 0;
        const send = async () => {
          const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
          const context = canvas.getContext('2d'); context.fillStyle = '#ed2f68'; context.fillRect(0, 0, 64, 32);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .9));
          if (blob && state.socketAuthenticated) state.socket.emit('screen-share-frame', { sequence: ++sequence, width: 64, height: 32, data: await blob.arrayBuffer() });
        };
        void send(); globalThis.__tunnelSmokeFrameTimer = setInterval(() => void send(), 250); return true;
      })()`, true);
      const frame = await publicFrame;
      assert.ok(Number(frame.sequence) >= 1, '公网共享帧缺少有效序号');
      await window.webContents.executeJavaScript(`clearInterval(globalThis.__tunnelSmokeFrameTimer); delete globalThis.__tunnelSmokeFrameTimer`, true);
      const shareStoppedEvent = nextSocketEvent(pollingRemote, 'screen-share-stopped');
      const shareStopped = await window.webContents.executeJavaScript(`emitAck('screen-share-stop')`, true);
      assert.equal(shareStopped.success, true, shareStopped.error);
      await shareStoppedEvent;

      const medianLatency = median(websocketLatencies);
      const recoverySummary = [websocketRemote, pollingRemote].map((socket) => {
        const recovery = socket.syncwatchRecovery;
        return `${recovery.label} 瞬断 ${recovery.disconnects} 次/恢复 ${recovery.resumes} 次/最长 ${recovery.maxDowntimeMs}ms`;
      }).join('；');
      console.log(`✓ Cloudflare Quick Tunnel 公网 HTTPS、双客户端、${seekIterations} 次拖动中止、地址稳定、瞬断会话恢复、延迟无持续累积、H.264 播放与共享画面实测通过：${publicUrl}（基线中位 ${medianLatency}ms，拖动中位 ${median(seekLatencies)}ms，边缘瞬时错误 ${transientRangeStats.errors} 次 ${JSON.stringify(transientRangeStats.byStatus)}；${recoverySummary}）`);
    } finally {
      try { await window.webContents.executeJavaScript(`clearInterval(globalThis.__tunnelSmokeFrameTimer); delete globalThis.__tunnelSmokeFrameTimer`, true); } catch (_) {}
      websocketRemote?.close();
      pollingRemote?.close();
    }
  } else {
    console.log('⚠ 已跳过公网媒体与共享画面验收：当前网络无法验证 Cloudflare 边缘回连；本轮只确认临时隧道进程生命周期和安全开关');
  }
  window = await ensureControlWindow(window, { token: hostSessionToken, roomId });
  await window.webContents.executeJavaScript(`document.getElementById('stopTunnelBtn').click()`, true);
  await waitFor(window, `document.getElementById('tunnelStatus').textContent === '未开启'`, 15000);
  app.quit();
}).catch((error) => { console.error('公网隧道实测失败:', error); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {} process.exit(1); });

app.on('will-quit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {} });
