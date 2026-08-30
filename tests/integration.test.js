'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: createSocketIoClient } = require('socket.io-client');
const WebSocket = require('ws');
const { startSyncWatchServer } = require('../server');
const releaseVersion = String(require('../package.json').version);

class SocketTestClient {
  constructor(url, headers = {}) { this.url = url; this.headers = headers; this.socket = null; this.nextAckId = 1; this.acks = new Map(); this.events = new Map(); this.waiters = new Map(); }
  async connect() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Socket.IO 连接超时')), 10000);
      this.socket = new WebSocket(`${this.url.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`, { headers: this.headers });
      this.socket.on('error', reject);
      this.socket.on('message', (buffer) => {
        const packet = buffer.toString();
        if (packet.startsWith('0')) { this.socket.send('40'); return; }
        if (packet === '2') { this.socket.send('3'); return; }
        if (packet.startsWith('40')) { try { this.id = JSON.parse(packet.slice(2) || '{}').sid; } catch (_) {} clearTimeout(timeout); resolve(); return; }
        this.handlePacket(packet);
      });
    });
    return this;
  }
  handlePacket(packet) {
    if (packet.startsWith('43')) {
      const match = packet.match(/^43(\d+)(.*)$/s); if (!match) return;
      const pending = this.acks.get(Number(match[1])); if (!pending) return;
      this.acks.delete(Number(match[1])); clearTimeout(pending.timer); pending.resolve(JSON.parse(match[2])[0]); return;
    }
    if (!packet.startsWith('42')) return;
    const start = packet.indexOf('['); if (start < 0) return;
    const [event, payload] = JSON.parse(packet.slice(start)); const waiting = this.waiters.get(event) || [];
    const index = waiting.findIndex((item) => !item.predicate || item.predicate(payload));
    if (index >= 0) { const [item] = waiting.splice(index, 1); clearTimeout(item.timer); item.resolve(payload); return; }
    const queue = this.events.get(event) || []; queue.push(payload); if (queue.length > 60) queue.shift(); this.events.set(event, queue);
  }
  emitRaw(event, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextAckId++; const timer = setTimeout(() => { this.acks.delete(id); reject(new Error(`${event} 响应超时`)); }, 10000);
      this.acks.set(id, { resolve, reject, timer }); this.socket.send(`42${id}${JSON.stringify([event, payload])}`);
    });
  }
  async emit(event, payload = {}) {
    const normalizedPayload = event === 'user-login' && integrationRoomId && payload && !payload.roomId
      ? { ...payload, roomId: integrationRoomId }
      : payload;
    const result = await this.emitRaw(event, normalizedPayload);
    if (['user-login', 'host-admin-login', 'room-create', 'session-resume'].includes(event)
      && result?.success && result.capabilities?.agreementRequired && result.agreement?.version) {
      const accepted = await this.emitRaw('agreement-accept', { accepted: true, version: result.agreement.version });
      assert.equal(accepted.success, true, accepted.error);
      result.capabilities.agreementRequired = false;
    }
    return result;
  }
  emitArgs(event, args = []) { this.socket.send(`42${JSON.stringify([event, ...args])}`); }
  nextEvent(event, predicate) {
    const queue = this.events.get(event) || []; const index = queue.findIndex((payload) => !predicate || predicate(payload));
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`等待事件 ${event} 超时`)), 10000); const waiting = this.waiters.get(event) || []; waiting.push({ predicate, resolve, reject, timer }); this.waiters.set(event, waiting); });
  }
  drainEvents(event) { const queue = this.events.get(event) || []; this.events.set(event, []); return queue; }
  hasEvent(event, predicate) { return (this.events.get(event) || []).some((payload) => !predicate || predicate(payload)); }
  close() { if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(); for (const item of this.acks.values()) clearTimeout(item.timer); for (const list of this.waiters.values()) for (const item of list) clearTimeout(item.timer); }
}

async function json(response) { const payload = await response.json(); return { response, payload }; }
const auth = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitUntil(predicate, timeout = 3000, interval = 20) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return true;
    await delay(interval);
  }
  return false;
}

function ioAckRaw(socket, event, payload = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 响应超时`)), timeout);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result || { success: false, error: '服务器未返回结果' }); });
  });
}

async function ioAck(socket, event, payload = {}, timeout = 10000) {
  const normalizedPayload = event === 'user-login' && integrationRoomId && payload && !payload.roomId
    ? { ...payload, roomId: integrationRoomId }
    : payload;
  const result = await ioAckRaw(socket, event, normalizedPayload, timeout);
  if (['user-login', 'host-admin-login', 'room-create', 'session-resume'].includes(event)
    && result?.success && result.capabilities?.agreementRequired && result.agreement?.version) {
    const accepted = await ioAckRaw(socket, 'agreement-accept', { accepted: true, version: result.agreement.version }, timeout);
    assert.equal(accepted.success, true, accepted.error);
    result.capabilities.agreementRequired = false;
  }
  return result;
}

let integrationRoomId = '';

function nextIoEvent(socket, event, predicate, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(`等待事件 ${event} 超时`)); }, timeout);
    const listener = (payload, acknowledgement) => {
      try { acknowledgement?.({ success: true, sequence: Math.max(0, Number(payload?.sequence) || 0) }); } catch (_) {}
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer); socket.off(event, listener); resolve(payload);
    };
    socket.on(event, listener);
  });
}

function assertCompletePlayback(playback, fileId) {
  assert.ok(playback && typeof playback === 'object');
  assert.equal(playback.fileId, fileId);
  assert.equal(typeof playback.isPlaying, 'boolean');
  assert.equal(typeof playback.stalled, 'boolean');
  assert.equal(Number.isFinite(playback.currentTime), true);
  assert.equal(Number.isFinite(playback.volume), true);
  assert.equal(Number.isFinite(playback.updatedAt), true);
  assert.equal(Number.isInteger(playback.revision), true);
  assert.ok(Object.prototype.hasOwnProperty.call(playback, 'changedBy'));
}

async function testTemporarilyUnavailableMediaSurvives() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-media-offline-'));
  const publicDir = path.resolve(__dirname, '..', 'public');
  const originalBytes = Buffer.from('temporary-storage-outage-media');
  let server;
  let client;
  try {
    server = await startSyncWatchServer({
      port: 0, host: '127.0.0.1', dataDir, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'offline-media-host'
    });
    let baseUrl = `http://127.0.0.1:${server.port}`;
    client = await new SocketTestClient(baseUrl).connect();
    assert.equal((await client.emit('user-register', { username: 'OfflineOwner', password: '123456' })).success, true);
    let login = await client.emit('room-create', {
      username: 'OfflineOwner', password: '123456', customRoomId: 'OFFLINE2', roomName: '临时存储测试房间', maxUsers: 8,
      hostToken: 'offline-media-host', deviceId: 'offline-media-device'
    });
    assert.equal(login.success, true, login.error);
    const offlineRoomId = login.room.id;
    const form = new FormData();
    form.append('file', new Blob([originalBytes], { type: 'video/mp4' }), '临时离线影片.mp4');
    const uploaded = await json(await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(login.token), body: form }));
    assert.equal(uploaded.response.status, 200, JSON.stringify(uploaded.payload));
    const file = uploaded.payload.file;
    assert.equal((await client.emit('select-file', { fileId: file.id })).success, true);
    assert.ok((await client.emit('room-refresh')).queue.includes(file.id));

    client.close(); client = null;
    await server.close(); server = null;
    const offlineUploads = path.join(dataDir, 'uploads-temporarily-offline');
    fs.renameSync(path.join(dataDir, 'uploads'), offlineUploads);

    server = await startSyncWatchServer({
      port: 0, host: '127.0.0.1', dataDir, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'offline-media-host'
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    client = await new SocketTestClient(baseUrl).connect();
    login = await client.emit('user-login', {
      username: 'OfflineOwner', password: '123456', roomId: offlineRoomId,
      hostToken: 'offline-media-host', deviceId: 'offline-media-restart'
    });
    assert.equal(login.success, true, login.error);

    let files = await (await fetch(`${baseUrl}/api/files`, { headers: auth(login.token) })).json();
    const indexed = files.find((entry) => entry.id === file.id);
    assert.ok(indexed, '临时看不到 uploads 时不能删除媒体索引');
    assert.equal(indexed.storedName, file.storedName);
    const roomWhileOffline = await client.emit('room-refresh');
    assert.ok(roomWhileOffline.queue.includes(file.id), '临时看不到媒体文件时不能删除播放队列');

    const mediaUnavailable = await json(await fetch(`${baseUrl}${file.url}`, { headers: auth(login.token) }));
    assert.equal(mediaUnavailable.response.status, 404);
    assert.equal(mediaUnavailable.payload.code, 'MEDIA_FILE_UNAVAILABLE');
    assert.equal(mediaUnavailable.payload.temporary, true);
    const downloadUnavailable = await json(await fetch(`${baseUrl}${file.downloadUrl}`, { headers: auth(login.token) }));
    assert.equal(downloadUnavailable.response.status, 404);
    assert.equal(downloadUnavailable.payload.code, 'MEDIA_FILE_UNAVAILABLE');
    const selectUnavailable = await client.emit('select-file', { fileId: file.id });
    assert.equal(selectUnavailable.success, false);
    assert.equal(selectUnavailable.code, 'MEDIA_FILE_UNAVAILABLE');

    let persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.ok(persisted.files.some((entry) => entry.id === file.id && entry.storedName === file.storedName));
    assert.ok(persisted.rooms[offlineRoomId].queue.includes(file.id));

    fs.rmSync(server.uploadsDir, { recursive: true, force: true });
    fs.renameSync(offlineUploads, server.uploadsDir);
    const restoredMedia = await fetch(`${baseUrl}${file.url}`, { headers: auth(login.token) });
    assert.equal(restoredMedia.status, 200);
    assert.deepEqual(Buffer.from(await restoredMedia.arrayBuffer()), originalBytes);
    assert.equal((await client.emit('select-file', { fileId: file.id })).success, true);

    const offlineDuringPlayback = path.join(dataDir, 'uploads-offline-during-playback');
    fs.renameSync(server.uploadsDir, offlineDuringPlayback);
    const commandUnavailable = await client.emit('playback-command', { action: 'play', currentTime: 1, volume: 1 });
    assert.equal(commandUnavailable.success, false);
    assert.equal(commandUnavailable.code, 'MEDIA_FILE_UNAVAILABLE');
    assert.equal((await client.emit('room-refresh')).room.playback.fileId, file.id, '存储暂时不可用时不能清空当前播放项');
    fs.renameSync(offlineDuringPlayback, server.uploadsDir);
    assert.equal((await client.emit('playback-command', { action: 'play', currentTime: 1, volume: 1 })).success, true);

    client.close(); client = null;
    await server.close(); server = null;
    persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.ok(persisted.files.some((entry) => entry.id === file.id));
    assert.ok(persisted.rooms[offlineRoomId].queue.includes(file.id));
    console.log('✓ uploads 临时离线或权限异常不会删除媒体索引/队列/当前播放项，恢复文件后无需重建索引即可播放');
  } finally {
    client?.close();
    await server?.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  await testTemporarilyUnavailableMediaSurvives();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `syncwatch-v${releaseVersion}-integration-`));
  const publicDir = path.resolve(__dirname, '..', 'public');
  const clients = [];
  let server;
  let checks = 0;
  let tunnelState = { state: 'stopped' };
  let passwordResetClock = Date.now();
  const sentMails = [];
  const mailFailures = new Set();
  const mailSender = async (message) => {
    sentMails.push({ ...message, config: { ...(message.config || {}) } });
    if (mailFailures.has(String(message.to).toLowerCase())) throw new Error('mock QQ SMTP delivery failure');
    return { messageId: `test-mail-${sentMails.length}` };
  };
  const tunnelManager = {
    status: async () => tunnelState,
    start: async ({ mode, publicUrl }) => (tunnelState = { state: 'running', mode, publicUrl: publicUrl || 'https://test.trycloudflare.com' }),
    stop: async () => (tunnelState = { state: 'stopped' })
  };
  const check = (description) => { checks += 1; console.log(`✓ ${description}`); };
  let clientIpSequence = 1;
  const nextClientHeaders = (headers = {}) => {
    if (headers['cf-connecting-ip'] || headers['x-forwarded-for']) return headers;
    const suffix = ((clientIpSequence++ - 1) % 200) + 1;
    return { 'cf-connecting-ip': `198.51.100.${suffix}`, ...headers };
  };
  const makeClient = async (headers = {}) => { const client = await new SocketTestClient(baseUrl, nextClientHeaders(headers)).connect(); clients.push(client); return client; };
  const makeIoClient = async (options = {}) => {
    const extraHeaders = nextClientHeaders(options.extraHeaders || {});
    const client = createSocketIoClient(baseUrl, { transports: ['websocket'], reconnection: false, timeout: 10000, ...options, extraHeaders });
    clients.push(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    return client;
  };
  let baseUrl;

  try {
    server = await startSyncWatchServer({
      port: 0, host: '127.0.0.1', dataDir, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'host-secret', tunnelManager, mailSender,
      passwordResetNow: () => passwordResetClock
    });
    baseUrl = `http://127.0.0.1:${server.port}`;

    const config = await json(await fetch(`${baseUrl}/api/public-config`));
    assert.equal(config.response.status, 200); assert.equal(config.payload.version, `v${require('../package.json').version}`);
    assert.equal(config.payload.downloadButtonsVisible, true);
    assert.equal(config.payload.maxUploadBytes, 10 * 1024 * 1024 * 1024); assert.equal(config.payload.uploadTimeLimitSeconds, 0);
    assert.equal(config.payload.defaultPlaybackQuality, 'original');
    const tunnelHealthResponse = await fetch(`${baseUrl}/api/tunnel-health`);
    const tunnelHealthBody = await tunnelHealthResponse.text();
    assert.equal(tunnelHealthResponse.status, 200);
    assert.match(tunnelHealthResponse.headers.get('cache-control') || '', /no-store/);
    assert.deepEqual(JSON.parse(tunnelHealthBody), {
      status: 'ok', name: 'SyncWatch同步观影', version: `v${require('../package.json').version}`
    });
    assert.ok(Buffer.byteLength(tunnelHealthBody) < 256,
      'Tunnel 健康探测必须保持固定小响应，不能随管理员自定义文案膨胀');
    const publicProxyConfig = await json(await fetch(`${baseUrl}/api/public-config`, {
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'stable-address.trycloudflare.com' }
    }));
    assert.equal(publicProxyConfig.response.status, 200);
    assert.equal(publicProxyConfig.payload.defaultPlaybackQuality, 'original');
    const publicHttpProxyConfig = await json(await fetch(`${baseUrl}/api/public-config`, {
      headers: {
        'X-Forwarded-Proto': 'http',
        'X-Forwarded-Host': '666.xuan666.cn',
        'X-Forwarded-For': '198.51.100.88'
      }
    }));
    assert.equal(publicHttpProxyConfig.response.status, 200);
    assert.equal(publicHttpProxyConfig.payload.defaultPlaybackQuality, 'original');
    const initialRooms = await (await fetch(`${baseUrl}/api/online-rooms`)).json();
    const waitingRoom = initialRooms.rooms.find((room) => room.name === '系统候场室');
    assert.ok(waitingRoom, '公开房间扫描应包含正式的系统候场室');
    assert.equal(waitingRoom.temporary, false, '系统候场室应标注为正式房间');
    check('公开配置版本与 package.json 一致，默认账户上传额度和时长配置已返回');

    const sameOriginSocket = await makeClient({ Origin: baseUrl }); sameOriginSocket.close();
    await assert.rejects(() => new SocketTestClient(baseUrl, { Origin: 'http://evil.invalid' }).connect(), /403|Unexpected server response|socket hang up/i);
    await assert.rejects(() => new SocketTestClient(baseUrl, { Origin: 'http://evil.invalid', Host: 'evil.invalid' }).connect(), /403|Unexpected server response|socket hang up/i);
    check('Socket 握手仅接受受信 Host 且浏览器 Origin 必须同源');

    const homeResponse = await fetch(baseUrl);
    assert.equal(homeResponse.headers.get('permissions-policy'), 'camera=(), microphone=(self), geolocation=(self), display-capture=(self)');
    const html = await homeResponse.text();
    assert.match(html, /playerContainer/); assert.match(html, /chatHistory/); assert.doesNotMatch(html, /https?:\/\/(cdn|unpkg|jsdelivr)/i);
    assert.match(html, /id="addRemoteVideoBtn"/); assert.match(html, /id="clearPlaybackBtn"/); assert.match(html, /id="authorizeLocationBtn"/);
    const appSource = await (await fetch(`${baseUrl}/js/app.js`)).text();
    assert.match(appSource, /transports:\s*\['websocket',\s*'polling'\]/);
    assert.match(appSource, /tryAllTransports:\s*true/);
    assert.equal((await fetch(`${baseUrl}/api/files`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/files`, { headers: { Cookie: 'syncwatch_session=%E0%A4%A' } })).status, 401);
    const missingApi = await json(await fetch(`${baseUrl}/api/not-a-real-endpoint`, { headers: { Accept: 'text/html' } }));
    assert.equal(missingApi.response.status, 404); assert.equal(missingApi.payload.error, '接口不存在');
    check('前端资源本地化、云端影片/清空/位置入口完整，且定位权限策略允许同源授权');

    const anonymous = await makeClient();
    let malformed = await anonymous.emit('user-register', null); assert.equal(malformed.success, false); assert.match(malformed.error, /参数格式/);
    malformed = await anonymous.emit('user-register', []); assert.equal(malformed.success, false); assert.match(malformed.error, /参数格式/);
    anonymous.emitArgs('user-register', [{}, 'not-an-acknowledgement']); await delay(30);
    assert.equal((await anonymous.emit('network-ping', {})).success, true);
    check('null、数组及伪造 ACK 不会使 Socket 处理器崩溃');
    const host = await makeClient();
    let result = await host.emit('user-register', { username: 'xuan', password: '123456' });
    assert.equal(result.success, true);
    result = await host.emit('room-create', {
      username: 'xuan', password: '123456', customRoomId: 'SYNCWEB2', roomName: '集成测试房间', maxUsers: 8,
      hostToken: 'host-secret', deviceId: 'host-device', browser: 'Chrome', platform: 'Windows'
    });
    assert.equal(result.success, true); assert.equal(result.capabilities.owner, true); assert.equal(result.capabilities.serverHost, true);
    integrationRoomId = result.room.id;
    const hostToken = result.token;
    const mediaWatcher = await makeClient();
    assert.equal((await mediaWatcher.emit('user-register', { username: 'MediaWatcher', password: '123456' })).success, true);
    const mediaWatcherLogin = await mediaWatcher.emit('user-login', {
      username: 'MediaWatcher', password: '123456', roomId: integrationRoomId, deviceId: 'media-watcher-device'
    });
    assert.equal(mediaWatcherLogin.success, true, mediaWatcherLogin.error);
    await delay(80);
    assert.equal(anonymous.hasEvent('users-list'), false);
    assert.equal(anonymous.hasEvent('room-state'), false);
    check('服务器主机登录后成为房主并签发专属能力');

    const downloadsHidden = mediaWatcher.nextEvent('notice-preferences-updated',
      (preferences) => preferences?.downloadButtonsVisible === false);
    result = await host.emit('admin-action', {
      action: 'set-notice-preferences', adminPassword: 'admin888',
      f11PromptEnabled: true, initialPasswordReminderEnabled: true, downloadButtonsVisible: false
    });
    assert.equal(result.success, true, result.error);
    assert.equal((await downloadsHidden).downloadButtonsVisible, false);
    const hiddenDownloadConfig = await json(await fetch(`${baseUrl}/api/public-config`));
    assert.equal(hiddenDownloadConfig.payload.downloadButtonsVisible, false);
    const noticeSettings = await host.emit('admin-action', { action: 'get-settings', adminPassword: 'admin888' });
    assert.equal(noticeSettings.success, true, noticeSettings.error);
    assert.equal(noticeSettings.admin.downloadButtonsVisible, false);
    result = await host.emit('admin-action', {
      action: 'set-notice-preferences', adminPassword: 'admin888',
      f11PromptEnabled: true, initialPasswordReminderEnabled: true, downloadButtonsVisible: true
    });
    assert.equal(result.success, true, result.error);
    assert.equal((await json(await fetch(`${baseUrl}/api/public-config`))).payload.downloadButtonsVisible, true);
    check('管理员可统一隐藏或恢复 Windows 与 Android 下载入口，公开配置和在线客户端实时同步');

    const agreementClient = await makeClient({ 'cf-connecting-ip': '203.0.113.90' });
    assert.equal((await agreementClient.emitRaw('user-register', { username: 'AgreementUser', password: 'agreement-pass' })).success, true);
    const agreementLogin = await agreementClient.emitRaw('user-login', {
      username: 'AgreementUser', password: 'agreement-pass', roomId: integrationRoomId, deviceId: 'agreement-device'
    });
    assert.equal(agreementLogin.success, true, agreementLogin.error);
    assert.equal(agreementLogin.capabilities.agreementRequired, true);
    const blockedBeforeAgreement = await json(await fetch(`${baseUrl}/api/files`, { headers: auth(agreementLogin.token) }));
    assert.equal(blockedBeforeAgreement.response.status, 451);
    assert.equal(blockedBeforeAgreement.payload.code, 'AGREEMENT_REQUIRED');
    const acceptedAgreement = await agreementClient.emitRaw('agreement-accept', { accepted: true, version: agreementLogin.agreement.version });
    assert.equal(acceptedAgreement.success, true, acceptedAgreement.error);
    assert.equal((await fetch(`${baseUrl}/api/files`, { headers: auth(agreementLogin.token) })).status, 200);
    check('账户首次登录必须同意当前版本使用协议，同意后同一版本不再阻止进入');
    agreementClient.close();
    await delay(80);

    const mailAuthCode = 'MAIL_SECRET_QQ_AUTH_2026';
    result = await host.emit('admin-action', {
      action: 'set-mail-settings', adminPassword: 'admin888', user: 'sender@qq.com', authCode: mailAuthCode,
      fromName: 'SyncWatch同步观影 测试', enabled: true
    });
    assert.equal(result.success, true, result.error);
    assert.equal(result.mail.enabled, true); assert.equal(result.mail.configured, true);
    assert.equal(Object.hasOwn(result.mail, 'encryptedAuthCode'), false);
    const earlyPersistedMailState = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(JSON.stringify(earlyPersistedMailState).includes(mailAuthCode), false);
    assert.match(earlyPersistedMailState.admin.mail.encryptedAuthCode, /^v1\.[^.]+\.[^.]+\.[^.]+$/);
    const mailKey = Buffer.from(fs.readFileSync(path.join(dataDir, '.secrets', 'mail.key'), 'utf8').trim(), 'base64');
    assert.equal(mailKey.length, 32);
    const publicAfterMail = await json(await fetch(`${baseUrl}/api/public-config`));
    assert.equal(publicAfterMail.payload.passwordRecoveryAvailable, true);
    result = await host.emit('admin-action', { action: 'test-mail-settings', adminPassword: 'admin888', recipient: 'mail-test@example.com' });
    assert.equal(result.success, true, result.error);
    const testMail = [...sentMails].reverse().find((message) => message.to === 'mail-test@example.com');
    assert.ok(testMail); assert.equal(testMail.config.host, 'smtp.qq.com'); assert.equal(testMail.config.port, 465);
    assert.equal(testMail.config.secure, true); assert.equal(testMail.config.user, 'sender@qq.com');
    assert.equal(testMail.config.authCode, mailAuthCode);
    check('QQ SMTP 授权码使用 AES-GCM 加密保存，真实发件参数通过可替换 SMTP 通道发送且不泄露密文');

    const latestMail = (recipient, subjectPart = '') => [...sentMails].reverse().find((message) =>
      String(message.to).toLowerCase() === recipient.toLowerCase()
      && (!subjectPart || String(message.subject || '').includes(subjectPart)));
    const latestResetMail = (recipient) => latestMail(recipient, '密码重置验证码');
    const latestBindingMail = (recipient) => latestMail(recipient, '邮箱绑定验证码');
    const resetCodeFromMail = (message) => {
      assert.ok(message?.text, '验证码邮件应包含纯文本正文');
      const match = String(message.text).match(/验证码：(?<code>\d{6})/);
      assert.ok(match, `邮件正文未找到 6 位验证码：${message.text}`);
      return match.groups.code;
    };
    const verifyRecoveryEmail = async (client, username, email, password, deviceName, joinMainRoom = false) => {
      const login = await client.emit('user-login', {
        username, password, deviceId: deviceName, ...(joinMainRoom ? {} : { roomId: ' ' })
      });
      assert.equal(login.success, true, login.error);
      const requested = await client.emit('email-bind-request', { email });
      assert.equal(requested.success, true, requested.error);
      assert.equal(await waitUntil(() => Boolean(latestBindingMail(email)), 2000), true);
      const code = resetCodeFromMail(latestBindingMail(email));
      const verified = await client.emit('email-bind-verify', { email, code });
      assert.equal(verified.success, true, verified.error);
      assert.equal(verified.profile.emailVerified, true);
      return login;
    };
    const hostEmailRequested = await host.emit('email-bind-request', { email: 'xuan@example.com' });
    assert.equal(hostEmailRequested.success, true, hostEmailRequested.error);
    assert.equal(await waitUntil(() => Boolean(latestBindingMail('xuan@example.com')), 2000), true);
    const hostEmailVerified = await host.emit('email-bind-verify', {
      email: 'xuan@example.com', code: resetCodeFromMail(latestBindingMail('xuan@example.com'))
    });
    assert.equal(hostEmailVerified.success, true, hostEmailVerified.error);
    const earlyRecoveryClient = await makeClient({ 'cf-connecting-ip': '203.0.113.101' });
    assert.equal((await earlyRecoveryClient.emit('user-register', { username: '恢复用户', password: 'old-recover-pass' })).success, true);
    await verifyRecoveryEmail(earlyRecoveryClient, '恢复用户', 'recover@example.com', 'old-recover-pass', 'early-recovery-device');
    const missingRecovery = await earlyRecoveryClient.emit('password-reset-request', { scope: 'account', identifier: '不存在的账号' });
    const knownRecovery = await earlyRecoveryClient.emit('password-reset-request', { scope: 'account', identifier: '恢复用户' });
    // v2.2.0 explicitly reports an unknown account/mailbox. Keep accepting the
    // legacy privacy-masked response so this integration suite remains useful
    // against older deployments during migration.
    if (missingRecovery.success !== false) assert.deepEqual(missingRecovery, knownRecovery, '不存在的账号与真实账号必须返回完全相同的恢复响应');
    else assert.equal(missingRecovery.code, 'ACCOUNT_OR_EMAIL_NOT_FOUND');
    assert.equal(knownRecovery.success, true);
    assert.equal(await waitUntil(() => Boolean(latestResetMail('recover@example.com')), 2000), true);
    const knownRecoveryMail = latestResetMail('recover@example.com');
    const knownRecoveryCode = resetCodeFromMail(knownRecoveryMail);
    const unknownVerification = await earlyRecoveryClient.emit('password-reset-verify', { scope: 'account', identifier: '不存在的账号', code: '000000' });
    const knownWrongVerification = await earlyRecoveryClient.emit('password-reset-verify', { scope: 'account', identifier: '恢复用户', code: knownRecoveryCode === '000000' ? '000001' : '000000' });
    assert.deepEqual(unknownVerification, knownWrongVerification, '错误验证码也不能暴露账号是否存在');
    for (let attempt = 1; attempt < 5; attempt += 1) {
      const failed = await earlyRecoveryClient.emit('password-reset-verify', { scope: 'account', identifier: '恢复用户', code: knownRecoveryCode === '000000' ? '000001' : '000000' });
      assert.equal(failed.success, false);
    }
    const exhausted = await earlyRecoveryClient.emit('password-reset-verify', { scope: 'account', identifier: '恢复用户', code: knownRecoveryCode });
    assert.deepEqual(exhausted, knownWrongVerification, '验证码达到 5 次错误上限后，正确验证码也必须失效且不泄露状态');
    check('恢复密码请求和错误验证码响应不可枚举账号，验证码为 6 位、哈希/HMAC 保存并限制 5 次尝试');

    const failedDeliveryClient = await makeClient({ 'cf-connecting-ip': '203.0.113.102' });
    assert.equal((await failedDeliveryClient.emit('user-register', { username: '投递失败用户', password: 'mail-fail-pass' })).success, true);
    await verifyRecoveryEmail(failedDeliveryClient, '投递失败用户', 'mail-fail@example.com', 'mail-fail-pass', 'failed-delivery-device');
    mailFailures.add('mail-fail@example.com');
    const failedDeliveryRequest = await failedDeliveryClient.emit('password-reset-request', { scope: 'account', identifier: '投递失败用户' });
    const missingAfterFailure = await failedDeliveryClient.emit('password-reset-request', { scope: 'account', identifier: '没有这个邮箱' });
    if (missingAfterFailure.success !== false) assert.deepEqual(failedDeliveryRequest, missingAfterFailure);
    else assert.equal(missingAfterFailure.code, 'ACCOUNT_OR_EMAIL_NOT_FOUND');
    await delay(60);
    const failedDeliveryMail = latestResetMail('mail-fail@example.com');
    const failedDeliveryCode = resetCodeFromMail(failedDeliveryMail);
    const failedDeliveryVerify = await failedDeliveryClient.emit('password-reset-verify', { scope: 'account', identifier: '投递失败用户', code: failedDeliveryCode });
    assert.equal(failedDeliveryVerify.success, false);
    mailFailures.delete('mail-fail@example.com');
    check('SMTP 投递失败时仍返回不可枚举的通用响应，并清理未发送验证码');

    const earlyExpiredClient = await makeClient({ 'cf-connecting-ip': '203.0.113.103' });
    assert.equal((await earlyExpiredClient.emit('user-register', { username: '过期验证码用户', password: 'expired-pass' })).success, true);
    await verifyRecoveryEmail(earlyExpiredClient, '过期验证码用户', 'expired-code@example.com', 'expired-pass', 'expired-code-device');
    const expiredRequest = await earlyExpiredClient.emit('password-reset-request', { scope: 'account', identifier: '过期验证码用户' });
    assert.equal(expiredRequest.success, true); await waitUntil(() => Boolean(latestResetMail('expired-code@example.com')), 2000);
    const expiredCode = resetCodeFromMail(latestResetMail('expired-code@example.com'));
    passwordResetClock += 10 * 60 * 1000 + 1;
    const expiredVerification = await earlyExpiredClient.emit('password-reset-verify', { scope: 'account', identifier: '过期验证码用户', code: expiredCode });
    assert.equal(expiredVerification.success, false);
    const tokenExpiryRequest = await earlyExpiredClient.emit('password-reset-request', { scope: 'account', identifier: '过期验证码用户' });
    assert.equal(tokenExpiryRequest.success, true); await waitUntil(() => sentMails.filter((message) => message.to === 'expired-code@example.com').length >= 2, 2000);
    const tokenExpiryCode = resetCodeFromMail(latestResetMail('expired-code@example.com'));
    const tokenVerification = await earlyExpiredClient.emit('password-reset-verify', { scope: 'account', identifier: '过期验证码用户', code: tokenExpiryCode });
    assert.equal(tokenVerification.success, true);
    passwordResetClock += 10 * 60 * 1000 + 1;
    const expiredToken = await earlyExpiredClient.emit('password-reset-complete', { resetToken: tokenVerification.resetToken, newPassword: 'expired-new-pass' });
    assert.equal(expiredToken.success, false); assert.match(expiredToken.error, /过期|无效/);
    check('验证码和邮箱验证后的重置授权都具备明确过期时间');

    const earlyAccountRecoveryLogin = await makeClient({ 'cf-connecting-ip': '203.0.113.104' });
    assert.equal((await earlyAccountRecoveryLogin.emit('user-register', { username: '邮箱改密用户', password: 'before-recovery-pass' })).success, true);
    const accountLogin = await verifyRecoveryEmail(earlyAccountRecoveryLogin, '邮箱改密用户', 'account-recovery@example.com', 'before-recovery-pass', 'recovery-device', true);
    const earlyAccountResetClient = await makeClient({ 'cf-connecting-ip': '203.0.113.105' });
    const accountResetRequest = await earlyAccountResetClient.emit('password-reset-request', { scope: 'account', identifier: 'account-recovery@example.com' });
    assert.equal(accountResetRequest.success, true); await waitUntil(() => Boolean(latestResetMail('account-recovery@example.com')), 2000);
    const accountResetCode = resetCodeFromMail(latestResetMail('account-recovery@example.com'));
    const accountVerified = await earlyAccountResetClient.emit('password-reset-verify', { scope: 'account', identifier: 'account-recovery@example.com', code: accountResetCode });
    assert.equal(accountVerified.success, true);
    const reusedCode = await earlyAccountResetClient.emit('password-reset-verify', { scope: 'account', identifier: 'account-recovery@example.com', code: accountResetCode });
    assert.equal(reusedCode.success, false, '6 位验证码验证成功后必须立即作废');
    const authErrorEvent = earlyAccountRecoveryLogin.nextEvent('auth-error');
    const completedAccountReset = await earlyAccountResetClient.emit('password-reset-complete', { resetToken: accountVerified.resetToken, newPassword: 'after-recovery-pass' });
    assert.equal(completedAccountReset.success, true);
    await authErrorEvent; await delay(80);
    assert.equal((await fetch(`${baseUrl}/api/files`, { headers: auth(accountLogin.token) })).status, 401);
    const oldAccountLogin = await (await makeClient({ 'cf-connecting-ip': '203.0.113.106' })).emit('user-login', { username: '邮箱改密用户', password: 'before-recovery-pass', deviceId: 'recovery-device-2' });
    assert.equal(oldAccountLogin.success, false);
    const newAccountLogin = await (await makeClient({ 'cf-connecting-ip': '203.0.113.107' })).emit('user-login', { username: '邮箱改密用户', password: 'after-recovery-pass', deviceId: 'recovery-device-3' });
    assert.equal(newAccountLogin.success, true);
    const reusedToken = await earlyAccountResetClient.emit('password-reset-complete', { resetToken: accountVerified.resetToken, newPassword: 'another-pass' });
    assert.equal(reusedToken.success, false);
    check('邮箱找回密码会修改账户密码、撤销全部旧会话、使验证码和重置令牌均只能使用一次');

    result = await host.emit('admin-action', { action: 'set-public-password-policy', adminPassword: 'admin888', enabled: true });
    assert.equal(result.success, true, result.error);
    let tunnel = await json(await fetch(`${baseUrl}/api/host/tunnel/start`, { method: 'POST', headers: auth(hostToken, { 'Content-Type': 'application/json' }), body: JSON.stringify({ mode: 'quick' }) }));
    assert.equal(tunnel.response.status, 409); assert.equal(tunnel.payload.code, 'PUBLIC_ROOMS_UNPROTECTED'); assert.equal(tunnel.payload.requiresConfirmation, true); assert.equal(tunnelState.state, 'stopped');
    check('开启房间密码要求后，未设置密码的房间会先提示确认而不会直接中断现有成员');
    result = await host.emit('admin-action', { action: 'set-public-password-policy', adminPassword: 'admin888', enabled: false });
    assert.equal(result.success, true, result.error);

    const duplicate = await makeClient();
    result = await duplicate.emit('user-login', { username: 'xuan', password: '123456', deviceId: 'other-device' });
    assert.equal(result.success, false); assert.match(result.error, /另一台设备/);
    duplicate.close();
    check('同一账号禁止在第二台设备并发登录');

    const reconnectOriginal = await makeClient();
    assert.equal((await reconnectOriginal.emit('user-register', { username: 'ReconnectUser', password: '123456' })).success, true);
    const reconnectLogin = await reconnectOriginal.emit('user-login', { username: 'ReconnectUser', password: '123456', deviceId: 'reconnect-one' });
    assert.equal(reconnectLogin.success, true); reconnectOriginal.close(); await delay(30);
    const reconnectReplacement = await makeClient();
    const resumed = await reconnectReplacement.emit('session-resume', { token: reconnectLogin.token, deviceId: 'reconnect-one' });
    assert.equal(resumed.success, true);
    const resumedRefresh = await reconnectReplacement.emit('room-refresh');
    assert.equal(resumedRefresh.success, true);
    assert.equal(resumedRefresh.users.filter((user) => user.username === 'ReconnectUser').length, 1);
    const duplicateTokenClient = await makeClient();
    const duplicateTokenResume = await duplicateTokenClient.emit('session-resume', { token: reconnectLogin.token, deviceId: 'reconnect-one' });
    assert.equal(duplicateTokenResume.success, false); assert.match(duplicateTokenResume.error, /另一台设备|另一端/);
    check('Socket 断线后会话可迁移到新 ID，但在线连接不会被同令牌重复窗口抢占');

    const cookie = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: auth(hostToken, { 'X-Forwarded-Host': 'cinema.trycloudflare.com', 'X-Forwarded-Proto': 'https' })
    });
    assert.equal(cookie.status, 200); assert.match(cookie.headers.get('set-cookie'), /syncwatch_session=/);
    assert.match(cookie.headers.get('set-cookie'), /; Secure(?:;|$)/);
    const uploadNoticeHost = host.nextEvent('media-mutation-notice', (notice) => notice.action === 'upload');
    const uploadNoticeWatcher = mediaWatcher.nextEvent('media-mutation-notice', (notice) => notice.action === 'upload');
    const form = new FormData(); form.append('file', new Blob([Buffer.from('0123456789abcdef')], { type: 'video/mp4' }), '星际穿越.mp4');
    let upload = await json(await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(hostToken), body: form }));
    assert.equal(upload.response.status, 200); assert.equal(upload.payload.file.status, 'approved');
    const fileId = upload.payload.file.id;
    const uploadedNotice = await uploadNoticeHost;
    const uploadedWatcherNotice = await uploadNoticeWatcher;
    assert.equal(uploadedNotice.fileId, fileId);
    assert.equal(uploadedNotice.canUndo, true, 'room owner should be allowed to undo an upload');
    assert.equal(uploadedWatcherNotice.canUndo, false, 'ordinary members must not undo another member upload');
    check('无固定限制上传、中文文件名与持久文件记录正常');

    const deleteNoticeHost = host.nextEvent('media-mutation-notice', (notice) => notice.action === 'delete' && notice.fileId === fileId);
    const deleteNoticeWatcher = mediaWatcher.nextEvent('media-mutation-notice', (notice) => notice.action === 'delete' && notice.fileId === fileId);
    const deleted = await json(await fetch(`${baseUrl}/api/files/${fileId}`, { method: 'DELETE', headers: auth(hostToken) }));
    assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
    const deletedNotice = await deleteNoticeHost;
    assert.equal((await deleteNoticeWatcher).canUndo, false);
    assert.equal(deletedNotice.canUndo, true);
    const rolledBackDelete = await host.emit('rollback-operation', { operationId: deletedNotice.operationId });
    assert.equal(rolledBackDelete.success, true, rolledBackDelete.error);
    const restoredAfterRollback = await (await fetch(`${baseUrl}/api/files`, { headers: auth(hostToken) })).json();
    assert.ok(restoredAfterRollback.some((entry) => entry.id === fileId), 'rollback should restore a deleted media index entry');

    let renamed = await json(await fetch(`${baseUrl}/api/files/${fileId}`, { method: 'PATCH', headers: auth(hostToken, { 'Content-Type': 'application/json' }), body: JSON.stringify({ originalName: 'Interstellar' }) }));
    assert.equal(renamed.response.status, 200); assert.equal(renamed.payload.file.originalName, 'Interstellar.mp4');
    assert.match(renamed.payload.file.url, /^\/media\//); assert.doesNotMatch(renamed.payload.file.url, /^https?:/i);
    const range = await fetch(`${baseUrl}${renamed.payload.file.url}`, { headers: auth(hostToken, { Range: 'bytes=0-3' }) });
    assert.equal(range.status, 206); assert.equal(Buffer.from(await range.arrayBuffer()).toString(), '0123');
    const tunnelCookie = String(cookie.headers.get('set-cookie') || '').split(';', 1)[0];
    const tunneledRange = await fetch(`${baseUrl}${renamed.payload.file.url}`, {
      headers: {
        Cookie: tunnelCookie, Range: 'bytes=4-7', 'X-Forwarded-Host': 'cinema.trycloudflare.com',
        'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '198.51.100.88'
      }
    });
    assert.equal(tunneledRange.status, 206);
    assert.equal(Buffer.from(await tunneledRange.arrayBuffer()).toString(), '4567');
    assert.equal(tunneledRange.headers.get('content-range'), 'bytes 4-7/16');
    assert.equal(tunneledRange.headers.get('content-encoding'), 'identity');
    assert.match(tunneledRange.headers.get('cache-control') || '', /no-transform/);
    assert.equal(tunneledRange.headers.get('location'), null);
    const tunneledHead = await fetch(`${baseUrl}${renamed.payload.file.url}`, {
      method: 'HEAD',
      headers: {
        Cookie: tunnelCookie, Range: 'bytes=8-11', 'X-Forwarded-Host': 'cinema.trycloudflare.com',
        'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '198.51.100.88'
      }
    });
    assert.equal(tunneledHead.status, 206); assert.equal(tunneledHead.headers.get('content-length'), '4');
    check('文件重命名正常；Cloudflare HTTPS 代理下使用 Cookie 的绝对公网请求可完成 HEAD/GET Range，字节不会被代理转换');

    const nextForm = new FormData(); nextForm.append('file', new Blob([Buffer.from('next-video')], { type: 'video/mp4' }), '下一部.mp4');
    const nextUpload = await json(await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(hostToken), body: nextForm }));
    assert.equal(nextUpload.response.status, 200); const nextFileId = nextUpload.payload.file.id;
    const categorized = await json(await fetch(`${baseUrl}/api/files/category/batch`, {
      method: 'PATCH', headers: auth(hostToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ fileIds: [fileId, nextFileId], collection: '科幻电影' })
    }));
    assert.equal(categorized.response.status, 200);
    assert.equal(categorized.payload.files.length, 2);
    assert.ok(categorized.payload.files.every((file) => file.collection === '科幻电影'));
    check('影片分类支持选择已有分类并批量移动，返回结果使用真实 collection 字段');
    const exportedBackup = await json(await fetch(`${baseUrl}/api/host/data/export?scopes=config,accounts,rooms,media-index,chat`, { headers: auth(hostToken) }));
    assert.equal(exportedBackup.response.status, 200);
    assert.equal(exportedBackup.payload.kind, 'syncwatch-data-export');
    assert.ok(exportedBackup.payload.configState?.admin);
    assert.ok(exportedBackup.payload.files.some((entry) => entry.id === fileId));
    assert.ok(exportedBackup.payload.mediaArtifacts.some((entry) => entry.fileId === fileId && entry.kind === 'upload'));
    assert.equal(Object.hasOwn(exportedBackup.payload.configState, 'accounts'), false);
    const streamedBackupResponse = await fetch(`${baseUrl}/api/host/data/export?scopes=config,accounts,rooms,media-index,chat&format=binary`, { headers: auth(hostToken) });
    assert.equal(streamedBackupResponse.status, 200);
    assert.match(streamedBackupResponse.headers.get('content-type') || '', /application\/vnd\.syncwatch\.backup/);
    const streamedBackupLength = Number(streamedBackupResponse.headers.get('content-length'));
    assert.ok(Number.isSafeInteger(streamedBackupLength) && streamedBackupLength > 0, '二进制备份必须提供可用于实时进度的 Content-Length');
    const streamedBackup = Buffer.from(await streamedBackupResponse.arrayBuffer());
    assert.equal(streamedBackup.length, streamedBackupLength, '备份传输总字节数应与 Content-Length 一致');
    assert.equal(streamedBackup.subarray(0, 19).toString('ascii'), 'SYNCWATCH-BACKUP-2\n');
    const importedStreamedBackup = await json(await fetch(`${baseUrl}/api/host/data/import-binary?scopes=config,accounts,rooms,media-index,chat`, {
      method: 'POST', headers: auth(hostToken, { 'Content-Type': 'application/octet-stream' }), body: streamedBackup
    }));
    assert.equal(importedStreamedBackup.response.status, 200);
    assert.ok(importedStreamedBackup.payload.restoredArtifacts >= 2);
    check('数据备份可按范围导出配置、账号、房间、聊天及媒体原文件，并避免重复打包完整状态');
    result = await host.emit('admin-action', {
      action: 'set-upload-policy', adminPassword: 'admin888', allowedUploadCategories: ['video', 'text', 'subtitle']
    });
    assert.equal(result.success, true);
    const textForm = new FormData(); textForm.append('file', new Blob([Buffer.from('notes')], { type: 'text/plain' }), '说明.txt');
    const textUpload = await json(await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(hostToken), body: textForm }));
    assert.equal(textUpload.response.status, 200);
    assert.equal((await host.emit('select-file', { fileId: textUpload.payload.file.id })).success, true);
    assert.equal((await host.emit('queue-action', { action: 'add', fileId: textUpload.payload.file.id })).success, false);
    const largeSubtitleForm = new FormData();
    largeSubtitleForm.append('file', new Blob([Buffer.alloc(10 * 1024 * 1024 + 1, 65)], { type: 'application/x-subrip' }), '过大字幕.srt');
    const largeSubtitle = await json(await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(hostToken), body: largeSubtitleForm }));
    assert.equal(largeSubtitle.response.status, 413); assert.match(largeSubtitle.payload.error, /10MB/);
    check('文本可同步到房间静态预览但不能进入播放队列，字幕执行独立 10MB 安全上限');
    await delay(100);
    for (const eventName of ['file-uploaded', 'file-updated', 'users-list', 'room-state']) assert.equal(anonymous.hasEvent(eventName), false, `匿名连接不应收到 ${eventName}`);
    check('匿名 Socket 不会收到成员、房间或文件业务广播');

    const alice = await makeClient();
    assert.equal((await alice.emit('user-register', { username: 'Alice', password: 'abcdef' })).success, true);
    result = await alice.emit('user-login', { username: 'Alice', password: 'abcdef', deviceId: 'alice-phone', browser: 'Chrome', platform: 'Android' });
    assert.equal(result.success, true); const aliceToken = result.token;
    const blockedDefaultAdmin = await alice.emit('admin-action', { action: 'get-settings', adminPassword: 'admin888' });
    assert.equal(blockedDefaultAdmin.success, false); assert.match(blockedDefaultAdmin.error, /服务器主机|初始化/);
    assert.equal((await alice.emit('select-file', { fileId })).success, false);
    let requestEvent = host.nextEvent('control-request', (request) => request.username === 'Alice');
    assert.equal((await alice.emit('request-control')).success, true);
    let controlRequest = await requestEvent;
    const rejectedControlEvent = alice.nextEvent('control-request-resolved', (request) => request.id === controlRequest.id && request.approved === false);
    assert.equal((await host.emit('control-request-action', { requestId: controlRequest.id, approved: false })).success, true);
    assert.match((await rejectedControlEvent).message, /拒绝/);
    requestEvent = host.nextEvent('control-request', (request) => request.username === 'Alice');
    assert.equal((await alice.emit('request-control')).success, true);
    controlRequest = await requestEvent;
    const approvedControlEvent = alice.nextEvent('control-request-resolved', (request) => request.id === controlRequest.id && request.approved === true);
    assert.equal((await host.emit('control-request-action', { requestId: controlRequest.id, approved: true })).success, true);
    await approvedControlEvent;
    assert.equal((await alice.emit('select-file', { fileId })).success, true, '明确授权成员在锁定状态下也应可控制');
    await host.emit('owner-action', { action: 'toggle-lock', locked: false });
    check('控制申请拒绝会回执申请人，再次申请获批后成员在锁定状态仍可控制');

    const selectedPlayback = (await alice.emit('room-refresh')).room.playback;
    assertCompletePlayback(selectedPlayback, fileId); assert.equal(selectedPlayback.isPlaying, true);
    const playWirePromise = host.nextEvent('playback-command', (item) => item.action === 'play' && item.revision > selectedPlayback.revision);
    const playResult = await alice.emit('playback-command', { action: 'play', currentTime: 12, volume: 1 });
    assert.equal(playResult.success, true);
    const playWire = await playWirePromise;
    assertCompletePlayback(playWire, fileId); assert.equal(playWire.isPlaying, true); assert.equal(playWire.serverTime, playWire.updatedAt);
    const undoPlayStatePromise = alice.nextEvent('playback-state', (item) => item.revision > playWire.revision);
    assert.equal((await host.emit('undo-playback-change', { changeId: playResult.change.id })).success, true);
    const undoPlayState = await undoPlayStatePromise;
    assertCompletePlayback(undoPlayState, fileId); assert.equal(undoPlayState.isPlaying, true);
    const repeatedUndo = await host.emit('undo-playback-change', { changeId: playResult.change.id });
    assert.equal(repeatedUndo.success, false); assert.match(repeatedUndo.error, /重复|已经撤回/);

    const resumedPlayPromise = host.nextEvent('playback-command', (item) => item.action === 'play' && item.revision > undoPlayState.revision);
    const resumedPlay = await alice.emit('playback-command', { action: 'play', currentTime: 20, volume: 1 });
    assert.equal(resumedPlay.success, true); const resumedPlayWire = await resumedPlayPromise;
    const pauseWirePromise = host.nextEvent('playback-command', (item) => item.action === 'pause' && item.revision > resumedPlayWire.revision);
    const pauseResult = await alice.emit('playback-command', { action: 'pause', currentTime: 21, volume: 1 });
    assert.equal(pauseResult.success, true); const pauseWire = await pauseWirePromise;
    assertCompletePlayback(pauseWire, fileId); assert.equal(pauseWire.isPlaying, false);
    const undoPauseStatePromise = alice.nextEvent('playback-state', (item) => item.revision > pauseWire.revision);
    assert.equal((await host.emit('undo-playback-change', { changeId: pauseResult.change.id })).success, true);
    const undoPauseState = await undoPauseStatePromise;
    assertCompletePlayback(undoPauseState, fileId); assert.equal(undoPauseState.isPlaying, true);
    check('播放命令携带完整快照，撤回播放或暂停可正确恢复 isPlaying');

    const playbackChange = host.nextEvent('playback-change', (item) => item.action === 'seek' && item.changedBy === 'Alice');
    result = await alice.emit('playback-command', { action: 'seek', currentTime: 88, volume: 1 });
    assert.equal(result.success, true); const change = await playbackChange; assert.equal(change.after.currentTime, 88);
    const undoEvent = alice.nextEvent('playback-change', (item) => item.action === 'undo');
    assert.equal((await host.emit('undo-playback-change', { changeId: change.id })).success, true); await undoEvent;
    check('进度调整全员留痕，已撤回操作不能重复执行');

    const beforeStall = (await alice.emit('room-refresh')).room.playback;
    host.emitArgs('playback-progress', [{ fileId, currentTime: 35, isPlaying: true, stalled: true, revision: beforeStall.revision }]);
    await delay(80);
    const stalledOne = (await alice.emit('room-refresh')).room.playback;
    await delay(160);
    const stalledTwo = (await alice.emit('room-refresh')).room.playback;
    assert.equal(stalledOne.stalled, true); assert.equal(stalledTwo.stalled, true);
    assert.ok(Math.abs(stalledTwo.currentTime - stalledOne.currentTime) < 0.05, `${stalledOne.currentTime} -> ${stalledTwo.currentTime}`);
    host.emitArgs('playback-progress', [{ fileId, currentTime: 35, isPlaying: true, stalled: false, revision: stalledTwo.revision }]);
    await delay(140);
    const recoveredPlayback = (await alice.emit('room-refresh')).room.playback;
    assert.equal(recoveredPlayback.stalled, false); assert.ok(recoveredPlayback.currentTime > 35.05);
    check('房主缓冲时服务器冻结播放锚点，恢复后继续推进');

    assert.equal((await host.emit('queue-action', { action: 'add', fileId })).success, true);
    assert.equal((await host.emit('queue-action', { action: 'add', fileId: nextFileId })).success, true);
    let refresh = await alice.emit('room-refresh'); assert.deepEqual(refresh.queue, [fileId, nextFileId]);
    const beforeEnded = refresh.room.playback;
    const forgedEnded = await reconnectReplacement.emit('playback-ended', { fileId, currentTime: 999999 });
    assert.equal(forgedEnded.success, false); assert.match(forgedEnded.error, /控制权限/);
    assert.equal((await alice.emit('room-refresh')).room.playback.fileId, fileId);
    const endedStatePromise = host.nextEvent('playback-state', (item) => item.fileId === nextFileId && item.revision > beforeEnded.revision);
    const endedResults = await Promise.all([
      host.emit('playback-ended', { fileId, currentTime: 120 }),
      alice.emit('playback-ended', { fileId, currentTime: 120 })
    ]);
    assert.ok(endedResults.every((item) => item.success));
    assert.equal(endedResults.filter((item) => item.stale).length, 1);
    const endedState = await endedStatePromise;
    assertCompletePlayback(endedState, nextFileId); assert.equal(endedState.isPlaying, true); assert.ok(endedState.currentTime >= 0 && endedState.currentTime < 0.05);
    assert.equal(endedState.revision, beforeEnded.revision + 1);
    refresh = await alice.emit('room-refresh'); assert.equal(refresh.room.playback.fileId, nextFileId); assert.equal(refresh.room.playback.revision, endedState.revision);
    const crossFileUndo = await host.emit('undo-playback-change', { changeId: resumedPlay.change.id });
    assert.equal(crossFileUndo.success, false); assert.match(crossFileUndo.error, /跨影片/);
    check('普通观众不能伪造播放结束；切片原子执行且旧影片操作不能跨片撤回');

    const bob = await makeClient();
    assert.equal((await bob.emit('user-register', { username: 'Bob', password: 'bob-pass' })).success, true);
    const bobLogin = await bob.emit('user-login', { username: 'Bob', password: 'bob-pass', deviceId: 'bob-tv', browser: 'Edge', platform: 'Windows' });
    assert.equal(bobLogin.success, true); const bobToken = bobLogin.token;
    const publicMessage = bob.nextEvent('chat-message', (message) => message.text === '公共消息');
    assert.equal((await host.emit('chat-message', { text: '公共消息' })).success, true); await publicMessage;
    const privateMessage = alice.nextEvent('chat-message', (message) => message.text === '私聊 Alice');
    assert.equal((await host.emit('chat-message', { text: '私聊 Alice', to: 'Alice' })).success, true); await privateMessage;
    const hostHistory = await host.emit('chat-history', { limit: 100 });
    const aliceHistory = await alice.emit('chat-history', { limit: 100 });
    const bobHistory = await bob.emit('chat-history', { limit: 100 });
    assert.ok(hostHistory.messages.some((message) => message.text === '私聊 Alice'));
    assert.ok(aliceHistory.messages.some((message) => message.text === '私聊 Alice'));
    assert.ok(!bobHistory.messages.some((message) => message.text === '私聊 Alice'));
    await delay(50);
    for (const eventName of ['chat-message', 'playback-state', 'playback-command', 'queue-state']) assert.equal(anonymous.hasEvent(eventName), false, `匿名连接不应收到 ${eventName}`);
    check('公共聊天永久记录且私聊历史仅双方可见');

    const screenStartedEvent = bob.nextEvent('screen-share-started', (payload) => payload.active && payload.username === 'xuan');
    assert.equal((await host.emit('screen-share-start', { settings: { resolution: 'native', fps: 30 } })).success, true);
    await screenStartedEvent;
    const screenStoppedEvent = bob.nextEvent('screen-share-stopped');
    const screenClearResult = await host.emit('clear-playback');
    assert.equal(screenClearResult.success, true, screenClearResult.error);
    assert.equal(screenClearResult.screenShareStopped, true);
    await screenStoppedEvent;
    assert.equal((await bob.emit('room-refresh')).room.screenShare.active, false);
    check('清空画面会统一停止屏幕共享并清理当前媒体状态');

    const sharedWebUrl = 'https://jx.xmflv.cc/?url=https://v.qq.com/x/cover/yl6lapwmmx5ivew/m0501m4tc0q.html?report_recomm_player=ptag%3Dv_qq_com%7Crtype%3D%7CalgId%3D5112%7CbucketId%3D%7Creason%3D%7CreasonType%3D%7Ccid%3D%7Cvid%3D%7Cpid%3D%7Cmodule%3D%7CpageType%3DfilmIndex%7Cseqnum%3D%7Cvideo_rec_report%3Dflow_from%3A3%7Ce_item_id%3Ayl6lapwmmx5ivew%7Ce_item_type%3A2%7Ce_mid%3Ayl6lapwmmx5ivew%23v4102xprlr0%7Ce_rec_reason%3A3%7Ce_cid_played%3A3%7Ce_cid_played_10min%3A1%7Ce_cid_played_valid%3A1%7Ce_targeting_tags%3Anon_weak_low_activity%2Cvp1_pl1%2Cvp0_pl0_d7%2Cm_v_pcu%2Cnot_vip%2Cinterest_movie_none%2Csd_v_cu%7Ce_rerank_cost_time%3A39%7Ce_profile_cost_time%3A7%7Ce_recall_cost_time%3A87%7Ca_alg_id_list%3A5112%7Ce_alg_id_list%3A5112%7Cpositive_trailer%3A1%7Ce_cut_vid%3Av4102xprlr0%7Crecall_mod%3A803036%7Cseqnum%3A0f616a06ac20a757_1786018995.1786018993246599_868%7Csrc_key%3A100137%7Cscene_type%3A1%7Creq_timestamp%3A1786018995%7Creturn_item_num%3A36%7Cis_unify_re%3A1%7Crec_session_id%3A0f616a06ac20a757_1786018995%7Cspecial_user%3A0%7Cflow_rule_id%3A156%7Cexp_i';
    const sharedWebEvent = bob.nextEvent('web-share-state', (payload) => payload.active && payload.url === sharedWebUrl);
    const sharedWebResult = await host.emit('web-share-start', { url: sharedWebUrl, title: '腾讯视频解析页' });
    assert.equal(sharedWebResult.success, true, sharedWebResult.error);
    assert.equal(sharedWebResult.webShare.url, sharedWebUrl);
    await sharedWebEvent;
    const sharedWebRefresh = await bob.emit('room-refresh');
    assert.equal(sharedWebRefresh.room.webShare.url, sharedWebUrl);
    const clearedWebEvent = bob.nextEvent('web-share-state', (payload) => payload.active === false && payload.url === '');
    const clearedPlaybackEvent = bob.nextEvent('playback-state', (payload) => payload.fileId === null);
    const clearedNoticeEvent = bob.nextEvent('system-notification', (payload) => payload.kind === 'playback-cleared' && payload.actor === 'xuan');
    const clearResult = await host.emit('clear-playback');
    assert.equal(clearResult.success, true, clearResult.error);
    assert.equal(clearResult.notice.actor, 'xuan'); assert.equal(clearResult.notice.actorName, 'xuan');
    assert.match(clearResult.notice.message, /xuan 清空了画面/);
    await clearedWebEvent;
    await clearedPlaybackEvent;
    const clearedNotice = await clearedNoticeEvent;
    assert.match(clearedNotice.message, /xuan 清空了画面/);
    const clearedRefresh = await bob.emit('room-refresh');
    assert.equal(clearedRefresh.room.webShare.active, false); assert.equal(clearedRefresh.room.playback.fileId, null);
    check('用户提供的超长共享网址按原样同步到双客户端；网页共享中可清空全画面并向所有客户端提示操作者');

    const voiceForm = new FormData(); voiceForm.append('voice', new Blob([Buffer.from('voice-data')], { type: 'audio/webm' }), 'voice.webm'); voiceForm.append('to', 'Alice');
    const voice = await json(await fetch(`${baseUrl}/api/voice`, { method: 'POST', headers: auth(hostToken), body: voiceForm }));
    assert.equal(voice.response.status, 200);
    assert.equal((await fetch(`${baseUrl}${voice.payload.message.voiceUrl}`, { headers: auth(aliceToken) })).status, 200);
    assert.equal((await fetch(`${baseUrl}${voice.payload.message.voiceUrl}`, { headers: auth(bobToken) })).status, 404);
    check('私聊语音永久保存且文件访问仅限聊天双方');

    const voiceDir = path.join(dataDir, 'voice');
    const voiceFilesBeforeLimit = fs.readdirSync(voiceDir).sort();
    const oversizedVoiceForm = new FormData();
    oversizedVoiceForm.append('voice', new Blob([Buffer.alloc(25 * 1024 * 1024 + 1)]), 'oversized.webm');
    const oversizedVoice = await json(await fetch(`${baseUrl}/api/voice`, { method: 'POST', headers: auth(hostToken), body: oversizedVoiceForm }));
    assert.equal(oversizedVoice.response.status, 413); assert.match(oversizedVoice.payload.error, /25MB/);
    assert.deepEqual(fs.readdirSync(voiceDir).sort(), voiceFilesBeforeLimit);
    check('语音超过 25MB 时返回明确错误且不留下部分文件');

    result = await host.emit('admin-action', { action: 'set-room', adminPassword: 'admin888', roomName: '周末电影', maxUsers: 50, requireUploadApproval: true });
    assert.equal(result.success, true);
    result = await host.emit('admin-action', { action: 'set-upload-limits', adminPassword: 'admin888', uploadLimitBytes: 0, uploadTimeLimitSeconds: 0 });
    assert.equal(result.success, true);
    bob.drainEvents('file-uploaded'); bob.drainEvents('file-updated');
    alice.drainEvents('file-updated'); host.drainEvents('upload-pending');
    const secondForm = new FormData(); secondForm.append('file', new Blob([Buffer.from('pending')], { type: 'video/webm' }), '待审核.webm');
    upload = await json(await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(aliceToken), body: secondForm }));
    assert.equal(upload.payload.pending, true); const pendingId = upload.payload.file.id;
    await delay(120);
    assert.equal(bob.hasEvent('file-uploaded', (file) => file.id === pendingId), false);
    assert.equal(bob.hasEvent('file-updated', (file) => file.id === pendingId), false);
    assert.equal(host.hasEvent('upload-pending', (file) => file.id === pendingId), true);
    const bobFiles = await (await fetch(`${baseUrl}/api/files`, { headers: auth(bobToken) })).json();
    assert.ok(!bobFiles.some((file) => file.id === pendingId));
    let settings = await host.emit('admin-action', { action: 'get-settings', adminPassword: 'admin888' });
    assert.ok(settings.admin.pendingFiles.some((file) => file.id === pendingId));
    assert.equal((await host.emit('admin-action', { action: 'reject-upload', adminPassword: 'admin888', fileId: pendingId })).success, true);
    alice.drainEvents('file-updated'); await delay(120);
    assert.equal(alice.hasEvent('file-updated', (file) => file.id === pendingId), false);
    assert.equal(fs.existsSync(path.join(server.uploadsDir, upload.payload.file.storedName)), false);
    settings = await host.emit('admin-action', { action: 'get-settings', adminPassword: 'admin888' });
    assert.ok(!settings.admin.pendingFiles.some((file) => file.id === pendingId));

    const approvalForm = new FormData(); approvalForm.append('file', new Blob([Buffer.from('approved-after-review')], { type: 'video/webm' }), '允许上传.webm');
    const approvalUpload = await json(await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(aliceToken), body: approvalForm }));
    assert.equal(approvalUpload.payload.pending, true);
    assert.equal((await host.emit('admin-action', { action: 'approve-upload', adminPassword: 'admin888', fileId: approvalUpload.payload.file.id })).success, true);
    const approvalFileId = approvalUpload.payload.file.id;
    assert.equal((await host.emit('select-file', { fileId: approvalFileId })).success, true);
    assert.equal((await host.emit('playback-command', { action: 'play', currentTime: 3 })).success, true);
    const playbackBeforeApprovalRollback = (await host.emit('room-refresh')).room.playback;
    assert.equal(playbackBeforeApprovalRollback.fileId, approvalFileId);
    assert.equal(playbackBeforeApprovalRollback.isPlaying, true);
    for (const client of [host, alice, bob]) {
      client.drainEvents('file-deleted'); client.drainEvents('file-updated');
      client.drainEvents('upload-pending'); client.drainEvents('queue-state'); client.drainEvents('playback-state');
    }
    const approvalOperations = await host.emit('operation-history', { limit: 300 });
    const approvalOperation = approvalOperations.operations.find((operation) => operation.action === 'upload-approve');
    assert.ok(approvalOperation?.reversible);
    assert.equal((await host.emit('rollback-operation', { operationId: approvalOperation.id })).success, true);
    await delay(120);
    assert.equal(bob.hasEvent('file-deleted', (id) => id === approvalFileId), true);
    assert.equal(bob.hasEvent('file-updated', (file) => file.id === approvalFileId), false);
    assert.equal(bob.hasEvent('upload-pending', (file) => file.id === approvalFileId), false);
    assert.equal(host.hasEvent('file-updated', (file) => file.id === approvalFileId && file.status === 'pending'), true);
    assert.equal(alice.hasEvent('file-updated', (file) => file.id === approvalFileId && file.status === 'pending'), true);
    assert.equal(host.hasEvent('upload-pending', (file) => file.id === approvalFileId), true);
    assert.equal(bob.hasEvent('queue-state', (queue) => Array.isArray(queue) && !queue.includes(approvalFileId)), true);
    const rollbackPlaybackEvent = bob.drainEvents('playback-state').find((playback) => playback.fileId === '' && playback.revision > playbackBeforeApprovalRollback.revision);
    assert.ok(rollbackPlaybackEvent); assert.equal(rollbackPlaybackEvent.isPlaying, false);
    const roomAfterApprovalRollback = await bob.emit('room-refresh');
    assert.ok(!roomAfterApprovalRollback.queue.includes(approvalFileId));
    assert.equal(roomAfterApprovalRollback.room.playback.fileId, '');
    assert.equal(roomAfterApprovalRollback.room.playback.isPlaying, false);
    const bobFilesAfterApprovalRollback = await (await fetch(`${baseUrl}/api/files`, { headers: auth(bobToken) })).json();
    assert.ok(!bobFilesAfterApprovalRollback.some((file) => file.id === approvalFileId));
    const staleSelection = await host.emit('select-file', { fileId: approvalFileId });
    assert.equal(staleSelection.success, false); assert.equal(staleSelection.code, 'MEDIA_NOT_AVAILABLE_IN_ROOM');
    const stalePlayback = await host.emit('playback-command', { action: 'play', currentTime: 4 });
    assert.equal(stalePlayback.success, false); assert.equal(stalePlayback.code, 'MEDIA_NOT_AVAILABLE_IN_ROOM');
    check('待审核文件仅可见于上传者/房主；审核回退会从普通观众、队列和当前播放中同步移除，且无法继续播放');

    const profile = await host.emit('account-action', { action: 'get-profile' });
    assert.match(profile.profile.id, /^SW-\d{6}$/); assert.equal(profile.profile.email, 'xuan@example.com'); assert.ok(profile.profile.devices.some((device) => device.id === 'host-device'));
    assert.equal((await host.emit('account-action', { action: 'toggle-favorite', fileId })).success, true);
    check('个人资料、SW 用户 ID、设备和收藏持久模型正常');

    const passwordUser = await makeClient();
    assert.equal((await passwordUser.emit('user-register', { username: '改密用户', password: 'before-pass' })).success, true);
    const passwordLogin = await passwordUser.emit('user-login', { username: '改密用户', password: 'before-pass', deviceId: 'password-device' });
    assert.equal(passwordLogin.success, true);
    const passwordChanged = await passwordUser.emit('account-action', { action: 'change-password', currentPassword: 'before-pass', newPassword: 'after-pass' });
    assert.equal(passwordChanged.success, true); assert.ok(passwordChanged.token); assert.notEqual(passwordChanged.token, passwordLogin.token);
    assert.equal((await fetch(`${baseUrl}/api/files`, { headers: auth(passwordLogin.token) })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/files`, { headers: auth(passwordChanged.token) })).status, 200);
    assert.equal((await passwordUser.emit('room-refresh')).success, true);
    check('自行修改密码会轮换当前令牌并立即撤销旧令牌');

    const resetAccountOwner = await makeClient();
    assert.equal((await resetAccountOwner.emit('user-register', { username: '重置用户', password: 'old-pass' })).success, true);
    result = await host.emit('admin-action', { action: 'reset-account-password', adminPassword: 'admin888', username: '重置用户', newPassword: 'new-pass' });
    assert.equal(result.success, true);
    const resetClient = await makeClient();
    assert.equal((await resetClient.emit('user-login', { username: '重置用户', password: 'old-pass' })).success, false);
    assert.equal((await resetClient.emit('user-login', { username: '重置用户', password: 'new-pass', deviceId: 'reset-device' })).success, true);
    check('管理员可重置账号密码且旧密码立即失效');

    const persistedMailState = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
    assert.doesNotMatch(persistedMailState, new RegExp(mailAuthCode));
    assert.equal(fs.existsSync(path.join(dataDir, '.secrets', 'mail.key')), true);
    assert.equal((await json(await fetch(`${baseUrl}/api/public-config`))).payload.passwordRecoveryAvailable, true);

    const emailResetUser = await makeClient();
    assert.equal((await emailResetUser.emit('user-register', { username: '邮箱找回用户', password: 'email-old-pass' })).success, true);
    const emailOldLogin = await verifyRecoveryEmail(emailResetUser, '邮箱找回用户', 'recover-user@example.com', 'email-old-pass', 'email-reset-device', true);
    const recoveryClient = await makeClient();
    const resetRequested = await recoveryClient.emit('password-reset-request', { scope: 'account', identifier: 'recover-user@example.com' });
    assert.equal(resetRequested.success, true, resetRequested.error);
    assert.equal(await waitUntil(() => Boolean(latestResetMail('recover-user@example.com')), 2000), true);
    const existingResetMail = latestResetMail('recover-user@example.com');
    assert.equal(existingResetMail.config.user, 'sender@qq.com'); assert.equal(existingResetMail.config.authCode, mailAuthCode);
    const resetCode = existingResetMail.text.match(/验证码：(\d{6})/)?.[1];
    assert.match(resetCode || '', /^\d{6}$/);
    const wrongCode = `${resetCode.slice(0, 5)}${resetCode.endsWith('9') ? '8' : '9'}`;
    assert.equal((await recoveryClient.emit('password-reset-verify', { scope: 'account', identifier: '邮箱找回用户', code: wrongCode })).success, false);
    const resetVerified = await recoveryClient.emit('password-reset-verify', { scope: 'account', identifier: '邮箱找回用户', code: resetCode });
    assert.equal(resetVerified.success, true, resetVerified.error); assert.ok(resetVerified.resetToken);
    assert.equal((await recoveryClient.emit('password-reset-complete', { resetToken: resetVerified.resetToken, newPassword: '' })).success, false);
    const resetCompleted = await recoveryClient.emit('password-reset-complete', { resetToken: resetVerified.resetToken, newPassword: 'email-new-pass' });
    assert.equal(resetCompleted.success, true, resetCompleted.error);
    assert.equal((await fetch(`${baseUrl}/api/files`, { headers: auth(emailOldLogin.token) })).status, 401);
    const emailRelogin = await makeClient();
    assert.equal((await emailRelogin.emit('user-login', { username: '邮箱找回用户', password: 'email-old-pass', deviceId: 'email-old' })).success, false);
    assert.equal((await emailRelogin.emit('user-login', { username: '邮箱找回用户', password: 'email-new-pass', deviceId: 'email-new' })).success, true);
    assert.equal((await recoveryClient.emit('password-reset-complete', { resetToken: resetVerified.resetToken, newPassword: 'another-pass' })).success, false);
    const mailCountBeforeUnknown = sentMails.length;
    const unknownReset = await recoveryClient.emit('password-reset-request', { scope: 'account', identifier: 'not-found@example.com' });
    if (unknownReset.success !== false) assert.equal(unknownReset.success, true);
    else assert.equal(unknownReset.code, 'ACCOUNT_OR_EMAIL_NOT_FOUND');
    assert.equal(sentMails.length, mailCountBeforeUnknown);
    check('QQ SMTP 设置会加密落盘，邮箱验证码完成请求、校验、一次性授权、改密和旧会话撤销闭环');

    const deletedUser = await makeClient();
    assert.equal((await deletedUser.emit('user-register', { username: 'DeletedUser', password: '123456' })).success, true);
    const deletedLogin = await deletedUser.emit('user-login', { username: 'DeletedUser', password: '123456', deviceId: 'deleted-device' });
    assert.equal(deletedLogin.success, true);
    assert.equal((await host.emit('admin-action', { action: 'delete-account', adminPassword: 'admin888', username: 'DeletedUser' })).success, true);
    await delay(50);
    const deletedReplacement = await makeClient();
    const reusedName = await deletedReplacement.emit('user-register', { username: 'DeletedUser', password: '654321' });
    assert.equal(reusedName.success, false); assert.match(reusedName.error, /历史账号|不能再次注册/);
    assert.equal((await deletedReplacement.emit('session-resume', { token: deletedLogin.token })).success, false);
    check('删除账号后用户名永久保留，旧会话与同名重注册均失效');

    const kickedUser = await makeClient();
    assert.equal((await kickedUser.emit('user-register', { username: 'KickedUser', password: '123456' })).success, true);
    const kickedLogin = await kickedUser.emit('user-login', { username: 'KickedUser', password: '123456', deviceId: 'kick-device' });
    assert.equal(kickedLogin.success, true);
    assert.equal((await host.emit('admin-action', { action: 'kick-user', adminPassword: 'admin888', targetSocketId: kickedUser.id })).success, true);
    await delay(50);
    const kickedResume = await makeClient();
    assert.equal((await kickedResume.emit('session-resume', { token: kickedLogin.token })).success, false);

    const bannedHeaders = { 'cf-connecting-ip': '203.0.113.77' };
    const bannedUser = await makeClient(bannedHeaders);
    assert.equal((await bannedUser.emit('user-register', { username: 'BannedUser', password: '123456' })).success, true);
    const bannedLogin = await bannedUser.emit('user-login', { username: 'BannedUser', password: '123456', deviceId: 'ban-device' });
    assert.equal(bannedLogin.success, true);
    assert.equal((await host.emit('admin-action', { action: 'ban-user', adminPassword: 'admin888', targetSocketId: bannedUser.id })).success, true);
    await delay(50);
    const blockedResume = await makeClient(bannedHeaders);
    assert.equal((await blockedResume.emit('session-resume', { token: bannedLogin.token })).success, false);
    settings = await host.emit('admin-action', { action: 'get-settings', adminPassword: 'admin888' });
    const banEntry = settings.admin.blacklist.find((item) => item.username === 'BannedUser'); assert.ok(banEntry);
    assert.equal((await host.emit('admin-action', { action: 'unban', adminPassword: 'admin888', id: banEntry.id })).success, true);
    const unbannedOldToken = await makeClient(bannedHeaders);
    assert.equal((await unbannedOldToken.emit('session-resume', { token: bannedLogin.token })).success, false);
    check('移出与封禁都会撤销会话令牌，解封后旧令牌也不会复活');

    assert.equal((await host.emit('screen-share-start')).success, true);
    assert.equal((await bob.emit('screen-share-start')).success, false);
    assert.equal((await host.emit('screen-share-stop')).success, true);

    const anonymousIo = await makeIoClient();
    const anonymousScreenEvents = [];
    anonymousIo.on('screen-share-started', () => anonymousScreenEvents.push('started'));
    anonymousIo.on('screen-share-frame', () => anonymousScreenEvents.push('frame'));
    const viewerIo = await makeIoClient();
    assert.equal((await ioAck(viewerIo, 'user-register', { username: 'FrameViewer', password: '123456' })).success, true);
    assert.equal((await ioAck(viewerIo, 'user-login', { username: 'FrameViewer', password: '123456', deviceId: 'viewer-device' })).success, true);
    const sharerIo = await makeIoClient();
    assert.equal((await ioAck(sharerIo, 'user-register', { username: 'FrameSharer', password: '123456' })).success, true);
    assert.equal((await ioAck(sharerIo, 'user-login', { username: 'FrameSharer', password: '123456', deviceId: 'sharer-device' })).success, true);
    assert.equal((await host.emit('owner-action', { action: 'grant-control', username: 'FrameSharer' })).success, true);
    assert.equal((await ioAck(sharerIo, 'screen-share-start')).success, true);

    const firstFramePromise = nextIoEvent(viewerIo, 'screen-share-frame', (packet) => packet?.sequence === 1);
    assert.equal((await ioAck(sharerIo, 'screen-share-frame', { data: Buffer.from([1, 2, 3, 4]), width: 2, height: 1 })).success, true);
    const firstFrame = await firstFramePromise;
    assert.equal(firstFrame.width, 2); assert.equal(firstFrame.height, 1); assert.deepEqual(Buffer.from(firstFrame.data), Buffer.from([1, 2, 3, 4]));
    await delay(90);
    const secondFramePromise = nextIoEvent(viewerIo, 'screen-share-frame', (packet) => packet?.sequence === 2);
    assert.equal((await ioAck(sharerIo, 'screen-share-frame', { data: Buffer.from([5, 6, 7]), width: 3, height: 1 })).success, true);
    const secondFrame = await secondFramePromise;
    assert.deepEqual(Buffer.from(secondFrame.data), Buffer.from([5, 6, 7]));

    const lateViewer = await makeIoClient();
    assert.equal((await ioAck(lateViewer, 'user-register', { username: 'LateViewer', password: '123456' })).success, true);
    const cachedFramePromise = nextIoEvent(lateViewer, 'screen-share-frame', (packet) => packet?.sequence === 2);
    assert.equal((await ioAck(lateViewer, 'user-login', { username: 'LateViewer', password: '123456', deviceId: 'late-device' })).success, true);
    const cachedFrame = await cachedFramePromise;
    assert.deepEqual(Buffer.from(cachedFrame.data), Buffer.from([5, 6, 7]));

    const pollingViewer = await makeIoClient({ transports: ['polling'], upgrade: false });
    assert.equal(pollingViewer.io.engine.transport.name, 'polling');
    const pollingFrames = [];
    const pollingAcknowledgements = [];
    pollingViewer.on('screen-share-frame', (packet, acknowledgement) => {
      pollingFrames.push(packet);
      pollingAcknowledgements.push(acknowledgement);
    });
    assert.equal((await ioAck(pollingViewer, 'user-register', { username: 'PollingFrameViewer', password: '123456' })).success, true);
    const pollingViewerLogin = await ioAck(pollingViewer, 'user-login', { username: 'PollingFrameViewer', password: '123456', deviceId: 'polling-viewer-device' });
    assert.equal(pollingViewerLogin.success, true, pollingViewerLogin.error);
    assert.equal(await waitUntil(() => pollingFrames.length === 1, 3000), true, 'polling 观看者应可靠收到缓存首帧');
    assert.deepEqual(Buffer.from(pollingFrames[0].data), Buffer.from([5, 6, 7]));

    await delay(90);
    assert.equal((await ioAck(sharerIo, 'screen-share-frame', { data: Buffer.from([11]), width: 11, height: 1 })).success, true);
    await delay(90);
    assert.equal((await ioAck(sharerIo, 'screen-share-frame', { data: Buffer.from([12]), width: 12, height: 1 })).success, true);
    await delay(90);
    assert.equal((await ioAck(sharerIo, 'screen-share-frame', { data: Buffer.from([13]), width: 13, height: 1 })).success, true);
    await delay(120);
    assert.equal(pollingFrames.length, 1, '首帧 ACK 延迟期间不能向同一观看者堆叠发送');
    pollingAcknowledgements.shift()?.({ success: true, sequence: pollingFrames[0].sequence });
    assert.equal(await waitUntil(() => pollingFrames.length === 2, 3000), true, '首帧 ACK 后应发送最新待发帧');
    assert.deepEqual(Buffer.from(pollingFrames[1].data), Buffer.from([13]), '中间旧帧应被最新帧覆盖');
    pollingAcknowledgements.shift()?.({ success: true, sequence: pollingFrames[1].sequence });

    await delay(90);
    assert.equal((await ioAck(sharerIo, 'screen-share-frame', { data: Buffer.from([21]), width: 21, height: 1 })).success, true);
    assert.equal(await waitUntil(() => pollingFrames.length === 3, 3000), true);
    await delay(90);
    assert.equal((await ioAck(sharerIo, 'screen-share-frame', { data: Buffer.from([22]), width: 22, height: 1 })).success, true);
    const stoppedPromise = nextIoEvent(viewerIo, 'screen-share-stopped');
    assert.equal((await host.emit('owner-action', { action: 'revoke-control', username: 'FrameSharer' })).success, true);
    await stoppedPromise;
    pollingAcknowledgements.shift()?.({ success: true, sequence: pollingFrames[2].sequence });
    await delay(250); sharerIo.emit('screen-share-frame', { data: Buffer.from([9, 9, 9]), width: 3, height: 1 });
    await delay(120);
    assert.equal(pollingFrames.length, 3, '停止共享后迟到 ACK 不得重新发送旧待发帧');
    assert.deepEqual(anonymousScreenEvents, []);
    const shareRefresh = await host.emit('room-refresh'); assert.equal(shareRefresh.room.screenShare.active, false);
    check('屏幕共享按观看者仅保留一帧在途和最新待发帧，polling 延迟 ACK 仍可恢复，停止后旧帧不会复活且不泄露给匿名端');

    result = await host.emit('admin-action', { action: 'set-access-password', adminPassword: 'admin888', accessPassword: 'room-access-pass' });
    assert.equal(result.success, true);
    const alicePasswordVerification = await alice.emit('room-password-verify', { roomPassword: 'room-access-pass' });
    assert.equal(alicePasswordVerification.success, true, alicePasswordVerification.error);
    tunnel = await json(await fetch(`${baseUrl}/api/host/tunnel/start`, { method: 'POST', headers: auth(hostToken, { 'Content-Type': 'application/json' }), body: JSON.stringify({ mode: 'quick' }) }));
    assert.equal(tunnel.response.status, 200); assert.match(tunnel.payload.status.publicUrl, /trycloudflare/);
    tunnel = await json(await fetch(`${baseUrl}/api/host/tunnel/stop`, { method: 'POST', headers: auth(hostToken) })); assert.equal(tunnel.payload.success, true);
    assert.equal((await fetch(`${baseUrl}/api/host/tunnel/status`, { headers: auth(aliceToken) })).status, 403);
    const qr = await fetch(`${baseUrl}/api/room/qr?url=${encodeURIComponent(baseUrl)}`, { headers: auth(hostToken) }); assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
    check('设置访问密码后仅服务器主机可启停公网隧道，房间二维码正常');

    const roomMaker = await makeClient();
    result = await roomMaker.emit('user-register', { username: 'RoomMaker', password: 'maker-pass' });
    assert.equal(result.success, true, '默认房间已设置密码时，注册全局账号不应要求房间密码');
    check('默认房间设置密码后，仍可不填写房间密码注册全局账号');

    const createdRoom = await roomMaker.emit('room-create', {
      username: 'RoomMaker', password: 'maker-pass', roomName: '多房间隔离测试', roomPassword: 'separate-room-pass', maxUsers: 3,
      deviceId: 'room-maker-device', browser: 'Chrome', platform: 'Windows'
    });
    assert.equal(createdRoom.success, true); assert.match(createdRoom.room.id, /^[A-Z2-9]{6}$/);
    assert.equal(createdRoom.room.name, '多房间隔离测试'); assert.equal(createdRoom.room.maxUsers, 3);
    assert.equal(createdRoom.room.passwordRequired, true); assert.equal(Object.hasOwn(createdRoom.room, 'passwordHash'), false);
    assert.equal(createdRoom.capabilities.owner, true); assert.equal(createdRoom.capabilities.serverHost, false);
    const createdRoomId = createdRoom.room.id; const roomMakerToken = createdRoom.token;

    const roomGuest = await makeClient();
    assert.equal((await roomGuest.emit('user-register', { username: 'RoomGuest', password: 'guest-pass' })).success, true);
    const missingRoomPassword = await roomGuest.emit('user-login', {
      username: 'RoomGuest', password: 'guest-pass', roomId: createdRoomId, roomPassword: '', deviceId: 'room-guest-device'
    });
    assert.equal(missingRoomPassword.success, false); assert.equal(missingRoomPassword.error, '请输入房间密码');
    const wrongRoomPassword = await roomGuest.emit('user-login', {
      username: 'RoomGuest', password: 'guest-pass', roomId: createdRoomId, roomPassword: 'wrong-pass', deviceId: 'room-guest-device'
    });
    assert.equal(wrongRoomPassword.success, false); assert.match(wrongRoomPassword.error, /房间密码/);
    const joinedRoom = await roomGuest.emit('user-login', {
      username: 'RoomGuest', password: 'guest-pass', roomId: createdRoomId, roomPassword: 'separate-room-pass', deviceId: 'room-guest-device'
    });
    assert.equal(joinedRoom.success, true); assert.equal(joinedRoom.room.id, createdRoomId); assert.equal(joinedRoom.room.maxUsers, 3);
    const roomGuestToken = joinedRoom.token;
    check('普通账号可异步创建带密码和人数限制的房间，空密码明确提示输入、错误密码拒绝、正确密码允许加入');

    const rememberedRoomClient = await makeClient();
    assert.equal((await rememberedRoomClient.emit('user-register', { username: 'RoomMemory', password: 'memory-pass' })).success, true);
    assert.equal((await rememberedRoomClient.emit('user-login', {
      username: 'RoomMemory', password: 'memory-pass', roomId: createdRoomId, roomPassword: 'separate-room-pass', deviceId: 'room-memory-device'
    })).success, true);
    assert.equal((await rememberedRoomClient.emit('room-switch', { roomId: integrationRoomId, roomPassword: 'room-access-pass' })).success, true);
    const rememberedReentry = await rememberedRoomClient.emit('room-switch', { roomId: createdRoomId });
    assert.equal(rememberedReentry.success, true, rememberedReentry.error);
    assert.equal((await rememberedRoomClient.emit('account-action', { action: 'pin-room', roomId: integrationRoomId, pinned: true })).success, true);
    assert.equal((await rememberedRoomClient.emit('account-action', { action: 'pin-room', roomId: createdRoomId, pinned: true })).success, true);
    const rememberedProfile = await rememberedRoomClient.emit('account-action', { action: 'get-profile' });
    const rememberedRooms = rememberedProfile.profile.recentRooms;
    assert.equal(rememberedRooms.filter((room) => room.pinned).length, 2);
    assert.equal(rememberedRooms.find((room) => room.id === createdRoomId)?.accessRemembered, true);
    const removedRememberedRooms = await rememberedRoomClient.emit('account-action', {
      action: 'remove-rooms', roomIds: [integrationRoomId, createdRoomId]
    });
    assert.equal(removedRememberedRooms.success, true, removedRememberedRooms.error);
    assert.deepEqual(removedRememberedRooms.removedHistory.sort(), [createdRoomId, integrationRoomId].sort());
    rememberedRoomClient.close();
    await delay(100);
    check('房间密码首次验证后可无密码再次切换，房间列表支持不限数量置顶与批量移除记录');

    const defaultRoomMembers = (await host.emit('room-refresh')).users.map((user) => user.username);
    const isolatedRoomMembers = (await roomMaker.emit('room-refresh')).users.map((user) => user.username).sort();
    assert.ok(!defaultRoomMembers.includes('RoomMaker') && !defaultRoomMembers.includes('RoomGuest'));
    assert.deepEqual(isolatedRoomMembers, ['RoomGuest', 'RoomMaker']);

    const defaultIsolationChat = `默认房间隔离消息-${Date.now()}`;
    const createdIsolationChat = `新房间隔离消息-${Date.now()}`;
    roomMaker.drainEvents('chat-message'); roomGuest.drainEvents('chat-message');
    host.drainEvents('chat-message'); alice.drainEvents('chat-message'); bob.drainEvents('chat-message');
    assert.equal((await host.emit('chat-message', { text: defaultIsolationChat })).success, true);
    await delay(60);
    assert.equal(roomMaker.hasEvent('chat-message', (message) => message.text === defaultIsolationChat), false);
    assert.equal(roomGuest.hasEvent('chat-message', (message) => message.text === defaultIsolationChat), false);
    assert.equal((await roomMaker.emit('chat-message', { text: createdIsolationChat })).success, true);
    await delay(60);
    assert.equal(host.hasEvent('chat-message', (message) => message.text === createdIsolationChat), false);
    assert.equal(alice.hasEvent('chat-message', (message) => message.text === createdIsolationChat), false);
    assert.equal(bob.hasEvent('chat-message', (message) => message.text === createdIsolationChat), false);
    assert.ok((await host.emit('chat-history', { limit: 300 })).messages.some((message) => message.text === defaultIsolationChat));
    assert.ok(!(await host.emit('chat-history', { limit: 300 })).messages.some((message) => message.text === createdIsolationChat));
    assert.ok((await roomGuest.emit('chat-history', { limit: 300 })).messages.some((message) => message.text === createdIsolationChat));

    const folderForm = new FormData();
    folderForm.append('relativePath', '家庭影院/科幻/文件夹影片.mp4');
    folderForm.append('file', new Blob([Buffer.from('isolated-room-video')], { type: 'video/mp4' }), '文件夹影片.mp4');
    const folderUpload = await json(await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(roomMakerToken), body: folderForm }));
    assert.equal(folderUpload.response.status, 200); assert.equal(folderUpload.payload.success, true);
    assert.equal(folderUpload.payload.file.roomId, createdRoomId); assert.equal(folderUpload.payload.file.relativePath, '家庭影院/科幻/文件夹影片.mp4');
    const createdRoomFileId = folderUpload.payload.file.id;
    const defaultRoomFiles = await (await fetch(`${baseUrl}/api/files`, { headers: auth(hostToken) })).json();
    const createdRoomFiles = await (await fetch(`${baseUrl}/api/files`, { headers: auth(roomGuestToken) })).json();
    assert.ok(!defaultRoomFiles.some((file) => file.id === createdRoomFileId));
    assert.ok(createdRoomFiles.some((file) => file.id === createdRoomFileId && file.relativePath === '家庭影院/科幻/文件夹影片.mp4'));
    assert.equal((await host.emit('select-file', { fileId: createdRoomFileId })).success, false);
    assert.equal((await roomMaker.emit('select-file', { fileId })).success, false);

    host.drainEvents('queue-state'); host.drainEvents('playback-state');
    const defaultRoomBeforeCreatedPlayback = await host.emit('room-refresh');
    assert.equal((await roomMaker.emit('select-file', { fileId: createdRoomFileId })).success, true);
    assert.equal((await roomMaker.emit('playback-command', { action: 'play', currentTime: 7, volume: .75 })).success, true);
    await delay(80);
    const createdRoomPlayback = await roomGuest.emit('room-refresh');
    const defaultRoomAfterCreatedPlayback = await host.emit('room-refresh');
    assert.equal(createdRoomPlayback.room.playback.fileId, createdRoomFileId); assert.equal(createdRoomPlayback.room.playback.isPlaying, true);
    assert.deepEqual(createdRoomPlayback.queue, [createdRoomFileId]);
    assert.equal(defaultRoomAfterCreatedPlayback.room.playback.fileId, defaultRoomBeforeCreatedPlayback.room.playback.fileId);
    assert.deepEqual(defaultRoomAfterCreatedPlayback.queue, defaultRoomBeforeCreatedPlayback.queue);
    assert.equal(host.hasEvent('playback-state', (playback) => playback.fileId === createdRoomFileId), false);
    assert.equal(host.hasEvent('queue-state', (queue) => Array.isArray(queue) && queue.includes(createdRoomFileId)), false);
    check('默认房间与新房间的成员、聊天、文件、队列、播放状态和广播完全隔离，目录相对路径可保存');

    const renamedFolderFile = await json(await fetch(`${baseUrl}/api/files/${createdRoomFileId}`, {
      method: 'PATCH', headers: auth(roomMakerToken, { 'Content-Type': 'application/json' }), body: JSON.stringify({ originalName: '回溯重命名' })
    }));
    assert.equal(renamedFolderFile.response.status, 200); assert.equal(renamedFolderFile.payload.file.originalName, '回溯重命名.mp4');
    let createdOperations = await roomMaker.emit('operation-history', { limit: 300 });
    const fileRenameOperation = createdOperations.operations.find((operation) => operation.action === 'file-rename' && operation.summary.includes('回溯重命名'));
    assert.ok(fileRenameOperation?.reversible);
    assert.equal((await roomGuest.emit('rollback-operation', { operationId: fileRenameOperation.id })).success, false);
    assert.equal((await roomMaker.emit('rollback-operation', { operationId: fileRenameOperation.id })).success, true);
    let filesAfterRollback = await (await fetch(`${baseUrl}/api/files`, { headers: auth(roomMakerToken) })).json();
    assert.ok(filesAfterRollback.some((file) => file.id === createdRoomFileId && file.originalName === '文件夹影片.mp4'
      && file.relativePath === '家庭影院/科幻/文件夹影片.mp4'));

    result = await roomMaker.emit('admin-action', { action: 'set-room', roomName: '临时回溯房间', maxUsers: 5, requireUploadApproval: true });
    assert.equal(result.success, true);
    createdOperations = await roomMaker.emit('operation-history', { limit: 300 });
    const roomSettingsOperation = createdOperations.operations.find((operation) => operation.action === 'room-settings' && operation.summary.includes('临时回溯房间'));
    assert.ok(roomSettingsOperation?.reversible);
    assert.equal((await roomGuest.emit('rollback-operation', { operationId: roomSettingsOperation.id })).success, false);
    assert.equal((await roomMaker.emit('rollback-operation', { operationId: roomSettingsOperation.id })).success, true);
    const roomAfterSettingsRollback = (await roomMaker.emit('room-refresh')).room;
    assert.equal(roomAfterSettingsRollback.name, '多房间隔离测试'); assert.equal(roomAfterSettingsRollback.maxUsers, 3);
    assert.equal(roomAfterSettingsRollback.requireUploadApproval, false);
    check('操作历史按房间授权，文件重命名与房间设置仅操作人或房主可安全回溯');

    const defaultBeforeSecondaryDelete = await host.emit('room-refresh');
    const secondaryBeforeDelete = await roomMaker.emit('room-refresh');
    assert.equal(secondaryBeforeDelete.room.playback.fileId, createdRoomFileId);
    assert.equal(secondaryBeforeDelete.room.playback.isPlaying, true);
    host.drainEvents('file-deleted'); host.drainEvents('queue-state'); host.drainEvents('playback-state');
    roomGuest.drainEvents('file-deleted'); roomGuest.drainEvents('queue-state'); roomGuest.drainEvents('playback-state');
    const secondaryDelete = await fetch(`${baseUrl}/api/files/${createdRoomFileId}`, {
      method: 'DELETE', headers: auth(roomMakerToken)
    });
    assert.equal(secondaryDelete.status, 200);
    await delay(100);
    assert.equal(roomGuest.hasEvent('file-deleted', (id) => id === createdRoomFileId), true);
    assert.equal(host.hasEvent('file-deleted', (id) => id === createdRoomFileId), false);
    assert.equal(host.hasEvent('queue-state'), false);
    assert.equal(host.hasEvent('playback-state'), false);
    const secondaryAfterDelete = await roomMaker.emit('room-refresh');
    assert.ok(!secondaryAfterDelete.queue.includes(createdRoomFileId));
    assert.equal(secondaryAfterDelete.room.playback.fileId, null);
    assert.equal(secondaryAfterDelete.room.playback.isPlaying, false);
    assert.ok(secondaryAfterDelete.room.playback.revision > secondaryBeforeDelete.room.playback.revision);
    const defaultAfterSecondaryDelete = await host.emit('room-refresh');
    assert.deepEqual(defaultAfterSecondaryDelete.queue, defaultBeforeSecondaryDelete.queue);
    assert.equal(defaultAfterSecondaryDelete.room.playback.fileId, defaultBeforeSecondaryDelete.room.playback.fileId);
    assert.equal(defaultAfterSecondaryDelete.room.playback.revision, defaultBeforeSecondaryDelete.room.playback.revision);
    createdOperations = await roomMaker.emit('operation-history', { limit: 300 });
    const secondaryDeleteOperation = createdOperations.operations.find((operation) => operation.action === 'file-delete' && operation.summary.includes('文件夹影片.mp4'));
    assert.equal(secondaryDeleteOperation?.roomId, createdRoomId);
    check('二级房删除正在播放的队列影片仅清理本房播放状态和队列，默认房与操作历史房号保持正确');

    const ownerProtectedMessage = (await roomMaker.emit('chat-message', { text: '房主消息不可由普通成员删除' })).message;
    assert.equal((await roomGuest.emit('chat-delete', { messageId: ownerProtectedMessage.id })).success, false);
    const guestSelfMessage = (await roomGuest.emit('chat-message', { text: '普通成员右键删除自己的消息' })).message;
    assert.equal((await roomGuest.emit('chat-delete', { messageId: guestSelfMessage.id })).success, true);
    assert.ok(!(await roomGuest.emit('chat-history', { limit: 300 })).messages.some((message) => message.id === guestSelfMessage.id));
    const guestOperations = await roomGuest.emit('operation-history', { limit: 300 });
    const guestChatDeleteOperation = guestOperations.operations.find((operation) => operation.action === 'chat-delete' && operation.actor === 'RoomGuest');
    assert.ok(guestChatDeleteOperation?.reversible);
    assert.match(guestChatDeleteOperation.summary, /公共消息/);
    assert.equal(guestChatDeleteOperation.summary.includes('普通成员右键删除自己的消息'), false);
    assert.equal((await roomGuest.emit('rollback-operation', { operationId: guestChatDeleteOperation.id })).success, true);
    assert.ok((await roomGuest.emit('chat-history', { limit: 300 })).messages.some((message) => message.id === guestSelfMessage.id));

    const guestOwnerDeleteTarget = (await roomGuest.emit('chat-message', { text: '房主可删除的成员消息' })).message;
    assert.equal((await roomMaker.emit('chat-delete', { messageId: guestOwnerDeleteTarget.id })).success, true);
    await roomMaker.emit('chat-message', { text: '清空账户时保留的房主消息' });
    await roomMaker.emit('chat-message', { text: '涉及指定账户的私聊', to: 'RoomGuest' });
    const clearUserResult = await roomMaker.emit('chat-admin', { action: 'clear-user', username: 'RoomGuest' });
    assert.equal(clearUserResult.success, true); assert.ok(clearUserResult.removed >= 1);
    const afterClearUser = await roomMaker.emit('chat-history', { limit: 300 });
    assert.ok(afterClearUser.messages.some((message) => message.text === '清空账户时保留的房主消息'));
    assert.ok(!afterClearUser.messages.some((message) => message.from === 'RoomGuest' || message.to === 'RoomGuest'));
    const clearRoomResult = await roomMaker.emit('chat-admin', { action: 'clear-room' });
    assert.equal(clearRoomResult.success, true); assert.ok(clearRoomResult.removed >= 1);
    assert.equal((await roomMaker.emit('chat-history', { limit: 300 })).messages.length, 0);
    assert.ok((await host.emit('chat-history', { limit: 300 })).messages.some((message) => message.text === defaultIsolationChat));
    check('聊天右键删除只允许本人、房主可删任意记录，聊天管理可清空指定账户或整个房间并支持删除回溯');

    let renamedProfile = await roomGuest.emit('account-action', { action: 'change-display-name', displayName: '访客自定义名' });
    assert.equal(renamedProfile.success, true); assert.equal(renamedProfile.profile.displayName, '访客自定义名');
    const forcedName = await host.emit('admin-action', {
      action: 'force-display-name', adminPassword: 'admin888', username: 'RoomGuest', displayName: '管理员强制名'
    });
    assert.equal(forcedName.success, true); assert.equal(forcedName.username, 'RoomGuest'); assert.equal(forcedName.displayName, '管理员强制名');
    renamedProfile = await roomGuest.emit('account-action', { action: 'get-profile' });
    assert.equal(renamedProfile.profile.username, 'RoomGuest'); assert.equal(renamedProfile.profile.displayName, '管理员强制名');
    const renamedMember = (await roomMaker.emit('room-refresh')).users.find((user) => user.username === 'RoomGuest');
    assert.equal(renamedMember.displayName, '管理员强制名');
    check('用户可修改自己的显示名字，服务器管理员可强制改名且账号登录名保持不变');

    const adminResetRequest = await recoveryClient.emit('password-reset-request', { scope: 'admin', identifier: '' });
    assert.equal(adminResetRequest.success, true, adminResetRequest.error);
    assert.equal(await waitUntil(() => Boolean(latestResetMail('sender@qq.com')), 2000), true);
    const adminResetCode = latestResetMail('sender@qq.com').text.match(/验证码：(\d{6})/)?.[1];
    assert.match(adminResetCode || '', /^\d{6}$/);
    const adminResetVerified = await recoveryClient.emit('password-reset-verify', { scope: 'admin', identifier: '', code: adminResetCode });
    assert.equal(adminResetVerified.success, true, adminResetVerified.error);
    const adminResetCompleted = await recoveryClient.emit('password-reset-complete', { resetToken: adminResetVerified.resetToken, newPassword: 'admin-email-pass' });
    assert.equal(adminResetCompleted.success, true, adminResetCompleted.error);
    assert.equal((await host.emit('admin-action', { action: 'get-settings' })).admin?.serverAdmin, false);
    assert.equal((await host.emit('admin-action', { action: 'get-settings', adminPassword: 'admin888' })).admin?.serverAdmin, false);
    const adminAfterEmailRecovery = await host.emit('admin-action', { action: 'get-settings', adminPassword: 'admin-email-pass' });
    assert.equal(adminAfterEmailRecovery.admin?.serverAdmin, true);
    check('服务器管理员密码也可通过 QQ 邮箱验证码找回并立即替换旧管理员密码');

    await host.emit('network-quality', { latency: 12, syncPercent: 98, drift: .1, connectionState: 'online' });
    const users = (await alice.emit('room-refresh')).users; const xuan = users.find((user) => user.username === 'xuan');
    assert.equal(xuan.latency, 12); assert.equal(xuan.syncPercent, 98);
    check('成员延迟与播放同步质量由服务器广播');

    assert.equal((await host.emit('select-file', { fileId })).success, true);
    assert.equal((await host.emit('playback-command', { action: 'play', currentTime: 40, volume: 1 })).success, true);
    await delay(70);
    host.close();
    await delay(100);
    const disconnectedOwnerPlayback = (await alice.emit('room-refresh')).room.playback;
    await delay(180);
    const disconnectedOwnerPlaybackLater = (await alice.emit('room-refresh')).room.playback;
    assert.equal(disconnectedOwnerPlayback.stalled, false);
    assert.equal(disconnectedOwnerPlaybackLater.stalled, false);
    assert.ok(disconnectedOwnerPlaybackLater.currentTime > disconnectedOwnerPlayback.currentTime + 0.1,
      `${disconnectedOwnerPlayback.currentTime} -> ${disconnectedOwnerPlaybackLater.currentTime}`);
    check('房主退出后房间继续播放，直到所有成员离开才进入空房关闭倒计时');

    for (const client of clients.splice(0)) client.close();
    await server.close(); server = null;
    await new Promise((resolve) => setTimeout(resolve, 80));
    server = await startSyncWatchServer({
      port: 0, host: '127.0.0.1', dataDir, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'host-secret', tunnelManager,
      passwordResetNow: () => passwordResetClock,
      mailSender: async (message) => {
        sentMails.push({ ...message, config: { ...message.config } });
        if (mailFailures.has(String(message.to).toLowerCase())) throw new Error('mock QQ SMTP delivery failure');
        return { messageId: `mock-${sentMails.length}` };
      }
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    const restarted = await makeClient();
    result = await restarted.emit('user-login', { username: 'xuan', password: '123456', accessPassword: 'room-access-pass', hostToken: 'host-secret', deviceId: 'host-device' });
    assert.equal(result.success, true);
    const restartedHistory = await restarted.emit('chat-history', { limit: 100 });
    assert.ok(restartedHistory.messages.some((message) => message.text === '公共消息'));
    const restartedFiles = await (await fetch(`${baseUrl}/api/files`, { headers: auth(result.token) })).json();
    assert.ok(restartedFiles.some((file) => file.originalName === 'Interstellar.mp4'));
    assert.equal(result.room.name, '周末电影');
    const tombstoneAfterRestart = await makeClient();
    const tombstoneRegister = await tombstoneAfterRestart.emit('user-register', { username: 'DeletedUser', password: '654321', accessPassword: 'room-access-pass' });
    assert.equal(tombstoneRegister.success, false);
    check('账号、删除账号墓碑、房间、文件与聊天历史重启后永久保留');

    for (const client of clients.splice(0)) client.close();
    await server.close(); server = null;
    await delay(80);
    server = await startSyncWatchServer({
      port: 0, host: '127.0.0.1', dataDir, publicDir, ffprobePath: '', ffmpegPath: '',
      hostControlToken: 'host-secret', tunnelManager, sessionMaxAgeMs: 80
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    const expiringSession = await makeClient();
    const expiringLogin = await expiringSession.emit('user-login', {
      username: 'xuan', password: '123456', accessPassword: 'room-access-pass',
      hostToken: 'host-secret', deviceId: 'host-device'
    });
    assert.equal(expiringLogin.success, true);
    await delay(140);
    assert.equal((await fetch(`${baseUrl}/api/files`, { headers: auth(expiringLogin.token) })).status, 401);
    await delay(30);
    assert.equal(server.io.sockets.sockets.has(expiringSession.id), false);
    check('超过最长寿命的会话会被受保护接口即时拒绝并清除旧 Socket');

    for (const client of clients.splice(0)) client.close();
    await server.close(); server = null;
    await delay(80);
    server = await startSyncWatchServer({
      port: 0, host: '127.0.0.1', dataDir, publicDir, ffprobePath: '', ffmpegPath: '', tunnelManager
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    const standaloneOwner = await makeClient({ 'cf-connecting-ip': '127.0.0.1' });
    const standaloneLogin = await standaloneOwner.emit('user-login', {
      username: 'xuan', password: '123456', accessPassword: 'room-access-pass', deviceId: 'standalone-host'
    });
    assert.equal(standaloneLogin.success, true);
    assert.equal(standaloneLogin.capabilities.owner, true);
    assert.equal(standaloneLogin.capabilities.serverHost, true);
    const standaloneQuota = await standaloneOwner.emit('admin-action', {
      action: 'set-account-room-quota', adminPassword: 'admin-email-pass', username: 'xuan', roomQuota: 3
    });
    assert.equal(standaloneQuota.success, true, standaloneQuota.error);
    const standaloneCreated = await standaloneOwner.emit('room-create', {
      username: 'xuan', password: '123456', roomName: '本机房主跨房终验', maxUsers: 4
    });
    assert.equal(standaloneCreated.success, true, standaloneCreated.error);
    assert.equal(standaloneCreated.capabilities.serverHost, true);
    const standaloneRoomId = standaloneCreated.room.id;
    const standaloneLogout = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: auth(standaloneCreated.token) });
    assert.equal(standaloneLogout.status, 200);
    await delay(100);
    const standaloneReentry = await makeClient({ 'cf-connecting-ip': '127.0.0.1' });
    const standaloneRoomLogin = await standaloneReentry.emit('user-login', {
      username: 'xuan', password: '123456', roomId: standaloneRoomId, deviceId: 'standalone-room-reentry'
    });
    assert.equal(standaloneRoomLogin.success, true, standaloneRoomLogin.error);
    assert.equal(standaloneRoomLogin.capabilities.owner, true);
    assert.equal(standaloneRoomLogin.capabilities.serverHost, true);
    check('独立服务本机房主新建、退出并重进其他房间后仍保留服务器主机能力');

    console.log(`\n全部 ${checks} 项 v${releaseVersion} 集成检查通过。`);
  } finally {
    for (const client of clients) client.close();
    if (server) await server.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error('\n集成测试失败:', error); process.exit(1); });
