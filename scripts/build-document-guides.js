'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const docs = path.join(root, 'docs');

const guides = [
  ['user-guide', '普通用户完整使用说明', 'USER GUIDE', '从下载、启动、登录、建房到多端同步播放，给第一次使用 SyncWatch同步观影 的用户一条不绕路的操作路径。', 'user-guide.md', ['login.png', 'main-interface.png', 'synchronized-playback.png']],
  ['server-deployment-guide', '服务器部署与使用教程', 'SERVER DEPLOYMENT', '覆盖 Windows、Linux、Docker、HTTPS、Cloudflare Tunnel、备份、升级和上线安全检查。', 'server-deployment-guide.md', ['public-access-settings.png', 'backup-and-restore.png', 'main-interface.png']],
  ['cloud-media-deployment', '云端媒体与商业部署', 'CLOUD MEDIA', '解释对象存储、反向代理、Range 播放、同步协议和容量边界，帮助你选择合适的部署规模。', 'cloud-media-deployment.md', ['media-library.png', 'public-access-settings.png']],
  ['tips-and-advantages', '使用技巧与产品优势', 'PRACTICAL TIPS', '把部署顺序、权限策略、备份方法和自托管优势整理成可执行的日常清单。', 'tips-and-advantages.md', ['synchronized-playback.png', 'backup-and-restore.png']],
  ['release-artifacts', '发布文件与下载说明', 'RELEASE ARTIFACTS', '解释体验版、完整便携版、独立服务器和 Android 文件分别做什么，以及如何校验。', 'release-artifacts.md', ['project-cover.png', 'main-interface.png']],
  ['runtime-installation', 'cloudflared 与 Node.js 安装使用教程', 'RUNTIME INSTALLATION', '说明普通用户何时不需要环境，以及源码、独立服务器和手工 Tunnel 如何安装与诊断。', 'runtime-installation.md', ['public-access-settings.png', 'main-interface.png']],
  ['repository-map', '仓库文件地图', 'REPOSITORY MAP', '帮助新手找到 public、server、mobile、tests、docs、scripts 和 GitHub Actions 的职责边界。', 'repository-map.md', ['project-cover.png', 'main-interface.png']],
  ['quick-start', '新手快速开始', 'QUICK START', '从打开终端或双击程序，到第一次登录、建房、邀请成员和结束备份，按步骤完成第一次可用连接。', 'quick-start.md', ['login.png', 'main-interface.png', 'synchronized-playback.png']],
  ['contributing', '参与贡献', 'CONTRIBUTING', '说明 Fork、分支、格式检查、测试、Pull Request、维护者审核和版本发布流程。', '../CONTRIBUTING.md', ['project-cover.png']],
  ['wiki-guide', 'Wiki 使用与维护', 'WIKI GUIDE', '说明如何阅读、更新和发布 Wiki 教程，以及 Markdown 原文与 Pages HTML 的对应关系。', 'wiki-guide.md', ['project-cover.png']]
];

function escapeHtml(value) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const visualDocumentPages = new Map([
  ['user-guide.md', 'user-guide.html'],
  ['server-deployment-guide.md', 'server-deployment-guide.html'],
  ['cloud-media-deployment.md', 'cloud-media-deployment.html'],
  ['tips-and-advantages.md', 'tips-and-advantages.html'],
  ['release-artifacts.md', 'release-artifacts.html'],
  ['runtime-installation.md', 'runtime-installation.html'],
  ['repository-map.md', 'repository-map.html'],
  ['quick-start.md', 'quick-start.html'],
  ['management-center.md', 'management-center-guide.html'],
  ['architecture.md', 'architecture.html'],
  ['troubleshooting.md', 'troubleshooting.html'],
  ['wiki-guide.md', 'wiki-guide.html'],
  ['../CONTRIBUTING.md', 'contributing.html']
]);
function visualDocumentHref(href) {
  const [target, fragment] = href.split('#');
  const visual = visualDocumentPages.get(target);
  return visual ? `${visual}${fragment ? `#${fragment}` : ''}` : href;
}
function inline(value) {
  let result = escapeHtml(value);
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img class="doc-inline-image" src="$2" alt="$1" loading="lazy">');
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${visualDocumentHref(href)}">${label}</a>`);
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return result;
}
function markdownToSections(source) {
  const lines = source.split(/\r?\n/);
  const sections = [];
  let current = null;
  let list = null;
  let code = null;
  const flushList = () => { if (!list || !current) return; current.body.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`); list = null; };
  const flushCode = () => { if (!code || !current) return; current.body.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; };
  for (const line of lines) {
    if (line.startsWith('```')) { if (code) flushCode(); else { flushList(); code = []; } continue; }
    if (code) { code.push(line); continue; }
    const heading = line.match(/^#{2,3}\s+(.+)$/);
    if (heading) { flushList(); current = { title: heading[1].trim(), body: [] }; sections.push(current); continue; }
    if (!current) continue;
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (item) { list ||= []; list.push(item[1]); continue; }
    if (!line.trim()) { flushList(); continue; }
    flushList();
    current.body.push(`<p>${inline(line.trim())}</p>`);
  }
  flushList(); flushCode();
  return sections;
}

function stageHtml() {
  return `<div class="doc-stage" data-guide-stage tabindex="0" aria-label="教程执行过程的三维数据流，可拖动进行 360 度旋转"><div class="doc-stage__plane"></div><div class="doc-node"><strong>打开入口</strong><small>route / menu</small></div><div class="doc-node"><strong>填写配置</strong><small>input / policy</small></div><div class="doc-node"><strong>保存状态</strong><small>server / data</small></div><div class="doc-node"><strong>验证结果</strong><small>client / check</small></div><div class="doc-node"><strong>记录审计</strong><small>log / trace</small></div><div class="doc-node"><strong>成员反馈</strong><small>socket / event</small></div><div class="doc-node"><strong>可恢复</strong><small>backup / restore</small></div><i class="doc-beam"></i><i class="doc-beam"></i><i class="doc-beam"></i><i class="doc-beam"></i><i class="doc-pulse"></i><div class="doc-stage-controls"><button type="button" class="doc-stage-reset" data-guide-reset>复位视角</button><button type="button" class="doc-stage-toggle" data-guide-toggle>暂停动画</button><span>拖动 360° · 滚轮缩放 · 方向键微调</span></div></div>`;
}

function evidence(images, title) {
  return `<div class="doc-evidence">${images.map((image, index) => `<figure data-doc-tilt><img src="screenshots/${image}" alt="${escapeHtml(title)}相关真实界面截图 ${index + 1}" loading="lazy"><figcaption>${escapeHtml(title)}真实界面证据 ${index + 1}</figcaption></figure>`).join('')}</div>`;
}

function page(slug, title, kicker, intro, sourcePath, images, sections) {
  const sourceHref = sourcePath.startsWith('../') ? `https://github.com/xuange6610/SyncWatch/blob/main/${sourcePath.slice(3)}` : sourcePath;
  const visualHref = `${slug}.html`;
  const toc = sections.map((section, index) => `<a href="#chapter-${index + 1}">${escapeHtml(section.title)}</a>`).join('');
  const chapters = sections.map((section, index) => `<section class="doc-section" id="chapter-${index + 1}"><h2>${escapeHtml(section.title)}</h2>${section.body.join('')}</section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#10161b"><meta name="description" content="${escapeHtml(title)} | SyncWatch同步观影"><title>${escapeHtml(title)} | SyncWatch同步观影</title><link rel="icon" href="favicon.ico"><link rel="stylesheet" href="assets/guide.css"><link rel="stylesheet" href="assets/document-guide.css"></head><body class="doc-page"><div class="doc-progress"></div><a class="skip" href="#main">跳到正文</a><header class="guide-header"><div class="shell guide-topbar"><a class="guide-brand" href="index.html">SyncWatch同步观影</a><nav class="guide-nav" aria-label="教程导航"><a href="index.html">在线展示</a><a href="management-center.html">管理中心</a><a href="quick-start.html">快速开始</a><a href="https://github.com/xuange6610/SyncWatch">GitHub主页</a></nav></div></header><section class="doc-hero"><div class="doc-shell doc-hero-grid"><div><div class="doc-kicker">${escapeHtml(kicker)} / v2.4.0</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p><div class="doc-actions"><a class="doc-button primary" href="#chapter-1">开始阅读</a><a class="doc-button" href="${visualHref}">可视化阅读</a><a class="doc-button" href="${sourceHref}" download>下载 Markdown 源文档</a><a class="doc-button" href="index.html">回到展示站</a></div><p class="doc-source-note">页面内容从维护中的 Markdown 生成，网页负责阅读体验；源码入口单独提供下载。</p></div>${stageHtml()}</div></section><main id="main" class="doc-main"><div class="doc-shell doc-layout"><aside class="doc-toc"><strong>本页章节</strong>${toc}</aside><article>${chapters}${evidence(images, title)}<div class="doc-callout">操作完成后请回到真实应用验证结果。不要在公开 Issue、截图或日志中提交密码、令牌、真实 IP、邮箱或私人媒体信息。</div></article></div></main><footer class="doc-footer"><div class="doc-shell">SyncWatch同步观影 · Apache-2.0 · 作者：xuan<nav><a href="${visualHref}">可视化阅读</a><a href="${sourceHref}" download>下载 Markdown 源文档</a><a href="index.html">在线展示</a><a href="https://github.com/xuange6610/SyncWatch">GitHub主页</a></nav></div></footer><script src="assets/document-guide.js"></script></body></html>`;
}

for (const [slug, title, kicker, intro, sourcePath, images] of guides) {
  const absolute = sourcePath.startsWith('../') ? path.join(docs, sourcePath) : path.join(docs, sourcePath);
  let source = fs.readFileSync(absolute, 'utf8');
  const sections = markdownToSections(source);
  let rendered = page(slug, title, kicker, intro, sourcePath, images, sections);
  rendered = rendered.replace('<link rel="stylesheet" href="assets/document-guide.css">', '<link rel="stylesheet" href="assets/document-guide.css"><link rel="stylesheet" href="assets/pro-max.css">');
  if (slug === 'contributing') rendered = rendered.replace(/href="LICENSE"/g, 'href="https://github.com/xuange6610/SyncWatch/blob/main/LICENSE"');
  fs.writeFileSync(path.join(docs, `${slug}.html`), rendered, 'utf8');
}

const managementSource = fs.readFileSync(path.join(docs, 'management-center.md'), 'utf8');
const managementSections = markdownToSections(managementSource);
const managementLinks = ['room-upload','all-rooms','members-permissions','chat-records','accounts-registration','application-center','account-levels','notifications','mail-settings','log-center','server-settings'];
const managementBody = managementLinks.map((slug, index) => `<a class="doc-button" href="modules/${slug}.html">${String(index + 1).padStart(2, '0')} ${slug}</a>`).join('');
const managementPage = page('management-center-guide', '管理中心完整图文教程', 'ADMIN CONSOLE', '从登录、权限初始化，到 11 个管理模块的按钮、字段、结果和真实截图，按“打开入口 → 修改 → 保存 → 验证 → 记录”完成一次完整管理流程。', 'management-center.md', ['main-interface.png', 'member-panel.png', 'public-access-settings.png'], managementSections);
fs.writeFileSync(path.join(docs, 'management-center-guide.html'), managementPage.replace('<link rel="stylesheet" href="assets/document-guide.css">', '<link rel="stylesheet" href="assets/document-guide.css"><link rel="stylesheet" href="assets/pro-max.css">').replace('data-guide-stage tabindex="0"', 'data-guide-stage data-control-map tabindex="0"').replace('</article>', `<div class="doc-callout"><strong>11 个独立模块：</strong>${managementBody}</div></article>`), 'utf8');
console.log(`generated ${guides.length + 1} document guide pages`);



