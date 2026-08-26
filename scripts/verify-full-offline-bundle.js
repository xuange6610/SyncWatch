'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '.build', 'offline-bundle');
const expected = [
  ['windows/SyncWatch-Experience-Client-Portable-v2.2.2-x64.exe', 50 * 1024 * 1024],
  ['android/SyncWatch-Android-v2.2.2-universal.apk', 50 * 1024 * 1024],
  ['mac/SyncWatch-Server-macOS-v2.2.2-x64.zip', 100 * 1024 * 1024],
  ['mac/SyncWatch-Server-macOS-v2.2.2-arm64.zip', 100 * 1024 * 1024],
  ['mac/SyncWatch-Client-macOS-v2.2.2-x64.zip', 100 * 1024 * 1024],
  ['mac/SyncWatch-Client-macOS-v2.2.2-arm64.zip', 100 * 1024 * 1024]
];

let total = 0;
for (const [relative, minimum] of expected) {
  const filename = path.join(root, ...relative.split('/'));
  assert.ok(fs.existsSync(filename), `Full offline bundle is missing ${relative}`);
  const size = fs.statSync(filename).size;
  assert.ok(size >= minimum, `Full offline bundle file is unexpectedly small: ${relative} (${size} bytes)`);
  total += size;
}
assert.ok(total >= 900 * 1024 * 1024, `Full offline payload is unexpectedly small (${total} bytes)`);
console.log(`Full offline bundle verified: ${expected.length} platform files, ${total} bytes.`);
