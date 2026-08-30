'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { io } = require('socket.io-client');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { startSyncWatchServer } = require('../server');

function emitAck(socket, event, payload = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeout);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result || {});
    });
  });
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 12000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

function audioForm(entries) {
  const form = new FormData();
  for (const entry of entries) {
    form.append('music', new Blob([entry.bytes], { type: entry.type }), entry.name);
  }
  return form;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-login-music-validation-'));
  const dataDir = path.join(root, 'SyncWatch同步观影-Data');
  const fixture = path.join(root, 'valid-login-music.wav');
  const generated = spawnSync(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', fixture
  ], { windowsHide: true, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr || 'failed to generate valid audio fixture');
  const validBytes = fs.readFileSync(fixture);
  const loginMusicDir = path.join(dataDir, 'login-music');
  let server;
  let socket;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, discovery: false,
      publicDir: path.resolve(__dirname, '..', 'public'), hostControlToken: 'login-music-validation-host',
      ffmpegPath, ffprobePath
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    socket = await connect(baseUrl);
    const login = await emitAck(socket, 'host-admin-login', {
      adminPassword: 'admin888', hostToken: 'login-music-validation-host',
      roomId: publicConfig.roomId, deviceId: 'login-music-validation-admin'
    });
    assert.equal(login.success, true, login.error);
    if (login.capabilities?.agreementRequired) {
      const agreement = await emitAck(socket, 'agreement-accept', { accepted: true, version: login.agreement.version });
      assert.equal(agreement.success, true, agreement.error);
    }

    const validResponse = await fetch(`${baseUrl}/api/login-music-upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.token}` },
      body: audioForm([{ bytes: validBytes, type: 'audio/wav', name: 'valid-theme.wav' }])
    });
    const validResult = await validResponse.json();
    assert.equal(validResponse.status, 200, validResult.error);
    assert.equal(validResult.success, true, validResult.error);
    assert.equal(validResult.tracks.length, 1);
    assert.equal(validResult.url, validResult.tracks[0].url);
    assert.equal(validResult.tracks[0].originalName, 'valid-theme.wav');
    assert.match(validResult.tracks[0].storedName, /^[a-f0-9-]+\.wav$/i);
    assert.equal(fs.readFileSync(path.join(loginMusicDir, validResult.tracks[0].storedName)).compare(validBytes), 0);

    const replacementTrack = { ...validResult.tracks[0], title: 'replacement-theme' };
    const replacement = await emitAck(socket, 'admin-action', {
      action: 'set-login-music', enabled: true, title: replacementTrack.title,
      url: 'https://old.example.com/stale-theme.mp3', currentTrackId: replacementTrack.id,
      tracks: [replacementTrack]
    });
    assert.equal(replacement.success, true, replacement.error);
    assert.equal(replacement.loginMusic.currentTrackId, replacementTrack.id);
    assert.equal(replacement.loginMusic.url, replacementTrack.url,
      'the active URL must follow the uploaded track, not a stale form URL');
    assert.equal(replacement.loginMusic.title, replacementTrack.title,
      'the active title must follow the selected uploaded track');

    const external = await emitAck(socket, 'admin-action', {
      action: 'set-login-music', enabled: true, title: 'external-theme',
      url: 'https://media.example.com/external-theme.mp3'
    });
    assert.equal(external.success, true, external.error);
    assert.equal(external.loginMusic.url, 'https://media.example.com/external-theme.mp3');
    assert.ok(external.loginMusic.tracks.some((track) => track.url === external.loginMusic.url),
      'an HTTPS-only music address must be represented in the playlist');

    const cleared = await emitAck(socket, 'admin-action', {
      action: 'delete-login-music', ids: external.loginMusic.tracks.map((track) => track.id)
    });
    assert.equal(cleared.success, true, cleared.error);
    assert.equal(cleared.loginMusic.url, '');
    assert.equal(cleared.loginMusic.title, '');
    assert.equal(cleared.loginMusic.currentTrackId, '');
    assert.equal(cleared.loginMusic.tracks.length, 0);

    const filesAfterValidUpload = fs.readdirSync(loginMusicDir).sort();
    const damagedResponse = await fetch(`${baseUrl}/api/login-music-upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.token}` },
      body: audioForm([{
        bytes: validBytes.subarray(0, 24), type: 'audio/wav', name: 'truncated-theme.wav'
      }])
    });
    const damagedResult = await damagedResponse.json();
    assert.ok(damagedResponse.status >= 400 && damagedResponse.status < 500,
      `damaged audio must return 4xx, got ${damagedResponse.status}: ${JSON.stringify(damagedResult)}`);
    assert.equal(damagedResult.success, false);
    assert.deepEqual(fs.readdirSync(loginMusicDir).sort(), filesAfterValidUpload,
      'a damaged audio upload must not leave a stored file');

    const renamedResponse = await fetch(`${baseUrl}/api/login-music-upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.token}` },
      body: audioForm([{ bytes: validBytes, type: 'audio/mpeg', name: 'wav-renamed-as-mp3.mp3' }])
    });
    const renamedResult = await renamedResponse.json();
    assert.ok(renamedResponse.status >= 400 && renamedResponse.status < 500,
      `mismatched audio extension must return 4xx, got ${renamedResponse.status}: ${JSON.stringify(renamedResult)}`);
    assert.equal(renamedResult.success, false);
    assert.deepEqual(fs.readdirSync(loginMusicDir).sort(), filesAfterValidUpload,
      'an extension-mismatched audio upload must not leave a stored file');

    const filesBeforeRejectedBatch = fs.readdirSync(loginMusicDir).sort();
    const rejectedResponse = await fetch(`${baseUrl}/api/login-music-upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.token}` },
      body: audioForm([
        { bytes: validBytes, type: 'audio/wav', name: 'batch-valid.wav' },
        { bytes: Buffer.from('this is not an mp3 stream'), type: 'audio/mpeg', name: 'forged-extension.mp3' }
      ])
    });
    const rejectedResult = await rejectedResponse.json();
    assert.ok(rejectedResponse.status >= 400 && rejectedResponse.status < 500,
      `forged audio must return 4xx, got ${rejectedResponse.status}: ${JSON.stringify(rejectedResult)}`);
    assert.equal(rejectedResult.success, false);
    assert.deepEqual(fs.readdirSync(loginMusicDir).sort(), filesBeforeRejectedBatch,
      'a rejected batch must remove every file uploaded by that request without deleting earlier valid tracks');

    console.log('login music FFprobe validation and rejected-batch cleanup passed.');
  } finally {
    socket?.close();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('login music upload validation failed:', error);
  process.exitCode = 1;
});
