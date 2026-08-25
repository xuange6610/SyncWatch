'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
assert.match(app, /if\s*\(!result\.success\)\s*\{[\s\S]{0,260}loginErrorMessage\(result/, 'ordinary account login must expose actionable error IDs');
assert.match(app, /SOCKET_EVENT_FAILED[\s\S]{0,360}errorId/, 'socket failures must include a support error ID');

for (const id of [
  'showSuperAdminAccountsBtn',
  'uploadLimitTutorialBtn', 'uploadLimitTutorialModal', 'closeUploadLimitTutorialBtn',
  'accountAuditLogBtn', 'accountAuditLogModal', 'closeAccountAuditLogBtn',
  'accountAuditLogSearch', 'accountAuditLogType', 'accountAuditLogSelectAll',
  'deleteSelectedAccountAuditLogsBtn', 'accountAuditLogList'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing HTML control ${id}`);
  assert.match(app, new RegExp(`\\b${id}\\b`), `missing JS binding for ${id}`);
}

assert.match(app, /showSuperAdminAccountsBtn[^`]*accountAdminList/s,
  'super-admin filter button must be registered with the static element registry');
assert.match(app, /showSuperAdminAccountsBtn\?\.addEventListener\('click',\s*toggleSuperAdminAccountFilter\)/,
  'super-admin filter needs a working click listener');
assert.match(app, /function filterAndSortAccounts\([^)]*\{[^}]*superOnly\s*=\s*false[^}]*\}/,
  'account filtering must expose a reusable super-admin-only option');
assert.match(app, /if\s*\(superOnly\s*&&\s*account\.superAdmin\s*!==\s*true\s*&&\s*account\.username\s*!==\s*['"]admin['"]\)\s*return false/,
  'the reusable account filter must retain admin and explicit super-admin accounts');
assert.match(app, /filterAndSortAccounts\(sourceAccounts,\s*\{[\s\S]{0,300}superOnly:\s*state\.accountAdminSuperOnly/,
  'account administration must pass its super-admin-only state into the reusable filter');

assert.match(html, /class="header-online-stat"/,
  'the online metric needs its own stable layout class');
assert.match(app, /function updateHeaderOnlineMetric\(/,
  'online values need a deterministic compaction helper');
assert.match(css, /\.header-online-stat[\s\S]*white-space:\s*nowrap/,
  'online metric must stay on one line');

assert.match(app, /function openServerSettingsFromLogin\([\s\S]*!state\.authenticated[\s\S]*请先登录超级管理员账号/,
  'login-page settings must require an authenticated super-admin account');
assert.match(app, /async function loginAsServerAdmin\([\s\S]*host-passwordless-management-login[\s\S]*finishAuthentication\(result, state\.rememberSession, false\)[\s\S]*result\.sessionMode === ['"]management['"][\s\S]*openManagementHub\(['"]server['"]\)/,
  'server-admin login must use the dedicated passwordless event, trust the server-issued session mode, and land on settings');
assert.match(app, /if \(managementOnly\) \{[\s\S]*elements\.loginPage\.classList\.remove\(['"]is-hidden['"]\)[\s\S]*elements\.mainPage\.classList\.add\(['"]is-hidden['"]\)/,
  'server-admin settings authentication must keep the room surface hidden');

assert.match(app, /get-account-audit-logs/);
assert.match(app, /delete-account-audit-logs/);
assert.match(app, /set-account-email/);
assert.match(app, /delete-own-account/);
assert.match(app, /fillValue:\s*confirmationText/,
  'self deletion must expose the explicit one-click confirmation fill');

assert.match(app, /passwordStatusLine/,
  'account admin UI must render a password status line');
assert.match(app, /passwordMeta\.mustChange/,
  'account admin UI must expose must-change status');
assert.match(app, /passwordMeta\.expired/,
  'account admin UI must expose expiry status');
assert.match(app, /passwordMeta\.changedAt/,
  'account admin UI must expose safe password status metadata without exposing plaintext');
assert.doesNotMatch(app, /account\.passwordHash|account\.password\b/,
  'browser code must not render server-side password material');

console.log('Frontend v2.2.0 account management, auth gate, tutorial, audit, deletion, and responsive header contracts passed.');
