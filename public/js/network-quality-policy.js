'use strict';

(function attachNetworkQualityPolicy(root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) root.SyncWatchNetworkQuality = policy;
})(typeof globalThis === 'object' ? globalThis : this, function createNetworkQualityPolicy() {
  const HIGH_LATENCY_MS = 500;
  const DEGRADE_AFTER = 3;
  const RECOVER_AFTER = 2;

  function classifySample(sample = {}, highLatencyMs = HIGH_LATENCY_MS) {
    const latencyMs = Number(sample.latencyMs ?? sample.latency);
    const timedOut = sample.timedOut === true || sample.sampleStatus === 'timeout';
    const highLatency = Number.isFinite(latencyMs) && latencyMs > highLatencyMs;
    return {
      abnormal: timedOut || highLatency,
      sampleStatus: timedOut ? 'timeout' : highLatency ? 'high-latency' : 'healthy',
      latencyMs: Number.isFinite(latencyMs) ? Math.max(0, latencyMs) : null
    };
  }

  function createTracker(options = {}) {
    const highLatencyMs = Math.max(1, Number(options.highLatencyMs) || HIGH_LATENCY_MS);
    const degradeAfter = Math.max(1, Math.floor(Number(options.degradeAfter) || DEGRADE_AFTER));
    const recoverAfter = Math.max(1, Math.floor(Number(options.recoverAfter) || RECOVER_AFTER));
    let state = options.initialState === 'unstable' ? 'unstable' : 'online';
    let consecutiveAbnormal = 0;
    let consecutiveHealthy = 0;

    function snapshot(extra = {}) {
      return {
        state, consecutiveAbnormal, consecutiveHealthy,
        highLatencyMs, degradeAfter, recoverAfter, ...extra
      };
    }

    return {
      observe(sample = {}) {
        const classified = classifySample(sample, highLatencyMs);
        const previousState = state;
        if (classified.abnormal) {
          consecutiveAbnormal += 1;
          consecutiveHealthy = 0;
          if (consecutiveAbnormal >= degradeAfter) state = 'unstable';
        } else {
          consecutiveHealthy += 1;
          consecutiveAbnormal = 0;
          if (state === 'unstable' && consecutiveHealthy >= recoverAfter) state = 'online';
        }
        return snapshot({ ...classified, changed: state !== previousState });
      },
      reset(nextState = 'online') {
        state = nextState === 'unstable' ? 'unstable' : 'online';
        consecutiveAbnormal = 0;
        consecutiveHealthy = 0;
        return snapshot({ changed: false });
      },
      snapshot
    };
  }

  function roomStatus({ authenticated = false, socketConnected = false, socketAuthenticated = false, localConnectionState = 'online', members = [] } = {}) {
    if (authenticated && (!socketConnected || !socketAuthenticated)) {
      return { state: 'disconnected', label: '连接中断', healthy: false };
    }
    if (localConnectionState === 'unstable'
      || Array.isArray(members) && members.some((member) => member?.connectionState === 'unstable')) {
      return { state: 'unstable', label: '网络波动', healthy: false };
    }
    return { state: 'healthy', label: '同步正常', healthy: true };
  }

  return Object.freeze({
    HIGH_LATENCY_MS, DEGRADE_AFTER, RECOVER_AFTER,
    classifySample, createTracker, roomStatus
  });
});
