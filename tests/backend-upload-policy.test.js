require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

function ack(socket, event, payload = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} response timed out`)), timeout);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result || { success: false, error: 'empty response' }); });
  });
}

function once(socket, event, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} event timed out`)), timeout);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket.IO connection timed out')), 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', reject);
  });
  return socket;
}

async function acceptAgreement(socket, login) {
  if (!login?.success || !login.capabilities?.agreementRequired) return login;
  const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: login.agreement.version });
  assert.equal(accepted.success, true, accepted.error);
  return login;
}

async function upload(baseUrl, token, name, type, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const response = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: response.status, body: await response.json() };
}

async function start(dataDir) {
  return startSyncWatchServer({
    host: '127.0.0.1', port: 0, dataDir,
    publicDir: path.resolve(__dirname, '..', 'public'), hostControlToken: 'backend-policy-host',
    ffprobePath: '', ffmpegPath: '', discovery: false
  });
}

async function main() {
  const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.doesNotMatch(serverSource, /playbackRequests\s*=\s*runtime\.playbackRequests\.filter[\s\S]{0,160}createdAt/);
  assert.doesNotMatch(serverSource, /themeSyncRequests\s*=\s*\(runtime\.themeSyncRequests[\s\S]{0,160}createdAt/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-backend-policy-'));
  const dataDir = path.join(root, 'SyncWatch同步观影-Data');
  const copiedDir = path.join(root, 'Copied-SyncWatch同步观影-Data');
  let server; let admin; let member;
  try {
    server = await start(dataDir);
    let baseUrl = `http://127.0.0.1:${server.port}`;
    let publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.deepEqual(publicConfig.allowedUploadCategories, ['video']);

    admin = await connect(baseUrl);
    let adminLogin = await acceptAgreement(admin, await ack(admin, 'host-admin-login', {
      adminPassword: 'admin888', roomId: publicConfig.roomId, hostToken: 'backend-policy-host'
    }));
    assert.equal(adminLogin.success, true, adminLogin.error);

    member = await connect(baseUrl);
    assert.equal((await ack(member, 'user-register', { username: 'PolicyMember', password: '123456' })).success, true);
    const memberLogin = await acceptAgreement(member, await ack(member, 'user-login', {
      username: 'PolicyMember', password: '123456', roomId: publicConfig.roomId
    }));
    assert.equal(memberLogin.success, true, memberLogin.error);

    const adminImage = await upload(baseUrl, adminLogin.token, 'admin-poster.png', 'image/png', Buffer.from('admin-image'));
    assert.equal(adminImage.status, 200, adminImage.body.error);
    assert.equal(adminImage.body.file.category, 'image', '管理员应绕过可配置的上传类型策略');

    const rejectedImage = await upload(baseUrl, memberLogin.token, 'poster.png', 'image/png', Buffer.from('not-a-real-image'));
    assert.equal(rejectedImage.status, 415);
    assert.equal(rejectedImage.body.code, 'UPLOAD_CATEGORY_NOT_ALLOWED');
    assert.equal(rejectedImage.body.category, 'image');
    assert.equal(rejectedImage.body.requestable, true);

    const policyNotice = once(admin, 'upload-policy-requested');
    const requestedPolicy = await ack(member, 'upload-policy-request', { category: 'image', fileName: 'poster.png', reason: 'preview poster' });
    assert.equal(requestedPolicy.success, true, requestedPolicy.error);
    assert.equal((await policyNotice).id, requestedPolicy.request.id);
    const duplicatePolicy = await ack(member, 'upload-policy-request', { category: 'image', fileName: 'poster.png' });
    assert.equal(duplicatePolicy.request.id, requestedPolicy.request.id);

    const policyResolvedNotice = once(member, 'upload-policy-resolved');
    const resolvedPolicy = await ack(admin, 'admin-action', {
      action: 'resolve-upload-policy-request', requestId: requestedPolicy.request.id, approved: true
    });
    assert.equal(resolvedPolicy.success, true, resolvedPolicy.error);
    assert.ok(resolvedPolicy.allowedUploadCategories.includes('image'));
    assert.equal((await policyResolvedNotice).approved, true);

    const imageUpload = await upload(baseUrl, memberLogin.token, 'poster.png', 'image/png', Buffer.from('image-preview'));
    assert.equal(imageUpload.status, 200, imageUpload.body.error);
    assert.equal(imageUpload.body.file.category, 'image');
    const imagePlayback = once(member, 'playback-state');
    const selectedImage = await ack(admin, 'select-file', { fileId: imageUpload.body.file.id });
    assert.equal(selectedImage.success, true, selectedImage.error);
    assert.equal(selectedImage.previewCategory, 'image');
    const imageState = await imagePlayback;
    assert.equal(imageState.fileId, imageUpload.body.file.id);
    assert.equal(imageState.isPlaying, false);

    const staticPolicy = await ack(admin, 'admin-action', {
      action: 'set-upload-policy', allowedUploadCategories: ['video', 'image', 'text', 'pdf']
    });
    assert.equal(staticPolicy.success, true, staticPolicy.error);
    for (const sample of [
      { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('shared notes'), category: 'text' },
      { name: 'manual.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n%%EOF'), category: 'pdf' }
    ]) {
      const staticUpload = await upload(baseUrl, memberLogin.token, sample.name, sample.type, sample.bytes);
      assert.equal(staticUpload.status, 200, staticUpload.body.error);
      const stateEvent = once(member, 'playback-state');
      const selected = await ack(admin, 'select-file', { fileId: staticUpload.body.file.id });
      assert.equal(selected.success, true, selected.error);
      assert.equal(selected.previewCategory, sample.category);
      assert.equal((await stateEvent).isPlaying, false);
    }

    const videoUpload = await upload(baseUrl, memberLogin.token, 'small.mp4', 'video/mp4', Buffer.from('12345678'));
    assert.equal(videoUpload.status, 200, videoUpload.body.error);
    assert.equal((await ack(admin, 'admin-action', {
      action: 'set-upload-limits', uploadLimitBytes: 4, uploadTimeLimitSeconds: 0
    })).success, true);
    const adminOverConfiguredLimit = await upload(baseUrl, adminLogin.token, 'admin-large.mp4', 'video/mp4', Buffer.from('12345678'));
    assert.equal(adminOverConfiguredLimit.status, 200, adminOverConfiguredLimit.body.error);
    const memberOverConfiguredLimit = await upload(baseUrl, memberLogin.token, 'member-large.mp4', 'video/mp4', Buffer.from('12345678'));
    assert.equal(memberOverConfiguredLimit.status, 413);
    assert.equal((await ack(admin, 'admin-action', {
      action: 'set-upload-limits', uploadLimitBytes: 0, uploadTimeLimitSeconds: 0
    })).success, true);
    const serverInfo = await (await fetch(`${baseUrl}/api/server-info`, { headers: { Authorization: `Bearer ${adminLogin.token}` } })).json();
    const currentUsage = serverInfo.room.storage.originalBytes;
    const setLimit = await ack(admin, 'admin-action', { action: 'set-room-storage-limit', storageLimitBytes: currentUsage + 4 });
    assert.equal(setLimit.success, true, setLimit.error);
    const rejectedCapacity = await upload(baseUrl, memberLogin.token, 'too-large.mp4', 'video/mp4', Buffer.from('12345678'));
    assert.equal(rejectedCapacity.status, 413);
    assert.equal(rejectedCapacity.body.code, 'ROOM_STORAGE_LIMIT_REACHED');
    assert.equal(rejectedCapacity.body.requestable, true);
    const adminOverRoomQuota = await upload(baseUrl, adminLogin.token, 'admin-over-quota.mp4', 'video/mp4', Buffer.from('12345678'));
    assert.equal(adminOverRoomQuota.status, 200, adminOverRoomQuota.body.error);

    const storageNotice = once(admin, 'storage-quota-requested');
    const storageRequest = await ack(member, 'storage-quota-request', {
      requestedLimitBytes: currentUsage + 1024, reason: 'more room for videos'
    });
    assert.equal(storageRequest.success, true, storageRequest.error);
    assert.equal((await storageNotice).id, storageRequest.request.id);
    const storageResolvedNotice = once(member, 'storage-quota-resolved');
    const storageResolved = await ack(admin, 'admin-action', {
      action: 'resolve-storage-quota-request', requestId: storageRequest.request.id, approved: true
    });
    assert.equal(storageResolved.success, true, storageResolved.error);
    assert.equal((await storageResolvedNotice).approved, true);
    assert.equal((await upload(baseUrl, memberLogin.token, 'accepted.mp4', 'video/mp4', Buffer.from('12345678'))).status, 200);

    const usersAfterLocation = once(admin, 'users-list');
    const memberLocation = await ack(member, 'member-location', {
      status: 'authorized', latitude: 31.2304, longitude: 121.4737, accuracy: 12,
      country: 'China', province: 'Shanghai', city: 'Shanghai', district: 'Huangpu', street: 'People Square'
    });
    assert.equal(memberLocation.success, true, memberLocation.error);
    const publicLocatedMember = (await usersAfterLocation).find((entry) => entry.username === 'PolicyMember');
    assert.equal(publicLocatedMember.location.latitude, null);
    assert.equal(publicLocatedMember.location.longitude, null);
    const profile = await ack(admin, 'member-profile', { username: 'PolicyMember' });
    assert.equal(profile.success, true, profile.error);
    assert.equal(profile.profile.username, 'PolicyMember');
    assert.equal(profile.profile.level, 1);
    assert.equal(profile.profile.location.street, 'People Square');
    assert.equal(profile.profile.location.latitude, null);
    const locations = await ack(admin, 'member-location-list');
    assert.equal(locations.success, true, locations.error);
    const locatedMember = locations.members.find((entry) => entry.username === 'PolicyMember');
    assert.equal(locatedMember.location.latitude, 31.2304);
    assert.equal((await ack(member, 'member-location-list')).success, false);

    assert.equal((await ack(member, 'chat-message', { text: 'policy filter needle' })).success, true);
    assert.equal((await ack(member, 'chat-message', { text: 'unrelated public message' })).success, true);
    const today = new Date().toISOString().slice(0, 10);
    const filteredChat = await ack(admin, 'chat-admin', {
      action: 'list-messages', usernames: ['PolicyMember'], type: 'public',
      fromDate: today, toDate: today, query: 'filter needle', limit: 100
    });
    assert.equal(filteredChat.success, true, filteredChat.error);
    assert.equal(filteredChat.messages.length, 1);
    assert.equal(filteredChat.messages[0].text, 'policy filter needle');

    const pendingDocument = await ack(member, 'upload-policy-request', { category: 'document', fileName: 'manual.docx' });
    assert.equal(pendingDocument.success, true, pendingDocument.error);
    admin.close(); member.close(); admin = null; member = null;
    await server.close(); server = null;

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(persisted.version, 12);
    assert.ok(persisted.admin.allowedUploadCategories.includes('image'));
    assert.equal(persisted.admin.uploadPolicyRequests.find((entry) => entry.id === pendingDocument.request.id).status, 'pending');

    fs.cpSync(dataDir, copiedDir, { recursive: true });
    server = await start(copiedDir);
    baseUrl = `http://127.0.0.1:${server.port}`;
    publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.ok(publicConfig.allowedUploadCategories.includes('image'), 'copied data directory must apply copied settings');
    member = await connect(baseUrl);
    const copiedLogin = await acceptAgreement(member, await ack(member, 'user-login', {
      username: 'PolicyMember', password: '123456', roomId: publicConfig.roomId
    }));
    assert.equal(copiedLogin.success, true, copiedLogin.error);
    const copiedFiles = await (await fetch(`${baseUrl}/api/files`, { headers: { Authorization: `Bearer ${copiedLogin.token}` } })).json();
    assert.ok(copiedFiles.some((file) => file.originalName === 'poster.png'), 'copied media index and file must remain readable');
    const copiedChat = await ack(member, 'chat-history', { limit: 100 });
    assert.ok(copiedChat.messages.some((message) => message.text === 'policy filter needle'), 'copied chat data must remain readable');
    member.close(); member = null;
    await server.close(); server = null;

    fs.rmSync(copiedDir, { recursive: true, force: true });
    server = await start(copiedDir);
    baseUrl = `http://127.0.0.1:${server.port}`;
    publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.deepEqual(publicConfig.allowedUploadCategories, ['video'], 'deleted data directory must restart from defaults');
    assert.equal(JSON.parse(fs.readFileSync(path.join(copiedDir, 'config.json'), 'utf8')).version, 12);
    member = await connect(baseUrl);
    const removedAccountLogin = await ack(member, 'user-login', { username: 'PolicyMember', password: '123456', roomId: publicConfig.roomId });
    assert.equal(removedAccountLogin.success, false, 'deleted data directory must not retain copied accounts');

    console.log('backend upload policy, persistent requests, static preview, member details, and portable data directory passed');
  } finally {
    admin?.close(); member?.close();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error('\nbackend upload policy regression failed:', error); process.exitCode = 1; });
