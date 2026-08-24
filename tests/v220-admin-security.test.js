'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-v220-admin-'));
const dataDir = path.join(root, 'data');
const sockets = [];
let server;

function connect(baseUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      transports: ['websocket'], reconnection: false, forceNew: true,
      extraHeaders: { Origin: baseUrl, ...headers }
    });
    const timer = setTimeout(() => reject(new Error('Socket.IO 连接超时')), 10000);
    socket.once('connect', () => { clearTimeout(timer); sockets.push(socket); resolve(socket); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function ack(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 响应超时`)), 10000);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result); });
  });
}

async function acceptAgreement(socket, login) {
  if (!login.success || !login.capabilities?.agreementRequired) return login;
  const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: login.agreement.version });
  assert.equal(accepted.success, true, accepted.error);
  return login;
}

async function main() {
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, discovery: false,
      publicDir: path.resolve(__dirname, '..', 'public'), ffprobePath: '', ffmpegPath: ''
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const config = await (await fetch(`${baseUrl}/api/public-config`, { headers: { Origin: baseUrl } })).json();
    assert.equal(config.serverHostPasswordlessAvailable, true);

    const first = await connect(baseUrl);
    const firstLogin = await acceptAgreement(first, await ack(first, 'host-admin-login', { passwordless: true, deviceId: 'admin-one' }));
    assert.equal(firstLogin.success, true, firstLogin.error);
    const saved = await ack(first, 'admin-action', { action: 'set-admin-session-limit', limit: 2 });
    assert.equal(saved.success, true, saved.error);
    assert.equal(saved.limit, 2);
    const matchingLogs = await ack(first, 'server-logs', { accountQuery: 'DmI', limit: 50 });
    assert.equal(matchingLogs.success, true, matchingLogs.error);
    assert.ok(matchingLogs.logs.length > 0);
    assert.ok(matchingLogs.logs.every((entry) => [entry.actor, entry.actorName].some((value) => String(value || '').toLowerCase().includes('dmi'))));
    assert.equal((await ack(first, 'server-logs', { accountQuery: 'definitely-not-this-account', limit: 50 })).logs.length, 0);

    const second = await connect(baseUrl);
    const secondLogin = await acceptAgreement(second, await ack(second, 'host-admin-login', { passwordless: true, deviceId: 'admin-two' }));
    assert.equal(secondLogin.success, true, secondLogin.error);

    const third = await connect(baseUrl);
    const thirdLogin = await ack(third, 'host-admin-login', { passwordless: true, deviceId: 'admin-three' });
    assert.equal(thirdLogin.success, false);
    assert.equal(thirdLogin.code, 'ADMIN_SESSION_LIMIT');

    const proxy = await connect(baseUrl, { 'x-forwarded-for': '203.0.113.50' });
    const proxyLogin = await ack(proxy, 'host-admin-login', { passwordless: true, deviceId: 'proxy-admin' });
    assert.equal(proxyLogin.success, false, '代理转发的公网访问不能使用本机免密入口');

    const kicked = new Promise((resolve) => second.once('auth-error', resolve));
    const lowered = await ack(first, 'admin-action', { action: 'set-admin-session-limit', limit: 1 });
    assert.equal(lowered.success, true, lowered.error);
    assert.equal(lowered.limit, 1);
    assert.match(await kicked, /同时登录|上限/);
    assert.equal((await ack(first, 'admin-action', { action: 'get-settings' })).admin.adminMaxConcurrentSessions, 1);

    await server.close(); server = null;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(persisted.admin.adminMaxConcurrentSessions, 1);
    console.log('v2.2.0 本机免密边界与 admin 并发会话上限回归通过。');
  } finally {
    for (const socket of sockets) socket.close();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
