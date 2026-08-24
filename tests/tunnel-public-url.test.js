'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

function ack(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 10000);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result); });
  });
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timed out')), 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-tunnel-public-url-'));
  let server; let socket;
  let tunnelState = { state: 'stopped', publicUrl: '' };
  let startupSettings = { autoStartTunnel: false, mode: 'quick', publicUrl: '', bypassProxy: true, autoDiagnose: true };
  let lastStartOptions = null;
  const tunnelManager = {
    status: async () => ({ ...tunnelState }),
    startupSettings: async () => ({ ...startupSettings }),
    saveStartupSettings: async (input = {}) => (startupSettings = { ...startupSettings, ...input }),
    start: async (options = {}) => {
      lastStartOptions = { ...options };
      return (tunnelState = { state: 'running', publicUrl: 'https://new-address.trycloudflare.com', verified: true, bypassProxy: options.bypassProxy });
    },
    stop: async () => (tunnelState = { state: 'stopped', publicUrl: '' })
  };
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir: root, discovery: false,
      publicDir: path.resolve(__dirname, '..', 'public'), hostControlToken: 'stale-url-host', tunnelManager,
      publicUrl: 'https://configured.example.com'
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    socket = await connect(baseUrl);
    const login = await ack(socket, 'host-admin-login', { adminPassword: 'admin888', hostToken: 'stale-url-host' });
    assert.equal(login.success, true, login.error);
    if (login.capabilities?.agreementRequired) {
      const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: login.agreement.version });
      assert.equal(accepted.success, true, accepted.error);
    }

    const configuredConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(configuredConfig.publicAddress, 'https://configured.example.com',
      '没有活动 Tunnel 时应使用已配置的公网根地址');

    const startResponse = await fetch(`${baseUrl}/api/host/tunnel/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'quick', bypassProxy: false, confirmUnprotectedRooms: true })
    });
    const started = await startResponse.json();
    assert.equal(startResponse.status, 200, started.error);
    assert.equal(lastStartOptions.bypassProxy, false);
    const persistedStartup = await (await fetch(`${baseUrl}/api/host/tunnel/startup`, {
      headers: { Authorization: `Bearer ${login.token}` }
    })).json();
    assert.equal(persistedStartup.settings.bypassProxy, false,
      'starting cloudflared must persist the unchecked proxy-bypass preference');

    tunnelState = { state: 'running', publicUrl: 'https://old-address.trycloudflare.com', verified: true };
    let config = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(config.publicAddress, tunnelState.publicUrl);

    tunnelState = { state: 'running', publicUrl: 'https://old-address.trycloudflare.com', verified: true, health: 'degraded' };
    config = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(config.publicAddress, tunnelState.publicUrl,
      '瞬时探测波动不能撤销已经验证且进程仍在运行的公网地址');

    // The public endpoint must refresh tunnel state itself. A running process
    // without a successful probe is not yet safe to advertise or share.
    tunnelState = { state: 'running', publicUrl: 'https://unverified-running.trycloudflare.com' };
    config = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(config.publicAddress, 'https://configured.example.com');

    // A reconnecting Quick Tunnel has no usable address. The previous URL must
    // be removed from allowed hosts and sharing must fall back to the configured origin.
    tunnelState = { state: 'reconnecting', publicUrl: '' };
    config = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(config.publicAddress, 'https://configured.example.com');

    tunnelState = { state: 'error', publicUrl: 'https://stale-address.trycloudflare.com', verified: false };
    config = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(config.publicAddress, 'https://configured.example.com');

    tunnelState = { state: 'verifying', publicUrl: 'https://unverified-address.trycloudflare.com', verified: false };
    config = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(config.publicAddress, 'https://configured.example.com');

    tunnelState = { state: 'running', publicUrl: 'https://new-address.trycloudflare.com', verified: true };
    config = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(config.publicAddress, tunnelState.publicUrl);
    console.log('Tunnel public URL lifecycle removes stale Quick Tunnel addresses and publishes only verified running state.');
  } finally {
    socket?.disconnect();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
