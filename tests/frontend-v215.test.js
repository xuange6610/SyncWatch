'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const proMaxCss = fs.readFileSync(path.join(root, 'public', 'css', 'pro-max.css'), 'utf8');
const launcherProMaxCss = fs.readFileSync(path.join(root, 'public', 'css', 'pro-max-launcher.css'), 'utf8');
const launcher = fs.readFileSync(path.join(root, 'client-launcher.html'), 'utf8');

// 1) Guest login UI: button, socket event, occupied-IP handling, no remembered session.
assert.match(html, /id="guestLoginBtn"/);
assert.match(html, /游客模式 · 免注册/);
assert.doesNotMatch(html, /游客模式 · 免注册，退出即删除/);
assert.match(app, /emitAck\('guest-login'/);
assert.match(app, /GUEST_IP_OCCUPIED/);
assert.match(app, /finishAuthentication\(result, false, true\)/);
assert.match(app, /syncwatchGuestLogoutNotice/);
assert.match(app, /游客数据已清除，欢迎再次体验/);

// 2) Login marquee is moved inside the auth card while keeping the old hook.
assert.match(app, /\(elements\.authCard \|\| elements\.loginPage\)\.prepend\(marquee\)/);
assert.match(css, /\.login-page > \.login-marquee, \.auth-card > \.login-marquee/);
assert.match(css, /\.login-page\s*\{[^}]*padding-top:\s*12px/);

// 3) Login cube default rotation speed is 16 degrees per second.
assert.match(html, /id="loginCubeRotationSpeed"[^>]*value="16"/);
assert.match(html, /loginCubeRotationSpeedValue">16°\/秒</);
assert.match(app, /rotationSpeed: Math\.max\(0, Math\.min\(18, Number\.isFinite\(speed\) \? speed : 16\)\)/);
assert.match(app, /rotationSpeed: 16, faces: LOGIN_CUBE_FACE_DEFAULTS/);

// 4) Playback rate prompt only appears on real changes, auto-hides, and can be muted/restored.
assert.match(html, /id="playbackRatePrompt"/);
assert.match(html, /data-rate-prompt-action="session"/);
assert.match(html, /data-rate-prompt-action="day"/);
assert.match(html, /data-rate-prompt-action="never"/);
assert.match(app, /const PLAYBACK_RATE_PROMPT_KEY = 'syncwatchPlaybackRatePrompt'/);
assert.match(app, /appliedPlaybackRate/);
assert.match(app, /setTimeout\(\(\) => elements\.playbackRatePrompt\.classList\.add\('is-hidden'\), 5000\)/);
assert.match(app, /restore-playback-rate-prompt/);
assert.match(app, /localStorage\.removeItem\(PLAYBACK_RATE_PROMPT_KEY\)/);

// 5) Mail template preview keeps styles and the test recipient can pick a template.
assert.match(html, /id="mailTestTemplate"/);
assert.match(html, /value="verification">邮箱验证码模板/);
assert.match(html, /value="password-reset">密码重置验证码模板/);
assert.match(app, /templateEvent: elements\.mailTestTemplate\?\.value \|\| 'verification'/);
assert.match(app, /const previewHtml = html;/);
assert.match(html, /id="mailTemplatePreview"[^>]*min-height:420px/);

// 6) Verification code messages show only the fixed support mailbox plus the account name.
assert.match(app, /const SYNCWATCH_SUPPORT_EMAIL = '2590813506@qq\.com'/);
assert.match(app, /return `账号：\$\{accountName \|\| '待注册账号'\} · 收件邮箱：\$\{SYNCWATCH_SUPPORT_EMAIL\}`/);
assert.match(app, /验证码已发送（\$\{target\}）/);
assert.match(app, /toast\(`验证码已发送 · \$\{destination\}`, 'success', 7000\)/);
assert.match(app, /验证码将发送到 \$\{SYNCWATCH_SUPPORT_EMAIL\}/);

// 7) Account and registration lists support cards, compact, and table modes.
assert.match(html, /id="accountViewMode"/);
assert.match(html, /id="registrationViewMode"/);
assert.match(app, /accountViewMode: localStorage\.getItem\('syncwatchAccountViewMode'\) \|\| 'cards'/);
assert.match(app, /list\.className = `account-admin-list view-\$\{viewMode\}`/);
assert.match(app, /class="admin-account-table"/);
assert.match(app, /class="admin-request-table"/);
assert.match(css, /\.account-admin-list\.view-table, \.registration-request-list\.view-table/);
assert.match(css, /\.account-admin-list\.view-compact/);

// 8) Shared audio uses an interactive 48 kHz context, compact 20 ms PCM fallback and higher-quality WebRTC.
assert.match(app, /new AudioContext\(\{ latencyHint: 'interactive', sampleRate: 48000 \}\)/);
assert.match(app, /createScriptProcessor\(1024,/);
assert.match(app, /new Int16Array\(/);
assert.match(app, /sampleFormat: 's16'/);
assert.match(app, /state\.screenAudioQueue/);
assert.match(app, /state\.screenAudioLastSequence/);
assert.match(app, /maxBitrate = 256000/);
assert.match(app, /maxaveragebitrate=256000/);
assert.match(app, /jitterBufferTarget = 0\.12/);
assert.match(app, /minptime=10;ptime=20;maxplaybackrate=48000/);
assert.match(css, /grid-template-columns:\s*max-content minmax\(0, 1fr\) minmax\(0, auto\)/);
assert.match(css, /max-width:\s*min\(56vw, 470px\)/);

// 9) The web surface reports the current release and the standalone client uses the
// unified desktop product identity introduced by the split release.
assert.match(html, /版本 v2\.3\.1 · 版权所有/);
assert.match(html, /id="versionText">v2\.3\.1</);
assert.match(launcher, /<title>同步观影<\/title>/);
assert.match(launcher, /SYNCWATCH DESKTOP/);
assert.doesNotMatch(html, /v2\.0\.5|2\.0\.5/);
assert.doesNotMatch(app, /v2\.0\.5|2\.0\.5/);
assert.doesNotMatch(launcher, /v2\.0\.5|2\.0\.5/);

// 10) One server setting controls the supported Windows and Android downloads
// on both the login screen and the authenticated account menu.
assert.match(html, /id="downloadButtonsVisible"/);
for (const id of [
  'downloadClientBtn', 'downloadClientMainBtn', 'downloadLoginApkBtn', 'androidApkBtn'
]) assert.match(html, new RegExp(`id=["']${id}["']`));
assert.doesNotMatch(html, /id=["']downloadMac(?:Server|Client)/);
assert.match(app, /const showDownloads = state\.publicConfig\.downloadButtonsVisible !== false/);
assert.match(app, /notice-preferences-updated/);
assert.match(app, /downloadButtonsVisible: elements\.downloadButtonsVisible\?\.checked !== false/);

// 11) The application and standalone launcher both load the shared Pro Max
// redesign without reducing the existing 48 px Android touch targets.
assert.match(html, /href="\/css\/pro-max\.css"/);
assert.match(launcher, /href="public\/css\/pro-max-launcher\.css"/);
assert.match(proMaxCss, /@media \(max-width:\s*760px\)[\s\S]*?button:not\([^}]+min-height:\s*48px/);
assert.match(launcherProMaxCss, /focus-visible/);

console.log('Frontend current-release product, accessibility and Pro Max redesign contracts passed.');
