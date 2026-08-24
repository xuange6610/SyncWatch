'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { io } = require('socket.io-client');
const iconv = require('iconv-lite');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { startSyncWatchServer } = require('../server');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const HOST_TOKEN = 'media-host';
const USERNAME = '媒体测试';
const PASSWORD = '123456';
const mediaRoomIds = new Map();

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function ack(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 超时`)), 10000);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function waitFor(check, { timeoutMs = 30000, intervalMs = 100, label = '等待条件' } = {}) {
  const startedAt = Date.now();
  let lastValue;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await check();
    if (lastValue) return lastValue;
    await delay(intervalMs);
  }
  throw new Error(`${label}超时${lastValue === undefined ? '' : `，最后状态：${JSON.stringify(lastValue)}`}`);
}

function runFfmpeg(label, args) {
  const result = spawnSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  assert.equal(result.status, 0, `${label}失败：\n${result.stderr || result.stdout}`);
}

function probeMedia(filename) {
  const result = spawnSync(ffprobePath, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filename
  ], { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `ffprobe 失败：${filename}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function mediaStreams(filename) {
  const info = probeMedia(filename);
  return {
    info,
    video: info.streams.find((stream) => stream.codec_type === 'video'),
    audio: info.streams.find((stream) => stream.codec_type === 'audio')
  };
}

function assertCompatibleOutput(filename) {
  const { video, audio } = mediaStreams(filename);
  assert.ok(video, '兼容版缺少视频流');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.ok(video.width <= 854, `流畅版宽度不应超过 854，实际为 ${video.width}`);
  assert.ok(video.height <= 480, `流畅版高度不应超过 480，实际为 ${video.height}`);
  assert.ok(audio, '带音轨的源影片转换后应保留音轨');
  assert.equal(audio.codec_name, 'aac');
  return { video, audio };
}

function fileSha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function readStateRecord(dataDir, fileId) {
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  return state.files.find((file) => file.id === fileId);
}

let sessionCounter = 0;

async function launchServer(dataDir, { register = false, ffprobe = ffprobePath, ffmpeg = ffmpegPath } = {}) {
  const server = await startSyncWatchServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    publicDir: PUBLIC_DIR,
    hostControlToken: HOST_TOKEN,
    mediaCompatibilityHardware: false,
    ffprobePath: ffprobe,
    ffmpegPath: ffmpeg
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const socket = io(baseUrl, { transports: ['websocket'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket.IO 连接超时')), 10000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  try {
    if (register) {
      const registration = await ack(socket, 'user-register', { username: USERNAME, password: PASSWORD });
      assert.equal(registration.success, true, registration.error);
    }
    const roomKey = path.resolve(dataDir);
    const onlineRooms = await (await fetch(`${baseUrl}/api/online-rooms`)).json();
    const knownRoomId = mediaRoomIds.get(roomKey);
    const roomId = onlineRooms.rooms?.some((room) => room.id === knownRoomId)
      ? knownRoomId
      : onlineRooms.rooms?.[0]?.id;
    sessionCounter += 1;
    const login = roomId
      ? await ack(socket, 'user-login', {
        username: USERNAME, password: PASSWORD, roomId, hostToken: HOST_TOKEN, deviceId: `media-test-${sessionCounter}`
      })
      : await ack(socket, 'room-create', {
        username: USERNAME, password: PASSWORD, roomName: '媒体兼容测试房间', maxUsers: 8,
        hostToken: HOST_TOKEN, deviceId: `media-test-${sessionCounter}`
      });
    assert.equal(login.success, true, login.error);
    mediaRoomIds.set(roomKey, login.room.id);
    if (login.capabilities?.agreementRequired) {
      const accepted = await ack(socket, 'agreement-accept', { accepted: true, version: login.agreement.version });
      assert.equal(accepted.success, true, accepted.error);
    }
    const uploadPolicy = await ack(socket, 'admin-action', {
      action: 'set-upload-policy', adminPassword: 'admin888', allowedUploadCategories: ['video', 'subtitle']
    });
    assert.equal(uploadPolicy.success, true, uploadPolicy.error);
    return { server, socket, baseUrl, headers: { Authorization: `Bearer ${login.token}` }, dataDir };
  } catch (error) {
    socket.close();
    await server.close().catch(() => {});
    throw error;
  }
}

async function stopServer(session) {
  if (!session) return;
  session.socket?.close();
  await session.server?.close();
}

async function listFiles(session) {
  const response = await fetch(`${session.baseUrl}/api/files`, { headers: session.headers });
  assert.equal(response.status, 200);
  return response.json();
}

async function verifyInterruptedUploadCleanup(session) {
  const beforeNames = new Set(fs.readdirSync(session.server.uploadsDir));
  const beforeIds = new Set((await listFiles(session)).map((file) => file.id));
  const boundary = `syncwatch-abort-${crypto.randomBytes(8).toString('hex')}`;
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="interrupted.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
    'utf8'
  );
  const declaredBodyBytes = 8 * 1024 * 1024;
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const target = new URL('/api/upload', session.baseUrl);
  const request = http.request(target, {
    method: 'POST',
    headers: {
      ...session.headers,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(preamble.length + declaredBodyBytes + epilogue.length)
    }
  });
  request.on('error', () => {});
  request.write(preamble);
  request.write(Buffer.alloc(256 * 1024, 0x5a));
  await waitFor(() => fs.readdirSync(session.server.uploadsDir).some((name) => !beforeNames.has(name)), {
    timeoutMs: 5000, intervalMs: 20, label: '等待中断上传临时文件'
  });
  request.destroy(new Error('test interrupted upload'));
  await waitFor(() => fs.readdirSync(session.server.uploadsDir).every((name) => beforeNames.has(name)), {
    timeoutMs: 10000, intervalMs: 25, label: '等待中断上传残片清理'
  });
  assert.equal((await listFiles(session)).some((file) => !beforeIds.has(file.id)), false, '中断上传不得写入影片索引');
  console.log('✓ 上传连接中途断开会清理磁盘残片，且不会写入影片索引');
}

async function waitForFile(session, fileId, predicate, options = {}) {
  let lastFile = null;
  return waitFor(async () => {
    lastFile = (await listFiles(session)).find((file) => file.id === fileId) || null;
    return lastFile && predicate(lastFile) ? lastFile : null;
  }, {
    timeoutMs: options.timeoutMs || 30000,
    intervalMs: options.intervalMs || 100,
    label: options.label || `等待媒体 ${fileId}`
  }).catch((error) => {
    error.message += `；最后文件状态：${JSON.stringify(lastFile)}`;
    throw error;
  });
}

async function uploadFile(session, filename, source, mimeType = 'video/mp4') {
  const contents = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  const form = new FormData();
  form.append('file', new Blob([contents], { type: mimeType }), filename);
  const response = await fetch(`${session.baseUrl}/api/upload`, {
    method: 'POST',
    headers: session.headers,
    body: form
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.success, true, body.error);
  return body.file;
}

async function deleteFile(session, fileId) {
  const response = await fetch(`${session.baseUrl}/api/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: session.headers
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.success, true, body.error);
  return body;
}

async function assertRangeResponse(session, mediaUrl, range, expectedStart, expectedEnd, totalSize) {
  const response = await fetch(`${session.baseUrl}${mediaUrl}`, {
    headers: { ...session.headers, Range: range }
  });
  const body = Buffer.from(await response.arrayBuffer());
  const contentRange = response.headers.get('content-range') || '';
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
  assert.ok(match, `${range} Content-Range 格式错误：${contentRange}`);
  const actualStart = Number(match[1]);
  const actualEnd = Number(match[2]);
  const actualTotal = Number(match[3]);
  const openEnded = /^bytes=\d+-$/.test(range);
  const expectedLength = actualEnd - actualStart + 1;
  assert.equal(response.status, 206, `${range} 应返回 206`);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(actualStart, expectedStart);
  assert.equal(actualTotal, totalSize);
  if (!openEnded) assert.equal(actualEnd, expectedEnd);
  else assert.ok(actualEnd <= expectedEnd, `${range} 不应超出请求上限`);
  assert.equal(Number(response.headers.get('content-length')), expectedLength);
  assert.equal(body.length, expectedLength, `${range} 响应体长度错误`);
  return body;
}

function createSamples(rootDir) {
  const nativeSample = path.join(rootDir, '测试影片.mp4');
  const highBitrateSample = path.join(rootDir, '高码率-H264.mp4');
  const hevc4kSample = path.join(rootDir, '4K-HEVC-10bit.mp4');
  const h264TenBitSample = path.join(rootDir, 'H264-10bit.mp4');

  runFfmpeg('生成 H.264 原生兼容样片', [
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', nativeSample
  ]);
  runFfmpeg('生成高码率 H.264 样片', [
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=480:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '4M', '-minrate', '4M', '-maxrate', '4M', '-bufsize', '8M',
    '-c:a', 'aac', '-shortest', highBitrateSample
  ]);
  runFfmpeg('生成 4K HEVC 10-bit 样片', [
    '-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=12:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=520:duration=4',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
    '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', hevc4kSample
  ]);
  runFfmpeg('生成 H.264 10-bit 样片', [
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=12:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=620:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high10',
    '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', '-shortest', h264TenBitSample
  ]);

  const hevcInput = mediaStreams(hevc4kSample);
  assert.equal(hevcInput.video.codec_name, 'hevc');
  assert.equal(hevcInput.video.width, 3840);
  assert.equal(hevcInput.video.height, 2160);
  assert.equal(hevcInput.video.pix_fmt, 'yuv420p10le');
  assert.equal(hevcInput.audio.codec_name, 'aac');

  const h264TenBitInput = mediaStreams(h264TenBitSample);
  assert.equal(h264TenBitInput.video.codec_name, 'h264');
  assert.equal(h264TenBitInput.video.pix_fmt, 'yuv420p10le');
  assert.equal(h264TenBitInput.audio.codec_name, 'aac');

  return { nativeSample, highBitrateSample, hevc4kSample, h264TenBitSample };
}

async function testPrimaryMediaFlow(rootDir, serverDataDir, samples) {
  let session = await launchServer(serverDataDir, { register: true });
  let hevcFile;
  let compatiblePath;
  let sourcePath;
  try {
    await verifyInterruptedUploadCleanup(session);
    const nativeUpload = await uploadFile(session, '测试影片.mp4', samples.nativeSample);
    const nativeFile = await waitForFile(session, nativeUpload.id, (file) => (
      file.metadata?.duration >= 3.5 && file.thumbnailUrl && file.compatibility?.status === 'native'
    ), { timeoutMs: 30000, label: '等待原生影片分析和缩略图' });
    assert.equal(nativeFile.metadata.width, 640);
    assert.equal(nativeFile.metadata.height, 360);
    assert.equal(nativeFile.metadata.videoCodec, 'H264');
    assert.equal(nativeFile.metadata.pixelFormat, 'yuv420p');
    const thumbnail = await fetch(`${session.baseUrl}${nativeFile.thumbnailUrl}`, { headers: session.headers });
    assert.equal(thumbnail.status, 200);
    assert.match(thumbnail.headers.get('content-type') || '', /image\/jpeg/);
    const thumbnailPath = path.join(serverDataDir, 'thumbnails', path.basename(nativeFile.thumbnailUrl));
    assert.ok(fs.statSync(thumbnailPath).size > 0, '缩略图文件必须非空');
    fs.unlinkSync(thumbnailPath);
    await stopServer(session);
    session = await launchServer(serverDataDir);
    const rebuiltThumbnailFile = await waitForFile(session, nativeFile.id, (file) => {
      if (!file.thumbnailUrl || !fs.existsSync(thumbnailPath)) return false;
      return fs.statSync(thumbnailPath).size > 0 ? file : false;
    }, { timeoutMs: 30000, label: '等待缺失缩略图自动重建' });
    const rebuiltThumbnail = await fetch(`${session.baseUrl}${rebuiltThumbnailFile.thumbnailUrl}`, { headers: session.headers });
    assert.equal(rebuiltThumbnail.status, 200);
    assert.match(rebuiltThumbnail.headers.get('content-type') || '', /image\/jpeg/);
    console.log('✓ 已有影片缩略图丢失后会在重启时自动补建');
    const hlsPlaylist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nsegment-000.ts\n#EXT-X-ENDLIST\n';
    const hlsUpload = await uploadFile(session, 'playlist.m3u8', Buffer.from(hlsPlaylist, 'utf8'), 'application/vnd.apple.mpegurl');
    const hlsFile = await waitForFile(session, hlsUpload.id, (file) => file.category === 'video' && file.compatibility?.status === 'native', { label: '等待 HLS 播放列表状态' });
    assert.equal(hlsFile.compatibility.required, false, 'HLS 播放列表不应进入单文件兼容转码');
    assert.match(hlsFile.url, /^\/media\//);
    const hlsResponse = await fetch(`${session.baseUrl}${hlsFile.url}`, { headers: session.headers });
    assert.equal(hlsResponse.status, 200);
    assert.match(hlsResponse.headers.get('content-type') || '', /application\/vnd\.apple\.mpegurl/);
    console.log('✓ HLS m3u8 播放列表可上传、直出并跳过错误的单文件转码');
    console.log('✓ ffprobe 能读取媒体参数，ffmpeg 能生成缩略图');

    const highBitrateUpload = await uploadFile(session, '高码率-H264.mp4', samples.highBitrateSample);
    const highBitrateFile = await waitForFile(session, highBitrateUpload.id, (file) => (
      file.metadata?.videoCodec === 'H264' && file.compatibility?.required && file.compatibility?.ready
    ), { timeoutMs: 120000, intervalMs: 100, label: '等待高码率 H.264 流畅版' });
    const highBitratePath = path.join(session.server.compatibleMediaDir, highBitrateFile.compatibility.fileName);
    const highBitrateOutput = assertCompatibleOutput(highBitratePath);
    const outputDuration = Number(highBitrateOutput.video.duration || probeMedia(highBitratePath).format?.duration) || 4;
    const outputMbps = fs.statSync(highBitratePath).size * 8 / outputDuration / 1_000_000;
    assert.ok(outputMbps < 1.35, `流畅版平均总码率应低于 1.35 Mbps，实际为 ${outputMbps.toFixed(2)} Mbps`);
    console.log('✓ 可解码但高码率的 H.264 也会生成低带宽流畅版');

    const hevcUpload = await uploadFile(session, '4K-HEVC-10bit.mp4', samples.hevc4kSample);
    hevcFile = await waitForFile(session, hevcUpload.id, (file) => (
      file.metadata?.videoCodec === 'HEVC' && file.compatibility?.required && file.compatibility?.ready
    ), { timeoutMs: 120000, intervalMs: 150, label: '等待 4K HEVC 兼容版' });
    assert.equal(hevcFile.metadata.width, 3840);
    assert.equal(hevcFile.metadata.height, 2160);
    assert.equal(hevcFile.metadata.pixelFormat, 'yuv420p10le');
    assert.equal(hevcFile.metadata.bitDepth, 10);
    assert.equal(hevcFile.compatibility.required, true);
    assert.equal(hevcFile.compatibility.ready, true, hevcFile.compatibility.error);
    assert.equal(hevcFile.compatibility.maxWidth, 854);
    assert.equal(hevcFile.compatibility.maxHeight, 480);
    assert.match(hevcFile.url, /^\/compatible-media\/[a-f0-9-]+\.mp4$/i);

    compatiblePath = path.join(session.server.compatibleMediaDir, hevcFile.compatibility.fileName);
    const compatibleStreams = assertCompatibleOutput(compatiblePath);
    assert.ok(compatibleStreams.video.width <= 854);
    assert.equal(compatibleStreams.video.height, 480);

    const compatibleSize = fs.statSync(compatiblePath).size;
    await assertRangeResponse(session, hevcFile.url, 'bytes=0-4095', 0, 4095, compatibleSize);
    await assertRangeResponse(session, hevcFile.url, 'bytes=100-', 100, compatibleSize - 1, compatibleSize);
    await assertRangeResponse(session, hevcFile.url, 'bytes=-512', compatibleSize - 512, compatibleSize - 1, compatibleSize);
    const invalidRange = await fetch(`${session.baseUrl}${hevcFile.url}`, {
      headers: { ...session.headers, Range: `bytes=${compatibleSize}-` }
    });
    await invalidRange.arrayBuffer();
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get('content-range'), `bytes */${compatibleSize}`);

    const selection = await ack(session.socket, 'select-file', { fileId: hevcFile.id });
    assert.equal(selection.success, true, selection.error);
    console.log('✓ 4K HEVC Main10 真正降为 480P H.264/yuv420p + AAC，并完整支持 HTTP Range');

    const h264TenBitUpload = await uploadFile(session, 'H264-10bit.mp4', samples.h264TenBitSample);
    const h264TenBitFile = await waitForFile(session, h264TenBitUpload.id, (file) => (
      file.metadata?.videoCodec === 'H264' && file.metadata?.pixelFormat === 'yuv420p10le'
      && file.compatibility?.required && file.compatibility?.ready
    ), { timeoutMs: 120000, intervalMs: 100, label: '等待 H.264 10-bit 兼容版' });
    assert.equal(h264TenBitFile.metadata.bitDepth, 10);
    assert.equal(h264TenBitFile.compatibility.required, true);
    assertCompatibleOutput(path.join(session.server.compatibleMediaDir, h264TenBitFile.compatibility.fileName));
    console.log('✓ H.264 10-bit 不会被误判为浏览器原生格式，会转换成 8-bit yuv420p');

    const subtitleUpload = await uploadFile(
      session,
      '测试影片.srt',
      Buffer.from('1\n00:00:00,000 --> 00:00:02,000\n字幕测试\n', 'utf8'),
      'application/x-subrip'
    );
    assert.equal(subtitleUpload.subtitleVideoId, nativeFile.id);
    assert.ok(subtitleUpload.subtitleUrl);
    const vtt = await (await fetch(`${session.baseUrl}${subtitleUpload.subtitleUrl}`, { headers: session.headers })).text();
    assert.match(vtt, /^WEBVTT/);
    assert.match(vtt, /00:00:00\.000 --> 00:00:02\.000/);
    assert.match(vtt, /字幕测试/);

    const gbkSubtitle = iconv.encode('1\n00:00:00,000 --> 00:00:02,000\nGBK 中文字幕\n', 'gb18030');
    const gbkUpload = await uploadFile(session, '国标编码.srt', gbkSubtitle, 'application/x-subrip');
    assert.ok(gbkUpload.subtitleUrl);
    const gbkVtt = await (await fetch(`${session.baseUrl}${gbkUpload.subtitleUrl}`, { headers: session.headers })).text();
    assert.match(gbkVtt, /GBK 中文字幕/);
    console.log('✓ UTF-8 与 GB18030/GBK 中文字幕均可转换为 VTT');

    const raceUpload = await uploadFile(session, '转码中删除.mp4', samples.hevc4kSample);
    const partialStem = path.basename(raceUpload.compatibility.fileName, '.mp4');
    const raceState = await waitFor(async () => {
      const current = (await listFiles(session)).find((file) => file.id === raceUpload.id);
      const partials = fs.readdirSync(session.server.compatibleMediaDir)
        .filter((name) => name.startsWith(`${partialStem}.partial-`));
      if (current?.compatibility?.ready) {
        throw new Error('转码中删除回归未命中：样片在观察到 partial 前已转换完成');
      }
      return current?.compatibility?.status === 'converting' && partials.length ? { current, partials } : null;
    }, { timeoutMs: 60000, intervalMs: 20, label: '等待转码 partial 文件' });
    assert.ok(raceState.partials.length > 0);
    await deleteFile(session, raceUpload.id);
    await waitFor(() => {
      const leftovers = fs.readdirSync(session.server.compatibleMediaDir)
        .filter((name) => name.startsWith(`${partialStem}.partial-`));
      return leftovers.length === 0 ? true : null;
    }, { timeoutMs: 10000, intervalMs: 50, label: '等待删除转码 partial' });
    assert.equal(fs.existsSync(path.join(session.server.uploadsDir, raceUpload.storedName)), false);
    assert.equal(fs.existsSync(path.join(session.server.compatibleMediaDir, raceUpload.compatibility.fileName)), false);
    assert.equal((await listFiles(session)).some((file) => file.id === raceUpload.id), false);
    console.log('✓ 转码进行中删除文件会终止任务，并清理 final/partial 残留');

    const analysisRace = await uploadFile(session, '分析期删除.mp4', samples.nativeSample);
    await deleteFile(session, analysisRace.id);
    await delay(500);
    assert.equal((await listFiles(session)).some((file) => file.id === analysisRace.id), false);
    assert.equal(fs.existsSync(path.join(session.server.uploadsDir, analysisRace.storedName)), false);
    assert.equal(fs.existsSync(path.join(session.server.dataDir, 'thumbnails', `${analysisRace.id}.jpg`)), false);

    sourcePath = path.join(session.server.uploadsDir, hevcFile.storedName);
    const stateBeforeRestart = readStateRecord(serverDataDir, hevcFile.id);
    const cacheBeforeRestart = {
      generatedAt: stateBeforeRestart.compatibility.generatedAt,
      sourceMtimeMs: stateBeforeRestart.compatibility.sourceMtimeMs,
      outputMtimeMs: fs.statSync(compatiblePath).mtimeMs,
      size: fs.statSync(compatiblePath).size,
      sha256: fileSha256(compatiblePath)
    };

    await stopServer(session);
    session = null;

    const stalePartial = path.join(
      path.dirname(compatiblePath),
      `${path.basename(compatiblePath, '.mp4')}.partial-stale-startup.mp4`
    );
    fs.writeFileSync(stalePartial, 'stale partial');
    session = await launchServer(serverDataDir);
    await waitFor(() => (fs.existsSync(stalePartial) ? null : true), {
      timeoutMs: 5000,
      intervalMs: 25,
      label: '等待启动清理 stale partial'
    });
    const reusedFile = await waitForFile(session, hevcFile.id, (file) => file.compatibility?.ready, {
      timeoutMs: 10000,
      label: '等待重启复用兼容缓存'
    });
    assert.equal(reusedFile.url, hevcFile.url);
    await delay(1200);
    const reusedState = readStateRecord(serverDataDir, hevcFile.id);
    const reusedStats = fs.statSync(compatiblePath);
    assert.equal(reusedState.compatibility.generatedAt, cacheBeforeRestart.generatedAt);
    assert.equal(reusedStats.size, cacheBeforeRestart.size);
    assert.equal(reusedStats.mtimeMs, cacheBeforeRestart.outputMtimeMs);
    assert.equal(fileSha256(compatiblePath), cacheBeforeRestart.sha256);
    console.log('✓ 服务重启会复用有效兼容缓存，并清理上次遗留的 partial');

    await stopServer(session);
    session = null;

    const sourceStats = fs.statSync(sourcePath);
    fs.utimesSync(sourcePath, sourceStats.atime, new Date(sourceStats.mtimeMs + 10000));
    const changedSourceMtimeMs = Math.trunc(fs.statSync(sourcePath).mtimeMs);
    assert.notEqual(changedSourceMtimeMs, cacheBeforeRestart.sourceMtimeMs);
    session = await launchServer(serverDataDir);
    await waitForFile(session, hevcFile.id, (file) => file.compatibility?.ready, {
      timeoutMs: 120000,
      intervalMs: 100,
      label: '等待源 mtime 变化后的兼容版重建'
    });
    const changedSourceState = readStateRecord(serverDataDir, hevcFile.id);
    assert.notEqual(changedSourceState.compatibility.generatedAt, cacheBeforeRestart.generatedAt);
    assert.equal(changedSourceState.compatibility.sourceMtimeMs, changedSourceMtimeMs);
    assert.equal(changedSourceState.compatibility.size, fs.statSync(compatiblePath).size);
    assertCompatibleOutput(compatiblePath);
    console.log('✓ 源文件 mtime 变化会使缓存失效并自动重建');

    const generatedAfterSourceChange = changedSourceState.compatibility.generatedAt;
    await stopServer(session);
    session = null;

    fs.writeFileSync(compatiblePath, Buffer.from('corrupt-compatible-cache'));
    const corruptSize = fs.statSync(compatiblePath).size;
    session = await launchServer(serverDataDir);
    await waitForFile(session, hevcFile.id, (file) => file.compatibility?.ready, {
      timeoutMs: 120000,
      intervalMs: 100,
      label: '等待损坏缓存重建'
    });
    const rebuiltState = readStateRecord(serverDataDir, hevcFile.id);
    const rebuiltStats = fs.statSync(compatiblePath);
    assert.notEqual(rebuiltState.compatibility.generatedAt, generatedAfterSourceChange);
    assert.notEqual(rebuiltStats.size, corruptSize);
    assert.equal(rebuiltState.compatibility.size, rebuiltStats.size);
    assertCompatibleOutput(compatiblePath);
    console.log('✓ 缓存被截断或篡改后不会继续提供，服务会自动重建有效 MP4');
  } finally {
    await stopServer(session).catch(() => {});
  }
}

async function testAndroidStyleServer(serverDataDir, hevcSample) {
  let session = await launchServer(serverDataDir, { register: true, ffprobe: '', ffmpeg: '' });
  try {
    const upload = await uploadFile(session, '安卓原片直出.mp4', hevcSample);
    const file = await waitForFile(session, upload.id, (entry) => (
      entry.compatibility?.required && entry.compatibility?.status === 'unavailable'
    ), { timeoutMs: 10000, intervalMs: 50, label: '等待无转码组件状态' });
    assert.equal(file.compatibility.required, true);
    assert.equal(file.compatibility.ready, false);
    assert.equal(file.compatibility.status, 'unavailable');
    assert.ok(file.compatibility.error);
    assert.equal(file.url, file.originalUrl);
    assert.match(file.url, /^\/media\//);

    const originalRange = await fetch(`${session.baseUrl}${file.originalUrl}`, {
      headers: { ...session.headers, Range: 'bytes=0-31' }
    });
    const originalBody = Buffer.from(await originalRange.arrayBuffer());
    assert.equal(originalRange.status, 206);
    assert.equal(originalBody.length, 32);

    const selection = await ack(session.socket, 'select-file', { fileId: file.id });
    assert.equal(selection.success, true, selection.error);
    console.log('✓ 无 ffprobe/ffmpeg 的安卓式服务器显示 required+unavailable，但仍允许选择和读取原片');
  } finally {
    await stopServer(session).catch(() => {});
    session = null;
  }
}

async function main() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-media-test-'));
  const startedAt = Date.now();
  try {
    const samples = createSamples(rootDir);
    await testPrimaryMediaFlow(rootDir, path.join(rootDir, 'desktop-server'), samples);
    await testAndroidStyleServer(path.join(rootDir, 'android-server'), samples.hevc4kSample);
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\n真实媒体兼容回归全部通过，耗时 ${elapsedSeconds} 秒。`);
  } finally {
    try {
      fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
  }
}

main().catch((error) => {
  console.error('\n媒体兼容回归失败:', error);
  process.exit(1);
});
