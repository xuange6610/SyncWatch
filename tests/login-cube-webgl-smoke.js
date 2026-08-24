'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-login-cube-webgl-'));
app.setPath('userData', path.join(dataDir, 'electron-profile'));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

let controller;
let window;
let adminSocket;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ack(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 15000);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result || { success: false, error: 'Empty server response' });
    });
  });
}

async function waitFor(expression, description, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (await window.webContents.executeJavaScript(expression, true)) return;
    } catch (_) {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function makeGlb(document, binary) {
  const json = Buffer.from(JSON.stringify(document), 'utf8');
  const jsonChunk = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const binChunk = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  const body = Buffer.concat([jsonHeader, jsonChunk, binHeader, binChunk]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 4, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(header.length + body.length, 8);
  return Buffer.concat([header, body]);
}

function makeVisibleTriangleGlb() {
  const positions = Buffer.from(new Float32Array([
    -1, -1, 0,
    1, -1, 0,
    0, 1, 0
  ]).buffer);
  const normals = Buffer.from(new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1
  ]).buffer);
  const binary = Buffer.concat([positions, normals]);
  return makeGlb({
    asset: { version: '2.0', generator: 'SyncWatch同步观影 WebGL smoke' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: [0.96, 0.12, 0.05, 1],
        metallicFactor: 0,
        roughnessFactor: 0.45
      },
      doubleSided: true
    }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 },
      { buffer: 0, byteOffset: positions.length, byteLength: normals.length, target: 34962 }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }
    ]
  }, binary);
}

async function sampleFrame() {
  return window.webContents.executeJavaScript(`(() => {
    const renderer = state.loginCubeModelRenderer;
    const root = state.loginCubeModelRoot;
    if (!renderer || !root?.children?.length) return null;
    renderer.render(state.loginCubeModelScene, state.loginCubeModelCamera);
    const gl = renderer.getContext();
    gl.finish();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let coloredPixels = 0;
    let alphaPixels = 0;
    let signature = 2166136261 >>> 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (alpha > 0) alphaPixels += 1;
      if (red + green + blue > 24) coloredPixels += 1;
      if ((offset & 63) === 0) {
        signature ^= red | (green << 8) | (blue << 16) | (alpha << 24);
        signature = Math.imul(signature, 16777619) >>> 0;
      }
    }
    return {
      width, height, coloredPixels, alphaPixels, signature,
      rotationX: root.rotation.x, rotationY: root.rotation.y,
      renderer: gl.getParameter(gl.RENDERER)
    };
  })()`, true);
}

async function run() {
  controller = await startSyncWatchServer({
    host: '127.0.0.1', port: 0, dataDir,
    publicDir: path.resolve(__dirname, '..', 'public'), discovery: false,
    hostControlToken: 'webgl-smoke-host', ffmpegPath: '', ffprobePath: ''
  });
  const baseUrl = `http://127.0.0.1:${controller.port}`;
  adminSocket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    adminSocket.once('connect', resolve);
    adminSocket.once('connect_error', reject);
  });
  const login = await ack(adminSocket, 'host-admin-login', {
    adminPassword: 'admin888', hostToken: 'webgl-smoke-host',
    roomId: (await (await fetch(`${baseUrl}/api/public-config`)).json()).roomId,
    deviceId: 'webgl-smoke-admin'
  });
  assert.equal(login.success, true, login.error);
  if (login.capabilities?.agreementRequired) {
    const accepted = await ack(adminSocket, 'agreement-accept', { accepted: true, version: login.agreement.version });
    assert.equal(accepted.success, true, accepted.error);
  }

  const triangle = makeVisibleTriangleGlb();
  const form = new FormData();
  form.append('model', new Blob([triangle], { type: 'model/gltf-binary' }), 'visible-triangle.glb');
  const uploadResponse = await fetch(`${baseUrl}/api/login-cube-model`, {
    method: 'POST', headers: { Authorization: `Bearer ${login.token}` }, body: form
  });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200, upload.error);
  const configured = await ack(adminSocket, 'admin-action', {
    action: 'set-login-cube-settings', displayMode: 'model',
    autoRotate: true, inertia: false, rotationDirection: 'right', rotationSpeed: 18
  });
  assert.equal(configured.success, true, configured.error);
  assert.equal(configured.loginCube.displayMode, 'model');

  window = new BrowserWindow({
    width: 960, height: 720, x: -10000, y: -10000, show: false, skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false
    }
  });
  await window.loadURL(baseUrl);
  window.setOpacity(0);
  window.showInactive();
  await waitFor(`document.visibilityState === 'visible'`, 'a visible renderer document');
  await waitFor(`Boolean(
    state.publicConfig.loginCube?.displayMode === 'model'
    && state.loginCubeModelRenderer
    && state.loginCubeModelRoot?.children?.length
    && elements.loginCubeScene.classList.contains('has-loaded-model')
  )`, 'the uploaded GLB to render');
  await waitFor(`elements.loginCubeScene.clientWidth >= 300 && elements.loginCubeScene.clientHeight >= 300`, 'the login cube layout');
  await waitFor(`state.loginCubeModelRenderer.getContext().drawingBufferWidth >= 300`, 'the WebGL renderer resize');

  const first = await sampleFrame();
  assert.ok(first && first.width >= 300 && first.height >= 300, JSON.stringify(first));
  assert.ok(first.alphaPixels > 1000, `Expected nonblank alpha pixels: ${JSON.stringify(first)}`);
  assert.ok(first.coloredPixels > 1000, `Expected visible colored pixels: ${JSON.stringify(first)}`);
  await delay(700);
  const second = await sampleFrame();
  assert.ok(second, 'The second WebGL frame was unavailable');
  assert.ok(second.rotationY > first.rotationY + 0.05, `${first.rotationY} -> ${second.rotationY}`);
  assert.notEqual(second.signature, first.signature, 'Rotating the visible GLB must change rendered canvas pixels');
  assert.ok(second.coloredPixels > 1000, JSON.stringify(second));

  console.log(`Login GLB WebGL render passed: ${first.renderer}; ${first.coloredPixels} visible pixels; rotation ${first.rotationY.toFixed(3)} -> ${second.rotationY.toFixed(3)} rad.`);
}

async function finish(exitCode) {
  adminSocket?.close();
  window?.destroy();
  await controller?.close().catch(() => {});
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    console.warn(`Electron still holds its temporary browser profile; it can be removed after exit: ${dataDir}`);
  }
  process.exitCode = exitCode;
  app.exit(exitCode);
}

app.whenReady().then(async () => {
  let exitCode = 0;
  try { await run(); }
  catch (error) { exitCode = 1; console.error(error); }
  await finish(exitCode);
});
