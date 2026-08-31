'use strict';

const fs = require('fs');

const probeFile = process.env.SYNCWATCH_EPIPE_PROBE_FILE;
const mode = process.env.SYNCWATCH_EPIPE_CASE;

if (!probeFile) throw new Error('SYNCWATCH_EPIPE_PROBE_FILE is required');

function record(label, source) {
  try { fs.appendFileSync(probeFile, `${label}:${source}\n`, 'utf8'); } catch (_) {}
}

// Observe the real stream failure without registering an error listener here:
// the target entry must install its own guard.  Calling the original emit
// preserves the exact handled/unhandled behavior under test.
for (const [label, stream] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
  if (!stream) continue;
  const originalEmit = stream.emit;
  stream.emit = function probedEmit(event, ...arguments_) {
    if (event === 'error' && arguments_[0]?.code === 'EPIPE') record(label, 'emit');
    return Reflect.apply(originalEmit, this, [event, ...arguments_]);
  };
  const originalWrite = stream.write;
  stream.write = function probedWrite(...arguments_) {
    try {
      return Reflect.apply(originalWrite, this, arguments_);
    } catch (error) {
      if (error?.code === 'EPIPE') record(label, 'throw');
      throw error;
    }
  };
}

if (mode === 'production') {
  require('../electron-pink');
  const { app } = require('electron');
  record('child', 'production-loaded');
  let beforeQuitCount = 0;
  app.whenReady().then(() => record('app', 'ready'));
  app.on('browser-window-created', () => record('app', 'browser-window-created'));
  app.on('before-quit', () => record('app', `before-quit-${++beforeQuitCount}`));
  app.on('will-quit', () => record('app', 'will-quit'));
  app.on('quit', () => record('app', 'quit'));
  process.on('exit', (code) => record('process', `exit-${code}`));
  // Hosted Windows runners can leave a hidden renderer alive after the
  // production smoke requests graceful shutdown. Keep that test-only path
  // bounded while preserving the app's normal app.quit() behavior first.
  setTimeout(() => {
    record('smoke', 'force-exit');
    process.exit(0);
  }, 5000);
} else if (mode === 'test-entry') {
  require('./epipe-guard');
  const { app } = require('electron');
  app.whenReady().then(() => {
    setTimeout(() => app.exit(0), 1200).unref?.();
  });
} else {
  throw new Error(`Unknown SYNCWATCH_EPIPE_CASE: ${mode}`);
}

// Separate timers guarantee that both descriptors are exercised even if a
// runtime chooses to throw synchronously for one of them.
const payload = Buffer.alloc(256 * 1024, 0x78);
for (const stream of [process.stdout, process.stderr]) {
  const timer = setInterval(() => stream?.write?.(payload), 40);
  timer.unref?.();
  setTimeout(() => clearInterval(timer), 1000).unref?.();
}
