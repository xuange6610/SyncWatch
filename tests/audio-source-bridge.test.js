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
assert.match(serverElectron, /汽水\|qishui\|soda/);
assert.match(clientElectron, /汽水\|qishui\|soda/);
assert.match(serverElectron, /Get-Process \| Where-Object/);
assert.match(clientElectron, /Get-Process \| Where-Object/);
assert.match(serverElectron, /kind: 'process'/);
assert.match(clientElectron, /kind: 'process'/);
assert.match(audioSmoke, /process\.platform\s*!==\s*['"]win32['"]/,
  'desktop audio smoke must declare its Windows-only platform boundary');

assert.match(app, /option\.value = `native:\$\{source\.id\}`/);
assert.match(app, /const selectedNativeId = selectedPlatform\.startsWith\('native:'\)/);
assert.match(app, /dataset\.sourceKind === 'process' \? fallbackScreenId/);
assert.match(app, /chromeMediaSourceId:\s*videoSourceId/);
assert.match(app, /fallbackScreenId[\s\S]{0,500}attempts\.push\(desktopConstraints\(fallbackScreenId\)\)/);
assert.match(app, /audio-share-start'[\s\S]{0,180}sourceName/);

assert.match(server, /const sourceName = cleanText\(payload\.sourceName, 120\)/);
assert.match(server, /roomState\.audioShare = \{[^\n]+platform, sourceName, volume \}/);
assert.match(server, /audioShare: \{ active: false,[^\n]+sourceName: ''/);

assert.doesNotMatch(mainPreload, /syncwatch:picture-in-picture/);

console.log('audio source bridge checks passed');
