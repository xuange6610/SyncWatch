'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');

function expectedFiles(version) {
  return [
    `windows/SyncWatch-Experience-Client-Portable-v${version}-x64.exe`,
    `android/SyncWatch-Android-v${version}-universal.apk`
  ];
}

function prepareBundle({ inputRoot, outputRoot, version }) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) {
    throw new Error(`Invalid Full Offline version: ${version}`);
  }

  const copied = [];
  for (const relative of expectedFiles(version)) {
    const source = path.join(inputRoot, ...relative.split('/'));
    const destination = path.join(outputRoot, ...relative.split('/'));
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`Full Offline source is missing ${relative}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    copied.push(relative);
  }
  return copied;
}

if (require.main === module) {
  const version = String(require(path.join(repositoryRoot, 'package.json')).version);
  const copied = prepareBundle({
    inputRoot: path.join(repositoryRoot, '.build', 'full-inputs'),
    outputRoot: path.join(repositoryRoot, '.build', 'offline-bundle'),
    version
  });
  console.log(`Prepared Full Offline bundle: ${copied.length} exact platform files.`);
}

module.exports = { expectedFiles, prepareBundle };
