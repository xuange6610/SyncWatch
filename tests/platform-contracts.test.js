'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const packageManifest = JSON.parse(read('package.json'));
assert.equal(packageManifest.version, '2.4.1');
assert.equal(packageManifest.scripts['build:mac'], undefined);
for (const file of ['electron-builder-mac-client.json','electron-builder-mac-server.json','electron-builder-mac-full.json','mac-distribution.example.json','server/macos-distribution.js']) {
  assert.equal(fs.existsSync(path.join(root, file)), false, `removed macOS file still exists: ${file}`);
}
for (const file of ['server/index.js','electron-pink.js','electron-client.js','server-standalone.js']) {
  assert.doesNotMatch(read(file), /macos|macOS|darwin/i, `${file} still contains removed macOS integration`);
}
assert.match(
  read('electron-builder-windows-full-portable.json'),
  new RegExp(`SyncWatch-v${packageManifest.version.replace(/\./g, '\\.')}-Full-Offline-Portable`)
);
assert.doesNotMatch(read('electron-builder-windows-full-portable.json'), /macOS|macos|offline-downloads\/mac/);
console.log('Windows and Android platform contract tests passed; macOS build integration is removed.');

