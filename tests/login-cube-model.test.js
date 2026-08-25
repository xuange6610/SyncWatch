'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

function ack(socket, event, payload = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} response timed out`)), timeout);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result || { success: false, error: 'No acknowledgement returned' });
    });
  });
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 10000 });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
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

function makeGlb(document, binary = null) {
  const json = Buffer.from(JSON.stringify(document), 'utf8');
  const jsonPadding = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
  const chunks = [];
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  chunks.push(jsonHeader, jsonChunk);
  if (binary) {
    const binPadding = (4 - (binary.length % 4)) % 4;
    const binChunk = Buffer.concat([binary, Buffer.alloc(binPadding)]);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binChunk.length, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    chunks.push(binHeader, binChunk);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 4, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(header.length + body.length, 8);
  return Buffer.concat([header, body]);
}

async function uploadModel(baseUrl, token, buffer, name = 'cinema.glb', type = 'model/gltf-binary') {
  const form = new FormData();
  form.append('model', new Blob([buffer], { type }), name);
  const response = await fetch(`${baseUrl}/api/login-cube-model`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
  });
  let result = {};
  try { result = await response.json(); } catch (_) {}
  return { response, result };
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-login-cube-model-'));
  const publicDir = path.resolve(__dirname, '..', 'public');
  const sockets = [];
  let server;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, discovery: false,
      hostControlToken: 'cube-model-host', ffmpegPath: '', ffprobePath: ''
    });
    let baseUrl = `http://127.0.0.1:${server.port}`;
    const roomId = (await (await fetch(`${baseUrl}/api/public-config`)).json()).roomId;

    const ordinary = await connect(baseUrl); sockets.push(ordinary);
    assert.equal((await ack(ordinary, 'user-register', { username: 'ModelViewer', password: '123456' })).success, true);
    const ordinaryLogin = await acceptAgreement(ordinary, await ack(ordinary, 'user-login', {
      username: 'ModelViewer', password: '123456', roomId, deviceId: 'model-viewer'
    }));
    assert.equal(ordinaryLogin.success, true, ordinaryLogin.error);

    const admin = await connect(baseUrl); sockets.push(admin);
    const adminLogin = await acceptAgreement(admin, await ack(admin, 'host-admin-login', {
      adminPassword: 'admin888', hostToken: 'cube-model-host', roomId, deviceId: 'model-admin'
    }));
    assert.equal(adminLogin.success, true, adminLogin.error);

    const validGlb = makeGlb({ asset: { version: '2.0', generator: 'SyncWatch同步观影 test' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{}] });
    let attempt = await uploadModel(baseUrl, ordinaryLogin.token, validGlb);
    assert.equal(attempt.response.status, 403, 'ordinary members must not upload the login model');

    attempt = await uploadModel(baseUrl, adminLogin.token, Buffer.from('{"asset":{"version":"2.0"}}'), 'model.gltf', 'model/gltf+json');
    assert.equal(attempt.response.status, 415, 'JSON glTF must be rejected');
    assert.match(attempt.result.error, /GLB/i);

    attempt = await uploadModel(baseUrl, adminLogin.token, Buffer.from('not-a-glb'), 'fake.glb');
    assert.equal(attempt.response.status, 400);
    assert.match(attempt.result.error, /GLB|文件头/);

    const wrongLength = Buffer.from(validGlb);
    wrongLength.writeUInt32LE(wrongLength.length + 4, 8);
    attempt = await uploadModel(baseUrl, adminLogin.token, wrongLength, 'wrong-length.glb');
    assert.equal(attempt.response.status, 400);
    assert.match(attempt.result.error, /长度/);

    const externalGlb = makeGlb({
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ uri: 'https://example.test/mesh.bin', byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }]
    });
    attempt = await uploadModel(baseUrl, adminLogin.token, externalGlb, 'external.glb');
    assert.equal(attempt.response.status, 400);
    assert.match(attempt.result.error, /外部|URI/i);

    attempt = await uploadModel(baseUrl, adminLogin.token, validGlb, 'cinema.glb');
    assert.equal(attempt.response.status, 200, attempt.result.error);
    assert.equal(attempt.result.success, true);
    assert.equal(attempt.result.loginCube.model.originalName, 'cinema.glb');
    assert.equal(attempt.result.loginCube.model.size, validGlb.length);
    assert.match(attempt.result.loginCube.model.sha256, /^[a-f0-9]{64}$/);
    assert.match(attempt.result.loginCube.model.url, /^\/login-cube-model\/[a-f0-9-]+\.glb\?v=\d+$/);

    const modelUrl = attempt.result.loginCube.model.url;
    const modelResponse = await fetch(`${baseUrl}${modelUrl}`);
    assert.equal(modelResponse.status, 200);
    assert.equal(modelResponse.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(modelResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await modelResponse.arrayBuffer()), validGlb);
    assert.equal((await fetch(`${baseUrl}/login-cube-model/not-configured.glb`)).status, 404,
      'the model route must only publish the configured random filename');

    const selected = await ack(admin, 'admin-action', {
      action: 'set-login-cube-settings', displayMode: 'model', rotationDirection: 'left'
    });
    assert.equal(selected.success, true, selected.error);
    assert.equal(selected.loginCube.displayMode, 'model');
    assert.equal(selected.loginCube.model.url, modelUrl);
    let publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(publicConfig.loginCube.displayMode, 'model');
    assert.equal(publicConfig.loginCube.model.originalName, 'cinema.glb');

    for (const socket of sockets.splice(0)) socket.disconnect();
    await server.close(); server = null;
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, discovery: false,
      hostControlToken: 'cube-model-host', ffmpegPath: '', ffprobePath: ''
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(publicConfig.loginCube.displayMode, 'model');
    assert.equal(publicConfig.loginCube.model.originalName, 'cinema.glb');
    assert.equal((await fetch(`${baseUrl}${publicConfig.loginCube.model.url}`)).status, 200);

    const restartedAdmin = await connect(baseUrl); sockets.push(restartedAdmin);
    const restartedLogin = await acceptAgreement(restartedAdmin, await ack(restartedAdmin, 'host-admin-login', {
      adminPassword: 'admin888', hostToken: 'cube-model-host', roomId: publicConfig.roomId, deviceId: 'model-admin-restart'
    }));
    assert.equal(restartedLogin.success, true, restartedLogin.error);
    const deleted = await fetch(`${baseUrl}/api/login-cube-model`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${restartedLogin.token}` }
    });
    const deletedResult = await deleted.json();
    assert.equal(deleted.status, 200, deletedResult.error);
    assert.equal(deletedResult.loginCube.displayMode, 'cube');
    assert.equal(deletedResult.loginCube.model.url, '');
    assert.equal((await fetch(`${baseUrl}${modelUrl}`)).status, 404);

    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(publicDir, 'js', 'app.js'), 'utf8');
    const webglSmoke = fs.readFileSync(path.join(__dirname, 'login-cube-webgl-smoke.js'), 'utf8');
    assert.match(webglSmoke, /process\.platform === 'linux'/);
    assert.match(webglSmoke, /appendSwitch\('use-gl', 'swiftshader'\)/);
    assert.match(webglSmoke, /appendSwitch\('enable-unsafe-swiftshader'\)/);
    assert.match(webglSmoke, /appendSwitch\('ignore-gpu-blocklist'\)/);
    assert.match(html, /id="loginCubeModel"/);
    assert.match(html, /id="loginCubeModelFile"[^>]+accept="\.glb,model\/gltf-binary"/);
    assert.doesNotMatch(html, /loginCubeModelFile[^>]+\.gltf/);
    assert.doesNotMatch(html, /(?:unpkg|jsdelivr|cdnjs|threejs\.org)/i);
    assert.match(app, /THREE\.GLTFLoader/);
    assert.match(app, /\/vendor\/three\/three\.min\.js/);
    assert.match(app, /\/vendor\/three\/GLTFLoader\.js/);
    assert.doesNotMatch(html, /<script[^>]+\/vendor\/three\//,
      'Three.js must be lazy-loaded only when model mode is active');
    for (const name of ['three.min.js', 'GLTFLoader.js', 'LICENSE']) {
      assert.ok(fs.statSync(path.join(publicDir, 'vendor', 'three', name)).size > (name.endsWith('.js') ? 1000 : 100));
    }
    console.log('Login GLB model validation, authorization, restricted serving, persistence, deletion and local renderer contracts passed.');
  } finally {
    for (const socket of sockets) socket.disconnect();
    if (server) await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
