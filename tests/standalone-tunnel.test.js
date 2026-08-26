'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createStandaloneTunnelManager, extractPublicUrl, connectorRegistered, sanitizeEnvironment, requestTunnelHealth, connectionStrategies } = require('../server/standalone-tunnel');
const standaloneSource = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'standalone-tunnel.js'), 'utf8');
const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'index.js'), 'utf8');
assert.match(standaloneSource, /state: 'verifying', verificationStartedAt: Date\.now\(\)/);
assert.match(standaloneSource, /operationStartedAt/);
assert.match(standaloneSource, /attempt: attempt \+ 1, maxAttempts:/);
const tunnelHealthRoute = serverSource.match(/app\.get\('\/api\/tunnel-health'[\s\S]*?\n\s*\}\);/)?.[0] || '';
assert.match(tunnelHealthRoute, /name:\s*'SyncWatch同步观影'/);
assert.match(tunnelHealthRoute, /version:\s*APP_VERSION/);
assert.doesNotMatch(tunnelHealthRoute, /uiCopy|public-config/,
  'Tunnel health responses must stay fixed-size and independent of custom UI copy');
const { cloudflaredRuntime, ensureCloudflaredBinary } = require('../server/cloudflared-installer');

async function settleWithin(promise, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ hung: true }), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

assert.equal(extractPublicUrl('INF https://api.trycloudflare.com/provision https://bright-river-123.trycloudflare.com'), 'https://bright-river-123.trycloudflare.com');
assert.equal(extractPublicUrl('https://api.trycloudflare.com'), '');
assert.equal(connectorRegistered('Registered tunnel connection connIndex=0'), true);
assert.equal(connectorRegistered('quick tunnel created'), false);
const fallbackStrategies = connectionStrategies({ mode: 'quick', bypassProxy: true }, {
  physicalIpv4: '192.168.1.20', edgeAddresses: ['198.41.192.7']
});
assert.deepEqual(fallbackStrategies.map((strategy) => strategy.id), [
  'direct-auto-pinned-edge', 'direct-auto', 'direct-http2', 'system-auto-fallback'
]);
assert.ok(fallbackStrategies.every((strategy, index) => index === 2 || strategy.protocol === 'auto'),
  'Quick Tunnel should prefer automatic QUIC/HTTP2 selection and retain explicit HTTP2 as a fallback');
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
  let responseMode = 'healthy';
  let proxyResponseMode = 'healthy';
  let requestedPath = '';
  const probeServer = http.createServer((request, response) => {
    requestedPath = request.url;
    response.setHeader('Content-Type', 'application/json');
    if (responseMode === 'oversized') {
      for (let index = 0; index < 32; index += 1) response.write(Buffer.alloc(1024, 0x61));
      return;
    }
    if (responseMode === 'aborted') {
      response.write('{"name":');
      response.destroy();
      return;
    }
    if (responseMode === 'stalled') {
      response.write('{"name":');
      return;
    }
    response.end(JSON.stringify({ name: 'SyncWatch同步观影', version: 'v2.2.2' }));
  });
  const proxyServer = http.createServer((request, response) => {
    proxyServer.requestCount += 1;
    proxyServer.lastUrl = request.url;
    response.setHeader('Content-Type', 'application/json');
    if (proxyResponseMode === 'oversized') {
      for (let index = 0; index < 32; index += 1) response.write(Buffer.alloc(1024, 0x61));
      return;
    }
    response.end(JSON.stringify({ name: 'SyncWatch同步观影', version: 'v2.2.2' }));
  });
  proxyServer.requestCount = 0;
  proxyServer.lastUrl = '';
  try {
    await Promise.all([probeServer, proxyServer].map((server) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    })));
    const probePort = probeServer.address().port;
    const boundProbe = await requestTunnelHealth(`http://127.0.0.1:${probePort}`, 2000, { localAddress: '127.0.0.1' });
    assert.equal(boundProbe.ok, true, boundProbe.error);
    assert.equal(requestedPath, '/api/tunnel-health');

    responseMode = 'oversized';
    const oversizedStartedAt = Date.now();
    const oversizedProbe = await settleWithin(
      requestTunnelHealth(`http://127.0.0.1:${probePort}`, 2000, { localAddress: '127.0.0.1' })
    );
    assert.equal(oversizedProbe.hung, undefined, 'an oversized chunked response must settle instead of hanging');
    assert.equal(oversizedProbe.ok, false);
    assert.ok(Date.now() - oversizedStartedAt < 1000);

    responseMode = 'aborted';
    const abortedProbe = await settleWithin(
      requestTunnelHealth(`http://127.0.0.1:${probePort}`, 2000, { localAddress: '127.0.0.1' })
    );
    assert.equal(abortedProbe.hung, undefined, 'an aborted response must settle instead of hanging');
    assert.equal(abortedProbe.ok, false);

    responseMode = 'stalled';
    const timedOutProbe = await settleWithin(
      requestTunnelHealth(`http://127.0.0.1:${probePort}`, 100, { localAddress: '127.0.0.1' })
    );
    assert.equal(timedOutProbe.hung, undefined, 'a stalled response must settle when the request times out');
    assert.equal(timedOutProbe.ok, false);
    responseMode = 'healthy';

    const proxyPort = proxyServer.address().port;
    const proxyEnvironment = {
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: ''
    };
    const proxyProbe = await requestTunnelHealth('http://proxy-only.invalid:65530', 2000, {
      useSystemProxy: true, environment: proxyEnvironment
    });
    assert.equal(proxyProbe.ok, true, proxyProbe.error);
    assert.match(proxyServer.lastUrl, /^http:\/\/proxy-only\.invalid:65530\/api\/tunnel-health$/);

    proxyResponseMode = 'oversized';
    const oversizedProxyProbe = await settleWithin(requestTunnelHealth(
      'http://proxy-only.invalid:65530', 2000, { useSystemProxy: true, environment: proxyEnvironment }
    ));
    assert.equal(oversizedProxyProbe.hung, undefined,
      'an oversized response received through the system proxy must settle instead of hanging');
    assert.equal(oversizedProxyProbe.ok, false);
    proxyResponseMode = 'healthy';

    const binaryName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const vendorDir = path.join(dataDir, 'vendor');
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(path.join(vendorDir, binaryName), Buffer.alloc(1024 * 1024 + 1, 0x51));
    const spawnProcess = (_binary, _args, options) => {
      const processHandle = new EventEmitter();
      processHandle.stdout = new PassThrough();
      processHandle.stderr = new PassThrough();
      processHandle.exitCode = null;
      processHandle.signalCode = null;
      processHandle.kill = () => {
        if (processHandle.exitCode !== null) return false;
        processHandle.exitCode = 0;
        setImmediate(() => processHandle.emit('exit', 0, null));
        return true;
      };
      setImmediate(() => {
        if (options.env.NO_PROXY === '*') {
          processHandle.emit('error', new Error('direct route blocked'));
          return;
        }
        processHandle.stderr.write([
          'INF Your quick Tunnel has been created! Visit it at https://proxy-only-test.trycloudflare.com',
          'INF Registered tunnel connection connIndex=0'
        ].join('\n'));
      });
      return processHandle;
    };
    const manager = createStandaloneTunnelManager({
      rootDir: dataDir, dataDir, getPort: () => 5000, spawnProcess,
      requestTunnelHealthImpl: (_url, timeoutMs, options) => requestTunnelHealth(
        'http://proxy-only.invalid:65530', timeoutMs, options
      )
    });
    const initial = await manager.status();
    assert.equal(initial.state, 'stopped');
    const saved = await manager.saveStartupSettings({ autoStartTunnel: false, bypassProxy: false });
    assert.equal(saved.bypassProxy, false);
    const unchanged = await manager.saveStartupSettings({ autoStartTunnel: false });
    assert.equal(unchanged.bypassProxy, false, 'omitted bypass setting should not silently toggle the proxy mode');
    const startup = await manager.startupSettings();
    assert.equal(startup.bypassProxy, false);

    const processProxyEnvironment = process.platform === 'win32' ? proxyEnvironment : {
      ...proxyEnvironment,
      http_proxy: proxyEnvironment.HTTP_PROXY,
      https_proxy: proxyEnvironment.HTTPS_PROXY,
      no_proxy: proxyEnvironment.NO_PROXY
    };
    const savedProxyValues = Object.fromEntries(
      Object.keys(processProxyEnvironment).map((key) => [key, process.env[key]])
    );
    Object.assign(process.env, processProxyEnvironment);
    try {
      const running = await manager.start({ mode: 'quick', bypassProxy: true, autoDiagnose: false });
      assert.equal(running.state, 'running');
      assert.equal(running.strategy, 'system-auto-fallback');
      assert.equal(running.activeNetworkMode, 'system');
      assert.equal(running.bypassProxy, false,
        'status must report the winning strategy rather than the originally requested direct mode');
      await manager.stop();
    } finally {
      for (const [key, value] of Object.entries(savedProxyValues)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }

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
    await Promise.all([probeServer, proxyServer].map((server) => new Promise((resolve) => server.close(resolve))));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
