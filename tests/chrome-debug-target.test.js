'use strict';

const assert = require('node:assert/strict');
const { waitForChromeDebugTarget } = require('./chrome-debug-target');

(async () => {
  let attempts = 0;
  const target = await waitForChromeDebugTarget({
    port: 9222,
    child: { exitCode: null },
    timeoutMs: 1000,
    pollMs: 0,
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connection refused');
      if (attempts === 2) return { ok: true, json: async () => [] };
      return { ok: true, json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1' }] };
    }
  });
  assert.equal(target.webSocketDebuggerUrl, 'ws://127.0.0.1/devtools/page/1');
  assert.equal(attempts, 3, 'CDP discovery must retry startup connection and empty-target states');

  await assert.rejects(waitForChromeDebugTarget({
    port: 9223,
    child: { exitCode: 137 },
    timeoutMs: 1000,
    sleep: async () => {},
    stderrTail: () => 'shared memory exhausted'
  }), /code 137[\s\S]*shared memory exhausted/);

  console.log('Chrome CDP startup retry and exit diagnostics passed.');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
