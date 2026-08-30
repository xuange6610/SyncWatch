'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const {
  normalizeReleaseTag,
  compareReleaseTags,
  extractAtomReleaseTag,
  createLatestReleaseChecker
} = require('../server/latest-release');
const {
  clientFacingAddressState,
  isPrivateWebOrigin
} = require('../server/client-address-privacy');

async function verifyLatestReleaseChecker() {
  assert.equal(normalizeReleaseTag('v2.2.4'), 'v2.2.4');
  assert.equal(normalizeReleaseTag('V2.2.4'), 'v2.2.4');
  assert.equal(normalizeReleaseTag('2.2.4'), '');
  assert.equal(normalizeReleaseTag('v2.2'), '');
  assert.equal(normalizeReleaseTag('v2.2.4-01'), '', 'SemVer 数字预发布标识不能含前导零');
  assert.equal(extractAtomReleaseTag(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>tag:github.com,2008:https://github.com/xuange6610/SyncWatch/releases</id><title>Release notes from SyncWatch</title><entry><id>tag:github.com,2008:Repository/1338151032/v2.2.9</id><link rel="alternate" href="https://github.com/xuange6610/SyncWatch/releases/tag/v2.2.9"/><title>SyncWatch同步观影 v2.2.9</title></entry></feed>`), 'v2.2.9');
  assert.equal(extractAtomReleaseTag('<feed><entry><title>没有版本</title></entry></feed>'), '');
  assert.equal(compareReleaseTags('v2.2.3', 'v2.2.4'), -1);
  assert.equal(compareReleaseTags('v2.2.4', 'v2.2.4'), 0);
  assert.equal(compareReleaseTags('v2.10.0', 'v2.9.9'), 1);
  assert.equal(compareReleaseTags('v2.2.4-beta.2', 'v2.2.4-beta.10'), -1);
  assert.equal(compareReleaseTags('v2.2.4', 'v2.2.4-beta.10'), 1);

  let now = 1_000;
  let requests = 0;
  const headers = [];
  const responses = [
    new Response(JSON.stringify({
      tag_name: 'v2.2.4', name: 'SyncWatch v2.2.4', draft: false, prerelease: false,
      html_url: 'https://github.com/xuange6610/SyncWatch/releases/tag/v2.2.4'
    }), { status: 200, headers: { 'content-type': 'application/json', etag: '"release-224"' } }),
    new Response(null, { status: 304, headers: { etag: '"release-224"' } })
  ];
  const checker = createLatestReleaseChecker({
    now: () => now,
    cacheTtlMs: 5_000,
    timeoutMs: 100,
    fetchImpl: async (_url, options) => {
      requests += 1;
      headers.push(options.headers);
      return responses.shift();
    }
  });

  const network = await checker.check();
  assert.deepEqual({
    success: network.success, tag: network.tag_name, source: network.source,
    cached: network.cached, stale: network.stale
  }, { success: true, tag: 'v2.2.4', source: 'network', cached: false, stale: false });
  assert.equal(requests, 1);
  assert.equal(headers[0]['Cache-Control'], 'no-cache');

  now += 2_000;
  const freshCache = await checker.check();
  assert.deepEqual({ source: freshCache.source, cached: freshCache.cached, stale: freshCache.stale },
    { source: 'fresh-cache', cached: true, stale: false });
  assert.equal(requests, 1);

  now += 5_000;
  const revalidated = await checker.check();
  assert.deepEqual({ source: revalidated.source, cached: revalidated.cached, stale: revalidated.stale },
    { source: 'revalidated-cache', cached: true, stale: false });
  assert.equal(headers[1]['If-None-Match'], '"release-224"');

  now += 6_000;
  const staleChecker = createLatestReleaseChecker({
    now: () => now,
    cacheTtlMs: 1,
    timeoutMs: 10,
    initialCache: checker.snapshot(),
    fetchImpl: async () => { throw Object.assign(new Error('offline'), { code: 'ENETUNREACH' }); }
  });
  const stale = await staleChecker.check();
  assert.deepEqual({ success: stale.success, source: stale.source, stale: stale.stale, code: stale.warningCode },
    { success: true, source: 'stale-cache', stale: true, code: 'GITHUB_NETWORK_ERROR' });

  const offlineChecker = createLatestReleaseChecker({
    timeoutMs: 10,
    fetchImpl: async () => { throw Object.assign(new Error('offline'), { code: 'ENETUNREACH' }); }
  });
  const offline = await offlineChecker.check();
  assert.deepEqual({ success: offline.success, cached: offline.cached, code: offline.code, networkFailure: offline.networkFailure },
    { success: false, cached: false, code: 'GITHUB_NETWORK_ERROR', networkFailure: true });

  const invalidChecker = createLatestReleaseChecker({
    fetchImpl: async () => new Response(JSON.stringify({ tag_name: '2.2.4' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  });
  const invalid = await invalidChecker.check();
  assert.equal(invalid.success, false);
  assert.equal(invalid.code, 'GITHUB_INVALID_RELEASE');
  assert.equal(invalid.networkFailure, false);

  const fallbackRequests = [];
  const fallbackChecker = createLatestReleaseChecker({
    cacheTtlMs: 1,
    fetchImpl: async (url) => {
      fallbackRequests.push(String(url));
      if (String(url).includes('/releases/latest')) return new Response('rate limited', { status: 403 });
      return new Response('<feed><entry><id>tag:github.com,2008:Repository/1/v2.2.9</id><title>v2.2.9</title></entry></feed>', { status: 200 });
    }
  });
  const fallback = await fallbackChecker.check({ forceRefresh: true });
  assert.equal(fallback.success, true);
  assert.equal(fallback.tag_name, 'v2.2.9');
  assert.equal(fallback.source, 'atom-fallback');
  assert.equal(fallbackRequests.length, 2);
}

function verifyAddressPrivacy() {
  assert.equal(isPrivateWebOrigin('http://192.168.1.5:5000'), true);
  assert.equal(isPrivateWebOrigin('http://127.0.0.1:5000'), true);
  assert.equal(isPrivateWebOrigin('https://watch.example.com'), false);

  const tunnelClient = clientFacingAddressState({
    runtimeRole: 'client',
    currentOrigin: 'https://new.trycloudflare.com/room',
    configuredPublicAddress: 'https://old.example.com',
    lanAddresses: ['http://192.168.1.5:5000', 'http://10.0.0.8:5000']
  });
  assert.deepEqual(tunnelClient, {
    statusAddress: '', shareAddress: 'https://new.trycloudflare.com',
    addresses: ['https://new.trycloudflare.com'], public: true
  });

  const configuredPublicClient = clientFacingAddressState({
    runtimeRole: 'client', currentOrigin: 'http://192.168.1.9:5000',
    configuredPublicAddress: 'https://watch.example.com',
    lanAddresses: ['http://192.168.1.5:5000']
  });
  assert.equal(configuredPublicClient.shareAddress, 'https://watch.example.com');
  assert.deepEqual(configuredPublicClient.addresses, ['https://watch.example.com']);
  assert.equal(configuredPublicClient.statusAddress, '');

  const lanClient = clientFacingAddressState({
    runtimeRole: 'client', currentOrigin: 'http://192.168.1.9:5000',
    configuredPublicAddress: '', lanAddresses: ['http://192.168.1.5:5000']
  });
  assert.deepEqual(lanClient, { statusAddress: '', shareAddress: '', addresses: [], public: false },
    '普通客户端没有可信公网根地址时必须 fail closed，不能回退内网 IP');

  const serverApp = clientFacingAddressState({
    runtimeRole: 'server', currentOrigin: 'http://127.0.0.1:5000',
    configuredPublicAddress: 'https://watch.example.com',
    lanAddresses: ['http://192.168.1.5:5000', 'http://10.0.0.8:5000']
  });
  assert.equal(serverApp.statusAddress, 'http://192.168.1.5:5000');
  assert.equal(serverApp.shareAddress, 'https://watch.example.com');
  assert.deepEqual(serverApp.addresses, ['http://192.168.1.5:5000', 'http://10.0.0.8:5000']);
}

function verifyRuntimeMarkers() {
  const serverPreload = read('electron-main-preload.js');
  const clientPreload = read('electron-client-preload.js');
  const android = read('mobile/app/src/main/java/com/xuan/syncwatch/MainActivity.java');

  const exposePreload = (source) => {
    const exposed = {};
    const ipcRenderer = { invoke() {}, on() {}, send() {}, removeListener() {} };
    vm.runInNewContext(source, {
      require(name) {
        assert.equal(name, 'electron');
        return { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } }, ipcRenderer };
      },
      Object, String, Boolean, Promise
    });
    return exposed;
  };

  assert.match(serverPreload, /exposeInMainWorld\(['"]SyncWatchPlatform['"],\s*Object\.freeze\(\{[\s\S]*runtime:\s*['"]electron['"][\s\S]*role:\s*['"]server['"][\s\S]*serverApp:\s*true[\s\S]*clientApp:\s*false/);
  assert.match(clientPreload, /exposeInMainWorld\(['"]SyncWatchPlatform['"],\s*Object\.freeze\(\{[\s\S]*runtime:\s*['"]electron['"][\s\S]*role:\s*['"]client['"][\s\S]*serverApp:\s*false[\s\S]*clientApp:\s*true/);
  const serverBridge = exposePreload(serverPreload);
  const clientBridge = exposePreload(clientPreload);
  assert.deepEqual(JSON.parse(JSON.stringify(serverBridge.SyncWatchPlatform)), {
    version: 1, runtime: 'electron', role: 'server', serverApp: true, clientApp: false
  });
  assert.deepEqual(JSON.parse(JSON.stringify(clientBridge.SyncWatchPlatform)), {
    version: 1, runtime: 'electron', role: 'client', serverApp: false, clientApp: true
  });
  assert.equal(typeof serverBridge.SyncWatchDesktop.writeClipboardText, 'function');
  assert.equal(typeof clientBridge.SyncWatchClient.writeClipboardText, 'function');
  assert.equal(Object.isFrozen(serverBridge.SyncWatchPlatform), true);
  assert.equal(Object.isFrozen(clientBridge.SyncWatchPlatform), true);
  assert.match(android, /runtime:\\\"android\\\",role:\\\"client\\\",serverApp:false,clientApp:true/);
  assert.match(android, /localServerMode:/,
    'Android marker must keep embedded local-server capability separate from the client UI role');
}

(async () => {
  await verifyLatestReleaseChecker();
  verifyAddressPrivacy();
  verifyRuntimeMarkers();
  console.log('platform address privacy, runtime markers and latest-release checks passed.');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
