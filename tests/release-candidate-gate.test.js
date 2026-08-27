'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ASSETS: THIRD_PARTY_ASSETS } = require('../scripts/release-third-party-assets');
const {
  BUILD_EVIDENCE_SCHEMA,
  THIRD_PARTY_EVIDENCE_SCHEMA,
  manifestForVersion,
  sourceArchivesForVersion,
  requiredForPhase,
  assetsForSelection,
  verifyMetadata,
  verifyMetadataForAssets,
  verifyEvidenceDirectory,
  parseChecksumManifest,
  writeBuildEvidence
} = require('../scripts/release-candidate-gate');

const version = '2.2.4';
const manifest = manifestForVersion(version);
const sourceArchives = sourceArchivesForVersion(version);
assert.equal(manifest.length, 26);
assert.equal(sourceArchives.length, 2);
assert.equal(new Set([...manifest, ...sourceArchives].map((entry) => entry.name)).size, 28);
assert.equal(manifest.filter((entry) => entry.kind === 'application').length, 17);
assert.equal(manifest.filter((entry) => entry.kind === 'third-party').length, 9);
assert.equal(assetsForSelection('bundle', version).length, 28);
assert.equal(assetsForSelection('official', version).length, 9);
assert.equal(assetsForSelection('windows-base', version).length, 2);
assert.equal(assetsForSelection('windows-full', version).length, 2);
assert.equal(assetsForSelection('mac-client-x64', version).length, 2);
assert.equal(assetsForSelection('mac-server-arm64', version).length, 2);
assert.equal(assetsForSelection('mac-full-x64', version).length, 2);

assert.equal(requiredForPhase('android', version).length, 0);
assert.deepEqual(requiredForPhase('mac-base', version).map((entry) => entry.name), [
  'SyncWatch-Android-v2.2.4-universal.apk'
]);
assert.equal(requiredForPhase('windows-base', version).length, 9);
assert.equal(requiredForPhase('windows-full', version).length, 11);
assert.equal(requiredForPhase('mac-full', version).length, 11);
assert.equal(requiredForPhase('final', version).length, 26);
assert.equal(requiredForPhase('bundle', version).length, 28);

const digestFor = (entry) => entry.sha256 || crypto.createHash('sha256').update(entry.name).digest('hex');
const metadata = manifest.map((entry) => ({
  name: entry.name,
  size: entry.minimumBytes,
  digest: `sha256:${digestFor(entry)}`,
  state: 'uploaded'
}));
const verifiedRows = verifyMetadata({ assets: metadata }, 'final', version);
assert.equal(verifiedRows.length, 26);
assert.throws(
  () => verifyMetadata({ assets: metadata.slice(0, -1) }, 'final', version),
  /exactly 26 assets|Missing release candidate asset/
);
assert.throws(
  () => verifyMetadata({ assets: [...metadata, { name: 'unexpected.bin', size: 1, digest: `sha256:${'a'.repeat(64)}`, state: 'uploaded' }] }, 'final', version),
  /exactly 26 assets|unexpected/
);
assert.throws(
  () => verifyMetadata({ assets: [{ ...metadata[0], digest: metadata[1].digest }, ...metadata.slice(1)] }, 'final', version),
  /Duplicate release content/
);
const official = manifest.find((entry) => entry.kind === 'third-party');
assert.throws(
  () => verifyMetadataForAssets({ assets: [{
    name: official.name, size: official.minimumBytes, digest: `sha256:${'f'.repeat(64)}`, state: 'uploaded'
  }] }, [official]),
  /Pinned SHA-256 mismatch/
);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-release-gate-'));
try {
  const checksumFile = path.join(temp, 'SHA256SUMS.txt');
  fs.writeFileSync(checksumFile, metadata.map((entry) => `${entry.digest.slice(7)}  ${entry.name}`).join('\n') + '\n');
  const expectedDigests = parseChecksumManifest(checksumFile);
  assert.equal(verifyMetadataForAssets({ assets: metadata }, manifest, { expectedDigests }).length, 26);
  const mismatched = new Map(expectedDigests);
  mismatched.set(metadata[0].name, '0'.repeat(64));
  assert.throws(
    () => verifyMetadataForAssets({ assets: metadata }, manifest, { expectedDigests: mismatched }),
    /Remote SHA-256 mismatch/
  );

  const evidenceDirectory = path.join(temp, 'evidence');
  fs.mkdirSync(evidenceDirectory);
  const context = {
    sourceCommit: '1'.repeat(40),
    sourceTree: '2'.repeat(40),
    runId: '123456',
    runAttempt: '2'
  };
  const applicationRows = verifiedRows.filter((row) => row.kind === 'application');
  const applicationEvidence = path.join(evidenceDirectory, 'applications.json');
  writeBuildEvidence(applicationEvidence, applicationRows, 'applications', context);
  assert.equal(JSON.parse(fs.readFileSync(applicationEvidence)).schema, BUILD_EVIDENCE_SCHEMA);

  const rowByName = new Map(verifiedRows.map((row) => [row.name, row]));
  fs.writeFileSync(path.join(evidenceDirectory, 'official.json'), JSON.stringify({
    schema: THIRD_PARTY_EVIDENCE_SCHEMA,
    runId: context.runId,
    runAttempt: context.runAttempt,
    nodeVersion: '24.19.0',
    cloudflaredVersion: '2026.8.2',
    assets: THIRD_PARTY_ASSETS.map((entry) => ({
      name: entry.name,
      bytes: rowByName.get(entry.name).size,
      sha256: rowByName.get(entry.name).digest.slice(7),
      sourceUrl: entry.url,
      sourceSha256: entry.sourceSha256
    }))
  }, null, 2));
  verifyEvidenceDirectory(evidenceDirectory, verifiedRows, context);
  assert.throws(
    () => verifyEvidenceDirectory(evidenceDirectory, verifiedRows, { ...context, runAttempt: '3' }),
    /source\/run mismatch|third-party release evidence/
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('release candidate manifest, provenance and remote digest gates passed.');
