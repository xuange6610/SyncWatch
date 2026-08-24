'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { startSyncWatchServer, _test } = require('../server');

function request(baseUrl, pathname, headers = {}) {
  const target = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = http.request(target, { method: 'GET', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

function decodedBody(response) {
  if (response.headers['content-encoding'] === 'gzip') return zlib.gunzipSync(response.body);
  if (response.headers['content-encoding'] === 'br') return zlib.brotliDecompressSync(response.body);
  return response.body;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-http-compression-'));
  const dataDir = path.join(root, 'SyncWatch同步观影-Data');
  const publicDir = path.resolve(__dirname, '..', 'public');
  let server;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, discovery: false,
      ffmpegPath: '', ffprobePath: ''
    });
    let baseUrl = `http://127.0.0.1:${server.port}`;

    const javascript = await request(baseUrl, '/js/app.js', { 'Accept-Encoding': 'gzip' });
    assert.equal(javascript.status, 200);
    assert.equal(javascript.headers['content-encoding'], 'gzip');
    assert.match(String(javascript.headers.vary || ''), /(?:^|,\s*)Accept-Encoding(?:\s*,|$)/i);
    assert.deepEqual(decodedBody(javascript), fs.readFileSync(path.join(publicDir, 'js', 'app.js')));
    assert.ok(javascript.body.length < decodedBody(javascript).length / 2,
      'the large application bundle should be materially smaller over the tunnel');

    const html = await request(baseUrl, '/', { 'Accept-Encoding': 'br' });
    assert.equal(html.status, 200);
    assert.equal(html.headers['content-encoding'], 'br');
    assert.deepEqual(decodedBody(html), fs.readFileSync(path.join(publicDir, 'index.html')));

    const stylesheet = await request(baseUrl, '/css/style.css', { 'Accept-Encoding': 'br' });
    assert.equal(stylesheet.status, 200);
    assert.equal(stylesheet.headers['content-encoding'], 'br');
    assert.deepEqual(decodedBody(stylesheet), fs.readFileSync(path.join(publicDir, 'css', 'style.css')));

    const publicConfig = await request(baseUrl, '/api/public-config', { 'Accept-Encoding': 'gzip' });
    assert.equal(publicConfig.status, 200);
    assert.equal(publicConfig.headers['content-encoding'], 'gzip');
    assert.equal(JSON.parse(decodedBody(publicConfig).toString('utf8')).version, 'v2.2.0');

    const localPlaybackConfig = JSON.parse(decodedBody(publicConfig).toString('utf8'));
    assert.equal(localPlaybackConfig.defaultPlaybackQuality, 'original');

    await server.close();
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, discovery: false,
      ffmpegPath: '', ffprobePath: '', publicUrl: 'http://public.example.test',
      allowedHosts: ['public.example.test']
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    const configuredTunnelConfig = await request(baseUrl, '/api/public-config', {
      Host: 'public.example.test', 'Accept-Encoding': 'gzip'
    });
    assert.equal(configuredTunnelConfig.status, 200);
    assert.equal(JSON.parse(decodedBody(configuredTunnelConfig).toString('utf8')).defaultPlaybackQuality, 'smooth',
      'an explicitly configured HTTP tunnel host must default to smooth playback without X-Forwarded headers');
    const stillLocalConfig = await request(baseUrl, '/api/public-config', { 'Accept-Encoding': 'gzip' });
    assert.equal(JSON.parse(decodedBody(stillLocalConfig).toString('utf8')).defaultPlaybackQuality, 'original',
      'configuring a public URL must not change direct local playback defaults');

    const sourceJavascript = fs.readFileSync(path.join(publicDir, 'js', 'app.js'));
    const staticRange = await request(baseUrl, '/js/app.js', {
      Range: 'bytes=10-41', 'Accept-Encoding': 'gzip, br'
    });
    assert.equal(staticRange.status, 206);
    assert.equal(staticRange.headers['content-encoding'], undefined);
    assert.equal(staticRange.headers['content-range'], `bytes 10-41/${sourceJavascript.length}`);
    assert.equal(Number(staticRange.headers['content-length']), 32);
    assert.deepEqual(staticRange.body, sourceJavascript.subarray(10, 42));

    await server.close();
    server = null;

    const videoName = '11111111-1111-4111-8111-111111111111.mp4';
    const videoBody = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'ascii');
    const videoDir = path.join(dataDir, 'login-video');
    fs.mkdirSync(videoDir, { recursive: true });
    fs.writeFileSync(path.join(videoDir, videoName), videoBody);
    const statePath = path.join(dataDir, 'config.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.admin.loginVideo = {
      enabled: true,
      title: 'Compression exclusion fixture',
      url: `/login-video/${videoName}`,
      storedName: videoName,
      originalName: 'fixture.mp4',
      mimeType: 'video/mp4',
      size: videoBody.length,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, discovery: false,
      ffmpegPath: '', ffprobePath: ''
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    const videoRange = await request(baseUrl, `/login-video/${videoName}`, {
      Range: 'bytes=5-12', 'Accept-Encoding': 'gzip, br'
    });
    assert.equal(videoRange.status, 206);
    assert.equal(videoRange.headers['content-encoding'], 'identity');
    assert.equal(videoRange.headers['content-range'], `bytes 5-12/${videoBody.length}`);
    assert.equal(Number(videoRange.headers['content-length']), 8);
    assert.match(String(videoRange.headers['cache-control'] || ''), /(?:^|,)\s*no-transform\s*(?:,|$)/i);
    assert.deepEqual(videoRange.body, videoBody.subarray(5, 13));

    const fullVideo = await request(baseUrl, `/login-video/${videoName}`, {
      'Accept-Encoding': 'gzip, br'
    });
    assert.equal(fullVideo.status, 200);
    assert.equal(fullVideo.headers['content-encoding'], 'identity');
    assert.equal(Number(fullVideo.headers['content-length']), videoBody.length);
    assert.equal(fullVideo.headers['content-range'], undefined);
    assert.deepEqual(fullVideo.body, videoBody);

    for (const pathname of [
      '/media/file.mp4', '/original-media/file.mp4', '/login-music/file.mp3',
      '/login-video/file.mp4', '/login-cube-model/file.glb', '/compatible-media/file.mp4',
      '/host-media/ROOM/file', '/voice/file.ogg', '/chat-image/file.webp'
    ]) {
      assert.equal(_test.requestSkipsCompression({ path: pathname, headers: {} }), true, pathname);
    }
    assert.equal(_test.requestSkipsCompression({ path: '/js/app.js', headers: { range: 'bytes=0-1' } }), true);
    assert.equal(_test.requestSkipsCompression({ path: '/js/app.js', headers: {} }), false);

    console.log('HTTP text compression and Range/media exclusion contracts passed.');
  } finally {
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('HTTP compression regression failed:', error);
  process.exitCode = 1;
});
