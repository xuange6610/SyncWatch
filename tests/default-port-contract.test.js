'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const runtimeContracts = [
  ['server/index.js', /const DEFAULT_PORT = 20311;/],
  ['electron-pink.js', /const DEFAULT_PORT = 20311;/],
  ['server-standalone.js', /const DEFAULT_PORT = 20311;[\s\S]*const rawPort = Object\.prototype\.hasOwnProperty\.call\(input, 'port'\)/],
  ['server/standalone-tunnel.js', /Number\(getPort\?\.\(\)\) \|\| 20311/],
  ['mobile/app/src/main/java/com/xuan/syncwatch/MobileServerService.java', /SERVER_PORT = 20311;/],
  ['mobile/app/src/main/java/com/xuan/syncwatch/MainActivity.java', /setHint\("20311"\)/],
  ['public/js/app.js', /state\.publicConfig\.port \|\| location\.port \|\| 20311/],
  ['Dockerfile', /PORT=20311[\s\S]*EXPOSE 20311/],
  ['docker-compose.yml', /SYNCWATCH_PORT:-20311/]
];

for (const [file, pattern] of runtimeContracts) {
  assert.match(read(file), pattern, `${file} 必须使用默认服务端口 20311`);
}

const currentPortDocs = [
  'docs/index.html',
  'docs/quick-start.md', 'docs/quick-start.html',
  'docs/runtime-installation.md', 'docs/runtime-installation.html',
  'docs/server-deployment-guide.md', 'docs/server-deployment-guide.html',
  'docs/standalone-server.md',
  'docs/cloud-media-deployment.md', 'docs/cloud-media-deployment.html',
  'docs/troubleshooting.md', 'docs/troubleshooting.html',
  'docs/management-center.html',
  'docs/wiki/04-公网访问与Cloudflare-Tunnel.md',
  'docs/wiki/07-故障排查.md',
  'docs/wiki/10-Cloudflared与Node安装.md',
  'docs/wiki/12-服务器部署完整教程.md',
  'docs/wiki/14-技术架构完整说明.md',
  'docs/wiki/15-常见错误完整手册.md',
  'docs/wiki/17-独立服务器部署.md',
  'docs/wiki/19-云端媒体与商业部署.md',
  'docs/wiki/23-运行环境完整教程.md'
];

for (const file of currentPortDocs) {
  const source = read(file);
  assert.match(source, /20311/, `${file} 必须记录当前默认端口`);
  assert.doesNotMatch(source, /5000/, `${file} 不得残留旧的默认端口`);
  assert.doesNotMatch(
    source,
    /(?:127\.0\.0\.1|localhost|0\.0\.0\.0):2026|(?:默认|监听|保持|开放|放行|限制|绑定|内部)[^\r\n]{0,40}(?:端口[^\r\n]{0,12})?2026|2026[^\r\n]{0,24}(?:端口|可限制|直接暴露)/i,
    `${file} 不得残留临时默认端口 2026`
  );
}

assert.doesNotMatch(read('README.md'), /(?:127\.0\.0\.1|192\.0\.2\.10):5000|`5000` 端口/);
assert.doesNotMatch(read('PRODUCT.md'), /默认(?:端口为|监听) 5000/);
assert.doesNotMatch(read('docs/architecture.md'), /(?:0\.0\.0\.0|127\.0\.0\.1):5000/);
assert.doesNotMatch(read('scripts/generate-doc-pages.js'), /127\.0\.0\.1:5000/);

console.log('Default server port 20311 runtime, Docker, Android, Pages, and Wiki contracts passed.');
