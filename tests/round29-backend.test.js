'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { io } = require('socket.io-client');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { startSyncWatchServer } = require('../server');

function ack(socket, event, payload = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeout);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result || { success: false, error: 'empty response' });
    });
  });
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 12000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

async function acceptAgreement(socket, result) {
  if (result?.success && result.capabilities?.agreementRequired) {
    const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: result.agreement.version });
    assert.equal(accepted.success, true, accepted.error);
  }
  return result;
}

async function logout(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/logout`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-round29-backend-'));
  const dataDir = path.join(root, 'SyncWatch同步观影-Data');
  const sockets = [];
  let server;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, discovery: false,
      publicDir: path.resolve(__dirname, '..', 'public'), hostControlToken: 'round29-host',
      ffprobePath, ffmpegPath
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    let publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    const systemRoomId = publicConfig.roomId;

    const admin = await connect(baseUrl); sockets.push(admin);
    const adminLogin = await acceptAgreement(admin, await ack(admin, 'host-admin-login', {
      adminPassword: 'admin888', hostToken: 'round29-host', roomId: systemRoomId, deviceId: 'round29-admin'
    }));
    assert.equal(adminLogin.success, true, adminLogin.error);

    const wrongCurrent = await ack(admin, 'verify-current-password', { currentPassword: 'not-the-password' });
    assert.equal(wrongCurrent.success, false);
    const rightCurrent = await ack(admin, 'verify-current-password', { currentPassword: 'admin888' });
    assert.equal(rightCurrent.success, true, rightCurrent.error);

    const cube = await ack(admin, 'admin-action', {
      action: 'set-login-cube-settings', displayMode: 'flat', rotationDirection: 'up'
    });
    assert.equal(cube.success, true, cube.error);
    assert.equal(cube.loginCube.displayMode, 'flat');
    assert.equal(cube.loginCube.rotationDirection, 'up');

    const notices = await ack(admin, 'admin-action', {
      action: 'set-notice-preferences', f11PromptEnabled: false, initialPasswordReminderEnabled: false
    });
    assert.equal(notices.success, true, notices.error);
    assert.equal(notices.f11PromptEnabled, false);
    assert.equal(notices.initialPasswordReminderEnabled, false);

    const enabledMusic = await ack(admin, 'admin-action', {
      action: 'set-login-music', enabled: true, title: 'Round 29 music',
      showTitle: false, url: 'https://example.com/round29.mp3', volume: 0.25, loop: true
    });
    assert.equal(enabledMusic.success, true, enabledMusic.error);
    assert.equal(enabledMusic.loginMusic.enabled, true);
    assert.equal(enabledMusic.loginMusic.showTitle, false);
    const loginVideoFixture = path.join(root, 'round29-login-video.mp4');
    const generated = spawnSync(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=12:d=1',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', loginVideoFixture
    ], { windowsHide: true, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr || 'failed to generate login video fixture');
    const videoForm = new FormData();
    videoForm.append('video', new Blob([fs.readFileSync(loginVideoFixture)], { type: 'video/mp4' }), 'round29.mp4');
    const videoUploadResponse = await fetch(`${baseUrl}/api/login-video-upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminLogin.token}` }, body: videoForm
    });
    const videoUpload = await videoUploadResponse.json();
    assert.equal(videoUploadResponse.status, 200, videoUpload.error);
    assert.equal(videoUpload.success, true, videoUpload.error);
    const enabledVideo = await ack(admin, 'admin-action', {
      ...(videoUpload.loginVideo || videoUpload.video),
      action: 'set-login-video', enabled: true, title: 'Round 29 video'
    });
    assert.equal(enabledVideo.success, true, enabledVideo.error);
    assert.equal(enabledVideo.loginVideo.enabled, true, JSON.stringify(enabledVideo));
    assert.equal(enabledVideo.loginMusic.enabled, false,
      'enabling login video must disable login music on the server');
    const videoResponse = await fetch(`${baseUrl}${enabledVideo.loginVideo.url}`, {
      headers: { Range: 'bytes=0-7' }
    });
    assert.equal(videoResponse.status, 206, 'login video must support browser media Range requests');
    assert.equal((await videoResponse.arrayBuffer()).byteLength, 8);
    const reenabledMusic = await ack(admin, 'admin-action', {
      action: 'set-login-music', enabled: true, title: 'Round 29 music',
      url: 'https://example.com/round29.mp3', volume: 0.25, loop: true
    });
    assert.equal(reenabledMusic.success, true, reenabledMusic.error);
    assert.equal(reenabledMusic.loginMusic.enabled, true);
    assert.equal(reenabledMusic.loginVideo.enabled, false,
      'enabling login music must disable login video on the server');

    const roomSettings = await ack(admin, 'admin-action', {
      action: 'set-room', roomName: '禁止游客测试房', maxUsers: 8, allowGuests: false
    });
    assert.equal(roomSettings.success, true, roomSettings.error);
    const adminSettings = await ack(admin, 'admin-action', { action: 'get-settings' });
    assert.equal(adminSettings.admin.allowGuests, false);

    publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(publicConfig.loginCube.displayMode, 'flat');
    assert.equal(publicConfig.loginCube.rotationDirection, 'up');
    assert.equal(publicConfig.f11PromptEnabled, false);
    assert.equal(publicConfig.initialPasswordReminderEnabled, false);
    assert.equal(publicConfig.loginMusic.showTitle, false);

    const whitelist = await ack(admin, 'admin-action', {
      action: 'add-registration-whitelist', ipAddress: '127.0.0.1'
    });
    assert.equal(whitelist.success, true, whitelist.error);

    const setupSocket = await connect(baseUrl); sockets.push(setupSocket);
    for (const username of ['Round29FirstAdmin', 'Round29SecondAdmin']) {
      const registered = await ack(setupSocket, 'user-register', { username, password: 'round29-admin-pass' });
      assert.equal(registered.success, true, `${username}: ${registered.error || ''}`);
      const agreementSocket = await connect(baseUrl); sockets.push(agreementSocket);
      const preparedLogin = await acceptAgreement(agreementSocket, await ack(agreementSocket, 'user-login', {
        username, password: 'round29-admin-pass', roomId: systemRoomId, deviceId: `${username}-agreement`
      }));
      assert.equal(preparedLogin.success, true, preparedLogin.error);
      agreementSocket.close();
    }

    for (const username of ['Round29FirstAdmin', 'Round29SecondAdmin']) {
      const promoted = await ack(admin, 'admin-action', {
        action: 'set-super-admin', username, enabled: true, forcePasswordChange: true
      });
      assert.equal(promoted.success, true, promoted.error);
    }
    const removedWhitelist = await ack(admin, 'admin-action', {
      action: 'remove-registration-whitelist', ipAddress: '127.0.0.1'
    });
    assert.equal(removedWhitelist.success, true, removedWhitelist.error);

    admin.close();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const requester = await connect(baseUrl); sockets.push(requester);
    const pendingRequest = await ack(requester, 'registration-request', {
      username: 'Round29PendingAccount', requestedCount: 2, reason: '双管理员弹窗回归'
    });
    assert.equal(pendingRequest.success, true, pendingRequest.error);
    assert.equal(pendingRequest.request.popupClaimedBy, '', 'offline request must remain unclaimed until an administrator logs in');

    const firstAdmin = await connect(baseUrl); sockets.push(firstAdmin);
    const firstAdminLogin = await ack(firstAdmin, 'user-login', {
      username: 'Round29FirstAdmin', password: 'round29-admin-pass', roomId: systemRoomId,
      deviceId: 'round29-first-admin'
    });
    assert.equal(firstAdminLogin.success, true, firstAdminLogin.error);
    assert.equal(firstAdminLogin.capabilities.mustChangeAccountPassword, false,
      'promoted administrators must not inherit the built-in admin first-login password reset');
    assert.deepEqual(firstAdminLogin.claimedRegistrationRequests, [],
      'delegated administrators must not receive built-in-admin system request popups');

    const secondAdmin = await connect(baseUrl); sockets.push(secondAdmin);
    const secondAdminLogin = await ack(secondAdmin, 'user-login', {
      username: 'Round29SecondAdmin', password: 'round29-admin-pass', roomId: systemRoomId,
      deviceId: 'round29-second-admin'
    });
    assert.equal(secondAdminLogin.success, true, secondAdminLogin.error);
    assert.deepEqual(secondAdminLogin.claimedRegistrationRequests, [],
      'delegated administrator logins must not claim sensitive system request popups');
    const secondAdminSettings = await ack(secondAdmin, 'admin-action', { action: 'get-settings' });
    assert.equal(secondAdminSettings.success, true, secondAdminSettings.error);
    const visiblePendingRequest = secondAdminSettings.admin.registrationRequests
      .find((request) => request.id === pendingRequest.request.id);
    assert.ok(visiblePendingRequest, 'later administrators must still see the request in the application center');
    assert.equal(visiblePendingRequest.popupClaimedBy, '');

    const blockedGuest = await connect(baseUrl); sockets.push(blockedGuest);
    const denied = await ack(blockedGuest, 'guest-login', { roomId: systemRoomId, deviceId: 'round29-blocked' });
    assert.equal(denied.success, false);
    assert.equal(denied.code, 'GUESTS_DISABLED');

    const fallbackGuest = await connect(baseUrl); sockets.push(fallbackGuest);
    const fallback = await acceptAgreement(fallbackGuest, await ack(fallbackGuest, 'guest-login', {
      roomId: 'MISSING29', deviceId: 'round29-fallback'
    }));
    assert.equal(fallback.success, true, fallback.error);
    assert.equal(fallback.user.guest, true);
    assert.equal(fallback.room.temporary, true);
    assert.deepEqual(fallback.roomFallback, { requestedRoomId: 'MISSING29', temporaryRoomId: fallback.room.id });

    const onlineRooms = await (await fetch(`${baseUrl}/api/online-rooms`)).json();
    const scannedTemporary = onlineRooms.rooms.find((room) => room.id === fallback.room.id);
    assert.ok(scannedTemporary, 'temporary room must be discoverable');
    assert.equal(scannedTemporary.temporary, true);
    const scannedFormal = onlineRooms.rooms.find((room) => room.id === systemRoomId);
    assert.ok(scannedFormal, 'formal room must be discoverable');
    assert.equal(scannedFormal.temporary, false);

    const converted = await ack(fallbackGuest, 'guest-convert-account', {
      username: 'Round29Member', password: 'member-pass-29', email: '', emailCode: ''
    }, 30000);
    assert.equal(converted.success, true, converted.error);
    assert.ok(converted.token);
    assert.equal(converted.user.username, 'Round29Member');
    assert.equal(converted.user.guest, false);
    assert.equal(converted.profile.guest, false);
    assert.equal(converted.room.temporary, false, 'owned guest room is made persistent during conversion');

    await logout(baseUrl, converted.token);
    const relogin = await connect(baseUrl); sockets.push(relogin);
    const memberLogin = await acceptAgreement(relogin, await ack(relogin, 'user-login', {
      username: 'Round29Member', password: 'member-pass-29', roomId: converted.room.id, deviceId: 'round29-member'
    }));
    assert.equal(memberLogin.success, true, memberLogin.error);
    assert.equal(memberLogin.user.guest, false);

    await server.close(); server = null;
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, discovery: false,
      publicDir: path.resolve(__dirname, '..', 'public'), hostControlToken: 'round29-host',
      ffprobePath, ffmpegPath
    });
    const restartedBaseUrl = `http://127.0.0.1:${server.port}`;
    publicConfig = await (await fetch(`${restartedBaseUrl}/api/public-config`)).json();
    assert.equal(publicConfig.loginCube.displayMode, 'flat');
    assert.equal(publicConfig.loginCube.rotationDirection, 'up');
    assert.equal(publicConfig.f11PromptEnabled, false);
    assert.equal(publicConfig.initialPasswordReminderEnabled, false);
    assert.equal(publicConfig.loginMusic.enabled, true);
    assert.equal(publicConfig.loginMusic.title, 'Round 29 music');
    assert.equal(publicConfig.loginVideo.enabled, false);
    assert.ok(publicConfig.loginVideo.url,
      'disabling login video through music mutual exclusion must preserve the uploaded video setting');
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(persisted.accounts.Round29Member.guest, false);
    assert.equal(persisted.rooms[converted.room.id].allowGuests, true);
    console.log('round29 backend contracts passed');
  } finally {
    for (const socket of sockets) socket.close();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('round29 backend contracts failed:', error);
  process.exitCode = 1;
});
