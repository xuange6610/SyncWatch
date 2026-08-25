'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-download-assets-'));
const dataDir = path.join(root, 'data');
const publicDir = path.resolve(__dirname, '..', 'public');
const hostToken = 'download-assets-host-token';
let server;
let socket;

function connect(baseUrl) {
  return new Promise((resolve, reject) => {
    const client = io(baseUrl, {
      transports: ['websocket'], reconnection: false, forceNew: true,
      extraHeaders: { Origin: baseUrl }
    });
    const timer = setTimeout(() => reject(new Error('Socket.IO 连接超时')), 10000);
    client.once('connect', () => { clearTimeout(timer); resolve(client); });
    client.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function ack(client, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 响应超时`)), 10000);
    client.emit(event, payload, (result) => { clearTimeout(timer); resolve(result); });
  });
}

async function acceptAgreement(client, login) {
  if (!login.success || !login.capabilities?.agreementRequired) return login;
  const accepted = await ack(client, 'agreement-accept', { accepted: true, version: login.agreement.version });
  assert.equal(accepted.success, true, accepted.error);
  return login;
}

function fixture(signature, { dmg = false } = {}) {
  const bytes = Buffer.alloc(1024 * 1024 + 4096, 0x5a);
  Buffer.from(signature, 'binary').copy(bytes, 0);
  if (dmg) Buffer.from('koly', 'ascii').copy(bytes, bytes.length - 64);
  return bytes;
}

async function upload(baseUrl, token, kind, filename, bytes, architecture = '') {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  const response = await fetch(`${baseUrl}/api/download-assets/${kind}${architecture ? `?arch=${architecture}` : ''}`, {
    method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form
  });
  let payload = {}; try { payload = await response.json(); } catch (_) {}
  return { response, payload };
}

async function start() {
  return startSyncWatchServer({
    host: '127.0.0.1', port: 0, dataDir, publicDir, discovery: false,
    hostControlToken: hostToken, ffprobePath: '', ffmpegPath: '', discoverDefaultMacArtifacts: false
  });
}

async function main() {
  try {
    server = await start();
    let baseUrl = `http://127.0.0.1:${server.port}`;
    const initial = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(initial.clientDownloadAvailable, false);
    assert.equal(initial.androidApkAvailable, false);

    const unauthenticated = await upload(baseUrl, '', 'windows-server', 'server.exe', fixture('MZ'));
    assert.equal(unauthenticated.response.status, 401, '公开访问不能上传客户端下载文件');

    socket = await connect(baseUrl);
    const login = await acceptAgreement(socket, await ack(socket, 'host-admin-login', {
      adminPassword: 'admin888', hostToken, deviceId: 'download-assets-admin'
    }));
    assert.equal(login.success, true, login.error);

    const invalid = await upload(baseUrl, login.token, 'windows-server', '../outside.txt', fixture('MZ'));
    assert.equal(invalid.response.status, 415);
    assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false, '上传文件名不能控制目标路径');

    const windows = await upload(baseUrl, login.token, 'windows-server', 'portable.exe', fixture('MZ'));
    assert.equal(windows.response.status, 200, windows.payload.error);
    const android = await upload(baseUrl, login.token, 'android-client', 'client.apk', fixture('PK\x03\x04'));
    assert.equal(android.response.status, 200, android.payload.error);
    const macServer = await upload(baseUrl, login.token, 'macos-server', 'server.zip', fixture('PK\x03\x04'), 'x64');
    assert.equal(macServer.response.status, 200, macServer.payload.error);
    const macClient = await upload(baseUrl, login.token, 'macos-client', 'client.dmg', fixture('DMG!', { dmg: true }), 'arm64');
    assert.equal(macClient.response.status, 200, macClient.payload.error);

    const config = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(config.clientDownloadAvailable, true);
    assert.equal(config.androidApkAvailable, true);
    assert.ok(config.macServerDownloads.some((entry) => entry.architecture === 'x64' && entry.formats.includes('zip')));
    assert.ok(config.macClientDownloads.some((entry) => entry.architecture === 'arm64' && entry.formats.includes('dmg')));
    assert.equal((await fetch(`${baseUrl}/api/client-download`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/android-apk`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/macos-server-download?arch=x64&format=zip`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/macos-client-download?arch=arm64&format=dmg`, { method: 'HEAD' })).status, 200);

    socket.close(); socket = null;
    await server.close(); server = null;
    server = await start();
    baseUrl = `http://127.0.0.1:${server.port}`;
    const restarted = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(restarted.clientDownloadAvailable, true, 'Windows 下载文件应在重启后继续可用');
    assert.equal(restarted.androidApkAvailable, true, 'Android 下载文件应在重启后继续可用');
    assert.ok(restarted.macServerDownloads.some((entry) => entry.architecture === 'x64' && entry.formats.includes('zip')));
    assert.ok(restarted.macClientDownloads.some((entry) => entry.architecture === 'arm64' && entry.formats.includes('dmg')));
    const temporary = path.join(dataDir, 'download-assets', '.temporary');
    assert.deepEqual(fs.readdirSync(temporary), [], '成功和失败上传都不能遗留临时文件');
    console.log('客户端下载固定目标上传、权限、文件签名、下载与重启持久化回归通过。');
  } finally {
    socket?.close();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
