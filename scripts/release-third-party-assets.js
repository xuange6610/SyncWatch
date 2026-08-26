'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NODE_VERSION = '24.19.0';
const CLOUDFLARED_VERSION = '2026.8.2';
const THIRD_PARTY_EVIDENCE_SCHEMA = 'syncwatch-third-party-evidence-v1';
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const DOWNLOAD_ATTEMPTS = 3;
const PROJECT_VERSION = String(require('../package.json').version);
let proxyDispatcher;

function getProxyDispatcher() {
  if (!process.env.HTTP_PROXY && !process.env.HTTPS_PROXY && !process.env.ALL_PROXY) return undefined;
  if (!proxyDispatcher) {
    const { EnvHttpProxyAgent } = require('undici');
    proxyDispatcher = new EnvHttpProxyAgent();
  }
  return proxyDispatcher;
}

const ASSETS = Object.freeze([
  {
    name: `node-v${NODE_VERSION}-x64.msi`,
    sourceName: `node-v${NODE_VERSION}-x64.msi`,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-x64.msi`,
    sha256: 'f0f66c2a80c08a30a5ab5179ee9ea9e45f9b46289436a8cc87ff833b852db351',
    sourceSha256: 'f0f66c2a80c08a30a5ab5179ee9ea9e45f9b46289436a8cc87ff833b852db351',
    upstream: `Node.js v${NODE_VERSION}`
  },
  {
    name: `node-v${NODE_VERSION}-arm64.msi`,
    sourceName: `node-v${NODE_VERSION}-arm64.msi`,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-arm64.msi`,
    sha256: '47b16e1b1012b1b9ad62169b3a466adb6bc758b2cb8bd8224683c086836484f8',
    sourceSha256: '47b16e1b1012b1b9ad62169b3a466adb6bc758b2cb8bd8224683c086836484f8',
    upstream: `Node.js v${NODE_VERSION}`
  },
  {
    name: `node-v${NODE_VERSION}-macos-x64.pkg`,
    sourceName: `node-v${NODE_VERSION}.pkg`,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}.pkg`,
    sha256: '13ecebfefa0234e3d618b4a0af8c5803bdeedab30b84ee37cccafb7276d90a0e',
    sourceSha256: '13ecebfefa0234e3d618b4a0af8c5803bdeedab30b84ee37cccafb7276d90a0e',
    upstream: `Node.js v${NODE_VERSION}`
  },
  {
    name: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sourceName: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
    sourceSha256: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
    upstream: `Node.js v${NODE_VERSION}`
  },
  {
    name: 'cloudflared-windows-x64.exe',
    sourceName: 'cloudflared-windows-amd64.exe',
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`,
    sha256: 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5',
    sourceSha256: 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5',
    upstream: `cloudflared ${CLOUDFLARED_VERSION}`
  },
  {
    name: 'cloudflared-windows-x64-installer.msi',
    sourceName: 'cloudflared-windows-amd64.msi',
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.msi`,
    sha256: '7067806367266ad66ae8e742b2856827a8ff07e1eb45f8fcbb335d4a28988a23',
    sourceSha256: '7067806367266ad66ae8e742b2856827a8ff07e1eb45f8fcbb335d4a28988a23',
    upstream: `cloudflared ${CLOUDFLARED_VERSION}`
  },
  {
    name: 'cloudflared-windows-x86-installer.msi',
    sourceName: 'cloudflared-windows-386.msi',
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-386.msi`,
    sha256: 'c8d16c3cf20106958ec907361844c170cbeafb1f1c8ba24c906f332413381dc5',
    sourceSha256: 'c8d16c3cf20106958ec907361844c170cbeafb1f1c8ba24c906f332413381dc5',
    upstream: `cloudflared ${CLOUDFLARED_VERSION}`
  },
  {
    name: 'cloudflared-macos-x64',
    sourceName: 'cloudflared-darwin-amd64.tgz',
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-amd64.tgz`,
    sha256: 'b0f770e1e0b281399a57219b840fd8eef1cc25387a404124248157ea2073727a',
    sourceSha256: 'f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4',
    upstream: `cloudflared ${CLOUDFLARED_VERSION}`,
    archive: true
  },
  {
    name: 'cloudflared-macos-arm64',
    sourceName: 'cloudflared-darwin-arm64.tgz',
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-arm64.tgz`,
    sha256: 'b61054d3d6326ea558cb49826eebf5676e0d0a36d51b546975096ca3e0e3c89d',
    sourceSha256: '9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442',
    upstream: `cloudflared ${CLOUDFLARED_VERSION}`,
    archive: true
  }
]);

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function download(url) {
  let lastError;
  const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        dispatcher: getProxyDispatcher(),
        headers: {
          'User-Agent': `SyncWatch-release-builder/${PROJECT_VERSION}`,
          ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {})
        },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`Official asset download failed (${response.status}): ${url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw new Error(`Official asset download was empty: ${url}`);
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
    }
  }
  throw new Error(`Official asset download failed after ${DOWNLOAD_ATTEMPTS} attempts: ${url} (${lastError?.message || lastError})`);
}

async function downloadText(url) {
  return (await download(url)).toString('utf8');
}

async function verifyUpstreamManifests(selected) {
  const nodeAssets = selected.filter((entry) => entry.upstream.startsWith('Node.js '));
  if (nodeAssets.length) {
    const shasums = await downloadText(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`);
    const upstream = new Map();
    for (const line of shasums.split(/\r?\n/)) {
      const match = /^([a-f0-9]{64})\s+[*]?(.+)$/.exec(line.trim());
      if (match) upstream.set(match[2], match[1]);
    }
    for (const entry of nodeAssets) {
      if (upstream.get(entry.sourceName) !== entry.sourceSha256) {
        throw new Error(`Node.js SHASUMS256 mismatch for ${entry.sourceName}`);
      }
    }
  }

  const cloudflaredAssets = selected.filter((entry) => entry.upstream.startsWith('cloudflared '));
  if (cloudflaredAssets.length) {
    const release = JSON.parse(await downloadText(
      `https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${CLOUDFLARED_VERSION}`
    ));
    const upstream = new Map((release.assets || []).map((entry) => [entry.name, String(entry.digest || '').replace(/^sha256:/, '')]));
    for (const entry of cloudflaredAssets) {
      if (upstream.get(entry.sourceName) !== entry.sourceSha256) {
        throw new Error(`cloudflared release digest mismatch for ${entry.sourceName}`);
      }
    }
  }
}

function writeVerifiedFile(outputDirectory, entry, bytes) {
  const actual = digest(bytes);
  if (actual !== entry.sha256) throw new Error(`SHA-256 mismatch for ${entry.name}: expected ${entry.sha256}, got ${actual}`);
  const target = path.join(outputDirectory, entry.name);
  if (fs.existsSync(target)) throw new Error(`Refusing to replace an existing release asset: ${target}`);
  const staging = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(staging, bytes, { flag: 'wx' });
  fs.renameSync(staging, target);
  if (entry.name.startsWith('cloudflared-macos-')) fs.chmodSync(target, 0o755);
  return {
    name: entry.name, bytes: bytes.length, sha256: actual,
    upstream: entry.upstream, sourceName: entry.sourceName, sourceUrl: entry.url,
    sourceSha256: entry.sourceSha256
  };
}

function findCloudflared(directory) {
  const queue = [directory];
  while (queue.length) {
    const current = queue.shift();
    for (const child of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, child.name);
      if (child.isDirectory()) queue.push(absolute);
      else if (child.isFile() && child.name === 'cloudflared') return absolute;
    }
  }
  return '';
}

async function prepareAsset(outputDirectory, entry) {
  const downloaded = await download(entry.url);
  const sourceDigest = digest(downloaded);
  if (sourceDigest !== entry.sourceSha256) {
    throw new Error(`Upstream SHA-256 mismatch for ${entry.sourceName}: expected ${entry.sourceSha256}, got ${sourceDigest}`);
  }
  if (!entry.archive) return writeVerifiedFile(outputDirectory, entry, downloaded);

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-official-'));
  try {
    const archive = path.join(temporaryDirectory, entry.sourceName);
    const extracted = path.join(temporaryDirectory, 'extracted');
    fs.writeFileSync(archive, downloaded, { flag: 'wx' });
    fs.mkdirSync(extracted);
    const result = spawnSync('tar', ['-xzf', archive, '-C', extracted], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Unable to extract ${entry.sourceName}: ${String(result.stderr || '').trim()}`);
    const binary = findCloudflared(extracted);
    if (!binary) throw new Error(`${entry.sourceName} did not contain cloudflared`);
    return writeVerifiedFile(outputDirectory, entry, fs.readFileSync(binary));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = { output: '', evidence: '', only: [], runId: '', runAttempt: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--print-manifest') { options.print = true; continue; }
    if (!['--output', '--evidence', '--only', '--run-id', '--run-attempt'].includes(key) || !value) {
      throw new Error(`Invalid argument: ${key}`);
    }
    const optionName = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[optionName] = key === '--only' ? value.split(',').filter(Boolean) : value;
    index += 1;
  }
  if (!options.print && !options.output) throw new Error('--output is required.');
  if (options.evidence && (!/^\d+$/.test(options.runId) || !/^\d+$/.test(options.runAttempt))) {
    throw new Error('--evidence requires numeric --run-id and --run-attempt.');
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.print) { console.log(JSON.stringify(ASSETS, null, 2)); return; }
  const requested = options.only.length ? options.only : ASSETS.map((entry) => entry.name);
  const selected = ASSETS.filter((entry) => requested.includes(entry.name));
  if (!selected.length || requested.length !== new Set(requested).size || selected.length !== requested.length) {
    throw new Error('The official asset selection is empty, duplicated, or contains an unknown name.');
  }
  const outputDirectory = path.resolve(options.output);
  fs.mkdirSync(outputDirectory, { recursive: true });
  await verifyUpstreamManifests(selected);
  const evidence = [];
  for (const entry of selected) {
    const row = await prepareAsset(outputDirectory, entry);
    evidence.push(row);
    console.log(`${row.name} | ${row.bytes} bytes | SHA-256 ${row.sha256}`);
  }
  if (options.evidence) {
    const target = path.resolve(options.evidence);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({
      schema: THIRD_PARTY_EVIDENCE_SCHEMA,
      runId: String(options.runId),
      runAttempt: String(options.runAttempt),
      nodeVersion: NODE_VERSION,
      cloudflaredVersion: CLOUDFLARED_VERSION,
      assets: evidence
    }, null, 2) + '\n');
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
}

module.exports = {
  ASSETS,
  NODE_VERSION,
  CLOUDFLARED_VERSION,
  THIRD_PARTY_EVIDENCE_SCHEMA,
  DOWNLOAD_TIMEOUT_MS,
  DOWNLOAD_ATTEMPTS,
  digest,
  parseArguments,
  verifyUpstreamManifests
};
