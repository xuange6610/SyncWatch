'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { startSyncWatchServer } = require('../server');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-close-theme-'));
let server;
let window;

function relativeLuminance(rgb) {
  const channels = rgb.match(/[\d.]+/g).slice(0, 3).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function waitFor(expression, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await window.webContents.executeJavaScript(expression, true)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${expression}`);
}

app.whenReady().then(async () => {
  server = await startSyncWatchServer({
    host: '127.0.0.1', port: 0, dataDir, publicDir: path.resolve(__dirname, '..', 'public'),
    ffprobePath: '', ffmpegPath: '', hostControlToken: 'close-theme-smoke'
  });
  window = new BrowserWindow({
    show: true, width: 920, height: 680,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  await window.loadURL(`http://127.0.0.1:${server.port}/#host=close-theme-smoke`);
  await waitFor(`document.readyState === 'complete' && document.documentElement.dataset.uiTheme === 'silver-screen'`);
  const result = await window.webContents.executeJavaScript(`(() => {
    showDesktopClosePrompt();
    const modal = document.getElementById('desktopCloseModal');
    const card = modal.querySelector('.desktop-close-card');
    const minimize = modal.querySelector('[data-desktop-close="minimize"]');
    const minimizeDescription = minimize.querySelector('small');
    const style = getComputedStyle(card);
    return {
      visible: !modal.classList.contains('is-hidden'),
      buttons: modal.querySelectorAll('[data-desktop-close]').length,
      newServer: modal.querySelector('[data-desktop-close="new-server"]')?.textContent.includes('打开新的服务器'),
      background: style.backgroundColor,
      borderColor: style.borderTopColor,
      textColor: style.color,
      minimizeBackground: getComputedStyle(minimize).backgroundColor,
      minimizeDescriptionColor: getComputedStyle(minimizeDescription).color,
      theme: document.documentElement.dataset.uiTheme
    };
  })()`, true);
  assert.equal(result.visible, true);
  assert.equal(result.buttons, 5);
  assert.equal(result.newServer, true);
  assert.notEqual(result.background, 'rgb(255, 255, 255)');
  assert.equal(result.theme, 'silver-screen');
  assert.ok(contrastRatio(result.minimizeDescriptionColor, result.minimizeBackground) >= 4.5,
    `最小化到托盘说明文字对比度不足：${result.minimizeDescriptionColor} / ${result.minimizeBackground}`);
  const outputDir = path.join(os.tmpdir(), 'syncwatch-ui-review');
  fs.mkdirSync(outputDir, { recursive: true });
  const screenshot = path.join(outputDir, 'desktop-close-silver-screen.png');
  window.show();
  window.focus();
  await new Promise((resolve) => setTimeout(resolve, 350));
  fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
  console.log(`✓ 银幕典藏主题退出弹窗显示正常（${result.background}，金色边框 ${result.borderColor}），截图：${screenshot}`);
  await server.close();
  server = null;
  app.quit();
}).catch(async (error) => {
  console.error(error.stack || error.message);
  try { await server?.close(); } catch (_) {}
  app.exit(1);
});

app.on('window-all-closed', () => {});
