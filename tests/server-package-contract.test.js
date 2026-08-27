'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const collector = path.join(root, 'scripts', 'collect-macos-distribution.ps1');
const buildScript = fs.readFileSync(path.join(root, 'build-server-package.ps1'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const pnpmLock = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
const examplePath = path.join(root, 'mac-distribution.example.json');
const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
const version = packageJson.version;
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

function artifactName(value) {
  return decodeURIComponent(new URL(value).pathname.split('/').pop());
}

function prepareSource(parent, name) {
  const source = path.join(parent, name);
  fs.mkdirSync(path.join(source, 'mac'), { recursive: true });
  fs.copyFileSync(examplePath, path.join(source, 'mac-distribution.example.json'));
  return source;
}

function collect(source, destination) {
  return spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', collector,
    '-SourceRoot', source, '-Destination', destination, '-Version', version
  ], { encoding: 'utf8' });
}

assert.ok(fs.existsSync(collector), 'the standalone package must use the constrained macOS collector');
assert.match(buildScript, /scripts\\collect-macos-distribution\.ps1/);
assert.match(buildScript, /-SourceRoot\s+\$PSScriptRoot\s+-Destination\s+\$macDirectory\s+-Version\s+\$version/);
assert.match(buildScript, /server\\standalone-tunnel\.js/);
assert.match(buildScript, /server\\latest-release\.js/);
assert.match(buildScript, /server\\client-address-privacy\.js/);
assert.match(buildScript, /vendor\\cloudflared\.exe/);
assert.ok(buildScript.includes(`Join-Path $PSScriptRoot 'dist\\SyncWatch-Experience-Client-Portable-v${version}-x64.exe'`));
assert.doesNotMatch(buildScript, /Join-Path\s+\$PSScriptRoot\s+['"]SyncWatch同步观影-Client-v2\.1\.8\.exe['"]/, 
  'the server package must never fall back to a stale root-level client EXE');

const compressionVersion = packageJson.dependencies.compression;
assert.equal(compressionVersion, '1.8.1', 'compression must remain a pinned production dependency');
assert.equal(packageLock.packages[''].dependencies.compression, compressionVersion,
  'package-lock root dependencies must lock the production compression dependency');
assert.equal(packageLock.packages['node_modules/compression'].version, compressionVersion,
  'package-lock must contain the installed compression package');
assert.match(pnpmLock, /^\s{6}compression:\r?\n\s{8}specifier: 1\.8\.1\r?\n\s{8}version: 1\.8\.1$/m,
  'pnpm importer must lock compression to the production version');
assert.match(pnpmLock, /^  compression@1\.8\.1:$/m,
  'pnpm lockfile must contain the compression package snapshot');

const requiredFilesBlock = buildScript.match(/\$requiredFiles\s*=\s*@\(([\s\S]*?)\r?\n\)/)?.[1] || '';
assert.match(requiredFilesBlock, /['"]node_modules\\compression\\package\.json['"]/,
  'source preflight must require the compression runtime package');
const stagedDependenciesBlock = buildScript.match(/foreach\s*\(\$dependency\s+in\s+@\(([^)]*)\)\)\s*\{/)?.[1] || '';
assert.match(stagedDependenciesBlock, /['"]compression['"]/,
  'staged production dependency validation must require compression');
const archiveRequirementsBlock = buildScript.match(/foreach\s*\(\$required\s+in\s+@\(([\s\S]*?)\)\)\s*\{/)?.[1] || '';
assert.match(archiveRequirementsBlock, /\$folderName\/node_modules\/compression\/package\.json/,
  'archive validation must require the compression runtime package');

const shellProbe = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
if (shellProbe.error) {
  console.log('server package static contract passed; PowerShell collector smoke skipped.');
  process.exit(0);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-server-package-contract-'));
try {
  const source = prepareSource(tempRoot, 'valid-source');
  const destination = path.join(tempRoot, 'valid-stage', 'mac');
  const serverZip = artifactName(example.server.x64.zip);
  const clientDmg = artifactName(example.client.arm64.dmg);
  fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(source, 'mac', serverZip), 'server-zip');
  fs.writeFileSync(path.join(source, 'dist', clientDmg), 'client-dmg');
  fs.writeFileSync(path.join(source, 'mac', 'SyncWatch同步观影-unrelated-v2.2.0-x64.zip'), 'unrelated');
  fs.writeFileSync(path.join(source, 'mac', 'private-key.pem'), 'must-not-leak');
  fs.writeFileSync(path.join(source, 'mac', 'mac-distribution.json'), JSON.stringify({
    manifestVersion: 1,
    server: { arm64: { dmg: 'https://downloads.syncwatch.example/server-arm64.dmg' } }
  }));

  const valid = collect(source, destination);
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
  assert.deepEqual(fs.readdirSync(destination).sort(), [clientDmg, 'mac-distribution.json', serverZip].sort());
  assert.equal(fs.readFileSync(path.join(destination, serverZip), 'utf8'), 'server-zip');

  const emptySource = prepareSource(tempRoot, 'empty-source');
  fs.writeFileSync(path.join(emptySource, 'mac', serverZip), '');
  const empty = collect(emptySource, path.join(tempRoot, 'empty-stage', 'mac'));
  assert.notEqual(empty.status, 0, 'zero-byte macOS artifacts must fail packaging');
  assert.match(`${empty.stdout}\n${empty.stderr}`, /artifact is empty/i);

  const conflictSource = prepareSource(tempRoot, 'conflict-source');
  fs.mkdirSync(path.join(conflictSource, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(conflictSource, 'dist', serverZip), 'older-build');
  fs.writeFileSync(path.join(conflictSource, 'mac', serverZip), 'newer-build');
  const conflict = collect(conflictSource, path.join(tempRoot, 'conflict-stage', 'mac'));
  assert.notEqual(conflict.status, 0, 'different artifacts with the same release name must fail packaging');
  assert.match(`${conflict.stdout}\n${conflict.stderr}`, /conflicting macOS artifacts/i);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('standalone server package macOS distribution contract passed.');
