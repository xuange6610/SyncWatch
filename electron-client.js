const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const { app, BrowserWindow, clipboard, dialog, shell, session, ipcMain, desktopCapturer } = require('electron');

const APP_VERSION = 'v2.3.3';
const APP_NAME = 'SyncWatch同步观影';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.xuan.syncwatch.client');
let mainWindow = null;
let trustedServerOrigin = '';
const launcherUrl = pathToFileURL(path.join(__dirname, 'client-launcher.html')).toString();
const allowedWebPermissions = new Set(['media', 'display-capture', 'geolocation', 'fullscreen', 'notifications']);
const MAX_LOGIN_MODEL_BYTES = 25 * 1024 * 1024;

function iconPath() {
  return path.join(__dirname, 'assets', 'app-icon.ico');
}

function scanVisibleWindowsPrograms() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { [PSCustomObject]@{ pid = $_.Id; processName = $_.ProcessName; title = $_.MainWindowTitle } } | ConvertTo-Json -Compress'
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024, encoding: 'utf8'
    }, (error, stdout) => {
      if (error || !String(stdout || '').trim()) return resolve([]);
      try {
        const parsed = JSON.parse(String(stdout).trim());
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolve(rows.map((row) => ({
          id: `process:${Math.max(0, Number(row.pid) || 0)}`,
          name: String(row.title || row.processName || '未命名程序').trim(),
          processName: String(row.processName || '').trim(), kind: 'process', displayId: '', captureSourceId: ''
        })).filter((source) => source.id !== 'process:0' && source.name).slice(0, 200));
      } catch (_) { resolve([]); }
    });
  });
}

function mergeDesktopAudioSources(captureSources = [], programSources = []) {
  const normalized = captureSources.map((source) => ({
    id: String(source.id || ''), name: String(source.name || '未命名窗口').trim() || '未命名窗口',
    displayId: String(source.display_id || ''), kind: source.id?.startsWith('window:') ? 'window' : 'screen',
    captureSourceId: String(source.id || ''), processName: ''
  })).filter((source) => source.id);
  const capturedNames = normalized.map((source) => source.name.toLocaleLowerCase());
  for (const source of programSources) {
    const title = source.name.toLocaleLowerCase();
    const processName = source.processName.toLocaleLowerCase();
    if (capturedNames.some((name) => name === title || (title.length > 3 && name.includes(title)) || (processName.length > 3 && name.includes(processName)))) continue;
    normalized.push(source);
  }
  return normalized.map((source) => ({
    ...source,
    musicApp: /汽水|qishui|soda|网易云|cloudmusic|netease|qq\s*音乐|qqmusic|酷狗|kugou/i.test(`${source.name} ${source.processName}`)
  })).sort((left, right) => Number(right.musicApp) - Number(left.musicApp)
    || ({ process: 0, window: 1, screen: 2 }[left.kind] ?? 3) - ({ process: 0, window: 1, screen: 2 }[right.kind] ?? 3)
    || left.name.localeCompare(right.name, 'zh-CN'));
}

function normalizeServerAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.toString();
  } catch (_) { return ''; }
}

function normalizedOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '';
  } catch (_) { return ''; }
}

function isLauncherUrl(value) {
  try {
    const candidate = new URL(String(value || ''));
    const launcher = new URL(launcherUrl);
    return candidate.protocol === 'file:' && candidate.pathname === launcher.pathname;
  } catch (_) { return false; }
}

function ipcSenderUrl(event) {
  return String(event?.senderFrame?.url || event?.sender?.getURL?.() || '');
}

function isMainWindowSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event?.sender === mainWindow.webContents && !event?.senderFrame?.parent);
}

function isLauncherSender(event) {
  return isMainWindowSender(event) && isLauncherUrl(ipcSenderUrl(event));
}

function isTrustedServerSender(event) {
  return isMainWindowSender(event) && Boolean(trustedServerOrigin)
    && normalizedOrigin(ipcSenderUrl(event)) === trustedServerOrigin;
}

function permissionRequestIsTrusted(webContents, permission, requestingUrl = '') {
  if (!mainWindow || mainWindow.isDestroyed() || webContents !== mainWindow.webContents || !allowedWebPermissions.has(permission)) return false;
  const pageOrigin = normalizedOrigin(webContents.getURL());
  const requestingOrigin = normalizedOrigin(requestingUrl) || pageOrigin;
  return Boolean(trustedServerOrigin) && pageOrigin === trustedServerOrigin && requestingOrigin === trustedServerOrigin;
}

async function verifySyncWatchServer(address) {
  const requested = new URL(address);
  const response = await fetch(new URL('/api/public-config', requested.origin), {
    headers: { Accept: 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`服务器验证失败（HTTP ${response.status}）`);
  if (!/^application\/json\b/i.test(response.headers.get('content-type') || '')) throw new Error('目标地址没有返回 SyncWatch同步观影 配置');
  const config = await response.json();
  if (!['SyncWatch同步观影', 'SyncWatch'].includes(config?.name) || typeof config.version !== 'string' || config.roomsEnabled !== true) {
    throw new Error('目标地址不是可识别的 SyncWatch同步观影 服务器');
  }
  const verifiedOrigin = normalizedOrigin(response.url);
  if (!verifiedOrigin) throw new Error('服务器最终地址无效');
  const destination = new URL(address);
  const verified = new URL(verifiedOrigin);
  destination.protocol = verified.protocol;
  destination.host = verified.host;
  destination.username = '';
  destination.password = '';
  return { address: destination.toString(), origin: verifiedOrigin, hostname: verified.host, config };
}

function serverConnectionError(error) {
  return ['TimeoutError', 'AbortError'].includes(error?.name)
    ? '连接服务器超时，请检查地址与网络'
    : (error?.message || '无法验证服务器地址');
}

function validGlbBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 20 && buffer.subarray(0, 4).toString('ascii') === 'glTF'
    && buffer.readUInt32LE(4) === 2 && buffer.readUInt32LE(8) === buffer.length;
}

async function fetchConfiguredLoginModel(address) {
  const verified = await verifySyncWatchServer(address);
  const model = verified.config?.loginCube?.model;
  if (verified.config?.loginCube?.displayMode !== 'model' || !model?.url) throw new Error('服务器当前未启用自定义 3D 登录模型');
  const modelUrl = new URL(String(model.url), verified.origin);
  if (modelUrl.origin !== verified.origin || !/^\/login-cube-model\/[a-f0-9-]+\.glb$/i.test(modelUrl.pathname)) {
    throw new Error('服务器返回了不受信任的模型地址');
  }
  const response = await fetch(modelUrl, { headers: { Accept: 'model/gltf-binary' }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`模型下载失败（HTTP ${response.status}）`);
  const declaredLength = Number(response.headers.get('content-length')) || 0;
  if (declaredLength > MAX_LOGIN_MODEL_BYTES) throw new Error('服务器登录模型超过 25 MB 限制');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_LOGIN_MODEL_BYTES || !validGlbBuffer(buffer)) throw new Error('服务器登录模型不是有效的 GLB 2.0 文件');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (model.sha256 && sha256 !== String(model.sha256).toLowerCase()) throw new Error('服务器登录模型完整性校验失败');
  return { base64: buffer.toString('base64'), sha256, size: buffer.length };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 390, minHeight: 620, show: false,
    title: APP_NAME, icon: iconPath(),
    backgroundColor: '#0d1114', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'electron-client-preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const address = normalizeServerAddress(url);
    if (address && normalizedOrigin(mainWindow?.webContents.getURL()) === trustedServerOrigin) void shell.openExternal(address);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isLauncherUrl(url) || (trustedServerOrigin && normalizedOrigin(url) === trustedServerOrigin)) return;
    event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, 'client-launcher.html'));
}

ipcMain.handle('syncwatch-client:inspect', async (event, value) => {
  if (!isLauncherSender(event)) return { success: false, error: '只有客户端连接页可以读取服务器登录视觉' };
  const address = normalizeServerAddress(value);
  if (!address) return { success: false, error: '请输入有效的 HTTP/HTTPS 服务器地址' };
  try {
    const verified = await verifySyncWatchServer(address);
    return {
      success: true,
      address: verified.address,
      origin: verified.origin,
      hostname: verified.hostname,
      config: verified.config
    };
  } catch (error) {
    return { success: false, error: serverConnectionError(error) };
  }
});

ipcMain.handle('syncwatch-client:load-login-model', async (event, value) => {
  if (!isLauncherSender(event)) return { success: false, error: '只有客户端连接页可以读取服务器登录模型' };
  const address = normalizeServerAddress(value);
  if (!address) return { success: false, error: '请输入有效的 HTTP/HTTPS 服务器地址' };
  try { return { success: true, ...await fetchConfiguredLoginModel(address) }; }
  catch (error) { return { success: false, error: serverConnectionError(error) }; }
});

ipcMain.handle('syncwatch-client:open', async (_event, value) => {
  if (!isLauncherSender(_event)) return { success: false, error: '只有客户端连接页可以更换服务器地址' };
  const address = normalizeServerAddress(value);
  if (!address) return { success: false, error: '请输入有效的 HTTP/HTTPS 服务器地址' };
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: '客户端窗口已关闭' };
  try {
    const verified = await verifySyncWatchServer(address);
    trustedServerOrigin = verified.origin;
    await mainWindow.loadURL(verified.address);
    return { success: true, address: verified.address };
  } catch (error) {
    trustedServerOrigin = '';
    return { success: false, error: serverConnectionError(error) };
  }
});

ipcMain.handle('syncwatch-client:audio-muted', (event, muted) => {
  if (!isTrustedServerSender(event)) return { success: false, error: '当前页面无权控制客户端声音' };
  mainWindow.webContents.setAudioMuted(Boolean(muted));
  return { success: true, muted: mainWindow.webContents.isAudioMuted() };
});
ipcMain.handle('syncwatch-client:read-clipboard-text', async (event) => {
  if (!isTrustedServerSender(event)) return { success: false, error: '当前页面无权读取系统剪贴板', text: '' };
  const hostname = new URL(trustedServerOrigin).host;
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'question', title: '读取系统剪贴板', message: `${hostname} 请求读取系统剪贴板`,
    detail: '仅当您刚刚点击了“粘贴”或“从剪贴板导入”时允许。',
    buttons: ['允许本次读取', '取消'], defaultId: 0, cancelId: 1, noLink: true
  });
  if (confirmation.response !== 0) return { success: false, error: '您已取消读取系统剪贴板', text: '' };
  try { return { success: true, text: clipboard.readText() }; }
  catch (error) { return { success: false, error: error?.message || '无法读取系统剪贴板', text: '' }; }
});
ipcMain.handle('syncwatch-client:write-clipboard-text', (event, value) => {
  if (!isTrustedServerSender(event)) return { success: false, error: '当前页面无权写入系统剪贴板' };
  try { clipboard.writeText(String(value || '')); return { success: true }; }
  catch (error) { return { success: false, error: error?.message || '无法写入系统剪贴板' }; }
});
ipcMain.handle('syncwatch-client:list-audio-sources', async (event) => {
  if (!isTrustedServerSender(event)) return { success: false, error: '当前页面无权扫描电脑音源', sources: [] };
  try {
    const [sources, programs] = await Promise.all([
      desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }),
      scanVisibleWindowsPrograms()
    ]);
    return {
      success: true,
      sources: mergeDesktopAudioSources(sources, programs)
    };
  } catch (error) { return { success: false, error: error?.message || '无法扫描当前电脑音源', sources: [] }; }
});
ipcMain.handle('syncwatch-client:open-external', async (event, value) => {
  if (!isTrustedServerSender(event)) return { success: false, error: '当前页面无权打开外部应用' };
  const raw = String(value || '').trim();
  let url;
  try { url = new URL(raw); } catch (_) { return { success: false, error: '外部地址无效' }; }
  if (!['http:', 'https:', 'mailto:', 'tel:', 'tencent:', 'weixin:'].includes(url.protocol)) return { success: false, error: '外部协议不受支持' };
  try { await shell.openExternal(url.toString()); return { success: true }; }
  catch (error) { return { success: false, error: error.message || '系统未找到对应应用' }; }
});

app.on('web-contents-created', (_event, contents) => {
  contents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(permissionRequestIsTrusted(webContents, permission, details?.requestingUrl || details?.requestingOrigin || ''));
  });
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
      permissionRequestIsTrusted(webContents, permission, requestingOrigin || details?.requestingUrl || '')
    ));
    createWindow();
  }).catch((error) => { dialog.showErrorBox(`${APP_NAME}启动失败`, String(error?.message || error)); app.quit(); });
  app.on('activate', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { normalizeServerAddress };
