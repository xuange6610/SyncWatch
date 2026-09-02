'use strict';

// Service supervisors and redirected logs can close stdout/stderr before the
// Node process has fully drained.  A closed logging pipe must not terminate a
// healthy 24-hour server instance.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (error) => {
    if (error?.code !== 'EPIPE') process.exitCode = 1;
  });
}

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { APP_VERSION, startSyncWatchServer, resolveDefaultDataDir } = require('./server');
const { createStandaloneTunnelManager } = require('./server/standalone-tunnel');

const ROOT_DIR = path.resolve(process.env.SYNCWATCH_ROOT || __dirname);
const DATA_DIR = path.resolve(process.env.SYNCWATCH_DATA_DIR || resolveDefaultDataDir(ROOT_DIR));
const LEGACY_SETTINGS_FILE = path.join(ROOT_DIR, 'server-config.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'server-config.json');
const HOST_TOKEN_FILE = path.join(DATA_DIR, '.secrets', 'server-host-token.txt');
const RUNTIME_INFO_FILE = path.join(DATA_DIR, '服务器运行信息.txt');
const DEFAULT_PORT = 20311;
const LEGACY_DEFAULT_PORTS = new Set([2311, 5000]);

function validPort(value) {
  if (!['number', 'string'].includes(typeof value)) return null;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function commandLineValue(name, argv = process.argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');
    if (value.startsWith(`--${name}=`)) return value.slice(name.length + 3);
    if (value === `--${name}`) {
      const next = index + 1 < argv.length ? String(argv[index + 1] || '') : '';
      return next.startsWith('--') ? '' : next;
    }
  }
  return undefined;
}

function commandLineFlag(name, argv = process.argv) {
  const exact = `--${name}`;
  for (const entry of argv) {
    const value = String(entry || '').trim().toLowerCase();
    if (value === exact) return true;
    if (value.startsWith(`${exact}=`)) return ['1', 'true', 'yes', 'on'].includes(value.slice(exact.length + 1));
  }
  return false;
}

function standaloneHelp() {
  return [
    `SyncWatch同步观影 ${APP_VERSION} 纯控制台服务端`,
    '',
    '此入口没有桌面窗口，不会显示 Electron 原生菜单；需要桌面窗口时请运行 Windows 桌面服务器程序。',
    '',
    '控制台等价入口：',
    '  node server-standalone.js [选项]',
    '  --open-browser              服务就绪后在默认浏览器打开私密管理入口',
    '  --port <1-65535>            指定监听端口',
    '  --trusted-proxies <列表>    指定可信反向代理 IP/CIDR（逗号分隔）',
    '  --help, -h                  显示本帮助并退出',
    '',
    '启动设置保存在数据目录的 server-config.json；停止服务后再编辑。',
    '运行地址、数据目录和私密管理入口保存在数据目录的 服务器运行信息.txt。',
    '浏览器中的刷新、全屏和缩放分别使用 F5、F11、Ctrl+0。'
  ].join('\n');
}

function standaloneManagementSummary({ ownerUrl, dataDir, settingsFile, runtimeInfoFile } = {}) {
  return [
    '纯控制台模式：此窗口只显示服务日志，不提供 Electron 原生顶部菜单。',
    `管理页面：${ownerUrl}`,
    `启动设置：${settingsFile}（停止服务后编辑）`,
    `数据目录：${dataDir}`,
    `完整运行信息：${runtimeInfoFile}`,
    '视图操作请在浏览器使用 F5 刷新、F11 全屏、Ctrl+0 重置缩放。',
    '命令帮助：node server-standalone.js --help'
  ].join('\n');
}

function systemBrowserCommand(value, platform = process.platform) {
  let url;
  try { url = new URL(String(value || '')); }
  catch (_) { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const target = url.toString();
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] };
  return { command: 'xdg-open', args: [target] };
}

function openSystemBrowser(value, { platform = process.platform, execFileImpl = execFile } = {}) {
  const launch = systemBrowserCommand(value, platform);
  if (!launch) return Promise.reject(new Error('管理页面地址无效'));
  return new Promise((resolve, reject) => {
    execFileImpl(launch.command, launch.args, { windowsHide: true, timeout: 10_000 }, (error) => {
      if (error) reject(error); else resolve();
    });
  });
}

function atomicWrite(filename, contents, mode) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', ...(mode ? { mode } : {}) });
  fs.renameSync(temporary, filename);
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
  return [...new Set(entries.map(normalizeAllowedHost).filter(Boolean))].slice(0, 100);
}

function normalizeSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('server-config.json 顶层必须是 JSON 对象');
  const rawPort = Object.prototype.hasOwnProperty.call(input, 'port') ? input.port : DEFAULT_PORT;
  const numericPort = Number(rawPort);
  const port = LEGACY_DEFAULT_PORTS.has(numericPort) ? DEFAULT_PORT : validPort(rawPort);
  if (port === null) throw new Error('server-config.json 的 port 必须是 1-65535 之间的整数');
  return {
    port,
    publicUrl: normalizePublicUrl(input.publicUrl),
    allowedHosts: normalizeAllowedHosts(input.allowedHosts)
  };
}

function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE) && fs.existsSync(LEGACY_SETTINGS_FILE)) {
    try {
      const migrated = normalizeSettings(JSON.parse(fs.readFileSync(LEGACY_SETTINGS_FILE, 'utf8')));
      atomicWrite(SETTINGS_FILE, `${JSON.stringify(migrated, null, 2)}\n`);
      fs.rmSync(LEGACY_SETTINGS_FILE, { force: true });
    } catch (error) { throw new Error(`旧服务器配置文件无法迁移：${error.message}`); }
  }
  if (!fs.existsSync(SETTINGS_FILE)) {
    const defaults = normalizeSettings();
    atomicWrite(SETTINGS_FILE, `${JSON.stringify(defaults, null, 2)}\n`);
    return defaults;
  }
  try {
    const persisted = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const persistedPort = Number(persisted?.port);
    const settings = normalizeSettings(persisted);
    if (persistedPort === 0 || LEGACY_DEFAULT_PORTS.has(persistedPort)) {
      const migrated = { ...settings, port: 20311 };
      atomicWrite(SETTINGS_FILE, `${JSON.stringify(migrated, null, 2)}\n`);
      return migrated;
    }
    return settings;
  }
  catch (error) { throw new Error(`服务器配置文件无法读取：${error.message}`); }
}

function hostToken() {
  if (process.env.SYNCWATCH_HOST_TOKEN && String(process.env.SYNCWATCH_HOST_TOKEN).length >= 32) return String(process.env.SYNCWATCH_HOST_TOKEN);
  if (fs.existsSync(HOST_TOKEN_FILE)) {
    const existing = fs.readFileSync(HOST_TOKEN_FILE, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(existing)) return existing;
  }
  const generated = crypto.randomBytes(32).toString('base64url');
  atomicWrite(HOST_TOKEN_FILE, `${generated}\n`, 0o600);
  return generated;
}

function publicBaseUrl(settings) {
  const value = process.env.SYNCWATCH_PUBLIC_URL !== undefined ? process.env.SYNCWATCH_PUBLIC_URL : settings.publicUrl;
  try { return normalizePublicUrl(value); }
  catch (error) { throw new Error(`publicUrl 无效：${error.message}`); }
}

async function main() {
  if (commandLineFlag('help') || process.argv.includes('-h')) {
    console.log(standaloneHelp());
    return { help: true };
  }
  process.title = `SyncWatch同步观影 Server ${APP_VERSION}`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(path.join(DATA_DIR, 'config.json'))) console.log('首次加载需要生成数据库，请耐心等待哦~');
  const settings = loadSettings();
  const cliPort = commandLineValue('port');
  const requestedPort = cliPort !== undefined
    ? cliPort
    : (process.env.PORT !== undefined ? process.env.PORT : settings.port);
  const port = validPort(requestedPort);
  if (!port) throw new Error('端口必须是 1-65535 之间的整数');
  const trustedProxies = commandLineValue('trusted-proxies');
  if (trustedProxies !== undefined && !trustedProxies.trim()) {
    throw new Error('--trusted-proxies 必须后跟至少一个精确代理 IP 或 CIDR');
  }
  const publicUrl = publicBaseUrl(settings);
  const allowedHosts = [...settings.allowedHosts];
  for (const entry of String(process.env.SYNCWATCH_ALLOWED_HOSTS || '').split(',')) if (entry.trim()) allowedHosts.push(entry.trim().toLowerCase());
  if (publicUrl) allowedHosts.push(new URL(publicUrl).host.toLowerCase());
  const token = hostToken();
  const tunnelManager = createStandaloneTunnelManager({ rootDir: ROOT_DIR, dataDir: DATA_DIR, getPort: () => controller?.port || port });
  // Keep source checkouts and the packaged standalone archive aligned with the
  // same release while preserving the archive's user-facing download name.
  const releaseVersion = String(APP_VERSION).replace(/^v/i, '');
  const androidApkPath = [
    path.join(ROOT_DIR, 'dist', `SyncWatch-Android-v${releaseVersion}-universal.apk`),
    path.join(ROOT_DIR, 'mobile', `SyncWatch同步观影-v${releaseVersion}.apk`)
  ].find((candidate) => fs.existsSync(candidate)) || '';
  const clientDownloadCandidates = [
    path.join(ROOT_DIR, 'dist', `SyncWatch-Experience-Client-Portable-v${releaseVersion}-x64.exe`),
    path.join(ROOT_DIR, `SyncWatch同步观影-Client-v${releaseVersion}.exe`),
    path.join(ROOT_DIR, 'client', `SyncWatch同步观影-Client-v${releaseVersion}.exe`)
  ];
  const clientDownloadPath = clientDownloadCandidates.find((candidate) => fs.existsSync(candidate)) || '';
  const controller = await startSyncWatchServer({
    host: '0.0.0.0', port, strictPort: true, portFallbackCount: 0, dataDir: DATA_DIR, publicDir: path.join(ROOT_DIR, 'public'),
    hostControlToken: token, allowedHosts, publicUrl, androidApkPath, clientDownloadPath, tunnelManager,
    ...(trustedProxies !== undefined ? { trustedProxies } : {})
  });
  const local = `http://127.0.0.1:${controller.port}`;
  const accessUrls = [...new Set([publicUrl, ...controller.addresses, local].filter(Boolean))];
  const ownerBase = publicUrl || local;
  const ownerUrl = `${ownerBase}/#host=${encodeURIComponent(token)}`;
  const runtimeInfo = [
    `SyncWatch同步观影 ${APP_VERSION}`,
    `启动时间：${new Date().toISOString()}`,
    `程序根目录：${ROOT_DIR}`,
    `数据目录：${DATA_DIR}`,
    `监听端口：${controller.port}`,
    '',
    '访问地址：',
    ...accessUrls.map((url) => `- ${url}`),
    '',
    '服务器房主入口（请勿公开）：',
    ownerUrl,
    '',
    '普通用户不要使用带 #host= 的房主链接。'
  ].join('\n');
  atomicWrite(RUNTIME_INFO_FILE, `${runtimeInfo}\n`, 0o600);
  console.log(runtimeInfo);
  console.log(`\n${standaloneManagementSummary({
    ownerUrl, dataDir: DATA_DIR, settingsFile: SETTINGS_FILE, runtimeInfoFile: RUNTIME_INFO_FILE
  })}\n`);
  if (commandLineFlag('open-browser')) {
    try {
      await openSystemBrowser(ownerUrl);
      console.log('已在默认浏览器打开私密管理入口。');
    } catch (error) {
      console.warn(`无法自动打开浏览器：${error.message}。请复制“管理页面”地址手动打开。`);
    }
  }
  // Honour the persisted public-tunnel startup preference in the standalone
  // package as well as the desktop app. A failed auto-start must not take the
  // local server down; the owner can retry from the management UI.
  try {
    const tunnelStatus = await tunnelManager.startConfiguredTunnel();
    if (tunnelStatus?.state === 'running' && tunnelStatus.publicUrl) {
      console.log(`公网访问已开启：${tunnelStatus.publicUrl}`);
    }
  } catch (error) {
    console.warn(`公网隧道自动启动失败：${error.message}`);
  }

  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`收到 ${signal}，正在安全保存数据并关闭服务器…`);
    await controller.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void close('SIGINT'));
  process.once('SIGTERM', () => void close('SIGTERM'));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`服务器启动失败：${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  _test: {
    validPort, commandLineValue, commandLineFlag, normalizePublicUrl, normalizeSettings, publicBaseUrl,
    standaloneHelp, standaloneManagementSummary, systemBrowserCommand, openSystemBrowser
  }
};
