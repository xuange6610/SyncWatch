const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const html = read('public/index.html');
const app = read('public/js/app.js');
const server = read('server/index.js');
const mainPreload = read('electron-main-preload.js');
const clientPreload = read('electron-client-preload.js');
const serverElectron = read('electron-pink.js');
const clientElectron = read('electron-client.js');
const audioSmoke = read('tests/audio-source-electron-smoke.js');

assert.match(html, /id="refreshAudioSourcesBtn"/);
assert.match(app, /refreshAudioSourcesBtn[^\n]*startAudioSourceBtn/);
assert.match(app, /elements\.refreshAudioSourcesBtn\?\.addEventListener\('click', refreshNativeAudioSources\)/);

assert.match(mainPreload, /listAudioSources:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('syncwatch:list-audio-sources'\)/);
assert.match(clientPreload, /listAudioSources:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('syncwatch-client:list-audio-sources'\)/);
assert.match(serverElectron, /ipcMain\.handle\('syncwatch:list-audio-sources'/);
assert.match(clientElectron, /ipcMain\.handle\('syncwatch-client:list-audio-sources'/);
assert.match(app, /audioSourceFallbackTimer/);
assert.match(app, /jitterBufferTarget = 0\.12/);
assert.match(app, /maxaveragebitrate=256000;usedtx=0;useinbandfec=1;minptime=10;ptime=20/);
assert.match(serverElectron, /汽水\|qishui\|soda/);
assert.match(clientElectron, /汽水\|qishui\|soda/);
assert.match(serverElectron, /Get-Process \| Where-Object/);
assert.match(clientElectron, /Get-Process \| Where-Object/);
assert.match(serverElectron, /kind: 'process'/);
assert.match(clientElectron, /kind: 'process'/);
assert.match(serverElectron, /callback\(\{ video: source, \.\.\.\(request\.audioRequested \? \{ audio: 'loopback' \} : \{\}\) \}\)/);
assert.match(serverElectron, /\}, \{ useSystemPicker: false \}\);/);
assert.match(audioSmoke, /process\.platform\s*!==\s*['"]win32['"]/,
  'desktop audio smoke must declare its Windows-only platform boundary');

assert.match(app, /option\.value = `native:\$\{source\.id\}`/);
assert.match(app, /const selectedNativeId = selectedPlatform\.startsWith\('native:'\)/);
assert.match(app, /dataset\.sourceKind === 'process' \? fallbackScreenId/);
assert.match(app, /chromeMediaSourceId:\s*videoSourceId/);
assert.match(app, /fallbackScreenId[\s\S]{0,500}attempts\.push\(desktopConstraints\(fallbackScreenId\)\)/);
assert.match(app, /audio-share-start'[\s\S]{0,180}sourceName/);

assert.match(server, /function sanitizeAudioSourceMetadata\(/);
assert.match(server, /sourceName: cleanText\(payload\.sourceName, 120\)/);
assert.match(server, /processName: cleanText\(payload\.processName, 80\)/);
assert.match(server, /roomState\.audioShare = \{[^\n]+platform, \.\.\.metadata, volume \}/);
assert.match(server, /audioShare: \{ active: false,[^\n]+processName: ''[^\n]+mediaTitle: ''/);

assert.doesNotMatch(mainPreload, /syncwatch:picture-in-picture/);

console.log('audio source bridge checks passed');
