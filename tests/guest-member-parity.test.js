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
      resolve(result || { success: false, error: 'empty response' });
    });
  });
}

async function connect(baseUrl, forwardedIp) {
  const socket = io(baseUrl, {
    transports: ['websocket'], forceNew: true, reconnection: false,
    extraHeaders: { 'x-forwarded-for': forwardedIp }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 12000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

async function acceptAgreement(socket, auth) {
  if (!auth.capabilities?.agreementRequired) return;
  const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: auth.agreement.version });
  assert.equal(accepted.success, true, accepted.error);
}

async function profile(socket) {
  const result = await ack(socket, 'account-action', { action: 'get-profile' });
  assert.equal(result.success, true, result.error);
  return result.profile;
}

async function logout(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerExitAction: 'leave' })
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitFor(predicate, label, timeout = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-guest-member-parity-'));
  const dataDir = path.join(root, 'SyncWatch同步观影-Data');
  const sockets = [];
  let server;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, discovery: false,
      publicDir: path.resolve(__dirname, '..', 'public'),
      ffprobePath: '', ffmpegPath: '', hostControlToken: 'guest-parity-host'
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const member = await connect(baseUrl, '203.0.113.10'); sockets.push(member);
    const registered = await ack(member, 'user-register', { username: 'ParityMember', password: 'member-pass' });
    assert.equal(registered.success, true, registered.error);
    const memberLogin = await ack(member, 'user-login', {
      username: 'ParityMember', password: 'member-pass', deviceId: 'member-device'
    });
    assert.equal(memberLogin.success, true, memberLogin.error);
    await acceptAgreement(member, memberLogin);
    const initialMemberProfile = await profile(member);
    assert.equal(initialMemberProfile.roomQuota, 1);
    assert.equal(initialMemberProfile.ownedRoomCount, 0);

    const memberRoom = await ack(member, 'room-create', {
      customRoomId: 'MEMBERROOM', roomName: 'Member room', deviceId: 'member-device'
    }, 30000);
    assert.equal(memberRoom.success, true, memberRoom.error);
    const memberQuotaReached = await ack(member, 'room-create', {
      customRoomId: 'MEMBERROOM2', roomName: 'Second member room', deviceId: 'member-device'
    }, 30000);
    assert.equal(memberQuotaReached.success, false);
    assert.equal(memberQuotaReached.code, 'ROOM_QUOTA_REACHED');

    const policyOwner = await connect(baseUrl, '203.0.113.13'); sockets.push(policyOwner);
    const policyOwnerRegistration = await ack(policyOwner, 'user-register', {
      username: 'GuestPolicyOwner', password: 'policy-owner-pass'
    });
    assert.equal(policyOwnerRegistration.success, true, policyOwnerRegistration.error);
    const policyRoom = await ack(policyOwner, 'room-create', {
      username: 'GuestPolicyOwner', password: 'policy-owner-pass', customRoomId: 'NOGUESTS',
      roomName: 'No guests room', deviceId: 'policy-owner-device'
    }, 30000);
    assert.equal(policyRoom.success, true, policyRoom.error);
    await acceptAgreement(policyOwner, policyRoom);
    const guestsDisabled = await ack(policyOwner, 'owner-action', { action: 'allow-guests', enabled: false });
    assert.equal(guestsDisabled.success, true, guestsDisabled.error);
    const deniedGuest = await connect(baseUrl, '203.0.113.14'); sockets.push(deniedGuest);
    const deniedGuestLogin = await ack(deniedGuest, 'guest-login', { roomId: policyRoom.room.id, deviceId: 'denied-guest' });
    assert.equal(deniedGuestLogin.success, false);
    assert.equal(deniedGuestLogin.code, 'GUESTS_DISABLED',
      '游客获得普通成员权限后，房主的“禁止游客进入”开关仍必须按身份生效');
    const guestsEnabled = await ack(policyOwner, 'owner-action', { action: 'allow-guests', enabled: true });
    assert.equal(guestsEnabled.success, true, guestsEnabled.error);
    const registeredMemberLogin = await ack(member, 'room-switch', { roomId: policyRoom.room.id });
    assert.equal(registeredMemberLogin.success, true, registeredMemberLogin.error);

    const guest = await connect(baseUrl, '203.0.113.11'); sockets.push(guest);
    const guestLogin = await ack(guest, 'guest-login', { deviceId: 'guest-device' });
    assert.equal(guestLogin.success, true, guestLogin.error);
    assert.equal(guestLogin.user.guest, true);
    await acceptAgreement(guest, guestLogin);
    const guestUsername = guestLogin.user.username;
    const guestTemporaryRoomId = guestLogin.room.id;
    const initialGuestProfile = await profile(guest);

    assert.equal(initialGuestProfile.roomQuota, initialMemberProfile.roomQuota,
      '游客与刚注册普通用户应获得相同建房额度');
    assert.equal(initialGuestProfile.ownedRoomCount, initialMemberProfile.ownedRoomCount,
      '临时登录房间不应占用游客或普通用户的正式房间额度');
    assert.deepEqual(guestLogin.permissions, registeredMemberLogin.permissions,
      '游客登录后应获得与加入他人房间的注册账号相同的普通成员权限');
    assert.equal(guestLogin.capabilities.owner, false, '游客临时房不得通过房主身份获得管理特权');
    assert.deepEqual(
      Object.keys(initialGuestProfile).sort(),
      Object.keys(initialMemberProfile).sort(),
      '游客资料页应与刚注册普通用户暴露相同的页面数据结构'
    );

    const guestRoom = await ack(guest, 'room-create', {
      customRoomId: 'GUESTROOM', roomName: 'Guest room', deviceId: 'guest-device'
    }, 30000);
    assert.equal(guestRoom.success, false);
    assert.equal(guestRoom.code, 'GUEST_REGISTRATION_REQUIRED');

    await new Promise((resolve) => setImmediate(resolve));
    const finalGuestProfile = await profile(guest);
    assert.equal(finalGuestProfile.guest, true, '建房不能把游客隐式转换为正式账号');
    assert.equal(finalGuestProfile.roomQuota, initialMemberProfile.roomQuota);
    assert.equal(finalGuestProfile.ownedRoomCount, 0);

    const guestQuotaReached = await ack(guest, 'room-create', {
      customRoomId: 'GUESTROOM2', roomName: 'Second guest room', deviceId: 'guest-device'
    }, 30000);
    assert.equal(guestQuotaReached.success, false);
    assert.equal(guestQuotaReached.code, 'GUEST_REGISTRATION_REQUIRED');

    const guestQuotaRequest = await ack(guest, 'room-quota-request', {
      requestedQuota: 2, reason: 'guest parity lifecycle test'
    });
    assert.equal(guestQuotaRequest.success, false);
    assert.equal(guestQuotaRequest.code, 'GUEST_REGISTRATION_REQUIRED');

    const persistedWhileOnline = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(persistedWhileOnline.accounts[guestUsername].roomCreationBlocked, false);
    assert.equal(persistedWhileOnline.accounts[guestUsername].roomQuota, 1);
    assert.equal(persistedWhileOnline.rooms.GUESTROOM, undefined);

    const loggedOut = await logout(baseUrl, guestLogin.token);
    assert.equal(loggedOut.success, true, loggedOut.error);
    await waitFor(() => {
      const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      return !persisted.accounts[guestUsername]
        && !persisted.rooms[guestTemporaryRoomId]
        && !persisted.admin.roomQuotaRequests.some((request) => request.username === guestUsername);
    }, '游客退出后清除账号及其临时/正式房间');

    console.log('guest login is capped to ordinary-member permissions regression passed');
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('guest/member parity regression failed:', error);
  process.exitCode = 1;
});
