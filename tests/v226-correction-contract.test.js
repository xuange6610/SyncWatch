const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('public/js/app.js');
const html = read('public/index.html');
const css = read('public/css/style.css');
const server = read('server/index.js');

assert.match(html, /id="requestLoginConcurrencyBtn"/);
assert.match(app, /requestLoginConcurrencyBtn\?\.addEventListener\('click', requestLoginConcurrency\)/);
assert.match(app, /result\.code === 'LOGIN_CONCURRENCY_LIMIT'/);
assert.match(app, /emitAck\('login-concurrency-request'/);
assert.match(html, /id="loginConcurrencyRequestList"/);
assert.match(app, /resolve-login-concurrency-request/);
assert.match(server, /onSafe\('login-concurrency-request'/);
assert.match(server, /code: 'LOGIN_CONCURRENCY_LIMIT'/);
assert.match(server, /另一台设备已登录/);

assert.match(html, /id="accountSessionLimit"/);
assert.match(html, /id="guestSessionsPerIp"/);
assert.match(html, /id="accessRecordsList"/);
assert.match(app, /data-access-record-action="account-whitelist"/);
assert.match(app, /data-access-record-action="guest-whitelist"/);
assert.match(app, /data-access-record-action="ban"/);
assert.match(server, /payload\.accountSessionWhitelistIps/);
assert.match(server, /payload\.guestIpWhitelistIps/);

assert.match(app, /abortAgreementSession/);
assert.match(app, /if \(!state\.authenticated\) return;/);
assert.match(app, /state\.intentionalLogout = !reconnectSocket/);
assert.match(app, /memberProfileFriendAction/);
assert.match(app, /data-member-profile-action="friend-request"/);
assert.match(app, /LOGIN_CUBE_TEMPLATE_NAMES = Object\.freeze\(\[/);
assert.ok((app.match(/'[^']+'/g) || []).length > 50, '立方体预设数据应存在');

assert.match(app, /handlePlayerDoubleClick/);
assert.match(app, /cancelPendingFullscreenPlaybackGesture\(\)/);
assert.match(app, /if \(isPlayerFullscreen\(\)\) \{ showFullscreenControls\(\); openFullscreenChat\(\); \}/);
assert.match(css, /player-container:fullscreen \.danmaku-container/);
assert.match(css, /display: block !important; visibility: visible !important; opacity: 1 !important/);
assert.match(html, /data-owner-exit="leave" class="primary-button owner-exit-default"/);
assert.match(app, /!state\.authenticated \|\| !canManageServer/);
assert.match(app, /房间已创建：\$\{result\.room\.id\}（临时房间）/);

assert.match(html, /id="clientModeRequestCard"/);
assert.match(html, /id="clientModeRequestScope"/);
assert.match(html, /id="clientModeRequestUserList"/);
assert.match(app, /send-client-mode-request/);
assert.match(app, /client-mode-requested/);
assert.match(app, /client-mode-request-response/);
assert.match(server, /clientModeRequests/);
assert.match(server, /send-client-mode-request/);
assert.match(server, /cancel-client-mode-request/);
assert.match(server, /client-mode-request-response/);
assert.match(app, /login-page-visit/);
assert.match(server, /onSafe\('login-page-visit'/);
assert.match(app, /房间已创建：\$\{result\.room\.id\}（正式房间）/);
assert.match(app, /data-login-concurrency-action="revoke"/);
assert.match(server, /revoke-login-concurrency/);
assert.doesNotMatch(html, /SyncWatch同步观影 · v2\.2\.3/);
assert.doesNotMatch(html, /当前应用版本 v2\.2\.3/);
assert.doesNotMatch(app, /SyncWatch同步观影-v2\.2\.3/);

console.log('v2.2.6 correction login, policy, agreement, friend, fullscreen and UI contracts passed.');
