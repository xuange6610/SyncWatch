'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expectedFiles, prepareBundle } = require('../scripts/prepare-full-offline-bundle');

const version = '2.2.4';
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-full-offline-'));
const inputRoot = path.join(temporaryRoot, 'inputs');
const outputRoot = path.join(temporaryRoot, 'bundle');

function write(relative, contents = relative) {
  const filename = path.join(inputRoot, ...relative.split('/'));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function list(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return list(absolute);
    return entry.isFile() ? [path.relative(outputRoot, absolute).split(path.sep).join('/')] : [];
  });
}

try {
  for (const relative of expectedFiles(version)) write(relative);
  write(`windows/SyncWatch-Standard-Server-Portable-v${version}-x64.exe`, 'must not be embedded');
  write(`mac/SyncWatch-Client-macOS-v${version}-x64.dmg`, 'must not be embedded');

  const copied = prepareBundle({ inputRoot, outputRoot, version });
  assert.deepEqual(copied, expectedFiles(version));
  assert.deepEqual(list(outputRoot).sort(), expectedFiles(version).sort());
  for (const relative of expectedFiles(version)) {
    assert.equal(fs.readFileSync(path.join(outputRoot, ...relative.split('/')), 'utf8'), relative);
  }

  const missingRoot = path.join(temporaryRoot, 'missing-inputs');
  fs.mkdirSync(missingRoot);
  assert.throws(
    () => prepareBundle({ inputRoot: missingRoot, outputRoot: path.join(temporaryRoot, 'missing-output'), version }),
    /Full Offline source is missing/
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('Full Offline bundle selection contract passed.');
