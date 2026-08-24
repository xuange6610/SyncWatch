'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { createStandaloneTunnelManager, extractPublicUrl, connectorRegistered, sanitizeEnvironment, requestPublicConfig, connectionStrategies } = require('../server/standalone-tunnel');
const standaloneSource = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'standalone-tunnel.js'), 'utf8');
assert.match(standaloneSource, /state: 'verifying', verificationStartedAt: Date\.now\(\)/);
assert.match(standaloneSource, /operationStartedAt/);
assert.match(standaloneSource, /attempt: attempt \+ 1, maxAttempts:/);
const { cloudflaredRuntime, ensureCloudflaredBinary } = require('../server/cloudflared-installer');

assert.equal(extractPublicUrl('INF https://api.trycloudflare.com/provision https://bright-river-123.trycloudflare.com'), 'https://bright-river-123.trycloudflare.com');
assert.equal(extractPublicUrl('https://api.trycloudflare.com'), '');
assert.equal(connectorRegistered('Registered tunnel connection connIndex=0'), true);
assert.equal(connectorRegistered('quick tunnel created'), false);
const fallbackStrategies = connectionStrategies({ mode: 'quick', bypassProxy: true }, {
  physicalIpv4: '192.168.1.20', edgeAddresses: ['198.41.192.7']
});
assert.deepEqual(fallbackStrategies.map((strategy) => strategy.id), [
  'direct-http2-pinned-edge', 'direct-http2', 'direct-auto', 'system-http2-fallback'
]);
assert.equal(fallbackStrategies.at(-1).bypassProxy, false);
assert.equal(fallbackStrategies.at(-1).bindAddress, '');

const originalProxy = process.env.HTTP_PROXY;
process.env.HTTP_PROXY = 'http://proxy.invalid:8080';
const directEnvironment = sanitizeEnvironment(true);
assert.equal(directEnvironment.HTTP_PROXY, undefined);
assert.equal(directEnvironment.NO_PROXY, '*');
const systemEnvironment = sanitizeEnvironment(false);
assert.equal(systemEnvironment.HTTP_PROXY, 'http://proxy.invalid:8080');
if (originalProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = originalProxy;

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-standalone-tunnel-'));
  const probeServer = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ success: true }));
  });
  try {
    await new Promise((resolve, reject) => {
      probeServer.once('error', reject);
      probeServer.listen(0, '127.0.0.1', resolve);
    });
    const probePort = probeServer.address().port;
    const boundProbe = await requestPublicConfig(`http://127.0.0.1:${probePort}`, 2000, { localAddress: '127.0.0.1' });
    assert.equal(boundProbe.ok, true, boundProbe.error);
    const manager = createStandaloneTunnelManager({ rootDir: dataDir, dataDir, getPort: () => 5000 });
    const initial = await manager.status();
    assert.equal(initial.state, 'stopped');
    const saved = await manager.saveStartupSettings({ autoStartTunnel: false, bypassProxy: false });
    assert.equal(saved.bypassProxy, false);
    const unchanged = await manager.saveStartupSettings({ autoStartTunnel: false });
    assert.equal(unchanged.bypassProxy, false, 'omitted bypass setting should not silently toggle the proxy mode');
    const startup = await manager.startupSettings();
    assert.equal(startup.bypassProxy, false);

    const installerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-cloudflared-installer-'));
    const payload = Buffer.alloc(1024 * 1024 + 17, 0x51);
    const digest = require('crypto').createHash('sha256').update(payload).digest('hex');
    const runtime = cloudflaredRuntime('win32', 'x64');
    let requestCount = 0;
    const fakeFetch = async (url) => {
      requestCount += 1;
      if (String(url).includes('/releases/latest')) {
        return new Response(JSON.stringify({
          tag_name: 'test-release',
          assets: [{
            name: runtime.assetName, size: payload.length, digest: `sha256:${digest}`,
            browser_download_url: `https://downloads.example.test/${runtime.assetName}`
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(payload, { status: 200 });
    };
    try {
      const installed = await ensureCloudflaredBinary({
        dataDir: installerRoot, platform: 'win32', arch: 'x64', fetchImpl: fakeFetch
      });
      assert.equal(path.basename(installed), 'cloudflared.exe');
      assert.deepEqual(fs.readFileSync(installed), payload);
      assert.equal(requestCount, 2);
      const cached = await ensureCloudflaredBinary({
        dataDir: installerRoot, platform: 'win32', arch: 'x64',
        fetchImpl: async () => { throw new Error('verified cache should be reused'); }
      });
      assert.equal(cached, installed);
      assert.equal(requestCount, 2);
    } finally {
      fs.rmSync(installerRoot, { recursive: true, force: true });
    }
    console.log('standalone tunnel supervisor contract passed.');
  } finally {
    await new Promise((resolve) => probeServer.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
