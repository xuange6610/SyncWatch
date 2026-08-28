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
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result || { success: false, error: 'empty acknowledgement' });
    });
  });
}

function nextEvent(socket, event, predicate = () => true, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`${event} timed out`));
    }, timeout);
    const listener = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  await nextEvent(socket, 'connect', () => true);
  return socket;
}

async function acceptAgreement(socket, auth) {
  if (auth?.success && auth.capabilities?.agreementRequired) {
    const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: auth.agreement.version });
    assert.equal(accepted.success, true, accepted.error);
  }
  return auth;
}

async function login(socket, username, password, roomId, deviceId) {
  const result = await acceptAgreement(socket, await ack(socket, 'user-login', {
    username, password, roomId, deviceId,
    deviceName: deviceId, platform: 'test', browser: 'socket.io'
  }));
  assert.equal(result.success, true, result.error);
  return result;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-v226-client-mode-'));
  const dataDir = path.join(root, 'SyncWatch同步观影-Data');
  const sockets = [];
  let server;
  try {
    server = await startSyncWatchServer({
      port: 0, host: '127.0.0.1', dataDir, discovery: false,
      publicDir: path.resolve(__dirname, '..', 'public'),
      ffmpegPath: '', ffprobePath: '', hostControlToken: 'v226-mode-host'
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    const roomId = publicConfig.roomId;

    const admin = await connect(baseUrl); sockets.push(admin);
    const adminAuth = await acceptAgreement(admin, await ack(admin, 'host-admin-login', {
      adminPassword: 'admin888', hostToken: 'v226-mode-host', roomId, deviceId: 'v226-mode-admin'
    }));
    assert.equal(adminAuth.success, true, adminAuth.error);
    const whitelist = await ack(admin, 'admin-action', { action: 'add-registration-whitelist', ipAddress: '127.0.0.1' });
    assert.equal(whitelist.success, true, whitelist.error);

    const setup = await connect(baseUrl); sockets.push(setup);
    for (const [username, password] of [['ModeUser', 'mode-pass'], ['ModePeer', 'peer-pass']]) {
      const registered = await ack(setup, 'user-register', { username, password });
      assert.equal(registered.success, true, registered.error);
    }

    const modeUser = await connect(baseUrl); sockets.push(modeUser);
    await login(modeUser, 'ModeUser', 'mode-pass', roomId, 'mode-user-device');
    const modePeer = await connect(baseUrl); sockets.push(modePeer);
    await login(modePeer, 'ModePeer', 'peer-pass', roomId, 'mode-peer-device');

    const concisePrompt = nextEvent(modeUser, 'client-mode-requested', (entry) => entry.mode === 'concise');
    const conciseSent = await ack(admin, 'admin-action', {
      action: 'send-client-mode-request', mode: 'concise', scope: 'users', usernames: ['ModeUser'],
      reason: '测试简洁模式申请'
    });
    assert.equal(conciseSent.success, true, conciseSent.error);
    assert.equal(conciseSent.requests.length, 1);
    const conciseRequest = await concisePrompt;
    assert.equal(conciseRequest.username, 'ModeUser');
    const conciseResolved = await ack(modeUser, 'client-mode-request-response', {
      requestId: conciseRequest.id, accepted: true
    });
    assert.equal(conciseResolved.success, true, conciseResolved.error);
    assert.equal(conciseResolved.viewPreferences.conciseMode, true);
    assert.equal(conciseResolved.notificationSettings.allNotifications, true);

    const roomUserPrompt = nextEvent(modeUser, 'client-mode-requested', (entry) => entry.mode === 'notifications-off');
    const roomPeerPrompt = nextEvent(modePeer, 'client-mode-requested', (entry) => entry.mode === 'notifications-off');
    const roomSent = await ack(admin, 'admin-action', {
      action: 'send-client-mode-request', mode: 'notifications-off', scope: 'room', roomId,
      reason: '测试房间范围通知申请'
    });
    assert.equal(roomSent.success, true, roomSent.error);
    assert.deepEqual(roomSent.requests.map((entry) => entry.username).sort(), ['ModePeer', 'ModeUser']);
    const roomUserRequest = await roomUserPrompt;
    const roomPeerRequest = await roomPeerPrompt;
    const notificationOff = await ack(modeUser, 'client-mode-request-response', {
      requestId: roomUserRequest.id, accepted: true
    });
    assert.equal(notificationOff.success, true, notificationOff.error);
    assert.equal(notificationOff.notificationSettings.allNotifications, false);
    const declined = await ack(modePeer, 'client-mode-request-response', {
      requestId: roomPeerRequest.id, accepted: false
    });
    assert.equal(declined.success, true, declined.error);
    assert.equal(declined.status, 'denied');

    modePeer.disconnect();
    const professionalSent = await ack(admin, 'admin-action', {
      action: 'send-client-mode-request', mode: 'professional', scope: 'users', usernames: ['ModePeer'],
      reason: '测试离线补投'
    });
    assert.equal(professionalSent.success, true, professionalSent.error);
    const offlineRequest = professionalSent.requests[0];

    const resumedPeer = await connect(baseUrl); sockets.push(resumedPeer);
    const offlinePrompt = nextEvent(resumedPeer, 'client-mode-requested', (entry) => entry.id === offlineRequest.id);
    await login(resumedPeer, 'ModePeer', 'peer-pass', roomId, 'mode-peer-reconnect');
    const deliveredOfflineRequest = await offlinePrompt;
    assert.equal(deliveredOfflineRequest.mode, 'professional');
    const professionalApplied = await ack(resumedPeer, 'client-mode-request-response', {
      requestId: deliveredOfflineRequest.id, accepted: true
    });
    assert.equal(professionalApplied.success, true, professionalApplied.error);
    assert.equal(professionalApplied.viewPreferences.conciseMode, false);
    assert.equal(professionalApplied.notificationSettings.allNotifications, true);

    const cancellable = await ack(admin, 'admin-action', {
      action: 'send-client-mode-request', mode: 'concise', scope: 'users', usernames: ['ModePeer']
    });
    assert.equal(cancellable.success, true, cancellable.error);
    const cancelledEvent = nextEvent(resumedPeer, 'client-mode-request-cancelled', (entry) => entry.requestId === cancellable.requests[0].id);
    const cancelled = await ack(admin, 'admin-action', {
      action: 'cancel-client-mode-request', requestId: cancellable.requests[0].id
    });
    assert.equal(cancelled.success, true, cancelled.error);
    assert.equal((await cancelledEvent).status, 'cancelled');

    const settings = await ack(admin, 'admin-action', { action: 'get-settings' });
    assert.equal(settings.success, true, settings.error);
    assert.ok(settings.admin.clientModeRequests.some((entry) => entry.id === conciseRequest.id && entry.status === 'approved'));
    assert.ok(settings.admin.clientModeRequests.some((entry) => entry.id === offlineRequest.id && entry.status === 'approved'));
    assert.ok(settings.admin.clientModeRequests.some((entry) => entry.id === cancellable.requests[0].id && entry.status === 'cancelled'));

    console.log('v2.2.6 管理员客户端模式申请、用户确认、离线补投与取消链路通过。');
  } finally {
    for (const socket of sockets) socket?.disconnect();
    if (server) await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
