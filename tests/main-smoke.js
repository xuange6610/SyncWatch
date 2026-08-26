'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const APP_VERSION = require('../package.json').version;

process.env.SYNCWATCH_SMOKE_MODE = '1';
process.env.SYNCWATCH_SMOKE_EXIT_MS = '2200';
process.env.SYNCWATCH_DATA_DIR = require('path').join(require('os').tmpdir(), `syncwatch-main-smoke-${process.pid}`);

const fs = require('fs');
const path = require('path');
const dataDir = process.env.SYNCWATCH_DATA_DIR;

const { _test: electronSettings } = require('../electron-pink');

const portableRootCases = process.platform === 'win32'
  ? [
      { file: `D:\\SyncWatch同步观影\\SyncWatch同步观影-v${APP_VERSION}.exe`, expected: path.resolve('D:\\SyncWatch同步观影') },
      { file: `E:\\SyncWatch同步观影\\SyncWatch同步观影-v${APP_VERSION}.exe`, expected: path.resolve('E:\\SyncWatch同步观影') }
    ]
  : [
      { file: path.join(dataDir, 'drive-d', `SyncWatch同步观影-v${APP_VERSION}.exe`), expected: path.resolve(dataDir, 'drive-d') },
      { file: path.join(dataDir, 'drive-e', `SyncWatch同步观影-v${APP_VERSION}.exe`), expected: path.resolve(dataDir, 'drive-e') }
    ];
const driveDRoot = electronSettings.resolveApplicationRoot({ portableExecutableFile: portableRootCases[0].file });
const driveERoot = electronSettings.resolveApplicationRoot({ portableExecutableFile: portableRootCases[1].file });
assert.equal(driveDRoot, portableRootCases[0].expected);
assert.equal(driveERoot, portableRootCases[1].expected);
assert.notEqual(driveDRoot, driveERoot);
assert.equal(electronSettings.resolveApplicationRoot({
  isPackaged: true, platform: 'darwin', execPath: '/Applications/SyncWatch同步观影.app/Contents/MacOS/SyncWatch同步观影',
  userDataPath: '/Users/example/Library/Application Support/SyncWatch同步观影-服务器'
}), path.resolve('/Users/example/Library/Application Support/SyncWatch同步观影-服务器'));
fs.mkdirSync(dataDir, { recursive: true });
const packagedServerPath = path.join(dataDir, `SyncWatch同步观影-v${APP_VERSION}.exe`);
const packagedClientPath = path.join(dataDir, `SyncWatch同步观影-Client-v${APP_VERSION}.exe`);
fs.writeFileSync(packagedClientPath, 'smoke-client');
assert.equal(electronSettings.resolveClientDownloadPath({ isPackaged: true, portableExecutableFile: packagedServerPath }), '');
assert.equal(electronSettings.resolveClientDownloadPath({ isPackaged: true, resourcesPath: dataDir }), '');
const embeddedClientPath = path.join(dataDir, 'offline-downloads', 'windows', `SyncWatch-Experience-Client-Portable-v${APP_VERSION}-x64.exe`);
fs.mkdirSync(path.dirname(embeddedClientPath), { recursive: true });
fs.writeFileSync(embeddedClientPath, 'embedded-client');
assert.equal(electronSettings.resolveClientDownloadPath({ isPackaged: true, resourcesPath: dataDir }), embeddedClientPath);
assert.equal(electronSettings.resolveClientDownloadPath({ isPackaged: true, portableExecutableFile: path.join(dataDir, 'missing', `SyncWatch同步观影-v${APP_VERSION}.exe`) }), '');
const macArtifacts = path.join(dataDir, 'mac');
fs.mkdirSync(macArtifacts);
const macServerArm64 = path.join(macArtifacts, `SyncWatch同步观影-服务器-v${APP_VERSION}-arm64.dmg`);
const macServerX64Zip = path.join(macArtifacts, `SyncWatch同步观影-服务器-v${APP_VERSION}-x64.zip`);
const macClientX64 = path.join(macArtifacts, `SyncWatch同步观影-客户端-v${APP_VERSION}-x64.dmg`);
const macClientX64Zip = path.join(macArtifacts, `SyncWatch同步观影-客户端-v${APP_VERSION}-x64.zip`);
fs.writeFileSync(macServerArm64, 'server-arm64');
fs.writeFileSync(macServerX64Zip, 'server-x64-zip');
fs.writeFileSync(macClientX64, 'client-x64');
fs.writeFileSync(macClientX64Zip, 'client-x64-zip');
assert.deepEqual(electronSettings.resolveMacDownloadPaths('server', { isPackaged: true, portableExecutableFile: packagedServerPath }), {
  x64: { dmg: '', zip: '' }, arm64: { dmg: '', zip: '' }
});
assert.deepEqual(electronSettings.resolveMacDownloadPaths('client', { isPackaged: true, portableExecutableFile: packagedServerPath }), {
  x64: { dmg: '', zip: '' }, arm64: { dmg: '', zip: '' }
});
assert.deepEqual(electronSettings.resolveMacDownloadPaths('server', { developmentDirectory: dataDir }), {
  x64: { dmg: '', zip: macServerX64Zip }, arm64: { dmg: macServerArm64, zip: '' }
});
assert.deepEqual(electronSettings.resolveMacDownloadPaths('client', { developmentDirectory: dataDir }), {
  x64: { dmg: macClientX64, zip: macClientX64Zip }, arm64: { dmg: '', zip: '' }
});

const electronSource = fs.readFileSync(path.resolve(__dirname, '..', 'electron-pink.js'), 'utf8');
assert.doesNotMatch(electronSource, /首次加载需要生成数据库/);
const portableStorageCall = electronSource.indexOf('configurePortableStorage();');
assert.ok(portableStorageCall >= 0);
assert.doesNotMatch(electronSource, /requestSingleInstanceLock\(/,
  '不同 SyncWatch同步观影 数据目录应允许并行运行，不能再使用全局单实例锁');
assert.match(electronSource, /\[DEFAULT_DATA_DIR, LEGACY_USER_DATA_ROOT\]/);
console.log('✓ Electron 便携根目录按 EXE 所在文件夹隔离，不同数据目录可并行运行，恢复出厂覆盖新旧应用数据');

assert.equal(electronSettings.normalizeServerSettings({}).port, 5000);
assert.equal(electronSettings.normalizeServerSettings({}).autostart, false);
assert.equal(electronSettings.normalizeServerSettings({ autostart: true }).autostart, true);
assert.equal(electronSettings.normalizeServerSettings({}).networkInterface, 'auto');
assert.equal(electronSettings.normalizeServerSettings({ networkInterface: '  Ethernet  ' }).networkInterface, 'Ethernet');
assert.equal(electronSettings.normalizeServerSettings({ publicUrl: 'http://Example.com:8080/' }).publicUrl, 'http://example.com:8080');
assert.deepEqual(electronSettings.normalizeServerSettings({ allowedHosts: 'Movie.Example.com\nmovie.example.com:8443' }).allowedHosts, ['movie.example.com', 'movie.example.com:8443']);
for (const port of [0, 'abc', 70000, undefined]) {
  assert.throws(() => electronSettings.normalizeServerSettings({ port }), /port 必须是 1-65535/);
}
for (const allowedHost of ['https://example.com/path', 'user@example.com', 'example.com/path', 'https://user:pass@example.com']) {
  assert.throws(() => electronSettings.normalizeServerSettings({ allowedHosts: [allowedHost] }), /允许域名/);
}
for (const publicUrl of [
  'file:///tmp/index.html', 'https://user:pass@example.com', 'https://example.com/watch',
  'https://example.com?room=1', 'https://example.com/#room', 'https://example.com/watch/..'
]) {
  assert.throws(() => electronSettings.normalizeServerSettings({ publicUrl }), /publicUrl/);
}
console.log('✓ Electron 配置仅在缺少 port 时默认 5000，并严格拒绝非法端口和 publicUrl');

const networkInterfaces = {
  'vEthernet (WSL)': [{ address: '172.20.0.1', family: 'IPv4', internal: false }],
  'Wi-Fi': [{ address: '192.168.1.23', family: 'IPv4', internal: false }],
  Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
};
assert.equal(electronSettings.resolveLanAddress({ networkInterface: 'auto' }, networkInterfaces), '192.168.1.23');
assert.equal(electronSettings.resolveLanAddress({ networkInterface: 'vEthernet (WSL)' }, networkInterfaces), '172.20.0.1');
assert.equal(electronSettings.resolveLanAddress({ networkInterface: 'missing' }, networkInterfaces), '192.168.1.23');
assert.deepEqual(electronSettings.selectableNetworkAdapters(networkInterfaces).map(({ name, address }) => ({ name, address })), [
  { name: 'Wi-Fi', address: '192.168.1.23' },
  { name: 'vEthernet (WSL)', address: '172.20.0.1' }
]);
console.log('✓ 启动网卡支持自动优选、手动指定与断线回退');

assert.deepEqual(electronSettings.tunnelCommandArgs('quick', 5000), [
  'tunnel', '--url', 'http://127.0.0.1:5000', '--protocol', 'auto', '--edge-ip-version', '4', '--retries', '12', '--no-autoupdate'
]);
assert.deepEqual(electronSettings.tunnelCommandArgs('named', 5000), [
  'tunnel', '--protocol', 'auto', '--edge-ip-version', '4', '--retries', '12', '--no-autoupdate', 'run'
]);
const sanitizedLog = electronSettings.sanitizeTunnelLog('TUNNEL_TOKEN=secret --token another authorization: bearer');
assert.doesNotMatch(sanitizedLog, /secret|another|bearer/);
assert.match(sanitizedLog, /TUNNEL_TOKEN=\[已隐藏\]/);
const degradedTunnel = electronSettings.applyTunnelHealthProbe({
  state: 'running', mode: 'quick', publicUrl: 'https://stable-address.trycloudflare.com',
  verified: true, latencyMs: 120, reconnectCount: 0, lastCheckedAt: 1000
}, { ok: false, latencyMs: 8000 }, 2, { processRunning: true, checkedAt: 2000 });
assert.equal(degradedTunnel.healthFailures, 3);
assert.equal(degradedTunnel.current.state, 'running');
assert.equal(degradedTunnel.current.publicUrl, 'https://stable-address.trycloudflare.com');
assert.equal(degradedTunnel.current.reconnectCount, 0);
assert.equal(degradedTunnel.current.verified, true);
assert.match(degradedTunnel.current.error, /公网探测波动/);
const recoveredTunnel = electronSettings.applyTunnelHealthProbe(
  degradedTunnel.current, { ok: true, latencyMs: 88 }, degradedTunnel.healthFailures,
  { processRunning: true, checkedAt: 3000 }
);
assert.equal(recoveredTunnel.healthFailures, 0);
assert.equal(recoveredTunnel.current.state, 'running');
assert.equal(recoveredTunnel.current.publicUrl, 'https://stable-address.trycloudflare.com');
assert.equal(recoveredTunnel.current.latencyMs, 88);
assert.equal(recoveredTunnel.current.error, '');
const exitedTunnel = electronSettings.applyTunnelHealthProbe(
  recoveredTunnel.current, { ok: false }, recoveredTunnel.healthFailures,
  { processRunning: false, checkedAt: 4000 }
);
assert.equal(exitedTunnel.current.state, 'error');
assert.equal(exitedTunnel.current.publicUrl, '');
assert.equal(exitedTunnel.current.lastPublicUrl, 'https://stable-address.trycloudflare.com');
assert.equal(exitedTunnel.current.verified, false);
const tunnelStatusSource = electronSource.match(/status:\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)return\s+\{\s*\.\.\.current,\s*installed:/)?.[1] || '';
assert.ok(tunnelStatusSource, '应能定位公网隧道状态实现');
assert.doesNotMatch(tunnelStatusSource, /await\s+start\s*\(/,
  '公网探测超时不能主动重启 Quick Tunnel，否则随机地址会变化并踢掉全部客户端');
assert.match(electronSource, /waitForPublicUrl\(establishedUrl, 8000,[\s\S]{0,180}localAddress/,
  'Quick Tunnel 首次验证应使用有界等待，并与 cloudflared 绑定同一物理出口');
assert.match(electronSource, /const verified = Boolean\(verifiedResult\?\.ok\)[\s\S]*?state: verified \? 'running' : 'verifying'[\s\S]*?publicUrl: verified \? establishedUrl : ''/,
  'Quick Tunnel 首次探测未通过时只能保持 verifying，不能发布未验证地址');
const launchTunnelAttemptSource = electronSource.match(/async function launchTunnelAttempt[\s\S]*?const result = await attemptResult/)?.[0] || '';
assert.match(launchTunnelAttemptSource, /let timer = null;/,
  'cloudflared 快速退出时也必须先初始化策略计时器，不能在错误分支抛出 timer is not defined');
assert.match(launchTunnelAttemptSource, /tunnelConnectorRegistered\(log\)[\s\S]*?finish\(\{ success: true, publicUrl: candidatePublicUrl \}\)/,
  '临时地址必须等 cloudflared 连接器注册后才发布，避免 Cloudflare 1033');
assert.match(electronSource, /cloudflareErrorCode === 1033/,
  '公网探针应把 Cloudflare 1033 显示为连接器未注册，而不是普通超时');
console.log('✓ Quick Tunnel 首选 QUIC/HTTP/2 自动选择并保留 HTTP/2、系统网络回退，探测超时保持原进程与临时地址');

const closeHandlerSource = electronSource.match(/mainWindow\.on\('close',[\s\S]*?mainWindow\.on\('closed'/)?.[0] || '';
assert.ok(closeHandlerSource, '应能定位主窗口关闭处理器');
assert.doesNotMatch(closeHandlerSource, /dialog\.showMessageBox/,
  '关闭主窗口不能再显示无法继承主题的 Windows 白色消息框');
assert.match(closeHandlerSource, /webContents\.send\('syncwatch:request-close-choice'/,
  '关闭主窗口应通知渲染器显示主题关闭窗口');

const preloadSource = fs.readFileSync(path.resolve(__dirname, '..', 'electron-main-preload.js'), 'utf8');
const pageSource = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const styleSource = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
assert.match(pageSource, /id="tunnelAutoDiagnose"[^>]*checked/,
  'Tunnel network preflight should be enabled by default.');
assert.match(preloadSource, /onCloseRequested/);
assert.match(preloadSource, /completeCloseChoice/);
assert.match(pageSource, /id="desktopCloseModal"/);
assert.match(appSource, /SyncWatchDesktop\?\.onCloseRequested/);
assert.match(styleSource, /\.desktop-close-card/);
console.log('✓ 关闭主窗口使用应用内主题弹窗和受限 IPC');

process.on('exit', () => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  console.log('✓ Electron 主入口、屏幕捕获授权处理器、托盘和服务器启动正常');
});
