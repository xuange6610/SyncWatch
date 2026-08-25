'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const forbidden = ['唐' + '靖轩', 'tang' + 'jingxuan', 'com.tang' + 'jingxuan'];
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8').split('\0').filter(Boolean);

for (const relative of tracked) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
  const bytes = fs.readFileSync(absolute);
  for (const value of forbidden) {
    const found = bytes.includes(Buffer.from(value, 'utf8'))
      || bytes.includes(Buffer.from(value, 'utf16le'));
    assert.equal(found, false, `privacy identifier found in tracked file: ${relative}`);
  }
}

assert.ok(fs.existsSync(path.join(root, 'mobile/app/src/main/java/com/xuan/syncwatch/MainActivity.java')),
  'Android Java package must use com.xuan.syncwatch');

if (process.argv.includes('--release')) {
  const releaseRoot = path.join(root, 'dist');
  const artifacts = fs.existsSync(releaseRoot)
    ? fs.readdirSync(releaseRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((file) => /\.(?:exe|apk|zip|dmg)$/i.test(file))
    : [];
  assert.ok(artifacts.length > 0, 'no dist artifacts found for privacy scan');
  for (const artifact of artifacts) {
    const bytes = fs.readFileSync(artifact);
    for (const value of forbidden) {
      const found = bytes.includes(Buffer.from(value, 'utf8'))
        || bytes.includes(Buffer.from(value, 'utf16le'));
      assert.equal(found, false,
        `privacy identifier found in release artifact: ${path.relative(root, artifact)}`);
    }
  }
}

console.log('privacy branding contract passed.');
