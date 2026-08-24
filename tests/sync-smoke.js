'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const ffmpegPath = require('ffmpeg-static');
const { startSyncWatchServer } = require('../server');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-sync-smoke-'));
const dataDir = path.join(root, 'server');
const sample = path.join(root, 'sync-sample.mp4');
const windows = [];
let controller;
const sharedWebUrl = 'https://jx.xmflv.cc/?url=https://v.qq.com/x/cover/yl6lapwmmx5ivew/m0501m4tc0q.html?report_recomm_player=ptag%3Dv_qq_com%7Crtype%3D%7CalgId%3D5112%7CbucketId%3D%7Creason%3D%7CreasonType%3D%7Ccid%3D%7Cvid%3D%7Cpid%3D%7Cmodule%3D%7CpageType%3DfilmIndex%7Cseqnum%3D%7Cvideo_rec_report%3Dflow_from%3A3%7Ce_item_id%3Ayl6lapwmmx5ivew%7Ce_item_type%3A2%7Ce_mid%3Ayl6lapwmmx5ivew%23v4102xprlr0%7Ce_rec_reason%3A3%7Ce_cid_played%3A3%7Ce_cid_played_10min%3A1%7Ce_cid_played_valid%3A1%7Ce_targeting_tags%3Anon_weak_low_activity%2Cvp1_pl1%2Cvp0_pl0_d7%2Cm_v_pcu%2Cnot_vip%2Cinterest_movie_none%2Csd_v_cu%7Ce_rerank_cost_time%3A39%7Ce_profile_cost_time%3A7%7Ce_recall_cost_time%3A87%7Ca_alg_id_list%3A5112%7Ce_alg_id_list%3A5112%7Cpositive_trailer%3A1%7Ce_cut_vid%3Av4102xprlr0%7Crecall_mod%3A803036%7Cseqnum%3A0f616a06ac20a757_1786018995.1786018993246599_868%7Csrc_key%3A100137%7Cscene_type%3A1%7Creq_timestamp%3A1786018995%7Creturn_item_num%3A36%7Cis_unify_re%3A1%7Crec_session_id%3A0f616a06ac20a757_1786018995%7Cspecial_user%3A0%7Cflow_rule_id%3A156%7Cexp_i';

const generated = spawnSync(ffmpegPath, [
  '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=12',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', sample
], { windowsHide: true, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(window, expression, description, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await window.webContents.executeJavaScript(expression, true);
      if (value) return value;
    } catch (_) {}
    await delay(100);
  }
  throw new Error(`等待“${description}”超时`);
}

async function createClientWindow(baseUrl, partition, { hostToken = '', clockOffset = 0 } = {}) {
  const window = new BrowserWindow({
    width: 1100, height: 760, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, partition }
  });
  windows.push(window);
  if (clockOffset) {
    await window.loadURL('about:blank');
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Page.enable');
    await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => { const nativeNow = Date.now.bind(Date); Date.now = () => nativeNow() + ${Number(clockOffset)}; })();`
    });
  }
  await window.loadURL(`${baseUrl}${hostToken ? `#host=${encodeURIComponent(hostToken)}` : ''}`);
  if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
  await waitFor(window, `document.getElementById('connectionBadge').classList.contains('online')`, '连接服务器');
  return window;
}

async function registerAndLogin(window, username, password, { roomId = '', createRoom = false } = {}) {
  await window.webContents.executeJavaScript(`
    document.getElementById('showRegisterBtn').click();
    document.getElementById('regUsername').value = ${JSON.stringify(username)};
    document.getElementById('regPassword').value = ${JSON.stringify(password)};
    document.getElementById('regPasswordConfirm').value = ${JSON.stringify(password)};
    document.getElementById('registerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  `, true);
  await waitFor(window, `document.getElementById('loginStatus').textContent.includes('注册成功')`, `${username} 注册`);
  await window.webContents.executeJavaScript(`
    document.getElementById('username').value = ${JSON.stringify(username)};
    document.getElementById('password').value = ${JSON.stringify(password)};
    if (${JSON.stringify(createRoom)}) {
      document.getElementById('createRoomBtn').click();
      document.getElementById('newRoomName').value = ${JSON.stringify(`${username}的同步房间`)};
      document.getElementById('newRoomId').value = 'SYNCROOM';
      document.getElementById('newRoomMaxUsers').value = '8';
      document.getElementById('createRoomForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    } else {
      document.getElementById('roomIdInput').value = ${JSON.stringify(roomId)};
      document.getElementById('loginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  `, true);
  await waitFor(window, `
    !document.getElementById('agreementModal').classList.contains('is-hidden') ||
    (!document.getElementById('mainPage').classList.contains('is-hidden') && state.socketAuthenticated)
  `, `${username} 首次协议或登录`);
  if (!await window.webContents.executeJavaScript(`document.getElementById('agreementModal').classList.contains('is-hidden')`, true)) {
    await window.webContents.executeJavaScript(`
      document.getElementById('agreementCheck').click();
      document.getElementById('acceptAgreementBtn').click();
    `, true);
  }
  await waitFor(window, `!document.getElementById('mainPage').classList.contains('is-hidden') && state.socketAuthenticated`, `${username} 登录`);
  await window.webContents.executeJavaScript(`videoPlayer.muted = true`, true);
  return window.webContents.executeJavaScript(`state.room.id`, true);
}

async function run() {
  console.log('• 启动双窗口同步服务…');
  controller = await startSyncWatchServer({
    host: '0.0.0.0', port: 0, dataDir, publicDir: path.resolve(__dirname, '..', 'public'), hostControlToken: 'sync-host'
  });
  const baseUrl = controller.addresses[0] || `http://127.0.0.1:${controller.port}`;

  const host = await createClientWindow(baseUrl, `sync-host-${process.pid}`, { hostToken: 'sync-host' });
  console.log('• 房主窗口已连接…');
  const hostRoomId = await registerAndLogin(host, '同步房主', 'host-pass', { createRoom: true });
  const hostToken = await host.webContents.executeJavaScript(`state.token`, true);
  const registrationSettings = await host.webContents.executeJavaScript(`emitAck('admin-action', { action: 'get-settings', adminPassword: 'admin888' })`, true);
  assert.equal(registrationSettings.success, true, registrationSettings.error);
  const hostRegistrationIp = registrationSettings.admin.accounts.find((account) => account.username === '同步房主')?.registrationIp;
  assert.ok(hostRegistrationIp, '同步房主应记录注册 IP');
  const registrationWhitelist = await host.webContents.executeJavaScript(`emitAck('admin-action', { action: 'add-registration-whitelist', adminPassword: 'admin888', ipAddress: ${JSON.stringify(hostRegistrationIp)} })`, true);
  assert.equal(registrationWhitelist.success, true, registrationWhitelist.error);

  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(sample)], { type: 'video/mp4' }), '同步测试.mp4');
  const uploadResponse = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${hostToken}` }, body: form });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200); assert.equal(upload.success, true);
  const fileId = upload.file.id;
  await waitFor(host, `state.files.has(${JSON.stringify(fileId)})`, '房主收到影片');
  await waitFor(host, `(() => {
    const file = state.files.get(${JSON.stringify(fileId)});
    return file?.metadata?.analysisVersion === 2 && file?.compatibility?.ready === true;
  })()`, '房主收到影片编码检测结果', 30000);
  const selected = await host.webContents.executeJavaScript(`emitAck('select-file', { fileId: ${JSON.stringify(fileId)} })`, true);
  assert.equal(selected?.success, true, selected?.error || '房主选择同步测试影片失败');
  await waitFor(host, `state.currentFile?.id === ${JSON.stringify(fileId)} && videoPlayer.readyState >= 1 && videoPlayer.paused`, '房主暂停画面就绪');
  console.log('• 房主影片已在暂停状态就绪…');

  const uploadPolicy = await host.webContents.executeJavaScript(`emitAck('admin-action', { action: 'set-upload-policy', adminPassword: 'admin888', allowedUploadCategories: ['video', 'subtitle'] })`, true);
  assert.equal(uploadPolicy?.success, true, uploadPolicy?.error || '同步测试应先允许字幕上传');

  const viewer = await createClientWindow(baseUrl, `sync-viewer-${process.pid}`, { clockOffset: 60000 });
  console.log('• 时钟偏差观众窗口已连接…');
  await registerAndLogin(viewer, '同步观众', 'viewer-pass', { roomId: hostRoomId });
  await waitFor(viewer, `state.currentFile?.id === ${JSON.stringify(fileId)} && videoPlayer.readyState >= 1 && videoPlayer.paused`, '暂停状态晚加入仍显示影片');
  const clock = await viewer.webContents.executeJavaScript(`({ skew: Date.now() - new Date().getTime(), offset: state.serverClockOffset })`, true);
  assert.ok(clock.skew > 59000 && clock.skew < 61000, JSON.stringify(clock));
  assert.ok(clock.offset < -59000 && clock.offset > -61000, JSON.stringify(clock));
  console.log('✓ 系统时钟快 60 秒的设备仍能在暂停状态晚加入并立即显示影片');

  const subtitleForm = new FormData();
  subtitleForm.append('file', new Blob([Buffer.from('1\n00:00:00,000 --> 00:00:03,000\n动态字幕\n', 'utf8')], { type: 'application/x-subrip' }), '同步测试.srt');
  const subtitleResponse = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${hostToken}` }, body: subtitleForm });
  assert.equal(subtitleResponse.status, 200);
  await waitFor(viewer, `videoPlayer.querySelectorAll('track').length === 1`, '当前影片动态加载字幕');
  console.log('✓ 播放页面无需换片或刷新即可动态挂载新字幕');

  await host.webContents.executeJavaScript(`sendPlayback('play', 0)`, true);
  await waitFor(host, `!videoPlayer.paused && videoPlayer.currentTime > 1`, '房主开始播放', 25000);
  await waitFor(viewer, `!videoPlayer.paused && videoPlayer.currentTime > 1`, '观众同步播放', 25000);
  const playing = await Promise.all([host, viewer].map((window) => window.webContents.executeJavaScript(`videoPlayer.currentTime`, true)));
  assert.ok(Math.abs(playing[0] - playing[1]) < 0.7, `播放差 ${Math.abs(playing[0] - playing[1])}秒`);
  assert.ok(playing[1] < 10, '时钟偏差不应让观众跳到片尾');
  console.log('✓ 双窗口真实 MP4 播放同步，时钟偏差不会造成跳播');

  const bufferingGuard = await viewer.webContents.executeJavaScript(`(() => {
    const before = videoPlayer.currentTime;
    state.localBuffering = true; state.bufferedAheadSeconds = 0;
    state.expectedSeek = null; state.syncSeekCooldownUntil = 0;
    adaptiveSynchronize({ ...state.room.playback, currentTime: before + 4, updatedAt: estimatedServerNow() }, true);
    const result = { before, after: videoPlayer.currentTime, expectedSeek: state.expectedSeek, notice: elements.syncNotice.textContent };
    state.localBuffering = false;
    return result;
  })()`, true);
  assert.equal(bufferingGuard.expectedSeek, null, JSON.stringify(bufferingGuard));
  assert.ok(Math.abs(bufferingGuard.after - bufferingGuard.before) < .5, JSON.stringify(bufferingGuard));
  assert.match(bufferingGuard.notice, /正在缓冲，暂停定位/);
  await viewer.webContents.executeJavaScript(`refreshRoom()`, true);
  console.log('✓ 观众本机缓冲时不会反复强制定位并重置 Range 请求');

  await host.webContents.executeJavaScript(`(() => {
    state.lastPlaybackProgress = Number.POSITIVE_INFINITY;
    state.mediaFailed = true;
    state.socket.emit('playback-progress', {
      fileId: ${JSON.stringify(fileId)}, currentTime: videoPlayer.currentTime,
      isPlaying: true, stalled: true, revision: state.room?.playback?.revision
    });
    return true;
  })()`, true);
  await waitFor(viewer, `state.room?.playback?.stalled === true && videoPlayer.paused && !videoPlayer.seeking && state.expectedSeek === null && document.getElementById('syncStatus').textContent.includes('缓冲')`, '缓冲状态同步到观众并完成冻结定位');
  await waitFor(host, `state.room?.playback?.stalled === true`, '房主接收缓冲 revision');
  const stalledSample = await viewer.webContents.executeJavaScript(`({
    currentTime: videoPlayer.currentTime,
    paused: videoPlayer.paused,
    stalled: state.room?.playback?.stalled,
    revision: state.room?.playback?.revision
  })`, true);
  await delay(700);
  const stalledSampleLater = await viewer.webContents.executeJavaScript(`({
    currentTime: videoPlayer.currentTime,
    paused: videoPlayer.paused,
    stalled: state.room?.playback?.stalled,
    revision: state.room?.playback?.revision
  })`, true);
  assert.equal(stalledSampleLater.stalled, true, JSON.stringify({ stalledSample, stalledSampleLater }));
  assert.equal(stalledSampleLater.paused, true, JSON.stringify({ stalledSample, stalledSampleLater }));
  assert.ok(Math.abs(stalledSampleLater.currentTime - stalledSample.currentTime) < 0.2, `stalled 状态下观众时间轴不应继续推进：${JSON.stringify({ stalledSample, stalledSampleLater })}`);
  await host.webContents.executeJavaScript(`(() => {
    state.lastPlaybackProgress = 0;
    state.socket.emit('playback-progress', {
      fileId: ${JSON.stringify(fileId)}, currentTime: videoPlayer.currentTime,
      isPlaying: true, stalled: false, revision: state.room?.playback?.revision
    });
    state.mediaFailed = false;
    return true;
  })()`, true);
  await waitFor(viewer, `state.room?.playback?.stalled === false && !videoPlayer.paused`, '缓冲恢复后继续播放');
  console.log('✓ 房主 stalled 状态会冻结观众时间轴，恢复后继续同步播放');

  const oldSocketId = await viewer.webContents.executeJavaScript(`state.socket.id`, true);
  await viewer.webContents.executeJavaScript(`(() => { state.socket.disconnect(); return true; })()`, true);
  await waitFor(viewer, `!state.socket.connected && !state.socketAuthenticated`, '观众断开连接');
  const missedChatText = `断线补聊-${Date.now()}`;
  await host.webContents.executeJavaScript(`(() => {
    state.chatMode = 'public';
    document.getElementById('chatInput').value = ${JSON.stringify(missedChatText)};
    document.getElementById('chatForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`, true);
  await waitFor(host, `state.messages.some((message) => message.text === ${JSON.stringify(missedChatText)})`, '房主发送断线期间聊天');
  await viewer.webContents.executeJavaScript(`(() => { state.socket.connect(); return true; })()`, true);
  await waitFor(viewer, `state.socket.connected && state.socketAuthenticated && state.socket.id !== ${JSON.stringify(oldSocketId)} && document.getElementById('reconnectOverlay').classList.contains('is-hidden')`, '断网后会话和播放自动恢复', 25000);
  await waitFor(viewer, `state.messages.some((message) => message.text === ${JSON.stringify(missedChatText)})`, '重连后自动补齐断线聊天', 25000);
  await waitFor(viewer, `!videoPlayer.paused`, '重连后继续播放');
  console.log('✓ Socket 更换 ID 后自动恢复登录、补齐断线聊天并继续播放');

  await host.webContents.executeJavaScript(`sendPlayback('pause', videoPlayer.currentTime)`, true);
  await waitFor(viewer, `videoPlayer.paused && Math.abs(videoPlayer.currentTime - state.room.playback.currentTime) < 0.8`, '观众同步暂停');

  const startedShare = await host.webContents.executeJavaScript(`emitAck('screen-share-start')`, true);
  assert.equal(startedShare.success, true);
  await waitFor(host, `state.screenShareActive`, '房主进入共享状态');
  await waitFor(viewer, `state.screenShareActive && !screenShareCanvas.classList.contains('is-hidden')`, '观众进入共享画面');
  await host.webContents.executeJavaScript(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 16;
    const context = canvas.getContext('2d'); context.fillStyle = '#e62f68'; context.fillRect(0, 0, 32, 16);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .9));
    state.nativeCapture = { session: 999, bridge: null, acked: true, started: true, lastSourceSequence: 0 };
    resetOutgoingScreenFrames();
    sendCapturedScreenFrame({ sequence: ++state.captureSequence, width: 32, height: 16, data: await blob.arrayBuffer() });
    return true;
  })()`, true);
  await waitFor(viewer, `screenShareCanvas.width === 32 && screenShareCanvas.height === 16 && screenShareCanvas.getContext('2d').getImageData(8, 8, 1, 1).data[0] > 180`, '二进制共享帧绘制', 15000);
  await waitFor(host, `state.screenFrameReliableLastAt > 0 && !state.screenFrameReliableInFlight`, '首个共享画面可靠 ACK');
  await host.webContents.executeJavaScript(`emitAck('screen-share-stop')`, true);
  await waitFor(viewer, `!state.screenShareActive && !videoPlayer.classList.contains('is-hidden') && screenShareCanvas.classList.contains('is-hidden') && screenShareCanvas.width === 1 && screenShareCanvas.height === 1`, '停止共享后恢复影片');
  console.log('✓ 生产发送路径的首帧可靠 ACK、二进制 JPEG 绘制及停止后影片恢复正常');

  const sharedWeb = await host.webContents.executeJavaScript(`emitAck('web-share-start', { url: ${JSON.stringify(sharedWebUrl)}, title: '腾讯视频解析页' })`, true);
  assert.equal(sharedWeb.success, true, sharedWeb.error);
  for (const [name, window] of [['房主', host], ['观众', viewer]]) {
    await waitFor(window, `state.webShare?.active === true
      && state.webShare.url === ${JSON.stringify(sharedWebUrl)}
      && sharedWebViewer.getAttribute('src') === ${JSON.stringify(sharedWebUrl)}
      && !sharedWebViewer.classList.contains('is-hidden')`, `${name}切换到完整共享网址`, 20000);
  }
  const clearButtonState = await host.webContents.executeJavaScript(`(() => {
    const button = document.getElementById('clearPlaybackBtn');
    return { disabled: button.disabled, ariaDisabled: button.getAttribute('aria-disabled') };
  })()`, true);
  assert.equal(clearButtonState.disabled, false, JSON.stringify(clearButtonState));
  assert.equal(clearButtonState.ariaDisabled, 'false', JSON.stringify(clearButtonState));
  await host.webContents.executeJavaScript(`document.getElementById('clearPlaybackBtn').click()`, true);
  for (const [name, window] of [['房主', host], ['观众', viewer]]) {
    await waitFor(window, `state.webShare?.active === false
      && sharedWebViewer.getAttribute('src') === 'about:blank'
      && sharedWebViewer.classList.contains('is-hidden')
      && document.getElementById('toastRegion').textContent.includes('同步房主 清空了画面')`, `${name}清空共享网页并收到操作者提示`, 20000);
  }
  console.log('✓ 用户提供的完整长网址会同步到双窗口；网页共享时可清空且全员看到操作者提示');
}

app.whenReady().then(run).then(async () => {
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  await controller?.close(); fs.rmSync(root, { recursive: true, force: true });
  console.log('\n双窗口播放/画面同步验收通过。'); process.exitCode = 0; app.exit(0);
}).catch(async (error) => {
  console.error('\n双窗口播放/画面同步验收失败:', error);
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  await controller?.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); process.exitCode = 1; app.exit(1);
});
