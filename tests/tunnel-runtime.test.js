'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `syncwatch-tunnel-runtime-${process.pid}-`));
process.env.SYNCWATCH_SMOKE_MODE = '1';
process.env.SYNCWATCH_SMOKE_EXIT_MS = '2500';
process.env.SYNCWATCH_DATA_DIR = path.join(temporaryRoot, 'data');

const { _test } = require('../electron-pink');

assert.deepEqual(_test.cloudflaredRuntime('win32', 'x64'), {
  platform: 'win32', arch: 'x64', binaryName: 'cloudflared.exe',
  assetName: 'cloudflared-windows-amd64.exe', archive: 'binary', emulated: false
});
assert.deepEqual(_test.cloudflaredRuntime('win32', 'ia32'), {
  platform: 'win32', arch: 'ia32', binaryName: 'cloudflared.exe',
  assetName: 'cloudflared-windows-386.exe', archive: 'binary'
});
assert.equal(_test.cloudflaredRuntime('win32', 'arm64').assetName, 'cloudflared-windows-amd64.exe');
assert.equal(_test.cloudflaredRuntime('win32', 'arm64').emulated, true);
assert.deepEqual(_test.cloudflaredRuntime('darwin', 'x64'), {
  platform: 'darwin', arch: 'x64', binaryName: 'cloudflared',
  assetName: 'cloudflared-darwin-amd64.tgz', archive: 'tgz'
});
assert.equal(_test.cloudflaredRuntime('darwin', 'arm64').assetName, 'cloudflared-darwin-arm64.tgz');
assert.throws(() => _test.cloudflaredRuntime('linux', 'x64'), /不支持自动安装/);
assert.throws(() => _test.cloudflaredRuntime('darwin', 'ia32'), /不支持自动安装/);

assert.deepEqual(
  [0, 1, 2, 3, 4, 5, 12].map((attempt) => _test.tunnelRestartDelayMs(attempt)),
  [2000, 4000, 8000, 16000, 30000, 30000, 30000]
);
assert.deepEqual(
  [0, 1, 2, 3, 4].map((attempt) => _test.tunnelRestartDelayMs(attempt, { baseDelayMs: 750, maxDelayMs: 5000 })),
  [750, 1500, 3000, 5000, 5000]
);

const networkCandidates = _test.physicalNetworkCandidates({
  'vEthernet (WSL)': [{ family: 'IPv4', address: '172.28.64.1', internal: false }],
  DockerNAT: [{ family: 'IPv4', address: '10.0.75.1', internal: false }],
  'VMware Network Adapter VMnet8': [{ family: 'IPv4', address: '192.168.220.1', internal: false }],
  NordVPN: [{ family: 'IPv4', address: '10.8.0.2', internal: false }],
  'Wi-Fi': [
    { family: 'IPv6', address: 'fe80::1', internal: false },
    { family: 'IPv4', address: '192.168.31.200', internal: false }
  ],
  Ethernet: [{ family: 4, address: '192.168.1.20', internal: false }],
  Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }]
});
assert.equal(networkCandidates.selected.address, '192.168.31.200');
assert.equal(_test.preferredPhysicalIpv4({
  'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.18.0.1', internal: false }],
  Ethernet: [{ family: 'IPv4', address: '10.0.0.8', internal: false }]
}), '10.0.0.8');
for (const virtualName of ['vEthernet (WSL)', 'DockerNAT', 'VMware Network Adapter VMnet8', 'NordVPN']) {
  assert.ok(networkCandidates.rejected.some((candidate) => candidate.name === virtualName));
}

const hashFixture = path.join(temporaryRoot, 'hash.txt');
fs.writeFileSync(hashFixture, 'abc');
assert.equal(_test.fileSha256(hashFixture), crypto.createHash('sha256').update('abc').digest('hex'));

function tarGzWithFile(name, contents) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${contents.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return zlib.gzipSync(Buffer.concat([header, contents, padding, Buffer.alloc(1024)]));
}

const payload = Buffer.alloc(1_000_321, 0x5a);
const archive = path.join(temporaryRoot, 'cloudflared.tgz');
const extracted = path.join(temporaryRoot, 'cloudflared');
fs.writeFileSync(archive, tarGzWithFile('release/cloudflared', payload));
const extraction = _test.extractCloudflaredTarGz(archive, extracted);
assert.equal(extraction.entryName, 'release/cloudflared');
assert.equal(fs.statSync(extracted).size, payload.length);
assert.equal(_test.fileSha256(extracted), crypto.createHash('sha256').update(payload).digest('hex'));

const source = fs.readFileSync(path.join(__dirname, '..', 'electron-pink.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const stopSource = source.match(/async function stop\(\)[\s\S]*?return \{ \.\.\.current \};\s*\}/)?.[0] || '';
const statusSource = source.match(/status:\s*async\s*\(\)\s*=>\s*\{[\s\S]*?return\s+\{\s*\.\.\.current,[\s\S]*?\n\s*\}\s*\n\s*\};/)?.[0] || '';
assert.match(source, /restartEligibleProcess === tunnelProcess[\s\S]*?scheduleAutoRestart\(failure\)/);
assert.match(source, /function scheduleAutoRestart[\s\S]*?tunnelRestartDelayMs\(autoRestartAttempts\)/);
assert.match(source, /const lastPublicUrl = automaticRecovery \? String\(current\.lastPublicUrl \|\| ''\) : ''/);
assert.match(source, /runtime\.platform === 'darwin' \? \[`cloudflared-darwin-\$\{runtime\.arch\}`\] : \[\]/);
assert.match(stopSource, /cancelAutoRestart\(\)/);
assert.match(stopSource, /desiredTunnel = null/);
assert.doesNotMatch(statusSource, /await\s+start\s*\(/);
assert.match(source, /\['QUICK_API_TIMEOUT', 'DNS_RESOLUTION_FAILED'\]\.includes\(recorded\.failure\.code\)[\s\S]*?flushDnsCache\(\)/);
assert.equal(_test.DEFAULT_TUNNEL_BYPASS_PROXY, true);
assert.equal(_test.extractQuickTunnelPublicUrl('INF Requesting new quick Tunnel on https://api.trycloudflare.com'), '');
assert.equal(_test.extractQuickTunnelPublicUrl('INF Your quick Tunnel has been created! Visit it at https://bright-cinema-example.trycloudflare.com'), 'https://bright-cinema-example.trycloudflare.com');
assert.equal(_test.tunnelConnectorRegistered('INF Registered tunnel connection connIndex=0'), true);
assert.deepEqual(_test.tunnelFakeIpAddresses('dial tcp 198.18.0.59:7844 and 198.19.0.4:443'), ['198.18.0.59', '198.19.0.4']);
assert.equal(_test.isPublicIpv4Address('198.41.192.7'), true);
assert.equal(_test.isPublicIpv4Address('198.18.0.7'), false, 'Fake-IP 地址不能作为 Cloudflare Edge');
assert.equal(_test.isPublicIpv4Address('192.168.1.1'), false);
assert.deepEqual(_test.normalizeTunnelEdgeAddresses(['198.41.192.7:7844', '198.41.192.7', '198.18.0.7', '198.41.200.13']), ['198.41.192.7', '198.41.200.13']);
assert.deepEqual(_test.cloudflareEdgeTargetsFromSrv({ Answer: [
  { type: 33, data: '1 1 7844 region1.v2.argotunnel.com.' },
  { type: 33, data: '1 1 443 malicious.example.com.' },
  { type: 33, data: '1 1 7844 region2.v2.argotunnel.com.' }
] }), ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com']);
assert.deepEqual(_test.publicIpv4AddressesFromDnsAnswer({ Answer: [
  { type: 1, data: '198.41.192.7' }, { type: 1, data: '198.18.0.7' }
] }), ['198.41.192.7']);
assert.deepEqual(_test.tunnelCommandArgs('quick', 5000, {
  bypassProxy: true, bindAddress: '192.168.110.188', protocol: 'http2', edgeAddresses: ['198.41.192.7', '198.41.200.13']
}), [
  'tunnel', '--url', 'http://127.0.0.1:5000', '--protocol', 'http2', '--edge-ip-version', '4',
  '--edge', '198.41.192.7:7844', '--edge', '198.41.200.13:7844', '--edge-bind-address', '192.168.110.188',
  '--retries', '12', '--no-autoupdate'
]);
const pinnedStrategies = _test.tunnelConnectionStrategies('quick', {
  bypassProxy: true, bindAddress: '192.168.110.188', edgeAddresses: ['198.41.192.7']
});
assert.equal(pinnedStrategies[0].id, 'direct-http2-pinned-edge');
assert.deepEqual(pinnedStrategies[0].edgeAddresses, ['198.41.192.7']);
assert.deepEqual(pinnedStrategies.map((strategy) => strategy.id), [
  'direct-http2-pinned-edge', 'direct-http2', 'system-http2-fallback'
]);
assert.equal(pinnedStrategies.at(-1).bypassProxy, false,
  'quick tunnels must finally retry with the system network when every direct attempt times out');
assert.equal(pinnedStrategies.at(-1).bindAddress, '');
assert.deepEqual(pinnedStrategies.at(-1).edgeAddresses, []);
assert.equal(_test.tunnelProbeLocalAddress({ bypassProxy: true, bindAddress: '192.168.110.188' }, true), '',
  'public URL verification must use the viewer route even when cloudflared is edge-bound');
assert.equal(_test.tunnelProbeLocalAddress({ bypassProxy: true, bindAddress: '' }, true), '',
  'an unbound attempt must verify through the active system route instead of forcing a physical adapter');
assert.equal(_test.tunnelProbeLocalAddress({ bypassProxy: false, bindAddress: '192.168.110.188' }, true), '');
assert.equal(_test.tunnelProbeTransport('192.168.110.188'), 'bound-native-https');
assert.equal(_test.tunnelProbeTransport('', {}), 'electron-system-network',
  'an unbound/system fallback probe must honor the operating-system proxy and TUN route');
assert.equal(_test.tunnelProbeTransport('', { HTTPS_PROXY: 'http://127.0.0.1:7890' }), 'environment-proxy',
  'an unbound/system fallback probe must honor the proxy inherited by cloudflared');
assert.deepEqual(_test.parseTunnelProbeResponse(200, JSON.stringify({ name: 'SyncWatch同步观影', version: 'v2.2.0' })), {
  ok: true, statusCode: 200
});
assert.equal(_test.parseTunnelProbeResponse(530, 'Cloudflare error code: 1033').cloudflareErrorCode, 1033);
assert.match(source, /undiciFetch\(url, \{ \.\.\.request, dispatcher \}\)/,
  'environment-proxy tunnel verification must use the explicit proxy dispatcher');
assert.match(source, /net\.fetch\(url, request\)/,
  'system-network tunnel verification must use Electron net.fetch so Windows proxy/PAC is honored');
assert.match(source, /strategy\.bypassProxy[^\n]+bypassProxy/,
  'each launch attempt must honor the strategy-specific proxy mode');
assert.match(source, /if \(!verified && index \+ 1 < strategies\.length\)[\s\S]*?terminateProcess\(tunnelProcess\)[\s\S]*?continue;/,
  'an unreachable public URL must advance to the next connection strategy instead of stalling');
assert.match(source, /!startupPreflight\.checks\.apiTcpPhysical\?\.ok && !startupPreflight\.checks\.edgeTcp\?\.ok[\s\S]*?strategies\.sort/,
  'when only the system route works, it must be attempted before known-dead physical routes');
assert.equal(_test.classifyTunnelFailure('TLS handshake with edge error: read tcp 198.18.0.1:1234->198.18.0.59:7844: i/o timeout').code, 'VPN_TUN_FAKE_IP');
assert.equal(_test.classifyTunnelFailure('dial tcp 203.0.113.8:7844: i/o timeout').code, 'EDGE_PORT_7844_BLOCKED');
const waitingForConnector = _test.applyTunnelHealthProbe(
  { state: 'verifying', publicUrl: '', verified: false },
  { ok: false, statusCode: 530, cloudflareErrorCode: 1033 }, 0,
  { processRunning: true, checkedAt: 1000, candidatePublicUrl: 'https://pending-address.trycloudflare.com' }
);
assert.equal(waitingForConnector.current.state, 'verifying');
assert.equal(waitingForConnector.current.publicUrl, '');
assert.match(waitingForConnector.current.error, /1033/);
const verifiedConnector = _test.applyTunnelHealthProbe(
  waitingForConnector.current, { ok: true, latencyMs: 72 }, waitingForConnector.healthFailures,
  { processRunning: true, checkedAt: 2000, candidatePublicUrl: 'https://pending-address.trycloudflare.com' }
);
assert.equal(verifiedConnector.current.state, 'running');
assert.equal(verifiedConnector.current.publicUrl, 'https://pending-address.trycloudflare.com');
assert.equal(verifiedConnector.current.verified, true);
const transientProbeFailure = _test.applyTunnelHealthProbe(
  verifiedConnector.current, { ok: false }, 0,
  { processRunning: true, checkedAt: 3000 }
);
assert.equal(transientProbeFailure.current.state, 'running');
assert.equal(transientProbeFailure.current.health, 'degraded');
assert.equal(transientProbeFailure.current.publicUrl, 'https://pending-address.trycloudflare.com');
assert.equal(transientProbeFailure.current.verified, true,
  '一次普通公网探测超时不能撤销已经验证的地址和 Socket 主机白名单');
const explicitCloudflareFailure = _test.applyTunnelHealthProbe(
  verifiedConnector.current, { ok: false, statusCode: 530, cloudflareErrorCode: 1033 }, 0,
  { processRunning: true, checkedAt: 4000 }
);
assert.equal(explicitCloudflareFailure.current.verified, false,
  'Cloudflare 1033/530 必须立即停止发布失效地址');
assert.match(explicitCloudflareFailure.current.error, /1033/);
assert.equal(_test.tunnelProbeNeedsConnectorRestart({ cloudflareErrorCode: 1033 }, 2), false);
assert.equal(_test.tunnelProbeNeedsConnectorRestart({ cloudflareErrorCode: 1033 }, 3), true);
assert.equal(_test.tunnelProbeNeedsConnectorRestart({ statusCode: 530 }, 8), false);
assert.match(source, /tunnelProbeNeedsConnectorRestart\(probe, healthFailures\)[\s\S]*?terminateProcess\(probeProcess\)/,
  '连续 1033 必须自动重建连接器，不能永久停留在验证中');
assert.match(source, /autoDiagnose: value\.autoDiagnose !== false/);
assert.match(source, /if \(autoDiagnose\)[\s\S]*?runTunnelPreflight\(\{ bypassProxy: Boolean\(bypassProxy\) \}\)/);
assert.match(rendererSource, /next\.health === 'degraded' \? ' · 公网探测波动，连接器仍在运行'/);
assert.match(rendererSource, /\['downloading', 'diagnosing', 'starting', 'verifying', 'reconnecting'\]\.includes\(next\.state\)/);
assert.match(rendererSource, /function renderTunnelProgress/);
assert.match(rendererSource, /预计剩余/);
assert.match(rendererSource, /next\.state === 'running' && next\.verified === true/);
assert.doesNotMatch(rendererSource.match(/async function startTunnel[\s\S]*?\n}/)?.[0] || '', /公网访问已开启/,
  'POST 返回 verifying 时不得提前提示公网已开启');
assert.match(source, /operationStartedAt/);

process.on('exit', () => {
  try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch (_) {}
});

console.log('Tunnel runtime, platform selection, archive verification, adapter filtering, and recovery contracts passed.');
