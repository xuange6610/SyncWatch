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
  'loginMusicTrackSelect', 'loginMusicPreviousBtn', 'loginMusicNextBtn', 'loginMusicPlaybackMode',
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
  , 'collapseMembersPanelBtn'
]) hasId(id);
assert.match(html, /id=["']danmakuSettingsBtn["'][^>]*aria-controls=["']danmakuSettingsPanel["']/);
assert.match(app, /elements\.danmakuSettingsBtn\?\.addEventListener\('click', toggleDanmakuSettings\)/);
assert.match(css, /panel-collapse-pulse/);
assert.match(css, /\.topbar-menu:not\(\[open\]\)\s*>\s*\.topbar-menu-panel\s*\{\s*display:\s*none/,
  '未展开的顶部菜单不得渲染内部按钮或挤出视口');
assert.match(css, /\.topbar-menu-panel::before\s*\{[^}]*top:\s*-8px;[^}]*height:\s*8px;/,
  '桌面顶部菜单必须保留从触发器到下拉项的连续悬停路径');
assert.match(css, /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)[\s\S]{0,260}\.topbar-menu:hover\s*>\s*\.topbar-menu-panel\s*\{\s*display:\s*grid\s*!important;/,
  '支持悬停的桌面浏览器必须能直接展开顶部菜单项');
assert.match(html, /id=["']fullscreenLockBtn["'][\s\S]{0,220}快捷键 L/,
  '全屏锁定按钮必须明确显示 L 快捷键');
assert.match(html, /按 F2 或回车呼出边看边聊/,
  '全屏提示必须同时说明 F2 和回车可以呼出边看边聊');
assert.match(app, /const shortcuts = state\.accountViewPreferences\.shortcuts[\s\S]{0,260}shortcutMatches\(event,\s*shortcuts\.fullscreenLock\)[\s\S]{0,260}toggleFullscreenInteractionLock\(\)/,
  '全屏锁定必须使用当前账号自定义快捷键');
assert.match(app, /event\.key === ['"]Enter['"][\s\S]{0,220}openFullscreenChat\(\)/,
  '全屏按回车必须打开边看边聊并聚焦输入框');
for (const [id, label] of [
  ['copyRoomCodeBtn', '分享房间号'],
  ['copyLanAddressBtn', '分享内网地址'],
  ['copyPublicAddressBtn', '分享公网地址'],
  ['copyShareLinkBtn', '分享地址'],
  ['copyTunnelUrlBtn', '分享公网地址']
]) {
  assert.match(html, new RegExp(`id=["']${id}["'][^>]*>\\s*${label}\\s*</button>`), `#${id} 必须显示“${label}”`);
}
assert.match(electron, /await createSplash\(\)[\s\S]{0,260}require\(['"]\.\/server['"]\)/,
  'Electron 必须先绘制启动页，再加载体积较大的服务端模块');
assert.doesNotMatch(electron, /^const \{ APP_VERSION, startSyncWatchServer, resolveDefaultDataDir \} = require\(['"]\.\/server['"]\);/m,
  '服务端模块不得在启动页出现前被同步加载');
const runtimeInformationSource = electron.match(/async function showRuntimeInformation\(\)\s*\{[\s\S]*?\n\}\n\nfunction copyLanAddress/)?.[0] || '';
assert.ok(runtimeInformationSource, '缺少完整的运行信息窗口实现');
assert.match(runtimeInformationSource, /new BrowserWindow\([\s\S]*?backgroundColor:\s*['"]#101318['"]/,
  '运行信息 BrowserWindow 必须使用与应用一致的深色背景');
assert.match(runtimeInformationSource, /body\{[^}]*background:\s*#101318/,
  '运行信息页面必须使用与应用一致的深色主题');

assert.ok(html.lastIndexOf('id="loginHostShortcuts"') > html.indexOf('id="myRoomsLoginBtn"'), '登录卡片中的服务器快捷入口模板必须位于我的房间记录之后');
assert.ok(html.indexOf('id="loginHostShortcuts"') < html.indexOf('class="device-ip-row"'), '服务器快捷入口必须位于设备 IP 信息之前');
assert.doesNotMatch(html, /id=["']adminUnlimitedDevices["']/, 'admin 登录策略应使用明确的并发数量，而不是不限设备开关');
assert.match(html, /id=["']adminMaxConcurrentSessions["'][^>]*type=["']number["'][^>]*min=["']1["'][^>]*max=["']20["']/);
assert.match(html, /同步观影网址（实时画面）/);
assert.match(html, /支持任意 HTTP\/HTTPS 网页/);
assert.match(app, /if \(!roomId\)[\s\S]{0,140}请输入房间号后再登录/);
assert.match(app, /mode: 'live'/);
assert.match(app, /const passwordState = room\.passwordRequired \? ['"]密码：有['"] : ['"]密码：无['"]/, '在线房间下拉必须显示实时密码状态');
assert.match(app, /select\.id === ['"]onlineRoomSelect['"][\s\S]{0,220}Math\.min\(520/, '在线房间下拉菜单必须提供更宽的可读宽度');
assert.match(css, /recommended-action-breathe/);
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
assert.match(css, /body:not\(\.android-client\) \.theater[\s\S]{0,260}grid-template-areas:\s*"marquee" "status" "mobile-nav" "player" "toolbar" "owner" "chat"/,
  '手机网页必须先显示视频，再显示选项和房主设置');
assert.match(css, /\.login-now-playing\s*\{[\s\S]{0,900}overflow:\s*visible/,
  '手机登录音乐展开层不能被播放器容器裁剪');
assert.match(css, /\.shortcut-settings-card\s*\{\s*display:\s*none\s*!important/,
  '手机网页不应展示无法可靠使用的键盘快捷键设置');
assert.match(app, /usesMobileActionMenu\(\) && event\.key !== ['"]Escape['"]/, '手机网页应停用不可用的键盘快捷键');
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
assert.match(app, /function applyMembersPanelCollapsed\(\)/, '右侧成员栏必须支持整体折叠');
assert.match(app, /ACCOUNT_VIEW_PREFERENCE_KEY_PREFIX/, '左右栏折叠状态必须按账号缓存');
assert.match(app, /saveAccountViewPreferences\(\{ libraryCollapsed: state\.libraryCollapsed \}\)/, '左侧影片库折叠状态必须保存到账号偏好');
assert.match(app, /saveAccountViewPreferences\(\{ membersPanelCollapsed: state\.membersPanelCollapsed \}\)/, '右侧成员栏折叠状态必须保存到账号偏好');
assert.doesNotMatch(app, /syncwatch(?:Files|MembersPanel)Collapsed/, '折叠状态不得继续使用会串账号的全局存储键');
assert.match(css, /\.workspace\.members-panel-collapsed\.user-panel|\.workspace\.members-panel-collapsed \.user-panel/, '右侧成员栏折叠后必须收窄');
assert.match(css, /\.login-host-shortcuts\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2/s,
  '服务器登录快捷入口必须在登录卡片内使用紧凑网格');
assert.match(css, /body\.android-client \.login-host-shortcuts\s*\{[^}]*display:\s*none\s*!important/s,
  'Android 客户端不得显示服务器快捷入口');
assert.match(css, /body\.electron-server \.login-host-shortcuts button\s*\{[^}]*height:\s*30px\s*!important;[^}]*min-height:\s*30px\s*!important;[^}]*font-size:\s*11px;/s,
  'Electron 粗指针环境也必须保持服务器快捷入口紧凑');
assert.match(app, /function readLoginMusicPreference\(\)/);
assert.match(app, /function handleLoginMusicEnded\(\)/, '登录音乐结束后必须按播放模式处理下一首');
assert.match(app, /playbackMode/, '登录音乐配置必须保存播放模式');
assert.match(html, /id=["']loginMusicTrackSelect["'][\s\S]{0,120}选择登录背景音乐/, '登录页当前曲目必须提供服务器歌曲切换下拉框');
assert.match(app, /function renderLoginMusicPicker\(music = state\.publicConfig\.loginMusic \|\| \{\}\)/, '登录页必须渲染服务器上传的全部歌曲');
assert.match(app, /applyLoginMusic\(value = \{\}\)[\s\S]{0,700}renderLoginMusicPicker\(music\)/, '服务器下发音乐列表后必须同步刷新当前曲目选择器');
assert.match(app, /trackId: typeof stored\?\.trackId === 'string'/, '当前曲目选择必须在本机持久化');
assert.match(html, /id=["']roomActionsMyRoomsBtn["'][\s\S]{0,240}我的房间/, '房间操作菜单必须提供我的房间入口');
assert.match(html, /id=["']roomActionsRoomSettingsBtn["'][\s\S]{0,240}房间设置/, '房间操作菜单必须提供房间设置入口');
assert.match(app, /roomActionsRoomSettingsBtn\?\.classList\.toggle\('is-hidden', !canManageRoomSettings\)/, '房间设置入口必须按房间管理权限显示');
assert.match(html, /id=["']uploadMinValue["'][\s\S]{0,600}id=["']uploadMaxUnit["']/, '上传限制必须提供文件下限、上限和单位选择');
assert.match(app, /function uploadSizeBytes\(value, unit\)/, '上传限制单位必须转换为字节后提交');
assert.match(app, /uploadMinBytes, uploadLimitBytes, uploadTimeLimitSeconds/, '上传限制保存必须同时提交上下限');
assert.match(app, /headerOnline\?\.closest\('\.header-online-stat'\)\?\.addEventListener\('dblclick', \(event\) => \{[\s\S]{0,220}event\.preventDefault\(\);[\s\S]{0,120}event\.stopPropagation\(\);[\s\S]{0,120}editRoomMaxUsers\(\)/, '在线成员指标双击必须打开人数上限编辑且不能冒泡到主题窗口');
assert.match(app, /const stopRoomHeaderThemeShortcut = \(event\) => \{[\s\S]{0,180}event\.preventDefault\(\);[\s\S]{0,100}event\.stopPropagation\(\);/, '房间状态信息双击必须阻止默认行为和主题事件冒泡');
assert.match(app, /headerStatus\?\.addEventListener\('dblclick', stopRoomHeaderThemeShortcut\)/, '同步状态双击不得打开主题设置');
assert.match(app, /headerServerPortGroup\?\.addEventListener\('dblclick', stopRoomHeaderThemeShortcut\)/, '服务端口双击不得打开主题设置');
assert.match(app, /headerRoomName\?\.addEventListener\('dblclick', \(event\) => \{[\s\S]{0,260}event\.preventDefault\(\);[\s\S]{0,120}event\.stopPropagation\(\);[\s\S]{0,180}renameOwnedRoom\(/, '房间名称双击必须打开重命名且不能冒泡到主题窗口');
assert.match(app, /function editRoomMaxUsers\(\)[\s\S]{0,900}set-room/, '在线成员人数上限编辑必须复用房间设置权限与服务端动作');
assert.match(app, /localStorage\.setItem\(LOGIN_MUSIC_PREFERENCE_KEY, JSON\.stringify\(state\.loginMusicPreference\)\)/,
  '登录音乐播放、静音与音量偏好必须在本机持久化');
assert.match(app, /const loginHostShortcutsVisible\s*=\s*\(!state\.authenticated \|\| state\.managementOnlyAuth\)/,
  '进入普通观影房间后必须隐藏服务器登录快捷入口');
assert.match(app, /function initializeMiddleMouseScroll\(\)/, '网页端必须注册中键拖动滚动处理');
assert.match(app, /state\.publicConfig\s*=\s*\{[\s\S]{0,320}maxUploadBytes:[\s\S]{0,240}uploadTimeLimitSeconds:/, '保存上传限制后必须立即同步影片库提示状态');
assert.match(app, /function saveUploadLimits\(\)[\s\S]{0,1000}applyPublicConfig\(\)/, '上传限制保存完成后必须重新渲染客户端提示');
assert.doesNotMatch(app, /topbarDisplayModeBtn|topbar-compact/, '精简工具栏模式代码必须移除');
assert.match(app, /loginMusicNowPlaying\.classList\.toggle\(['"]is-hidden['"],\s*!\(music\.enabled\s*&&\s*music\.url\s*&&\s*!state\.authenticated\)/,
  '登录音乐控制窗口不能因隐藏标题设置而在手机网页消失');
assert.match(css, /\.login-page\s*>\s*\.login-now-playing\s*\{\s*z-index:\s*180;/,
  '登录音乐控制窗口必须位于登录表单之上');
assert.match(app, /function initializeOnboardingGuide\(\)/, '首次进入必须注册新手引导');
assert.match(app, /ONBOARDING_GUIDE_KEY/, '新手引导完成状态必须持久化');
assert.match(app, /function openOnboardingGuide\([\s\S]{0,500}firstRun\)[\s\S]{0,260}writeOnboardingGuideState\(\{ completed: true, version: 1 \}\)/,
  '新手引导自动提醒首次打开时必须立即记录已提醒，避免重启重复弹出');
assert.match(css, /@media \(max-width:\s*924px\)[\s\S]*main \{[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s,
  '移动端登录页必须使用文档滚动，不能被固定 main 高度截断');
assert.match(css, /@media \(max-width:\s*924px\)[\s\S]*\.login-page \{[^}]*height:\s*auto;[^}]*overflow:\s*visible;[^}]*touch-action:\s*pan-y;/s,
  '手机登录页必须允许手指上下拖动文档');
assert.match(css, /body\.android-client main\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s,
  'Android WebView 登录页不能嵌套在固定高度 main 滚动容器中');
assert.match(css, /body\.android-client \.login-page\s*\{[^}]*overflow:\s*visible;[^}]*touch-action:\s*pan-y/s, 'Android 登录页必须支持手指上下滚动');
assert.match(css, /body\.android-client \.live-voice-bar[\s\S]{0,180}display:\s*none\s*!important/, 'Android 手机端必须彻底隐藏实时语音栏');
assert.match(css, /body\.android-client #liveVoiceBar[\s\S]{0,180}visibility:\s*hidden\s*!important/, 'Android 手机端实时语音栏必须有最终隐藏兜底');
assert.match(css, /body\.android-client \.room-tools-module #fullscreenBtn\s*\{[^}]*grid-row:\s*1/s, 'Android 全屏按钮必须位于第一行');
assert.match(css, /body\.android-client \.room-tools-module \.fullscreen-auto-lock-toolbar\s*\{[^}]*grid-row:\s*1/s, 'Android 全屏自动锁屏必须位于第一行');
assert.match(app, /for \(const key of \[['"]liveVoiceBar['"],\s*['"]liveVoiceFloating['"]\]\)[\s\S]{0,500}elements\[key\]\?\.remove\(\)/, '手机端运行时必须从 DOM 移除实时语音组件');
assert.match(css, /\.login-music-muted-icon\s*\{[^}]*display:\s*none;/, '登录音乐静音图标默认隐藏，避免同一按钮显示成两个按钮');
assert.match(css, /@media \(max-width:\s*924px\)[\s\S]*body:not\(\.android-client\) main\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s,
  '普通手机网页登录页必须覆盖 540px 断点留下的固定 main 高度');
assert.match(css, /body:not\(\.android-client\) \.login-page\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible;[^}]*touch-action:\s*pan-y;/s,
  '普通手机网页登录页必须把滚动交给文档并允许触摸上下滑动');
assert.match(proMaxCss, /body:not\(\.android-client\):not\(\.electron-server\)\s*\{[^}]*height:\s*auto\s*!important;[^}]*overflow-y:\s*auto\s*!important;/s,
  '高级主题不得重新锁住普通网页登录页的文档滚动');
assert.match(proMaxCss, /body:not\(\.android-client\):not\(\.electron-server\)\s*>\s*main\s*>\s*\.login-page\s*\{[^}]*height:\s*auto\s*!important;[^}]*overflow:\s*visible\s*!important;[^}]*touch-action:\s*pan-y;/s,
  '网页登录页必须在主题层保持可触摸的自然滚动');
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
assert.match(proMaxCss, /body\.android-client \.workspace[\s\S]{0,260}overflow-x:\s*clip[\s\S]{0,120}overflow-y:\s*visible/,
  'Android 横屏必须保留文档纵向滚动，同时裁剪横向溢出');
assert.match(proMaxCss, /mobile-module-nav[\s\S]{0,260}grid-template-rows:\s*48px[\s\S]{0,120}grid-auto-rows:\s*48px/,
  '移动端模块栏必须固定为稳定的 48px 触控行，不能被网格拉高');
assert.match(proMaxCss, /body\.android-client \.chat-panel:not\(\.mobile-chat-collapsed\) \.chat-head[\s\S]{0,420}grid-template-rows:\s*auto auto/s,
  'Android 展开聊天时标题必须使用两行紧凑网格布局');
assert.match(proMaxCss, /body\.android-client \.chat-head \.chat-head-actions[\s\S]{0,260}display:\s*flex\s*!important/s,
  'Android 聊天操作按钮必须保持横向 flex 布局，不能纵向撑高');
assert.match(app, /function openMobileModule\(module\)\s*\{[\s\S]{0,260}module === ['"]chat['"] && state\.mobileChatCollapsed/,
  '打开聊天模块时应先展开折叠状态再应用活动模块');
assert.match(app, /LOGIN_ROOM_REMINDER_KEY_PREFIX/);
assert.match(app, /dataset\.mobileModuleActive\s*=\s*module/);
assert.match(app, /classList\.toggle\(['"]chat-expanded['"][\s\S]{0,140}module\s*===\s*['"]chat['"]/,
  '离开移动端聊天模块后必须清除聊天展开状态，恢复播放器工具栏和全屏按钮');
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
assert.match(electron, /function copyLanAddress\([\s\S]{0,300}Notification\.isSupported\(\)[\s\S]{0,220}内网地址已复制到剪贴板/,
  '系统菜单和托盘分享内网地址后必须发送桌面通知');
assert.match(app, /if \(locallyBuffering\)[\s\S]{0,260}正在缓冲，暂停定位/,
  '本机缓冲时必须暂停强制定位，避免公网 Range 请求被反复重置');
assert.match(proMaxCss, /input:not\(\[type=["']checkbox["']\]\):not\(\[type=["']radio["']\]\),\s*select,\s*textarea\s*\{/,
  '通用表单样式不得把 checkbox 拉高成文本框');
assert.match(css, /@media \(max-width:\s*924px\)[\s\S]{0,700}#playPauseBtn[\s\S]{0,180}#floatingPlayerBtn\s*\{\s*display:\s*none\s*!important/,
  '手机端必须隐藏重复播放按钮和悬浮播放按钮');
assert.match(css, /@media \(max-width:\s*924px\)[\s\S]{0,1000}\.room-tools-module #fullscreenBtn\s*\{\s*grid-column:\s*1;\s*grid-row:\s*1[\s\S]{0,180}\.room-tools-module \.fullscreen-auto-lock-toolbar\s*\{\s*grid-column:\s*2;\s*grid-row:\s*1/,
  '手机端全屏与全屏自动锁屏必须固定在第一行');
assert.match(app, /const phoneViewport\s*=\s*\(\)[\s\S]{0,260}window\.matchMedia\?\.\('\(max-width: 924px\)'\)\.matches/, 
  '手机端初始化必须识别手机视口并移除实时语音栏和悬浮语音控件');

console.log('Round 29 HTML/CSS structure, safe defaults, accessibility hooks, and fullscreen reachability passed.');
