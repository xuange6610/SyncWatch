'use strict';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForChromeDebugTarget({
  port,
  child,
  timeoutMs = 30000,
  pollMs = 200,
  fetchImpl = fetch,
  sleep = delay,
  stderrTail = () => ''
}) {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Chrome exited before CDP was ready (code ${child.exitCode}). ${String(stderrTail() || '').trim()}`.trim());
    }
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = Array.isArray(targets) ? targets.find((entry) => entry?.type === 'page' && entry.webSocketDebuggerUrl) : null;
        if (target) return target;
        lastError = 'CDP returned no page target';
      } else lastError = `CDP returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(pollMs);
  }
  const diagnostics = String(stderrTail() || '').trim();
  throw new Error(`Chrome CDP was not ready within ${timeoutMs}ms${lastError ? `: ${lastError}` : ''}${diagnostics ? `\n${diagnostics}` : ''}`);
}

module.exports = { waitForChromeDebugTarget };
