'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const electronPath = require('electron');
const reportPath = path.join(os.tmpdir(), `syncwatch-app-player-recovery-${process.pid}.json`);
let passed = false;
const environment = {
  ...process.env,
  SYNCWATCH_LONG_PLAY_SECONDS: '110',
  SYNCWATCH_LONG_PLAY_MEDIA_SECONDS: '150',
  SYNCWATCH_LONG_PLAY_VIDEO_KBPS: '1800',
  SYNCWATCH_LONG_PLAY_RANGE_PROBE: '1',
  SYNCWATCH_LONG_PLAY_DOWNLOAD_KBPS: '2100',
  SYNCWATCH_LONG_PLAY_RECOVERY_KBPS: '16000',
  SYNCWATCH_LONG_PLAY_LATENCY_MS: '250',
  // Keep the intentional outage within the same bounded recovery window as
  // the default smoke. A 45s outage can exhaust Chromium's buffered media
  // on hosted runners before the recovered Range path is observable.
  SYNCWATCH_LONG_PLAY_OUTAGE_MS: '25000',
  SYNCWATCH_LONG_PLAY_OUTAGE_AT_SECONDS: '8',
  SYNCWATCH_LONG_PLAY_USE_QUICK_TUNNEL: '0',
  SYNCWATCH_LONG_PLAY_REPORT: reportPath
};
delete environment.ELECTRON_RUN_AS_NODE;

try {
  const result = spawnSync(electronPath, [path.join(__dirname, 'long-play-network-smoke.js')], {
    cwd: root,
    env: environment,
    stdio: 'inherit',
    timeout: 5 * 60 * 1000,
    windowsHide: true
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `application player recovery smoke exited with ${result.status}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.playback?.appState?.socketAuthenticated, true);
  assert.equal(report.playback?.appState?.mediaFailed, false);
  assert.ok(Number(report.playback?.summary?.recoveryProgress) >= 5);
  passed = true;
  console.log('authenticated application player network recovery smoke passed.');
} finally {
  if (passed) {
    try { fs.rmSync(reportPath, { force: true }); } catch (_) {}
  } else if (fs.existsSync(reportPath)) {
    console.error(`application player recovery report retained: ${reportPath}`);
  }
}
