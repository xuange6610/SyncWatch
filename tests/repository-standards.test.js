'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const requiredFiles = [
  'AGENTS.md',
  '.editorconfig',
  '.gitattributes',
  '.github/ISSUE_TEMPLATE/bug-report.yml',
  '.github/ISSUE_TEMPLATE/feature-request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/CODEOWNERS',
  '.github/workflows/ci.yml',
  '.github/workflows/release-windows.yml',
  '.github/workflows/release-atomic.yml',
  '.github/workflows/pages.yml',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'DESIGN.md',
  'LICENSE',
  'NOTICE',
  '.impeccable/design.json',
  'SECURITY.md',
  'docs/index.html',
  'docs/index.md',
  'docs/maintenance/maintainer-requirements.md',
  'docs/release/release-manifest.md',
  'docs/management-center.html',
  'docs/management-center-guide.html',
  'docs/troubleshooting.html',
  'docs/architecture.html',
  'docs/assets/guide.css',
  'docs/assets/guide.js',
  'docs/assets/document-guide.css',
  'docs/assets/document-guide.js',
  'docs/assets/module-guide.css',
  'docs/assets/module-guide.js',
  'docs/assets/site.css',
  'docs/assets/site.js',
  'docs/server-deployment-guide.md',
  'docs/architecture.md',
  'docs/user-guide.md',
  'docs/cloud-media-deployment.md',
  'docs/macos-build.md',
  'docs/troubleshooting.md',
  'docs/runtime-installation.md',
  'docs/runtime-installation.html',
  'docs/user-guide.html',
  'docs/server-deployment-guide.html',
  'docs/macos-build.html',
  'docs/cloud-media-deployment.html',
  'docs/tips-and-advantages.html',
  'docs/release-artifacts.html',
  'docs/repository-map.html',
  'docs/quick-start.html',
  'docs/quick-start.md',
  'docs/contributing.html',
  'docs/wiki-guide.html',
  'docs/assets/contact/qq-friend.jpg',
  'docs/assets/contact/wechat-friend.png',
  'docs/assets/contact/wechat-pay.png',
  'docs/screenshots/main-interface.png',
  'docs/wiki/10-Cloudflared与Node安装.md',
  'docs/wiki/12-服务器部署完整教程.md',
  'docs/wiki/13-管理中心完整教程.md',
  'docs/wiki/15-常见错误完整手册.md',
  'docs/wiki/23-运行环境完整教程.md',
  'docs/wiki/_Sidebar.md',
  'docs/tips-and-advantages.md',
  'docs/standalone-server.md',
  'build-windows.ps1',
  'scripts/release-candidate-gate.js',
  'scripts/release-third-party-assets.js',
  'tests/release-atomic-workflow.test.js',
  'tests/release-candidate-gate.test.js',
  'tests/release-third-party-assets.test.js',
  'electron-builder-windows-full-portable.json',
  'assets/app-icon.png',
  'assets/app-icon.ico'
];

for (const relative of requiredFiles) {
  assert.ok(exists(relative), `missing repository file: ${relative}`);
}

for (const obsolete of [
  '服务器部署与使用教程.md',
  '技术架构与依赖说明.md',
  '使用说明.md',
  '云端视频与商业部署说明.md',
  'MACOS-BUILD.md',
  'SERVER-README.md',
  '生成EXE.ps1',
  '同步观影图标2026.png',
  '同步观影图标2026.ico',
  'SyncWatch-main.zip'
]) {
  assert.ok(!exists(obsolete), `obsolete repository path still exists: ${obsolete}`);
}

const license = read('LICENSE');
assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
assert.match(license, /http:\/\/www\.apache\.org\/licenses\//);
assert.match(read('NOTICE'), /SyncWatch同步观影/);
assert.match(read('NOTICE'), /Copyright 2026 xuan/);

const manifest = JSON.parse(read('package.json'));
const sourceTag = `v${manifest.version}`;
const latestStableTag = sourceTag;
assert.equal(manifest.license, 'Apache-2.0');
assert.equal(manifest.description, 'SyncWatch同步观影');
assert.equal(manifest.build.productName, 'SyncWatch同步观影');
assert.equal(manifest.scripts['test:repo'], 'node tests/repository-standards.test.js');

const pnpmLock = read('pnpm-lock.yaml');
assert.match(pnpmLock, /\n      undici:\r?\n        specifier: \^7\.29\.0\r?\n        version: 7\.29\.0\r?\n/,
  'pnpm lockfile must keep undici as a direct production dependency');

const designMetadata = JSON.parse(read('.impeccable/design.json'));
assert.equal(designMetadata.schemaVersion, 2);
assert.match(read('DESIGN.md'), /^name: SyncWatch同步观影$/m);

const readme = read('README.md');
assert.match(readme, /^# SyncWatch同步观影/m);
assert.match(readme, /Apache-2\.0/);
assert.match(readme, /QQ:\s*2590813506/);
assert.match(readme, /微信:\s*love_020804/);
assert.match(readme, /xuange6610\.github\.io\/SyncWatch\//);
assert.match(readme, /docs\/screenshots\/main-interface\.png/);
const stableReleaseBanner = new RegExp(`当前正式发布：\\[${escapeRegExp(latestStableTag)}\\]\\(https:\\/\\/github\\.com\\/xuange6610\\/SyncWatch\\/releases\\/tag\\/${escapeRegExp(latestStableTag)}\\).*Latest`);
const candidateReleaseBanner = readme.includes('当前正式发布：[v2.2.5](https://github.com/xuange6610/SyncWatch/releases/tag/v2.2.5)') && readme.includes('v2.2.7') && readme.includes('候选分支');
assert.ok(stableReleaseBanner.test(readme) || candidateReleaseBanner, 'README must describe either the published version or an explicitly pending candidate');
assert.ok(new RegExp(`${escapeRegExp(latestStableTag)}.*发布并设为 Latest`, 's').test(readme) || new RegExp(`${escapeRegExp(latestStableTag)}.*源码候选改动.*等待`, 's').test(readme));
assert.match(readme, /10 个维护者资产.*(?:两个|2 个)(?: GitHub)? 源码归档.*12 个文件/s);
assert.match(readme, new RegExp(`SyncWatch-${escapeRegExp(latestStableTag)}-Full-Offline-Installer-x64\\.exe`));
assert.match(readme, new RegExp(`SyncWatch-${escapeRegExp(latestStableTag)}-Full-Offline-Portable-x64\\.exe`));
assert.match(readme, /cloudflared-windows-x64-installer\.msi/);
assert.match(readme, /node-v24\.19\.0-x64\.msi/);

const agents = read('AGENTS.md');
assert.match(agents, /12 个可见文件/);
assert.match(agents, /10 个维护者资产/);
assert.match(agents, /每次开始新任务/);
assert.match(agents, /每次任务完成/);
assert.match(agents, /docs\/maintenance\/maintainer-requirements\.md/);
const stableAgentSnapshot = `当前最新正式版本为 ${String.fromCharCode(96)}${latestStableTag}${String.fromCharCode(96)}`;
assert.ok(agents.includes(stableAgentSnapshot) || (agents.includes(`${latestStableTag}`) && agents.includes('候选')));
const maintainerRequirements = read('docs/maintenance/maintainer-requirements.md');
assert.match(maintainerRequirements, /每次开始任务必须执行/);
assert.match(maintainerRequirements, /10 个维护者真实资产/);
assert.match(maintainerRequirements, /12 个可见文件/);
assert.match(maintainerRequirements, /任何历史 Release、历史 tag 和旧版本资产都必须保留/);
assert.match(maintainerRequirements, /Release 正文与更新公告/);
assert.match(maintainerRequirements, /Android 验收要求/);
const stableMaintainerSnapshot = `当前线上正式版本：${String.fromCharCode(96)}${latestStableTag}${String.fromCharCode(96)}`;
assert.ok(maintainerRequirements.includes(stableMaintainerSnapshot) || (maintainerRequirements.includes(`${latestStableTag}`) && maintainerRequirements.includes('候选')));
const releaseManifest = read('docs/release/release-manifest.md');
assert.match(releaseManifest, /Source code \(zip\)/);
assert.match(releaseManifest, /26 个维护者资产/);
assert.match(releaseManifest, new RegExp(`(?:${escapeRegExp(latestStableTag)}.*Latest|${escapeRegExp(latestStableTag)}.*当前只是候选)`, 's'));

const releaseNotes = read('docs/release-notes-v2.2.0.md');
assert.match(releaseNotes, /GitHub Release v2\.2\.0/);
assert.match(releaseNotes, /## macOS/);
assert.match(releaseNotes, /## 首次启动、升级与安全/);
assert.match(releaseNotes, /## cloudflared 独立工具/);
assert.match(releaseNotes, /## Node\.js 官方环境包/);
const currentReleaseNotesPath = `docs/release-notes-${sourceTag}.md`;
assert.ok(exists(currentReleaseNotesPath), `missing current release notes: ${currentReleaseNotesPath}`);
const currentReleaseNotes = read(currentReleaseNotesPath);
assert.match(currentReleaseNotes, new RegExp(`SyncWatch同步观影 ${escapeRegExp(sourceTag)} 发布说明`));
assert.match(currentReleaseNotes, /17 个 SyncWatch 应用资产/);
assert.match(currentReleaseNotes, /最终.*Tag.*真实重建/s);

const pages = read('.github/workflows/pages.yml');
assert.match(pages, /pages:\s*write/);
assert.match(pages, /id-token:\s*write/);
assert.match(pages, /actions\/upload-pages-artifact@v3/);
assert.match(pages, /path:\s*docs/);
assert.match(pages, /actions\/deploy-pages@v4/);

const contributionChecks = read('.github/workflows/ci.yml');
assert.match(contributionChecks, /pull_request:/);
assert.match(contributionChecks, /npm run test:repo/);
assert.match(contributionChecks, /npm test/);
assert.match(contributionChecks, /npm run test:credential-policy/);
assert.match(contributionChecks, /npm run test:release-gates/);
assert.match(read('.github/CODEOWNERS'), /@xuange6610/);
assert.match(read('CONTRIBUTING.md'), /Pull Request/);
assert.match(read('CONTRIBUTING.md'), /分支保护/);

const windowsRelease = read('.github/workflows/release-windows.yml');
const macReleaseWorkflow = read('.github/workflows/release-macos.yml');
const atomicReleaseWorkflow = read('.github/workflows/release-atomic.yml');
const releaseCandidateGate = read('scripts/release-candidate-gate.js');
assert.match(windowsRelease, /npm install --global pnpm@11\.9\.0/,
  'Windows release must install the package manager used by Electron Builder dependency collection');
assert.match(windowsRelease, /npx electron-builder --win portable --x64 --publish never/,
  'Windows portable build must not require a publish token before assets are collected');
assert.match(windowsRelease, /npm run build:client -- --publish never/,
  'Windows client build must not require a publish token before the upload step');
assert.match(windowsRelease, /electron-builder-windows-installer\.json --win nsis --x64 --publish never/,
  'Windows installer build must not require a publish token before the upload step');
assert.match(windowsRelease, /name:\s*\$\{\{ inputs\.artifact_prefix \}\}-windows-base/,
  'Windows reusable workflow artifacts must use the immutable caller prefix');
const cloudflaredPrepareIndex = windowsRelease.indexOf('Prepare pinned Cloudflare Tunnel binary');
const sourcePrivacyIndex = windowsRelease.indexOf('npm run test:privacy');
const buildIndex = windowsRelease.indexOf('Build Windows base artifacts', sourcePrivacyIndex);
const releasePrivacyIndex = windowsRelease.lastIndexOf('npm run test:privacy:release');
assert.ok(cloudflaredPrepareIndex >= 0 && cloudflaredPrepareIndex < sourcePrivacyIndex,
  'Windows release must prepare cloudflared before pre-build contracts');
assert.ok(sourcePrivacyIndex < buildIndex && buildIndex < releasePrivacyIndex,
  'Windows release must scan source before building and artifacts after building');
assert.match(releaseCandidateGate, /function manifestForVersion/);
assert.match(releaseCandidateGate, /case 'final': return manifest/);
assert.match(releaseCandidateGate, /Final candidate must contain exactly/);
assert.match(windowsRelease, /workflow_call:/);
assert.match(windowsRelease, /if: inputs\.phase == 'android'/);
assert.match(windowsRelease, /if: inputs\.phase == 'base'/);
assert.match(windowsRelease, /if: inputs\.phase == 'full'/);
assert.doesNotMatch(windowsRelease, /gh release upload|--draft=false|--latest/);
assert.match(macReleaseWorkflow, /workflow_call:/);
assert.match(macReleaseWorkflow, /if: inputs\.phase == 'base'/);
assert.match(macReleaseWorkflow, /if: inputs\.phase == 'full'/);
assert.doesNotMatch(macReleaseWorkflow, /gh release upload|--draft=false|--latest/);
assert.match(atomicReleaseWorkflow, /test \"\$WORKFLOW_REF\" = \"refs\/tags\/\$\{RELEASE_TAG\}\"/);
assert.match(atomicReleaseWorkflow, /test \"\$WORKFLOW_SHA\" = \"\$commit_sha\"/);
assert.match(atomicReleaseWorkflow, /Generate source archives directly in dist and verify exact 28/);
assert.match(atomicReleaseWorkflow, /gh release upload \"\$RELEASE_TAG\" \"\$\{replacement_files\[@\]\}\"/);
assert.match(atomicReleaseWorkflow, /-F draft=false[\s\S]*-f make_latest=true/);
assert.match(atomicReleaseWorkflow, /Atomic replacement failed before cutover/);

const site = read('docs/index.html');
assert.match(site, /<html\s+lang="zh-CN">/);
assert.match(site, /<title>SyncWatch同步观影/);
assert.match(site, /<h1[^>]*>[^<]*SyncWatch同步观影/s);
assert.match(site, /GitHub Pages 仅提供静态展示/);
assert.match(site, /href="architecture\.html"[^>]*>阅读完整技术架构</,
  'architecture action must open the designed HTML guide');

const managementCenter = read('docs/management-center.html');
assert.match(managementCenter, /href="troubleshooting\.html"[^>]*>查看错误处理</,
  'management center troubleshooting action must open the designed HTML guide');
assert.match(managementCenter, /href="management-center-guide\.html"[^>]*>查看完整图文教程</,
  'management center guide action must open the designed HTML guide');

const troubleshootingGuide = read('docs/troubleshooting.html');
assert.match(troubleshootingGuide, /<html\s+lang="zh-CN">/);
assert.match(troubleshootingGuide, /data-diagnostic-console/);
assert.match(troubleshootingGuide, /href="troubleshooting\.md"/,
  'troubleshooting HTML must preserve access to the Markdown source');

const managementGuide = read('docs/management-center-guide.html');
assert.match(managementGuide, /<html\s+lang="zh-CN">/);
assert.match(managementGuide, /data-control-map/);
assert.match(managementGuide, /href="management-center\.md"/,
  'management HTML guide must preserve access to the Markdown source');

const architectureGuide = read('docs/architecture.html');
assert.match(architectureGuide, /<html\s+lang="zh-CN">/);
assert.match(architectureGuide, /data-architecture-stage/);
assert.match(architectureGuide, /data-tilt/,
  'architecture guide must expose pointer-driven 3D interaction');
assert.match(architectureGuide, /href="architecture\.md"/,
  'architecture HTML must preserve access to the Markdown source');

const designedDocRoutes = [
  ['user-guide.html', 'user-guide.md'],
  ['server-deployment-guide.html', 'server-deployment-guide.md'],
  ['macos-build.html', 'macos-build.md'],
  ['cloud-media-deployment.html', 'cloud-media-deployment.md'],
  ['tips-and-advantages.html', 'tips-and-advantages.md'],
  ['release-artifacts.html', 'release-artifacts.md'],
  ['runtime-installation.html', 'runtime-installation.md'],
  ['repository-map.html', 'repository-map.md'],
  ['quick-start.html', 'quick-start.md']
];
for (const [htmlPath, markdownPath] of designedDocRoutes) {
  const html = read(`docs/${htmlPath}`);
  assert.match(html, /data-guide-stage/, `${htmlPath} must include the animated guide stage`);
  assert.match(html, /data-guide-stage[^>]*tabindex="0"/, `${htmlPath} must expose keyboard-accessible 3D interaction`);
  assert.match(html, /data-guide-reset/, `${htmlPath} must expose a 3D view reset control`);
  assert.ok(html.includes(`href="${markdownPath}"`), `${htmlPath} must preserve its Markdown source link`);
}

for (const htmlPath of fs.readdirSync(path.join(root, 'docs'), { recursive: true })
  .filter((entry) => typeof entry === 'string' && entry.endsWith('.html'))) {
  const html = read(path.join('docs', htmlPath));
  assert.match(html, /(?:\.\.\/|)assets\/pro-max\.css/,
    `${htmlPath} must load the shared Pro Max design layer`);
}

const moduleRoutes = [
  'room-upload', 'all-rooms', 'members-permissions', 'chat-records',
  'accounts-registration', 'application-center', 'account-levels',
  'notifications', 'mail-settings', 'log-center', 'server-settings'
];
for (const route of moduleRoutes) {
  const html = read(`docs/modules/${route}.html`);
  const imagePaths = [...html.matchAll(/data-module-image[^>]+data-src="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(imagePaths.length, 5, `${route} must present exactly five module screenshots`);
  assert.equal(new Set(imagePaths).size, 5, `${route} screenshots must not repeat`);
  imagePaths.forEach((imagePath) => assert.ok(exists(path.join('docs/modules', imagePath)), `missing module screenshot: ${imagePath}`));
  assert.match(html, /data-module-stage/, `${route} must include the interactive 3D monitor`);
  assert.match(html, /href="\.\.\/assets\/pro-max\.css"/, `${route} must load the shared Pro Max design layer`);
}

assert.match(site, /data-contact-image="assets\/contact\/qq-friend\.jpg"/,
  'footer QQ action must open the public friend QR image');
assert.match(site, /data-contact-image="assets\/contact\/wechat-friend\.png"/,
  'footer WeChat action must open the public friend QR image');
assert.match(site, /data-support-action/,
  'footer must expose the donation QR action');
assert.match(read('docs/assets/site.js'), /dblclick/,
  'donation QR must open on double click');

for (const relative of ['build-server-package.ps1', 'mobile/app/build.gradle']) {
  assert.doesNotMatch(read(relative), /[A-Z]:[\\/]Users[\\/]Administrator/i,
    `machine-specific user path found in ${relative}`);
}

for (const match of site.matchAll(/(?:href|src)="([^"]+)"/g)) {
  const target = match[1];
  if (/^(?:https?:|mailto:|tel:|#)/.test(target)) continue;
  const clean = target.split(/[?#]/, 1)[0];
  assert.ok(fs.existsSync(path.resolve(root, 'docs', clean)), `broken Pages asset: ${target}`);
}

console.log('repository standards and GitHub Pages contract passed.');
