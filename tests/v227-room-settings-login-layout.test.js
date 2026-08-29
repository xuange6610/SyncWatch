const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

assert.match(html, /id="accountRoomSettingsBtn"[^>]*>房间设置<\/button>/, '账户菜单必须提供房间设置入口');
assert.match(app, /data-profile-action="room-settings"/, '我的房间卡片必须提供房间设置按钮');
assert.match(app, /const ROOM_OWNER_MANAGEMENT_SECTIONS = new Set\(\['room', 'permissions', 'chat'\]\)/, '房主范围必须只包含三个模块');
assert.match(app, /scope === 'room-owner'/, '打开管理中心时必须支持房主范围');
assert.match(app, /accountRoomSettingsBtn/, '账户菜单房间设置必须接入点击处理');
assert.match(css, /\.login-page\s*\{[\s\S]*?align-items:\s*start;/, '登录页必须从顶部开始布局，避免短窗口垂直居中裁切');
assert.match(css, /\.login-page #authCard\.auth-card\s*\{[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;/, '登录卡片不得再使用内部固定高度裁切');
assert.match(css, /\.login-visual\s*\{[\s\S]*?align-items:\s*center;/, '登录页立体框容器必须垂直居中');
assert.match(app, /function maybeResumeWatchPosition\(/, '客户端必须提供未完成影片的继续播放提示');
assert.match(app, /resumeHistory/, '客户端必须接收账户级观看进度');
assert.match(app, /pagehide[\s\S]{0,180}reportWatchProgress\(\)/, '关闭或异常退出前必须尽量冲刷最新观看进度');
assert.match(app, /videoManagementBatchCoverBtn/, '视频管理必须提供批量随机封面入口');
assert.match(app, /\/api\/files\/cover\/batch/, '批量封面必须调用服务器生成接口');
assert.match(server, /onSafe\(['"]web-share-start['"]/, '服务端必须提供网页共享启动事件');
assert.match(server, /fileId:\s*null[\s\S]{0,240}playbackRate:\s*1/, '网页共享启动必须清空原播放状态');
assert.match(html, /同步网址.*各端独立浏览/, '网页 URL 模式必须明确各端独立加载边界');

console.log('v2.2.7 room settings and login layout contract passed');
