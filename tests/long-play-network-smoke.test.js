'use strict';

const assert = require('node:assert/strict');
const {
  assertLongPlaybackAcceptance,
  isTransientInitialLoadError,
  loadInitialBrowserUrl,
  sanitizeReportSnapshot,
  summarizePlaybackContinuity
} = require('./long-play-network-smoke');

async function testInitialLoadRetry() {
  assert.equal(isTransientInitialLoadError(Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), { code: -100 })), true);
  assert.equal(isTransientInitialLoadError(new Error('net::ERR_CONNECTION_RESET (-101)')), true);
  assert.equal(isTransientInitialLoadError(new Error('net::ERR_TIMED_OUT (-118)')), true);
  assert.equal(isTransientInitialLoadError(new Error('net::ERR_NAME_NOT_RESOLVED (-105)')), false);

  const calls = [];
  const waits = [];
  const transientErrors = [
    Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), { code: -100 }),
    Object.assign(new Error('net::ERR_CONNECTION_RESET'), { code: -101 })
  ];
  const targetWindow = {
    async loadURL(url) {
      calls.push(url);
      if (transientErrors.length) throw transientErrors.shift();
    }
  };
  const attempts = [];
  const result = await loadInitialBrowserUrl(targetWindow, 'https://verified.trycloudflare.com/?probe=1', {
    allowTransientRetry: true,
    retryDelaysMs: [10, 20, 30],
    sleep: async (milliseconds) => waits.push(milliseconds),
    onAttempt: (entry) => attempts.push(entry)
  });
  assert.equal(result.attempts, 3);
  assert.deepEqual(calls, Array(3).fill('https://verified.trycloudflare.com/?probe=1'));
  assert.deepEqual(waits, [10, 20]);
  assert.deepEqual(attempts.map((entry) => entry.ok), [false, false, true]);

  const permanent = new Error('net::ERR_CERT_AUTHORITY_INVALID');
  let permanentCalls = 0;
  await assert.rejects(loadInitialBrowserUrl({
    async loadURL() {
      permanentCalls += 1;
      throw permanent;
    }
  }, 'https://verified.trycloudflare.com/', {
    allowTransientRetry: true,
    sleep: async () => assert.fail('non-transient load errors must not wait or retry')
  }), (error) => error === permanent);
  assert.equal(permanentCalls, 1);
}

function testReportSanitization() {
  const rawToken = 'plain-secret-token';
  const snapshot = sanitizeReportSnapshot({
    tunnel: {
      publicHost: 'private-words.trycloudflare.com',
      logTail: `dest=https://private-words.trycloudflare.com/media/a.mp4?syncwatch_token=${rawToken} `
        + 'ipv4=192.0.2.50 ipv6=2001:db8:85a3::8a2e:370:7334'
    },
    playback: {
      samples: [{ recoveryKey: `file:https://private-words.trycloudflare.com/media/a.mp4?syncwatch_token=${rawToken}&v=1` }],
      appState: { recoveryKey: `file:/media/a.mp4?syncwatch_token=${rawToken}` }
    },
    error: {
      stack: `fetch https://private-words.trycloudflare.com/?syncwatch_token=${rawToken}`,
      message: `request failed at /path?access_token=${rawToken}`
    }
  });
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /private-words\.trycloudflare\.com/i);
  assert.doesNotMatch(serialized, new RegExp(rawToken, 'i'));
  assert.doesNotMatch(serialized, /192\.0\.2\.50|2001:db8/i);
  assert.match(serialized, /\[redacted-quick-tunnel\]/);
  assert.match(serialized, /syncwatch_token=\[redacted-token\]/);
  assert.match(serialized, /access_token=\[redacted-token\]/);
  assert.match(serialized, /\[redacted-ip\]/);
}

function makeSamples({ durationSeconds, stalledFrom = -1, stalledUntil = -1 }) {
  return Array.from({ length: durationSeconds + 1 }, (_, second) => {
    const stalledSeconds = second > stalledFrom
      ? Math.max(0, Math.min(second, stalledUntil) - stalledFrom) : 0;
    return { atMs: second * 1000, currentTime: second - stalledSeconds };
  });
}

function testLongPlaybackAcceptance() {
  const healthySamples = makeSamples({ durationSeconds: 600, stalledFrom: 120, stalledUntil: 165 });
  const continuity = summarizePlaybackContinuity(healthySamples);
  assert.ok(continuity.longestNoProgressMs >= 45000);
  assert.ok(continuity.tailProgressSeconds >= 29);
  assert.ok(continuity.tailLongestNoProgressMs <= 2000);

  const healthySummary = {
    continuity,
    final: { paused: false, ended: false },
    appState: { roomPlaying: true }
  };
  assert.equal(assertLongPlaybackAcceptance({
    playbackSeconds: 600,
    boundedOutageMs: 45000,
    playbackSummary: healthySummary
  }), true);

  assert.equal(assertLongPlaybackAcceptance({
    playbackSeconds: 110,
    boundedOutageMs: 45000,
    playbackSummary: {
      continuity: summarizePlaybackContinuity([]),
      final: { paused: true, ended: true },
      appState: { roomPlaying: false }
    }
  }), false, 'short recovery smoke must not inherit 600-second continuity assertions');

  const stalledTail = makeSamples({ durationSeconds: 600, stalledFrom: 565, stalledUntil: 600 });
  assert.throws(() => assertLongPlaybackAcceptance({
    playbackSeconds: 600,
    boundedOutageMs: 45000,
    playbackSummary: {
      continuity: summarizePlaybackContinuity(stalledTail),
      final: { paused: false, ended: false },
      appState: { roomPlaying: true }
    }
  }), /last 30 seconds/);

  const excessiveMidPlaybackStall = makeSamples({ durationSeconds: 600, stalledFrom: 200, stalledUntil: 300 });
  assert.throws(() => assertLongPlaybackAcceptance({
    playbackSeconds: 600,
    boundedOutageMs: 45000,
    playbackSummary: {
      continuity: summarizePlaybackContinuity(excessiveMidPlaybackStall),
      final: { paused: false, ended: false },
      appState: { roomPlaying: true }
    }
  }), /stopped progressing/);

  assert.throws(() => assertLongPlaybackAcceptance({
    playbackSeconds: 600,
    boundedOutageMs: 45000,
    playbackSummary: {
      continuity,
      final: { paused: true, ended: false },
      appState: { roomPlaying: true }
    }
  }), /paused/);

  assert.throws(() => assertLongPlaybackAcceptance({
    playbackSeconds: 600,
    boundedOutageMs: 45000,
    playbackSummary: {
      continuity,
      final: { paused: false, ended: true },
      appState: { roomPlaying: true }
    }
  }), /ended/);

  assert.throws(() => assertLongPlaybackAcceptance({
    playbackSeconds: 600,
    boundedOutageMs: 45000,
    playbackSummary: {
      continuity,
      final: { paused: false, ended: false },
      appState: { roomPlaying: false }
    }
  }), /authoritative room/);
}

(async () => {
  await testInitialLoadRetry();
  testReportSanitization();
  testLongPlaybackAcceptance();
  console.log('long-play network smoke helpers passed.');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
