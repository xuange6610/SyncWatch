'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const proMaxCss = fs.readFileSync(path.join(root, 'public', 'css', 'pro-max.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');

function hasId(id) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `缺少 #${id}`);
}

for (const id of [
  'loginMusicNowPlaying', 'loginMusicProgressShell', 'loginMusicProgress', 'loginMusicTime',
  'loginVideoSettingsCard', 'loginVideoEnabled', 'loginVideoFile', 'loginVideoPreview',
  'loginVideoUploadProgress', 'saveLoginVideoBtn', 'removeLoginVideoBtn', 'loginVideoStatus',
  'saveNoticePreferenceSettingsBtn', 'clearAllToastsBtn', 'roomAllowGuests',
  'globalRoomStorageLimitMb', 'roomMediaPreviewSelectAll', 'roomMediaPreviewBatchDeleteBtn',
  'roomMediaPreviewBanUploadBtn', 'mediaProcessingDeleteSource',
  'guestConvertBtn', 'guestConvertModal', 'closeGuestConvertBtn', 'guestConvertForm',
  'guestConvertUsername', 'guestConvertPassword', 'guestConvertPasswordConfirm',
  'guestConvertEmail', 'guestConvertEmailCode', 'sendGuestConvertEmailCodeBtn', 'guestConvertStatus',
  'loginCubeModelFile', 'loginCubeModelTutorial', 'phoneOneTapLoginBtn', 'wechatLoginBtn', 'qqLoginBtn',
  'loginRoomReminderPreference', 'loginTemporaryRoomBtn', 'mediaCompatibilityAutoConvert'
  , 'loginHostShortcuts', 'adminMaxConcurrentSessions', 'lanScanSelectAll', 'deleteSelectedLanRoomsBtn'
]) hasId(id);

assert.ok(html.indexOf('id="loginHostShortcuts"') < html.indexOf('id="loginForm"'), '服务器快捷入口必须位于登录表单上方');
assert.ok(html.indexOf('id="resetAdminPasswordBtn"') < html.indexOf('id="loginForm"'), '重置超级管理员密码入口必须位于登录表单上方');
assert.doesNotMatch(html, /id=["']adminUnlimitedDevices["']/, 'admin 登录策略应使用明确的并发数量，而不是不限设备开关');
assert.match(html, /id=["']adminMaxConcurrentSessions["'][^>]*type=["']number["'][^>]*min=["']1["'][^>]*max=["']20["']/);
assert.match(html, /实时共享网页画面/);
assert.match(html, /同步网址（各端独立浏览）/);
assert.match(app, /state\.localCapture\s*=\s*stream[\s\S]{0,500}emitAck\(['"]screen-share-start['"]/, '屏幕流必须在通知观看端建连前可用');

assert.doesNotMatch(html, /游客模式\s*·\s*免注册，退出即删除/);
assert.match(html, /游客模式\s*·\s*免注册/);

assert.match(html, /id=["']loginCubeDisplayMode["'][\s\S]{0,600}value=["']cube["'][\s\S]{0,240}value=["']model["'][\s\S]{0,240}value=["']flat["'][\s\S]{0,240}value=["']hidden["']/);
assert.match(html, /id=["']loginCubeRotationDirection["'][\s\S]{0,700}value=["']right["'][\s\S]{0,180}value=["']left["'][\s\S]{0,180}value=["']up["'][\s\S]{0,180}value=["']down["'][\s\S]{0,180}value=["']random["']/);
assert.match(html, /id=["']loginCubeModelFile["'][^>]*accept=["'][^"']*(?:\.glb|model\/gltf-binary)[^"']*["']/);
assert.doesNotMatch(html, /id=["']loginCubeModelFile["'][^>]*(?:\.gltf|model\/gltf\+json)/);
assert.match(html, /单文件 GLB 2\.0/);
assert.match(html, /不超过 25 MB/);

assert.match(html, /id=["']f11PromptGlobalEnabled["'][^>]*checked/);
assert.match(html, /id=["']initialPasswordReminderEnabled["'][^>]*checked/);
assert.match(html, /id=["']mediaCompatibilityAutoConvert["'][^>]*checked/);
assert.match(html, /id=["']theater["'][^>]*data-mobile-module-active=["']watch["']/);
assert.match(html, /id=["']clearAllToastsBtn["'][^>]*class=["'][^"']*is-hidden/);
assert.match(html, /id=["']roomAllowGuests["'][^>]*checked/);
assert.doesNotMatch(html, /id=["']mediaProcessingDeleteSource["'][^>]*checked/);

const registrationVerification = html.match(/<div\s+id=["']registrationEmailVerificationRow["'][^>]*>/)?.[0] || '';
assert.ok(registrationVerification, '缺少常显注册邮箱验证码行');
assert.doesNotMatch(registrationVerification, /\bis-hidden\b/, '注册邮箱验证码不能默认隐藏');
assert.match(html, /id=["']regEmailVerificationCode["'][^>]*data-required-when=["']regEmail["']/);
assert.match(html, /填写邮箱[^<]*(?:必须|需要)[^<]*验证码/);

for (const providerId of ['phoneOneTapLoginBtn', 'wechatLoginBtn', 'qqLoginBtn']) {
  assert.match(html, new RegExp(`id=["']${providerId}["'][^>]*\\bdisabled\\b`), `${providerId} 在未配置服务商时必须禁用`);
}
assert.match(html, /需(?:要)?服务商配置|服务商尚未配置/);

assert.match(html, /id=["']guestConvertModal["'][^>]*role=["']dialog["'][^>]*aria-modal=["']true["']/);
assert.match(html, /id=["']guestConvertEmailCode["'][^>]*data-required-when=["']guestConvertEmail["']/);
assert.match(html, /id=["']loginVideoEnabled["'][^>]*data-mutually-exclusive-with=["']loginMusicEnabled["']/);

assert.match(css, /login-cube-scene\[data-display-mode=["']flat["']\][\s\S]{0,900}login-cube-front/);
assert.match(css, /login-cube-scene\[data-display-mode=["']hidden["']\]/);
assert.match(css, /\.clear-all-toasts-button\s*\{[^}]*position:\s*fixed;[^}]*pointer-events:\s*auto;/s);
assert.match(css, /\.login-music-progress-popover\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s);
assert.match(css, /\.login-now-playing\.is-expanded\s+\.login-music-progress-popover/);
assert.match(css, /\.player-container:fullscreen\s+\.fullscreen-show-button[\s\S]{0,500}pointer-events:\s*auto/);
assert.doesNotMatch(css, /@import\s+(?:url\()?['"]?https?:\/\//i, '不得引用远程字体或样式');
assert.match(css, /data-mobile-module-active=["']chat["'][\s\S]{0,900}\.chat-panel/);
assert.match(css, /body\.android-client\s+\.side-panel\.mobile-open\s*\{[^}]*transform:\s*translateX\(0\)/s);
assert.match(css, /\.mobile-module-nav\s*\{[^}]*position:\s*static;/s,
  '移动端模块导航必须随页面自然滚动，不能固定遮挡观影内容');
assert.match(css, /\.live-voice-bar:not\(\.is-collapsed\)\s+\.voice-fold-button\s*\{[^}]*width:\s*100%/s,
  '移动端语音折叠按钮必须保持横向完整触控区域');
assert.match(css, /:fullscreen:not\(\.controls-visible\)\s+\.player-progress-bar[^}]*visibility:\s*hidden/s,
  '全屏隐藏界面时不能残留播放进度条');
assert.match(app, /LOGIN_ROOM_REMINDER_KEY_PREFIX/);
assert.match(app, /dataset\.mobileModuleActive\s*=\s*module/);
assert.match(app, /if \(isPlayerFullscreen\(\)\) showFullscreenControls\(\);[\s\S]{0,120}else void togglePlayerFullscreen\(\);/,
  '全屏双击必须重新显示聊天与控件');
assert.match(app, /state\.room\.playback\.isPlaying\s*=\s*action === ['"]play['"][\s\S]{0,120}syncPlayPauseButton/,
  '播放暂停按钮必须在服务端确认前先即时更新');
assert.match(app, /applyPlaybackCommand\(command\)\s*\{\s*adaptiveSynchronize\(command,\s*!\[['"]volume['"],\s*['"]rate['"],\s*['"]speed['"],\s*['"]playback-rate['"]\]\.includes/,
  '倍速命令不能被当作强制定位，避免重复播放一小段');
assert.match(app, /const locallyBuffering\s*=\s*state\.localBuffering\s*\|\|\s*elements\.videoPlayer\.readyState\s*<\s*3/,
  '同步器必须识别本机缓冲状态');
assert.match(app, /if \(locallyBuffering\)[\s\S]{0,260}正在缓冲，暂停定位/,
  '本机缓冲时必须暂停强制定位，避免公网 Range 请求被反复重置');
assert.match(proMaxCss, /input:not\(\[type=["']checkbox["']\]\):not\(\[type=["']radio["']\]\),\s*select,\s*textarea\s*\{/,
  '通用表单样式不得把 checkbox 拉高成文本框');

console.log('Round 29 HTML/CSS structure, safe defaults, accessibility hooks, and fullscreen reachability passed.');
