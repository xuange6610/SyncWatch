'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const isDarwin = process.platform === 'darwin';
const runtimeArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64';
const binary = isDarwin
  ? path.join(repositoryRoot, 'vendor', `cloudflared-darwin-${runtimeArchitecture}`)
  : path.join(repositoryRoot, 'vendor', 'cloudflared.exe');
const source = fs.readFileSync(path.join(repositoryRoot, 'electron-pink.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(repositoryRoot, 'server', 'index.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(repositoryRoot, 'public', 'index.html'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const macServerConfig = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'electron-builder-mac-server.json'), 'utf8'));

assert.ok(fs.existsSync(binary), `${path.relative(repositoryRoot, binary)} is missing`);
const stats = fs.statSync(binary);
assert.ok(stats.size > 1_000_000, 'bundled cloudflared binary is empty or truncated');
if (isDarwin) {
  assert.ok(macServerConfig.extraResources?.some((entry) =>
    entry.from === `vendor/cloudflared-darwin-${runtimeArchitecture}`
      && entry.to === `vendor/cloudflared-darwin-${runtimeArchitecture}`),
  `electron-builder does not package the macOS ${runtimeArchitecture} cloudflared binary as an extra resource`);
} else {
  assert.ok(packageJson.build?.extraResources?.some((entry) =>
    entry.from === 'vendor/cloudflared.exe' && entry.to === 'vendor/cloudflared.exe'),
  'electron-builder does not package vendor/cloudflared.exe as an extra resource');
}
assert.match(source, /const roots = \[process\.resourcesPath \|\| '', __dirname\]/);
assert.match(source, /path\.join\(root, 'vendor', name\)/);
assert.match(source, /cloudflared-darwin-\$\{runtime\.arch\}/);
assert.match(source, /cloudflared-windows-amd64\.exe/);
assert.match(source, /cloudflared-windows-386\.exe/);
assert.match(source, /assetName: `cloudflared-darwin-/);
assert.match(source, /arch === 'arm64' \? 'arm64' : 'amd64'/);
assert.match(source, /api\.github\.com\/repos\/cloudflare\/cloudflared\/releases\/latest/);
assert.match(source, /extractCloudflaredTarGz/);
assert.match(source, /fileSha256/);
for (const architecture of ['x64', 'arm64']) {
  assert.ok(macServerConfig.extraResources?.some((entry) =>
    entry.from === `vendor/cloudflared-darwin-${architecture}`
      && entry.to === `vendor/cloudflared-darwin-${architecture}`),
  `macOS ${architecture} cloudflared is not packaged as an extra resource`);
}
assert.match(source, /net\.fetch\(/);
assert.match(source, /Readable\.fromWeb\(response\.body\)/);
assert.match(source, /cloudflared\.verified\.json/);
assert.match(source, /Import-Module Microsoft\.PowerShell\.Security -ErrorAction Stop/,
  'Windows signature verification must explicitly load the security module under -NoProfile');
assert.doesNotMatch(source, /requestSingleInstanceLock/, '不同程序目录的 SyncWatch同步观影 服务器不应被全局单实例锁互相阻止');
assert.match(source, /tunnel-startup\.json/);
assert.match(source, /autoStartTunnel/);
assert.match(source, /startConfiguredTunnel/);
assert.match(serverSource, /api\/host\/tunnel\/startup/);
assert.match(pageSource, /id="tunnelAutoStart"/);
assert.match(pageSource, /id="saveTunnelStartupBtn"/);

if (process.platform === 'win32') {
  const powershell = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  assert.ok(fs.existsSync(powershell), 'Windows PowerShell is required for Authenticode verification');
  const verification = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-Command',
    "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; "
      + "$signature = Get-AuthenticodeSignature -LiteralPath $env:SYNCWATCH_SIGNATURE_FILE; "
      + "if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate "
      + "-or $signature.SignerCertificate.Subject -notmatch 'Cloudflare') { exit 1 }"
  ], {
    windowsHide: true,
    env: {
      ...process.env,
      PSModulePath: path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      SYNCWATCH_SIGNATURE_FILE: binary
    },
    encoding: 'utf8'
  });
  assert.equal(verification.status, 0, verification.stderr || 'cloudflared Authenticode signature is invalid');
}

console.log(`cloudflared bundle verification passed (${path.basename(binary)}, ${stats.size} bytes, ${crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex')}).`);
