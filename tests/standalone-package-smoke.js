'use strict';

require('./epipe-guard');

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const root = path.resolve(process.argv[2] || '');
if (!root || !fs.existsSync(path.join(root, 'server-standalone.js'))) {
  throw new Error('Usage: node tests/standalone-package-smoke.js <extracted-server-root>');
}
const packageManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = packageManifest.version;
const standaloneSource = fs.readFileSync(path.join(root, 'server-standalone.js'), 'utf8');
const packagedAndroidPath = path.join(root, 'mobile', `SyncWatch同步观影-v${version}.apk`);
if (!fs.existsSync(packagedAndroidPath) || fs.statSync(packagedAndroidPath).size < 1024 * 1024) {
  throw new Error(`standalone package must contain the v${version} Android APK`);
}
if (!standaloneSource.includes("path.join(ROOT_DIR, 'mobile', `SyncWatch同步观影-v${releaseVersion}.apk`)")) {
  throw new Error('standalone server must resolve the versioned packaged Android APK');
}
if (!fs.existsSync(path.join(root, 'server', 'standalone-tunnel.js'))
  || !fs.existsSync(path.join(root, 'vendor', 'cloudflared.exe'))) {
  throw new Error('standalone server must ship the cloudflared supervisor and bundled Windows binary');
}
if (!standaloneSource.includes('createStandaloneTunnelManager')) {
  throw new Error('standalone server must wire the cloudflared supervisor into startSyncWatchServer');
}
const packagedClientPath = path.join(root, `SyncWatch同步观影-Client-v${version}.exe`);
if (!fs.existsSync(packagedClientPath) || fs.statSync(packagedClientPath).size < 1024 * 1024) {
  throw new Error('standalone package must contain the canonical Windows client at its Docker context root');
}
if (!fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').includes(
  `COPY SyncWatch同步观影-Client-v${version}.exe ./client/SyncWatch同步观影-Client-v${version}.exe`
)) {
  throw new Error('standalone Dockerfile must copy the packaged Windows client into the runtime client directory');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitHttp(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/public-config`);
      if (response.ok) return response.json();
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`standalone server did not become ready on ${port}`);
}

function start(rootDir, port) {
  const child = spawn(process.execPath, ['server-standalone.js', `--port=${port}`], {
    cwd: rootDir, env: { ...process.env, PORT: '' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  return { child, output: () => output };
}

function stop(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 3000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    try { child.kill('SIGINT'); } catch (_) { child.kill(); }
  });
}

(async () => {
  let activeRoot = root;
  let first = null;
  let second = null;
  try {
    const firstPort = await freePort();
    first = start(activeRoot, firstPort);
    const firstConfig = await waitHttp(firstPort);
    if (!firstConfig.clientDownloadAvailable) throw new Error('standalone server did not publish the packaged Windows client');
    const clientResponse = await fetch(`http://127.0.0.1:${firstPort}/api/client-download`);
    if (!clientResponse.ok) throw new Error(`standalone client download failed with HTTP ${clientResponse.status}`);
    const downloadedClient = Buffer.from(await clientResponse.arrayBuffer());
    const expectedClientHash = crypto.createHash('sha256').update(fs.readFileSync(packagedClientPath)).digest('hex');
    const downloadedClientHash = crypto.createHash('sha256').update(downloadedClient).digest('hex');
    if (downloadedClientHash !== expectedClientHash) throw new Error('standalone client download hash mismatch');
    const dataDir = path.join(activeRoot, 'SyncWatch同步观影-Data');
    fs.writeFileSync(path.join(dataDir, 'portable-move-marker.txt'), 'portable-data-survives-folder-move\n', 'utf8');
    const firstInfo = fs.readFileSync(path.join(dataDir, '服务器运行信息.txt'), 'utf8');
    if (!firstInfo.includes('数据目录')) throw new Error('runtime info did not record data directory');
    const firstHostToken = fs.readFileSync(
      path.join(dataDir, '.secrets', 'server-host-token.txt'), 'utf8'
    ).trim();
    if (!/^[A-Za-z0-9_-]{32,}$/.test(firstHostToken)) throw new Error('initial host token is invalid');
    const firstLockOwner = JSON.parse(fs.readFileSync(
      path.join(dataDir, '.syncwatch-instance.lock', 'owner.json'), 'utf8'
    ));
    if (firstLockOwner.pid !== first.child.pid || !firstLockOwner.token) {
      throw new Error('initial instance lock owner is invalid');
    }
    await stop(first.child);
    first = null;
    if (process.platform !== 'win32' && fs.existsSync(path.join(dataDir, '.syncwatch-instance.lock'))) {
      throw new Error('instance lock remained after the first clean shutdown');
    }

    const movedRoot = `${activeRoot}-moved`;
    fs.renameSync(activeRoot, movedRoot);
    activeRoot = movedRoot;
    const secondPort = await freePort();
    second = start(activeRoot, secondPort);
    const secondConfig = await waitHttp(secondPort);
    if (!fs.existsSync(path.join(activeRoot, 'SyncWatch同步观影-Data', 'portable-move-marker.txt'))) {
      throw new Error('portable marker was lost after moving the complete server folder');
    }
    if (secondConfig.version !== firstConfig.version) throw new Error('version changed after moving the folder');
    const secondHostToken = fs.readFileSync(
      path.join(activeRoot, 'SyncWatch同步观影-Data', '.secrets', 'server-host-token.txt'), 'utf8'
    ).trim();
    if (secondHostToken !== firstHostToken) throw new Error('host token changed after moving the folder');
    const secondLockOwner = JSON.parse(fs.readFileSync(
      path.join(activeRoot, 'SyncWatch同步观影-Data', '.syncwatch-instance.lock', 'owner.json'), 'utf8'
    ));
    if (secondLockOwner.pid !== second.child.pid || secondLockOwner.token === firstLockOwner.token) {
      throw new Error('moved server did not acquire a fresh instance lock');
    }
    await stop(second.child);
    second = null;
    if (process.platform !== 'win32' && fs.existsSync(path.join(activeRoot, 'SyncWatch同步观影-Data', '.syncwatch-instance.lock'))) {
      throw new Error('instance lock remained after the second clean shutdown');
    }
    console.log(JSON.stringify({
      firstPort, secondPort, version: secondConfig.version, movedData: true,
      hostTokenFile: true, hostTokenPreserved: true, instanceLockRotated: true
    }, null, 2));
  } finally {
    if (second?.child) await stop(second.child);
    if (first?.child) await stop(first.child);
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
