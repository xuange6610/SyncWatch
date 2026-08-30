'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const publicDirectory = path.resolve(__dirname, '..', 'public');
const pageSource = fs.readFileSync(path.join(publicDirectory, 'index.html'), 'utf8');
const styleSource = fs.readFileSync(path.join(publicDirectory, 'css', 'style.css'), 'utf8');
const appSource = fs.readFileSync(path.join(publicDirectory, 'js', 'app.js'), 'utf8');
const noticePreferencesSource = fs.readFileSync(path.join(publicDirectory, 'js', 'notification-preferences.js'), 'utf8');
const firstPaintThemeSource = fs.readFileSync(path.join(publicDirectory, 'js', 'first-paint-theme.js'), 'utf8');

assert.match(pageSource, /<script src="\/js\/first-paint-theme\.js"><\/script>\s*<link rel="stylesheet" href="\/css\/style\.css">/,
  '保存主题和默认银幕典藏必须在样式表加载前应用，登录页不能先闪出模板配色');
assert.match(firstPaintThemeSource, /let theme\s*=\s*'silver-screen'[\s\S]{0,500}localStorage\.getItem\('syncwatchUiTheme'\)/,
  '首帧主题脚本必须读取设备偏好并默认使用银幕典藏');
assert.match(appSource, /style\.textContent\s*=\s*`body, body \*, body \*::before, body \*::after/,
  '应用字体必须立即覆盖标题和动态内容，而不只改变表单控件');

assert.match(pageSource, /id="roomMarquee"\s+class="room-marquee/);
assert.match(pageSource, /id="ownerControls"\s+class="owner-controls/);

for (const area of ['marquee', 'status', 'mobile-nav', 'toolbar', 'owner', 'player', 'chat']) {
  assert.match(styleSource, new RegExp(`grid-area:\\s*${area}\\b`), `影院布局缺少固定区域 ${area}`);
}

assert.match(styleSource, /\.theater\s*\{[^}]*grid-template-areas:\s*"marquee"\s*"status"\s*"mobile-nav"\s*"toolbar"\s*"owner"\s*"player"\s*"chat"/s,
  'PC/网页影院布局必须显式声明稳定行，避免开启顶部播报后房主控制被挤入播放器');
assert.match(styleSource, /\.room-marquee\.is-hidden\s*\{[^}]*display:\s*none/s,
  '关闭顶部播报时应仅隐藏播报区域');

assert.match(pageSource, /class="topbar-scroll-actions"[\s\S]*id="copyrightBtn"[\s\S]*class="topbar-fixed-actions"[\s\S]*id="serverSettingsLoginBtn"[\s\S]*id="copyAddressBtn"[\s\S]*id="connectionBadge"[\s\S]*id="accountMenuBtn"/,
  '服务器设置、分享房间、连接状态和头像必须位于顶部固定区，不能进入功能滑动栏');
assert.ok(
  /\.topbar-scroll-actions\s*\{[^}]*overflow-x:\s*auto/s.test(styleSource)
    || /\.topbar-scroll-actions\s*\{[^}]*overflow:\s*visible/s.test(styleSource),
  '顶部非固定功能必须支持横向拖动或保持桌面下拉菜单不被裁切'
);
assert.match(styleSource, /button\s*\{[^}]*appearance:\s*none;[^}]*color:\s*var\(--text\);[^}]*background:\s*var\(--theme-button/s,
  '动态生成按钮必须使用主题基线，避免出现白底白字的浏览器原生按钮');
assert.match(styleSource, /input\[type="checkbox"\]\s*\{[^}]*display:\s*inline-grid;[^}]*place-items:\s*center;[^}]*max-width:\s*18px/s,
  '复选框必须保持紧凑尺寸并在格子中央绘制勾选标记');
assert.match(styleSource, /#memberProfileModal\s*\{[^}]*z-index:\s*240/s,
  '从位置清单打开的成员资料必须绘制在位置清单上方');
assert.match(appSource, /topbarDisplayMode:\s*localStorage\.getItem\('syncwatchTopbarDisplayModeV2'\)\s*===\s*'compact'\s*\?\s*'compact'\s*:\s*'text'/,
  '升级后的工具栏必须默认使用文字模式，旧版精简模式缓存不能覆盖新默认值');
assert.match(pageSource, /id="playbackQualitySelect"[^>]*>[\s\S]*<option value="original" selected>原画<\/option>/,
  '播放器清晰度选择器必须在首帧标记原画为默认选项');
assert.match(appSource, /playbackQuality:\s*\['auto',\s*'smooth',\s*'original'\]\.includes\(localStorage\.getItem\('syncwatchPlaybackQuality'\)\)\s*\?\s*localStorage\.getItem\('syncwatchPlaybackQuality'\)\s*:\s*'original'/,
  '没有已保存用户选择时，客户端必须默认使用原画');
assert.match(appSource, /if\s*\(!localStorage\.getItem\('syncwatchPlaybackQuality'\)\)\s*state\.playbackQuality\s*=\s*state\.publicConfig\.defaultPlaybackQuality\s*\|\|\s*'original'/,
  '服务器公共配置缺失或新客户端未保存选择时必须回退原画');
assert.match(styleSource, /#desktopCloseModal\s+\.desktop-close-actions\s*>\s*button:is\(:hover,\s*:focus\)[\s\S]*background:\s*var\(--pink\)/,
  '关闭方式窗口的所有按钮 hover/focus 必须使用与最小化到托盘一致的高亮背景');

for (const id of [
  'refreshAllApplicationsBtn', 'marqueeLoginEnabled', 'copyLanAddressBtn',
  'copyPublicAddressBtn', 'lanAccessEnabled', 'themeFontSearch', 'themeFontSelect',
  'switchOwnedRoomRefreshBtn', 'switchOwnedRoomList', 'switchOwnedRoomStatus',
  'tunnelAutoDiagnose'
]) {
  assert.match(pageSource, new RegExp(`id="${id}"`), `界面缺少 ${id}`);
}
assert.match(pageSource, /当前服务器所有创建的房间（不包括离线房间）/,
  '在线房间列表必须说明它仅展示当前服务器正在运行的房间');
assert.match(appSource, /handleLocalPlaybackEvent[\s\S]{0,700}!canControlPlayback\(\)[\s\S]{0,260}adaptiveSynchronize\(state\.room\?\.playback, true\)/,
  '无播放权限时，原生播放器产生的播放操作必须立即回滚到房间状态');
assert.match(appSource, /async function toggleFloatingPlayer\([\s\S]{0,1500}documentPictureInPicture[\s\S]{0,1500}requestPictureInPicture/,
  '悬浮播放必须包含 Document PiP 与标准 PiP 两级回退');
assert.match(appSource, /function memberDetailsExpanded\(/,
  '房间成员必须支持逐个展开或折叠明细');
assert.match(appSource, /function refreshAllApplications\(/,
  '用户申请中心必须提供一键刷新全部申请');
assert.match(appSource, /function copyLanAddress\([\s\S]{0,400}function copyPublicAddress\(/,
  '房间号区域必须分别支持复制内网和公网地址');
assert.match(appSource, /function activeTunnelPublicUrl\(\)\s*\{[\s\S]{0,300}state\s*===\s*'running'[\s\S]{0,180}verified\s*===\s*true/,
  'Tunnel URLs must be shared only after a successful health verification.');
assert.match(appSource, /function publicShareAddress\(\)\s*\{[\s\S]{0,240}if \(state\.tunnelLastStatus\) return tunnelAddress \? shareAddressForBase\(tunnelAddress\) : ''/,
  'Known but unverified tunnel state must not fall back to a cached public address.');
const fontPresetBlock = appSource.match(/const UI_FONT_PRESETS = \[([\s\S]*?)\n\];/);
assert.ok(fontPresetBlock, '缺少字体预设列表');
assert.equal((fontPresetBlock[1].match(/^  \[/gm) || []).length, 50,
  '字体选择器必须保留 50 个预设');

assert.match(appSource, /async function readClipboardTextFromAvailableSources\([\s\S]{0,1200}SyncWatchDesktop[\s\S]{0,500}SyncWatchAndroid/,
  '网页粘贴必须在 Clipboard API 失败时尝试桌面与安卓原生桥');
assert.match(appSource, /function trySystemPaste\([\s\S]{0,1800}execCommand\('paste'\)[\s\S]{0,1000}Ctrl\+V/,
  '原生桥不可用时必须聚焦输入框并提供系统粘贴降级，不能直接报错终止');
assert.match(appSource, /function renderSwitchOwnedRooms\(rooms[\s\S]{0,3200}renderRoomDirectoryDetails\(room\)[\s\S]{0,700}data-switch-owned-room/,
  '更换房间弹窗必须复用账号资料中的本人房间并提供一键进入');
assert.match(appSource, /function renderSwitchOwnedRooms\(rooms[\s\S]{0,3200}data-switch-owned-select[\s\S]{0,900}data-switch-room-action="delete-selected"/,
  'Switch-room owned-room cards must support item selection and batch deletion.');
assert.match(appSource, /const visibleRooms = \[\.\.\.filteredRooms\]\.sort\(\(left, right\) => Number\(right\.id === state\.room\?\.id\) - Number\(left\.id === state\.room\?\.id\)\)/,
  'The current room must remain pinned to the top of the all-rooms dashboard.');
assert.match(styleSource, /\.global-room-item\.is-current-room\s*\{[^}]*animation:\s*current-room-pulse/s,
  'The current room must keep a theme-aware visual highlight.');
assert.match(appSource, /async function convertTemporaryRoom\([\s\S]{0,2400}value:\s*'custom'[\s\S]{0,300}value:\s*'random'/,
  'Temporary-room conversion must offer both custom and random formal room IDs.');
assert.match(appSource, /function updateUploadEntryAttention\([\s\S]{0,500}category\s*===\s*'video'[\s\S]{0,300}needs-first-video/,
  '当前房间没有影片时上传入口必须保持高亮，首个视频出现后自动停止');
assert.match(styleSource, /\.upload-button\.needs-first-video\s*\{[^}]*animation:\s*first-video-upload-attention/s,
  '空影片上传入口必须使用主题一致的持续提醒动画');
assert.match(styleSource, /body\.android-client\s+\.player-container\.fullscreen-active\s*\{[^}]*position:\s*fixed;[^}]*height:\s*100dvh;[^}]*padding:\s*0/s,
  '安卓伪全屏必须覆盖后置普通播放器尺寸，控制栏不得挤压媒体画面');
assert.match(styleSource, /body\.android-client \.player-container\.fullscreen-active:not\(\.controls-visible\) \.player-progress-bar\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden/s,
  '手机全屏收起控件后必须隐藏自定义进度条，不能与原生进度条长期重叠');
assert.match(styleSource, /\.player-container\.fullscreen-active\s*>\s*\.media-view[\s\S]{0,500}position:\s*absolute;[\s\S]{0,300}inset:\s*0;/,
  '全屏媒体层必须铺满视口，顶部控制只可作为覆盖层');

for (const id of ['mediaProcessingSearch', 'mediaProcessingSelectAll', 'deleteSelectedMediaProcessingBtn']) {
  assert.match(pageSource, new RegExp(`id="${id}"`), `媒体处理窗口缺少 ${id}`);
}
assert.match(appSource, /function handleMediaProcessingSelection\(/, '媒体处理进度需要支持单项选择');
assert.match(appSource, /function deleteSelectedMediaProcessingTasks\(/, '媒体处理进度需要支持批量删除');
assert.match(appSource, /emitAck\('media-processing-dismiss',\s*\{\s*taskIds:/, '删除处理记录必须调用非破坏性的记录清理事件');
const processingDeleteBlock = appSource.match(/async function deleteMediaProcessingTask[\s\S]*?\n\}/)?.[0] || '';
assert.doesNotMatch(processingDeleteBlock, /\/api\/files\//, '删除处理记录不得调用影片删除接口');
assert.match(appSource, /data-file-action="processing-progress"/, '处理中影片卡片需要提供处理进度入口');
assert.match(appSource, /processing \? 'processing-progress'/, '我的影片处理中项目需要提供处理进度入口');
assert.match(appSource, /function bringMemberProfileToFront\(/, '成员资料卡需要提供置顶层级刷新');
assert.match(appSource, /function bringModalToFront\([\s\S]{0,700}modal\.style\.zIndex/, '模态窗口需要统一的动态置顶层级');
assert.match(appSource, /elements\.appDialog\.classList\.remove\('is-hidden'\)[\s\S]{0,220}bringModalToFront\(elements\.appDialog, 500\)/,
  '输入对话框必须提升到已打开资料卡之上');
assert.match(appSource, /function bringMemberProfileToFront\([\s\S]{0,280}activeAppDialog[\s\S]{0,220}bringModalToFront/,
  '资料卡异步刷新时不得重新遮挡活动输入对话框');
assert.match(appSource, /function updateLocationMemberRemarks\(/, '成员备注保存后需要同步位置清单');
assert.match(appSource, /async function saveProfileWithEmailVerification\([\s\S]{0,5000}EMAIL_VERIFICATION_REQUIRED[\s\S]{0,1200}email-bind-request[\s\S]{0,1600}one-time-code[\s\S]{0,900}email-bind-verify[\s\S]{0,900}action:\s*'update-profile'/,
  '个人资料更换邮箱必须完成发送验证码、六位码输入、验证绑定与完整资料二次保存');
assert.match(styleSource, /\.status-card > div > p > strong\s*\{[\s\S]{0,320}white-space:\s*normal/s, '状态卡片标题需要允许换行');
assert.match(styleSource, /\.user-actions\s*\{[\s\S]{0,220}grid-column:\s*2[\s\S]{0,220}flex-wrap:\s*wrap/s, '成员操作按钮需要在窄卡片内换行');
assert.match(styleSource, /\.conversion-progress-toolbar\s*\{[\s\S]{0,180}grid-template-columns/s, '媒体处理工具栏需要稳定网格布局');
assert.match(styleSource, /\.tunnel-primary-actions\s*\{[^}]*display:\s*grid;[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  '公网访问主操作在窄设置栏中必须使用稳定双列布局，避免中文被压成竖排');
assert.match(styleSource, /body\.android-client \.topbar-actions \.header-feature-button[\s\S]{0,240}width:\s*100%;[\s\S]{0,160}white-space:\s*normal/s,
  '安卓功能菜单必须覆盖旧的 38px 固定宽度，文字不能被挤成竖排');
for (const id of ['dataBackupProgress', 'dataBackupProgressBar', 'dataBackupProgressPercent', 'dataBackupProgressDetail']) {
  assert.match(pageSource, new RegExp(`id="${id}"`), `备份导出缺少实时进度控件 ${id}`);
}
assert.match(appSource, /async function readBackupResponseWithProgress\([\s\S]{0,500}Content-Length[\s\S]{0,1200}response\.body\.getReader\(\)/,
  '备份导出必须按响应流字节更新真实进度');
assert.match(pageSource, /\/js\/notification-preferences\.js/, '页面必须加载统一通知暂停模块');
assert.match(noticePreferencesSource, /data-notice-snooze="once"[\s\S]*data-notice-snooze="never"[\s\S]*noticeSnoozeCustomValue/,
  '右下角通知与滚动公告必须支持本次、定时、永久和自定义暂停');
assert.match(noticePreferencesSource, /noticeSuppressionSettings[\s\S]*data-restore-all-notices/,
  '账号安全页必须能够恢复已暂停的通知');
assert.match(pageSource, /id="friendChatFloatingBtn"[^>]*>关闭悬浮提示</,
  '好友对话框必须提供按好友关闭画面悬浮提示的按钮');
assert.match(appSource, /floatingNoticeMuted[\s\S]{0,600}showDanmaku\(\{ text: `\[私聊\]/,
  '好友私聊必须能以仅收件人可见的私聊弹幕显示，并遵守持久化悬浮开关');

console.log('影院顶部播报布局回归检查通过');
