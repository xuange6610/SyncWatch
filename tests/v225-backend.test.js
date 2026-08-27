'use strict';

require('./epipe-guard');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

function ack(socket, event, payload = {}, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} response timeout`)), timeout);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result || {}); });
  });
}

async function connect(baseUrl, headers = {}) {
  const socket = io(baseUrl, { transports: ['websocket'], reconnection: false, timeout: 10000, transportOptions: { websocket: { extraHeaders: headers } } });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}

async function acceptAgreement(socket, result) {
  if (result.success && result.capabilities?.agreementRequired) {
    const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: result.agreement.version });
    assert.equal(accepted.success, true, accepted.error);
  }
  return result;
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-v225-'));
  const sockets = [];
  let server;
  try {
    server = await startSyncWatchServer({ port: 0, host: '127.0.0.1', dataDir, publicDir: path.resolve(__dirname, '..', 'public'), ffmpegPath: '', ffprobePath: '', discovery: false, hostControlToken: 'v225-host' });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const owner = await connect(baseUrl); sockets.push(owner);
    assert.equal((await ack(owner, 'user-register', { username: 'V225Owner', password: 'owner-pass' })).success, true);
    const login = await acceptAgreement(owner, await ack(owner, 'user-login', { username: 'V225Owner', password: 'owner-pass', roomId: '', deviceId: 'v225-owner' }));
    assert.equal(login.success, true, login.error);
    const room = await ack(owner, 'room-create', { roomName: 'v2.2.5 identity', customRoomId: 'V225ID', hostToken: 'v225-host', deviceId: 'v225-owner' });
    assert.equal(room.success, true, room.error);

    const renamed = await ack(owner, 'account-action', { action: 'change-login-username', username: 'V225Renamed', currentPassword: 'owner-pass' });
    assert.equal(renamed.success, true, renamed.error);
    assert.equal(renamed.profile.username, 'V225Renamed');
    assert.equal(renamed.profile.recentRooms.some((entry) => entry.id === 'V225ID'), true);
    const profileAfter = await ack(owner, 'account-action', { action: 'get-profile' });
    assert.equal(profileAfter.profile.username, 'V225Renamed');
    owner.disconnect();
    const oldSocket = await connect(baseUrl); sockets.push(oldSocket);
    const oldLogin = await ack(oldSocket, 'user-login', { username: 'V225Owner', password: 'owner-pass', roomId: 'V225ID', deviceId: 'v225-old-login' });
    assert.equal(oldLogin.success, false);
    const newSocket = await connect(baseUrl); sockets.push(newSocket);
    const newLogin = await acceptAgreement(newSocket, await ack(newSocket, 'user-login', { username: 'V225Renamed', password: 'owner-pass', roomId: 'V225ID', deviceId: 'v225-new-login' }));
    assert.equal(newLogin.success, true, newLogin.error);
    assert.equal(newLogin.room.ownerUsername, 'V225Renamed');

    const logoutResponse = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { Authorization: `Bearer ${newLogin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerExitAction: 'leave' }) });
    assert.equal(logoutResponse.status, 200);
    const replacement = await connect(baseUrl); sockets.push(replacement);
    const replacementLogin = await acceptAgreement(replacement, await ack(replacement, 'user-login', { username: 'V225Renamed', password: 'owner-pass', roomId: 'V225ID', deviceId: 'v225-replacement' }));
    assert.equal(replacementLogin.success, true, replacementLogin.error);
    console.log('v2.2.5 account identity migration and immediate logout regression passed');
  } finally {
    for (const socket of sockets) socket.disconnect();
    if (server) await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
