'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const RELEASE_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const MIN_BINARY_BYTES = 1000000;

function cloudflaredRuntime(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    if (arch === 'ia32') return { assetName: 'cloudflared-windows-386.exe', binaryName: 'cloudflared.exe', archive: 'binary' };
    if (arch === 'x64' || arch === 'arm64') return { assetName: 'cloudflared-windows-amd64.exe', binaryName: 'cloudflared.exe', archive: 'binary' };
  }
  if (platform === 'linux' && ['ia32', 'x64', 'arm64'].includes(arch)) {
    const suffix = { ia32: '386', x64: 'amd64', arm64: 'arm64' }[arch];
    return { assetName: `cloudflared-linux-${suffix}`, binaryName: 'cloudflared', archive: 'binary' };
  }
  throw new Error(`当前系统不支持自动安装 cloudflared（${platform}/${arch}）`);
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function extractTarGz(archive, destination) {
  const tar = zlib.gunzipSync(fs.readFileSync(archive));
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const read = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '').trim();
    const name = [read(345, 500), read(0, 100)].filter(Boolean).join('/');
    const rawSize = read(124, 136);
    if (!/^[0-7]+$/.test(rawSize)) throw new Error('cloudflared 压缩包包含无效的 TAR 文件大小');
    const size = Number.parseInt(rawSize, 8);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(size) || dataEnd > tar.length) throw new Error('cloudflared 压缩包内容不完整');
    const type = String.fromCharCode(header[156] || 0);
    if ((type === '\0' || type === '0') && path.posix.basename(name.replace(/\\/g, '/')) === 'cloudflared') {
      if (size < MIN_BINARY_BYTES) throw new Error('cloudflared 压缩包中的程序文件不完整');
      fs.writeFileSync(destination, tar.subarray(dataStart, dataEnd), { flag: 'wx', mode: 0o755 });
      return;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error('cloudflared 压缩包中未找到可执行文件');
}

async function download(fetchImpl, url, destination) {
  const response = await fetchImpl(url, { redirect: 'follow', headers: { 'User-Agent': 'SyncWatch-Standalone' } });
  const finalUrl = new URL(response.url || url);
  if (finalUrl.protocol !== 'https:' || !response.ok || !response.body) {
    throw new Error(`cloudflared 下载失败（HTTP ${response.status || 0}）`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }));
}

function cachedBinary(destination, markerFile, runtime) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    const stats = fs.statSync(destination);
    return stats.isFile() && stats.size >= MIN_BINARY_BYTES && marker.assetName === runtime.assetName
      && marker.binarySize === stats.size && marker.binarySha256 === sha256(destination);
  } catch (_) { return false; }
}

async function ensureCloudflaredBinary({ dataDir, platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 版本不支持安全下载 cloudflared，请安装 Node.js 22 或更高版本');
  const runtime = cloudflaredRuntime(platform, arch);
  const toolsDir = path.join(path.resolve(dataDir), 'tools');
  const destination = path.join(toolsDir, runtime.binaryName);
  const markerFile = path.join(toolsDir, 'cloudflared.verified.json');
  if (cachedBinary(destination, markerFile, runtime)) return destination;

  fs.mkdirSync(toolsDir, { recursive: true });
  const response = await fetchImpl(RELEASE_API, {
    redirect: 'follow', headers: { 'User-Agent': 'SyncWatch-Standalone', Accept: 'application/vnd.github+json' }
  });
  const apiUrl = new URL(response.url || RELEASE_API);
  if (apiUrl.protocol !== 'https:' || !response.ok) throw new Error(`无法获取 Cloudflare 发布信息（HTTP ${response.status || 0}）`);
  const release = await response.json();
  const asset = Array.isArray(release?.assets) ? release.assets.find((item) => item?.name === runtime.assetName) : null;
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(String(asset?.digest || ''))?.[1]?.toLowerCase() || '';
  const size = Number(asset?.size);
  const url = String(asset?.browser_download_url || '');
  if (!asset || !digest || !Number.isSafeInteger(size) || size < MIN_BINARY_BYTES || !url.startsWith('https://')) {
    throw new Error(`Cloudflare 发布文件 ${runtime.assetName} 的校验信息不完整`);
  }

  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const downloaded = path.join(toolsDir, `.cloudflared-${token}.download`);
  const extracted = path.join(toolsDir, `.cloudflared-${token}.binary`);
  try {
    await download(fetchImpl, url, downloaded);
    const stats = fs.statSync(downloaded);
    if (stats.size !== size || sha256(downloaded) !== digest) throw new Error('cloudflared 下载文件 SHA-256 校验失败');
    const candidate = runtime.archive === 'tgz' ? extracted : downloaded;
    if (runtime.archive === 'tgz') extractTarGz(downloaded, extracted);
    if (platform !== 'win32') fs.chmodSync(candidate, 0o755);
    fs.rmSync(destination, { force: true });
    fs.renameSync(candidate, destination);
    const marker = {
      release: String(release.tag_name || ''), assetName: runtime.assetName, assetSize: size,
      assetSha256: digest, binarySize: fs.statSync(destination).size, binarySha256: sha256(destination)
    };
    const markerTemp = `${markerFile}.${token}.tmp`;
    fs.writeFileSync(markerTemp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    fs.renameSync(markerTemp, markerFile);
    return destination;
  } finally {
    fs.rmSync(downloaded, { force: true });
    fs.rmSync(extracted, { force: true });
  }
}

module.exports = { cloudflaredRuntime, ensureCloudflaredBinary, _test: { extractTarGz } };
