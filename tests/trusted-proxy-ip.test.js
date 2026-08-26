'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startSyncWatchServer, _test } = require('../server');

const {
  createTrustedProxyMatcher,
  normalizeTrustedProxyEntries,
  resolveClientIp
} = _test;

const trusted = createTrustedProxyMatcher([
  '127.0.0.1',
  '192.168.110.198',
  '172.18.0.0/16',
  '2001:db8:1::/48'
]);

assert.deepEqual(
  normalizeTrustedProxyEntries('127.0.0.1, 172.18.0.0/16\ninvalid, 203.0.113.7/33, 0.0.0.0/0, ::/0'),
  ['127.0.0.1', '172.18.0.0/16']
);

const wildcard = createTrustedProxyMatcher(['0.0.0.0/0', '::/0']);
assert.equal(wildcard('198.51.100.90'), false, 'an IPv4 wildcard CIDR must fail closed');
assert.equal(wildcard('2001:db8::90'), false, 'an IPv6 wildcard CIDR must fail closed');

assert.equal(
  resolveClientIp('10.0.0.24', { 'x-forwarded-for': '198.51.100.20' }, trusted),
  '10.0.0.24',
  'an arbitrary private/LAN peer must not be able to spoof its source IP'
);

assert.equal(
  resolveClientIp('192.168.110.198', { 'x-forwarded-for': '198.51.100.21' }, trusted),
  '198.51.100.21',
  'the server own LAN address may be a local tunnel peer'
);

assert.equal(
  resolveClientIp('127.0.0.1', { 'x-forwarded-for': '198.51.100.22, 172.18.3.4' }, trusted),
  '198.51.100.22',
  'trusted proxy hops must be removed from right to left'
);

assert.equal(
  resolveClientIp('127.0.0.1', { 'x-forwarded-for': '192.0.2.250, 198.51.100.23' }, trusted),
  '198.51.100.23',
  'an attacker-controlled leftmost XFF value must not replace the first untrusted hop'
);

assert.equal(
  resolveClientIp('127.0.0.1', {
    'cf-connecting-ip': '198.51.100.24',
    'x-forwarded-for': '198.51.100.25'
  }, trusted),
  '198.51.100.25',
  'a valid trusted XFF chain takes precedence over single-hop compatibility headers'
);

assert.equal(
  resolveClientIp('127.0.0.1', { 'cf-connecting-ip': '198.51.100.24' }, trusted),
  '198.51.100.24',
  'CF-Connecting-IP is accepted only from a trusted direct peer'
);

assert.equal(
  resolveClientIp('203.0.113.90', { 'cf-connecting-ip': '198.51.100.24' }, trusted),
  '203.0.113.90',
  'CF-Connecting-IP from an untrusted direct peer must be ignored'
);

assert.equal(
  resolveClientIp('2001:db8:1::7', { 'x-forwarded-for': '2001:db8:2::8' }, trusted),
  '2001:db8:2::8',
  'explicit IPv6 proxy CIDRs must be supported'
);

function connect(baseUrl, extraHeaders) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      transports: ['websocket'], forceNew: true, reconnection: false, timeout: 10000, extraHeaders
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Socket.IO connection timed out'));
    }, 10000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

function ack(socket, event, payload = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeout);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-trusted-proxy-'));
  const publicDir = path.resolve(__dirname, '..', 'public');
  const sourceIp = '198.51.100.88';
  const proxyHeaders = { 'x-forwarded-for': sourceIp };
  let server;
  let socket;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, ffprobePath: '', ffmpegPath: ''
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${baseUrl}/api/public-config`, { headers: proxyHeaders });
    assert.equal(response.status, 200);
    const publicConfig = await response.json();
    assert.equal(publicConfig.clientIp, sourceIp, 'HTTP must resolve the trusted proxy source IP');

    socket = await connect(baseUrl, proxyHeaders);
    const login = await ack(socket, 'guest-login', {
      deviceId: 'trusted-proxy-runtime-device', deviceName: '可信代理运行态测试'
    });
    assert.equal(login.success, true, login.error);
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(persisted.accounts[login.user.username].registrationIp, publicConfig.clientIp,
      'Socket.IO login and HTTP public-config must use the same resolved source IP');
    assert.equal(persisted.accounts[login.user.username].loginHistory[0].ip, publicConfig.clientIp,
      'the Socket.IO session audit trail must retain the shared resolved source IP');

    console.log('trusted proxy client IP regression passed');
  } finally {
    socket?.close();
    await server?.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
