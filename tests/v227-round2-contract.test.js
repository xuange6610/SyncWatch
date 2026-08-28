const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const index = read('public/index.html');
const app = read('public/js/app.js');
const css = read('public/css/style.css');
const notes = read('docs/release-notes-v2.2.7.md');

assert.match(index, /class="download-recommended"/);
assert.match(index, /SyncWatch-v2\.2\.7-Full-Offline-Portable-x64\.exe/);
assert.doesNotMatch(index, /SyncWatch-Full-Offline-macOS-v2\.2\.7/);
assert.doesNotMatch(index, /node-v24\.19\.0-macos/);
assert.match(app, /正在加入房间/);
assert.match(app, /已加入\$\{roomKind\}/);
assert.match(app, /headerThemeStatus\?\.addEventListener\('dblclick'/);
assert.match(app, /showFullscreenGestureIndicator\(nextLocked \? '🔒 已锁定画面操作' : '🔓 已解除画面锁定'\)/);
assert.match(app, /managementHubModal\.classList\.add\('management-loading'\)/);
assert.match(app, /room-card-badges/);
assert.match(css, /\.download-recommended\s*\{/);
assert.match(css, /\.room-card-badges\s*\{/);
assert.match(notes, /当前主题.*双击/);
assert.match(notes, /点击加入后.*提示|加入进度/);

console.log('v2.2.7 round-2 download, join, fullscreen, theme, management and room readability contracts passed.');
