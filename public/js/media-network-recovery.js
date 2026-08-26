'use strict';

(function attachMediaNetworkRecoveryPolicy(root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) root.SyncWatchMediaNetworkRecovery = policy;
})(typeof globalThis === 'object' ? globalThis : this, function createMediaNetworkRecoveryPolicy() {
  const DELAYS_MS = Object.freeze([500, 1500, 3500, 7000, 12000]);
  const OFFLINE_RECHECK_MS = 1000;
  const STALL_TIMEOUT_MS = 12000;
  const STABLE_PROGRESS_SECONDS = 3;

  function nextAttempt(completedAttempts) {
    const index = Math.max(0, Math.floor(Number(completedAttempts) || 0));
    if (index >= DELAYS_MS.length) return null;
    return { attempt: index + 1, delayMs: DELAYS_MS[index] };
  }

  function nextStep(completedAttempts, options = {}) {
    const completed = Math.max(0, Math.floor(Number(completedAttempts) || 0));
    if (options.transportReady === false) {
      return { waitingForNetwork: true, attempt: completed, delayMs: OFFLINE_RECHECK_MS };
    }
    const next = nextAttempt(completed);
    return next ? { waitingForNetwork: false, ...next } : null;
  }

  function isEligible({ errorCode, sourceType, source, pageHref }) {
    if (Number(errorCode) !== 2 || sourceType === 'remote') return false;
    try {
      const page = new URL(pageHref);
      const media = new URL(source, page);
      const firstSegment = media.pathname.split('/').filter(Boolean)[0] || '';
      return media.origin === page.origin && ['media', 'compatible-media'].includes(firstSegment);
    } catch (_) {
      return false;
    }
  }

  function isStillStalled(snapshot, current) {
    return Number(current?.readyState) < 3
      && Math.abs((Number(current?.currentTime) || 0) - (Number(snapshot?.currentTime) || 0)) < .5
      && (Number(current?.bufferedAhead) || 0) < (Number(snapshot?.bufferedAhead) || 0) + .75;
  }

  function hasStableProgress(snapshot, current) {
    return Number(current?.readyState) >= 3
      && current?.paused !== true
      && current?.ended !== true
      && current?.seeking !== true
      && Number(current?.elapsedMs) >= STABLE_PROGRESS_SECONDS * 1000
      && (Number(current?.currentTime) || 0) - (Number(snapshot?.currentTime) || 0) >= STABLE_PROGRESS_SECONDS;
  }

  return Object.freeze({
    MAX_ATTEMPTS: DELAYS_MS.length,
    DELAYS_MS,
    OFFLINE_RECHECK_MS,
    STALL_TIMEOUT_MS,
    STABLE_PROGRESS_SECONDS,
    nextAttempt,
    nextStep,
    isEligible,
    isStillStalled,
    hasStableProgress
  });
});
