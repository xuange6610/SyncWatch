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
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
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
    assert.match(appSource, /canSkipInitialAccountPasswordVerification/);
    assert.match(appSource, /let step = skipCurrentPasswordVerification \? 1 : 0/,
      '密码认证的首次管理员改密必须从新密码步骤开始');
    assert.match(serverSource, /passwordAuthenticated: true/);
    assert.match(serverSource, /skipCurrentPasswordVerification/);
    const hostToken = 'v220-local-owner-token';
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, discovery: false,
      publicDir: path.resolve(__dirname, '..', 'public'), ffprobePath: '', ffmpegPath: '', hostControlToken: hostToken
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const untrustedConfig = await (await fetch(`${baseUrl}/api/public-config`, { headers: { Origin: baseUrl } })).json();
    assert.equal(untrustedConfig.serverHostPasswordlessManagementAvailable, false, '缺少主机令牌时不能暴露免密入口');
    const config = await (await fetch(`${baseUrl}/api/public-config`, { headers: { Origin: baseUrl, 'X-SyncWatch-Host-Token': hostToken } })).json();
    assert.equal(config.serverHostPasswordlessManagementAvailable, true);
    assert.equal(config.serverHostPasswordlessRoomAvailable, true);

    let first = await connect(baseUrl);
    assert.equal((await ack(first, 'host-admin-login', { passwordless: true, hostToken })).code, 'DEDICATED_PASSWORDLESS_EVENT_REQUIRED');
    const firstLogin = await acceptAgreement(first, await ack(first, 'host-passwordless-management-login', { hostToken, deviceId: 'admin-one' }));
    assert.equal(firstLogin.success, true, firstLogin.error);
    assert.equal(firstLogin.sessionMode, 'management');
    assert.equal(firstLogin.capabilities.canSetInitialAccountPassword, true);
    assert.equal(firstLogin.capabilities.canSkipInitialAccountPasswordVerification, false,
      '本机免密会话不能跳过首次改密的当前密码校验');
    const passwordlessBypass = await ack(first, 'account-action', {
      action: 'change-password', initialSetup: true, currentPassword: '', newPassword: 'V220ForgedPassword!'
    });
    assert.equal(passwordlessBypass.success, false);
    assert.equal(passwordlessBypass.code, 'CURRENT_PASSWORD_INVALID');
    const passwordlessReuse = await ack(first, 'account-action', {
      action: 'change-password', initialSetup: true, currentPassword: 'admin888', newPassword: 'admin888'
    });
    assert.equal(passwordlessReuse.success, false);
    assert.equal(passwordlessReuse.code, 'PASSWORD_REUSE', '首次管理改密不能通过重复提交旧密码绕过');

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 140));
    first = await connect(baseUrl);
    const passwordLogin = await acceptAgreement(first, await ack(first, 'host-admin-login', {
      adminPassword: 'admin888', hostToken, deviceId: 'admin-one'
    }));
    assert.equal(passwordLogin.success, true, passwordLogin.error);
    assert.equal(passwordLogin.sessionMode, 'management');
    assert.equal(passwordLogin.capabilities.canSkipInitialAccountPasswordVerification, true,
      '刚通过管理员密码认证的首次登录应直接进入新密码步骤');
    const shortPassword = await ack(first, 'account-action', {
      action: 'change-password', initialSetup: true, currentPassword: '', newPassword: 'x'
    });
    assert.equal(shortPassword.success, false);
    assert.match(shortPassword.error || '', /至少需要 8 位/, '服务端必须执行首次管理员密码最小长度规则');
    const reusedPassword = await ack(first, 'account-action', {
      action: 'change-password', initialSetup: true, currentPassword: '', newPassword: 'admin888'
    });
    assert.equal(reusedPassword.success, false);
    assert.equal(reusedPassword.code, 'PASSWORD_REUSE');
    const changedPassword = await ack(first, 'account-action', {
      action: 'change-password', initialSetup: true, currentPassword: '', newPassword: 'V220AdminPassword!'
    });
    assert.equal(changedPassword.success, true, changedPassword.error);
    assert.equal(changedPassword.initialSetup, true);
    const resumedManagement = await ack(first, 'session-resume', {
      token: changedPassword.token, hostToken, deviceId: 'admin-one'
    });
    assert.equal(resumedManagement.success, true, resumedManagement.error);
    assert.equal(resumedManagement.sessionMode, 'management', '改密替换 token 后管理专用会话不能降级为观影会话');
    assert.equal(resumedManagement.capabilities.canSkipInitialAccountPasswordVerification, false,
      '首次改密完成后必须立即撤销免重复校验能力');
    const laterBypass = await ack(first, 'account-action', {
      action: 'change-password', initialSetup: true, currentPassword: '', newPassword: 'V220LaterPassword!'
    });
    assert.equal(laterBypass.success, false);
    assert.equal(laterBypass.code, 'CURRENT_PASSWORD_INVALID', '后续改密仍必须校验当前密码');
    const saved = await ack(first, 'admin-action', { action: 'set-admin-session-limit', limit: 3 });
    assert.equal(saved.success, true, saved.error);
    assert.equal(saved.limit, 3);
    const matchingLogs = await ack(first, 'server-logs', { accountQuery: 'DmI', limit: 50 });
    assert.equal(matchingLogs.success, true, matchingLogs.error);
    assert.ok(matchingLogs.logs.length > 0);
    assert.ok(matchingLogs.logs.every((entry) => [entry.actor, entry.actorName].some((value) => String(value || '').toLowerCase().includes('dmi'))));
    assert.equal((await ack(first, 'server-logs', { accountQuery: 'definitely-not-this-account', limit: 50 })).logs.length, 0);

    const second = await connect(baseUrl);
    const secondLogin = await acceptAgreement(second, await ack(second, 'host-passwordless-room-login', {
      hostToken, roomId: passwordLogin.room.id, deviceId: 'admin-two'
    }));
    assert.equal(secondLogin.success, true, secondLogin.error);
    assert.equal(secondLogin.sessionMode, 'room', '本机免密进入房间不能变成 managementOnly 会话');
    assert.equal(secondLogin.room.id, passwordLogin.room.id);
    assert.equal((await ack(second, 'admin-action', { action: 'get-settings' })).success, true, '进入房间后 admin 管理权限保持不回归');

    const third = await connect(baseUrl);
    const forgedLogin = await ack(third, 'host-passwordless-management-login', { hostToken: 'forged-token', deviceId: 'forged-admin' });
    assert.equal(forgedLogin.success, false);
    assert.equal(forgedLogin.code, 'LOCAL_PASSWORDLESS_FORBIDDEN');

    const proxy = await connect(baseUrl, { 'x-forwarded-for': '203.0.113.50' });
    const proxyLogin = await ack(proxy, 'host-passwordless-management-login', { hostToken, deviceId: 'proxy-admin' });
    assert.equal(proxyLogin.success, false, '代理转发的公网访问不能使用本机免密入口');

    const disabled = await ack(first, 'admin-action', {
      action: 'set-local-passwordless-access', managementEnabled: false, roomEnabled: false
    });
    assert.equal(disabled.success, true, disabled.error);
    assert.equal((await ack(third, 'host-passwordless-management-login', { hostToken })).code, 'LOCAL_PASSWORDLESS_DISABLED');
    assert.equal((await ack(third, 'host-passwordless-room-login', { hostToken, roomId: firstLogin.room.id })).code, 'LOCAL_PASSWORDLESS_DISABLED');
    const disabledConfig = await (await fetch(`${baseUrl}/api/public-config`, { headers: { Origin: baseUrl, 'X-SyncWatch-Host-Token': hostToken } })).json();
    assert.equal(disabledConfig.serverHostPasswordlessManagementAvailable, false);
    assert.equal(disabledConfig.serverHostPasswordlessRoomAvailable, false);

    const reenabled = await ack(first, 'admin-action', {
      action: 'set-local-passwordless-access', managementEnabled: true, roomEnabled: true
    });
    assert.equal(reenabled.success, true, reenabled.error);
    const logoutResponse = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST', headers: { Authorization: `Bearer ${changedPassword.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerExitAction: 'delete' })
    });
    assert.equal(logoutResponse.status, 200);
    const revokedResponse = await fetch(`${baseUrl}/api/server-info`, { headers: { Authorization: `Bearer ${changedPassword.token}` } });
    assert.equal(revokedResponse.status, 401, '退出管理登录后服务端 token 必须立即失效');

    await server.close(); server = null;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(persisted.admin.localPasswordlessManagementEnabled, true);
    assert.equal(persisted.admin.localPasswordlessRoomEnabled, true);
    console.log('v2.2.0 本机免密管理/入房边界、开关与退出撤销回归通过。');
  } finally {
    for (const socket of sockets) socket.close();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
