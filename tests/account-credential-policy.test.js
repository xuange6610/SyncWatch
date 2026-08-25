'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

const USERNAME_MAX_UTF8_BYTES = 1024;
const PASSWORD_MAX_UTF8_BYTES = 4096;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-credential-policy-'));
const dataDir = path.join(root, 'data');
const sockets = [];
let server;

function connect(baseUrl) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true });
    const timer = setTimeout(() => reject(new Error('Socket.IO 连接超时')), 10000);
    socket.once('connect', () => { clearTimeout(timer); sockets.push(socket); resolve(socket); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function ack(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 响应超时`)), 10000);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result || {}); });
  });
}

async function acceptAgreement(socket, result) {
  if (!result?.success || !result.capabilities?.agreementRequired) return result;
  const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: result.agreement.version });
  assert.equal(accepted.success, true, accepted.error);
  return result;
}

async function main() {
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, discovery: false,
      publicDir: path.resolve(__dirname, '..', 'public'), ffprobePath: '', ffmpegPath: '',
      hostControlToken: 'credential-policy-host'
    });
    let baseUrl = `http://127.0.0.1:${server.port}`;
    let config = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.deepEqual(config.usernamePolicy, {
      mode: 'unrestricted', lengthRestricted: false,
      minLength: 1, maxLength: USERNAME_MAX_UTF8_BYTES, maxBytes: USERNAME_MAX_UTF8_BYTES
    });
    assert.deepEqual(config.passwordPolicy, {
      mode: 'unrestricted', lengthRestricted: false,
      minLength: 1, maxLength: PASSWORD_MAX_UTF8_BYTES, maxBytes: PASSWORD_MAX_UTF8_BYTES, expiryDays: 7
    });

    const owner = await connect(baseUrl);
    const unicodeUsername = '影 迷 /🙂!@';
    const unicodePassword = ' 密码 /🙂! ';
    let result = await ack(owner, 'user-register', { username: unicodeUsername, password: unicodePassword });
    assert.equal(result.success, true, result.error);
    result = await acceptAgreement(owner, await ack(owner, 'user-login', { username: unicodeUsername, password: unicodePassword }));
    assert.equal(result.success, true, result.error);

    const admin = await connect(baseUrl);
    result = await acceptAgreement(admin, await ack(admin, 'host-admin-login', { adminPassword: 'admin888', hostToken: 'credential-policy-host' }));
    assert.equal(result.success, true, result.error);
    result = await ack(admin, 'admin-action', { action: 'add-registration-whitelist', ipAddress: '127.0.0.1' });
    assert.equal(result.success, true, result.error);

    result = await ack(owner, 'user-register', { username: '单', password: '密' });
    assert.equal(result.success, true, result.error);
    result = await acceptAgreement(owner, await ack(owner, 'user-login', { username: '单', password: '密' }));
    assert.equal(result.success, true, result.error);

    const ceilingUsername = '🙂'.repeat(USERNAME_MAX_UTF8_BYTES / 4);
    const ceilingPassword = '🔐'.repeat(PASSWORD_MAX_UTF8_BYTES / 4);
    result = await ack(owner, 'user-register', { username: ceilingUsername, password: ceilingPassword });
    assert.equal(result.success, true, result.error);
    result = await acceptAgreement(owner, await ack(owner, 'user-login', { username: ceilingUsername, password: ceilingPassword }));
    assert.equal(result.success, true, result.error);

    result = await ack(owner, 'user-register', { username: `${ceilingUsername}🙂`, password: 'ok' });
    assert.equal(result.success, false, '账号超过 UTF-8 防滥用上限时不能注册');
    assert.match(result.error || '', /1024.*UTF-8.*字节/);
    result = await ack(owner, 'user-register', { username: '密码字节上限', password: `${ceilingPassword}🔐` });
    assert.equal(result.success, false, '密码超过 UTF-8 防滥用上限时不能注册');
    assert.match(result.error || '', /4096.*UTF-8.*字节/);

    result = await ack(admin, 'admin-action', {
      action: 'set-password-policy', mode: 'english_digits', lengthRestricted: true,
      minLength: 8, maxLength: 12, expiryDays: 0,
      usernamePolicy: { mode: 'safe', lengthRestricted: true, minLength: 3, maxLength: 8 }
    });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.usernamePolicy, {
      mode: 'safe', lengthRestricted: true, minLength: 3, maxLength: 8, maxBytes: USERNAME_MAX_UTF8_BYTES
    });
    assert.deepEqual(result.passwordPolicy, {
      mode: 'english_digits', lengthRestricted: true,
      minLength: 8, maxLength: 12, maxBytes: PASSWORD_MAX_UTF8_BYTES, expiryDays: 0
    });

    result = await ack(owner, 'user-register', { username: 'User_12', password: 'Pass1234' });
    assert.equal(result.success, true, result.error);
    result = await ack(owner, 'user-register', { username: 'Bad!12', password: 'Pass1234' });
    assert.equal(result.success, false);
    result = await ack(owner, 'user-register', { username: 'LongUser9', password: 'Pass1234' });
    assert.equal(result.success, false, '账号超过配置上限时不能注册');
    result = await ack(owner, 'user-register', { username: 'Num123', password: 'Pass!234' });
    assert.equal(result.success, false, '密码模式不允许符号时不能注册');
    result = await ack(owner, 'user-register', { username: 'Num123', password: 'Pass12' });
    assert.equal(result.success, false, '密码低于配置下限时不能注册');

    config = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.deepEqual(config.usernamePolicy, {
      mode: 'safe', lengthRestricted: true, minLength: 3, maxLength: 8, maxBytes: USERNAME_MAX_UTF8_BYTES
    });
    assert.deepEqual(config.passwordPolicy, {
      mode: 'english_digits', lengthRestricted: true,
      minLength: 8, maxLength: 12, maxBytes: PASSWORD_MAX_UTF8_BYTES, expiryDays: 0
    });
    owner.close(); admin.close();
    await server.close(); server = null;
    await new Promise((resolve) => setTimeout(resolve, 100));

    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, discovery: false,
      publicDir: path.resolve(__dirname, '..', 'public'), ffprobePath: '', ffmpegPath: '',
      hostControlToken: 'credential-policy-host'
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    config = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.deepEqual(config.usernamePolicy, {
      mode: 'safe', lengthRestricted: true, minLength: 3, maxLength: 8, maxBytes: USERNAME_MAX_UTF8_BYTES
    });
    assert.deepEqual(config.passwordPolicy, {
      mode: 'english_digits', lengthRestricted: true,
      minLength: 8, maxLength: 12, maxBytes: PASSWORD_MAX_UTF8_BYTES, expiryDays: 0
    });
    console.log('账号/密码策略：默认无业务长度和符号限制、UTF-8 字节安全上限、可配置限制及重启持久化回归通过。');
  } finally {
    for (const socket of sockets) socket.close();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
