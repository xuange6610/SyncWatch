'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { io } = require('socket.io-client');
const ffmpegPath = require('ffmpeg-static');
const packageManifest = require('../package.json');
const { version: expectedVersion } = packageManifest;
const expectedPublicVersion = `v${expectedVersion}`;

const WAIT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 250;
const OUTPUT_LIMIT = 16 * 1024;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function appendOutput(current, chunk) {
  const combined = current + chunk.toString('utf8');
  return combined.length > OUTPUT_LIMIT ? combined.slice(-OUTPUT_LIMIT) : combined;
}

async function waitForHttp(baseUrl, child, output, spawnError) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    if (spawnError()) throw new Error(`无法启动候选 EXE：${spawnError().message}\n${output()}`);
    if (child.exitCode !== null) {
      throw new Error(`候选 EXE 在 HTTP 服务就绪前退出（代码 ${child.exitCode}）。\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/public-config`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(2_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      assert.match(response.headers.get('content-type') || '', /^application\/json\b/i);
      return await response.json();
    } catch (error) {
      lastError = error;
      await delay(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`等待候选 EXE 的 HTTP 服务超时：${lastError?.message || '未知错误'}\n${output()}`);
}

function connectSocket(baseUrl, transport, label) {
  const socket = io(baseUrl, {
    transports: [transport],
    upgrade: false,
    reconnection: false,
    timeout: 15_000,
    extraHeaders: { Origin: baseUrl }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${label} 连接超时`));
    }, 20_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 回执超时`)), 10_000);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function waitForPlayableFile(baseUrl, token, fileId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastFile = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/files`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const files = await response.json();
      lastFile = files.find((file) => file.id === fileId) || null;
      if (lastFile?.metadata?.analysisVersion === 2 && lastFile?.compatibility?.ready === true) {
        return { file: lastFile, files };
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`等待候选 EXE 完成影片编码检测超时：${lastError?.message || JSON.stringify(lastFile)}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopChildTree(child) {
  if (!child || child.exitCode !== null) return;
  if (!Number.isInteger(child.pid)) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
  } else {
    child.kill('SIGTERM');
  }
  if (!await waitForExit(child, 10_000) && child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  if (process.platform !== 'win32') throw new Error('成品 EXE 冒烟测试只能在 Windows 上运行');

  const input = process.argv[2] || path.join(__dirname, '..', 'dist', `SyncWatch-v${packageManifest.version}-Full-Offline-Portable-x64.exe`);
  const executable = path.resolve(input);
  const stats = fs.statSync(executable);
  assert.ok(stats.isFile() && stats.size > 1024 * 1024, '候选 EXE 不存在或体积异常');

  const port = await reservePort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-artifact-smoke-'));
  const dataDir = path.join(tempRoot, 'data');
  const userDataDir = path.join(tempRoot, 'electron-user-data');
  const samplePath = path.join(tempRoot, 'artifact-room.mp4');
  const generated = spawnSync(ffmpegPath, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
    '-c:a', 'aac', '-movflags', '+faststart', '-shortest', samplePath
  ], { windowsHide: true, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr || '无法生成候选 EXE 冒烟测试影片');
  const sampleBytes = fs.readFileSync(samplePath);
  assert.ok(sampleBytes.length > 2048, '候选 EXE 冒烟测试影片体积异常');
  const env = {
    ...process.env,
    PORT: String(port),
    SYNCWATCH_DATA_DIR: dataDir,
    SYNCWATCH_SMOKE_MODE: '1',
    SYNCWATCH_SMOKE_EXIT_MS: String(WAIT_TIMEOUT_MS + 30_000)
  };
  delete env.ELECTRON_RUN_AS_NODE;

  let child = null;
  let pollingSocket = null;
  let socket = null;
  let output = '';
  let launchError = null;
  try {
    child = spawn(executable, [`--user-data-dir=${userDataDir}`], {
      cwd: tempRoot,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => { output = appendOutput(output, chunk); });
    child.stderr.on('data', (chunk) => { output = appendOutput(output, chunk); });
    child.once('error', (error) => {
      launchError = error;
      output = appendOutput(output, error.stack || error.message);
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const config = await waitForHttp(baseUrl, child, () => output, () => launchError);
    assert.equal(config.name, 'SyncWatch同步观影');
    assert.equal(config.version, expectedPublicVersion, '成品公开版本与 package.json 不一致');
    assert.equal(config.port, port, '成品未监听指定的随机测试端口');
    assert.equal(config.androidApkAvailable, true, '完整离线 EXE 必须内嵌 Android APK');
    assert.equal(config.clientDownloadAvailable, true, '完整离线 EXE 必须内嵌 Windows 体验版');
    assert.deepEqual(config.macServerDownloads || [], [], '主 EXE 不应内嵌 macOS 服务器');
    assert.deepEqual(config.macClientDownloads || [], [], '主 EXE 不应内嵌 macOS 客户端');
    for (const endpoint of ['/api/macos-server-download', '/api/macos-client-download']) {
      const response = await fetch(`${baseUrl}${endpoint}`, { signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, 404, `${endpoint} 必须明确表示独立产物未内嵌`);
    }
    for (const endpoint of ['/api/android-apk', '/api/client-download']) {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(15_000)
      });
      assert.ok([200, 206].includes(response.status), `${endpoint} 必须能从完整离线 EXE 下载内嵌资产`);
      await response.arrayBuffer();
    }

    pollingSocket = await connectSocket(baseUrl, 'polling', 'Socket.IO polling');
    assert.equal(pollingSocket.io.engine.transport.name, 'polling');
    const pollingPong = await emitAck(pollingSocket, 'network-ping', { sentAt: Date.now() });
    assert.equal(pollingPong?.success, true);
    pollingSocket.close();
    pollingSocket = null;

    socket = await connectSocket(baseUrl, 'websocket', '真实 WebSocket');
    assert.equal(socket.io.engine.transport.name, 'websocket');
    const pong = await emitAck(socket, 'network-ping', { sentAt: Date.now() });
    assert.equal(pong?.success, true);
    assert.ok(Number.isFinite(pong.serverTime), 'network-ping 未返回有效服务器时间');

    const registration = await emitAck(socket, 'user-register', { username: 'ArtifactSmoke', password: 'artifact-pass' });
    assert.equal(registration?.success, true, registration?.error || '候选 EXE 测试账号注册失败');
    const emptyRoomLogin = await emitAck(socket, 'user-login', { username: 'ArtifactSmoke', password: 'artifact-pass', deviceId: 'artifact-smoke' });
    assert.equal(emptyRoomLogin?.success, true, emptyRoomLogin?.error || '普通账号不填写房间号时应进入临时房');
    assert.equal(emptyRoomLogin?.room?.temporary, true, '不填写房间号时应进入临时房');
    const created = await emitAck(socket, 'room-create', {
      username: 'ArtifactSmoke', password: 'artifact-pass', roomName: '成品新房上传测试', maxUsers: 4,
      deviceId: 'artifact-smoke-room'
    });
    assert.equal(created?.success, true, created?.error || '候选 EXE 无法创建新房间');
    if (created.capabilities?.agreementRequired) {
      const accepted = await emitAck(socket, 'agreement-accept', { accepted: true, version: created.agreement?.version });
      assert.equal(accepted?.success, true, accepted?.error || '候选 EXE 测试账号无法接受首次协议');
    }
    assert.match(created.room?.id || '', /^[A-Z2-9]{6}$/);
    assert.ok(created.token, '创建新房间后未签发会话令牌');

    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([sampleBytes], { type: 'video/mp4' }), 'artifact-room.mp4');
    const uploadResponse = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${created.token}` }, body: uploadForm, signal: AbortSignal.timeout(15_000)
    });
    assert.equal(uploadResponse.status, 200, '候选 EXE 新房间 HTTP 上传失败');
    const upload = await uploadResponse.json();
    assert.equal(upload.success, true, upload.error || '候选 EXE 新房间 HTTP 上传未成功');
    assert.equal(upload.file?.roomId, created.room.id, '候选 EXE 新房间上传错误落入其他房间');
    const readyFile = await waitForPlayableFile(baseUrl, created.token, upload.file.id);
    const roomFiles = readyFile.files;
    assert.ok(roomFiles.some((file) => file.id === upload.file.id), '候选 EXE 新房间文件列表缺少刚上传影片');
    assert.ok(roomFiles.every((file) => file.roomId === created.room.id), '候选 EXE 新房间文件列表混入其他房间媒体');
    assert.equal(readyFile.file.compatibility.required, false, '候选 EXE 把标准 H.264/AAC MP4 误判为需要转码');
    const selected = await emitAck(socket, 'select-file', { fileId: upload.file.id });
    assert.equal(selected?.success, true, selected?.error || '候选 EXE 新房间影片无法选择播放');

    console.log(`✓ 分拆后主 EXE HTTP、版本 ${expectedPublicVersion}、polling、真实 WebSocket/network-ping、新房上传播放冒烟通过`);
  } finally {
    pollingSocket?.close();
    socket?.close();
    await stopChildTree(child);
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((error) => {
  console.error('成品 EXE 冒烟失败：', error);
  process.exitCode = 1;
});
