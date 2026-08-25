require('./epipe-guard');

const assert = require('node:assert/strict');
const http = require('node:http');
const { app, BrowserWindow, desktopCapturer, session } = require('electron');

const captureScript = (sourceId) => `
  (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: { mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: ${JSON.stringify(sourceId)},
        minWidth: 160,
        maxWidth: 640,
        minHeight: 90,
        maxHeight: 360,
        maxFrameRate: 1
      } }
    });
    const result = {
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
      audioLabel: stream.getAudioTracks()[0]?.label || ''
    };
    stream.getTracks().forEach((track) => track.stop());
    return result;
  })()
`;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function run() {
  if (process.platform !== 'win32') {
    console.log(`audio capture smoke skipped on ${process.platform}; Windows loopback validation runs on the Windows release runner.`);
    return;
  }
  await app.whenReady();
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  });
  const qishui = sources.find((source) => /汽水|qishui|soda/i.test(source.name));
  const screen = sources.find((source) => source.id.startsWith('screen:'));
  assert.ok(qishui || screen, 'Electron should enumerate at least one capturable audio source');

  const webServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>SyncWatch同步观影 audio capture smoke</title>');
  });
  const port = await listen(webServer);
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === 'media'));
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await window.loadURL(`http://127.0.0.1:${port}/`);

  const attempts = [qishui, screen].filter(Boolean).filter((source, index, items) => items.findIndex((item) => item.id === source.id) === index);
  let captured = null;
  let lastError = null;
  for (const source of attempts) {
    try {
      const result = await window.webContents.executeJavaScript(captureScript(source.id), true);
      if (result.audioTracks > 0 && result.videoTracks > 0) {
        captured = { source, result };
        break;
      }
    } catch (error) { lastError = error; }
  }

  window.destroy();
  await new Promise((resolve) => webServer.close(resolve));
  assert.ok(captured, lastError?.message || 'Electron did not expose a Windows loopback audio track');
  assert.ok(captured.result.videoTracks > 0);
  console.log(`audio capture smoke passed: selected=${qishui?.name || 'not-running'}, captured=${captured.source.name}, audio=${captured.result.audioLabel || 'loopback'}`);
}

run().then(() => app.quit(), (error) => {
  console.error(error);
  app.exit(1);
});
