'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const policy = require('../public/js/media-network-recovery');
const appSource = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const tunnelSmokeSource = fs.readFileSync(path.join(root, 'tests', 'tunnel-smoke.js'), 'utf8');

assert.equal(policy.MAX_ATTEMPTS, 3);
assert.deepEqual(policy.DELAYS_MS, [250, 500, 1000]);
assert.equal(policy.STALL_TIMEOUT_MS, 12000);
assert.deepEqual(policy.nextAttempt(0), { attempt: 1, delayMs: 250 });
assert.deepEqual(policy.nextAttempt(2), { attempt: 3, delayMs: 1000 });
assert.equal(policy.nextAttempt(3), null, '媒体网络恢复不能无限重试');
assert.equal(policy.isStillStalled({ currentTime: 20, bufferedAhead: .2 }, { currentTime: 20.1, bufferedAhead: .3, readyState: 2 }), true);
assert.equal(policy.isStillStalled({ currentTime: 20, bufferedAhead: .2 }, { currentTime: 20.7, bufferedAhead: .3, readyState: 2 }), false,
  '播放时间已经推进时不应该重载');
assert.equal(policy.isStillStalled({ currentTime: 20, bufferedAhead: .2 }, { currentTime: 20.1, bufferedAhead: 1.1, readyState: 2 }), false,
  '缓冲区仍在增长时不应该重载');
assert.equal(policy.isStillStalled({ currentTime: 20, bufferedAhead: .2 }, { currentTime: 20.1, bufferedAhead: .3, readyState: 3 }), false,
  '播放器已经恢复可播放状态时不应该重载');

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
assert.match(appSource, /onMediaCanPlay[\s\S]{0,900}clearMediaNetworkRecovery\(true\)/,
  '媒体恢复成功后必须清零重试状态');
assert.match(appSource, /function teardownTimedMedia\([\s\S]{0,500}clearMediaNetworkRecovery\(false\)/,
  '换片或销毁媒体时必须取消待执行的恢复');
assert.match(appSource, /handleMediaError[\s\S]{0,300}scheduleMediaNetworkRecovery\(mediaError\)/,
  '媒体错误处理必须优先尝试有限网络恢复');
assert.match(appSource, /handleMediaBuffering[\s\S]{0,400}scheduleMediaStallRecovery\(\)/,
  '媒体长时缓冲且没有进度时必须进入有限网络恢复');
assert.match(appSource, /scheduleMediaStallRecovery[\s\S]{0,1400}scheduleMediaNetworkRecovery\(\{ code: 2 \}\)/,
  '缓冲超时必须复用现有的三次有限恢复，不能无限重载');
assert.match(appSource, /scheduleMediaNetworkRecovery\(\{ code: 2 \}\);[\s\S]{0,80}else scheduleMediaStallRecovery\(\);/,
  '缓冲仍有微小进展但尚未恢复时必须继续观察，不能只检查一次后永久停帧');

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

console.log('media network recovery and tunnel transient retry policy passed.');
