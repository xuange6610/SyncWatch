require('./epipe-guard');

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { startSyncWatchServer } = require('../server');

function ack(socket, event, payload = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} response timed out`)), timeout);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result || { success: false, error: 'empty response' });
    });
  });
}

function once(socket, event, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} event timed out`)), timeout);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForStableTask(socket, fileId, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastTask = null;
  while (Date.now() < deadline) {
    const result = await ack(socket, 'media-processing-status');
    assert.equal(result.success, true, result.error);
    lastTask = result.status.tasks.find((task) => task.id === fileId) || null;
    if (lastTask && !['queued', 'converting'].includes(lastTask.compatibility?.status)) return lastTask;
    await delay(100);
  }
  throw new Error(`media task did not become dismissible: ${JSON.stringify(lastTask)}`);
}

async function connect(baseUrl) {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket.IO connection timed out')), 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', reject);
  });
  return socket;
}

async function loginHost(socket, roomId) {
  const login = await ack(socket, 'host-admin-login', {
    adminPassword: 'admin888', roomId, hostToken: 'media-processing-host'
  });
  assert.equal(login.success, true, login.error);
  if (login.capabilities?.agreementRequired) {
    const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: login.agreement.version });
    assert.equal(accepted.success, true, accepted.error);
  }
  return login;
}

async function launch(dataDir) {
  return startSyncWatchServer({
    host: '127.0.0.1', port: 0, dataDir, discovery: false,
    publicDir: path.resolve(__dirname, '..', 'public'), hostControlToken: 'media-processing-host',
    ffprobePath: '', ffmpegPath: ''
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-media-processing-'));
  const dataDir = path.join(root, 'SyncWatch同步观影-Data');
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const preload = fs.readFileSync(path.resolve(__dirname, '..', 'electron-main-preload.js'), 'utf8');
  const electron = fs.readFileSync(path.resolve(__dirname, '..', 'electron-pink.js'), 'utf8');
  assert.match(html, /id="backgroundUploadBtn"/);
  assert.match(html, /id="mediaProcessingConcurrency"[\s\S]*value="3"/);
  assert.match(html, /id="mediaCompatibilityAutoConvert"[^>]*checked/);
  assert.match(html, /id="openConvertedMediaFolderBtn"/);
  assert.match(app, /playerSeekDragging[\s\S]*playerSeekTarget/);
  assert.match(app, /explicitTime\s*!==\s*null\s*&&\s*explicitTime\s*!==\s*undefined/);
  assert.match(app, /const attempts = action === 'seek' \? 2 : 1/);
  assert.match(app, /emitAck\('media-processing-cancel',\s*\{\s*taskId\s*\}/);
  assert.match(app, /data-media-processing-action="stop"/);
  const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(serverSource, /onSafe\('media-processing-cancel'/);
  assert.match(serverSource, /manualReason:\s*'user-stopped'/);
  assert.match(serverSource, /'-c:v',\s*'copy'/);
  assert.doesNotMatch(serverSource.match(/function compatibilityOutputArguments[\s\S]*?\n  }/)[0], /'-r',\s*'30'/);
  assert.match(preload, /openConvertedMediaFolder:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('syncwatch:open-compatible-media-folder'\)/);
  assert.match(electron, /event\.sender\s*!==\s*mainWindow\.webContents[\s\S]{0,500}compatible-media/);

  let server; let socket;
  try {
    server = await launch(dataDir);
    let baseUrl = `http://127.0.0.1:${server.port}`;
    let publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    socket = await connect(baseUrl);
    let hostLogin = await loginHost(socket, publicConfig.roomId);

    let status = await ack(socket, 'media-processing-status');
    assert.equal(status.success, true, status.error);
    assert.equal(status.status.concurrency, 3);
    assert.equal(status.status.autoConvert, true);
    assert.equal(status.status.maximumConcurrency, 8);
    assert.equal(status.status.canConfigure, true);
    assert.deepEqual(status.status.counts, { total: 0, converting: 0, queued: 0, manual: 0, completed: 0, failed: 0, unavailable: 0, native: 0 });

    const remote = await ack(socket, 'add-remote-video', {
      name: '保留影片的处理记录.mp4', url: 'https://example.com/keep-media.mp4'
    });
    assert.equal(remote.success, true, remote.error);
    const remoteFileId = remote.file.id;
    status = await ack(socket, 'media-processing-status');
    assert.equal(status.status.tasks.some((task) => task.id === remoteFileId), true);
    const dismissed = await ack(socket, 'media-processing-dismiss', { taskIds: [remoteFileId] });
    assert.equal(dismissed.success, true, dismissed.error);
    assert.equal(dismissed.status.tasks.some((task) => task.id === remoteFileId), false);
    const filesAfterDismiss = await (await fetch(`${baseUrl}/api/files`, {
      headers: { Authorization: `Bearer ${hostLogin.token}` }
    })).json();
    assert.equal(filesAfterDismiss.some((file) => file.id === remoteFileId), true,
      '删除处理记录不得删除影片或媒体索引');

    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([Buffer.from('media-processing-delete-source')], { type: 'video/mp4' }), 'delete-source.mp4');
    const uploadResponse = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${hostLogin.token}` }, body: uploadForm
    });
    const uploaded = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200, uploaded.error);
    assert.equal(uploaded.success, true, uploaded.error);
    await waitForStableTask(socket, uploaded.file.id);
    const deletedSource = await ack(socket, 'media-processing-dismiss', {
      taskIds: [uploaded.file.id], deleteSource: true
    }, 20000);
    assert.equal(deletedSource.success, true, deletedSource.error);
    assert.equal(deletedSource.sourceDeleted, 1);
    const filesAfterSourceDelete = await (await fetch(`${baseUrl}/api/files`, {
      headers: { Authorization: `Bearer ${hostLogin.token}` }
    })).json();
    assert.equal(filesAfterSourceDelete.some((file) => file.id === uploaded.file.id), false,
      'explicit source deletion must remove the media index');
    const operations = await ack(socket, 'operation-history', { limit: 100 });
    const sourceDeleteOperation = operations.operations.find((operation) =>
      operation.action === 'media-processing-source-delete' && operation.summary.includes('delete-source.mp4'));
    assert.equal(sourceDeleteOperation?.reversible, true,
      'source deletion must use the recoverable trash-backed operation path');
    const rollback = await ack(socket, 'rollback-operation', { operationId: sourceDeleteOperation.id });
    assert.equal(rollback.success, true, rollback.error);
    const filesAfterRollback = await (await fetch(`${baseUrl}/api/files`, {
      headers: { Authorization: `Bearer ${hostLogin.token}` }
    })).json();
    assert.equal(filesAfterRollback.some((file) => file.id === uploaded.file.id), true,
      'rolling back a source deletion must restore the media index and file');

    const invalid = await ack(socket, 'admin-action', { action: 'set-media-processing', concurrency: 0 });
    assert.equal(invalid.success, false);
    assert.match(invalid.error, /1-8/);

    const changedEvent = once(socket, 'media-processing-updated');
    const changed = await ack(socket, 'admin-action', { action: 'set-media-processing', concurrency: 5, autoConvert: false });
    assert.equal(changed.success, true, changed.error);
    assert.equal(changed.status.concurrency, 5);
    assert.equal(changed.status.autoConvert, false);
    assert.equal((await changedEvent).concurrency, 5);
    const settings = await ack(socket, 'admin-action', { action: 'get-settings' });
    assert.equal(settings.admin.mediaCompatibilityConcurrency, 5);
    assert.equal(settings.admin.mediaCompatibilityAutoConvert, false);

    socket.disconnect(); socket = null;
    await server.close(); server = null;
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).admin.mediaCompatibilityConcurrency, 5);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).admin.mediaCompatibilityAutoConvert, false);

    server = await launch(dataDir);
    baseUrl = `http://127.0.0.1:${server.port}`;
    publicConfig = await (await fetch(`${baseUrl}/api/public-config`)).json();
    socket = await connect(baseUrl);
    hostLogin = await loginHost(socket, publicConfig.roomId);
    status = await ack(socket, 'media-processing-status');
    assert.equal(status.status.concurrency, 5);
    assert.equal(status.status.autoConvert, false);
    assert.equal(status.status.tasks.some((task) => task.id === remoteFileId), false,
      '处理记录的清理状态应随账号持久化');
    const filesAfterRestart = await (await fetch(`${baseUrl}/api/files`, {
      headers: { Authorization: `Bearer ${hostLogin.token}` }
    })).json();
    assert.equal(filesAfterRestart.some((file) => file.id === remoteFileId), true,
      '服务器重启后影片仍应保留');
    console.log('✓ 媒体转换默认并发 3，1-8 立即调整与重启持久化验证通过');
    console.log('✓ 上传后台折叠、处理统计、安全打开转码目录与可靠 seek 回归检查通过');
  } finally {
    socket?.disconnect();
    if (server) await server.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
