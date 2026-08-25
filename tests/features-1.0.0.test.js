'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const auth = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.events = new Map();
    this.waiters = new Map();
    socket.onAny((event, payload) => {
      const waiters = this.waiters.get(event) || [];
      const index = waiters.findIndex((entry) => !entry.predicate || entry.predicate(payload));
      if (index >= 0) {
        const [entry] = waiters.splice(index, 1);
        clearTimeout(entry.timer);
        entry.resolve(payload);
        return;
      }
      const queue = this.events.get(event) || [];
      queue.push(payload);
      if (queue.length > 50) queue.shift();
      this.events.set(event, queue);
    });
  }

  static async connect(url) {
    const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket.IO 连接超时')), 10000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
    });
    return new TestClient(socket);
  }

  ackRaw(event, payload = {}, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} 响应超时`)), timeout);
      this.socket.emit(event, payload, (result) => {
        clearTimeout(timer);
        resolve(result || { success: false, error: '服务器未返回结果' });
      });
    });
  }

  async ack(event, payload = {}, timeout = 10000) {
    const result = await this.ackRaw(event, payload, timeout);
    if (['user-login', 'host-admin-login', 'room-create', 'session-resume'].includes(event)
      && result?.success && result.capabilities?.agreementRequired && result.agreement?.version) {
      const accepted = await this.ackRaw('agreement-accept', { accepted: true, version: result.agreement.version }, timeout);
      assert.equal(accepted.success, true, accepted.error);
      result.capabilities.agreementRequired = false;
    }
    return result;
  }

  next(event, predicate, timeout = 10000) {
    const queue = this.events.get(event) || [];
    const index = queue.findIndex((payload) => !predicate || predicate(payload));
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待事件 ${event} 超时`)), timeout);
      const waiters = this.waiters.get(event) || [];
      waiters.push({ predicate, resolve, reject, timer });
      this.waiters.set(event, waiters);
    });
  }

  close() {
    this.socket.close();
    for (const waiters of this.waiters.values()) {
      for (const entry of waiters) clearTimeout(entry.timer);
    }
  }
}

async function uploadVideo(baseUrl, token, filename) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(`feature-media-${filename}`)], { type: 'video/mp4' }), filename);
  const response = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(token), body: form });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.success, true, payload.error);
  return payload.file;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-features-v2.2.0-'));
  const publicDir = path.resolve(__dirname, '..', 'public');
  const clients = [];
  let server;

  const connect = async () => {
    const client = await TestClient.connect(`http://127.0.0.1:${server.port}`);
    clients.push(client);
    return client;
  };

  try {
    server = await startSyncWatchServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      publicDir,
      ffprobePath: '',
      ffmpegPath: '',
      discovery: false,
      hostControlToken: 'feature-host-token',
      roomEmptyCloseMs: 140
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const admin = await connect();
    let adminLogin = await admin.ack('user-login', {
      username: 'admin',
      password: 'admin888',
      hostToken: 'feature-host-token',
      deviceId: 'feature-admin-device',
      deviceName: '测试管理终端'
    });
    assert.equal(adminLogin.success, true, adminLogin.error);
    assert.equal(adminLogin.capabilities.superAdmin, true);
    assert.equal(adminLogin.capabilities.mustChangeAccountPassword, true);
    assert.equal(adminLogin.permissions.manageRoom, true);
    assert.equal(adminLogin.room.temporary, true);
    const temporaryAdminRoomId = adminLogin.room.id;
    const initialDirectory = await (await fetch(`${baseUrl}/api/online-rooms`)).json();
    const scannedTemporaryRoom = initialDirectory.rooms.find((room) => room.id === temporaryAdminRoomId);
    assert.ok(scannedTemporaryRoom, '正在使用的临时房应出现在房间扫描结果中');
    assert.equal(scannedTemporaryRoom.temporary, true);
    let adminToken = adminLogin.token;

    let result = await admin.ack('admin-action', { action: 'get-settings' });
    assert.equal(result.success, true, result.error);
    assert.equal(result.admin.watchLevels.length, 10);
    assert.equal(result.admin.rooms.some((room) => room.id === temporaryAdminRoomId), false);
    assert.deepEqual(result.admin.watchLevels.slice(0, 3).map((entry) => entry.name), ['初映小星', '抱枕观众', '爆米花搭子']);
    assert.equal((await admin.ack('admin-action', {
      action: 'add-registration-whitelist',
      ipAddress: '127.0.0.1'
    })).success, true);

    result = await admin.ack('account-action', {
      action: 'change-password',
      initialSetup: true,
      currentPassword: '',
      newPassword: 'admin-feature-2026'
    });
    assert.equal(result.success, true, result.error);
    adminToken = result.token;
    result = await admin.ack('account-action', { action: 'get-profile' });
    assert.equal(result.profile.mustChangePassword, false);
    console.log('✓ 内置 admin 超级管理员首次登录强制改密，并拥有最高房间权限');

    const owner = await connect();
    const viewer = await connect();
    const promoted = await connect();
    const memoryOwner = await connect();
    const banOwner = await connect();
    for (const [client, username] of [
      [owner, 'StarOwner'],
      [viewer, 'StarViewer'],
      [promoted, 'StarManager'],
      [memoryOwner, 'MemoryOwner'],
      [banOwner, 'BanOwner']
    ]) {
      result = await client.ack('user-register', { username, password: 'feature-pass' });
      assert.equal(result.success, true, `${username}: ${result.error || ''}`);
    }

    result = await admin.ack('admin-action', {
      action: 'set-room-creation-block',
      username: 'StarViewer',
      blocked: true
    });
    assert.equal(result.success, true, result.error);
    result = await viewer.ack('room-create', {
      username: 'StarViewer',
      password: 'feature-pass',
      customRoomId: 'DENY88',
      roomName: '不应创建'
    });
    assert.equal(result.success, false);
    assert.match(result.error, /禁止.*创建房间/);

    let ownerLogin = await owner.ack('room-create', {
      username: 'StarOwner',
      password: 'feature-pass',
      customRoomId: 'STAR88',
      roomName: '星光测试房',
      roomPassword: 'star-room-pass',
      maxUsers: 12,
      deviceName: '房主电脑'
    });
    assert.equal(ownerLogin.success, true, ownerLogin.error);
    assert.equal(ownerLogin.room.id, 'STAR88');
    assert.equal(ownerLogin.capabilities.owner, true);
    const ownerToken = ownerLogin.token;

    result = await owner.ack('room-create', { customRoomId: 'STAR99', roomName: '超额房间' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'ROOM_QUOTA_REACHED');
    result = await admin.ack('admin-action', { action: 'set-account-room-quota', username: 'StarOwner', roomQuota: 2 });
    assert.equal(result.success, true, result.error);

    result = await owner.ack('room-create', {
      customRoomId: 'STAR88',
      roomName: '重复房间'
    });
    assert.equal(result.success, false);
    assert.match(result.error, /已被使用/);

    let viewerLogin = await viewer.ack('user-login', {
      username: 'StarViewer', password: 'feature-pass'
    });
    assert.equal(viewerLogin.success, true, viewerLogin.error);
    assert.equal(viewerLogin.room.temporary, true);
    viewerLogin = await viewer.ack('user-login', {
      username: 'StarViewer',
      password: 'feature-pass',
      roomId: 'STAR88',
      roomPassword: 'star-room-pass',
      deviceName: '观众手机',
      platform: 'Android',
      browser: 'Chrome'
    });
    assert.equal(viewerLogin.success, true, viewerLogin.error);

    result = await admin.ack('admin-action', {
      action: 'set-super-admin',
      username: 'StarManager',
      enabled: true,
      forcePasswordChange: true
    });
    assert.equal(result.success, true, result.error);
    let promotedLogin = await promoted.ack('user-login', {
      username: 'StarManager',
      password: 'feature-pass',
      roomId: 'STAR88',
      deviceName: '远程管理电脑'
    });
    assert.equal(promotedLogin.success, true, promotedLogin.error);
    assert.equal(promotedLogin.capabilities.superAdmin, true);
    assert.equal(promotedLogin.capabilities.mustChangeAccountPassword, true);

    adminLogin = await admin.ack('room-switch', { roomId: 'STAR88' });
    assert.equal(adminLogin.success, true, adminLogin.error);
    assert.equal(adminLogin.capabilities.superAdmin, true);
    assert.equal(adminLogin.user.isAdmin, true);
    result = await admin.ack('room-refresh');
    assert.equal(result.users[0].username, 'StarOwner');
    assert.equal(result.users.some((entry) => entry.username === 'admin' && entry.isSuperAdmin && entry.isAdmin), true);
    assert.equal((await admin.ack('admin-action', { action: 'kick-user', targetSocketId: promoted.socket.id })).success, false);
    const publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.equal(publicConfig.clientIp, '127.0.0.1');
    let onlineRooms = await (await fetch(`${baseUrl}/api/online-rooms`)).json();
    assert.equal(onlineRooms.rooms.some((room) => room.id === 'STAR88' && room.online >= 4), true);
    for (let attempt = 0; attempt < 20 && onlineRooms.rooms.some((room) => room.id === temporaryAdminRoomId); attempt += 1) {
      await delay(25);
      onlineRooms = await (await fetch(`${baseUrl}/api/online-rooms`)).json();
    }
    assert.equal(onlineRooms.rooms.some((room) => room.id === temporaryAdminRoomId), false);
    console.log('✓ 自定义房间号、重复校验、建房限制、超管免密码进入和成员角色排序正常');

    const requestVideo = await uploadVideo(baseUrl, ownerToken, '申请播放测试.mp4');
    const playbackRequested = admin.next('playback-requested', (request) => request.username === 'StarViewer');
    result = await viewer.ack('request-playback', { fileId: requestVideo.id });
    assert.equal(result.success, true, result.error);
    const playRequest = await playbackRequested;
    const duplicateRequest = await viewer.ack('request-playback', { fileId: requestVideo.id });
    assert.equal(duplicateRequest.success, false);
    assert.equal(duplicateRequest.code, 'PLAYBACK_REQUEST_DUPLICATE');
    result = await admin.ack('playback-request-action', { requestId: playRequest.id, approved: true });
    assert.equal(result.success, true, result.error);
    result = await viewer.ack('room-refresh');
    assert.equal(result.room.playback.fileId, requestVideo.id);
    assert.equal(result.room.playback.isPlaying, true);
    console.log('✓ 无权限成员可申请播放，重复申请被拦截，批准后立即全房播放');

    const ownerVoiceJoined = owner.next('voice-peer-joined', (payload) => payload.peer?.username === 'StarViewer');
    result = await owner.ack('voice-room-join');
    assert.equal(result.success, true, result.error);
    result = await viewer.ack('voice-room-join');
    assert.equal(result.success, true, result.error);
    assert.equal(result.peers.some((peer) => peer.username === 'StarOwner'), true);
    await ownerVoiceJoined;
    const roomSignal = owner.next('voice-signal', (payload) => payload.fromSocketId === viewer.socket.id);
    result = await viewer.ack('voice-signal', {
      targetSocketId: owner.socket.id,
      description: { type: 'offer', sdp: 'room-voice-test' }
    });
    assert.equal(result.success, true, result.error);
    assert.equal((await roomSignal).description.sdp, 'room-voice-test');
    await owner.ack('voice-leave');
    await viewer.ack('voice-leave');

    const incomingCall = owner.next('voice-call-incoming', (call) => call.callerUsername === 'StarViewer');
    result = await viewer.ack('voice-call', { username: 'StarOwner' });
    assert.equal(result.success, true, result.error);
    const call = await incomingCall;
    const callResolved = viewer.next('voice-call-resolved', (payload) => payload.callId === call.id && payload.accepted);
    result = await owner.ack('voice-call-response', { callId: call.id, accepted: true });
    assert.equal(result.success, true, result.error);
    assert.equal((await callResolved).peer.username, 'StarOwner');
    const privateSignal = viewer.next('voice-signal', (payload) => payload.fromSocketId === owner.socket.id);
    result = await owner.ack('voice-signal', {
      targetSocketId: viewer.socket.id,
      candidate: { candidate: 'private-voice-test' }
    });
    assert.equal(result.success, true, result.error);
    assert.equal((await privateSignal).candidate.candidate, 'private-voice-test');
    await owner.ack('voice-leave');
    console.log('✓ 全麦、私聊邀请和 WebRTC 信令只在目标房间与目标成员间转发');

    const passwordRequired = viewer.next('room-password-verification-required');
    result = await owner.ack('admin-action', {
      action: 'set-access-password',
      accessPassword: 'star-room-pass-2'
    });
    assert.equal(result.success, true, result.error);
    await passwordRequired;
    result = await viewer.ack('room-refresh');
    assert.equal(result.success, false);
    assert.match(result.error, /密码.*更新|重新验证/);
    assert.equal((await viewer.ack('room-password-verify', { roomPassword: 'wrong-pass' })).success, false);
    assert.equal((await viewer.ack('room-password-verify', { roomPassword: 'star-room-pass-2' })).success, true);
    console.log('✓ 房间改密后在线普通成员必须重新验证，超级管理员保持最高访问权');

    viewer.socket.emit('watch-progress', {
      fileId: requestVideo.id,
      currentTime: 30,
      duration: 120,
      watchedSeconds: 30
    });
    viewer.socket.emit('watch-progress', {
      fileId: requestVideo.id,
      currentTime: 60,
      duration: 120,
      watchedSeconds: 30
    });
    await delay(80);
    result = await viewer.ack('account-action', { action: 'get-profile' });
    assert.equal(result.profile.experience, 1);
    assert.equal(result.profile.stats.watchSeconds, 60);
    result = await admin.ack('admin-action', {
      action: 'set-account-level',
      username: 'StarViewer',
      experience: 300,
      levelOverride: 7
    });
    assert.equal(result.success, true, result.error);
    assert.equal(result.profile.level, 7);
    assert.equal(result.profile.levelName, '光影收藏家');
    result = await admin.ack('admin-action', {
      action: 'set-account-level', username: 'StarViewer', experience: 420, levelOverride: 0,
      registrationDays: 30, onlineSeconds: 7200, signature: '同步观影测试签名'
    });
    assert.equal(result.success, true, result.error);
    assert.equal(result.profile.registrationDays, 30);
    assert.ok(result.profile.onlineSeconds >= 7200);
    assert.equal(result.profile.signature, '同步观影测试签名');
    result = await admin.ack('admin-action', { action: 'set-default-account-password', newPassword: 'default-feature-pass' });
    assert.equal(result.success, true, result.error);
    result = await admin.ack('admin-action', { action: 'batch-account-action', batchAction: 'block-rooms', usernames: ['StarViewer'] });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.completed, ['StarViewer']);
    result = await admin.ack('admin-action', { action: 'save-permission-group', groupId: 'family_test', name: '家庭测试组', control: true, upload: true, voiceChat: true });
    assert.equal(result.success, true, result.error);
    result = await admin.ack('admin-action', { action: 'set-permissions', username: 'StarViewer', groupId: 'family_test', control: true, upload: true, voiceChat: true });
    assert.equal(result.success, true, result.error);
    result = await admin.ack('admin-action', { action: 'delete-permission-group', groupId: 'family_test' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'PERMISSION_GROUP_IN_USE');
    result = await admin.ack('admin-action', { action: 'delete-permission-group', groupId: 'family_test', forceRemoveMembers: true });
    assert.equal(result.success, true, result.error);
    result = await admin.ack('queue-action', { action: 'set-file-mode', fileId: requestVideo.id, mode: 'single' });
    assert.equal(result.success, true, result.error);
    assert.equal((await admin.ack('room-refresh')).room.queueFileModes[requestVideo.id].mode, 'single');
    result = await admin.ack('admin-action', { action: 'set-account-remark', username: 'StarViewer', remark: '客厅电视' });
    assert.equal(result.success, true, result.error);
    result = await admin.ack('member-location-list');
    assert.equal(result.success, true, result.error);
    assert.equal(result.members.find((member) => member.username === 'StarViewer').adminRemark, '客厅电视');
    console.log('✓ 观看时间累计经验，后台可修改经验并固定观看等级');

    result = await admin.ack('admin-action', { action: 'get-settings' });
    const starRoom = result.admin.rooms.find((room) => room.id === 'STAR88');
    assert.ok(starRoom);
    assert.equal(starRoom.online >= 4, true);
    assert.equal(starRoom.playback.fileName, '申请播放测试.mp4');
    assert.equal(starRoom.members.some((member) => member.username === 'StarViewer' && member.deviceName === '观众手机'), true);

    const playbackBeforeOwnerDisconnect = (await viewer.ack('room-refresh')).room.playback;
    owner.close();
    await delay(180);
    const playbackAfterOwnerDisconnect = (await viewer.ack('room-refresh')).room.playback;
    assert.equal(playbackAfterOwnerDisconnect.isPlaying, true);
    assert.equal(playbackAfterOwnerDisconnect.stalled, false);
    assert.ok(playbackAfterOwnerDisconnect.currentTime > playbackBeforeOwnerDisconnect.currentTime + 0.1);
    console.log('✓ 房主退出后房间继续播放，服务器全局房间详情包含成员、设备和当前影片');

    let memoryLogin = await memoryOwner.ack('room-create', {
      username: 'MemoryOwner',
      password: 'feature-pass',
      customRoomId: 'MEMRY9',
      roomName: '记忆播放测试房'
    });
    assert.equal(memoryLogin.success, true, memoryLogin.error);
    const memoryToken = memoryLogin.token;
    const memoryVideo = await uploadVideo(baseUrl, memoryToken, '记忆位置测试.mp4');
    assert.equal((await memoryOwner.ack('select-file', { fileId: memoryVideo.id })).success, true);
    assert.equal((await memoryOwner.ack('playback-command', {
      action: 'seek',
      currentTime: 12.5,
      volume: 0.8
    })).success, true);
    const logoutResponse = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: auth(memoryToken)
    });
    assert.equal(logoutResponse.status, 200);
    await delay(320);
    result = await admin.ack('admin-action', { action: 'get-settings' });
    const closedMemoryRoom = result.admin.rooms.find((room) => room.id === 'MEMRY9');
    assert.equal(closedMemoryRoom.closed, false);
    assert.equal(closedMemoryRoom.playback.isPlaying, true);
    assert.ok(closedMemoryRoom.playback.currentTime >= 12.4);

    const memoryReturn = await connect();
    memoryLogin = await memoryReturn.ack('user-login', {
      username: 'MemoryOwner',
      password: 'feature-pass',
      roomId: 'MEMRY9'
    });
    assert.equal(memoryLogin.success, true, memoryLogin.error);
    assert.equal(memoryLogin.room.closed, false);
    assert.equal(memoryLogin.room.playback.isPlaying, true);
    assert.ok(memoryLogin.room.playback.currentTime >= 12.4);
    console.log('✓ 主动退出立即清理在线状态且不关闭房间，再进入时从原播放位置继续');

    const banRoom = await banOwner.ack('room-create', {
      username: 'BanOwner',
      password: 'feature-pass',
      customRoomId: 'BAN888',
      roomName: '服务器管理测试房'
    });
    assert.equal(banRoom.success, true, banRoom.error);
    result = await admin.ack('admin-action', { action: 'set-account-room-quota', username: 'BanOwner', roomQuota: 2 });
    assert.equal(result.success, true, result.error);
    const secondBanRoom = await banOwner.ack('room-create', {
      customRoomId: 'BAN889', roomName: '批量删除测试房'
    });
    assert.equal(secondBanRoom.success, true, secondBanRoom.error);
    result = await admin.ack('admin-action', { action: 'delete-rooms', roomIds: ['BAN888', 'BAN889'], confirmation: '错误文字' });
    assert.equal(result.success, false);
    result = await admin.ack('admin-action', { action: 'delete-rooms', roomIds: ['BAN888', 'BAN889'], confirmation: '我已知道这个风险' });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(new Set(result.deleted), new Set(['BAN888', 'BAN889']));
    result = await admin.ack('admin-action', { action: 'get-settings' });
    assert.equal(result.admin.rooms.some((room) => ['BAN888', 'BAN889'].includes(room.id)), false);
    console.log('✓ 服务器超级管理员不可被移出，并可查看及批量删除任意房间');

    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(config.accounts.admin.passwordHash.includes('admin-feature-2026'), false);
    assert.equal(Object.values(config.accounts).some((account) => Object.hasOwn(account, 'password')), false);
    assert.equal(fs.existsSync(path.join(dataDir, '数据目录说明.txt')), true);
    assert.equal(adminToken.length >= 32, true);
    console.log('✓ 密码仅保存安全哈希，数据目录说明文件会自动生成');

    result = await admin.ack('admin-action', { action: 'factory-reset', confirmation: '错误文字' });
    assert.equal(result.success, false);
    result = await admin.ack('admin-action', { action: 'factory-reset', confirmation: '我已知道这个风险' }, 20000);
    assert.equal(result.success, true, result.error);
    await delay(120);
    const resetConfig = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.deepEqual(Object.keys(resetConfig.accounts), ['admin']);
    assert.equal(resetConfig.accounts.admin.mustChangePassword, true);
    assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 0);
    console.log('✓ 恢复出厂设置要求风险确认，并清空全部服务器数据与缓存');

    console.log('\n全部 v2.2.0 功能检查通过。');
  } finally {
    for (const client of clients) client.close();
    if (server) await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('\nv2.2.0 功能检查失败:', error);
  process.exitCode = 1;
});
