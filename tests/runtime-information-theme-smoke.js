'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, Menu } = require('electron');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-runtime-info-'));
const outputDir = path.join(os.tmpdir(), 'syncwatch-ui-review');
const screenshot = path.join(outputDir, 'runtime-information-silver-screen.png');
process.env.SYNCWATCH_SMOKE_MODE = '1';
process.env.SYNCWATCH_DATA_DIR = dataDir;
process.env.PORT = String(24000 + (process.pid % 10000));

require('../electron-pink');

async function waitFor(callback, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待“${description}”超时`);
}

async function run() {
  const runtimeMenuItem = await waitFor(() => {
    const menu = Menu.getApplicationMenu();
    return menu?.items.find((item) => item.label === '帮助')?.submenu?.items
      .find((item) => item.label === '运行信息') || null;
  }, '应用菜单');
  runtimeMenuItem.click();

  const infoWindow = await waitFor(async () => {
    for (const candidate of BrowserWindow.getAllWindows()) {
      if (candidate.isDestroyed()) continue;
      try {
        const text = await candidate.webContents.executeJavaScript('document.body?.innerText || ""', true);
        if (text.includes('服务器运行信息') && text.includes('局域网地址')) return candidate;
      } catch (_) {}
    }
    return null;
  }, '主题运行信息窗口');

  const metrics = await infoWindow.webContents.executeJavaScript(`(() => {
    const body = getComputedStyle(document.body);
    const panel = getComputedStyle(document.querySelector('main'));
    const button = getComputedStyle(document.querySelector('button'));
    return {
      bodyBackground: body.backgroundColor,
      panelBackground: panel.backgroundColor,
      textColor: body.color,
      buttonBackground: button.backgroundColor,
      buttonColor: button.color,
      title: document.querySelector('h1')?.textContent || '',
      hasDataDirectory: document.body.innerText.includes('数据目录'),
      noOverflow: document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth
    };
  })()`, true);
  assert.notEqual(metrics.bodyBackground, 'rgb(255, 255, 255)');
  assert.notEqual(metrics.panelBackground, 'rgb(255, 255, 255)');
  assert.equal(metrics.buttonBackground, 'rgb(199, 167, 99)');
  assert.match(metrics.title, /SyncWatch同步观影 v2\.2\.9/);
  assert.equal(metrics.hasDataDirectory, true);
  assert.equal(metrics.noOverflow, true);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(screenshot, (await infoWindow.webContents.capturePage()).toPNG());
  await infoWindow.webContents.executeJavaScript("document.querySelector('button').click()", true);
  await waitFor(() => infoWindow.isDestroyed(), '运行信息窗口关闭');
  console.log(`✓ 运行信息使用深色金色主题并可正常关闭，截图：${screenshot}`);
}

async function finish(exitCode) {
  try { BrowserWindow.getAllWindows().forEach((window) => window.destroy()); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) {}
  process.exitCode = exitCode;
  app.quit();
  setTimeout(() => app.exit(exitCode), 2500).unref?.();
}

app.whenReady().then(async () => {
  try { await run(); await finish(0); }
  catch (error) { console.error(error.stack || error.message); await finish(1); }
});

app.on('window-all-closed', () => {});
