'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');

assert.match(html, /id="wechatUploadNotice"/);
assert.match(html, /微信内置浏览器提示/);
assert.match(html, /微信相册选择器可能限制视频最长 5 分钟/);
assert.match(html, /SyncWatch 服务端限制/);
assert.match(app, /function isWechatEmbeddedBrowser\(\)/);
assert.match(app, /MicroMessenger/);
assert.match(app, /updateWechatUploadNotice\(\)/);
assert.match(app, /elements\.wechatUploadNotice/);
assert.match(css, /\.wechat-upload-notice/);
console.log('WeChat embedded-browser upload notice contract passed.');
