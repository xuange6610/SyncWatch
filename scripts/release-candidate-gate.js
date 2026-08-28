'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ASSETS: THIRD_PARTY_ASSETS } = require('./release-third-party-assets');

const repositoryRoot = path.resolve(__dirname, '..');
const defaultVersion = String(require(path.join(repositoryRoot, 'package.json')).version);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const BUILD_EVIDENCE_SCHEMA = 'syncwatch-release-build-evidence-v1';
const THIRD_PARTY_EVIDENCE_SCHEMA = 'syncwatch-third-party-evidence-v1';

function asset(name, minimumBytes, group, options = {}) {
  return {
    name,
    minimumBytes,
    maximumBytes: options.maximumBytes || Number.MAX_SAFE_INTEGER,
    group,
    kind: options.kind || 'application',
    sha256: options.sha256 || ''
  };
}

function manifestForVersion(version = defaultVersion) {
  const v = String(version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`Invalid release version: ${version}`);
  const windowsBase = [
    asset(`SyncWatch-Experience-Client-Portable-v${v}-x64.exe`, 50 * MIB, 'windows-base', { maximumBytes: GIB }),
    asset(`SyncWatch-Standard-Server-Portable-v${v}-x64.exe`, 50 * MIB, 'windows-base', { maximumBytes: GIB })
  ];
  const windowsFull = [
    // The Windows + Android-only offline closure is normally ~430 MiB after
    // macOS payloads were retired; keep a 300 MiB floor to reject incomplete
    // packages without requiring the obsolete 1 GiB macOS-inclusive bundle.
    asset(`SyncWatch-v${v}-Full-Offline-Installer-x64.exe`, 300 * MIB, 'windows-full', { maximumBytes: 2 * GIB }),
    asset(`SyncWatch-v${v}-Full-Offline-Portable-x64.exe`, 300 * MIB, 'windows-full', { maximumBytes: 2 * GIB })
  ];
  const android = [asset(`SyncWatch-Android-v${v}-universal.apk`, 150 * MIB, 'android', { maximumBytes: GIB })];
  const officialByName = new Map(THIRD_PARTY_ASSETS.map((entry) => [entry.name, entry]));
  const nodeRuntime = [
    ['node-v24.19.0-x64.msi', 20 * MIB],
    ['node-v24.19.0-arm64.msi', 20 * MIB],
    
  ].map(([name, minimumBytes]) => asset(name, minimumBytes, 'node', {
    kind: 'third-party', maximumBytes: 256 * MIB, sha256: officialByName.get(name)?.sha256
  }));
  const cloudflared = [
    'cloudflared-windows-x64.exe',
    'cloudflared-windows-x64-installer.msi',
    'cloudflared-windows-x86-installer.msi'
  ].map((name) => asset(name, 10 * MIB, 'cloudflared', {
    kind: 'third-party', maximumBytes: 128 * MIB, sha256: officialByName.get(name)?.sha256
  }));
  const manifest = [...windowsBase, ...windowsFull, ...android, ...nodeRuntime, ...cloudflared];
  if (manifest.length !== 10 || manifest.some((entry) => entry.kind === 'third-party' && !entry.sha256)) {
    throw new Error('Release manifest is incomplete or is missing a pinned third-party digest.');
  }
  return manifest;
}

function sourceArchivesForVersion(version = defaultVersion) {
  const v = String(version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`Invalid release version: ${version}`);
  return [
    asset(`SyncWatch-Source-v${v}.zip`, MIB, 'source', { kind: 'source', maximumBytes: 512 * MIB }),
    asset(`SyncWatch-Source-v${v}.tar.gz`, MIB, 'source', { kind: 'source', maximumBytes: 512 * MIB })
  ];
}

function requiredForPhase(phase, version = defaultVersion) {
  const manifest = manifestForVersion(version);
  const byGroup = (...groups) => manifest.filter((entry) => groups.includes(entry.group));
  const android = byGroup('android');
  const windowsBase = byGroup('windows-base');
  switch (phase) {
    case 'android': return [];
    case 'windows-base': return [...android];
    case 'windows-full': return [...android, ...windowsBase];
    case 'final': return manifest;
    case 'bundle': return [...manifest, ...sourceArchivesForVersion(version)];
    default: throw new Error(`Unknown release candidate phase: ${phase}`);
  }
}

function assetsForSelection(selection, version = defaultVersion) {
  const manifest = manifestForVersion(version);
  const byGroup = (...groups) => manifest.filter((entry) => groups.includes(entry.group));
  if (selection === 'release' || selection === 'final') return manifest;
  if (selection === 'bundle') return [...manifest, ...sourceArchivesForVersion(version)];
  if (selection === 'applications') return manifest.filter((entry) => entry.kind === 'application');
  if (selection === 'official') return manifest.filter((entry) => entry.kind === 'third-party');
  if (['android', 'windows-base', 'windows-full'].includes(selection)) return byGroup(selection);
  throw new Error(`Unknown release asset selection: ${selection}`);
}

function normalizeMetadata(payload) {
  const assets = Array.isArray(payload) ? payload : payload?.assets;
  if (!Array.isArray(assets)) throw new Error('Release metadata must contain an assets array.');
  const byName = new Map();
  for (const entry of assets) {
    const name = String(entry?.name || '');
    if (!name) throw new Error('Release metadata contains an unnamed asset.');
    if (byName.has(name)) throw new Error(`Duplicate release asset name: ${name}`);
    byName.set(name, entry);
  }
  return { assets, byName };
}

function normalizeDigest(value, label) {
  const digest = String(value || '').toLowerCase().replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid SHA-256 digest for ${label}.`);
  return digest;
}

function assertSize(expected, size) {
  if (!Number.isSafeInteger(size) || size < expected.minimumBytes || size >= expected.maximumBytes) {
    throw new Error(`Release candidate asset has an invalid size: ${expected.name} (${size} bytes)`);
  }
}

function parseChecksumManifest(filename) {
  const entries = new Map();
  const text = fs.readFileSync(path.resolve(filename), 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([a-fA-F0-9]{64})\s+[*]?(.+)$/.exec(line);
    if (!match) throw new Error(`Invalid checksum manifest line: ${rawLine}`);
    if (entries.has(match[2])) throw new Error(`Duplicate checksum manifest entry: ${match[2]}`);
    entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}

function verifyMetadataForAssets(payload, expectedAssets, options = {}) {
  const { assets, byName } = normalizeMetadata(payload);
  const expectedNames = new Set(expectedAssets.map((entry) => entry.name));
  if (options.exact !== false) {
    const unexpected = assets.filter((entry) => !expectedNames.has(String(entry.name)));
    if (assets.length !== expectedAssets.length || unexpected.length) {
      throw new Error(`Final candidate must contain exactly ${expectedAssets.length} assets; found ${assets.length}`
        + (unexpected.length ? `; unexpected: ${unexpected.map((entry) => entry.name).join(', ')}` : ''));
    }
  }
  const seenDigests = new Map();
  return expectedAssets.map((expected) => {
    const actual = byName.get(expected.name);
    if (!actual) throw new Error(`Missing release candidate asset: ${expected.name}`);
    const size = Number(actual.size);
    assertSize(expected, size);
    if (actual.state && actual.state !== 'uploaded') {
      throw new Error(`Release candidate asset is not uploaded: ${expected.name} (${actual.state})`);
    }
    const digest = normalizeDigest(actual.digest, expected.name);
    const pinned = expected.sha256 ? normalizeDigest(expected.sha256, `${expected.name} pinned digest`) : '';
    const local = options.expectedDigests?.get(expected.name) || '';
    if (pinned && digest !== pinned) throw new Error(`Pinned SHA-256 mismatch for ${expected.name}.`);
    if (local && digest !== normalizeDigest(local, `${expected.name} local digest`)) {
      throw new Error(`Remote SHA-256 mismatch for ${expected.name}.`);
    }
    if (seenDigests.has(digest)) throw new Error(`Duplicate release content: ${expected.name} and ${seenDigests.get(digest)}`);
    seenDigests.set(digest, expected.name);
    return { ...expected, size, digest: `sha256:${digest}` };
  });
}

function verifyMetadata(payload, phase, version = defaultVersion, options = {}) {
  return verifyMetadataForAssets(payload, requiredForPhase(phase, version), {
    ...options,
    exact: phase === 'final' || phase === 'bundle'
  });
}

function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(8 * MIB);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function verifyDirectoryForAssets(directory, expectedAssets, options = {}) {
  const root = path.resolve(directory);
  const expectedNames = new Set(expectedAssets.map((entry) => entry.name));
  const files = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile());
  if (options.exact !== false) {
    const unexpected = files.filter((entry) => !expectedNames.has(entry.name));
    if (files.length !== expectedAssets.length || unexpected.length) {
      throw new Error(`Final candidate directory must contain exactly ${expectedAssets.length} files; found ${files.length}`
        + (unexpected.length ? `; unexpected: ${unexpected.map((entry) => entry.name).join(', ')}` : ''));
    }
  }
  const seenDigests = new Map();
  return expectedAssets.map((expected) => {
    const filename = path.join(root, expected.name);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new Error(`Missing release candidate file: ${expected.name}`);
    const size = fs.statSync(filename).size;
    assertSize(expected, size);
    const digest = sha256File(filename);
    if (expected.sha256 && digest !== normalizeDigest(expected.sha256, `${expected.name} pinned digest`)) {
      throw new Error(`Pinned SHA-256 mismatch for ${expected.name}.`);
    }
    if (seenDigests.has(digest)) throw new Error(`Duplicate release content: ${expected.name} and ${seenDigests.get(digest)}`);
    seenDigests.set(digest, expected.name);
    return { ...expected, size, digest: `sha256:${digest}` };
  });
}

function verifyDirectory(directory, phase, version = defaultVersion) {
  return verifyDirectoryForAssets(directory, requiredForPhase(phase, version), {
    exact: phase === 'final' || phase === 'bundle'
  });
}

function verifySelectionDirectory(directory, selection, version = defaultVersion) {
  return verifyDirectoryForAssets(directory, assetsForSelection(selection, version), { exact: true });
}

function assertSourceContext(context) {
  for (const key of ['sourceCommit', 'sourceTree']) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(context[key] || ''))) {
      throw new Error(`Invalid ${key} for release evidence.`);
    }
  }
  if (!/^\d+$/.test(String(context.runId || '')) || !/^\d+$/.test(String(context.runAttempt || ''))) {
    throw new Error('Release evidence requires numeric runId and runAttempt.');
  }
}

function writeBuildEvidence(filename, rows, selection, context) {
  assertSourceContext(context);
  if (!rows.length || rows.some((row) => row.kind !== 'application')) {
    throw new Error('Build evidence may only describe SyncWatch application assets.');
  }
  const payload = {
    schema: BUILD_EVIDENCE_SCHEMA,
    selection,
    sourceCommit: context.sourceCommit,
    sourceTree: context.sourceTree,
    runId: String(context.runId),
    runAttempt: String(context.runAttempt),
    files: rows.map((row) => ({ name: row.name, size: row.size, sha256: normalizeDigest(row.digest, row.name) }))
  };
  const target = path.resolve(filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
}

function verifyEvidenceDirectory(directory, rows, context) {
  assertSourceContext(context);
  const rowByName = new Map(rows.map((row) => [row.name, row]));
  const applicationNames = new Set(rows.filter((row) => row.kind === 'application').map((row) => row.name));
  const officialNames = new Set(rows.filter((row) => row.kind === 'third-party').map((row) => row.name));
  const seenApplications = new Set();
  let officialEvidence = null;
  const evidenceFiles = fs.readdirSync(path.resolve(directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  for (const entry of evidenceFiles) {
    const payload = JSON.parse(fs.readFileSync(path.join(path.resolve(directory), entry.name), 'utf8'));
    if (payload.schema === BUILD_EVIDENCE_SCHEMA) {
      if (payload.sourceCommit !== context.sourceCommit || payload.sourceTree !== context.sourceTree
          || String(payload.runId) !== String(context.runId) || String(payload.runAttempt) !== String(context.runAttempt)) {
        throw new Error(`Build evidence source/run mismatch: ${entry.name}`);
      }
      if (!Array.isArray(payload.files) || !payload.files.length) throw new Error(`Build evidence has no files: ${entry.name}`);
      for (const file of payload.files) {
        if (!applicationNames.has(file.name) || seenApplications.has(file.name)) {
          throw new Error(`Unexpected or duplicate application evidence: ${file.name}`);
        }
        const actual = rowByName.get(file.name);
        if (Number(file.size) !== actual.size || normalizeDigest(file.sha256, file.name) !== normalizeDigest(actual.digest, file.name)) {
          throw new Error(`Application evidence mismatch: ${file.name}`);
        }
        seenApplications.add(file.name);
      }
    } else if (payload.schema === THIRD_PARTY_EVIDENCE_SCHEMA) {
      if (officialEvidence) throw new Error('Duplicate third-party release evidence.');
      officialEvidence = payload;
    }
  }
  if (seenApplications.size !== applicationNames.size) {
    const missing = [...applicationNames].filter((name) => !seenApplications.has(name));
    throw new Error(`Missing application build evidence: ${missing.join(', ')}`);
  }
  if (!officialEvidence || String(officialEvidence.runId) !== String(context.runId)
      || String(officialEvidence.runAttempt) !== String(context.runAttempt)) {
    throw new Error('Missing or mismatched third-party release evidence.');
  }
  const upstreamByName = new Map(THIRD_PARTY_ASSETS.map((entry) => [entry.name, entry]));
  const seenOfficial = new Set();
  for (const file of officialEvidence.assets || []) {
    const upstream = upstreamByName.get(file.name);
    const actual = rowByName.get(file.name);
    if (!upstream || !officialNames.has(file.name) || seenOfficial.has(file.name)) {
      throw new Error(`Unexpected or duplicate third-party evidence: ${file.name}`);
    }
    if (file.sourceUrl !== upstream.url || normalizeDigest(file.sourceSha256, `${file.name} source`) !== upstream.sourceSha256
        || Number(file.bytes) !== actual.size || normalizeDigest(file.sha256, file.name) !== normalizeDigest(actual.digest, file.name)) {
      throw new Error(`Third-party evidence mismatch: ${file.name}`);
    }
    seenOfficial.add(file.name);
  }
  if (seenOfficial.size !== officialNames.size) {
    const missing = [...officialNames].filter((name) => !seenOfficial.has(name));
    throw new Error(`Missing third-party release evidence: ${missing.join(', ')}`);
  }
}

function writeManifest(filename, rows) {
  const target = path.resolve(filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rows.map((row) => `${normalizeDigest(row.digest, row.name)}  ${row.name}`).join('\n') + '\n');
}

function writeList(filename, rows, prefix = '') {
  const target = path.resolve(filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rows.map((row) => `${prefix}${row.name}`).join('\n') + '\n');
}

function parseArguments(argv) {
  const options = {
    phase: '', selection: '', version: defaultVersion, metadata: '', directory: '', manifest: '',
    uploadManifest: '', releaseList: '', expectedManifest: '', evidence: '', evidenceDirectory: '',
    sourceCommit: '', sourceTree: '', runId: '', runAttempt: ''
  };
  const keys = new Set([
    '--phase', '--selection', '--version', '--metadata', '--directory', '--manifest', '--upload-manifest',
    '--release-list', '--expected-manifest', '--evidence', '--evidence-directory', '--source-commit',
    '--source-tree', '--run-id', '--run-attempt'
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: true };
    if (!keys.has(key)) throw new Error(`Unknown argument: ${key}`);
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${key}`);
    const camel = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[camel] = value;
  }
  if (Boolean(options.phase) === Boolean(options.selection)) throw new Error('Provide exactly one of --phase or --selection.');
  if (Boolean(options.metadata) === Boolean(options.directory)) throw new Error('Provide exactly one of --metadata or --directory.');
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log('Usage: node scripts/release-candidate-gate.js (--phase phase|--selection selection) (--metadata json|--directory dir) [options]');
    return;
  }
  const expected = options.selection
    ? assetsForSelection(options.selection, options.version)
    : requiredForPhase(options.phase, options.version);
  const expectedDigests = options.expectedManifest ? parseChecksumManifest(options.expectedManifest) : null;
  if (expectedDigests) {
    const expectedNames = new Set(expected.map((entry) => entry.name));
    const extra = [...expectedDigests.keys()].filter((name) => !expectedNames.has(name));
    const missing = expected.filter((entry) => !expectedDigests.has(entry.name));
    if (expectedDigests.size !== expected.length || extra.length || missing.length) {
      throw new Error(`Expected checksum manifest must contain exactly ${expected.length} entries.`);
    }
  }
  const rows = options.metadata
    ? verifyMetadataForAssets(JSON.parse(fs.readFileSync(path.resolve(options.metadata), 'utf8')), expected, {
      exact: options.selection ? true : options.phase === 'final' || options.phase === 'bundle', expectedDigests
    })
    : verifyDirectoryForAssets(options.directory, expected, {
      exact: options.selection ? true : options.phase === 'final' || options.phase === 'bundle'
    });
  const context = {
    sourceCommit: options.sourceCommit,
    sourceTree: options.sourceTree,
    runId: options.runId,
    runAttempt: options.runAttempt
  };
  if (options.evidence) writeBuildEvidence(options.evidence, rows, options.selection || options.phase, context);
  if (options.evidenceDirectory) verifyEvidenceDirectory(options.evidenceDirectory, rows, context);
  if (options.manifest) writeManifest(options.manifest, rows);
  const uploadRows = rows.filter((row) => row.kind !== 'source');
  if (options.uploadManifest) writeManifest(options.uploadManifest, uploadRows);
  if (options.releaseList) writeList(options.releaseList, uploadRows, 'dist/');
  console.log(`Release candidate gate passed: ${options.selection ? 'selection' : 'phase'}=${options.selection || options.phase}, assets=${rows.length}, version=v${options.version}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message || error); process.exitCode = 1; }
}

module.exports = {
  BUILD_EVIDENCE_SCHEMA,
  THIRD_PARTY_EVIDENCE_SCHEMA,
  manifestForVersion,
  sourceArchivesForVersion,
  requiredForPhase,
  assetsForSelection,
  verifyMetadata,
  verifyMetadataForAssets,
  verifyDirectory,
  verifySelectionDirectory,
  verifyEvidenceDirectory,
  parseChecksumManifest,
  writeBuildEvidence,
  writeManifest
};
