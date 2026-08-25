'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { io } = require('socket.io-client');
const policy = require('../public/js/network-quality-policy');
const { startSyncWatchServer, _test } = require('../server');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section ${start}`);
  return source.slice(from, to);
}

function ack(socket, event, payload = {}, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeout);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result || { success: false, error: 'server returned no result' });
    });
  });
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket.IO connection timed out')), 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

async function acceptAgreement(socket, result) {
  if (!result.success || !result.capabilities?.agreementRequired) return result;
  const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: result.agreement.version });
  assert.equal(accepted.success, true, accepted.error);
  return { ...result, capabilities: { ...result.capabilities, agreementRequired: false } };
}

function testClientPolicy() {
  assert.equal(policy.HIGH_LATENCY_MS, 500);
  assert.equal(policy.DEGRADE_AFTER, 3);
  assert.equal(policy.RECOVER_AFTER, 2);

  let tracker = policy.createTracker();
  assert.equal(tracker.observe({ latencyMs: 1800 }).state, 'online', 'one latency spike must not degrade');
  assert.equal(tracker.observe({ latencyMs: 40, buffering: true }).state, 'online',
    'player buffering must not be treated as a control-channel failure');
  assert.equal(tracker.snapshot().consecutiveAbnormal, 0, 'a healthy probe must clear an isolated spike');

  tracker = policy.createTracker();
  assert.equal(tracker.observe({ latencyMs: 900 }).state, 'online');
  assert.equal(tracker.observe({ latencyMs: 1100 }).state, 'online');
  let result = tracker.observe({ latencyMs: 850 });
  assert.equal(result.state, 'unstable', 'three consecutive high RTT probes must degrade');
  assert.equal(result.changed, true);
  assert.equal(tracker.observe({ latencyMs: 45 }).state, 'unstable', 'one healthy probe must not flap back online');
  result = tracker.observe({ latencyMs: 55 });
  assert.equal(result.state, 'online', 'two consecutive healthy probes must recover');
  assert.equal(result.changed, true);

  tracker = policy.createTracker();
  assert.equal(tracker.observe({ timedOut: true }).state, 'online', 'one timeout must not degrade');
  assert.equal(tracker.observe({ timedOut: true }).state, 'online');
  assert.equal(tracker.observe({ timedOut: true }).state, 'unstable');

  assert.deepEqual(policy.roomStatus({
    authenticated: true, socketConnected: true, socketAuthenticated: true,
    members: [{ connectionState: 'reconnecting' }]
  }), { state: 'healthy', label: '同步正常', healthy: true },
  'a reconnecting member must not be mislabeled as room-wide network jitter');
  assert.deepEqual(policy.roomStatus({
    authenticated: true, socketConnected: true, socketAuthenticated: true,
    members: [{ connectionState: 'unstable' }]
  }), { state: 'unstable', label: '网络波动', healthy: false });
  assert.deepEqual(policy.roomStatus({
    authenticated: true, socketConnected: true, socketAuthenticated: true,
    localConnectionState: 'unstable', members: [{ connectionState: 'online' }]
  }), { state: 'unstable', label: '网络波动', healthy: false },
  'a half-open client must show its own sustained probe failure without waiting for server echo');
  assert.deepEqual(policy.roomStatus({
    authenticated: true, socketConnected: false, socketAuthenticated: false, members: []
  }), { state: 'disconnected', label: '连接中断', healthy: false },
  'a real local socket disconnect must remain explicit');
}

function testServerPolicy() {
  assert.equal(typeof _test.applyNetworkQualitySample, 'function');
  const user = { connectionState: 'online' };

  let result = _test.applyNetworkQualitySample(user, {
    sequence: 1, latency: 20, connectionState: 'unstable'
  });
  assert.equal(result.connectionState, 'online', 'one legacy unstable flag cannot directly poison presence');
  assert.equal(user.connectionState, 'online');

  result = _test.applyNetworkQualitySample(user, { sequence: 3, latency: 900, syncPercent: 92, sampleStatus: 'high-latency' });
  assert.equal(result.connectionState, 'online');
  result = _test.applyNetworkQualitySample(user, { sequence: 2, latency: 25, syncPercent: 5, sampleStatus: 'healthy' });
  assert.equal(result.ignored, true, 'out-of-order probe results must be ignored');
  assert.equal(user.connectionState, 'online');
  assert.equal(user.latency, 900, 'an old probe cannot overwrite the latest latency');
  assert.equal(user.syncPercent, 92, 'an old probe cannot overwrite the latest sync metric');
  _test.applyNetworkQualitySample(user, { sequence: 4, latency: 920, sampleStatus: 'high-latency' });
  result = _test.applyNetworkQualitySample(user, { sequence: 5, latency: 940, sampleStatus: 'high-latency' });
  assert.equal(result.connectionState, 'unstable');
  assert.equal(_test.applyNetworkQualitySample(user, { sequence: 6, latency: 45, sampleStatus: 'healthy' }).connectionState, 'unstable');
  assert.equal(_test.applyNetworkQualitySample(user, { sequence: 7, latency: 50, sampleStatus: 'healthy' }).connectionState, 'online');
}

function testSourceContracts() {
  assert.match(pageSource, /js\/network-quality-policy\.js[\s\S]*js\/app\.js/,
    'network quality policy must load before the application');
  assert.match(appSource, /networkProbe:\s*\{[^}]*inFlightSequence:\s*0[^}]*connectionEpoch:\s*0/s);
  const measureSource = section(appSource, 'async function measureNetwork()', 'function recoverFromBackground()');
  assert.match(measureSource, /if \(probe\.inFlightSequence\) return/,
    'the four-second timer must not overlap a five-second probe');
  assert.match(measureSource, /const sequence = \+\+probe\.sequence/);
  assert.match(measureSource, /connectionEpoch !== probe\.connectionEpoch/,
    'a result from an earlier socket connection must not update the new connection');
  assert.match(measureSource, /sequence !== probe\.inFlightSequence/,
    'an older result must not clear or overwrite a newer in-flight probe');
  assert.match(appSource, /sampleStatus:\s*observation\.sampleStatus/);
  assert.match(appSource, /socket\.volatile\.emit\('network-quality'/,
    'stale network quality telemetry must not be replayed after reconnect');
  assert.match(appSource, /state\.networkProbe\.localConnectionState = observation\.state;\s*updateRoomHeader\(\);\s*renderUsers\(\)/,
    'local degraded/recovered state must update the UI before attempting the potentially damaged uplink');
  assert.match(appSource, /function clearSession\(\) \{\s*resetNetworkQualityTracking\(\)/,
    'logging into another account on the same socket must not inherit the previous quality streak');

  const bufferingSource = section(appSource, 'function handleMediaBuffering()', 'function handleMediaBufferRecovered()');
  assert.doesNotMatch(bufferingSource, /network-quality|observeNetworkQuality/,
    'HTMLMediaElement buffering must stay separate from control-channel quality');
  const headerSource = section(appSource, 'function updateRoomHeader()', 'function syncPlayPauseButton');
  assert.match(headerSource, /SyncWatchNetworkQuality\.roomStatus/);
  assert.match(appSource, /持续高延迟 · 正在恢复/);
  assert.match(appSource, /连接中断 · 正在重新连接/);
  assert.doesNotMatch(serverSource, /user\.connectionState\s*=\s*payload\.connectionState/,
    'the server must not trust one client-provided connection state');
  assert.match(serverSource, /onSafe\('network-quality',[\s\S]{0,600}applyNetworkQualitySample\(user, payload\)/,
    'the live Socket.IO handler must use the ordered server-side policy');
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function createClientProbeHarness() {
  const reports = [];
  const acknowledgements = [];
  const ackCalls = [];
  const state = {
    socketAuthenticated: true,
    socket: {
      connected: true,
      volatile: { emit: (event, payload) => reports.push({ event, payload: { ...payload } }) }
    },
    networkProbe: {
      inFlightSequence: 0, sequence: 0, appliedSequence: 0, connectionEpoch: 0,
      localConnectionState: 'online', tracker: policy.createTracker()
    },
    syncPercent: 100,
    latestDrift: 0,
    playbackQuality: 'original',
    localLatency: null,
    localBuffering: true
  };
  const context = vm.createContext({
    window: { SyncWatchNetworkQuality: policy },
    state,
    elements: { localLatency: { textContent: '' } },
    Date,
    performance: { now: () => 100 },
    updateServerClock() {},
    updateRoomHeader() {},
    renderUsers() {},
    async emitAck(event, payload) {
      ackCalls.push({ event, payload: { ...payload } });
      const response = acknowledgements.length
        ? acknowledgements.shift()
        : { success: true, serverTime: Date.now() };
      return await response;
    }
  });
  const probeSource = section(appSource, 'function resetNetworkQualityTracking()', 'function recoverFromBackground()');
  vm.runInContext(`${probeSource}\nthis.measureNetwork = measureNetwork; this.resetNetworkQualityTracking = resetNetworkQualityTracking;`, context);
  return {
    state, reports, acknowledgements, ackCalls,
    measureNetwork: () => context.measureNetwork(),
    reset: () => context.resetNetworkQualityTracking()
  };
}

async function testClientProbeLifecycle() {
  const harness = createClientProbeHarness();

  for (let sample = 0; sample < 120; sample += 1) await harness.measureNetwork();
  assert.equal(harness.state.networkProbe.localConnectionState, 'online',
    'eight simulated minutes of healthy probes while buffering must not report network jitter');
  assert.equal(harness.reports.length, 120);
  assert.ok(harness.reports.every(({ payload }) => payload.connectionState === 'online'));

  harness.reset();
  harness.reports.length = 0;
  const slowAck = deferred();
  harness.acknowledgements.push(slowAck.promise);
  const firstProbe = harness.measureNetwork();
  const overlappingProbe = harness.measureNetwork();
  assert.equal(harness.ackCalls.at(-1).payload.sequence, harness.state.networkProbe.inFlightSequence);
  const callsWhilePending = harness.ackCalls.length;
  await overlappingProbe;
  assert.equal(harness.ackCalls.length, callsWhilePending, 'a pending probe must suppress overlapping timer ticks');
  slowAck.resolve({ success: true, serverTime: Date.now() });
  await firstProbe;

  harness.reset();
  harness.reports.length = 0;
  const timeout = { success: false, transient: true, error: '服务器响应超时，请稍后重试' };
  for (let sample = 0; sample < 3; sample += 1) {
    harness.acknowledgements.push(timeout);
    await harness.measureNetwork();
  }
  assert.deepEqual(harness.reports.map(({ payload }) => payload.connectionState), ['online', 'online', 'unstable'],
    'only sustained control-channel failures may degrade the client');
  await harness.measureNetwork();
  assert.equal(harness.state.networkProbe.localConnectionState, 'unstable',
    'one healthy result must not bypass recovery hysteresis');
  await harness.measureNetwork();
  assert.equal(harness.state.networkProbe.localConnectionState, 'online',
    'two consecutive healthy results must recover the client');

  harness.reset();
  harness.reports.length = 0;
  const oldConnectionAck = deferred();
  harness.acknowledgements.push(oldConnectionAck.promise);
  const oldConnectionProbe = harness.measureNetwork();
  const oldSequence = harness.state.networkProbe.inFlightSequence;
  harness.reset();
  await harness.measureNetwork();
  const currentSequence = harness.state.networkProbe.appliedSequence;
  oldConnectionAck.resolve(timeout);
  await oldConnectionProbe;
  assert.ok(currentSequence > oldSequence);
  assert.equal(harness.state.networkProbe.appliedSequence, currentSequence);
  assert.equal(harness.state.networkProbe.localConnectionState, 'online');
  assert.deepEqual(harness.reports.map(({ payload }) => payload.sequence), [currentSequence],
    'a late result from the old connection epoch must not update or report into the new connection');
}

async function testRangePlaybackKeepsControlChannelResponsive() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-network-quality-'));
  const sockets = [];
  let server;
  let rangeReader;
  try {
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, discovery: false,
      publicDir: path.join(root, 'public'), ffprobePath: '', ffmpegPath: '',
      hostControlToken: 'network-quality-host'
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const socket = await connect(baseUrl); sockets.push(socket);
    assert.equal((await ack(socket, 'user-register', { username: 'NetworkHost', password: 'network-pass' })).success, true);
    const login = await acceptAgreement(socket, await ack(socket, 'room-create', {
      username: 'NetworkHost', password: 'network-pass', customRoomId: 'NETWORK1', roomName: 'Network quality',
      hostToken: 'network-quality-host', deviceId: 'network-quality-device'
    }));
    assert.equal(login.success, true, login.error);

    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(8 * 1024 * 1024, 0x61)], { type: 'video/mp4' }), 'range-control-test.mp4');
    const uploadResponse = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.token}` }, body: form
    });
    const uploaded = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200, uploaded.error);

    const rangeResponse = await fetch(`${baseUrl}${uploaded.file.originalUrl}`, {
      headers: { Authorization: `Bearer ${login.token}`, Range: 'bytes=0-' }
    });
    assert.equal(rangeResponse.status, 206);
    rangeReader = rangeResponse.body.getReader();
    let rangeFinished = false;
    const slowRead = (async () => {
      while (true) {
        const item = await rangeReader.read();
        if (item.done) { rangeFinished = true; return; }
        await delay(35);
      }
    })();

    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const startedAt = performance.now();
      const pong = await ack(socket, 'network-ping', { sequence });
      assert.equal(pong.success, true, pong.error);
      assert.ok(performance.now() - startedAt < 1000, 'media Range transfer starved the Socket.IO control channel');
    }
    assert.equal(rangeFinished, false, 'the media Range stream should still be active during control probes');
    const quality = await ack(socket, 'network-quality', {
      sequence: 1, latency: 40, syncPercent: 100, drift: 0,
      playbackQuality: 'original', sampleStatus: 'healthy', connectionState: 'online'
    });
    assert.equal(quality.success, true, quality.error);
    const self = (await ack(socket, 'room-refresh')).users.find((member) => member.username === 'NetworkHost');
    assert.equal(self.connectionState, 'online');

    const quota = await ack(socket, 'admin-action', {
      action: 'set-account-room-quota', adminPassword: 'admin888', username: 'NetworkHost', roomQuota: 2
    });
    assert.equal(quota.success, true, quota.error);
    const targetRoom = await ack(socket, 'room-create', {
      customRoomId: 'NETWORK2', roomName: 'Network target'
    });
    assert.equal(targetRoom.success, true, targetRoom.error);
    const returned = await ack(socket, 'room-switch', { roomId: 'NETWORK1' });
    assert.equal(returned.success, true, returned.error);

    for (let sequence = 2; sequence <= 4; sequence += 1) {
      const degraded = await ack(socket, 'network-quality', {
        sequence, latency: 900, syncPercent: 90, drift: 0,
        playbackQuality: 'original', sampleStatus: 'high-latency'
      });
      assert.equal(degraded.success, true, degraded.error);
    }
    assert.equal((await ack(socket, 'room-refresh')).users.find((member) => member.username === 'NetworkHost').connectionState, 'unstable');
    const switched = await ack(socket, 'room-switch', { roomId: 'NETWORK2' });
    assert.equal(switched.success, true, switched.error);
    const switchedSelf = (await ack(socket, 'room-refresh')).users.find((member) => member.username === 'NetworkHost');
    assert.equal(switchedSelf.connectionState, 'unstable', 'room switching must preserve socket-wide network quality');
    const firstRecovery = await ack(socket, 'network-quality', {
      sequence: 5, latency: 40, syncPercent: 100, drift: 0,
      playbackQuality: 'original', sampleStatus: 'healthy'
    });
    assert.equal(firstRecovery.connectionState, 'unstable', 'one healthy sample after a room switch must not bypass recovery hysteresis');

    await rangeReader.cancel();
    await Promise.race([slowRead, delay(1000)]);
  } finally {
    try { await rangeReader?.cancel(); } catch (_) {}
    for (const socket of sockets) socket.disconnect();
    if (server) await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  testClientPolicy();
  testServerPolicy();
  testSourceContracts();
  await testClientProbeLifecycle();
  await testRangePlaybackKeepsControlChannelResponsive();
  console.log('network quality hysteresis, ordering, disconnect and active Range control-channel regression passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
