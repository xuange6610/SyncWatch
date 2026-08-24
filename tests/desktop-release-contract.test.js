'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));

const manifest = json('package.json');
const clientConfig = json('electron-builder-client.json');
const fullInstallerConfig = json('electron-builder-windows-installer.json');
const fullPortableConfig = json('electron-builder-windows-full-portable.json');
const macClientConfig = json('electron-builder-mac-client.json');
const macServerConfig = json('electron-builder-mac-server.json');
const macFullConfig = json('electron-builder-mac-full.json');
const electronServer = read('electron-pink.js');
const electronClient = read('electron-client.js');
const clientPreload = read('electron-client-preload.js');
const launcher = read('client-launcher.html');
const macReleaseWorkflow = read('.github/workflows/release-macos.yml');
const windowsReleaseWorkflow = read('.github/workflows/release-windows.yml');
const windowsBuildPath = path.join(root, 'build-windows.ps1');
const windowsBuildBytes = fs.readFileSync(windowsBuildPath);
const windowsBuild = windowsBuildBytes.toString('utf8').replace(/^\uFEFF/, '');

const DESKTOP_NAME = 'SyncWatch同步观影';

// Windows PowerShell 5.1 decodes BOM-less scripts using the system code page.
// Keep such scripts ASCII-only, and load localized product metadata as UTF-8.
const windowsBuildHasUtf8Bom = windowsBuildBytes.length >= 3
  && windowsBuildBytes[0] === 0xef && windowsBuildBytes[1] === 0xbb && windowsBuildBytes[2] === 0xbf;
assert.ok(windowsBuildHasUtf8Bom || !/[^\x00-\x7f]/.test(windowsBuild),
  'a BOM-less Windows PowerShell build script must not contain non-ASCII literals');
assert.match(windowsBuild, /Get-Content[^\r\n]+-Encoding UTF8[^\r\n]+package\.json/,
  'the Windows build must decode package.json explicitly as UTF-8');
assert.match(windowsBuild, /\$expectedProductName\s*=\s*\[string\]\$manifest\.build\.productName/,
  'the Windows build must derive its localized executable name from package.json');

// Windows/macOS metadata, Electron runtime identity, window titles and tray
// identity must all present one product name. Artifact filenames remain free to
// include the SyncWatch同步观影 brand and version for distribution.
for (const config of [
  manifest.build, clientConfig, fullInstallerConfig, fullPortableConfig,
  macClientConfig, macServerConfig, macFullConfig
]) {
  assert.equal(config.productName, DESKTOP_NAME);
  assert.equal(config.directories.output, 'dist', 'every formal Electron artifact must output to root dist');
}
assert.equal(manifest.description, DESKTOP_NAME);
assert.equal(manifest.build.win.executableName, DESKTOP_NAME);
assert.equal(clientConfig.win.executableName, DESKTOP_NAME);
assert.equal(clientConfig.extraMetadata.description, DESKTOP_NAME);
assert.equal(macClientConfig.extraMetadata.description, DESKTOP_NAME);
assert.match(electronServer, /const APP_NAME = ['"]SyncWatch同步观影['"]/);
assert.match(electronClient, /const APP_NAME = ['"]SyncWatch同步观影['"]/);
assert.match(electronServer, /app\.setName\(APP_NAME\)/);
assert.match(electronClient, /app\.setName\(APP_NAME\)/);
assert.match(electronServer, /tray\.setToolTip\(APP_NAME\)/);
assert.match(electronServer, /title:\s*APP_NAME/);
assert.match(electronClient, /title:\s*APP_NAME/);
assert.doesNotMatch(electronServer, /SyncWatch同步观影-服务器/);
assert.doesNotMatch(electronClient, /SyncWatch同步观影-客户端/);

// The standalone client launcher renders the same configurable six-face
// identity as the web login. It asks the main process to read /api/public-config
// and keeps a complete offline fallback when the configured server is absent.
for (const face of ['front', 'back', 'right', 'left', 'top', 'bottom']) {
  assert.match(launcher, new RegExp(`data-login-cube-face=["']${face}["']`));
}
assert.match(launcher, /id=["']loginCubeScene["']/);
assert.match(launcher, /id=["']loginCube["']/);
assert.match(launcher, /function\s+normalizeLoginCube\s*\(/);
assert.match(launcher, /function\s+applyLoginCube\s*\(/);
assert.match(launcher, /displayMode/);
assert.match(launcher, /rotationDirection/);
assert.match(launcher, /SyncWatchClient\.inspect\(/);
assert.match(clientPreload, /inspect:\s*\(address\)\s*=>\s*ipcRenderer\.invoke\(['"]syncwatch-client:inspect['"]/);
assert.match(electronClient, /ipcMain\.handle\(['"]syncwatch-client:inspect['"]/);
assert.match(electronClient, /new URL\(['"]\/api\/public-config['"]/);
assert.match(electronClient, /config:\s*verified\.config/);
for (const rendererResource of ['public/vendor/three/three.min.js', 'public/vendor/three/GLTFLoader.js']) {
  assert.ok(clientConfig.files.includes(rendererResource), `Windows client must package ${rendererResource}`);
  assert.ok(macClientConfig.files.includes(rendererResource), `macOS client must package ${rendererResource}`);
}

// The Standard portable executable contains only its Windows server runtime.
// The explicitly named Full offline installer is a separate configuration and
// embeds real platform downloads under resources/offline-downloads.
const mainFiles = manifest.build.files.map(String);
const mainUnpacked = (manifest.build.asarUnpack || []).map(String);
const mainResources = (manifest.build.extraResources || []).map((entry) => String(entry.from || ''));
for (const required of [
  'electron-pink.js', 'electron-main-preload.js', 'electron-settings-preload.js',
  'server/index.js', 'server/ai-relay.js', 'public/**/*', 'package.json'
]) assert.ok(mainFiles.includes(required), `main desktop package missing ${required}`);
for (const value of [...mainFiles, ...mainUnpacked, ...mainResources]) {
  assert.doesNotMatch(value, /(^|[\\/])(?:mobile|mac)(?:[\\/]|$)|SyncWatch同步观影-Client-v2\.1\.7\.exe/i,
    `main desktop package embeds a separately released payload: ${value}`);
}
assert.doesNotMatch(windowsBuild, /release[\\/](?:windows|android|macos|server-deployment)/i,
  'formal build assets must not be published to split release directories');
assert.match(windowsBuild, /Join-Path\s+\$PSScriptRoot\s+['"]dist['"]/);
assert.match(windowsBuild, /Join-Path\s+\$PSScriptRoot\s+['"]\.build['"]/);
assert.doesNotMatch(windowsBuild, /win-unpacked\\resources\\mac/);
assert.doesNotMatch(windowsBuild, /app\.asar\.unpacked\\mobile/);
for (const [label, config] of [
  ['Full installer', fullInstallerConfig],
  ['Full portable', fullPortableConfig],
  ['macOS Full', macFullConfig]
]) {
  const resources = (config.extraResources || []).map((entry) => `${entry.from || ''} -> ${entry.to || ''}`);
  for (const directory of ['.build/offline-bundle/windows', '.build/offline-bundle/android', '.build/offline-bundle/mac']) {
    assert.ok(resources.some((entry) => entry.includes(directory)), `${label} must embed ${directory}`);
  }
}
assert.equal(fullInstallerConfig.nsis.artifactName, 'SyncWatch-v2.2.0-Full-Offline-Installer-${arch}.exe');
assert.equal(fullPortableConfig.portable.artifactName, 'SyncWatch-v2.2.0-Full-Offline-Portable-${arch}.exe');
assert.equal(manifest.build.portable.artifactName, 'SyncWatch-Standard-Server-Portable-v2.2.0-${arch}.exe');
assert.equal(clientConfig.portable.artifactName, 'SyncWatch-Experience-Client-Portable-v2.2.0-${arch}.exe');
assert.equal(macClientConfig.artifactName, 'SyncWatch-Client-macOS-v2.2.0-${arch}.${ext}');
assert.equal(macServerConfig.artifactName, 'SyncWatch-Server-macOS-v2.2.0-${arch}.${ext}');
assert.equal(macFullConfig.artifactName, 'SyncWatch-Full-Offline-macOS-v2.2.0-${arch}.${ext}');
assert.match(electronServer, /offline-downloads['"], ['"]windows/);
assert.match(electronServer, /offline-downloads['"], ['"]android/);
assert.match(electronServer, /offline-downloads['"], ['"]mac/);

assert.doesNotMatch(windowsBuild, /SyncWatch同步观影-Client-v2\.1\.7\.exe/);
assert.match(windowsBuild, /SyncWatch-Experience-Client-Portable-v2\.2\.0-x64\.exe/);

// GitHub strips some non-ASCII characters from uploaded asset names. Keep the
// public macOS names ASCII and role-specific so client/server jobs cannot
// overwrite one another when both architectures are published.
for (const arch of ['x64', 'arm64']) {
  for (const extension of ['dmg', 'zip']) {
    assert.match(macReleaseWorkflow,
      new RegExp(`SyncWatch-\\$\\{release_role\\}-macOS-v\\$\\{VERSION\\}-${arch}\\.${extension}`));
  }
}
assert.match(macReleaseWorkflow, /release_role="Client"/);
assert.match(macReleaseWorkflow, /release_role="Server"/);
for (const publicName of [
  'SyncWatch-Experience-Client-Portable-v2.2.0-x64.exe',
  'SyncWatch-Standard-Server-Portable-v2.2.0-x64.exe',
  'SyncWatch-v2.2.0-Full-Offline-Installer-x64.exe',
  'SyncWatch-v2.2.0-Full-Offline-Portable-x64.exe'
]) {
  assert.match(windowsReleaseWorkflow, new RegExp(publicName.replaceAll('.', '\\.')),
    `Windows release workflow must publish the tiered asset ${publicName}`);
}
assert.match(windowsReleaseWorkflow, /dist\/\*\.exe|dist\\\*\.exe/,
  'Windows release workflow must collect EXE assets from root dist');
for (const arch of ['x64', 'arm64']) {
  for (const extension of ['dmg', 'zip']) {
    assert.match(macReleaseWorkflow,
      new RegExp(`SyncWatch-Full-Offline-macOS-v\\$\\{VERSION\\}-${arch}\\.${extension}`),
      `macOS release workflow must publish the Full Offline ${arch} ${extension} package`);
  }
}

console.log('desktop login visual, metadata and split-release contracts passed.');
