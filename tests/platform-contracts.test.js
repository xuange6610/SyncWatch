const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const page = read('public/index.html');
const app = read('public/js/app.js');
const server = read('server/index.js');
const standalone = read('server-standalone.js');
const electronServer = read('electron-pink.js');
const electronClient = read('electron-client.js');
const serverPreload = read('electron-main-preload.js');
const clientPreload = read('electron-client-preload.js');
const android = read('mobile/app/src/main/java/com/xuan/syncwatch/MainActivity.java');
const packageManifest = JSON.parse(read('package.json'));
const macServerConfig = JSON.parse(read('electron-builder-mac-server.json'));
const macClientConfig = JSON.parse(read('electron-builder-mac-client.json'));
const macDistributionExample = JSON.parse(read('mac-distribution.example.json'));
const embeddedMacReadme = read('mac/README.md');
const windowsBuild = read('build-windows.ps1');
const dockerfile = read('Dockerfile');
const dockerignore = read('.dockerignore');
const dockerCompose = read('docker-compose.yml');
const powershellServerLauncher = read('start-server.ps1');
const cmdServerLauncher = read('start-server.cmd');
const shellServerLauncher = read('start-server.sh');

assert.match(serverPreload, /readClipboardText:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]syncwatch:read-clipboard-text['"]\)/);
assert.match(clientPreload, /readClipboardText:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]syncwatch-client:read-clipboard-text['"]\)/);
assert.match(electronServer, /ipcMain\.handle\(['"]syncwatch:read-clipboard-text['"]/);
assert.match(electronClient, /ipcMain\.handle\(['"]syncwatch-client:read-clipboard-text['"]/);
assert.match(electronClient, /async function verifySyncWatchServer\(/);
assert.match(electronClient, /\[['"]SyncWatch同步观影['"], ['"]SyncWatch['"]\]\.includes\(config\?\.name\)/);
assert.match(electronClient, /if \(!isLauncherSender\(_event\)\)/);
assert.match(electronClient, /if \(!isTrustedServerSender\(event\)\)/);
assert.match(electronClient, /function permissionRequestIsTrusted\(/);
assert.match(electronClient, /请求读取系统剪贴板/);
assert.doesNotMatch(electronClient, /callback\(\[['"]media['"], ['"]display-capture['"], ['"]geolocation['"]/);
assert.match(android, /readClipboardText:function\(\)/);
assert.match(android, /public String readClipboardText\(String token\)/);
assert.match(android, /ClipboardManager/);
assert.match(app, /readClipboardTextFromAvailableSources/);
assert.match(app, /document\.execCommand\(['"]paste['"]\)/);

for (const id of ['downloadMacServerBtn', 'downloadMacClientBtn', 'downloadMacServerMainBtn', 'downloadMacClientMainBtn', 'macDownloadModal', 'macDownloadArch', 'macDownloadFormat', 'macDownloadAvailability']) {
  assert.match(page, new RegExp(`id=["']${id}["']`));
}
assert.match(app, /api\/macos-server-download/);
assert.match(app, /api\/macos-client-download/);
assert.match(app, /macServerDownloads/);
assert.match(app, /macClientDownloads/);
assert.match(app, /format=\$\{encodeURIComponent\(format\)\}/);
assert.match(server, /macServerDownloadArchitectures/);
assert.match(server, /macClientDownloadArchitectures/);
assert.match(server, /app\.get\(['"]\/api\/macos-server-download['"]/);
assert.match(server, /app\.get\(['"]\/api\/macos-client-download['"]/);
assert.match(server, /MACOS_ARTIFACT_UNAVAILABLE/);
assert.match(server, /macServerDownloads/);
assert.ok(fs.existsSync(path.join(root, 'server', 'macos-distribution.js')));
assert.ok(packageManifest.build.files.includes('server/macos-distribution.js'));
assert.ok(macServerConfig.files.includes('server/macos-distribution.js'));
assert.equal(macDistributionExample.manifestVersion, 1);
assert.ok(macDistributionExample.server.arm64.dmg.startsWith('https://'));
assert.match(read('docs/macos-build.md'), /mac-distribution\.json/);
assert.ok(!packageManifest.build.extraResources.some((entry) => ['mac', 'mobile', `SyncWatch同步观影-Client-v${packageManifest.version}.exe`].includes(String(entry.from || ''))),
  'Windows server EXE must keep client, Android and macOS downloads as separate release artifacts');
assert.match(embeddedMacReadme, /scripts\/build-macos\.sh/);
assert.match(windowsBuild, /\$buildRoot\s*=.*['"]\.build['"][\s\S]{0,160}\$offlineRoot\s*=\s*Join-Path\s+\$buildRoot\s+['"]offline-bundle['"]/,
  'Windows Full Offline packaging must use the temporary offline bundle');
assert.ok(windowsBuild.includes(`SyncWatch-Server-macOS-v${packageManifest.version}-x64.zip`),
  'Windows Full Offline packaging must require canonical macOS artifacts from root dist');
assert.doesNotMatch(windowsBuild, /win-unpacked\\resources\\mac/,
  'Windows packaging must not copy macOS payloads into the Windows executable');
assert.ok(standalone.includes(`SyncWatch-Server-macOS-v${packageManifest.version}`));
assert.ok(standalone.includes(`SyncWatch-Client-macOS-v${packageManifest.version}`));
assert.ok(dockerfile.includes(`COPY dist/SyncWatch-Experience-Client-Portable-v${packageManifest.version}-x64.exe ./client/SyncWatch同步观影-Client-v${packageManifest.version}.exe`),
  'Docker deployment must include the Windows client download artifact');
assert.ok(dockerignore.indexOf(`!dist/SyncWatch-Experience-Client-Portable-v${packageManifest.version}-x64.exe`) > dockerignore.indexOf('*.exe'),
  'Docker ignore rules must re-include the canonical Windows client after the executable wildcard');
assert.match(standalone, /commandLineValue\(['"]trusted-proxies['"]\)/,
  'the standalone Node entry must accept --trusted-proxies');
assert.match(electronServer, /commandLineValue\(['"]trusted-proxies['"]\)/,
  'the Electron server entry must accept --trusted-proxies');
assert.match(powershellServerLauncher, /server-standalone\.js['"]?\s+@args/,
  'the PowerShell launcher must forward standalone server arguments');
assert.match(cmdServerLauncher, /start-server\.ps1['"]?\s+%\*/,
  'the CMD launcher must forward arguments into PowerShell');
assert.match(shellServerLauncher, /server-standalone\.js\s+"\$@"/,
  'the POSIX launcher must forward standalone server arguments');
assert.match(dockerCompose, /SYNCWATCH_TRUSTED_PROXIES:\s*["']\$\{SYNCWATCH_TRUSTED_PROXIES:-\}["']/,
  'Docker Compose must map SYNCWATCH_TRUSTED_PROXIES into the container');

for (const [config, main] of [[macServerConfig, 'electron-pink.js'], [macClientConfig, 'electron-client.js']]) {
  assert.ok(config.files.includes(main));
  assert.equal(config.mac.icon, 'assets/app-icon.png');
  const architectures = config.mac.target.flatMap((target) => target.arch || []);
  assert.ok(architectures.includes('x64'));
  assert.ok(architectures.includes('arm64'));
  assert.match(config.artifactName, /\$\{arch\}/);
}
assert.match(packageManifest.scripts['build:mac'], /build-macos\.sh/);
assert.ok(fs.existsSync(path.join(root, 'assets/app-icon.png')));
assert.ok(fs.existsSync(path.join(root, 'scripts', 'prepare-cloudflared-macos.js')));

console.log('desktop, Android and macOS platform contract tests passed.');
