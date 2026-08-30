'use strict';

// A parent terminal/test runner may close its capture pipe while Electron is
// still shutting down.  On Windows that benign condition is reported as
// EPIPE; if it reaches Electron's uncaughtException handler it becomes a
// misleading modal "main process" error.  Consume only broken-pipe errors and
// keep every other stream failure visible through the normal error path.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (error) => {
    if (error?.code !== 'EPIPE') process.exitCode = 1;
  });
}

const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const https = require('https');
const nodeNet = require('net');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { fetch: undiciFetch, EnvHttpProxyAgent } = require('undici');
const {
  app, BrowserWindow, Menu, Tray, clipboard, dialog, shell, ipcMain,
  desktopCapturer, session, screen, net, Notification, nativeTheme
} = require('electron');

const { version: PACKAGE_VERSION } = require('./package.json');

const APP_VERSION = `v${String(PACKAGE_VERSION || '').replace(/^v/i, '')}`;
let startSyncWatchServer = null;

function resolveDefaultDataDir(root = process.cwd()) {
  const preferred = path.resolve(root, 'SyncWatch同步观影-Data');
  const legacy = path.resolve(root, 'SyncWatch-Data');
  if (fs.existsSync(preferred) || !fs.existsSync(legacy)) return preferred;
  try { fs.renameSync(legacy, preferred); return preferred; }
  catch (_) { return legacy; }
}

const APP_NAME = 'SyncWatch同步观影';
app.setName(APP_NAME);
nativeTheme.themeSource = 'dark';
if (process.platform === 'win32') app.setAppUserModelId('com.xuan.syncwatch.server');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const COPYRIGHT = '版权所有 © xuan';
const HELP_LINKS = Object.freeze({
  author: 'https://github.com/xuange6610',
  project: 'https://github.com/xuange6610/SyncWatch',
  latest: 'https://github.com/xuange6610/SyncWatch/releases/latest',
  wiki: 'https://github.com/xuange6610/SyncWatch/wiki'
});
const HELP_LINK_ALLOWLIST = new Set(Object.values(HELP_LINKS));
const SMOKE_MODE = process.env.SYNCWATCH_SMOKE_MODE === '1';
// Allow the server launcher to inject a fresh owner token for portable deployments;
// interactive desktop launches still receive a cryptographically random token.
const HOST_CONTROL_TOKEN = String(process.env.SYNCWATCH_HOST_TOKEN || '').trim()
  || crypto.randomBytes(32).toString('base64url');
const DEFAULT_PORT = 20311;
const DEFAULT_TUNNEL_BYPASS_PROXY = true;
const QUICK_TUNNEL_ATTEMPT_TIMEOUT_MS = 25000;
const QUICK_TUNNEL_MAX_ATTEMPTS = 3;
const TUNNEL_VERIFY_MAX_MS = 60000;
const CLOUDFLARE_EDGE_PORT = 7844;
const CLOUDFLARE_EDGE_MAX_ADDRESSES = 4;
const CLOUDFLARE_EDGE_DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve'
];
const TUNNEL_RESTART_BASE_DELAY_MS = 2000;
const TUNNEL_RESTART_MAX_DELAY_MS = 30000;
const CLOUDFLARED_MIN_BINARY_BYTES = 1000000;
const CLOUDFLARED_RELEASE_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const LEGACY_USER_DATA_ROOT = app.getPath('userData');
const LEGACY_DATA_DIR = path.join(LEGACY_USER_DATA_ROOT, 'data');

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

function resolveApplicationRoot({
  portableExecutableDir = '', portableExecutableFile = '', isPackaged = false,
  execPath = '', moduleDir = '', platform = process.platform, userDataPath = ''
} = {}) {
  return path.resolve(portableExecutableDir
    || (portableExecutableFile ? path.dirname(portableExecutableFile) : '')
    || (isPackaged ? path.dirname(execPath) : moduleDir));
}

function resolveClientDownloadPath({ isPackaged = false, resourcesPath = '', portableExecutableDir = '', portableExecutableFile = '', developmentClientPath = '' } = {}) {
  const candidates = isPackaged
    ? [resourcesPath ? path.join(resourcesPath, 'offline-downloads', 'windows', `SyncWatch-Experience-Client-Portable-v${String(APP_VERSION).replace(/^v/i, '')}-x64.exe`) : '', resourcesPath ? path.join(resourcesPath, 'client', `SyncWatch同步观影-Client-v${String(APP_VERSION).replace(/^v/i, '')}.exe`) : '']
    : [developmentClientPath];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

const APPLICATION_ROOT = resolveApplicationRoot({
  portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
  portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  moduleDir: __dirname,
  platform: process.platform,
  userDataPath: app.getPath('userData')
});
const DEFAULT_DATA_DIR = resolveDefaultDataDir(APPLICATION_ROOT);
const LEGACY_SERVER_SETTINGS_FILE = path.join(APPLICATION_ROOT, 'server-config.json');
const SERVER_SETTINGS_FILE = path.join(DEFAULT_DATA_DIR, 'server-config.json');
const FACTORY_RESET_MARKER = path.join(APPLICATION_ROOT, '.syncwatch-factory-reset.json');
let mainWindow = null;
let splashWindow = null;
let settingsWindow = null;
let conflictWindow = null;
let tray = null;
let serverController = null;
let tunnelManager = null;
let shuttingDown = false;
let forceQuit = false;
let closeChoicePending = false;
let displayCapturePromptReady = false;
let pendingDisplayCapturePrompt = null;
let activeServerSettings = null;
let storageSetupError = null;

function requestApplicationQuit() {
  forceQuit = true;
  app.quit();
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function dataLockConflictDetails(error) {
  if (error?.code !== 'SYNCWATCH_DATA_LOCKED' || !error.lockOwner || !error.lockDirectory) return null;
  const owner = error.lockOwner;
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || owner.token.length < 16) return null;
  return { owner, lockDirectory: String(error.lockDirectory), dataDirectory: String(error.dataDirectory || '') };
}

function sendDataLockCommand(details, action) {
  if (!details || !['focus', 'shutdown'].includes(action)) throw new Error('实例控制指令无效');
  atomicWriteJson(path.join(details.lockDirectory, 'control.json'), {
    version: 1, action, ownerToken: details.owner.token,
    requestedByPid: process.pid, requestedAt: new Date().toISOString()
  });
}

function conflictHtml(message) {
  const escaped = String(message || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#100d08;color:#f5ead1;font-family:"Microsoft YaHei",sans-serif;display:grid;place-items:center}
    main{width:100%;height:100%;padding:28px 30px 24px;border:1px solid #5b4824;background:#171108;position:relative}
    .close{position:absolute;right:14px;top:10px;width:34px;height:34px;display:grid;place-items:center;color:#d8c28d;text-decoration:none;font-size:24px;border-radius:4px}.close:hover{background:#332818;color:#fff4d6}
    .brand{color:#d9b86c;font-size:12px;font-weight:700}.title{margin:10px 0 8px;font-size:24px;color:#ffe7ad}.message{margin:0;white-space:pre-wrap;line-height:1.75;color:#d9cfba;font-size:14px;max-height:140px;overflow:auto}
    .status{min-height:22px;margin:12px 0 4px;color:#d9b86c;font-size:13px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.actions a{flex:1;min-width:150px;padding:11px 14px;text-align:center;text-decoration:none;border-radius:5px;font-weight:700;font-size:14px}
    .primary{background:#d9b86c;color:#171108;border:1px solid #f3d68e}.secondary{background:#2b2113;color:#f5e6bd;border:1px solid #806634}.danger{background:#321b16;color:#f7c2ae;border:1px solid #8f4e39}
  </style><main><a class="close" href="https://syncwatch.local/close" aria-label="关闭">×</a><div class="brand">SYNCWATCH · 服务器</div><h1 class="title">数据目录正在使用</h1><p class="message">${escaped}</p><p id="status" class="status">请选择打开现有实例，或安全退出旧实例后重试。</p><div class="actions"><a class="primary" href="https://syncwatch.local/focus">打开正在运行的程序</a><a class="danger" href="https://syncwatch.local/shutdown">退出旧实例并重试</a><a class="secondary" href="https://syncwatch.local/close">关闭</a></div></main></html>`;
}

async function showDataLockConflict(error) {
  const details = dataLockConflictDetails(error);
  if (!details) throw error;
  splashWindow?.destroy(); splashWindow = null;
  conflictWindow = new BrowserWindow({
    width: 650, height: 390, minWidth: 560, minHeight: 350, frame: false, resizable: true,
    center: true, alwaysOnTop: true, show: false, backgroundColor: '#100d08', icon: iconPath(),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  const setStatus = (message) => conflictWindow?.webContents.executeJavaScript(`document.getElementById('status').textContent=${JSON.stringify(message)}`).catch(() => {});
  conflictWindow.webContents.on('will-navigate', (event, target) => {
    let action = '';
    try { const url = new URL(target); if (url.hostname === 'syncwatch.local') action = url.pathname.slice(1); } catch (_) {}
    if (!action) return;
    event.preventDefault();
    if (action === 'close') return app.exit(0);
    if (!processIsRunning(details.owner.pid)) return setStatus('旧实例已经退出，请关闭窗口后重新启动。');
    try { sendDataLockCommand(details, action === 'focus' ? 'focus' : 'shutdown'); }
    catch (commandError) { return setStatus(`无法发送指令：${commandError.message}`); }
    if (action === 'focus') {
      setStatus('正在打开已运行的 SyncWatch同步观影…');
      return setTimeout(() => app.exit(0), 1000);
    }
    setStatus('正在安全退出旧实例，完成后会自动重试启动…');
    const deadline = Date.now() + 20000;
    const poll = setInterval(() => {
      if (processIsRunning(details.owner.pid) && Date.now() < deadline) return;
      clearInterval(poll);
      if (processIsRunning(details.owner.pid)) return setStatus('旧实例暂未退出，请在其关闭确认窗口中选择“退出程序”。');
      relaunchCurrentExecutable();
    }, 300);
  });
  conflictWindow.on('closed', () => { conflictWindow = null; if (!shuttingDown) app.exit(0); });
  await conflictWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(conflictHtml(error.message))}`);
  if (!SMOKE_MODE) conflictWindow.show();
}

process.on('syncwatch-data-lock-command', (command) => {
  if (command?.action === 'focus') {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
    else if (splashWindow) { splashWindow.show(); splashWindow.focus(); }
    return;
  }
  if (command?.action === 'shutdown') requestApplicationQuit();
});

function validPort(value, allowZero = false) {
  if (!['number', 'string'].includes(typeof value)) return null;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= (allowZero ? 0 : 1) && port <= 65535 ? port : null;
}

function userFacingDesktopError(error, fallback = '操作失败，请稍后重试', context = '桌面端操作失败') {
  const message = String(error?.message || error || '').trim();
  if (!message) return fallback;
  console.error(`${context}（原始错误仅写入日志）:`, error);
  if (/publicUrl/i.test(message)) {
    if (/query|hash/i.test(message)) return '公网根地址不能包含查询参数或页面锚点';
    if (/用户名|密码/.test(message)) return '公网根地址不能包含用户名或密码';
    if (/路径|根地址/.test(message)) return '公网根地址只能填写站点根地址，不能包含路径';
    if (/HTTP\/HTTPS|字符串|完整/.test(message)) return '公网根地址必须是完整的 HTTP/HTTPS 地址';
    return '公网根地址格式不正确';
  }
  if (/server-config\.json/i.test(message)) {
    if (/port/i.test(message)) return '服务器配置文件中的端口必须是 1–65535 之间的整数';
    return '服务器配置文件内容格式不正确';
  }
  if (/eaddrinuse/i.test(message)) return '服务器端口已被其他程序占用，请更换端口后重试';
  if (/enospc|no space left|quota exceeded/i.test(message)) return '磁盘空间不足，请清理空间后重试';
  if (/eacces|eperm|permission denied|access denied/i.test(message)) return '系统拒绝访问所需文件或端口，请检查目录和防火墙权限';
  if (/enoent|module_not_found|\bspawn\b.*not found/i.test(message)) return '缺少运行所需组件，请重新安装完整程序';
  if (/signature rejected|数字签名|authenticodesignature/i.test(message)) return '公网隧道组件数字签名验证失败，请删除该组件后重试';
  if (/econn|enotfound|eai_again|network|connection|failed to fetch/i.test(message)) return '网络连接失败，请检查网络和代理设置';
  if (/timeout|timed out|etimedout/i.test(message)) return '操作超时，请稍后重试';
  if (/epipe|broken pipe/i.test(message)) return '程序通信已中断，请重新启动后重试';
  const looksLikeRawTechnicalError = /\b(?:Error|Exception|TypeError|RangeError|ReferenceError|SyntaxError|ERR_[A-Z_]+|E[A-Z]{3,})\b|\bspawn\b|\bfailed\b|\binvalid\b|unexpected token|\bat\s+\S+\s*\(/i.test(message);
  if (/[\u3400-\u9fff]/.test(message) && !looksLikeRawTechnicalError) return message;
  return fallback;
}

function commandLineValue(name) {
  for (let index = 0; index < process.argv.length; index += 1) {
    const current = String(process.argv[index] || '');
    if (current.startsWith(`--${name}=`)) return current.slice(name.length + 3);
    if (current === `--${name}`) {
      const next = index + 1 < process.argv.length ? String(process.argv[index + 1] || '') : '';
      return next.startsWith('--') ? '' : next;
    }
  }
  return undefined;
}

function commandLinePort() {
  return commandLineValue('port') ?? '';
}

function atomicWriteJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filename);
}

async function factoryResetAndRestart() {
  if (shuttingDown) return;
  atomicWriteJson(FACTORY_RESET_MARKER, { requestedAt: new Date().toISOString(), applicationRoot: APPLICATION_ROOT });
  shuttingDown = true; forceQuit = true;
  const controller = serverController; serverController = null;
  try { await controller?.close(); }
  catch (error) { console.error('恢复出厂设置时关闭服务器失败:', error); }
  relaunchCurrentExecutable();
}

async function restartApplication() {
  if (shuttingDown) return;
  shuttingDown = true; forceQuit = true;
  const controller = serverController; serverController = null;
  try { await controller?.close(); }
  catch (error) { console.error('重启时关闭服务器失败:', error); }
  relaunchCurrentExecutable();
}

function relaunchCurrentExecutable() {
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
  const executable = portableFile && fs.existsSync(portableFile) ? portableFile : process.execPath;
  if (executable && fs.existsSync(executable) && app.isPackaged) {
    const args = process.argv.slice(1).filter((argument) => !/^--squirrel/i.test(String(argument)));
    try {
      const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      app.exit(0);
      return;
    } catch (error) { console.error('使用便携式 EXE 重启失败，将回退到 Electron relaunch:', error); }
  }
  app.relaunch();
  app.exit(0);
}

function launchAdditionalServer() {
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
  const executable = portableFile && fs.existsSync(portableFile) ? portableFile : process.execPath;
  const instanceRoot = path.join(DEFAULT_DATA_DIR, 'additional-servers', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  const args = process.argv.slice(1)
    .filter((argument) => !/^--squirrel/i.test(String(argument)) && !String(argument).startsWith('--user-data-dir'))
    .concat(`--user-data-dir=${path.join(instanceRoot, 'electron-profile')}`);
  fs.mkdirSync(instanceRoot, { recursive: true });
  const child = spawn(executable, args, {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, SYNCWATCH_DATA_DIR: instanceRoot, SYNCWATCH_HOST_TOKEN: crypto.randomBytes(32).toString('hex') }
  });
  child.unref();
}

function normalizePublicUrl(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new Error('publicUrl 必须是字符串');
  const normalized = value.trim();
  if (!normalized) return '';
  let parsed;
  try { parsed = new URL(normalized); }
  catch (error) { throw new Error(`publicUrl 必须是完整的 HTTP/HTTPS 地址：${error.message}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('publicUrl 仅支持 HTTP/HTTPS');
  if (parsed.username || parsed.password) throw new Error('publicUrl 不允许包含用户名或密码');
  if (normalized.includes('?') || normalized.includes('#')) throw new Error('publicUrl 不能包含 query 或 hash');
  const authorityStart = normalized.indexOf('://') + 3;
  const pathStart = normalized.indexOf('/', authorityStart);
  if (parsed.pathname !== '/' || (pathStart >= 0 && normalized.slice(pathStart) !== '/')) {
    throw new Error('publicUrl 只能填写站点根地址，不能包含路径');
  }
  return parsed.origin;
}

function normalizeAllowedHost(value) {
  if (typeof value !== 'string') throw new Error('允许域名必须是字符串');
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  let parsed;
  try { parsed = new URL(/^https?:\/\//i.test(normalized) ? normalized : `http://${normalized}`); }
  catch (_) { throw new Error(`允许域名格式无效：${value}`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.host) {
    throw new Error(`允许域名只能填写“域名”或“域名:端口”：${value}`);
  }
  return parsed.host.toLowerCase();
}

function normalizeAllowedHosts(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/[,\r\n]+/);
  return [...new Set(entries.map(normalizeAllowedHost).filter(Boolean))].slice(0, 50);
}

function normalizeServerSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('server-config.json 顶层必须是 JSON 对象');
  const port = Object.prototype.hasOwnProperty.call(input, 'port') ? validPort(input.port) : DEFAULT_PORT;
  if (port === null) throw new Error('server-config.json 的 port 必须是 1-65535 之间的整数');
  const publicUrl = normalizePublicUrl(input.publicUrl);
  const allowedHosts = normalizeAllowedHosts(input.allowedHosts);
  const networkInterface = String(input.networkInterface || 'auto').trim() || 'auto';
  if (networkInterface.length > 120 || /[\x00-\x1f]/.test(networkInterface)) throw new Error('网卡名称无效');
  return { port, networkInterface, publicUrl, allowedHosts, autostart: input.autostart === true };
}

function selectableNetworkAdapters(interfaces = os.networkInterfaces() || {}) {
  const physical = new Set(physicalNetworkCandidates(interfaces).accepted.map((entry) => entry.address));
  const adapters = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      const address = String(entry?.address || '');
      if (entry?.internal || (entry?.family !== 'IPv4' && entry?.family !== 4)
        || !address || /^(?:0\.0\.0\.0|127\.|169\.254\.)/.test(address)) continue;
      adapters.push({ name, address, physical: physical.has(address) });
    }
  }
  return adapters.sort((left, right) => Number(right.physical) - Number(left.physical)
    || left.name.localeCompare(right.name, 'zh-CN') || left.address.localeCompare(right.address));
}

function resolveLanAddress(settings = {}, interfaces = os.networkInterfaces() || {}) {
  const adapters = selectableNetworkAdapters(interfaces);
  const requested = String(settings.networkInterface || 'auto').trim();
  if (requested && requested !== 'auto') {
    const matched = adapters.find((adapter) => adapter.name === requested);
    if (matched) return matched.address;
  }
  return physicalNetworkCandidates(interfaces).selected?.address || adapters[0]?.address || '';
}

function loadServerSettings({ create = false } = {}) {
  let settings = normalizeServerSettings();
  if (!fs.existsSync(SERVER_SETTINGS_FILE) && fs.existsSync(LEGACY_SERVER_SETTINGS_FILE)) {
    try {
      settings = normalizeServerSettings(JSON.parse(fs.readFileSync(LEGACY_SERVER_SETTINGS_FILE, 'utf8')));
      atomicWriteJson(SERVER_SETTINGS_FILE, settings);
      fs.rmSync(LEGACY_SERVER_SETTINGS_FILE, { force: true });
    } catch (error) { throw new Error(userFacingDesktopError(error, '旧服务器配置文件无法迁移，请检查配置内容', '迁移服务器配置失败')); }
  }
  if (fs.existsSync(SERVER_SETTINGS_FILE)) {
    try { settings = normalizeServerSettings(JSON.parse(fs.readFileSync(SERVER_SETTINGS_FILE, 'utf8'))); }
    catch (error) { throw new Error(userFacingDesktopError(error, '服务器配置文件无法读取，请检查配置内容', '读取服务器配置失败')); }
  } else if (create) atomicWriteJson(SERVER_SETTINGS_FILE, settings);
  return settings;
}

function applyAutostartSetting(enabled) {
  try { app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: false }); }
  catch (error) { console.warn('无法应用开机自启动设置：', error.message); }
}

function resolvedStartPort(settings) {
  const cliValue = commandLinePort();
  if (cliValue !== '') {
    const port = validPort(cliValue, SMOKE_MODE);
    if (port === null) throw new Error('命令行端口必须是 1-65535 之间的整数');
    return port;
  }
  if (process.env.PORT !== undefined && process.env.PORT !== '') {
    const port = validPort(process.env.PORT, SMOKE_MODE);
    if (port === null) throw new Error('环境变量 PORT 必须是 1-65535 之间的整数');
    return port;
  }
  return settings.port;
}

function configurePortableStorage() {
  if (process.env.SYNCWATCH_DATA_DIR || process.argv.some((argument) => String(argument).startsWith('--user-data-dir'))) return;
  try {
    const profileDir = path.join(DEFAULT_DATA_DIR, 'electron-profile');
    const cacheDir = path.join(DEFAULT_DATA_DIR, 'cache');
    const logsDir = path.join(DEFAULT_DATA_DIR, 'logs');
    const crashDir = path.join(DEFAULT_DATA_DIR, 'crash-dumps');
    for (const directory of [DEFAULT_DATA_DIR, profileDir, cacheDir, logsDir, crashDir]) fs.mkdirSync(directory, { recursive: true });
    app.setPath('userData', profileDir);
    try { app.setPath('sessionData', cacheDir); } catch (_) {}
    try { app.setPath('cache', cacheDir); } catch (_) {}
    try { app.setPath('logs', logsDir); } catch (_) {}
    try { app.setPath('crashDumps', crashDir); } catch (_) {}
    app.commandLine.appendSwitch('disk-cache-dir', cacheDir);
  } catch (error) { storageSetupError = error; }
}

function applyPendingFactoryReset() {
  if (!fs.existsSync(FACTORY_RESET_MARKER)) return;
  const resetDirectories = [DEFAULT_DATA_DIR, LEGACY_USER_DATA_ROOT]
    .map((directory) => path.resolve(directory))
    .filter((directory, index, list) => list.indexOf(directory) === index)
    .filter((directory) => directory !== path.parse(directory).root && directory !== APPLICATION_ROOT)
    .filter((directory) => !APPLICATION_ROOT.startsWith(`${directory}${path.sep}`));
  for (const directory of resetDirectories) fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(LEGACY_SERVER_SETTINGS_FILE, { force: true });
  fs.rmSync(FACTORY_RESET_MARKER, { force: true });
}

try { applyPendingFactoryReset(); }
catch (error) { storageSetupError = new Error(`恢复出厂设置未能清理旧数据：${error.message}`, { cause: error }); }
configurePortableStorage();

function dataFileManifest(root) {
  const output = new Map();
  if (!fs.existsSync(root)) return output;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) output.set(path.relative(root, absolute), fs.statSync(absolute).size);
    }
  };
  walk(root);
  return output;
}

async function migrateLegacyData() {
  if (process.env.SYNCWATCH_DATA_DIR || path.resolve(LEGACY_DATA_DIR) === path.resolve(DEFAULT_DATA_DIR)) return;
  const legacyConfig = path.join(LEGACY_DATA_DIR, 'config.json');
  if (!fs.existsSync(legacyConfig)) return;
  const portableConfig = path.join(DEFAULT_DATA_DIR, 'config.json');
  const progressFile = path.join(DEFAULT_DATA_DIR, '.legacy-migration-in-progress.json');
  if (fs.existsSync(portableConfig) && !fs.existsSync(progressFile)) return;

  fs.mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
  atomicWriteJson(progressFile, { source: LEGACY_DATA_DIR, destination: DEFAULT_DATA_DIR, startedAt: new Date().toISOString() });
  await fs.promises.cp(LEGACY_DATA_DIR, DEFAULT_DATA_DIR, {
    recursive: true, force: false, errorOnExist: false, preserveTimestamps: true
  });
  JSON.parse(fs.readFileSync(portableConfig, 'utf8'));
  const expected = dataFileManifest(LEGACY_DATA_DIR);
  const copied = dataFileManifest(DEFAULT_DATA_DIR);
  for (const [relative, size] of expected) {
    if (copied.get(relative) !== size) throw new Error(`旧数据迁移校验失败：${relative}`);
  }
  atomicWriteJson(path.join(DEFAULT_DATA_DIR, '旧数据迁移记录.json'), {
    source: LEGACY_DATA_DIR, completedAt: new Date().toISOString(), files: expected.size,
    note: '旧目录作为安全备份保留，确认新版数据无误后可手动归档。'
  });
  fs.rmSync(progressFile, { force: true });
}

// Linux Electron cannot decode the Windows ICO tray asset; use the shared PNG
// everywhere except Windows, where the ICO remains the native tray format.
function iconPath() { return path.join(__dirname, 'assets', process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png'); }

function serverSettingsHtml() {
  const port = activeServerSettings?.port || DEFAULT_PORT;
  const actualPort = serverController?.port || port;
  const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const configuredInterface = String(activeServerSettings?.networkInterface || 'auto');
  const adapters = selectableNetworkAdapters();
  const resolvedAddress = resolveLanAddress(activeServerSettings || {});
  const automaticAddress = resolveLanAddress({ networkInterface: 'auto' });
  const networkOptions = [
    `<option value="auto" ${configuredInterface === 'auto' ? 'selected' : ''}>自动选择（推荐：${escapeHtml(automaticAddress || '暂无可用 IPv4')}）</option>`,
    ...adapters.map((adapter) => `<option value="${escapeHtml(adapter.name)}" ${configuredInterface === adapter.name ? 'selected' : ''}>${escapeHtml(adapter.name)} · ${escapeHtml(adapter.address)}${adapter.physical ? '' : ' · 虚拟/VPN'}</option>`)
  ];
  if (configuredInterface !== 'auto' && !adapters.some((adapter) => adapter.name === configuredInterface)) {
    networkOptions.push(`<option value="${escapeHtml(configuredInterface)}" selected>${escapeHtml(configuredInterface)} · 当前不可用（启动时自动回退）</option>`);
  }
  const publicUrl = String(activeServerSettings?.publicUrl || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const allowedHosts = (activeServerSettings?.allowedHosts || []).join('\n').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const autostart = activeServerSettings?.autostart === true;
  const root = APPLICATION_ROOT.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const data = (serverController?.dataDir || DEFAULT_DATA_DIR).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
    *{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#d64f92 #211729}*::-webkit-scrollbar{width:9px;height:9px}*::-webkit-scrollbar-track{background:#211729}*::-webkit-scrollbar-thumb{min-height:34px;background:#b94380;border:2px solid #211729;border-radius:8px}*::-webkit-scrollbar-thumb:hover{background:#d64f92}body{margin:0;min-height:100vh;overflow:auto;background:#140e1d;color:#f9edf7;font-family:"Microsoft YaHei",sans-serif}main{min-height:100vh;padding:26px 26px 32px;display:grid;align-content:start;gap:15px}h1{margin:0;font-size:21px}p{margin:0;color:#c9b6c9;font-size:12px;line-height:1.7}.card{display:grid;gap:11px;padding:15px;background:#ffffff09;border:1px solid #ffffff16;border-radius:12px}label{display:grid;gap:6px;font-size:12px}input,select,textarea{width:100%;padding:11px 12px;border:1px solid #ffffff20;border-radius:9px;background:#0d0913;color:#fff;font:14px "Microsoft YaHei",sans-serif}textarea{min-height:78px;resize:vertical}.check-line{display:flex;align-items:center;gap:8px;margin:2px 0}.check-line input[type="checkbox"]{width:18px;height:18px;margin:0;padding:0;flex:0 0 18px;accent-color:#d64f92}.hint{color:#aa98ad}details{padding:10px 12px;border:1px solid #ffffff16;border-radius:9px;background:#ffffff05;color:#c9b6c9;font-size:12px;line-height:1.7}summary{cursor:pointer;color:#e7b8d7;font-weight:700}code{color:#f3c5dd}.path{word-break:break-all;color:#e7b8d7}footer{display:flex;gap:9px;justify-content:flex-end;flex-wrap:wrap;position:sticky;bottom:0;padding-top:10px;background:linear-gradient(180deg,transparent,#140e1d 35%)}footer button{min-width:130px}button{border:0;border-radius:9px;padding:10px 16px;color:#fff;background:#513b59;cursor:pointer}button.primary{background:#d64f92}#status{min-height:20px;color:#ffb6d6}
  </style></head><body><main><div><h1>服务器启动设置</h1><p>默认端口为 20311。保存后程序会自动重启并生效；云服务器还需在防火墙放行同一端口。</p></div><form id="form" class="card"><label>监听端口<input id="port" type="number" min="1" max="65535" required value="${port}"></label><p class="hint">当前实际端口：${actualPort}。命令行 --port 或环境变量 PORT 会优先于此处设置。</p><label>开放的局域网网卡<select id="networkInterface">${networkOptions.join('')}</select></label><p class="hint">当前选中 IPv4：${escapeHtml(resolvedAddress || '暂无')}。“自动选择”优先有线/无线物理网卡；手动网卡断开后，下次启动会回退到自动选择。本机回环始终保留，不影响桌面界面和 Cloudflare。</p><label>公网根地址（选填）<input id="publicUrl" type="url" value="${publicUrl}" placeholder="例如 https://movie.example.com"></label><p class="hint">使用第三方内网穿透或反向代理时填写完整公网根地址；程序会自动允许这个域名并作为分享地址。</p><details><summary>公网根地址怎么填？</summary><ol><li>先在反向代理、内网穿透或 Cloudflare 配好指向本机端口（默认 20311）。</li><li>填写浏览器最终访问的站点根地址，例如 <code>https://watch.example.com</code>。</li><li>不要填写 <code>/room</code>、<code>?room=ADMIN</code>、#片段、用户名或密码。</li><li>若使用非默认端口，只有对外地址保留该端口时才写，例如 <code>https://watch.example.com:8443</code>。</li><li>保存重启后，先用手机流量打开 <code>/api/public-config</code> 检查；无法访问时检查 Windows/云服务器防火墙、路由器端口映射与代理回源端口。</li></ol></details><label>额外允许域名（选填，每行一个）<textarea id="allowedHosts" placeholder="例如 movie.example.com&#10;movie.example.com:8443">${allowedHosts}</textarea></label><label class="check-line"><input id="autostart" type="checkbox" ${autostart ? 'checked' : ''}> 随系统登录自动启动 SyncWatch同步观影</label><p class="hint">关闭后不会影响已经运行的服务器，仅取消下次登录系统时自动启动。</p><p>程序根目录：<span class="path">${root}</span></p><p>全部服务器数据与缓存：<span class="path">${data}</span></p><p id="status"></p><footer><button id="cancel" type="button">取消</button><button class="primary" type="submit">保存并自动重启</button></footer></form></main><script>
    const form=document.getElementById('form'),port=document.getElementById('port'),networkInterface=document.getElementById('networkInterface'),publicUrl=document.getElementById('publicUrl'),allowedHosts=document.getElementById('allowedHosts'),autostart=document.getElementById('autostart'),status=document.getElementById('status');
    document.getElementById('cancel').addEventListener('click',()=>window.syncWatchServerSettings.close());
    form.addEventListener('submit',async(event)=>{event.preventDefault();status.textContent='正在保存…';const result=await window.syncWatchServerSettings.saveSettings({port:Number(port.value),networkInterface:networkInterface.value,publicUrl:publicUrl.value,allowedHosts:allowedHosts.value,autostart:autostart.checked});status.textContent=result?.message||result?.error||'';});
  </script></body></html>`;
}

function openServerSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 680, height: 780, minWidth: 560, minHeight: 620, parent: mainWindow || undefined, modal: Boolean(mainWindow),
    show: false, resizable: true, title: '服务器启动设置', icon: iconPath(), backgroundColor: '#140e1d',
    webPreferences: { preload: path.join(__dirname, 'electron-settings-preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  settingsWindow.removeMenu();
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(serverSettingsHtml())}`);
}

ipcMain.handle('syncwatch-server-settings:save-port', async (event, payload = {}) => {
  if (!settingsWindow || settingsWindow.isDestroyed() || event.sender !== settingsWindow.webContents) return { success: false, error: '设置窗口已失效' };
  const port = validPort(payload.port);
  if (port === null) return { success: false, error: '端口必须是 1–65535 之间的整数' };
  const previous = activeServerSettings || loadServerSettings();
  let settings;
  try {
    settings = normalizeServerSettings({
      ...previous, port,
      networkInterface: payload.networkInterface === undefined ? previous.networkInterface : payload.networkInterface,
      publicUrl: payload.publicUrl === undefined ? previous.publicUrl : payload.publicUrl,
      allowedHosts: payload.allowedHosts === undefined ? previous.allowedHosts : payload.allowedHosts,
      autostart: payload.autostart === undefined ? previous.autostart : payload.autostart
    });
  } catch (error) { return { success: false, error: userFacingDesktopError(error, '服务器设置无效，请检查后重试', '保存服务器设置失败') }; }
  atomicWriteJson(SERVER_SETTINGS_FILE, settings);
  activeServerSettings = settings;
  applyAutostartSetting(settings.autostart);
  if (port === serverController?.port && JSON.stringify(settings) === JSON.stringify(previous)) return { success: true, message: '设置未变化，无需重启' };
  const controller = serverController;
  try { await controller?.close(); }
  catch (error) { return { success: false, error: userFacingDesktopError(error, '服务器未能安全停止，已取消自动重启', '保存后重启失败') }; }
  serverController = null;
  shuttingDown = true;
  setTimeout(relaunchCurrentExecutable, 200);
  return { success: true, message: '设置已保存，正在自动重启…' };
});

ipcMain.on('syncwatch-server-settings:close', (event) => {
  if (settingsWindow && !settingsWindow.isDestroyed() && event.sender === settingsWindow.webContents) settingsWindow.close();
});
ipcMain.handle('syncwatch:audio-muted', (event, muted) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { success: false, error: '主窗口已关闭' };
  mainWindow.webContents.setAudioMuted(Boolean(muted));
  return { success: true, muted: mainWindow.webContents.isAudioMuted() };
});
ipcMain.handle('syncwatch:read-clipboard-text', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { success: false, error: '主窗口已关闭', text: '' };
  try { return { success: true, text: clipboard.readText() }; }
  catch (error) { return { success: false, error: error?.message || '无法读取系统剪贴板', text: '' }; }
});
ipcMain.handle('syncwatch:list-audio-sources', async (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { success: false, error: '主窗口已关闭', sources: [] };
  try {
    const [sources, programs] = await Promise.all([
      desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }),
      scanVisibleWindowsPrograms()
    ]);
    return {
      success: true,
      sources: mergeDesktopAudioSources(sources, programs)
    };
  } catch (error) {
    return { success: false, error: error?.message || '无法扫描当前电脑的音源窗口', sources: [] };
  }
});
ipcMain.handle('syncwatch:open-external', async (event, value) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { success: false, error: '主窗口已关闭' };
  const raw = String(value || '').trim();
  let url;
  try { url = new URL(raw); } catch (_) { return { success: false, error: '外部地址无效' }; }
  if (!['http:', 'https:', 'mailto:', 'tel:', 'tencent:', 'weixin:'].includes(url.protocol)) return { success: false, error: '外部协议不受支持' };
  try { await shell.openExternal(url.toString()); return { success: true }; }
  catch (error) { return { success: false, error: error.message || '系统未找到对应应用' }; }
});
ipcMain.handle('syncwatch:open-compatible-media-folder', async (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { success: false, error: '主窗口已关闭' };
  const root = path.resolve(serverController?.dataDir || DEFAULT_DATA_DIR);
  const target = path.join(root, 'compatible-media');
  try {
    fs.mkdirSync(target, { recursive: true });
    const failure = await shell.openPath(target);
    return failure ? { success: false, error: failure } : { success: true };
  } catch (error) { return { success: false, error: error?.message || '无法打开转换文件目录' }; }
});
ipcMain.handle('syncwatch:show-notification', (event, payload = {}) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { success: false, error: '主窗口已关闭' };
  if (!Notification.isSupported()) return { success: false, error: '当前系统不支持桌面通知' };
  const title = String(payload.title || 'SyncWatch同步观影').trim().slice(0, 80);
  const body = String(payload.body || '').trim().slice(0, 240);
  if (!body) return { success: false, error: '通知内容为空' };
  const notification = new Notification({ title, body, icon: iconPath() });
  notification.on('click', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show(); mainWindow?.focus();
  });
  notification.show();
  return { success: true };
});
ipcMain.handle('syncwatch:close-choice', async (event, requestedChoice) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { success: false, error: '主窗口已关闭' };
  const choice = String(requestedChoice || '').trim().toLowerCase();
  if (!['minimize', 'quit', 'restart', 'new-server', 'cancel'].includes(choice)) return { success: false, error: '无效的关闭方式' };
  closeChoicePending = false;
  if (choice === 'minimize') {
    mainWindow.hide();
    tray?.displayBalloon?.({ title: `${APP_NAME}仍在运行`, content: '程序已最小化到托盘，服务器与房间保持在线。' });
  } else if (choice === 'quit') requestApplicationQuit();
  else if (choice === 'restart') await restartApplication();
  else if (choice === 'new-server') {
    try { launchAdditionalServer(); }
    catch (error) { return { success: false, error: userFacingDesktopError(error, '无法打开新的服务器', '打开新服务器失败') }; }
  }
  return { success: true, choice };
});
ipcMain.on('syncwatch:display-capture-fallback-ready', (event) => {
  displayCapturePromptReady = Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
});
ipcMain.handle('syncwatch:display-capture-fallback-choice', async (event, approved) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { success: false, error: '主窗口已关闭' };
  if (!pendingDisplayCapturePrompt) return { success: false, error: '当前没有待确认的屏幕共享请求' };
  const prompt = pendingDisplayCapturePrompt;
  pendingDisplayCapturePrompt = null;
  clearTimeout(prompt.timer);
  prompt.resolve(approved === true);
  return { success: true, approved: approved === true };
});
function localUrl() { return `http://127.0.0.1:${serverController.port}`; }
function primaryLanUrl() { return serverController.addresses[0] || localUrl(); }

function trustedExternalUrl(value) {
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : '';
  } catch (_) { return ''; }
}

async function openHelpLink(key) {
  const value = HELP_LINKS[String(key || '')];
  if (!value || !HELP_LINK_ALLOWLIST.has(value)) return { success: false, error: '帮助链接不在允许列表中' };
  let url;
  try { url = new URL(value); } catch (_) { return { success: false, error: '帮助链接无效' }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== 'github.com') {
    return { success: false, error: '帮助链接不安全' };
  }
  await shell.openExternal(url.toString());
  return { success: true };
}

async function downloadFile(url, destination) {
  let source;
  try { source = new URL(url); }
  catch (_) { throw new Error('cloudflared 下载地址无效'); }
  if (source.protocol !== 'https:') throw new Error('cloudflared 下载地址不安全');
  const response = await net.fetch(source.toString(), {
    method: 'GET', redirect: 'follow', headers: { 'User-Agent': `SyncWatch/${APP_VERSION}` }
  });
  let finalUrl;
  try { finalUrl = new URL(response.url || source); }
  catch (_) { throw new Error('cloudflared 下载重定向地址无效'); }
  if (finalUrl.protocol !== 'https:') throw new Error('cloudflared 下载被重定向到不安全地址');
  if (!response.ok) throw new Error(`cloudflared 下载失败（HTTP ${response.status}）`);
  if (!response.body) throw new Error('cloudflared 下载没有返回文件内容');
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }));
}

function cloudflaredRuntime(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    if (arch === 'ia32') {
      return { platform, arch, binaryName: 'cloudflared.exe', assetName: 'cloudflared-windows-386.exe', archive: 'binary' };
    }
    if (arch === 'x64' || arch === 'arm64') {
      return {
        platform, arch, binaryName: 'cloudflared.exe', assetName: 'cloudflared-windows-amd64.exe',
        archive: 'binary', emulated: arch === 'arm64'
      };
    }
  }
  throw new Error(`当前系统不支持自动安装 cloudflared（${platform}/${arch}）`);
}

function fileSha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

async function cloudflaredReleaseAsset(assetName) {
  const response = await net.fetch(CLOUDFLARED_RELEASE_API, {
    method: 'GET', redirect: 'follow', headers: {
      'User-Agent': `SyncWatch/${APP_VERSION}`, Accept: 'application/vnd.github+json'
    }
  });
  let finalUrl;
  try { finalUrl = new URL(response.url || CLOUDFLARED_RELEASE_API); }
  catch (_) { throw new Error('Cloudflare 发布信息地址无效'); }
  if (finalUrl.protocol !== 'https:') throw new Error('Cloudflare 发布信息被重定向到不安全地址');
  if (!response.ok) throw new Error(`无法获取 Cloudflare 发布信息（HTTP ${response.status}）`);
  const release = await response.json();
  const asset = Array.isArray(release?.assets) ? release.assets.find((item) => item?.name === assetName) : null;
  if (!asset) throw new Error(`Cloudflare 最新版本缺少 ${assetName}`);
  const url = trustedExternalUrl(asset.browser_download_url);
  const size = Number(asset.size);
  const digestMatch = /^sha256:([a-f0-9]{64})$/i.exec(String(asset.digest || ''));
  if (!url || !url.startsWith('https://') || !Number.isSafeInteger(size) || size < CLOUDFLARED_MIN_BINARY_BYTES) {
    throw new Error('Cloudflare 发布文件元数据无效');
  }
  return {
    name: assetName, url, size, sha256: digestMatch ? digestMatch[1].toLowerCase() : '',
    release: String(release.tag_name || '')
  };
}

function verifyCloudflaredReleaseFile(filename, asset, { requireDigest = false } = {}) {
  const stats = fs.statSync(filename);
  if (stats.size !== asset.size) throw new Error('cloudflared 下载文件大小与官方发布信息不一致');
  if (requireDigest && !asset.sha256) throw new Error('Cloudflare 发布信息缺少 SHA256 校验值');
  if (asset.sha256) {
    const actual = fileSha256(filename);
    if (actual !== asset.sha256) throw new Error('cloudflared 下载文件 SHA256 校验失败');
  }
}

function tunnelSystemProxyConfigured(environment = process.env) {
  return ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']
    .some((key) => Boolean(String(environment?.[key] || '').trim()));
}

const TUNNEL_HEALTH_PATH = '/api/tunnel-health';
const MAX_TUNNEL_HEALTH_BYTES = 8 * 1024;

function tunnelProbeTransport(localAddress = '', environment = process.env) {
  if (String(localAddress || '').trim()) return 'bound-native-https';
  return tunnelSystemProxyConfigured(environment) ? 'environment-proxy' : 'electron-system-network';
}

function parseTunnelProbeResponse(statusCode, body = '') {
  if (statusCode !== 200) {
    const cloudflareErrorCode = /(?:error\s*(?:code)?\s*[:#]?\s*|code=)(1033)\b/i.test(body) ? 1033 : null;
    const failureCode = cloudflareErrorCode === 1033
      ? 'CLOUDFLARE_TUNNEL_1033'
      : statusCode === 530 ? 'CLOUDFLARE_HTTP_530' : '';
    return { ok: false, statusCode, cloudflareErrorCode, failureCode };
  }
  try {
    const result = JSON.parse(body);
    return { ok: result?.name === 'SyncWatch同步观影' && typeof result.version === 'string', statusCode };
  } catch (_) { return { ok: false, statusCode }; }
}

async function probeHttpsThroughSystemNetwork(url, environment = process.env) {
  const startedAt = Date.now();
  const useEnvironmentProxy = tunnelSystemProxyConfigured(environment);
  let dispatcher = null;
  try {
    // Match cloudflared's system-network fallback: explicit proxy environment
    // variables take precedence, otherwise use Electron's OS proxy/PAC/TUN
    // network service. Node's native https client supports neither path.
    const request = {
      method: 'GET', signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': `SyncWatch/${APP_VERSION}`, Accept: 'application/json,text/html' }
    };
    if (useEnvironmentProxy) {
      const httpProxy = environment.http_proxy || environment.HTTP_PROXY
        || environment.all_proxy || environment.ALL_PROXY;
      dispatcher = new EnvHttpProxyAgent({
        httpProxy,
        httpsProxy: environment.https_proxy || environment.HTTPS_PROXY || httpProxy,
        noProxy: environment.no_proxy ?? environment.NO_PROXY ?? '',
        proxyTunnel: false
      });
    }
    const response = useEnvironmentProxy
      ? await undiciFetch(url, { ...request, dispatcher })
      : await net.fetch(url, request);
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error('公网健康检查响应不可读');
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > MAX_TUNNEL_HEALTH_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error('公网健康检查响应过大');
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    const body = Buffer.concat(chunks, total).toString('utf8');
    return { ...parseTunnelProbeResponse(response.status, body), latencyMs: Math.max(0, Date.now() - startedAt) };
  } catch (_) {
    return { ok: false, latencyMs: Math.max(0, Date.now() - startedAt) };
  } finally {
    if (dispatcher) await dispatcher.destroy().catch(() => {});
  }
}

function probeHttpsDetailed(url, { localAddress = '' } = {}) {
  if (tunnelProbeTransport(localAddress) !== 'bound-native-https') {
    return probeHttpsThroughSystemNetwork(url);
  }
  return new Promise((resolve) => {
    let settled = false;
    let responseStarted = false;
    const startedAt = Date.now();
    const finish = (value) => { if (!settled) { settled = true; resolve({ ...value, latencyMs: Math.max(0, Date.now() - startedAt) }); } };
    const request = https.get(url, {
      family: 4, ...(localAddress ? { localAddress } : {}),
      headers: { 'User-Agent': `SyncWatch/${APP_VERSION}`, Accept: 'application/json,text/html' }
    }, (response) => {
      responseStarted = true;
      let body = '';
      let bodyBytes = 0;
      response.on('data', (chunk) => {
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_TUNNEL_HEALTH_BYTES) {
          finish({ ok: false, statusCode: response.statusCode || 0 });
          response.destroy(new Error('公网健康检查响应过大'));
          return;
        }
        body += chunk.toString('utf8');
      });
      response.on('end', () => {
        finish(parseTunnelProbeResponse(response.statusCode, body));
      });
      response.on('aborted', () => finish({ ok: false }));
      response.on('error', () => finish({ ok: false }));
      response.on('close', () => { if (!response.complete) finish({ ok: false }); });
    });
    request.setTimeout(8000, () => { request.destroy(); finish({ ok: false }); });
    request.on('error', () => finish({ ok: false }));
    request.on('close', () => { if (!responseStarted) finish({ ok: false }); });
  });
}

function probeHttps(url) { return probeHttpsDetailed(url).then((result) => result.ok); }

async function waitForPublicUrl(url, timeoutMs = 60000, { localAddress = '' } = {}) {
  const started = Date.now();
  let lastProbe = { ok: false, latencyMs: 0 };
  while (Date.now() - started < timeoutMs) {
    const probe = await probeHttpsDetailed(`${url}${TUNNEL_HEALTH_PATH}`, { localAddress });
    if (probe.ok) return probe;
    lastProbe = probe;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return lastProbe;
}

function physicalNetworkCandidates(interfaces = os.networkInterfaces() || {}) {
  const blockedName = /(?:vpn|\btun\d*\b|\btap\d*\b|utun|wintun|wireguard|tailscale|zerotier|clash|v2ray|代理|虚拟|virtual|loopback|vethernet|wsl|docker|hyper-?v|vmware|virtualbox|parallels|hamachi|npcap|\bbridge\d*\b|\bawdl\d*\b|\bllw\d*\b)/i;
  const preferredName = /(?:ethernet|以太网|wi-?fi|wlan|无线|en\d+|eth\d+)/i;
  const accepted = [];
  const rejected = [];
  let order = 0;
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      const address = String(entry?.address || '');
      let reason = '';
      if (blockedName.test(name)) reason = 'virtual-or-tunnel-adapter';
      else if (entry?.internal) reason = 'internal-adapter';
      else if (entry?.family !== 'IPv4' && entry?.family !== 4) reason = 'not-ipv4';
      else if (!address || /^(?:0\.0\.0\.0|127\.|169\.254\.)/.test(address)) reason = 'unusable-address';
      if (reason) {
        rejected.push({ name, address, reason });
        continue;
      }
      const privateAddress = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address);
      accepted.push({
        name, address, privateAddress, preferredName: preferredName.test(name),
        score: (privateAddress ? 4 : 0) + (preferredName.test(name) ? 2 : 0), order: order++
      });
    }
  }
  accepted.sort((left, right) => right.score - left.score || left.order - right.order);
  return { selected: accepted[0] || null, accepted, rejected };
}

function preferredPhysicalIpv4(interfaces = os.networkInterfaces() || {}) {
  return physicalNetworkCandidates(interfaces).selected?.address || '';
}

function tunnelRestartDelayMs(attempt, {
  baseDelayMs = TUNNEL_RESTART_BASE_DELAY_MS, maxDelayMs = TUNNEL_RESTART_MAX_DELAY_MS
} = {}) {
  const safeAttempt = Math.max(0, Math.min(16, Number.isFinite(Number(attempt)) ? Math.floor(Number(attempt)) : 0));
  const base = Math.max(1, Number(baseDelayMs) || TUNNEL_RESTART_BASE_DELAY_MS);
  const cap = Math.max(base, Number(maxDelayMs) || TUNNEL_RESTART_MAX_DELAY_MS);
  return Math.min(cap, base * (2 ** safeAttempt));
}

function isPublicIpv4Address(value) {
  const parts = String(value || '').trim().split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second, third] = parts;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false; // CGNAT
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 192 && second === 0 && third === 0) return false;
  if (first === 192 && second === 0 && third === 2) return false;
  if (first === 198 && second === 18) return false;
  if (first === 198 && second === 19) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function normalizeTunnelEdgeAddresses(values, limit = CLOUDFLARE_EDGE_MAX_ADDRESSES) {
  const source = Array.isArray(values) ? values : [values];
  const normalized = [];
  for (const value of source) {
    const address = String(value || '').trim().replace(/:\d+$/, '');
    if (!isPublicIpv4Address(address) || normalized.includes(address)) continue;
    normalized.push(address);
    if (normalized.length >= Math.max(1, Number(limit) || CLOUDFLARE_EDGE_MAX_ADDRESSES)) break;
  }
  return normalized;
}

function cloudflareEdgeTargetsFromSrv(answer) {
  const records = Array.isArray(answer) ? answer : answer?.Answer;
  if (!Array.isArray(records)) return [];
  const targets = [];
  for (const record of records) {
    if (record?.type !== undefined && Number(record.type) !== 33) continue;
    const data = String(record?.data || '').trim();
    const match = data.match(/^\d+\s+\d+\s+7844\s+([a-z0-9](?:[a-z0-9.-]{0,250})?)\.?$/i);
    const target = String(match?.[1] || '').toLowerCase().replace(/\.$/, '');
    if (!target || !/(?:^|\.)argotunnel\.com$/.test(target) || targets.includes(target)) continue;
    targets.push(target);
    if (targets.length >= CLOUDFLARE_EDGE_MAX_ADDRESSES) break;
  }
  return targets;
}

function publicIpv4AddressesFromDnsAnswer(answer) {
  const records = Array.isArray(answer) ? answer : answer?.Answer;
  if (!Array.isArray(records)) return [];
  return normalizeTunnelEdgeAddresses(records
    .filter((record) => record?.type === undefined || Number(record.type) === 1)
    .map((record) => record?.data));
}

function queryDnsOverHttps(name, type, { timeoutMs = 5000, endpoints = CLOUDFLARE_EDGE_DOH_ENDPOINTS } = {}) {
  const validName = String(name || '').trim().replace(/\.$/, '');
  const validType = String(type || '').toUpperCase();
  if (!/^[a-z0-9_.*-]+$/i.test(validName) || !['A', 'SRV'].includes(validType)) {
    return Promise.reject(new Error('DoH 查询参数无效'));
  }
  const candidates = Array.isArray(endpoints) && endpoints.length ? endpoints : CLOUDFLARE_EDGE_DOH_ENDPOINTS;
  return (async () => {
    let lastError = null;
    for (const endpoint of candidates) {
      try {
        const url = new URL(String(endpoint));
        if (url.protocol !== 'https:') throw new Error('DoH 必须使用 HTTPS');
        url.searchParams.set('name', validName);
        url.searchParams.set('type', validType);
        const payload = await new Promise((resolve, reject) => {
          const request = https.get(url, {
            headers: { Accept: 'application/dns-json', 'User-Agent': `SyncWatch/${APP_VERSION}` }, family: 4
          }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              body = `${body}${chunk}`;
              if (body.length > 256 * 1024) response.destroy(new Error('DoH 响应过大'));
            });
            response.once('error', reject);
            response.once('end', () => {
              if (response.statusCode !== 200) return reject(new Error(`DoH HTTP ${response.statusCode || 0}`));
              try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('DoH 返回内容不是有效 JSON')); }
            });
          });
          request.setTimeout(Math.max(500, Number(timeoutMs) || 5000), () => request.destroy(new Error('DoH 请求超时')));
          request.once('error', reject);
        });
        return payload;
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('DoH 查询失败');
  })();
}

async function resolveCloudflareEdgeAddressesViaDoh({ query = queryDnsOverHttps } = {}) {
  const fallbackTargets = ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com'];
  let targets = [];
  let srvError = '';
  try {
    targets = cloudflareEdgeTargetsFromSrv(await query('_v2-origintunneld._tcp.argotunnel.com', 'SRV'));
  } catch (error) { srvError = error.message; }
  if (!targets.length) targets = fallbackTargets;
  const addresses = [];
  const targetResults = [];
  for (const target of targets.slice(0, CLOUDFLARE_EDGE_MAX_ADDRESSES)) {
    try {
      const answer = await query(target, 'A');
      const resolved = publicIpv4AddressesFromDnsAnswer(answer);
      targetResults.push({ target, addresses: resolved });
      for (const address of resolved) {
        if (!addresses.includes(address)) addresses.push(address);
        if (addresses.length >= CLOUDFLARE_EDGE_MAX_ADDRESSES) break;
      }
    } catch (error) { targetResults.push({ target, addresses: [], error: error.message }); }
    if (addresses.length >= CLOUDFLARE_EDGE_MAX_ADDRESSES) break;
  }
  return {
    ok: addresses.length > 0, addresses: addresses.slice(0, CLOUDFLARE_EDGE_MAX_ADDRESSES),
    targets, targetResults, ...(srvError ? { srvError } : {})
  };
}

function tunnelCommandArgs(mode, port, {
  bypassProxy = false, bindAddress = '', protocol = '', edgeIpVersion = '4', retries = 12, edgeAddresses = []
} = {}) {
  const selectedProtocol = protocol || 'auto';
  const transport = ['--protocol', selectedProtocol, '--edge-ip-version', edgeIpVersion];
  const binding = bypassProxy && bindAddress ? ['--edge-bind-address', bindAddress] : [];
  const pinnedEdges = bypassProxy
    ? normalizeTunnelEdgeAddresses(edgeAddresses).flatMap((address) => ['--edge', `${address}:${CLOUDFLARE_EDGE_PORT}`])
    : [];
  const resilience = ['--retries', String(Math.max(1, Math.min(30, Number(retries) || 12)))];
  return mode === 'quick'
    ? ['tunnel', '--url', `http://127.0.0.1:${port}`, ...transport, ...pinnedEdges, ...binding, ...resilience, '--no-autoupdate']
    : ['tunnel', ...transport, ...pinnedEdges, ...binding, ...resilience, '--no-autoupdate', 'run'];
}

function tunnelEnvironment(bypassProxy = false, extra = {}) {
  const environment = { ...process.env, ...extra };
  if (bypassProxy) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete environment[key];
    environment.NO_PROXY = '*'; environment.no_proxy = '*';
  }
  return environment;
}

function tunnelConnectionStrategies(mode, {
  bypassProxy = DEFAULT_TUNNEL_BYPASS_PROXY, bindAddress = '', edgeAddresses = []
} = {}) {
  const strategies = [];
  const pinnedEdges = normalizeTunnelEdgeAddresses(edgeAddresses);
  const quickMode = mode === 'quick';
  if (quickMode && bypassProxy && bindAddress && pinnedEdges.length) {
    strategies.push({
      id: 'direct-auto-pinned-edge',
      label: `QUIC/HTTP/2 自动降级直连（DoH Edge ${pinnedEdges.length} 个）`,
      protocol: 'auto', edgeIpVersion: '4', bindAddress, edgeAddresses: pinnedEdges, bypassProxy: true
    });
  }
  if (quickMode) {
    strategies.push({
      id: bypassProxy ? 'direct-auto' : 'system-auto',
      label: bypassProxy ? 'QUIC/HTTP/2 自动降级直连' : 'QUIC/HTTP/2 自动降级（系统网络）',
      protocol: 'auto', edgeIpVersion: '4', bindAddress: '', bypassProxy: Boolean(bypassProxy)
    });
  }
  if (bypassProxy && bindAddress && pinnedEdges.length) {
    if (!quickMode) strategies.push({
      id: 'direct-http2-pinned-edge',
      label: `HTTP/2 IPv4 直连（DoH Edge ${pinnedEdges.length} 个）`,
      protocol: 'http2', edgeIpVersion: '4', bindAddress, edgeAddresses: pinnedEdges, bypassProxy: true
    });
  }
  if (!quickMode && bypassProxy && bindAddress) {
    strategies.push({ id: 'direct-http2-bound', label: `HTTP/2 IPv4 直连（${bindAddress}）`, protocol: 'http2', edgeIpVersion: '4', bindAddress, bypassProxy: true });
  }
  strategies.push({
    id: bypassProxy ? 'direct-http2' : 'system-http2',
    label: bypassProxy ? 'HTTP/2 IPv4 直连（自动出口）' : 'HTTP/2 IPv4（系统网络）',
    protocol: 'http2', edgeIpVersion: '4', bindAddress: '', bypassProxy: Boolean(bypassProxy)
  });
  if (!quickMode) strategies.push({
    id: bypassProxy ? 'direct-auto' : 'system-auto',
    label: bypassProxy ? 'QUIC/HTTP/2 自动降级直连' : 'QUIC/HTTP/2 自动降级（系统网络）',
    protocol: 'auto', edgeIpVersion: '4', bindAddress: '', bypassProxy: Boolean(bypassProxy)
  });
  if (quickMode && strategies.length < QUICK_TUNNEL_MAX_ATTEMPTS) {
    strategies.push({
      id: bypassProxy ? 'direct-http2-retry' : 'system-http2-retry',
      label: bypassProxy ? 'HTTP/2 IPv4 直连（DNS 刷新后重试）' : 'HTTP/2 IPv4（最终重试）',
      protocol: 'http2', edgeIpVersion: '4', bindAddress: '', retry: true, bypassProxy: Boolean(bypassProxy)
    });
  }
  const limit = quickMode ? QUICK_TUNNEL_MAX_ATTEMPTS : 2;
  if (quickMode && bypassProxy) {
    return [...strategies.filter((strategy) => strategy.id !== 'direct-http2-bound').slice(0, limit - 1), {
      id: 'system-auto-fallback', label: 'QUIC/HTTP/2 自动降级（系统网络最终回退）',
      protocol: 'auto', edgeIpVersion: '4', bindAddress: '', edgeAddresses: [], bypassProxy: false, retry: true
    }].slice(0, limit);
  }
  return strategies.slice(0, limit);
}

function tunnelProbeLocalAddress() {
  // The connector's edge route and a viewer's public HTTPS route are
  // independent. Always verify the published URL through the same system or
  // proxy path a browser uses, even when cloudflared itself is edge-bound.
  return '';
}

function sanitizeTunnelLog(value, limit = 6000) {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\b(TUNNEL_TOKEN|token|credential|authorization)\b([=:]\s*)\S+/ig, '$1$2[已隐藏]')
      .replace(/(--token\s+)\S+/ig, '$1[已隐藏]')
    .slice(-Math.max(500, Number(limit) || 6000));
}

function extractQuickTunnelPublicUrl(logValue) {
  const matches = String(logValue || '').matchAll(/https:\/\/([a-z0-9](?:[a-z0-9-]{0,62}))\.trycloudflare\.com\b/ig);
  for (const match of matches) {
    const label = String(match[1] || '').toLowerCase();
    // cloudflared also logs its provisioning API URL. Publishing that host as
    // the tunnel address makes the UI report a link before a connector exists.
    if (!label || ['api', 'www'].includes(label) || !label.includes('-')) continue;
    return `https://${label}.trycloudflare.com`;
  }
  return '';
}

function tunnelConnectorRegistered(logValue) {
  return /Registered tunnel connection|Connection [^\r\n]* registered/i.test(String(logValue || ''));
}

function tunnelFakeIpAddresses(logValue) {
  return [...new Set((String(logValue || '').match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || []).filter(isTunnelFakeIp))];
}

function classifyTunnelFailure(logValue, { code = null, signal = '' } = {}) {
  const log = String(logValue || '');
  if (tunnelFakeIpAddresses(log).length) {
    return { code: 'VPN_TUN_FAKE_IP', title: 'VPN/TUN Fake-IP 拦截了 cloudflared 连接' };
  }
  if (/(?:\b7844\b[^\r\n]{0,180}(?:timeout|timed out|blocked|refused|unreachable)|(?:timeout|timed out|blocked|refused|unreachable)[^\r\n]{0,180}\b7844\b)/i.test(log)) {
    return { code: 'EDGE_PORT_7844_BLOCKED', title: 'Cloudflare 边缘端口 7844 连接超时或被拦截' };
  }
  if (/failed to request quick Tunnel|api\.trycloudflare\.com[\s\S]{0,200}(?:deadline|timeout)|Client\.Timeout exceeded|context deadline exceeded/i.test(log)) {
    return { code: 'QUICK_API_TIMEOUT', title: 'Cloudflare 临时地址接口连接超时' };
  }
  if (/no such host|server misbehaving|lookup [^\s]+.*(?:failed|timeout)|DNS/i.test(log)) {
    return { code: 'DNS_RESOLUTION_FAILED', title: 'DNS 解析异常' };
  }
  if (/bind|cannot assign requested address|requested address is not valid|address.*not available/i.test(log)) {
    return { code: 'BIND_ADDRESS_FAILED', title: '物理网卡绑定失败' };
  }
  if (/QUIC|UDP|no recent network activity|timeout: no recent network activity/i.test(log)) {
    return { code: 'QUIC_BLOCKED', title: 'QUIC/UDP 连接可能被拦截' };
  }
  if (/x509|certificate|TLS handshake|unknown authority/i.test(log)) {
    return { code: 'TLS_INTERCEPTED', title: 'TLS 证书或 HTTPS 检查异常' };
  }
  if (/Unauthorized|authentication|credentials|tunnel token|failed to parse token/i.test(log)) {
    return { code: 'AUTHENTICATION_FAILED', title: 'Cloudflare 隧道凭据无效' };
  }
  if (/dial tcp|connectex|network is unreachable|failed to connect to edge|connection refused|i\/o timeout/i.test(log)) {
    return { code: 'EDGE_CONNECTIVITY_FAILED', title: 'Cloudflare 边缘网络连接失败' };
  }
  if (signal) return { code: 'PROCESS_SIGNAL_EXIT', title: `cloudflared 被系统终止（${signal}）` };
  return { code: Number.isInteger(code) ? `PROCESS_EXIT_${code}` : 'PROCESS_START_FAILED', title: 'cloudflared 进程异常退出' };
}

function isTunnelFakeIp(address) {
  const parts = String(address || '').split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

function tunnelRepairRecommendations({ failureCode = '', fakeIpDns = false, tunAdapters = [], bypassProxy = true } = {}) {
  const recommendations = [];
  if (failureCode === 'VPN_TUN_FAKE_IP' || fakeIpDns || tunAdapters.length) {
    recommendations.push({
      code: 'VPN_TUN_DIRECT_RULE', severity: 'warning', title: '让 cloudflared 进程真正绕过 VPN/TUN',
      detail: `检测到${fakeIpDns ? ' Fake-IP DNS' : ''}${fakeIpDns && tunAdapters.length ? ' 和' : ''}${tunAdapters.length ? `虚拟网卡（${tunAdapters.join('、')}）` : ''}。如果浏览器可联网但物理网卡直连超时，请先取消勾选“绕过系统代理”；必须直连时，再把 cloudflared 进程和 trycloudflare.com、argotunnel.com 设为 DIRECT。`
    });
  }
  if (failureCode === 'QUICK_API_TIMEOUT' || failureCode === 'DNS_RESOLUTION_FAILED' || failureCode === 'VPN_TUN_FAKE_IP' || fakeIpDns) {
    recommendations.push({
      code: 'DNS_AND_ROUTER_REPAIR', severity: 'warning', title: '修复家庭路由器 DNS 与连接超时',
      detail: '先重启光猫和路由器，将电脑或路由器 DNS 改为 1.1.1.1/1.0.0.1 或 8.8.8.8/8.8.4.4，再执行 DNS 缓存刷新。SyncWatch同步观影 的“网络诊断与修复”会自动刷新本机 DNS 并用备用连接策略重试。'
    });
  }
  if (failureCode === 'QUIC_BLOCKED' || failureCode === 'EDGE_CONNECTIVITY_FAILED' || failureCode === 'EDGE_PORT_7844_BLOCKED' || failureCode === 'QUICK_API_TIMEOUT') {
    recommendations.push({
      code: 'FIREWALL_EGRESS', severity: 'info', title: '检查家庭网络出站规则',
      detail: '允许 cloudflared 出站访问 TCP 443、TCP 7844 与 UDP 7844。路由器或运营商屏蔽 UDP 7844 时，SyncWatch同步观影 会自动降级到 HTTP/2。'
    });
  }
  if (!bypassProxy && !fakeIpDns && !tunAdapters.length) {
    recommendations.push({
      code: 'ENABLE_PROXY_BYPASS', severity: 'info', title: '开启绕过系统代理',
      detail: '建议勾选“绕过系统代理启动 cloudflared”，避免 HTTP_PROXY/HTTPS_PROXY 环境变量把隧道送入延迟较高的代理节点。'
    });
  }
  recommendations.push({
    code: 'NAMED_TUNNEL_FOR_UPTIME', severity: 'info', title: '长时间稳定使用建议配置固定隧道',
    detail: 'trycloudflare.com 临时地址本身没有可用性保证，进程退出后旧随机地址无法恢复。长时间 4K 观影建议使用 Cloudflare 固定隧道令牌和自有域名。'
  });
  return recommendations;
}

function withTimeout(promise, timeoutMs, fallback) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

async function resolveTunnelDns() {
  try {
    return await withTimeout(dns.promises.resolve4('api.trycloudflare.com'), 5000, []);
  } catch (_) { return []; }
}

function probeTcp(host, port, { localAddress = '', timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = nodeNet.createConnection({ host, port, ...(localAddress ? { localAddress } : {}) });
    let settled = false;
    let timer = null;
    const finish = (ok, error = '') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, host, port, localAddress, latencyMs: Date.now() - startedAt, error: String(error || '') });
    };
    socket.setTimeout(timeoutMs, () => finish(false, 'timeout'));
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(false, error.code || error.message));
  });
}

function flushDnsCache() {
  let executable = '';
  let args = [];
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    executable = path.join(systemRoot, 'System32', 'ipconfig.exe');
    args = ['/flushdns'];
  } else {
    return Promise.resolve({ success: true, skipped: true });
  }
  if (!fs.existsSync(executable)) return Promise.resolve({ success: false, error: `未找到 ${path.basename(executable)}` });
  return new Promise((resolve) => {
    const child = spawn(executable, args, { windowsHide: true });
    let output = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 8000);
    child.stdout.on('data', (data) => { output = `${output}${data}`.slice(-1000); });
    child.stderr.on('data', (data) => { output = `${output}${data}`.slice(-1000); });
    child.once('error', (error) => { clearTimeout(timer); resolve({ success: false, error: error.message }); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ success: code === 0, code, output: output.trim() }); });
  });
}

function applyTunnelHealthProbe(current, probe, healthFailures = 0, {
  processRunning = true, checkedAt = Date.now(), candidatePublicUrl = ''
} = {}) {
  if (probe?.ok) {
    return {
      healthFailures: 0,
      current: {
        ...current, state: 'running', health: 'healthy', verified: true, error: '',
        publicUrl: candidatePublicUrl || current.publicUrl || '',
        latencyMs: Number(probe.latencyMs) || null, lastCheckedAt: checkedAt, lastHealthyAt: checkedAt
      }
    };
  }
  const nextFailures = Math.max(0, Number(healthFailures) || 0) + 1;
  if (!processRunning) {
    return {
      healthFailures: nextFailures,
      current: {
        ...current, state: 'error', publicUrl: '', lastPublicUrl: current.publicUrl || current.lastPublicUrl || '', health: 'offline', verified: false, latencyMs: null,
        error: 'cloudflared 进程已退出，请重新开启公网访问', lastCheckedAt: checkedAt
      }
    };
  }
  const explicitCloudflareFailure = probe?.cloudflareErrorCode === 1033 || probe?.statusCode === 530;
  const keepVerifiedAddress = current.state !== 'verifying' && !explicitCloudflareFailure
    && current.verified === true && Boolean(current.publicUrl);
  return {
    healthFailures: nextFailures,
    current: {
      ...current,
      state: current.state === 'verifying' ? 'verifying' : 'running',
      publicUrl: current.state === 'verifying' ? '' : current.publicUrl,
      health: current.state === 'verifying' ? 'verifying' : 'degraded', verified: keepVerifiedAddress, latencyMs: null,
      error: explicitCloudflareFailure
        ? `Cloudflare 返回 ${probe?.cloudflareErrorCode === 1033 ? '1033' : 'HTTP 530'}：公网地址已生成，但连接器尚未在边缘网络注册；不会发布该地址，请等待自动恢复或运行网络诊断`
        : current.state === 'verifying'
        ? `公网地址已生成且连接器已注册，但 ${TUNNEL_HEALTH_PATH} 尚未验证成功；验证完成前不会发布该地址`
        : nextFailures >= 3
        ? '公网探测波动：连续超时，但隧道进程仍在运行；已保持原地址并等待 cloudflared 自动恢复'
        : '公网探测波动：暂时超时，隧道进程仍在运行；已保持原地址继续服务',
      lastCheckedAt: checkedAt
    }
  };
}

function tunnelProbeNeedsConnectorRestart(probe, healthFailures) {
  return probe?.cloudflareErrorCode === 1033 && Math.max(0, Number(healthFailures) || 0) >= 3;
}

function createTunnelManager(dataDir, getPort, { onAutoStartChanged = null } = {}) {
  const runtime = cloudflaredRuntime();
  const toolsDir = path.join(dataDir, 'tools');
  const binary = path.join(toolsDir, runtime.binaryName);
  const verificationMarker = path.join(toolsDir, 'cloudflared.verified.json');
  const startupFile = path.join(dataDir, 'tunnel-startup.json');
  let child = null;
  let operationId = 0;
  let binaryPromise = null;
  let healthProbePromise = null;
  let healthFailures = 0;
  let attemptHistory = [];
  let lastExit = null;
  let lastLogTail = '';
  let desiredTunnel = null;
  let restartEligibleProcess = null;
  let autoRestartTimer = null;
  let autoRestartAttempts = 0;
  let recoveryGeneration = 0;
  let pendingPublicUrl = '';
  let lastPreflight = null;
  let current = { state: 'stopped', mode: '', publicUrl: '', error: '', latencyMs: null, reconnectCount: 0, lastCheckedAt: 0, bypassProxy: DEFAULT_TUNNEL_BYPASS_PROXY };
  let startup = { autoStartTunnel: false, mode: 'quick', token: '', publicUrl: '', bypassProxy: DEFAULT_TUNNEL_BYPASS_PROXY, autoDiagnose: true };

  function normalizeTunnelStartup(value = {}) {
    const mode = value.mode === 'named' ? 'named' : 'quick';
    let publicUrl = '';
    try { publicUrl = normalizePublicUrl(value.publicUrl || ''); } catch (_) { publicUrl = ''; }
    return {
      autoStartTunnel: value.autoStartTunnel === true,
      mode,
      token: String(value.token || '').trim().slice(0, 4096),
      publicUrl, bypassProxy: value.bypassProxy !== false,
      autoDiagnose: value.autoDiagnose !== false
    };
  }

  function loadTunnelStartup() {
    try {
      if (fs.existsSync(startupFile)) startup = normalizeTunnelStartup(JSON.parse(fs.readFileSync(startupFile, 'utf8')));
    } catch (error) { console.warn('公网隧道启动配置读取失败，将使用默认设置：', error.message); startup = normalizeTunnelStartup(); }
    return startup;
  }

  loadTunnelStartup();

  function publicTunnelStartup() {
    return {
      autoStartTunnel: startup.autoStartTunnel, mode: startup.mode, publicUrl: startup.publicUrl,
      bypassProxy: startup.bypassProxy === true, autoDiagnose: startup.autoDiagnose !== false,
      tokenConfigured: Boolean(startup.token)
    };
  }

  async function saveTunnelStartup(input = {}) {
    const hasToken = Object.prototype.hasOwnProperty.call(input, 'token');
    const nextInput = {
      ...startup,
      ...input,
      token: hasToken ? String(input.token || '').trim() : startup.token
    };
    const next = normalizeTunnelStartup(nextInput);
    if (next.mode === 'named' && next.autoStartTunnel && !next.token) throw new Error('稳定隧道开启自动公网访问时必须保存 Cloudflare Tunnel 令牌');
    startup = next;
    atomicWriteJson(startupFile, startup);
    if (typeof onAutoStartChanged === 'function') await onAutoStartChanged(startup.autoStartTunnel);
    return publicTunnelStartup();
  }

  function verifyBinarySignature(filename) {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (!fs.existsSync(powershell)) return Promise.reject(new Error('系统缺少用于验证 cloudflared 签名的 Windows PowerShell'));
    const command = [
      "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop",
      "$signature = Get-AuthenticodeSignature -LiteralPath $env:SYNCWATCH_SIGNATURE_FILE",
      "if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch 'Cloudflare') {",
      "  Write-Error ('cloudflared signature rejected: ' + $signature.Status + ' / ' + $signature.SignerCertificate.Subject)",
      '  exit 1',
      '}'
    ].join('; ');
    return new Promise((resolve, reject) => {
      const systemModulePath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
      const verifier = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        env: { ...process.env, PSModulePath: systemModulePath, SYNCWATCH_SIGNATURE_FILE: filename }
      });
      let output = '';
      const timer = setTimeout(() => verifier.kill('SIGKILL'), 15000);
      verifier.stdout.on('data', (data) => { output = `${output}${data}`.slice(-2000); });
      verifier.stderr.on('data', (data) => { output = `${output}${data}`.slice(-2000); });
      verifier.once('error', (error) => {
        clearTimeout(timer);
        console.error('无法启动 cloudflared 数字签名验证（原始错误仅写入日志）:', error);
        reject(new Error('无法验证 cloudflared 数字签名，请确认系统验证组件完整'));
      });
      verifier.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          if (output.trim()) console.error('cloudflared 数字签名验证输出（仅日志）:', output.trim());
          reject(new Error('cloudflared 数字签名无效，请删除该组件后重试'));
        }
      });
    });
  }

  function verifiedBinaryUnchanged() {
    if (!fs.existsSync(binary) || !fs.existsSync(verificationMarker)) return false;
    try {
      const stats = fs.statSync(binary);
      const marker = JSON.parse(fs.readFileSync(verificationMarker, 'utf8'));
      if (stats.size < CLOUDFLARED_MIN_BINARY_BYTES || marker.size !== stats.size
        || marker.platform !== runtime.platform || marker.arch !== runtime.arch) return false;
      return marker.mtimeMs === stats.mtimeMs;
    } catch (_) { return false; }
  }

  function rememberVerifiedBinary(metadata = {}) {
    const stats = fs.statSync(binary);
    fs.writeFileSync(verificationMarker, JSON.stringify({
      platform: runtime.platform, arch: runtime.arch, assetName: runtime.assetName,
      size: stats.size, mtimeMs: stats.mtimeMs,
      ...(metadata.release ? { release: metadata.release } : {}),
      verifiedAt: new Date().toISOString()
    }));
  }

  function bundledBinaryCandidates() {
    const bundledNames = [
      runtime.binaryName,
    ];
    const roots = [process.resourcesPath || '', __dirname];
    return [...new Set(roots.flatMap((root) => bundledNames.map((name) => path.join(root, 'vendor', name))))]
      .filter((candidate) => candidate && candidate !== binary && fs.existsSync(candidate));
  }

  async function ensureBinary() {
    if (verifiedBinaryUnchanged()) return;
    if (fs.existsSync(binary)) {
      if (fs.statSync(binary).size >= CLOUDFLARED_MIN_BINARY_BYTES) {
        try { await verifyBinarySignature(binary); rememberVerifiedBinary(); return; }
        catch (_) {}
      }
      fs.unlinkSync(binary);
    }
    fs.rmSync(verificationMarker, { force: true });
    if (!binaryPromise) binaryPromise = (async () => {
      fs.mkdirSync(toolsDir, { recursive: true });
      const temporary = `${binary}.download`;
      let releaseAsset = null;
      try {
        fs.rmSync(temporary, { force: true });
        const bundled = bundledBinaryCandidates().find((candidate) => fs.statSync(candidate).size >= CLOUDFLARED_MIN_BINARY_BYTES);
        if (bundled) {
          fs.copyFileSync(bundled, temporary, fs.constants.COPYFILE_EXCL);
        } else {
          releaseAsset = await cloudflaredReleaseAsset(runtime.assetName);
          await downloadFile(releaseAsset.url, temporary);
          verifyCloudflaredReleaseFile(temporary, releaseAsset);
        }
        if (!fs.existsSync(temporary) || fs.statSync(temporary).size < CLOUDFLARED_MIN_BINARY_BYTES) throw new Error('cloudflared 下载文件不完整');
        await verifyBinarySignature(temporary);
        fs.renameSync(temporary, binary);
        rememberVerifiedBinary(releaseAsset || {});
      } catch (error) {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        fs.rmSync(verificationMarker, { force: true });
        throw error;
      }
    })().finally(() => { binaryPromise = null; });
    await binaryPromise;
  }

  function terminateProcess(processToStop, timeoutMs = 3000) {
    if (!processToStop || processToStop.exitCode !== null || processToStop.signalCode) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let forceTimer = null;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(forceTimer); resolve(); };
      const timer = setTimeout(() => {
        try { processToStop.kill('SIGKILL'); } catch (_) {}
        forceTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('cloudflared 无法停止，请在任务管理器中结束该进程'));
        }, 2000);
      }, timeoutMs);
      processToStop.once('exit', finish);
      try { processToStop.kill(); } catch (_) { finish(); }
    });
  }

  function cancelAutoRestart() {
    if (autoRestartTimer) clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
  }

  function scheduleAutoRestart(failure = {}) {
    if (!desiredTunnel || autoRestartTimer) return;
    const generation = recoveryGeneration;
    const delayMs = tunnelRestartDelayMs(autoRestartAttempts);
    autoRestartAttempts += 1;
    pendingPublicUrl = '';
    current = {
      ...current, state: 'reconnecting', publicUrl: '', verified: false, health: 'reconnecting',
      reconnectCount: autoRestartAttempts, nextRetryAt: Date.now() + delayMs,
      error: `${failure.title || 'cloudflared 进程异常退出'}，将在 ${Math.ceil(delayMs / 1000)} 秒后自动恢复公网访问`,
      failureCode: failure.code || current.failureCode || '',
      failureTitle: failure.title || current.failureTitle || ''
    };
    autoRestartTimer = setTimeout(async () => {
      autoRestartTimer = null;
      if (!desiredTunnel || generation !== recoveryGeneration) return;
      const requested = { ...desiredTunnel };
      try {
        await start(requested, { automaticRecovery: true, expectedRecoveryGeneration: generation });
      } catch (error) {
        if (!desiredTunnel || generation !== recoveryGeneration) return;
        current = {
          ...current, state: 'reconnecting', publicUrl: '', verified: false, health: 'reconnecting',
          error: userFacingDesktopError(error, '公网隧道自动恢复失败，正在继续重试', '公网隧道恢复失败')
        };
        scheduleAutoRestart({
          code: current.failureCode || 'AUTO_RESTART_FAILED',
          title: current.failureTitle || '公网隧道自动恢复失败'
        });
      }
    }, delayMs);
    autoRestartTimer.unref?.();
  }

  async function stop() {
    recoveryGeneration += 1;
    cancelAutoRestart();
    desiredTunnel = null;
    restartEligibleProcess = null;
    autoRestartAttempts = 0;
    operationId += 1;
    const processToStop = child;
    child = null;
    pendingPublicUrl = '';
    await terminateProcess(processToStop);
    current = {
      state: 'stopped', mode: '', publicUrl: '', error: '', latencyMs: null,
      reconnectCount: 0, lastCheckedAt: 0, bypassProxy: current.bypassProxy !== false,
      lastExit, lastLogTail, attempts: [...attemptHistory]
    };
    healthFailures = 0;
    return { ...current };
  }

  function rememberAttempt({ strategy, startedAt, success = false, error = '', code = null, signal = '', log = '' }) {
    const failure = success ? null : classifyTunnelFailure(log || error, { code, signal });
    const entry = {
      strategy: strategy.id, strategyLabel: strategy.label, success,
      startedAt: new Date(startedAt).toISOString(), durationMs: Math.max(0, Date.now() - startedAt),
      ...(failure ? { failureCode: failure.code, failureTitle: failure.title } : {}),
      ...(Number.isInteger(code) ? { exitCode: code } : {}), ...(signal ? { signal } : {})
    };
    attemptHistory = [...attemptHistory.slice(-5), entry];
    lastLogTail = sanitizeTunnelLog(log || lastLogTail);
    if (!success) lastExit = {
      code: Number.isInteger(code) ? code : null, signal: signal || '',
      failureCode: failure.code, title: failure.title, at: new Date().toISOString()
    };
    return { entry, failure };
  }

  async function launchTunnelAttempt({ startId, mode, publicUrl, token, bypassProxy, strategy, attemptIndex, attemptCount }) {
    const startedAt = Date.now();
    const attemptBypassProxy = Object.prototype.hasOwnProperty.call(strategy, 'bypassProxy')
      ? strategy.bypassProxy !== false : Boolean(bypassProxy);
    const args = tunnelCommandArgs(mode, getPort(), {
      bypassProxy: attemptBypassProxy, bindAddress: strategy.bindAddress,
      protocol: strategy.protocol, edgeIpVersion: strategy.edgeIpVersion, retries: 12,
      edgeAddresses: strategy.edgeAddresses || []
    });
    const environment = tunnelEnvironment(attemptBypassProxy, mode === 'named' ? { TUNNEL_TOKEN: token.trim() } : {});
    current = {
      ...current, state: attemptIndex === 0 ? 'starting' : 'reconnecting', mode,
      publicUrl: '', error: '', verified: false,
      bypassProxy, bindAddress: strategy.bindAddress || '', strategy: strategy.id,
      edgeAddresses: normalizeTunnelEdgeAddresses(strategy.edgeAddresses || []),
      strategyLabel: strategy.label, activeNetworkMode: attemptBypassProxy ? 'direct' : 'system',
      attempt: attemptIndex + 1, maxAttempts: attemptCount,
      attempts: [...attemptHistory]
    };

    let tunnelProcess;
    try {
      tunnelProcess = spawn(binary, args, { windowsHide: true, env: environment });
    } catch (error) {
      const detail = userFacingDesktopError(error, '公网隧道组件无法启动，请重新下载后重试', '启动公网隧道进程失败');
      rememberAttempt({ strategy, startedAt, error: detail });
      return { success: false, error: detail, log: detail, code: null, signal: '' };
    }
    child = tunnelProcess;
    let log = '';
    let candidatePublicUrl = '';
    let connectorReady = false;
    let expectedTermination = false;
    let settled = false;
    let timer = null;
    let settleAttempt;
    const attemptResult = new Promise((resolve) => { settleAttempt = resolve; });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleAttempt(value);
    };
    const handleLog = (data) => {
      log = sanitizeTunnelLog(`${log}${data}`, 12000);
      lastLogTail = sanitizeTunnelLog(log);
      if (operationId !== startId || child !== tunnelProcess) return;
      candidatePublicUrl ||= mode === 'quick' ? extractQuickTunnelPublicUrl(log) : publicUrl;
      connectorReady ||= tunnelConnectorRegistered(log);
      if (!settled && mode === 'quick' && candidatePublicUrl) {
        current = {
          ...current, state: connectorReady ? 'verifying' : 'starting', mode,
          publicUrl: '',
          error: connectorReady ? '' : '公网地址已生成，正在等待 cloudflared 连接器注册',
          verified: false, lastLogTail
        };
        if (connectorReady) finish({ success: true, publicUrl: candidatePublicUrl });
      }
      if (!settled && mode === 'named' && connectorReady) {
        current = { ...current, state: 'verifying', mode, publicUrl: '', error: '', verified: false, lastLogTail };
        finish({ success: true, publicUrl });
      }
    };
    tunnelProcess.stdout.on('data', handleLog);
    tunnelProcess.stderr.on('data', handleLog);
    tunnelProcess.once('error', (error) => {
      if (operationId !== startId || child !== tunnelProcess) return;
      const detail = userFacingDesktopError(error, '公网隧道组件无法启动，请重新下载后重试', '启动公网隧道进程失败');
      child = null;
      pendingPublicUrl = '';
      current = { ...current, state: 'error', publicUrl: '', error: detail, verified: false, lastLogTail };
      finish({ success: false, error: detail, code: null, signal: '', log });
    });
    tunnelProcess.once('exit', (code, signal) => {
      if (expectedTermination) {
        if (child === tunnelProcess) child = null;
        return;
      }
      if (operationId !== startId || child !== tunnelProcess) return;
      const failedUrl = current.publicUrl || pendingPublicUrl || current.lastPublicUrl || '';
      const failure = classifyTunnelFailure(log, { code, signal });
      const detail = `${failure.title}：cloudflared 已退出（${code ?? signal ?? '未知'}）`;
      const shouldRecover = restartEligibleProcess === tunnelProcess && Boolean(desiredTunnel);
      restartEligibleProcess = null;
      lastExit = { code: Number.isInteger(code) ? code : null, signal: signal || '', failureCode: failure.code, title: failure.title, at: new Date().toISOString() };
      lastLogTail = sanitizeTunnelLog(log);
      current = {
        ...current, state: shouldRecover ? 'reconnecting' : (code === 0 ? 'stopped' : 'error'), publicUrl: '',
        lastPublicUrl: failedUrl, error: detail, verified: false, lastExit, lastLogTail
      };
      pendingPublicUrl = '';
      child = null;
      finish({ success: false, error: detail, code, signal, log });
      if (shouldRecover) scheduleAutoRestart(failure);
    });
    timer = setTimeout(() => {
      if (operationId !== startId || child !== tunnelProcess || settled) return;
      const failure = classifyTunnelFailure(log);
      const detail = candidatePublicUrl
        ? `公网地址已生成但连接器未能注册：${failure.title}`
        : `连接策略“${strategy.label}”在 ${Math.round(QUICK_TUNNEL_ATTEMPT_TIMEOUT_MS / 1000)} 秒内没有创建公网地址：${failure.title}`;
      finish({ success: false, error: detail, code: null, signal: '', log });
    }, mode === 'quick' ? QUICK_TUNNEL_ATTEMPT_TIMEOUT_MS : 35000);

    const result = await attemptResult;
    if (!result.success && child === tunnelProcess && tunnelProcess.exitCode === null && !tunnelProcess.signalCode) {
      expectedTermination = true;
      child = null;
      try {
        await terminateProcess(tunnelProcess);
      } catch (error) {
        result.terminationError = userFacingDesktopError(
          error,
          'cloudflared 未能停止，已取消继续重试以避免遗留后台进程',
          '停止公网隧道进程失败'
        );
      }
    }
    return { ...result, process: tunnelProcess, getLog: () => log, startedAt };
  }

  async function runTunnelPreflight({ bypassProxy = DEFAULT_TUNNEL_BYPASS_PROXY } = {}) {
    const networkCandidates = physicalNetworkCandidates();
    const physicalIpv4 = networkCandidates.selected?.address || '';
    const [dnsAddresses, apiTcp, apiTcpPhysical, edgeTcp] = await Promise.all([
      resolveTunnelDns(),
      probeTcp('api.trycloudflare.com', 443),
      physicalIpv4 ? probeTcp('api.trycloudflare.com', 443, { localAddress: physicalIpv4 }) : Promise.resolve({ ok: false, skipped: true }),
      probeTcp('region1.v2.argotunnel.com', CLOUDFLARE_EDGE_PORT, bypassProxy && physicalIpv4 ? { localAddress: physicalIpv4 } : {})
    ]);
    const fakeIpDns = dnsAddresses.some(isTunnelFakeIp);
    let edgeDiscovery = { ok: false, addresses: [], targets: [], targetResults: [] };
    if (bypassProxy && physicalIpv4 && fakeIpDns) {
      edgeDiscovery = await resolveCloudflareEdgeAddressesViaDoh();
      const edgeProbes = await Promise.all(edgeDiscovery.addresses.map((address) =>
        probeTcp(address, CLOUDFLARE_EDGE_PORT, { localAddress: physicalIpv4 })));
      const reachable = edgeProbes.filter((probe) => probe.ok).map((probe) => probe.host);
      edgeDiscovery = { ...edgeDiscovery, reachableAddresses: reachable, ok: reachable.length > 0 };
    }
    const edgeFailure = edgeTcp?.ok ? '' : classifyTunnelFailure(`${CLOUDFLARE_EDGE_PORT} ${edgeTcp?.error || 'timeout'}`).code;
    const hasPinnedEdge = Boolean(edgeDiscovery.ok && edgeDiscovery.reachableAddresses?.length);
    const failureCode = fakeIpDns
      ? (hasPinnedEdge ? '' : 'VPN_TUN_FAKE_IP')
      : edgeFailure || (!apiTcp.ok && 'QUICK_API_TIMEOUT') || '';
    return {
      checkedAt: new Date().toISOString(), bypassProxy: Boolean(bypassProxy), physicalIpv4,
      networkCandidates, dnsAddresses, fakeIpDns,
      edgeAddresses: hasPinnedEdge ? edgeDiscovery.reachableAddresses : [],
      edgeDiscovery,
      checks: { apiTcp, apiTcpPhysical, edgeTcp }, failureCode
    };
  }

  async function start(
    { mode = 'quick', token = '', publicUrl = '', bypassProxy = DEFAULT_TUNNEL_BYPASS_PROXY, autoDiagnose = startup.autoDiagnose !== false } = {},
    { automaticRecovery = false, expectedRecoveryGeneration = null } = {}
  ) {
    if (automaticRecovery) {
      if (!desiredTunnel || expectedRecoveryGeneration !== recoveryGeneration) throw new Error('公网隧道自动恢复已取消');
    } else {
      recoveryGeneration += 1;
      cancelAutoRestart();
      desiredTunnel = null;
      restartEligibleProcess = null;
      autoRestartAttempts = 0;
    }
    const startId = ++operationId;
    const operationStartedAt = Date.now();
    const processToStop = child;
    child = null;
    pendingPublicUrl = '';
    restartEligibleProcess = null;
    await terminateProcess(processToStop);
    if (operationId !== startId) throw new Error('公网隧道启动已取消');
    const lastPublicUrl = automaticRecovery ? String(current.lastPublicUrl || '') : '';
    if (!automaticRecovery) {
      attemptHistory = [];
      lastExit = null;
      lastLogTail = '';
    }
    current = fs.existsSync(binary)
      ? { state: 'stopped', mode: '', publicUrl: '', lastPublicUrl, error: '', latencyMs: null, reconnectCount: 0, lastCheckedAt: 0, bypassProxy: Boolean(bypassProxy), operationStartedAt }
      : { state: 'downloading', mode: '', publicUrl: '', lastPublicUrl, error: '', latencyMs: null, reconnectCount: 0, lastCheckedAt: 0, bypassProxy: Boolean(bypassProxy), operationStartedAt };
    try {
      await ensureBinary();
    } catch (error) {
      const message = userFacingDesktopError(error, '公网隧道组件准备失败，请检查网络后重试', '准备公网隧道组件失败');
      if (operationId === startId) current = {
        ...current, state: 'error', mode, publicUrl: '', error: message, verified: false,
        bypassProxy: Boolean(bypassProxy)
      };
      throw new Error(message);
    }
    if (operationId !== startId) throw new Error('公网隧道启动已取消');
    if (mode === 'named' && !token.trim()) throw new Error('稳定隧道需要 Cloudflare Tunnel 令牌');
    if (mode === 'named') {
      try {
        publicUrl = normalizePublicUrl(publicUrl);
        if (!publicUrl.startsWith('https://')) throw new Error('invalid');
      } catch (_) { throw new Error('稳定隧道需要填写已绑定的 HTTPS 公网地址'); }
    }

    let startupPreflight = null;
    if (autoDiagnose) {
      current = { ...current, state: 'diagnosing', mode, publicUrl: '', verified: false, error: '正在执行公网网络预检…' };
      try {
        startupPreflight = await runTunnelPreflight({ bypassProxy: Boolean(bypassProxy) });
        lastPreflight = startupPreflight;
      }
      catch (error) {
        lastPreflight = { checkedAt: new Date().toISOString(), bypassProxy: Boolean(bypassProxy), failureCode: 'PREFLIGHT_FAILED', error: error.message };
      }
      if (operationId !== startId) throw new Error('公网隧道启动已取消');
    }

    const bindAddress = bypassProxy ? preferredPhysicalIpv4() : '';
    const strategies = tunnelConnectionStrategies(mode, {
      bypassProxy: Boolean(bypassProxy), bindAddress,
      edgeAddresses: startupPreflight?.edgeAddresses || []
    });
    if (bypassProxy && startupPreflight?.checks?.apiTcp?.ok
      && !startupPreflight.checks.apiTcpPhysical?.ok && !startupPreflight.checks.edgeTcp?.ok) {
      strategies.sort((left, right) => Number(left.bypassProxy !== false) - Number(right.bypassProxy !== false));
    }
    let finalFailure = null;
    for (let index = 0; index < strategies.length; index += 1) {
      if (operationId !== startId) throw new Error('公网隧道启动已取消');
      const strategy = strategies[index];
      const attempt = await launchTunnelAttempt({
        startId, mode, publicUrl, token, bypassProxy: Boolean(bypassProxy),
        strategy, attemptIndex: index, attemptCount: strategies.length
      });
      if (!attempt.success) {
        const recorded = rememberAttempt({
          strategy, startedAt: attempt.startedAt || Date.now(), error: attempt.error,
          code: attempt.code, signal: attempt.signal, log: attempt.log
        });
        finalFailure = { ...recorded.failure, detail: attempt.error };
        if (attempt.terminationError) {
          current = {
            ...current, state: 'error', publicUrl: '', verified: false,
            error: attempt.terminationError, attempts: [...attemptHistory], lastExit, lastLogTail
          };
          throw new Error(attempt.terminationError);
        }
        if (index + 1 < strategies.length && operationId === startId) {
          let dnsFlush = null;
          const nextStrategy = strategies[index + 1];
          if (nextStrategy.retry || ['QUICK_API_TIMEOUT', 'DNS_RESOLUTION_FAILED'].includes(recorded.failure.code)) {
            dnsFlush = await flushDnsCache();
          }
          current = {
            ...current, state: 'reconnecting', publicUrl: '', verified: false,
            error: `${recorded.failure.title}，正在切换到备用连接策略（${index + 2}/${strategies.length}）…`,
            attempts: [...attemptHistory], lastExit, lastLogTail, dnsFlush
          };
          const retryDelay = tunnelRestartDelayMs(index, { baseDelayMs: 750, maxDelayMs: 5000 });
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
        continue;
      }

      const tunnelProcess = attempt.process;
      const establishedUrl = attempt.publicUrl;
      const verifiedResult = await waitForPublicUrl(establishedUrl, 8000, {
        localAddress: tunnelProbeLocalAddress(strategy, bypassProxy)
      });
      const processRunning = operationId === startId && child === tunnelProcess
        && tunnelProcess.exitCode === null && !tunnelProcess.signalCode;
      if (!processRunning) {
        const recorded = rememberAttempt({
          strategy, startedAt: attempt.startedAt, error: current.error,
          code: lastExit?.code, signal: lastExit?.signal, log: attempt.getLog()
        });
        finalFailure = { ...recorded.failure, detail: current.error };
        continue;
      }
      const verified = Boolean(verifiedResult?.ok);
      if (!verified && index + 1 < strategies.length) {
        child = null;
        pendingPublicUrl = '';
        try { await terminateProcess(tunnelProcess); }
        catch (error) {
          const detail = userFacingDesktopError(error, 'cloudflared 未能停止，已取消备用连接以避免遗留后台进程', '停止公网隧道进程失败');
          current = { ...current, state: 'error', publicUrl: '', verified: false, error: detail };
          throw new Error(detail);
        }
        const recorded = rememberAttempt({
          strategy, startedAt: attempt.startedAt,
          error: `公网地址未通过访问验证（${verifiedResult?.statusCode ? `HTTP ${verifiedResult.statusCode}` : '网络超时'}）`,
          log: attempt.getLog()
        });
        finalFailure = { ...recorded.failure, detail: current.error };
        current = {
          ...current, state: 'reconnecting', publicUrl: '', verified: false,
          error: `公网地址无法访问，正在切换到备用连接策略（${index + 2}/${strategies.length}）…`,
          attempts: [...attemptHistory], lastLogTail
        };
        await new Promise((resolve) => setTimeout(resolve, tunnelRestartDelayMs(index, { baseDelayMs: 750, maxDelayMs: 5000 })));
        continue;
      }
      rememberAttempt({ strategy, startedAt: attempt.startedAt, success: true, log: attempt.getLog() });
      healthFailures = verified ? 0 : 1;
      const recoveryCount = automaticRecovery ? autoRestartAttempts : index;
      pendingPublicUrl = verified ? '' : establishedUrl;
      current = {
        ...current, state: verified ? 'running' : 'verifying', publicUrl: verified ? establishedUrl : '', verified, health: verified ? 'healthy' : 'verifying',
        latencyMs: verified ? Number(verifiedResult.latencyMs) || null : null,
        error: verified ? '' : `公网地址已创建但尚未通过 ${TUNNEL_HEALTH_PATH} 验证（${verifiedResult?.statusCode ? `HTTP ${verifiedResult.statusCode}` : '网络超时'}），验证成功前不会发布地址。`,
        lastCheckedAt: Date.now(), verificationStartedAt: verified ? 0 : Date.now(), reconnectCount: recoveryCount, nextRetryAt: null,
        attempts: [...attemptHistory], lastExit, lastLogTail
      };
      desiredTunnel = {
        mode, token: String(token || '').trim(), publicUrl: mode === 'named' ? publicUrl : '',
        bypassProxy: Boolean(bypassProxy), autoDiagnose: Boolean(autoDiagnose)
      };
      restartEligibleProcess = tunnelProcess;
      if (!automaticRecovery || verified) autoRestartAttempts = 0;
      return { ...current };
    }

    if (operationId !== startId) throw new Error('公网隧道启动已取消');
    const failure = finalFailure || { code: 'TUNNEL_START_FAILED', title: '公网隧道启动失败', detail: '' };
    const error = `${failure.title}。已自动尝试 ${strategies.length} 种连接方式仍未成功，请打开“网络诊断与修复”查看家庭网络、DNS 与 VPN/TUN 修复方案。`;
    current = {
      ...current, state: 'error', publicUrl: '', error, verified: false,
      failureCode: failure.code, failureTitle: failure.title,
      attempts: [...attemptHistory], lastExit, lastLogTail, lastCheckedAt: Date.now()
    };
    throw new Error(error);
  }

  async function startConfiguredTunnel() {
    loadTunnelStartup();
    if (!startup.autoStartTunnel) return { ...current, startup: publicTunnelStartup() };
    return start({ mode: startup.mode, token: startup.token, publicUrl: startup.publicUrl, bypassProxy: startup.bypassProxy, autoDiagnose: startup.autoDiagnose });
  }

  async function diagnostics({ bypassProxy = current.bypassProxy !== false } = {}) {
    const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
    const proxyEnvironment = Object.fromEntries(proxyKeys.map((key) => [key, Boolean(process.env[key])]));
    const networkCandidates = physicalNetworkCandidates();
    const physicalIpv4 = networkCandidates.selected?.address || '';
    const tunPattern = /(?:vpn|tun|tap|wintun|wireguard|tailscale|zerotier|clash|v2ray|代理|虚拟|virtual|vethernet|wsl|docker|hyper-?v|vmware|virtualbox)/i;
    const tunAdapters = Object.entries(os.networkInterfaces() || {})
      .filter(([name, entries]) => tunPattern.test(name) && (entries || []).some((entry) => !entry.internal && entry.family === 'IPv4'))
      .map(([name]) => name);
    const preflight = await runTunnelPreflight({ bypassProxy });
    const { dnsAddresses, apiTcp, apiTcpPhysical, edgeTcp, fakeIpDns, edgeAddresses, edgeDiscovery } = {
      ...preflight, ...(preflight.checks || {})
    };
    const publicProbeUrl = current.publicUrl || pendingPublicUrl;
    const publicProbe = publicProbeUrl ? await probeHttpsDetailed(`${publicProbeUrl}${TUNNEL_HEALTH_PATH}`, {
      localAddress: bypassProxy ? physicalIpv4 : ''
    }) : { ok: false, latencyMs: null, skipped: true };
    const failureCode = current.failureCode || lastExit?.failureCode || preflight.failureCode || publicProbe.failureCode || '';
    const recommendations = tunnelRepairRecommendations({ failureCode, fakeIpDns, tunAdapters, bypassProxy: Boolean(bypassProxy) });
    const message = fakeIpDns && edgeAddresses?.length
      ? `检测到 VPN/TUN Fake-IP DNS，已通过 DoH 获取 ${edgeAddresses.length} 个真实 Cloudflare Edge 并尝试绑定物理网卡。`
      : fakeIpDns
      ? '检测到 VPN/TUN Fake-IP DNS：当前解析可能仍经过代理内核，清除代理变量不能完全绕过。请按下方方案设置 cloudflared 进程与 Cloudflare 域名直连。'
      : bypassProxy
        ? '已启用 cloudflared 直连环境并清除代理变量；检测结果和家庭网络修复方案如下。'
        : 'cloudflared 当前继承系统网络环境；建议开启绕过系统代理并执行网络修复。';
    return {
      state: current.state, publicUrl: current.publicUrl || '', lastPublicUrl: current.lastPublicUrl || '',
      installed: fs.existsSync(binary), bypassProxy: Boolean(bypassProxy),
      autoRestartPending: Boolean(autoRestartTimer), autoRestartAttempts, nextRetryAt: current.nextRetryAt || null,
      runtime, binary, proxyEnvironment, physicalIpv4, networkCandidates, tunAdapters, dnsAddresses, fakeIpDns,
      failureCode, failureTitle: current.failureTitle || lastExit?.title || '',
      checks: { apiTcp, apiTcpPhysical, edgeTcp, publicProbe, edgeDiscovery }, publicProbe,
      edgeAddresses: edgeAddresses || [], edgeDiscovery: edgeDiscovery || null,
      lastExit, lastLogTail, attempts: [...attemptHistory], recommendations, message,
      preflight
    };
  }

  async function repair({ bypassProxy = current.bypassProxy !== false } = {}) {
    const previous = { ...current };
    const dnsFlush = await flushDnsCache();
    if (child || ['running', 'reconnecting', 'verifying', 'degraded', 'starting'].includes(previous.state)) await stop();
    loadTunnelStartup();
      const status = await start({
      mode: previous.mode || startup.mode,
      token: startup.token,
      publicUrl: previous.publicUrl || previous.lastPublicUrl || startup.publicUrl,
      bypassProxy, autoDiagnose: startup.autoDiagnose
    });
    return { ...status, repair: { dnsFlush, bypassProxy: Boolean(bypassProxy), completedAt: new Date().toISOString() } };
  }

  return {
    start, stop, startConfiguredTunnel, diagnostics, repair,
    startupSettings: async () => publicTunnelStartup(),
    saveStartupSettings: saveTunnelStartup,
    status: async () => {
      const now = Date.now();
      if (current.state === 'verifying' && Number(current.verificationStartedAt) > 0
        && now - Number(current.verificationStartedAt) >= TUNNEL_VERIFY_MAX_MS) {
        const stalledProcess = child;
        operationId += 1;
        child = null;
        pendingPublicUrl = '';
        restartEligibleProcess = null;
        desiredTunnel = null;
        current = {
          ...current, state: 'error', publicUrl: '', verified: false, health: 'offline',
          failureCode: 'PUBLIC_VERIFICATION_TIMEOUT',
          error: `公网地址连续 ${Math.round(TUNNEL_VERIFY_MAX_MS / 1000)} 秒未通过访问验证；已停止未就绪的连接器，请运行“网络诊断与修复”后重试。`,
          lastCheckedAt: now
        };
        if (stalledProcess) void terminateProcess(stalledProcess).catch(() => {});
      }
      const probeUrl = current.state === 'running' ? current.publicUrl : current.state === 'verifying' ? pendingPublicUrl : '';
      const probeIntervalMs = current.state === 'verifying' ? 2000 : 10000;
      if (probeUrl && !healthProbePromise
        && now - Number(current.lastCheckedAt || 0) > probeIntervalMs) {
        const publicUrl = probeUrl;
        const probeOperationId = operationId;
        const probeProcess = child;
        current = { ...current, lastCheckedAt: now };
        healthProbePromise = probeHttpsDetailed(`${publicUrl}${TUNNEL_HEALTH_PATH}`, {
          localAddress: current.bypassProxy !== false ? (current.bindAddress || preferredPhysicalIpv4()) : ''
        }).then((probe) => {
          if (operationId !== probeOperationId || child !== probeProcess || (current.publicUrl !== publicUrl && pendingPublicUrl !== publicUrl)) return;
          const next = applyTunnelHealthProbe(current, probe, healthFailures, {
            processRunning: Boolean(child && child.exitCode === null && !child.signalCode), checkedAt: Date.now(),
            candidatePublicUrl: publicUrl
          });
          healthFailures = next.healthFailures;
          current = next.current;
          if (probe.ok && pendingPublicUrl === publicUrl) pendingPublicUrl = '';
          if (probe.ok) autoRestartAttempts = 0;
          if (tunnelProbeNeedsConnectorRestart(probe, healthFailures)
            && child === probeProcess && desiredTunnel && !autoRestartTimer) {
            pendingPublicUrl = '';
            current = {
              ...current, state: 'reconnecting', publicUrl: '', verified: false, health: 'reconnecting',
              error: 'Cloudflare 连续返回 1033，正在自动重建连接器和临时公网地址'
            };
            void terminateProcess(probeProcess).catch((error) => {
              if (child !== probeProcess) return;
              current = {
                ...current, state: 'error', publicUrl: '', verified: false, health: 'offline',
                error: userFacingDesktopError(error, '连接器自动重启失败，请运行网络诊断与修复', '公网连接器恢复失败')
              };
            });
          }
        }).catch(() => {
          if (operationId !== probeOperationId || child !== probeProcess || (current.publicUrl !== publicUrl && pendingPublicUrl !== publicUrl)) return;
          const next = applyTunnelHealthProbe(current, { ok: false }, healthFailures, {
            processRunning: Boolean(child && child.exitCode === null && !child.signalCode), checkedAt: Date.now(), candidatePublicUrl: publicUrl
          });
          healthFailures = next.healthFailures;
          current = next.current;
        }).finally(() => { healthProbePromise = null; });
      }
      return {
        ...current, installed: fs.existsSync(binary), startup: publicTunnelStartup(),
        lastExit, lastLogTail, attempts: [...attemptHistory],
        autoRestartPending: Boolean(autoRestartTimer), autoRestartAttempts,
        preflight: lastPreflight
      };
    }
  };
}

async function createSplash() {
  splashWindow = new BrowserWindow({
    width: 500, height: 300, frame: false, resizable: false, alwaysOnTop: true,
    center: true, backgroundColor: '#101318', show: false, icon: iconPath(),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;background:#101318;font-family:"Microsoft YaHei",sans-serif;color:#f8f7f2}
    main{width:calc(100% - 36px);text-align:center;padding:32px;border:1px solid #46525b;border-radius:8px;background:#1a2027;box-shadow:0 18px 50px #0008}.mark{display:grid;width:58px;height:58px;margin:0 auto;place-items:center;border-radius:7px;background:#c7a763;color:#101318;font-size:30px}h1{font-size:25px;margin:14px 0 6px}p{margin:6px;color:#dce3e5}.bar{width:250px;height:5px;margin:30px auto 0;background:#ffffff20;border-radius:8px;overflow:hidden}.bar i{display:block;height:100%;background:#c7a763;animation:load 1.4s ease-in-out infinite}@keyframes load{0%{width:0}60%{width:80%}100%{width:100%}}small{display:block;margin-top:20px;color:#b9c2c9}
  </style><main><div class="mark">🎬</div><h1>SyncWatch同步观影</h1><p>正在启动 SyncWatch同步观影 服务器…</p><div class="bar"><i></i></div><small>${COPYRIGHT}</small></main>`;
  await splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  if (!SMOKE_MODE && !splashWindow.isDestroyed()) splashWindow.show();
}

async function showRuntimeInformation() {
  let copyright = COPYRIGHT;
  try {
    const response = await fetch(`${localUrl()}/api/public-config`, { signal: AbortSignal.timeout(3000) });
    const config = response.ok ? await response.json() : null;
    copyright = String(config?.branding?.notice || config?.branding?.owner && `版权所有 © ${config.branding.owner}，保留所有权利。` || COPYRIGHT);
  } catch (_) {}
  const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const infoWindow = new BrowserWindow({
    parent: mainWindow, modal: true, width: 560, height: 390, show: false, resizable: false,
    frame: false, backgroundColor: '#101318', icon: iconPath(),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  infoWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      infoWindow.close();
    }
  });
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{height:100vh;margin:0;padding:18px;overflow:hidden;background:#101318;color:#f8f7f2;font-family:"Microsoft YaHei",sans-serif}main{height:100%;display:grid;grid-template-rows:auto 1fr auto;border:1px solid #46525b;border-radius:8px;background:#1a2027;box-shadow:0 18px 50px #0008;overflow:hidden}header{display:flex;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid #323b44;background:#151b20}.mark{display:grid;width:44px;height:44px;place-items:center;border-radius:6px;background:#c7a763;color:#111;font-size:23px}h1{margin:0;font-size:20px}header small{display:block;margin-top:3px;color:#b9c2c9}.content{display:grid;gap:12px;padding:22px 24px;align-content:start;min-height:0}.row{display:grid;grid-template-columns:92px minmax(0,1fr);gap:12px}.row span{color:#b9c2c9}.row strong{overflow-wrap:anywhere}.note{padding:10px 12px;border-left:3px solid #c7a763;background:#c7a76312;color:#dce3e5}footer{display:flex;justify-content:flex-end;padding:14px 20px;border-top:1px solid #323b44}button{min-width:96px;height:38px;border:1px solid #c7a763;border-radius:6px;background:#c7a763;color:#101318;font:700 14px inherit;cursor:pointer}</style><main><header><div class="mark">▶</div><div><h1>SyncWatch同步观影 ${escapeHtml(APP_VERSION)}</h1><small>服务器运行信息</small></div></header><section class="content"><div class="row"><span>局域网地址</span><strong>${escapeHtml(primaryLanUrl())}</strong></div><div class="row"><span>数据目录</span><strong>${escapeHtml(serverController.dataDir)}</strong></div><div class="note">房主可在“服务器设置”中开启公网访问。</div><small>${escapeHtml(copyright)}</small></section><footer><button onclick="window.close()">确定</button></footer></main></html>`;
  infoWindow.once('ready-to-show', () => infoWindow.show());
  await infoWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return infoWindow;
}

function copyLanAddress() {
  const url = primaryLanUrl();
  clipboard.writeText(url);
  if (Notification.isSupported()) new Notification({ title: APP_NAME, body: `内网地址已复制到剪贴板：${url}`, icon: iconPath() }).show();
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '系统', submenu: [
      { label: '分享内网地址', accelerator: 'Ctrl+L', click: copyLanAddress },
      { label: '在默认浏览器中打开', click: () => shell.openExternal(primaryLanUrl()) },
      { label: '打开数据目录', submenu: dataDirectoryMenuItems() },
      { label: `服务器启动设置（当前端口 ${serverController.port}）`, click: openServerSettings },
      { type: 'separator' }, { label: '退出', accelerator: 'Alt+F4', click: requestApplicationQuit }
    ] },
    { label: '视图', submenu: [
      { label: '刷新', accelerator: 'F5', click: () => mainWindow?.reload() },
      { label: '应用全屏', accelerator: 'F11', click: () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()) },
      { label: '重置缩放', accelerator: 'Ctrl+0', click: () => mainWindow?.webContents.setZoomFactor(1) }
    ] },
    { label: '帮助', submenu: [
      { label: '运行信息', click: showRuntimeInformation },
      { type: 'separator' },
      { label: '作者 GitHub', click: () => void openHelpLink('author') },
      { label: 'SyncWatch 项目主页', click: () => void openHelpLink('project') },
      { label: 'Latest 最新版下载', click: () => void openHelpLink('latest') },
      { label: '项目 Wiki', click: () => void openHelpLink('wiki') }
    ] }
  ]));
}

function dataDirectoryMenuItems() {
  const root = serverController?.dataDir || DEFAULT_DATA_DIR;
  const preferred = [
    ['总数据目录', ''], ['上传原文件', 'uploads'], ['公网兼容文件', 'compatible-media'], ['影片缩略图', 'thumbnails'],
    ['字幕文件', 'subtitles'], ['语音消息', 'voice'], ['聊天图片', 'chat-images'], ['用户头像', 'avatars'],
    ['回收与回溯', 'trash'], ['公网工具', 'tools'], ['管理员密码', 'secrets'], ['加密密钥', '.secrets']
  ];
  return preferred.map(([label, relative]) => {
    const target = relative ? path.join(root, relative) : root;
    return { label: `${label}（${path.basename(target)}）`, enabled: !relative || fs.existsSync(target), click: () => shell.openPath(target) };
  });
}

function createTray() {
  tray = new Tray(iconPath());
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '分享内网地址', click: copyLanAddress },
    { label: '在浏览器中打开', click: () => shell.openExternal(primaryLanUrl()) },
    { label: `服务器启动设置（当前端口 ${serverController.port}）`, click: openServerSettings },
    { type: 'separator' }, { label: '退出', click: requestApplicationQuit }
  ]));
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

function requestDisplayCaptureFallbackDecision() {
  if (!mainWindow || mainWindow.isDestroyed() || !displayCapturePromptReady) return Promise.resolve(false);
  if (pendingDisplayCapturePrompt) {
    clearTimeout(pendingDisplayCapturePrompt.timer);
    pendingDisplayCapturePrompt.resolve(false);
    pendingDisplayCapturePrompt = null;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingDisplayCapturePrompt || pendingDisplayCapturePrompt.resolve !== resolve) return;
      pendingDisplayCapturePrompt = null;
      resolve(false);
    }, 60000);
    pendingDisplayCapturePrompt = { resolve, timer };
    mainWindow.webContents.send('syncwatch:display-capture-fallback-requested', {
      title: '共享主显示器',
      message: '系统屏幕选择器不可用，是否共享主显示器画面？',
      detail: '共享前请关闭主显示器上的隐私内容。开启系统声音时将使用系统回环音频。',
      confirmText: '共享主显示器', cancelText: '取消', timeoutMs: 60000
    });
  });
}

function configureDisplayCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (new URL(request.securityOrigin).origin !== new URL(localUrl()).origin || !request.videoRequested) return callback({});
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      const primaryId = String(screen.getPrimaryDisplay().id);
      const source = sources.find((item) => item.display_id === primaryId) || sources.find((item) => /^screen|整个屏幕|显示器/i.test(item.name));
      if (!source) return callback({});
      const approved = await requestDisplayCaptureFallbackDecision();
      if (!approved) return callback({});
      callback({ video: source, ...(request.audioRequested ? { audio: 'loopback' } : {}) });
    } catch (error) {
      console.error('屏幕捕获授权失败:', error);
      callback({});
    }
  }, { useSystemPicker: true });
}

function configureWebPermissions() {
  const trustedOrigin = new URL(localUrl()).origin;
  const allowedPermissions = new Set(['geolocation', 'media', 'fullscreen', 'notifications', 'display-capture']);
  const isTrustedRequest = (webContents, details = {}) => {
    if (!mainWindow || mainWindow.isDestroyed() || webContents !== mainWindow.webContents) return false;
    const candidate = details.requestingUrl || details.requestingOrigin || details.securityOrigin || webContents.getURL();
    try { return new URL(candidate).origin === trustedOrigin; } catch (_) { return false; }
  };
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allowedPermissions.has(permission) && isTrustedRequest(webContents, details));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    allowedPermissions.has(permission)
    && isTrustedRequest(webContents, { ...(details || {}), requestingOrigin })
  ));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320, height: 840, minWidth: 920, minHeight: 640, center: true, show: false,
    title: APP_NAME, icon: iconPath(), backgroundColor: '#100c16', autoHideMenuBar: false,
    webPreferences: { preload: path.join(__dirname, 'electron-main-preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, backgroundThrottling: false }
  });
  const allowedOrigin = new URL(localUrl()).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new URL(url).origin === allowedOrigin) return { action: 'allow' }; } catch (_) {}
    const external = trustedExternalUrl(url);
    if (external) shell.openExternal(external);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin === allowedOrigin) return; } catch (_) {}
    event.preventDefault();
    const external = trustedExternalUrl(url);
    if (external) shell.openExternal(external);
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && mainWindow?.isFullScreen()) {
      event.preventDefault();
      mainWindow.setFullScreen(false);
    }
  });
  mainWindow.once('ready-to-show', () => {
    splashWindow?.close(); splashWindow = null;
    if (!SMOKE_MODE) mainWindow.show();
    console.log(`APP_READY=${localUrl()}`);
  });
  mainWindow.on('close', (event) => {
    if (SMOKE_MODE || forceQuit || shuttingDown) return;
    event.preventDefault();
    if (closeChoicePending) return;
    closeChoicePending = true;
    if (mainWindow.webContents.isDestroyed()) { closeChoicePending = false; return; }
    mainWindow.webContents.send('syncwatch:request-close-choice');
  });
  mainWindow.on('closed', () => {
    displayCapturePromptReady = false;
    if (pendingDisplayCapturePrompt) {
      clearTimeout(pendingDisplayCapturePrompt.timer);
      pendingDisplayCapturePrompt.resolve(false);
      pendingDisplayCapturePrompt = null;
    }
    mainWindow = null;
  });
  mainWindow.loadURL(`${localUrl()}#host=${encodeURIComponent(HOST_CONTROL_TOKEN)}`);
}

async function startApplication() {
  await createSplash();
  await new Promise((resolve) => setImmediate(resolve));
  ({ startSyncWatchServer } = require('./server'));
  if (storageSetupError) throw new Error(userFacingDesktopError(storageSetupError, '无法在程序根目录创建数据文件夹，请检查目录写入权限', '初始化数据目录失败'));
  await migrateLegacyData();
  activeServerSettings = loadServerSettings({ create: !process.env.SYNCWATCH_DATA_DIR && commandLinePort() === '' && process.env.PORT === undefined });
  applyAutostartSetting(activeServerSettings.autostart);
  const startPort = resolvedStartPort(activeServerSettings);
  const trustedProxies = commandLineValue('trusted-proxies');
  if (trustedProxies !== undefined && !trustedProxies.trim()) {
    throw new Error('--trusted-proxies 必须后跟至少一个精确代理 IP 或 CIDR');
  }
  const lanAddress = resolveLanAddress(activeServerSettings);
  const dataDir = process.env.SYNCWATCH_DATA_DIR || DEFAULT_DATA_DIR;
  const releaseVersion = String(APP_VERSION).replace(/^v/i, '');
  const androidApkPath = app.isPackaged
    ? path.join(process.resourcesPath, 'offline-downloads', 'android', `SyncWatch-Android-v${releaseVersion}-universal.apk`)
    : path.join(__dirname, 'dist', `SyncWatch-Android-v${releaseVersion}-universal.apk`);
  const developmentClientPath = path.join(__dirname, 'dist', `SyncWatch-Experience-Client-Portable-v${releaseVersion}-x64.exe`);
  const clientDownloadPath = resolveClientDownloadPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    developmentClientPath
  });
  const configuredHosts = [...activeServerSettings.allowedHosts];
  if (activeServerSettings.publicUrl) {
    try { configuredHosts.push(new URL(activeServerSettings.publicUrl).host.toLowerCase()); } catch (_) {}
  }
  // Non-Windows source smoke runs only exercise the desktop shell and server
  // lifecycle.  cloudflared is intentionally unsupported outside Windows, so avoid
  // failing the whole smoke process before the Electron window can start.
  // Production builds construct the real tunnel manager on Windows.
  const smokeTunnelDisabled = SMOKE_MODE && process.platform !== 'win32';
  tunnelManager = smokeTunnelDisabled ? null : createTunnelManager(dataDir, () => serverController?.port || startPort, {
    onAutoStartChanged: async (enabled) => {
      if (!enabled || activeServerSettings?.autostart) return;
      activeServerSettings = { ...activeServerSettings, autostart: true };
      atomicWriteJson(SERVER_SETTINGS_FILE, activeServerSettings);
      applyAutostartSetting(true);
    }
  });
  serverController = await startSyncWatchServer({
    host: '0.0.0.0', port: startPort, strictPort: false, dataDir, allowedHosts: configuredHosts,
    publicUrl: activeServerSettings.publicUrl, lanAddress,
    ...(trustedProxies !== undefined ? { trustedProxies } : {}),
    publicDir: path.join(__dirname, 'public'), hostControlToken: HOST_CONTROL_TOKEN, tunnelManager, androidApkPath, clientDownloadPath,
    onFactoryResetRequested: factoryResetAndRestart, onRestartRequested: restartApplication
  });
  configureDisplayCapture();
  createMainWindow();
  configureWebPermissions();
  buildMenu();
  createTray();
  setImmediate(() => {
    serverController?.startConfiguredTunnel?.().catch((error) => console.warn('公网隧道自动启动失败：', error.message));
  });
  if (SMOKE_MODE && process.env.SYNCWATCH_SMOKE_EXIT_MS) {
    setTimeout(() => app.quit(), Math.max(500, Number(process.env.SYNCWATCH_SMOKE_EXIT_MS) || 2000)).unref?.();
  }
}

app.whenReady().then(startApplication).catch(async (error) => {
  const message = userFacingDesktopError(error, 'SyncWatch同步观影 服务无法启动，请检查端口、网络和数据目录', '应用启动失败');
  if (dataLockConflictDetails(error)) {
    try { await showDataLockConflict(error); return; }
    catch (conflictError) { console.error('无法显示实例冲突窗口:', conflictError); }
  }
  splashWindow?.close(); dialog.showErrorBox('启动失败', message); app.quit();
});
app.on('activate', () => { if (mainWindow) mainWindow.show(); else if (serverController) createMainWindow(); });
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  if (!serverController || shuttingDown) return;
  event.preventDefault(); shuttingDown = true;
  const controller = serverController; serverController = null;
  controller.close().catch(() => {}).finally(() => app.quit());
});
process.on('uncaughtException', (error) => {
  if (error?.code === 'EPIPE') return;
  const message = userFacingDesktopError(error, '程序发生异常，请重新启动；若仍失败请查看日志', '未捕获异常');
  if (app.isReady()) dialog.showErrorBox('系统错误', message);
});
process.on('unhandledRejection', (error) => {
  if (error?.code === 'EPIPE') return;
  console.error('未处理的异步错误:', error);
});

module.exports = { _test: {
  validPort, commandLineValue, iconPath, normalizePublicUrl, normalizeAllowedHost, normalizeServerSettings, resolvedStartPort,
  selectableNetworkAdapters, resolveLanAddress,
  resolveApplicationRoot, resolveClientDownloadPath, tunnelCommandArgs, tunnelEnvironment,
  tunnelConnectionStrategies, classifyTunnelFailure, isTunnelFakeIp, tunnelRepairRecommendations,
  applyTunnelHealthProbe, tunnelProbeNeedsConnectorRestart, sanitizeTunnelLog, extractQuickTunnelPublicUrl, tunnelConnectorRegistered,
  tunnelFakeIpAddresses, DEFAULT_TUNNEL_BYPASS_PROXY,
  cloudflaredRuntime, fileSha256, physicalNetworkCandidates,
  preferredPhysicalIpv4, tunnelRestartDelayMs, isPublicIpv4Address,
  normalizeTunnelEdgeAddresses, cloudflareEdgeTargetsFromSrv, publicIpv4AddressesFromDnsAnswer,
  queryDnsOverHttps, resolveCloudflareEdgeAddressesViaDoh, tunnelProbeLocalAddress, tunnelSystemProxyConfigured,
  tunnelProbeTransport, parseTunnelProbeResponse, probeHttpsThroughSystemNetwork,
  TUNNEL_HEALTH_PATH, CLOUDFLARE_EDGE_PORT,
  HELP_LINKS, HELP_LINK_ALLOWLIST, openHelpLink
} };
