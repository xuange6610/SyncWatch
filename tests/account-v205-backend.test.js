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

function nextEvent(socket, event, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`${event} event timed out`));
    }, timeout);
    const listener = (payload) => {
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
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

async function login(socket, credentials) {
  const result = await ack(socket, 'user-login', credentials);
  if (result.success && result.capabilities?.agreementRequired) {
    const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: result.agreement.version });
    assert.equal(accepted.success, true, accepted.error);
  }
  return result;
}

async function registerAndLogin(socket, baseUrl, username, password, roomId, deviceId) {
  const registered = await ack(socket, 'user-register', { username, password });
  assert.equal(registered.success, true, registered.error);
  const result = await login(socket, { username, password, roomId, deviceId });
  assert.equal(result.success, true, result.error);
  return result;
}

async function uploadVideo(baseUrl, token) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('syncwatch-test-video')], { type: 'video/mp4' }), 'permissions.mp4');
  const response = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
  });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  assert.equal(result.success, true, result.error);
  return result.file;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-account-v205-'));
  const dataDir = path.join(root, 'SyncWatch同步观影-Data');
  const sockets = [];
  let server;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir,
      publicDir: path.resolve(__dirname, '..', 'public'),
      hostControlToken: 'account-v205-host', ffprobePath: '', ffmpegPath: '', discovery: false
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    const roomId = publicConfig.roomId;
    assert.equal(publicConfig.locationStatusNoticesEnabled, true);
    assert.equal(publicConfig.locationAuthorizationRequestsEnabled, true);

    const admin = await connect(baseUrl); sockets.push(admin);
    const adminLogin = await ack(admin, 'host-admin-login', {
      adminPassword: 'admin888', roomId, hostToken: 'account-v205-host', deviceId: 'v205-admin'
    });
    assert.equal(adminLogin.success, true, adminLogin.error);
    if (adminLogin.capabilities?.agreementRequired) {
      const accepted = await ack(admin, 'agreement-accept', { accepted: true, version: adminLogin.agreement.version });
      assert.equal(accepted.success, true, accepted.error);
    }
    const whitelist = await ack(admin, 'admin-action', {
      action: 'add-registration-whitelist', ipAddress: '127.0.0.1'
    });
    assert.equal(whitelist.success, true, whitelist.error);

    const alice = await connect(baseUrl); const bob = await connect(baseUrl); const charlie = await connect(baseUrl);
    sockets.push(alice, bob, charlie);
    await registerAndLogin(alice, baseUrl, 'V205Alice', '123456', roomId, 'v205-alice');
    await registerAndLogin(bob, baseUrl, 'V205Bob', '123456', roomId, 'v205-bob');
    await registerAndLogin(charlie, baseUrl, 'V205Charlie', '123456', roomId, 'v205-charlie');

    const file = await uploadVideo(baseUrl, adminLogin.token);
    const selected = await ack(admin, 'select-file', { fileId: file.id });
    assert.equal(selected.success, true, selected.error);
    const rateRejected = await ack(alice, 'playback-command', { action: 'rate', playbackRate: 3 });
    assert.equal(rateRejected.success, false, 'ordinary members must not control playback rate');
    const rateAccepted = await ack(admin, 'playback-command', { action: 'rate', playbackRate: 3 });
    assert.equal(rateAccepted.success, true, rateAccepted.error);
    assert.equal(rateAccepted.change.after.playbackRate, 3);

    const mediaRequestEvent = nextEvent(admin, 'media-management-requested');
    const mediaRequest = await ack(alice, 'media-management-request', { reason: 'I need to curate the room library.' });
    assert.equal(mediaRequest.success, true, mediaRequest.error);
    assert.equal((await mediaRequestEvent).id, mediaRequest.request.id);
    const mediaResolvedEvent = nextEvent(alice, 'media-management-request-resolved');
    const mediaResolved = await ack(admin, 'admin-action', {
      action: 'resolve-media-management-request', requestId: mediaRequest.request.id, approved: true
    });
    assert.equal(mediaResolved.success, true, mediaResolved.error);
    assert.equal(mediaResolved.granted, true);
    assert.equal((await mediaResolvedEvent).approved, true);
    const mediaSettings = await ack(admin, 'admin-action', { action: 'get-settings' });
    assert.equal(mediaSettings.success, true, mediaSettings.error);
    assert.equal(mediaSettings.admin.mediaManagementRequests.some((entry) => entry.id === mediaRequest.request.id), true);

    const friendRequestEvent = nextEvent(bob, 'friend-request');
    const friendRequest = await ack(alice, 'account-action', {
      action: 'friend-request', username: 'V205Bob', message: 'Original request text'
    });
    assert.equal(friendRequest.success, true, friendRequest.error);
    const pending = await friendRequestEvent;
    const pendingDirectory = await ack(alice, 'account-action', { action: 'friend-search', query: 'V205Bob' });
    assert.equal(pendingDirectory.success, true, pendingDirectory.error);
    assert.equal(pendingDirectory.accounts[0].pendingRequestId, pending.id);
    assert.equal(pendingDirectory.accounts[0].pendingRequestMessage, 'Original request text');
    const editedEvent = nextEvent(bob, 'friend-request-updated');
    const edited = await ack(alice, 'account-action', {
      action: 'friend-request-edit', requestId: pending.id, message: 'Updated request text'
    });
    assert.equal(edited.success, true, edited.error);
    assert.equal((await editedEvent).request.message, 'Updated request text');
    const editedDirectory = await ack(alice, 'account-action', { action: 'friend-search', query: 'V205Bob' });
    assert.equal(editedDirectory.accounts[0].pendingRequestMessage, 'Updated request text');
    const withdrawEvent = nextEvent(bob, 'friend-request-withdrawn');
    const withdrawn = await ack(alice, 'account-action', {
      action: 'friend-request-withdraw', requestId: pending.id
    });
    assert.equal(withdrawn.success, true, withdrawn.error);
    assert.equal((await withdrawEvent).withdrawn, true);

    const secondRequestEvent = nextEvent(bob, 'friend-request');
    const secondRequest = await ack(alice, 'account-action', {
      action: 'friend-request', username: 'V205Bob', message: 'Please add me'
    });
    assert.equal(secondRequest.success, true, secondRequest.error);
    const acceptedRequest = await secondRequestEvent;
    const accepted = await ack(bob, 'account-action', { action: 'friend-respond', requestId: acceptedRequest.id, accepted: true });
    assert.equal(accepted.success, true, accepted.error);

    const firstMessage = await ack(alice, 'account-action', {
      action: 'friend-message', username: 'V205Bob', text: 'needle message'
    });
    assert.equal(firstMessage.success, true, firstMessage.error);
    const imageMessage = await ack(alice, 'account-action', {
      action: 'friend-message', username: 'V205Bob', type: 'image', imageUrl: '/chat-images/test.png', imageName: 'test.png'
    });
    assert.equal(imageMessage.success, true, imageMessage.error);
    const unreadHistory = await ack(bob, 'account-action', {
      action: 'friend-history', username: 'V205Alice', unreadOnly: true, type: 'text', query: 'needle'
    });
    assert.equal(unreadHistory.success, true, unreadHistory.error);
    assert.equal(unreadHistory.messages.length, 1);
    assert.equal(unreadHistory.messages[0].id, firstMessage.message.id);
    const imageHistory = await ack(bob, 'account-action', {
      action: 'friend-history', username: 'V205Alice', type: 'image', query: 'test.png'
    });
    assert.equal(imageHistory.success, true, imageHistory.error);
    assert.equal(imageHistory.messages.length, 1);
    assert.equal(imageHistory.messages[0].id, imageMessage.message.id);

    const locationStatus = nextEvent(admin, 'member-location-status');
    const locationUpdate = await ack(alice, 'member-location', {
      status: 'authorized', latitude: 31.2304, longitude: 121.4737, accuracy: 12,
      country: 'China', province: 'Shanghai', city: 'Shanghai', district: 'Huangpu', street: 'People Square'
    });
    assert.equal(locationUpdate.success, true, locationUpdate.error);
    assert.equal((await locationStatus).status, 'authorized');
    const locationRevoked = nextEvent(admin, 'member-location-status');
    const revoked = await ack(alice, 'member-location-revoke');
    assert.equal(revoked.success, true, revoked.error);
    assert.equal((await locationRevoked).status, 'revoked');
    const requestLocationEvent = nextEvent(alice, 'location-authorization-requested');
    const requestedLocation = await ack(admin, 'member-location-request', { username: 'V205Alice' });
    assert.equal(requestedLocation.success, true, requestedLocation.error);
    assert.equal((await requestLocationEvent).username, 'V205Alice');

    const disabledLocationNotices = await ack(admin, 'admin-action', {
      action: 'set-notice-preferences', f11PromptEnabled: true, initialPasswordReminderEnabled: true,
      downloadButtonsVisible: true, locationStatusNoticesEnabled: false, locationAuthorizationRequestsEnabled: false
    });
    assert.equal(disabledLocationNotices.success, true, disabledLocationNotices.error);
    let unexpectedLocationStatus = false;
    const unexpectedLocationListener = () => { unexpectedLocationStatus = true; };
    admin.on('member-location-status', unexpectedLocationListener);
    const silentLocationUpdate = await ack(alice, 'member-location', { status: 'denied' });
    assert.equal(silentLocationUpdate.success, true, silentLocationUpdate.error);
    await new Promise((resolve) => setTimeout(resolve, 250));
    admin.off('member-location-status', unexpectedLocationListener);
    assert.equal(unexpectedLocationStatus, false, 'disabled server location status notices must not be emitted');
    const disabledLocationRequest = await ack(admin, 'member-location-request', { username: 'V205Alice' });
    assert.equal(disabledLocationRequest.success, false);
    assert.equal(disabledLocationRequest.code, 'LOCATION_REQUESTS_DISABLED');
    const unrelatedPreferenceUpdate = await ack(admin, 'admin-action', {
      action: 'set-notice-preferences', f11PromptEnabled: false
    });
    assert.equal(unrelatedPreferenceUpdate.success, true, unrelatedPreferenceUpdate.error);
    assert.equal(unrelatedPreferenceUpdate.locationStatusNoticesEnabled, false);
    assert.equal(unrelatedPreferenceUpdate.locationAuthorizationRequestsEnabled, false);
    const disabledPublicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(disabledPublicConfig.locationStatusNoticesEnabled, false);
    assert.equal(disabledPublicConfig.locationAuthorizationRequestsEnabled, false);

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const storedMedia = persisted.admin.mediaManagementRequests.find((entry) => entry.id === mediaRequest.request.id);
    assert.equal(storedMedia.status, 'approved');
    assert.equal(persisted.rooms[roomId].mediaManagementGrants.V205Alice, true);
    assert.equal(persisted.admin.locationStatusNoticesEnabled, false);
    assert.equal(persisted.admin.locationAuthorizationRequestsEnabled, false);
    console.log('account v2.2.0 backend protocol regression passed');
  } finally {
    for (const socket of sockets) socket.close();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('account v2.2.0 backend regression failed:', error);
  process.exitCode = 1;
});
