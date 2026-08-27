'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));
const version = '2.2.6';
const tag = `v${version}`;
const serverModules = ['server/latest-release.js', 'server/client-address-privacy.js'];

const manifest = json('package.json');
const lock = json('package-lock.json');
assert.equal(manifest.version, version);
assert.equal(lock.version, version);
assert.equal(lock.packages[''].version, version);

const builders = [
  json('electron-builder-client.json'),
  json('electron-builder-mac-client.json'),
  json('electron-builder-mac-server.json'),
  json('electron-builder-mac-full.json'),
  json('electron-builder-windows-installer.json'),
  json('electron-builder-windows-full-portable.json')
];
for (const config of builders) {
  assert.equal(config.directories.output, 'dist');
  assert.doesNotMatch(JSON.stringify(config), /v?2\.2\.5/);
}
assert.equal(builders[0].extraMetadata.version, version);
assert.equal(builders[1].extraMetadata.version, version);

for (const config of [manifest.build, ...builders.slice(2)]) {
  for (const module of serverModules) assert.ok(config.files.includes(module), `${config.appId || 'package build'} missing ${module}`);
}
for (const config of builders.slice(0, 2)) {
  for (const module of serverModules) assert.equal(config.files.includes(module), false, 'client-only package must not embed server modules');
}

const androidGradle = read('mobile/app/build.gradle');
assert.match(androidGradle, /versionCode\s+20206/);
assert.match(androidGradle, /versionName\s+['"]2\.2\.6['"]/);
assert.match(read('mobile/app/src/main/java/com/xuan/syncwatch/MainActivity.java'), /SyncWatchAndroid\/v2\.2\.6/);
assert.match(read('mobile/app/src/main/java/com/xuan/syncwatch/MobileServerService.java'), /SyncWatch同步观影-v2\.2\.6\.apk/);

for (const relative of [
  '.dockerignore', 'Dockerfile', 'build-server-package.ps1', 'build-windows.ps1',
  'client-launcher.html', 'electron-client.js', 'electron-pink.js', 'server-standalone.js',
  'server/index.js', 'server/macos-distribution.js', 'mac-distribution.example.json', 'mobile/build-apk.ps1'
]) {
  assert.doesNotMatch(read(relative), /v?2\.2\.5|20205/, `${relative} still contains the previous release version`);
}

const serverPackage = read('build-server-package.ps1');
for (const module of serverModules.map((value) => value.replaceAll('/', '\\'))) {
  assert.ok(serverPackage.includes(module), `standalone package closure missing ${module}`);
}

const allTests = manifest.scripts['test:all'];
for (const required of [
  'tests/v224-backend.test.js',
  'tests/v225-backend.test.js',
  'tests/v225-frontend.test.js',
  'tests/v226-build-contract.test.js',
  'tests/browser-ui-smoke.js',
  'tests/release-atomic-workflow.test.js'
]) assert.ok(allTests.includes(required), `test:all missing ${required}`);

assert.match(read('electron-client.js'), new RegExp(`APP_VERSION = ['"]${tag.replaceAll('.', '\\.') }['"]`));
assert.match(read('public/index.html'), /id="fullscreenLockBtn"/);
assert.match(read('public/index.html'), /id="fullscreenShortcutHint"/);
assert.match(read('public/js/app.js'), /event\.key === 'F2'/);
assert.match(read('public/js/app.js'), /webkitfullscreenchange/);
assert.match(read('public/js/app.js'), /fullscreenInteractionLocked/);
assert.match(read('public/js/app.js'), /requestWindow/);
assert.match(read('public/js/app.js'), /改用系统画中画/);
assert.match(read('docs/release-notes-v2.2.6.md'), /SyncWatch同步观影 v2\.2\.6 发布说明/);
assert.match(read('docs/release-notes-v2.2.6.md'), /17 个 SyncWatch 应用资产/);
assert.match(read('docs/release-notes-v2.2.6.md'), /最终 Tag.*重新构建/s);
assert.match(read('docs/wiki/37-v2.2.6更新公告.md'), /v2\.2\.6 更新公告/);

console.log('v2.2.6 version, fullscreen, documentation, and build closure contracts passed.');
