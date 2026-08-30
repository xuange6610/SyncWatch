'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const binary = path.join(repositoryRoot, 'vendor', 'cloudflared.exe');
const source = fs.readFileSync(path.join(repositoryRoot, 'electron-pink.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(repositoryRoot, 'server', 'index.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(repositoryRoot, 'public', 'index.html'), 'utf8');
const fullPortableConfig = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, 'electron-builder-windows-full-portable.json'), 'utf8'));

assert.ok(fs.existsSync(binary), 'vendor/cloudflared.exe is missing');
const stats = fs.statSync(binary);
assert.ok(stats.size > 1_000_000, 'bundled cloudflared binary is empty or truncated');
assert.ok(fullPortableConfig.extraResources?.some((entry) =>
  entry.from === 'vendor/cloudflared.exe' && entry.to === 'vendor/cloudflared.exe'),
'Windows full portable build does not package vendor/cloudflared.exe');
assert.match(source, /const roots = \[process\.resourcesPath \|\| '', __dirname\]/);
assert.match(source, /path\.join\(root, 'vendor', name\)/);
assert.match(source, /cloudflared-windows-amd64\.exe/);
assert.match(source, /cloudflared-windows-386\.exe/);
assert.match(source, /api\.github\.com\/repos\/cloudflare\/cloudflared\/releases\/latest/);
assert.match(source, /fileSha256/);
assert.match(source, /net\.fetch\(/);
assert.match(source, /Readable\.fromWeb\(response\.body\)/);
assert.match(source, /cloudflared\.verified\.json/);
assert.match(source, /Import-Module Microsoft\.PowerShell\.Security -ErrorAction Stop/,
  'Windows signature verification must explicitly load the security module under -NoProfile');
assert.doesNotMatch(source, /requestSingleInstanceLock/,
  'different SyncWatch server directories must not share a global single-instance lock');
assert.doesNotMatch(source, /darwin|macOS|macos/,
  'Windows desktop source must not retain removed macOS integration');
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

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
console.log(`Windows cloudflared bundle verification passed (${stats.size} bytes, ${sha256}).`);
