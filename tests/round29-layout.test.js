'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const proMaxCss = fs.readFileSync(path.join(root, 'public', 'css', 'pro-max.css'), 'utf8');
const aiCss = fs.readFileSync(path.join(root, 'public', 'css', 'ai-workbench.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const electron = fs.readFileSync(path.join(root, 'electron-pink.js'), 'utf8');

function hasId(id) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `缺少 #${id}`);
}

for (const id of [
  'loginMusicNowPlaying', 'loginMusicPlayPauseBtn', 'loginMusicMuteBtn', 'loginMusicProgressShell',
  'loginMusicProgress', 'loginMusicTime', 'loginMusicClientVolume', 'loginMusicClientVolumeText',
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
  , 'loginHostShortcuts', 'adminMaxConcurrentSessions', 'lanScanSelectAll', 'deleteSelectedLanRoomsBtn',
  'locationStatusNoticesEnabled', 'locationAuthorizationRequestsEnabled', 'accountTierEditor', 'permissionGroupEditor'
  , 'onboardingGuideModal', 'openOnboardingGuideBtn', 'onboardingGuideStep'
]) hasId(id);

assert.ok(html.indexOf('id="loginHostShortcuts"') > html.indexOf('id="myRoomsLoginBtn"'), '服务器快捷入口必须位于我的房间记录之后');
assert.ok(html.indexOf('id="loginHostShortcuts"') < html.indexOf('class="device-ip-row"'), '服务器快捷入口必须位于设备 IP 信息之前');
assert.doesNotMatch(html, /id=["']adminUnlimitedDevices["']/, 'admin 登录策略应使用明确的并发数量，而不是不限设备开关');
assert.match(html, /id=["']adminMaxConcurrentSessions["'][^>]*type=["']number["'][^>]*min=["']1["'][^>]*max=["']20["']/);
assert.match(html, /实时共享网页画面/);
assert.match(html, /同步网址（各端独立浏览）/);
assert.match(app, /state\.localCapture\s*=\s*stream[\s\S]{0,500}emitAck\(['"]screen-share-start['"]/, '屏幕流必须在通知观看端建连前可用');
assert.match(app, /get-account-overview/, '账号总览必须使用独立服务端 action');
assert.match(app, /SyncWatchPlatform\?\.serverApp\) document\.body\.classList\.add\(['"]electron-server['"]\)/, 'Electron 服务端必须使用专用布局标记');
assert.match(css, /body\.electron-server \.login-visual[\s\S]{0,260}overflow:\s*visible/, 'Electron 服务端立体方块必须保持可见');

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
assert.match(css, /\.login-host-shortcuts button\s*\{[^}]*height:\s*30px;[^}]*min-height:\s*30px;/s,
  '服务器登录快捷入口必须保持 30px 紧凑高度');
assert.match(css, /\.login-host-shortcuts\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2/s,
  '服务器登录快捷入口必须在登录卡片内使用紧凑网格');
assert.match(css, /body\.android-client \.login-host-shortcuts\s*\{[^}]*display:\s*none\s*!important/s,
  'Android 客户端不得显示服务器快捷入口');
assert.match(css, /body\.electron-server \.login-host-shortcuts button\s*\{[^}]*height:\s*30px\s*!important;[^}]*min-height:\s*30px\s*!important;[^}]*font-size:\s*11px;/s,
  'Electron 粗指针环境也必须保持服务器快捷入口紧凑');
assert.match(app, /function readLoginMusicPreference\(\)/);
assert.match(app, /localStorage\.setItem\(LOGIN_MUSIC_PREFERENCE_KEY, JSON\.stringify\(state\.loginMusicPreference\)\)/,
  '登录音乐播放、静音与音量偏好必须在本机持久化');
assert.match(app, /const loginHostShortcutsVisible\s*=\s*\(!state\.authenticated \|\| state\.managementOnlyAuth\)/,
  '进入普通观影房间后必须隐藏服务器登录快捷入口');
assert.match(app, /function initializeMiddleMouseScroll\(\)/, '网页端必须注册中键拖动滚动处理');
assert.match(app, /function initializeOnboardingGuide\(\)/, '首次进入必须注册新手引导');
assert.match(app, /ONBOARDING_GUIDE_KEY/, '新手引导完成状态必须持久化');
assert.match(css, /@media \(max-width:\s*924px\)[\s\S]*main \{[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s,
  '移动端登录页必须使用文档滚动，不能被固定 main 高度截断');
assert.match(css, /@media \(max-width:\s*924px\)[\s\S]*\.login-page \{[^}]*height:\s*auto;[^}]*overflow:\s*visible;[^}]*touch-action:\s*pan-y;/s,
  '手机登录页必须允许手指上下拖动文档');
assert.match(css, /body\.android-client main\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s,
  'Android WebView 登录页不能嵌套在固定高度 main 滚动容器中');
assert.match(css, /body\.android-client \.login-page\s*\{[^}]*overflow:\s*visible;[^}]*touch-action:\s*pan-y/s, 'Android 登录页必须支持手指上下滚动');
assert.match(app, /event\.button\s*!==\s*1[\s\S]{0,180}isExcluded\(event\.target\)/, '中键滚动必须避开表单和交互控件');
assert.match(app, /drag\.container\.scrollTop\s*=\s*drag\.startTop\s*-\s*\(event\.clientY\s*-\s*drag\.startY\)/, '中键拖动必须按垂直位移滚动当前容器');
assert.match(app, /profile-room-item room-directory-card \$\{room\.pinned \? 'pinned' : ''\} \$\{room\.owned \? 'is-owned' : ''\}/, '我的房间卡片必须带有房主高亮状态类');
assert.match(css, /\.profile-room-item\.is-owned\s*\{[^}]*animation:\s*owned-room-pulse/, '房主房间必须持续呼吸高亮');
assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]{0,260}\.profile-room-item\.is-owned\s*\{[^}]*animation:\s*none/s, '房主房间高亮必须支持减少动态效果偏好');
assert.match(css, /\.player-container:fullscreen\s+\.fullscreen-show-button[\s\S]{0,500}pointer-events:\s*auto/);
assert.doesNotMatch(css, /@import\s+(?:url\()?['"]?https?:\/\//i, '不得引用远程字体或样式');
assert.match(css, /data-mobile-module-active=["']chat["'][\s\S]{0,900}\.chat-panel/);
assert.match(css, /body\.android-client\s+\.side-panel\.mobile-open\s*\{[^}]*transform:\s*translateX\(0\)/s);
assert.match(css, /\.mobile-module-nav\s*\{[^}]*position:\s*static;/s,
  '移动端模块导航必须随页面自然滚动，不能固定遮挡观影内容');
assert.match(css, /\.chat-panel:not\(\.mobile-chat-collapsed\)[^{]*\{[^}]*grid-template-rows:[^}]*clamp\(160px,\s*42dvh,\s*420px\)/s,
  '移动端聊天记录必须使用确定的限高轨道，避免长记录撑高整页');
assert.match(css, /\.chat-panel:not\(\.mobile-chat-collapsed\)\s+\.chat-history\s*\{[^}]*height:\s*clamp\(160px,\s*42dvh,\s*420px\);[^}]*overflow|\.chat-history\s*\{[^}]*overflow-y:\s*auto/s,
  '聊天记录必须在自身容器内滚动');
assert.match(aiCss, /@media \(max-width:\s*820px\)[\s\S]*?\.ai-conversation-panel\s*\{[^}]*grid-template-columns:\s*92px\s+minmax\(0,\s*1fr\)\s+104px;[^}]*grid-template-rows:\s*48px;/,
  'AI 对话切换和管理操作在手机端必须保持单行紧凑布局');
assert.match(aiCss, /@media \(max-width:\s*540px\)[\s\S]*?\.ai-config-command-row button[^}]*min-height:\s*48px;/,
  'APK AI 配置按钮必须紧凑排列且保持 48dp 触控高度');
assert.match(aiCss, /\.ai-model-toolbar\s*\{\s*grid-row:\s*1;\s*\}[\s\S]{0,160}\.ai-composer\s*\{\s*grid-row:\s*4;\s*\}/,
  'AI 配置隐藏时各区域仍必须留在固定网格行，避免底部操作被裁切');
assert.match(css, /\.live-voice-bar:not\(\.is-collapsed\)\s+\.voice-fold-button\s*\{[^}]*width:\s*100%/s,
  '移动端语音折叠按钮必须保持横向完整触控区域');
assert.match(css, /:fullscreen:not\(\.controls-visible\)\s+\.player-progress-bar[^}]*visibility:\s*hidden/s,
  '全屏隐藏界面时不能残留播放进度条');
assert.match(app, /LOGIN_ROOM_REMINDER_KEY_PREFIX/);
assert.match(app, /dataset\.mobileModuleActive\s*=\s*module/);
assert.match(app, /if \(isPlayerFullscreen\(\)\)\s*\{?\s*showFullscreenControls\(\);[\s\S]{0,180}(?:openFullscreenChat\(\);)?[\s\S]{0,80}\}?\s*else void togglePlayerFullscreen\(\);/,
  '全屏双击必须重新显示聊天与控件');
assert.match(app, /state\.room\.playback\.isPlaying\s*=\s*action === ['"]play['"][\s\S]{0,120}syncPlayPauseButton/,
  '播放暂停按钮必须在服务端确认前先即时更新');
assert.match(app, /applyPlaybackCommand\(command\)\s*\{\s*adaptiveSynchronize\(command,\s*!\[['"]volume['"],\s*['"]rate['"],\s*['"]speed['"],\s*['"]playback-rate['"]\]\.includes/,
  '倍速命令不能被当作强制定位，避免重复播放一小段');
assert.match(app, /const locallyBuffering\s*=\s*state\.localBuffering\s*\|\|\s*elements\.videoPlayer\.readyState\s*<\s*3/,
  '同步器必须识别本机缓冲状态');
assert.match(app, /elements\.chatPanel\?\.scrollIntoView[\s\S]{0,180}requestAnimationFrame\(\(\)\s*=>\s*\{\s*elements\.chatHistory\.scrollTop\s*=\s*elements\.chatHistory\.scrollHeight;/,
  '切换到移动端聊天模块后必须把内部记录滚到最新消息');
assert.match(html, /id=["']accountTierEditor["'][^>]*class=["'][^"']*modal[^"']*is-hidden[^"']*["'][^>]*role=["']dialog["']/,
  '账户等级查看/编辑必须使用独立主题窗口');
assert.match(html, /id=["']permissionGroupEditor["'][^>]*class=["'][^"']*modal[^"']*is-hidden[^"']*["'][^>]*role=["']dialog["']/,
  '权限组查看/编辑必须使用独立主题窗口');
assert.match(app, /if \(!elements\.permissionGroupEditor\?\.classList\.contains\('is-hidden'\)\) closePermissionGroupEditor\(\)/,
  'ESC 必须优先关闭权限组编辑窗口');
assert.match(app, /history-row lan-room-row[\s\S]{0,160}is-selectable/,
  '可加入房间必须使用专用的选择框、信息和操作布局');
assert.match(css, /\.lan-room-row\.is-selectable\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/,
  '桌面可加入房间必须使用紧凑三列布局');
assert.match(css, /#lanRoomList\s*\{[^}]*align-content:\s*start;[^}]*grid-auto-rows:\s*max-content/,
  '房间行不能被列表剩余高度强行拉伸');
assert.match(css, /@media \(max-width:\s*520px\)[\s\S]{0,500}\.lan-room-row\s*>\s*button\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
  '手机端加入按钮必须独占一行，避免挤压房间信息');
assert.match(app, /locationAuthorizationRequestsEnabled\s*!==\s*false\) setTimeout\(\(\) => void reportMemberLocation/,
  '关闭服务器位置授权提醒后，进房不能再自动请求浏览器位置');
assert.match(electron, /nativeTheme\.themeSource\s*=\s*['"]dark['"]/,
  'Electron 原生菜单必须跟随深色主题');
assert.match(electron, /function copyLanAddress\([\s\S]{0,300}Notification\.isSupported\(\)[\s\S]{0,220}已复制局域网地址/,
  '系统菜单和托盘复制局域网地址后必须发送桌面通知');
assert.match(app, /if \(locallyBuffering\)[\s\S]{0,260}正在缓冲，暂停定位/,
  '本机缓冲时必须暂停强制定位，避免公网 Range 请求被反复重置');
assert.match(proMaxCss, /input:not\(\[type=["']checkbox["']\]\):not\(\[type=["']radio["']\]\),\s*select,\s*textarea\s*\{/,
  '通用表单样式不得把 checkbox 拉高成文本框');

console.log('Round 29 HTML/CSS structure, safe defaults, accessibility hooks, and fullscreen reachability passed.');
