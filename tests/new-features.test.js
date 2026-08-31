require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

function ack(socket, event, payload = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 响应超时`)), timeout);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result || { success: false, error: '服务器未返回结果' }); });
  });
}

function once(socket, event, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} event timeout`)), timeout);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket.IO 连接超时')), 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', reject);
  });
  return socket;
}

async function acceptAgreement(socket, login) {
  if (!login?.success || !login.capabilities?.agreementRequired) return login;
  const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: login.agreement.version });
  assert.equal(accepted.success, true, accepted.error);
  return login;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-new-features-'));
  const publicDir = path.resolve(__dirname, '..', 'public');
  let server; let owner; let manager; let expiring; let themeAdmin; let adminVerifier; let temporaryAdmin; let randomTemporaryAdmin;
  try {
    server = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir, publicDir, hostControlToken: 'new-feature-host', ffprobePath: '', ffmpegPath: '' });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const pageSource = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const appSource = fs.readFileSync(path.join(publicDir, 'js', 'app.js'), 'utf8');
    const styleSource = fs.readFileSync(path.join(publicDir, 'css', 'style.css'), 'utf8');
    const clientLauncherSource = fs.readFileSync(path.resolve(__dirname, '..', 'client-launcher.html'), 'utf8');
    const electronServerSource = fs.readFileSync(path.resolve(__dirname, '..', 'electron-pink.js'), 'utf8');
    const electronClientSource = fs.readFileSync(path.resolve(__dirname, '..', 'electron-client.js'), 'utf8');
    const releaseScriptSource = fs.readFileSync(path.resolve(__dirname, '..', 'build-windows.ps1'), 'utf8');
    const serverPackageScriptSource = fs.readFileSync(path.resolve(__dirname, '..', 'build-server-package.ps1'), 'utf8');
    const serverLauncherBytes = fs.readFileSync(path.resolve(__dirname, '..', 'start-server.ps1'));
    const packageManifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    assert.match(pageSource, /id="adminUsername"/);
    assert.match(pageSource, /id="passwordPolicyExpiryDays"/);
    assert.match(pageSource, /id="changeCurrentRoomIdBtn"/);
    assert.match(pageSource, /id="copyRoomCodeBtn"/);
    assert.match(pageSource, /id="convertTemporaryRoomBtn"/);
    assert.match(pageSource, /id="syncThemeBtn"/);
    assert.match(pageSource, /id="playPauseBtn"/);
    assert.match(pageSource, /id="videoMuteBtn"/);
    assert.match(pageSource, /id="refreshOnlineRoomsBtn"/);
    assert.match(pageSource, /id="closeReconnectOverlayBtn"/);
    assert.match(pageSource, /id="closeRoomSwitchSuccessBtn"/);
    assert.doesNotMatch(pageSource, /id="pauseBtn"/);
    assert.match(pageSource, /id="temporaryRoomNotice"/);
    assert.match(pageSource, /id="themeSyncTargets"/);
    assert.match(pageSource, /id="marqueeEnabled"/);
    assert.match(pageSource, /id="registrationAccountNoticeToggle"/);
    assert.match(pageSource, /id="showSuperAdminAccountsBtn"/);
    assert.match(pageSource, /id="tunnelBypassProxy"[^>]*checked/);
    assert.match(pageSource, /id="roomEntryNoticeModal"/);
    for (const id of ['batchStopRoomsBtn', 'batchBanRoomsBtn', 'batchRenameRoomsBtn', 'batchRenameRoomIdsBtn']) {
      assert.match(pageSource, new RegExp(`id="${id}"`));
    }
    const topbarOrder = [
      'aiWorkbenchBtn', 'masterMuteBtn', 'conversionProgressBtn', 'webShareBtn', 'noticeCenterBtn',
      'themeBtn', 'adminContactBtn', 'copyrightBtn', 'quickDissolveRoomBtn', 'newRoomBtn', 'switchRoomBtn',
      'lanScanBtn', 'serverSettingsLoginBtn'
    ].map((id) => pageSource.indexOf(`id="${id}"`));
    assert.ok(topbarOrder.every((index) => index >= 0));
    assert.deepEqual(topbarOrder, [...topbarOrder].sort((left, right) => left - right));
    assert.equal((pageSource.match(/id="serverSettingsLoginBtn"/g) || []).length, 1);
    assert.doesNotMatch(pageSource, /id="androidBuildSettingsCard"/);
    assert.ok(pageSource.indexOf('id="topbarDisplayModeBtn"') < pageSource.indexOf('id="androidApkBtn"'));
    assert.match(pageSource, /css\/ai-workbench\.css/);
    assert.match(pageSource, /js\/ai-workbench\.js/);
    assert.match(appSource, /initialAdminPasswordSetupSkipped/);
    assert.match(appSource, /cancelText:\s*initialSetup\s*\?\s*['"]暂不更改['"]/);
    assert.match(appSource, /theme-sync-request/);
    assert.match(appSource, /function openManagementHub[\s\S]{0,260}state\.capabilities\.superAdmin/);
    assert.match(appSource, /function renderPersistentRequests\([\s\S]{0,4200}data-request-action="open-accounts"/);
    assert.match(appSource, /account-registration-\$\{request\.username\s*\|\|\s*['"]unknown['"]\}-\$\{request\.registeredAt\s*\|\|\s*request\.createdAt/);
    assert.match(appSource, /function toggleSuperAdminAccountFilter\(/);
    assert.match(appSource, /canManageSuperAdmins\s*=\s*state\.adminSettings\?\.canManageSuperAdmins\s*===\s*true/);
    assert.match(appSource, /dataset\.memberProfileAction\s*=\s*["']level-help["']/);
    assert.match(appSource, /function handleThemeSyncResponse\([\s\S]{0,320}response\.accepted/);
    assert.match(styleSource, /\.theme-modal-card\s*\{[^}]*grid-template-rows:\s*auto\s+auto\s+auto\s+minmax\(0,\s*1fr\)/);
    assert.match(styleSource, /\.theme-grid\s*\{[^}]*grid-row:\s*4/);
    assert.match(appSource, /api\/location\/reverse/);
    assert.match(appSource, /浏览器拒绝了位置授权[\s\S]{0,260}toastWithActions|toastWithActions\([\s\S]{0,260}浏览器拒绝了位置授权/);
    assert.match(appSource, /toast-close/);
    assert.match(appSource, /function toggleVideoMute\(/);
    assert.match(appSource, /function updatePlayerBufferState\(/);
    assert.match(appSource, /address\.searchParams\.set\(['"]room['"],\s*roomId\)/);
    assert.match(appSource, /copyTunnelUrl[\s\S]{0,260}shareAddressForBase/);
    assert.match(appSource, /openTunnelUrl[\s\S]{0,260}shareAddressForBase/);
    assert.match(appSource, /function refreshOnlineRooms\(/);
    assert.match(appSource, /function toast\([\s\S]{0,700}toast-close/);
    assert.match(appSource, /function findMatchingToast\(/);
    assert.match(appSource, /界面风格已从“\$\{previousTheme\[1\]\}”切换为“\$\{nextTheme\[1\]\}”/);
    assert.match(appSource, /syncwatchSelfMemberHighlight/);
    assert.match(appSource, /self-highlight/);
    assert.doesNotMatch(appSource, /elements\.webUrlInput\.value\s*=\s*['"]https:\/\/v\.qq\.com\//);
    assert.match(appSource, /classList\.toggle\(['"]is-current-room['"],/);
    assert.match(appSource, /filteredRooms[\s\S]{0,220}right\.id === state\.room\?\.id/);
    assert.match(appSource, /locationStatusNoticeMuteUntil/);
    assert.match(appSource, /configureLocationStatusNotices/);
    assert.match(styleSource, /@keyframes\s+current-room-pulse/);
    assert.match(appSource, /video-switch-notice/);
    assert.match(pageSource, /id="batchMoveMediaCategoryBtn"/);
    assert.match(pageSource, /id="tunnelTutorialBtn"/);
    assert.match(appSource, /function showAppSelect\(/);
    assert.match(appSource, /api\/files\/category\/batch/);
    assert.match(appSource, /function openTunnelTutorial\(/);
    assert.match(appSource, /chooseUploadCollection/);
    assert.match(appSource, /async function loadTunnelStartupSettings/);
    assert.match(appSource, /async function saveTunnelStartupSettings/);
    assert.match(appSource, /api\/host\/tunnel\/startup/);
    assert.match(appSource, /tunnelBypassProxy\.checked\s*=\s*settings\.bypassProxy\s*!==\s*false/);
    assert.match(appSource, /Array\.isArray\(sessions\)\s*\?\s*sessions\.length\s*>\s*0\s*:\s*Number\(sessions\)\s*>\s*0/);
    assert.match(appSource, /srt\|ass\|ssa\|vtt[\s\S]{0,40}return 'subtitle'/);
    assert.match(appSource, /data-contact-action="copy-open"/);
    assert.match(clientLauncherSource, /首次连接时会在本机创建 SyncWatch同步观影-Data/);
    assert.match(electronServerSource, /const APP_NAME = ['"]SyncWatch同步观影['"];[\s\S]{0,80}app\.setName\(APP_NAME\)/);
    assert.match(electronServerSource, /setAppUserModelId\(['"]com\.xuan\.syncwatch\.server['"]\)/);
    assert.match(electronClientSource, /const APP_NAME = ['"]SyncWatch同步观影['"];[\s\S]{0,80}app\.setName\(APP_NAME\)/);
    assert.match(electronClientSource, /setAppUserModelId\(['"]com\.xuan\.syncwatch\.client['"]\)/);
    assert.match(electronServerSource, /waitForPublicUrl\(establishedUrl, 8000,[\s\S]{0,180}localAddress/);
    assert.match(electronServerSource, /const verified = Boolean\(verifiedResult\?\.ok\)[\s\S]{0,160}if \(!verified && index \+ 1 < strategies\.length\)/);
    assert.match(electronServerSource, /state: verified \? 'running' : 'verifying'[\s\S]{0,160}publicUrl: verified \? establishedUrl : ''/);
    assert.ok(!packageManifest.build.extraResources.some((entry) => entry.from === `SyncWatch同步观影-Client-v${packageManifest.version}.exe`));
    assert.equal(packageManifest.build.portable.artifactName, `SyncWatch-v${packageManifest.version}-Full-Offline-Portable-\${arch}.exe`);
    assert.equal(packageManifest.build.win.executableName, 'SyncWatch同步观影');
    assert.match(releaseScriptSource, /powershell\.exe[\s\S]{0,220}mobile\\build-apk\.ps1/);
    assert.doesNotMatch(releaseScriptSource, /Reusing the existing verified APK artifact/);
    assert.match(releaseScriptSource, /run test:all/);
    assert.match(releaseScriptSource, /Join-Path\s+\$PSScriptRoot\s+['"]dist['"]/);
    assert.match(releaseScriptSource, /Invoke-Builder ['"]electron-builder-client\.json['"]/);
    assert.match(releaseScriptSource, /Assert-Artifact\s+\"SyncWatch-Experience-Client-Portable-v\$\(\$manifest\.version\)-x64\.exe\"/);
    assert.match(releaseScriptSource, /Get-FileHash\s+-Algorithm SHA256/);
    assert.deepEqual([...serverLauncherBytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    assert.match(serverPackageScriptSource, /Management\.Automation\.Language\.Parser\]::ParseFile/);
    const initialPublicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    const roomId = initialPublicConfig.roomId;
    assert.equal(initialPublicConfig.passwordPolicy.expiryDays, 7);
    assert.equal(fs.existsSync(path.join(dataDir, 'secrets', 'admin-password.json')), true);

    owner = await connect(baseUrl); manager = await connect(baseUrl);
    assert.equal((await ack(owner, 'user-register', { username: 'FeatureOwner', password: '123456' })).success, true);
    let ownerLogin = await acceptAgreement(owner, await ack(owner, 'user-login', { username: 'FeatureOwner', password: '123456', roomId, hostToken: 'new-feature-host' }));
    assert.equal(ownerLogin.success, true, ownerLogin.error);
    assert.equal((await ack(owner, 'admin-action', { action: 'add-registration-whitelist', ipAddress: '127.0.0.1', adminPassword: 'admin888' })).success, true);

    assert.equal((await ack(manager, 'user-register', { username: 'FeatureManager', password: '123456' })).success, true);
    let managerLogin = await acceptAgreement(manager, await ack(manager, 'user-login', { username: 'FeatureManager', password: '123456', roomId }));
    assert.equal(managerLogin.success, true, managerLogin.error);
    const privateRemarkSaved = await ack(manager, 'account-action', {
      action: 'set-user-remark', username: 'FeatureOwner', remark: '我的房主备注'
    });
    assert.equal(privateRemarkSaved.success, true, privateRemarkSaved.error);
    const managerOwnerProfile = await ack(manager, 'member-profile', { username: 'FeatureOwner' });
    assert.equal(managerOwnerProfile.success, true, managerOwnerProfile.error);
    assert.equal(managerOwnerProfile.profile.privateRemark, '我的房主备注');
    const ownerSelfProfile = await ack(owner, 'member-profile', { username: 'FeatureOwner' });
    assert.equal(ownerSelfProfile.success, true, ownerSelfProfile.error);
    assert.equal(ownerSelfProfile.profile.privateRemark, '', '私人备注不能泄露给被备注用户或其他账号');
    const onlinePermissionNotice = once(manager, 'permissions-changed');
    assert.equal((await ack(owner, 'admin-action', { action: 'set-permissions', username: 'FeatureManager', groupId: 'administrator', administrator: true })).success, true);
    assert.match((await onlinePermissionNotice).message, /权限已更新/);
    const refreshedUsers = await ack(owner, 'room-refresh');
    const managerSummary = refreshedUsers.users.find((entry) => entry.username === 'FeatureManager');
    assert.equal(managerSummary.permissionGroup.id, 'administrator');
    assert.ok(managerSummary.permissionGroup.name);
    assert.equal(managerSummary.permissionGroup.permissions.manageRoom, true);
    const onlineTierNotice = once(manager, 'account-notification');
    const onlineTierUpdate = await ack(owner, 'admin-action', {
      action: 'set-account-tier', adminPassword: 'admin888', username: 'FeatureManager', tierId: 'advanced'
    });
    assert.equal(onlineTierUpdate.success, true, onlineTierUpdate.error);
    assert.equal((await onlineTierNotice).kind, 'account-tier');
    const marqueeDisabled = await ack(owner, 'admin-action', {
      action: 'set-marquee-notice', adminPassword: 'admin888', enabled: false, loginEnabled: false,
      text: '保留的实时播报内容', color: '#f3c96a', speed: 70, scope: 'all'
    });
    assert.equal(marqueeDisabled.success, true, marqueeDisabled.error);
    assert.equal(marqueeDisabled.marqueeNotice.enabled, false);
    assert.equal(marqueeDisabled.marqueeNotice.loginEnabled, false);
    assert.equal(marqueeDisabled.marqueeNotice.text, '保留的实时播报内容');
    const lanDisabled = await ack(owner, 'admin-action', {
      action: 'set-lan-access', adminPassword: 'admin888', enabled: false
    });
    assert.equal(lanDisabled.success, true, lanDisabled.error);
    assert.equal(lanDisabled.enabled, false);
    const disabledSettings = await ack(owner, 'admin-action', {
      action: 'get-settings', adminPassword: 'admin888'
    });
    assert.equal(disabledSettings.success, true, disabledSettings.error);
    assert.equal(disabledSettings.admin.lanAccessEnabled, false);
    assert.equal((await fetch(`${baseUrl}/api/public-config`)).ok, true,
      '关闭局域网访问后仍需允许本机和公网隧道读取配置');
    const lanEnabled = await ack(owner, 'admin-action', {
      action: 'set-lan-access', adminPassword: 'admin888', enabled: true
    });
    assert.equal(lanEnabled.success, true, lanEnabled.error);
    assert.equal(lanEnabled.enabled, true);

    manager.close(); manager = null;
    await delay(50);
    const offlinePermissionUpdate = await ack(owner, 'admin-action', {
      action: 'set-permissions', username: 'FeatureManager', groupId: 'member', administrator: false,
      control: false, upload: true, delete: false, shareScreen: false, shareWeb: false, voiceChat: true,
      manageChat: false, manageRoom: false, sendNotice: false
    });
    assert.equal(offlinePermissionUpdate.success, true, offlinePermissionUpdate.error);
    const offlineLevelUpdate = await ack(owner, 'admin-action', {
      action: 'set-account-level', adminPassword: 'admin888', username: 'FeatureManager', experience: 80, levelOverride: 2
    });
    assert.equal(offlineLevelUpdate.success, true, offlineLevelUpdate.error);
    const offlineTierUpdate = await ack(owner, 'admin-action', {
      action: 'set-account-tier', adminPassword: 'admin888', username: 'FeatureManager', tierId: 'professional'
    });
    assert.equal(offlineTierUpdate.success, true, offlineTierUpdate.error);
    const offlineEmailUpdate = await ack(owner, 'admin-action', {
      action: 'set-account-email', adminPassword: 'admin888', username: 'FeatureManager', email: 'manager@example.com'
    });
    assert.equal(offlineEmailUpdate.success, true, offlineEmailUpdate.error);
    manager = await connect(baseUrl);
    managerLogin = await acceptAgreement(manager, await ack(manager, 'user-login', { username: 'FeatureManager', password: '123456', roomId }));
    assert.equal(managerLogin.success, true, managerLogin.error);
    assert.deepEqual(new Set((managerLogin.notifications || []).map((notice) => notice.kind)), new Set(['room-permissions', 'account-level', 'account-tier', 'account-email']));
    const onlineEmailNotice = once(manager, 'account-profile-updated');
    const onlineEmailUpdate = await ack(owner, 'admin-action', {
      action: 'set-account-email', adminPassword: 'admin888', username: 'FeatureManager', email: 'manager2@example.com'
    });
    assert.equal(onlineEmailUpdate.success, true, onlineEmailUpdate.error);
    const emailNotice = await onlineEmailNotice;
    assert.equal(emailNotice.profile.email, 'manager2@example.com');
    const restoredPermissionNotice = once(manager, 'permissions-changed');
    assert.equal((await ack(owner, 'admin-action', { action: 'set-permissions', username: 'FeatureManager', groupId: 'administrator', administrator: true })).success, true);
    await restoredPermissionNotice;
    assert.equal((await ack(owner, 'admin-action', { action: 'set-access-password', accessPassword: 'changed-room-pass' })).success, true);
    const ownerRename = await ack(owner, 'admin-action', { action: 'rename-room-id', roomId, newRoomId: 'OWNERROOM' });
    assert.equal(ownerRename.success, true, ownerRename.error);
    assert.equal(ownerRename.newRoomId, 'OWNERROOM');
    const policyUpdate = await ack(owner, 'admin-action', { action: 'set-password-policy', adminPassword: 'admin888', mode: 'unrestricted', minLength: 6, maxLength: 72, expiryDays: 30 });
    assert.equal(policyUpdate.success, true, policyUpdate.error);
    assert.equal(policyUpdate.passwordPolicy.expiryDays, 30);
    expiring = await connect(baseUrl);
    assert.equal((await ack(expiring, 'user-register', { username: 'ExpiringUser', password: '123456' })).success, true);
    const expiringLogin = await acceptAgreement(expiring, await ack(expiring, 'user-login', { username: 'ExpiringUser', password: '123456', roomId: 'OWNERROOM', roomPassword: 'changed-room-pass' }));
    assert.equal(expiringLogin.success, true, expiringLogin.error);
    manager.close(); manager = await connect(baseUrl);
    managerLogin = await acceptAgreement(manager, await ack(manager, 'user-login', { username: 'FeatureManager', password: '123456', roomId: 'OWNERROOM' }));
    assert.equal(managerLogin.success, true, '房间管理员应无需房间密码直接进入');

    themeAdmin = await connect(baseUrl);
    const themeAdminLogin = await acceptAgreement(themeAdmin, await ack(themeAdmin, 'host-admin-login', { adminPassword: 'admin888', roomId: 'OWNERROOM', hostToken: 'new-feature-host' }));
    assert.equal(themeAdminLogin.success, true, themeAdminLogin.error);
    const requestedTheme = once(manager, 'theme-sync-requested');
    const themeRequest = await ack(themeAdmin, 'theme-sync-request', { themeId: 'cinema-deck', targetUsernames: ['FeatureManager'] });
    assert.equal(themeRequest.success, true, themeRequest.error);
    assert.equal(themeRequest.recipientCount, 1);
    assert.deepEqual(themeRequest.request.targetUsernames, ['FeatureManager']);
    const receivedTheme = await requestedTheme;
    assert.equal(receivedTheme.themeId, 'cinema-deck');
    const themeResponse = once(themeAdmin, 'theme-sync-responded');
    const acceptedTheme = await ack(manager, 'theme-sync-response', { requestId: receivedTheme.id, accepted: true });
    assert.equal(acceptedTheme.success, true, acceptedTheme.error);
    assert.equal((await themeResponse).accepted, true);

    const rejectedThemeRequest = once(manager, 'theme-sync-requested');
    assert.equal((await ack(themeAdmin, 'theme-sync-request', { themeId: 'living-room', targetUsernames: ['FeatureManager'] })).success, true);
    const rejectedTheme = await rejectedThemeRequest;
    const rejectedThemeResponse = once(themeAdmin, 'theme-sync-responded');
    assert.equal((await ack(manager, 'theme-sync-response', { requestId: rejectedTheme.id, accepted: false })).success, true);
    const rejectedPayload = await rejectedThemeResponse;
    assert.equal(rejectedPayload.accepted, false);
    assert.match(rejectedPayload.message, /已拒绝/);

    const alreadyAppliedRequest = once(manager, 'theme-sync-requested');
    assert.equal((await ack(themeAdmin, 'theme-sync-request', { themeId: 'cinema-deck', targetUsernames: ['FeatureManager'] })).success, true);
    const alreadyAppliedTheme = await alreadyAppliedRequest;
    const alreadyAppliedResponse = once(themeAdmin, 'theme-sync-responded');
    assert.equal((await ack(manager, 'theme-sync-response', { requestId: alreadyAppliedTheme.id, accepted: true, alreadyApplied: true })).success, true);
    const alreadyAppliedPayload = await alreadyAppliedResponse;
    assert.equal(alreadyAppliedPayload.accepted, true);
    assert.equal(alreadyAppliedPayload.alreadyApplied, true);

    const contradictoryRequest = once(manager, 'theme-sync-requested');
    assert.equal((await ack(themeAdmin, 'theme-sync-request', { themeId: 'living-room', targetUsernames: ['FeatureManager'] })).success, true);
    const contradictoryTheme = await contradictoryRequest;
    const contradictoryResponse = once(themeAdmin, 'theme-sync-responded');
    assert.equal((await ack(manager, 'theme-sync-response', { requestId: contradictoryTheme.id, accepted: false, alreadyApplied: true })).success, true);
    const contradictoryPayload = await contradictoryResponse;
    assert.equal(contradictoryPayload.accepted, false);
    assert.equal(contradictoryPayload.alreadyApplied, false);
    assert.match(contradictoryPayload.message, /已拒绝/);

    const clientPasswordChange = await ack(themeAdmin, 'account-action', {
      action: 'change-password', currentPassword: 'admin888', newPassword: 'ClientAdmin888'
    });
    assert.equal(clientPasswordChange.success, true, clientPasswordChange.error);
    assert.equal(clientPasswordChange.initialSetup, true);
    adminVerifier = await connect(baseUrl);
    const verifiedAfterClientChange = await acceptAgreement(adminVerifier, await ack(adminVerifier, 'host-admin-login', {
      adminPassword: 'ClientAdmin888', roomId: 'OWNERROOM', hostToken: 'new-feature-host'
    }));
    assert.equal(verifiedAfterClientChange.success, true, verifiedAfterClientChange.error);
    assert.equal(verifiedAfterClientChange.capabilities.mustChangeAdminPassword, false);

    temporaryAdmin = await connect(baseUrl);
    const temporaryLogin = await acceptAgreement(temporaryAdmin, await ack(temporaryAdmin, 'host-admin-login', { adminPassword: 'ClientAdmin888', hostToken: 'new-feature-host' }));
    assert.equal(temporaryLogin.success, true, temporaryLogin.error);
    assert.equal(temporaryLogin.room.temporary, true);
    const converted = await ack(temporaryAdmin, 'admin-action', {
      action: 'convert-temporary-room', roomId: temporaryLogin.room.id, name: 'Converted Test Room',
      roomIdMode: 'custom', newRoomId: 'FORMALROOM'
    });
    assert.equal(converted.success, true, converted.error);
    assert.equal(converted.room.temporary, false);
    assert.equal(converted.room.id, 'FORMALROOM');
    const convertedRoomId = converted.room.id;
    randomTemporaryAdmin = await connect(baseUrl);
    const randomTemporaryLogin = await acceptAgreement(randomTemporaryAdmin, await ack(randomTemporaryAdmin, 'host-admin-login', {
      adminPassword: 'ClientAdmin888', hostToken: 'new-feature-host'
    }));
    assert.equal(randomTemporaryLogin.success, true, randomTemporaryLogin.error);
    assert.equal(randomTemporaryLogin.room.temporary, true);
    const randomConverted = await ack(randomTemporaryAdmin, 'admin-action', {
      action: 'convert-temporary-room', roomId: randomTemporaryLogin.room.id, name: 'Random Converted Room', roomIdMode: 'random'
    });
    assert.equal(randomConverted.success, true, randomConverted.error);
    assert.equal(randomConverted.room.temporary, false);
    assert.match(randomConverted.room.id, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.notEqual(randomConverted.room.id, randomTemporaryLogin.room.id);
    console.log('✓ 管理员客户端改密会同步服务器、临时房可转正式房、管理员可向房间成员发送风格同步邀请');

    const remote = await ack(owner, 'add-remote-video', { name: 'COS电影.mp4', url: 'https://example.com/movie.mp4' });
    assert.equal(remote.success, true, remote.error);
    assert.equal(remote.file.sourceType, 'remote');
    const selectedRemote = await ack(owner, 'select-file', { fileId: remote.file.id });
    assert.equal(selectedRemote.success, true, selectedRemote.error);
    const remoteNext = await ack(owner, 'add-remote-video', { name: 'COS电影续集.mp4', url: 'https://example.com/movie-next.mp4' });
    assert.equal(remoteNext.success, true, remoteNext.error);
    const switchNoticePending = once(manager, 'video-switch-notice');
    const selectedNext = await ack(owner, 'select-file', { fileId: remoteNext.file.id });
    assert.equal(selectedNext.success, true, selectedNext.error);
    const switchNotice = await switchNoticePending;
    assert.equal(switchNotice.actor, 'FeatureOwner');
    assert.equal(switchNotice.previousFileName, 'COS电影.mp4');
    assert.equal(switchNotice.nextFileName, 'COS电影续集.mp4');
    assert.ok(Date.parse(switchNotice.operatedAt));
    assert.ok(switchNotice.operationId);
    assert.equal(switchNotice.canUndo, true);
    const undoneSwitch = await ack(manager, 'rollback-operation', { operationId: switchNotice.operationId });
    assert.equal(undoneSwitch.success, true, undoneSwitch.error);
    const refreshedPlayback = await ack(owner, 'room-refresh');
    assert.equal(refreshedPlayback.room.playback.fileId, remote.file.id);
    const cleared = await ack(owner, 'clear-playback');
    assert.equal(cleared.success, true, cleared.error);
    assert.equal(cleared.playback.fileId, null);
    const switchedToBatchRoom = await ack(manager, 'room-switch', { roomId: convertedRoomId, roomPassword: '' });
    assert.equal(switchedToBatchRoom.success, true, switchedToBatchRoom.error);
    const stopNotice = once(manager, 'system-notification');
    const batchStopped = await ack(owner, 'admin-action', { action: 'batch-room-action', adminPassword: 'ClientAdmin888', operation: 'stop', roomIds: [convertedRoomId] });
    assert.equal(batchStopped.success, true, batchStopped.error);
    assert.deepEqual(batchStopped.affected, [convertedRoomId]);
    assert.equal((await stopNotice).kind, 'batch-room-stop');
    const batchRenamed = await ack(owner, 'admin-action', {
      action: 'batch-room-action', adminPassword: 'ClientAdmin888', operation: 'rename', roomIds: [convertedRoomId], names: { [convertedRoomId]: '批量改名房间' }
    });
    assert.equal(batchRenamed.success, true, batchRenamed.error);
    const batchRoomId = 'BATCHROOM';
    const batchIdRenamed = await ack(owner, 'admin-action', {
      action: 'batch-room-action', adminPassword: 'ClientAdmin888', operation: 'rename-id', roomIds: [convertedRoomId], roomIdsMap: { [convertedRoomId]: batchRoomId }
    });
    assert.equal(batchIdRenamed.success, true, batchIdRenamed.error);
    assert.equal(batchIdRenamed.renamed[0].newRoomId, batchRoomId);
    const conflictRename = await ack(owner, 'admin-action', {
      action: 'batch-room-action', adminPassword: 'ClientAdmin888', operation: 'rename-id', roomIds: [batchRoomId], roomIdsMap: { [batchRoomId]: 'OWNERROOM' }
    });
    assert.equal(conflictRename.success, false);
    assert.match(conflictRename.error, /已存在|冲突/);
    const batchBanned = await ack(owner, 'admin-action', {
      action: 'batch-room-action', adminPassword: 'ClientAdmin888', operation: 'ban', roomIds: [batchRoomId], reason: '批量封禁测试'
    });
    assert.equal(batchBanned.success, true, batchBanned.error);
    assert.deepEqual(batchBanned.affected, [batchRoomId]);
    console.log('✓ 房间管理员免密进入、COS/OSS 直链入库和清空画面闭环正常');

    const customAdmin = await ack(owner, 'admin-action', { action: 'change-admin-password', adminPassword: 'ClientAdmin888', newAdminPassword: 'CustomAdmin888' });
    assert.equal(customAdmin.success, true, customAdmin.error);
    themeAdmin.close(); adminVerifier.close(); temporaryAdmin.close(); randomTemporaryAdmin.close();
    themeAdmin = null; adminVerifier = null; temporaryAdmin = null; randomTemporaryAdmin = null;
    owner.close(); manager.close(); expiring.close(); owner = null; manager = null; expiring = null;
    await server.close(); server = null;
    const configPath = path.join(dataDir, 'config.json');
    const expiredConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expiredConfig.admin.passwordPolicy.expiryDays = 1;
    expiredConfig.accounts.ExpiringUser.passwordChangedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(configPath, `${JSON.stringify(expiredConfig, null, 2)}\n`, 'utf8');
    fs.rmSync(path.join(dataDir, 'secrets'), { recursive: true, force: true });

    server = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir, publicDir, hostControlToken: 'new-feature-host', ffprobePath: '', ffmpegPath: '' });
    const resetBaseUrl = `http://127.0.0.1:${server.port}`;
    expiring = await connect(resetBaseUrl);
    const expiredLogin = await ack(expiring, 'user-login', { username: 'ExpiringUser', password: '123456', roomId: 'OWNERROOM', roomPassword: 'changed-room-pass' });
    assert.equal(expiredLogin.success, true, expiredLogin.error);
    assert.equal(expiredLogin.capabilities.mustChangeAccountPassword, false, '非内置 admin 账号不得因密码期限被强制重置');
    expiring.close(); expiring = null;
    owner = await connect(resetBaseUrl);
    const resetDefaultPassword = await ack(owner, 'host-admin-login', { adminPassword: 'admin888', hostToken: 'new-feature-host' });
    assert.equal(resetDefaultPassword.success, true, resetDefaultPassword.error);
    assert.equal(resetDefaultPassword.capabilities.mustChangeAdminPassword, true);
    const resetAccountLogin = await ack(owner, 'user-login', { username: 'admin', password: 'admin888', roomId: 'OWNERROOM', hostToken: 'new-feature-host' });
    assert.equal(resetAccountLogin.success, true, resetAccountLogin.error);
    assert.equal(resetAccountLogin.capabilities.mustChangeAccountPassword, true);
    const resetResponse = await fetch(`${resetBaseUrl}/api/host/reset-admin-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-syncwatch-host-token': 'new-feature-host' }, body: JSON.stringify({ newPassword: 'ResetAdmin888' })
    });
    const reset = await resetResponse.json();
    assert.equal(reset.success, true, reset.error);
    assert.equal(fs.existsSync(path.join(dataDir, 'secrets', 'admin-password.json')), true);
    owner.close();
    owner = await connect(resetBaseUrl);
    assert.equal((await ack(owner, 'host-admin-login', { adminPassword: 'ResetAdmin888', hostToken: 'new-feature-host' })).success, true);
    console.log('✓ 删除 secrets 文件夹会清除超级管理员密码，本机重置后独立密码文件会重新创建');
  } finally {
    owner?.close(); manager?.close(); expiring?.close(); themeAdmin?.close(); adminVerifier?.close(); temporaryAdmin?.close(); randomTemporaryAdmin?.close();
    await server?.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error('\n新增功能回归失败:', error); process.exitCode = 1; });
