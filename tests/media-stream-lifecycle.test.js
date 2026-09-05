'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const { EventEmitter, once } = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { _test } = require('../server');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function abortedRequest(port, offset) {
  await new Promise((resolve) => {
    const request = http.get({
      host: '127.0.0.1', port, path: '/', headers: { Range: `bytes=${offset}-` }
    }, (response) => {
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received >= 64 * 1024) {
          request.destroy();
          resolve();
        }
      });
      response.on('error', resolve);
    });
    request.on('error', resolve);
  });
}

(async () => {
  assert.equal(typeof _test.clampMediaRangeEnd, 'function', '服务器应提供标准开放式 Range 末尾计算');
  assert.equal(_test.clampMediaRangeEnd(0, 64 * 1024 * 1024 - 1, 64 * 1024 * 1024, true), 64 * 1024 * 1024 - 1);
  assert.equal(_test.clampMediaRangeEnd(0, 1023, 64 * 1024 * 1024, false), 1023);

  assert.equal(typeof _test.pipeMediaFileResponse, 'function',
    '服务器应提供会在客户端中止 Range 请求时销毁文件流的媒体管线');

  const missingRequest = new EventEmitter(); missingRequest.aborted = false;
  const missingResponse = new PassThrough();
  let missingError = null;
  _test.pipeMediaFileResponse(
    missingRequest, missingResponse, path.join(os.tmpdir(), `syncwatch-missing-${process.pid}-${Date.now()}.mp4`), {},
    (error) => {
      missingError = error;
      assert.equal(missingResponse.destroyed, false,
        '文件流在打开前失败时不能先销毁 HTTP 响应');
      missingResponse.end('handled');
    }
  );
  await once(missingResponse, 'finish');
  assert.equal(missingError?.code, 'ENOENT',
    '文件流打开失败应把原始 ENOENT 交给路由错误处理');
  assert.equal(missingResponse.destroyed, false,
    '路由处理文件打开失败后仍应能正常结束响应');
  console.log('✓ 文件流打开失败时保留 HTTP 响应，避免向 NAT 代理暴露 ECONNRESET');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-media-stream-'));
  const mediaFile = path.join(root, 'large-4k-like-media.bin');
  const fileHandle = fs.openSync(mediaFile, 'w');
  fs.ftruncateSync(fileHandle, 256 * 1024 * 1024);
  fs.closeSync(fileHandle);
  const activeStreams = new Set();
  let streamErrors = 0;

  const server = http.createServer((request, response) => {
    const total = fs.statSync(mediaFile).size;
    response.statusCode = 206;
    response.setHeader('Content-Type', 'video/mp4');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Range', `bytes 0-${total - 1}/${total}`);
    response.setHeader('Content-Length', total);
    const source = _test.pipeMediaFileResponse(
      request, response, mediaFile, { start: 0, end: total - 1 },
      () => { streamErrors += 1; }
    );
    activeStreams.add(source);
    source.once('close', () => activeStreams.delete(source));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    for (let index = 0; index < 80; index += 1) {
      await abortedRequest(port, index * 1024 * 1024);
    }
    await delay(1200);
    assert.equal(activeStreams.size, 0,
      `80 次进度拖动中止后仍有 ${activeStreams.size} 个媒体文件流没有关闭`);
    assert.equal(streamErrors, 0, '客户端主动中止不应被记录成媒体读取错误');
    console.log('✓ 连续中止 80 个大媒体 Range 请求后，全部源文件流均已关闭');

    const tracker = new Map();
    const firstRequest = new EventEmitter(); firstRequest.aborted = false;
    const firstResponse = new PassThrough({ highWaterMark: 1 }); firstResponse.pause();
    const firstSource = _test.pipeMediaFileResponse(
      firstRequest, firstResponse, mediaFile, { start: 0, end: fs.statSync(mediaFile).size - 1 },
      () => { streamErrors += 1; }, { tracker, key: 'same-session:same-media' }
    );
    await delay(60);
    assert.equal(firstSource.destroyed, false, '第一条慢代理媒体流应保持打开');

    const secondRequest = new EventEmitter(); secondRequest.aborted = false;
    const secondResponse = new PassThrough();
    let secondBytes = 0;
    secondResponse.on('data', (chunk) => { secondBytes += chunk.length; });
    secondResponse.resume();
    const secondSource = _test.pipeMediaFileResponse(
      secondRequest, secondResponse, mediaFile, { start: 8 * 1024 * 1024, end: 8 * 1024 * 1024 + 65535 },
      () => { streamErrors += 1; }, { tracker, key: 'same-session:same-media' }
    );
    await Promise.race([once(secondSource, 'close'), delay(1000)]);
    assert.equal(secondSource.destroyed, true, '第二条并发 Range 应完整结束');
    assert.equal(secondBytes, 65536, '第二条并发 Range 的全部字节都应抵达客户端');
    assert.equal(firstSource.destroyed, false, '同一会话同一文件的新 Range 不应销毁仍在转发的旧 Range');
    assert.equal(tracker.get('same-session:same-media')?.has(firstSource), true);
    firstResponse.destroy();
    await delay(30);
    assert.equal(tracker.has('same-session:same-media'), false, '所有并发流结束后应清理跟踪桶');
    assert.equal(streamErrors, 0, '客户端主动中止不应被记录成媒体读取错误');
    console.log('✓ 慢代理下同一会话同一文件的并发 Range 互不截断，并在结束后清理');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
