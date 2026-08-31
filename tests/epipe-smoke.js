'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const electronPath = require('electron');
const childEntry = path.join(__dirname, 'epipe-electron-child.js');

function assertElectronEntryGuards() {
  const directEntries = fs.readdirSync(__dirname)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => {
      const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
      return source.includes("require('electron')") || source.includes("require('../electron-pink')");
    });
  const entryFiles = [...new Set([
    ...directEntries,
    // artifact-smoke launches the packaged Electron EXE. android-package can
    // use Electron's executable in ELECTRON_RUN_AS_NODE mode as its runtime.
    'artifact-smoke.js',
    'android-package.test.js'
  ])];

  for (const name of entryFiles.filter((entry) => entry !== 'epipe-electron-child.js')) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    const guardIndex = source.indexOf("require('./epipe-guard')");
    const electronIndexes = [
      source.indexOf("require('electron')"),
      source.indexOf("require('../electron-pink')")
    ].filter((index) => index >= 0);
    const electronIndex = electronIndexes.length ? Math.min(...electronIndexes) : Number.POSITIVE_INFINITY;
    const consoleIndex = source.search(/\bconsole\.(?:log|info|warn|error|debug)\s*\(/);
    assert.ok(guardIndex >= 0, `${name}: 缺少 tests/epipe-guard`);
    assert.ok(guardIndex < electronIndex, `${name}: 必须在加载 Electron 前安装 EPIPE 防护`);
    if (consoleIndex >= 0) assert.ok(guardIndex < consoleIndex, `${name}: 必须在首次 console 输出前安装 EPIPE 防护`);
  }

  // This helper deliberately has two branches. The test-entry branch installs
  // the shared guard before Electron; the production branch delegates to the
  // production main entry so the smoke test can independently verify its own
  // inline guard instead of accidentally pre-installing the test guard.
  const childSource = fs.readFileSync(childEntry, 'utf8');
  const testBranchIndex = childSource.indexOf("mode === 'test-entry'");
  const childGuardIndex = childSource.indexOf("require('./epipe-guard')", testBranchIndex);
  const childElectronIndex = childSource.indexOf("require('electron')", testBranchIndex);
  assert.ok(testBranchIndex >= 0 && childGuardIndex > testBranchIndex && childGuardIndex < childElectronIndex,
    'epipe-electron-child.js: test-entry 分支必须先安装 EPIPE 防护');
  assert.equal(childSource.search(/\bconsole\.(?:log|info|warn|error|debug)\s*\(/), -1,
    'epipe-electron-child.js: 安装分支防护前不得 console 输出');
  assert.match(childSource, /record\('smoke', 'force-exit'\);\s*process\.exit\(0\);/,
    'epipe-electron-child.js: production smoke 必须保留有界强制退出与生命周期证据');
  assert.doesNotMatch(childSource, /forceExitTimer\.unref|setTimeout\(\(\) => \{[\s\S]*?record\('smoke', 'force-exit'\)[\s\S]*?\}\s*,\s*5000\)\.unref/,
    'epipe-electron-child.js: Windows Electron 仅剩原生消息循环时不得 unref 强制退出计时器');

  const productionSource = fs.readFileSync(path.resolve(__dirname, '..', 'electron-pink.js'), 'utf8');
  const productionGuardIndex = productionSource.indexOf('process.stdout');
  const productionElectronIndex = productionSource.indexOf("require('electron')");
  assert.ok(productionGuardIndex >= 0 && productionGuardIndex < productionElectronIndex,
    'electron-pink.js: 生产入口必须在加载 Electron 前安装 EPIPE 防护');
  assert.match(productionSource, /SYNCWATCH_EPIPE_CASE === 'production'\) process\.exit\(0\);/,
    'electron-pink.js: production EPIPE smoke 必须在 Electron 生命周期阻塞前直接退出');
  assert.match(productionSource, /setTimeout\(exitSmoke, Math\.max\(500, Number\(process\.env\.SYNCWATCH_SMOKE_EXIT_MS\) \|\| 2000\)\);/,
    'electron-pink.js: production smoke 退出计时器必须保持引用并实际调度');
  assert.doesNotMatch(productionSource, /timer = setTimeout\(resolve, 2000\);\s*timer\.unref\?\./,
    'electron-pink.js: updateSplash 超时计时器必须保持引用并实际调度');
  const splashExecutionIndex = productionSource.indexOf('splashWindow.webContents.executeJavaScript(script, true)');
  const splashTimerIndex = productionSource.indexOf('timer = setTimeout(resolve, 2000);');
  assert.ok(splashTimerIndex >= 0 && splashTimerIndex < splashExecutionIndex,
    'electron-pink.js: updateSplash 必须在调用渲染器脚本前安排超时计时器');
  return entryFiles.length;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => (value, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value, signal);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Electron PID ${child.pid} did not exit after ${timeoutMs}ms; a modal main-process error may be blocking shutdown`));
    }, timeoutMs);
    child.once('error', finish(reject));
    child.once('exit', finish((code, signal) => resolve({ code, signal })));
  });
}

async function runCase(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `syncwatch-epipe-${mode}-`));
  const marker = path.join(root, 'epipe-events.txt');
  const port = await reservePort();
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(electronPath, [
      childEntry,
      `--port=${port}`,
      `--user-data-dir=${path.join(root, 'electron-profile')}`
    ], {
      cwd: path.resolve(__dirname, '..'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SYNCWATCH_EPIPE_CASE: mode,
        SYNCWATCH_EPIPE_PROBE_FILE: marker,
        SYNCWATCH_SMOKE_MODE: '1',
        SYNCWATCH_SMOKE_EXIT_MS: '1600',
        SYNCWATCH_DATA_DIR: path.join(root, 'SyncWatch同步观影-Data')
      }
    });

    // Closing the parent's read ends recreates the exact broken-pipe condition
    // seen when a terminal/test runner exits before Electron finishes logging.
    child.stdout.destroy();
    child.stderr.destroy();

    let result;
    try {
      result = await waitForExit(child, 20_000);
    } catch (error) {
      const events = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().replace(/\r?\n/g, ', ') : 'none';
      error.message = `${mode}: ${error.message}; lifecycle=${events}`;
      throw error;
    }
    assert.equal(result.signal, null, `${mode}: Electron was terminated by ${result.signal}`);
    assert.equal(result.code, 0, `${mode}: Electron exited with code ${result.code}`);

    const events = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    assert.match(events, /^stdout:(?:emit|throw)$/m, `${mode}: stdout did not produce a verified EPIPE`);
    assert.match(events, /^stderr:(?:emit|throw)$/m, `${mode}: stderr did not produce a verified EPIPE`);
    return Date.now() - startedAt;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
  }
}

async function main() {
  const auditedEntries = assertElectronEntryGuards();
  if (process.platform !== 'win32') {
    console.log(`✓ EPIPE 静态审计通过：${auditedEntries} 个 Electron 测试入口；真实 Windows 断管与退出验证由 Windows release runner 执行`);
    return;
  }
  const productionMs = await runCase('production');
  const testEntryMs = await runCase('test-entry');
  console.log(`✓ EPIPE 回归通过：静态审计 ${auditedEntries} 个 Electron 测试入口；生产主入口 ${productionMs}ms、测试入口 ${testEntryMs}ms；父进程关闭 stdout/stderr 后均触发真实 EPIPE、无错误弹窗并以 0 退出`);
}

main().catch((error) => {
  console.error('EPIPE 回归失败:', error);
  process.exitCode = 1;
});
