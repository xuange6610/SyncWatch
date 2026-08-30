'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const { io: createSocketClient } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');
const releaseVersion = String(require('../package.json').version);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `syncwatch-electron-v${releaseVersion}-`));
const androidApkPath = path.join(__dirname, '..', 'dist', `SyncWatch-Android-v${releaseVersion}-universal.apk`);
const expectedAndroidDownloadAvailable = fs.existsSync(androidApkPath);
app.setPath('userData', path.join(dataDir, 'electron-profile'));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
let controller;
let window;
const errors = [];
const requestedUrls = [];
const sentMails = [];

async function waitFor(expression, description, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await window.webContents.executeJavaScript(expression, true);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待“${description}”超时`);
}

async function setContentViewport(width, height) {
  if (window.isFullScreen()) window.setFullScreen(false);
  if (window.isMaximized()) window.unmaximize();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    window.setContentSize(width, height, false);
    const viewport = await window.webContents.executeJavaScript(`({ width: innerWidth, height: innerHeight })`, true);
    if (Math.abs(viewport.width - width) <= 2 && Math.abs(viewport.height - height) <= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`无法把 Electron 内容视口调整为 ${width}x${height}`);
}

function connectSocketClient(baseUrl) {
  return new Promise((resolve, reject) => {
    const socket = createSocketClient(baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { Origin: baseUrl } });
    const timer = setTimeout(() => { socket.close(); reject(new Error('测试 Socket.IO 连接超时')); }, 12000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (error) => { clearTimeout(timer); socket.close(); reject(error); });
  });
}

function socketAck(socket, eventName, payload, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${eventName} 响应超时`)), timeout);
    socket.emit(eventName, payload, (result) => { clearTimeout(timer); resolve(result || { success: false, error: '服务器未返回结果' }); });
  });
}

async function run() {
  controller = await startSyncWatchServer({
    host: '0.0.0.0', port: 0, dataDir, publicDir: path.resolve(__dirname, '..', 'public'), ffprobePath: '', ffmpegPath: '', androidApkPath, hostControlToken: 'renderer-host',
    mailSender: async (message) => { sentMails.push(message); return { messageId: `electron-mail-${sentMails.length}` }; }
  });
  const baseUrl = controller.addresses[0];
  assert.ok(baseUrl, '测试机器需要一个可用的局域网 IPv4 地址');
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => { requestedUrls.push(details.url); callback({}); });
  window = new BrowserWindow({ width: 1320, height: 840, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.on('console-message', (event, level, message) => { if (level >= 2 && !/DevTools|Autofill|媒体分析失败|Electron Security Warning \(Insecure Resources\)|An iframe which has both allow-scripts and allow-same-origin/i.test(message)) errors.push(message); });
  window.webContents.on('render-process-gone', (event, details) => errors.push(`渲染进程退出：${details.reason}`));
  await window.loadURL(`${baseUrl}#host=renderer-host`);
  await waitFor(`document.getElementById('connectionBadge').classList.contains('online')`, 'initial host connection');
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    hash: location.hash,
    cached: sessionStorage.getItem('syncwatchHostToken'),
    active: state.hostToken
  })`, true), { hash: '', cached: 'renderer-host', active: 'renderer-host' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('page reload timed out')), 12000);
    window.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    window.webContents.reload();
  });
  await waitFor(`document.getElementById('connectionBadge').classList.contains('online')`, 'host connection after reload');
  await window.webContents.executeJavaScript(`
    window.prompt = () => { throw new Error('Electron 功能不得依赖原生 prompt'); };
    window.confirm = () => { throw new Error('Electron 功能不得依赖原生 confirm'); };
    true;
  `, true);
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    hash: location.hash,
    cached: sessionStorage.getItem('syncwatchHostToken'),
    active: state.hostToken
  })`, true), { hash: '', cached: 'renderer-host', active: 'renderer-host' });
  await waitFor(`document.getElementById('connectionBadge').classList.contains('online')`, '页面连接服务器');
  const insecureLanContext = await window.webContents.executeJavaScript(`({ secure: isSecureContext, randomUUID: typeof crypto.randomUUID })`);
  assert.deepEqual(insecureLanContext, { secure: false, randomUUID: 'undefined' });
  console.log('✓ 局域网 HTTP 非安全上下文在缺少 crypto.randomUUID 时仍能连接 Socket.IO');

  const loginSurface = await window.webContents.executeJavaScript(`(() => {
    const title = document.getElementById('authTitle');
    const statusWrap = document.getElementById('loginStatusWrap');
    const topbarIds = [...document.querySelectorAll('.topbar-scroll-actions > button, .topbar-fixed-actions > button, .topbar-fixed-actions > span')].map((item) => item.id);
    setLoginStatus('登录测试错误');
    const visible = !statusWrap.classList.contains('is-hidden') && statusWrap.textContent.includes('登录测试错误');
    const nearJoinTitle = title.compareDocumentPosition(statusWrap) & Node.DOCUMENT_POSITION_FOLLOWING;
    document.getElementById('closeLoginStatusBtn').click();
    const closed = statusWrap.classList.contains('is-hidden') && !document.getElementById('loginStatus').textContent;
    const onlineRoomStyle = getComputedStyle(document.getElementById('onlineRoomSelect'));
    const loginEntryStyle = getComputedStyle(document.querySelector('.login-entry-actions'));
    const authCard = document.querySelector('.auth-card');
    return {
      visible, nearJoinTitle: Boolean(nearJoinTitle), closed,
      serverDownloadVisible: !document.getElementById('downloadClientBtn').classList.contains('is-hidden'),
      androidDownloadVisible: !document.getElementById('downloadLoginApkBtn').classList.contains('is-hidden'),
      serverDownloadLabel: document.getElementById('downloadClientBtn').textContent.trim(),
      topbarContextOrder: [
        'masterMuteBtn', 'quickDissolveRoomBtn', 'newRoomBtn', 'switchRoomBtn', 'lanScanBtn',
        'conversionProgressBtn', 'webShareBtn', 'noticeCenterBtn', 'themeBtn', 'adminContactBtn', 'copyrightBtn', 'serverSettingsLoginBtn'
      ].map((id) => topbarIds.indexOf(id)),
      androidDownloadInAccountMenu: document.getElementById('accountDropdown')?.contains(document.getElementById('androidApkBtn'))
        && document.getElementById('downloadClientMainBtn')?.nextElementSibling === document.getElementById('androidApkBtn'),
      compactLoginEntries: loginEntryStyle.gridTemplateColumns.split(' ').length === 2,
      authCardFitsWidth: authCard.scrollWidth <= authCard.clientWidth + 1,
      selectAppearance: onlineRoomStyle.appearance,
      selectHasChevron: onlineRoomStyle.backgroundImage !== 'none',
      selectRightPadding: parseFloat(onlineRoomStyle.paddingRight)
    };
  })()`, true);
  assert.deepEqual({
    visible: loginSurface.visible, nearJoinTitle: loginSurface.nearJoinTitle, closed: loginSurface.closed,
    serverDownloadVisible: loginSurface.serverDownloadVisible, androidDownloadVisible: loginSurface.androidDownloadVisible,
    serverDownloadLabel: loginSurface.serverDownloadLabel
  }, {
    visible: true, nearJoinTitle: true, closed: true,
    serverDownloadVisible: true, androidDownloadVisible: true,
    serverDownloadLabel: '下载 Windows 客户端'
  });
  assert.deepEqual(loginSurface.topbarContextOrder, [...loginSurface.topbarContextOrder].sort((a, b) => a - b));
  assert.equal(loginSurface.androidDownloadInAccountMenu, true);
  assert.equal(loginSurface.compactLoginEntries, true);
  assert.equal(loginSurface.authCardFitsWidth, true);
  assert.equal(loginSurface.selectAppearance, 'none');
  assert.equal(loginSurface.selectHasChevron, true);
  assert.ok(loginSurface.selectRightPadding >= 36);
  console.log('✓ 登录提示可关闭且位于加入标题区，下载入口、顶部操作组和下拉框样式完整');

  const loginPasswordGuidance = await window.webContents.executeJavaScript(`(async () => {
    const previousFetch = fetchWithTimeout;
    const previousRoomId = elements.roomIdInput.value;
    const previousRoomPassword = elements.loginRoomPassword.value;
    fetchWithTimeout = async () => ({ ok: true, json: async () => ({ success: true, room: { id: 'LOCK88', name: '密码房间', online: 1, maxUsers: 8, passwordRequired: true } }) });
    elements.roomIdInput.value = 'LOCK88';
    elements.loginRoomPassword.value = '';
    await loadRoomInfo();
    const required = { text: elements.loginRoomPasswordState.textContent, className: elements.loginRoomPasswordState.className };
    const blocked = await promptForMissingLoginRoomPassword('LOCK88');
    const emptyPrompt = elements.loginStatus.textContent;
    const focused = document.activeElement === elements.loginRoomPassword;
    elements.loginRoomPassword.value = 'secret';
    const accepted = !(await promptForMissingLoginRoomPassword('LOCK88'));
    const highlights = ['username', 'password', 'roomIdInput'].map((id) => {
      const input = document.getElementById(id);
      const target = id === 'password' ? input.closest('.password-field') : input;
      const style = getComputedStyle(target);
      return { id, animation: style.animationName, shadow: style.boxShadow };
    });
    fetchWithTimeout = previousFetch;
    elements.roomIdInput.value = previousRoomId;
    elements.loginRoomPassword.value = previousRoomPassword;
    void loadRoomInfo();
    return { required, blocked, emptyPrompt, focused, accepted, highlights };
  })()`, true);
  assert.equal(loginPasswordGuidance.required.text, '有密码', JSON.stringify(loginPasswordGuidance));
  assert.match(loginPasswordGuidance.required.className, /required/);
  assert.equal(loginPasswordGuidance.blocked, true);
  assert.equal(loginPasswordGuidance.emptyPrompt, '请输入房间密码');
  assert.equal(loginPasswordGuidance.focused, true);
  assert.equal(loginPasswordGuidance.accepted, true);
  assert.ok(loginPasswordGuidance.highlights.every((item) => item.animation.includes('login-field-attention') || item.shadow !== 'none'), JSON.stringify(loginPasswordGuidance));

  const onlineRoomRequestsBeforeRefresh = requestedUrls.filter((url) => /\/api\/online-rooms(?:\?|$)/.test(url)).length;
  await window.webContents.executeJavaScript(`document.getElementById('refreshOnlineRoomsBtn').click(); true`, true);
  await waitFor(`!document.getElementById('refreshOnlineRoomsBtn').disabled && document.getElementById('toastRegion').textContent.includes('在线房间已刷新')`, '手动刷新在线房间');
  const onlineRoomRequestsAfterRefresh = requestedUrls.filter((url) => /\/api\/online-rooms(?:\?|$)/.test(url)).length;
  assert.ok(onlineRoomRequestsAfterRefresh > onlineRoomRequestsBeforeRefresh, '刷新按钮没有重新请求在线房间接口');
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('onlineRoomSelect').options.length >= 1`, true), true);
  console.log('✓ 登录页可以手动刷新在线房间并更新选择器');

  const publicAddressCopy = await window.webContents.executeJavaScript(`(async () => {
    const previousRoom = state.room;
    const previousTunnelStatus = state.tunnelLastStatus;
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { copied = value; } } });
    state.room = { ...(state.room || {}), id: 'PUBLIC88' };
    state.tunnelLastStatus = { state: 'running', publicUrl: 'https://example.trycloudflare.com/', verified: true };
    await copyTunnelUrl();
    state.room = previousRoom;
    state.tunnelLastStatus = previousTunnelStatus;
    return copied;
  })()`, true);
  assert.equal(publicAddressCopy, 'https://example.trycloudflare.com/?room=PUBLIC88');
  console.log('✓ 复制公网地址会自动携带当前房间号且不会依赖输入框内容');

  const closableNotices = await window.webContents.executeJavaScript(`(() => {
    elements.toastRegion.replaceChildren();
    toast('普通错误提示', 'error', 0);
    toast('普通错误提示', 'error', 0);
    const ordinaryItems = [...elements.toastRegion.querySelectorAll('.toast')];
    const ordinaryClose = ordinaryItems[0]?.querySelector('.toast-close');
    ordinaryClose?.click();

    toastWithAction('位置授权失败', '重新授权', () => {}, 0);
    toastWithAction('位置授权失败', '重新授权', () => {}, 0);
    const actionItems = [...elements.toastRegion.querySelectorAll('.toast')];
    const actionClose = actionItems[0]?.querySelector('.toast-close');
    actionClose?.click();

    setReconnectState(true);
    document.getElementById('closeReconnectOverlayBtn').click();
    showRoomSwitchSuccess('房间 A', '房间 B');
    document.getElementById('closeRoomSwitchSuccessBtn').click();
    return {
      ordinaryCount: ordinaryItems.length,
      ordinaryClosed: !ordinaryItems[0]?.isConnected,
      actionCount: actionItems.length,
      actionClosed: !actionItems[0]?.isConnected,
      reconnectClosed: elements.reconnectOverlay.classList.contains('is-hidden'),
      roomSwitchClosed: elements.roomSwitchSuccessOverlay.classList.contains('is-hidden')
    };
  })()`, true);
  assert.deepEqual(closableNotices, {
    ordinaryCount: 1,
    ordinaryClosed: true,
    actionCount: 1,
    actionClosed: true,
    reconnectClosed: true,
    roomSwitchClosed: true
  });
  console.log('✓ 普通报错、操作通知、断线遮罩和房间切换提示均可手动关闭，重复通知不会堆叠');

  await window.webContents.executeJavaScript(`
    document.getElementById('showRegisterBtn').click();
  `, true);
  assert.match(await window.webContents.executeJavaScript(`document.getElementById('authHint').textContent`), /注册账号不需要房间密码/);
  await window.webContents.executeJavaScript(`
    document.getElementById('regUsername').value = '界面测试';
    document.getElementById('regEmail').value = '';
    document.getElementById('regPassword').value = '123456';
    document.getElementById('regPasswordConfirm').value = '123456';
    document.getElementById('registerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  `, true);
  await waitFor(`document.getElementById('loginStatus').textContent.includes('注册成功')`, '注册成功');
  await window.webContents.executeJavaScript(`
    document.getElementById('username').value = '界面测试';
    document.getElementById('password').value = '123456';
    document.getElementById('createRoomBtn').click();
    document.getElementById('newRoomName').value = '界面测试房间';
    document.getElementById('newRoomId').value = 'UITEST2';
    document.getElementById('newRoomMaxUsers').value = '8';
    document.getElementById('createRoomForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  `, true);
  await waitFor(`
    !document.getElementById('agreementModal').classList.contains('is-hidden') ||
    !document.getElementById('mainPage').classList.contains('is-hidden')
  `, '首次协议或登录成功');
  if (!await window.webContents.executeJavaScript(`document.getElementById('agreementModal').classList.contains('is-hidden')`, true)) {
    await window.webContents.executeJavaScript(`
      document.getElementById('agreementCheck').click();
      document.getElementById('acceptAgreementBtn').click();
    `, true);
  }
  await waitFor(`!document.getElementById('mainPage').classList.contains('is-hidden')`, '登录成功');
  if (await window.webContents.executeJavaScript(`Boolean(state.capabilities.mustChangeAdminPassword)`, true)) {
    await waitFor(`typeof activeAppDialog !== 'undefined' && activeAppDialog?.mode === 'confirm'`, '首次管理员密码修改提醒');
    await window.webContents.executeJavaScript(`settleAppDialog(false)`, true);
    await waitFor(`document.getElementById('appDialog').classList.contains('is-hidden')`, '关闭首次管理员密码修改提醒');
  }
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('userCount').textContent`), '1');
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    serverHost: state.capabilities.serverHost,
    owner: state.capabilities.owner,
    username: state.user.username,
    ownerUsername: state.room.ownerUsername
  })`, true), {
    serverHost: true, owner: true,
    username: '界面测试', ownerUsername: '界面测试'
  });
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('ownerControls').classList.contains('is-hidden')`), false);
  console.log('✓ 真实注册登录、单账号 UI 与房主控制区正常');

  const desktopChatCollapse = await window.webContents.executeJavaScript(`(() => {
    state.mobileChatCollapsed = true; applyMobileChatCollapsed();
    const collapsed = getComputedStyle(document.getElementById('chatHistory')).display === 'none';
    state.mobileChatCollapsed = false; applyMobileChatCollapsed();
    const expanded = getComputedStyle(document.getElementById('chatHistory')).display !== 'none';
    return { collapsed, expanded };
  })()`, true);
  assert.deepEqual(desktopChatCollapse, { collapsed: true, expanded: true }, '进入房间后，桌面端聊天也应支持默认收起与手动展开');

  const featureControls = await window.webContents.executeJavaScript(`(() => ({
    fileMultiple: document.getElementById('fileInput').multiple,
    folderMultiple: document.getElementById('folderInput').multiple,
    folderPicker: document.getElementById('folderInput').hasAttribute('webkitdirectory'),
    shareAddress: preferredShareAddress(), roomId: state.room.id,
    apkVisible: !document.getElementById('androidApkBtn').classList.contains('is-hidden'),
    managementVisible: !document.getElementById('managementHubBtn').classList.contains('is-hidden'),
    directHistoryHidden: document.getElementById('operationHistoryBtn').classList.contains('is-hidden'),
    directChatManagerHidden: document.getElementById('chatManageBtn').classList.contains('is-hidden'),
    managementHistoryExists: Boolean(document.getElementById('managementOperationHistoryBtn')),
    managementChatExists: Boolean(document.getElementById('managementChatManageBtn')),
    chatMode: state.chatMode,
    desktopDanmakuActive: document.querySelector('[data-chat-mode="danmaku"]').classList.contains('active'),
    fullscreenChatMode: document.getElementById('fullscreenChatMode').value
  }))()`);
  assert.equal(featureControls.fileMultiple, true);
  assert.equal(featureControls.folderMultiple, true);
  assert.equal(featureControls.folderPicker, true);
  assert.equal(new URL(featureControls.shareAddress).searchParams.get('room'), featureControls.roomId);
  assert.deepEqual({
    apkVisible: featureControls.apkVisible, managementVisible: featureControls.managementVisible,
    directHistoryHidden: featureControls.directHistoryHidden, directChatManagerHidden: featureControls.directChatManagerHidden,
    managementHistoryExists: featureControls.managementHistoryExists, managementChatExists: featureControls.managementChatExists
  }, {
    apkVisible: expectedAndroidDownloadAvailable, managementVisible: true, directHistoryHidden: true, directChatManagerHidden: true,
    managementHistoryExists: true, managementChatExists: true
  });
  assert.deepEqual({ chatMode: featureControls.chatMode, desktopDanmakuActive: featureControls.desktopDanmakuActive, fullscreenChatMode: featureControls.fullscreenChatMode }, {
    chatMode: 'danmaku', desktopDanmakuActive: true, fullscreenChatMode: 'danmaku'
  });

  const electronUploadPolicy = await window.webContents.executeJavaScript(`emitAck('admin-action', {
    action: 'set-upload-policy', adminPassword: 'admin888',
    allowedUploadCategories: ['video', 'audio', 'subtitle', 'image', 'pdf', 'text', 'document']
  })`, true);
  assert.equal(electronUploadPolicy.success, true, electronUploadPolicy.error);
  const dialogFileId = await window.webContents.executeJavaScript(`(async () => {
    const originalChooseUploadCollection = chooseUploadCollection;
    chooseUploadCollection = async () => 'Electron 界面测试';
    try {
      await startUploadBatch([new File(['electron app dialog'], 'electron-dialog-original.txt', { type: 'text/plain' })]);
    } finally {
      chooseUploadCollection = originalChooseUploadCollection;
    }
    const file = [...state.files.values()].find((entry) => entry.originalName === 'electron-dialog-original.txt');
    return file?.id || '';
  })()`, true);
  assert.ok(dialogFileId, '应用内重命名对话框测试文件应上传成功');
  await window.webContents.executeJavaScript(`document.querySelector('[data-file-id="${dialogFileId}"] [data-file-action="rename"]').click()`, true);
  await waitFor(`!document.getElementById('appDialog').classList.contains('is-hidden') && document.getElementById('appDialogTitle').textContent === '重命名文件' && document.activeElement === document.getElementById('appDialogInput')`, '打开文件重命名应用内对话框');
  await window.webContents.executeJavaScript(`document.getElementById('appDialogInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`, true);
  await waitFor(`document.getElementById('appDialog').classList.contains('is-hidden')`, 'Escape 取消应用内输入对话框');
  assert.equal(await window.webContents.executeJavaScript(`state.files.get('${dialogFileId}')?.originalName`), 'electron-dialog-original.txt');
  await window.webContents.executeJavaScript(`document.querySelector('[data-file-id="${dialogFileId}"] [data-file-action="rename"]').click()`, true);
  await waitFor(`!document.getElementById('appDialog').classList.contains('is-hidden')`, '再次打开文件重命名应用内对话框');
  await window.webContents.executeJavaScript(`document.getElementById('appDialogInput').value = '应用内对话框重命名.txt'; document.getElementById('appDialogConfirmBtn').click()`, true);
  await waitFor(`state.files.get('${dialogFileId}')?.originalName === '应用内对话框重命名.txt' && document.querySelector('[data-file-id="${dialogFileId}"]').textContent.includes('应用内对话框重命名.txt')`, '文件应用内对话框重命名生效');
  await window.webContents.executeJavaScript(`document.querySelector('[data-file-id="${dialogFileId}"] [data-file-action="delete"]').click()`, true);
  await waitFor(`!document.getElementById('appDialog').classList.contains('is-hidden') && document.getElementById('appDialogTitle').textContent === '删除文件'`, '打开应用内确认对话框');
  await window.webContents.executeJavaScript(`document.getElementById('appDialogCancelBtn').click()`, true);
  await waitFor(`document.getElementById('appDialog').classList.contains('is-hidden')`, '取消应用内确认对话框');
  assert.equal(await window.webContents.executeJavaScript(`state.files.has('${dialogFileId}')`), true);
  console.log('✓ 文件重命名、取消/Escape 与危险操作确认均使用应用内对话框');

  const nestedDialogLayers = await window.webContents.executeJavaScript(`(async () => {
    elements.memberProfileModal.classList.remove('is-hidden');
    bringMemberProfileToFront();
    const profileLayer = Number.parseInt(getComputedStyle(elements.memberProfileModal).zIndex, 10);
    const pending = showAppInput({ title: '设置备注', initialValue: '测试备注' });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    bringMemberProfileToFront();
    const dialogLayer = Number.parseInt(getComputedStyle(elements.appDialog).zIndex, 10);
    settleAppDialog(null);
    await pending;
    elements.memberProfileModal.classList.add('is-hidden');
    elements.memberProfileModal.style.zIndex = '';
    return { profileLayer, dialogLayer };
  })()`, true);
  assert.ok(nestedDialogLayers.dialogLayer > nestedDialogLayers.profileLayer,
    `资料备注对话框必须位于资料卡上方：${JSON.stringify(nestedDialogLayers)}`);
  console.log('✓ 成员资料异步刷新不会遮挡备注输入对话框');

  const roomFileBoundary = await window.webContents.executeJavaScript(`(() => {
    const saved = {
      room: state.room, user: state.user, files: state.files, queue: state.queue,
      currentFile: state.currentFile, pendingPlayback: state.pendingPlayback
    };
    const currentRoomId = state.user.roomId;
    const foreignRoomId = currentRoomId === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ';
    const localFile = {
      id: 'room-guard-local', roomId: currentRoomId, originalName: '当前房间.mp4', storedName: 'local.mp4',
      size: 10, mimeType: 'video/mp4', category: 'video', uploadedAt: new Date().toISOString(), uploadedBy: state.user.username,
      uploadedByName: state.user.displayName, relativePath: '', status: 'approved', metadata: {}, url: '/media/local.mp4', downloadUrl: '/api/files/local/download'
    };
    const foreignFile = { ...localFile, id: 'room-guard-foreign', roomId: foreignRoomId, originalName: '其他房间.mp4', storedName: 'foreign.mp4' };
    state.currentFile = foreignFile;
    applyFiles([localFile, foreignFile]);
    const applyFiltered = state.files.has(localFile.id) && !state.files.has(foreignFile.id) && state.currentFile === null;
    upsertFile(foreignFile);
    const eventIgnored = !state.files.has(foreignFile.id);
    applyRoom({ ...state.room, id: foreignRoomId, name: '错误房间事件' });
    const staleRoomIgnored = state.room.id === currentRoomId;
    state.room = saved.room; state.user = saved.user; state.files = saved.files; state.queue = saved.queue;
    state.currentFile = saved.currentFile; state.pendingPlayback = saved.pendingPlayback;
    renderFiles(); renderQueue(); updateControlAccess();
    return { applyFiltered, eventIgnored, staleRoomIgnored };
  })()`, true);
  assert.deepEqual(roomFileBoundary, { applyFiltered: true, eventIgnored: true, staleRoomIgnored: true });
  const roomScopedPlaybackReset = await window.webContents.executeJavaScript(`(() => {
    const saved = {
      users: state.users, messages: state.messages, chatHasMore: state.chatHasMore,
      chatBeforeId: state.chatBeforeId, chatBefore: state.chatBefore,
      chatManageAccounts: state.chatManageAccounts, chatManageMessages: state.chatManageMessages,
      chatManageHasMore: state.chatManageHasMore, chatManageLoading: state.chatManageLoading,
      chatManageBeforeId: state.chatManageBeforeId, chatManageBefore: state.chatManageBefore,
      chatManageGeneration: state.chatManageGeneration, files: state.files, queue: state.queue,
      currentFile: state.currentFile, playbackRevision: state.playbackRevision,
      playbackAnchor: state.playbackAnchor, pendingPlayback: state.pendingPlayback
    };
    state.users = [{ username: 'old-room-member' }];
    state.playbackRevision = 73;
    state.playbackAnchor = { fileId: 'old-room-file', revision: 73 };
    state.pendingPlayback = { playback: { fileId: 'old-room-file', revision: 73 } };
    state.files = new Map([['old-room-file', { id: 'old-room-file' }]]);
    state.queue = ['old-room-file'];
    resetRoomScopedClientState();
    const result = {
      users: state.users.length, revision: state.playbackRevision,
      anchor: state.playbackAnchor, pending: state.pendingPlayback,
      files: state.files.size, queue: state.queue.length, currentFile: state.currentFile
    };
    state.users = saved.users; state.messages = saved.messages; state.chatHasMore = saved.chatHasMore;
    state.chatBeforeId = saved.chatBeforeId; state.chatBefore = saved.chatBefore;
    state.chatManageAccounts = saved.chatManageAccounts; state.chatManageMessages = saved.chatManageMessages;
    state.chatManageHasMore = saved.chatManageHasMore; state.chatManageLoading = saved.chatManageLoading;
    state.chatManageBeforeId = saved.chatManageBeforeId; state.chatManageBefore = saved.chatManageBefore;
    state.chatManageGeneration = saved.chatManageGeneration; state.files = saved.files; state.queue = saved.queue;
    state.currentFile = saved.currentFile; state.playbackRevision = saved.playbackRevision;
    state.playbackAnchor = saved.playbackAnchor; state.pendingPlayback = saved.pendingPlayback;
    renderUsers(); renderChat(); renderFiles(); renderQueue(); updateControlAccess();
    return result;
  })()`, true);
  assert.deepEqual(roomScopedPlaybackReset, {
    users: 0, revision: -1, anchor: null, pending: null, files: 0, queue: 0, currentFile: null
  });
  console.log('✓ 客户端会过滤跨房间文件事件，并在房间切换时清除不属于当前房间的 currentFile');

  const uploadCancellation = await window.webContents.executeJavaScript(`(async () => {
    const OriginalXhr = window.XMLHttpRequest;
    const originalChooseUploadCollection = chooseUploadCollection;
    let relativePath = '';
    class PendingXhr {
      constructor() { this.upload = {}; this.status = 0; this.responseText = ''; }
      open() {}
      setRequestHeader() {}
      send(form) { relativePath = form.get('relativePath'); queueMicrotask(() => this.upload.onprogress?.({ loaded: 2 })); }
      abort() { this.onabort?.(); }
    }
    window.XMLHttpRequest = PendingXhr;
    chooseUploadCollection = async () => '家庭影院';
    const file = new File(['folder-upload'], 'movie.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'webkitRelativePath', { configurable: true, value: '家庭影院/电影/movie.txt' });
    const running = startUploadBatch([file]);
    await new Promise((resolve) => setTimeout(resolve));
    cancelUpload(true);
    await running;
    window.XMLHttpRequest = OriginalXhr;
    chooseUploadCollection = originalChooseUploadCollection;
    return {
      relativePath,
      reset: state.uploadBatch === null && document.getElementById('uploadProgress').classList.contains('is-hidden')
        && !document.getElementById('chooseFileBtn').disabled && !document.getElementById('chooseFolderBtn').disabled
    };
  })()`, true);
  assert.deepEqual(uploadCancellation, { relativePath: '家庭影院/电影/movie.txt', reset: true });

  const androidFolderAndApkBridge = await window.webContents.executeJavaScript(`(async () => {
    const bridgeDescriptor = Object.getOwnPropertyDescriptor(window, 'SyncWatchAndroid');
    const filesDescriptor = Object.getOwnPropertyDescriptor(elements.folderInput, 'files');
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    const OriginalXhr = window.XMLHttpRequest;
    const originalChooseUploadCollection = chooseUploadCollection;
    let chooseCalls = 0; let folderClicks = 0; let relativePath = ''; let apkHref = '';
    const preventFolderChooser = (event) => { folderClicks += 1; event.preventDefault(); };
    elements.folderInput.addEventListener('click', preventFolderChooser);
    Object.defineProperty(window, 'SyncWatchAndroid', { configurable: true, value: {
      chooseFolder() { chooseCalls += 1; return true; }
    } });
    HTMLAnchorElement.prototype.click = function click() { apkHref = this.href; };
    class PendingXhr {
      constructor() { this.upload = {}; this.status = 0; this.responseText = ''; }
      open() {}
      setRequestHeader() {}
      send(form) { relativePath = form.get('relativePath'); }
      abort() { this.onabort?.(); }
    }
    window.XMLHttpRequest = PendingXhr;
    chooseUploadCollection = async () => '手机目录';
    window.__syncWatchNativeFolderPaths = ['旧目录/旧文件.txt'];
    await chooseUploadFolder();
    const stalePathsCleared = window.__syncWatchNativeFolderPaths.length === 0;
    const file = new File(['android-folder'], 'movie.txt', { type: 'text/plain' });
    Object.defineProperty(elements.folderInput, 'files', { configurable: true, value: [file] });
    window.__syncWatchNativeFolderPaths = ['手机目录/电影/movie.txt'];
    uploadFolder(); await new Promise((resolve) => setTimeout(resolve)); cancelUpload(true);
    while (state.uploadBatch) await new Promise((resolve) => setTimeout(resolve));
    const pathsConsumed = Array.isArray(window.__syncWatchNativeFolderPaths) && window.__syncWatchNativeFolderPaths.length === 0;
    await downloadAndroidApk();
    window.XMLHttpRequest = OriginalXhr; chooseUploadCollection = originalChooseUploadCollection; HTMLAnchorElement.prototype.click = originalAnchorClick;
    elements.folderInput.removeEventListener('click', preventFolderChooser);
    if (filesDescriptor) Object.defineProperty(elements.folderInput, 'files', filesDescriptor); else delete elements.folderInput.files;
    if (bridgeDescriptor) Object.defineProperty(window, 'SyncWatchAndroid', bridgeDescriptor); else delete window.SyncWatchAndroid;
    return { chooseCalls, folderClicks, stalePathsCleared, relativePath, pathsConsumed, apkHref };
  })()`, true);
  assert.equal(androidFolderAndApkBridge.chooseCalls, 1);
  assert.equal(androidFolderAndApkBridge.folderClicks, 1);
  assert.equal(androidFolderAndApkBridge.stalePathsCleared, true);
  assert.equal(androidFolderAndApkBridge.relativePath, '手机目录/电影/movie.txt');
  assert.equal(androidFolderAndApkBridge.pathsConsumed, true);
  if (expectedAndroidDownloadAvailable) {
    assert.equal(new URL(androidFolderAndApkBridge.apkHref).origin, new URL(baseUrl).origin);
    assert.equal(new URL(androidFolderAndApkBridge.apkHref).pathname, '/api/android-apk');
  } else {
    assert.equal(androidFolderAndApkBridge.apkHref, '');
  }

  const operationPagination = await window.webContents.executeJavaScript(`(async () => {
    const originalEmitAck = emitAck;
    const saved = {
      operations: state.operationHistory, before: state.operationHistoryBefore,
      hasMore: state.operationHistoryHasMore, loading: state.operationHistoryLoading,
      html: elements.operationHistoryList.innerHTML
    };
    const requests = [];
    emitAck = async (eventName, payload) => {
      if (eventName !== 'operation-history') return { success: true };
      requests.push({ before: payload.before, cursor: payload.cursor, limit: payload.limit });
      if (!payload.before) return { success: true, operations: [
        { id: 'op-new', action: 'new', summary: '最新操作', actor: 'tester', scope: 'room', createdAt: '2026-08-04T03:00:00.000Z', reversible: false },
        { id: 'op-mid', action: 'mid', summary: '中间操作', actor: 'tester', scope: 'room', createdAt: '2026-08-04T02:00:00.000Z', reversible: false }
      ], hasMore: true, nextBeforeId: 'cursor-older' };
      return { success: true, operations: [
        { id: 'op-old', action: 'old', summary: '更早操作', actor: 'tester', scope: 'room', createdAt: '2026-08-04T01:00:00.000Z', reversible: false }
      ], hasMore: false, nextBefore: '' };
    };
    await loadOperationHistory(false);
    const loadMoreVisible = Boolean(elements.operationHistoryList.querySelector('[data-operation-action="load-more"]'));
    await loadOperationHistory(true);
    const result = {
      requests, ids: state.operationHistory.map((operation) => operation.id),
      loadMoreVisible, finished: !state.operationHistoryHasMore && !elements.operationHistoryList.querySelector('[data-operation-action="load-more"]')
    };
    emitAck = originalEmitAck;
    state.operationHistory = saved.operations; state.operationHistoryBefore = saved.before;
    state.operationHistoryHasMore = saved.hasMore; state.operationHistoryLoading = saved.loading;
    elements.operationHistoryList.innerHTML = saved.html;
    return result;
  })()`, true);
  assert.deepEqual(operationPagination.requests, [
    { before: '', cursor: '', limit: 200 },
    { before: 'cursor-older', cursor: 'cursor-older', limit: 200 }
  ]);
  assert.deepEqual(operationPagination.ids, ['op-new', 'op-mid', 'op-old']);
  assert.equal(operationPagination.loadMoreVisible, true);
  assert.equal(operationPagination.finished, true);

  const libraryAndFullscreen = await window.webContents.executeJavaScript(`(() => {
    state.libraryCollapsed = false; applyLibraryCollapsed(); document.getElementById('collapseFilesBtn').click();
    const collapsed = document.querySelector('.workspace').classList.contains('files-collapsed');
    document.getElementById('collapseFilesBtn').click();
    state.pseudoFullscreen = true; handleFullscreenChange();
    document.getElementById('playerInfo').classList.remove('is-hidden');
    document.getElementById('syncNotice').classList.remove('is-hidden');
    document.getElementById('resumePlaybackBtn').classList.remove('is-hidden');
    const fullscreenActions = document.querySelector('.fullscreen-actions');
    const actionsRect = fullscreenActions.getBoundingClientRect();
    const fullscreenTopSafe = actionsRect.top >= 0 && actionsRect.right <= innerWidth + 1;
    const fullscreenTextVisible = [...fullscreenActions.querySelectorAll('button')].every((button) =>
      button.scrollHeight <= button.clientHeight + 1 && button.scrollWidth <= button.clientWidth + 1
    );
    document.getElementById('fullscreenHideBtn').click();
    const hidden = {
      active: document.getElementById('playerContainer').classList.contains('fullscreen-active'),
      overlayHidden: document.getElementById('fullscreenOverlay').getAttribute('aria-hidden') === 'true',
      infoHidden: getComputedStyle(document.getElementById('playerInfo')).visibility === 'hidden',
      statusHidden: getComputedStyle(document.getElementById('syncNotice')).visibility === 'hidden',
      resumeHidden: getComputedStyle(document.getElementById('resumePlaybackBtn')).visibility === 'hidden',
      contextMenuInsidePlayer: document.getElementById('chatContextMenu').parentElement === document.getElementById('playerContainer')
    };
    document.getElementById('playerContainer').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const visible = {
      overlayVisible: document.getElementById('fullscreenOverlay').getAttribute('aria-hidden') === 'false',
      infoVisible: getComputedStyle(document.getElementById('playerInfo')).visibility === 'visible',
      statusVisible: getComputedStyle(document.getElementById('syncNotice')).visibility === 'visible',
      resumeVisible: getComputedStyle(document.getElementById('resumePlaybackBtn')).visibility === 'visible'
    };
    document.getElementById('fullscreenExitBtn').click();
    document.getElementById('playerInfo').classList.add('is-hidden');
    document.getElementById('syncNotice').classList.add('is-hidden');
    document.getElementById('resumePlaybackBtn').classList.add('is-hidden');
    return {
      collapsed, fullscreenTopSafe, fullscreenTextVisible, hidden, visible,
      exited: !document.body.classList.contains('fullscreen-open'),
      contextMenuRestored: document.getElementById('chatContextMenu').parentElement === document.body
    };
  })()`, true);
  assert.deepEqual(libraryAndFullscreen, {
    collapsed: true, fullscreenTopSafe: true, fullscreenTextVisible: true,
    hidden: { active: true, overlayHidden: true, infoHidden: true, statusHidden: true, resumeHidden: true, contextMenuInsidePlayer: true },
    visible: { overlayVisible: true, infoVisible: true, statusVisible: true, resumeVisible: true },
    exited: true,
    contextMenuRestored: true
  });

  await window.webContents.executeJavaScript(`document.getElementById('lightsBtn').click()`, true);
  await waitFor(`document.body.classList.contains('ambient-light-on') && document.getElementById('theater').classList.contains('lights-on')`, '观影灯光开启');
  await window.webContents.executeJavaScript(`document.getElementById('lightsBtn').click()`, true);
  await waitFor(`!document.body.classList.contains('ambient-light-on') && !document.getElementById('theater').classList.contains('lights-on')`, '观影灯光关闭');

  const apkResponse = await window.webContents.executeJavaScript(`fetch('/api/android-apk').then(async (response) => {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, size: bytes.length, zip: bytes[0] === 0x50 && bytes[1] === 0x4b };
  })`, true);
  if (expectedAndroidDownloadAvailable) {
    assert.equal(apkResponse.status, 200); assert.equal(apkResponse.zip, true); assert.ok(apkResponse.size > 10 * 1024);
  } else {
    assert.equal(apkResponse.status, 404); assert.equal(apkResponse.zip, false);
  }
  console.log(`✓ 文件夹上传/中止、影片栏折叠、灯光、全屏浮层、房间分享链接和 APK 下载入口状态正常（${expectedAndroidDownloadAvailable ? '已提供' : '未提供，入口隐藏'}）`);

  await window.webContents.executeJavaScript(`
    document.querySelector('[data-chat-mode="danmaku"]').click();
    document.getElementById('chatInput').value = '全屏弹幕测试';
    document.getElementById('chatForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  `, true);
  await waitFor(`[...document.querySelectorAll('.danmaku-item')].some(node => node.textContent.includes('全屏弹幕测试'))`, '弹幕显示');
  const overlayInsidePlayer = await window.webContents.executeJavaScript(`document.getElementById('danmakuContainer').parentElement.id === 'playerContainer'`);
  assert.equal(overlayInsidePlayer, true);
  console.log('✓ 弹幕位于自定义全屏容器内，不会被全屏视频遮挡');

  await window.webContents.executeJavaScript(`
    document.querySelector('[data-chat-mode="public"]').click();
    document.getElementById('chatInput').value = '持久聊天界面测试';
    document.getElementById('chatForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  `, true);
  await waitFor(`document.getElementById('chatHistory').textContent.includes('持久聊天界面测试')`, '聊天显示');
  console.log('✓ 聊天模式与历史区真实交互正常');

  const staticMediaChecks = await window.webContents.executeJavaScript(`(async () => {
    const staticFile = {
      id: 'electron-static-image', originalName: 'static-image.png', category: 'image',
      status: 'approved', size: 68, uploadedBy: state.user.username,
      url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
    };
    state.files.set(staticFile.id, staticFile);
    renderFiles();
    const card = document.querySelector('[data-file-id="electron-static-image"]');
    const hasTimedAction = Boolean(card?.querySelector('[data-file-action="play"], [data-file-action="queue"]'));
    const originalEmitAck = emitAck;
    const emitted = [];
    emitAck = async (eventName, payload) => { emitted.push({ eventName, payload }); return { success: true }; };
    try { await queueAction('add', staticFile.id); } finally { emitAck = originalEmitAck; }
    loadFile(staticFile);
    const controlsDisabled = [...document.querySelectorAll('.control-button')].every((button) => button.disabled)
      && document.getElementById('volumeSlider').disabled;
    const result = {
      hasTimedAction, emitted, controlsDisabled,
      activeTimedFileId: state.activeTimedFileId,
      videoHasSource: videoPlayer.hasAttribute('src')
    };
    state.files.delete(staticFile.id); clearStage(); renderFiles();
    return result;
  })()`, true);
  assert.equal(staticMediaChecks.hasTimedAction, false, '静态文件不应提供播放或加入队列操作');
  assert.deepEqual(staticMediaChecks.emitted, [], '静态文件加入队列不应发送 Socket 命令');
  assert.equal(staticMediaChecks.controlsDisabled, true, '查看静态文件时播放控件应禁用');
  assert.equal(staticMediaChecks.activeTimedFileId, null);
  assert.equal(staticMediaChecks.videoHasSource, false, '切换到静态文件应释放旧媒体源');
  console.log('✓ 静态文件不可播放或入队，查看时定时媒体控件和旧媒体源均已禁用');

  const chatIdentity = await window.webContents.executeJavaScript(`(() => {
    const base = Date.now();
    state.messages = [{ id: 'voice-node', from: 'tester', type: 'voice', voiceUrl: '/voice-test.webm', timestamp: new Date(base).toISOString() }];
    renderChat();
    const originalAudio = document.querySelector('#chatHistory [data-message-id="voice-node"] audio');
    originalAudio.dataset.identity = 'preserve-me';
    addChatMessage({ id: 'later-text', from: 'tester', type: 'text', text: 'later', timestamp: new Date(base + 1000).toISOString() });
    return {
      sameNode: originalAudio === document.querySelector('#chatHistory [data-message-id="voice-node"] audio'),
      identity: document.querySelector('#chatHistory [data-message-id="voice-node"] audio')?.dataset.identity,
      desktopCount: document.querySelectorAll('#chatHistory [data-message-id]').length,
      fullscreenCount: document.querySelectorAll('#fullscreenChatHistory [data-message-id]').length
    };
  })()`, true);
  assert.deepEqual(chatIdentity, { sameNode: true, identity: 'preserve-me', desktopCount: 2, fullscreenCount: 2 });
  console.log('✓ 新聊天消息采用增量追加，不会重建已有语音 audio DOM');

  const chatManagementPagination = await window.webContents.executeJavaScript(`(async () => {
    const originalEmitAck = emitAck;
    const saved = {
      messages: state.messages, chatHasMore: state.chatHasMore, chatBeforeId: state.chatBeforeId, chatBefore: state.chatBefore,
      managerMessages: state.chatManageMessages, managerHasMore: state.chatManageHasMore,
      managerLoading: state.chatManageLoading, managerBeforeId: state.chatManageBeforeId,
      managerBefore: state.chatManageBefore, managerGeneration: state.chatManageGeneration,
      managerAccounts: state.chatManageAccounts, managerAccountsLoading: state.chatManageAccountsLoading,
      listHtml: elements.chatManageList.innerHTML, selected: elements.chatManageUser.value,
      modalHidden: elements.chatManageModal.classList.contains('is-hidden')
    };
    const requests = []; const deleted = [];
    let managerPageRequest = 0;
    emitAck = async (eventName, payload = {}) => {
      if (eventName === 'chat-history') return { success: true, messages: [], hasMore: false, nextBeforeId: '', nextBefore: '' };
      if (eventName !== 'chat-admin') return { success: true };
      if (payload.action === 'list-accounts') return { success: true, accounts: [{ username: 'ArchivedUser', displayName: '离线成员' }] };
      if (payload.action === 'delete-message') { deleted.push(payload.messageId); return { success: true, removed: 1, message: '已删除 1 条聊天记录' }; }
      if (payload.action !== 'list-messages') return { success: true };
      managerPageRequest += 1;
      requests.push({ username: payload.username, beforeId: payload.beforeId, before: payload.before, limit: payload.limit });
      if (managerPageRequest === 1) return { success: true, messages: [
        { id: 'manager-new', from: 'ArchivedUser', fromName: '离线成员', type: 'text', text: '最新管理记录', timestamp: '2026-08-04T03:00:00.000Z' }
      ], hasMore: true, nextBeforeId: 'manager-new', nextBefore: '2026-08-04T03:00:00.000Z' };
      if (managerPageRequest === 2) return { success: true, messages: [
        { id: 'manager-old', from: 'ArchivedUser', fromName: '离线成员', type: 'text', text: '首屏以前的旧记录', timestamp: '2026-08-04T01:00:00.000Z' },
        { id: 'manager-remote', from: 'ArchivedUser', fromName: '离线成员', type: 'text', text: '其他客户端删除目标', timestamp: '2026-08-04T02:00:00.000Z' }
      ], hasMore: false, nextBeforeId: '', nextBefore: '' };
      return { success: true, messages: [
        { id: 'manager-after-reset', from: 'ArchivedUser', fromName: '离线成员', type: 'text', text: '重载后的记录', timestamp: '2026-08-04T04:00:00.000Z' }
      ], hasMore: false, nextBeforeId: '', nextBefore: '' };
    };
    try {
      elements.chatManageModal.classList.add('is-hidden');
      state.messages = [
        { id: 'main-chat-cursor', from: 'tester', type: 'text', text: '即将删除的分页边界', timestamp: '2026-08-04T02:00:00.000Z' },
        { id: 'main-chat-next', from: 'tester', type: 'text', text: '新的分页边界', timestamp: '2026-08-04T03:00:00.000Z' }
      ];
      state.chatHasMore = true; state.chatBeforeId = 'main-chat-cursor'; state.chatBefore = '2026-08-04T02:00:00.000Z';
      handleChatRecordsChanged({ action: 'delete', ids: ['main-chat-cursor'] });
      const mainCursorAdvanced = state.chatBeforeId === 'main-chat-next' && state.chatBefore === '2026-08-04T03:00:00.000Z';
      elements.chatManageModal.classList.remove('is-hidden');
      state.messages = []; state.chatManageAccounts = [{ username: 'ArchivedUser', displayName: '离线成员' }];
      elements.chatManageUser.value = '';
      await loadChatManagerMessages(false);
      const loadMoreVisible = Boolean(elements.chatManageList.querySelector('[data-chat-manage="load-more"]'));
      await loadChatManagerMessages(true);
      const oldVisible = Boolean(elements.chatManageList.querySelector('[data-message-id="manager-old"]'));
      handleChatRecordsChanged({ action: 'delete', ids: ['manager-remote'] });
      const remoteDeleteRemoved = !elements.chatManageList.querySelector('[data-message-id="manager-remote"]');
      await handleChatManagerAction({ target: elements.chatManageList.querySelector('[data-message-id="manager-old"] button') });
      const requestedOldDelete = deleted.includes('manager-old');
      const ownDeleteRemoved = !elements.chatManageList.querySelector('[data-message-id="manager-old"]');
      handleChatRecordsChanged({ action: 'reset' });
      for (let attempt = 0; attempt < 30 && !elements.chatManageList.querySelector('[data-message-id="manager-after-reset"]'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return {
        requests, loadMoreVisible, oldVisible, remoteDeleteRemoved, requestedOldDelete, ownDeleteRemoved,
        mainCursorAdvanced,
        resetReloaded: Boolean(elements.chatManageList.querySelector('[data-message-id="manager-after-reset"]')),
        staleRowsGone: !elements.chatManageList.querySelector('[data-message-id="manager-new"], [data-message-id="manager-old"], [data-message-id="manager-remote"]')
      };
    } finally {
      emitAck = originalEmitAck;
      state.messages = saved.messages; state.chatHasMore = saved.chatHasMore; state.chatBeforeId = saved.chatBeforeId; state.chatBefore = saved.chatBefore;
      state.chatManageMessages = saved.managerMessages; state.chatManageHasMore = saved.managerHasMore;
      state.chatManageLoading = saved.managerLoading; state.chatManageBeforeId = saved.managerBeforeId;
      state.chatManageBefore = saved.managerBefore; state.chatManageGeneration = saved.managerGeneration;
      state.chatManageAccounts = saved.managerAccounts; state.chatManageAccountsLoading = saved.managerAccountsLoading;
      elements.chatManageList.innerHTML = saved.listHtml; renderChatManagerAccounts(); elements.chatManageUser.value = saved.selected;
      elements.chatManageModal.classList.toggle('is-hidden', saved.modalHidden); renderChat();
    }
  })()`, true);
  assert.deepEqual(chatManagementPagination.requests.slice(0, 2), [
    { username: '', beforeId: '', before: '', limit: 200 },
    { username: '', beforeId: 'manager-new', before: '2026-08-04T03:00:00.000Z', limit: 200 }
  ]);
  assert.deepEqual({
    loadMoreVisible: chatManagementPagination.loadMoreVisible,
    oldVisible: chatManagementPagination.oldVisible,
    remoteDeleteRemoved: chatManagementPagination.remoteDeleteRemoved,
    requestedOldDelete: chatManagementPagination.requestedOldDelete,
    ownDeleteRemoved: chatManagementPagination.ownDeleteRemoved,
    mainCursorAdvanced: chatManagementPagination.mainCursorAdvanced,
    resetReloaded: chatManagementPagination.resetReloaded,
    staleRowsGone: chatManagementPagination.staleRowsGone
  }, {
    loadMoreVisible: true, oldVisible: true, remoteDeleteRemoved: true, requestedOldDelete: true,
    ownDeleteRemoved: true, mainCursorAdvanced: true, resetReloaded: true, staleRowsGone: true
  });
  console.log('✓ 聊天管理页可独立分页到旧记录，指定删除及远端删除/重置事件不会留下陈旧行');

  const shareFailure = await window.webContents.executeJavaScript(`(async () => {
    const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    const originalEmitAck = emitAck;
    let stopped = 0;
    const track = { readyState: 'live', stop() { stopped += 1; this.readyState = 'ended'; }, addEventListener() {} };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: async () => stream } });
    emitAck = async (eventName) => eventName === 'screen-share-start'
      ? { success: false, transient: true, error: 'ack timeout' }
      : { success: true };
    try { await toggleScreenShare(); }
    finally {
      emitAck = originalEmitAck;
      if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor);
      else delete navigator.mediaDevices;
    }
    return { stopped, localCapture: state.localCapture, active: state.screenShareActive };
  })()`, true);
  assert.deepEqual(shareFailure, { stopped: 1, localCapture: null, active: false });

  const nativeCaptureBridge = await window.webContents.executeJavaScript(`(async () => {
    const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    const bridgeDescriptor = Object.getOwnPropertyDescriptor(window, 'SyncWatchAndroid');
    const originalEmitAck = emitAck; const originalSocket = state.socket;
    let startCalls = 0; let stopCalls = 0; let serverStops = 0; const frames = [];
    const bridge = {
      isScreenCaptureSupported() { return true; },
      startScreenCapture() { startCalls += 1; return true; },
      stopScreenCapture() { stopCalls += 1; return true; }
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
    Object.defineProperty(window, 'SyncWatchAndroid', { configurable: true, value: bridge });
    state.socket = {
      id: 'native-capture-test', connected: true,
      volatile: { emit(eventName, packet) { if (eventName === 'screen-share-frame') frames.push(packet); } },
      emit(eventName) { if (eventName === 'screen-share-stop') serverStops += 1; }
    };
    emitAck = async (eventName) => eventName === 'screen-share-start' ? { success: true } : { success: true };
    try {
      await toggleScreenShare();
      window.__syncWatchNativeCaptureFrame(btoa('before-ack'), 2, 2, 1);
      const preAckFrames = frames.length;
      await window.__syncWatchNativeCaptureState('started', 'ok');
      window.__syncWatchNativeCaptureFrame(btoa('frame-1'), 2, 2, 1);
      window.__syncWatchNativeCaptureFrame(btoa('frame-3'), 2, 2, 3);
      window.__syncWatchNativeCaptureFrame(btoa('frame-2'), 2, 2, 2);
      window.__syncWatchNativeCaptureFrame('A'.repeat(MAX_NATIVE_CAPTURE_BASE64_LENGTH + 9), 2, 2, 4);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const active = Boolean(state.nativeCapture?.acked && state.screenShareActive);
      const emittedType = frames[0]?.data instanceof Uint8Array;
      const emittedText = frames[0] ? new TextDecoder().decode(frames[0].data) : '';
      await toggleScreenShare();
      const stoppedCleanly = state.nativeCapture === null && !state.screenShareActive && !state.screenShareRequestInFlight;

      emitAck = async (eventName) => eventName === 'screen-share-start' ? { success: false, error: 'native ack rejected' } : { success: true };
      await toggleScreenShare(); await window.__syncWatchNativeCaptureState('started', 'ok');
      const ackFailureCleaned = state.nativeCapture === null && !state.screenShareActive && !state.screenShareRequestInFlight;
      return { startCalls, stopCalls, serverStops, preAckFrames, frameCount: frames.length, emittedType, emittedText, active, stoppedCleanly, ackFailureCleaned };
    } finally {
      if (state.nativeCapture) stopNativeCapture(false);
      state.socket = originalSocket; emitAck = originalEmitAck;
      if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor); else delete navigator.mediaDevices;
      if (bridgeDescriptor) Object.defineProperty(window, 'SyncWatchAndroid', bridgeDescriptor); else delete window.SyncWatchAndroid;
    }
  })()`, true);
  assert.deepEqual(nativeCaptureBridge, {
    startCalls: 2, stopCalls: 2, serverStops: 2, preAckFrames: 0, frameCount: 1,
    emittedType: true, emittedText: 'frame-3', active: true, stoppedCleanly: true, ackFailureCleaned: true
  });
  console.log('✓ Android 原生投屏桥在 ACK 后才发帧，丢弃过期/超限帧，并在停止或 ACK 失败时完整释放');

  const shareRestore = await window.webContents.executeJavaScript(`(() => {
    const file = {
      id: 'share-restore-image', originalName: 'restore.png', category: 'image', status: 'approved',
      size: 68, uploadedBy: state.user.username,
      url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
    };
    const originalPlayback = state.room?.playback;
    state.files.set(file.id, file); loadFile(file);
    if (state.room) state.room.playback = {
      fileId: file.id, currentTime: 0, isPlaying: false, stalled: false,
      volume: 1, revision: (state.playbackRevision || 0) + 1, updatedAt: Date.now()
    };
    showScreenShare({ active: true, socketId: 'remote-share', username: 'remote' });
    screenShareCanvas.width = 12; screenShareCanvas.height = 8;
    screenShareCanvas.getContext('2d').fillRect(0, 0, 12, 8);
    hideScreenShare();
    const result = {
      width: screenShareCanvas.width, height: screenShareCanvas.height,
      canvasHidden: screenShareCanvas.classList.contains('is-hidden'),
      imageVisible: !imageViewer.classList.contains('is-hidden'), currentFile: state.currentFile?.id
    };
    if (state.room) state.room.playback = originalPlayback;
    state.files.delete(file.id); clearStage(); renderFiles();
    return result;
  })()`, true);
  assert.deepEqual(shareRestore, { width: 1, height: 1, canvasHidden: true, imageVisible: true, currentFile: 'share-restore-image' });
  console.log('✓ 共享 ACK 失败会释放捕获轨道，停止共享会清空画布并恢复原内容');

  const recorderCleanup = await window.webContents.executeJavaScript(`(async () => {
    const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    const recorderDescriptor = Object.getOwnPropertyDescriptor(window, 'MediaRecorder');
    const originalFileClick = elements.voiceFileInput.click;
    elements.voiceFileInput.click = () => {};
    let constructorStops = 0; let runtimeStops = 0;
    const constructorTrack = { stop() { constructorStops += 1; } };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [constructorTrack] })
    } });
    class BrokenRecorder { constructor() { throw new Error('constructor failed'); } static isTypeSupported() { return true; } }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, writable: true, value: BrokenRecorder });
    await toggleVoiceRecording();

    const runtimeTrack = { stop() { runtimeStops += 1; } };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [runtimeTrack] })
    } });
    class RuntimeRecorder {
      constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
      static isTypeSupported() { return true; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.onstop?.(); }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, writable: true, value: RuntimeRecorder });
    await toggleVoiceRecording();
    state.mediaRecorder.onerror({ error: new Error('runtime failed') });
    const recorderCleared = state.mediaRecorder === null;
    elements.voiceFileInput.click = originalFileClick;
    if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor);
    else delete navigator.mediaDevices;
    if (recorderDescriptor) Object.defineProperty(window, 'MediaRecorder', recorderDescriptor);
    else delete window.MediaRecorder;
    return { constructorStops, runtimeStops, recorderCleared };
  })()`, true);
  assert.deepEqual(recorderCleanup, { constructorStops: 1, runtimeStops: 1, recorderCleared: true });
  console.log('✓ MediaRecorder 构造和运行期异常都会释放麦克风轨道');

  await window.webContents.executeJavaScript(`document.getElementById('accountMenuBtn').click(); document.querySelector('#accountDropdown [data-account-page="home"]').click();`, true);
  await waitFor(`!document.getElementById('accountModal').classList.contains('is-hidden') && document.getElementById('accountContent').textContent.includes('SW-')`, '个人中心');
  await window.webContents.executeJavaScript(`document.getElementById('profileDisplayName').value = '界面昵称'; document.querySelector('[data-profile-action="change-display-name"]').click();`, true);
  await waitFor(`document.getElementById('accountName').textContent === '界面昵称'`, '用户自行修改账户名字');
  console.log('✓ 个人中心、用户 ID、资料读取和用户自行改名正常');
  const registrationAdmin = await window.webContents.executeJavaScript(`emitAck('admin-action', { action: 'get-settings', adminPassword: 'admin888' })`, true);
  assert.equal(registrationAdmin.success, true);
  console.log('  · 已读取注册管理设置');
  const registrationIp = registrationAdmin.admin.accounts.find((account) => account.username === '界面测试')?.registrationIp;
  assert.ok(registrationIp, '测试账号应记录注册 IP');
  await window.webContents.executeJavaScript(`window.__electronRegistrationIp = ${JSON.stringify(registrationIp)}; true`, true);
  console.log(`  · 测试账号注册 IP：${registrationIp}`);
  const registrationWhitelist = await window.webContents.executeJavaScript(`(async () => {
    try { return await emitAck('admin-action', { action: 'add-registration-whitelist', adminPassword: 'admin888', ipAddress: window.__electronRegistrationIp }); }
    catch (error) { return { success: false, error: String(error?.stack || error) }; }
  })()`, true);
  assert.equal(registrationWhitelist.success, true, registrationWhitelist.error);
  console.log('  · 已加入多账号注册白名单');
  const registrationRendererState = await window.webContents.executeJavaScript(`({
    href: location.href,
    readyState: document.readyState,
    emitAckType: typeof emitAck,
    authenticated: Boolean(state?.authenticated),
    socketConnected: Boolean(state?.socket?.connected)
  })`, true);
  console.log('  · 注册前渲染状态：', registrationRendererState);
  const registrationSocket = await connectSocketClient(baseUrl);
  try {
    const resetTargetRegistered = await socketAck(registrationSocket, 'user-register', { username: '密码重置测试', password: '旧密码123456' });
    assert.equal(resetTargetRegistered.success, true, resetTargetRegistered.error);
    const emailRecoveryRegistered = await socketAck(registrationSocket, 'user-register', { username: '邮箱界面恢复', password: '界面旧密码123456' });
    assert.equal(emailRecoveryRegistered.success, true, emailRecoveryRegistered.error);
  } finally {
    registrationSocket.close();
  }
  await window.webContents.executeJavaScript(`document.getElementById('closeAccountBtn').click(); openManagementHub('accounts'); document.getElementById('adminPassword').value = 'admin888'; document.getElementById('loadAdminBtn').click();`, true);
  await waitFor(`document.getElementById('accountAdminList').textContent.includes('界面昵称') && document.querySelector('[data-account="密码重置测试"] [data-admin-account="reset"]')`, '账号管理');
  await waitFor(`!document.getElementById('mailSettingsCard').classList.contains('is-hidden')`, 'QQ 邮箱管理设置');
  await window.webContents.executeJavaScript(`(() => {
    document.getElementById('mailUser').value = 'electron-sender@qq.com';
    document.getElementById('mailAuthCode').value = 'electron-qq-auth-code';
    document.getElementById('mailFromName').value = 'Electron SyncWatch同步观影';
    document.getElementById('mailEnabled').checked = true;
    document.getElementById('saveMailSettingsBtn').click();
  })()`, true);
  await waitFor(`state.adminSettings?.mail?.configured === true && document.getElementById('mailAuthCode').value === ''`, '保存 QQ 邮箱设置');
  await window.webContents.executeJavaScript(`document.getElementById('mailTestRecipient').value = 'electron-test@example.com'; document.getElementById('testMailSettingsBtn').click()`, true);
  for (let attempt = 0; attempt < 100 && !sentMails.some((message) => message.to === 'electron-test@example.com'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const electronTestMail = sentMails.find((message) => message.to === 'electron-test@example.com');
  assert.ok(electronTestMail); assert.equal(electronTestMail.config.authCode, 'electron-qq-auth-code');
  assert.equal(electronTestMail.config.user, 'electron-sender@qq.com');
  console.log('✓ Electron 管理界面可保存加密 QQ SMTP 设置并发送测试邮件');
  const bindingSocket = await connectSocketClient(baseUrl);
  try {
    const bindingLogin = await socketAck(bindingSocket, 'user-login', {
      username: '邮箱界面恢复', password: '界面旧密码123456', roomId: ' ', deviceId: 'electron-email-binding'
    });
    assert.equal(bindingLogin.success, true, bindingLogin.error);
    if (bindingLogin.capabilities?.agreementRequired) {
      const accepted = await socketAck(bindingSocket, 'agreement-accept', { accepted: true, version: bindingLogin.agreement.version });
      assert.equal(accepted.success, true, accepted.error);
    }
    const bindingRequested = await socketAck(bindingSocket, 'email-bind-request', { email: 'electron-ui-recovery@example.com' });
    assert.equal(bindingRequested.success, true, bindingRequested.error);
    for (let attempt = 0; attempt < 100 && !sentMails.some((message) => message.to === 'electron-ui-recovery@example.com' && String(message.subject).includes('邮箱绑定')); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const bindingMail = [...sentMails].reverse().find((message) => message.to === 'electron-ui-recovery@example.com' && String(message.subject).includes('邮箱绑定'));
    const bindingCode = bindingMail?.text.match(/验证码：(\d{6})/)?.[1];
    assert.match(bindingCode || '', /^\d{6}$/);
    const bound = await socketAck(bindingSocket, 'email-bind-verify', { email: 'electron-ui-recovery@example.com', code: bindingCode });
    assert.equal(bound.success, true, bound.error);
    assert.equal(bound.profile.emailVerified, true);
  } finally { bindingSocket.close(); }
  await window.webContents.executeJavaScript(`document.querySelector('[data-account="界面测试"] [data-admin-account="rename"]').click();`, true);
  await waitFor(`!document.querySelector('[data-account="界面测试"] [data-admin-rename-editor]').classList.contains('is-hidden') && document.querySelector('[data-account="界面测试"] [data-admin-rename-input]') === document.activeElement`, '显示强制改名输入框');
  await window.webContents.executeJavaScript(`document.querySelector('[data-account="界面测试"] [data-admin-rename-input]').value = '管理员强制名'; document.querySelector('[data-account="界面测试"] [data-admin-account="rename-save"]').click();`, true);
  await waitFor(`document.getElementById('accountName').textContent === '管理员强制名'`, '管理员强制改名');
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('hostTunnelCard').classList.contains('is-hidden')`), false);
  console.log('✓ 管理员强制改名、账号管理与服务器专属公网入口正常');

  await setContentViewport(430, 780);
  const mobileChatToggle = await window.webContents.executeJavaScript(`(() => {
    state.mobileChatCollapsed = false; applyMobileChatCollapsed();
    document.getElementById('chatToggleBtn').click();
    const collapsed = {
      panel: document.getElementById('chatPanel').classList.contains('mobile-chat-collapsed'),
      theater: document.getElementById('theater').classList.contains('mobile-chat-collapsed'),
      expanded: document.getElementById('chatToggleBtn').getAttribute('aria-expanded'),
      historyHidden: getComputedStyle(document.getElementById('chatHistory')).display === 'none',
      label: document.getElementById('chatToggleBtn').textContent
    };
    document.getElementById('chatToggleBtn').click();
    return { collapsed, restored: {
      panel: !document.getElementById('chatPanel').classList.contains('mobile-chat-collapsed'),
      expanded: document.getElementById('chatToggleBtn').getAttribute('aria-expanded'),
      historyVisible: getComputedStyle(document.getElementById('chatHistory')).display !== 'none'
    } };
  })()`, true);
  assert.deepEqual(mobileChatToggle, {
    collapsed: { panel: true, theater: true, expanded: 'false', historyHidden: true, label: '展开聊天' },
    restored: { panel: true, expanded: 'true', historyVisible: true }
  });
  await window.webContents.executeJavaScript(`document.getElementById('mobileFilesBtn').click()`, true);
  await waitFor(`document.getElementById('filePanel').classList.contains('mobile-open')`, '手机影片面板');
  const returnVisible = await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-close-panel="filePanel"]')).display !== 'none'`);
  assert.equal(returnVisible, true);
  await window.webContents.executeJavaScript(`document.querySelector('[data-close-panel="filePanel"]').click()`, true);
  await waitFor(`!document.getElementById('filePanel').classList.contains('mobile-open')`, '手机返回观影');
  console.log('✓ 手机聊天可显式收起/展开，上传侧栏具备固定返回按钮并可恢复播放界面');

  for (const size of [[768, 1024], [900, 700], [1024, 768], [812, 375], [1920, 1080]]) {
    await setContentViewport(size[0], size[1]);
    const overflow = await window.webContents.executeJavaScript(`(() => {
      const viewport = document.documentElement.clientWidth;
      const offenders = [...document.querySelectorAll('body *')].map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, id: element.id, className: String(element.className || '').slice(0, 100), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
      }).filter((item) => item.right > viewport + 2 || item.left < -2).slice(0, 12);
      return { overflow: document.documentElement.scrollWidth > viewport + 2, viewport, scrollWidth: document.documentElement.scrollWidth, offenders };
    })()`);
    assert.equal(overflow.overflow, false, `${size.join('x')} 不应横向溢出：${JSON.stringify(overflow)}`);
  }
  console.log('✓ 手机、平板、电脑和电视尺寸无横向布局溢出');

  await setContentViewport(812, 375);
  const shortLandscapeOverlap = await window.webContents.executeJavaScript(`(() => {
    const player = document.getElementById('playerContainer').getBoundingClientRect();
    const chat = document.querySelector('.chat-panel').getBoundingClientRect();
    const overlapWidth = Math.max(0, Math.min(player.right, chat.right) - Math.max(player.left, chat.left));
    const overlapHeight = Math.max(0, Math.min(player.bottom, chat.bottom) - Math.max(player.top, chat.top));
    return {
      overlaps: overlapWidth > 1 && overlapHeight > 1,
      overlapWidth, overlapHeight,
      viewport: { width: innerWidth, height: innerHeight },
      shortLandscape: matchMedia('(orientation: landscape) and (max-height: 560px) and (max-width: 1000px)').matches,
      player: { left: player.left, right: player.right, top: player.top, bottom: player.bottom },
      chat: { left: chat.left, right: chat.right, top: chat.top, bottom: chat.bottom }
    };
  })()`);
  assert.equal(shortLandscapeOverlap.overlaps, false, `短横屏聊天区不应覆盖播放画面：${JSON.stringify(shortLandscapeOverlap)}`);
  console.log('✓ 900px 宽度与短横屏布局无裁切，聊天区不覆盖播放器');

  await window.webContents.executeJavaScript(`document.querySelector('[data-account="密码重置测试"] [data-admin-account="reset"]').click()`, true);
  await waitFor(`!document.getElementById('appDialog').classList.contains('is-hidden') && document.getElementById('appDialogTitle').textContent === '重置为默认密码'`, '打开管理员默认密码确认对话框');
  await window.webContents.executeJavaScript(`document.getElementById('appDialogConfirmBtn').click()`, true);
  await waitFor(`document.getElementById('toastRegion').textContent.includes('密码已重置')`, '管理员重置密码完成');
  const resetPasswordVerification = await window.webContents.executeJavaScript(`(async () => {
    const loginPayload = { username: '密码重置测试', roomId: state.room.id, roomPassword: '', ...deviceInfo() };
    const oldPassword = await emitAck('user-login', { ...loginPayload, password: '旧密码123456' });
    const newPassword = await emitAck('user-login', { ...loginPayload, password: '123456' });
    return { oldPasswordAccepted: Boolean(oldPassword.success), newPasswordAccepted: Boolean(newPassword.success) };
  })()`, true);
  assert.deepEqual(resetPasswordVerification, { oldPasswordAccepted: false, newPasswordAccepted: true });
  console.log('✓ 管理员可将账号重置为服务器默认密码，旧密码失效且默认密码可登录');

  await window.webContents.executeJavaScript(`document.getElementById('forgotPasswordBtn').click()`, true);
  await waitFor(`!document.getElementById('appDialog').classList.contains('is-hidden') && document.getElementById('appDialogTitle').textContent === 'QQ 邮箱找回密码'`, '打开 QQ 邮箱找回密码对话框');
  const recoveryDescription = await window.webContents.executeJavaScript(`document.getElementById('appDialogDescription').textContent`, true);
  // v2.2.0 may explicitly explain an unknown account instead of promising a
  // privacy-masked response; both variants must keep a usable description.
  assert.ok(recoveryDescription.trim().length > 0);
  await window.webContents.executeJavaScript(`document.getElementById('appDialogInput').value = '邮箱界面恢复'; document.getElementById('appDialogConfirmBtn').click()`, true);
  await waitFor(`!document.getElementById('appDialog').classList.contains('is-hidden') && document.getElementById('appDialogTitle').textContent === '填写邮箱验证码' && document.getElementById('appDialogInput').autocomplete === 'one-time-code'`, '打开验证码对话框');
  for (let attempt = 0; attempt < 100 && !sentMails.some((message) => message.to === 'electron-ui-recovery@example.com' && String(message.subject).includes('密码重置')); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const electronRecoveryMail = [...sentMails].reverse().find((message) => message.to === 'electron-ui-recovery@example.com' && String(message.subject).includes('密码重置'));
  assert.ok(electronRecoveryMail);
  const electronRecoveryCode = electronRecoveryMail.text.match(/验证码：(\d{6})/)?.[1];
  assert.match(electronRecoveryCode || '', /^\d{6}$/);
  await window.webContents.executeJavaScript(`document.getElementById('appDialogInput').value = '${electronRecoveryCode}'; document.getElementById('appDialogConfirmBtn').click()`, true);
  await waitFor(`!document.getElementById('appDialog').classList.contains('is-hidden') && document.getElementById('appDialogTitle').textContent === '设置新的登录密码'`, '邮箱验证码通过');
  await window.webContents.executeJavaScript(`document.getElementById('appDialogInput').value = '邮箱新密码654321'; document.getElementById('appDialogConfirmBtn').click()`, true);
  await waitFor(`!document.getElementById('appDialog').classList.contains('is-hidden') && document.getElementById('appDialogTitle').textContent === '确认新密码'`, '邮箱新密码确认对话框');
  await window.webContents.executeJavaScript(`document.getElementById('appDialogInput').value = '邮箱新密码654321'; document.getElementById('appDialogConfirmBtn').click()`, true);
  await waitFor(`document.getElementById('toastRegion').textContent.includes('登录密码已修改')`, '邮箱找回密码完成');
  const electronRecoveryVerification = await window.webContents.executeJavaScript(`(async () => {
    const loginPayload = { username: '邮箱界面恢复', roomId: state.room.id, roomPassword: '', ...deviceInfo() };
    const oldPassword = await emitAck('user-login', { ...loginPayload, password: '界面旧密码123456' });
    const newPassword = await emitAck('user-login', { ...loginPayload, password: '邮箱新密码654321' });
    return { oldPasswordAccepted: Boolean(oldPassword.success), newPasswordAccepted: Boolean(newPassword.success) };
  })()`, true);
  assert.deepEqual(electronRecoveryVerification, { oldPasswordAccepted: false, newPasswordAccepted: true });
  console.log('✓ Electron 忘记密码界面完成 QQ 验证码、设置新密码并使旧密码失效');

  window.setFullScreen(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const f11Layout = await window.webContents.executeJavaScript(`(() => {
    const topbar = document.querySelector('.topbar');
    const rect = topbar.getBoundingClientRect();
    const visibleButtons = [...topbar.querySelectorAll('button:not(.is-hidden)')].filter((button) => getComputedStyle(button).display !== 'none');
    return {
      topbarVisible: rect.top >= 0 && rect.bottom <= innerHeight && rect.height >= 50,
      textUnclipped: visibleButtons.every((button) => button.scrollHeight <= button.clientHeight + 1),
      brandUnclipped: document.querySelector('.brand').scrollHeight <= document.querySelector('.brand').clientHeight + 1
    };
  })()`, true);
  assert.deepEqual(f11Layout, { topbarVisible: true, textUnclipped: true, brandUnclipped: true });
  window.setFullScreen(false);
  console.log('✓ Electron F11 窗口全屏下顶部栏和按钮文字不会被裁切');

  const websocketOrigin = baseUrl.replace(/^http/, 'ws');
  const external = requestedUrls.filter((url) => !url.startsWith(baseUrl) && !url.startsWith(websocketOrigin));
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  console.log('✓ 无外网前端依赖、无渲染脚本错误');
}

async function finishTest(exitCode) {
  window?.destroy(); window = null;
  await controller?.close().catch((error) => console.warn('关闭测试服务器失败:', error.message));
  controller = null;
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    console.warn(`Electron 当前仍占用临时浏览器缓存，进程退出后可安全清理：${dataDir}`);
  }
  process.exitCode = exitCode;
  app.exit(exitCode);
}

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    await run();
    console.log(`\nElectron v${releaseVersion} 渲染验收全部通过。`);
  } catch (error) {
    exitCode = 1;
    console.error(`\nElectron v${releaseVersion} 渲染验收失败:`, error);
  }
  try { await finishTest(exitCode); }
  catch (error) { console.error(`\nElectron v${releaseVersion} 清理失败:`, error); app.exit(1); }
}).catch((error) => { console.error(`\nElectron v${releaseVersion} 启动失败:`, error); app.exit(1); });
