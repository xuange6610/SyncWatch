'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const electron = require('electron');

const INITIAL_LOAD_RETRY_DELAYS_MS = Object.freeze([750, 1500, 3000]);
const TRANSIENT_INITIAL_LOAD_ERRORS = new Set([
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_RESET',
  'ERR_TIMED_OUT'
]);
const TRANSIENT_INITIAL_LOAD_CODES = new Set([-100, -101, -118]);
const LONG_PLAY_MINIMUM_SECONDS = 600;
const LONG_PLAY_TAIL_WINDOW_MS = 30000;

function sanitizeSensitiveText(value) {
  return String(value || '')
    .replace(/https?:\/\/[a-z0-9-]+\.trycloudflare\.com\b/ig, 'https://[redacted-quick-tunnel]')
    .replace(/\b[a-z0-9-]+\.trycloudflare\.com\b/ig, '[redacted-quick-tunnel]')
    .replace(/([?&](?:syncwatch_token|access_token|auth_token|api_?key|secret|signature)=)[^&#\s"'<>\\)]+/ig,
      '$1[redacted-token]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/(?<![A-Fa-f0-9:])(?:(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}|(?:[A-Fa-f0-9]{1,4}:){1,7}:|(?:[A-Fa-f0-9]{1,4}:){1,6}:[A-Fa-f0-9]{1,4}|(?:[A-Fa-f0-9]{1,4}:){1,5}(?::[A-Fa-f0-9]{1,4}){1,2}|(?:[A-Fa-f0-9]{1,4}:){1,4}(?::[A-Fa-f0-9]{1,4}){1,3}|(?:[A-Fa-f0-9]{1,4}:){1,3}(?::[A-Fa-f0-9]{1,4}){1,4}|(?:[A-Fa-f0-9]{1,4}:){1,2}(?::[A-Fa-f0-9]{1,4}){1,5}|[A-Fa-f0-9]{1,4}:(?:(?::[A-Fa-f0-9]{1,4}){1,6})|:(?:(?::[A-Fa-f0-9]{1,4}){1,7}|:))(?:%[A-Za-z0-9_.-]+)?(?![A-Fa-f0-9:])/g,
      '[redacted-ip]');
}

function sanitizeReportSnapshot(value) {
  if (typeof value === 'string') return sanitizeSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeReportSnapshot(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, sanitizeReportSnapshot(item)]));
}

function isTransientInitialLoadError(error) {
  const text = `${error?.code || ''} ${error?.errno || ''} ${error?.message || error || ''}`.toUpperCase();
  if ([...TRANSIENT_INITIAL_LOAD_ERRORS].some((name) => text.includes(name))) return true;
  return [error?.code, error?.errno]
    .map((value) => Number(value))
    .some((value) => Number.isFinite(value) && TRANSIENT_INITIAL_LOAD_CODES.has(value));
}

async function loadInitialBrowserUrl(targetWindow, targetUrl, {
  allowTransientRetry = false,
  retryDelaysMs = INITIAL_LOAD_RETRY_DELAYS_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onAttempt = () => {}
} = {}) {
  const maxAttempts = allowTransientRetry ? retryDelaysMs.length + 1 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await targetWindow.loadURL(targetUrl);
      onAttempt({ attempt, ok: true });
      return { attempts: attempt };
    } catch (error) {
      onAttempt({
        attempt,
        ok: false,
        error: sanitizeSensitiveText(error?.message || error),
        code: String(error?.code || error?.errno || '')
      });
      if (!allowTransientRetry || !isTransientInitialLoadError(error) || attempt >= maxAttempts) throw error;
      await sleep(retryDelaysMs[attempt - 1]);
    }
  }
  throw new Error('initial browser load exhausted without a result');
}

function summarizeProgressWindow(samples, progressThresholdSeconds = 0.25) {
  if (samples.length < 2) {
    return {
      observedMs: 0,
      progressSeconds: 0,
      longestNoProgressMs: 0,
      progressEvents: 0
    };
  }
  let noProgressStartedAt = samples[0].atMs;
  let longestNoProgressMs = 0;
  let progressEvents = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (current.currentTime - previous.currentTime < progressThresholdSeconds) continue;
    longestNoProgressMs = Math.max(longestNoProgressMs, current.atMs - noProgressStartedAt);
    noProgressStartedAt = current.atMs;
    progressEvents += 1;
  }
  const finalSample = samples[samples.length - 1];
  longestNoProgressMs = Math.max(longestNoProgressMs, finalSample.atMs - noProgressStartedAt);
  const initialTime = samples[0].currentTime;
  const furthestTime = Math.max(...samples.map((sample) => sample.currentTime));
  return {
    observedMs: finalSample.atMs - samples[0].atMs,
    progressSeconds: Number(Math.max(0, furthestTime - initialTime).toFixed(3)),
    longestNoProgressMs,
    progressEvents
  };
}

function summarizePlaybackContinuity(rawSamples, tailWindowMs = LONG_PLAY_TAIL_WINDOW_MS) {
  const samples = (Array.isArray(rawSamples) ? rawSamples : [])
    .map((sample) => ({ atMs: Number(sample?.atMs), currentTime: Number(sample?.currentTime) }))
    .filter((sample) => Number.isFinite(sample.atMs) && Number.isFinite(sample.currentTime))
    .sort((left, right) => left.atMs - right.atMs);
  const overall = summarizeProgressWindow(samples);
  if (!samples.length) {
    return {
      sampleCount: 0,
      observedMs: 0,
      longestNoProgressMs: 0,
      tailWindowMs,
      tailObservedMs: 0,
      tailProgressSeconds: 0,
      tailLongestNoProgressMs: 0,
      tailProgressEvents: 0
    };
  }
  const tailCutoff = samples[samples.length - 1].atMs - tailWindowMs;
  const firstTailIndex = Math.max(0, samples.findIndex((sample) => sample.atMs >= tailCutoff));
  const tail = samples.slice(firstTailIndex);
  const tailSummary = summarizeProgressWindow(tail);
  return {
    sampleCount: samples.length,
    observedMs: overall.observedMs,
    longestNoProgressMs: overall.longestNoProgressMs,
    tailWindowMs,
    tailObservedMs: tailSummary.observedMs,
    tailProgressSeconds: tailSummary.progressSeconds,
    tailLongestNoProgressMs: tailSummary.longestNoProgressMs,
    tailProgressEvents: tailSummary.progressEvents
  };
}

function summarizeRecoveryProgress(rawSamples, recoveryRelativeMs) {
  const samples = (Array.isArray(rawSamples) ? rawSamples : [])
    .map((sample) => ({
      atMs: Number(sample?.atMs),
      currentTime: Number(sample?.currentTime),
      paused: Boolean(sample?.paused),
      socketAuthenticated: Boolean(sample?.socketAuthenticated),
      mediaFailed: Boolean(sample?.mediaFailed),
      waitingForNetwork: Boolean(sample?.waitingForNetwork),
      recoveryKey: String(sample?.recoveryKey || '')
    }))
    .filter((sample) => Number.isFinite(sample.atMs)
      && Number.isFinite(sample.currentTime)
      && sample.atMs >= Number(recoveryRelativeMs))
    .sort((left, right) => left.atMs - right.atMs);
  const healthy = samples.filter((sample) => sample.socketAuthenticated
    && !sample.mediaFailed
    && !sample.paused
    && !sample.waitingForNetwork
    && !sample.recoveryKey);
  if (healthy.length < 2) return 0;
  const initialTime = healthy[0].currentTime;
  const furthestTime = Math.max(...healthy.map((sample) => sample.currentTime));
  return Number(Math.max(0, furthestTime - initialTime).toFixed(3));
}

function assertLongPlaybackAcceptance({ playbackSeconds, boundedOutageMs, playbackSummary }) {
  if (playbackSeconds < LONG_PLAY_MINIMUM_SECONDS) return false;
  const continuity = playbackSummary?.continuity || {};
  assert.ok(Number(continuity.observedMs) >= playbackSeconds * 1000 - 5000,
    `600-second playback telemetry is incomplete: ${continuity.observedMs || 0} ms`);
  assert.ok(Number(continuity.longestNoProgressMs) <= boundedOutageMs + 30000,
    `playback stopped progressing for ${continuity.longestNoProgressMs} ms`);
  assert.ok(Number(continuity.tailObservedMs) >= LONG_PLAY_TAIL_WINDOW_MS - 2000,
    `last 30 seconds of playback telemetry are incomplete: ${continuity.tailObservedMs || 0} ms`);
  assert.ok(Number(continuity.tailProgressSeconds) >= 20,
    `playback did not keep advancing during the last 30 seconds: ${continuity.tailProgressSeconds || 0} s`);
  assert.ok(Number(continuity.tailLongestNoProgressMs) <= 5000,
    `playback stalled during the last 30 seconds for ${continuity.tailLongestNoProgressMs} ms`);
  assert.equal(playbackSummary?.final?.paused, false, 'the 600-second player finished paused');
  assert.equal(playbackSummary?.final?.ended, false, 'the 600-second player reached ended state');
  assert.equal(playbackSummary?.appState?.roomPlaying, true,
    'the authoritative room playback state is no longer playing');
  return true;
}

const { app, BrowserWindow } = typeof electron === 'object' && electron ? electron : {};

if (!app) {
  module.exports = {
    assertLongPlaybackAcceptance,
    isTransientInitialLoadError,
    loadInitialBrowserUrl,
    sanitizeReportSnapshot,
    sanitizeSensitiveText,
    summarizePlaybackContinuity,
    summarizeRecoveryProgress
  };
} else {
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { io } = require('socket.io-client');
const { fetch: undiciFetch, EnvHttpProxyAgent } = require('undici');
const ffmpegPath = require('ffmpeg-static');
const { startSyncWatchServer, _test } = require('../server');

const MIB = 1024 * 1024;
const ROOT = path.resolve(__dirname, '..');
const HOST_TOKEN = 'long-play-network-host';
const TEST_USERNAME = 'LongPlayHost';
const TEST_PASSWORD = 'long-play-pass';
const TEST_ROOM_ID = 'LONGPLAY1';
const startedAt = Date.now();

function numericEnvironment(name, fallback, minimum, maximum = Number.POSITIVE_INFINITY) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  assert.ok(Number.isFinite(value) && value >= minimum && value <= maximum,
    `${name} must be between ${minimum} and ${maximum}`);
  return value;
}

function enumEnvironment(name, fallback, allowed) {
  const value = String(process.env[name] || fallback).trim().toLowerCase();
  assert.ok(allowed.includes(value), `${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

function booleanEnvironment(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return Boolean(fallback);
  assert.ok(['0', '1'].includes(raw), `${name} must be 0 or 1`);
  return raw === '1';
}

const config = Object.freeze({
  playbackSeconds: numericEnvironment('SYNCWATCH_LONG_PLAY_SECONDS', 90, 20, 24 * 60 * 60),
  mediaSeconds: numericEnvironment('SYNCWATCH_LONG_PLAY_MEDIA_SECONDS', 20, 10, 600),
  videoKbps: numericEnvironment('SYNCWATCH_LONG_PLAY_VIDEO_KBPS', 20000, 256, 100000),
  rangeProbeKbps: numericEnvironment('SYNCWATCH_LONG_PLAY_RANGE_KBPS', 24000, 256, 1000000),
  rangeTimeoutMs: numericEnvironment('SYNCWATCH_LONG_PLAY_RANGE_TIMEOUT_MS', 300000, 30000, 30 * 60 * 1000),
  rangeRetries: numericEnvironment('SYNCWATCH_LONG_PLAY_RANGE_RETRIES', 2, 0, 10),
  rangeProbeEnabled: booleanEnvironment('SYNCWATCH_LONG_PLAY_RANGE_PROBE', true),
  constrainedKbps: numericEnvironment('SYNCWATCH_LONG_PLAY_DOWNLOAD_KBPS', 1800, 64, 1000000),
  recoveryKbps: numericEnvironment('SYNCWATCH_LONG_PLAY_RECOVERY_KBPS', 32000, 256, 1000000),
  latencyMs: numericEnvironment('SYNCWATCH_LONG_PLAY_LATENCY_MS', 350, 0, 30000),
  outageMs: numericEnvironment('SYNCWATCH_LONG_PLAY_OUTAGE_MS', 25000, 0, 60000),
  outageAtSeconds: numericEnvironment('SYNCWATCH_LONG_PLAY_OUTAGE_AT_SECONDS', 0, 0, 24 * 60 * 60),
  tunnelProtocol: enumEnvironment('SYNCWATCH_LONG_PLAY_TUNNEL_PROTOCOL', 'auto', ['http2', 'auto', 'quic']),
  tunnelBypassProxy: booleanEnvironment('SYNCWATCH_LONG_PLAY_TUNNEL_BYPASS_PROXY'),
  useQuickTunnel: process.env.SYNCWATCH_LONG_PLAY_USE_QUICK_TUNNEL === '1',
  keepTemp: process.env.SYNCWATCH_LONG_PLAY_KEEP_TEMP === '1',
  mediaPath: process.env.SYNCWATCH_LONG_PLAY_MEDIA
    ? path.resolve(process.env.SYNCWATCH_LONG_PLAY_MEDIA) : '',
  reportPath: path.resolve(process.env.SYNCWATCH_LONG_PLAY_REPORT
    || path.join(os.tmpdir(), `syncwatch-long-play-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
});

if (process.argv.includes('--help')) {
  console.log(`Usage: npx electron tests/long-play-network-smoke.js

This opt-in smoke test is intentionally excluded from npm test and test:all.

Environment variables:
  SYNCWATCH_LONG_PLAY_SECONDS=90             Playback observation duration
  SYNCWATCH_LONG_PLAY_MEDIA_SECONDS=20       Generated H.264 duration
  SYNCWATCH_LONG_PLAY_VIDEO_KBPS=20000       Generated H.264 target bitrate
  SYNCWATCH_LONG_PLAY_RANGE_KBPS=24000       Sequential Range probe bandwidth
  SYNCWATCH_LONG_PLAY_RANGE_TIMEOUT_MS=300000 Sequential Range phase timeout
  SYNCWATCH_LONG_PLAY_RANGE_RETRIES=2        Additional attempts per failed segment
  SYNCWATCH_LONG_PLAY_RANGE_PROBE=1          Run the full >32 MiB contiguous Range probe
  SYNCWATCH_LONG_PLAY_DOWNLOAD_KBPS=1800     Constrained playback bandwidth
  SYNCWATCH_LONG_PLAY_RECOVERY_KBPS=32000    Recovery playback bandwidth
  SYNCWATCH_LONG_PLAY_LATENCY_MS=350         Constrained round-trip latency
  SYNCWATCH_LONG_PLAY_OUTAGE_MS=25000        Intentional offline window
  SYNCWATCH_LONG_PLAY_OUTAGE_AT_SECONDS=0    Explicit outage start; 0 selects an early bounded default
  SYNCWATCH_LONG_PLAY_USE_QUICK_TUNNEL=1     Route Chromium through Quick Tunnel
  SYNCWATCH_LONG_PLAY_TUNNEL_PROTOCOL=auto   Quick Tunnel connector protocol (auto/http2/quic)
  SYNCWATCH_LONG_PLAY_TUNNEL_BYPASS_PROXY=0  Strip proxy variables for a direct connector route
  SYNCWATCH_CLOUDFLARED_PATH=<path>          Override cloudflared executable
  SYNCWATCH_LONG_PLAY_MEDIA=<path>           Use an existing >32 MiB browser video
  SYNCWATCH_LONG_PLAY_REPORT=<path>          JSON report destination
  SYNCWATCH_LONG_PLAY_KEEP_TEMP=1            Keep generated media and server data`);
  process.exit(0);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-long-play-'));
const dataDir = path.join(temporaryRoot, 'data');
const browserDataDir = path.join(temporaryRoot, 'chromium');
const generatedMediaPath = path.join(temporaryRoot, 'long-play-generated.mp4');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(browserDataDir, { recursive: true });

app.setPath('userData', browserDataDir);
app.setPath('cache', path.join(browserDataDir, 'cache'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const report = {
  schemaVersion: 1,
  startedAt: new Date(startedAt).toISOString(),
  status: 'running',
  mode: config.useQuickTunnel ? 'quick-tunnel' : 'loopback',
  config: {
    playbackSeconds: config.playbackSeconds,
    mediaSeconds: config.mediaSeconds,
    videoKbps: config.videoKbps,
    rangeProbeKbps: config.rangeProbeKbps,
    rangeTimeoutMs: config.rangeTimeoutMs,
    rangeRetries: config.rangeRetries,
    rangeProbeEnabled: config.rangeProbeEnabled,
    constrainedKbps: config.constrainedKbps,
    recoveryKbps: config.recoveryKbps,
    latencyMs: config.latencyMs,
    outageMs: config.outageMs,
    outageAtSeconds: config.outageAtSeconds,
    tunnelProtocol: config.tunnelProtocol,
    tunnelBypassProxy: config.tunnelBypassProxy,
    suppliedMedia: Boolean(config.mediaPath)
  },
  runtime: {
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome
  },
  phases: [],
  browser: { initialLoadAttempts: [] },
  media: {},
  ranges: { probeSegments: [], probeFailures: [], browserRequests: [], summary: {} },
  socket: { samples: [], summary: {} },
  playback: { events: [], samples: [], summary: {} },
  assertions: []
};

let server = null;
let socket = null;
let window = null;
let quickTunnel = null;
let faultProxy = null;
let rttLoopRunning = false;
let rttLoopPromise = null;
let currentPhase = 'setup';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const relativeMs = () => Date.now() - startedAt;

async function startFaultProxy(targetPort) {
  const sockets = new Set();
  const runtime = { online: true, sockets, server: null, port: 0 };
  const proxy = net.createServer((client) => {
    client.setNoDelay(true);
    if (!runtime.online) {
      client.destroy();
      return;
    }
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    const cleanupPair = () => {
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('close', cleanupPair);
    upstream.on('close', cleanupPair);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  runtime.server = proxy;
  await new Promise((resolve, reject) => {
    const onError = (error) => { proxy.off('listening', onListening); reject(error); };
    const onListening = () => { proxy.off('error', onError); resolve(); };
    proxy.once('error', onError);
    proxy.once('listening', onListening);
    proxy.listen(0, '127.0.0.1');
  });
  runtime.port = proxy.address().port;
  runtime.setOnline = (online) => {
    runtime.online = Boolean(online);
    if (!runtime.online) for (const socketHandle of [...sockets]) socketHandle.destroy();
  };
  runtime.close = async () => {
    runtime.setOnline(false);
    if (!proxy.listening) return;
    await new Promise((resolve) => proxy.close(resolve));
  };
  return runtime;
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function recordPhase(name, profile = {}) {
  currentPhase = name;
  report.phases.push({ name, atMs: relativeMs(), ...profile });
  console.log(`[long-play] phase=${name} ${JSON.stringify(profile)}`);
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function summarizeNumbers(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { count: 0, min: null, median: null, p95: null, max: null };
  return {
    count: finite.length,
    min: Math.min(...finite),
    median: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: Math.max(...finite)
  };
}

function countErrorTypes(values) {
  const counts = {};
  for (const value of values) {
    const text = String(value || 'UNKNOWN');
    const networkCode = text.match(/(?:net::)?(ERR_[A-Z0-9_]+)/)?.[1];
    const httpStatus = text.match(/(?:status(?:Code)?[=: ]+|HTTP[_ ]+)(\d{3})/i)?.[1];
    const type = networkCode || (httpStatus ? `HTTP_${httpStatus}`
      : (/Failed to fetch/i.test(text) ? 'FETCH_FAILED' : 'OTHER'));
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function headerValue(headers, targetName) {
  const pair = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === targetName.toLowerCase());
  if (!pair) return '';
  return Array.isArray(pair[1]) ? pair[1].join(', ') : String(pair[1] || '');
}

function safeError(error) {
  return { name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack || '' };
}

function generateMediaSample(targetPath) {
  assert.ok(ffmpegPath && fs.existsSync(ffmpegPath), 'ffmpeg-static is unavailable');
  const duration = config.mediaSeconds;
  const videoBitrate = `${Math.round(config.videoKbps)}k`;
  const result = spawnSync(ffmpegPath, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=660:sample_rate=48000:duration=${duration}`,
    '-vf', 'noise=alls=20:allf=t+u',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-b:v', videoBitrate, '-minrate', videoBitrate, '-maxrate', videoBitrate, '-bufsize', videoBitrate,
    '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-g', '60',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest',
    targetPath
  ], { windowsHide: true, encoding: 'utf8', timeout: 180000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'failed to generate H.264 sample');
  return targetPath;
}

function prepareMedia() {
  const source = config.mediaPath || generateMediaSample(generatedMediaPath);
  assert.ok(fs.existsSync(source), 'long-play media does not exist');
  const stat = fs.statSync(source);
  assert.ok(stat.isFile(), 'long-play media must be a regular file');
  if (config.rangeProbeEnabled) {
    assert.ok(stat.size > _test.OPEN_ENDED_MEDIA_RANGE_CHUNK_THRESHOLD_BYTES,
      `long-play media must exceed ${_test.OPEN_ENDED_MEDIA_RANGE_CHUNK_THRESHOLD_BYTES} bytes; got ${stat.size}`);
  } else {
    assert.ok(stat.size > MIB, `playback media must exceed ${MIB} bytes; got ${stat.size}`);
  }
  report.media = {
    generated: !config.mediaPath,
    bytes: stat.size,
    mebibytes: Number((stat.size / MIB).toFixed(2)),
    thresholdBytes: _test.OPEN_ENDED_MEDIA_RANGE_CHUNK_THRESHOLD_BYTES,
    expectedOpenRangeBytes: _test.MAX_OPEN_ENDED_MEDIA_RANGE_BYTES
  };
  return source;
}

function ack(targetSocket, event, payload = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), timeoutMs);
    targetSocket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result || { success: false, error: 'server returned no result' });
    });
  });
}

async function connect(baseUrl) {
  const target = io(baseUrl, {
    transports: ['websocket', 'polling'], tryAllTransports: true,
    upgrade: true, forceNew: true, reconnection: false, timeout: 30000,
    extraHeaders: { Origin: baseUrl }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket.IO connection timed out')), 45000);
    const finish = (error) => {
      clearTimeout(timer);
      target.off('connect', onConnect);
      target.off('connect_error', onError);
      if (error) reject(error); else resolve();
    };
    const onConnect = () => finish();
    const onError = (error) => finish(new Error(`Socket.IO connection failed: ${error?.message || error}`));
    target.once('connect', onConnect);
    target.once('connect_error', onError);
  });
  return target;
}

async function createSession(localBaseUrl) {
  socket = await connect(localBaseUrl);
  const registration = await ack(socket, 'user-register', { username: TEST_USERNAME, password: TEST_PASSWORD });
  assert.equal(registration.success, true, registration.error);
  const created = await ack(socket, 'room-create', {
    username: TEST_USERNAME,
    password: TEST_PASSWORD,
    customRoomId: TEST_ROOM_ID,
    roomName: 'Long play network smoke',
    hostToken: HOST_TOKEN,
    deviceId: 'long-play-network-smoke'
  });
  assert.equal(created.success, true, created.error);
  if (created.capabilities?.agreementRequired) {
    const accepted = await ack(socket, 'agreement-accept', {
      accepted: true,
      version: created.agreement?.version
    });
    assert.equal(accepted.success, true, accepted.error);
  }
  assert.match(created.token || '', /^[A-Za-z0-9_-]{32,}$/);
  return created.token;
}

async function uploadMedia(localBaseUrl, token, mediaPath) {
  const bytes = fs.readFileSync(mediaPath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'video/mp4' }), 'long-play-network-source.mp4');
  const response = await fetch(`${localBaseUrl}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(180000)
  });
  const body = await response.json();
  assert.equal(response.status, 200, body.error || 'media upload failed');
  assert.equal(body.success, true, body.error);
  assert.match(body.file?.originalUrl || body.file?.url || '', /^\/media\//);
  return body.file;
}

function resolveCloudflared() {
  if (process.env.SYNCWATCH_CLOUDFLARED_PATH) return path.resolve(process.env.SYNCWATCH_CLOUDFLARED_PATH);
  return path.join(ROOT, 'vendor', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

async function waitForPublicOrigin(publicUrl, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  let lastError = '';
  const proxyConfigured = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']
    .some((name) => String(process.env[name] || '').trim());
  const dispatcher = proxyConfigured ? new EnvHttpProxyAgent() : null;
  try {
    while (Date.now() < deadline) {
      try {
        const response = await undiciFetch(`${publicUrl}/?long-play-tunnel-probe=1`, {
          redirect: 'manual', signal: AbortSignal.timeout(7000), ...(dispatcher ? { dispatcher } : {})
        });
        lastStatus = response.status;
        await response.body?.cancel().catch(() => {});
        if (response.status > 0 && response.status < 500) return;
      } catch (error) {
        lastError = error.message;
      }
      await delay(1000);
    }
  } finally {
    if (dispatcher) await dispatcher.close().catch(() => {});
  }
  throw new Error(`Quick Tunnel did not become reachable (status=${lastStatus}, error=${lastError || 'none'})`);
}

async function launchQuickTunnel(localBaseUrl) {
  const binary = resolveCloudflared();
  assert.ok(fs.existsSync(binary), `cloudflared is missing: ${binary}`);
  const tunnelEnvironment = { ...process.env };
  if (config.tunnelBypassProxy) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      delete tunnelEnvironment[key];
    }
    tunnelEnvironment.NO_PROXY = '*';
    tunnelEnvironment.no_proxy = '*';
  }
  const child = spawn(binary, [
    'tunnel', '--url', localBaseUrl, '--protocol', config.tunnelProtocol,
    '--edge-ip-version', '4', '--retries', '12', '--no-autoupdate'
  ], { env: tunnelEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let publicUrl = '';
  const capture = (chunk) => {
    log = `${log}${chunk}`.slice(-30000);
    const matches = log.matchAll(/https:\/\/([a-z0-9](?:[a-z0-9-]{0,62}))\.trycloudflare\.com\b/ig);
    for (const match of matches) {
      const label = String(match[1] || '').toLowerCase();
      if (label.includes('-') && !['api', 'www'].includes(label)) publicUrl ||= `https://${label}.trycloudflare.com`;
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const runtime = {
    child,
    publicUrl: '',
    protocol: config.tunnelProtocol,
    bypassProxy: config.tunnelBypassProxy,
    exitedBeforeCleanup: false,
    exitCode: null,
    signalCode: '',
    getLog: () => log
  };
  child.once('exit', (code, signal) => {
    runtime.exitedBeforeCleanup = !runtime.stopping;
    runtime.exitCode = Number.isInteger(code) ? code : null;
    runtime.signalCode = signal || '';
  });
  try {
    const deadline = Date.now() + 120000;
    while (!publicUrl && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`cloudflared exited before publishing a URL (${child.exitCode})`);
      await delay(250);
    }
    if (!publicUrl) throw new Error('cloudflared did not publish a Quick Tunnel URL before the 120-second deadline');
    runtime.publicUrl = publicUrl;
    quickTunnel = runtime;
    await waitForPublicOrigin(publicUrl);
    return runtime;
  } catch (error) {
    runtime.publicUrl = publicUrl;
    quickTunnel = runtime;
    captureTunnelDiagnostics();
    await stopQuickTunnel(runtime).catch(() => {});
    throw error;
  }
}

async function stopQuickTunnel(tunnel) {
  if (!tunnel?.child || tunnel.child.exitCode !== null) return;
  tunnel.stopping = true;
  const exited = new Promise((resolve) => tunnel.child.once('exit', resolve));
  tunnel.child.kill();
  await Promise.race([exited, delay(5000)]);
  if (tunnel.child.exitCode === null) tunnel.child.kill('SIGKILL');
}

function sanitizedTunnelLog(value) {
  return sanitizeSensitiveText(value)
    .replace(/[\r\n]+/g, '\n')
    .slice(-12000);
}

function captureTunnelDiagnostics() {
  if (!quickTunnel) return;
  report.tunnel = {
    ...(report.tunnel || {}),
    protocol: quickTunnel.protocol,
    bypassProxy: Boolean(quickTunnel.bypassProxy),
    exitedBeforeCleanup: Boolean(quickTunnel.exitedBeforeCleanup),
    exitCode: Number.isInteger(quickTunnel.child?.exitCode)
      ? quickTunnel.child.exitCode : quickTunnel.exitCode,
    signalCode: quickTunnel.child?.signalCode || quickTunnel.signalCode || '',
    logTail: sanitizedTunnelLog(quickTunnel.getLog?.())
  };
}

function installRangeRequestCollector(targetWindow) {
  const pending = new Map();
  const filter = { urls: ['http://*/media/*', 'https://*/media/*'] };
  targetWindow.webContents.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const range = headerValue(details.requestHeaders, 'range');
    if (range) {
      const entry = {
        requestId: details.id,
        phase: currentPhase,
        atMs: relativeMs(),
        method: details.method,
        path: new URL(details.url).pathname,
        marker: new URL(details.url).searchParams.get('syncwatch_long_play') || '',
        range
      };
      pending.set(details.id, entry);
      report.ranges.browserRequests.push(entry);
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  targetWindow.webContents.session.webRequest.onHeadersReceived(filter, (details, callback) => {
    const entry = pending.get(details.id);
    if (entry) {
      entry.statusCode = details.statusCode;
      entry.contentRange = headerValue(details.responseHeaders, 'content-range');
      entry.contentLength = Number(headerValue(details.responseHeaders, 'content-length')) || 0;
    }
    callback({ responseHeaders: details.responseHeaders });
  });
  targetWindow.webContents.session.webRequest.onCompleted(filter, (details) => {
    const entry = pending.get(details.id);
    if (!entry) return;
    pending.delete(details.id);
    entry.completedAtMs = relativeMs();
    entry.durationMs = entry.completedAtMs - entry.atMs;
  });
  targetWindow.webContents.session.webRequest.onErrorOccurred(filter, (details) => {
    const entry = pending.get(details.id);
    if (!entry) return;
    pending.delete(details.id);
    entry.completedAtMs = relativeMs();
    entry.durationMs = entry.completedAtMs - entry.atMs;
    entry.error = details.error;
  });
}

async function waitForExpression(targetWindow, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await targetWindow.webContents.executeJavaScript(expression, true)) return;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`browser expression timed out: ${expression}; ${lastError?.message || 'no execution error'}`);
}

async function attachDevToolsNetwork(targetWindow) {
  targetWindow.webContents.debugger.attach('1.3');
  await targetWindow.webContents.debugger.sendCommand('Network.enable');
  await targetWindow.webContents.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });
}

async function emulateNetwork(targetWindow, { offline = false, latencyMs = 0, downloadKbps = 1000000 } = {}) {
  const bytesPerSecond = Math.max(1, Math.round(downloadKbps * 1024 / 8));
  await targetWindow.webContents.debugger.sendCommand('Network.emulateNetworkConditions', {
    offline,
    latency: latencyMs,
    downloadThroughput: bytesPerSecond,
    uploadThroughput: Math.max(bytesPerSecond, 1024 * 1024),
    connectionType: offline ? 'none' : 'cellular3g'
  });
}

async function runSequentialRangeProbe(targetWindow, mediaUrl, token, expectedTotal) {
  const script = String.raw`(async () => {
    const segments = [];
    const failures = [];
    globalThis.__syncwatchLongPlayRangeController?.abort();
    const controller = new AbortController();
    globalThis.__syncwatchLongPlayRangeController = controller;
    try {
      const target = new URL(${JSON.stringify(mediaUrl)}, location.origin);
      target.searchParams.set('syncwatch_token', ${JSON.stringify(token)});
      target.searchParams.set('syncwatch_long_play', 'probe');
      let offset = 0;
      let previousFinishedAt = null;
      while (offset < ${expectedTotal}) {
        let completed = null;
        for (let attempt = 1; attempt <= ${config.rangeRetries + 1}; attempt += 1) {
          const startedAt = performance.now();
          try {
            const response = await fetch(target, {
              headers: { Range: 'bytes=' + offset + '-' },
              cache: 'no-store',
              signal: controller.signal
            });
            const headersAt = performance.now();
            const bytes = await response.arrayBuffer();
            const finishedAt = performance.now();
            const contentRange = response.headers.get('content-range') || '';
            const contentType = response.headers.get('content-type') || '';
            const cfRay = response.headers.get('cf-ray') || '';
            const [unit, rangeAndTotal = ''] = contentRange.split(' ');
            const [span = '', totalText = ''] = rangeAndTotal.split('/');
            const [startText = '', endText = ''] = span.split('-');
            const start = Number(startText);
            const end = Number(endText);
            const total = Number(totalText);
            if (response.status !== 206 || unit !== 'bytes' || !Number.isInteger(start)
              || !Number.isInteger(end) || !Number.isInteger(total)) {
              const bodyPreview = new TextDecoder().decode(bytes.slice(0, 600))
                .replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/ig, 'https://[redacted-quick-tunnel]')
                .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
                .replace(/\s+/g, ' ').trim().slice(0, 400);
              throw new Error('invalid Range response: status=' + response.status
                + ' content-range=' + contentRange + ' content-type=' + contentType
                + ' cf-ray=' + cfRay + ' body=' + bodyPreview);
            }
            const bodyBytes = bytes.byteLength;
            completed = {
              requestRange: 'bytes=' + offset + '-', status: response.status, attempt,
              start, end, total, bodyBytes,
              interRequestGapMs: previousFinishedAt === null
                ? null : Number((startedAt - previousFinishedAt).toFixed(1)),
              ttfbMs: Number((headersAt - startedAt).toFixed(1)),
              durationMs: Number((finishedAt - startedAt).toFixed(1)),
              throughputMbps: Number(((bodyBytes * 8 / 1000000) / Math.max(.001, (finishedAt - headersAt) / 1000)).toFixed(2))
            };
            if (start !== offset || end < start || bodyBytes !== end - start + 1 || total !== ${expectedTotal}) {
              throw new Error('non-contiguous Range response: ' + JSON.stringify(completed));
            }
            previousFinishedAt = finishedAt;
            break;
          } catch (error) {
            failures.push({
              offset, attempt,
              durationMs: Number((performance.now() - startedAt).toFixed(1)),
              error: error?.message || String(error)
            });
            if (attempt > ${config.rangeRetries}) {
              throw new Error('Range bytes=' + offset + '- failed after ' + attempt + ' attempts: '
                + (error?.message || String(error)));
            }
            await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** (attempt - 1))));
          }
        }
        segments.push(completed);
        offset = completed.end + 1;
        if (segments.length > 1000) throw new Error('Range continuation did not converge');
      }
      return { ok: true, segments, failures };
    } catch (error) {
      return { ok: false, segments, failures, error: error?.message || String(error), stack: error?.stack || '' };
    } finally {
      if (globalThis.__syncwatchLongPlayRangeController === controller) {
        globalThis.__syncwatchLongPlayRangeController = null;
      }
    }
  })()`;
  try { new Function(`return ${script};`); }
  catch (error) { throw new Error(`invalid Range probe renderer script: ${error.message}`); }
  const outcome = await targetWindow.webContents.executeJavaScript(script, true);
  report.ranges.probeSegments = outcome?.segments || [];
  report.ranges.probeFailures = outcome?.failures || [];
  if (!outcome?.ok) throw new Error(`Chromium Range probe failed: ${outcome?.error || 'unknown error'}\n${outcome?.stack || ''}`);
  return outcome.segments;
}

async function abortBrowserRangeProbe(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  try {
    await targetWindow.webContents.executeJavaScript(`(() => {
      globalThis.__syncwatchLongPlayRangeController?.abort();
      globalThis.__syncwatchLongPlayRangeController = null;
    })()`, true);
  } catch (_) {}
}

async function authenticateBrowserApplication(targetWindow, token) {
  await targetWindow.webContents.executeJavaScript(`(() => {
    localStorage.setItem('syncwatchToken', ${JSON.stringify(token)});
    localStorage.setItem('syncwatchLocationPromptDisabled', '1');
    state.locationPromptDisabled = true;
    state.token = ${JSON.stringify(token)};
    state.rememberSession = true;
    queueSessionResume(false);
  })()`, true);
  await waitForExpression(targetWindow,
    `Boolean(state?.authenticated && state?.socketAuthenticated && state?.room?.id === ${JSON.stringify(TEST_ROOM_ID)})`,
    60000);
}

async function installPlaybackRecorder(targetWindow) {
  return targetWindow.webContents.executeJavaScript(`(() => {
    globalThis.__syncwatchLongPlay?.cleanup?.();
    const video = elements.videoPlayer;
    if (!video) return { ok: false, error: 'application-video-missing' };
    video.muted = true;
    const telemetry = {
      startedAt: performance.now(), events: [], samples: [], maxCurrentTime: 0, handlers: {},
      record(type, detail = {}) {
        const sample = {
          type, atMs: Number((performance.now() - this.startedAt).toFixed(1)),
          currentTime: Number((video.currentTime || 0).toFixed(3)),
          readyState: video.readyState, networkState: video.networkState,
          socketConnected: Boolean(state.socket?.connected),
          socketAuthenticated: Boolean(state.socketAuthenticated),
          mediaFailed: Boolean(state.mediaFailed),
          recoveryAttempts: Number(state.mediaNetworkRecovery?.attempts) || 0,
          waitingForNetwork: Boolean(state.mediaNetworkRecovery?.waitingForNetwork),
          ...detail
        };
        this.maxCurrentTime = Math.max(this.maxCurrentTime, sample.currentTime);
        this.events.push(sample);
      }
    };
    for (const type of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled', 'suspend', 'pause', 'ended']) {
      telemetry.handlers[type] = () => telemetry.record(type);
      video.addEventListener(type, telemetry.handlers[type]);
    }
    telemetry.handlers.error = () => telemetry.record('error', {
      code: video.error?.code || 0,
      message: video.error?.message || ''
    });
    video.addEventListener('error', telemetry.handlers.error);
    telemetry.handlers.socketConnect = () => telemetry.record('socket-connect');
    telemetry.handlers.socketDisconnect = (reason) => telemetry.record('socket-disconnect', { reason: String(reason || '') });
    state.socket?.on('connect', telemetry.handlers.socketConnect);
    state.socket?.on('disconnect', telemetry.handlers.socketDisconnect);
    telemetry.sampleTimer = setInterval(() => {
      telemetry.samples.push({
        atMs: Number((performance.now() - telemetry.startedAt).toFixed(1)),
        currentTime: Number((video.currentTime || 0).toFixed(3)),
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        socketConnected: Boolean(state.socket?.connected),
        socketAuthenticated: Boolean(state.socketAuthenticated),
        mediaFailed: Boolean(state.mediaFailed),
        recoveryKey: String(state.mediaNetworkRecovery?.key || ''),
        recoveryAttempts: Number(state.mediaNetworkRecovery?.attempts) || 0,
        waitingForNetwork: Boolean(state.mediaNetworkRecovery?.waitingForNetwork),
        activeVariant: String(state.activeMediaVariant || ''),
        bufferedAhead: video.buffered.length
          ? Number((Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime)).toFixed(3)) : 0
      });
      telemetry.maxCurrentTime = Math.max(telemetry.maxCurrentTime, video.currentTime || 0);
    }, 1000);
    telemetry.cleanup = () => {
      clearInterval(telemetry.sampleTimer);
      for (const [type, handler] of Object.entries(telemetry.handlers)) {
        if (type === 'socketConnect') state.socket?.off('connect', handler);
        else if (type === 'socketDisconnect') state.socket?.off('disconnect', handler);
        else video.removeEventListener(type, handler);
      }
    };
    globalThis.__syncwatchLongPlay = telemetry;
    return { ok: true, readyState: video.readyState, networkState: video.networkState };
  })()`, true);
}

async function startApplicationPlayback(targetWindow, fileId) {
  await targetWindow.webContents.executeJavaScript(`selectFile(${JSON.stringify(fileId)})`, true);
  await waitForExpression(targetWindow,
    `Boolean(state?.currentFile?.id === ${JSON.stringify(fileId)} && state?.room?.playback?.fileId === ${JSON.stringify(fileId)})`,
    45000);
  // Mark the authoritative room as playing before waiting for metadata. This
  // mirrors a user pressing Play and lets initial-load waiting/error events
  // exercise the same recovery state machine as a mid-film interruption.
  await targetWindow.webContents.executeJavaScript(`sendPlayback('play', Number(elements.videoPlayer.currentTime) || 0)`, true);
  await waitForExpression(targetWindow,
    `Boolean(state?.room?.playback?.isPlaying && elements?.videoPlayer?.readyState >= 1 && !elements?.videoPlayer?.paused && !state?.mediaFailed)`,
    120000);
  return targetWindow.webContents.executeJavaScript(`({
    ok: true,
    currentTime: Number(elements.videoPlayer.currentTime) || 0,
    readyState: elements.videoPlayer.readyState,
    networkState: elements.videoPlayer.networkState,
    socketAuthenticated: Boolean(state.socketAuthenticated)
  })`, true);
}

async function collectPlaybackRecorder(targetWindow) {
  return targetWindow.webContents.executeJavaScript(`(() => {
    const telemetry = globalThis.__syncwatchLongPlay;
    if (!telemetry) return null;
    telemetry.cleanup?.();
    const video = elements.videoPlayer;
    return {
      events: telemetry.events,
      samples: telemetry.samples,
      maxCurrentTime: telemetry.maxCurrentTime,
      final: video ? {
        currentTime: video.currentTime,
        duration: video.duration,
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        ended: video.ended,
        error: video.error ? { code: video.error.code, message: video.error.message || '' } : null
      } : null,
      appState: {
        authenticated: Boolean(state.authenticated),
        socketConnected: Boolean(state.socket?.connected),
        socketAuthenticated: Boolean(state.socketAuthenticated),
        mediaFailed: Boolean(state.mediaFailed),
        currentFileId: String(state.currentFile?.id || ''),
        roomFileId: String(state.room?.playback?.fileId || ''),
        roomPlaying: Boolean(state.room?.playback?.isPlaying),
        activeVariant: String(state.activeMediaVariant || ''),
        recoveryKey: String(state.mediaNetworkRecovery?.key || ''),
        recoveryAttempts: Number(state.mediaNetworkRecovery?.attempts) || 0,
        waitingForNetwork: Boolean(state.mediaNetworkRecovery?.waitingForNetwork)
      }
    };
  })()`, true);
}

async function cleanupBrowserRecorders(targetWindow) {
  await abortBrowserRangeProbe(targetWindow);
  if (!targetWindow || targetWindow.isDestroyed()) return;
  try {
    await targetWindow.webContents.executeJavaScript(`(() => {
      globalThis.__syncwatchLongPlay?.cleanup?.();
    })()`, true);
  } catch (_) {}
}

async function browserRttSample(targetWindow) {
  return targetWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    const socket = state?.socket;
    if (!socket?.connected || !state?.socketAuthenticated) {
      resolve({ ok: false, error: socket?.connected ? 'socket-not-authenticated' : 'socket-disconnected', transport: socket?.io?.engine?.transport?.name || '' });
      return;
    }
    const startedAt = performance.now();
    const timer = setTimeout(() => resolve({
      ok: false, error: 'ack-timeout', latencyMs: Math.round(performance.now() - startedAt),
      transport: socket.io?.engine?.transport?.name || ''
    }), 7000);
    socket.emit('network-ping', { source: 'long-play-smoke' }, (result) => {
      clearTimeout(timer);
      resolve({
        ok: Boolean(result?.success),
        error: result?.success ? '' : (result?.error || 'negative-ack'),
        latencyMs: Math.round(performance.now() - startedAt),
        transport: socket.io?.engine?.transport?.name || ''
      });
    });
  })`, true);
}

function startRttLoop(targetWindow) {
  rttLoopRunning = true;
  rttLoopPromise = (async () => {
    while (rttLoopRunning) {
      const sampleStarted = relativeMs();
      const samplePhase = currentPhase;
      try {
        const sample = await browserRttSample(targetWindow);
        report.socket.samples.push({ atMs: sampleStarted, phase: samplePhase, ...sample });
      } catch (error) {
        report.socket.samples.push({ atMs: sampleStarted, phase: samplePhase, ok: false, error: error.message });
      }
      if (rttLoopRunning) await delay(4000);
    }
  })();
}

async function stopRttLoop() {
  rttLoopRunning = false;
  if (rttLoopPromise) await rttLoopPromise;
}

function assertRangeProbe(segments, totalBytes) {
  assert.ok(segments.length >= 5, `expected at least five continued Range responses, got ${segments.length}`);
  let expectedStart = 0;
  for (const [index, segment] of segments.entries()) {
    assert.equal(segment.status, 206, `Range segment ${index + 1} must return 206`);
    assert.equal(segment.start, expectedStart, `Range segment ${index + 1} is not contiguous`);
    assert.equal(segment.total, totalBytes, `Range segment ${index + 1} reports the wrong total`);
    assert.equal(segment.bodyBytes, segment.end - segment.start + 1,
      `Range segment ${index + 1} Content-Range does not match its body`);
    assert.ok(segment.bodyBytes <= _test.MAX_OPEN_ENDED_MEDIA_RANGE_BYTES,
      `Range segment ${index + 1} exceeds the open-ended limit`);
    if (segment.end < totalBytes - 1) {
      assert.equal(segment.bodyBytes, _test.MAX_OPEN_ENDED_MEDIA_RANGE_BYTES,
        `non-final Range segment ${index + 1} should fill the open-ended limit`);
    }
    expectedStart = segment.end + 1;
  }
  assert.equal(expectedStart, totalBytes, 'continued Range requests did not cover the entire media object');
  report.assertions.push('open-ended Range responses continuously covered a >32 MiB media object');
}

function summarizeReport(outageAtMs, recoveryAtMs) {
  const segmentTtfb = report.ranges.probeSegments.map((segment) => segment.ttfbMs);
  const interRequestGaps = report.ranges.probeSegments.map((segment) => segment.interRequestGapMs);
  const segmentThroughput = report.ranges.probeSegments.map((segment) => segment.throughputMbps);
  report.ranges.summary = {
    segments: report.ranges.probeSegments.length,
    retryFailures: report.ranges.probeFailures.length,
    retryErrorsByType: countErrorTypes(report.ranges.probeFailures.map((failure) => failure.error)),
    coveredBytes: report.ranges.probeSegments.reduce((sum, segment) => sum + segment.bodyBytes, 0),
    interRequestGapMs: summarizeNumbers(interRequestGaps),
    ttfbMs: summarizeNumbers(segmentTtfb),
    throughputMbps: summarizeNumbers(segmentThroughput),
    browserRequestCount: report.ranges.browserRequests.length,
    browserRequestErrors: report.ranges.browserRequests.filter((request) => request.error).length,
    browserErrorsByType: countErrorTypes(report.ranges.browserRequests
      .filter((request) => request.error).map((request) => request.error))
  };

  const successfulRtts = report.socket.samples.filter((sample) => sample.ok && Number.isFinite(sample.latencyMs));
  report.socket.summary = {
    allSamples: report.socket.samples.length,
    successfulSamples: successfulRtts.length,
    failures: report.socket.samples.length - successfulRtts.length,
    latencyMs: summarizeNumbers(successfulRtts.map((sample) => sample.latencyMs)),
    byPhase: Object.fromEntries([...new Set(report.socket.samples.map((sample) => sample.phase))].map((phase) => [
      phase,
      summarizeNumbers(report.socket.samples
        .filter((sample) => sample.phase === phase && sample.ok)
        .map((sample) => sample.latencyMs))
    ]))
  };

  const interesting = new Set(['waiting', 'stalled', 'error']);
  const eventCounts = {};
  for (const event of report.playback.events) eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
  const outageRelativeMs = outageAtMs - report.playback.startedAtMs;
  const recoveryRelativeMs = recoveryAtMs - report.playback.startedAtMs;
  const afterRecovery = report.playback.samples.filter((sample) => sample.atMs >= recoveryRelativeMs);
  const recoveryProgress = summarizeRecoveryProgress(report.playback.samples, recoveryRelativeMs);
  const outageEvents = report.playback.events.filter((event) => interesting.has(event.type)
    && event.atMs >= Math.max(0, outageRelativeMs - 1000)
    && event.atMs <= recoveryRelativeMs + 5000);
  const socketInterrupted = report.playback.events.some((event) => event.type === 'socket-disconnect')
    || report.playback.samples.some((sample) => sample.atMs >= outageRelativeMs
      && sample.atMs <= recoveryRelativeMs + 5000 && !sample.socketAuthenticated);
  const postRecoveryRanges = report.ranges.browserRequests.filter((request) => request.atMs >= recoveryAtMs);
  const failedPostRecoveryRanges = postRecoveryRanges.filter((request) => request.error
    || Number(request.statusCode) >= 400);
  const unrecoveredPostRecoveryRangeErrors = postRecoveryRanges.filter((request, index) => {
    if (!request.error && Number(request.statusCode) < 400) return false;
    return !postRecoveryRanges.slice(index + 1).some((later) => !later.error
      && Number(later.statusCode) >= 200 && Number(later.statusCode) < 400);
  });
  const recoveryStateActivated = report.playback.events.some((event) => event.mediaFailed
    || event.waitingForNetwork || event.recoveryAttempts > 0)
    || report.playback.samples.some((sample) => sample.mediaFailed || sample.waitingForNetwork
      || sample.recoveryAttempts > 0 || sample.recoveryKey);
  const observationRelativeMs = Math.max(0,
    (report.playback.observationStartedAtMs || report.playback.startedAtMs) - report.playback.startedAtMs);
  const observationSamples = report.playback.samples
    .filter((sample) => sample.atMs >= observationRelativeMs);
  const continuity = summarizePlaybackContinuity(observationSamples);
  report.playback.summary = {
    eventCounts,
    interruptionEvents: outageEvents.length,
    socketInterrupted,
    socketReauthenticated: socketInterrupted && afterRecovery.some((sample) => sample.socketAuthenticated),
    recoveryStateActivated,
    postRecoveryPlayingEvents: report.playback.events.filter((event) => event.type === 'playing'
      && event.atMs >= recoveryRelativeMs).length,
    postRecoveryRangeRequests: postRecoveryRanges.length,
    postRecoveryRangeErrors: failedPostRecoveryRanges.length,
    unrecoveredPostRecoveryRangeErrors: unrecoveredPostRecoveryRangeErrors.length,
    maxCurrentTime: report.playback.maxCurrentTime,
    recoveryProgress: Number(recoveryProgress.toFixed(3)),
    continuity,
    final: report.playback.final,
    appState: report.playback.appState
  };
}

async function run() {
  assert.equal(_test.MAX_OPEN_ENDED_MEDIA_RANGE_BYTES, 8 * MIB,
    'the long-play smoke expects the v2.2.4 8 MiB open-ended Range policy');
  const mediaPath = prepareMedia();
  recordPhase('server-start');
  server = await startSyncWatchServer({
    host: '127.0.0.1', port: 0, dataDir, discovery: false,
    publicDir: path.join(ROOT, 'public'), ffprobePath: '', ffmpegPath: '',
    hostControlToken: HOST_TOKEN
  });
  const localBaseUrl = `http://127.0.0.1:${server.port}`;
  faultProxy = await startFaultProxy(server.port);
  const browserLocalBaseUrl = `http://127.0.0.1:${faultProxy.port}`;
  const token = await createSession(localBaseUrl);
  const media = await uploadMedia(localBaseUrl, token, mediaPath);
  const mediaUrl = media.originalUrl || media.url;
  assert.equal(Number(media.size), report.media.bytes, 'uploaded media size changed');
  socket?.close();
  socket = null;
  await delay(150);

  let browserBaseUrl = browserLocalBaseUrl;
  if (config.useQuickTunnel) {
    recordPhase('quick-tunnel-start');
    quickTunnel = await launchQuickTunnel(browserLocalBaseUrl);
    browserBaseUrl = quickTunnel.publicUrl;
    report.tunnel = { publicHost: '[redacted-quick-tunnel]', protocol: config.tunnelProtocol };
  }

  recordPhase('browser-start');
  window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: false,
      sandbox: false
    }
  });
  installRangeRequestCollector(window);
  const initialBrowserUrl = `${browserBaseUrl}/?long-play-network-smoke=1`;
  const verifiedQuickTunnelTarget = Boolean(quickTunnel
    && new URL(initialBrowserUrl).origin === new URL(quickTunnel.publicUrl).origin);
  await loadInitialBrowserUrl(window, initialBrowserUrl, {
    allowTransientRetry: verifiedQuickTunnelTarget,
    onAttempt: (entry) => report.browser.initialLoadAttempts.push(entry)
  });
  await waitForExpression(window, `Boolean(state?.socket?.connected)`, 45000);
  await authenticateBrowserApplication(window, token);
  await attachDevToolsNetwork(window);
  startRttLoop(window);

  if (config.rangeProbeEnabled) {
    recordPhase('range-probe', {
      latencyMs: Math.min(config.latencyMs, 150),
      downloadKbps: config.rangeProbeKbps
    });
    await emulateNetwork(window, {
      latencyMs: Math.min(config.latencyMs, 150),
      downloadKbps: config.rangeProbeKbps
    });
    try {
      report.ranges.probeSegments = await withTimeout(
        runSequentialRangeProbe(window, mediaUrl, token, report.media.bytes),
        config.rangeTimeoutMs,
        'Chromium sequential Range probe'
      );
    } catch (error) {
      await abortBrowserRangeProbe(window);
      throw error;
    }
    assertRangeProbe(report.ranges.probeSegments, report.media.bytes);
  } else {
    recordPhase('range-probe-skipped');
    report.assertions.push('the optional full sequential Range preflight was skipped; formal player Range traffic remained monitored');
  }

  recordPhase('playback-constrained', {
    latencyMs: config.latencyMs,
    downloadKbps: config.constrainedKbps
  });
  await emulateNetwork(window, { latencyMs: config.latencyMs, downloadKbps: config.constrainedKbps });
  report.playback.startedAtMs = relativeMs();
  const recorder = await installPlaybackRecorder(window);
  assert.equal(recorder.ok, true, `application playback recorder did not start: ${JSON.stringify(recorder)}`);
  const playbackStart = await startApplicationPlayback(window, media.id);
  assert.equal(playbackStart.ok, true, `SyncWatch application playback did not start: ${JSON.stringify(playbackStart)}`);
  report.playback.observationStartedAtMs = relativeMs();

  const totalPlaybackMs = Math.round(config.playbackSeconds * 1000);
  const boundedOutageMs = Math.min(config.outageMs, Math.floor(totalPlaybackMs / 2));
  const availablePlaybackMs = totalPlaybackMs - boundedOutageMs;
  const requestedOutageAtMs = config.outageAtSeconds > 0
    ? Math.round(config.outageAtSeconds * 1000)
    : Math.min(15000, Math.max(5000, Math.floor(availablePlaybackMs * 0.2)));
  const beforeOutageMs = boundedOutageMs > 0
    ? Math.max(5000, Math.min(requestedOutageAtMs, availablePlaybackMs - 5000))
    : totalPlaybackMs;
  const afterOutageMs = boundedOutageMs > 0
    ? Math.max(5000, totalPlaybackMs - beforeOutageMs - boundedOutageMs) : 0;
  await delay(beforeOutageMs);

  const outageAtMs = relativeMs();
  let mediaRecoveryExercised = false;
  if (boundedOutageMs > 0) {
    recordPhase('playback-offline', { outageMs: boundedOutageMs });
    faultProxy.setOnline(false);
    await emulateNetwork(window, { offline: true, latencyMs: config.latencyMs, downloadKbps: config.constrainedKbps });
    await delay(boundedOutageMs);
  }

  const recoveryAtMs = relativeMs();
  if (boundedOutageMs > 0) {
    recordPhase('playback-recovery', {
      latencyMs: Math.min(80, config.latencyMs),
      downloadKbps: config.recoveryKbps
    });
    faultProxy.setOnline(true);
    await emulateNetwork(window, {
      latencyMs: Math.min(80, config.latencyMs),
      downloadKbps: config.recoveryKbps
    });
    await delay(afterOutageMs);
  }

  report.playback = {
    ...report.playback,
    ...(await collectPlaybackRecorder(window))
  };
  await stopRttLoop();
  captureTunnelDiagnostics();
  summarizeReport(outageAtMs, recoveryAtMs);

  assert.ok(report.socket.summary.successfulSamples >= 3,
    `too few successful Socket.IO RTT samples: ${report.socket.summary.successfulSamples}`);
  if (boundedOutageMs > 0) {
    assert.ok(report.socket.samples.filter((sample) => sample.phase === 'playback-recovery' && sample.ok).length >= 2,
      'Socket.IO did not recover after the intentional outage');
    assert.ok(report.playback.summary.interruptionEvents >= 1 || report.playback.summary.socketInterrupted,
      'the intentional outage did not interrupt the formal SyncWatch session');
    assert.equal(report.playback.summary.socketInterrupted, true,
      'the intentional outage did not exercise the Socket.IO reconnect path');
    assert.equal(report.playback.summary.socketReauthenticated, true,
      'the formal SyncWatch session did not reauthenticate after reconnect');
    mediaRecoveryExercised = report.playback.summary.recoveryStateActivated
      || report.playback.summary.postRecoveryRangeErrors > 0
      || report.playback.summary.postRecoveryRangeRequests > 0;
    if (mediaRecoveryExercised) {
      assert.ok(report.playback.summary.postRecoveryRangeRequests >= 1,
        'the formal SyncWatch player issued no new Range request after media recovery');
      assert.equal(report.playback.summary.unrecoveredPostRecoveryRangeErrors, 0,
        'the final post-recovery media Range request still failed without a later successful response');
    } else {
      report.assertions.push('the intentional outage was absorbed by buffered media while Socket.IO reauthenticated');
    }
  }
  assert.ok(report.playback.summary.maxCurrentTime >= 1,
    `SyncWatch playback made no measurable progress: ${report.playback.summary.maxCurrentTime}`);
  if (boundedOutageMs > 0) {
    assert.ok(report.playback.summary.recoveryProgress >= 5,
      `SyncWatch playback did not keep advancing after recovery: ${report.playback.summary.recoveryProgress}`);
  }
  assert.equal(report.playback.events.some((event) => event.type === 'error' && [3, 4].includes(Number(event.code))), false,
    'Chromium reported a decode/unsupported-source media error');
  assert.equal(report.playback.final?.error || null, null, 'the formal player retained a terminal media error');
  assert.equal(report.playback.appState?.socketAuthenticated, true, 'the final application socket is not authenticated');
  assert.equal(report.playback.appState?.mediaFailed, false, 'the final application state still marks media as failed');
  assert.equal(report.playback.appState?.recoveryKey, '', 'the media recovery state did not clear after canplay');
  assert.equal(report.playback.appState?.waitingForNetwork, false, 'the player remained stuck waiting for network');
  assert.equal(report.playback.appState?.currentFileId, media.id, 'the application lost the selected media');
  if (assertLongPlaybackAcceptance({
    playbackSeconds: config.playbackSeconds,
    boundedOutageMs,
    playbackSummary: report.playback.summary
  })) {
    report.assertions.push('600-second playback stayed within the maximum no-progress window');
    report.assertions.push('playback kept advancing throughout the final 30-second acceptance window');
    report.assertions.push('the final player and authoritative room state remained actively playing');
  }
  if (quickTunnel) assert.equal(report.tunnel.exitedBeforeCleanup, false, 'cloudflared exited during long playback');
  if (boundedOutageMs > 0) {
    report.assertions.push('the authenticated SyncWatch player, not a detached video element, exercised reconnect and media recovery');
    report.assertions.push(mediaRecoveryExercised
      ? 'Socket.IO reauthenticated and media Range delivery resumed after the intentional outage'
      : 'Socket.IO reauthenticated while the player continued from its existing media buffer');
    report.assertions.push('the formal player advanced for at least five seconds after recovery and cleared its recovery state');
  } else {
    report.assertions.push('the authenticated SyncWatch player was observed without an intentional network outage');
  }
}

async function cleanup() {
  rttLoopRunning = false;
  try { await stopRttLoop(); } catch (_) {}
  if (window && !window.isDestroyed()) {
    await cleanupBrowserRecorders(window);
    try {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    } catch (_) {}
  }
  socket?.close();
  captureTunnelDiagnostics();
  await stopQuickTunnel(quickTunnel).catch(() => {});
  captureTunnelDiagnostics();
  if (faultProxy) await faultProxy.close().catch(() => {});
  if (server) await server.close().catch(() => {});
  if (!config.keepTemp) {
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
    try { fs.rmSync(generatedMediaPath, { force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
  }
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.elapsedMs = Date.now() - startedAt;
  const sanitizedReport = sanitizeReportSnapshot(report);
  fs.mkdirSync(path.dirname(config.reportPath), { recursive: true });
  fs.writeFileSync(config.reportPath, `${JSON.stringify(sanitizedReport, null, 2)}\n`, 'utf8');
  console.log(`[long-play] report=${config.reportPath}`);
}

function scheduleTemporaryRootCleanup() {
  const target = path.resolve(temporaryRoot);
  const temporaryBase = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!target.startsWith(temporaryBase) || !path.basename(target).startsWith('syncwatch-long-play-')) return false;
  const cleanupSource = `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const target = path.resolve(process.argv[1] || '');
    const base = path.resolve(os.tmpdir()) + path.sep;
    if (!target.startsWith(base) || !path.basename(target).startsWith('syncwatch-long-play-')) process.exit(2);
    let attempts = 0;
    const remove = () => {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        process.exit(0);
      } catch (_) {
        attempts += 1;
        if (attempts >= 40) process.exit(1);
        setTimeout(remove, 250);
      }
    };
    remove();
  `;
  const helper = spawn(process.execPath, ['-e', cleanupSource, target], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  helper.unref();
  return true;
}

app.whenReady().then(async () => {
  try {
    await run();
    report.status = 'passed';
    console.log(`[long-play] passed: ${report.ranges.probeSegments.length} Range segments, `
      + `${report.socket.summary.successfulSamples} RTT samples, `
      + `${report.playback.summary.interruptionEvents} playback interruption events`);
  } catch (error) {
    report.status = 'failed';
    report.error = safeError(error);
    process.exitCode = 1;
    console.error('[long-play] failed:', error.stack || error.message);
  } finally {
    await cleanup();
    await writeReport();
    const exitCode = report.status === 'passed' ? 0 : 1;
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(exitCode);
  }
});

app.on('will-quit', () => {
  if (config.keepTemp) {
    console.log(`[long-play] temp=${temporaryRoot}`);
    return;
  }
  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    const scheduled = scheduleTemporaryRootCleanup();
    console.warn(`[long-play] temp cleanup ${scheduled ? 'scheduled after Electron exit' : 'failed'}: `
      + `${temporaryRoot} (${error.code || error.message})`);
  }
});
}
