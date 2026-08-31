'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const html = read('public/index.html');
const css = read('public/css/style.css');
const app = read('public/js/app.js');
const server = read('server/index.js');
const electron = read('electron-pink.js');

// Highest-capability defaults remain honest: request the detected device rate,
// then display the track settings actually granted by the OS/browser.
assert.match(html, /id="desktopShareResolution"[\s\S]{0,180}<option value="native" selected>/);
assert.match(html, /id="desktopShareFps"[\s\S]{0,500}<option value="device" selected>[\s\S]*value="120"[\s\S]*value="144"[\s\S]*value="165"[\s\S]*value="240"/);
assert.match(html, /id="desktopShareQuality"[\s\S]{0,240}<option value="ultra" selected>/);
assert.match(html, /id="desktopShareSystemAudio"[^>]*checked/);
assert.match(html, /id="desktopShareActualStatus"/);
assert.match(app, /DEFAULT_DESKTOP_SHARE_SETTINGS[\s\S]{0,180}fps:\s*'device'[\s\S]{0,180}quality:\s*'ultra'/);
assert.match(app, /Math\.min\(240,[^\n]+desktopShare/);
assert.match(app, /getSettings\(\)[\s\S]{0,500}frameRate/);
assert.match(app, /实际捕获[^`'"\n]*\$\{[^}]*actualFps/);

// The primary WebRTC stream must not compete with full-resolution JPEG relay.
assert.match(app, /screenFallbackViewerCount/);
assert.match(app, /screen-share-transport-state/);
assert.match(app, /peer\.connectionState === 'disconnected'[\s\S]{0,500}transport: 'fallback'/);
assert.match(app, /screen-share-fallback-state/);
assert.match(server, /screenWebrtcViewers:\s*new Set\(\)/);
assert.match(server, /onSafe\('screen-share-transport-state'/);
assert.match(server, /screenWebrtcViewers\.has\(targetSocket\.id\)/);
assert.match(app, /fallbackScreenCaptureSize/);
assert.doesNotMatch(app, /balanced:\s*6_000_000,\s*high:\s*14_000_000,\s*ultra:\s*28_000_000/);

// Audio fallback is interactive, ~20 ms, compact PCM and recoverable after an
// autoplay block on mobile/web.
assert.match(app, /new AudioContext\(\{ latencyHint: 'interactive', sampleRate: 48000 \}\)/);
assert.match(app, /createScriptProcessor\(1024,/);
assert.match(app, /new Int16Array\(/);
assert.match(app, /sampleFormat:\s*'s16'/);
assert.match(app, /function unlockSharedAudio\(/);
assert.match(html, /id="audioShareRoomStatus"/);
assert.match(html, /id="unlockSharedAudioBtn"/);
assert.match(css, /\.audio-share-room-status/);
assert.match(css, /\.audio-share-room-status[^\n]+bottom:\s*var\(--audio-share-bottom, 58px\)/);
assert.match(app, /playerContainer\?\.classList\.toggle\('audio-share-active', active\)/);
assert.match(app, /function updateAudioShareLayout\([\s\S]{0,900}progress\.getBoundingClientRect\(\)\.height/);

// Room audio state includes only sanitized display metadata, never a local
// absolute path, and is cleared room-wide on stop.
for (const field of ['processName', 'mediaTitle', 'sourceKind']) {
  assert.match(app, new RegExp(field));
  assert.match(server, new RegExp(field));
}
assert.match(server, /sanitizeAudioSourceMetadata/);
assert.match(server, /audioShare = \{ active: false,[^\n]+processName: ''[^\n]+mediaTitle: ''/);

// Ending a live webpage capture clears screen state and URL metadata together.
assert.match(server, /function stopScreenShare\([\s\S]{0,1500}webShare\?\.active[\s\S]{0,300}webShare\.mode === 'live'/);
assert.match(server, /screen-share-stop[\s\S]{0,220}stopScreenShare\(socket\.id/);
assert.match(app, /stopLocalCapture\([\s\S]{0,900}stopLiveWebShare/);

// Same-theme clients auto-acknowledge without a desktop notification or dialog;
// accept/reject outcomes remain bottom-right toasts for the requester.
assert.match(app, /enqueueThemeSyncRequest\([\s\S]{0,650}themeId === state\.uiTheme[\s\S]{0,300}alreadyApplied:\s*true/);
assert.match(app, /handleThemeSyncResponse\([\s\S]{0,500}已拒绝/);
assert.match(server, /accepted, alreadyApplied, username:/);
assert.match(server, /description\?\.type === 'offer'[\s\S]{0,260}socket\.id !== sharerSocketId/);
assert.match(server, /description\?\.type === 'answer'[\s\S]{0,260}targetSocketId !== sharerSocketId/);
assert.match(server, /resumedAudioShare[\s\S]{0,300}audioShare\.socketId = socket\.id/);

// The splash remains visible until the real local page has loaded and is ready;
// transient local load failures use bounded retries instead of a false failure.
assert.match(electron, /async function loadMainWindowWithRetry\(/);
assert.match(electron, /async function createMainWindow\(/);
assert.match(electron, /await loadMainWindowWithRetry\(/);
assert.match(electron, /await createMainWindow\(\)/);
assert.doesNotMatch(electron, /setTimeout\(\(\) => \{ if \(splashWindow[^\n]+450\)/);
assert.match(electron, /ready-to-show[\s\S]{0,500}splashWindow\?\.close\(\)/);

console.log('sharing performance, state cleanup, theme response and startup lifecycle contracts passed');
