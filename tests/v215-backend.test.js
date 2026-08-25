'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');
const packageVersion = require('../package.json').version;

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

async function acceptAgreement(socket, result) {
  if (result.capabilities?.agreementRequired) {
    const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: result.agreement.version });
    assert.equal(accepted.success, true, accepted.error);
  }
}

async function uploadVideo(baseUrl, token, filename) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('syncwatch-v215-test-video')], { type: 'video/mp4' }), filename);
  const response = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
  });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  assert.equal(result.success, true, result.error);
  return result.file;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-v215-backend-'));
  const dataDir = path.join(root, 'SyncWatch同步观影-Data');
  const sentMails = [];
  const sockets = [];
  let server;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir,
      publicDir: path.resolve(__dirname, '..', 'public'),
      hostControlToken: 'v215-backend-host', ffprobePath: '', ffmpegPath: '', discovery: false,
      mailSender: async (message) => { sentMails.push(message); return { messageId: `mail-${sentMails.length}` }; },
      mailVerifier: async () => true
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(publicConfig.version, `v${packageVersion}`);
    const defaultRoomId = publicConfig.roomId;

    const admin = await connect(baseUrl); sockets.push(admin);
    const adminLogin = await ack(admin, 'host-admin-login', {
      adminPassword: 'admin888', roomId: defaultRoomId, hostToken: 'v215-backend-host', deviceId: 'v215-admin'
    });
    assert.equal(adminLogin.success, true, adminLogin.error);
    await acceptAgreement(admin, adminLogin);

    const owner = await connect(baseUrl); sockets.push(owner);
    const registered = await ack(owner, 'user-register', { username: 'V215Owner', password: 'owner-pass' });
    assert.equal(registered.success, true, registered.error);
    const ownerLogin = await ack(owner, 'room-create', {
      username: 'V215Owner', password: 'owner-pass', customRoomId: 'V215ROOM', roomName: 'V215 测试房间', deviceId: 'v215-owner'
    });
    assert.equal(ownerLogin.success, true, ownerLogin.error);
    const ownerRoomId = ownerLogin.room.id;
    const ownerToken = ownerLogin.token;
    await acceptAgreement(owner, ownerLogin);

    // Server admin can adjust another room's storage limit and notify the owner.
    const roomStateEvent = nextEvent(owner, 'room-state');
    const noticeEvent = nextEvent(owner, 'account-notification');
    const crossRoomLimit = await ack(admin, 'admin-action', {
      action: 'set-room-storage-limit', roomId: ownerRoomId, storageLimitBytes: 100 * 1024 * 1024, adminPassword: 'admin888'
    });
    assert.equal(crossRoomLimit.success, true, crossRoomLimit.error);
    assert.equal(crossRoomLimit.storage.limitBytes, 100 * 1024 * 1024);
    assert.equal((await roomStateEvent).storage.limitBytes, 100 * 1024 * 1024);
    const ownerNotice = await noticeEvent;
    assert.match(ownerNotice.message, /服务器管理员已将房间/);

    // A normal room owner manages only their own room storage.
    const ownLimit = await ack(owner, 'admin-action', { action: 'set-room-storage-limit', storageLimitBytes: 50 * 1024 * 1024 });
    assert.equal(ownLimit.success, true, ownLimit.error);
    assert.equal(ownLimit.storage.limitBytes, 50 * 1024 * 1024);
    const deniedCrossRoom = await ack(owner, 'admin-action', { action: 'set-room-storage-limit', roomId: defaultRoomId, storageLimitBytes: 60 * 1024 * 1024 });
    assert.equal(deniedCrossRoom.success, false);
    assert.match(deniedCrossRoom.error, /服务器管理员/);

    // Server admin can delete files from another room.
    const ownerFile = await uploadVideo(baseUrl, ownerToken, 'movie-v215.mp4');
    const fileDeletedEvent = nextEvent(owner, 'file-deleted');
    const deleteNoticeEvent = nextEvent(owner, 'account-notification');
    const deletedFiles = await ack(admin, 'admin-action', {
      action: 'delete-room-files', roomId: ownerRoomId, fileIds: [ownerFile.id], adminPassword: 'admin888'
    });
    assert.equal(deletedFiles.success, true, deletedFiles.error);
    assert.equal(deletedFiles.deleted, 1);
    assert.equal(await fileDeletedEvent, ownerFile.id);
    assert.match((await deleteNoticeEvent).message, /服务器管理员删除了您房间的/);
    const ownerFilesAfterDelete = await (await fetch(`${baseUrl}/api/files`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
    assert.equal(ownerFilesAfterDelete.some((entry) => entry.id === ownerFile.id), false);

    // Server admin can ban and unban an upload name per room.
    const banNoticeEvent = nextEvent(owner, 'account-notification');
    const banned = await ack(admin, 'admin-action', {
      action: 'set-media-upload-ban', roomId: ownerRoomId, originalName: 'banned-movie.mp4', banned: true, adminPassword: 'admin888'
    });
    assert.equal(banned.success, true, banned.error);
    assert.equal(banned.entry.enabled, true);
    assert.match((await banNoticeEvent).message, /已禁止/);
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('syncwatch-banned-video')], { type: 'video/mp4' }), 'banned-movie.mp4');
    const bannedUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` }, body: form
    });
    const bannedUploadResult = await bannedUpload.json();
    assert.equal(bannedUpload.status, 403);
    assert.equal(bannedUploadResult.code, 'MEDIA_UPLOAD_BANNED');
    assert.match(bannedUploadResult.error, /禁止上传/);

    const unbanned = await ack(admin, 'admin-action', {
      action: 'set-media-upload-ban', roomId: ownerRoomId, originalName: 'banned-movie.mp4', banned: false, adminPassword: 'admin888'
    });
    assert.equal(unbanned.success, true, unbanned.error);
    assert.equal(unbanned.entry, null);
    const secondFile = await uploadVideo(baseUrl, ownerToken, 'banned-movie.mp4');

    // Media Range keeps 206 semantics and accepts both query and Bearer tokens.
    const rangeUrl = `${baseUrl}/media/${encodeURIComponent(secondFile.storedName)}?syncwatch_token=${encodeURIComponent(ownerToken)}`;
    const ranged = await fetch(rangeUrl, { headers: { Range: 'bytes=0-9' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 0-9/${secondFile.size}`);
    assert.equal(Number(ranged.headers.get('content-length')), 10);
    assert.equal(ranged.headers.get('x-content-type-options'), 'nosniff');
    assert.match(ranged.headers.get('cache-control'), /no-store/);
    const rangedBody = await ranged.arrayBuffer();
    assert.equal(rangedBody.byteLength, 10);
    const bearerRange = await fetch(`${baseUrl}/media/${encodeURIComponent(secondFile.storedName)}`, {
      headers: { Range: 'bytes=0-4', Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(bearerRange.status, 206);
    assert.equal(Number(bearerRange.headers.get('content-length')), 5);

    const mailSaved = await ack(admin, 'admin-action', {
      action: 'set-mail-settings', adminPassword: 'admin888', enabled: true,
      host: 'smtp.example.com', port: 587, secure: false, useTls: true,
      user: 'smtp-user@example.com', password: 'SMTP_SECRET_2026', recoveryEmail: 'admin-recovery@example.com',
      fromEmail: 'noreply@example.com', fromName: 'SyncWatch同步观影 测试'
    });
    assert.equal(mailSaved.success, true, mailSaved.error);

    // test-mail-settings renders the real selected template.
    const verificationMail = await ack(admin, 'admin-action', {
      action: 'test-mail-settings', templateEvent: 'verification', recipient: 'test@example.com', adminPassword: 'admin888'
    });
    assert.equal(verificationMail.success, true, verificationMail.error);
    assert.match(verificationMail.message, /邮箱验证码模板/);
    assert.match(sentMails.at(-1).subject, /验证码/);
    assert.match(sentMails.at(-1).html, /123456/);

    const resetMail = await ack(admin, 'admin-action', {
      action: 'test-mail-settings', templateEvent: 'password-reset', recipient: 'test@example.com', adminPassword: 'admin888'
    });
    assert.equal(resetMail.success, true, resetMail.error);
    assert.match(resetMail.message, /密码重置验证码模板/);
    assert.match(sentMails.at(-1).subject, /密码重置验证码/);
    assert.match(sentMails.at(-1).html, /123456/);

    const serverInfo = await (await fetch(`${baseUrl}/api/server-info`, { headers: { Authorization: `Bearer ${adminLogin.token}` } })).json();
    assert.equal(serverInfo.version, `v${packageVersion}`);
    console.log(`SyncWatch同步观影 v${packageVersion} backend admin/mail/media regression passed`);
  } finally {
    for (const socket of sockets) socket.close();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`SyncWatch同步观影 v${packageVersion} backend regression failed:`, error);
  process.exitCode = 1;
});
