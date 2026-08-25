'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

function connect(baseUrl) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
    const timer = setTimeout(() => { socket.close(); reject(new Error('Socket.IO 连接超时')); }, 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (error) => { clearTimeout(timer); socket.close(); reject(error); });
  });
}

function ack(socket, event, payload = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 响应超时`)), timeout);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result || {}); });
  });
}

function once(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 事件超时`)), timeout);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

async function acceptAgreement(socket, result) {
  if (!result?.success || !result.capabilities?.agreementRequired) return result;
  const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: result.agreement.version });
  assert.equal(accepted.success, true, accepted.error);
  return result;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-ui-copy-'));
  const dataDir = path.join(root, 'data');
  const sockets = [];
  let server;
  try {
    server = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir, discovery: false, publicDir: path.resolve(__dirname, '..', 'public'), ffprobePath: '', ffmpegPath: '', hostControlToken: 'ui-copy-host' });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const initial = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(initial.uiCopy['login.title'], '登录 SyncWatch同步观影');

    const admin = await connect(baseUrl); sockets.push(admin);
    const adminLogin = await acceptAgreement(admin, await ack(admin, 'host-admin-login', { adminPassword: 'admin888', hostToken: 'ui-copy-host', roomId: initial.roomId }));
    assert.equal(adminLogin.success, true, adminLogin.error);

    const member = await connect(baseUrl); sockets.push(member);
    const registration = await ack(member, 'user-register', { username: 'CopyMember', password: 'copy-pass-123' });
    assert.equal(registration.success, true, registration.error);
    const memberLogin = await acceptAgreement(member, await ack(member, 'user-login', { username: 'CopyMember', password: 'copy-pass-123', roomId: initial.roomId }));
    assert.equal(memberLogin.success, true, memberLogin.error);

    const forbidden = await ack(member, 'admin-action', { action: 'set-ui-copy', entries: { 'login.title': '不应保存' } });
    assert.equal(forbidden.success, false, '普通成员不能修改统一文案');

    const eventPromise = once(member, 'ui-copy-state');
    const saved = await ack(admin, 'admin-action', { action: 'set-ui-copy', entries: { 'login.title': '家庭影院登录', 'player.emptyHint': '请选择同一部影片开始同步。' } });
    assert.equal(saved.success, true, saved.error);
    assert.equal(saved.uiCopy['login.title'], '家庭影院登录');
    const event = await eventPromise;
    assert.equal(event.uiCopy['login.title'], '家庭影院登录');

    const generatedKey = 'ui.auto.checkupdatebtn.text.0123abcd';
    const generatedEventPromise = once(member, 'ui-copy-state');
    const generatedSaved = await ack(admin, 'admin-action', { action: 'set-ui-copy', entries: { [generatedKey]: '检查服务器更新' } });
    assert.equal(generatedSaved.success, true, generatedSaved.error);
    assert.equal(generatedSaved.uiCopy[generatedKey], '检查服务器更新');
    assert.equal((await generatedEventPromise).uiCopy[generatedKey], '检查服务器更新');

    const unknown = await ack(admin, 'admin-action', { action: 'set-ui-copy', entries: { 'document.body.innerHTML': '恶意' } });
    assert.equal(unknown.success, false); assert.equal(unknown.code, 'UI_COPY_INVALID');
    const selectorLike = await ack(admin, 'admin-action', { action: 'set-ui-copy', entries: { 'ui.auto.#accountdropdown.text.0123abcd': '恶意选择器' } });
    assert.equal(selectorLike.success, false); assert.equal(selectorLike.code, 'UI_COPY_INVALID');
    const html = await ack(admin, 'admin-action', { action: 'set-ui-copy', entries: { 'login.title': '<img src=x>' } });
    assert.equal(html.success, false); assert.equal(html.code, 'UI_COPY_INVALID');
    const tooLong = await ack(admin, 'admin-action', { action: 'set-ui-copy', entries: { 'login.title': 'x'.repeat(241) } });
    assert.equal(tooLong.success, false); assert.equal(tooLong.code, 'UI_COPY_INVALID');

    const exported = await ack(admin, 'admin-action', { action: 'export-ui-copy' });
    assert.equal(exported.success, true); assert.match(exported.json, /家庭影院登录/);
    const imported = await ack(admin, 'admin-action', { action: 'import-ui-copy', json: exported.json });
    assert.equal(imported.success, true); assert.equal(imported.uiCopy['player.emptyHint'], '请选择同一部影片开始同步。');
    const futureVersion = await ack(admin, 'admin-action', { action: 'import-ui-copy', json: JSON.stringify({ version: 999, uiCopy: { 'login.title': '未来格式' } }) });
    assert.equal(futureVersion.success, false); assert.equal(futureVersion.code, 'UI_COPY_INVALID');
    const reset = await ack(admin, 'admin-action', { action: 'reset-ui-copy' });
    assert.equal(reset.success, true); assert.equal(reset.uiCopy['login.title'], '登录 SyncWatch同步观影');

    const appSource = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    const htmlSource = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(appSource, /function applyUiCopy/);
    assert.match(appSource, /ui-copy-state/);
    assert.match(appSource, /import-ui-copy/);
    assert.match(appSource, /uiCopySearch/);
    assert.match(htmlSource, /data-copy-key="login\.title"/);
    assert.match(htmlSource, /data-copy-key="closeDialog\.title"/);
    assert.match(htmlSource, /id="serverSettingsLoginBtn"[^>]*data-copy-key="topbar\.serverSettings"/);
    assert.match(htmlSource, /id="managementHubBtn"[^>]*data-copy-key="topbar\.management"/);
    assert.match(htmlSource, /id="logoutKeepCredentialsBtn"[^>]*data-copy-key="topbar\.logoutKeepCredentials"/);
    assert.match(htmlSource, /id="logoutBtn"[^>]*data-copy-key="topbar\.logout"/);
    assert.match(htmlSource, /ui-copy-runtime\.js/);

    await server.close(); server = null;
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.deepEqual(persisted.admin.uiCopy['login.title'], '登录 SyncWatch同步观影');
    console.log('统一 UI 文案白名单、权限、导入导出、Socket 广播与持久化回归通过。');
  } finally {
    for (const socket of sockets) socket.close();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
