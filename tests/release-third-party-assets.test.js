'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ASSETS,
  NODE_VERSION,
  CLOUDFLARED_VERSION,
  THIRD_PARTY_EVIDENCE_SCHEMA,
  DOWNLOAD_TIMEOUT_MS,
  DOWNLOAD_ATTEMPTS,
  DEFAULT_CACHE_DIRECTORY,
  parseArguments
} = require('../scripts/release-third-party-assets');

assert.equal(NODE_VERSION, '24.19.0');
assert.equal(CLOUDFLARED_VERSION, '2026.8.2');
assert.equal(THIRD_PARTY_EVIDENCE_SCHEMA, 'syncwatch-third-party-evidence-v1');
assert.equal(DOWNLOAD_TIMEOUT_MS, 30 * 60 * 1000);
assert.equal(DOWNLOAD_ATTEMPTS, 3);
assert.match(DEFAULT_CACHE_DIRECTORY, /release-third-party/);
const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release-third-party-assets.js'), 'utf8');
assert.match(source, /const \{ EnvHttpProxyAgent \} = require\('undici'\)/);
assert.match(source, /dispatcher: getProxyDispatcher\(\)/);
assert.match(source, /reused verified local cache/);
assert.match(source, /Cached official asset SHA-256 mismatch/);
assert.equal(ASSETS.length, 5);
assert.equal(new Set(ASSETS.map((entry) => entry.name)).size, 5);
for (const entry of ASSETS) {
  assert.match(entry.url, /^https:\/\//);
  assert.doesNotMatch(entry.url, /\/latest\//, `${entry.name} must use a pinned upstream version`);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.match(entry.sourceSha256, /^[a-f0-9]{64}$/);
  assert.ok(entry.upstream);
}
assert.equal(ASSETS.filter((entry) => entry.name.startsWith('node-')).length, 2);
assert.equal(ASSETS.filter((entry) => entry.name.startsWith('cloudflared-')).length, 3);
assert.equal(ASSETS.filter((entry) => entry.archive).length, 0);
assert.deepEqual(parseArguments([
  '--output', 'dist', '--evidence', 'evidence.json', '--run-id', '123', '--run-attempt', '2',
  '--only', ASSETS[0].name
]), {
  output: 'dist', evidence: 'evidence.json', only: [ASSETS[0].name], runId: '123', runAttempt: '2', cacheDirectory: DEFAULT_CACHE_DIRECTORY
});
assert.throws(
  () => parseArguments(['--output', 'dist', '--evidence', 'evidence.json']),
  /requires numeric/
);

console.log('pinned Node.js and cloudflared release source contracts passed.');
