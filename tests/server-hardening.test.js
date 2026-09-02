'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const WebSocket = require('ws');
const { startSyncWatchServer, _test } = require('../server');
const { _test: standaloneSettings } = require('../server-standalone');

const publicDir = path.resolve(__dirname, '..', 'public');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const auth = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let testClientIpSequence = 1;
const testRoomSelections = new Map();

function connectClient(baseUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const providedHeaders = options.extraHeaders || {};
    const suffix = ((testClientIpSequence++ - 1) % 200) + 1;
    const extraHeaders = providedHeaders['cf-connecting-ip'] || providedHeaders['x-forwarded-for']
      ? providedHeaders : { 'cf-connecting-ip': `198.51.100.${suffix}`, ...providedHeaders };
    const socket = io(baseUrl, { transports: ['websocket'], reconnection: false, timeout: 10000, forceNew: true, ...options, extraHeaders });
    const timer = setTimeout(() => { socket.close(); reject(new Error('Socket.IO 连接超时')); }, 10000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.syncWatchBaseUrl = baseUrl;
      resolve(socket);
    });
    socket.once('connect_error', (error) => { clearTimeout(timer); socket.close(); reject(error); });
  });
}

function ackRaw(socket, event, payload = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 响应超时`)), timeout);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result); });
  });
}

async function ack(socket, event, payload = {}, timeout = 15000) {
  let normalizedPayload = payload;
  if (event === 'user-login' && payload && !payload.roomId) {
    const selectionKey = `${socket.syncWatchBaseUrl}|${payload.username || ''}`;
    let roomId = testRoomSelections.get(selectionKey) || '';
    if (!roomId) {
      const onlineRooms = await (await fetch(`${socket.syncWatchBaseUrl}/api/online-rooms`)).json();
      const rooms = onlineRooms.rooms || [];
      roomId = rooms.find((room) => !room.passwordRequired)?.id || '';
    }
    normalizedPayload = roomId ? { ...payload, roomId } : payload;
  }
  const result = await ackRaw(socket, event, normalizedPayload, timeout);
  if (['user-login', 'host-admin-login', 'room-create', 'session-resume'].includes(event)
    && result?.success && result.capabilities?.agreementRequired && result.agreement?.version) {
    const accepted = await ackRaw(socket, 'agreement-accept', { accepted: true, version: result.agreement.version }, timeout);
    assert.equal(accepted.success, true, accepted.error);
    result.capabilities.agreementRequired = false;
  }
  if (result?.success && result.room?.id && normalizedPayload?.username) {
    testRoomSelections.set(`${socket.syncWatchBaseUrl}|${normalizedPayload.username}`, result.room.id);
  }
  return result;
}

async function registerAndLogin(socket, username, options = {}) {
  const password = options.password || '123456';
  const registered = await ack(socket, 'user-register', { username, password });
  assert.equal(registered.success, true, registered.error);
  let selectedRoomId = options.roomId || '';
  if (!selectedRoomId) {
    const onlineRooms = await (await fetch(`${socket.syncWatchBaseUrl}/api/online-rooms`)).json();
    selectedRoomId = (onlineRooms.rooms || []).find((room) => !room.passwordRequired)?.id || '';
  }
  if (!selectedRoomId) {
    const created = await ack(socket, 'room-create', {
      username, password, roomName: `${username} 测试房间`, roomPassword: options.createRoomPassword || '', maxUsers: 8,
      hostToken: options.hostToken, deviceId: `${username}-${Date.now()}`
    });
    assert.equal(created.success, true, created.error);
    return created;
  }
  const login = await ack(socket, 'user-login', {
    username, password, roomId: selectedRoomId, roomPassword: options.roomPassword,
    hostToken: options.hostToken, deviceId: `${username}-${Date.now()}`
  });
  assert.equal(login.success, true, login.error);
  return login;
}

function rawSocket(baseUrl, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`, { headers });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('原始 Socket 连接超时')); }, 5000);
    socket.on('message', (data) => {
      const packet = data.toString();
      if (packet.startsWith('0')) socket.send('40');
      else if (packet.startsWith('40')) { clearTimeout(timer); resolve(socket); }
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function navigate(baseUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(baseUrl);
    const request = http.request({
      hostname: target.hostname, port: target.port, path: '/', method: 'GET',
      headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', ...headers }
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

function requestBuffer(baseUrl, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, baseUrl);
    const request = http.request({
      hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`,
      method: 'GET', headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end();
  });
}

function openChunkedUpload(baseUrl, token, filename = 'chunked.mp4') {
  const target = new URL('/api/upload', baseUrl);
  const boundary = `----syncwatch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let request;
  let finish;
  const response = new Promise((resolve) => {
    request = http.request({
      hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Transfer-Encoding': 'chunked' }
    });
    request.on('response', (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
        resolve({ status: incoming.statusCode, payload });
      });
    });
    request.on('error', (error) => resolve({ status: 0, error }));
    request.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`);
    request.write(Buffer.from('0123456789abcdef'));
    finish = () => request.end(`fedcba9876543210\r\n--${boundary}--\r\n`);
  });
  response.request = request;
  response.finish = finish;
  return response;
}

async function testStateConfigFailsClosed() {
  const cases = [
    { name: 'parse', contents: '{"version":6,"accounts":', error: /配置文件解析失败/ },
    { name: 'migration', contents: '[]\n', error: /配置迁移失败/ }
  ];
  for (const entry of cases) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `syncwatch-config-${entry.name}-`));
    const stateFile = path.join(dataDir, 'config.json');
    try {
      fs.writeFileSync(stateFile, entry.contents, 'utf8');
      await assert.rejects(
        () => startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '' }),
        entry.error
      );
      assert.equal(fs.readFileSync(stateFile, 'utf8'), entry.contents, `${entry.name} 失败后不得覆盖原配置`);
      const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith('config.json.corrupt-'));
      assert.equal(backups.length, 1, `${entry.name} 失败应保留一份损坏配置备份`);
      assert.equal(fs.readFileSync(path.join(dataDir, backups[0]), 'utf8'), entry.contents);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  const writeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-config-write-'));
  let initialServer;
  try {
    initialServer = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir: writeDataDir, publicDir, ffprobePath: '', ffmpegPath: '' });
    await initialServer.close(); initialServer = null;
    const stateFile = path.join(writeDataDir, 'config.json');
    const original = fs.readFileSync(stateFile, 'utf8');
    fs.mkdirSync(`${stateFile}.tmp`);
    await assert.rejects(
      () => startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir: writeDataDir, publicDir, ffprobePath: '', ffmpegPath: '' }),
      /配置迁移结果无法写入/
    );
    assert.equal(fs.readFileSync(stateFile, 'utf8'), original, '写盘失败不得覆盖原配置');
    assert.deepEqual(fs.readdirSync(writeDataDir).filter((name) => name.startsWith('config.json.corrupt-')), [], '写盘失败不得误标为损坏配置');
  } finally {
    await initialServer?.close().catch(() => {});
    fs.rmSync(writeDataDir, { recursive: true, force: true });
  }

  assert.equal(standaloneSettings.normalizeSettings({}).port, 20311);
  assert.equal(standaloneSettings.normalizeSettings({ port: 2311 }).port, 20311);
  assert.equal(standaloneSettings.normalizeSettings({ publicUrl: 'https://Example.com/' }).publicUrl, 'https://example.com');
  for (const port of [0, 'abc', 70000, undefined]) {
    assert.throws(() => standaloneSettings.normalizeSettings({ port }), /port 必须是 1-65535/);
  }
  for (const publicUrl of [
    'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/watch',
    'https://example.com?room=1', 'https://example.com/#room', 'https://example.com/watch/..'
  ]) {
    assert.throws(() => standaloneSettings.normalizeSettings({ publicUrl }), /publicUrl/);
  }
  const originalArgv = process.argv;
  try {
    process.argv = ['node', 'server-standalone.js', '--trusted-proxies=172.18.0.0/16,10.0.0.5'];
    assert.equal(standaloneSettings.commandLineValue('trusted-proxies'), '172.18.0.0/16,10.0.0.5');
    process.argv = ['node', 'server-standalone.js', '--trusted-proxies', '172.19.0.0/16'];
    assert.equal(standaloneSettings.commandLineValue('trusted-proxies'), '172.19.0.0/16');
  } finally {
    process.argv = originalArgv;
  }
  console.log('✓ config.json 解析/迁移/写盘失败均 fail closed，独立服务器端口和 publicUrl 严格校验');
}

async function testDataDirectorySingleInstanceLock() {
  const sharedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-single-instance-'));
  const independentDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-independent-instance-'));
  const lockPath = path.join(sharedDataDir, '.syncwatch-instance.lock');
  let first;
  let independent;
  let replacement;
  try {
    first = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir: sharedDataDir, publicDir, ffprobePath: '', ffmpegPath: '' });
    assert.equal(fs.existsSync(path.join(lockPath, 'owner.json')), true);
    await assert.rejects(
      () => startSyncWatchServer({
        host: '127.0.0.1', port: first.port + 1, strictPort: true, dataDir: sharedDataDir, publicDir, ffprobePath: '', ffmpegPath: ''
      }),
      (error) => /数据目录.*正在被另一个 SyncWatch同步观影 实例占用/.test(error.message)
        && error.message.includes(`PID ${process.pid}`) && /不同的 SyncWatch同步观影-Data 目录/.test(error.message)
    );

    independent = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir: independentDataDir, publicDir, ffprobePath: '', ffmpegPath: ''
    });
    assert.notEqual(independent.dataDir, first.dataDir, '不同数据目录必须允许并行运行');

    await first.close(); first = null;
    assert.equal(fs.existsSync(lockPath), false, '正常 close 必须释放数据目录锁');
    replacement = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir: sharedDataDir, publicDir, ffprobePath: '', ffmpegPath: '' });
    await replacement.close(); replacement = null;
    assert.equal(fs.existsSync(lockPath), false);

    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
      version: 1,
      pid: 2147483647,
      hostname: os.hostname(),
      token: 'crashed-instance-token-1234567890',
      dataDirectory: path.resolve(sharedDataDir),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      processStartMarker: ''
    }, null, 2)}\n`, 'utf8');
    replacement = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir: sharedDataDir, publicDir, ffprobePath: '', ffmpegPath: '' });
    const recoveredOwner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    assert.equal(recoveredOwner.pid, process.pid);
    assert.notEqual(recoveredOwner.token, 'crashed-instance-token-1234567890');
    await replacement.close(); replacement = null;
    assert.equal(fs.existsSync(lockPath), false, '回收崩溃遗留锁后的实例仍须正常释放锁');

    // Android can reuse a stale PID for an unrelated process. A lock whose
    // heartbeat stopped long enough ago must be reclaimed even when that PID
    // is currently alive; otherwise the APK remains permanently blocked after
    // a force-stop/restart cycle.
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
      version: 1,
      pid: process.pid,
      hostname: os.hostname(),
      token: 'reused-pid-stale-token-1234567890',
      dataDirectory: path.resolve(sharedDataDir),
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
      processStartMarker: ''
    }, null, 2)}\n`, 'utf8');
    replacement = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir: sharedDataDir, publicDir, ffprobePath: '', ffmpegPath: '' });
    const reusedPidOwner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    assert.equal(reusedPidOwner.pid, process.pid);
    assert.notEqual(reusedPidOwner.token, 'reused-pid-stale-token-1234567890');
    await replacement.close(); replacement = null;
    assert.equal(fs.existsSync(lockPath), false);
    console.log('✓ 同一 SyncWatch同步观影-Data 在不同端口也只允许单实例写入，独立数据目录可并行，正常关闭释放且崩溃遗留锁可安全回收');
  } finally {
    await first?.close().catch(() => {});
    await independent?.close().catch(() => {});
    await replacement?.close().catch(() => {});
    fs.rmSync(sharedDataDir, { recursive: true, force: true });
    fs.rmSync(independentDataDir, { recursive: true, force: true });
  }
}

async function testCaptureTimeout() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 43210;
  child.exitCode = null; child.signalCode = null; child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return true; };
  const tracker = new Set();
  const started = Date.now();
  await assert.rejects(
    _test.captureProcess('fake', [], 20, tracker, { spawnImpl: () => child, platform: 'linux', terminationGraceMs: 20 }),
    /超过 20ms/
  );
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(tracker.size, 0);
  console.log('✓ 媒体分析子进程超时后会强制终止并在有界时间释放任务槽');
}

async function testPrivateChatOperationPrivacy() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-private-history-'));
  let server; let owner; let alice; let bob;
  try {
    server = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'privacy-host' });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    owner = await connectClient(baseUrl); alice = await connectClient(baseUrl); bob = await connectClient(baseUrl);
    await registerAndLogin(owner, 'PrivacyOwner', { hostToken: 'privacy-host' });
    await registerAndLogin(alice, 'PrivacyAlice');
    await registerAndLogin(bob, 'PrivacyBob');
    const secret = '只有私聊双方可见的秘密内容';
    const sent = await ack(alice, 'chat-message', { type: 'text', to: 'PrivacyBob', text: secret });
    assert.equal(sent.success, true, sent.error);
    assert.equal((await ack(alice, 'chat-delete', { messageId: sent.message.id })).success, true);
    const history = await ack(owner, 'operation-history', { limit: 200 });
    assert.equal(history.success, true, history.error);
    const deletion = history.operations.find((item) => item.action === 'chat-delete' && item.actor === 'PrivacyAlice');
    assert.ok(deletion, '房主应能看到不含正文的删除操作');
    assert.equal(deletion.summary.includes(secret), false);
    assert.match(deletion.summary, /私聊/);
    const ownerHistory = await ack(owner, 'chat-history', { limit: 100 });
    assert.equal(ownerHistory.messages.some((message) => message.text === secret), false);
    console.log('✓ 私聊删除操作历史不泄露消息正文，房主仍无法读取他人私聊');
  } finally {
    owner?.close(); alice?.close(); bob?.close(); await server?.close().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testConcurrentRegistrationClaims() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-register-race-'));
  const sentMails = [];
  let server; let first; let second;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '',
      hostControlToken: 'register-race-host',
      mailSender: async (message) => { sentMails.push(message); return { messageId: `race-mail-${sentMails.length}` }; },
      mailVerifier: async () => true
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    first = await connectClient(baseUrl); second = await connectClient(baseUrl);
    const sameUsername = await Promise.all([
      ack(first, 'user-register', { username: 'RaceAccount', password: 'race-pass-one' }),
      ack(second, 'user-register', { username: 'RaceAccount', password: 'race-pass-two' })
    ]);
    assert.equal(sameUsername.filter((item) => item.success).length, 1);
    const winnerIndex = sameUsername.findIndex((item) => item.success);
    const winningPassword = winnerIndex === 0 ? 'race-pass-one' : 'race-pass-two';
    const losingPassword = winnerIndex === 0 ? 'race-pass-two' : 'race-pass-one';
    const winnerSocket = winnerIndex === 0 ? first : second;
    const loserSocket = winnerIndex === 0 ? second : first;
    const winnerRoom = await ack(winnerSocket, 'room-create', {
      username: 'RaceAccount', password: winningPassword, roomName: '并发注册胜者房间', maxUsers: 4,
      hostToken: 'register-race-host'
    });
    assert.equal(winnerRoom.success, true, winnerRoom.error);
    assert.equal((await ack(loserSocket, 'user-login', { username: 'RaceAccount', password: losingPassword, roomId: winnerRoom.room.id })).success, false);

    const mailSettings = await ack(winnerSocket, 'admin-action', {
      action: 'set-mail-settings', adminPassword: 'admin888', enabled: true,
      host: 'smtp.example.com', port: 465, secure: true, useTls: true,
      user: 'sender@example.com', password: 'race-mail-secret', fromEmail: 'sender@example.com',
      registrationVerificationEnabled: false
    });
    assert.equal(mailSettings.success, true, mailSettings.error);
    const emailCodeRequested = await ack(first, 'registration-email-code-request', {
      username: 'EmailRaceOne', email: 'same-race@example.com'
    });
    assert.equal(emailCodeRequested.success, true, emailCodeRequested.error);
    const emailCode = String(sentMails.at(-1)?.text || '').match(/验证码：(\d{6})/)?.[1];
    assert.match(emailCode || '', /^\d{6}$/);

    const sameEmail = await Promise.all([
      ack(first, 'user-register', { username: 'EmailRaceOne', password: '123456', email: 'same-race@example.com', emailVerificationCode: emailCode }),
      ack(second, 'user-register', { username: 'EmailRaceTwo', password: '123456', email: 'same-race@example.com', emailVerificationCode: emailCode })
    ]);
    assert.equal(sameEmail.filter((item) => item.success).length, 1);
    console.log('✓ 并发同名或同邮箱注册仅一个成功，失败请求不能覆盖最终账号密码和 ID');
  } finally {
    first?.close(); second?.close(); await server?.close().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testConcurrentRoomCreationClaims() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-room-create-race-'));
  let server; let first; let second; let loggedIn;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'room-race-host'
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    first = await connectClient(baseUrl); second = await connectClient(baseUrl); loggedIn = await connectClient(baseUrl);

    const guestRegistered = await ack(first, 'user-register', { username: 'RoomRaceGuest', password: '123456' });
    assert.equal(guestRegistered.success, true, guestRegistered.error);
    const guestResults = await Promise.all([
      ack(first, 'room-create', { username: 'RoomRaceGuest', password: '123456', roomName: '游客并发房间一', roomPassword: 'guest-room-one' }),
      ack(second, 'room-create', { username: 'RoomRaceGuest', password: '123456', roomName: '游客并发房间二', roomPassword: 'guest-room-two' })
    ]);
    assert.equal(guestResults.filter((item) => item.success).length, 1);
    const guestSuccess = guestResults.find((item) => item.success);
    const guestFailure = guestResults.find((item) => !item.success);
    assert.match(guestFailure.error, /正在创建房间|已在另一台设备登录/);
    const guestWinner = guestResults[0].success ? first : second;
    const guestRoom = await ack(guestWinner, 'room-refresh');
    assert.equal(guestRoom.success, true, guestRoom.error);
    assert.equal(guestRoom.users.length, 1);
    assert.equal(guestRoom.users[0].username, 'RoomRaceGuest');

    const guestRoomPassword = guestResults[0].success ? 'guest-room-one' : 'guest-room-two';
    await registerAndLogin(loggedIn, 'RoomRaceLogged', { roomId: guestSuccess.room.id, roomPassword: guestRoomPassword });
    const loggedResults = await Promise.all([
      ack(loggedIn, 'room-create', { roomName: '登录并发房间一', roomPassword: 'logged-room-one' }),
      ack(loggedIn, 'room-create', { roomName: '登录并发房间二', roomPassword: 'logged-room-two' })
    ]);
    assert.equal(loggedResults.filter((item) => item.success).length, 1);
    const loggedSuccess = loggedResults.find((item) => item.success);
    const loggedFailure = loggedResults.find((item) => !item.success);
    assert.match(loggedFailure.error, /正在创建房间/);
    const loggedRoom = await ack(loggedIn, 'room-refresh');
    assert.equal(loggedRoom.success, true, loggedRoom.error);
    assert.equal(loggedRoom.users.length, 1);
    assert.equal(loggedRoom.users[0].username, 'RoomRaceLogged');

    first.close(); second.close(); loggedIn.close(); first = null; second = null; loggedIn = null;
    await server.close(); server = null;
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const guestRooms = Object.values(state.rooms).filter((room) => room.ownerUsername === 'RoomRaceGuest');
    const loggedRooms = Object.values(state.rooms).filter((room) => room.ownerUsername === 'RoomRaceLogged');
    assert.equal(guestRooms.length, 1);
    assert.equal(loggedRooms.length, 1);
    assert.equal(guestRooms[0].id, guestSuccess.room.id);
    assert.equal(loggedRooms[0].id, loggedSuccess.room.id);
    assert.equal(state.accounts.RoomRaceGuest.stats.createdRooms, 1);
    assert.equal(state.accounts.RoomRaceLogged.stats.createdRooms, 1);
    assert.equal(Object.keys(state.rooms).length, 3, '除初始房间和两个成功房间外不应存在孤儿房间');
    console.log('✓ 未登录双客户端及已登录同客户端并发建房都只会成功一次，不会产生孤儿房间或重复统计');
  } finally {
    first?.close(); second?.close(); loggedIn?.close(); await server?.close().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testServerHostRoomReentryPlaybackContext() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-host-room-reentry-'));
  let server; let host; let defaultGuest;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '',
      hostControlToken: 'room-reentry-host'
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    host = await connectClient(baseUrl);
    let login = await registerAndLogin(host, 'RoomReentryOwner', { hostToken: 'room-reentry-host' });
    const defaultRoomId = login.room.id;

    const defaultForm = new FormData();
    defaultForm.append('file', new Blob([Buffer.from('default-room-video')], { type: 'video/mp4' }), 'default-room.mp4');
    const defaultUpload = await (await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: auth(login.token), body: defaultForm
    })).json();
    assert.equal(defaultUpload.success, true, defaultUpload.error);
    assert.equal(defaultUpload.file.roomId, defaultRoomId);
    assert.equal(defaultUpload.file.status, 'approved');

    const quota = await ack(host, 'admin-action', {
      action: 'set-account-room-quota', adminPassword: 'admin888', username: 'RoomReentryOwner', roomQuota: 2
    });
    assert.equal(quota.success, true, quota.error);

    const created = await ack(host, 'room-create', {
      username: 'RoomReentryOwner', password: '123456', roomName: '切房回归测试'
    });
    assert.equal(created.success, true, created.error);
    assert.equal(created.capabilities.serverHost, true, '服务器主机新建房间后不应丢失主机能力');
    const secondaryRoomId = created.room.id;
    defaultGuest = await connectClient(baseUrl);
    const defaultGuestLogin = await registerAndLogin(defaultGuest, 'RoomReentryGuest', { roomId: defaultRoomId });
    assert.equal(defaultGuestLogin.room.id, defaultRoomId);

    const secondaryUploadRequest = openChunkedUpload(baseUrl, created.token, 'secondary-room.mp4');
    await delay(40);
    const defaultFilesDuringUpload = await (await fetch(`${baseUrl}/api/files`, { headers: auth(defaultGuestLogin.token) })).json();
    assert.ok(defaultFilesDuringUpload.every((file) => file.roomId === defaultRoomId));
    secondaryUploadRequest.finish();
    const secondaryUploadResponse = await secondaryUploadRequest;
    assert.equal(secondaryUploadResponse.status, 200, secondaryUploadResponse.error?.message);
    const secondaryUpload = secondaryUploadResponse.payload;
    assert.equal(secondaryUpload.success, true, secondaryUpload.error);
    assert.equal(secondaryUpload.file.roomId, secondaryRoomId);
    assert.equal(secondaryUpload.file.status, 'approved');
    const secondaryOperations = await ack(host, 'operation-history', { limit: 100 });
    assert.ok(secondaryOperations.operations.some((operation) => operation.action === 'file-upload' && operation.summary.includes('secondary-room.mp4')));

    const voiceForm = new FormData();
    voiceForm.append('voice', new Blob([Buffer.from('secondary-room-voice')], { type: 'audio/webm' }), 'secondary-room.webm');
    const voiceResponse = await fetch(`${baseUrl}/api/voice`, { method: 'POST', headers: auth(created.token), body: voiceForm });
    assert.equal(voiceResponse.status, 200);
    const voice = await voiceResponse.json();
    assert.equal(voice.success, true, voice.error);
    assert.equal(voice.message.roomId, secondaryRoomId);
    assert.equal((await fetch(`${baseUrl}${voice.message.voiceUrl}`, { headers: auth(created.token) })).status, 200);
    assert.equal((await fetch(`${baseUrl}${voice.message.voiceUrl}`, { headers: auth(defaultGuestLogin.token) })).status, 404);

    login = await ack(host, 'user-login', {
      username: 'RoomReentryOwner', password: '123456', roomId: defaultRoomId,
      deviceId: 'room-reentry-default'
    });
    assert.equal(login.success, true, login.error);
    assert.equal(login.user.roomId, defaultRoomId);
    assert.equal(login.room.id, defaultRoomId, '切回默认房时认证回执不得保留旧房间上下文');
    assert.equal(login.capabilities.serverHost, true);
    assert.equal(login.capabilities.owner, true);
    const defaultFiles = await (await fetch(`${baseUrl}/api/files`, { headers: auth(login.token) })).json();
    assert.ok(defaultFiles.some((file) => file.id === defaultUpload.file.id));
    assert.ok(defaultFiles.every((file) => file.roomId === defaultRoomId));
    assert.equal((await ack(host, 'select-file', { fileId: defaultUpload.file.id })).success, true);
    const foreignSelection = await ack(host, 'select-file', { fileId: secondaryUpload.file.id });
    assert.equal(foreignSelection.success, false);
    assert.equal(foreignSelection.code, 'MEDIA_NOT_AVAILABLE_IN_ROOM');

    login = await ack(host, 'user-login', {
      username: 'RoomReentryOwner', password: '123456', roomId: secondaryRoomId,
      deviceId: 'room-reentry-secondary'
    });
    assert.equal(login.success, true, login.error);
    assert.equal(login.user.roomId, secondaryRoomId);
    assert.equal(login.room.id, secondaryRoomId, '再次进入当前房间时认证回执必须与会话房间一致');
    assert.equal(login.capabilities.serverHost, true, '同一服务器主机会话切换房间时不得丢失主机能力');
    const secondaryFiles = await (await fetch(`${baseUrl}/api/files`, { headers: auth(login.token) })).json();
    assert.ok(secondaryFiles.some((file) => file.id === secondaryUpload.file.id));
    assert.ok(secondaryFiles.every((file) => file.roomId === secondaryRoomId));
    assert.equal((await ack(host, 'select-file', { fileId: secondaryUpload.file.id })).success, true);
    console.log('✓ 新房间真实异步上传和语音消息显式绑定会话房间，服务器启动者切房后的身份、文件及播放上下文保持一致');
  } finally {
    host?.close(); defaultGuest?.close(); await server?.close().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testRoomCapacityOwnerAndServerHostExemptions() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-room-capacity-'));
  const sockets = [];
  let server;
  const connect = async (baseUrl) => {
    const socket = await connectClient(baseUrl);
    sockets.push(socket);
    return socket;
  };
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '',
      hostControlToken: 'capacity-host-token'
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const owner = await connect(baseUrl);
    const ownerLogin = await registerAndLogin(owner, 'RoomCapacityOwner', { hostToken: 'capacity-host-token' });
    assert.equal((await ack(owner, 'admin-action', { action: 'set-room', roomName: '容量测试房', maxUsers: 2 })).success, true);

    const memberOne = await connect(baseUrl);
    const memberTwo = await connect(baseUrl);
    const memberThree = await connect(baseUrl);
    const hostManager = await connect(baseUrl);
    for (const [socket, username] of [
      [memberOne, 'RoomCapacityOne'], [memberTwo, 'RoomCapacityTwo'],
      [memberThree, 'RoomCapacityThree'], [hostManager, 'RoomCapacityHost']
    ]) {
      const registration = await ack(socket, 'user-register', { username, password: '123456' });
      assert.equal(registration.success, true, registration.error);
    }

    const logout = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: auth(ownerLogin.token) });
    assert.equal(logout.status, 200);
    await delay(100);
    assert.equal((await ack(memberOne, 'user-login', { username: 'RoomCapacityOne', password: '123456' })).success, true);
    assert.equal((await ack(memberTwo, 'user-login', { username: 'RoomCapacityTwo', password: '123456' })).success, true);
    assert.equal((await ack(memberOne, 'room-refresh')).users.length, 2);

    const ownerReentry = await connect(baseUrl);
    const ownerReturn = await ack(ownerReentry, 'user-login', { username: 'RoomCapacityOwner', password: '123456' });
    assert.equal(ownerReturn.success, true, ownerReturn.error);
    assert.equal(ownerReturn.capabilities.owner, true);
    assert.equal(ownerReturn.capabilities.serverHost, false);

    const hostReturn = await ack(hostManager, 'user-login', {
      username: 'RoomCapacityHost', password: '123456', hostToken: 'capacity-host-token'
    });
    assert.equal(hostReturn.success, true, hostReturn.error);
    assert.equal(hostReturn.capabilities.serverHost, true);
    assert.equal(hostReturn.capabilities.owner, true);
    const management = await ack(hostManager, 'admin-action', { action: 'set-room', roomName: '主机接管容量房', maxUsers: 2 });
    assert.equal(management.success, true, management.error);

    const ordinaryOverflow = await ack(memberThree, 'user-login', { username: 'RoomCapacityThree', password: '123456' });
    assert.equal(ordinaryOverflow.success, false);
    assert.match(ordinaryOverflow.error, /房间人数已满/);
    console.log('✓ 当前房主及有效服务器主机可在满房时进入默认房管理，普通成员仍严格受人数上限限制');
  } finally {
    for (const socket of sockets) socket.close();
    await server?.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testPermanentHistoryAndPagination() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-history-hardening-'));
  let server; let socket;
  const registrationSockets = [];
  try {
    server = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'history-host' });
    let baseUrl = `http://127.0.0.1:${server.port}`;
    socket = await connectClient(baseUrl);
    const login = await registerAndLogin(socket, 'HistoryOwner', { hostToken: 'history-host' });
    const roomId = login.room.id;
    for (const username of ['HistoryArchived', 'HistorySecretA', 'HistorySecretB']) {
      const registrationSocket = await connectClient(baseUrl);
      registrationSockets.push(registrationSocket);
      const registered = await ack(registrationSocket, 'user-register', { username, password: '123456' });
      assert.equal(registered.success, true, registered.error);
    }
    for (const registrationSocket of registrationSockets.splice(0)) registrationSocket.close();
    socket.close(); socket = null; await server.close(); server = null;

    const stateFile = path.join(dataDir, 'config.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const synthetic = Array.from({ length: 2505 }, (_, index) => ({
      id: `history-op-${String(index).padStart(4, '0')}`, roomId, actor: 'HistoryOwner', actorName: 'HistoryOwner',
      action: 'synthetic', summary: `历史记录 ${index}`, createdAt: new Date(1700000000000 + index).toISOString(), scope: 'room', undo: null, undone: false
    }));
    state.operations.push(...synthetic);
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    const baseMessages = Array.from({ length: 3505 }, (_, index) => ({
      id: `history-chat-${String(index).padStart(4, '0')}`, roomId, type: 'text', from: 'HistoryOwner', fromName: 'HistoryOwner',
      to: null, toName: null, text: `永久聊天 ${index}`, voiceUrl: '', timestamp: new Date(1710000000000 + index * 1000).toISOString()
    }));
    const sameTimestamp = new Date(1710004000000).toISOString();
    const sameMillisecondMessages = Array.from({ length: 650 }, (_, index) => ({
      id: `same-ms-chat-${String(index).padStart(4, '0')}`, roomId, type: 'text', from: 'HistoryOwner', fromName: 'HistoryOwner',
      to: null, toName: null, text: `同毫秒聊天 ${index}`, voiceUrl: '', timestamp: sameTimestamp
    }));
    const archivedMessage = {
      id: 'history-archived-account', roomId, type: 'text', from: 'HistoryArchived', fromName: '离线历史成员',
      to: null, toName: null, text: '旧于客户端首屏的离线账户消息', voiceUrl: '', timestamp: new Date(1709999998000).toISOString()
    };
    const privateSecret = '不应泄露给房主的历史私聊正文';
    const privateMessage = {
      id: 'history-private-secret', roomId, type: 'text', from: 'HistorySecretA', fromName: '历史私聊甲',
      to: 'HistorySecretB', toName: '历史私聊乙', text: privateSecret, voiceUrl: '', timestamp: new Date(1709999999000).toISOString()
    };
    const messages = [archivedMessage, privateMessage, ...baseMessages, ...sameMillisecondMessages];
    fs.writeFileSync(path.join(dataDir, 'chat-history.jsonl'), `${messages.map(JSON.stringify).join('\n')}\n`);

    server = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'history-host' });
    baseUrl = `http://127.0.0.1:${server.port}`;
    socket = await connectClient(baseUrl);
    const relogin = await ack(socket, 'user-login', { username: 'HistoryOwner', password: '123456', hostToken: 'history-host' });
    assert.equal(relogin.success, true, relogin.error);

    const operationIds = [];
    let before = '';
    do {
      const page = await ack(socket, 'operation-history', { limit: 500, before });
      assert.equal(page.success, true, page.error);
      operationIds.push(...page.operations.map((item) => item.id));
      assert.equal(page.nextBefore, page.nextBeforeId);
      before = page.nextBefore;
      if (!page.hasMore) break;
    } while (before);
    assert.ok(operationIds.includes('history-op-0000'), '第 501 条以前的操作必须可继续分页读取');
    const currentState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const persistedOperationIds = currentState.operations.filter((item) => item.roomId === roomId).map((item) => item.id);
    assert.equal(new Set(operationIds).size, operationIds.length, '操作历史分页不能返回重复记录');
    assert.equal(persistedOperationIds.every((id) => operationIds.includes(id)), true, '持久化操作历史必须全部可分页读取');

    const liveHistory = await ack(socket, 'chat-history', { limit: 20 });
    assert.equal(liveHistory.success, true, liveHistory.error);
    assert.ok(liveHistory.messages.some((message) => message.type === 'system'
      && message.systemKind === 'member-join' && message.actor === 'HistoryOwner'),
    '重新登录产生的成员进入记录必须继续写入并可从聊天历史读取');

    // The relogin above intentionally appends a newer system message. Bound the
    // synthetic pagination fixture to one millisecond after its shared timestamp
    // so this test verifies the cursor boundary instead of assuming a quiet room.
    const syntheticHistoryBoundary = new Date(Date.parse(sameTimestamp) + 1).toISOString();
    const latestChat = await ack(socket, 'chat-history', { limit: 300, before: syntheticHistoryBoundary });
    assert.equal(latestChat.success, true, latestChat.error);
    assert.equal(latestChat.messages.at(-1).id, 'same-ms-chat-0649');
    assert.equal(latestChat.nextBeforeId, 'same-ms-chat-0350');
    assert.equal(latestChat.nextBefore, sameTimestamp);
    const middleChat = await ack(socket, 'chat-history', {
      limit: 300, beforeId: latestChat.nextBeforeId, before: latestChat.nextBefore
    });
    assert.equal(middleChat.success, true, middleChat.error);
    assert.equal(middleChat.messages[0].id, 'same-ms-chat-0050');
    assert.equal(middleChat.messages.at(-1).id, 'same-ms-chat-0349');
    assert.equal(middleChat.nextBeforeId, 'same-ms-chat-0050');
    const earlierChat = await ack(socket, 'chat-history', {
      limit: 300, beforeId: middleChat.nextBeforeId, before: middleChat.nextBefore
    });
    assert.equal(earlierChat.success, true, earlierChat.error);
    const burstIds = [...latestChat.messages, ...middleChat.messages, ...earlierChat.messages]
      .filter((item) => item.id.startsWith('same-ms-chat-')).map((item) => item.id);
    assert.equal(new Set(burstIds).size, 650, '同一毫秒跨页聊天不能重复或遗漏');

    const oldestChat = await ack(socket, 'chat-history', { limit: 300, before: baseMessages[0].timestamp });
    assert.equal(oldestChat.success, true, oldestChat.error);
    assert.deepEqual(oldestChat.messages.map((item) => item.id), ['history-archived-account']);
    assert.equal(JSON.stringify(oldestChat).includes(privateSecret), false);

    const managedMessageIds = [];
    let managedBeforeId = '';
    let managedBefore = '';
    do {
      const page = await ack(socket, 'chat-admin', {
        action: 'list-messages', limit: 300, beforeId: managedBeforeId, before: managedBefore
      });
      assert.equal(page.success, true, page.error);
      assert.equal(JSON.stringify(page).includes(privateSecret), false, '聊天管理分页不能读取其他账户的私聊正文');
      managedMessageIds.push(...page.messages.map((item) => item.id));
      managedBeforeId = page.nextBeforeId;
      managedBefore = page.nextBefore;
      if (!page.hasMore) break;
    } while (managedBeforeId || managedBefore);
    assert.ok(managedMessageIds.includes('history-chat-0000'), '聊天管理页必须能独立翻到首屏以前的旧消息');
    assert.ok(managedMessageIds.includes('history-archived-account'), '聊天管理页必须能读取离线历史账户的可见旧消息');
    const fixtureMessageIds = new Set(messages.map((item) => item.id));
    const persistedSystemIds = managedMessageIds.filter((id) => !fixtureMessageIds.has(id));
    assert.ok(persistedSystemIds.length >= 1, '成员进入/退出系统消息必须保留在聊天管理历史中');
    assert.equal(new Set(managedMessageIds).size, messages.length - 1 + persistedSystemIds.length,
      '聊天管理精确分页不能重复、漏掉可见消息或泄露他人私聊');
    const managedBurstIds = managedMessageIds.filter((id) => id.startsWith('same-ms-chat-'));
    assert.equal(new Set(managedBurstIds).size, 650, '聊天管理页同一毫秒跨页不能重复或遗漏');

    const archivedManagedPage = await ack(socket, 'chat-admin', { action: 'list-messages', username: 'HistoryArchived', limit: 20 });
    assert.equal(archivedManagedPage.success, true, archivedManagedPage.error);
    assert.deepEqual(archivedManagedPage.messages.map((item) => item.id), ['history-archived-account']);
    const privateManagedPage = await ack(socket, 'chat-admin', { action: 'list-messages', username: 'HistorySecretA', limit: 20 });
    assert.equal(privateManagedPage.success, true, privateManagedPage.error);
    assert.deepEqual(privateManagedPage.messages, [], '房主可以清理私聊账户，但不能在管理列表读取他人私聊正文');

    const deleteManagedOldMessage = await ack(socket, 'chat-admin', { action: 'delete-message', messageId: 'history-chat-0000' });
    assert.equal(deleteManagedOldMessage.success, true, deleteManagedOldMessage.error);
    assert.equal(deleteManagedOldMessage.removed, 1, '聊天管理页必须能删除分页加载到的指定旧消息');

    let managedAccounts = await ack(socket, 'chat-admin', { action: 'list-accounts' });
    assert.equal(managedAccounts.success, true, managedAccounts.error);
    assert.deepEqual(
      ['HistoryArchived', 'HistoryOwner', 'HistorySecretA', 'HistorySecretB'].filter((username) => !managedAccounts.accounts.some((item) => item.username === username)),
      [],
      '房主应能看到当前房间全部离线历史参与账户'
    );
    assert.equal(Object.hasOwn(managedAccounts, 'messages'), false);
    assert.equal(JSON.stringify(managedAccounts).includes(privateSecret), false, '历史账户列表不能夹带私聊正文');
    const clearArchived = await ack(socket, 'chat-admin', { action: 'clear-user', username: 'HistoryArchived' });
    assert.equal(clearArchived.success, true, clearArchived.error); assert.equal(clearArchived.removed, 1);
    const clearPrivate = await ack(socket, 'chat-admin', { action: 'clear-user', username: 'HistorySecretA' });
    assert.equal(clearPrivate.success, true, clearPrivate.error); assert.equal(clearPrivate.removed, 1);
    assert.equal(JSON.stringify(clearPrivate).includes(privateSecret), false);
    managedAccounts = await ack(socket, 'chat-admin', { action: 'list-accounts' });
    assert.equal(managedAccounts.accounts.some((item) => ['HistoryArchived', 'HistorySecretA', 'HistorySecretB'].includes(item.username)), false);
    const chatAdminOperations = await ack(socket, 'operation-history', { limit: 200 });
    assert.equal(JSON.stringify(chatAdminOperations).includes(privateSecret), false, '聊天管理审计不能泄露私聊正文');

    socket.close(); socket = null; await server.close(); server = null;
    // The private fixture is physically persisted in chat-history.jsonl even
    // though it is intentionally hidden from the room-owner's management
    // listing. It is removed by clear-user below, so the file count starts
    // from the complete fixture set (plus runtime system messages), then
    // subtracts the three records explicitly deleted in this test.
    assert.equal(fs.readFileSync(path.join(dataDir, 'chat-history.jsonl'), 'utf8').trim().split('\n').length,
      messages.length + persistedSystemIds.length - 3);
    assert.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).operations.length >= state.operations.length + 3);
    console.log('✓ 聊天及管理页使用精确 ID 游标，房主可翻页删除旧记录、管理离线账户且不会读取他人私聊正文');
  } finally {
    socket?.close(); for (const registrationSocket of registrationSockets) registrationSocket.close();
    await server?.close().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testRoomsTunnelVoiceAndTrash() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-room-trash-hardening-'));
  let tunnelState = { state: 'stopped' };
  const tunnelManager = {
    status: async () => tunnelState,
    start: async () => (tunnelState = { state: 'running', publicUrl: 'https://hardening.trycloudflare.com' }),
    stop: async () => (tunnelState = { state: 'stopped' })
  };
  let server; let owner; let observer;
  try {
    server = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'room-host', tunnelManager });
    let baseUrl = `http://127.0.0.1:${server.port}`;
    owner = await connectClient(baseUrl); observer = await connectClient(baseUrl);
    let ownerLogin = await registerAndLogin(owner, 'RoomOwner', { hostToken: 'room-host' });
    const defaultRoomId = ownerLogin.room.id;
    await registerAndLogin(observer, 'RoomObserver');

    const form = new FormData(); form.append('file', new Blob([Buffer.from('video-data')], { type: 'video/mp4' }), 'freeze.mp4');
    const uploaded = await (await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(ownerLogin.token), body: form })).json();
    assert.equal(uploaded.success, true, uploaded.error);
    assert.equal((await ack(owner, 'select-file', { fileId: uploaded.file.id })).success, true);
    assert.equal((await ack(owner, 'playback-command', { action: 'play', currentTime: 2 })).success, true);
    await delay(60);
    const quota = await ack(owner, 'admin-action', {
      action: 'set-account-room-quota',
      adminPassword: 'admin888',
      username: 'RoomOwner',
      roomQuota: 4
    });
    assert.equal(quota.success, true, quota.error);
    const created = await ack(owner, 'room-create', { username: 'RoomOwner', password: '123456', roomName: '未加密房间', maxUsers: 8, hostToken: 'room-host' });
    assert.equal(created.success, true, created.error);
    const unprotectedRoomId = created.room.id;
    await delay(30);
    const oldRoom = await ack(observer, 'room-refresh');
    assert.equal(oldRoom.room.playback.stalled, false);
    const continuedAt = oldRoom.room.playback.currentTime;
    await delay(80);
    assert.ok((await ack(observer, 'room-refresh')).room.playback.currentTime > continuedAt + 0.05);

    ownerLogin = await ack(owner, 'user-login', { username: 'RoomOwner', password: '123456', roomId: defaultRoomId, hostToken: 'room-host' });
    assert.equal(ownerLogin.success, true, ownerLogin.error);
    assert.equal((await ack(owner, 'admin-action', { action: 'set-access-password', accessPassword: 'default-pass' })).success, true);
    let tunnelResponse = await fetch(`${baseUrl}/api/host/tunnel/start`, {
      method: 'POST', headers: auth(ownerLogin.token, { 'Content-Type': 'application/json' }), body: '{}'
    });
    let tunnel = await tunnelResponse.json();
    assert.equal(tunnelResponse.status, 409);
    assert.equal(tunnel.success, false);
    assert.equal(tunnel.code, 'PUBLIC_ROOMS_UNPROTECTED');
    assert.equal(tunnel.requiresConfirmation, true);
    assert.match(tunnel.error, new RegExp(unprotectedRoomId));

    tunnelResponse = await fetch(`${baseUrl}/api/host/tunnel/start`, {
      method: 'POST', headers: auth(ownerLogin.token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ confirmUnprotectedRooms: true })
    });
    tunnel = await tunnelResponse.json();
    assert.equal(tunnelResponse.status, 200);
    assert.equal(tunnel.success, true, tunnel.error);

    ownerLogin = await ack(owner, 'user-login', { username: 'RoomOwner', password: '123456', roomId: unprotectedRoomId, hostToken: 'room-host' });
    assert.equal(ownerLogin.success, true, ownerLogin.error);
    assert.equal((await ack(owner, 'admin-action', { action: 'set-access-password', accessPassword: 'room-pass' })).success, true);
    const clearedPassword = await ack(owner, 'admin-action', { action: 'set-access-password', accessPassword: '' });
    assert.equal(clearedPassword.success, true, clearedPassword.error);
    const policyFreeRoom = await ack(owner, 'room-create', { username: 'RoomOwner', password: '123456', roomName: '动态无密码', hostToken: 'room-host' });
    assert.equal(policyFreeRoom.success, true, policyFreeRoom.error);
    const protectedRoom = await ack(owner, 'room-create', { username: 'RoomOwner', password: '123456', roomName: '动态有密码', roomPassword: 'third-pass', hostToken: 'room-host' });
    assert.equal(protectedRoom.success, true, protectedRoom.error);
    ownerLogin = protectedRoom;

    const voiceForm = new FormData(); voiceForm.append('voice', new Blob([Buffer.from('voice-data')], { type: 'audio/webm' }), 'voice.webm');
    const voice = await (await fetch(`${baseUrl}/api/voice`, { method: 'POST', headers: auth(ownerLogin.token), body: voiceForm })).json();
    assert.equal(voice.success, true, voice.error);
    const voiceName = path.basename(voice.message.voiceUrl);
    const voicePath = path.join(dataDir, 'voice', voiceName);
    assert.equal(fs.existsSync(voicePath), true);
    assert.equal((await ack(owner, 'chat-delete', { messageId: voice.message.id })).success, true);
    assert.equal(fs.existsSync(voicePath), false);
    let history = await ack(owner, 'operation-history', { limit: 200 });
    const firstDelete = history.operations.find((item) => item.action === 'chat-delete' && item.reversible);
    assert.ok(firstDelete);
    assert.equal((await ack(owner, 'rollback-operation', { operationId: firstDelete.id })).success, true);
    assert.equal(fs.existsSync(voicePath), true);
    assert.equal((await fetch(`${baseUrl}${voice.message.voiceUrl}`, { headers: auth(ownerLogin.token) })).status, 200);
    assert.equal((await ack(owner, 'chat-delete', { messageId: voice.message.id })).success, true);
    history = await ack(owner, 'operation-history', { limit: 200 });
    const expiringDelete = history.operations.find((item) => item.action === 'chat-delete' && item.reversible);
    assert.ok(expiringDelete && expiringDelete.id !== firstDelete.id);

    await fetch(`${baseUrl}/api/host/tunnel/stop`, { method: 'POST', headers: auth(ownerLogin.token) });
    owner.close(); observer.close(); owner = null; observer = null; await server.close(); server = null;
    const stateFile = path.join(dataDir, 'config.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const operation = state.operations.find((item) => item.id === expiringDelete.id);
    operation.undo.expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    const orphan = path.join(dataDir, 'trash', 'orphan.tmp'); fs.writeFileSync(orphan, 'orphan');

    server = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'room-host', tunnelManager });
    baseUrl = `http://127.0.0.1:${server.port}`;
    owner = await connectClient(baseUrl);
    ownerLogin = await ack(owner, 'user-login', { username: 'RoomOwner', password: '123456', roomId: protectedRoom.room.id, roomPassword: 'third-pass', hostToken: 'room-host' });
    assert.equal(ownerLogin.success, true, ownerLogin.error);
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(voicePath), false);
    history = await ack(owner, 'operation-history', { limit: 200 });
    const expired = history.operations.find((item) => item.id === expiringDelete.id);
    assert.equal(expired.reversible, false);
    const expiredRollback = await ack(owner, 'rollback-operation', { operationId: expiringDelete.id });
    assert.equal(expiredRollback.success, false); assert.match(expiredRollback.error, /30 天/);
    console.log('✓ 房主切房后旧房继续播放；无密码公网需确认且非强制策略允许动态建房；语音回收可恢复且 30 天后清理');
  } finally {
    owner?.close(); observer?.close(); await server?.close().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testTrashUndoSurvivesDirectoryMove() {
  const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-portable-trash-'));
  const oldDataDir = path.join(portableRoot, 'old-server', 'SyncWatch同步观影-Data');
  const newDataDir = path.join(portableRoot, 'moved-server', 'SyncWatch同步观影-Data');
  let server; let client;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir: oldDataDir, publicDir,
      ffprobePath: '', ffmpegPath: '', hostControlToken: 'portable-host'
    });
    let baseUrl = `http://127.0.0.1:${server.port}`;
    client = await connectClient(baseUrl);
    let login = await registerAndLogin(client, 'PortableOwner', { hostToken: 'portable-host' });
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('portable-video-data')], { type: 'video/mp4' }), 'portable.mp4');
    const uploaded = await (await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(login.token), body: form })).json();
    assert.equal(uploaded.success, true, uploaded.error);
    const deleted = await fetch(`${baseUrl}/api/files/${uploaded.file.id}`, { method: 'DELETE', headers: auth(login.token) });
    assert.equal(deleted.status, 200);
    const history = await ack(client, 'operation-history', { limit: 200 });
    const deleteOperation = history.operations.find((operation) => operation.action === 'file-delete' && operation.reversible);
    assert.ok(deleteOperation);

    client.close(); client = null; await server.close(); server = null;
    const oldStateFile = path.join(oldDataDir, 'config.json');
    const state = JSON.parse(fs.readFileSync(oldStateFile, 'utf8'));
    const storedOperation = state.operations.find((operation) => operation.id === deleteOperation.id);
    assert.ok(storedOperation?.undo?.artifacts?.length);
    for (const artifact of storedOperation.undo.artifacts) {
      assert.deepEqual(Object.keys(artifact).sort(), ['kind', 'originalName', 'trashName']);
      const directory = ({ upload: 'uploads', thumbnail: 'thumbnails', subtitle: 'subtitles', voice: 'voice' })[artifact.kind];
      artifact.originalPath = path.join(oldDataDir, directory, artifact.originalName);
      artifact.trashPath = path.join(oldDataDir, 'trash', artifact.trashName);
      delete artifact.originalName;
      delete artifact.trashName;
    }
    fs.writeFileSync(oldStateFile, `${JSON.stringify(state, null, 2)}\n`);
    fs.mkdirSync(path.dirname(newDataDir), { recursive: true });
    fs.renameSync(oldDataDir, newDataDir);

    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir: newDataDir, publicDir,
      ffprobePath: '', ffmpegPath: '', hostControlToken: 'portable-host'
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    client = await connectClient(baseUrl);
    login = await ack(client, 'user-login', {
      username: 'PortableOwner', password: '123456', hostToken: 'portable-host', deviceId: `portable-${Date.now()}`
    });
    assert.equal(login.success, true, login.error);
    const movedHistory = await ack(client, 'operation-history', { limit: 200 });
    const movedOperation = movedHistory.operations.find((operation) => operation.id === deleteOperation.id);
    assert.equal(movedOperation?.reversible, true);
    const rollback = await ack(client, 'rollback-operation', { operationId: deleteOperation.id });
    assert.equal(rollback.success, true, rollback.error);
    assert.equal(fs.existsSync(path.join(newDataDir, 'uploads', uploaded.file.storedName)), true);
    const migratedState = JSON.parse(fs.readFileSync(path.join(newDataDir, 'config.json'), 'utf8'));
    const migratedOperation = migratedState.operations.find((operation) => operation.id === deleteOperation.id);
    assert.deepEqual(Object.keys(migratedOperation.undo.artifacts[0]).sort(), ['kind', 'originalName', 'trashName']);
    console.log('✓ 删除回溯使用相对标识，旧绝对路径会随数据目录搬迁自动迁移且仍可恢复');
  } finally {
    client?.close(); await server?.close().catch(() => {}); fs.rmSync(portableRoot, { recursive: true, force: true });
  }
}

async function testTunnelStartPolicyLock() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-tunnel-start-race-'));
  const startEntered = deferred();
  const startRelease = deferred();
  let blockedStatus = null;
  let tunnelState = { state: 'stopped' };
  let startCalls = 0;
  const tunnelManager = {
    status: async () => {
      if (blockedStatus) {
        const blocker = blockedStatus;
        blockedStatus = null;
        blocker.entered.resolve();
        return blocker.release.promise;
      }
      return tunnelState;
    },
    start: async () => {
      startCalls += 1;
      tunnelState = { state: 'starting' };
      startEntered.resolve();
      await startRelease.promise;
      return (tunnelState = { state: 'running', publicUrl: 'https://start-lock.trycloudflare.com' });
    },
    stop: async () => (tunnelState = { state: 'stopped' })
  };
  let server; let owner; let creator;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '',
      hostControlToken: 'tunnel-lock-host', tunnelManager
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    owner = await connectClient(baseUrl);
    creator = await connectClient(baseUrl);
    const ownerLogin = await registerAndLogin(owner, 'TunnelLockOwner', { hostToken: 'tunnel-lock-host' });
    await registerAndLogin(creator, 'TunnelLockCreator');
    const passwordSet = await ack(owner, 'admin-action', { action: 'set-access-password', accessPassword: 'locked-room-pass' });
    assert.equal(passwordSet.success, true, passwordSet.error);
    const policyEnabled = await ack(owner, 'admin-action', { action: 'set-public-password-policy', adminPassword: 'admin888', enabled: true });
    assert.equal(policyEnabled.success, true, policyEnabled.error);
    const history = await ack(owner, 'operation-history', { limit: 50 });
    const passwordOperation = history.operations.find((item) => item.action === 'room-password' && item.reversible);
    assert.ok(passwordOperation);

    const statusEntered = deferred();
    const statusRelease = deferred();
    blockedStatus = { entered: statusEntered, release: statusRelease };
    const clearingBeforeStart = ack(owner, 'admin-action', { action: 'set-access-password', accessPassword: '' });
    await statusEntered.promise;

    const firstStart = fetch(`${baseUrl}/api/host/tunnel/start`, {
      method: 'POST', headers: auth(ownerLogin.token, { 'Content-Type': 'application/json' }), body: '{}'
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    await startEntered.promise;
    statusRelease.resolve({ state: 'stopped' });

    const clearResult = await clearingBeforeStart;
    assert.equal(clearResult.success, false);
    assert.match(clearResult.error, /公网访问/);

    const rollbackResult = await ack(owner, 'rollback-operation', { operationId: passwordOperation.id });
    assert.equal(rollbackResult.success, false);
    assert.match(rollbackResult.error, /公网访问/);

    const createResult = await ack(creator, 'room-create', {
      username: 'TunnelLockCreator', password: '123456', roomName: '启动竞态无密码房间'
    });
    assert.equal(createResult.success, false);
    assert.match(createResult.error, /必须设置访问密码/);

    const secondStart = fetch(`${baseUrl}/api/host/tunnel/start`, {
      method: 'POST', headers: auth(ownerLogin.token, { 'Content-Type': 'application/json' }), body: '{}'
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    const secondResult = await secondStart;
    assert.equal(secondResult.status, 409);
    assert.equal(secondResult.body.success, false);
    assert.match(secondResult.body.error, /正在启动/);
    assert.equal(startCalls, 1);

    startRelease.resolve();
    const firstResult = await firstStart;
    assert.equal(firstResult.status, 200);
    assert.equal(firstResult.body.success, true, firstResult.body.error);
    assert.equal(tunnelState.state, 'running');
    console.log('✓ 隧道启动锁覆盖异步交叉时序，并阻止无密码建房、清空/回溯密码和重复启动');
  } finally {
    startRelease.resolve();
    blockedStatus?.release.resolve({ state: 'stopped' });
    owner?.close(); creator?.close(); await server?.close().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testDynamicHostsAndDiskChecks() {
  const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.doesNotMatch(serverSource, /topLevelNavigation\s*&&\s*requestFromPrivateProxy/,
    '外部端口直连的顶层页面不能被误判为必须来自本机反代');
  const hostData = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-host-hardening-'));
  let server; let proxyHost;
  const aliases = {};
  const localIps = [];
  let tunnelState = { state: 'running', publicUrl: 'https://active-tunnel.example.com', verified: true };
  const tunnelManager = {
    status: async () => ({ ...tunnelState }),
    start: async () => ({ ...tunnelState }),
    stop: async () => (tunnelState = { state: 'stopped' })
  };
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir: hostData, publicDir, ffprobePath: '', ffmpegPath: '',
      allowedHosts: ['public.example.com'], hostControlToken: 'proxy-host-token', tunnelManager,
      networkInterfaces: () => ({ loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], lan: localIps.map((address) => ({ address, family: 'IPv4', internal: false })) }),
      lookupHost: async (hostname) => {
        if (!aliases[hostname]) { const error = new Error('not found'); error.code = 'ENOTFOUND'; throw error; }
        return aliases[hostname].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
      }
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    aliases['cinema.lan'] = ['127.0.0.1'];
    let socket = await rawSocket(baseUrl, { Host: `cinema.lan:${server.port}`, Origin: `http://cinema.lan:${server.port}` }); socket.close();
    localIps.push('10.77.0.5');
    socket = await rawSocket(baseUrl, { Host: `10.77.0.5:${server.port}`, Origin: `http://10.77.0.5:${server.port}` }); socket.close();
    aliases['mixed.local'] = ['127.0.0.1', '203.0.113.10'];
    await assert.rejects(() => rawSocket(baseUrl, { Host: `mixed.local:${server.port}`, Origin: `http://mixed.local:${server.port}` }), /403|Unexpected server response/i);
    aliases['attacker.com'] = ['127.0.0.1'];
    await assert.rejects(() => rawSocket(baseUrl, { Host: `attacker.com:${server.port}`, Origin: `http://attacker.com:${server.port}` }), /403|Unexpected server response/i);
    socket = await rawSocket(baseUrl, { Host: 'public.example.com', Origin: 'https://public.example.com' }); socket.close();
    socket = await rawSocket(baseUrl, { Host: `127.0.0.1:${server.port}`, Origin: 'https://public.example.com' }); socket.close();
    await assert.rejects(
      () => rawSocket(baseUrl, { Host: `127.0.0.1:${server.port}`, Origin: 'https://unknown-proxy.example.com' }),
      /403|Unexpected server response/i
    );
    await assert.rejects(() => rawSocket(baseUrl, { Host: 'forward.example.net', Origin: 'https://forward.example.net' }), /403|Unexpected server response/i);
    assert.equal(await navigate(baseUrl, { Host: 'forward.example.net' }), 200);
    socket = await rawSocket(baseUrl, { Host: 'forward.example.net', Origin: 'https://forward.example.net' }); socket.close();
    const externalPortHost = 'forward.example.net:18443';
    await assert.rejects(() => rawSocket(baseUrl, { Host: externalPortHost, Origin: `https://${externalPortHost}` }), /403|Unexpected server response/i);
    assert.equal(await navigate(baseUrl, { Host: externalPortHost }), 200);
    socket = await rawSocket(baseUrl, { Host: externalPortHost, Origin: `https://${externalPortHost}` }); socket.close();
    await assert.rejects(
      () => rawSocket(baseUrl, { Host: externalPortHost, Origin: 'https://unknown-proxy.example.com' }),
      /403|Unexpected server response/i
    );
    assert.equal(await navigate(baseUrl, { Host: `127.0.0.1:${server.port}`, 'X-Forwarded-Host': 'proxy.example.net' }), 200);
    socket = await rawSocket(baseUrl, { Host: `127.0.0.1:${server.port}`, 'X-Forwarded-Host': 'proxy.example.net', Origin: 'https://proxy.example.net' }); socket.close();
    proxyHost = await connectClient(baseUrl);
    const proxyHostLogin = await registerAndLogin(proxyHost, 'ProxyTunnelHost', { hostToken: 'proxy-host-token', createRoomPassword: 'proxy-room-pass' });
    const mediaBytes = Buffer.alloc(3 * 1024 * 1024, 0x5a);
    const mediaForm = new FormData();
    mediaForm.append('file', new Blob([mediaBytes], { type: 'video/mp4' }), 'external-port-range.mp4');
    const mediaUploadResponse = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: auth(proxyHostLogin.token), body: mediaForm
    });
    assert.equal(mediaUploadResponse.status, 200);
    const uploadedMedia = (await mediaUploadResponse.json()).file;
    const externalMediaUrl = `${uploadedMedia.originalUrl}?syncwatch_token=${encodeURIComponent(proxyHostLogin.token)}`;
    const externalRange = await requestBuffer(baseUrl, externalMediaUrl, {
      Host: externalPortHost, Origin: `https://${externalPortHost}`,
      Range: 'bytes=0-'
    });
    assert.equal(externalRange.status, 206);
    assert.equal(externalRange.headers['accept-ranges'], 'bytes');
    assert.equal(externalRange.headers['content-range'], `bytes 0-${mediaBytes.length - 1}/${mediaBytes.length}`);
    assert.equal(externalRange.body.length, mediaBytes.length, '开放式 Range 应完整穿过第三方域名和外部端口');
    assert.deepEqual(externalRange.body, mediaBytes);
    const tunnelStatus = await fetch(`${baseUrl}/api/host/tunnel/status`, { headers: auth(proxyHostLogin.token) });
    assert.equal(tunnelStatus.status, 200);
    socket = await rawSocket(baseUrl, { Host: '127.0.0.1', Origin: 'https://active-tunnel.example.com' }); socket.close();

    const secureCookie = await fetch(`${baseUrl}/api/session`, {
      method: 'POST', headers: auth(proxyHostLogin.token, { 'X-Forwarded-Proto': 'https' })
    });
    assert.match(secureCookie.headers.get('set-cookie') || '', /; Secure(?:;|$)/);
    const publicSpoofRequest = {
      headers: {
        host: 'attacker.example.net', 'x-forwarded-host': 'public.example.com',
        origin: 'https://public.example.com', 'x-forwarded-proto': 'https'
      },
      socket: { remoteAddress: '203.0.113.40' }
    };
    assert.equal(_test.requestHostHeader(publicSpoofRequest), 'attacker.example.net');
    assert.equal(_test.socketOriginAllowed(publicSpoofRequest, new Set(['public.example.com'])), false);
    assert.equal(_test.requestUsesForwardedHttps(publicSpoofRequest), false);
    assert.equal(_test.requestUsesPublicProxy(publicSpoofRequest), false);
    const privateProxyRequest = {
      headers: {
        host: `127.0.0.1:${server.port}`, 'x-forwarded-host': 'public.example.com',
        origin: 'https://public.example.com', 'x-forwarded-proto': 'https'
      },
      socket: { remoteAddress: '10.20.30.40' }
    };
    assert.equal(_test.requestHostHeader(privateProxyRequest), 'public.example.com');
    assert.equal(_test.socketOriginAllowed(privateProxyRequest, new Set(['public.example.com'])), true);
    assert.equal(_test.requestUsesForwardedHttps(privateProxyRequest), true);
    assert.equal(_test.requestUsesPublicProxy(privateProxyRequest), false,
      'a forwarded host alone must not be enough to classify an HTTP request as public');
    const privateHttpTunnelRequest = {
      headers: {
        host: `127.0.0.1:${server.port}`, 'x-forwarded-host': 'public.example.com',
        'x-forwarded-proto': 'http', 'x-forwarded-for': '198.51.100.88'
      },
      socket: { remoteAddress: '127.0.0.1' }
    };
    assert.equal(_test.requestUsesPublicProxy(privateHttpTunnelRequest), true);
    console.log('✓ 同源连接、显式/活动隧道白名单与可信私有代理 Host 改写可用，未知 Origin 和公网伪造转发头被拒');
    proxyHost.close(); proxyHost = null;
    await server.close(); server = null;

    const diskData = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-disk-hardening-'));
    let checks = 0; let client;
    try {
      server = await startSyncWatchServer({
        host: '127.0.0.1', port: 0, dataDir: diskData, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'disk-host',
        diskCheckIntervalBytes: 1, freeDiskBytes: () => (++checks === 1 ? 2 * 1024 * 1024 * 1024 : 0)
      });
      const base = `http://127.0.0.1:${server.port}`;
      client = await connectClient(base);
      const login = await registerAndLogin(client, 'DiskOwner', { hostToken: 'disk-host' });
      const upload = openChunkedUpload(base, login.token, 'disk.mp4'); upload.finish();
      const result = await upload;
      assert.equal(result.status, 507, result.error?.message || JSON.stringify(result.payload));
      const leftovers = fs.readdirSync(path.join(diskData, 'uploads'));
      assert.deepEqual(leftovers, [], `磁盘不足后仍残留文件：${leftovers.map((name) => `${name}:${fs.statSync(path.join(diskData, 'uploads', name)).size}`).join(', ')}`);
      console.log('✓ 启动后新增本机 IP/局域网别名可连接，混合解析与公网重绑定被拒；分块上传会动态检查磁盘并清理残片');
    } finally {
      client?.close(); await server?.close().catch(() => {}); fs.rmSync(diskData, { recursive: true, force: true });
    }
  } finally {
    proxyHost?.close(); await server?.close().catch(() => {}); fs.rmSync(hostData, { recursive: true, force: true });
  }
}

async function testCloseDrainsWrites() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-close-hardening-'));
  let server; let client;
  try {
    server = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'close-host' });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    client = await connectClient(baseUrl);
    const login = await registerAndLogin(client, 'CloseOwner', { hostToken: 'close-host' });
    const chat = await ack(client, 'chat-message', { text: '关闭前最后一条聊天' });
    assert.equal(chat.success, true);
    const upload = openChunkedUpload(baseUrl, login.token, 'closing.mp4');
    await delay(80);
    const closing = server.close();
    const rejected = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: auth(login.token) });
    assert.equal(rejected.status, 503);
    upload.finish();
    const uploaded = await upload;
    assert.equal(uploaded.status, 200, uploaded.error?.message || JSON.stringify(uploaded.payload));
    await closing; server = null;
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.ok(state.files.some((file) => file.originalName === 'closing.mp4'));
    const lines = fs.readFileSync(path.join(dataDir, 'chat-history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(lines.some((message) => message.id === chat.message.id));
    console.log('✓ 安全关闭会先拒绝新变更、等待在途上传，再最终保存状态并刷盘聊天');
  } finally {
    client?.close(); await server?.close().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testCloseAbortsHungUpload() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-close-timeout-hardening-'));
  let stopAt = 0;
  const tunnelManager = {
    status: async () => ({ state: 'running', publicUrl: 'https://close-test.trycloudflare.com' }),
    start: async () => ({ state: 'running', publicUrl: 'https://close-test.trycloudflare.com' }),
    stop: async () => { if (!stopAt) stopAt = Date.now(); return { state: 'stopped' }; }
  };
  let server; let client; let upload;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: '', hostControlToken: 'hung-host', tunnelManager,
      closeDrainTimeoutMs: 100, closeAbortGraceMs: 250, closeFinalTimeoutMs: 300
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    client = await connectClient(baseUrl);
    const login = await registerAndLogin(client, 'HungOwner', { hostToken: 'hung-host', createRoomPassword: 'hung-room-pass' });
    upload = openChunkedUpload(baseUrl, login.token, 'never-finishes.mp4');
    await delay(80);
    const started = Date.now();
    await server.close(); server = null;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `悬挂上传导致关闭耗时 ${elapsed}ms`);
    assert.ok(stopAt >= started && stopAt - started < 100, '公网隧道应在关闭入口立即停止');
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads')), []);
    console.log('✓ 永不结束的 chunked 上传会在有界 drain 后中止清理，公网隧道在关闭入口立即停止');
  } finally {
    upload?.request?.destroy(); client?.close(); await server?.close().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  await testStateConfigFailsClosed();
  await testDataDirectorySingleInstanceLock();
  await testCaptureTimeout();
  await testPrivateChatOperationPrivacy();
  await testConcurrentRegistrationClaims();
  await testConcurrentRoomCreationClaims();
  await testServerHostRoomReentryPlaybackContext();
  await testRoomCapacityOwnerAndServerHostExemptions();
  await testPermanentHistoryAndPagination();
  await testRoomsTunnelVoiceAndTrash();
  await testTrashUndoSurvivesDirectoryMove();
  await testTunnelStartPolicyLock();
  await testDynamicHostsAndDiskChecks();
  await testCloseDrainsWrites();
  await testCloseAbortsHungUpload();
  console.log('\n全部服务端硬化回归测试通过。');
}

main().catch((error) => { console.error('\n服务端硬化回归失败:', error); process.exitCode = 1; });
