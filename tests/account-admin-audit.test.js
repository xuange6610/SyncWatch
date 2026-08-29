'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

function ack(socket, event, payload = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeout);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result || {});
    });
  });
}

async function connect(baseUrl, ipAddress = '') {
  const options = { transports: ['websocket'], forceNew: true, reconnection: false };
  if (ipAddress) options.transportOptions = { websocket: { extraHeaders: { 'cf-connecting-ip': ipAddress } } };
  const socket = io(baseUrl, options);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', reject);
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

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-account-audit-'));
  const sockets = [];
  let server;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir,
      publicDir: path.resolve(__dirname, '..', 'public'), hostControlToken: 'account-audit-host',
      ffprobePath: '', ffmpegPath: '', discovery: false
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const accountSocket = await connect(baseUrl, '203.0.113.41'); sockets.push(accountSocket);
    const registered = await ack(accountSocket, 'user-register', {
      username: 'AuditUser', password: 'audit-password', deviceName: '注册浏览器', platform: 'Windows', browser: 'Chrome'
    });
    assert.equal(registered.success, true, registered.error);

    const failedLogin = await ack(accountSocket, 'user-login', {
      username: 'AuditUser', password: 'wrong-password', deviceName: '失败设备', platform: 'Windows', browser: 'Chrome'
    });
    assert.equal(failedLogin.success, false);
    const login = await acceptAgreement(accountSocket, await ack(accountSocket, 'user-login', {
      username: 'AuditUser', password: 'audit-password', deviceName: '用户电脑', platform: 'Windows', browser: 'Chrome'
    }));
    assert.equal(login.success, true, login.error);

    const unauthorizedLogs = await ack(accountSocket, 'admin-action', { action: 'get-account-audit-logs' });
    assert.equal(unauthorizedLogs.success, false, '普通已登录账号不能读取账户审计日志');

    const adminSocket = await connect(baseUrl); sockets.push(adminSocket);
    const adminLogin = await acceptAgreement(adminSocket, await ack(adminSocket, 'host-admin-login', {
      adminPassword: 'admin888', hostToken: 'account-audit-host', deviceName: '服务器主机', platform: 'Windows', browser: 'Electron'
    }));
    assert.equal(adminLogin.success, true, adminLogin.error);

    const settings = await ack(adminSocket, 'admin-action', { action: 'get-settings' });
    assert.equal(settings.success, true, settings.error);
    const managed = settings.admin.accounts.find((account) => account.username === 'AuditUser');
    assert.ok(managed, '账户管理应返回目标账号');
    assert.deepEqual(Object.keys(managed.passwordStatus).sort(), ['changedAt', 'configured', 'expired', 'mustChange']);
    assert.equal(managed.passwordStatus.configured, true);
    assert.equal(Object.hasOwn(managed, 'password'), false);
    assert.equal(Object.hasOwn(managed, 'passwordHash'), false);
    assert.doesNotMatch(JSON.stringify(settings.admin.accounts), /audit-password|wrong-password/);

    const overview = await ack(adminSocket, 'admin-action', { action: 'get-account-overview', limit: 500 });
    assert.equal(overview.success, true, overview.error);
    const overviewAccount = overview.accounts.find((account) => account.username === 'AuditUser');
    assert.ok(overviewAccount, '独立账号总览 action 应返回目标账号');
    assert.equal(Object.hasOwn(overviewAccount, 'password'), false);
    assert.equal(Object.hasOwn(overviewAccount, 'passwordHash'), false);
    const deniedOverview = await ack(accountSocket, 'admin-action', { action: 'get-account-overview' });
    assert.equal(deniedOverview.success, false, '普通账号不能读取独立账号总览');

    let changedEmail = await ack(adminSocket, 'admin-action', {
      action: 'set-account-email', username: 'AuditUser', email: 'not-an-email'
    });
    assert.equal(changedEmail.success, false);
    changedEmail = await ack(adminSocket, 'admin-action', {
      action: 'set-account-email', username: 'AuditUser', email: 'audit@example.com'
    });
    assert.equal(changedEmail.success, true, changedEmail.error);
    assert.equal(changedEmail.profile.email, 'audit@example.com');
    const clearedEmail = await ack(adminSocket, 'admin-action', {
      action: 'set-account-email', username: 'AuditUser', email: ''
    });
    assert.equal(clearedEmail.success, true, clearedEmail.error);
    assert.equal(clearedEmail.profile.email, '');

    let logs = await ack(adminSocket, 'admin-action', {
      action: 'get-account-audit-logs', query: 'AuditUser', limit: 100
    });
    assert.equal(logs.success, true, logs.error);
    assert.ok(logs.logs.some((entry) => entry.category === 'register' && entry.result === 'success'));
    assert.ok(logs.logs.some((entry) => entry.category === 'login' && entry.result === 'failure'));
    assert.ok(logs.logs.some((entry) => entry.category === 'login' && entry.result === 'success'));
    assert.equal(logs.logs.some((entry) => Object.hasOwn(entry, 'password') || Object.hasOwn(entry, 'passwordHash')), false);
    assert.doesNotMatch(JSON.stringify(logs.logs), /audit-password|wrong-password/);

    const removable = logs.logs.find((entry) => entry.category === 'login' && entry.result === 'failure');
    const deletedLogs = await ack(adminSocket, 'admin-action', {
      action: 'delete-account-audit-logs', ids: [removable.id]
    });
    assert.equal(deletedLogs.success, true, deletedLogs.error);
    assert.equal(deletedLogs.deleted, 1);
    logs = await ack(adminSocket, 'admin-action', { action: 'get-account-audit-logs', query: 'AuditUser', limit: 100 });
    assert.equal(logs.logs.some((entry) => entry.id === removable.id), false);

    const badConfirmation = await ack(accountSocket, 'account-action', {
      action: 'delete-own-account', confirmation: '注销账号'
    });
    assert.equal(badConfirmation.success, false);
    assert.equal(badConfirmation.requiredConfirmation, '注销账号 AuditUser');
    const deletedAccount = await ack(accountSocket, 'account-action', {
      action: 'delete-own-account', confirmation: '注销账号 AuditUser'
    });
    assert.equal(deletedAccount.success, true, deletedAccount.error);

    await new Promise((resolve) => setTimeout(resolve, 100));
    logs = await ack(adminSocket, 'admin-action', {
      action: 'get-account-audit-logs', query: 'AuditUser', category: 'account-delete', limit: 100
    });
    assert.equal(logs.success, true, logs.error);
    assert.ok(logs.logs.some((entry) => entry.result === 'success' && entry.username === 'AuditUser'));

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(persisted.accounts.AuditUser, undefined);
    assert.ok(persisted.deletedUsernames.includes('AuditUser'));
    assert.ok(Array.isArray(persisted.accountAuditLogs));
    assert.doesNotMatch(JSON.stringify(persisted.accountAuditLogs), /audit-password|wrong-password/);
    console.log('Account password status, audit log, privileged email management, and self-deletion tests passed.');
  } finally {
    for (const socket of sockets) socket.close();
    await server?.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
