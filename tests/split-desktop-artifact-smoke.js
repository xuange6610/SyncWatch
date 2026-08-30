'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { io } = require('socket.io-client');
const manifest = require('../package.json');

const WAIT_TIMEOUT_MS = 90_000;

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPublicConfig(baseUrl, child, output) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`候选 EXE 在 HTTP 就绪前退出（${child.exitCode}）\n${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/public-config`, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`等待候选 EXE 超时：${lastError?.message || '未知错误'}\n${output()}`);
}

function connectSocket(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], upgrade: false, reconnection: false, timeout: 15_000 });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket 连接超时')); }, 20_000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (error) => { clearTimeout(timer); socket.close(); reject(error); });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 回执超时`)), 10_000);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result); });
  });
}

async function stopChildTree(child) {
  if (!child || child.exitCode !== null || !Number.isInteger(child.pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('拆分后的桌面 EXE 冒烟测试只能在 Windows 上运行');
  const executable = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', `SyncWatch-v${manifest.version}-Full-Offline-Portable-x64.exe`));
  const stats = fs.statSync(executable);
  assert.ok(stats.isFile() && stats.size > 1024 * 1024, '候选 EXE 不存在或体积异常');

  const port = await reservePort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-split-desktop-'));
  const dataDir = path.join(tempRoot, 'data');
  const userDataDir = path.join(tempRoot, 'user-data');
  const env = {
    ...process.env,
    PORT: String(port),
    SYNCWATCH_DATA_DIR: dataDir,
    SYNCWATCH_SMOKE_MODE: '1',
    SYNCWATCH_SMOKE_EXIT_MS: String(WAIT_TIMEOUT_MS + 30_000)
  };
  delete env.ELECTRON_RUN_AS_NODE;

  let output = '';
  let child = null;
  let socket = null;
  try {
    child = spawn(executable, [`--user-data-dir=${userDataDir}`], {
      cwd: tempRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const append = (chunk) => {
      output = (output + chunk.toString('utf8')).slice(-16 * 1024);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const baseUrl = `http://127.0.0.1:${port}`;
    const config = await waitForPublicConfig(baseUrl, child, () => output);
    assert.equal(config.name, 'SyncWatch同步观影');
    assert.equal(config.version, `v${manifest.version}`);
    assert.equal(config.androidApkAvailable, false, '主 EXE 不应内嵌 Android APK');
    assert.equal(config.clientDownloadAvailable, false, '主 EXE 不应内嵌独立 Windows 客户端');
    assert.deepEqual(config.macServerDownloads, [], '主 EXE 不应内嵌 macOS 服务器');
    assert.deepEqual(config.macClientDownloads, [], '主 EXE 不应内嵌 macOS 客户端');

    for (const endpoint of ['/api/android-apk', '/api/client-download', '/api/macos-server-download', '/api/macos-client-download']) {
      const response = await fetch(`${baseUrl}${endpoint}`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 404, `${endpoint} 应当明确表示独立产物未内嵌`);
    }

    socket = await connectSocket(baseUrl);
    const pong = await emitAck(socket, 'network-ping', { sentAt: Date.now() });
    assert.equal(pong?.success, true, '拆包后的桌面服务缺少 Socket.IO 运行依赖');
    assert.ok(Number.isFinite(pong.serverTime));
    console.log('✓ 主 EXE 启动、HTTP/WebSocket 依赖与大体积资源拆分验证通过');
  } finally {
    socket?.close();
    await stopChildTree(child);
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((error) => {
  console.error('拆分后的桌面 EXE 冒烟失败：', error);
  process.exitCode = 1;
});
