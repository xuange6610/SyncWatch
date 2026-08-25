'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const html = read('public', 'index.html');
const app = read('public', 'js', 'app.js');
const css = read('public', 'css', 'style.css');
const noticePreferences = read('public', 'js', 'notification-preferences.js');
const ai = read('public', 'js', 'ai-workbench.js');
const server = read('server', 'index.js');

const failures = [];
const passes = [];

function check(group, name, assertion) {
  try {
    assertion();
    passes.push({ group, name });
  } catch (error) {
    const rawMessage = error?.message || String(error);
    const inputAt = String(rawMessage).indexOf('Input:');
    const message = String(rawMessage).slice(0, inputAt >= 0 ? inputAt : undefined).replace(/\s+/g, ' ').trim();
    failures.push({ group, name, message });
  }
}

function section(source, start, end) {
  const startAt = source.indexOf(start);
  assert.ok(startAt >= 0, `missing section marker: ${start}`);
  const endAt = end ? source.indexOf(end, startAt + start.length) : -1;
  return source.slice(startAt, endAt > startAt ? endAt : startAt + 12000);
}

function assertControl(id) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing control ${id}`);
  assert.match(app, new RegExp(`\\b${id}\\b`), `missing binding ${id}`);
}

// Frontend contracts already present in the round-26 handoff.
check('account overview', 'presence filter, name sorting, and fuzzy search', () => {
  for (const id of ['accountAdminPresence', 'accountAdminSort', 'accountAdminSearch', 'accountOverviewPresence', 'accountOverviewSort']) assertControl(id);
  assert.match(app, /function filterAndSortAccounts\([\s\S]*presence[\s\S]*sort/);
  assert.match(app, /filterAndSortAccounts\(sourceAccounts/);
});

check('email UX', 'verification destinations show account and masked mailbox', () => {
  assert.match(app, /function maskEmailAddress\(/);
  assert.match(app, /function verificationDestination\([\s\S]*maskEmailAddress/);
  assert.match(app, /verificationDestination\(result, elements\.regUsername/);
  assert.match(app, /verificationDestination\(requested/);
});

check('sharing', 'room QR and copy fallback keep the room query', () => {
  assert.match(app, /document\.execCommand\(['"]copy['"]\)/);
  const addressBuilder = section(app, 'function shareAddressForBase', 'function publicShareAddress');
  assert.match(addressBuilder, /searchParams\.set\(['"]room['"],\s*roomId\)/);
  assert.match(addressBuilder, /room=\$\{encodeURIComponent\(roomId\)\}/);
  assert.match(app, /title:\s*['"]生成房间二维码[\s\S]{0,700}value:\s*['"]public['"][\s\S]{0,300}value:\s*['"]lan['"]/);
});

check('friends', 'friend list precedes discovery and supports collapse, clear, pin, and groups', () => {
  const listAt = app.indexOf('friend-list-card');
  const directoryAt = app.indexOf('friend-directory-card', listAt);
  assert.ok(listAt > 0 && directoryAt > listAt, 'friend list must render before directory search');
  for (const action of ['friend-directory-toggle', 'friend-directory-clear', 'friend-pin', 'friend-group']) {
    assert.match(app, new RegExp(`data-profile-action=["']${action}["']`));
  }
  assert.match(css, /\.friend-profile-item\.is-pinned/);
});

check('cube', 'login cube is present before connection and uses inertial pointer motion', () => {
  assert.match(html, /id=["']loginCubeScene["'][\s\S]*id=["']loginCube["']/);
  assert.match(html, /login-cube-(front|back|right|left|top|bottom)/);
  assert.match(app, /loginCubeScene[\s\S]{0,700}addEventListener\(['"]pointerdown['"]/);
  assert.match(app, /function stopLoginCubeMotion[\s\S]{0,260}cancelAnimationFrame/);
  assert.match(css, /\.login-cube\s*\{[^}]*transform-style:\s*preserve-3d/);
});

check('media', 'range-capable media delivery, text/HLS input, and clear-stage controls', () => {
  const media = section(server, 'function serveMediaRange', 'function normalizeRelativePath');
  assert.match(media, /Accept-Ranges/);
  assert.match(media, /Content-Range/);
  assert.match(server, /\[['"]\.m3u8['"][\s\S]*\[['"]\.txt['"]/);
  assert.match(html, /accept=["'][^"']*\.txt/);
  assert.match(app, /const clearableStage = Boolean\(state\.currentFile \|\| state\.webShare\.active \|\| state\.screenShareActive\)/);
  assert.match(server, /function uploadPolicyExempt\([\s\S]*isSuperAdmin/);
});

check('tunnel media', 'public video responses use octet-stream so HTTP tunnels relay Range bodies', () => {
  const media = section(server, 'function serveMediaRange', 'function normalizeRelativePath');
  assert.match(media, /localMediaHost/);
  assert.match(media, /application\/octet-stream/);
  assert.match(media, /Accept-Ranges/);
});

check('cube copy', 'removed gesture instruction does not regress into the login surface', () => {
  assert.doesNotMatch(html, /按住并轻扫|轻扫立方体/);
});

// Backend contracts that are currently missing or only wired on the frontend.
check('account numbers', 'server exposes configurable account-number policy and per-account edits', () => {
  assert.match(html, /id=["']accountIdPolicy/);
  assert.match(server, /function normalizeAccount(?:Number|Id)Policy\(/);
  assert.match(server, /action === ['"]set-account-(?:number|id)-policy['"]/);
  assert.match(server, /action === ['"]set-account-(?:number|id)['"]/);
});

check('password recovery', 'unknown account/mailbox returns an explicit error and the UI no longer promises privacy masking', () => {
  const request = section(server, 'async function requestPasswordReset', 'function verifyPasswordReset');
  assert.match(request, /if\s*\(!target\)\s*return\s*\{\s*success:\s*false/);
  assert.match(request, /maskedEmail|maskedDestination/);
  const ui = section(app, 'async function recoverPasswordByEmail', 'async function login');
  assert.doesNotMatch(ui, /不会提示账号是否存在/);
});

check('registration email', 'every supplied registration email requires a verified one-time code', () => {
  const register = section(server, "onSafe('user-register'", "onSafe('account-room-list'");
  assert.match(register, /if\s*\(email\s*&&\s*!verifyRegistrationEmailCode\(email,\s*payload\.emailVerificationCode(?:\s*\?\?\s*payload\.emailCode)?\)/);
  assert.match(register, /emailVerified:\s*true|emailVerified:\s*Boolean\(email\s*&&/);
});

check('verification center', 'admin actions persist searchable verification-code audit records', () => {
  assert.match(server, /action === ['"]get-verification-codes['"]/);
  assert.match(server, /action === ['"]delete-verification-codes['"]/);
  assert.match(server, /verificationCode(?:Records|Audit|History)/);
  assert.match(server, /verification(?:RateLimit|Code).*?(?:enabled|disable|unblock)/i);
});

check('notification preferences', 'registration/all-notification suppression is server-backed and requires typed confirmation', () => {
  assert.match(server, /notificationPreferences|noticePreferences/);
  assert.match(server, /set-(?:notification|notice)-preferences/);
  assert.match(server, /disable-all-(?:notifications|notices)|allNotificationsEnabled/);
  assert.match(app + noticePreferences, /showRiskConfirmation|fillValue/);
});

check('AI sync', 'AI config sync requests and responses are handled by the server', () => {
  assert.match(server, /onSafe\(['"]ai-config-sync-request['"]/);
  assert.match(server, /onSafe\(['"]ai-config-sync-response['"]/);
  assert.match(server, /ai-config-sync-requested/);
  assert.match(server, /ai-config-sync-delivered/);
  assert.match(ai, /scope[\s\S]{0,500}value:\s*['"]room['"][\s\S]{0,300}value:\s*['"]online['"]/);
});

check('login music', 'uploaded/batched login music is persisted, served, and removable', () => {
  assert.match(server, /app\.(?:post|use)\(['"]\/api\/login-music-upload['"]/);
  assert.match(server, /action === ['"]set-login-music['"]/);
  assert.match(server, /loginMusic/);
  assert.match(server, /delete-login-music|removeLoginMusic/);
});

check('mail defaults', 'fresh servers enable SMTP by default while preserving an explicit opt-out', () => {
  const mail = section(server, 'function normalizeMailSettings', 'function cleanUsername');
  assert.match(mail, /enabled:\s*(?:source\.enabled\s*!==\s*false|true)/);
  assert.match(server, /mail:\s*normalizeMailSettings\(\)/);
});

check('mail templates', 'the fifty presets carry materially distinct layout/style metadata', () => {
  const presets = section(app, 'const MAIL_TEMPLATE_PRESETS =', 'window.__syncWatchNativeCaptureState');
  const list = presets.slice(presets.indexOf('[') + 1, presets.indexOf('].map'));
  assert.equal((list.match(/'(?:\\.|[^'])*'/g) || []).length, 50, 'expected exactly 50 built-in presets');
  assert.match(presets, /(?:layout|background|fontFamily|templateHtml|markup)\s*:/);
  const colors = new Set(presets.match(/#[0-9a-f]{6}/gi) || []);
  assert.ok(colors.size >= 10, `expected at least 10 distinct preset colors, got ${colors.size}`);
});

check('previous-step navigation', 'multi-step dialogs expose a back action when a previous step exists', () => {
  const flows = [
    ['requestRegistrationAllowance', 'async function recoverPasswordByEmail'],
    ['recoverPasswordByEmail', 'async function login'],
    ['promptRequiredAccountPasswordChange', 'async function dissolveCurrentRoom'],
    ['addRemoteVideo', 'function chooseUploadFolder'],
    ['convertTemporaryRoom', 'async function changeCurrentRoomId'],
    ['requestMoreRoomsWithCredentials', 'async function requestMoreRooms']
  ];
  for (const [name, end] of flows) {
    const flow = section(app, `function ${name}`, end);
    const nextDialogs = flow.match(/showApp(?:Input|Select)\(\{[\s\S]*?confirmText:\s*['"]下一步['"][\s\S]*?\}\)/g) || [];
    for (const dialog of nextDialogs) {
      if (name === 'promptRequiredAccountPasswordChange') {
        assert.match(dialog, /allowBack:\s*(?:true|!skipCurrentPasswordVerification)/);
      } else {
        assert.match(dialog, /allowBack:\s*true/);
      }
    }
  }
});

check('document preview', 'same-origin PDF preview is allowed by CSP', () => {
  assert.match(server, /frame-ancestors ['"]self['"]/);
  assert.doesNotMatch(server, /frame-ancestors ['"]none['"]/);
});

check('ordinary notifications', 'account registration notices use timed toasts, not the persistent request center', () => {
  const handler = section(app, 'function showAccountNotification', 'function handleRoomPasswordEnforcement');
  assert.match(handler, /account-registration/);
  assert.match(handler, /toast\(/);
  assert.doesNotMatch(handler, /account-registration[\s\S]{0,180}addPersistentRequest/);
});

check('login marquee', 'login marquee is bounded and cannot cover the auth card', () => {
  const loginRule = section(css, '.login-page > .login-marquee', '@media (max-width: 760px)');
  assert.match(loginRule, /max-(?:width|inline-size)|overflow:\s*hidden|grid-column/);
  assert.match(css, /\.login-page\s*\{[^}]*padding-top:\s*12px/);
});

const grouped = new Map();
for (const item of failures) {
  if (!grouped.has(item.group)) grouped.set(item.group, []);
  grouped.get(item.group).push(item);
}

console.log(`Round-26 contract audit: ${passes.length} passed, ${failures.length} failed.`);
for (const [group, items] of grouped) {
  console.log(`\n[${group}]`);
  for (const item of items) console.log(`- ${item.name}: ${item.message}`);
}

if (failures.length) process.exitCode = 1;
