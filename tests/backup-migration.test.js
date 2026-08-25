const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

function ack(socket, event, payload = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeout);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result || {}); });
  });
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', reject);
  });
  return socket;
}

async function loginHost(socket, token) {
  const result = await ack(socket, 'host-admin-login', { adminPassword: 'admin888', hostToken: token });
  assert.equal(result.success, true, result.error);
  if (result.capabilities?.agreementRequired) {
    const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: result.agreement.version });
    assert.equal(accepted.success, true, accepted.error);
  }
  return result;
}

function auth(token, extra = {}) { return { Authorization: `Bearer ${token}`, ...extra }; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function write(file, contents) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); }

function rewriteArchivePath(archive, from, to) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to), 'replacement path must keep the entry header length stable');
  const changed = Buffer.from(archive); let position = 19;
  const metadataLength = Number(changed.readBigUInt64BE(position)); position += 8 + metadataLength;
  while (position < changed.length) {
    const headerLength = changed.readUInt32BE(position); position += 4;
    if (!headerLength) break;
    const headerStart = position; const header = JSON.parse(changed.subarray(position, position + headerLength).toString('utf8')); position += headerLength;
    const size = Number(changed.readBigUInt64BE(position)); position += 8;
    if (header.relativePath === from) {
      const replacement = Buffer.from(JSON.stringify({ ...header, relativePath: to }));
      assert.equal(replacement.length, headerLength);
      replacement.copy(changed, headerStart);
      return changed;
    }
    position += size;
  }
  throw new Error(`archive entry ${from} was not found`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-backup-migration-'));
  const sourceDir = path.join(root, 'source');
  const destinationDir = path.join(root, 'destination');
  const publicDir = path.resolve(__dirname, '..', 'public');
  let source; let destination; let sourceSocket; let destinationSocket; let staleSocket;
  try {
    source = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir: sourceDir, publicDir, discovery: false, hostControlToken: 'migration-host', ffprobePath: '', ffmpegPath: '' });
    sourceSocket = await connect(`http://127.0.0.1:${source.port}`);
    const sourceLogin = await loginHost(sourceSocket, 'migration-host');
    const registration = await ack(sourceSocket, 'user-register', { username: 'MigrationOwner', password: '123456' });
    assert.equal(registration.success, true, registration.error);
    const room = await ack(sourceSocket, 'room-create', { username: 'MigrationOwner', password: '123456', customRoomId: 'MIGRATE1', roomName: '迁移源房间', maxUsers: 12, hostToken: 'migration-host', deviceId: 'migration-device' });
    assert.equal(room.success, true, room.error);
    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([Buffer.from('migration-original')], { type: 'video/mp4' }), '迁移原片.mp4');
    const uploadResponse = await fetch(`http://127.0.0.1:${source.port}/api/upload`, { method: 'POST', headers: auth(sourceLogin.token), body: uploadForm });
    const upload = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200, JSON.stringify(upload));
    const file = upload.file;

    write(path.join(sourceDir, 'compatible-media', `${file.id}.mp4`), Buffer.from('migration-compatible'));
    write(path.join(sourceDir, 'avatars', 'MigrationOwner.bin'), Buffer.from('migration-avatar'));
    write(path.join(sourceDir, 'chat-images', 'chat-image.bin'), Buffer.from('migration-chat-image'));
    write(path.join(sourceDir, 'voice', 'voice-message.bin'), Buffer.from('migration-voice'));
    write(path.join(sourceDir, '.secrets', 'mail.key'), `${Buffer.alloc(32, 7).toString('base64')}\n`);
    write(path.join(sourceDir, 'secrets', 'migration-marker.txt'), Buffer.from('migration-admin-secret'));
    write(path.join(sourceDir, 'tools', 'cloudflared-windows-amd64.exe'), Buffer.from('migration-cloudflared'));
    write(path.join(sourceDir, 'download-assets', 'migration-client.exe'), Buffer.from('migration-download-asset'));
    write(path.join(sourceDir, 'server-config.json'), JSON.stringify({ port: 5151, autostart: true }));
    write(path.join(sourceDir, 'cache', 'do-not-export.tmp'), Buffer.from('cache'));
    await source.close(); source = null; sourceSocket.close(); sourceSocket = null;

    source = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir: sourceDir, publicDir, discovery: false, hostControlToken: 'migration-host', ffprobePath: '', ffmpegPath: '' });
    sourceSocket = await connect(`http://127.0.0.1:${source.port}`);
    const sourceExportLogin = await loginHost(sourceSocket, 'migration-host');
    const exportResponse = await fetch(`http://127.0.0.1:${source.port}/api/host/data/export?scopes=all&format=binary`, { headers: auth(sourceExportLogin.token) });
    assert.equal(exportResponse.status, 200);
    const archive = Buffer.from(await exportResponse.arrayBuffer());
    assert.ok(archive.length > 1000, 'full migration archive should include files');
    assert.equal(archive.subarray(0, 19).toString('ascii'), 'SYNCWATCH-BACKUP-2\n');
    assert.match(archive.toString('utf8'), /chat-images|\.secrets|compatible-media|cloudflared-windows-amd64/);
    assert.match(archive.toString('utf8'), /download-assets/, '完整备份应包含服务器下载中心文件');
    const configExportResponse = await fetch(`http://127.0.0.1:${source.port}/api/host/data/export?scopes=config&format=binary`, { headers: auth(sourceExportLogin.token) });
    assert.equal(configExportResponse.status, 200);
    const configArchive = Buffer.from(await configExportResponse.arrayBuffer());
    assert.doesNotMatch(configArchive.toString('utf8'), /download-assets/, '仅配置备份不能携带大体积客户端安装文件');
    await source.close(); source = null; sourceSocket.close(); sourceSocket = null;

    destination = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir: destinationDir, publicDir, discovery: false, hostControlToken: 'migration-host', ffprobePath: '', ffmpegPath: '' });
    const unauthorizedImport = await fetch(`http://127.0.0.1:${destination.port}/api/host/data/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'syncwatch-data-export', scopes: ['config'], configState: {} })
    });
    assert.equal(unauthorizedImport.status, 401, 'JSON migration import must require an authenticated server host session');
    destinationSocket = await connect(`http://127.0.0.1:${destination.port}`);
    const destinationLogin = await loginHost(destinationSocket, 'migration-host');
    staleSocket = await connect(`http://127.0.0.1:${destination.port}`);
    const staleLogin = await loginHost(staleSocket, 'migration-host');
    write(path.join(destinationDir, 'uploads', 'stale.bin'), Buffer.from('must-be-removed'));
    const importResponse = await fetch(`http://127.0.0.1:${destination.port}/api/host/data/import-binary?scopes=all`, { method: 'POST', headers: auth(destinationLogin.token, { 'Content-Type': 'application/octet-stream' }), body: archive });
    const imported = await importResponse.json();
    assert.equal(importResponse.status, 200, JSON.stringify(imported));
    assert.equal(imported.success, true, imported.error);
    assert.equal(fs.existsSync(path.join(destinationDir, 'uploads', 'stale.bin')), false, 'full import should remove stale managed files');
    const migratedState = JSON.parse(fs.readFileSync(path.join(destinationDir, 'config.json'), 'utf8'));
    assert.ok(migratedState.accounts.MigrationOwner, 'full import should restore registered accounts');
    assert.equal(migratedState.rooms.MIGRATE1?.name, '迁移源房间', 'full import should restore owned rooms');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destinationDir, 'server-config.json'), 'utf8')), { port: 5151, autostart: true });
    for (const [relative, expected] of [
      [`uploads/${file.storedName}`, 'migration-original'],
      [`compatible-media/${file.id}.mp4`, 'migration-compatible'],
      ['avatars/MigrationOwner.bin', 'migration-avatar'],
      ['chat-images/chat-image.bin', 'migration-chat-image'],
      ['voice/voice-message.bin', 'migration-voice'],
      ['.secrets/mail.key', `${Buffer.alloc(32, 7).toString('base64')}\n`],
      ['secrets/migration-marker.txt', 'migration-admin-secret'],
      ['tools/cloudflared-windows-amd64.exe', 'migration-cloudflared'],
      ['download-assets/migration-client.exe', 'migration-download-asset']
    ]) {
      const contents = fs.readFileSync(path.join(destinationDir, relative));
      assert.equal(contents.equals(Buffer.isBuffer(expected) ? expected : Buffer.from(expected)), true, `migrated ${relative}`);
    }
    assert.equal(fs.existsSync(path.join(destinationDir, 'cache', 'do-not-export.tmp')), false, 'transient cache must not migrate');
    const importerStillWorks = await fetch(`http://127.0.0.1:${destination.port}/api/server-info`, { headers: auth(destinationLogin.token) });
    assert.equal(importerStillWorks.status, 200, 'the importing request session should remain usable');
    const revoked = await fetch(`http://127.0.0.1:${destination.port}/api/server-info`, { headers: auth(staleLogin.token) });
    assert.equal(revoked.status, 401, 'import should revoke other old sessions');

    const badArchive = Buffer.from(archive); badArchive[badArchive.length - 1] ^= 0xff;
    const freshSocket = await connect(`http://127.0.0.1:${destination.port}`);
    const freshLogin = await loginHost(freshSocket, 'migration-host');
    const beforeRollback = fs.readFileSync(path.join(destinationDir, 'config.json'));
    const traversalArchive = rewriteArchivePath(archive, 'config.json', '../evil.txt');
    const traversal = await fetch(`http://127.0.0.1:${destination.port}/api/host/data/import-binary?scopes=all`, { method: 'POST', headers: auth(freshLogin.token, { 'Content-Type': 'application/octet-stream' }), body: traversalArchive });
    assert.equal(traversal.status, 400);
    assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false, 'path traversal must never write outside the staging directory');
    assert.equal(fs.readFileSync(path.join(destinationDir, 'config.json')).equals(beforeRollback), true, 'path traversal rejection must not modify the destination');
    const failed = await fetch(`http://127.0.0.1:${destination.port}/api/host/data/import-binary?scopes=all`, { method: 'POST', headers: auth(freshLogin.token, { 'Content-Type': 'application/octet-stream' }), body: badArchive });
    assert.equal(failed.status, 400);
    assert.equal(fs.readFileSync(path.join(destinationDir, 'config.json')).equals(beforeRollback), true, 'hash failure must leave config untouched');
    freshSocket.close();
    console.log('Full server migration backup export/import, integrity, transient exclusion, session revocation, and rollback tests passed.');
  } finally {
    sourceSocket?.close(); destinationSocket?.close(); staleSocket?.close();
    await source?.close().catch(() => {});
    await destination?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
