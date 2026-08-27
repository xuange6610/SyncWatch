'use strict';

require('./epipe-guard');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

function ack(socket, event, payload = {}, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeout);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result || { success: false, error: 'empty acknowledgement' });
    });
  });
}

function nextEvent(socket, event, predicate = () => true, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`${event} timed out`));
    }, timeout);
    const listener = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 12000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

async function acceptAgreement(socket, auth) {
  if (auth?.success && auth.capabilities?.agreementRequired) {
    const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: auth.agreement.version });
    assert.equal(accepted.success, true, accepted.error);
  }
  return auth;
}

async function register(socket, username, password) {
  const result = await ack(socket, 'user-register', { username, password });
  assert.equal(result.success, true, result.error);
}

async function login(socket, username, password, roomId) {
  const result = await acceptAgreement(socket, await ack(socket, 'user-login', {
    username, password, roomId, deviceId: `${username}-v224`
  }));
  assert.equal(result.success, true, result.error);
  return result;
}

async function createRoom(socket, username, password, roomId, roomName) {
  const result = await acceptAgreement(socket, await ack(socket, 'room-create', {
    username, password, customRoomId: roomId, roomName
  }));
  assert.equal(result.success, true, result.error);
  return result;
}

async function uploadVideo(baseUrl, token, filename, content) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(content)], { type: 'video/mp4' }), filename);
  const response = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
  });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  assert.equal(result.success, true, result.error);
  return result.file;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-v224-backend-'));
  const dataDir = path.join(root, 'SyncWatch同步观影-Data');
  const sockets = [];
  let server;
  try {
    server = await startSyncWatchServer({
      port: 0, host: '127.0.0.1', dataDir, discovery: false,
      publicDir: path.resolve(__dirname, '..', 'public'), ffmpegPath: '', ffprobePath: '',
      hostControlToken: 'v224-host'
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const ordinaryPublicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    const systemRoomId = ordinaryPublicConfig.roomId;
    assert.deepEqual(ordinaryPublicConfig.addresses, [],
      'ordinary client public-config must not expose server LAN addresses');
    assert.equal(ordinaryPublicConfig.publicAddress, '',
      'ordinary clients without a trusted public origin must fail closed instead of falling back to LAN');

    const admin = await connect(baseUrl); sockets.push(admin);
    const adminAuth = await acceptAgreement(admin, await ack(admin, 'host-admin-login', {
      adminPassword: 'admin888', hostToken: 'v224-host', roomId: systemRoomId, deviceId: 'v224-admin'
    }));
    assert.equal(adminAuth.success, true, adminAuth.error);
    assert.equal((await ack(admin, 'admin-action', { action: 'add-registration-whitelist', ipAddress: '127.0.0.1' })).success, true);

    const setup = await connect(baseUrl); sockets.push(setup);
    await register(setup, 'SourceOwner', 'source-pass');
    await register(setup, 'TargetOwner', 'target-pass');
    await register(setup, 'RoomMember', 'member-pass');
    await register(setup, 'DelegatedAdmin', 'delegated-pass');
    await register(setup, 'LateWebViewer', 'late-web-pass');
    await register(setup, '符号 名!@#', '!');

    let source = await connect(baseUrl); sockets.push(source);
    let sourceAuth = await createRoom(source, 'SourceOwner', 'source-pass', 'SOURCE24', '源房间');
    const target = await connect(baseUrl); sockets.push(target);
    const targetAuth = await createRoom(target, 'TargetOwner', 'target-pass', 'TARGET24', '目标房间');
    assert.equal((await ack(admin, 'admin-action', {
      action: 'set-account-room-quota', username: 'TargetOwner', roomQuota: 3
    })).success, true);
    const member = await connect(baseUrl); sockets.push(member);
    await login(member, 'RoomMember', 'member-pass', sourceAuth.room.id);

    const viewPreferences = await ack(member, 'account-action', {
      action: 'set-view-preferences', conciseMode: true, chatOnly: true,
      danmakuColor: '#12abef', danmakuFontSize: 31
    });
    assert.equal(viewPreferences.success, true, viewPreferences.error);
    assert.deepEqual(viewPreferences.profile.viewPreferences, {
      conciseMode: true, chatOnly: true, danmakuColor: '#12abef', danmakuFontSize: 31
    });
    let conciseMemberSawScreenNotice = false;
    member.on('screen-notice', () => { conciseMemberSawScreenNotice = true; });
    const ownerScreenNotice = nextEvent(source, 'screen-notice');
    const screenNotice = await ack(source, 'screen-notice', { text: '简洁模式不应显示这条公告' });
    assert.equal(screenNotice.success, true, screenNotice.error);
    assert.equal((await ownerScreenNotice).text, '简洁模式不应显示这条公告');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(conciseMemberSawScreenNotice, false, 'concise mode must suppress direct screen notices');

    const remoteA = await ack(source, 'add-remote-video', { url: 'https://media.example.test/a.mp4', name: 'a.mp4' });
    const remoteB = await ack(source, 'add-remote-video', { url: 'https://media.example.test/b.mp4', name: 'b.mp4' });
    assert.equal(remoteA.success, true, remoteA.error);
    assert.equal(remoteB.success, true, remoteB.error);
    const duplicateRenameResponse = await fetch(`${baseUrl}/api/files/rename/batch`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${sourceAuth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ renames: [
        { fileId: remoteA.file.id, originalName: '重复名称.mp4' },
        { fileId: remoteB.file.id, originalName: '重复名称.mp4' }
      ] })
    });
    assert.equal(duplicateRenameResponse.status, 409, 'batch rename must reject duplicate output atomically');
    const unchangedAfterConflict = await (await fetch(`${baseUrl}/api/files`, {
      headers: { Authorization: `Bearer ${sourceAuth.token}` }
    })).json();
    assert.equal(unchangedAfterConflict.find((file) => file.id === remoteA.file.id)?.originalName, 'a.mp4');
    assert.equal(unchangedAfterConflict.find((file) => file.id === remoteB.file.id)?.originalName, 'b.mp4');
    const batchRenameResponse = await fetch(`${baseUrl}/api/files/rename/batch`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${sourceAuth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ renames: [
        { fileId: remoteA.file.id, originalName: '银幕典藏-01.mp4' },
        { fileId: remoteB.file.id, originalName: '银幕典藏-02' }
      ] })
    });
    const batchRename = await batchRenameResponse.json();
    assert.equal(batchRenameResponse.status, 200, batchRename.error);
    assert.equal(batchRename.renamed, 2);
    assert.deepEqual(batchRename.files.map((file) => file.originalName), ['银幕典藏-01.mp4', '银幕典藏-02.mp4'],
      'batch rename must preserve a missing source extension');
    const clearedInitialQueue = await ack(source, 'queue-action', { action: 'batch-remove', fileIds: [remoteA.file.id, remoteB.file.id] });
    assert.equal(clearedInitialQueue.success, true, clearedInitialQueue.error);
    const batched = await ack(source, 'queue-action', { action: 'batch-add', fileIds: [remoteA.file.id, remoteB.file.id, remoteA.file.id] });
    assert.equal(batched.success, true, batched.error);
    assert.deepEqual(batched.added.sort(), [remoteA.file.id, remoteB.file.id].sort());
    assert.equal(batched.queue.length, 2);
    const batchRemoved = await ack(source, 'queue-action', { action: 'batch-remove', fileIds: [remoteB.file.id] });
    assert.equal(batchRemoved.success, true, batchRemoved.error);
    assert.deepEqual(batchRemoved.removed, [remoteB.file.id]);

    const skipEvent = nextEvent(member, 'room-skip-settings-updated');
    const skip = await ack(source, 'room-playback-skip-settings', { enabled: true, introSeconds: 45, outroSeconds: 80 });
    assert.equal(skip.success, true, skip.error);
    assert.deepEqual(skip.skipSettings, { enabled: true, introSeconds: 45, outroSeconds: 80 });
    assert.deepEqual((await skipEvent).skipSettings, skip.skipSettings);

    const permission = await ack(source, 'admin-action', {
      action: 'set-permissions', username: 'RoomMember', groupId: 'member',
      control: false, seek: true, upload: true, voiceChat: true
    });
    assert.equal(permission.success, true, permission.error);
    assert.equal(permission.permissions.seek, true);
    assert.equal(permission.permissions.control, false);
    assert.equal((await ack(source, 'select-file', { fileId: remoteA.file.id })).success, true);
    const seek = await ack(member, 'playback-command', { action: 'seek', currentTime: 90 });
    assert.equal(seek.success, true, seek.error);
    assert.equal((await ack(member, 'playback-command', { action: 'pause', currentTime: 90 })).success, false,
      'seek permission must not silently grant play/pause control');

    const fullControl = await ack(source, 'admin-action', {
      action: 'set-permissions', username: 'RoomMember', groupId: 'member',
      control: true, seek: true, upload: true, voiceChat: true
    });
    assert.equal(fullControl.success, true, fullControl.error);
    const rateBroadcast = nextEvent(source, 'playback-command', (value) => value.action === 'playback-rate');
    const rate = await ack(member, 'playback-command', { action: 'playback-rate', playbackRate: 1.75 });
    assert.equal(rate.success, true, rate.error);
    assert.equal(rate.change.after.playbackRate, 1.75);
    assert.equal((await rateBroadcast).playbackRate, 1.75);

    const qualityPrompt = nextEvent(member, 'quality-change-requested');
    const qualityRequest = await ack(source, 'quality-change-request', { username: 'RoomMember', quality: 'smooth' });
    assert.equal(qualityRequest.success, true, qualityRequest.error);
    const qualityRequested = await qualityPrompt;
    assert.equal(qualityRequested.quality, 'smooth');
    const qualityResolved = nextEvent(source, 'quality-change-resolved', (value) => value.requestId === qualityRequested.id);
    const qualityResponse = await ack(member, 'quality-change-response', { requestId: qualityRequested.id, accepted: true });
    assert.equal(qualityResponse.success, true, qualityResponse.error);
    assert.equal((await qualityResolved).accepted, true);

    const shared = await ack(source, 'web-share-start', { url: 'https://example.com/watch-together', title: '同步网页' });
    assert.equal(shared.success, true, shared.error);
    assert.equal(shared.webShare.active, true);
    assert.ok(shared.webShare.revision >= 1);
    const recoveredWebShare = await ack(member, 'web-share-state-request');
    assert.equal(recoveredWebShare.success, true, recoveredWebShare.error);
    assert.equal(recoveredWebShare.webShare.url, 'https://example.com/watch-together');
    assert.equal(recoveredWebShare.webShare.revision, shared.webShare.revision);
    const lateViewer = await connect(baseUrl); sockets.push(lateViewer);
    const lateWebShareEvent = nextEvent(lateViewer, 'web-share-state', (value) => (
      value.roomId === sourceAuth.room.id && value.url === 'https://example.com/watch-together'
    ));
    const lateViewerAuth = await login(lateViewer, 'LateWebViewer', 'late-web-pass', sourceAuth.room.id);
    assert.equal(lateViewerAuth.room.webShare.revision, shared.webShare.revision);
    assert.equal((await lateWebShareEvent).revision, shared.webShare.revision,
      'a member joining after sharing starts must receive the authoritative web-share revision');

    const copiedGroup = await ack(source, 'admin-action', {
      action: 'save-permission-group', groupId: 'copy-editors', name: '可复制协管组',
      control: true, seek: true, upload: true, delete: false, manageMedia: false,
      shareScreen: false, shareAudio: false, shareWeb: true, voiceChat: true,
      manageChat: true, manageRoom: false, sendNotice: false
    });
    assert.equal(copiedGroup.success, true, copiedGroup.error);
    const copiedMemberPermission = await ack(source, 'admin-action', {
      action: 'set-permissions', username: 'RoomMember', groupId: 'copy-editors',
      control: true, seek: true, upload: true, delete: false, manageMedia: false,
      shareScreen: false, shareAudio: false, shareWeb: true, voiceChat: true,
      manageChat: true, manageRoom: false, sendNotice: false
    });
    assert.equal(copiedMemberPermission.success, true, copiedMemberPermission.error);
    const mediaManagementRequest = await ack(member, 'media-management-request', { reason: '验证复制媒体授权' });
    assert.equal(mediaManagementRequest.success, true, mediaManagementRequest.error);
    const mediaManagementGrant = await ack(source, 'admin-action', {
      action: 'resolve-media-management-request', requestId: mediaManagementRequest.request.id, approved: true
    });
    assert.equal(mediaManagementGrant.success, true, mediaManagementGrant.error);
    assert.equal(mediaManagementGrant.granted, true);

    const copiedEvent = nextEvent(source, 'room-copy-requested');
    const copyRequest = await ack(target, 'room-copy-request', { sourceRoomId: sourceAuth.room.id, requestedRoomName: '复制后的源房间' });
    assert.equal(copyRequest.success, true, copyRequest.error);
    assert.equal((await copiedEvent).id, copyRequest.request.id);
    const copyApproved = await ack(source, 'room-copy-request-action', { requestId: copyRequest.request.id, approved: true }, 30000);
    assert.equal(copyApproved.success, true, copyApproved.error);
    assert.notEqual(copyApproved.room.id, sourceAuth.room.id);
    assert.equal(copyApproved.room.ownerUsername, 'TargetOwner');
    assert.equal(copyApproved.copiedFiles, 2);
    const stateAfterConfiguredCopy = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const copiedRoomConfig = stateAfterConfiguredCopy.rooms[copyApproved.room.id];
    assert.deepEqual(copiedRoomConfig.permissionGroups['copy-editors'], stateAfterConfiguredCopy.rooms.SOURCE24.permissionGroups['copy-editors'],
      'room copy must preserve custom permission-group definitions');
    assert.equal(copiedRoomConfig.memberGroups.RoomMember, 'copy-editors',
      'room copy must preserve member-to-group assignments');
    assert.deepEqual(copiedRoomConfig.permissions.RoomMember, stateAfterConfiguredCopy.rooms.SOURCE24.permissions.RoomMember,
      'room copy must preserve explicit member permission overrides');
    assert.equal(copiedRoomConfig.mediaManagementGrants.RoomMember, true,
      'room copy must preserve media-management grants');

    source.disconnect();
    const offlineOwnerRequest = await ack(target, 'room-copy-request', {
      sourceRoomId: sourceAuth.room.id, requestedRoomName: '离线房主待处理副本', reason: '验证重登管理中心'
    });
    assert.equal(offlineOwnerRequest.success, true, offlineOwnerRequest.error);
    assert.match(offlineOwnerRequest.message, /已记录|上线后/);
    source = await connect(baseUrl); sockets.push(source);
    sourceAuth = await login(source, 'SourceOwner', 'source-pass', sourceAuth.room.id);
    const sourceOwnerSettings = await ack(source, 'admin-action', { action: 'get-settings' });
    assert.equal(sourceOwnerSettings.success, true, sourceOwnerSettings.error);
    assert.ok(sourceOwnerSettings.admin.roomCopyRequests.some((request) => (
      request.id === offlineOwnerRequest.request.id && request.status === 'pending'
    )), 'source owner must see offline copy requests after signing back into the management center');
    const deniedOfflineRequest = await ack(source, 'room-copy-request-action', {
      requestId: offlineOwnerRequest.request.id, approved: false
    });
    assert.equal(deniedOfflineRequest.success, true, deniedOfflineRequest.error);

    const unauthorizedMigration = await ack(source, 'admin-action', {
      action: 'migrate-room', sourceRoomId: sourceAuth.room.id, targetRoomId: targetAuth.room.id,
      confirmation: `迁移覆盖 ${targetAuth.room.id}`
    }, 30000);
    assert.equal(unauthorizedMigration.success, false,
      'ordinary room owners must not be able to migrate or overwrite another room');
    const migrated = await ack(admin, 'admin-action', {
      action: 'migrate-room', sourceRoomId: sourceAuth.room.id, targetRoomId: targetAuth.room.id,
      confirmation: `迁移覆盖 ${targetAuth.room.id}`
    }, 30000);
    assert.equal(migrated.success, true, migrated.error);
    assert.equal(migrated.room.id, targetAuth.room.id);
    assert.equal(migrated.room.ownerUsername, 'TargetOwner', 'migration must retain target identity and ownership');
    assert.equal(migrated.copiedFiles, 2);

    assert.equal((await ack(admin, 'admin-action', {
      action: 'set-account-room-quota', username: 'TargetOwner', roomQuota: 5
    })).success, true);
    const localA = await uploadVideo(baseUrl, sourceAuth.token, 'copy-local-a.mp4', 'local-media-a');
    const localB = await uploadVideo(baseUrl, sourceAuth.token, 'copy-local-b.mp4', 'local-media-b');
    const localCopyRequest = await ack(target, 'room-copy-request', {
      sourceRoomId: sourceAuth.room.id, requestedRoomName: '本地媒体完整副本'
    });
    assert.equal(localCopyRequest.success, true, localCopyRequest.error);
    const localCopy = await ack(source, 'room-copy-request-action', {
      requestId: localCopyRequest.request.id, approved: true
    }, 30000);
    assert.equal(localCopy.success, true, localCopy.error);
    assert.equal(localCopy.copiedFiles, 4);
    const afterLocalCopy = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const copiedLocalA = afterLocalCopy.files.find((file) => file.roomId === localCopy.room.id && file.originalName === localA.originalName);
    const copiedLocalB = afterLocalCopy.files.find((file) => file.roomId === localCopy.room.id && file.originalName === localB.originalName);
    assert.ok(copiedLocalA && copiedLocalB, 'copied room must retain both local media records');
    assert.notEqual(copiedLocalA.storedName, localA.storedName, 'local media copies require a fresh storage name');
    assert.notEqual(copiedLocalB.storedName, localB.storedName, 'local media copies require a fresh storage name');
    assert.equal(fs.readFileSync(path.join(dataDir, 'uploads', copiedLocalA.storedName), 'utf8'), 'local-media-a');
    assert.equal(fs.readFileSync(path.join(dataDir, 'uploads', copiedLocalB.storedName), 'utf8'), 'local-media-b');

    // Make the second source artifact unavailable after the first artifact can be
    // copied. The failed transaction must remove that partial clone and must not
    // create a room or mutate the source room.
    fs.rmSync(path.join(dataDir, 'uploads', localB.storedName));
    const roomsBeforeFailedCopy = Object.keys(afterLocalCopy.rooms).sort();
    const filesBeforeFailedCopy = fs.readdirSync(path.join(dataDir, 'uploads')).sort();
    const failedCopyRequest = await ack(target, 'room-copy-request', {
      sourceRoomId: sourceAuth.room.id, requestedRoomName: '不应出现的残缺副本'
    });
    assert.equal(failedCopyRequest.success, true, failedCopyRequest.error);
    const failedCopy = await ack(source, 'room-copy-request-action', {
      requestId: failedCopyRequest.request.id, approved: true
    }, 30000);
    assert.equal(failedCopy.success, false);
    assert.equal(failedCopy.code, 'ROOM_COPY_FAILED');
    const afterFailedCopy = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.deepEqual(Object.keys(afterFailedCopy.rooms).sort(), roomsBeforeFailedCopy,
      'failed copy must not leave a destination room');
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads')).sort(), filesBeforeFailedCopy,
      'failed copy must remove partially copied local media artifacts');
    assert.ok(afterFailedCopy.files.some((file) => file.id === localA.id && file.roomId === sourceAuth.room.id),
      'failed copy must preserve source room records');

    const promoted = await ack(admin, 'admin-action', {
      action: 'set-super-admin', username: 'DelegatedAdmin', enabled: true, forcePasswordChange: true
    });
    assert.equal(promoted.success, true, promoted.error);
    const delegated = await connect(baseUrl); sockets.push(delegated);
    const delegatedAuth = await login(delegated, 'DelegatedAdmin', 'delegated-pass', sourceAuth.room.id);
    assert.equal(delegatedAuth.capabilities.mustChangeAccountPassword, false,
      'only the built-in admin may have the first-login forced password change');

    let memberSawLocation = false;
    let delegatedSawLocation = false;
    member.on('member-location-status', () => { memberSawLocation = true; });
    delegated.on('member-location-status', () => { delegatedSawLocation = true; });
    const adminLocation = nextEvent(admin, 'member-location-status', (value) => value.username === 'RoomMember');
    assert.equal((await ack(member, 'member-location', { status: 'unavailable' })).success, true);
    assert.equal((await adminLocation).status, 'unavailable');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(memberSawLocation, false);
    assert.equal(delegatedSawLocation, false, 'delegated super admins must not receive sensitive system notices');

    const attacker = await connect(baseUrl); sockets.push(attacker);
    assert.equal((await ack(admin, 'admin-action', { action: 'remove-registration-whitelist', ipAddress: '127.0.0.1' })).success, true);
    const registrationRequest = await ack(attacker, 'registration-request', {
      username: 'RequestedV224', requestedCount: 3, reason: '三项申请后撤回一项'
    });
    assert.equal(registrationRequest.success, true, registrationRequest.error);
    assert.equal(registrationRequest.request.requestedCount, 3);
    assert.equal(registrationRequest.request.totalRequestedCount, 3);
    assert.equal(registrationRequest.request.remainingCount, 3);
    const invalidWithdraw = await ack(attacker, 'registration-request-withdraw', {
      requestId: registrationRequest.request.id, username: 'RequestedV224', withdrawCount: 4
    });
    assert.equal(invalidWithdraw.success, false, 'withdrawal must reject counts above the remaining amount');
    const withdrawn = await ack(attacker, 'registration-request-withdraw', {
      requestId: registrationRequest.request.id, username: 'RequestedV224', withdrawCount: 1
    });
    assert.equal(withdrawn.success, true, withdrawn.error);
    assert.equal(withdrawn.remainingCount, 2);
    assert.equal(withdrawn.totalRequestedCount, 3);
    assert.equal(withdrawn.withdrawnCount, 1);
    assert.equal(withdrawn.request.status, 'pending');
    const settingsAfterWithdraw = await ack(admin, 'admin-action', { action: 'get-settings' });
    const pendingAfterWithdraw = settingsAfterWithdraw.admin.registrationRequests
      .find((item) => item.id === registrationRequest.request.id);
    assert.equal(pendingAfterWithdraw.totalRequestedCount, 3);
    assert.equal(pendingAfterWithdraw.remainingCount, 2);
    const deletedRequest = await ack(admin, 'admin-action', {
      action: 'delete-registration-request', requestId: registrationRequest.request.id
    });
    assert.equal(deletedRequest.success, true, deletedRequest.error);
    assert.deepEqual(deletedRequest.deleted, [registrationRequest.request.id]);

    const fullyWithdrawnRequest = await ack(attacker, 'registration-request', {
      username: 'WithdrawAllV224', requestedCount: 2, reason: '全部撤回并保留审计记录'
    });
    assert.equal(fullyWithdrawnRequest.success, true, fullyWithdrawnRequest.error);
    const fullyWithdrawn = await ack(attacker, 'registration-request-withdraw', {
      requestId: fullyWithdrawnRequest.request.id, username: 'WithdrawAllV224', withdrawCount: 2
    });
    assert.equal(fullyWithdrawn.success, true, fullyWithdrawn.error);
    assert.equal(fullyWithdrawn.status, 'withdrawn');
    assert.equal(fullyWithdrawn.remainingCount, 0);
    assert.equal(fullyWithdrawn.totalRequestedCount, 2);
    assert.equal((await ack(attacker, 'registration-request-withdraw', {
      requestId: fullyWithdrawnRequest.request.id, username: 'WithdrawAllV224', withdrawCount: 1
    })).success, false, 'a fully withdrawn request cannot be withdrawn twice');

    const batchRequestA = await ack(attacker, 'registration-request', { username: 'BatchDeleteA', requestedCount: 1 });
    const batchRequestB = await ack(attacker, 'registration-request', { username: 'BatchDeleteB', requestedCount: 2 });
    assert.equal(batchRequestA.success, true, batchRequestA.error);
    assert.equal(batchRequestB.success, true, batchRequestB.error);
    const delegatedDelete = await ack(delegated, 'admin-action', {
      action: 'delete-registration-requests', requestIds: [batchRequestA.request.id, batchRequestB.request.id]
    });
    assert.equal(delegatedDelete.success, false, 'delegated super admins must not delete registration request history');
    const batchDeleted = await ack(admin, 'admin-action', {
      action: 'delete-registration-requests', requestIds: [batchRequestA.request.id, batchRequestB.request.id]
    });
    assert.equal(batchDeleted.success, true, batchDeleted.error);
    assert.equal(batchDeleted.count, 2);
    assert.deepEqual(new Set(batchDeleted.deleted), new Set([batchRequestA.request.id, batchRequestB.request.id]));

    let limited;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      limited = await ack(attacker, 'user-login', { username: 'NoSuchV224', password: 'wrong' });
    }
    assert.equal(limited.code, 'LOGIN_RATE_LIMITED');
    assert.equal(limited.canRequestClear, true);
    const limitRequestedEvent = nextEvent(admin, 'login-limit-clear-requested');
    const limitRequest = await ack(attacker, 'login-limit-clear-request', { username: 'NoSuchV224', reason: '测试解除' });
    assert.equal(limitRequest.success, true, limitRequest.error);
    assert.equal((await limitRequestedEvent).id, limitRequest.request.id);
    const settings = await ack(admin, 'admin-action', { action: 'get-settings' });
    assert.ok(settings.admin.loginLimitRequests.some((item) => item.id === limitRequest.request.id && item.status === 'pending'));
    assert.equal(settings.admin.passwordPolicy.mode, 'unrestricted');
    assert.equal(settings.admin.passwordPolicy.lengthRestricted, false);
    assert.ok(settings.admin.accounts.every((account) => !Object.hasOwn(account, 'passwordHash') && !Object.hasOwn(account, 'password')),
      'administrator account responses must expose password status only, never hashes or reversible credentials');
    const unrestrictedAccount = settings.admin.accounts.find((account) => account.username === '符号 名!@#');
    assert.equal(unrestrictedAccount.passwordStatus.configured, true);
    assert.equal(typeof unrestrictedAccount.passwordStatus.changedAt, 'string');
    const passwordSession = await connect(baseUrl); sockets.push(passwordSession);
    await login(passwordSession, '符号 名!@#', '!', sourceAuth.room.id);
    const passwordSessionDisconnected = new Promise((resolve) => passwordSession.once('disconnect', resolve));
    const passwordReset = await ack(admin, 'admin-action', {
      action: 'reset-account-password', username: '符号 名!@#', newPassword: '重置后的!密码'
    });
    assert.equal(passwordReset.success, true, passwordReset.error);
    await passwordSessionDisconnected;
    const oldPasswordClient = await connect(baseUrl); sockets.push(oldPasswordClient);
    assert.equal((await ack(oldPasswordClient, 'user-login', {
      username: '符号 名!@#', password: '!', roomId: sourceAuth.room.id
    })).success, false, 'an administrator password reset must invalidate the old password');
    const newPasswordClient = await connect(baseUrl); sockets.push(newPasswordClient);
    assert.equal((await login(newPasswordClient, '符号 名!@#', '重置后的!密码', sourceAuth.room.id)).success, true);
    const settingsAfterPasswordReset = await ack(admin, 'admin-action', { action: 'get-settings' });
    const resetAccount = settingsAfterPasswordReset.admin.accounts.find((account) => account.username === '符号 名!@#');
    assert.notEqual(resetAccount.passwordStatus.changedAt, unrestrictedAccount.passwordStatus.changedAt,
      'password status metadata must reflect the administrator reset time');
    assert.ok(settingsAfterPasswordReset.admin.accounts.every((account) => (
      !Object.hasOwn(account, 'passwordHash') && !Object.hasOwn(account, 'password')
    )));
    const limitResolved = nextEvent(attacker, 'login-limit-clear-resolved', (value) => value.requestId === limitRequest.request.id);
    const approved = await ack(admin, 'admin-action', { action: 'resolve-login-limit-request', requestId: limitRequest.request.id, approved: true });
    assert.equal(approved.success, true, approved.error);
    assert.equal((await limitResolved).approved, true);
    const afterClear = await ack(attacker, 'user-login', { username: 'NoSuchV224', password: 'wrong' });
    assert.notEqual(afterClear.code, 'LOGIN_RATE_LIMITED');

    await server.close(); server = null;
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(persisted.version, 13, 'v2.2.4 state migrations must persist the current schema version');
    assert.equal(persisted.accounts.RoomMember.viewPreferences.conciseMode, true);
    assert.equal(persisted.accounts.DelegatedAdmin.mustChangePassword, false);
    assert.deepEqual(persisted.rooms.SOURCE24.skipSettings, { enabled: true, introSeconds: 45, outroSeconds: 80 });
    assert.equal(persisted.rooms.SOURCE24.savedState.webShare.url, 'https://example.com/watch-together');
    assert.equal(persisted.rooms.SOURCE24.savedState.webShare.revision, shared.webShare.revision);
    const persistedWithdrawn = persisted.admin.registrationRequests
      .find((item) => item.id === fullyWithdrawnRequest.request.id);
    assert.equal(persistedWithdrawn.status, 'withdrawn');
    assert.equal(persistedWithdrawn.requestedCount, 0);
    assert.equal(persistedWithdrawn.remainingCount, 0);
    assert.equal(persistedWithdrawn.totalRequestedCount, 2);
    assert.ok(persisted.admin.loginLimitRequests.some((item) => item.status === 'approved'));
    server = await startSyncWatchServer({
      port: 0, host: '127.0.0.1', dataDir, discovery: false,
      publicDir: path.resolve(__dirname, '..', 'public'), ffmpegPath: '', ffprobePath: '',
      hostControlToken: 'v224-host-restart'
    });
    const restartedBaseUrl = `http://127.0.0.1:${server.port}`;
    const restoredViewer = await connect(restartedBaseUrl); sockets.push(restoredViewer);
    const restoredEvent = nextEvent(restoredViewer, 'web-share-state', (value) => (
      value.roomId === sourceAuth.room.id && value.url === 'https://example.com/watch-together'
    ));
    const restoredAuth = await login(restoredViewer, 'LateWebViewer', 'late-web-pass', sourceAuth.room.id);
    assert.equal(restoredAuth.room.webShare.revision, shared.webShare.revision);
    assert.equal((await restoredEvent).revision, shared.webShare.revision,
      'a process restart must retain and restore the authoritative web-share revision');
    await server.close(); server = null;
    console.log('v2.2.4 backend preferences, permissions, room transfer, queue, login unlock, registration security, web-share recovery and privacy contracts passed');
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('v2.2.4 backend contracts failed:', error);
  process.exitCode = 1;
});
