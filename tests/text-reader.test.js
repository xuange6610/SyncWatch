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
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result || { success: false }); });
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
  await once(socket, 'connect');
  return socket;
}

async function acceptAgreement(socket, login) {
  if (!login?.capabilities?.agreementRequired) return login;
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

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-text-reader-'));
  let server; let host; let viewer; let resumedViewer;
  try {
    const clientSource = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    assert.match(clientSource, /TextDecoder\('utf-16le'\)/, 'client should decode UTF-16 little-endian text with a BOM');
    assert.match(clientSource, /TextDecoder\('utf-16be'\)/, 'client should decode UTF-16 big-endian text with a BOM');
    assert.match(clientSource, /TextDecoder\('gb18030'\)/, 'client should fall back for common Chinese GBK/GB18030 novels');
    assert.match(clientSource, /elements\.textViewer\.textContent = text/, 'text reader must render untrusted files as text');
    assert.doesNotMatch(clientSource, /elements\.textViewer\.innerHTML\s*=\s*text/, 'text reader must not execute uploaded markup');
    assert.match(clientSource, /state\.currentFile\.id !== fileId/, 'delayed reading updates must not leak from the previous text file');

    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir: path.join(root, 'data'), publicDir: path.resolve(__dirname, '..', 'public'),
      hostControlToken: 'text-reader-host', ffprobePath: '', ffmpegPath: '', discovery: false
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const config = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(config.allowTextUploads, true);
    assert.ok(config.supportedExtensions.includes('txt'));
    assert.ok(config.supportedExtensions.includes('json'));

    host = await connect(baseUrl);
    const hostLogin = await acceptAgreement(host, await ack(host, 'host-admin-login', {
      adminPassword: 'admin888', roomId: config.roomId, hostToken: 'text-reader-host'
    }));
    assert.equal(hostLogin.success, true, hostLogin.error);

    viewer = await connect(baseUrl);
    assert.equal((await ack(viewer, 'user-register', { username: 'TextViewer', password: '123456' })).success, true);
    const viewerLogin = await acceptAgreement(viewer, await ack(viewer, 'user-login', {
      username: 'TextViewer', password: '123456', roomId: config.roomId, deviceId: 'text-viewer-device'
    }));
    assert.equal(viewerLogin.success, true, viewerLogin.error);

    const policy = await ack(host, 'admin-action', {
      action: 'set-upload-policy', allowedUploadCategories: ['video', 'text']
    });
    assert.equal(policy.success, true, policy.error);

    const novel = await upload(baseUrl, viewerLogin.token, 'novel.txt', 'text/plain', Buffer.from('第一章\n安全的同步小说阅读。\n'.repeat(200), 'utf8'));
    assert.equal(novel.status, 200, novel.body.error);
    assert.equal(novel.body.file.category, 'text');
    const novelResponse = await fetch(`${baseUrl}${novel.body.file.originalUrl}`, { headers: { Authorization: `Bearer ${viewerLogin.token}` } });
    assert.equal(novelResponse.status, 200);
    assert.match(novelResponse.headers.get('content-type') || '', /^text\/plain/i);
    assert.match(novelResponse.headers.get('content-security-policy') || '', /sandbox/);
    const configText = await upload(baseUrl, viewerLogin.token, 'chapters.json', 'application/json', Buffer.from('{"chapter":2,"title":"继续阅读"}', 'utf8'));
    assert.equal(configText.status, 200, configText.body.error);
    assert.equal(configText.body.file.category, 'text');
    const utf16Novel = await upload(baseUrl, viewerLogin.token, 'utf16-novel.txt', 'text/plain', Buffer.concat([
      Buffer.from([0xFF, 0xFE]), Buffer.from('第二章\n带 BOM 的中文小说。', 'utf16le')
    ]));
    assert.equal(utf16Novel.status, 200, utf16Novel.body.error);
    assert.equal(utf16Novel.body.file.category, 'text');

    const disguisedBinary = await upload(baseUrl, hostLogin.token, 'malware.txt', 'text/plain', Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
    assert.equal(disguisedBinary.status, 415);
    assert.equal(disguisedBinary.body.code, 'INVALID_TEXT_CONTENT');
    const delayedBinary = await upload(baseUrl, hostLogin.token, 'delayed-binary.txt', 'text/plain', Buffer.concat([
      Buffer.alloc(70 * 1024, 0x41), Buffer.from([0, 1, 2, 3])
    ]));
    assert.equal(delayedBinary.status, 415);
    assert.equal(delayedBinary.body.code, 'INVALID_TEXT_CONTENT');
    const wrongMime = await upload(baseUrl, hostLogin.token, 'fake-text.txt', 'image/png', Buffer.from('plain-looking bytes'));
    assert.equal(wrongMime.status, 415);
    assert.equal(wrongMime.body.code, 'INVALID_TEXT_CONTENT');
    const oversizedText = await upload(baseUrl, hostLogin.token, 'oversized.txt', 'text/plain', Buffer.alloc(10 * 1024 * 1024 + 1, 0x41));
    assert.equal(oversizedText.status, 413);
    assert.equal(oversizedText.body.code, 'TEXT_FILE_TOO_LARGE');

    assert.equal((await ack(viewer, 'admin-action', { action: 'set-text-upload-policy', allowTextUploads: false })).success, false);
    const disabled = await ack(host, 'admin-action', { action: 'set-text-upload-policy', allowTextUploads: false });
    assert.equal(disabled.success, true, disabled.error);
    assert.equal((await (await fetch(`${baseUrl}/api/public-config`)).json()).allowTextUploads, false);
    const hostBlocked = await upload(baseUrl, hostLogin.token, 'blocked.md', 'text/markdown', Buffer.from('# should be blocked', 'utf8'));
    assert.equal(hostBlocked.status, 415);
    assert.equal(hostBlocked.body.code, 'TEXT_UPLOAD_DISABLED');
    assert.equal((await ack(host, 'admin-action', { action: 'set-text-upload-policy', allowTextUploads: true })).success, true);

    const selectedForViewer = once(viewer, 'playback-state');
    assert.equal((await ack(host, 'select-file', { fileId: novel.body.file.id })).success, true);
    assert.equal((await selectedForViewer).fileId, novel.body.file.id);

    const hostTextState = once(host, 'text-reading-state');
    const viewerTextState = once(viewer, 'text-reading-state');
    const updated = await ack(host, 'text-reading-update', { fileId: novel.body.file.id, position: 0.42, page: 6 });
    assert.equal(updated.success, true, updated.error);
    for (const state of [await hostTextState, await viewerTextState]) {
      assert.equal(state.fileId, novel.body.file.id);
      assert.equal(state.position, 0.42);
      assert.equal(state.page, 6);
    }
    assert.equal((await ack(viewer, 'text-reading-update', { fileId: novel.body.file.id, position: 0.9, page: 12 })).success, false);

    const viewerToken = viewerLogin.token;
    viewer.close(); viewer = null;
    assert.equal((await ack(host, 'text-reading-update', { fileId: novel.body.file.id, position: 0.73, page: 9 })).success, true);
    resumedViewer = await connect(baseUrl);
    const resumed = await ack(resumedViewer, 'session-resume', { token: viewerToken, deviceId: 'text-viewer-device' });
    assert.equal(resumed.success, true, resumed.error);
    assert.equal(resumed.room.textReading.fileId, novel.body.file.id);
    assert.equal(resumed.room.textReading.position, 0.73);
    assert.equal(resumed.room.textReading.page, 9);

    const clearedForHost = once(host, 'text-reading-state');
    const clearedForViewer = once(resumedViewer, 'text-reading-state');
    const deleted = await fetch(`${baseUrl}/api/files/${encodeURIComponent(novel.body.file.id)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${hostLogin.token}` }
    });
    assert.equal(deleted.status, 200);
    for (const state of [await clearedForHost, await clearedForViewer]) {
      assert.equal(state.fileId, '');
      assert.equal(state.position, 0);
      assert.equal(state.page, 1);
    }

    console.log('safe text upload, policy enforcement, synchronized reading, and reconnect recovery passed');
  } finally {
    host?.close(); viewer?.close(); resumedViewer?.close();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error('\ntext reader regression failed:', error); process.exitCode = 1; });
