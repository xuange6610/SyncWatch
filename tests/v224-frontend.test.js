'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');

function hasId(id) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `v2.2.4 前端缺少 #${id}`);
}

for (const id of [
  'conciseModeBtn', 'danmakuSettingsBtn', 'danmakuSettingsPanel', 'danmakuColorInput', 'danmakuFontSizeInput',
  'chatOnlyToggle', 'skipSettingsBtn', 'skipSettingsModal', 'skipIntroSeconds', 'skipOutroSeconds', 'permSkipSettings', 'groupPermSkipSettings',
  'libraryQueueSelectAll', 'addSelectedToQueueBtn', 'queueSelectAll', 'removeSelectedQueueBtn',
  'videoManagementBatchRenameBtn', 'videoManagementRenameTemplate', 'videoManagementRenamePreview',
  'applyVideoManagementRenameBtn', 'videoManagementPreviewPlayer'
]) hasId(id);

assert.match(app, /function handlePlayerDoubleClick\([\s\S]{0,650}cancelPendingFullscreenPlaybackGesture\(\)[\s\S]{0,300}showFullscreenControls\(\)/,
  '全屏双击必须取消待确认的播放事件并只调出边看边聊');
const doubleClickHandler = app.match(/function handlePlayerDoubleClick\([\s\S]*?\n\}/)?.[0] || '';
assert.doesNotMatch(doubleClickHandler, /togglePlayPause|sendPlayback\(/,
  '全屏双击不得直接播放、暂停或发送播放命令');
assert.match(app, /function handleLocalPlaybackEvent\([\s\S]{0,900}fullscreenPlaybackGestureTimer/,
  '全屏原生播放事件必须延迟确认，避免双击误触');

assert.match(app, /function suppressFullscreenInterruptions\([\s\S]{0,800}clearAllToasts\(\)/,
  '进入全屏时必须清掉 toast 与外部提示');
assert.match(app, /function toast\([\s\S]{0,260}fullscreenInterruptionsSuppressed\(\)[\s\S]{0,120}return null/,
  '全屏期间不得创建 toast');
assert.match(app, /function openAppDialog\([\s\S]{0,300}fullscreenInterruptionsSuppressed\(\)/,
  '全屏期间不得打开通用弹窗');
assert.match(css, /body\.fullscreen-open\s+\.modal[\s\S]{0,350}display:\s*none\s*!important/,
  '伪全屏也必须硬性隐藏普通弹窗与通知');
assert.match(css, /player-container:(?:fullscreen|fullscreen-active)[\s\S]{0,500}danmaku-container[\s\S]{0,260}display:\s*block\s*!important/,
  '弹幕层在原生与伪全屏中都必须可见');

assert.match(app, /shortcutMatches\(event,\s*shortcuts\.appFullscreen\)[\s\S]{0,220}togglePlayerFullscreen\(\)/,
  '应用全屏必须使用当前账号自定义快捷键');
assert.match(css, /fullscreen-chat-card[\s\S]{0,450}max-width:\s*calc\(100vw\s*-/,
  '边看边聊在浏览器缩放或低分辨率时不得溢出视口');
assert.match(css, /fullscreen-actions[\s\S]{0,420}overflow-(?:x|y|block):\s*auto/,
  '全屏操作在低高度或高缩放下必须仍可达');

assert.match(app, /action:\s*['"]set-view-preferences['"][\s\S]{0,300}conciseMode[\s\S]{0,300}chatOnly/,
  '简洁模式与仅聊天必须保存为服务端账户偏好');
assert.match(css, /body\.concise-mode[\s\S]{0,2000}\.chat-panel/,
  '简洁模式必须有独立紧凑布局');
assert.match(app, /function conciseNoticeAllowed\([\s\S]{0,500}(?:进入|加入)[\s\S]{0,300}(?:离开|退出)[\s\S]{0,300}(?:进度|拖动|跳转)/,
  '简洁模式只保留进出房间与进度调整通知');
assert.match(app, /function filteredChatMessages\([\s\S]{0,450}state\.accountViewPreferences\.chatOnly[\s\S]{0,220}announcement[\s\S]{0,220}system/,
  '仅显示聊天内容必须过滤公告与系统通报');

assert.match(app, /function applyDanmakuPreferences\([\s\S]{0,500}--account-danmaku-color[\s\S]{0,260}--account-danmaku-size/,
  '弹幕颜色与字号必须通过账户偏好实时应用');
assert.match(css, /\.danmaku-item\s*\{[^}]*color:\s*var\(--account-danmaku-color/s,
  '弹幕必须使用账户自定义颜色与字号');

assert.match(app, /emitAck\(['"]room-playback-skip-settings['"][\s\S]{0,400}introSeconds[\s\S]{0,300}outroSeconds/,
  '片头片尾设置 UI 必须接入房间设置事件');
assert.match(app, /skipSettings:\s*elements\.permSkipSettings\.checked/, '成员权限保存必须包含跳过片头片尾设置权限');
assert.match(app, /skipSettings:\s*elements\.groupPermSkipSettings\.checked/, '权限组保存必须包含跳过片头片尾设置权限');
assert.match(app, /state\.permissions\.skipSettings/, '客户端必须根据 skipSettings 权限控制编辑入口');
assert.match(app, /state\.socket\.on\(['"]room-skip-settings-updated['"]/,
  '客户端必须实时接收片头片尾设置');
assert.match(app, /state\.socket\.on\(['"]quality-change-requested['"]/,
  '客户端必须接收管理员或房主发来的清晰度调整申请');
assert.match(app, /emitAck\(['"]quality-change-response['"]/,
  '客户端必须回复清晰度调整申请');

assert.match(app, /action:\s*['"]batch-add['"][\s\S]{0,300}fileIds/,
  '影片库批量加入播放队列必须使用批量协议');
assert.match(app, /action:\s*['"]batch-remove['"][\s\S]{0,300}fileIds/,
  '播放队列必须支持批量移除');

assert.match(app, /function renderServerEndpointStatus\([\s\S]{0,420}state\.hostToken[\s\S]{0,220}state\.capabilities\.serverHost/,
  '局域网服务状态只能在真实服务器主机上显示');
const endpointRenderer = app.match(/function renderServerEndpointStatus\([\s\S]*?\n\}/)?.[0] || '';
assert.doesNotMatch(endpointRenderer, /serverHostLoginAvailable|capabilities\.superAdmin/,
  '远程客户端和超级管理员账号都不得因权限而暴露局域网 IP');

assert.match(app, /cache:\s*['"]no-store['"][\s\S]{0,500}release\.(?:tag_name|tagName|version)/,
  '检查更新必须绕过缓存并兼容稳定版本字段');
assert.match(html, /id=["']copyLanAddressBtn["'][^>]*server-only-control/,
  '复制内网地址必须标记为服务器应用专属控件');
assert.match(app, /function lanShareAddress\(\)[\s\S]{0,180}SyncWatchPlatform\?\.serverApp\s*!==\s*true\) return ['"]["']/,
  '普通客户端不得生成或回退到内网分享地址');
assert.match(app, /function showQr\([\s\S]{0,260}serverApp[\s\S]{0,160}publicAddress[\s\S]{0,100}localAddress/,
  '二维码的公网/内网双地址选择只能出现在真实服务器应用');

for (const id of ['requestRoomCopyBtn', 'roomCopyRequestList', 'roomMigrationSource', 'roomMigrationTarget', 'migrateRoomBtn']) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `房间复制与迁移界面缺少 ${id}`);
}
assert.match(app, /function requestRoomCopy\([\s\S]{0,900}room-copy-request/,
  '房主必须可以提交房间复制申请');
assert.match(app, /function handleRoomCopyRequestAction\([\s\S]{0,900}room-copy-request-action/,
  '源房主必须可以同意或拒绝房间复制申请');
assert.match(app, /function migrateRoomData\([\s\S]{0,1400}adminAction\(['"]migrate-room['"]/,
  '超级管理员必须可以迁移覆盖房间');

assert.match(app, /elements\.mailTemplatePreset\?\.addEventListener\(['"]change['"], applyMailTemplatePreset\)/,
  '选择内置邮件模板后必须立即应用并刷新预览');
assert.match(app, /function updateMailTemplateDraft\(\)[\s\S]{0,260}if \(state\.mailTemplateKey\) \{/,
  '邮件模板预览更新不能依赖草稿键已提前初始化');

assert.match(app, /function managedVideoRenamePlan\([\s\S]{0,1100}replaceAll\('\{name\}'[\s\S]{0,240}replaceAll\('\{index\}'[\s\S]{0,240}replaceAll\('\{ext\}'/,
  '批量重命名必须支持名称、序号和扩展名占位符');
assert.match(app, /function applyVideoManagementRename\([\s\S]{0,1200}\/api\/files\/rename\/batch[\s\S]{0,300}renames:/,
  '批量重命名必须通过服务端批量接口保存');
assert.match(app, /function openVideoManagementPreview\([\s\S]{0,700}videoManagementPreviewPlayer[\s\S]{0,220}mediaUrlWithSessionToken/,
  '视频管理窗口必须提供带会话鉴权的独立预览播放器');
assert.match(css, /video-management-rename-grid[\s\S]{0,500}video-management-rename-preview-row/,
  '批量重命名规则预览必须有稳定的响应式布局');

console.log('v2.2.4 全屏、简洁模式、聊天、弹幕、队列与更新检查前端契约通过。');
