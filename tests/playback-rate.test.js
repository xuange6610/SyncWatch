'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

function emitAck(socket, event, payload = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} response timed out`)), timeout);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result || { success: false, error: 'No acknowledgement returned' });
    });
  });
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], reconnection: false, timeout: 10000 });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

function nextEvent(socket, event, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} event timed out`)), timeout);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-playback-rate-'));
  let server;
  let socket;
  try {
    server = await startSyncWatchServer({
      port: 0, host: '127.0.0.1', dataDir, publicDir: path.resolve(__dirname, '..', 'public'),
      ffmpegPath: '', ffprobePath: '', discovery: false
    });
    socket = await connect(`http://127.0.0.1:${server.port}`);
    assert.equal((await emitAck(socket, 'user-register', {
      username: 'RateOwner', password: 'rate-pass'
    })).success, true);
    const login = await emitAck(socket, 'room-create', {
      username: 'RateOwner', password: 'rate-pass', customRoomId: 'RATE01', roomName: 'Rate room'
    });
    assert.equal(login.success, true, login.error);
    if (login.capabilities?.agreementRequired) {
      assert.equal((await emitAck(socket, 'agreement-accept', {
        accepted: true, version: login.agreement.version
      })).success, true);
    }
    const remote = await emitAck(socket, 'add-remote-video', {
      url: 'https://media.example.test/demo.mp4', name: 'demo.mp4'
    });
    assert.equal(remote.success, true, remote.error);
    assert.equal((await emitAck(socket, 'select-file', { fileId: remote.file.id })).success, true);

    const commandEvent = nextEvent(socket, 'playback-command');
    const faster = await emitAck(socket, 'playback-command', { action: 'rate', rate: 2.5 });
    assert.equal(faster.success, true, faster.error);
    assert.equal(faster.change.after.playbackRate, 2.5);
    const broadcast = await commandEvent;
    assert.equal(broadcast.playbackRate, 2.5);
    assert.equal(broadcast.speed, 2.5);

    // The server's periodic snapshot must advance at the shared rate.  If it
    // advances at wall-clock speed, the next rate command sends clients back
    // into already played media and causes repeated playback.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // A delayed owner progress report must not rewind the server projection.
    // This is the long-running 2.5x regression: real clients report their
    // local media clock periodically, and network/buffer delay can make that
    // clock older than the server's already projected position.
    socket.emit('playback-progress', {
      fileId: remote.file.id,
      currentTime: 0.1,
      isPlaying: true,
      stalled: false,
      revision: faster.change.afterRevision
    });
    const changedRate = await emitAck(socket, 'playback-command', { action: 'rate', rate: 2 });
    assert.equal(changedRate.success, true, changedRate.error);
    assert.ok(changedRate.change.before.currentTime > 2,
      `2.5x playback should advance more than two seconds in 1.1 seconds; got ${changedRate.change.before.currentTime}`);
    assert.equal(changedRate.change.after.playbackRate, 2);

    const seek = await emitAck(socket, 'playback-command', { action: 'seek', currentTime: 12 });
    assert.equal(seek.success, true, seek.error);
    assert.equal(seek.change.after.playbackRate, 2, 'Seeking must preserve the synchronized rate.');
    assert.equal((await emitAck(socket, 'playback-command', { action: 'speed', speed: 3.1 })).success, false);
    assert.equal((await emitAck(socket, 'playback-command', { action: 'playback-rate', playbackRate: 0.5 })).success, true);
    console.log('Playback rate synchronization and 0.5x-3x authorization bounds passed.');
  } finally {
    socket?.disconnect();
    if (server) await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
