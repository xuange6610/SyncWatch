require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startSyncWatchServer, _test } = require('../server');
const macDistribution = require('../server/macos-distribution');
const releaseVersion = String(require('../package.json').version);
const releaseTag = `v${releaseVersion}`;

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-macos-download-'));
  const artifactsDir = path.join(dataDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const emptyArtifact = path.join(artifactsDir, 'empty.dmg');
  const disguisedArtifact = path.join(artifactsDir, 'not-an-installer.txt');
  fs.writeFileSync(emptyArtifact, '');
  fs.writeFileSync(disguisedArtifact, 'not a ZIP');
  const files = {
    serverX64: path.join(artifactsDir, `SyncWatch同步观影-服务器-${releaseTag}-x64.zip`),
    serverArm64: path.join(artifactsDir, `SyncWatch同步观影-服务器-${releaseTag}-arm64.dmg`),
    clientX64: path.join(artifactsDir, `SyncWatch同步观影-客户端-${releaseTag}-x64.dmg`),
    clientArm64: path.join(artifactsDir, `SyncWatch同步观影-客户端-${releaseTag}-arm64.zip`)
  };
  for (const [name, filename] of Object.entries(files)) fs.writeFileSync(filename, `syncwatch-${name}`);

  const discovered = macDistribution.createMacDistribution({
    kind: 'server', version: releaseTag, roots: [artifactsDir], includeDefaultRoots: false,
    env: { SYNCWATCH_MAC_SERVER_ARM64_URL: 'https://downloads.example.test/server-arm64.dmg' }
  });
  assert.deepEqual(macDistribution.availableMacArchitectures(discovered), ['arm64', 'x64']);
  assert.deepEqual(macDistribution.macDownloadSummary(discovered).find((entry) => entry.architecture === 'x64'), {
    architecture: 'x64', formats: ['zip'], preferredFormat: 'zip', sources: ['local']
  });
  assert.equal(macDistribution.selectMacArtifact({ query: { arch: 'arm64', format: 'dmg' }, headers: {} }, discovered).artifact.source, 'local');
  assert.equal(macDistribution.selectMacArtifact({ query: { arch: 'x64', format: 'dmg' }, headers: {} }, discovered), null);

  const rejectedLocalArtifacts = macDistribution.createMacDistribution({
    kind: 'server', version: releaseTag, roots: [], includeDefaultRoots: false, env: {},
    configured: {
      x64: { dmg: { path: emptyArtifact } },
      arm64: { zip: { path: disguisedArtifact } }
    }
  });
  assert.deepEqual(macDistribution.availableMacArchitectures(rejectedLocalArtifacts), []);
  assert.equal(rejectedLocalArtifacts.x64.dmg, null, 'zero-byte installers must not be advertised');
  assert.equal(rejectedLocalArtifacts.arm64.zip, null, 'a declared format must match the local file extension');

  const normalizedBridge = _test.normalizeMacDownloadPaths({
    x64: { dmg: files.clientX64, zip: files.serverX64 },
    arm64: { dmg: emptyArtifact, zip: files.clientArm64 }
  });
  assert.deepEqual(normalizedBridge, {
    x64: { dmg: files.clientX64, zip: files.serverX64 },
    arm64: { dmg: '', zip: files.clientArm64 }
  });
  const bridged = macDistribution.createMacDistribution({
    kind: 'client', version: releaseTag, legacyPaths: normalizedBridge,
    roots: [], includeDefaultRoots: false, env: {}
  });
  assert.deepEqual(macDistribution.macDownloadSummary(bridged), [
    { architecture: 'arm64', formats: ['zip'], preferredFormat: 'zip', sources: ['local'] },
    { architecture: 'x64', formats: ['dmg', 'zip'], preferredFormat: 'dmg', sources: ['local'] }
  ]);

  assert.deepEqual(_test.availableMacArchitectures({ x64: files.serverX64, arm64: files.serverArm64 }), ['arm64', 'x64']);
  assert.equal(_test.preferredMacArchitecture({ query: { arch: 'arm64' }, headers: {} }, { x64: files.serverX64, arm64: files.serverArm64 }), 'arm64');

  let server;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir: path.resolve(__dirname, '..', 'public'),
      ffprobePath: '', ffmpegPath: '',
      discoverDefaultMacArtifacts: false,
      macDistributionRoots: [artifactsDir],
      macClientDownloadUrls: { arm64: { dmg: `https://downloads.example.test/SyncWatch同步观影-客户端-${releaseTag}-arm64.dmg` } }
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const configResponse = await fetch(`${baseUrl}/api/public-config`);
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    assert.deepEqual(config.macServerDownloadArchitectures, ['arm64', 'x64']);
    assert.deepEqual(config.macClientDownloadArchitectures, ['arm64', 'x64']);
    assert.deepEqual(config.macServerDownloads.find((entry) => entry.architecture === 'x64').formats, ['zip']);

    const serverResponse = await fetch(`${baseUrl}/api/macos-server-download?arch=arm64`);
    assert.equal(serverResponse.status, 200);
    assert.match(decodeURIComponent(serverResponse.headers.get('content-disposition') || ''), /SyncWatch同步观影-[^;]+-arm64\.dmg/i);
    assert.equal(await serverResponse.text(), 'syncwatch-serverArm64');

    const zipResponse = await fetch(`${baseUrl}/api/macos-server-download?arch=x64`);
    assert.equal(zipResponse.status, 200);
    assert.match(decodeURIComponent(zipResponse.headers.get('content-disposition') || ''), /SyncWatch同步观影-[^;]+-x64\.zip/i);
    assert.equal(await zipResponse.text(), 'syncwatch-serverX64');

    const clientResponse = await fetch(`${baseUrl}/api/macos-client-download?arch=arm64`, { redirect: 'manual' });
    assert.equal(clientResponse.status, 302);
    assert.match(decodeURIComponent(clientResponse.headers.get('location') || ''), /downloads\.example\.test\/SyncWatch同步观影-.+arm64\.dmg/i);
    const localClient = await fetch(`${baseUrl}/api/macos-client-download?arch=x64`);
    assert.equal(localClient.status, 200);
    assert.match(decodeURIComponent(localClient.headers.get('content-disposition') || ''), /SyncWatch同步观影-[^;]+-x64\.dmg/i);
    assert.equal(await localClient.text(), 'syncwatch-clientX64');
    const unavailable = await fetch(`${baseUrl}/api/macos-client-download?arch=x64&format=zip`);
    assert.equal(unavailable.status, 404, 'an explicitly unavailable format must not silently change architecture or format');
    const wrongFormat = await fetch(`${baseUrl}/api/macos-client-download?arch=arm64&format=zip`);
    assert.equal(wrongFormat.status, 200, 'local ZIP fallback remains available');
    assert.match(decodeURIComponent(wrongFormat.headers.get('content-disposition') || ''), /SyncWatch同步观影-[^;]+-arm64\.zip/i);
  } finally {
    await server?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('macOS download contract tests passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
