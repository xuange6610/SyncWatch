'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { FILE_TYPES, _test, startSyncWatchServer } = require('../server');

const publicDir = path.resolve(__dirname, '..', 'public');
const hostToken = 'media-format-host';
const password = 'FormatTest123';

const supportedExtensions = new Map([
  ['.mp4', 'video/mp4'], ['.avi', 'video/x-msvideo'], ['.mov', 'video/quicktime'],
  ['.mkv', 'video/x-matroska'], ['.flv', 'video/x-flv'], ['.wmv', 'video/x-ms-wmv'],
  ['.rm', 'application/vnd.rn-realmedia'], ['.rmvb', 'application/vnd.rn-realmedia-vbr'],
  ['.3gp', 'video/3gpp'], ['.m4v', 'video/x-m4v'], ['.asf', 'video/x-ms-asf'],
  ['.asx', 'application/x-ms-asx'], ['.dat', 'video/mpeg'], ['.vob', 'video/dvd'],
  ['.ts', 'video/mp2t'], ['.webm', 'video/webm'], ['.mpeg', 'video/mpeg'],
  ['.mpg', 'video/mpeg'], ['.divx', 'video/divx'], ['.xvid', 'video/x-xvid'],
  ['.prores', 'video/prores'], ['.av1', 'video/av1'], ['.h264', 'video/h264'],
  ['.h265', 'video/h265'], ['.vp9', 'video/vp9']
]);

function ack(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timeout`)), 10000);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result); });
  });
}

async function upload(baseUrl, token, name, contents) {
  const form = new FormData();
  form.append('file', new Blob([contents], { type: 'application/octet-stream' }), name);
  const response = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.success, true, body.error);
  return body.file;
}

function requestRange(baseUrl, pathname, token) {
  const target = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(target, {
      method: 'GET',
      headers: { Host: 'watch.example.test', Authorization: `Bearer ${token}`, Range: 'bytes=0-7' }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function main() {
  for (const [extension, mime] of supportedExtensions) {
    assert.deepEqual(FILE_TYPES.get(extension), ['video', mime], `${extension} must be a video input`);
    assert.deepEqual(_test.resolveFileType(`fixture${extension}`, 'application/octet-stream'), ['video', mime]);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-media-format-'));
  let server;
  let socket;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir: path.join(root, 'data'), publicDir,
      hostControlToken: hostToken, discovery: false, ffprobePath: '', ffmpegPath: '',
      allowedHosts: ['watch.example.test']
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    socket = io(baseUrl, { transports: ['websocket'] });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const registration = await ack(socket, 'user-register', { username: 'format-test', password });
    assert.equal(registration.success, true, registration.error);
    const login = await ack(socket, 'room-create', {
      username: 'format-test', password, roomName: '媒体格式测试', maxUsers: 8,
      hostToken, deviceId: 'format-support-test'
    });
    assert.equal(login.success, true, login.error);
    if (login.capabilities?.agreementRequired) {
      const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: login.agreement.version });
      assert.equal(accepted.success, true, accepted.error);
    }
    const token = login.token;
    const fixture = Buffer.from('0123456789abcdef', 'ascii');

    const mp4 = await upload(baseUrl, token, 'fixture.mp4', fixture);
    const ranged = await requestRange(baseUrl, mp4.url, token);
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers['content-type'], 'video/mp4', 'public video must retain a playable MIME');
    assert.equal(ranged.headers['content-range'], `bytes 0-7/${fixture.length}`);
    assert.equal(Number(ranged.headers['content-length']), 8);
    assert.deepEqual(ranged.body, fixture.subarray(0, 8));

    for (const extension of supportedExtensions.keys()) {
      if (extension === '.mp4') continue;
      const file = await upload(baseUrl, token, `fixture${extension}`, fixture);
      assert.equal(file.category, 'video', `${extension} must upload as video`);
      assert.equal(file.mimeType, supportedExtensions.get(extension));
    }
    console.log('媒体扩展名映射、上传分类和公网 MP4 Range/MIME 回归全部通过。');
  } finally {
    socket?.close();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('媒体格式支持回归失败:', error);
  process.exitCode = 1;
});
