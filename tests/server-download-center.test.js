'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'server-download-center.css'), 'utf8');
const style = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const latestRelease = fs.readFileSync(path.join(root, 'server', 'latest-release.js'), 'utf8');
const electron = fs.readFileSync(path.join(root, 'electron-pink.js'), 'utf8');

for (const id of [
  'serverEndpointBadge', 'serverEndpointAddress', 'serverEndpointState', 'checkUpdateBtn', 'downloadCenterBtn',
  'adminProfileBtn', 'downloadCenterModal', 'downloadAssetSettingsCard', 'serverAdminRoomLoginBtn', 'managementLogoutBtn', 'managementSessionLogoutBtn'
]) assert.match(html, new RegExp(`id=["']${id}["']`), `缺少 ${id}`);

assert.match(html, /id="lanScanBtn"[^>]*>[\s\S]*?<svg class="header-line-icon"[\s\S]*?<circle[\s\S]*?<path[\s\S]*?扫描房间/);
assert.doesNotMatch(html, /id="lanScanBtn"[^>]*>[\s\S]{0,120}⌁/);
assert.match(html, /下载文件[\s\S]*版本[\s\S]*适合谁[\s\S]*简单说明/);
for (const filename of [
  'SyncWatch-Experience-Client-Portable-v2.4.1-x64.exe',
  'SyncWatch-v2.4.1-Full-Offline-Portable-x64.exe',
  'SyncWatch-Android-v2.4.1-universal.apk',
  'cloudflared-windows-x64-installer.msi',
  'node-v24.19.0-x64.msi'
]) assert.match(html, new RegExp(filename.replace(/[.]/g, '\\.')));
assert.equal((html.match(/class="download-role-badge download-role-client"/g) || []).length, 2,
  '下载中心必须明确标注客户端文件');
assert.equal((html.match(/class="download-role-badge download-role-server">服务器</g) || []).length, 1,
  '下载中心必须明确标注服务器应用文件');
assert.equal((html.match(/class="download-role-badge download-role-server">服务器工具/g) || []).length, 1,
  '下载中心必须标注服务器配套工具');
assert.equal((html.match(/class="download-role-badge download-role-server">服务器环境/g) || []).length, 1,
  '下载中心必须标注服务器运行环境');
assert.doesNotMatch(html, /github\.com\/xuange6610-oss/);

assert.match(app, /function renderServerEndpointStatus\(\)/);
assert.match(app, /function checkForUpdates\(\)[\s\S]*fetchWithTimeout\(['"]\/api\/releases\/latest['"]/);
assert.match(app, /serverEndpointBadge\?\.addEventListener\(['"]dblclick['"],\s*openServerEndpointDetails\)/);
assert.match(app, /function openServerEndpointDetails\(\)/);
assert.match(app, /function openAdminProfileEditor\(\)[\s\S]*openAccount\(['"]home['"]\)/);
assert.match(app, /uploadFileWithProgress\(`\/api\/download-assets\/\$\{encodeURIComponent/);
assert.match(app, /async function logoutManagementSession\(\)[\s\S]*logout\(\{ managementSession: true \}\)/);
assert.match(app, /result\.sessionMode === ['"]management['"]/);

assert.match(css, /\.server-endpoint-badge[\s\S]*\.is-open/);
assert.match(css, /\.shortcut-list[\s\S]*kbd/);
assert.match(style, /\.topbar-menu-panel \.header-feature-button \.button-label\s*\{[^}]*display:\s*inline\s*!important/,
  '顶部下拉菜单必须始终显示功能名称');
assert.match(style, /body\.android-client \.topbar-actions \.topbar-menu\s*\{\s*display:\s*contents/,
  'Android 顶部下拉菜单必须参与操作面板网格布局');
assert.match(style, /body:not\(\.android-client\) \.topbar-actions \.topbar-menu-panel\s*\{[\s\S]*position:\s*static[\s\S]*grid-column:\s*1 \/ -1/,
  '手机网页顶部下拉面板必须跨列静态展开，避免裁剪');
assert.match(css, /\.login-host-shortcuts > button[\s\S]*width:\s*auto/);
assert.match(css, /\.download-center-table-wrap[\s\S]*overflow:\s*auto/);
assert.match(css, /\.download-role-badge[\s\S]*font-size:\s*\.72rem/);
assert.match(css, /\.download-role-client[\s\S]*\.download-role-server/);
assert.match(css, /@media \(max-width:\s*620px\)/);

assert.match(server, /app\.post\(['"]\/api\/download-assets\/:kind['"],[\s\S]*requireSession,[\s\S]*requireHost/);
assert.match(server, /app\.get\(['"]\/api\/releases\/latest['"][\s\S]*latestReleaseChecker\.check/);
assert.match(latestRelease, /https:\/\/api\.github\.com\/repos\/xuange6610\/SyncWatch\/releases\/latest/);
assert.match(latestRelease, /DEFAULT_RELEASE_ATOM/);
assert.match(latestRelease, /response\.status === 403[\s\S]*fallbackUrl/);
assert.match(server, /managedClientDownloadPath[\s\S]*managedAndroidApkPath/);
assert.match(server, /DOWNLOAD_ASSET_FILE_LIMIT_BYTES/);
assert.match(server, /EXE 文件头无效[\s\S]*ZIP\/APK 文件头无效[\s\S]*DMG 文件尾签名无效/);
assert.match(server, /host-passwordless-management-login/);
assert.match(server, /host-passwordless-room-login/);
assert.match(server, /!directRequest \|\| !hostControlToken \|\| !validHostToken/);

for (const url of [
  'https://github.com/xuange6610',
  'https://github.com/xuange6610/SyncWatch',
  'https://github.com/xuange6610/SyncWatch/releases/latest',
  'https://github.com/xuange6610/SyncWatch/wiki'
]) assert.ok(electron.includes(url), `帮助菜单缺少 ${url}`);
assert.match(electron, /const HELP_LINK_ALLOWLIST = new Set\(Object\.values\(HELP_LINKS\)\)/);
assert.match(electron, /url\.protocol !== ['"]https:['"][\s\S]*url\.hostname !== ['"]github\.com['"]/);
assert.match(electron, /label: `\$\{label\}（\$\{path\.basename\(target\)\}）`/);

console.log('服务器顶栏、下载中心、本机入口、固定下载上传与 Electron 帮助菜单契约检查通过。');

