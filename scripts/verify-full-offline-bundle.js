'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const root = path.join(repositoryRoot, '.build', 'offline-bundle');
const version = String(require(path.join(repositoryRoot, 'package.json')).version);
const expected = [
  [`windows/SyncWatch-Experience-Client-Portable-v${version}-x64.exe`, 50 * 1024 * 1024],
  [`android/SyncWatch-Android-v${version}-universal.apk`, 50 * 1024 * 1024],
];

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(absolute);
    return entry.isFile() ? [path.relative(root, absolute).split(path.sep).join('/')] : [];
  });
}

let total = 0;
for (const [relative, minimum] of expected) {
  const filename = path.join(root, ...relative.split('/'));
  assert.ok(fs.existsSync(filename), `Full offline bundle is missing ${relative}`);
  const size = fs.statSync(filename).size;
  assert.ok(size >= minimum, `Full offline bundle file is unexpectedly small: ${relative} (${size} bytes)`);
  total += size;
}
assert.deepEqual(
  listFiles(root).sort(),
  expected.map(([relative]) => relative).sort(),
  'Full Offline bundle must contain exactly the two Windows/Android platform files'
);
assert.ok(total >= 100 * 1024 * 1024, `Full offline payload is unexpectedly small (${total} bytes)`);
console.log(`Full offline bundle verified: ${expected.length} platform files, ${total} bytes.`);
