'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const policy = require('../public/js/media-network-recovery');
const { _test } = require('../server');
const appSource = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const tunnelSmokeSource = fs.readFileSync(path.join(root, 'tests', 'tunnel-smoke.js'), 'utf8');

assert.equal(policy.MAX_ATTEMPTS, 5);
assert.deepEqual(policy.DELAYS_MS, [500, 1500, 3500, 7000, 12000]);
assert.equal(policy.OFFLINE_RECHECK_MS, 1000);
assert.equal(policy.STALL_TIMEOUT_MS, 12000);
assert.equal(policy.STABLE_PROGRESS_SECONDS, 3);
assert.deepEqual(policy.nextAttempt(0), { attempt: 1, delayMs: 500 });
assert.deepEqual(policy.nextAttempt(4), { attempt: 5, delayMs: 12000 });
assert.equal(policy.nextAttempt(5), null, '媒体网络恢复不能无限重试');
assert.deepEqual(policy.nextStep(2, { transportReady: false }), {
  waitingForNetwork: true, attempt: 2, delayMs: 1000
}, '设备或 Socket 离线时应等待传输恢复，不应消耗第 3 次重试');
assert.deepEqual(policy.nextStep(2, { transportReady: true }), {
  waitingForNetwork: false, attempt: 3, delayMs: 3500
});
assert.deepEqual(policy.nextStep(policy.MAX_ATTEMPTS, { transportReady: false }), {
  waitingForNetwork: true, attempt: policy.MAX_ATTEMPTS, delayMs: 1000
}, '离线时即使恢复额度已用完也应等待网络，以便联网后执行降级或明确失败');
assert.equal(policy.nextStep(policy.MAX_ATTEMPTS, { transportReady: true }), null,
  '联网后恢复额度用完必须进入明确终态，不能再安排第 6 次重载');
assert.equal(_test.MAX_OPEN_ENDED_MEDIA_RANGE_BYTES, 8 * 1024 * 1024,
  '大文件开放式 Range 应使用 8 MiB 有界分段，减少高延迟链路的周期性断流');
assert.equal(policy.isStillStalled({ currentTime: 20, bufferedAhead: .2 }, { currentTime: 20.1, bufferedAhead: .3, readyState: 2 }), true);
assert.equal(policy.isStillStalled({ currentTime: 20, bufferedAhead: .2 }, { currentTime: 20.7, bufferedAhead: .3, readyState: 2 }), false,
  '播放时间已经推进时不应该重载');
assert.equal(policy.isStillStalled({ currentTime: 20, bufferedAhead: .2 }, { currentTime: 20.1, bufferedAhead: 1.1, readyState: 2 }), false,
  '缓冲区仍在增长时不应该重载');
assert.equal(policy.isStillStalled({ currentTime: 20, bufferedAhead: .2 }, { currentTime: 20.1, bufferedAhead: .3, readyState: 3 }), false,
  '播放器已经恢复可播放状态时不应该重载');
assert.equal(policy.hasStableProgress({ currentTime: 20 }, { currentTime: 20.16, readyState: 3, paused: false, elapsedMs: 3000 }), false,
  'canplay 后只推进一帧不能把弱网恢复次数清零');
assert.equal(policy.hasStableProgress({ currentTime: 20 }, { currentTime: 23.1, readyState: 3, paused: false, elapsedMs: 3000 }), true,
  '恢复后连续推进三秒才可确认本轮媒体连接稳定');
assert.equal(policy.hasStableProgress({ currentTime: 20 }, { currentTime: 24, readyState: 2, paused: false, elapsedMs: 4000 }), false,
  '再次进入缓冲时不能确认恢复成功');
assert.equal(policy.hasStableProgress({ currentTime: 20 }, { currentTime: 98, readyState: 3, paused: false, elapsedMs: 50 }), false,
  '立即跳转很大的媒体时间也不能伪装成连续稳定播放');
assert.equal(policy.hasStableProgress({ currentTime: 20 }, { currentTime: 24, readyState: 3, paused: false, seeking: true, elapsedMs: 4000 }), false,
  '播放器正在 seeking 时不能确认恢复成功');

const localSource = 'https://example.trycloudflare.com/media/movie.mp4?syncwatch_token=test';
assert.equal(policy.isEligible({ errorCode: 2, sourceType: 'local', source: localSource, pageHref: 'https://example.trycloudflare.com/?room=ADMIN' }), true);
assert.equal(policy.isEligible({ errorCode: 3, sourceType: 'local', source: localSource, pageHref: 'https://example.trycloudflare.com/?room=ADMIN' }), false,
  '解码错误不能伪装成瞬时网络错误反复重试');
assert.equal(policy.isEligible({ errorCode: 2, sourceType: 'remote', source: 'https://cos.example/movie.mp4', pageHref: 'https://example.trycloudflare.com/' }), false,
  '远端 COS/OSS CORS 或签名错误不能进入本地媒体重试');
assert.equal(policy.isEligible({ errorCode: 2, sourceType: 'local', source: 'https://other.example/media/movie.mp4', pageHref: 'https://example.trycloudflare.com/' }), false,
  '跨域媒体不能进入同源隧道恢复');

assert.match(pageSource, /js\/media-network-recovery\.js[\s\S]*js\/app\.js/,
  '媒体恢复策略必须先于主应用加载');
assert.match(appSource, /function scheduleMediaNetworkRecovery\(/);
assert.match(appSource, /function clearMediaNetworkRecovery\(/);
assert.match(appSource, /function mediaRecoveryTransportReady\(/);
assert.match(appSource, /policy\.nextStep\(recovery\.attempts,\s*\{ transportReady: mediaRecoveryTransportReady\(\) \}\)/,
  '媒体恢复必须在离线时暂停重试预算');
assert.match(appSource, /function resumeWaitingMediaRecovery\([\s\S]{0,700}recovery\.waitingForNetwork/,
  '网络恢复时必须主动唤醒媒体恢复');
assert.doesNotMatch(appSource, /state\.socket\.on\('connect',[\s\S]{0,180}resumeWaitingMediaRecovery\(\)/,
  '原始 Socket 刚连接但尚未完成会话认证时不得提前重载媒体');
assert.match(appSource, /applyRoom\(result\.room\);\s*resumeWaitingMediaRecovery\(\)/,
  '必须等会话认证和权威房间状态恢复后再重载媒体');
assert.match(appSource, /function mediaRecoveryTransportReady\([\s\S]{0,300}state\.socketAuthenticated/,
  '媒体恢复必须等待 Socket 会话重新认证');
assert.match(appSource, /function resumeWaitingMediaRecovery\([\s\S]{0,900}if \(!scheduleMediaNetworkRecovery\(\{ code: 2 \}\)\) finishMediaNetworkRecovery\(\{ code: 2 \}\)/,
  '恢复额度在离线期间耗尽时，联网后必须降级或进入明确错误终态');
assert.match(appSource, /function finishMediaNetworkRecovery\([\s\S]{0,900}tryCompatibilityFallback\(recoveryResume\)/,
  '媒体恢复终态必须优先切换已有流畅版');
const canPlaySource = appSource.slice(appSource.indexOf('function onMediaCanPlay()'), appSource.indexOf('function beginPlayerSeekDrag()'));
assert.doesNotMatch(canPlaySource, /clearMediaNetworkRecovery\(true\)/,
  'canplay 只说明已有少量数据，不能立即清零弱网恢复次数');
assert.match(canPlaySource, /beginMediaRecoveryStability\(\)/,
  '恢复中的媒体 canplay 后必须进入实际播放进度观察期');
assert.match(canPlaySource, /playback\?\.stalled[\s\S]{0,700}state\.capabilities\.owner[\s\S]{0,700}setProgrammaticPlaying\(true/,
  '房主重载成功后必须越过自己上报的旧 stalled 快照并重新启动播放器');
assert.match(appSource, /addEventListener\('timeupdate',\s*handleMediaRecoveryProgress\)/,
  '恢复成功必须由真实 timeupdate 播放进度确认');
assert.match(appSource, /addEventListener\('seeking',[\s\S]{0,180}invalidateMediaRecoveryStability\(\)/,
  '任何跳转都必须撤销旧的稳定播放观察');
assert.match(appSource, /addEventListener\('seeked',\s*beginMediaRecoveryStability\)/,
  '跳转完成后必须从新位置重新观察');
assert.match(appSource, /function handleMediaBufferRecovered\([\s\S]{0,300}beginMediaRecoveryStability\(\)/,
  '缓冲后直接恢复 playing 时也必须重新开始稳定观察');
assert.match(appSource, /function teardownTimedMedia\([\s\S]{0,500}clearMediaNetworkRecovery\(false\)/,
  '换片或销毁媒体时必须取消待执行的恢复');
assert.match(appSource, /function handleLocalPlaybackEvent\(playing\)\s*\{[\s\S]{0,100}if \(!playing\)[\s\S]{0,100}clearMediaBufferingState\(\)/,
  '任何本地或同步暂停事件都必须立即撤销缓冲恢复计时器');
assert.match(appSource, /function handleLocalPlaybackEvent\(playing\)[\s\S]{0,180}if \(!playing\)[\s\S]{0,120}clearMediaNetworkRecovery\(\)/,
  '任何本地或同步暂停事件都必须立即撤销媒体重载计时器');
assert.match(appSource, /if \(!accepted\.isPlaying\)[\s\S]{0,220}clearMediaNetworkRecovery\(\)[\s\S]{0,300}readyState < 1/,
  '权威暂停必须在播放器尚未就绪的早退之前撤销媒体重载');
assert.match(appSource, /function clearMediaBufferingState\([\s\S]{0,300}invalidateMediaRecoveryStability\(\)/,
  '暂停或销毁媒体时必须中断稳定播放观察');
assert.match(appSource, /function teardownTimedMedia\([\s\S]{0,600}clearMediaBufferingState\(\)/,
  '换片或销毁媒体时必须清理旧影片的缓冲状态');
assert.match(appSource, /handleMediaError[\s\S]{0,300}scheduleMediaNetworkRecovery\(mediaError\)/,
  '媒体错误处理必须优先尝试有限网络恢复');
assert.match(appSource, /handleMediaBuffering[\s\S]{0,400}scheduleMediaStallRecovery\(\)/,
  '媒体长时缓冲且没有进度时必须进入有限网络恢复');
assert.match(appSource, /scheduleMediaStallRecovery[\s\S]{0,1400}scheduleMediaNetworkRecovery\(\{ code: 2 \}\)/,
  '缓冲超时必须复用现有的有限恢复，不能无限重载');
assert.match(appSource, /scheduleMediaStallRecovery[\s\S]{0,1600}if \(!scheduleMediaNetworkRecovery\(\{ code: 2 \}\)\) finishMediaNetworkRecovery\(\{ code: 2 \}\)/,
  '第五次重载后仍 stalled 必须降级或明确失败，不能永久停帧');
assert.match(appSource, /scheduleMediaStallRecovery[\s\S]{0,1000}!state\.room\?\.playback\?\.isPlaying[\s\S]{0,250}video\.paused/,
  '缓冲计时器到点时若房间已暂停或本机播放器已暂停，不得重载媒体');
assert.match(appSource, /if \(!scheduleMediaNetworkRecovery\(\{ code: 2 \}\)\) finishMediaNetworkRecovery\(\{ code: 2 \}\);[\s\S]{0,80}\} else scheduleMediaStallRecovery\(\);/,
  '缓冲仍有微小进展但尚未恢复时必须继续观察，不能只检查一次后永久停帧');
assert.match(appSource, /handleMediaError[\s\S]{0,350}finishMediaNetworkRecovery\(mediaError\)/,
  '原画的有界网络恢复用尽后，有流畅版时应自动降级而不是永久停播');
assert.match(appSource, /const playback = state\.pendingPlayback\?\.playback \|\| state\.room\?\.playback/,
  '切换流畅版时必须从 pendingPlayback 包装中读取播放快照');
assert.match(appSource, /state\.pendingPlayback = \{ playback: preservedTarget, force: true \}/,
  '流畅版必须按 applyPendingPlayback 的契约保存快照');
assert.match(appSource, /state\.mediaNetworkRecovery\.resume = \{[\s\S]{0,350}source,[\s\S]{0,350}variant: 'smooth'/,
  '切换流畅版后必须为新媒体源重建恢复快照');

assert.match(tunnelSmokeSource, /MAX_TRANSIENT_RANGE_ERRORS\s*=\s*3/);
assert.match(tunnelSmokeSource, /TRANSIENT_RANGE_HTTP_STATUSES\s*=\s*new Set\(\[502, 503, 504\]\)/);
assert.match(tunnelSmokeSource, /transientRangeStats\.errors\s*<=\s*MAX_TRANSIENT_RANGE_ERRORS/,
  '隧道压力测试必须对瞬时边缘错误设置全局上限');
assert.match(tunnelSmokeSource, /transientRangeStats\.byStatus/,
  '隧道压力测试必须统计边缘状态码');
assert.match(tunnelSmokeSource, /function ensureControlWindow\([\s\S]{0,900}app\.emit\('activate'\)/,
  '长时间公网测试的隐藏控制窗口被系统回收后必须重建，而不是跳过后续验收');
assert.match(tunnelSmokeSource, /window\s*=\s*await ensureControlWindow\(window,[\s\S]{0,220}statusAfterSeeks/,
  '40 次拖动后必须恢复测试控制窗口并继续检查同一隧道状态');

{
  const calls = [];
  const source = `${canPlaySource}\nthis.onMediaCanPlay = onMediaCanPlay;`;
  const context = vm.createContext({
    state: {
      mediaNetworkRecovery: { resume: {
        fileId: 'movie', source: 'https://watch.example/media/movie.mp4',
        generation: 4, currentTime: 42, wasPlaying: true, volume: 0.7, muted: false
      } },
      currentFile: { id: 'movie' }, activeTimedSource: 'https://watch.example/media/movie.mp4',
      activeMediaVariant: 'original', mediaGeneration: 4, mediaFailed: true,
      room: { playback: { fileId: 'movie', currentTime: 42, revision: 9, isPlaying: true, stalled: true } },
      capabilities: { owner: true }, screenShareActive: false, pendingPlayback: { playback: { revision: 8 } },
      playbackRevision: 9
    },
    elements: { videoPlayer: { currentTime: 40 } },
    isActiveTimedMedia: () => true,
    updatePlayerProgressBar: () => calls.push('progress'),
    projectedTime: () => 42,
    setProgrammaticTime: (time, revision) => calls.push(['time', time, revision]),
    setProgrammaticVolume: (volume, muted) => calls.push(['volume', volume, muted]),
    setProgrammaticPlaying: (playing, revision) => calls.push(['playing', playing, revision]),
    applyPendingPlayback: () => calls.push('pending'),
    adaptiveSynchronize: () => calls.push('adaptive'),
    beginMediaRecoveryStability: () => calls.push('stability')
  });
  vm.runInContext(source, context);
  context.onMediaCanPlay();
  assert.deepEqual(calls.find((entry) => Array.isArray(entry) && entry[0] === 'playing'),
    ['playing', true, 9], '房主恢复后必须主动跨过旧 stalled 快照开始播放');
  assert.equal(calls.includes('adaptive'), false, '房主恢复不应重新落入 stalled 同步分支');
  assert.equal(calls.includes('pending'), false, '旧 pending 快照不应阻止房主恢复');
  assert.equal(calls.includes('stability'), true);
}

{
  const fallbackStart = appSource.indexOf('function tryCompatibilityFallback(');
  const fallbackEnd = appSource.indexOf('function clearMediaNetworkRecovery(', fallbackStart);
  const finishStart = appSource.indexOf('function finishMediaNetworkRecovery(');
  const finishEnd = appSource.indexOf('function handleMediaError(', finishStart);
  assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart && finishStart >= 0 && finishEnd > finishStart);
  let loadCalls = 0;
  const state = {
    currentFile: {
      id: 'movie', sourceType: 'local', originalName: 'movie.mkv',
      url: '/compatible-media/movie.mp4', compatibility: { required: true, ready: true }
    },
    activeMediaVariant: 'original', activeTimedFileId: 'movie',
    activeTimedSource: 'https://watch.example/media/movie.mkv', mediaGeneration: 7,
    compatibilityFallbackFileId: '', compatibilityFallbackGeneration: -1,
    playbackRevision: 11, pendingPlayback: null,
    room: { playback: {
      fileId: 'movie', isPlaying: true, stalled: true, currentTime: 42,
      volume: 0.65, muted: false, revision: 11, updatedAt: 1000
    } },
    mediaNetworkRecovery: {
      key: 'movie:https://watch.example/media/movie.mkv', attempts: policy.MAX_ATTEMPTS,
      timer: null, stallTimer: null, stability: null, waitingForNetwork: false,
      resume: {
        fileId: 'movie', source: 'https://watch.example/media/movie.mkv', variant: 'original',
        generation: 7, currentTime: 42, wasPlaying: true, volume: 0.65, muted: false
      }
    },
    mediaFailed: true
  };
  const video = { paused: true, currentTime: 42, volume: 0.65, muted: false, playbackRate: 1, src: '', load: () => { loadCalls += 1; } };
  const context = vm.createContext({
    state, elements: { videoPlayer: video, syncStatus: { textContent: '' } },
    location: { href: 'https://watch.example/?room=ROOM' }, Date, URL,
    mediaUrlWithSessionToken: (value) => value,
    teardownTimedMedia() {
      state.mediaGeneration += 1;
      state.activeTimedFileId = null; state.activeTimedSource = ''; state.activeMediaVariant = 'auto';
      state.mediaNetworkRecovery = {
        key: '', attempts: 0, timer: null, stallTimer: null,
        resume: null, stability: null, waitingForNetwork: false
      };
    },
    attachSubtitleTracks() {}, showSyncNotice() {}, toast() {}, clearTimeout() {}
  });
  vm.runInContext(`${appSource.slice(fallbackStart, fallbackEnd)}\n${appSource.slice(finishStart, finishEnd)}\nthis.finishMediaNetworkRecovery = finishMediaNetworkRecovery;`, context);
  assert.equal(context.finishMediaNetworkRecovery({ code: 2 }), true,
    '原画恢复用尽时应成功切换现有流畅版');
  assert.equal(state.activeMediaVariant, 'smooth');
  assert.equal(loadCalls, 1);
  assert.equal(state.pendingPlayback.playback.stalled, true,
    '服务端的权威 stalled 快照应保留到房主真实恢复播放');
  assert.deepEqual({ ...state.mediaNetworkRecovery.resume }, {
    fileId: 'movie', source: 'https://watch.example/compatible-media/movie.mp4', variant: 'smooth',
    generation: 8, currentTime: 42, wasPlaying: true, volume: 0.65, muted: false
  }, '流畅版新源必须继承恢复位置和播放意图');
}

function createRecoveryHarness() {
  const start = appSource.indexOf('function clearMediaNetworkRecovery(');
  const end = appSource.indexOf('async function updatePlayerInfo(', start);
  assert.ok(start >= 0 && end > start, '无法提取媒体恢复状态机');
  const timers = new Map();
  let nextTimer = 1;
  let fallbackCalls = 0;
  let loadCalls = 0;
  let now = 100;
  const video = {
    currentTime: 42, paused: false, ended: false, readyState: 2,
    volume: 0.8, muted: false, playbackRate: 1, src: '',
    load() { loadCalls += 1; }
  };
  const state = {
    socket: { connected: false }, socketAuthenticated: false, token: 'test-token',
    mediaNetworkRecovery: {
      key: 'movie:https://watch.example/media/movie.mp4?syncwatch_token=test', attempts: policy.MAX_ATTEMPTS,
      timer: null, stallTimer: null, resume: null, stability: null, waitingForNetwork: false
    },
    currentFile: {
      id: 'movie', sourceType: 'local', originalName: 'movie.mp4',
      compatibility: { required: true, ready: true }
    },
    activeTimedSource: 'https://watch.example/media/movie.mp4?syncwatch_token=test',
    activeMediaVariant: 'original', mediaGeneration: 7, screenShareActive: false,
    room: { playback: { fileId: 'movie', isPlaying: true, currentTime: 42 } },
    localBuffering: false, bufferedAheadSeconds: 0, mediaFailed: false,
    expectedSeek: null, expectedPlaybackEvent: null
  };
  const context = vm.createContext({
    SyncWatchMediaNetworkRecovery: policy,
    state,
    elements: { videoPlayer: video, syncStatus: { textContent: '' } },
    navigator: { onLine: false },
    location: { href: 'https://watch.example/?room=ROOM' },
    performance: { now: () => now },
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    attachSubtitleTracks() {}, updatePlayerBufferState() {}, showSyncNotice() {}, toast() {},
    tryCompatibilityFallback() { fallbackCalls += 1; return true; }
  });
  vm.runInContext(`${appSource.slice(start, end)}\nthis.scheduleMediaNetworkRecovery = scheduleMediaNetworkRecovery; this.resumeWaitingMediaRecovery = resumeWaitingMediaRecovery; this.scheduleMediaStallRecovery = scheduleMediaStallRecovery; this.beginMediaRecoveryStability = beginMediaRecoveryStability; this.handleMediaRecoveryProgress = handleMediaRecoveryProgress;`, context);
  return {
    context, state, video, timers,
    fallbackCalls: () => fallbackCalls,
    loadCalls: () => loadCalls,
    setNow: (value) => { now = Number(value); }
  };
}

{
  const harness = createRecoveryHarness();
  assert.equal(harness.context.scheduleMediaNetworkRecovery({ code: 2 }), true);
  assert.equal(harness.state.mediaNetworkRecovery.waitingForNetwork, true);
  assert.equal(harness.state.mediaNetworkRecovery.attempts, policy.MAX_ATTEMPTS,
    '离线等待不得消耗或重置已用完的恢复额度');
  harness.context.navigator.onLine = true;
  harness.state.socket.connected = true;
  const unauthenticatedTimer = harness.state.mediaNetworkRecovery.timer;
  harness.context.resumeWaitingMediaRecovery();
  assert.equal(harness.state.mediaNetworkRecovery.timer, unauthenticatedTimer,
    'Socket 物理连接但会话未认证时不得提前重载媒体');
  assert.equal(harness.state.mediaNetworkRecovery.waitingForNetwork, true);
  assert.equal(harness.fallbackCalls(), 0);
  harness.state.socketAuthenticated = true;
  harness.context.resumeWaitingMediaRecovery();
  assert.equal(harness.fallbackCalls(), 1,
    '第五次恢复后离线再联网，必须进入流畅版降级而不是永久等待');
  assert.equal(harness.state.mediaNetworkRecovery.waitingForNetwork, false);
  assert.equal(harness.state.mediaNetworkRecovery.resume, null);
}

{
  const harness = createRecoveryHarness();
  harness.state.mediaNetworkRecovery.attempts = 0;
  harness.state.mediaNetworkRecovery.key = '';
  harness.state.localBuffering = true;
  harness.state.socket.connected = true;
  harness.state.socketAuthenticated = true;
  harness.context.navigator.onLine = true;
  let recoveryCalls = 0;
  harness.context.scheduleMediaNetworkRecovery = () => { recoveryCalls += 1; return true; };
  harness.context.scheduleMediaStallRecovery();
  const timer = [...harness.timers.values()][0];
  assert.equal(typeof timer, 'function', '缓冲监控必须安排一次有限计时器');
  harness.state.room.playback.isPlaying = false;
  harness.video.paused = true;
  timer();
  assert.equal(recoveryCalls, 0, '暂停后到期的缓冲计时器不得重载影片');
}

{
  const harness = createRecoveryHarness();
  harness.state.mediaNetworkRecovery.attempts = 0;
  harness.state.mediaNetworkRecovery.key = '';
  harness.state.socket.connected = true;
  harness.state.socketAuthenticated = true;
  harness.context.navigator.onLine = true;
  assert.equal(harness.context.scheduleMediaNetworkRecovery({ code: 2 }), true);
  const staleTimer = [...harness.timers.values()][0];
  assert.equal(typeof staleTimer, 'function', '媒体错误必须先安排有界恢复');
  const attemptsBeforePause = harness.state.mediaNetworkRecovery.attempts;
  harness.state.room.playback.isPlaying = false;
  harness.video.paused = true;
  harness.context.clearMediaNetworkRecovery();
  assert.equal(harness.state.mediaNetworkRecovery.timer, null, '权威暂停必须立即清理待执行重载');
  assert.equal(harness.state.mediaNetworkRecovery.attempts, attemptsBeforePause,
    '暂停不是恢复成功，不得伪造次数重置');
  staleTimer();
  assert.equal(harness.loadCalls(), 0, '已撤销的旧回调即使进入事件队列也不得重载影片');
  assert.equal(harness.state.mediaNetworkRecovery.attempts, attemptsBeforePause,
    '暂停后的旧回调不得消耗新的恢复次数');
}

{
  const harness = createRecoveryHarness();
  harness.state.mediaNetworkRecovery.attempts = 2;
  harness.state.mediaNetworkRecovery.resume = {
    fileId: 'movie', source: harness.state.activeTimedSource,
    generation: harness.state.mediaGeneration, currentTime: 42,
    wasPlaying: true, volume: 0.8, muted: false
  };
  harness.state.socket.connected = true;
  harness.state.socketAuthenticated = true;
  harness.context.navigator.onLine = true;
  harness.video.readyState = 3;
  assert.equal(harness.context.beginMediaRecoveryStability(), true);
  harness.video.currentTime = 42.2;
  harness.setNow(3100);
  harness.context.handleMediaRecoveryProgress();
  assert.equal(harness.state.mediaNetworkRecovery.attempts, 2,
    'canplay 后只推进少量时不得清空已消耗的恢复次数');
  harness.video.currentTime = 45.2;
  harness.setNow(3200);
  harness.context.handleMediaRecoveryProgress();
  assert.equal(harness.state.mediaNetworkRecovery.attempts, 0,
    '连续播放超过稳定观察期后才可确认恢复成功');
  assert.equal(harness.state.mediaNetworkRecovery.resume, null);
}

{
  const harness = createRecoveryHarness();
  harness.state.mediaNetworkRecovery.attempts = 2;
  harness.state.mediaNetworkRecovery.resume = {
    fileId: 'movie', source: harness.state.activeTimedSource,
    generation: harness.state.mediaGeneration, currentTime: 42,
    wasPlaying: true, volume: 0.8, muted: false
  };
  harness.state.socket.connected = true;
  harness.state.socketAuthenticated = true;
  harness.context.navigator.onLine = true;
  harness.video.readyState = 3;
  harness.video.currentTime = 42.2;
  harness.setNow(100);
  harness.context.handleMediaRecoveryProgress();
  assert.ok(harness.state.mediaNetworkRecovery.stability,
    '恢复后即使 Chromium 没有补发 playing/canplay，健康 timeupdate 也必须重建稳定观察点');
  harness.video.currentTime = 45.3;
  harness.setNow(3200);
  harness.context.handleMediaRecoveryProgress();
  assert.equal(harness.state.mediaNetworkRecovery.key, '',
    '恢复播放继续推进三秒后不得遗留恢复键');
  assert.equal(harness.state.mediaNetworkRecovery.resume, null);
}

console.log('media network recovery and tunnel transient retry policy passed.');
