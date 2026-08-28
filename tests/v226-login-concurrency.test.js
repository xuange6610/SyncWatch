'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

function ack(socket, event, payload = {}, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeout);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result || {}); });
  });
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timed out')), 12000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

async function acceptAgreement(socket, auth) {
  if (auth?.success && auth.capabilities?.agreementRequired) {
    const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: auth.agreement.version });
    assert.equal(accepted.success, true, accepted.error);
  }
  return auth;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-v226-concurrency-'));
  const sockets = [];
  let server;
  try {
    server = await startSyncWatchServer({
      port: 0, host: '127.0.0.1', discovery: false,
      dataDir: path.join(root, 'SyncWatch同步观影-Data'),
      publicDir: path.resolve(__dirname, '..', 'public'), ffmpegPath: '', ffprobePath: '',
      hostControlToken: 'v226-concurrency-host'
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    const roomId = publicConfig.roomId;

    const admin = await connect(baseUrl); sockets.push(admin);
    const adminAuth = await acceptAgreement(admin, await ack(admin, 'host-admin-login', {
      adminPassword: 'admin888', hostToken: 'v226-concurrency-host', roomId, deviceId: 'admin-device'
    }));
    assert.equal(adminAuth.success, true, adminAuth.error);
    assert.equal((await ack(admin, 'admin-action', { action: 'add-registration-whitelist', ipAddress: '127.0.0.1' })).success, true);

    const setup = await connect(baseUrl); sockets.push(setup);
    const visit = await ack(setup, 'login-page-visit', { deviceName: '访问记录设备', platform: '测试平台', browser: '测试浏览器' });
    assert.equal(visit.success, true, visit.error);
    const registered = await ack(setup, 'user-register', { username: 'ConcurrentUser', password: 'concurrent-pass' });
    assert.equal(registered.success, true, registered.error);

    const first = await connect(baseUrl); sockets.push(first);
    const firstAuth = await acceptAgreement(first, await ack(first, 'user-login', {
      username: 'ConcurrentUser', password: 'concurrent-pass', roomId, deviceId: 'device-one'
    }));
    assert.equal(firstAuth.success, true, firstAuth.error);

    const second = await connect(baseUrl); sockets.push(second);
    const limited = await ack(second, 'user-login', {
      username: 'ConcurrentUser', password: 'concurrent-pass', roomId, deviceId: 'device-two'
    });
    assert.equal(limited.success, false);
    assert.equal(limited.code, 'LOGIN_CONCURRENCY_LIMIT');
    assert.match(limited.error, /另一台设备已登录/);

    const request = await ack(second, 'login-concurrency-request', {
      username: 'ConcurrentUser', password: 'concurrent-pass', requestedLimit: 2,
      deviceName: 'device-two', reason: '测试第二台设备登录'
    });
    assert.equal(request.success, true, request.error);
    assert.equal(request.request.status, 'pending');

    const settingsBefore = await ack(admin, 'admin-action', { action: 'get-settings' });
    assert.equal(settingsBefore.success, true, settingsBefore.error);
    assert.ok(settingsBefore.admin.accessRecords.some((entry) => entry.action === 'visit' && entry.deviceName === '访问记录设备'));
    assert.ok(settingsBefore.admin.loginConcurrencyRequests.some((entry) => entry.id === request.request.id));

    const approved = await ack(admin, 'admin-action', {
      action: 'resolve-login-concurrency-request', requestId: request.request.id, approved: true
    });
    assert.equal(approved.success, true, approved.error);
    assert.equal(approved.sessionLimit, 2);

    const secondAuth = await acceptAgreement(second, await ack(second, 'user-login', {
      username: 'ConcurrentUser', password: 'concurrent-pass', roomId, deviceId: 'device-two'
    }));
    assert.equal(secondAuth.success, true, secondAuth.error);

    const revoked = await ack(admin, 'admin-action', {
      action: 'revoke-login-concurrency', requestId: request.request.id, username: 'ConcurrentUser'
    });
    assert.equal(revoked.success, true, revoked.error);
    assert.equal(revoked.status, 'revoked');

    const third = await connect(baseUrl); sockets.push(third);
    const limitedAgain = await ack(third, 'user-login', {
      username: 'ConcurrentUser', password: 'concurrent-pass', roomId, deviceId: 'device-three'
    });
    assert.equal(limitedAgain.success, false);
    assert.equal(limitedAgain.code, 'LOGIN_CONCURRENCY_LIMIT');

    console.log('v2.2.7 登录页访问记录、多设备申请批准、第二设备登录与授权撤回链路通过。');
  } finally {
    for (const socket of sockets) socket?.disconnect();
    if (server) await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
