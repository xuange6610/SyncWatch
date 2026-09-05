'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');

// Node.js Mobile 18 builds can omit crypto.randomUUID even when randomBytes is
// available. Keep one RFC 4122 v4 fallback so Android login, audit and upload
// paths do not fail while desktop Node/Electron continue using the native API.
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = () => {
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
const { spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const { pipeline, Transform } = require('stream');

const compression = require('compression');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server: SocketIOServer } = require('socket.io');
const networkQualityPolicy = require('../public/js/network-quality-policy');
const { extractAiModelIds, extractAiText, modelEndpointCandidates, normalizeEndpointPath, proxyAiJson } = require('./ai-relay');
const { createLatestReleaseChecker } = require('./latest-release');
const { clientFacingAddressState } = require('./client-address-privacy');

function resolveDefaultDataDir(root = process.cwd()) {
  const preferred = path.resolve(root, 'SyncWatch同步观影-Data');
  const legacy = path.resolve(root, 'SyncWatch-Data');
  if (fs.existsSync(preferred) || !fs.existsSync(legacy)) return preferred;
  try { fs.renameSync(legacy, preferred); return preferred; }
  catch (_) { return legacy; }
}

const APP_VERSION = 'v2.4.3';

function applyNetworkQualitySample(user, payload = {}) {
  if (!user || user.connectionState === 'reconnecting') {
    return { ignored: true, connectionState: user?.connectionState || 'reconnecting' };
  }
  const sequence = Number(payload.sequence);
  const hasSequence = Number.isSafeInteger(sequence) && sequence > 0;
  const lastSequence = Number(user.networkQualityLastSequence) || 0;
  if (hasSequence && sequence <= lastSequence) {
    return { ignored: true, connectionState: user.connectionState || 'online', sequence };
  }
  if (hasSequence) {
    Object.defineProperty(user, 'networkQualityLastSequence', {
      configurable: true, enumerable: false, writable: true, value: sequence
    });
  }
  user.latency = Math.max(0, Math.min(9999, Number(payload.latency) || 0));
  user.syncPercent = Math.max(0, Math.min(100, Number(payload.syncPercent) || 0));
  user.drift = Math.max(-3600, Math.min(3600, Number(payload.drift) || 0));
  user.playbackQuality = ['auto', 'smooth', 'original'].includes(String(payload.playbackQuality))
    ? String(payload.playbackQuality) : (user.playbackQuality || 'original');
  if (!user.networkQualityTracker || typeof user.networkQualityTracker.observe !== 'function') {
    Object.defineProperty(user, 'networkQualityTracker', {
      configurable: true, enumerable: false, writable: true,
      value: networkQualityPolicy.createTracker({ initialState: user.connectionState })
    });
  }
  const observation = user.networkQualityTracker.observe({
    latencyMs: payload.latency,
    timedOut: payload.sampleStatus === 'timeout'
  });
  user.connectionState = observation.state;
  return {
    ...observation, ignored: false, connectionState: user.connectionState,
    sequence: hasSequence ? sequence : null
  };
}
const DEFAULT_MARQUEE_TEXT = '欢迎使用SyncWatch同步观影~ 此软件由xuan独立开发  SyncWatch同步观影为您带来极致的同步观影体验~ 如需更改此公告请前往设置中进行修改哦~';
// Legacy keys remain an explicit compatibility contract. Runtime-discovered
// copy uses opaque ui.auto keys that can never be interpreted as selectors or
// DOM paths, so full-surface customization does not create an HTML/DOM channel.
const UI_COPY_DEFAULTS = Object.freeze({
  'login.title': '登录 SyncWatch同步观影',
  'login.usernameLabel': '账号或邮箱',
  'login.passwordLabel': '密码',
  'login.roomLabel': '房间号（可选）',
  'login.submit': '登录并进入房间',
  'login.register': '注册账号',
  'login.guest': '游客模式 · 免注册',
  'login.guestIpOccupied': '当前 IP 已有游客在线，请先退出后再进入',
  'login.forgot': '忘记密码',
  'login.admin': '服务器设置',
  'login.connecting': '正在连接服务器…',
  'topbar.appName': 'SyncWatch同步观影',
  'topbar.serverSettings': '服务器设置',
  'topbar.management': '管理中心',
  'topbar.logoutKeepCredentials': '退出登录，保留账号密码',
  'topbar.logout': '退出登录',
  'topbar.room': '房间',
  'topbar.online': '在线成员',
  'topbar.download': '下载中心',
  'player.play': '播放',
  'player.pause': '暂停',
  'player.clear': '清空画面',
  'player.jump': '跳转',
  'player.quality': '清晰度',
  'player.rate': '倍速',
  'player.emptyTitle': '还没有选择影片',
  'player.emptyHint': '从左侧影片库选择文件，所有成员会看到同一播放状态。',
  'player.syncStatus': '同步状态',
  'closeDialog.title': '请选择关闭方式',
  'closeDialog.description': '最小化到托盘后，服务器、房间和临时公网连接会继续运行；退出程序会停止本机服务。',
  'closeDialog.minimize': '最小化到托盘',
  'closeDialog.restart': '重新启动',
  'closeDialog.quit': '退出程序',
  'closeDialog.newServer': '打开新的服务器',
  'closeDialog.cancel': '取消',
  'management.title': '管理设置',
  'management.verify': '验证并加载',
  'management.server': '服务器设置',
  'management.save': '保存设置',
  'management.copyHint': '双击带标记的文字即可编辑；修改会实时同步到所有在线客户端。',
  'management.import': '导入文案',
  'management.export': '导出文案',
  'management.reset': '恢复默认文案',
  'management.status': '文案字典尚未加载',
  'ai.messagesUnit': '条',
  'common.closeNotice': '关闭提示',
  'dialog.close': '关闭窗口',
  'dialog.fillRisk': '一键填入确认文字',
  'dialog.back': '上一步',
  'dialog.cancel': '取消',
  'dialog.confirm': '确定'
});
const UI_COPY_KEYS = new Set(Object.keys(UI_COPY_DEFAULTS));
const UI_COPY_GENERATED_KEY_PATTERN = /^ui\.auto\.[a-z0-9][a-z0-9_-]{0,47}\.(?:text|option|placeholder|title|aria-label|alt|value)\.[a-f0-9]{8}$/;
const UI_COPY_MAX_VALUE_LENGTH = 240;
const UI_COPY_MAX_ENTRIES = 5000;
const UI_COPY_MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const UI_COPY_VERSION = 2;

function validUiCopyKey(key) {
  return UI_COPY_KEYS.has(key) || UI_COPY_GENERATED_KEY_PATTERN.test(String(key || ''));
}

function defaultUiCopy() {
  return { ...UI_COPY_DEFAULTS };
}

function normalizeUiCopy(value, { partial = false } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = partial ? {} : defaultUiCopy();
  for (const [key, raw] of Object.entries(source).slice(0, UI_COPY_MAX_ENTRIES)) {
    if (!validUiCopyKey(key)) continue;
    if (typeof raw !== 'string') continue;
    const text = cleanText(raw, UI_COPY_MAX_VALUE_LENGTH);
    if (!text || /[<>]/.test(text) || /(?:javascript|data):/i.test(text)) continue;
    output[key] = text;
  }
  return output;
}

function validateUiCopyPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文案字典必须是 JSON 对象');
  const entries = Object.entries(value);
  if (entries.length > UI_COPY_MAX_ENTRIES) throw new Error(`文案字典最多包含 ${UI_COPY_MAX_ENTRIES} 个键`);
  const patch = {};
  for (const [key, raw] of entries) {
    if (!validUiCopyKey(key)) throw new Error(`不支持的 UI 文案键：${cleanText(key, 120)}`);
    if (typeof raw !== 'string') throw new Error(`文案值必须是纯文本：${key}`);
    if (raw.length > UI_COPY_MAX_VALUE_LENGTH) throw new Error(`文案过长（最多 ${UI_COPY_MAX_VALUE_LENGTH} 个字符）：${key}`);
    if (/[<>]/.test(raw) || /(?:javascript|data):/i.test(raw)) throw new Error(`文案包含不允许的标记：${key}`);
    const text = cleanText(raw, UI_COPY_MAX_VALUE_LENGTH);
    if (!text) throw new Error(`文案不能为空：${key}`);
    patch[key] = text;
  }
  if (!Object.keys(patch).length) throw new Error('至少提供一个受支持的文案键');
  return patch;
}

function uiCopyPayload(value) {
  let source = value;
  if (typeof source === 'string') {
    if (Buffer.byteLength(source, 'utf8') > UI_COPY_MAX_IMPORT_BYTES) throw new Error('文案导入内容不能超过 2 MB');
    try { source = JSON.parse(source); }
    catch (_) { throw new Error('文案导入内容不是有效 JSON'); }
  }
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    if (Object.prototype.hasOwnProperty.call(source, 'version')) {
      const version = Number(source.version);
      if (!Number.isInteger(version) || version < 1 || version > UI_COPY_VERSION) throw new Error(`不支持的文案配置版本：${cleanText(source.version, 20)}`);
    }
    if (source.uiCopy && typeof source.uiCopy === 'object' && !Array.isArray(source.uiCopy)) source = source.uiCopy;
    else if (source.entries && typeof source.entries === 'object' && !Array.isArray(source.entries)) source = source.entries;
    else if (source.dictionary && typeof source.dictionary === 'object' && !Array.isArray(source.dictionary)) source = source.dictionary;
  }
  return validateUiCopyPatch(source);
}
const LOGIN_CUBE_FACE_IDS = Object.freeze(['front', 'back', 'right', 'left', 'top', 'bottom']);
const DEFAULT_LOGIN_CUBE_FACES = Object.freeze([
  { id: 'front', icon: '🎬', title: '同一帧，共此刻', text: '局域网 / 公网 · 智能同步 · SyncWatch同步观影 为您带来极致的观影体验', image: '' },
  { id: 'back', icon: '📺', title: '稳定同步', text: '播放、暂停、进度与倍速保持一致', image: '' },
  { id: 'right', icon: '💬', title: '一起交流', text: '聊天、私聊、弹幕与表情实时送达', image: '' },
  { id: 'left', icon: '🎙️', title: '实时语音', text: '观影时也能自然地说说话', image: '' },
  { id: 'top', icon: '☁️', title: '多端连接', text: '电脑、网页与手机保持同步', image: '' },
  { id: 'bottom', icon: '✨', title: 'SyncWatch同步观影', text: '轻扫立方体，看看每一面', image: '' }
]);
const LOGIN_CUBE_IMAGE_LIMIT_BYTES = 2 * 1024 * 1024;
const LOGIN_CUBE_MODEL_LIMIT_BYTES = 25 * 1024 * 1024;
const DEFAULT_PORT = 20311;
const DISCOVERY_PORT = 5001;
const PASSWORD_ITERATIONS = 180000;
const VOICE_LIMIT_BYTES = 25 * 1024 * 1024;
const CHAT_IMAGE_LIMIT_BYTES = 12 * 1024 * 1024;
const AVATAR_LIMIT_BYTES = 5 * 1024 * 1024;
const LOGIN_MUSIC_FILE_LIMIT_BYTES = 256 * 1024 * 1024;
const LOGIN_MUSIC_TRACK_LIMIT = 200;
const LOGIN_VIDEO_FILE_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
const DOWNLOAD_ASSET_FILE_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
const DOWNLOAD_ASSET_MIN_BYTES = 1024 * 1024;
const SCREEN_FRAME_LIMIT_BYTES = 1500 * 1024;
const SCREEN_AUDIO_LIMIT_BYTES = 256 * 1024;
const MAX_MEDIA_STREAMS_PER_SESSION_FILE = 8;
const NAVIGATION_SOCKET_HOST_TTL_MS = 15 * 60 * 1000;
const MAX_NAVIGATION_SOCKET_HOSTS = 256;
const SCREEN_FRAME_ACK_TIMEOUT_MS = 2500;
const HARD_MEDIA_UPLOAD_LIMIT_BYTES = 32 * 1024 * 1024 * 1024;
const DEFAULT_USER_UPLOAD_LIMIT_BYTES = HARD_MEDIA_UPLOAD_LIMIT_BYTES;
const HARD_MEDIA_DURATION_LIMIT_SECONDS = 30 * 24 * 60 * 60;
// v2.3.9 shipped a short-lived candidate that persisted the former 300s
// default as an explicit policy. Keep a migration version so those records
// are cleared once, while limits saved after this fix remain authoritative.
const UPLOAD_DURATION_POLICY_VERSION = 3;
const MAX_ROOM_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024 * 1024;
const SUBTITLE_LIMIT_BYTES = 10 * 1024 * 1024;
const TEXT_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
function formatBytesForUploadError(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value; let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : 2)}${units[index]}`;
}
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MEMBER_DISCONNECT_GRACE_MS = 10 * 1000;
const HARD_REQUEST_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MEDIA_ANALYSIS_CONCURRENCY = 2;
const DEFAULT_MEDIA_COMPATIBILITY_CONCURRENCY = 3;
const MAX_MEDIA_COMPATIBILITY_CONCURRENCY = 8;
const MEDIA_ANALYSIS_VERSION = 2;
const MEDIA_COMPATIBILITY_RECIPE_VERSION = 3;
const MEDIA_COMPATIBILITY_MAX_WIDTH = 854;
const MEDIA_COMPATIBILITY_MAX_HEIGHT = 480;
const MEDIA_COMPATIBILITY_MAX_VIDEO_BITRATE = 900 * 1000;
const MEDIA_COMPATIBILITY_AUDIO_BITRATE = 96 * 1000;
const LOGIN_VIDEO_MAX_WIDTH = 1280;
const LOGIN_VIDEO_MAX_HEIGHT = 720;
const DISK_RESERVE_BYTES = 512 * 1024 * 1024;
const DISK_CHECK_INTERVAL_BYTES = 4 * 1024 * 1024;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PROCESS_TERMINATION_GRACE_MS = 1500;
const CHAT_ROOM_MEMORY_LIMIT = 1000;
const PASSWORD_RESET_CODE_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
const CLOSE_DRAIN_TIMEOUT_MS = 15000;
const CLOSE_ABORT_GRACE_MS = 2000;
const CLOSE_FINAL_TIMEOUT_MS = 5000;
const DATA_LOCK_DIRECTORY_NAME = '.syncwatch-instance.lock';
const DATA_LOCK_OWNER_FILE = 'owner.json';
const DATA_LOCK_CONTROL_FILE = 'control.json';
// A process can exit without running the synchronous lock cleanup path (for
// example Android force-stops the dedicated service process). PID values may
// then be reused by an unrelated process, so liveness alone is not proof that
// the lock owner is still the SyncWatch instance which created it.
const DATA_LOCK_STALE_MS = 30 * 1000;
const DATA_LOCK_HEARTBEAT_MS = 10000;
const ROOM_EMPTY_CLOSE_MS = 90 * 1000;
const DEFAULT_LEGAL_AGREEMENT_VERSION = '2.2.3';
const DANGEROUS_ACTION_CONFIRMATION = '我已知道这个风险';
const SHARED_WEB_URL_LIMIT = 8192;
const MAIL_TEMPLATE_HTML_LIMIT = 100000;
const MAIL_TEMPLATE_SUBJECT_LIMIT = 200;
const MAIL_TEMPLATE_LOCALES = new Set(['zh-CN', 'en-US']);
const MAIL_TEMPLATE_EVENTS = new Set(['verification', 'passwordReset']);
const DEFAULT_AVATAR_COUNT = 100;
const DEFAULT_AVATAR_PATH = /^\/default-avatar\/(?:[1-9]\d?|100)\.svg$/;
const DEFAULT_AVATAR_PALETTES = Object.freeze([
  ['#111827', '#f6d4b6', '#5eead4', '#f8fafc'],
  ['#1f2937', '#e9b894', '#fbbf24', '#fff7ed'],
  ['#20252b', '#f2c7a5', '#fb7185', '#fff1f2'],
  ['#172554', '#dca77f', '#60a5fa', '#eff6ff'],
  ['#1a2e22', '#f0c8a4', '#86efac', '#f0fdf4'],
  ['#272134', '#d8a27f', '#c4b5fd', '#faf5ff'],
  ['#312e2a', '#edc29e', '#fcd34d', '#fffbeb'],
  ['#16262a', '#c98f69', '#67e8f9', '#ecfeff'],
  ['#2b1f27', '#f1c6a8', '#f9a8d4', '#fdf2f8'],
  ['#17202b', '#b97855', '#a7f3d0', '#f0fdfa']
]);

function defaultAvatarSvg(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 1 || numericId > DEFAULT_AVATAR_COUNT) return '';
  const palette = DEFAULT_AVATAR_PALETTES[(numericId - 1) % DEFAULT_AVATAR_PALETTES.length];
  const series = Math.floor((numericId - 1) / 20);
  const variant = (numericId - 1) % 20;
  const faceX = 64 + ((variant % 3) - 1) * 2;
  const faceY = 59 + (variant % 2);
  const faceRadius = 27 + (variant % 4);
  const eyeY = faceY - 2 + (variant % 2);
  const hairHeight = 24 + (variant % 7);
  const badgeX = 99 + (variant % 3);
  const backdrop = [
    `<path d="M0 22h128v18H0zM0 88h128v18H0z" fill="${palette[2]}" opacity=".13"/><circle cx="18" cy="18" r="5" fill="${palette[2]}" opacity=".75"/>`,
    `<path d="M-8 103 48 0h20L12 128zm66 25L112 28h19L78 128z" fill="${palette[2]}" opacity=".16"/>`,
    `<circle cx="18" cy="22" r="10" fill="none" stroke="${palette[2]}" stroke-width="3" opacity=".48"/><circle cx="110" cy="40" r="6" fill="${palette[2]}" opacity=".38"/><path d="m17 94 5 10 11 2-8 8 2 11-10-5-10 5 2-11-8-8 11-2z" fill="${palette[2]}" opacity=".22"/>`,
    `<path d="M0 18h128M0 38h128M0 98h128M0 118h128" stroke="${palette[2]}" stroke-width="2" opacity=".16"/><path d="M18 0v128M110 0v128" stroke="${palette[2]}" stroke-width="2" opacity=".16"/>`,
    `<path d="M0 102c25-18 42-19 64-3 22 16 40 15 64-4v33H0z" fill="${palette[2]}" opacity=".2"/><circle cx="106" cy="19" r="9" fill="${palette[2]}" opacity=".52"/>`
  ][series];
  const hair = [
    `<path d="M${faceX - faceRadius} ${faceY - 4}c1-${hairHeight} 15-${hairHeight + 9} ${faceRadius} -${hairHeight + 3} 17 3 27 15 27 ${hairHeight + 2}-9-9-22-13-32-8-8 4-15 7-22 12z" fill="${palette[0]}"/>`,
    `<path d="M${faceX - faceRadius} ${faceY - 2}c2-${hairHeight} 18-${hairHeight + 8} ${faceRadius * 2} -${hairHeight - 2}l-8 17-12-17-11 12-12-10-11 10z" fill="${palette[0]}"/>`,
    `<path d="M${faceX - faceRadius} ${faceY + 1}c0-${hairHeight + 3} 13-${hairHeight + 10} ${faceRadius * 2} -${hairHeight + 5} 5 8 6 18 4 28-7-13-17-17-26-20-7 7-18 11-32 12z" fill="${palette[0]}"/>`,
    `<path d="M${faceX - faceRadius + 1} ${faceY - 5}c5-${hairHeight + 1} 23-${hairHeight + 7} ${faceRadius * 2 - 2} -${hairHeight - 4}-2 7-6 14-11 18-2-12-10-20-19-23-8 6-17 9-25 9z" fill="${palette[0]}"/>`
  ][variant % 4];
  const eyes = variant % 3 === 0
    ? `<path d="M${faceX - 14} ${eyeY}q5-5 10 0M${faceX + 4} ${eyeY}q5-5 10 0" fill="none" stroke="${palette[0]}" stroke-width="3" stroke-linecap="round"/>`
    : `<circle cx="${faceX - 9}" cy="${eyeY}" r="${variant % 3 === 1 ? 2.7 : 3.4}" fill="${palette[0]}"/><circle cx="${faceX + 9}" cy="${eyeY}" r="${variant % 3 === 1 ? 2.7 : 3.4}" fill="${palette[0]}"/>`;
  const mouth = variant % 4 === 0
    ? `<path d="M${faceX - 8} ${faceY + 12}q8 8 16 0" fill="none" stroke="${palette[0]}" stroke-width="2.8" stroke-linecap="round"/>`
    : variant % 4 === 1
      ? `<path d="M${faceX - 7} ${faceY + 14}h14" stroke="${palette[0]}" stroke-width="2.6" stroke-linecap="round"/>`
      : variant % 4 === 2
        ? `<circle cx="${faceX}" cy="${faceY + 13}" r="4" fill="${palette[0]}" opacity=".85"/>`
        : `<path d="M${faceX - 8} ${faceY + 15}q8-5 16 0" fill="none" stroke="${palette[0]}" stroke-width="2.8" stroke-linecap="round"/>`;
  const accessory = [
    `<path d="M${faceX - 20} ${faceY - 3}h14v9h-14zm26 0h14v9h-14zM${faceX - 6} ${faceY + 1}h12" fill="none" stroke="${palette[2]}" stroke-width="3" stroke-linejoin="round"/>`,
    `<path d="M${faceX + faceRadius - 5} ${faceY - 8}q11 6 4 17" fill="none" stroke="${palette[2]}" stroke-width="4" stroke-linecap="round"/>`,
    `<path d="m${faceX - 27} ${faceY - 22} 10-11 7 15m20 0 7-15 10 11" fill="none" stroke="${palette[2]}" stroke-width="5" stroke-linecap="round"/>`,
    `<circle cx="${faceX - faceRadius + 3}" cy="${faceY + 5}" r="5" fill="${palette[2]}"/><circle cx="${faceX + faceRadius - 3}" cy="${faceY + 5}" r="5" fill="${palette[2]}"/>`,
    `<path d="M${faceX - 25} ${faceY - 20}q25-18 50 0" fill="none" stroke="${palette[2]}" stroke-width="6" stroke-linecap="round"/>`
  ][variant % 5];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-labelledby="title-${numericId}" data-avatar-id="${numericId}"><title id="title-${numericId}">SyncWatch同步观影 默认头像 ${numericId}</title><rect width="128" height="128" rx="24" fill="${palette[0]}"/>${backdrop}<path d="M18 128c3-31 20-46 46-46s43 15 46 46z" fill="${palette[2]}"/><path d="M42 94c7 8 14 12 22 12s15-4 22-12l8 34H34z" fill="${palette[3]}" opacity=".92"/><circle cx="${faceX}" cy="${faceY}" r="${faceRadius}" fill="${palette[1]}"/>${hair}${eyes}${mouth}${accessory}<circle cx="${badgeX}" cy="104" r="16" fill="${palette[3]}" stroke="${palette[2]}" stroke-width="3"/><text x="${badgeX}" y="109" fill="${palette[0]}" font-family="Segoe UI,Arial,sans-serif" font-size="13" font-weight="800" text-anchor="middle">${numericId}</text></svg>`;
}

function pipeMediaFileResponse(req, res, target, options = {}, onError = () => {}, lifecycle = {}) {
  const tracker = lifecycle?.tracker instanceof Map ? lifecycle.tracker : null;
  const trackerKey = tracker && lifecycle.key ? String(lifecycle.key) : '';
  let trackedStreams = null;
  if (trackerKey) {
    const existing = tracker.get(trackerKey);
    trackedStreams = existing instanceof Set ? existing : new Set();
    tracker.set(trackerKey, trackedStreams);
  }
  const source = fs.createReadStream(target, options);
  trackedStreams?.add(source);
  let clientAborted = false;
  let pipelineStarted = false;
  let settled = false;
  let sourceError = null;

  const abortSource = () => {
    clientAborted = true;
    if (!source.destroyed) source.destroy();
  };
  const handleResponseClose = () => {
    if (!res.writableFinished) abortSource();
  };
  const cleanup = () => {
    req.removeListener('aborted', abortSource);
    res.removeListener('close', handleResponseClose);
    if (trackedStreams) {
      trackedStreams.delete(source);
      if (!trackedStreams.size && tracker.get(trackerKey) === trackedStreams) tracker.delete(trackerKey);
    }
    source.removeListener('open', startPipeline);
    source.removeListener('error', handleSourceError);
    source.removeListener('close', handleSourceClose);
  };

  const reportError = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (!error) return;
    // Errors raised before the file descriptor opens must remain visible to
    // the route handler. Starting pipeline() earlier would destroy `res` and
    // turn ENOENT/EACCES into an opaque ECONNRESET for reverse proxies.
    const expectedAbort = clientAborted || req.aborted
      || (!sourceError && ['ABORT_ERR', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code));
    if (!expectedAbort) onError(error);
  };

  const handleSourceError = (error) => {
    sourceError = error;
    if (!pipelineStarted) reportError(error);
  };

  const handleSourceClose = () => {
    if (!pipelineStarted && !settled) {
      reportError(sourceError || (clientAborted || req.aborted ? null : new Error('媒体文件流在打开前关闭')));
    }
  };

  const startPipeline = () => {
    if (pipelineStarted || settled || source.destroyed) return;
    pipelineStarted = true;
    source.removeListener('open', startPipeline);
    try {
      lifecycle?.beforePipe?.();
      pipeline(source, res, (error) => {
        reportError(sourceError || error);
      });
    } catch (error) {
      source.destroy(error);
      reportError(error);
    }
  };

  req.once('aborted', abortSource);
  res.once('close', handleResponseClose);
  source.once('open', startPipeline);
  source.once('error', handleSourceError);
  source.once('close', handleSourceClose);
  return source;
}

function attachmentContentDisposition(filename) {
  const original = path.basename(String(filename || 'download')).replace(/[\r\n"]/g, '_') || 'download';
  const extension = path.extname(original).replace(/[^.A-Za-z0-9_-]/g, '');
  let fallback = original.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_').replace(/[\\/";]/g, '_').trim();
  if (!fallback || !/[A-Za-z0-9]/.test(fallback)) fallback = `syncwatch-download${extension}`;
  if (fallback.length > 180) fallback = `${fallback.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
  const encoded = encodeURIComponent(original).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function downloadMimeType(filename) {
  switch (path.extname(String(filename || '')).toLowerCase()) {
    case '.exe': return 'application/vnd.microsoft.portable-executable';
    case '.apk': return 'application/vnd.android.package-archive';
    case '.dmg': return 'application/x-apple-diskimage';
    case '.zip': return 'application/zip';
    default: return 'application/octet-stream';
  }
}

function clampMediaRangeEnd(start, end, total, openEnded) {
  return Math.min(end, total - 1);
}

// Open-ended video ranges are commonly issued by browsers while the user
// drags the seek bar. Through a reverse proxy, sending the remainder of a
// multi-gigabyte file keeps an abandoned request in flight and can starve the
// Socket.IO control channel. Large files are therefore served in bounded
// chunks; the browser will request the next chunk when it needs it. Eight MiB
// keeps high-latency original-quality playback fed without restoring an
// unbounded multi-gigabyte response. Small
// files retain the traditional full open-ended response for third-party port
// forwarding compatibility.
const OPEN_ENDED_MEDIA_RANGE_CHUNK_THRESHOLD_BYTES = 32 * 1024 * 1024;
const MAX_OPEN_ENDED_MEDIA_RANGE_BYTES = 8 * 1024 * 1024;

const COMPRESSION_EXCLUDED_PATH_PREFIXES = Object.freeze([
  '/media/',
  '/original-media/',
  '/compatible-media/',
  '/host-media/',
  '/login-music/',
  '/login-video/',
  '/login-cube-model/',
  '/voice/',
  '/chat-image/',
  '/thumbnail/',
  '/subtitle/'
]);

function requestSkipsCompression(req) {
  if (String(req?.headers?.range || '').trim()) return true;
  const pathname = String(req?.path || '').toLowerCase();
  return COMPRESSION_EXCLUDED_PATH_PREFIXES.some((prefix) => (
    pathname === prefix.slice(0, -1) || pathname.startsWith(prefix)
  ));
}

const PASSWORD_POLICY_MODES = new Set([
  'unrestricted', 'chinese', 'english', 'digits',
  'chinese_english', 'chinese_digits', 'english_digits', 'chinese_english_digits'
]);

// Registration has no default business length or character-class restriction.
// These byte ceilings exist only to bound payload, persistence and password
// hashing work; administrators can opt into narrower character-count rules.
const USERNAME_POLICY_MODES = new Set([
  'unrestricted', 'safe', 'chinese', 'english', 'digits',
  'chinese_english', 'chinese_digits', 'english_digits', 'chinese_english_digits'
]);
const USERNAME_MAX_UTF8_BYTES = 1024;
const PASSWORD_MAX_UTF8_BYTES = 4096;
const USERNAME_POLICY_MODE_LABELS = Object.freeze({
  unrestricted: '任意 Unicode 字符、空格、标点和符号',
  safe: 'Unicode 字母、数字、下划线和短横线',
  chinese: '中文', english: '英文', digits: '数字',
  chinese_english: '中文和英文', chinese_digits: '中文和数字',
  english_digits: '英文和数字', chinese_english_digits: '中文、英文和数字'
});

const WATCH_LEVELS = [
  { level: 1, name: '初映小星', minExperience: 0 },
  { level: 2, name: '抱枕观众', minExperience: 60 },
  { level: 3, name: '爆米花搭子', minExperience: 300 },
  { level: 4, name: '月光追剧员', minExperience: 900 },
  { level: 5, name: '银幕旅行家', minExperience: 2400 },
  { level: 6, name: '星河影迷', minExperience: 6000 },
  { level: 7, name: '光影收藏家', minExperience: 12000 },
  { level: 8, name: '放映室管家', minExperience: 24000 },
  { level: 9, name: '影院守护星', minExperience: 48000 },
  { level: 10, name: '传奇放映官', minExperience: 96000 }
];

const FILE_TYPES = new Map([
  ['.mp4', ['video', 'video/mp4']], ['.mkv', ['video', 'video/x-matroska']],
  ['.webm', ['video', 'video/webm']], ['.ogv', ['video', 'video/ogg']],
  ['.mov', ['video', 'video/quicktime']], ['.avi', ['video', 'video/x-msvideo']],
  // Keep the server permissive for real-world camera and streaming formats.
  // HLS playlists are stored as video entries and served without a lossy
  // compatibility conversion because their segment files are external.
  ['.m3u8', ['video', 'application/vnd.apple.mpegurl']], ['.m3u', ['video', 'audio/x-mpegurl']],
  ['.ts', ['video', 'video/mp2t']], ['.m2ts', ['video', 'video/mp2t']], ['.mts', ['video', 'video/mp2t']],
  ['.m4v', ['video', 'video/x-m4v']], ['.mpg', ['video', 'video/mpeg']], ['.mpeg', ['video', 'video/mpeg']],
  ['.3gp', ['video', 'video/3gpp']], ['.3g2', ['video', 'video/3gpp2']], ['.flv', ['video', 'video/x-flv']],
  ['.wmv', ['video', 'video/x-ms-wmv']], ['.asf', ['video', 'video/x-ms-asf']], ['.vob', ['video', 'video/dvd']],
  ['.f4v', ['video', 'video/x-f4v']], ['.ogm', ['video', 'video/ogg']], ['.rm', ['video', 'application/vnd.rn-realmedia']],
  ['.rmvb', ['video', 'application/vnd.rn-realmedia-vbr']], ['.divx', ['video', 'video/divx']], ['.xvid', ['video', 'video/x-xvid']],
  ['.mxf', ['video', 'application/mxf']], ['.dat', ['video', 'video/mpeg']], ['.asx', ['video', 'application/x-ms-asx']],
  // Raw elementary streams and codec-labelled files are accepted as video
  // inputs so FFmpeg can probe and convert them to the browser-compatible MP4
  // path when the server has its media toolchain available.
  ['.m1v', ['video', 'video/mpeg']], ['.m2v', ['video', 'video/mpeg']],
  ['.h264', ['video', 'video/h264']], ['.264', ['video', 'video/h264']],
  ['.h265', ['video', 'video/h265']], ['.265', ['video', 'video/h265']], ['.hevc', ['video', 'video/hevc']],
  ['.av1', ['video', 'video/av1']], ['.ivf', ['video', 'video/x-ivf']], ['.vp9', ['video', 'video/vp9']],
  ['.prores', ['video', 'video/prores']],
  ['.mp3', ['audio', 'audio/mpeg']], ['.wav', ['audio', 'audio/wav']],
  ['.m4a', ['audio', 'audio/mp4']], ['.aac', ['audio', 'audio/aac']],
  ['.flac', ['audio', 'audio/flac']], ['.ogg', ['audio', 'audio/ogg']],
  ['.opus', ['audio', 'audio/ogg']], ['.oga', ['audio', 'audio/ogg']],
  ['.wma', ['audio', 'audio/x-ms-wma']], ['.ape', ['audio', 'audio/ape']],
  ['.amr', ['audio', 'audio/amr']], ['.ac3', ['audio', 'audio/ac3']],
  ['.aiff', ['audio', 'audio/aiff']], ['.aif', ['audio', 'audio/aiff']],
  ['.mid', ['audio', 'audio/midi']], ['.midi', ['audio', 'audio/midi']],
  ['.srt', ['subtitle', 'application/x-subrip']], ['.ass', ['subtitle', 'text/x-ssa']],
  ['.ssa', ['subtitle', 'text/x-ssa']], ['.vtt', ['subtitle', 'text/vtt']],
  ['.jpg', ['image', 'image/jpeg']], ['.jpeg', ['image', 'image/jpeg']],
  ['.png', ['image', 'image/png']], ['.gif', ['image', 'image/gif']],
  ['.webp', ['image', 'image/webp']], ['.pdf', ['pdf', 'application/pdf']],
  ['.txt', ['text', 'text/plain; charset=utf-8']], ['.md', ['text', 'text/markdown; charset=utf-8']],
  ['.markdown', ['text', 'text/markdown; charset=utf-8']], ['.log', ['text', 'text/plain; charset=utf-8']],
  ['.csv', ['text', 'text/csv; charset=utf-8']], ['.tsv', ['text', 'text/tab-separated-values; charset=utf-8']],
  ['.json', ['text', 'application/json; charset=utf-8']], ['.xml', ['text', 'application/xml; charset=utf-8']],
  ['.yaml', ['text', 'application/yaml; charset=utf-8']], ['.yml', ['text', 'application/yaml; charset=utf-8']],
  ['.ini', ['text', 'text/plain; charset=utf-8']], ['.cfg', ['text', 'text/plain; charset=utf-8']],
  ['.conf', ['text', 'text/plain; charset=utf-8']], ['.properties', ['text', 'text/plain; charset=utf-8']],
  ['.toml', ['text', 'application/toml; charset=utf-8']], ['.nfo', ['text', 'text/plain; charset=utf-8']],
  ['.html', ['text', 'text/html; charset=utf-8']], ['.htm', ['text', 'text/html; charset=utf-8']],
  ['.css', ['text', 'text/css; charset=utf-8']], ['.js', ['text', 'text/javascript; charset=utf-8']],
  ['.tex', ['text', 'text/plain; charset=utf-8']], ['.rst', ['text', 'text/plain; charset=utf-8']],
  ['.adoc', ['text', 'text/plain; charset=utf-8']],
  ['.doc', ['document', 'application/msword']],
  ['.docx', ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']],
  ['.xls', ['document', 'application/vnd.ms-excel']],
  ['.xlsx', ['document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]
]);

const VIDEO_MIME_FALLBACK = /^video\//i;
const HLS_EXTENSIONS = new Set(['.m3u8', '.m3u']);

function resolveFileType(originalName, mimeType = '') {
  const extension = path.extname(String(originalName || '')).toLowerCase();
  const known = FILE_TYPES.get(extension);
  if (known) return known;
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (VIDEO_MIME_FALLBACK.test(mime)) return ['video', mime || 'application/octet-stream'];
  return null;
}

function textUploadMimeAllowed(mimeType = '') {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return !mime || mime === 'application/octet-stream' || mime.startsWith('text/') || new Set([
    'application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/toml'
  ]).has(mime);
}

function bufferLooksLikeText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return true;
  const utf16Bom = (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff);
  if (utf16Bom) return buffer.length % 2 === 0;
  if (buffer.includes(0)) return false;
  let controls = 0;
  for (const byte of buffer) if (byte < 32 && ![9, 10, 12, 13].includes(byte)) controls += 1;
  return controls / buffer.length <= 0.02;
}

const UPLOAD_CATEGORIES = new Set([...FILE_TYPES.values()].map(([category]) => category));
const STATIC_PREVIEW_CATEGORIES = new Set(['image', 'text', 'pdf']);

function normalizeAllowedUploadCategories(value) {
  const requested = Array.isArray(value) ? value : [];
  return ['video', ...requested
    .map((category) => cleanText(category, 32).toLowerCase())
    .filter((category, index, values) => category !== 'video' && UPLOAD_CATEGORIES.has(category) && values.indexOf(category) === index)];
}

function normalizeBlockedWords(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\r\n,，]+/);
  return [...new Set(source
    .map((entry) => cleanText(entry, 80).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim())
    .filter((entry) => entry.length >= 2 && entry.length <= 80))].slice(0, 500);
}

function findBlockedWord(text, blockedWords = []) {
  const normalized = String(text || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalizeBlockedWords(blockedWords).find((word) => normalized.includes(word)) || '';
}

function normalizeFriendSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    messageNotifications: source.messageNotifications !== false,
    allowFriendRequests: source.allowFriendRequests !== false,
    allowPasswordlessOwnRoomJoin: source.allowPasswordlessOwnRoomJoin === true
  };
}

function normalizeNotificationSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    registrationNotices: source.registrationNotices !== false,
    allNotifications: source.allNotifications !== false,
    conciseMode: source.conciseMode === true
  };
}

function normalizeLoginPolicy(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalizeIps = (items) => [...new Set((Array.isArray(items) ? items : [])
    .map(normalizeIp).filter((ip) => ip && net.isIP(ip)))].slice(0, 500);
  return {
    accountSessionLimit: Math.max(1, Math.min(20, Math.floor(Number(source.accountSessionLimit) || 1))),
    guestSessionsPerIp: Math.max(1, Math.min(20, Math.floor(Number(source.guestSessionsPerIp) || 1))),
    accountSessionWhitelistIps: normalizeIps(source.accountSessionWhitelistIps || source.accountSessionWhitelist),
    guestIpWhitelistIps: normalizeIps(source.guestIpWhitelistIps || source.guestIpWhitelist)
  };
}

function normalizeViewPreferences(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const color = /^#[0-9a-f]{6}$/i.test(String(source.danmakuColor || ''))
    ? String(source.danmakuColor).toLowerCase() : '#ffffff';
  const requestedFontSize = Number(source.danmakuFontSize);
  const normalizeShortcut = (candidate, fallback) => {
    const normalized = cleanText(candidate, 48).trim().replace(/\s+/g, '+');
    return /^[A-Za-z0-9]+(?:\+[A-Za-z0-9]+)*$/.test(normalized) ? normalized : fallback;
  };
  const shortcutSource = source.shortcuts && typeof source.shortcuts === 'object' && !Array.isArray(source.shortcuts) ? source.shortcuts : {};
  return {
    conciseMode: source.conciseMode === true,
    chatOnly: source.chatOnly === true,
    danmakuColor: color,
    danmakuFontSize: Math.max(12, Math.min(72, Number.isFinite(requestedFontSize) ? Math.round(requestedFontSize) : 24)),
    libraryCollapsed: source.libraryCollapsed === true,
    membersPanelCollapsed: source.membersPanelCollapsed === true,
    memberDetailsCollapsed: source.memberDetailsCollapsed === true,
    shortcuts: {
      appFullscreen: normalizeShortcut(shortcutSource.appFullscreen, 'F12'),
      fullscreenChat: normalizeShortcut(shortcutSource.fullscreenChat, 'F2'),
      fullscreenLock: normalizeShortcut(shortcutSource.fullscreenLock, 'L'),
      closeOverlay: normalizeShortcut(shortcutSource.closeOverlay, 'Escape')
    }
  };
}

function normalizePlaybackSkipSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    enabled: source.enabled === true,
    introSeconds: Math.max(0, Math.min(3600, Math.floor(Number(source.introSeconds) || 0))),
    outroSeconds: Math.max(0, Math.min(3600, Math.floor(Number(source.outroSeconds) || 0)))
  };
}

const FRIEND_REQUEST_DEFAULT_MESSAGES = [
  '嗨，一起找部好电影看吧~',
  '你好呀，想和你成为观影好友。',
  '遇见你很开心，要不要加个好友？',
  '以后一起同步观影吧~',
  '向你发来一张好友邀请函。'
];

function friendRequestMessage(value) {
  const note = cleanText(value, 160);
  if (note) return note;
  return FRIEND_REQUEST_DEFAULT_MESSAGES[crypto.randomInt(FRIEND_REQUEST_DEFAULT_MESSAGES.length)];
}

function registrationRequestCount(value) {
  return Math.max(1, Math.min(50, Math.floor(Number(value) || 1)));
}

function normalizeRegistrationRequestCounts(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const status = cleanText(source.status || 'pending', 24) || 'pending';
  const requested = Math.max(0, Math.min(50, Math.floor(Number(source.remainingCount ?? source.requestedCount) || 0)));
  const remainingCount = status === 'withdrawn' ? 0 : (status === 'pending' ? Math.max(1, requested) : requested);
  const withdrawnCount = Math.max(0, Math.min(50 - remainingCount, Math.floor(Number(source.withdrawnCount) || 0)));
  const inferredTotal = remainingCount + withdrawnCount;
  const totalRequestedCount = Math.max(inferredTotal, Math.min(50, Math.floor(Number(source.totalRequestedCount) || 0)));
  return {
    ...source,
    status,
    requestedCount: remainingCount,
    remainingCount,
    totalRequestedCount,
    withdrawnCount
  };
}

function retainPersistentRequests(value) {
  const entries = Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') : [];
  const pending = entries.filter((entry) => entry.status === 'pending');
  const resolved = entries.filter((entry) => entry.status !== 'pending').slice(-500);
  return [...resolved, ...pending].sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
}

function cleanText(value, maxLength = 120) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function defaultMailTemplates() {
  const shell = (title, body, footer) => `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;color:#18181b"><div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 8px 30px rgba(15,23,42,.10)"><div style="padding:28px 32px;background:#4f46e5;color:#fff"><h1 style="margin:0;font-size:24px;line-height:1.25">${title}</h1></div><div style="padding:32px;font-size:15px;line-height:1.7">${body}</div><div style="padding:18px 32px;background:#fafafa;color:#71717a;font-size:12px">${footer}</div></div></body></html>`;
  const codeBlock = '<div style="margin:28px 0;text-align:center;font-size:34px;font-weight:700;letter-spacing:10px;color:#18181b">{{verification_code}}</div>';
  return {
    'verification:zh-CN': {
      subject: '[{{site_name}}] {{action_name}}验证码',
      html: shell('邮箱验证码', '<p>{{recipient_name}}，您好：</p><p>您正在进行“{{action_name}}”，验证码是：</p>' + codeBlock + '<p>验证码将在 {{expires_in_minutes}} 分钟后失效。如果不是您本人操作，请忽略此邮件。</p>', '此邮件由 {{site_name}} 自动发送，请勿直接回复。')
    },
    'passwordReset:zh-CN': {
      subject: '[{{site_name}}] 密码重置验证码',
      html: shell('密码重置', '<p>{{recipient_name}}，您好：</p><p>您正在重置 {{account_name}} 的登录密码，验证码是：</p>' + codeBlock + '<p>验证码将在 {{expires_in_minutes}} 分钟后失效，且只能使用一次。如果不是您本人操作，请忽略此邮件。</p>', '此邮件由 {{site_name}} 自动发送，请勿直接回复。')
    },
    'verification:en-US': {
      subject: '[{{site_name}}] Email verification code',
      html: shell('Email verification code', '<p>Hello {{recipient_name}},</p><p>You requested to {{action_name}}. Your verification code is:</p>' + codeBlock + '<p>This code expires in {{expires_in_minutes}} minutes. If you did not request it, you can ignore this email.</p>', 'This message was sent automatically by {{site_name}}. Please do not reply.')
    },
    'passwordReset:en-US': {
      subject: '[{{site_name}}] Password reset code',
      html: shell('Password reset', '<p>Hello {{recipient_name}},</p><p>You requested a password reset for {{account_name}}. Your verification code is:</p>' + codeBlock + '<p>This code expires in {{expires_in_minutes}} minutes and can be used once. If you did not request it, you can ignore this email.</p>', 'This message was sent automatically by {{site_name}}. Please do not reply.')
    }
  };
}

function mailTemplateSafetyError(value) {
  const html = String(value || '');
  if (Buffer.byteLength(html, 'utf8') > MAIL_TEMPLATE_HTML_LIMIT) return `邮件 HTML 模板不能超过 ${MAIL_TEMPLATE_HTML_LIMIT} 字节`;
  if (/<\s*\/?\s*(?:script|iframe|object|embed|form|input|button|textarea|select|svg|math|base|link)\b/i.test(html)) return '邮件模板不能包含脚本、表单、iframe、SVG 或可执行资源标签';
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html)) return '邮件模板不能包含自动跳转的 meta refresh';
  if (/\son[a-z]+\s*=|(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/i.test(html)) return '邮件模板包含不安全的事件属性或 URL';
  return '';
}

function normalizeMailTemplates(value) {
  const defaults = defaultMailTemplates();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const candidate = source[key] && typeof source[key] === 'object' ? source[key] : {};
    const subject = cleanText(candidate.subject || fallback.subject, MAIL_TEMPLATE_SUBJECT_LIMIT) || fallback.subject;
    const html = String(candidate.html || fallback.html).trim();
    normalized[key] = { subject, html: html && !mailTemplateSafetyError(html) ? html.slice(0, MAIL_TEMPLATE_HTML_LIMIT) : fallback.html };
  }
  return normalized;
}

function normalizeMailSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const port = Math.max(1, Math.min(65535, Math.floor(Number(source.port) || 465)));
  const legacyUser = cleanText(source.user, 254).toLowerCase();
  const recoveryEmail = cleanText(source.recoveryEmail, 254).toLowerCase();
  return {
    enabled: source.enabled !== false,
    host: cleanText(source.host || 'smtp.qq.com', 253) || 'smtp.qq.com',
    port,
    secure: typeof source.secure === 'boolean' ? source.secure : port === 465,
    useTls: source.useTls !== false,
    user: legacyUser,
    fromEmail: cleanText(source.fromEmail || legacyUser, 254).toLowerCase(),
    recoveryEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail) ? recoveryEmail : '',
    fromName: cleanText(source.fromName || 'SyncWatch同步观影', 60) || 'SyncWatch同步观影',
    encryptedAuthCode: String(source.encryptedAuthCode || source.encryptedPassword || ''),
    registrationVerificationEnabled: source.registrationVerificationEnabled === true,
    bindingVerificationEnabled: source.bindingVerificationEnabled !== false,
    accountRecoveryEnabled: source.accountRecoveryEnabled !== false,
    adminRecoveryEnabled: source.adminRecoveryEnabled !== false,
    defaultLocale: MAIL_TEMPLATE_LOCALES.has(source.defaultLocale) ? source.defaultLocale : 'zh-CN',
    templates: normalizeMailTemplates(source.templates)
  };
}

function normalizeAccountNumberPolicy(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const prefix = cleanText(source.prefix || 'SW', 10).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SW';
  const separator = ['-', '_', ''].includes(source.separator) ? source.separator : '-';
  const digits = Math.max(3, Math.min(12, Math.floor(Number(source.digits) || 6)));
  const nextNumber = Math.max(1, Math.min(999999999999, Math.floor(Number(source.nextNumber) || 1)));
  return { prefix, separator, digits, nextNumber };
}

function formatAccountNumber(number, policyValue = {}) {
  const policy = normalizeAccountNumberPolicy(policyValue);
  const numeric = Math.max(1, Math.floor(Number(number) || 1));
  return `${policy.prefix}${policy.separator}${String(numeric).padStart(policy.digits, '0')}`.slice(0, 32);
}

function normalizeVerificationCodePolicy(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    rateLimitEnabled: source.rateLimitEnabled !== false,
    deviceLimit: Math.max(1, Math.min(100, Math.floor(Number(source.deviceLimit) || 5))),
    targetLimit: Math.max(1, Math.min(100, Math.floor(Number(source.targetLimit) || 3))),
    windowMinutes: Math.max(1, Math.min(1440, Math.floor(Number(source.windowMinutes) || 60))),
    blockedDevices: source.blockedDevices && typeof source.blockedDevices === 'object' && !Array.isArray(source.blockedDevices)
      ? Object.fromEntries(Object.entries(source.blockedDevices).map(([key, entry]) => [cleanText(key, 120), {
        reason: cleanText(entry?.reason || '验证码请求过于频繁', 160), blockedAt: cleanText(entry?.blockedAt, 60),
        expiresAt: cleanText(entry?.expiresAt, 60), lastType: cleanText(entry?.lastType, 40)
      }]).filter(([key]) => key)) : {}
  };
}

function normalizeLoginMusic(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const isValidUrl = (url) => url.startsWith('/login-music/') || /^https:\/\//i.test(url);
  const trackIdentity = (track) => {
    const digest = /^[a-f0-9]{64}$/i.test(String(track?.sha256 || '')) ? String(track.sha256).toLowerCase() : '';
    // A local upload keeps its content digest across filename changes. This is
    // what prevents a repeated upload of the same song from appearing twice
    // in the login-page picker.
    if (digest) return `sha256:${digest}`;
    const storedName = path.basename(String(track?.storedName || ''));
    if (storedName) return `local:${storedName.toLowerCase()}`;
    return `url:${String(track?.url || '').trim()}`;
  };
  let tracks = (Array.isArray(source.tracks) ? source.tracks : []).map((track) => ({
    id: cleanText(track?.id, 80), title: cleanText(track?.title || track?.originalName || '登录音乐', 100),
    originalName: cleanText(track?.originalName, 180), storedName: path.basename(String(track?.storedName || '')),
    url: cleanText(track?.url, 2048), mimeType: cleanText(track?.mimeType || 'audio/mpeg', 120),
    size: Math.max(0, Math.floor(Number(track?.size) || 0)),
    sha256: /^[a-f0-9]{64}$/i.test(String(track?.sha256 || '')) ? String(track.sha256).toLowerCase() : '',
    createdAt: cleanText(track?.createdAt, 60)
  })).filter((track) => track.id && track.url && isValidUrl(track.url));
  // A repeated save/upload must not create repeated entries in the login
  // picker. Local audio uses its SHA-256 identity; HTTPS tracks use the exact
  // URL, because their query string can be a required signed URL.
  tracks = [...new Map(tracks.map((track) => [trackIdentity(track), track])).values()].slice(-LOGIN_MUSIC_TRACK_LIMIT);
  const legacyUrl = cleanText(source.url, 2048);
  // Older settings stored only url/title. Promote that value to a real track so
  // the current address and visible name can never drift apart after a save.
  if (!Array.isArray(source.tracks) && isValidUrl(legacyUrl) && !tracks.some((track) => track.url === legacyUrl)) {
    tracks = [{
      id: cleanText(source.currentTrackId, 80) || `legacy-${Buffer.from(legacyUrl).toString('base64url').slice(0, 64)}`,
      title: cleanText(source.title || '登录音乐', 100), originalName: '', storedName: '', url: legacyUrl,
      mimeType: 'audio/mpeg', size: 0, createdAt: cleanText(source.updatedAt || new Date().toISOString(), 60)
    }, ...tracks].slice(-LOGIN_MUSIC_TRACK_LIMIT);
  }
  const requestedId = cleanText(source.currentTrackId, 80);
  const selected = tracks.find((track) => track.id === requestedId)
    || tracks.find((track) => track.url === legacyUrl)
    || tracks[0] || null;
  const requestedMode = cleanText(source.playbackMode, 24);
  const playbackMode = ['single', 'list-loop', 'shuffle', 'single-loop'].includes(requestedMode)
    ? requestedMode : (source.shuffle === true ? 'shuffle' : (source.loop === false ? 'single' : 'list-loop'));
  return {
    enabled: source.enabled === true,
    showTitle: source.showTitle !== false,
    title: cleanText(source.title || selected?.title || '', 100),
    url: selected?.url || '',
    currentTrackId: selected?.id || '',
    volume: Math.max(0, Math.min(1, Number.isFinite(Number(source.volume)) ? Number(source.volume) : 0.3)),
    loop: source.loop !== false,
    shuffle: source.shuffle === true,
    playbackMode,
    tracks
  };
}

function normalizeLoginVideo(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const storedName = path.basename(String(source.storedName || ''));
  const requestedUrl = cleanText(source.url, 2048);
  const localUrl = storedName && /^[a-f0-9-]+\.(?:mp4|webm)$/i.test(storedName)
    ? `/login-video/${encodeURIComponent(storedName)}` : '';
  const url = requestedUrl.startsWith('/login-video/') ? requestedUrl : localUrl;
  return {
    enabled: source.enabled === true && Boolean(url),
    title: cleanText(source.title || source.originalName || '', 100),
    url,
    storedName,
    originalName: cleanText(source.originalName, 180),
    mimeType: ['video/mp4', 'video/webm'].includes(String(source.mimeType || '').toLowerCase())
      ? String(source.mimeType).toLowerCase() : 'video/mp4',
    size: Math.max(0, Math.floor(Number(source.size) || 0)),
    createdAt: cleanText(source.createdAt, 60),
    updatedAt: cleanText(source.updatedAt, 60)
  };
}

function cleanUsername(value) {
  const normalized = String(value ?? '').normalize('NFC').trim();
  return Buffer.byteLength(normalized, 'utf8') <= USERNAME_MAX_UTF8_BYTES ? normalized : '';
}
function validUsername(value) { return /^[\p{L}\p{N}_-]{2,24}$/u.test(value); }
function baseName(filename) { return path.basename(filename, path.extname(filename)).toLocaleLowerCase(); }

function normalizePasswordPolicy(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = PASSWORD_POLICY_MODES.has(source.mode) ? source.mode : 'unrestricted';
  const lengthRestricted = source.lengthRestricted === true;
  const minLength = Math.max(1, Math.min(PASSWORD_MAX_UTF8_BYTES, Math.floor(Number(source.minLength) || 1)));
  const maxLength = Math.max(minLength, Math.min(PASSWORD_MAX_UTF8_BYTES,
    Math.floor(Number(source.maxLength) || PASSWORD_MAX_UTF8_BYTES)));
  const expiryDays = Math.max(0, Math.min(3650, Math.floor(Number.isFinite(Number(source.expiryDays)) ? Number(source.expiryDays) : 7)));
  return { mode, lengthRestricted, minLength, maxLength, maxBytes: PASSWORD_MAX_UTF8_BYTES, expiryDays };
}

function normalizeUsernamePolicy(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = USERNAME_POLICY_MODES.has(source.mode) ? source.mode : 'unrestricted';
  const lengthRestricted = source.lengthRestricted === true;
  const rawMin = Number(source.minLength);
  const rawMax = Number(source.maxLength);
  const minLength = Math.max(1, Math.min(USERNAME_MAX_UTF8_BYTES,
    Number.isFinite(rawMin) && rawMin > 0 ? Math.floor(rawMin) : 1));
  const maxLength = Math.max(minLength, Math.min(USERNAME_MAX_UTF8_BYTES,
    Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : USERNAME_MAX_UTF8_BYTES));
  return { mode, lengthRestricted, minLength, maxLength, maxBytes: USERNAME_MAX_UTF8_BYTES };
}

function usernamePolicyError(value, policyValue = {}) {
  const text = String(value ?? '').normalize('NFC').trim();
  const policy = normalizeUsernamePolicy(policyValue);
  if (!text) return '请输入账号';
  if (Buffer.byteLength(text, 'utf8') > USERNAME_MAX_UTF8_BYTES) {
    return `账号不能超过 ${USERNAME_MAX_UTF8_BYTES} 个 UTF-8 字节（仅用于防止异常超大请求）`;
  }
  const length = Array.from(text).length;
  if (policy.lengthRestricted && (length < policy.minLength || length > policy.maxLength)) {
    return `账号长度需为 ${policy.minLength}-${policy.maxLength} 个字符`;
  }
  if (policy.mode === 'unrestricted') return '';
  const chinese = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u{20000}-\\u{2ebef}\\u{30000}-\\u{323af}';
  const patterns = {
    safe: new RegExp('^[\\p{L}\\p{M}\\p{N}_-]+$', 'u'),
    chinese: new RegExp(`^[${chinese}]+$`, 'u'),
    english: /^[A-Za-z]+$/,
    digits: /^\d+$/,
    chinese_english: new RegExp(`^[${chinese}A-Za-z]+$`, 'u'),
    chinese_digits: new RegExp(`^[${chinese}\\d]+$`, 'u'),
    english_digits: /^[A-Za-z\d]+$/,
    chinese_english_digits: new RegExp(`^[${chinese}A-Za-z\\d]+$`, 'u')
  };
  if (!patterns[policy.mode]?.test(text)) {
    return `账号只能使用${USERNAME_POLICY_MODE_LABELS[policy.mode] || '服务器允许的字符'}`;
  }
  return '';
}

function normalizeRoomIdPolicy(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = ['uppercase_alnum', 'uppercase_no_ambiguous', 'letters', 'digits', 'custom'].includes(source.mode)
    ? source.mode : 'uppercase_alnum';
  const minLength = Math.max(1, Math.min(32, Math.floor(Number(source.minLength) || 4)));
  const maxLength = Math.max(minLength, Math.min(32, Math.floor(Number(source.maxLength) || 12)));
  const customPattern = cleanText(source.customPattern || '', 120).replace(/\\/g, '').replace(/[\r\n]/g, '');
  return { enabled: Boolean(source.enabled), mode, minLength, maxLength, customPattern };
}

function validateCustomRoomId(value, policy = {}) {
  const id = String(value || '').trim().toUpperCase();
  if (!id) return '';
  const normalized = normalizeRoomIdPolicy(policy);
  if (!normalized.enabled) return /^[A-Z0-9]{4,32}$/.test(id) ? id : '';
  if (id.length < normalized.minLength || id.length > normalized.maxLength) return '';
  const patterns = {
    uppercase_alnum: /^[A-Z0-9]+$/,
    uppercase_no_ambiguous: /^[A-HJ-NP-Z2-9]+$/,
    letters: /^[A-Z]+$/,
    digits: /^[0-9]+$/
  };
  if (normalized.mode === 'custom') {
    try { return normalized.customPattern && new RegExp(`^(?:${normalized.customPattern})$`).test(id) ? id : ''; }
    catch (_) { return ''; }
  }
  return patterns[normalized.mode]?.test(id) ? id : '';
}

function normalizeAdminContact(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    label: cleanText(source.label || '联系服务器管理员', 40) || '联系服务器管理员',
    qq: cleanText(source.qq || '2590813506', 32).replace(/[^0-9]/g, ''),
    wechat: cleanText(source.wechat || 'love_020804', 80),
    email: cleanText(source.email, 120).toLowerCase(),
    phone: cleanText(source.phone, 40),
    note: cleanText(source.note, 240)
  };
}

function normalizeLegalAgreement(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceVersion = cleanText(source.version, 40);
  const version = sourceVersion === '2026-08-05' ? DEFAULT_LEGAL_AGREEMENT_VERSION : sourceVersion;
  return {
    version: version || DEFAULT_LEGAL_AGREEMENT_VERSION,
    title: cleanText(source.title || 'SyncWatch同步观影 使用协议与合规声明', 80) || 'SyncWatch同步观影 使用协议与合规声明',
    text: cleanText(source.text || [
      '本软件仅用于合法的个人观影、远程协作、内容演示与经授权的媒体共享。',
      '用户不得利用本软件传播侵权、淫秽、暴力恐怖、诈骗、赌博、恶意程序或其他违反法律法规及公序良俗的内容，不得绕过版权保护、访问控制或平台安全措施。',
      '用户应确保其上传、播放、共享、录制和转发的内容已取得必要授权，并对账号、房间、设备及操作行为承担全部责任。',
      '软件作者仅提供通用技术工具，不参与、不组织、不控制用户的具体使用行为。因用户违法、侵权、违规使用或配置不当造成的法律责任、经济损失及第三方争议，由相关用户自行承担。',
      '继续使用即表示您已阅读、理解并同意遵守本协议及服务器管理员发布的规则。'
    ].join('\n\n'), 4000)
  };
}

function watchLevelSummary(account = {}) {
  const experience = Math.max(0, Math.floor(Number(account.experience) || 0));
  const override = Number.isInteger(Number(account.levelOverride))
    ? Math.max(1, Math.min(WATCH_LEVELS.length, Number(account.levelOverride))) : 0;
  const earned = [...WATCH_LEVELS].reverse().find((entry) => experience >= entry.minExperience) || WATCH_LEVELS[0];
  const current = override ? WATCH_LEVELS[override - 1] : earned;
  const next = WATCH_LEVELS[current.level] || null;
  const range = next ? Math.max(1, next.minExperience - current.minExperience) : 1;
  return {
    level: current.level, levelName: current.name, experience, levelOverride: override || null,
    currentLevelExperience: Math.max(0, experience - current.minExperience),
    nextLevelExperience: next ? next.minExperience : null,
    experienceToNext: next ? Math.max(0, next.minExperience - experience) : 0,
    progressPercent: next ? Math.max(0, Math.min(100, Math.round((experience - current.minExperience) / range * 100))) : 100,
    maxLevel: WATCH_LEVELS.length
  };
}

function normalizeIp(value) {
  const raw = String(value || '').split(',')[0].trim();
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  if (raw === '::1') return '127.0.0.1';
  const zone = raw.indexOf('%');
  return zone >= 0 ? raw.slice(0, zone) : raw || 'unknown';
}

function normalizeTrustedProxyEntries(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const entries = [];
  for (const rawEntry of source) {
    const entry = String(rawEntry || '').trim();
    if (!entry) continue;
    const slash = entry.lastIndexOf('/');
    const address = normalizeIp(slash >= 0 ? entry.slice(0, slash) : entry);
    const family = net.isIP(address);
    if (!family) continue;
    if (slash < 0) {
      entries.push(address);
      continue;
    }
    const prefixText = entry.slice(slash + 1);
    if (!/^\d+$/.test(prefixText)) continue;
    const prefix = Number(prefixText);
    // A /0 entry trusts every address in that family and would let any direct
    // client forge proxy headers. Treat wildcard CIDRs as invalid so a typo or
    // overly broad deployment setting fails closed.
    if (prefix <= 0 || prefix > (family === 4 ? 32 : 128)) continue;
    entries.push(`${address}/${prefix}`);
  }
  return [...new Set(entries)];
}

function createTrustedProxyMatcher(value) {
  const entries = normalizeTrustedProxyEntries(value);
  const blockList = new net.BlockList();
  for (const entry of entries) {
    const slash = entry.lastIndexOf('/');
    const address = slash >= 0 ? entry.slice(0, slash) : entry;
    const family = net.isIP(address);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    try {
      if (slash >= 0) blockList.addSubnet(address, Number(entry.slice(slash + 1)), type);
      else blockList.addAddress(address, type);
    } catch (_) {}
  }
  const matcher = (valueToCheck) => {
    const address = normalizeIp(valueToCheck);
    const family = net.isIP(address);
    if (!family) return false;
    try { return blockList.check(address, family === 6 ? 'ipv6' : 'ipv4'); }
    catch (_) { return false; }
  };
  matcher.entries = entries;
  return matcher;
}

function resolveClientIp(peerAddress, headers = {}, trustedProxy = () => false) {
  const peer = normalizeIp(peerAddress);
  if (!net.isIP(peer) || !trustedProxy(peer)) return peer;
  const forwardedChain = String(headers['x-forwarded-for'] || '')
    .split(',').map(normalizeIp).filter((address) => net.isIP(address));
  if (forwardedChain.length) {
    let current = peer;
    for (let index = forwardedChain.length - 1; index >= 0 && trustedProxy(current); index -= 1) {
      current = forwardedChain[index];
    }
    return current;
  }
  const singleHop = [headers['cf-connecting-ip'], headers['x-real-ip']]
    .map(normalizeIp).find((address) => net.isIP(address));
  return singleHop || peer;
}

function makePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('hex');
  return `pbkdf2$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

function makePasswordHashAsync(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.pbkdf2(String(password), salt, PASSWORD_ITERATIONS, 32, 'sha256', (error, hash) => {
      if (error) return reject(error);
      return resolve(`pbkdf2$${PASSWORD_ITERATIONS}$${salt}$${hash.toString('hex')}`);
    });
  });
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyPassword(password, storedHash) {
  if (Buffer.byteLength(String(password ?? ''), 'utf8') > PASSWORD_MAX_UTF8_BYTES) return false;
  if (!storedHash) return password === '';
  const value = String(storedHash);
  if (value.startsWith('pbkdf2$')) {
    const [, iterationsText, salt, expected] = value.split('$');
    const iterations = Number(iterationsText);
    if (!Number.isSafeInteger(iterations) || !salt || !expected) return false;
    const actual = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256').toString('hex');
    return safeEqualText(actual, expected);
  }
  if (/^[a-f0-9]{32}$/i.test(value)) {
    return safeEqualText(crypto.createHash('md5').update(String(password)).digest('hex'), value.toLowerCase());
  }
  return safeEqualText(password, value);
}

function verifyPasswordAsync(password, storedHash) {
  if (Buffer.byteLength(String(password ?? ''), 'utf8') > PASSWORD_MAX_UTF8_BYTES) return Promise.resolve(false);
  if (!storedHash) return Promise.resolve(password === '');
  const value = String(storedHash);
  if (!value.startsWith('pbkdf2$')) return Promise.resolve(verifyPassword(password, value));
  const [, iterationsText, salt, expected] = value.split('$');
  const iterations = Number(iterationsText);
  if (!Number.isSafeInteger(iterations) || iterations <= 0 || !salt || !expected) return Promise.resolve(false);
  return new Promise((resolve) => {
    crypto.pbkdf2(String(password), salt, iterations, 32, 'sha256', (error, actual) => {
      if (error) return resolve(false);
      return resolve(safeEqualText(actual.toString('hex'), expected));
    });
  });
}

function isPlainPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) return false;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function privateOrLoopbackAddress(value) {
  const address = normalizeIp(value);
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 127 || octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254);
  }
  if (family === 6) return address === '::1' || /^f[cd]/i.test(address) || /^fe[89ab]/i.test(address);
  return false;
}

function requestPeerAddress(req) {
  return req.socket?.remoteAddress || req.connection?.remoteAddress || '';
}

function directLoopbackHostRequest(peerAddress, headers = {}) {
  if (normalizeIp(peerAddress) !== '127.0.0.1') return false;
  if (['cf-connecting-ip', 'forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']
    .some((name) => String(headers[name] || '').trim())) return false;
  const host = String(headers.host || '').trim().toLowerCase();
  const parts = hostHeaderParts(host);
  if (!parts || !['localhost', '127.0.0.1', '::1'].includes(normalizeIp(parts.hostname) || parts.hostname)) return false;
  const origin = String(headers.origin || '').trim();
  if (!origin) return String(headers['sec-fetch-site'] || '').trim().toLowerCase() === 'same-origin';
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host.toLowerCase() === host;
  } catch (_) { return false; }
}

function requestFromPrivateProxy(req) {
  return privateOrLoopbackAddress(requestPeerAddress(req));
}

function requestHostHeader(req) {
  const directHost = String(req.headers.host || '').trim().toLowerCase();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
  return forwardedHost && requestFromPrivateProxy(req) ? forwardedHost : directHost;
}

function socketOriginHost(req) {
  const hostHeader = requestHostHeader(req);
  if (!hostHeader || /[\s\\/]/.test(hostHeader)) return '';
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return hostHeader; // Native clients do not send Origin.
  if (origin === 'null') return '';
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    const originHost = parsed.host.toLowerCase();
    return hostHeaderParts(originHost) ? originHost : '';
  } catch (_) {
    return '';
  }
}

function socketOriginAllowed(req, allowedHosts = null) {
  const hostHeader = requestHostHeader(req);
  const originHost = socketOriginHost(req);
  return Boolean(hostHeader && originHost && hostHeader === originHost
    && (!allowedHosts?.size || allowedHosts.has(hostHeader)));
}

function requestUsesForwardedHttps(req) {
  if (req.secure || req.socket?.encrypted) return true;
  if (!requestFromPrivateProxy(req)) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function requestUsesPublicProxy(req) {
  if (!requestFromPrivateProxy(req)) return false;
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const parts = hostHeaderParts(forwardedHost);
  return Boolean(parts && net.isIP(parts.hostname) === 0 && net.isIP(forwardedFor) !== 0);
}

function hostHeaderParts(hostHeader) {
  try {
    const parsed = new URL(`http://${hostHeader}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return hostname ? { hostname, port: parsed.port ? Number(parsed.port) : 0 } : null;
  } catch (_) {
    return null;
  }
}

function roomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}

function normalizeRoomId(value) {
  const normalized = cleanText(value, 32).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{4,32}$/.test(normalized) ? normalized : '';
}

function normalizeSharedWebUrl(value) {
  const raw = cleanText(value, SHARED_WEB_URL_LIMIT);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch (_) { return ''; }
}

function defaultPermissionGroups() {
  return {
    viewer: { id: 'viewer', name: '观众', system: true, permissions: { control: false, seek: false, upload: false, delete: false, manageMedia: false, shareScreen: false, shareAudio: false, shareWeb: false, voiceChat: true, manageChat: false, manageRoom: false, skipSettings: false, sendNotice: false } },
    member: { id: 'member', name: '成员', system: true, permissions: { control: false, seek: false, upload: true, delete: false, manageMedia: false, shareScreen: false, shareAudio: false, shareWeb: false, voiceChat: true, manageChat: false, manageRoom: false, skipSettings: false, sendNotice: false } },
    controller: { id: 'controller', name: '协管员', system: true, permissions: { control: true, seek: true, upload: true, delete: false, manageMedia: false, shareScreen: true, shareAudio: true, shareWeb: true, voiceChat: true, manageChat: true, manageRoom: false, skipSettings: false, sendNotice: true } },
    administrator: { id: 'administrator', name: '管理员', system: true, permissions: { control: true, seek: true, upload: true, delete: true, manageMedia: true, shareScreen: true, shareAudio: true, shareWeb: true, voiceChat: true, manageChat: true, manageRoom: true, skipSettings: true, sendNotice: true } }
  };
}

function defaultAccountTiers() {
  return {
    basic: { id: 'basic', name: '基础级', uploadLimitBytes: 0, roomQuota: 1, description: '默认账户：视频文件大小和时长不限（受服务器安全上限约束），可创建 1 个房间。' },
    advanced: { id: 'advanced', name: '进阶级', uploadLimitBytes: 20 * 1024 * 1024 * 1024, roomQuota: 3, description: '适合多个观影主题房间。' },
    professional: { id: 'professional', name: '专业级', uploadLimitBytes: HARD_MEDIA_UPLOAD_LIMIT_BYTES, roomQuota: 10, description: '适合大型媒体库与团队协作。' },
    s_node: { id: 's_node', name: 'S级服务器（超级节点）', uploadLimitBytes: 0, roomQuota: 0, description: '平台核心服务器：管理所有房间、服务器节点与资源，查看全部用户数据、全局封禁、调整房间限制并管理 CDN/存储节点。' }
  };
}

function normalizeAccountTier(value = {}, fallbackId = '') {
  const id = cleanText(value?.id || fallbackId, 32).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!id) return null;
  const uploadLimitBytes = Math.max(0, Math.min(HARD_MEDIA_UPLOAD_LIMIT_BYTES, Math.floor(Number(value?.uploadLimitBytes) || 0)));
  const roomQuota = Math.max(0, Math.min(9999, Math.floor(Number(value?.roomQuota) || 0)));
  return { id, name: cleanText(value?.name || id, 40) || id, uploadLimitBytes, roomQuota, description: cleanText(value?.description, 240) };
}

function normalizePermissionGroup(group, fallbackId = '') {
  const id = cleanText(group?.id || fallbackId, 32).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!id) return null;
  const input = group?.permissions || {};
  return {
    id, name: cleanText(group?.name || id, 24) || id, system: Boolean(group?.system),
    permissions: {
      control: Boolean(input.control), seek: input.seek === undefined ? Boolean(input.control) : Boolean(input.seek), upload: Boolean(input.upload), delete: Boolean(input.delete), manageMedia: Boolean(input.manageMedia),
      shareScreen: Boolean(input.shareScreen), shareAudio: input.shareAudio === undefined ? Boolean(input.shareScreen) : Boolean(input.shareAudio), shareWeb: Boolean(input.shareWeb), voiceChat: input.voiceChat !== false,
      manageChat: Boolean(input.manageChat), manageRoom: Boolean(input.manageRoom), skipSettings: Boolean(input.skipSettings), sendNotice: Boolean(input.sendNotice)
    }
  };
}

const PLAYBACK_MODES = new Set(['autoplay', 'single', 'list', 'category', 'reverse', 'off']);
const UI_THEME_NAMES = new Map([
  ['original', '原版界面'], ['cinema-deck', '影院甲板'], ['command-orbit', '指挥轨道'],
  ['living-room', '客厅沉浸'], ['screening-journal', '放映刊物'], ['director-console', '导播控制台'],
  ['timeline-room', '时间线房间'], ['poster-library', '海报片库'], ['pure-screening', '纯净放映'],
  ['conversation-first', '对话优先'], ['spatial-room', '空间房间'], ['browser-workspace', '浏览器工作区'],
  ['ten-foot-tv', '十英尺电视'], ['fluid-desktop', '流畅桌面'], ['mono-screening', '黑白放映报'],
  ['friends-party', '好友放映会'], ['arcade-room', '街机房间'], ['audio-stage', '音源舞台'],
  ['city-watch', '城市同看'], ['modular-windows', '模块化窗口'], ['silver-screen', '银幕典藏']
]);

function normalizePlaybackMode(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = PLAYBACK_MODES.has(source.mode) ? source.mode : 'autoplay';
  return { mode, category: cleanText(source.category, 120) };
}

function normalizeBranding(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const owner = cleanText(source.owner || 'xuan', 60) || 'xuan';
  const notice = cleanText(source.notice || `版权所有 © ${owner}，保留所有权利。`, 240)
    || `版权所有 © ${owner}，保留所有权利。`;
  return { owner, notice };
}

function normalizeLoginCubeImage(value, faceId) {
  const raw = cleanText(value, 2048);
  if (!raw) return '';
  const localPattern = new RegExp(`^/login-cube-image/${faceId}(?:\\?v=\\d{1,20})?$`);
  if (localPattern.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    return parsed.toString().slice(0, 2048);
  } catch (_) { return ''; }
}

function normalizeLoginCubeModel(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const storedName = /^[a-f0-9-]+\.glb$/i.test(String(source.storedName || '')) ? path.basename(String(source.storedName)) : '';
  const expectedUrl = storedName ? `/login-cube-model/${storedName}` : '';
  const rawUrl = cleanText(source.url, 2048);
  const url = expectedUrl && new RegExp(`^${expectedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\?v=\\d{1,20})?$`).test(rawUrl)
    ? rawUrl : '';
  const size = Math.max(0, Math.min(LOGIN_CUBE_MODEL_LIMIT_BYTES, Math.floor(Number(source.size) || 0)));
  const sha256 = /^[a-f0-9]{64}$/i.test(String(source.sha256 || '')) ? String(source.sha256).toLowerCase() : '';
  if (!storedName || !url || !size || !sha256) return { url: '', storedName: '', originalName: '', size: 0, sha256: '', uploadedAt: '' };
  return {
    url, storedName, originalName: normalizeOriginalName(source.originalName || 'login-model.glb').slice(0, 180),
    size, sha256, uploadedAt: cleanText(source.uploadedAt, 60)
  };
}

function normalizeLoginCubeSettings(value = {}, baseValue = null) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const base = baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue) ? baseValue : {};
  const sourceFaces = Array.isArray(source.faces) ? source.faces : [];
  const baseFaces = Array.isArray(base.faces) ? base.faces : [];
  const faceById = new Map(sourceFaces.map((face) => [String(face?.id || ''), face]));
  const baseById = new Map(baseFaces.map((face) => [String(face?.id || ''), face]));
  const faces = DEFAULT_LOGIN_CUBE_FACES.map((defaults) => {
    const previous = baseById.get(defaults.id) || defaults;
    const incoming = faceById.get(defaults.id) || {};
    const merged = { ...previous, ...incoming, id: defaults.id };
    return {
      id: defaults.id,
      icon: incoming.icon === undefined && previous.icon === undefined ? defaults.icon : cleanText(merged.icon, 16),
      title: incoming.title === undefined && previous.title === undefined ? defaults.title : cleanText(merged.title, 60),
      text: incoming.text === undefined && previous.text === undefined ? defaults.text : cleanText(merged.text, 240),
      image: normalizeLoginCubeImage(merged.image, defaults.id)
    };
  });
  const autoRotate = source.autoRotate === undefined ? base.autoRotate !== false : source.autoRotate !== false;
  const inertia = source.inertia === undefined ? base.inertia !== false : source.inertia !== false;
  const rotationSpeedValue = source.rotationSpeed === undefined ? base.rotationSpeed : source.rotationSpeed;
  const parsedRotationSpeed = Number(rotationSpeedValue);
  const rotationSpeed = Math.max(0, Math.min(18, Number.isFinite(parsedRotationSpeed) ? parsedRotationSpeed : 3));
  const displayModeValue = source.displayMode === undefined ? base.displayMode : source.displayMode;
  const displayMode = ['cube', 'model', 'flat', 'hidden'].includes(displayModeValue) ? displayModeValue : 'cube';
  const rotationDirectionValue = source.rotationDirection === undefined ? base.rotationDirection : source.rotationDirection;
  const rotationDirection = ['right', 'left', 'up', 'down', 'random'].includes(rotationDirectionValue)
    ? rotationDirectionValue : 'right';
  const model = normalizeLoginCubeModel(source.model === undefined ? base.model : source.model);
  return { autoRotate, inertia, rotationSpeed, displayMode: displayMode === 'model' && !model.url ? 'cube' : displayMode, rotationDirection, faces, model, updatedAt: cleanText(source.updatedAt || base.updatedAt, 60) };
}

function normalizeMarqueeNotice(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = cleanText(source.text || DEFAULT_MARQUEE_TEXT, 240) || DEFAULT_MARQUEE_TEXT;
  const color = /^#[0-9a-f]{6}$/i.test(String(source.color || '')) ? String(source.color) : '#f3c96a';
  const speed = Math.max(10, Math.min(200, Number(source.speed) || 30));
  const scope = ['all', 'rooms', 'users'].includes(source.scope) ? source.scope : 'all';
  const enabled = source.enabled === undefined ? true : source.enabled === true;
  const loginEnabled = source.loginEnabled === undefined ? true : source.loginEnabled === true;
  return { enabled, loginEnabled, text, color, speed, scope, updatedAt: source.updatedAt || '' };
}

function normalizeRoomEntryNotice(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const timeoutSeconds = Math.max(3, Math.min(120, Math.floor(Number(source.timeoutSeconds ?? source.durationSeconds) || 10)));
  const updatedAt = cleanText(source.updatedAt, 60);
  return {
    enabled: source.enabled === true,
    title: cleanText(source.title || '房间通知', 80) || '房间通知',
    text: cleanText(source.text, 1000),
    timeoutSeconds,
    durationSeconds: timeoutSeconds,
    version: cleanText(source.version || updatedAt, 60),
    updatedAt,
    updatedBy: cleanUsername(source.updatedBy)
  };
}

function freshRoom(id = roomId(), ownerUsername = '', options = {}) {
  const permissionGroups = defaultPermissionGroups();
  if (options.permissionGroups && typeof options.permissionGroups === 'object' && !Array.isArray(options.permissionGroups)) {
    for (const [key, value] of Object.entries(options.permissionGroups)) {
      const normalized = normalizePermissionGroup(value, key);
      if (normalized) permissionGroups[normalized.id] = { ...permissionGroups[normalized.id], ...normalized, system: Boolean(permissionGroups[normalized.id]?.system || normalized.system) };
    }
  }
  return {
    id, name: cleanText(options.name || '私人影院', 40) || '私人影院',
    maxUsers: Math.max(2, Math.min(100, Math.floor(Number(options.maxUsers) || 8))),
    ownerUsername: cleanUsername(ownerUsername), controlLocked: options.controlLocked !== false,
    // Volume synchronization is opt-in for newly created rooms. Existing rooms
    // keep an explicitly stored `true` value, while older snapshots without the
    // field now follow the safer default of disabled.
    volumeSync: options.volumeSync === true, requireUploadApproval: Boolean(options.requireUploadApproval),
    allowGuests: options.allowGuests !== false,
    storageLimitBytes: Math.max(0, Math.min(MAX_ROOM_STORAGE_LIMIT_BYTES, Math.floor(Number(options.storageLimitBytes) || 0))),
    passwordHash: String(options.passwordHash || ''), permissions: options.permissions && typeof options.permissions === 'object' ? options.permissions : {},
    mediaManagementGrants: options.mediaManagementGrants && typeof options.mediaManagementGrants === 'object' && !Array.isArray(options.mediaManagementGrants)
      ? Object.fromEntries(Object.entries(options.mediaManagementGrants).map(([username, granted]) => [cleanUsername(username), Boolean(granted)]).filter(([username]) => username)) : {},
    permissionGroups, memberGroups: options.memberGroups && typeof options.memberGroups === 'object' && !Array.isArray(options.memberGroups) ? options.memberGroups : {},
    queue: Array.isArray(options.queue) ? options.queue : [], playbackMode: normalizePlaybackMode(options.playbackMode),
    skipSettings: normalizePlaybackSkipSettings(options.skipSettings),
    queueFileModes: options.queueFileModes && typeof options.queueFileModes === 'object' && !Array.isArray(options.queueFileModes)
      ? Object.fromEntries(Object.entries(options.queueFileModes).map(([id, mode]) => [cleanText(id, 80), normalizePlaybackMode(mode)]).filter(([id]) => id)) : {},
    createdAt: options.createdAt || new Date().toISOString(),
    createdBy: cleanUsername(options.createdBy || ownerUsername), archived: Boolean(options.archived), archivedAt: options.archivedAt || '',
    banned: Boolean(options.banned), banReason: cleanText(options.banReason, 200),
    closed: Boolean(options.closed), closedAt: options.closedAt || '', lastActivityAt: options.lastActivityAt || options.createdAt || new Date().toISOString(),
    resumeOnOpen: Boolean(options.resumeOnOpen),
    accessRevision: Math.max(1, Math.floor(Number(options.accessRevision) || 1)),
    temporary: Boolean(options.temporary), systemRoom: Boolean(options.systemRoom),
    passwordEnforcementRequired: Boolean(options.passwordEnforcementRequired) && !String(options.passwordHash || ''),
    entryNotice: options.entryNotice && typeof options.entryNotice === 'object' && !Array.isArray(options.entryNotice)
      ? normalizeRoomEntryNotice(options.entryNotice) : null,
    savedState: options.savedState && typeof options.savedState === 'object' ? options.savedState : null
  };
}

function freshState() {
  const initialRoom = freshRoom(undefined, '', { name: '系统候场室', systemRoom: true });
  return {
    version: 13,
    admin: {
      passwordHash: makePasswordHash('admin888'), accessPasswordHash: '', mustChangePassword: true, passwordChangedAt: new Date().toISOString(),
      uploadMinBytes: 0, uploadLimitBytes: 0, uploadTimeLimitSeconds: 0, uploadVideoDurationLimitSeconds: 0, uploadVideoDurationLimitConfigured: false, uploadVideoDurationLimitConfiguredAt: '', uploadVideoDurationLimitPolicyVersion: UPLOAD_DURATION_POLICY_VERSION, accountTiers: defaultAccountTiers(),
      defaultPermissions: { control: false, seek: false, upload: true, delete: false, manageMedia: false, shareScreen: false, shareAudio: false, shareWeb: false, voiceChat: true, manageChat: false, manageRoom: false, skipSettings: false, sendNotice: false },
      mail: normalizeMailSettings(),
      branding: normalizeBranding(), loginCube: normalizeLoginCubeSettings(), loginMusic: normalizeLoginMusic(), loginVideo: normalizeLoginVideo(), marqueeNotice: normalizeMarqueeNotice(), roomEntryNotice: normalizeRoomEntryNotice(),
      contact: normalizeAdminContact(), legalAgreement: normalizeLegalAgreement(), passwordPolicy: normalizePasswordPolicy(), usernamePolicy: normalizeUsernamePolicy(), roomIdPolicy: normalizeRoomIdPolicy(),
      accountNumberPolicy: normalizeAccountNumberPolicy(), verificationCodePolicy: normalizeVerificationCodePolicy(),
      uiCopy: defaultUiCopy(), uiCopyUpdatedAt: '',
      requireRoomPasswordForPublicAccess: false,
      lanAccessEnabled: true,
      localPasswordlessManagementEnabled: true,
      localPasswordlessRoomEnabled: true,
      f11PromptEnabled: true,
      initialPasswordReminderEnabled: true,
      downloadButtonsVisible: true,
      locationStatusNoticesEnabled: true,
      locationAuthorizationRequestsEnabled: true,
      mediaCompatibilityAutoConvert: true,
      mediaCompatibilityConcurrency: DEFAULT_MEDIA_COMPATIBILITY_CONCURRENCY,
      experiencePerMinute: 1,
      defaultAccountPasswordHash: makePasswordHash('123456'),
      adminMaxConcurrentSessions: 5,
      allowTextUploads: true,
      allowedUploadCategories: ['video'],
      blockedWords: [],
      registrationIpWhitelist: [], registrationAllowances: {}, registrationRequests: [], roomQuotaRequests: [], registrationAccountNoticeEnabled: true,
      uploadPolicyRequests: [], storageQuotaRequests: [], mediaManagementRequests: [], mediaUploadBans: [],
      roomCopyRequests: [], loginLimitRequests: [], loginConcurrencyRequests: [], clientModeRequests: [], accessRecords: [],
      loginPolicy: normalizeLoginPolicy()
    },
    defaultRoomId: initialRoom.id, rooms: { [initialRoom.id]: initialRoom },
    accounts: Object.assign(Object.create(null), {
      admin: {
        id: 'SW-000001', displayName: 'admin', email: '', emailVerified: false, passwordHash: makePasswordHash('admin888'), avatar: '',
        signature: '守护每一场放映', gender: 'private', age: null, registrationIp: '', createdAt: new Date().toISOString(), lastLogin: '',
        devices: [], watchHistory: [], favorites: [], favoriteMeta: {}, mediaNotes: {}, mediaCategories: [], loginHistory: [],
        roomMeta: {}, friends: [], friendMeta: {}, friendSettings: normalizeFriendSettings(), notificationSettings: normalizeNotificationSettings(), viewPreferences: normalizeViewPreferences(), friendRequests: [], friendBlocks: [], friendMessages: [], friendRoomRequests: [], stats: { joinedRooms: 0, createdRooms: 0, watchSeconds: 0, onlineSeconds: 0 },
        experience: 0, experienceRemainderSeconds: 0, levelOverride: null, superAdmin: true, mustChangePassword: true, passwordChangedAt: new Date().toISOString(), roomCreationBlocked: false,
        roomQuota: 0, recentRooms: [], pinnedRooms: [], roomVisitCounts: {}, roomAccessGrants: {}, pendingNotifications: [], acceptedAgreementVersion: '', multiDeviceLogin: true, tierId: 's_node'
      }
    }), blacklist: [], deletedUsernames: [], files: [], operations: [], serverLogs: [], accountAuditLogs: [], verificationCodeRecords: []
  };
}

function migrateState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('配置文件顶层必须是 JSON 对象');
  }
  const next = freshState();
  if (input.admin) {
    next.admin = {
      ...next.admin, ...input.admin,
      uploadMinBytes: Math.max(0, Math.min(HARD_MEDIA_UPLOAD_LIMIT_BYTES, Math.floor(Number(input.admin.uploadMinBytes) || 0))),
      uploadLimitBytes: Math.max(0, Math.min(HARD_MEDIA_UPLOAD_LIMIT_BYTES, Math.floor(Number(input.admin.uploadLimitBytes) || 0))),
      uploadTimeLimitSeconds: Math.max(0, Number(input.admin.uploadTimeLimitSeconds) || 0),
      // v2.3.9 introduced an explicit flag for the optional duration policy.
      // Older state files did not have this flag and some were created with
      // the former five-minute default; treat those as the new unlimited
      // default. Once an administrator saves the setting, the flag preserves
      // the chosen value (including an explicit 0/unlimited value).
      uploadVideoDurationLimitSeconds: (() => {
        const configured = input.admin.uploadVideoDurationLimitConfigured === true;
        const policyVersion = Number(input.admin.uploadVideoDurationLimitPolicyVersion) || 0;
        const candidateValue = Math.floor(Number(input.admin.uploadVideoDurationLimitSeconds) || 0);
        const configuredAt = typeof input.admin.uploadVideoDurationLimitConfiguredAt === 'string'
          && input.admin.uploadVideoDurationLimitConfiguredAt.trim() ? input.admin.uploadVideoDurationLimitConfiguredAt.trim() : '';
        // Candidate builds used policy version 1 (and some had no marker) but
        // still persisted the old five-minute default. Treat that exact value
        // as legacy and migrate it to unlimited. Other explicitly chosen
        // values remain intact across the migration.
        // v2.3.9 mobile candidates could stamp policy version 2 and a
        // configuredAt value while still carrying the former five-minute
        // default. v2.4.1 is the first policy version that can safely retain
        // an explicit 300-second choice, so every older 300-second value is
        // migrated to unlimited regardless of its stale marker.
        if (configured && candidateValue === 300 && policyVersion < UPLOAD_DURATION_POLICY_VERSION) return 0;
        return configured && policyVersion >= 1
          ? Math.max(0, Math.min(HARD_MEDIA_DURATION_LIMIT_SECONDS, candidateValue)) : 0;
      })(),
      // Candidate builds before this field was introduced could persist the
      // old five-minute value together with the configured flag. Treat those
      // records as legacy once, so an upgraded mobile server cannot keep
      // rejecting videos longer than five minutes. A value saved through the
      // v2.4.1 settings UI is tagged with policy version 3 and is retained.
      uploadVideoDurationLimitConfigured: input.admin.uploadVideoDurationLimitConfigured === true
        && Number(input.admin.uploadVideoDurationLimitPolicyVersion) >= 1
        && !(Math.floor(Number(input.admin.uploadVideoDurationLimitSeconds) || 0) === 300
          && Number(input.admin.uploadVideoDurationLimitPolicyVersion) < UPLOAD_DURATION_POLICY_VERSION),
      uploadVideoDurationLimitConfiguredAt: typeof input.admin.uploadVideoDurationLimitConfiguredAt === 'string'
        && input.admin.uploadVideoDurationLimitConfiguredAt.trim()
        && !(Math.floor(Number(input.admin.uploadVideoDurationLimitSeconds) || 0) === 300
          && Number(input.admin.uploadVideoDurationLimitPolicyVersion) < UPLOAD_DURATION_POLICY_VERSION)
        ? input.admin.uploadVideoDurationLimitConfiguredAt.trim() : '',
      uploadVideoDurationLimitPolicyVersion: UPLOAD_DURATION_POLICY_VERSION,
      accountTiers: { ...defaultAccountTiers(), ...(input.admin.accountTiers && typeof input.admin.accountTiers === 'object' ? input.admin.accountTiers : {}) },
      defaultPermissions: { ...next.admin.defaultPermissions, ...(input.admin.defaultPermissions || {}) },
      registrationIpWhitelist: Array.isArray(input.admin.registrationIpWhitelist)
        ? [...new Set(input.admin.registrationIpWhitelist.map(normalizeIp).filter(Boolean))] : [],
      registrationAllowances: input.admin.registrationAllowances && typeof input.admin.registrationAllowances === 'object'
        ? Object.fromEntries(Object.entries(input.admin.registrationAllowances).map(([ip, count]) => [normalizeIp(ip), Math.max(0, Math.floor(Number(count) || 0))]).filter(([ip, count]) => ip && count)) : {},
      registrationRequests: retainPersistentRequests(input.admin.registrationRequests)
        .map(normalizeRegistrationRequestCounts),
      registrationAccountNoticeEnabled: input.admin.registrationAccountNoticeEnabled !== false,
      allowTextUploads: input.admin.allowTextUploads !== false,
      allowedUploadCategories: normalizeAllowedUploadCategories(input.admin.allowedUploadCategories),
      blockedWords: normalizeBlockedWords(input.admin.blockedWords),
      mail: normalizeMailSettings(input.admin.mail),
      branding: normalizeBranding(input.admin.branding),
      loginCube: normalizeLoginCubeSettings(input.admin.loginCube),
      loginMusic: normalizeLoginMusic(input.admin.loginMusic),
      loginVideo: normalizeLoginVideo(input.admin.loginVideo),
      accountNumberPolicy: normalizeAccountNumberPolicy(input.admin.accountNumberPolicy),
      verificationCodePolicy: normalizeVerificationCodePolicy(input.admin.verificationCodePolicy)
    };
    next.admin.uiCopy = normalizeUiCopy(input.admin.uiCopy);
    next.admin.uiCopyUpdatedAt = cleanText(input.admin.uiCopyUpdatedAt, 60);
    next.admin.contact = normalizeAdminContact(input.admin.contact);
    next.admin.marqueeNotice = normalizeMarqueeNotice(input.admin.marqueeNotice);
    next.admin.roomEntryNotice = normalizeRoomEntryNotice(input.admin.roomEntryNotice);
    next.admin.legalAgreement = normalizeLegalAgreement(input.admin.legalAgreement);
    next.admin.passwordPolicy = normalizePasswordPolicy(input.admin.passwordPolicy);
    next.admin.usernamePolicy = normalizeUsernamePolicy(input.admin.usernamePolicy);
    next.admin.passwordChangedAt = input.admin.passwordChangedAt || next.admin.passwordChangedAt;
    next.admin.roomIdPolicy = normalizeRoomIdPolicy(input.admin.roomIdPolicy);
    next.admin.requireRoomPasswordForPublicAccess = input.admin.requireRoomPasswordForPublicAccess === true;
    next.admin.lanAccessEnabled = input.admin.lanAccessEnabled !== false;
    next.admin.localPasswordlessManagementEnabled = input.admin.localPasswordlessManagementEnabled !== false;
    next.admin.localPasswordlessRoomEnabled = input.admin.localPasswordlessRoomEnabled !== false;
    next.admin.f11PromptEnabled = input.admin.f11PromptEnabled !== false;
    next.admin.initialPasswordReminderEnabled = input.admin.initialPasswordReminderEnabled !== false;
    next.admin.downloadButtonsVisible = input.admin.downloadButtonsVisible !== false;
    next.admin.locationStatusNoticesEnabled = input.admin.locationStatusNoticesEnabled !== false;
    next.admin.locationAuthorizationRequestsEnabled = input.admin.locationAuthorizationRequestsEnabled !== false;
    next.admin.mediaCompatibilityAutoConvert = input.admin.mediaCompatibilityAutoConvert !== false;
    next.admin.mediaCompatibilityConcurrency = Math.max(1, Math.min(MAX_MEDIA_COMPATIBILITY_CONCURRENCY,
      Math.floor(Number(input.admin.mediaCompatibilityConcurrency) || DEFAULT_MEDIA_COMPATIBILITY_CONCURRENCY)));
    next.admin.experiencePerMinute = Number.isFinite(Number(input.admin.experiencePerMinute))
      ? Math.max(0, Math.min(1000, Math.floor(Number(input.admin.experiencePerMinute)))) : 1;
    next.admin.defaultAccountPasswordHash = String(input.admin.defaultAccountPasswordHash || '').startsWith('pbkdf2$')
      ? String(input.admin.defaultAccountPasswordHash) : makePasswordHash('123456');
    next.admin.adminMaxConcurrentSessions = Math.max(1, Math.min(20, Math.floor(Number(input.admin.adminMaxConcurrentSessions)
      || (input.admin.adminUnlimitedDevices === false ? 1 : 5))));
    next.admin.roomQuotaRequests = retainPersistentRequests(input.admin.roomQuotaRequests);
    next.admin.uploadPolicyRequests = retainPersistentRequests(input.admin.uploadPolicyRequests);
    next.admin.storageQuotaRequests = retainPersistentRequests(input.admin.storageQuotaRequests);
    next.admin.mediaManagementRequests = retainPersistentRequests(input.admin.mediaManagementRequests);
    next.admin.roomCopyRequests = retainPersistentRequests(input.admin.roomCopyRequests).slice(-1000);
    next.admin.loginLimitRequests = retainPersistentRequests(input.admin.loginLimitRequests).slice(-1000);
    next.admin.loginConcurrencyRequests = retainPersistentRequests(input.admin.loginConcurrencyRequests).slice(-1000);
    next.admin.clientModeRequests = retainPersistentRequests(input.admin.clientModeRequests).slice(-1000)
      .filter((entry) => ['notifications-off', 'concise', 'professional'].includes(entry.mode) && cleanUsername(entry.username))
      .map((entry) => ({
        ...entry,
        username: cleanUsername(entry.username),
        mode: entry.mode,
        scope: ['users', 'room', 'server'].includes(entry.scope) ? entry.scope : 'users',
        roomId: normalizeRoomId(entry.roomId),
        reason: cleanText(entry.reason, 240),
        status: ['pending', 'approved', 'denied', 'cancelled'].includes(entry.status) ? entry.status : 'pending'
      }));
    next.admin.accessRecords = (Array.isArray(input.admin.accessRecords) ? input.admin.accessRecords : [])
      .filter((entry) => entry && typeof entry === 'object').slice(-5000).map((entry) => ({
        id: cleanText(entry.id, 80) || crypto.randomUUID(), timestamp: cleanText(entry.timestamp, 60),
        ipAddress: normalizeIp(entry.ipAddress), username: cleanUsername(entry.username),
        deviceName: cleanText(entry.deviceName, 80), platform: cleanText(entry.platform, 40),
        browser: cleanText(entry.browser, 40), action: cleanText(entry.action, 40),
        result: cleanText(entry.result, 40), message: cleanText(entry.message, 240)
      }));
    next.admin.loginPolicy = normalizeLoginPolicy(input.admin.loginPolicy || input.admin);
    next.admin.mediaUploadBans = (Array.isArray(input.admin.mediaUploadBans) ? input.admin.mediaUploadBans : [])
      .filter((entry) => entry && typeof entry === 'object' && normalizeRoomId(entry.roomId) && cleanText(entry.originalName, 180))
      .slice(-1000)
      .map((entry) => ({
        id: cleanText(entry.id, 80) || crypto.randomUUID(),
        roomId: normalizeRoomId(entry.roomId),
        originalName: normalizeOriginalName(entry.originalName),
        addedBy: cleanUsername(entry.addedBy),
        addedAt: cleanText(entry.addedAt, 60) || new Date().toISOString(),
        enabled: entry.enabled !== false
      }));
  } else if (input.adminConfig) {
    if (input.adminConfig.adminPassword) next.admin.passwordHash = makePasswordHash(input.adminConfig.adminPassword);
    if (input.adminConfig.accessPassword) next.admin.accessPasswordHash = makePasswordHash(input.adminConfig.accessPassword);
  }
  next.verificationCodeRecords = (Array.isArray(input.verificationCodeRecords) ? input.verificationCodeRecords : [])
    .filter((entry) => entry && typeof entry === 'object' && entry.id)
    .map((entry) => ({
      id: cleanText(entry.id, 80), type: cleanText(entry.type, 40), status: ['active', 'used', 'expired', 'failed'].includes(entry.status) ? entry.status : 'expired',
      accountName: cleanText(entry.accountName, 120), senderEmail: cleanText(entry.senderEmail, 254), recipientEmail: cleanText(entry.recipientEmail, 254),
      requestIp: cleanText(entry.requestIp, 120), deviceId: cleanText(entry.deviceId, 160), createdAt: cleanText(entry.createdAt, 60),
      sentAt: cleanText(entry.sentAt, 60), acceptedAt: cleanText(entry.acceptedAt, 60), usedAt: cleanText(entry.usedAt, 60),
      expiresAt: cleanText(entry.expiresAt, 60), error: cleanText(entry.error, 240)
    })).slice(-5000);
  const guestUsernames = new Set();
  if (input.accounts && typeof input.accounts === 'object' && !Array.isArray(input.accounts)) {
    for (const [username, account] of Object.entries(input.accounts)) {
      if (account?.guest === true) guestUsernames.add(cleanUsername(username));
    }
  } else if (Array.isArray(input.accounts)) {
    for (const [username, account] of input.accounts) {
      if (account?.guest === true) guestUsernames.add(cleanUsername(username));
    }
  }
  const legacyRoomId = normalizeRoomId(input.room?.id) || normalizeRoomId(input.defaultRoomId) || next.defaultRoomId;
  next.rooms = {};
  if (input.rooms && typeof input.rooms === 'object' && !Array.isArray(input.rooms)) {
    for (const [key, value] of Object.entries(input.rooms)) {
      if (value?.temporary || guestUsernames.has(value?.ownerUsername || value?.createdBy)) continue;
      const id = normalizeRoomId(value?.id || key);
      if (!id || next.rooms[id]) continue;
      next.rooms[id] = freshRoom(id, value?.ownerUsername, {
        ...value,
        passwordHash: value?.passwordHash || (id === legacyRoomId ? next.admin.accessPasswordHash || '' : ''),
        permissions: value?.permissions || (id === legacyRoomId ? input.permissions || {} : {}),
        queue: value?.queue || (id === legacyRoomId ? input.queue || [] : [])
      });
    }
  }
  if (!Object.keys(next.rooms).length) {
    const legacy = input.room || {};
    if (!guestUsernames.has(legacy.ownerUsername)) {
      next.rooms[legacyRoomId] = freshRoom(legacyRoomId, legacy.ownerUsername, {
        ...legacy, passwordHash: legacy.passwordHash || next.admin.accessPasswordHash || '',
        permissions: input.permissions || {}, queue: input.queue || []
      });
    }
  }
  next.defaultRoomId = normalizeRoomId(input.defaultRoomId);
  if (!next.defaultRoomId || !next.rooms[next.defaultRoomId]) next.defaultRoomId = next.rooms[legacyRoomId] ? legacyRoomId : Object.keys(next.rooms)[0];
  next.admin.accessPasswordHash = next.rooms[next.defaultRoomId]?.passwordHash || next.admin.accessPasswordHash || '';
  next.accounts = Object.assign(Object.create(null), next.accounts,
    input.accounts && !Array.isArray(input.accounts) ? input.accounts : {});
  if (Array.isArray(input.accounts)) {
    for (const [username, account] of input.accounts) next.accounts[username] = account;
  }
  for (const username of guestUsernames) delete next.accounts[username];
  for (const [username, accountValue] of Object.entries(next.accounts)) {
    const account = accountValue && typeof accountValue === 'object' ? accountValue : {};
    account.displayName = cleanText(account.displayName || username, 24) || username;
    account.email = cleanText(account.email, 120).toLowerCase();
    account.emailVerified = Boolean(account.email && account.emailVerified === true);
    account.avatar = cleanText(account.avatar, 500);
    account.signature = cleanText(account.signature, 160);
    account.adminRemark = cleanText(account.adminRemark, 80);
    account.gender = ['male', 'female', 'other', 'private'].includes(account.gender) ? account.gender : 'private';
    account.age = Number.isInteger(Number(account.age)) && Number(account.age) >= 1 && Number(account.age) <= 150 ? Number(account.age) : null;
    account.registrationIp = normalizeIp(account.registrationIp || account.loginHistory?.[account.loginHistory.length - 1]?.ip || '');
    account.devices = Array.isArray(account.devices) ? account.devices : [];
    account.watchHistory = Array.isArray(account.watchHistory) ? account.watchHistory : [];
    account.favorites = Array.isArray(account.favorites) ? account.favorites : [];
    account.favoriteMeta = account.favoriteMeta && typeof account.favoriteMeta === 'object' ? account.favoriteMeta : {};
    account.mediaNotes = account.mediaNotes && typeof account.mediaNotes === 'object' ? account.mediaNotes : {};
    account.mediaCategories = Array.isArray(account.mediaCategories) ? [...new Set(account.mediaCategories.map((value) => cleanText(value, 80).trim()).filter(Boolean))].slice(0, 100) : [];
    account.roomMeta = account.roomMeta && typeof account.roomMeta === 'object' ? account.roomMeta : {};
    account.friends = Array.isArray(account.friends) ? [...new Set(account.friends.map(cleanUsername).filter(Boolean))] : [];
    account.friendMeta = account.friendMeta && typeof account.friendMeta === 'object' ? account.friendMeta : {};
    account.friendSettings = normalizeFriendSettings(account.friendSettings);
    account.notificationSettings = normalizeNotificationSettings(account.notificationSettings);
    account.viewPreferences = normalizeViewPreferences({
      ...(account.viewPreferences || {}),
      conciseMode: account.viewPreferences?.conciseMode ?? account.notificationSettings.conciseMode
    });
    account.notificationSettings.conciseMode = account.viewPreferences.conciseMode;
    account.friendRequests = Array.isArray(account.friendRequests) ? account.friendRequests.filter((item) => item && typeof item === 'object').slice(-200) : [];
    account.friendBlocks = Array.isArray(account.friendBlocks) ? [...new Set(account.friendBlocks.map(cleanUsername).filter(Boolean))] : [];
    account.friendMessages = Array.isArray(account.friendMessages) ? account.friendMessages.filter((item) => item && typeof item === 'object').slice(-1000) : [];
    account.friendRoomRequests = retainPersistentRequests(account.friendRoomRequests).slice(-500);
    account.userRemarks = account.userRemarks && typeof account.userRemarks === 'object' && !Array.isArray(account.userRemarks)
      ? Object.fromEntries(Object.entries(account.userRemarks)
        .map(([target, remark]) => [cleanUsername(target), cleanText(remark, 80)])
        .filter(([target, remark]) => target && remark && target !== username))
      : {};
    account.loginHistory = Array.isArray(account.loginHistory) ? account.loginHistory : [];
    account.stats = { joinedRooms: 0, createdRooms: 0, watchSeconds: 0, onlineSeconds: 0, ...(account.stats || {}) };
    account.experience = Math.max(0, Math.floor(Number(account.experience) || Math.floor((Number(account.stats.watchSeconds) || 0) / 60)));
    account.experienceRemainderSeconds = Math.max(0, Math.min(59.999, Number(account.experienceRemainderSeconds) || 0));
    account.levelOverride = Number.isInteger(Number(account.levelOverride)) ? Math.max(1, Math.min(WATCH_LEVELS.length, Number(account.levelOverride))) : null;
    account.superAdmin = username === 'admin' || Boolean(account.superAdmin);
    account.mustChangePassword = username === 'admin'
      ? account.mustChangePassword !== false
      : (account.superAdmin ? false : Boolean(account.mustChangePassword));
    const accountChangedAt = Date.parse(String(account.passwordChangedAt || account.createdAt || ''));
    account.passwordChangedAt = Number.isFinite(accountChangedAt) ? new Date(accountChangedAt).toISOString() : new Date().toISOString();
    account.roomCreationBlocked = Boolean(account.roomCreationBlocked);
    account.roomQuota = username === 'admin' ? 0 : Math.max(1, Math.min(9999, Math.floor(Number(account.roomQuota) || 1)));
    account.tierId = username === 'admin' || account.superAdmin ? 's_node' : (next.admin.accountTiers?.[account.tierId] ? account.tierId : 'basic');
    account.recentRooms = Array.isArray(account.recentRooms) ? account.recentRooms.map(normalizeRoomId).filter((id, index, values) => id && values.indexOf(id) === index).slice(0, 20) : [];
    account.pinnedRooms = Array.isArray(account.pinnedRooms) ? account.pinnedRooms.map(normalizeRoomId).filter((id, index, values) => id && values.indexOf(id) === index) : [];
    account.roomVisitCounts = account.roomVisitCounts && typeof account.roomVisitCounts === 'object' && !Array.isArray(account.roomVisitCounts)
      ? Object.fromEntries(Object.entries(account.roomVisitCounts).map(([id, count]) => [normalizeRoomId(id), Math.max(0, Math.floor(Number(count) || 0))]).filter(([id]) => id)) : {};
    account.roomAccessGrants = account.roomAccessGrants && typeof account.roomAccessGrants === 'object' && !Array.isArray(account.roomAccessGrants)
      ? Object.fromEntries(Object.entries(account.roomAccessGrants).map(([id, revision]) => [normalizeRoomId(id), Math.max(1, Math.floor(Number(revision) || 0))]).filter(([id, revision]) => id && revision)) : {};
    account.pendingNotifications = Array.isArray(account.pendingNotifications)
      ? account.pendingNotifications.filter((notice) => notice && typeof notice === 'object').slice(-100) : [];
    account.acceptedAgreementVersion = cleanText(account.acceptedAgreementVersion, 40);
    account.multiDeviceLogin = username === 'admin' ? true : Boolean(account.multiDeviceLogin);
    account.loginSessionLimit = username === 'admin' ? 0 : Math.max(0, Math.min(20, Math.floor(Number(account.loginSessionLimit) || 0)));
    next.accounts[username] = account;
  }
  next.blacklist = Array.isArray(input.blacklist) ? input.blacklist : [];
  next.deletedUsernames = Array.isArray(input.deletedUsernames)
    ? [...new Set(input.deletedUsernames.map(cleanUsername).filter((name) => !usernamePolicyError(name, {
      mode: 'unrestricted', lengthRestricted: false, minLength: 1, maxLength: USERNAME_MAX_UTF8_BYTES
    }) && name !== 'admin'))]
    : [];
  next.files = Array.isArray(input.files) ? input.files
    .filter((file) => !guestUsernames.has(file?.uploadedBy))
    .map((file) => ({
      status: 'approved', metadata: {}, thumbnailName: '', subtitleVideoId: '', relativePath: '', roomId: next.defaultRoomId, ...file,
      roomId: normalizeRoomId(file?.roomId) && next.rooms[normalizeRoomId(file.roomId)] ? normalizeRoomId(file.roomId) : next.defaultRoomId
    })) : [];
  next.operations = Array.isArray(input.operations) ? input.operations.filter((operation) => !guestUsernames.has(operation?.actor)) : [];
  next.serverLogs = Array.isArray(input.serverLogs) ? input.serverLogs.slice(-5000) : [];
  next.accountAuditLogs = Array.isArray(input.accountAuditLogs) ? input.accountAuditLogs
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && !guestUsernames.has(cleanUsername(entry.username)))
    .map((entry) => ({
      id: cleanText(entry.id, 80) || crypto.randomUUID(),
      timestamp: Number.isFinite(Date.parse(String(entry.timestamp || ''))) ? new Date(entry.timestamp).toISOString() : new Date().toISOString(),
      category: ['register', 'login', 'logout', 'account-delete'].includes(entry.category) ? entry.category : 'login',
      action: cleanText(entry.action, 40), result: entry.result === 'success' ? 'success' : 'failure',
      username: cleanUsername(entry.username), displayName: cleanText(entry.displayName, 60),
      ipAddress: normalizeIp(entry.ipAddress), deviceName: cleanText(entry.deviceName, 80),
      platform: cleanText(entry.platform, 40), browser: cleanText(entry.browser, 40),
      actor: cleanUsername(entry.actor), actorName: cleanText(entry.actorName, 60), message: cleanText(entry.message, 240)
    })).slice(-10000) : [];
  const defaultRoom = next.rooms[next.defaultRoomId];
  if (defaultRoom && !defaultRoom.systemRoom && !defaultRoom.temporary
    && !defaultRoom.ownerUsername && !defaultRoom.createdBy && defaultRoom.name === '私人影院') {
    const usedByAccount = Object.values(next.accounts).some((account) => Array.isArray(account?.recentRooms) && account.recentRooms.includes(defaultRoom.id));
    const usedByMedia = next.files.some((file) => file.roomId === defaultRoom.id);
    const usedByRoomOperation = next.operations.some((operation) => operation?.roomId === defaultRoom.id && operation?.scope !== 'server');
    if (!usedByAccount && !usedByMedia && !usedByRoomOperation && !defaultRoom.savedState) {
      defaultRoom.systemRoom = true;
      defaultRoom.name = '系统候场室';
    }
  }
  for (const room of Object.values(next.rooms)) {
    room.maxUsers = Math.max(2, Math.min(100, Math.floor(Number(room.maxUsers) || 8)));
    room.allowGuests = room.allowGuests !== false;
    room.queue = room.queue.filter((id) => next.files.some((file) => file.id === id && file.roomId === room.id));
  }
  if (next.admin.uploadLimitBytes > 0 && next.admin.uploadMinBytes > next.admin.uploadLimitBytes) {
    next.admin.uploadMinBytes = next.admin.uploadLimitBytes;
  }
  next.version = 13;
  return next;
}

function atomicWriteJson(filename, value) {
  const temporary = `${filename}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, filename);
  } catch (error) {
    try { if (fs.existsSync(temporary) && fs.statSync(temporary).isFile()) fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function formatLocalDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  if (typeof globalThis.Intl?.DateTimeFormat === 'function') {
    return new globalThis.Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(date);
  }
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function backupCorruptState(stateFile) {
  const backup = `${stateFile}.corrupt-${Date.now()}`;
  fs.copyFileSync(stateFile, backup, fs.constants.COPYFILE_EXCL);
  return backup;
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    const state = freshState();
    try { atomicWriteJson(stateFile, state); }
    catch (error) { throw new Error(`无法创建服务器配置文件 ${stateFile}：${error.message}`, { cause: error }); }
    return state;
  }

  let source;
  try {
    source = fs.readFileSync(stateFile, 'utf8');
  } catch (error) {
    throw new Error(`无法读取服务器配置文件 ${stateFile}，已停止启动：${error.message}`, { cause: error });
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    let backup = '';
    try { backup = backupCorruptState(stateFile); }
    catch (backupError) {
      throw new Error(`服务器配置文件解析失败，且无法创建损坏备份；原文件未被覆盖，已停止启动：${error.message}；备份失败：${backupError.message}`, { cause: error });
    }
    throw new Error(`服务器配置文件解析失败；原文件未被覆盖，已备份到 ${backup}，并停止启动：${error.message}`, { cause: error });
  }

  let state;
  try {
    state = migrateState(parsed);
  } catch (error) {
    let backup = '';
    try { backup = backupCorruptState(stateFile); }
    catch (backupError) {
      throw new Error(`服务器配置迁移失败，且无法创建损坏备份；原文件未被覆盖，已停止启动：${error.message}；备份失败：${backupError.message}`, { cause: error });
    }
    throw new Error(`服务器配置迁移失败；原文件未被覆盖，已备份到 ${backup}，并停止启动：${error.message}`, { cause: error });
  }

  try {
    atomicWriteJson(stateFile, state);
  } catch (error) {
    throw new Error(`服务器配置迁移结果无法写入；原配置未被当作损坏文件处理，已停止启动：${error.message}`, { cause: error });
  }
  return state;
}

function linuxProcessStartMarker(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return '';
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/);
    return fields[19] || '';
  } catch (_) { return ''; }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function dataLockOwner(lockDirectory) {
  const ownerFile = path.join(lockDirectory, DATA_LOCK_OWNER_FILE);
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    const valid = owner && owner.version === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0
      && typeof owner.hostname === 'string' && owner.hostname && typeof owner.token === 'string' && owner.token.length >= 16;
    return valid ? owner : null;
  } catch (_) { return null; }
}

function activeDataLockOwner(owner, canonicalDirectory) {
  if (!owner || owner.hostname.toLowerCase() !== os.hostname().toLowerCase()) return true;
  const ownerDirectory = process.platform === 'win32' ? String(owner.dataDirectory || '').toLowerCase() : String(owner.dataDirectory || '');
  if (ownerDirectory && ownerDirectory !== canonicalDirectory) return false;
  const updatedAt = Date.parse(String(owner.updatedAt || ''));
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt > DATA_LOCK_STALE_MS) return false;
  if (!processIsAlive(owner.pid)) return false;
  if (owner.processStartMarker) {
    const currentMarker = linuxProcessStartMarker(owner.pid);
    if (currentMarker && currentMarker !== owner.processStartMarker) return false;
  }
  return true;
}

function dataLockDescription(owner) {
  if (!owner) return '锁信息无法读取';
  const startedAt = cleanText(owner.startedAt, 60) || '未知时间';
  return `PID ${owner.pid}，主机 ${cleanText(owner.hostname, 120)}，启动时间 ${startedAt}`;
}

function writeDataLockOwner(ownerFile, owner) {
  const temporary = `${ownerFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, ownerFile);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    throw error;
  }
}

function acquireDataDirectoryLock(dataDirectory) {
  const resolvedDirectory = fs.realpathSync.native(dataDirectory);
  const canonicalDirectory = process.platform === 'win32' ? resolvedDirectory.toLowerCase() : resolvedDirectory;
  const lockDirectory = path.join(resolvedDirectory, DATA_LOCK_DIRECTORY_NAME);
  const token = crypto.randomBytes(24).toString('base64url');
  const owner = {
    version: 1,
    pid: process.pid,
    hostname: os.hostname(),
    token,
    dataDirectory: canonicalDirectory,
    startedAt: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
    updatedAt: new Date().toISOString(),
    processStartMarker: linuxProcessStartMarker(process.pid)
  };

  let acquired = false;
  for (let attempt = 0; attempt < 8 && !acquired; attempt += 1) {
    const pendingDirectory = `${lockDirectory}.pending-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      fs.mkdirSync(pendingDirectory, { mode: 0o700 });
      fs.writeFileSync(path.join(pendingDirectory, DATA_LOCK_OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx'
      });
      fs.renameSync(pendingDirectory, lockDirectory);
      acquired = true;
      break;
    } catch (createError) {
      try { fs.rmSync(pendingDirectory, { recursive: true, force: true }); } catch (_) {}
      let lockStats;
      try { lockStats = fs.lstatSync(lockDirectory); }
      catch (statError) {
        if (statError?.code === 'ENOENT') {
          if (attempt < 7) continue;
          throw new Error(`无法锁定数据目录 ${resolvedDirectory}：并发获取锁失败，请重试`, { cause: createError });
        }
        throw new Error(`无法检查数据目录锁 ${lockDirectory}：${statError.message}`, { cause: statError });
      }
      if (!lockStats.isDirectory() || lockStats.isSymbolicLink()) {
        throw new Error(`数据目录锁路径 ${lockDirectory} 不是安全的锁目录；请确认没有其他实例运行后人工处理`);
      }
      const existingOwner = dataLockOwner(lockDirectory);
      if (!existingOwner) {
        throw new Error(`数据目录 ${resolvedDirectory} 已被锁定，但锁信息损坏；为避免并发写坏数据，已停止启动。请确认没有其他实例运行后人工删除 ${lockDirectory}`);
      }
      if (activeDataLockOwner(existingOwner, canonicalDirectory)) {
        const conflict = new Error(`数据目录 ${resolvedDirectory} 正在被另一个 SyncWatch同步观影 实例占用（${dataLockDescription(existingOwner)}）。请先关闭原实例，或为新实例指定不同的 SyncWatch同步观影-Data 目录`);
        conflict.code = 'SYNCWATCH_DATA_LOCKED';
        conflict.dataDirectory = resolvedDirectory;
        conflict.lockDirectory = lockDirectory;
        conflict.lockOwner = { ...existingOwner };
        throw conflict;
      }
      const staleDirectory = `${lockDirectory}.stale-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      try {
        fs.renameSync(lockDirectory, staleDirectory);
        fs.rmSync(staleDirectory, { recursive: true, force: true });
        console.warn(`检测到上次异常退出遗留的数据目录锁（${dataLockDescription(existingOwner)}），已安全回收`);
      } catch (reclaimError) {
        if (reclaimError?.code === 'ENOENT') continue;
        throw new Error(`无法回收数据目录 ${resolvedDirectory} 的崩溃遗留锁：${reclaimError.message}`, { cause: reclaimError });
      }
    }
  }
  if (!acquired) throw new Error(`无法锁定数据目录 ${resolvedDirectory}，请重试`);

  const ownerFile = path.join(lockDirectory, DATA_LOCK_OWNER_FILE);
  const controlFile = path.join(lockDirectory, DATA_LOCK_CONTROL_FILE);
  let released = false;
  const commandPoll = setInterval(() => {
    if (released || !fs.existsSync(controlFile)) return;
    try {
      const command = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
      if (!command || command.version !== 1 || command.ownerToken !== token
        || !['focus', 'shutdown'].includes(command.action)) return;
      if (!process.emit('syncwatch-data-lock-command', { action: command.action, requestedAt: command.requestedAt || '' })) return;
      fs.rmSync(controlFile, { force: true });
    } catch (_) { /* The writer may still be replacing the command file. */ }
  }, 400);
  commandPoll.unref?.();
  const heartbeat = setInterval(() => {
    if (released) return;
    const currentOwner = dataLockOwner(lockDirectory);
    if (!currentOwner || currentOwner.token !== token) {
      clearInterval(heartbeat);
      console.error(`数据目录锁 ${lockDirectory} 的所有权已异常变化；为避免数据损坏，请尽快关闭此实例`);
      return;
    }
    owner.updatedAt = new Date().toISOString();
    try { writeDataLockOwner(ownerFile, owner); }
    catch (error) { console.error(`更新数据目录锁失败：${error.message}`); }
  }, DATA_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    path: lockDirectory,
    release() {
      if (released) return;
      clearInterval(heartbeat);
      clearInterval(commandPoll);
      const currentOwner = dataLockOwner(lockDirectory);
      if (!currentOwner) {
        if (!fs.existsSync(lockDirectory)) { released = true; return; }
        throw new Error(`无法安全释放数据目录锁 ${lockDirectory}：锁信息无法读取`);
      }
      if (currentOwner.token !== token) throw new Error(`无法安全释放数据目录锁 ${lockDirectory}：锁所有权已变化`);
      const releasedDirectory = `${lockDirectory}.released-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      fs.renameSync(lockDirectory, releasedDirectory);
      fs.rmSync(releasedDirectory, { recursive: true, force: true });
      released = true;
    }
  };
}

function safeStoredName(value) {
  const name = String(value || '');
  return Boolean(name && name.length <= 255 && name !== '.' && name !== '..' && !name.includes('\0')
    && path.posix.basename(name) === name && path.win32.basename(name) === name);
}

function normalizeOriginalName(value) {
  let name = cleanText(path.basename(String(value || '未命名文件')), 180) || '未命名文件';
  if (/^[\u0000-\u00ff]+$/.test(name)) {
    const repaired = Buffer.from(name, 'latin1').toString('utf8');
    if (!repaired.includes('\uFFFD') && /[^\u0000-\u007f]/.test(repaired)) name = repaired;
  }
  return name;
}

function networkAddresses(port) {
  const addresses = [];
  const virtual = /(vmware|virtualbox|hyper-v|vethernet|wsl|docker|zerotier|tailscale|tunnel|vpn)/i;
  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const entry of interfaces || []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.') || entry.address.startsWith('198.18.') || entry.address.startsWith('198.19.')) continue;
      const privateIp = entry.address.startsWith('10.') || entry.address.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address);
      const rank = (virtual.test(name) ? 20 : 0) + (entry.address.startsWith('192.168.') ? 0 : privateIp ? 2 : 10);
      addresses.push({ url: `http://${entry.address}:${port}`, rank });
    }
  }
  return [...new Map(addresses.sort((a, b) => a.rank - b.rank).map((item) => [item.url, item])).values()].map((item) => item.url);
}

function parseCookies(req) {
  const result = {};
  for (const section of String(req.headers.cookie || '').split(';')) {
    const separator = section.indexOf('=');
    if (separator < 0) continue;
    const key = section.slice(0, separator).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(section.slice(separator + 1).trim()); }
    catch (_) { /* Ignore malformed cookie values instead of failing the request. */ }
  }
  return result;
}

function vttTimestamp(raw) {
  const normalized = String(raw).trim().replace(',', '.');
  return /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(normalized) ? normalized : '00:00:00.000';
}

function subtitleToVtt(contents, extension) {
  let text = String(contents || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  if (extension === '.vtt') return text.startsWith('WEBVTT') ? text : `WEBVTT\n\n${text}`;
  if (extension === '.srt') {
    return `WEBVTT\n\n${text.replace(/(\d{2}:\d{2}:\d{2}),([0-9]{3})/g, '$1.$2')}`;
  }
  const result = ['WEBVTT', ''];
  for (const line of text.split('\n')) {
    if (!line.startsWith('Dialogue:')) continue;
    const values = line.slice(9).split(',');
    if (values.length < 10) continue;
    const time = (value) => {
      const match = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
      return match ? `${String(match[1]).padStart(2, '0')}:${match[2]}:${match[3]}.${match[4]}0` : '00:00:00.000';
    };
    result.push(`${vttTimestamp(time(values[1]))} --> ${vttTimestamp(time(values[2]))}`);
    result.push(values.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n'), '');
  }
  return result.join('\n');
}

function decodeSubtitle(contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents || '');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) {
    try { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
    catch (_) { return bytes.toString('utf8'); }
  }
}

function unpackedBinary(binaryPath) {
  if (!binaryPath) return '';
  return process.versions.electron ? binaryPath.replace('app.asar', 'app.asar.unpacked') : binaryPath;
}

function terminateProcessTree(child, force, spawnImpl = spawn, platform = process.platform) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode) return;
  try {
    if (platform === 'win32' && force) {
      const killer = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once?.('error', () => {});
      killer.unref?.();
      return;
    }
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch (_) {}
}

function captureProcess(command, args, timeoutMs = 30000, processTracker = null, captureOptions = {}) {
  return new Promise((resolve, reject) => {
    const spawnImpl = captureOptions.spawnImpl || spawn;
    const platform = captureOptions.platform || process.platform;
    const terminationGraceMs = Math.max(10, Number(captureOptions.terminationGraceMs) || PROCESS_TERMINATION_GRACE_MS);
    const child = spawnImpl(command, args, { windowsHide: true });
    child.syncWatchRecord = captureOptions.record || null;
    processTracker?.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutError = null;
    let timer = null;
    let forceTimer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      processTracker?.delete(child);
      callback(value);
    };
    child.syncWatchAbort = (reason = '进程已被服务器终止') => {
      timeoutError = new Error(reason);
      timeoutError.code = 'SERVER_SHUTDOWN';
      clearTimeout(timer);
      clearTimeout(forceTimer);
      terminateProcessTree(child, true, spawnImpl, platform);
    };
    timer = setTimeout(() => {
      timeoutError = new Error(`进程运行超过 ${timeoutMs}ms，已终止`);
      terminateProcessTree(child, false, spawnImpl, platform);
      forceTimer = setTimeout(() => {
        terminateProcessTree(child, true, spawnImpl, platform);
        finish(reject, timeoutError);
      }, terminationGraceMs);
    }, Math.max(1, timeoutMs));
    child.stdout.on('data', (data) => { if (stdout.length < 8 * 1024 * 1024) stdout += data; });
    child.stderr.on('data', (data) => { if (stderr.length < 2 * 1024 * 1024) stderr += data; });
    child.on('error', (error) => finish(reject, timeoutError || error));
    child.on('close', (code) => {
      if (timeoutError) finish(reject, timeoutError);
      else if (code === 0) finish(resolve, stdout);
      else finish(reject, new Error(stderr.slice(-500) || `进程退出码 ${code}`));
    });
  });
}

function writeDataDirectoryGuide(dataDir) {
  const guide = `SyncWatch同步观影 ${APP_VERSION} 数据目录说明
============================================================

本目录由程序自动创建。除 cache、logs 和 crash-dumps 外，其余内容都可能包含重要业务数据。
迁移服务器时，建议在程序完全退出后整体复制本目录。

config.json
  服务器主配置数据库。保存管理员设置、房间、账号、权限组、成员权限、影片索引、收藏、观看历史、IP 注册策略和操作历史。

chat-history.jsonl
  聊天、私聊、公告、弹幕、语音及图片消息的永久记录。每行是一条 JSON 记录。

uploads/
  用户上传的原始影片、音频、字幕、图片和文档。config.json 中的影片索引会引用这里的文件。

compatible-media/
  服务器生成的 H.264/AAC 公网兼容影片。删除后不会丢失原片，但远端设备可能需要重新生成兼容版。

thumbnails/
  影片缩略图缓存。可重新生成，但保留可避免再次分析影片。

subtitles/
  转换为 WebVTT 的字幕文件，供浏览器和手机端直接加载。

voice/
  聊天中上传或录制的语音消息。

chat-images/
  聊天、私聊和弹幕中粘贴或上传的图片。

avatars/
  用户上传的头像文件。

login-cube/
  登录页 3D 立方体六个面的自定义图片。文字、旋转设置和图片索引保存在 config.json 中。

login-cube-model/
  登录页自定义 3D 模型。仅保存服务器校验通过的单文件 GLB，当前文件索引保存在 config.json 中。

trash/
  可回溯操作对应的临时回收站。超过保留期的内容会由服务器自动清理。

.secrets/
  邮件授权码等敏感信息的本机加密密钥。不要公开、编辑或单独丢失。

secrets/
  超级管理员密码哈希文件：admin-password.json。这里只保存不可逆哈希，不保存明文密码。
  删除整个 secrets/ 文件夹会恢复 admin/admin888 初始登录，服务器会将账号与超级管理员密码同步重置并重新创建该文件。登录后可选择“暂不更改”，建议尽快设置新密码。

.syncwatch-instance.lock/
  防止两个程序同时写入同一数据目录的运行锁。程序正常退出后会自动释放。

electron-profile/
  PC 客户端登录状态、本机偏好和 Web 存储。清理后需要重新登录，但不会删除服务器账号。

cache/
  Electron 网页、图形和媒体缓存。程序退出后可以清理，之后会自动重建。

logs/
  PC 主程序运行日志，用于排查启动、网络和转码问题。

crash-dumps/
  Electron 异常退出诊断文件，仅用于故障排查。

服务器运行信息.txt
  独立服务器脚本生成的端口、访问地址等运行提示。

数据目录说明.txt
  当前说明文件。程序升级后会自动更新。
`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '数据目录说明.txt'), guide.replace(/\n/g, os.EOL), 'utf8');
}

async function startSyncWatchServer(options = {}) {
  const host = options.host || '0.0.0.0';
  const requestedPort = Number(options.port ?? process.env.PORT ?? DEFAULT_PORT);
  const roomEmptyCloseMs = Math.max(10, Number(options.roomEmptyCloseMs) || ROOM_EMPTY_CLOSE_MS);
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, '..', 'public'));
  // Keep the default state beside the executable/project so the complete
  // deployment can be moved as one folder without losing accounts, media,
  // chat history, recovery secrets, or caches. Callers can still provide an
  // explicit directory (tests, containers, and Android do this).
  const dataDir = path.resolve(options.dataDir || process.env.SYNCWATCH_DATA_DIR || resolveDefaultDataDir());
  const uploadsDir = path.join(dataDir, 'uploads');
  const thumbnailsDir = path.join(dataDir, 'thumbnails');
  const subtitlesDir = path.join(dataDir, 'subtitles');
  const voiceDir = path.join(dataDir, 'voice');
  const chatImagesDir = path.join(dataDir, 'chat-images');
  const avatarsDir = path.join(dataDir, 'avatars');
  const loginCubeDir = path.join(dataDir, 'login-cube');
  const loginCubeModelDir = path.join(dataDir, 'login-cube-model');
  const loginMusicDir = path.join(dataDir, 'login-music');
  const loginVideoDir = path.join(dataDir, 'login-video');
  const compatibleMediaDir = path.join(dataDir, 'compatible-media');
  const downloadAssetsDir = path.join(dataDir, 'download-assets');
  const downloadAssetTemporaryDir = path.join(downloadAssetsDir, '.temporary');
  const latestReleaseChecker = createLatestReleaseChecker({ userAgent: `SyncWatch/${APP_VERSION} update-check` });
  const stateFile = path.join(dataDir, 'config.json');
  const chatFile = path.join(dataDir, 'chat-history.jsonl');
  const trashDir = path.join(dataDir, 'trash');
  const secretsDir = path.join(dataDir, '.secrets');
  const adminSecretsDir = path.join(dataDir, 'secrets');
  const adminPasswordFile = path.join(adminSecretsDir, 'admin-password.json');
  const mailKeyFile = path.join(secretsDir, 'mail.key');
  const hostControlToken = String(options.hostControlToken || '');
  const tunnelManager = options.tunnelManager || null;
  const androidApkPath = path.resolve(options.androidApkPath || path.join(__dirname, '..', 'mobile', 'SyncWatch同步观影-v2.4.3.apk'));
  const clientDownloadPath = options.clientDownloadPath ? path.resolve(options.clientDownloadPath) : '';
  const managedAndroidApkPath = path.join(downloadAssetsDir, 'SyncWatch-Android-v2.4.3-universal.apk');
  const managedClientDownloadPath = path.join(downloadAssetsDir, 'SyncWatch-Experience-Client-Portable-v2.4.3-x64.exe');
  const activeAndroidApkPath = () => fs.existsSync(managedAndroidApkPath) ? managedAndroidApkPath : androidApkPath;
  const activeClientDownloadPath = () => fs.existsSync(managedClientDownloadPath) ? managedClientDownloadPath : clientDownloadPath;
  const factoryResetHandler = typeof options.onFactoryResetRequested === 'function' ? options.onFactoryResetRequested : null;
  const restartHandler = typeof options.onRestartRequested === 'function' ? options.onRestartRequested : null;
  const allowedSocketHosts = new Set((options.allowedHosts || []).map((entry) => String(entry).trim().toLowerCase()).filter(Boolean));
  const configuredSocketHosts = new Set(allowedSocketHosts);
  let configuredPublicSocketHost = '';
  let configuredPublicUrl = '';
  try {
    const parsedPublicUrl = new URL(String(options.publicUrl || ''));
    if (['http:', 'https:'].includes(parsedPublicUrl.protocol)) {
      configuredPublicSocketHost = parsedPublicUrl.host.toLowerCase();
      configuredPublicUrl = parsedPublicUrl.origin;
    }
  } catch (_) {}
  const navigationSocketHosts = new Map();
  const lookupHost = options.lookupHost || dns.promises.lookup.bind(dns.promises);
  const networkInterfaces = options.networkInterfaces || os.networkInterfaces.bind(os);
  const lanAddress = net.isIP(String(options.lanAddress || '').trim()) === 4 ? String(options.lanAddress).trim() : '';
  const diskSpaceProvider = typeof options.freeDiskBytes === 'function' ? options.freeDiskBytes : null;
  const diskCheckIntervalBytes = Math.max(1, Number(options.diskCheckIntervalBytes) || DISK_CHECK_INTERVAL_BYTES);
  const mediaCompatibilityHardware = options.mediaCompatibilityHardware !== false;
  const screenFrameAckTimeoutMs = Math.max(50, Number(options.screenFrameAckTimeoutMs) || SCREEN_FRAME_ACK_TIMEOUT_MS);
  const trashRetentionMs = Math.max(1000, Number(options.trashRetentionMs) || TRASH_RETENTION_MS);
  const closeDrainTimeoutMs = Math.max(50, Number(options.closeDrainTimeoutMs) || CLOSE_DRAIN_TIMEOUT_MS);
  const closeAbortGraceMs = Math.max(50, Number(options.closeAbortGraceMs) || CLOSE_ABORT_GRACE_MS);
  const closeFinalTimeoutMs = Math.max(50, Number(options.closeFinalTimeoutMs) || CLOSE_FINAL_TIMEOUT_MS);
  const discoveryPort = Math.max(1, Math.min(65535, Number(options.discoveryPort) || DISCOVERY_PORT));
  const portFallbackCount = options.strictPort ? 0 : Math.max(0, Math.min(100, Number.isFinite(Number(options.portFallbackCount)) ? Math.floor(Number(options.portFallbackCount)) : 10));
  const sessionMaxAgeMs = Math.max(50, Number(options.sessionMaxAgeMs) || SESSION_MAX_AGE_MS);
  const sessionIdleTimeoutMs = Math.max(50, Number(options.sessionIdleTimeoutMs) || SESSION_IDLE_TIMEOUT_MS);
  const memberDisconnectGraceMs = Math.max(50, Number(options.memberDisconnectGraceMs) || MEMBER_DISCONNECT_GRACE_MS);
  const passwordResetNow = typeof options.passwordResetNow === 'function' ? options.passwordResetNow : Date.now;
  const requestContext = new AsyncLocalStorage();
  let activeTunnelSocketHost = '';
  let activeTunnelPublicUrl = '';
  let tunnelPolicyLocked = false;
  let tunnelStartPromise = null;
  let actualPort = requestedPort;
  function rememberAllowedUrl(value) {
    try {
      const valueHost = new URL(String(value)).host.toLowerCase();
      allowedSocketHosts.add(valueHost);
      return valueHost;
    } catch (_) { return ''; }
  }
  function rememberNavigationSocketHost(req) {
    const hostHeader = requestHostHeader(req);
    if (!hostHeaderParts(hostHeader)) return '';
    const now = Date.now();
    for (const [knownHost, expiresAt] of navigationSocketHosts) {
      if (Number(expiresAt) <= now) navigationSocketHosts.delete(knownHost);
    }
    if (!navigationSocketHosts.has(hostHeader) && navigationSocketHosts.size >= MAX_NAVIGATION_SOCKET_HOSTS) {
      navigationSocketHosts.delete(navigationSocketHosts.keys().next().value);
    }
    navigationSocketHosts.delete(hostHeader);
    navigationSocketHosts.set(hostHeader, now + NAVIGATION_SOCKET_HOST_TTL_MS);
    return hostHeader;
  }
  function navigationSocketHostAllowed(hostHeader) {
    const expiresAt = Number(navigationSocketHosts.get(hostHeader)) || 0;
    if (expiresAt > Date.now()) return true;
    if (expiresAt) navigationSocketHosts.delete(hostHeader);
    return false;
  }
  function rememberTunnelUrl(value) {
    if (activeTunnelSocketHost && !configuredSocketHosts.has(activeTunnelSocketHost)) allowedSocketHosts.delete(activeTunnelSocketHost);
    activeTunnelSocketHost = rememberAllowedUrl(value);
    try { activeTunnelPublicUrl = new URL(String(value)).origin; } catch (_) { activeTunnelPublicUrl = ''; }
  }
  function forgetTunnelUrl() {
    if (activeTunnelSocketHost && !configuredSocketHosts.has(activeTunnelSocketHost)) allowedSocketHosts.delete(activeTunnelSocketHost);
    activeTunnelSocketHost = '';
    activeTunnelPublicUrl = '';
  }
  function tunnelStatusHasUsableUrl(status) {
    return status?.state === 'running' && status.verified === true && Boolean(status.publicUrl);
  }
  function synchronizeTunnelUrl(status) {
    if (tunnelStatusHasUsableUrl(status)) rememberTunnelUrl(status.publicUrl);
    else forgetTunnelUrl();
    return tunnelStatusHasUsableUrl(status);
  }
  async function tunnelRunning() {
    if (!tunnelManager) return false;
    try {
      const status = await tunnelManager.status();
      synchronizeTunnelUrl(status);
      return status?.state === 'running' || status?.state === 'reconnecting' || status?.state === 'verifying';
    } catch (_) { forgetTunnelUrl(); return false; }
  }
  function tunnelLifecycleLocked() {
    return tunnelPolicyLocked || Boolean(activeTunnelSocketHost);
  }
  function requestUsesConfiguredPublicHost(req) {
    if (!requestFromPrivateProxy(req)) return false;
    const hostHeader = requestHostHeader(req);
    return Boolean(hostHeader && (hostHeader === configuredPublicSocketHost || hostHeader === activeTunnelSocketHost));
  }
  function tunnelPasswordPolicyLocked() {
    return state.admin.requireRoomPasswordForPublicAccess === true && tunnelLifecycleLocked();
  }
  async function tunnelPasswordPolicyActive() {
    if (state.admin.requireRoomPasswordForPublicAccess !== true) return false;
    if (tunnelPasswordPolicyLocked()) return true;
    const running = await tunnelRunning();
    return running || tunnelPasswordPolicyLocked();
  }
  function currentLocalAddresses() {
    const addresses = new Set(['127.0.0.1']);
    for (const entries of Object.values(networkInterfaces() || {})) {
      for (const entry of entries || []) if (entry?.address && net.isIP(normalizeIp(entry.address))) addresses.add(normalizeIp(entry.address));
    }
    return addresses;
  }
  const trustedProxyMatcher = createTrustedProxyMatcher([
    ...currentLocalAddresses(),
    ...normalizeTrustedProxyEntries(options.trustedProxies ?? process.env.SYNCWATCH_TRUSTED_PROXIES)
  ]);
  async function socketHostIsLocal(hostHeader, { allowMissingPort = false } = {}) {
    const parts = hostHeaderParts(hostHeader);
    if (!parts || (parts.port ? parts.port !== actualPort : (!allowMissingPort && ![80, 443].includes(actualPort)))) return false;
    const localAddresses = currentLocalAddresses();
    if (net.isIP(parts.hostname)) return localAddresses.has(normalizeIp(parts.hostname));
    const localAlias = parts.hostname === 'localhost' || !parts.hostname.includes('.')
      || parts.hostname.endsWith('.local') || parts.hostname.endsWith('.lan')
      || parts.hostname.endsWith('.home.arpa') || parts.hostname.endsWith('.internal');
    if (!localAlias) return false;
    try {
      const answer = await lookupHost(parts.hostname, { all: true, verbatim: true });
      const resolved = Array.isArray(answer) ? answer : [answer];
      return resolved.length > 0 && resolved.every((entry) => entry?.address && localAddresses.has(normalizeIp(entry.address)));
    } catch (_) { return false; }
  }
  async function socketRequestAllowed(req) {
    const peer = normalizeIp(req.socket?.remoteAddress);
    if (lanAddress && peer !== '127.0.0.1' && normalizeIp(req.socket?.localAddress) !== lanAddress) return false;
    if (state?.admin?.lanAccessEnabled === false) {
      const forwardedHttps = privateOrLoopbackAddress(peer)
        && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
      if (peer !== '127.0.0.1' && privateOrLoopbackAddress(peer) && !forwardedHttps) return false;
    }
    const hostHeader = requestHostHeader(req);
    const originHost = socketOriginHost(req);
    if (!hostHeader || !originHost) return false;
    const hasOrigin = Boolean(String(req.headers.origin || '').trim());
    if (hasOrigin && originHost !== hostHeader) {
      const explicitlyAllowedOrigin = configuredSocketHosts.has(originHost) || originHost === activeTunnelSocketHost;
      if (!explicitlyAllowedOrigin || !requestFromPrivateProxy(req)) return false;
      return socketHostIsLocal(hostHeader, { allowMissingPort: true });
    }
    if (allowedSocketHosts.has(hostHeader)) return true;
    if (navigationSocketHostAllowed(hostHeader)) {
      allowedSocketHosts.add(hostHeader);
      return true;
    }
    return socketHostIsLocal(hostHeader);
  }

  let state;
  fs.mkdirSync(dataDir, { recursive: true });
  const dataDirectoryLock = acquireDataDirectoryLock(dataDir);
  try {
  const stateFileExisted = fs.existsSync(stateFile);
  for (const dir of [uploadsDir, thumbnailsDir, subtitlesDir, voiceDir, chatImagesDir, avatarsDir, loginCubeDir, loginCubeModelDir, loginMusicDir, loginVideoDir, compatibleMediaDir, downloadAssetsDir, downloadAssetTemporaryDir, trashDir, secretsDir, adminSecretsDir]) fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(downloadAssetTemporaryDir, { withFileTypes: true })) {
    if (entry.isFile() && /^\.upload-[a-f0-9-]+\.tmp$/i.test(entry.name)) fs.rmSync(path.join(downloadAssetTemporaryDir, entry.name), { force: true });
  }
  writeDataDirectoryGuide(dataDir);
  state = loadState(stateFile);

  function loginCubeFaceFile(faceId) {
    if (!LOGIN_CUBE_FACE_IDS.includes(faceId)) return '';
    for (const extension of ['png', 'jpg', 'webp', 'gif']) {
      const candidate = path.join(loginCubeDir, `${faceId}.${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return '';
  }

  // A copied config can outlive a manually removed login-cube directory. Do
  // not publish local URLs that would permanently return 404 to every client.
  function sanitizeLoginCubeImageReferences() {
    const current = normalizeLoginCubeSettings(state.admin.loginCube);
    let changed = false;
    const faces = current.faces.map((face) => {
      if (face.image.startsWith(`/login-cube-image/${face.id}`) && !loginCubeFaceFile(face.id)) {
        changed = true;
        return { ...face, image: '' };
      }
      return face;
    });
    if (!changed) return;
    state.admin.loginCube = normalizeLoginCubeSettings({ ...current, faces, updatedAt: new Date().toISOString() }, current);
    atomicWriteJson(stateFile, state);
  }

  sanitizeLoginCubeImageReferences();

  function loginCubeModelFile(model = normalizeLoginCubeSettings(state.admin.loginCube).model) {
    if (!model?.storedName || !/^[a-f0-9-]+\.glb$/i.test(model.storedName)) return '';
    const candidate = path.join(loginCubeModelDir, model.storedName);
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : '';
  }

  function sanitizeLoginCubeModelReference() {
    const current = normalizeLoginCubeSettings(state.admin.loginCube);
    if (!current.model.url || loginCubeModelFile(current.model)) {
      state.admin.loginCube = current;
      return;
    }
    state.admin.loginCube = normalizeLoginCubeSettings({
      ...current, displayMode: current.displayMode === 'model' ? 'cube' : current.displayMode,
      model: {}, updatedAt: new Date().toISOString()
    }, current);
    atomicWriteJson(stateFile, state);
  }

  sanitizeLoginCubeModelReference();

  function validateLoginCubeGlb(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 20) throw new Error('GLB 文件头不完整');
    if (buffer.length > LOGIN_CUBE_MODEL_LIMIT_BYTES) throw new Error('自定义模型不能超过 25 MB');
    if (buffer.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error('文件内容不是 GLB 二进制模型');
    if (buffer.readUInt32LE(4) !== 2) throw new Error('仅支持 GLB 2.0 模型');
    if (buffer.readUInt32LE(8) !== buffer.length) throw new Error('GLB 声明长度与实际文件长度不一致');
    if (buffer.length % 4 !== 0) throw new Error('GLB 文件长度未按 4 字节对齐');
    let offset = 12;
    let jsonDocument = null;
    let jsonChunks = 0;
    let binaryChunks = 0;
    while (offset < buffer.length) {
      if (offset + 8 > buffer.length) throw new Error('GLB 分块头不完整');
      const chunkLength = buffer.readUInt32LE(offset);
      const chunkType = buffer.readUInt32LE(offset + 4);
      offset += 8;
      if (!chunkLength || chunkLength % 4 !== 0 || offset + chunkLength > buffer.length) throw new Error('GLB 分块长度异常');
      if (chunkType === 0x4e4f534a) {
        jsonChunks += 1;
        if (jsonChunks !== 1 || offset !== 20 || chunkLength > 8 * 1024 * 1024) throw new Error('GLB JSON 分块异常');
        const source = buffer.subarray(offset, offset + chunkLength).toString('utf8').replace(/[\u0000\u0020]+$/g, '');
        try { jsonDocument = JSON.parse(source); }
        catch (_) { throw new Error('GLB 内部 JSON 数据损坏'); }
      } else if (chunkType === 0x004e4942) {
        binaryChunks += 1;
        if (!jsonDocument || binaryChunks > 1) throw new Error('GLB 二进制分块顺序或数量异常');
      } else {
        throw new Error('GLB 包含不受支持的分块');
      }
      offset += chunkLength;
    }
    if (offset !== buffer.length || jsonChunks !== 1 || !jsonDocument || typeof jsonDocument !== 'object' || Array.isArray(jsonDocument)) {
      throw new Error('GLB 结构不完整');
    }
    if (!/^2(?:\.\d+)?$/.test(String(jsonDocument.asset?.version || ''))) throw new Error('GLB 资源版本无效');
    const pending = [jsonDocument];
    let inspected = 0;
    while (pending.length) {
      const value = pending.pop();
      inspected += 1;
      if (inspected > 200000) throw new Error('GLB 模型结构过于复杂');
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === 'object') pending.push(item);
        continue;
      }
      for (const [key, item] of Object.entries(value)) {
        if (key.toLowerCase() === 'uri') {
          if (typeof item !== 'string') throw new Error('GLB URI 字段异常');
          if (!/^data:[^,]+;base64,[a-z0-9+/=]+$/i.test(item)) throw new Error('单文件 GLB 不允许引用外部 URI');
        }
        if (item && typeof item === 'object') pending.push(item);
      }
    }
    return jsonDocument;
  }

  function sanitizeLoginVideoReference() {
    const current = normalizeLoginVideo(state.admin.loginVideo);
    const target = current.storedName ? path.join(loginVideoDir, current.storedName) : '';
    if (!current.url || (target && fs.existsSync(target))) {
      state.admin.loginVideo = current;
    } else {
      state.admin.loginVideo = normalizeLoginVideo();
    }
    if (state.admin.loginVideo.enabled) {
      state.admin.loginMusic = normalizeLoginMusic({ ...state.admin.loginMusic, enabled: false });
    }
  }

  sanitizeLoginVideoReference();

  function removeLoginCubeFaceFiles(faceId) {
    if (!LOGIN_CUBE_FACE_IDS.includes(faceId)) return;
    for (const extension of ['png', 'jpg', 'webp', 'gif']) fs.rmSync(path.join(loginCubeDir, `${faceId}.${extension}`), { force: true });
  }

  function decodeLoginCubeImage(dataUrl) {
    const matched = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i);
    if (!matched) throw new Error('仅支持 PNG、JPG、WebP 或 GIF 图片');
    const mime = matched[1].toLowerCase();
    const buffer = Buffer.from(matched[2], 'base64');
    if (!buffer.length || buffer.length > LOGIN_CUBE_IMAGE_LIMIT_BYTES) throw new Error('立方体单面图片必须小于 2 MB');
    const valid = mime === 'image/png' ? buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : mime === 'image/jpeg' ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
        : mime === 'image/webp' ? buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
          : /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'));
    if (!valid) throw new Error('图片内容与文件格式不匹配');
    return { buffer, extension: mime === 'image/jpeg' ? 'jpg' : mime.slice(6), mime };
  }

  function updateLoginCubeFaceImage(faceId, image) {
    const current = normalizeLoginCubeSettings(state.admin.loginCube);
    const faces = current.faces.map((face) => face.id === faceId ? { ...face, image } : face);
    state.admin.loginCube = normalizeLoginCubeSettings({ ...current, faces, updatedAt: new Date().toISOString() }, current);
    persist();
    io.emit('login-cube-updated', state.admin.loginCube);
    return state.admin.loginCube;
  }
  // Move the legacy hash out of config.json on upgrade. Once version 10 is in
  // place, deleting the dedicated secrets folder is treated as a deliberate
  // first-login reset and restores the documented admin/admin888 bootstrap.
  if (!fs.existsSync(adminPasswordFile) && (!stateFileExisted || Number(state.version) < 10)) {
    atomicWriteJson(adminPasswordFile, { version: 1, passwordHash: String(state.admin.passwordHash || ''), updatedAt: new Date().toISOString() });
    try { fs.chmodSync(adminPasswordFile, 0o600); } catch (_) {}
  } else if (fs.existsSync(adminPasswordFile)) {
    try {
      const secret = JSON.parse(fs.readFileSync(adminPasswordFile, 'utf8'));
      if (secret && typeof secret.passwordHash === 'string') {
        const adminAccount = state.accounts.admin;
        const legacyClientPasswordChange = Boolean(adminAccount
          && adminAccount.mustChangePassword === false
          && state.admin.mustChangePassword === true
          && adminAccount.passwordHash
          && adminAccount.passwordHash !== secret.passwordHash);
        if (legacyClientPasswordChange) {
          state.admin.passwordHash = adminAccount.passwordHash;
          state.admin.mustChangePassword = false;
          state.admin.passwordChangedAt = adminAccount.passwordChangedAt || new Date().toISOString();
          atomicWriteJson(adminPasswordFile, { version: 1, passwordHash: String(adminAccount.passwordHash), updatedAt: state.admin.passwordChangedAt });
        } else {
          state.admin.passwordHash = secret.passwordHash;
          if (adminAccount) {
            adminAccount.passwordHash = secret.passwordHash;
            adminAccount.mustChangePassword = Boolean(state.admin.mustChangePassword);
            adminAccount.passwordChangedAt = state.admin.passwordChangedAt || adminAccount.passwordChangedAt;
          }
        }
      }
    } catch (error) { throw new Error(`超级管理员密码文件损坏：${error.message}`); }
  } else {
    const defaultAdminHash = makePasswordHash('admin888');
    state.admin.passwordHash = defaultAdminHash;
    state.admin.mustChangePassword = true;
    state.admin.passwordChangedAt = new Date().toISOString();
    if (state.accounts.admin) {
      state.accounts.admin.passwordHash = defaultAdminHash;
      state.accounts.admin.mustChangePassword = true;
      state.accounts.admin.passwordChangedAt = state.admin.passwordChangedAt;
    }
    writeAdminPasswordHash(defaultAdminHash);
    atomicWriteJson(stateFile, state);
  }
  let mailKeyCache = null;
  let mailTransportCache = null;
  const mailDeliveryJobs = new Set();
  const passwordResetCodes = new Map();
  const passwordResetTokens = new Map();
  const emailBindingCodes = new Map();
  const emailUnbindingCodes = new Map();
  const registrationEmailCodes = new Map();
  const passwordResetDigestKey = crypto.randomBytes(32);
  let verificationRecordSequence = 0;

  function verificationRecordId() {
    verificationRecordSequence = (verificationRecordSequence + 1) % 1000000;
    return `VC-${Date.now().toString(36).toUpperCase()}-${String(verificationRecordSequence).padStart(4, '0')}`;
  }

  function maskEmailAddressServer(value = '') {
    const email = cleanText(value, 254);
    const at = email.lastIndexOf('@');
    if (at <= 0) return email ? '***' : '';
    const local = email.slice(0, at); const domain = email.slice(at + 1);
    const visibleLocal = local.length <= 1 ? '*' : `${local[0]}***${local.length > 2 ? local.at(-1) : ''}`;
    const parts = domain.split('.'); const host = parts.shift() || '';
    const visibleHost = host.length <= 2 ? `${host[0] || '*'}*` : `${host[0]}***${host.at(-1)}`;
    return `${visibleLocal}@${visibleHost}${parts.length ? `.${parts.join('.')}` : ''}`;
  }

  function createVerificationRecord({ type, accountName = '', senderEmail = '', recipientEmail = '', socket, payload = {}, expiresAt = 0 }) {
    const now = new Date().toISOString();
    const record = {
      id: verificationRecordId(), type: cleanText(type, 40) || 'verification', status: 'active', accountName: cleanText(accountName, 120),
      senderEmail: cleanText(senderEmail, 254), recipientEmail: cleanText(recipientEmail, 254),
      maskedSenderEmail: maskEmailAddressServer(senderEmail), maskedEmail: maskEmailAddressServer(recipientEmail),
      requestIp: normalizeIp(getSocketIp(socket)), deviceId: cleanText(payload.deviceId || payload.device || '', 160),
      createdAt: now, sentAt: '', acceptedAt: '', usedAt: '', expiresAt: expiresAt ? new Date(expiresAt).toISOString() : '', error: ''
    };
    state.verificationCodeRecords = Array.isArray(state.verificationCodeRecords) ? state.verificationCodeRecords : [];
    state.verificationCodeRecords.push(record);
    if (state.verificationCodeRecords.length > 5000) state.verificationCodeRecords.splice(0, state.verificationCodeRecords.length - 5000);
    return record;
  }

  function updateVerificationRecord(id, patchValue = {}) {
    const record = state.verificationCodeRecords?.find((entry) => entry.id === id);
    if (!record) return;
    Object.assign(record, patchValue);
    if (record.status === 'active' && record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) record.status = 'expired';
  }

  function verificationRateAllowed(socket, type, targetKey, payload = {}) {
    const policy = normalizeVerificationCodePolicy(state.admin.verificationCodePolicy);
    if (!policy.rateLimitEnabled) return true;
    // Prefer the stable client-provided device id. When older clients omit it,
    // scope the bucket to the socket so several users behind one NAT are not
    // incorrectly blocked by one another's verification requests.
    const deviceKey = cleanText(payload.deviceId, 160) || `socket:${socket.id}`;
    const blocked = policy.blockedDevices?.[deviceKey];
    if (blocked && (!blocked.expiresAt || Date.parse(blocked.expiresAt) > Date.now())) return false;
    const windowMs = policy.windowMinutes * 60 * 1000;
    const deviceAllowed = consumeRateLimit(`verification-device:${deviceKey}`, policy.deviceLimit, windowMs);
    const targetAllowed = consumeRateLimit(`verification-target:${type}:${targetKey}`, policy.targetLimit, windowMs);
    if (deviceAllowed && targetAllowed) return true;
    state.admin.verificationCodePolicy = policy;
    state.admin.verificationCodePolicy.blockedDevices[deviceKey] = {
      reason: '验证码请求过于频繁', blockedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + windowMs).toISOString(), lastType: type
    };
    persist();
    return false;
  }

  function mailEncryptionKey(create = false) {
    if (mailKeyCache) return mailKeyCache;
    if (fs.existsSync(mailKeyFile)) {
      const decoded = Buffer.from(fs.readFileSync(mailKeyFile, 'utf8').trim(), 'base64');
      if (decoded.length !== 32) throw new Error('邮件密钥文件已损坏，请从完整的 SyncWatch同步观影-Data 备份恢复');
      mailKeyCache = decoded;
      return mailKeyCache;
    }
    if (!create) return null;
    const generatedKey = crypto.randomBytes(32);
    fs.writeFileSync(mailKeyFile, `${generatedKey.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    mailKeyCache = generatedKey;
    return mailKeyCache;
  }

  function encryptMailSecret(value) {
    const secret = String(value || '');
    if (!secret) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', mailEncryptionKey(true), iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  function decryptMailSecret(value = state.admin.mail?.encryptedAuthCode) {
    const encoded = String(value || '');
    if (!encoded) return '';
    const [version, ivValue, tagValue, ciphertextValue] = encoded.split('.');
    if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) throw new Error('邮件授权码密文格式无效');
    const key = mailEncryptionKey(false);
    if (!key) throw new Error('邮件密钥缺失，请恢复完整的 SyncWatch同步观影-Data/.secrets 目录');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()]).toString('utf8');
  }
  function roomConfig(roomIdValue = '') {
    const id = normalizeRoomId(roomIdValue) || requestContext.getStore()?.roomId || state.defaultRoomId;
    return state.rooms[id] || state.rooms[state.defaultRoomId];
  }
  function currentRoomId() { return roomConfig()?.id || state.defaultRoomId; }
  function withRoom(roomIdValue, callback) { return requestContext.run({ roomId: normalizeRoomId(roomIdValue) || state.defaultRoomId }, callback); }
  function roomChannel(roomIdValue = '') { return `syncwatch:room:${normalizeRoomId(roomIdValue) || currentRoomId()}`; }
  Object.defineProperties(state, {
    room: { configurable: true, enumerable: false, get: () => roomConfig() },
    permissions: { configurable: true, enumerable: false, get: () => roomConfig().permissions, set: (value) => { roomConfig().permissions = value; } },
    queue: { configurable: true, enumerable: false, get: () => roomConfig().queue, set: (value) => { roomConfig().queue = value; } }
  });
  state.admin.accountNumberPolicy = normalizeAccountNumberPolicy(state.admin.accountNumberPolicy);
  function claimNextAccountId(usedIds = new Set()) {
    const policy = normalizeAccountNumberPolicy(state.admin.accountNumberPolicy);
    let nextNumber = policy.nextNumber;
    let candidate = '';
    do {
      candidate = formatAccountNumber(nextNumber, policy);
      nextNumber += 1;
    } while (usedIds.has(candidate) && nextNumber <= 999999999999);
    state.admin.accountNumberPolicy = { ...policy, nextNumber };
    return candidate;
  }
  const usedAccountIds = new Set();
  for (const [username, accountValue] of Object.entries(state.accounts)) {
    const account = accountValue || {};
    let accountId = /^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(String(account.id || '').toUpperCase()) ? String(account.id).toUpperCase() : '';
    if (!accountId || usedAccountIds.has(accountId)) accountId = claimNextAccountId(usedAccountIds);
    usedAccountIds.add(accountId);
    state.accounts[username] = {
      passwordHash: account.passwordHash || account.password || '', id: accountId,
      displayName: cleanUsername(account.displayName || username) || username,
      email: cleanText(account.email, 120), emailVerified: Boolean(account.email && account.emailVerified === true), avatar: cleanText(account.avatar, 500),
      signature: cleanText(account.signature, 160), adminRemark: cleanText(account.adminRemark, 80), gender: ['male', 'female', 'other', 'private'].includes(account.gender) ? account.gender : 'private',
      age: Number.isInteger(Number(account.age)) && Number(account.age) >= 1 && Number(account.age) <= 150 ? Number(account.age) : null,
      registrationIp: normalizeIp(account.registrationIp || ''),
      createdAt: account.createdAt || new Date().toISOString(), lastLogin: account.lastLogin || '',
      passwordChangedAt: account.passwordChangedAt || account.createdAt || new Date().toISOString(),
      devices: Array.isArray(account.devices) ? account.devices : [],
      watchHistory: Array.isArray(account.watchHistory) ? account.watchHistory : [],
      favorites: Array.isArray(account.favorites) ? account.favorites : [],
      favoriteMeta: account.favoriteMeta && typeof account.favoriteMeta === 'object' ? account.favoriteMeta : {},
      mediaNotes: account.mediaNotes && typeof account.mediaNotes === 'object' ? account.mediaNotes : {},
      mediaCategories: Array.isArray(account.mediaCategories) ? account.mediaCategories : [],
      mediaProcessingDismissed: Array.isArray(account.mediaProcessingDismissed)
        ? [...new Set(account.mediaProcessingDismissed.map((id) => cleanText(id, 80)).filter(Boolean))].slice(-2000) : [],
      roomMeta: account.roomMeta && typeof account.roomMeta === 'object' ? account.roomMeta : {},
      friends: Array.isArray(account.friends) ? account.friends : [],
      friendMeta: account.friendMeta && typeof account.friendMeta === 'object' ? account.friendMeta : {},
      friendSettings: normalizeFriendSettings(account.friendSettings),
      notificationSettings: normalizeNotificationSettings({
        ...account.notificationSettings,
        conciseMode: account.viewPreferences?.conciseMode ?? account.notificationSettings?.conciseMode
      }),
      viewPreferences: normalizeViewPreferences({
        ...account.viewPreferences,
        conciseMode: account.viewPreferences?.conciseMode ?? account.notificationSettings?.conciseMode
      }),
      friendRequests: Array.isArray(account.friendRequests) ? account.friendRequests : [],
      friendBlocks: Array.isArray(account.friendBlocks) ? account.friendBlocks : [],
      friendMessages: Array.isArray(account.friendMessages) ? account.friendMessages : [],
      friendRoomRequests: retainPersistentRequests(account.friendRoomRequests).slice(-500),
      userRemarks: account.userRemarks && typeof account.userRemarks === 'object' && !Array.isArray(account.userRemarks) ? account.userRemarks : {},
      loginHistory: Array.isArray(account.loginHistory) ? account.loginHistory : [],
      stats: { joinedRooms: 0, createdRooms: 0, watchSeconds: 0, onlineSeconds: 0, ...(account.stats || {}) },
      experience: Math.max(0, Math.floor(Number(account.experience) || Math.floor((Number(account.stats?.watchSeconds) || 0) / 60))),
      experienceRemainderSeconds: Math.max(0, Math.min(59.999, Number(account.experienceRemainderSeconds) || 0)),
      levelOverride: Number.isInteger(Number(account.levelOverride)) ? Math.max(1, Math.min(WATCH_LEVELS.length, Number(account.levelOverride))) : null,
      superAdmin: username === 'admin' || Boolean(account.superAdmin),
      mustChangePassword: username === 'admin'
        ? account.mustChangePassword !== false
        : (Boolean(account.superAdmin) ? false : Boolean(account.mustChangePassword)),
      roomCreationBlocked: Boolean(account.roomCreationBlocked),
      roomQuota: username === 'admin' || account.superAdmin ? 0 : Math.max(1, Math.min(9999, Math.floor(Number(account.roomQuota) || 1))),
      recentRooms: Array.isArray(account.recentRooms) ? account.recentRooms.map(normalizeRoomId).filter(Boolean).slice(0, 20) : [],
      pinnedRooms: Array.isArray(account.pinnedRooms) ? account.pinnedRooms.map(normalizeRoomId).filter(Boolean) : [],
      roomVisitCounts: account.roomVisitCounts && typeof account.roomVisitCounts === 'object' && !Array.isArray(account.roomVisitCounts) ? account.roomVisitCounts : {},
      roomAccessGrants: account.roomAccessGrants && typeof account.roomAccessGrants === 'object' && !Array.isArray(account.roomAccessGrants)
        ? Object.fromEntries(Object.entries(account.roomAccessGrants).map(([id, revision]) => [normalizeRoomId(id), Math.max(1, Math.floor(Number(revision) || 0))]).filter(([id, revision]) => id && revision)) : {},
      pendingNotifications: Array.isArray(account.pendingNotifications) ? account.pendingNotifications : [],
      acceptedAgreementVersion: cleanText(account.acceptedAgreementVersion, 40),
      multiDeviceLogin: username === 'admin' ? Number(state.admin.adminMaxConcurrentSessions) > 1 : Boolean(account.multiDeviceLogin),
      tierId: username === 'admin' || account.superAdmin ? 's_node' : (state.admin.accountTiers?.[account.tierId] ? account.tierId : 'basic'),
      guest: Boolean(account.guest), loginSessionLimit: account.loginSessionLimit
    };
  }
  // A missing/inaccessible upload can be a temporary mount, permission, or
  // storage outage. Keep safe metadata and queue references so restoring the
  // file makes it usable again without rebuilding the library index.
  state.files = state.files.filter((file) => file && (safeStoredName(file.storedName)
    || (file.sourceType === 'remote' && /^https:\/\/[^\s]+$/i.test(String(file.sourceUrl || '')))));
  for (const room of Object.values(state.rooms)) {
    room.queue = room.queue.filter((id) => state.files.some((file) => file.id === id && file.roomId === room.id && file.status === 'approved' && ['video', 'audio'].includes(file.category)));
    room.queueFileModes = Object.fromEntries(Object.entries(room.queueFileModes || {})
      .filter(([id]) => room.queue.includes(id))
      .map(([id, mode]) => [id, normalizePlaybackMode(mode)]));
  }
  normalizeStoredTrashArtifacts();
  cleanupTrash(false);
  atomicWriteJson(stateFile, state);

  const chatMessages = [];
  const chatRoomWindowCounts = new Map();
  const chatParticipants = new Set();
  function rememberChatMessage(message) {
    if (!message?.id) return;
    chatMessages.push(message);
    if (message.from) chatParticipants.add(message.from);
    if (message.to) chatParticipants.add(message.to);
    const count = (chatRoomWindowCounts.get(message.roomId) || 0) + 1;
    chatRoomWindowCounts.set(message.roomId, count);
    if (count <= CHAT_ROOM_MEMORY_LIMIT) return;
    const oldest = chatMessages.findIndex((entry) => entry.roomId === message.roomId);
    if (oldest >= 0) chatMessages.splice(oldest, 1);
    chatRoomWindowCounts.set(message.roomId, CHAT_ROOM_MEMORY_LIMIT);
  }
  if (fs.existsSync(chatFile)) {
    const input = fs.createReadStream(chatFile, { encoding: 'utf8' });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        message.roomId = normalizeRoomId(message.roomId) && state.rooms[normalizeRoomId(message.roomId)] ? normalizeRoomId(message.roomId) : state.defaultRoomId;
        rememberChatMessage(message);
      } catch (_) {}
    }
  }

  const app = express();
  const httpServer = http.createServer(app);
  httpServer.requestTimeout = HARD_REQUEST_TIMEOUT_MS;
  const io = new SocketIOServer(httpServer, {
    maxHttpBufferSize: 4 * 1024 * 1024, pingTimeout: 120000, pingInterval: 20000,
    allowRequest(req, callback) {
      Promise.resolve(socketRequestAllowed(req)).then((allowed) => {
        callback(allowed ? null : '不允许跨站连接', allowed);
      }).catch(() => callback('不允许跨站连接', false));
    }
  });
  function advertisedNetworkAddresses() {
    return lanAddress ? [`http://${lanAddress}:${actualPort}`] : networkAddresses(actualPort);
  }
  const users = new Map();
  const sessions = new Map();
  const guestSessionsByIp = new Map();
  const guestSessionRecords = new Map();
  const rateBuckets = new Map();
  const aiConfigSyncRequests = new Map();
  const qualityChangeRequests = new Map();
  const registrationClaims = new Set();
  // A successfully verified registration grants one short-lived follow-up
  // registration on the same socket, so email verification is useful even
  // when the legacy per-IP quota would otherwise block the next account.
  const verifiedRegistrationAllowances = new Map();
  const roomCreateClaims = new Set();
  const roomTransferClaims = new Set();
  let qualityBroadcastTimer = null;
  const qualityBroadcastRooms = new Set();
  let closing = false;
  let acceptingMutations = true;
  let closePromise = null;
  let discoverySocket = null;
  const activeHttpMutations = new Set();
  const activeHttpRequests = new Set();
  const activeSocketHandlers = new Set();
  const activeMediaResponseStreams = new Map();
  const roomRuntimes = new Map();
  function normalizeTextReadingState(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const rawCharacterOffset = source.characterOffset ?? source.anchorOffset;
    const hasCharacterOffset = rawCharacterOffset !== undefined && rawCharacterOffset !== null && String(rawCharacterOffset).trim() !== '';
    const numericCharacterOffset = Number(rawCharacterOffset);
    const characterOffset = hasCharacterOffset && Number.isSafeInteger(numericCharacterOffset) && numericCharacterOffset >= 0
      ? Math.min(50_000_000, numericCharacterOffset) : null;
    return {
      fileId: cleanText(source.fileId, 80), position: Math.max(0, Math.min(1, Number(source.position) || 0)),
      page: Math.max(1, Math.min(1000000, Math.floor(Number(source.page) || 1))),
      characterOffset,
      updatedAt: Math.max(0, Number(source.updatedAt) || Date.now()), changedBy: cleanUsername(source.changedBy),
      revision: Math.max(0, Math.floor(Number(source.revision) || 0))
    };
  }
  function createRoomRuntime(roomIdValue = '') {
    const saved = roomConfig(roomIdValue)?.savedState || {};
    const savedPlayback = saved.playback && typeof saved.playback === 'object' ? saved.playback : {};
    const savedWebShare = saved.webShare && typeof saved.webShare === 'object' ? saved.webShare : {};
    const savedWebUrl = normalizeSharedWebUrl(savedWebShare.url);
    return {
      roomState: {
        lightsOn: Boolean(saved.lightsOn),
        playback: {
          fileId: cleanText(savedPlayback.fileId, 80) || null, isPlaying: false, stalled: false,
          currentTime: Math.max(0, Number(savedPlayback.currentTime) || 0), volume: Math.max(0, Math.min(1, Number(savedPlayback.volume ?? 1))),
          muted: Boolean(savedPlayback.muted), playbackRate: Math.max(0.5, Math.min(3, Number(savedPlayback.playbackRate ?? savedPlayback.rate ?? 1) || 1)),
          updatedAt: Date.now(), changedBy: cleanUsername(savedPlayback.changedBy) || null, revision: Math.max(0, Number(savedPlayback.revision) || 0)
        },
        textReading: normalizeTextReadingState(saved.textReading),
        screenShare: { active: false, socketId: null, username: null },
        audioShare: { active: false, socketId: null, username: null, displayName: '', platform: 'system', sourceName: '', processName: '', mediaTitle: '', sourceKind: '', volume: 0.8 },
        webShare: {
          active: savedWebShare.active === true && Boolean(savedWebUrl), mode: savedWebShare.mode === 'live' ? 'live' : 'url', url: savedWebUrl,
          title: cleanText(savedWebShare.title || '共享网页', 120), changedBy: cleanUsername(savedWebShare.changedBy),
          updatedAt: Math.max(0, Number(savedWebShare.updatedAt) || 0), revision: Math.max(0, Math.floor(Number(savedWebShare.revision) || 0))
        }
      },
      playbackChanges: [], playbackGeneration: 0, latestScreenFrame: null, screenFrameSequence: 0,
      screenFrameGeneration: 0, screenFrameDeliveries: new Map(), screenWebrtcViewers: new Set(), playbackRequests: [], playbackRequestSuppressions: new Map(), controlRequests: [], themeSyncRequests: []
    };
  }
  function roomRuntime(roomIdValue = '') {
    const id = normalizeRoomId(roomIdValue) || currentRoomId();
    if (!roomRuntimes.has(id)) roomRuntimes.set(id, createRoomRuntime(id));
    return roomRuntimes.get(id);
  }
  const roomState = new Proxy({}, {
    get: (_, key) => roomRuntime().roomState[key],
    set: (_, key, value) => { roomRuntime().roomState[key] = value; return true; }
  });
  const playbackChanges = new Proxy([], {
    get: (_, key) => roomRuntime().playbackChanges[key],
    set: (_, key, value) => { roomRuntime().playbackChanges[key] = value; return true; }
  });
  const disconnectTimers = new Map();
  const emptyRoomTimers = new Map();
  const pendingVoiceCalls = new Map();
  let persistTimer = null;
  let chatFlushTimer = null;
  let pendingChatLines = [];
  let chatWriteChain = Promise.resolve();
  let analysisClosing = false;
  const mediaAnalysisQueue = [];
  const mediaAnalysisJobs = new Set();
  const mediaAnalysisProcesses = new Set();
  const mediaCompatibilityQueue = [];
  const mediaCompatibilityJobs = new Set();
  const mediaCompatibilityProcesses = new Set();
  const cancelledMediaRecords = new WeakSet();

  function mediaCompatibilityAutoConvert() {
    return state.admin.mediaCompatibilityAutoConvert !== false;
  }

  function mediaCompatibilityConcurrency() {
    const value = Math.floor(Number(state.admin.mediaCompatibilityConcurrency) || DEFAULT_MEDIA_COMPATIBILITY_CONCURRENCY);
    return Math.max(1, Math.min(MAX_MEDIA_COMPATIBILITY_CONCURRENCY, value));
  }

  function snapshotRoomRuntime(roomIdValue) {
    const id = normalizeRoomId(roomIdValue);
    const room = id && state.rooms[id];
    const runtime = id && roomRuntimes.get(id);
    if (!room || !runtime) return;
    const playback = playbackSnapshot(id);
    room.savedState = {
      lightsOn: Boolean(runtime.roomState.lightsOn),
      playback: {
        fileId: playback.fileId || null, isPlaying: false, stalled: false,
        currentTime: Math.max(0, Number(playback.currentTime) || 0), volume: Math.max(0, Math.min(1, Number(playback.volume ?? 1))),
        muted: Boolean(playback.muted), playbackRate: Math.max(0.5, Math.min(3, Number(playback.playbackRate ?? playback.rate ?? 1) || 1)),
        changedBy: cleanUsername(playback.changedBy) || null, revision: Math.max(0, Number(playback.revision) || 0)
      },
      textReading: normalizeTextReadingState(runtime.roomState.textReading),
      webShare: {
        active: runtime.roomState.webShare.active === true, mode: runtime.roomState.webShare.mode === 'live' ? 'live' : 'url', url: normalizeSharedWebUrl(runtime.roomState.webShare.url),
        title: cleanText(runtime.roomState.webShare.title, 120), changedBy: cleanUsername(runtime.roomState.webShare.changedBy),
        updatedAt: Math.max(0, Number(runtime.roomState.webShare.updatedAt) || 0), revision: Math.max(0, Math.floor(Number(runtime.roomState.webShare.revision) || 0))
      },
      savedAt: new Date().toISOString()
    };
  }

  function snapshotAllRoomRuntimes() {
    for (const id of roomRuntimes.keys()) snapshotRoomRuntime(id);
  }

  function cancelEmptyRoomClose(roomIdValue) {
    const id = normalizeRoomId(roomIdValue);
    if (!id) return;
    clearTimeout(emptyRoomTimers.get(id));
    emptyRoomTimers.delete(id);
  }

  function markRoomActive(roomIdValue) {
    const id = normalizeRoomId(roomIdValue);
    const room = id && state.rooms[id];
    if (!room) return;
    cancelEmptyRoomClose(id);
    const runtime = roomRuntime(id);
    if (room.closed) {
      room.closed = false;
      room.closedAt = '';
      if (room.resumeOnOpen && runtime.roomState.playback.fileId) {
        runtime.roomState.playback = {
          ...runtime.roomState.playback, isPlaying: true, stalled: false, updatedAt: Date.now(),
          revision: runtime.roomState.playback.revision + 1
        };
      }
      room.resumeOnOpen = false;
    }
    room.lastActivityAt = new Date().toISOString();
  }

  function scheduleEmptyRoomClose(roomIdValue) {
    const id = normalizeRoomId(roomIdValue);
    const room = id && state.rooms[id];
    if (!room || roomUsers(id).length || emptyRoomTimers.has(id)) return;
    const timer = setTimeout(() => {
      emptyRoomTimers.delete(id);
      if (!state.rooms[id] || roomUsers(id).length) return;
      const runtime = roomRuntime(id);
      const playback = playbackSnapshot(id);
      room.resumeOnOpen = Boolean(playback.fileId);
      runtime.roomState.playback = {
        ...runtime.roomState.playback, currentTime: playback.currentTime, isPlaying: false, stalled: false,
        updatedAt: Date.now(), revision: runtime.roomState.playback.revision + 1
      };
      room.closed = true;
      room.closedAt = new Date().toISOString();
      room.lastActivityAt = room.closedAt;
      snapshotRoomRuntime(id);
      persist();
    }, roomEmptyCloseMs);
    timer.unref?.();
    emptyRoomTimers.set(id, timer);
  }

  function visibleRoom(room) {
    return Boolean(room && !room.temporary && !room.systemRoom);
  }

  function discoverableRoom(room) {
    return Boolean(room && !room.archived && !room.banned);
  }

  function guestsDisallowed(username, room) {
    return Boolean(state.accounts[cleanUsername(username)]?.guest && room?.allowGuests === false);
  }

  function createTemporaryRoom(username) {
    let id;
    do { id = roomId(); } while (state.rooms[id]);
    const displayName = state.accounts[username]?.displayName || username || '超级管理员';
    const room = freshRoom(id, username, {
      name: `${displayName} 的临时房间`, maxUsers: 100, createdBy: username, temporary: true
    });
    state.rooms[id] = room;
    return room;
  }

  function createGuestTemporaryRoom(username) {
    const room = createTemporaryRoom(username);
    room.ownerUsername = '';
    room.memberGroups[username] = 'member';
    return room;
  }

  async function deleteTemporaryRoomIfEmpty(roomIdValue) {
    const id = normalizeRoomId(roomIdValue);
    const room = id && state.rooms[id];
    if (!room?.temporary || roomUsers(id).length) return false;
    const result = await dissolveRoom(id, room.ownerUsername, false, { force: true, temporaryCleanup: true });
    return Boolean(result.success);
  }

  function broadcastRoomNotice(roomIdValue, message, details = {}) {
    const id = normalizeRoomId(roomIdValue) || currentRoomId();
    const notice = {
      id: crypto.randomUUID(), roomId: id, message: cleanText(message, 240),
      kind: cleanText(details.kind || 'room', 40), actor: cleanUsername(details.actor),
      important: Boolean(details.important), timestamp: Date.now(), ...details
    };
    for (const member of roomUsers(id)) {
      const concise = normalizeViewPreferences(state.accounts[member.username]?.viewPreferences).conciseMode;
      if (concise && !['member-join', 'member-leave', 'playback-seek'].includes(notice.kind)) continue;
      io.to(member.socketId).emit('system-notification', notice);
    }
    return notice;
  }

  function broadcastMediaMutation(roomIdValue, operation, file, action) {
    const id = normalizeRoomId(roomIdValue) || currentRoomId();
    const actorName = state.accounts[operation?.actor]?.displayName || operation?.actor || '成员';
    const operatedAt = operation?.createdAt || new Date().toISOString();
    const verb = action === 'delete' ? '删除了' : '上传了';
    const notice = {
      id: crypto.randomUUID(), roomId: id, action, operationId: operation?.id || '',
      actor: operation?.actor || '', actorName, fileId: file?.id || '', fileName: file?.originalName || '未命名文件',
      operatedAt, message: `${actorName} 于 ${formatLocalDateTime(operatedAt)} ${verb}《${file?.originalName || '未命名文件'}》`
    };
    for (const member of roomUsers(id)) {
      if (normalizeViewPreferences(state.accounts[member.username]?.viewPreferences).conciseMode) continue;
      io.to(member.socketId).emit('media-mutation-notice', { ...notice, canUndo: canUndoRoomOperation(member, operation) });
    }
    const historyMessage = {
      id: crypto.randomUUID(), roomId: id, type: 'system', from: 'system', fromName: '房间动态',
      to: null, toName: null, text: notice.message, channel: 'public', timestamp: operatedAt,
      systemKind: action === 'delete' ? 'media-delete' : 'media-upload', actor: notice.actor, actorName,
      fileId: notice.fileId, fileName: notice.fileName, mediaAction: action
    };
    appendMessage(historyMessage);
    emitMessage(historyMessage);
    return notice;
  }

  function broadcastMemberPresence(roomIdValue, user, action, details = {}) {
    const id = normalizeRoomId(roomIdValue || user?.roomId);
    const username = cleanUsername(user?.username);
    if (!id || !username || !state.rooms[id]) return null;
    const timestampValue = Number(details.timestamp);
    const timestamp = Number.isFinite(timestampValue) ? timestampValue : Date.now();
    const occurredAt = new Date(timestamp).toISOString();
    const timeText = formatLocalDateTime(timestamp);
    const room = roomConfig(id);
    const actorName = state.accounts[username]?.displayName || username;
    const serverHost = Boolean(sessions.get(user?.sessionToken)?.isServerHost);
    const role = isSuperAdmin(username) ? 'super-admin'
      : username === room.ownerUsername ? 'owner'
        : serverHost ? 'server-host'
          : isRoomAdmin({ ...user, roomId: id }) ? 'administrator' : 'member';
    const roleName = role === 'super-admin' ? '超级管理员 '
      : role === 'server-host' ? '服务器主机 '
        : role === 'owner' ? '房主 '
          : role === 'administrator' ? '管理员 ' : '';
    const joined = action === 'join';
    const notice = broadcastRoomNotice(id, `${roleName}${actorName} 于 ${timeText} ${joined ? '进入' : '退出'}房间`, {
      kind: joined ? 'member-join' : 'member-leave', actor: username, actorName, role,
      important: Boolean(details.important || role !== 'member'),
      event: joined ? 'join' : 'leave', reason: cleanText(details.reason, 40),
      occurredAt, timeText, timestamp,
      previousRoomId: normalizeRoomId(details.previousRoomId),
      targetRoomId: normalizeRoomId(details.targetRoomId)
    });
    const historyMessage = {
      id: crypto.randomUUID(), roomId: id, type: 'system', from: 'system', fromName: '房间动态',
      to: null, toName: null, text: notice.message, channel: 'public', timestamp: occurredAt,
      systemKind: notice.kind, actor: username, actorName, role, reason: notice.reason
    };
    appendMessage(historyMessage);
    emitMessage(historyMessage);
    return notice;
  }

  function accountOnlineMembers(username, exceptSocketId = '') {
    const normalized = cleanUsername(username);
    return [...users.values()].filter((member) => member.username === normalized
      && member.socketId !== exceptSocketId && member.connectionState !== 'offline'
      && io.sockets.sockets.get(member.socketId)?.connected !== false);
  }

  function clientModeRequestPayload(entry) {
    const modeLabels = {
      'notifications-off': '关闭普通通知',
      concise: '进入简洁模式',
      professional: '进入专业模式'
    };
    return {
      id: cleanText(entry?.id, 80), batchId: cleanText(entry?.batchId, 80),
      username: cleanUsername(entry?.username), mode: entry?.mode,
      modeLabel: modeLabels[entry?.mode] || '切换客户端模式',
      scope: entry?.scope || 'users', roomId: normalizeRoomId(entry?.roomId),
      requestedBy: cleanUsername(entry?.requestedBy),
      requestedByName: cleanText(entry?.requestedByName, 60),
      reason: cleanText(entry?.reason, 240), status: entry?.status || 'pending',
      createdAt: cleanText(entry?.createdAt, 60), resolvedAt: cleanText(entry?.resolvedAt, 60),
      resolvedBy: cleanUsername(entry?.resolvedBy)
    };
  }

  function emitPendingClientModeRequests(socket, username) {
    if (!socket?.connected || !agreementAccepted(username)) return;
    for (const entry of state.admin.clientModeRequests || []) {
      if (entry.status !== 'pending' || entry.username !== cleanUsername(username)) continue;
      socket.emit('client-mode-requested', clientModeRequestPayload(entry));
    }
  }

  function applyClientModeRequest(account, mode) {
    const currentView = normalizeViewPreferences(account.viewPreferences);
    const currentNotifications = normalizeNotificationSettings(account.notificationSettings);
    const conciseMode = mode === 'concise';
    account.viewPreferences = normalizeViewPreferences({ ...currentView, conciseMode });
    account.notificationSettings = normalizeNotificationSettings({
      ...currentNotifications,
      conciseMode,
      allNotifications: mode === 'notifications-off' ? false : true
    });
    if (conciseMode) account.pendingNotifications = [];
    return {
      viewPreferences: account.viewPreferences,
      notificationSettings: account.notificationSettings
    };
  }

  function accountIsOnline(username, exceptSocketId = '') {
    return accountOnlineMembers(username, exceptSocketId).length > 0;
  }

  function broadcastAccountPresence(username, online, { announceOnline = false } = {}) {
    const normalized = cleanUsername(username);
    const account = state.accounts[normalized];
    if (!account) return;
    const activeMembers = accountOnlineMembers(normalized);
    const payload = {
      username: normalized,
      displayName: account.displayName || normalized,
      avatar: account.avatar || '',
      online: Boolean(online),
      onlineSessions: activeMembers.length,
      roomId: activeMembers[0]?.roomId || '',
      changedAt: new Date().toISOString()
    };
    for (const member of users.values()) {
      if (member.username === normalized) continue;
      const viewerAccount = state.accounts[member.username];
      const viewerSession = sessions.get(member.sessionToken);
      const isFriend = Array.isArray(viewerAccount?.friends) && viewerAccount.friends.includes(normalized);
      const canManageAccounts = Boolean(viewerAccount?.superAdmin || viewerSession?.isServerHost);
      if (isFriend || canManageAccounts) io.to(member.socketId).emit('account-presence-changed', payload);
      if (announceOnline && online && isFriend
        && !normalizeViewPreferences(viewerAccount?.viewPreferences).conciseMode) io.to(member.socketId).emit('friend-online', {
        ...payload,
        message: `${account.displayName || normalized} 已上线`
      });
    }
  }

  function accountChangeNotice(username, notice, eventName = '', eventPayload = null) {
    const account = state.accounts[cleanUsername(username)];
    if (!account) return false;
    const notificationSettings = normalizeNotificationSettings(account.notificationSettings);
    const noticeKind = cleanText(notice?.kind || 'account', 40);
    const adminOnlyKinds = new Set(['location-status', 'member-location-status', 'device-location', 'system-location']);
    if (adminOnlyKinds.has(noticeKind) && cleanUsername(username) !== 'admin') return false;
    if (normalizeViewPreferences(account.viewPreferences).conciseMode
      && !['member-join', 'member-leave', 'playback-seek'].includes(noticeKind)) return false;
    const importantNotice = notice?.important === true
      || notice?.requiresAction === true
      || ['friend-message', 'friend-request', 'friend-room-request', 'location-authorization-request', 'playback-request', 'room-password-required', 'upload-review', 'room-quota-request', 'room-dissolved'].includes(noticeKind);
    if (!notificationSettings.allNotifications && !importantNotice) return false;
    if (noticeKind === 'account-registration' && !notificationSettings.registrationNotices) return false;
    const normalized = {
      id: crypto.randomUUID(), kind: noticeKind,
      message: cleanText(notice?.message || '账号权限已更新', 240),
      roomId: normalizeRoomId(notice?.roomId), actor: cleanUsername(notice?.actor),
      actorName: cleanText(notice?.actorName, 60), changed: Array.isArray(notice?.changed) ? notice.changed.map((item) => cleanText(item, 40)).filter(Boolean).slice(0, 40) : [],
      createdAt: new Date().toISOString(), ...notice
    };
    const liveMembers = accountOnlineMembers(username);
    if (liveMembers.length) {
      if (eventName) for (const member of liveMembers) io.to(member.socketId).emit(eventName,
        typeof eventPayload === 'function' ? eventPayload(member, normalized) : (eventPayload || normalized));
      else for (const member of liveMembers) io.to(member.socketId).emit('account-notification', normalized);
      return true;
    }
    account.pendingNotifications = Array.isArray(account.pendingNotifications) ? account.pendingNotifications : [];
    account.pendingNotifications.push(normalized);
    account.pendingNotifications = account.pendingNotifications.slice(-100);
    persist();
    return false;
  }

  async function renameRoomIdForAdmin(oldRoomId, newRoomId, actor, noticeKind = 'room-id-changed') {
    const oldId = normalizeRoomId(oldRoomId);
    const newId = normalizeRoomId(newRoomId);
    const targetRoom = oldId && state.rooms[oldId];
    if (!targetRoom) return { success: false, error: '房间不存在' };
    if (!newId || !/^[A-Z0-9]{4,32}$/.test(newId)) return { success: false, error: '房间号需为 4-32 位大写字母或数字' };
    if (oldId === newId) return { success: true, oldRoomId: oldId, newRoomId: newId, room: roomSnapshot(oldId), message: '房间号未发生变化' };
    if (state.rooms[newId]) return { success: false, error: '新的房间号已存在，无法修改' };
    const actorName = state.accounts[actor]?.displayName || actor || '服务器管理员';
    broadcastRoomNotice(oldId, `${actorName} 将房间号从 ${oldId} 修改为 ${newId}`, {
      kind: noticeKind, actor, actorName, important: true, oldRoomId: oldId, newRoomId: newId
    });
    const oldDefaultRoomId = state.defaultRoomId;
    targetRoom.id = newId;
    state.rooms[newId] = targetRoom;
    delete state.rooms[oldId];
    if (state.defaultRoomId === oldId) state.defaultRoomId = newId;
    for (const file of state.files) if (file.roomId === oldId) file.roomId = newId;
    for (const operation of state.operations) if (operation.roomId === oldId) operation.roomId = newId;
    for (const entry of state.serverLogs || []) if (entry.roomId === oldId) entry.roomId = newId;
    for (const account of Object.values(state.accounts)) {
      if (Array.isArray(account.recentRooms)) account.recentRooms = account.recentRooms.map((id) => id === oldId ? newId : id);
      if (Array.isArray(account.pinnedRooms)) account.pinnedRooms = account.pinnedRooms.map((id) => id === oldId ? newId : id);
      if (account.roomAccessGrants && Object.prototype.hasOwnProperty.call(account.roomAccessGrants, oldId)) {
        account.roomAccessGrants[newId] = account.roomAccessGrants[oldId];
        delete account.roomAccessGrants[oldId];
      }
      if (Array.isArray(account.watchHistory)) for (const item of account.watchHistory) if (item.roomId === oldId) item.roomId = newId;
    }
    for (const message of chatMessages) if (message.roomId === oldId) message.roomId = newId;
    for (const sessionEntry of sessions.values()) if (sessionEntry.roomId === oldId) sessionEntry.roomId = newId;
    const runtime = roomRuntimes.get(oldId);
    if (runtime) { roomRuntimes.delete(oldId); roomRuntimes.set(newId, runtime); }
    for (const member of users.values()) {
      if (member.roomId !== oldId) continue;
      member.roomId = newId;
      const targetSocket = io.sockets.sockets.get(member.socketId);
      targetSocket?.leave(roomChannel(oldId));
      targetSocket?.join(roomChannel(newId));
      targetSocket?.emit('room-id-changed', { oldRoomId: oldId, newRoomId: newId, room: roomSnapshot(newId) });
    }
    await mutateStoredChatMessages((messages) => {
      for (const message of messages) if (message.roomId === oldId) message.roomId = newId;
    });
    if (oldDefaultRoomId === oldId) state.admin.accessPasswordHash = targetRoom.passwordHash || '';
    targetRoom.lastActivityAt = new Date().toISOString();
    persist();
    recordOperation({ roomId: newId, actor, action: 'room-force-rename-id', summary: `强制修改房间号：${oldId} → ${newId}`, scope: 'server' });
    io.to(roomChannel(newId)).emit('users-list', usersList(newId));
    return { success: true, oldRoomId: oldId, newRoomId: newId, room: roomSnapshot(newId), message: `房间号已从 ${oldId} 修改为 ${newId}` };
  }

  function voicePeersFor(user) {
    if (!user?.voiceMode) return [];
    if (user.voiceMode === 'private') {
      const peer = users.get(user.voicePeerSocketId);
      return peer && peer.voiceMode === 'private' && peer.voicePeerSocketId === user.socketId ? [peer] : [];
    }
    return roomUsers(user.roomId).filter((peer) => peer.socketId !== user.socketId && peer.voiceMode === 'room');
  }

  function leaveLiveVoice(user, reason = 'left') {
    if (!user?.voiceMode) return;
    const peers = voicePeersFor(user);
    user.voiceMode = '';
    user.voicePeerSocketId = '';
    for (const peer of peers) {
      if (peer.voiceMode === 'private') {
        peer.voiceMode = '';
        peer.voicePeerSocketId = '';
      }
      io.to(peer.socketId).emit('voice-peer-left', { socketId: user.socketId, reason });
    }
    if (user.roomId && state.rooms[user.roomId]) io.to(roomChannel(user.roomId)).emit('users-list', usersList(user.roomId));
  }

  function persist() {
    // close() performs one final atomic snapshot before releasing the data
    // directory lock.  Background ffprobe/ffmpeg completions must never write
    // after shutdown has begun, otherwise an old instance can overwrite a new
    // instance that has already acquired the same directory.
    if (closing) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    snapshotAllRoomRuntimes();
    atomicWriteJson(stateFile, state);
  }
  function schedulePersist(delayMs = 1000) {
    if (persistTimer || closing) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try { snapshotAllRoomRuntimes(); atomicWriteJson(stateFile, state); }
      catch (error) { console.error('延迟保存配置失败:', error.message); }
    }, delayMs);
    persistTimer.unref?.();
  }
  const findFile = (id) => state.files.find((file) => file.id === id);
  function mediaFileAvailability(file) {
    if (file?.sourceType === 'remote' && /^https:\/\/[^\s]+$/i.test(String(file.sourceUrl || ''))) {
      return { available: true, remote: true, target: '', url: String(file.sourceUrl) };
    }
    if (!file || !safeStoredName(file.storedName)) return { available: false, target: '', reason: 'INVALID_NAME' };
    const target = path.join(uploadsDir, file.storedName);
    try {
      const stats = fs.statSync(target);
      return stats.isFile() ? { available: true, target } : { available: false, target, reason: 'NOT_A_FILE' };
    } catch (error) {
      return { available: false, target, reason: error?.code || 'UNAVAILABLE' };
    }
  }
  function unavailableMediaResult(file) {
    return {
      success: false, code: 'MEDIA_FILE_UNAVAILABLE', temporary: true,
      error: `媒体文件“${cleanText(file?.originalName, 180) || '未命名文件'}”当前无法从服务器存储读取，请检查磁盘、挂载或目录权限后重试`
    };
  }
  function sendUnavailableMedia(res, file) {
    return res.status(404).json(unavailableMediaResult(file));
  }
  function handleMediaSendError(error, res, file) {
    if (!error) return;
    if (res.headersSent) { res.destroy(error); return; }
    for (const header of ['Accept-Ranges', 'Content-Range', 'Content-Length', 'Content-Type', 'Last-Modified']) {
      res.removeHeader(header);
    }
    if (['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR'].includes(error.code)) {
      sendUnavailableMedia(res, file);
      return;
    }
    res.status(error.statusCode || 500).json({ success: false, error: '读取媒体文件失败，请稍后重试' });
  }
  function serveMediaRange(req, res, target, mimeType) {
    let stats;
    try { stats = fs.statSync(target); } catch (_) { return res.status(404).end(); }
    const total = Number(stats.size);
    // Keep the detected/container MIME for every host, including HTTPS tunnel
    // origins. Browsers use this value to decide whether a <video> resource is
    // playable; application/octet-stream plus nosniff makes valid MP4 files
    // fail before the Range body is decoded.
    const responseMime = mimeType;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', responseMime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Byte offsets must refer to the stored file even when the response passes
    // through Cloudflare or another reverse proxy.  Explicitly disabling
    // transformations prevents intermediary compression from invalidating
    // Content-Range and Content-Length.
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, no-transform');
    // Tell Nginx-compatible reverse proxies to relay media as it streams. The
    // response is already excluded from Express compression, so an explicit
    // `Content-Encoding: identity` is unnecessary and confuses some NAT
    // forwarding implementations that only understand compressed codings.
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Last-Modified', stats.mtime.toUTCString());
    res.vary('Cookie'); res.vary('Authorization');
    const mediaStreamKey = req.syncWatchToken ? `${req.syncWatchToken}:${target}` : '';
    const trackedStreams = mediaStreamKey ? activeMediaResponseStreams.get(mediaStreamKey) : null;
    if (req.method !== 'HEAD' && trackedStreams instanceof Set
      && trackedStreams.size >= MAX_MEDIA_STREAMS_PER_SESSION_FILE) {
      res.statusCode = 503;
      res.setHeader('Retry-After', '1');
      res.setHeader('Content-Length', '0');
      return res.end();
    }
    const rangeHeader = String(req.headers.range || '').trim();
    if (!rangeHeader) {
      res.statusCode = 200; res.setHeader('Content-Length', total);
      if (req.method === 'HEAD') return res.end();
      // Keep headers uncommitted until the file descriptor opens. If the
      // storage mount disappears between stat() and createReadStream(), the
      // handler can then return a useful HTTP error instead of resetting TCP.
      return pipeMediaFileResponse(req, res, target, {},
        (error) => handleMediaSendError(error, res, { originalName: path.basename(target) }),
        { tracker: activeMediaResponseStreams, key: mediaStreamKey });
    }
    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader);
    if (!match || total <= 0) { res.status(416).setHeader('Content-Range', `bytes */${total}`); return res.end(); }
    const suffixRange = !match[1] && Boolean(match[2]);
    let start = suffixRange ? Math.max(0, total - Number(match[2])) : (match[1] ? Number(match[1]) : 0);
    let end = suffixRange ? total - 1 : (match[2] ? Number(match[2]) : total - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= total) {
      res.status(416).setHeader('Content-Range', `bytes */${total}`); return res.end();
    }
    const openEnded = Boolean(match[1] && !match[2]);
    if (openEnded && total >= OPEN_ENDED_MEDIA_RANGE_CHUNK_THRESHOLD_BYTES && total - start > MAX_OPEN_ENDED_MEDIA_RANGE_BYTES) {
      end = start + MAX_OPEN_ENDED_MEDIA_RANGE_BYTES - 1;
    }
    end = clampMediaRangeEnd(start, end, total, openEnded);
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    return pipeMediaFileResponse(req, res, target, { start, end },
      (error) => handleMediaSendError(error, res, { originalName: path.basename(target) }),
      { tracker: activeMediaResponseStreams, key: mediaStreamKey });
  }
  function serveFileDownload(req, res, target, filename, mimeType = '') {
    res.setHeader('Content-Disposition', attachmentContentDisposition(filename));
    return serveMediaRange(req, res, target, mimeType || downloadMimeType(filename));
  }
  const isPlayableFile = (file) => Boolean(file && file.status === 'approved' && ['video', 'audio'].includes(file.category));
  const isSelectableFile = (file) => Boolean(file && file.status === 'approved'
    && (isPlayableFile(file) || STATIC_PREVIEW_CATEGORIES.has(file.category)));
  function compatibilityFileName(file) {
    const saved = path.basename(String(file?.compatibility?.fileName || ''));
    if (/^[a-f0-9-]{16,80}\.mp4$/i.test(saved)) return saved;
    const digest = crypto.createHash('sha256').update(String(file?.id || file?.storedName || '')).digest('hex').slice(0, 32);
    return `${digest}.mp4`;
  }
  function mediaSourceSnapshot(file) {
    if (!file || !safeStoredName(file.storedName)) return null;
    try {
      const stats = fs.statSync(path.join(uploadsDir, file.storedName));
      if (!stats.isFile()) return null;
      return { size: stats.size, mtimeMs: Math.trunc(Number(stats.mtimeMs) || 0) };
    } catch (_) { return null; }
  }
  function mediaMetadataNeedsAnalysis(file) {
    if (!file || file.category !== 'video' || file.sourceType === 'remote' || mediaIsHls(file)) return false;
    const metadata = file.metadata || {};
    return Number(metadata.analysisVersion) !== MEDIA_ANALYSIS_VERSION
      || !String(metadata.videoCodec || '').trim() || !String(metadata.pixelFormat || '').trim()
      || !(Number(metadata.width) > 0) || !(Number(metadata.height) > 0);
  }
  function mediaThumbnailAvailable(file) {
    if (!file || file.category !== 'video' || file.sourceType === 'remote') return false;
    const name = path.basename(String(file.thumbnailName || ''));
    if (!name || name !== String(file.thumbnailName || '')) return false;
    try {
      const stats = fs.statSync(path.join(thumbnailsDir, name));
      return stats.isFile() && stats.size > 0;
    } catch (_) { return false; }
  }
  function mediaIsHls(file) {
    return HLS_EXTENSIONS.has(path.extname(file?.originalName || file?.storedName || '').toLowerCase())
      || /mpegurl/i.test(String(file?.mimeType || ''));
  }
  function mediaThumbnailNeedsAnalysis(file) {
    return Boolean(file && file.category === 'video' && file.sourceType !== 'remote' && !mediaIsHls(file) && !mediaThumbnailAvailable(file));
  }
  function mediaNeedsCompatibility(file) {
    if (!file || file.category !== 'video') return false;
    // An HLS playlist is a manifest, not a single elementary stream. Its
    // segments may live beside it or on a CDN, so forcing it through FFmpeg
    // would fail (and can rewrite segment URLs). Keep the uploaded manifest
    // as-is and let the client/browser HLS pipeline consume it directly.
    const extension = path.extname(file.originalName || file.storedName || '').toLowerCase();
    if (mediaIsHls(file)) return false;
    const metadata = file.metadata || {};
    const videoCodec = String(metadata.videoCodec || '').trim().toUpperCase();
    // Unknown is not the same as browser-compatible.  Desktop servers will
    // analyze/convert it; lightweight Android servers without ffprobe/ffmpeg
    // expose it as "device decoding required" instead of promising a
    // conversion that can never run.
    if (!videoCodec) return true;
    const audioCodec = String(metadata.audioCodec || '').trim().toUpperCase();
    const pixelFormat = String(metadata.pixelFormat || '').trim().toLowerCase();
    const h264Video = ['H264', 'AVC', 'AVC1'].includes(videoCodec);
    const browserPixelFormat = pixelFormat === 'yuv420p';
    const browserAudio = !audioCodec || ['AAC', 'MP3'].includes(audioCodec);
    const duration = Number(metadata.duration) || 0;
    const averageBitrate = duration > 0 && Number(file.size) > 0 ? Number(file.size) * 8 / duration : Infinity;
    return extension !== '.mp4' || !h264Video || !browserPixelFormat || !browserAudio
      || Number(metadata.width) > MEDIA_COMPATIBILITY_MAX_WIDTH || Number(metadata.height) > MEDIA_COMPATIBILITY_MAX_HEIGHT
      || averageBitrate > MEDIA_COMPATIBILITY_MAX_VIDEO_BITRATE + MEDIA_COMPATIBILITY_AUDIO_BITRATE;
  }
  function mediaCompatibilitySummary(file) {
    if (file?.sourceType === 'remote') return { required: false, ready: true, status: 'native', progress: 100, remote: true };
    const required = mediaNeedsCompatibility(file);
    if (!required) return { required: false, ready: true, status: 'native', progress: 100 };
    const fileName = compatibilityFileName(file);
    const target = path.join(compatibleMediaDir, fileName);
    const source = mediaSourceSnapshot(file);
    let ready = false;
    let size = 0;
    try {
      const stats = fs.statSync(target);
      const compatibility = file.compatibility || {};
      ready = Boolean(source && stats.isFile() && stats.size > 0
        && Number(compatibility.recipeVersion) === MEDIA_COMPATIBILITY_RECIPE_VERSION
        && Number(compatibility.sourceSize) === source.size
        && Number(compatibility.sourceMtimeMs) === source.mtimeMs
        && Number(compatibility.size) === stats.size
        && Number(compatibility.outputMtimeMs) === Math.trunc(Number(stats.mtimeMs) || 0));
      size = ready ? stats.size : 0;
    } catch (_) {}
    const conversionAvailable = Boolean(ffmpegPath && fs.existsSync(ffmpegPath));
    const status = ready ? 'ready' : (conversionAvailable
      ? cleanText(file.compatibility?.status || (mediaCompatibilityAutoConvert() ? 'queued' : 'manual'), 20)
      : 'unavailable');
    return {
      required: true, ready, status, progress: ready ? 100 : Math.max(0, Math.min(99, Math.floor(Number(file.compatibility?.progress) || 0))),
      fileName, size, recipeVersion: MEDIA_COMPATIBILITY_RECIPE_VERSION,
      startedAt: file.compatibility?.startedAt || '', elapsedSeconds: Math.max(0, Number(file.compatibility?.elapsedSeconds) || 0),
      speedRatio: Math.max(0, Number(file.compatibility?.speedRatio) || 0), etaSeconds: Math.max(0, Number(file.compatibility?.etaSeconds) || 0),
      manualReason: cleanText(file.compatibility?.manualReason, 40),
      sourceSize: source?.size || 0, sourceMtimeMs: source?.mtimeMs || 0,
      maxWidth: MEDIA_COMPATIBILITY_MAX_WIDTH, maxHeight: MEDIA_COMPATIBILITY_MAX_HEIGHT,
      videoCodec: ready ? 'H264' : '', audioCodec: ready ? 'AAC' : '',
      error: status === 'manual' && file.compatibility?.manualReason === 'user-stopped' ? '已手动停止，可点击播放重新处理'
        : status === 'failed' ? '兼容版生成失败，可点击播放重试'
        : status === 'unavailable' ? '当前服务器没有可用的媒体转码组件，远端设备需要自行支持原始编码' : ''
    };
  }
  function normalizeRemoteVideoUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      const host = url.hostname.toLowerCase();
      if (['localhost', 'localhost.localdomain'].includes(host) || host.endsWith('.local')) return '';
      if (net.isIP(host)) {
        const normalized = normalizeIp(host);
        if (privateOrLoopbackAddress(normalized)) return '';
      }
      url.hash = '';
      return url.toString();
    } catch (_) { return ''; }
  }
  const isIpBanned = (ip) => state.blacklist.some((item) => item?.ip === ip);
  function sourceIp(peerAddress, headers = {}) {
    return resolveClientIp(peerAddress, headers, trustedProxyMatcher);
  }
  const getRequestIp = (req) => sourceIp(req.socket?.remoteAddress, req.headers);
  const getSocketIp = (socket) => sourceIp(socket.handshake?.address, socket.handshake?.headers);
  function requestIsLanClient(req) {
    const peer = normalizeIp(req.socket?.remoteAddress);
    if (peer === '127.0.0.1') return false;
    return privateOrLoopbackAddress(peer) && !requestUsesForwardedHttps(req);
  }
  function socketIsLanClient(socket) {
    const peer = normalizeIp(socket.handshake?.address);
    if (peer === '127.0.0.1') return false;
    const headers = socket.handshake?.headers || {};
    const forwardedHttps = privateOrLoopbackAddress(peer)
      && String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
    return privateOrLoopbackAddress(peer) && !forwardedHttps;
  }

  function consumeRateLimit(key, limit, windowMs) {
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      bucket = { count: 0, expiresAt: now + windowMs };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit;
  }

  function rateLimitBucket(key, windowMs) {
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      bucket = { count: 0, expiresAt: now + windowMs };
      rateBuckets.set(key, bucket);
    }
    return bucket;
  }

  function loginFailureKeysForIp(ipAddress, username) {
    const ip = normalizeIp(ipAddress);
    const normalizedUsername = cleanUsername(username).toLocaleLowerCase();
    return [`${ip}:login-failure`, normalizedUsername ? `${ip}:login-failure-user:${normalizedUsername}` : ''].filter(Boolean);
  }

  function loginFailureKeys(socket, username) {
    return loginFailureKeysForIp(getSocketIp(socket), username);
  }

  function loginFailureLimited(socket, username, acknowledgement) {
    const [ipKey, userKey] = loginFailureKeys(socket, username);
    const windowMs = 5 * 60 * 1000;
    const ipBlocked = rateLimitBucket(ipKey, windowMs).count >= 60;
    const userBlocked = userKey ? rateLimitBucket(userKey, windowMs).count >= 15 : false;
    if (!ipBlocked && !userBlocked) return false;
    const expiresAt = Math.max(rateLimitBucket(ipKey, windowMs).expiresAt, userKey ? rateLimitBucket(userKey, windowMs).expiresAt : 0);
    acknowledgement?.({
      success: false, code: 'LOGIN_RATE_LIMITED', canRequestClear: true,
      retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)),
      error: '登录失败次数过多，请稍后再试，或申请管理员解除限制'
    });
    return true;
  }

  function recordLoginFailure(socket, username) {
    const windowMs = 5 * 60 * 1000;
    for (const key of loginFailureKeys(socket, username)) rateLimitBucket(key, windowMs).count += 1;
  }

  function clearLoginFailures(socket, username) {
    for (const key of loginFailureKeys(socket, username)) rateBuckets.delete(key);
  }

  function socketRateLimited(socket, action, limit, windowMs, acknowledgement) {
    if (consumeRateLimit(`${getSocketIp(socket)}:${action}`, limit, windowMs)) return false;
    const result = { success: false, error: '操作过于频繁，请稍后再试' };
    if (typeof acknowledgement === 'function') acknowledgement(result);
    return true;
  }

  function httpRateLimit(action, limit, windowMs) {
    return (req, res, next) => {
      const username = req.syncWatchSession?.username || 'anonymous';
      const key = `${getRequestIp(req)}:${username}:http:${action}`;
      if (consumeRateLimit(key, limit, windowMs)) return next();
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(windowMs / 1000))));
      return res.status(429).json({ success: false, error: '操作过于频繁，请稍后再试' });
    };
  }

  function nonPublicTargetAddress(value) {
    const address = normalizeIp(value).toLowerCase();
    const family = net.isIP(address);
    if (family === 4) {
      const [a, b] = address.split('.').map(Number);
      return privateOrLoopbackAddress(address) || a === 0 || a >= 224
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 192 && b === 0)
        || (a === 198 && (b === 18 || b === 19));
    }
    if (family === 6) {
      return privateOrLoopbackAddress(address) || address === '::' || address.startsWith('ff')
        || address.startsWith('2001:db8:') || address.startsWith('::ffff:');
    }
    return true;
  }

  async function resolvePublicWebTarget(targetUrl) {
    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('只支持公开的 HTTP 或 HTTPS 地址');
    const expectedPort = parsed.protocol === 'https:' ? 443 : 80;
    if (parsed.port && Number(parsed.port) !== expectedPort) throw new Error('网页识别仅允许标准 HTTP/HTTPS 端口');
    const literalFamily = net.isIP(parsed.hostname);
    const addresses = literalFamily
      ? [{ address: parsed.hostname, family: literalFamily }]
      : await lookupHost(parsed.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => nonPublicTargetAddress(entry.address))) throw new Error('该地址不是可识别的公开网络资源');
    return { parsed, address: addresses[0].address, family: addresses[0].family };
  }

  function decodeHtmlAttribute(value) {
    return String(value || '').replace(/&amp;/gi, '&').replace(/&#38;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  }

  function publicMediaKind(urlValue, contentType = '') {
    const pathname = (() => { try { return new URL(urlValue).pathname.toLowerCase(); } catch (_) { return ''; } })();
    if (/\.m3u8$/.test(pathname) || /application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(contentType)) return 'HLS';
    if (/\.webm$/.test(pathname) || /video\/webm/i.test(contentType)) return 'WebM';
    if (/\.mp4$/.test(pathname) || /video\/mp4/i.test(contentType)) return 'MP4';
    return '';
  }

  function extractPublicMediaUrls(html, baseUrl) {
    const found = new Map();
    const remember = (candidate) => {
      if (found.size >= 40) return;
      try {
        const resolved = new URL(decodeHtmlAttribute(candidate), baseUrl);
        if (!['http:', 'https:'].includes(resolved.protocol)) return;
        const type = publicMediaKind(resolved.href);
        if (type) found.set(resolved.href, { url: resolved.href, type });
      } catch (_) {}
    };
    const attributePattern = /\b(?:src|href|data-src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    let match;
    while ((match = attributePattern.exec(html))) remember(match[1] || match[2] || match[3]);
    const absolutePattern = /https?:\\?\/\\?\/[^\s"'<>]+?\.(?:mp4|webm|m3u8)(?:\?[^\s"'<>]*)?/gi;
    while ((match = absolutePattern.exec(html))) remember(match[0].replace(/\\\//g, '/'));
    return [...found.values()];
  }

  async function probePublicWebPage(targetUrl, redirects = 0) {
    if (redirects > 3) throw new Error('网页重定向次数过多');
    const { parsed, address, family } = await resolvePublicWebTarget(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(parsed, {
        method: 'GET',
        headers: { 'User-Agent': `SyncWatch/${APP_VERSION}`, Accept: 'text/html,video/mp4,video/webm,application/vnd.apple.mpegurl;q=0.9,*/*;q=0.5' },
        lookup: (_hostname, _options, callback) => callback(null, address, family)
      }, (response) => {
        const status = Number(response.statusCode) || 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          let next;
          try { next = new URL(response.headers.location, parsed).href; } catch (_) { return reject(new Error('网页返回了无效的重定向地址')); }
          return probePublicWebPage(next, redirects + 1).then(resolve, reject);
        }
        if (status < 200 || status >= 400) { response.resume(); return reject(new Error(`网页返回状态 ${status}`)); }
        const contentType = cleanText(response.headers['content-type'], 160).toLowerCase();
        const directType = publicMediaKind(parsed.href, contentType);
        if (directType) { response.destroy(); return resolve({ finalUrl: parsed.href, title: path.basename(parsed.pathname) || parsed.hostname, resources: [{ url: parsed.href, type: directType }] }); }
        if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
          response.resume(); return reject(new Error('该地址不是网页或支持的公开媒体资源'));
        }
        const chunks = []; let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) { request.destroy(new Error('网页内容超过识别上限')); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8');
          const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          const title = cleanText(titleMatch?.[1]?.replace(/<[^>]+>/g, '') || parsed.hostname, 120);
          resolve({ finalUrl: parsed.href, title, resources: extractPublicMediaUrls(html, parsed.href) });
        });
      });
      request.setTimeout(10000, () => request.destroy(new Error('网页识别超时')));
      request.on('error', reject);
      request.end();
    });
  }

  function publicMailSettings() {
    const mail = normalizeMailSettings(state.admin.mail);
    let credentialReadable = false;
    if (mail.encryptedAuthCode) {
      try { credentialReadable = Boolean(decryptMailSecret(mail.encryptedAuthCode)); } catch (_) {}
    }
    return {
      enabled: Boolean(mail.enabled), host: mail.host, port: mail.port, secure: mail.secure, useTls: mail.useTls,
      user: mail.user, fromEmail: mail.fromEmail, recoveryEmail: mail.recoveryEmail, fromName: mail.fromName,
      configured: Boolean(mail.host && mail.port && mail.user && mail.fromEmail && mail.encryptedAuthCode && credentialReadable),
      registrationVerificationEnabled: mail.registrationVerificationEnabled,
      bindingVerificationEnabled: mail.bindingVerificationEnabled,
      accountRecoveryEnabled: mail.accountRecoveryEnabled,
      adminRecoveryEnabled: mail.adminRecoveryEnabled,
      defaultLocale: mail.defaultLocale,
      templates: mail.templates,
      provider: `${mail.host}:${mail.port}`
    };
  }

  function mailRecoveryAvailable(scope = 'account') {
    const mail = publicMailSettings();
    const flowEnabled = scope === 'admin' ? mail.adminRecoveryEnabled : mail.accountRecoveryEnabled;
    return mail.enabled && mail.configured && flowEnabled;
  }

  function registrationEmailVerificationAvailable() {
    const mail = publicMailSettings();
    // Do not advertise a policy that cannot deliver its verification code.
    return mail.enabled && mail.configured && mail.registrationVerificationEnabled;
  }

  function registrationEmailVerificationError() {
    const mail = publicMailSettings();
    if (!mail.enabled) return '服务器当前未启用 SMTP 邮件服务';
    if (!mail.configured) return '服务器已启用注册邮箱验证，但 SMTP 配置不可用，请检查 SMTP 设置或恢复 SyncWatch同步观影-Data/.secrets/mail.key';
    return '';
  }

  function emailBindingAvailable() {
    const mail = publicMailSettings();
    return mail.enabled && mail.configured && mail.bindingVerificationEnabled;
  }

  function htmlEscapeMailValue(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  function renderMailTemplate(event, values = {}, locale = '') {
    const mail = publicMailSettings();
    const safeEvent = MAIL_TEMPLATE_EVENTS.has(event) ? event : 'verification';
    const safeLocale = MAIL_TEMPLATE_LOCALES.has(locale) ? locale : mail.defaultLocale;
    const key = `${safeEvent}:${safeLocale}`;
    const template = mail.templates?.[key] || defaultMailTemplates()[key] || defaultMailTemplates()[`${safeEvent}:zh-CN`];
    const replacements = {
      site_name: 'SyncWatch同步观影', recipient_name: values.recipientName || values.accountName || 'SyncWatch同步观影 用户',
      recipient_email: values.recipientEmail || '', verification_code: values.verificationCode || '123456',
      expires_in_minutes: values.expiresInMinutes || Math.floor(PASSWORD_RESET_CODE_TTL_MS / 60000),
      action_name: values.actionName || '验证邮箱', account_name: values.accountName || 'SyncWatch同步观影 账号'
    };
    const replace = (input, escapeValues = true) => String(input || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, name) => {
      const value = Object.hasOwn(replacements, name) ? replacements[name] : '';
      return escapeValues ? htmlEscapeMailValue(value) : cleanText(value, 300);
    });
    const subject = replace(template.subject, false).replace(/[\r\n]+/g, ' ').slice(0, MAIL_TEMPLATE_SUBJECT_LIMIT);
    const html = replace(template.html, true);
    const plainBody = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
    const text = values.verificationCode ? `验证码：${cleanText(values.verificationCode, 32)}\n\n${plainBody}` : plainBody;
    return { subject, html, text };
  }

  async function sendConfiguredMail({ to, subject, text, html }) {
    const mail = publicMailSettings();
    if (!mail.enabled || !mail.configured) throw new Error('服务器尚未配置并启用 SMTP 邮件服务');
    const authCode = decryptMailSecret();
    const config = {
      host: mail.host, port: mail.port, secure: mail.secure, useTls: mail.useTls,
      user: mail.user, password: authCode, authCode,
      fromEmail: mail.fromEmail, fromName: mail.fromName
    };
    if (typeof options.mailSender === 'function') return options.mailSender({ config, to, subject, text, html });
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      host: mail.host, port: mail.port, secure: mail.secure, useTls: mail.useTls,
      user: mail.user, fromEmail: mail.fromEmail, credential: state.admin.mail.encryptedAuthCode
    })).digest('hex');
    if (!mailTransportCache || mailTransportCache.fingerprint !== fingerprint) {
      let nodemailer;
      try { nodemailer = require('nodemailer'); }
      catch (_) { throw new Error('服务器缺少邮件发送组件，请重新安装完整生产依赖'); }
      const tlsOptions = { minVersion: 'TLSv1.2', rejectUnauthorized: true };
      if (!net.isIP(mail.host)) tlsOptions.servername = mail.host;
      mailTransportCache = {
        fingerprint,
        transporter: nodemailer.createTransport({
          host: mail.host, port: mail.port, secure: mail.secure,
          requireTLS: mail.useTls && !mail.secure, ignoreTLS: !mail.useTls,
          auth: { user: mail.user, pass: authCode },
          connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
          tls: tlsOptions
        })
      };
    }
    return mailTransportCache.transporter.sendMail({ from: { name: mail.fromName, address: mail.fromEmail }, to, subject, text, html });
  }

  async function verifyConfiguredMailConnection() {
    const mail = publicMailSettings();
    if (!mail.enabled || !mail.configured) throw new Error('请先保存并启用完整的 SMTP 配置');
    const authCode = decryptMailSecret();
    const config = {
      host: mail.host, port: mail.port, secure: mail.secure, useTls: mail.useTls,
      user: mail.user, password: authCode, authCode, fromEmail: mail.fromEmail, fromName: mail.fromName
    };
    if (typeof options.mailVerifier === 'function') return options.mailVerifier({ config });
    if (typeof options.mailSender === 'function') return { success: true, simulated: true };
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      host: mail.host, port: mail.port, secure: mail.secure, useTls: mail.useTls,
      user: mail.user, fromEmail: mail.fromEmail, credential: state.admin.mail.encryptedAuthCode
    })).digest('hex');
    if (!mailTransportCache || mailTransportCache.fingerprint !== fingerprint) {
      let nodemailer;
      try { nodemailer = require('nodemailer'); }
      catch (_) { throw new Error('服务器缺少邮件发送组件，请重新安装完整生产依赖'); }
      const tlsOptions = { minVersion: 'TLSv1.2', rejectUnauthorized: true };
      if (!net.isIP(mail.host)) tlsOptions.servername = mail.host;
      mailTransportCache = {
        fingerprint,
        transporter: nodemailer.createTransport({
          host: mail.host, port: mail.port, secure: mail.secure,
          requireTLS: mail.useTls && !mail.secure, ignoreTLS: !mail.useTls,
          auth: { user: mail.user, pass: authCode },
          connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
          tls: tlsOptions
        })
      };
    }
    return mailTransportCache.transporter.verify();
  }

  function recoveryTarget(scope, identifier) {
    if (scope === 'admin') {
      const email = cleanText(state.admin.mail?.recoveryEmail || state.admin.mail?.user, 254).toLowerCase();
      return email ? { scope: 'admin', username: '', email, key: 'admin' } : null;
    }
    const value = String(identifier ?? '').normalize('NFC').trim();
    if (Buffer.byteLength(value, 'utf8') > USERNAME_MAX_UTF8_BYTES) return null;
    const emailValue = value.toLowerCase();
    let username = state.accounts[value] ? value : '';
    if (!username) username = Object.keys(state.accounts).find((name) => String(state.accounts[name]?.email || '').toLowerCase() === emailValue) || '';
    const account = username && state.accounts[username];
    const email = cleanText(account?.email, 120).toLowerCase();
    return account && email && account.emailVerified === true
      ? { scope: 'account', username, email, key: `account:${username}` }
      : null;
  }

  function resetCodeDigest(code, nonce) {
    return crypto.createHmac('sha256', passwordResetDigestKey).update(`${nonce}:${code}`, 'utf8').digest();
  }

  function clearPasswordResetState(key) {
    if (!key) return;
    passwordResetCodes.delete(key);
    for (const [token, entry] of passwordResetTokens) if (entry.key === key) passwordResetTokens.delete(token);
  }

  function queuePasswordResetMail(entry, message) {
    const job = Promise.resolve().then(() => sendConfiguredMail(message)).catch((error) => {
      if (passwordResetCodes.get(entry.key) === entry) passwordResetCodes.delete(entry.key);
      updateVerificationRecord(entry.recordId, { status: 'failed', error: cleanText(error.message, 240), sentAt: new Date().toISOString() });
      persist();
      console.error('发送密码重置邮件失败:', error.message);
    }).then((result) => {
      if (entry.recordId) {
        const acceptedAt = new Date().toISOString();
        updateVerificationRecord(entry.recordId, { sentAt: acceptedAt, acceptedAt });
        persist();
      }
      return result;
    });
    mailDeliveryJobs.add(job);
    job.finally(() => mailDeliveryJobs.delete(job)).catch(() => {});
  }

  async function requestPasswordReset(socket, payload = {}) {
    const scope = payload.scope === 'admin' ? 'admin' : 'account';
    if (!mailRecoveryAvailable(scope)) return { success: false, error: scope === 'admin' ? '服务器尚未启用管理员邮箱找回密码' : '服务器尚未启用账号邮箱找回密码，请联系服务器管理员' };
    const identifier = String(payload.identifier ?? '').normalize('NFC').trim();
    const target = recoveryTarget(scope, identifier);
    const privacySubject = target?.key || `${scope}:${identifier.toLowerCase()}`;
    const privacyKey = crypto.createHash('sha256').update(privacySubject).digest('hex').slice(0, 24);
    if (!verificationRateAllowed(socket, `password-reset-${scope}`, privacyKey, payload)) {
      return { success: false, error: '验证码请求过于频繁，请稍后再试' };
    }
    if (!target && scope === 'account') {
      // Accounts created before mailbox verification was enabled may still
      // contain an address, but that address is not eligible for recovery.
      // Keep the response generic and do not enqueue a message.
      const value = identifier.toLowerCase();
      const unverified = Object.entries(state.accounts).some(([name, account]) => {
        return (name.toLowerCase() === value || String(account.email || '').toLowerCase() === value)
          && Boolean(account.email) && account.emailVerified !== true;
      });
      if (unverified) return { success: true, message: '如果该邮箱已绑定且完成验证，验证码将发送至邮箱' };
    }
    if (!target) return { success: false, code: 'ACCOUNT_OR_EMAIL_NOT_FOUND', error: '账号或绑定邮箱不存在，请检查输入后重试' };
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const label = target.scope === 'admin' ? '服务器管理员密码' : `账号 ${target.username}`;
    const record = createVerificationRecord({ type: scope === 'admin' ? 'admin-reset' : 'password-reset', accountName: label, senderEmail: publicMailSettings().fromEmail, recipientEmail: target.email, socket, payload, expiresAt: passwordResetNow() + PASSWORD_RESET_CODE_TTL_MS });
    const entry = { ...target, nonce, digest: resetCodeDigest(code, nonce), expiresAt: passwordResetNow() + PASSWORD_RESET_CODE_TTL_MS, attempts: 0, recordId: record.id };
    passwordResetCodes.set(target.key, entry);
    const message = renderMailTemplate('passwordReset', {
      recipientName: target.scope === 'admin' ? '服务器管理员' : (state.accounts[target.username]?.displayName || target.username),
      recipientEmail: target.email, verificationCode: code, accountName: label,
      expiresInMinutes: Math.floor(PASSWORD_RESET_CODE_TTL_MS / 60000)
    });
    queuePasswordResetMail(entry, { to: target.email, ...message });
    persist();
    return { success: true, accountName: label, username: target.username, email: target.email, maskedEmail: maskEmailAddressServer(target.email), message: `验证码已发送至 ${maskEmailAddressServer(target.email)}，请检查收件箱和垃圾邮件` };
  }

  function verifyPasswordReset(payload = {}) {
    const invalid = { success: false, error: '验证码无效或已过期，请重新获取' };
    const scope = payload.scope === 'admin' ? 'admin' : 'account';
    const target = recoveryTarget(scope, payload.identifier);
    const entry = target && passwordResetCodes.get(target.key);
    if (!entry || entry.expiresAt <= passwordResetNow()) {
      if (target) {
        const expiredEntry = passwordResetCodes.get(target.key);
        passwordResetCodes.delete(target.key);
        updateVerificationRecord(expiredEntry?.recordId, { status: 'expired' });
      }
      return invalid;
    }
    entry.attempts += 1;
    const submitted = resetCodeDigest(String(payload.code || '').trim(), entry.nonce);
    if (submitted.length !== entry.digest.length || !crypto.timingSafeEqual(submitted, entry.digest)) {
      if (entry.attempts >= 5) passwordResetCodes.delete(target.key);
      return invalid;
    }
    passwordResetCodes.delete(target.key);
    updateVerificationRecord(entry.recordId, { status: 'used', usedAt: new Date().toISOString() });
    persist();
    for (const [token, reset] of passwordResetTokens) if (reset.key === entry.key) passwordResetTokens.delete(token);
    const resetToken = crypto.randomBytes(32).toString('base64url');
    passwordResetTokens.set(resetToken, { key: entry.key, scope: entry.scope, username: entry.username, expiresAt: passwordResetNow() + PASSWORD_RESET_TOKEN_TTL_MS });
    return { success: true, resetToken, expiresInSeconds: Math.floor(PASSWORD_RESET_TOKEN_TTL_MS / 1000), message: '邮箱验证通过，请设置新密码' };
  }

  async function completePasswordReset(payload = {}) {
    const token = String(payload.resetToken || '');
    const reset = passwordResetTokens.get(token);
    if (!reset || reset.expiresAt <= passwordResetNow()) {
      passwordResetTokens.delete(token);
      return { success: false, error: '重置授权无效或已过期，请重新验证邮箱' };
    }
    const newPassword = String(payload.newPassword || '');
    const passwordError = passwordPolicyError(newPassword, { administrator: reset.scope === 'admin' });
    if (passwordError) return { success: false, error: passwordError };
    passwordResetTokens.delete(token);
    const passwordHash = await makePasswordHashAsync(newPassword);
    if (reset.scope === 'admin') {
      setAdminPasswordHash(passwordHash);
      state.admin.mustChangePassword = false;
      if (state.accounts.admin) {
        state.accounts.admin.passwordHash = passwordHash;
        state.accounts.admin.mustChangePassword = false;
        state.accounts.admin.passwordChangedAt = state.admin.passwordChangedAt;
        state.accounts.admin.devices = state.accounts.admin.devices.map((device) => ({ ...device, current: false }));
      }
      clearAdminVerification();
      clearPasswordResetState('admin');
      clearPasswordResetState('account:admin');
      emailBindingCodes.delete('admin');
      revokeUserSessions('admin', 'auth-error', '管理员密码已通过邮箱重置，请使用新密码登录');
      persist();
      recordOperation({ actor: 'email-recovery', action: 'admin-password-recovery', summary: '通过 QQ 邮箱验证重置服务器管理员密码', scope: 'server' });
      return { success: true, message: '服务器管理员与 admin 账号密码已同步修改，原有 admin 会话已退出' };
    }
    const account = state.accounts[reset.username];
    if (!account) return { success: false, error: '重置授权无效或已过期，请重新验证邮箱' };
    account.passwordHash = passwordHash;
    account.mustChangePassword = false;
    account.passwordChangedAt = new Date().toISOString();
    account.devices = account.devices.map((device) => ({ ...device, current: false }));
    clearPasswordResetState(reset.key);
    revokeUserSessions(reset.username, 'auth-error', '密码已通过邮箱重置，请使用新密码登录');
    persist();
    recordOperation({ actor: reset.username, action: 'account-password-recovery', summary: '通过邮箱验证重置登录密码', scope: 'account' });
    return { success: true, message: '登录密码已修改，原有登录会话已全部退出' };
  }

  function registrationEmailDigest(email, code, nonce) {
    return crypto.createHmac('sha256', passwordResetDigestKey)
      .update(`registration:${email}:${nonce}:${code}`, 'utf8').digest();
  }

  async function requestRegistrationEmailCode(socket, payload = {}) {
    const registrationError = registrationEmailVerificationError();
    if (registrationError) return {
      success: false,
      code: registrationError.includes('SMTP 配置不可用') ? 'REGISTRATION_EMAIL_SMTP_UNAVAILABLE' : 'REGISTRATION_EMAIL_DISABLED',
      error: registrationError
    };
    const email = cleanText(payload.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { success: false, error: '请输入有效的注册邮箱' };
    const rawAccountName = String(payload.username ?? '');
    const accountName = cleanUsername(rawAccountName);
    if (rawAccountName) {
      const usernameError = usernamePolicyError(rawAccountName, state.admin.usernamePolicy);
      if (usernameError) return { success: false, error: usernameError };
    }
    if (Object.values(state.accounts).some((account) => String(account.email || '').toLowerCase() === email)) return { success: false, error: '邮箱已被其他账号使用' };
    const targetKey = crypto.createHash('sha256').update(email).digest('hex').slice(0, 24);
    if (!verificationRateAllowed(socket, 'registration', targetKey, payload)) {
      return { success: false, error: '注册验证码请求过于频繁，请稍后再试' };
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const record = createVerificationRecord({ type: 'registration', accountName: accountName || '新用户', senderEmail: publicMailSettings().fromEmail, recipientEmail: email, socket, payload, expiresAt: passwordResetNow() + PASSWORD_RESET_CODE_TTL_MS });
    const entry = {
      email, nonce, digest: registrationEmailDigest(email, code, nonce),
      expiresAt: passwordResetNow() + PASSWORD_RESET_CODE_TTL_MS, attempts: 0, recordId: record.id
    };
    registrationEmailCodes.set(email, entry);
    try {
      await sendConfiguredMail({ to: email, ...renderMailTemplate('verification', {
        recipientName: accountName || '新用户', recipientEmail: email,
        verificationCode: code, actionName: '注册邮箱', accountName: accountName || 'SyncWatch同步观影 账号',
        expiresInMinutes: Math.floor(PASSWORD_RESET_CODE_TTL_MS / 60000)
      }) });
    } catch (error) {
      if (registrationEmailCodes.get(email) === entry) registrationEmailCodes.delete(email);
      updateVerificationRecord(record.id, { status: 'failed', error: cleanText(error.message, 240), sentAt: new Date().toISOString() });
      persist();
      console.error('发送注册邮箱验证码失败:', error.message);
      return { success: false, error: '注册验证码发送失败，请检查邮箱地址、SMTP 设置或服务器网络' };
    }
    const acceptedAt = new Date().toISOString(); updateVerificationRecord(record.id, { sentAt: acceptedAt, acceptedAt }); persist();
    return { success: true, email, accountName, maskedEmail: maskEmailAddressServer(email), expiresInSeconds: Math.floor(PASSWORD_RESET_CODE_TTL_MS / 1000), message: `注册验证码已发送至 ${maskEmailAddressServer(email)}，请检查收件箱和垃圾邮件` };
  }

  function verifyRegistrationEmailCode(emailValue, codeValue) {
    const email = cleanText(emailValue, 254).toLowerCase();
    const entry = registrationEmailCodes.get(email);
    if (!entry || entry.expiresAt <= passwordResetNow()) {
      updateVerificationRecord(entry?.recordId, { status: 'expired' });
      registrationEmailCodes.delete(email);
      return false;
    }
    entry.attempts += 1;
    const submitted = registrationEmailDigest(email, String(codeValue || '').trim(), entry.nonce);
    const valid = submitted.length === entry.digest.length && crypto.timingSafeEqual(submitted, entry.digest);
    if (!valid && entry.attempts >= 5) registrationEmailCodes.delete(email);
    if (valid) { updateVerificationRecord(entry.recordId, { status: 'used', usedAt: new Date().toISOString() }); persist(); }
    return valid;
  }

  function emailBindingDigest(username, email, code, nonce) {
    return crypto.createHmac('sha256', passwordResetDigestKey)
      .update(`${username}:${email}:${nonce}:${code}`, 'utf8').digest();
  }

  async function requestEmailBinding(user, socket, payload = {}) {
    const account = state.accounts[user.username];
    const email = cleanText(payload.email, 120).toLowerCase();
    if (!account) return { success: false, error: '账号不存在' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { success: false, error: '邮箱格式不正确' };
    if (email === String(account.email || '').toLowerCase() && account.emailVerified === true) return { success: true, alreadyBound: true, message: '这个邮箱已经绑定到当前账号' };
    if (Object.entries(state.accounts).some(([username, entry]) => username !== user.username && String(entry?.email || '').toLowerCase() === email)) {
      return { success: false, error: '邮箱已被其他账号使用' };
    }
    if (!emailBindingAvailable()) return { success: false, error: '服务器尚未启用邮箱绑定验证，请联系服务器管理员' };
    if (!verificationRateAllowed(socket, 'binding', user.username, payload)) {
      return { success: false, error: '邮箱验证码请求过于频繁，请稍后再试' };
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const record = createVerificationRecord({ type: 'binding', accountName: `账号 ${user.username}`, senderEmail: publicMailSettings().fromEmail, recipientEmail: email, socket, payload, expiresAt: passwordResetNow() + PASSWORD_RESET_CODE_TTL_MS });
    const entry = {
      username: user.username, email, nonce,
      digest: emailBindingDigest(user.username, email, code, nonce),
      expiresAt: passwordResetNow() + PASSWORD_RESET_CODE_TTL_MS, attempts: 0, recordId: record.id
    };
    emailBindingCodes.set(user.username, entry);
    try {
      await sendConfiguredMail({ to: email, ...renderMailTemplate('verification', {
        recipientName: account.displayName || user.username, recipientEmail: email,
        verificationCode: code, actionName: '邮箱绑定', accountName: `账号 ${user.username}`,
        expiresInMinutes: Math.floor(PASSWORD_RESET_CODE_TTL_MS / 60000)
      }) });
    } catch (error) {
      if (emailBindingCodes.get(user.username) === entry) emailBindingCodes.delete(user.username);
      updateVerificationRecord(record.id, { status: 'failed', error: cleanText(error.message, 240), sentAt: new Date().toISOString() }); persist();
      console.error('发送邮箱绑定验证码失败:', error.message);
      return { success: false, error: '验证码发送失败，请检查邮箱地址或联系服务器管理员' };
    }
    const acceptedAt = new Date().toISOString(); updateVerificationRecord(record.id, { sentAt: acceptedAt, acceptedAt }); persist();
    return { success: true, email, accountName: `账号 ${user.username}`, maskedEmail: maskEmailAddressServer(email), expiresInSeconds: Math.floor(PASSWORD_RESET_CODE_TTL_MS / 1000), message: `验证码已发送至 ${maskEmailAddressServer(email)}，请查收新邮箱` };
  }

  function verifyEmailBinding(user, payload = {}) {
    const account = state.accounts[user.username];
    const entry = emailBindingCodes.get(user.username);
    const invalid = { success: false, error: '邮箱验证码无效或已过期，请重新获取' };
    if (!account || !entry || entry.expiresAt <= passwordResetNow()) {
      updateVerificationRecord(entry?.recordId, { status: 'expired' });
      emailBindingCodes.delete(user.username);
      return invalid;
    }
    const email = cleanText(payload.email, 120).toLowerCase();
    entry.attempts += 1;
    const submitted = emailBindingDigest(user.username, email, String(payload.code || '').trim(), entry.nonce);
    if (email !== entry.email || submitted.length !== entry.digest.length || !crypto.timingSafeEqual(submitted, entry.digest)) {
      if (entry.attempts >= 5) emailBindingCodes.delete(user.username);
      return invalid;
    }
    if (Object.entries(state.accounts).some(([name, item]) => name !== user.username && String(item?.email || '').toLowerCase() === email)) {
      emailBindingCodes.delete(user.username);
      return { success: false, error: '邮箱已被其他账号使用，请重新绑定' };
    }
    const previousEmail = String(account.email || '').toLowerCase();
    account.email = email;
    account.emailVerified = true;
    emailBindingCodes.delete(user.username);
    updateVerificationRecord(entry.recordId, { status: 'used', usedAt: new Date().toISOString() });
    clearPasswordResetState(`account:${user.username}`);
    persist();
    recordOperation({ actor: user.username, action: 'email-bind', summary: `验证并绑定邮箱：${email}`, scope: 'account' });
    const profile = accountProfile(user.username);
    for (const member of accountOnlineMembers(user.username)) {
      io.to(member.socketId).emit('account-profile-updated', {
        kind: 'email-bind', profile, changed: ['email'], email, previousEmail,
        message: '您的邮箱已验证并绑定成功'
      });
    }
    return { success: true, profile, email, message: '邮箱验证通过，已成功绑定' };
  }

  function emailUnbindingDigest(username, email, code, nonce) {
    return crypto.createHmac('sha256', passwordResetDigestKey)
      .update(`unbind:${username}:${email}:${nonce}:${code}`, 'utf8').digest();
  }

  async function requestEmailUnbinding(user, socket, payload = {}) {
    const account = state.accounts[user.username];
    const email = cleanText(account?.email, 120).toLowerCase();
    const requestedEmail = cleanText(payload.email, 120).toLowerCase();
    if (!account || !email || account.emailVerified !== true) return { success: false, error: '当前账号没有已验证的绑定邮箱' };
    if (requestedEmail && requestedEmail !== email) return { success: false, error: '请输入当前绑定的邮箱地址' };
    if (!emailBindingAvailable()) return { success: false, error: '服务器尚未启用邮箱解绑验证，请联系服务器管理员' };
    if (!verificationRateAllowed(socket, 'unbinding', user.username, payload)) {
      return { success: false, error: '邮箱验证码请求过于频繁，请稍后再试' };
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const record = createVerificationRecord({ type: 'unbinding', accountName: `账号 ${user.username}`, senderEmail: publicMailSettings().fromEmail, recipientEmail: email, socket, payload, expiresAt: passwordResetNow() + PASSWORD_RESET_CODE_TTL_MS });
    const entry = {
      username: user.username, email, nonce,
      digest: emailUnbindingDigest(user.username, email, code, nonce),
      expiresAt: passwordResetNow() + PASSWORD_RESET_CODE_TTL_MS, attempts: 0, recordId: record.id
    };
    emailUnbindingCodes.set(user.username, entry);
    try {
      await sendConfiguredMail({ to: email, ...renderMailTemplate('verification', {
        recipientName: account.displayName || user.username, recipientEmail: email,
        verificationCode: code, actionName: '清除邮箱绑定', accountName: `账号 ${user.username}`,
        expiresInMinutes: Math.floor(PASSWORD_RESET_CODE_TTL_MS / 60000)
      }) });
    } catch (error) {
      if (emailUnbindingCodes.get(user.username) === entry) emailUnbindingCodes.delete(user.username);
      updateVerificationRecord(record.id, { status: 'failed', error: cleanText(error.message, 240), sentAt: new Date().toISOString() }); persist();
      console.error('发送邮箱解绑验证码失败:', error.message);
      return { success: false, error: '验证码发送失败，请检查邮箱地址或联系服务器管理员' };
    }
    const acceptedAt = new Date().toISOString(); updateVerificationRecord(record.id, { sentAt: acceptedAt, acceptedAt }); persist();
    return { success: true, email, accountName: `账号 ${user.username}`, maskedEmail: maskEmailAddressServer(email), expiresInSeconds: Math.floor(PASSWORD_RESET_CODE_TTL_MS / 1000), message: `验证码已发送至 ${maskEmailAddressServer(email)}，请查收当前绑定邮箱` };
  }

  function verifyEmailUnbinding(user, payload = {}) {
    const account = state.accounts[user.username];
    const entry = emailUnbindingCodes.get(user.username);
    const invalid = { success: false, error: '邮箱验证码无效或已过期，请重新获取' };
    if (!account || !entry || entry.expiresAt <= passwordResetNow()) {
      updateVerificationRecord(entry?.recordId, { status: 'expired' });
      emailUnbindingCodes.delete(user.username);
      return invalid;
    }
    const email = cleanText(payload.email || account.email, 120).toLowerCase();
    entry.attempts += 1;
    const submitted = emailUnbindingDigest(user.username, email, String(payload.code || '').trim(), entry.nonce);
    if (email !== entry.email || submitted.length !== entry.digest.length || !crypto.timingSafeEqual(submitted, entry.digest)) {
      if (entry.attempts >= 5) emailUnbindingCodes.delete(user.username);
      return invalid;
    }
    const previousEmail = String(account.email || '').toLowerCase();
    account.email = '';
    account.emailVerified = false;
    emailUnbindingCodes.delete(user.username);
    updateVerificationRecord(entry.recordId, { status: 'used', usedAt: new Date().toISOString() });
    clearPasswordResetState(`account:${user.username}`);
    persist();
    recordOperation({ actor: user.username, action: 'email-unbind', summary: `验证并清除邮箱绑定：${previousEmail}`, scope: 'account' });
    const profile = accountProfile(user.username);
    for (const member of accountOnlineMembers(user.username)) {
      io.to(member.socketId).emit('account-profile-updated', {
        kind: 'email-unbind', profile, changed: ['email'], email: '', previousEmail,
        message: '邮箱验证码通过，已清除邮箱绑定'
      });
    }
    return { success: true, profile, email: '', previousEmail, cleared: true, message: '邮箱验证码通过，已清除邮箱绑定' };
  }

  function broadcastUsersSoon(roomIdValue = currentRoomId()) {
    qualityBroadcastRooms.add(normalizeRoomId(roomIdValue) || state.defaultRoomId);
    if (qualityBroadcastTimer) return;
    qualityBroadcastTimer = setTimeout(() => {
      qualityBroadcastTimer = null;
      for (const id of qualityBroadcastRooms) withRoom(id, () => io.to(roomChannel(id)).emit('users-list', usersList(id)));
      qualityBroadcastRooms.clear();
    }, 250);
    qualityBroadcastTimer.unref?.();
  }

  function permissionFor(username, roomIdValue = currentRoomId()) {
    const room = roomConfig(roomIdValue);
    if (state.accounts[username]?.superAdmin) return { control: true, seek: true, upload: true, delete: true, manageMedia: true, shareScreen: true, shareAudio: true, shareWeb: true, voiceChat: true, manageChat: true, manageRoom: true, skipSettings: true, sendNotice: true, administrator: true, superAdmin: true, groupId: 'super-admin' };
    const serverHost = [...users.values()].some((member) => member.username === username && member.roomId === room.id && sessions.get(member.sessionToken)?.isServerHost);
    if (serverHost) return { control: true, seek: true, upload: true, delete: true, manageMedia: true, shareScreen: true, shareAudio: true, shareWeb: true, voiceChat: true, manageChat: true, manageRoom: true, skipSettings: true, sendNotice: true, administrator: true, superAdmin: false, groupId: 'server-host' };
    if (username && username === room.ownerUsername) return { control: true, seek: true, upload: true, delete: true, manageMedia: true, shareScreen: true, shareAudio: true, shareWeb: true, voiceChat: true, manageChat: true, manageRoom: true, skipSettings: true, sendNotice: true, administrator: true, superAdmin: false, groupId: 'owner' };
    const groupId = cleanText(room.memberGroups?.[username] || 'member', 32).toLowerCase();
    const group = room.permissionGroups?.[groupId] || room.permissionGroups?.member || defaultPermissionGroups().member;
    const direct = room.permissions[username] || {};
    const permissions = { ...state.admin.defaultPermissions, ...(group.permissions || {}), ...direct };
    if (direct.seek === undefined && direct.control === true) permissions.seek = true;
    if (room.mediaManagementGrants?.[username] === true) permissions.manageMedia = true;
    permissions.administrator = Boolean(direct.administrator || groupId === 'administrator');
    if (permissions.administrator) Object.assign(permissions, { control: true, seek: true, upload: true, delete: true, manageMedia: true, shareScreen: true, shareAudio: true, shareWeb: true, voiceChat: true, manageChat: true, manageRoom: true, skipSettings: true, sendNotice: true });
    permissions.superAdmin = false;
    permissions.groupId = permissions.administrator ? 'administrator' : groupId;
    return permissions;
  }

  function isRoomAdmin(user, capability = 'manageRoom') {
    if (!user) return false;
    if (state.accounts[user.username]?.superAdmin) return true;
    const room = roomConfig(user.roomId);
    return user.username === room.ownerUsername || Boolean(permissionFor(user.username, room.id)[capability]);
  }

  function canManageMediaLibrary(username, roomIdValue = currentRoomId()) {
    const room = roomConfig(roomIdValue);
    const permissions = permissionFor(username, room.id);
    return Boolean(username && (username === room.ownerUsername || state.accounts[username]?.superAdmin
      || permissions.manageMedia || permissions.delete || room.mediaManagementGrants?.[username] === true));
  }

  function trashBackedUndo(undo) {
    return Boolean(undo && ['file-delete', 'chat'].includes(undo.kind));
  }

  function undoExpiry(operation) {
    if (!trashBackedUndo(operation?.undo)) return Infinity;
    let expiresAt = Date.parse(operation.undo.expiresAt || '');
    if (!Number.isFinite(expiresAt)) {
      const createdAt = Date.parse(operation.createdAt || '');
      expiresAt = (Number.isFinite(createdAt) ? createdAt : Date.now()) + trashRetentionMs;
      operation.undo.expiresAt = new Date(expiresAt).toISOString();
    }
    return expiresAt;
  }

  function portableArtifactName(value) {
    const normalized = String(value || '').replace(/\\/g, '/');
    const name = path.posix.basename(normalized);
    return name && !['.', '..'].includes(name) && !name.includes('\0') ? name : '';
  }

  function artifactDirectory(kind) {
    return ({ upload: uploadsDir, thumbnail: thumbnailsDir, subtitle: subtitlesDir, voice: voiceDir, 'chat-image': chatImagesDir, compatible: compatibleMediaDir })[kind] || '';
  }

  function normalizeTrashArtifact(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const kind = ['upload', 'thumbnail', 'subtitle', 'voice', 'chat-image', 'compatible'].includes(entry.kind) ? entry.kind : '';
    const originalName = portableArtifactName(entry.originalName || entry.originalPath);
    const trashName = portableArtifactName(entry.trashName || entry.trashPath);
    return kind && artifactDirectory(kind) && originalName && trashName ? { kind, originalName, trashName } : null;
  }

  function trashArtifactPaths(entry) {
    const normalized = normalizeTrashArtifact(entry);
    if (!normalized) return null;
    return {
      ...normalized,
      originalPath: path.join(artifactDirectory(normalized.kind), normalized.originalName),
      trashPath: path.join(trashDir, normalized.trashName)
    };
  }

  function normalizeStoredTrashArtifacts() {
    for (const operation of state.operations) {
      if (!Array.isArray(operation?.undo?.artifacts)) continue;
      operation.undo.artifacts = operation.undo.artifacts.map(normalizeTrashArtifact).filter(Boolean);
    }
  }

  function trashArtifacts(undo) {
    return Array.isArray(undo?.artifacts) ? undo.artifacts.map(normalizeTrashArtifact).filter(Boolean) : [];
  }

  function operationUndoAvailable(operation, now = Date.now()) {
    if (!operation?.undo || operation.undone || operation.undoExpiredAt || undoExpiry(operation) <= now) return false;
    const artifacts = trashArtifacts(operation.undo);
    if (operation.undo.kind === 'file-delete') return artifacts.length > 0 && artifacts.every((entry) => fs.existsSync(trashArtifactPaths(entry).trashPath));
    if (operation.undo.kind === 'chat') {
      const voiceCount = new Set((operation.undo.messages || []).map((message) => message?.voiceUrl).filter(Boolean)).size;
      return voiceCount === 0 || (artifacts.length >= voiceCount && artifacts.every((entry) => fs.existsSync(trashArtifactPaths(entry).trashPath)));
    }
    return true;
  }

  function cleanupTrash(scheduleChanges = true) {
    const now = Date.now();
    const referenced = new Set();
    let changed = false;
    for (const operation of state.operations) {
      if (!trashBackedUndo(operation?.undo)) continue;
      const expiresAt = undoExpiry(operation);
      if (expiresAt <= now) {
        if (!operation.undoExpiredAt) {
          operation.undoExpiredAt = new Date(now).toISOString();
          changed = true;
        }
        for (const artifact of trashArtifacts(operation.undo)) {
          const filename = trashArtifactPaths(artifact)?.trashPath || '';
          try { if (filename && fs.existsSync(filename)) { fs.rmSync(filename, { force: true }); changed = true; } } catch (_) {}
        }
      } else if (!operation.undone) {
        for (const artifact of trashArtifacts(operation.undo)) {
          const filename = trashArtifactPaths(artifact)?.trashPath;
          if (filename) referenced.add(filename);
        }
      }
    }
    try {
      for (const entry of fs.readdirSync(trashDir, { withFileTypes: true })) {
        const filename = path.join(trashDir, entry.name);
        if (referenced.has(filename)) continue;
        fs.rmSync(filename, { recursive: entry.isDirectory(), force: true });
        changed = true;
      }
    } catch (_) {}
    if (changed && scheduleChanges) schedulePersist(0);
    return changed;
  }

  function removeFileArtifacts(file) {
    if (!file) return;
    for (const filename of fileArtifactPaths(file).map((entry) => entry.path)) {
      if (fs.existsSync(filename)) fs.unlinkSync(filename);
    }
  }

  function fileArtifactPaths(file) {
    if (!file) return [];
    return [
      file.storedName && { kind: 'upload', path: path.join(uploadsDir, file.storedName) },
      file.thumbnailName && { kind: 'thumbnail', path: path.join(thumbnailsDir, file.thumbnailName) },
      file.vttName && { kind: 'subtitle', path: path.join(subtitlesDir, file.vttName) },
      (file.compatibility?.fileName || mediaNeedsCompatibility(file)) && { kind: 'compatible', path: path.join(compatibleMediaDir, compatibilityFileName(file)) }
    ].filter(Boolean);
  }

  function moveArtifactsToTrash(entries, operationId) {
    const moved = [];
    try {
      for (const entry of entries || []) {
        if (!entry?.path || !fs.existsSync(entry.path)) continue;
        const trashPath = path.join(trashDir, `${operationId}-${entry.kind}-${path.basename(entry.path)}`);
        fs.renameSync(entry.path, trashPath);
        moved.push({ kind: entry.kind, originalName: portableArtifactName(entry.path), trashName: portableArtifactName(trashPath) });
      }
      return moved;
    } catch (error) {
      for (const entry of [...moved].reverse()) {
        const paths = trashArtifactPaths(entry);
        try { if (paths && fs.existsSync(paths.trashPath) && !fs.existsSync(paths.originalPath)) fs.renameSync(paths.trashPath, paths.originalPath); } catch (_) {}
      }
      throw error;
    }
  }

  function moveFileArtifactsToTrash(file, operationId) {
    return moveArtifactsToTrash(fileArtifactPaths(file), operationId);
  }

  function moveChatArtifactsToTrash(messages, operationId) {
    const seen = new Set();
    const entries = [];
    for (const message of messages || []) {
      for (const [urlValue, prefix, kind, directory] of [
        [message?.voiceUrl, '/voice/', 'voice', voiceDir],
        [message?.imageUrl, '/chat-image/', 'chat-image', chatImagesDir]
      ]) {
        const match = String(urlValue || '').match(new RegExp(`^${prefix.replace(/\//g, '\\/')}([^/?#]+)$`));
        if (!match) continue;
        const name = path.basename(decodeURIComponent(match[1]));
        const key = `${kind}:${name}`;
        if (!name || seen.has(key)) continue;
        seen.add(key);
        entries.push({ kind, path: path.join(directory, name) });
      }
    }
    return moveArtifactsToTrash(entries, operationId);
  }

  function restoreTrashArtifacts(moved) {
    for (const entry of moved || []) {
      const paths = trashArtifactPaths(entry);
      if (!paths || !fs.existsSync(paths.trashPath) || fs.existsSync(paths.originalPath)) return false;
    }
    const restored = [];
    try {
      for (const entry of moved || []) {
        const paths = trashArtifactPaths(entry);
        fs.renameSync(paths.trashPath, paths.originalPath);
        restored.push(entry);
      }
      return true;
    } catch (error) {
      let rollbackError = null;
      for (const entry of [...restored].reverse()) {
        const paths = trashArtifactPaths(entry);
        try {
          if (paths && fs.existsSync(paths.originalPath) && !fs.existsSync(paths.trashPath)) fs.renameSync(paths.originalPath, paths.trashPath);
        } catch (current) { rollbackError ||= current; }
      }
      if (rollbackError) throw new AggregateError([error, rollbackError], '回溯文件恢复失败，并且自动回滚未能完整完成');
      return false;
    }
  }

  function clearScreenFrameDelivery(runtime, socketId) {
    if (!runtime?.screenFrameDeliveries || !socketId) return;
    const delivery = runtime.screenFrameDeliveries.get(socketId);
    if (delivery) delivery.pending = null;
    runtime.screenFrameDeliveries.delete(socketId);
  }

  function clearScreenFrameDeliveries(runtime) {
    if (!runtime?.screenFrameDeliveries) return;
    for (const delivery of runtime.screenFrameDeliveries.values()) delivery.pending = null;
    runtime.screenFrameDeliveries.clear();
  }

  function screenFrameDeliveryAllowed(runtime, roomIdValue, targetSocket) {
    const share = runtime?.roomState?.screenShare;
    const member = targetSocket && users.get(targetSocket.id);
    return Boolean(!closing && share?.active && targetSocket?.connected && member?.roomId === roomIdValue
      && targetSocket.id !== share.socketId);
  }

  function flushScreenFrameDelivery(runtime, roomIdValue, targetSocket, delivery) {
    if (!runtime || !delivery || delivery.inFlight || !delivery.pending) return;
    if (!screenFrameDeliveryAllowed(runtime, roomIdValue, targetSocket)
      || delivery.generation !== runtime.screenFrameGeneration) {
      clearScreenFrameDelivery(runtime, targetSocket?.id);
      return;
    }
    const packet = delivery.pending;
    delivery.pending = null;
    delivery.inFlight = true;
    delivery.inFlightSequence = packet.sequence;
    targetSocket.timeout(screenFrameAckTimeoutMs).emit('screen-share-frame', packet, () => {
      const current = runtime.screenFrameDeliveries.get(targetSocket.id);
      if (current !== delivery || delivery.generation !== runtime.screenFrameGeneration
        || delivery.inFlightSequence !== packet.sequence) return;
      delivery.inFlight = false;
      delivery.inFlightSequence = 0;
      if (!screenFrameDeliveryAllowed(runtime, roomIdValue, targetSocket)) {
        clearScreenFrameDelivery(runtime, targetSocket.id);
        return;
      }
      if (delivery.pending) flushScreenFrameDelivery(runtime, roomIdValue, targetSocket, delivery);
      else runtime.screenFrameDeliveries.delete(targetSocket.id);
    });
  }

  function queueScreenFrameForSocket(roomIdValue, targetSocket, packet) {
    const id = normalizeRoomId(roomIdValue) || currentRoomId();
    const runtime = roomRuntime(id);
    if (!packet || !screenFrameDeliveryAllowed(runtime, id, targetSocket)) return false;
    let delivery = runtime.screenFrameDeliveries.get(targetSocket.id);
    if (!delivery || delivery.generation !== runtime.screenFrameGeneration) {
      delivery = { generation: runtime.screenFrameGeneration, inFlight: false, inFlightSequence: 0, pending: null };
      runtime.screenFrameDeliveries.set(targetSocket.id, delivery);
    }
    delivery.pending = packet;
    flushScreenFrameDelivery(runtime, id, targetSocket, delivery);
    return true;
  }

  function broadcastScreenFrame(roomIdValue, packet) {
    const id = normalizeRoomId(roomIdValue) || currentRoomId();
    const runtime = roomRuntime(id);
    for (const member of roomUsers(id)) {
      const targetSocket = io.sockets.sockets.get(member.socketId);
      if (member.socketId === runtime.roomState.screenShare.socketId || !targetSocket || runtime.screenWebrtcViewers.has(targetSocket.id)) continue;
      if (targetSocket) queueScreenFrameForSocket(id, targetSocket, packet);
    }
    return runtime.screenFrameDeliveries.size;
  }

  function emitScreenFallbackState(roomIdValue = '') {
    const id = normalizeRoomId(roomIdValue) || currentRoomId();
    const runtime = roomRuntime(id);
    const sharerSocketId = runtime.roomState.screenShare.socketId;
    if (!sharerSocketId) return 0;
    const fallbackViewerCount = roomUsers(id).filter((member) => member.socketId !== sharerSocketId
      && io.sockets.sockets.has(member.socketId) && !runtime.screenWebrtcViewers.has(member.socketId)).length;
    io.to(sharerSocketId).emit('screen-share-fallback-state', { fallbackViewerCount });
    return fallbackViewerCount;
  }

  function stopScreenShare(socketId = '', roomIdValue = '') {
    const id = normalizeRoomId(roomIdValue) || users.get(socketId)?.roomId || currentRoomId();
    const runtime = roomRuntime(id);
    if (!runtime.roomState.screenShare.active) {
      clearScreenFrameDeliveries(runtime);
      return false;
    }
    if (socketId && runtime.roomState.screenShare.socketId !== socketId) return false;
    const stoppedShare = runtime.roomState.screenShare;
    runtime.roomState.screenShare = { active: false, socketId: null, username: null };
    runtime.latestScreenFrame = null;
    runtime.screenFrameSequence = 0;
    runtime.screenFrameGeneration += 1;
    runtime.screenWebrtcViewers.clear();
    clearScreenFrameDeliveries(runtime);
    io.to(roomChannel(id)).emit('screen-share-stopped');
    if (runtime.roomState.webShare?.active && runtime.roomState.webShare.mode === 'live') {
      runtime.roomState.webShare = {
        active: false, mode: 'live', url: '', title: '', changedBy: stoppedShare.username || '',
        updatedAt: Date.now(), revision: Math.max(0, Number(runtime.roomState.webShare.revision) || 0) + 1
      };
      persist();
      io.to(roomChannel(id)).emit('web-share-state', { roomId: id, ...runtime.roomState.webShare, serverTime: Date.now() });
    }
    return true;
  }

  function sanitizeAudioSourceMetadata(payload = {}) {
    const sourceKind = ['process', 'window', 'screen', 'tab'].includes(payload.sourceKind) ? payload.sourceKind : '';
    return {
      sourceName: cleanText(payload.sourceName, 120),
      processName: cleanText(payload.processName, 80).replace(/[\\/]/g, ''),
      mediaTitle: cleanText(payload.mediaTitle || payload.sourceName, 160),
      sourceKind
    };
  }

  function stopAudioShare(socketId = '', roomIdValue = '') {
    const id = normalizeRoomId(roomIdValue) || users.get(socketId)?.roomId || currentRoomId();
    const runtime = roomRuntime(id);
    if (!runtime.roomState.audioShare?.active) return false;
    if (socketId && runtime.roomState.audioShare.socketId !== socketId) return false;
    runtime.roomState.audioShare = { active: false, socketId: null, username: null, displayName: '', platform: 'system', sourceName: '', processName: '', mediaTitle: '', sourceKind: '', volume: 0.8 };
    io.to(roomChannel(id)).emit('audio-share-state', { ...runtime.roomState.audioShare });
    return true;
  }

  function normalizeScreenFrame(frame, runtime = roomRuntime()) {
    let data = frame;
    let width = 0;
    let height = 0;
    if (frame && typeof frame === 'object' && !Buffer.isBuffer(frame) && !(frame instanceof ArrayBuffer) && !ArrayBuffer.isView(frame)) {
      data = frame.data;
      width = Math.max(0, Math.min(4096, Math.floor(Number(frame.width) || 0)));
      height = Math.max(0, Math.min(4096, Math.floor(Number(frame.height) || 0)));
    }
    if (typeof data === 'string') {
      if (!data.startsWith('data:image/jpeg;base64,') || Buffer.byteLength(data) > SCREEN_FRAME_LIMIT_BYTES) return null;
    } else if (Buffer.isBuffer(data)) {
      if (!data.length || data.length > SCREEN_FRAME_LIMIT_BYTES) return null;
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      data = Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength || undefined);
      if (!data.length || data.length > SCREEN_FRAME_LIMIT_BYTES) return null;
    } else return null;
    return { sequence: ++runtime.screenFrameSequence, width, height, mimeType: 'image/jpeg', data };
  }

  function removeOnlineUser(socketId, { scheduleClose = false, announceLeave = true, reason = 'left', occurredAt = Date.now() } = {}) {
    const user = users.get(socketId);
    if (!user) return;
    const account = state.accounts[user.username];
    if (account) {
      account.stats = { joinedRooms: 0, createdRooms: 0, watchSeconds: 0, onlineSeconds: 0, ...(account.stats || {}) };
      account.stats.onlineSeconds = Math.max(0, Number(account.stats.onlineSeconds) || 0)
        + Math.max(0, (Date.now() - Number(user.onlineStartedAt || Date.now())) / 1000);
      schedulePersist(0);
    }
    leaveLiveVoice(user, reason || 'disconnect');
    stopAudioShare(socketId, user.roomId);
    clearScreenFrameDelivery(roomRuntime(user.roomId), socketId);
    clearTimeout(disconnectTimers.get(socketId));
    disconnectTimers.delete(socketId);
    users.delete(socketId);
    if (!accountIsOnline(user.username)) broadcastAccountPresence(user.username, false);
    if (account?.guest && !accountIsOnline(user.username)) {
      const guestUsername = user.username;
      const guestIp = user.ipAddress || '';
      setImmediate(() => void purgeGuestAccount(guestUsername, guestIp).catch((error) => console.error('清理离线游客数据失败:', error.message)));
    }
    withRoom(user.roomId, () => {
      if (announceLeave) broadcastMemberPresence(user.roomId, user, 'leave', { reason, timestamp: occurredAt });
      io.to(roomChannel(user.roomId)).emit('user-left', publicUser(user));
      io.to(roomChannel(user.roomId)).emit('users-list', usersList(user.roomId));
      if (scheduleClose) scheduleEmptyRoomClose(user.roomId);
    });
    emitRoomDirectoryChanged(user.roomId, 'member-left');
    if (user.roomId) void deleteTemporaryRoomIfEmpty(user.roomId).catch((error) => console.error('清理临时房间失败:', error.message));
  }

  function scheduleDisconnectedUserRemoval(socketId, occurredAt = Date.now()) {
    const user = users.get(socketId);
    if (!user) return;
    clearTimeout(disconnectTimers.get(socketId));
    user.connectionState = 'reconnecting';
    user.disconnectedAt = new Date(occurredAt).toISOString();
    withRoom(user.roomId, () => io.to(roomChannel(user.roomId)).emit('users-list', usersList(user.roomId)));
    const timer = setTimeout(() => {
      const current = users.get(socketId);
      disconnectTimers.delete(socketId);
      if (!current || current.sessionToken !== user.sessionToken || current.connectionState !== 'reconnecting') return;
      removeOnlineUser(socketId, { scheduleClose: false, reason: 'disconnect-timeout', occurredAt });
    }, memberDisconnectGraceMs);
    timer.unref?.();
    disconnectTimers.set(socketId, timer);
  }

  async function resetServerDataInPlace() {
    acceptingMutations = false;
    analysisClosing = true;
    const connectedSockets = [...io.sockets.sockets.values()];
    for (const targetSocket of connectedSockets) targetSocket.emit('factory-reset', { message: '服务器已恢复出厂设置，请使用初始账号重新登录' });
    for (const timer of disconnectTimers.values()) clearTimeout(timer);
    for (const timer of emptyRoomTimers.values()) clearTimeout(timer);
    disconnectTimers.clear(); emptyRoomTimers.clear(); pendingVoiceCalls.clear();
    mediaAnalysisQueue.length = 0; mediaCompatibilityQueue.length = 0;
    for (const child of [...mediaAnalysisProcesses, ...mediaCompatibilityProcesses]) terminateProcessTree(child, true);
    await settleWithin(Promise.allSettled([...mediaAnalysisJobs, ...mediaCompatibilityJobs, ...mailDeliveryJobs]), closeFinalTimeoutMs);
    try { mailTransportCache?.close?.(); } catch (_) {}
    mailTransportCache = null; mailKeyCache = null;
    try { await Promise.resolve(tunnelManager?.stop?.()); } catch (_) {}
    forgetTunnelUrl(); tunnelPolicyLocked = false;
    if (persistTimer) clearTimeout(persistTimer);
    if (chatFlushTimer) clearTimeout(chatFlushTimer);
    persistTimer = null; chatFlushTimer = null; pendingChatLines = [];
    await chatWriteChain.catch(() => {});
    sessions.clear(); users.clear(); guestSessionsByIp.clear(); guestSessionRecords.clear(); rateBuckets.clear(); registrationClaims.clear(); roomCreateClaims.clear(); verifiedRegistrationAllowances.clear();
    passwordResetCodes.clear(); passwordResetTokens.clear(); emailBindingCodes.clear(); emailUnbindingCodes.clear(); registrationEmailCodes.clear(); roomRuntimes.clear(); qualityBroadcastRooms.clear(); qualityChangeRequests.clear();
    chatMessages.length = 0; chatRoomWindowCounts.clear(); chatParticipants.clear();

    const lockName = path.basename(dataDirectoryLock.path);
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (entry.name === lockName) continue;
      fs.rmSync(path.join(dataDir, entry.name), { recursive: true, force: true });
    }
    for (const dir of [uploadsDir, thumbnailsDir, subtitlesDir, voiceDir, chatImagesDir, avatarsDir, loginCubeDir, loginCubeModelDir, loginMusicDir, loginVideoDir, compatibleMediaDir, downloadAssetsDir, downloadAssetTemporaryDir, trashDir, secretsDir]) fs.mkdirSync(dir, { recursive: true });
    const resetState = freshState();
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, resetState);
    roomRuntime(state.defaultRoomId);
    atomicWriteJson(stateFile, state);
    writeDataDirectoryGuide(dataDir);
    analysisClosing = false;
    acceptingMutations = true;
    setImmediate(() => connectedSockets.forEach((targetSocket) => targetSocket.connected && targetSocket.disconnect(true)));
  }

  function revokeUserSessions(username, eventName = '', message = '') {
    for (const [token, session] of sessions) if (session.username === username) sessions.delete(token);
    for (const member of [...users.values()]) {
      if (member.username !== username) continue;
      const targetSocket = io.sockets.sockets.get(member.socketId);
      if (eventName) targetSocket?.emit(eventName, message);
      stopScreenShare(member.socketId);
      removeOnlineUser(member.socketId);
      targetSocket?.disconnect(true);
    }
  }

  function clearAdminVerification(verifiedSession = null) {
    for (const activeSession of sessions.values()) delete activeSession.adminVerifiedAt;
    if (verifiedSession) verifiedSession.adminVerifiedAt = Date.now();
  }

  function revokeIpSessions(ipAddress, eventName = '', message = '') {
    for (const [token, session] of sessions) if (session.ipAddress === ipAddress) sessions.delete(token);
    for (const member of [...users.values()]) {
      if (member.ipAddress !== ipAddress) continue;
      const targetSocket = io.sockets.sockets.get(member.socketId);
      if (eventName) targetSocket?.emit(eventName, message);
      stopScreenShare(member.socketId);
      removeOnlineUser(member.socketId);
      targetSocket?.disconnect(true);
    }
  }

  function mediaCollectionName(file) {
    const explicit = cleanText(file?.collection || '', 80).replace(/[\\/]/g, '').trim();
    if (explicit) return explicit;
    const normalizedPath = cleanText(file?.relativePath, 500).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return normalizedPath.includes('/') ? normalizedPath.split('/')[0] : '未分类';
  }

  function publicFile(file) {
    const compatibility = mediaCompatibilitySummary(file);
    const remote = file?.sourceType === 'remote' && /^https:\/\/[^\s]+$/i.test(String(file.sourceUrl || ''));
    const originalUrl = remote ? String(file.sourceUrl) : `/media/${encodeURIComponent(file.storedName)}`;
    const normalizedPath = cleanText(file.relativePath, 500).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const collection = mediaCollectionName(file);
    return {
      id: file.id, originalName: file.originalName, storedName: file.storedName, size: file.size,
      mimeType: file.mimeType, category: file.category, uploadedAt: file.uploadedAt, uploadedBy: file.uploadedBy,
      uploadedByName: state.accounts[file.uploadedBy]?.displayName || file.uploadedBy,
      roomId: file.roomId, relativePath: normalizedPath, collection, note: cleanText(file.note, 500),
      status: file.status, metadata: file.metadata || {}, subtitleVideoId: file.subtitleVideoId || '', compatibility,
      sourceType: remote ? 'remote' : 'local', sourceUrl: remote ? String(file.sourceUrl) : '',
      url: !remote && compatibility.ready && compatibility.required ? `/compatible-media/${encodeURIComponent(compatibility.fileName)}` : originalUrl,
      originalUrl, downloadUrl: remote ? '' : `/api/files/${encodeURIComponent(file.id)}/download`,
      thumbnailUrl: mediaThumbnailAvailable(file) ? `/thumbnail/${encodeURIComponent(file.thumbnailName)}` : String(file.thumbnailUrl || ''),
      subtitleUrl: file.vttName ? `/subtitle/${encodeURIComponent(file.vttName)}` : ''
    };
  }

  function canSeeFile(session, file) {
    const sessionRoomId = normalizeRoomId(session?.roomId);
    if (!sessionRoomId || file.roomId !== sessionRoomId) return false;
    const room = roomConfig(file.roomId);
    return file.status === 'approved' || session.username === room.ownerUsername || session.username === file.uploadedBy;
  }

  function emitFileToVisible(eventName, file) {
    const visible = publicFile(file);
    for (const user of users.values()) {
      // Uploaders keep a live "My videos" view even while they are visiting a
      // different room. The normal media URLs remain protected by the room
      // session checks; this event only refreshes the uploader's own metadata.
      if (canSeeFile(user, file) || user.username === file.uploadedBy) io.to(user.socketId).emit(eventName, visible);
    }
    emitMediaProcessingSnapshots();
  }

  function mediaProcessingSnapshot(user, session = validSession(user?.sessionToken, false)) {
    const canConfigure = Boolean(user && session
      && (session.isServerHost || session.adminVerifiedAt || isSuperAdmin(user.username)));
    const dismissedIds = new Set(Array.isArray(state.accounts[user?.username]?.mediaProcessingDismissed)
      ? state.accounts[user.username].mediaProcessingDismissed.map((id) => cleanText(id, 80)).filter(Boolean) : []);
    const source = state.files.filter((file) => file.category === 'video'
      && (canConfigure || file.uploadedBy === user?.username || canSeeFile(user, file)));
    const visibleSource = source.filter((file) => {
      const compatibility = mediaCompatibilitySummary(file);
      const active = ['queued', 'converting'].includes(compatibility.status);
      return active || !dismissedIds.has(file.id);
    });
    const sourceIds = new Set(visibleSource.map((file) => file.id));
    const tasks = visibleSource.map((file) => ({
      id: file.id,
      originalName: file.originalName,
      roomId: file.roomId,
      uploadedBy: file.uploadedBy,
      uploadedAt: file.uploadedAt,
      compatibility: mediaCompatibilitySummary(file)
    })).sort((left, right) => {
      const rank = { converting: 0, queued: 1, manual: 2, failed: 3, unavailable: 4, ready: 5, native: 6 };
      const leftRank = rank[left.compatibility.status] ?? 6;
      const rightRank = rank[right.compatibility.status] ?? 6;
      return leftRank - rightRank || String(right.uploadedAt || '').localeCompare(String(left.uploadedAt || ''));
    });
    const counts = { total: tasks.length, converting: 0, queued: 0, manual: 0, completed: 0, failed: 0, unavailable: 0, native: 0 };
    for (const task of tasks) {
      const compatibility = task.compatibility || {};
      if (!compatibility.required || compatibility.status === 'native') counts.native += 1;
      else if (compatibility.ready || compatibility.status === 'ready') counts.completed += 1;
      else if (compatibility.status === 'converting') counts.converting += 1;
      else if (compatibility.status === 'manual') counts.manual += 1;
      else if (compatibility.status === 'failed') counts.failed += 1;
      else if (compatibility.status === 'unavailable') counts.unavailable += 1;
      else counts.queued += 1;
    }
    return {
      autoConvert: mediaCompatibilityAutoConvert(),
      concurrency: mediaCompatibilityConcurrency(),
      maximumConcurrency: MAX_MEDIA_COMPATIBILITY_CONCURRENCY,
      active: [...mediaCompatibilityJobs].filter((job) => sourceIds.has(job.record?.id)).length,
      waiting: mediaCompatibilityQueue.filter((record) => sourceIds.has(record?.id)).length,
      canConfigure,
      counts,
      tasks,
      updatedAt: new Date().toISOString()
    };
  }

  function emitMediaProcessingSnapshots() {
    for (const user of users.values()) {
      const session = validSession(user.sessionToken, false);
      if (session) io.to(user.socketId).emit('media-processing-updated', mediaProcessingSnapshot(user, session));
    }
  }

  function publicMemberLocation(location, includeCoordinates = false) {
    const source = location && typeof location === 'object' ? location : {};
    return {
      status: cleanText(source.status || '未授权位置', 40),
      country: cleanText(source.country, 80), province: cleanText(source.province, 80), city: cleanText(source.city, 80),
      district: cleanText(source.district, 80), street: cleanText(source.street, 120),
      accuracy: includeCoordinates && source.accuracy !== null && source.accuracy !== '' && Number.isFinite(Number(source.accuracy)) ? Number(source.accuracy) : null,
      latitude: includeCoordinates && source.latitude !== null && source.latitude !== '' && Number.isFinite(Number(source.latitude)) ? Number(source.latitude) : null,
      longitude: includeCoordinates && source.longitude !== null && source.longitude !== '' && Number.isFinite(Number(source.longitude)) ? Number(source.longitude) : null,
      updatedAt: cleanText(source.updatedAt, 60)
    };
  }

  function cumulativeOnlineSeconds(username, account = state.accounts[username]) {
    if (!account) return 0;
    const stored = Math.max(0, Number(account.stats?.onlineSeconds) || 0);
    const active = [...users.values()]
      .filter((entry) => entry.username === username && entry.onlineStartedAt)
      .reduce((sum, entry) => sum + Math.max(0, (Date.now() - Number(entry.onlineStartedAt)) / 1000), 0);
    return Math.floor(stored + active);
  }

  function registrationDays(account) {
    const createdAt = Date.parse(String(account?.createdAt || ''));
    return Number.isFinite(createdAt) ? Math.max(0, Math.floor((Date.now() - createdAt) / 86400000)) : 0;
  }

  function publicUser(user) {
    const room = roomConfig(user.roomId);
    const account = state.accounts[user.username];
    const level = watchLevelSummary(account || {});
    const permissions = permissionFor(user.username, user.roomId);
    const specialGroupNames = { 'super-admin': '超级管理员', 'server-host': '服务器主机', owner: '房主', administrator: '管理员' };
    const configuredGroup = room.permissionGroups?.[permissions.groupId] || defaultPermissionGroups()[permissions.groupId];
    const permissionGroup = {
      id: permissions.groupId || 'member',
      name: configuredGroup?.name || specialGroupNames[permissions.groupId] || permissions.groupId || '成员',
      permissions: {
        control: Boolean(permissions.control), seek: Boolean(permissions.seek), upload: Boolean(permissions.upload), delete: Boolean(permissions.delete), manageMedia: Boolean(permissions.manageMedia),
        shareScreen: Boolean(permissions.shareScreen), shareAudio: Boolean(permissions.shareAudio), shareWeb: Boolean(permissions.shareWeb), voiceChat: Boolean(permissions.voiceChat),
        manageChat: Boolean(permissions.manageChat), manageRoom: Boolean(permissions.manageRoom), skipSettings: Boolean(permissions.skipSettings), sendNotice: Boolean(permissions.sendNotice)
      }
    };
    return {
      socketId: user.socketId, username: user.username, displayName: account?.displayName || user.username, avatar: account?.avatar || '', roomId: user.roomId, deviceName: user.deviceName,
      platform: user.platform, browser: user.browser, joinedAt: user.joinedAt, onlineStartedAt: user.onlineStartedAt || null,
      isOwner: user.username === room.ownerUsername, isAdmin: isRoomAdmin(user), isSuperAdmin: Boolean(account?.superAdmin),
      guest: Boolean(account?.guest),
      permissions, permissionGroup, voiceMode: user.voiceMode || '',
      latency: user.latency ?? null, syncPercent: user.syncPercent ?? 100, playbackQuality: user.playbackQuality || 'original', location: publicMemberLocation(user.location),
      level: level.level, levelName: level.levelName, experience: level.experience, progressPercent: level.progressPercent,
      currentLevelExperience: level.currentLevelExperience, experienceToNext: level.experienceToNext, nextLevelExperience: level.nextLevelExperience,
      registrationDays: registrationDays(account), onlineSeconds: cumulativeOnlineSeconds(user.username, account),
      profile: { id: account?.id || '', signature: account?.signature || '', gender: account?.gender || 'private', age: account?.age || null, createdAt: account?.createdAt || '' },
      drift: user.drift ?? 0, connectionState: user.connectionState || 'online'
    };
  }

  function passwordPolicyError(password, { administrator = false } = {}) {
    const value = String(password ?? '');
    const policy = normalizePasswordPolicy(state.admin.passwordPolicy);
    if (!value) return '请输入密码';
    if (Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_UTF8_BYTES) {
      return `密码不能超过 ${PASSWORD_MAX_UTF8_BYTES} 个 UTF-8 字节（仅用于防止异常超大请求）`;
    }
    const minimum = administrator ? Math.max(8, policy.lengthRestricted ? policy.minLength : 1) : policy.minLength;
    const length = Array.from(value).length;
    if (administrator && length < minimum) return `管理员密码至少需要 ${minimum} 位`;
    if (policy.lengthRestricted && (length < minimum || length > policy.maxLength)) {
      return `密码长度需为 ${minimum}-${policy.maxLength} 位`;
    }
    const patterns = {
      chinese: /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ebef}\u{30000}-\u{323af}]+$/u,
      english: /^[A-Za-z]+$/,
      digits: /^\d+$/,
      chinese_english: /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ebef}\u{30000}-\u{323af}A-Za-z]+$/u,
      chinese_digits: /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ebef}\u{30000}-\u{323af}\d]+$/u,
      english_digits: /^[A-Za-z\d]+$/,
      chinese_english_digits: /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ebef}\u{30000}-\u{323af}A-Za-z\d]+$/u
    };
    const labels = {
      chinese: '只能使用中文字符', english: '只能使用英文字母', digits: '只能使用数字',
      chinese_english: '只能使用中文和英文字母', chinese_digits: '只能使用中文和数字',
      english_digits: '只能使用英文字母和数字', chinese_english_digits: '只能使用中文、英文字母和数字'
    };
    if (policy.mode !== 'unrestricted' && !patterns[policy.mode]?.test(value)) return `密码${labels[policy.mode] || '不符合服务器规则'}`;
    return '';
  }

  function passwordExpired(username, { adminSecret = false } = {}) {
    const policy = normalizePasswordPolicy(state.admin.passwordPolicy);
    if (!policy.expiryDays) return false;
    const account = state.accounts[username];
    const changedAt = adminSecret
      ? (state.admin.passwordChangedAt || account?.passwordChangedAt || account?.createdAt)
      : (account?.passwordChangedAt || account?.createdAt);
    const timestamp = Date.parse(String(changedAt || ''));
    if (!Number.isFinite(timestamp)) return true;
    return Date.now() - timestamp >= policy.expiryDays * 24 * 60 * 60 * 1000;
  }

  function ownedRooms(username) {
    return Object.values(state.rooms).filter((room) => room.ownerUsername === username && visibleRoom(room));
  }

  function roomStorageSummary(roomIdValue) {
    const id = normalizeRoomId(roomIdValue);
    const files = state.files.filter((file) => file.roomId === id);
    let originalBytes = 0;
    let compatibilityBytes = 0;
    let auxiliaryBytes = 0;
    for (const file of files) {
      const artifacts = fileArtifactPaths(file);
      let originalFound = false;
      for (const artifact of artifacts) {
        try {
          const stats = fs.statSync(artifact.path);
          if (!stats.isFile()) continue;
          if (artifact.kind === 'upload') { originalBytes += stats.size; originalFound = true; }
          else if (artifact.kind === 'compatible') compatibilityBytes += stats.size;
          else auxiliaryBytes += stats.size;
        } catch (_) {}
      }
      if (!originalFound) originalBytes += Math.max(0, Number(file.size) || 0);
    }
    let disk = { totalBytes: 0, freeBytes: 0, usedBytes: 0 };
    try {
      const root = path.parse(mediaRoot).root || mediaRoot;
      const stat = typeof fs.statfsSync === 'function' ? fs.statfsSync(root) : null;
      if (stat?.bsize && stat.blocks) {
        disk.totalBytes = Number(stat.blocks) * Number(stat.bsize);
        disk.freeBytes = Number(stat.bavail ?? stat.bfree ?? 0) * Number(stat.bsize);
        disk.usedBytes = Math.max(0, disk.totalBytes - disk.freeBytes);
      }
    } catch (_) {}
    const limitBytes = Math.max(0, Math.min(MAX_ROOM_STORAGE_LIMIT_BYTES, Math.floor(Number(state.rooms[id]?.storageLimitBytes) || 0)));
    return {
      totalBytes: originalBytes + compatibilityBytes + auxiliaryBytes,
      originalBytes, compatibilityBytes, auxiliaryBytes,
      limitBytes, remainingBytes: limitBytes ? Math.max(0, limitBytes - originalBytes) : null,
      fileCount: files.length, videoCount: files.filter((file) => file.category === 'video').length,
      diskTotalBytes: disk.totalBytes, diskFreeBytes: disk.freeBytes, diskUsedBytes: disk.usedBytes
    };
  }

  function effectiveRoomEntryNotice(roomIdValue = currentRoomId()) {
    const room = roomConfig(roomIdValue);
    const roomOverride = room.entryNotice && typeof room.entryNotice === 'object'
      ? normalizeRoomEntryNotice(room.entryNotice) : null;
    return {
      ...(roomOverride || normalizeRoomEntryNotice(state.admin.roomEntryNotice)),
      scope: roomOverride ? 'room' : 'global',
      roomId: room.id
    };
  }

  function roomDirectorySummary(room, username = '') {
    if (!room) return null;
    const runtime = roomRuntime(room.id);
    const playback = playbackSnapshot(room.id);
    const playingFile = findFile(playback.fileId);
    const ownerAccount = state.accounts[room.ownerUsername];
    return {
      id: room.id, name: room.name, ownerUsername: room.ownerUsername,
      ownerName: ownerAccount?.displayName || room.ownerUsername,
      ownerRemark: cleanText(ownerAccount?.roomMeta?.[room.id]?.note, 120),
      owned: Boolean(username && room.ownerUsername === username),
      online: roomUsers(room.id).length, maxUsers: room.maxUsers,
      passwordRequired: Boolean(room.passwordHash), temporary: Boolean(room.temporary), allowGuests: room.allowGuests !== false,
      passwordEnforcementRequired: Boolean(room.passwordEnforcementRequired && !room.passwordHash),
      banned: Boolean(room.banned), banReason: room.banReason || '', closed: Boolean(room.closed), archived: Boolean(room.archived),
      createdAt: room.createdAt, lastActivityAt: room.lastActivityAt || room.createdAt,
      storage: roomStorageSummary(room.id),
      playback: { ...playback, fileName: playingFile?.originalName || '' },
      members: usersList(room.id).map((member) => ({
        socketId: member.socketId, username: member.username, displayName: member.displayName, deviceName: member.deviceName,
        platform: member.platform, browser: member.browser, isOwner: member.isOwner, isAdmin: member.isAdmin, isSuperAdmin: member.isSuperAdmin,
        latency: member.latency, connectionState: member.connectionState, playbackQuality: member.playbackQuality
      })),
      screenShare: { ...runtime.roomState.screenShare }
    };
  }

  function emitRoomDirectoryChanged(roomIdValue, reason = 'updated') {
    const id = normalizeRoomId(roomIdValue);
    const room = id && state.rooms[id];
    const update = {
      roomId: id || '', reason: cleanText(reason, 40),
      room: visibleRoom(room) ? roomDirectorySummary(room) : null,
      updatedAt: new Date().toISOString()
    };
    for (const member of users.values()) {
      const account = state.accounts[member.username];
      const session = sessions.get(member.sessionToken);
      const canSee = !room || room.ownerUsername === member.username || member.roomId === id
        || account?.recentRooms?.includes(id) || account?.pinnedRooms?.includes(id)
        || account?.superAdmin || session?.isServerHost || session?.adminVerifiedAt;
      if (canSee) io.to(member.socketId).emit('room-directory-updated', update);
    }
  }

  function rememberRecentRoom(username, roomIdValue) {
    const account = state.accounts[username];
    const id = normalizeRoomId(roomIdValue);
    if (!account || !id || !visibleRoom(state.rooms[id])) return;
    account.recentRooms = [id, ...(Array.isArray(account.recentRooms) ? account.recentRooms : []).filter((entry) => entry !== id)].slice(0, 20);
    account.roomVisitCounts = account.roomVisitCounts && typeof account.roomVisitCounts === 'object' ? account.roomVisitCounts : {};
    account.roomVisitCounts[id] = Math.max(0, Math.floor(Number(account.roomVisitCounts[id]) || 0)) + 1;
  }

  function accountHasRoomAccess(username, room) {
    const account = state.accounts[username];
    if (!account || !room) return false;
    return canBypassRoomPassword(username, room) || !room.passwordHash
      || Number(account.roomAccessGrants?.[room.id]) === Number(room.accessRevision);
  }

  // Room administrators inherit the same password bypass as the server
  // administrator and room owner. This keeps login, room switching and HTTP
  // session checks consistent instead of prompting only one of those paths.
  function canBypassRoomPassword(username, room) {
    if (!username || !room) return false;
    if (isSuperAdmin(username) || room.ownerUsername === username) return true;
    return Boolean(permissionFor(username, room.id).administrator);
  }

  function rememberRoomAccess(username, room) {
    const account = state.accounts[username];
    if (!account || !room) return;
    account.roomAccessGrants = account.roomAccessGrants && typeof account.roomAccessGrants === 'object' ? account.roomAccessGrants : {};
    account.roomAccessGrants[room.id] = room.accessRevision;
  }

  function roomListForAccount(username) {
    const account = state.accounts[username];
    if (!account) return [];
    const ownedIds = new Set(ownedRooms(username).map((room) => room.id));
    const pinnedIds = (account.pinnedRooms || []).filter((id) => visibleRoom(state.rooms[id]));
    const orderedIds = [...new Set([...pinnedIds, ...ownedIds, ...(account.recentRooms || [])])];
    return orderedIds.map((id) => state.rooms[id]).filter(visibleRoom).map((room) => ({
      ...roomDirectorySummary(room, username),
      accessRemembered: accountHasRoomAccess(username, room), pinned: pinnedIds.includes(room.id),
      visitCount: Math.max(0, Math.floor(Number(account.roomVisitCounts?.[room.id]) || 0)),
      note: cleanText(account.roomMeta?.[room.id]?.note, 500), category: cleanText(account.roomMeta?.[room.id]?.category || '未分类', 80) || '未分类'
    })).sort((left, right) => Number(right.visitCount || 0) - Number(left.visitCount || 0)
      || Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
      || String(left.name || left.id).localeCompare(String(right.name || right.id), 'zh-CN'));
  }

  function agreementAccepted(username) {
    const agreement = normalizeLegalAgreement(state.admin.legalAgreement);
    return state.accounts[username]?.acceptedAgreementVersion === agreement.version;
  }

  function concurrentLoginAllowed(username) {
    const account = state.accounts[username];
    return Boolean(account && accountSessionLimit(username) > 1);
  }

  function loginPolicy() {
    const normalized = normalizeLoginPolicy(state.admin.loginPolicy);
    state.admin.loginPolicy = normalized;
    return normalized;
  }

  function accountSessionLimit(username) {
    const normalized = cleanUsername(username);
    if (!normalized) return 1;
    if (normalized === 'admin') return adminSessionLimit();
    const account = state.accounts[normalized];
    if (!account) return 1;
    const override = Math.floor(Number(account.loginSessionLimit) || 0);
    return Math.max(1, Math.min(20, override || loginPolicy().accountSessionLimit));
  }

  function activeAccountSessions(username, exceptToken = '') {
    // A disconnected socket remains resumable during the short reconnect
    // grace period, but it is no longer an active device for the login limit.
    // Count attached, connected users only so an explicit disconnect can log
    // back in immediately without waiting for the grace timer.
    return [...users.values()].filter((member) => member.username === username
      && member.sessionToken !== exceptToken
      && member.connectionState === 'online'
      && io.sockets.sockets.get(member.socketId)?.connected !== false
      && validSession(member.sessionToken, false)).length;
  }

  function accountIpWhitelisted(username, ipAddress) {
    const policy = loginPolicy();
    return policy.accountSessionWhitelistIps.includes(normalizeIp(ipAddress));
  }

  function guestIpWhitelisted(ipAddress) {
    return loginPolicy().guestIpWhitelistIps.includes(normalizeIp(ipAddress));
  }

  function guestSessionsForIp(ipAddress) {
    const ip = normalizeIp(ipAddress);
    return [...users.values()].filter((member) => member.ipAddress === ip
      && state.accounts[member.username]?.guest
      && member.connectionState === 'online'
      && io.sockets.sockets.get(member.socketId)?.connected !== false
      && validSession(member.sessionToken, false));
  }

  function recordAccessAttempt(entry = {}) {
    const record = {
      id: crypto.randomUUID(), timestamp: new Date().toISOString(),
      ipAddress: normalizeIp(entry.ipAddress), username: cleanUsername(entry.username),
      deviceName: cleanText(entry.deviceName, 80), platform: cleanText(entry.platform, 40),
      browser: cleanText(entry.browser, 40), action: cleanText(entry.action, 40),
      result: cleanText(entry.result, 40), message: cleanText(entry.message, 240)
    };
    state.admin.accessRecords = Array.isArray(state.admin.accessRecords) ? state.admin.accessRecords : [];
    state.admin.accessRecords.push(record);
    state.admin.accessRecords = state.admin.accessRecords.slice(-5000);
    return record;
  }

  function concurrencyError(username, ipAddress, exceptToken = '') {
    if (cleanUsername(username) === 'admin') return null;
    if (accountIpWhitelisted(username, ipAddress)) return null;
    const limit = accountSessionLimit(username);
    const active = activeAccountSessions(username, exceptToken);
    if (active < limit) return null;
    return { success: false, code: 'LOGIN_CONCURRENCY_LIMIT', canRequest: true, username,
      activeSessions: active, sessionLimit: limit,
      error: `该账号当前已有 ${active} 台设备在线（另一台设备已登录），服务器限制为 ${limit} 台；可提交并发登录申请` };
  }

  function accountTier(username) {
    const account = state.accounts[username];
    if (!account) return defaultAccountTiers().basic;
    if (account.superAdmin || username === 'admin') return state.admin.accountTiers?.s_node || defaultAccountTiers().s_node;
    return state.admin.accountTiers?.[account.tierId] || defaultAccountTiers().basic;
  }

  function uploadLimitForAccount(username) {
    if (state.accounts[username]?.superAdmin || username === 'admin') return HARD_MEDIA_UPLOAD_LIMIT_BYTES;
    const tierLimit = Math.max(0, Number(accountTier(username).uploadLimitBytes) || DEFAULT_USER_UPLOAD_LIMIT_BYTES);
    const serverLimit = Math.max(0, Number(state.admin.uploadLimitBytes) || 0);
    const effective = serverLimit > 0 ? Math.min(serverLimit, tierLimit) : tierLimit;
    return Math.min(HARD_MEDIA_UPLOAD_LIMIT_BYTES, effective || HARD_MEDIA_UPLOAD_LIMIT_BYTES);
  }

  function uploadPolicyExempt(session) {
    if (!session?.username) return false;
    if (session.isServerHost || session.username === 'admin' || state.accounts[session.username]?.superAdmin) return true;
    const onlineUser = users.get(session.socketId);
    return Boolean(onlineUser && onlineUser.username === session.username && isRoomAdmin(onlineUser));
  }

  function allowedUploadCategories() {
    const normalized = normalizeAllowedUploadCategories(state.admin.allowedUploadCategories);
    if (JSON.stringify(normalized) !== JSON.stringify(state.admin.allowedUploadCategories)) state.admin.allowedUploadCategories = normalized;
    return normalized;
  }

  function uploadCategoryAllowed(category) {
    return allowedUploadCategories().includes(cleanText(category, 32).toLowerCase());
  }

  function blockedWordMatch(value) {
    return findBlockedWord(value, state.admin.blockedWords);
  }

  function friendNotificationsMuted(account, friendUsername) {
    if (!normalizeFriendSettings(account?.friendSettings).messageNotifications) return true;
    const until = Date.parse(String(account?.friendMeta?.[friendUsername]?.muteUntil || ''));
    return Number.isFinite(until) && until > Date.now();
  }

  function friendRoomStatus(viewerUsername, friendUsername) {
    const member = accountOnlineMembers(friendUsername)[0];
    const room = member && state.rooms[member.roomId];
    if (!member || !room) return null;
    const friendAccount = state.accounts[friendUsername];
    return {
      id: room.id, name: room.name, ownerUsername: room.ownerUsername,
      ownerName: state.accounts[room.ownerUsername]?.displayName || room.ownerUsername,
      ownedByFriend: room.ownerUsername === friendUsername, temporary: Boolean(room.temporary),
      directJoinAllowed: room.ownerUsername === friendUsername
        && normalizeFriendSettings(friendAccount?.friendSettings).allowPasswordlessOwnRoomJoin === true,
      viewerAlreadyInside: accountOnlineMembers(viewerUsername).some((entry) => entry.roomId === room.id)
    };
  }

  function friendMessagePreview(message) {
    return cleanText(message?.text || (message?.type === 'image' ? '[图片]' : ''), 120);
  }

  function friendUnreadNotifications(username) {
    const account = state.accounts[username];
    if (!account || !normalizeFriendSettings(account.friendSettings).messageNotifications) return [];
    const latest = new Map();
    for (const message of account.friendMessages || []) {
      if (message.to !== username || message.readAt || friendNotificationsMuted(account, message.from)) continue;
      latest.set(message.from, message);
    }
    return [...latest.values()].map((message) => ({
      id: message.id, kind: 'friend-message', username: message.from,
      displayName: state.accounts[message.from]?.displayName || message.from,
      message: friendMessagePreview(message), timestamp: message.timestamp
    }));
  }

  function storeFriendMessage(fromUsername, toUsername, input = {}) {
    const from = state.accounts[fromUsername];
    const to = state.accounts[toUsername];
    if (!from || !to || !from.friends?.includes(toUsername) || !to.friends?.includes(fromUsername)) {
      return { success: false, error: '只能向好友发送消息' };
    }
    const type = input.type === 'image' ? 'image' : 'text';
    const text = cleanText(input.text, 500);
    const imageUrl = type === 'image' ? cleanText(input.imageUrl, 500) : '';
    if (!text && !imageUrl) return { success: false, error: '消息不能为空' };
    const blockedWord = blockedWordMatch(text);
    if (blockedWord) return { success: false, code: 'BLOCKED_WORD', blockedWord, error: `消息包含服务器屏蔽词“${blockedWord}”，请修改后再发送` };
    let replyTo = null;
    const replyToId = cleanText(input.replyToId, 80);
    if (replyToId) {
      const source = (from.friendMessages || []).find((entry) => entry.id === replyToId
        && ((entry.from === fromUsername && entry.to === toUsername) || (entry.from === toUsername && entry.to === fromUsername)));
      if (!source) return { success: false, error: '引用的消息不存在或已被删除' };
      replyTo = { id: source.id, from: source.from, fromName: source.fromName || state.accounts[source.from]?.displayName || source.from, type: source.type || 'text', text: friendMessagePreview(source) };
    }
    const online = accountIsOnline(toUsername);
    const message = {
      id: crypto.randomUUID(), from: fromUsername, to: toUsername,
      fromName: from.displayName || fromUsername, toName: to.displayName || toUsername,
      type, text, imageUrl, imageName: type === 'image' ? normalizeOriginalName(input.imageName || '图片') : '',
      replyTo, timestamp: new Date().toISOString(), deliveredAt: online ? new Date().toISOString() : '', readAt: ''
    };
    from.friendMessages.push(message); from.friendMessages = from.friendMessages.slice(-1000);
    to.friendMessages.push({ ...message, replyTo: replyTo ? { ...replyTo } : null }); to.friendMessages = to.friendMessages.slice(-1000);
    to.friendMeta = to.friendMeta && typeof to.friendMeta === 'object' ? to.friendMeta : {};
    to.friendMeta[fromUsername] = {
      ...(to.friendMeta[fromUsername] || {}),
      unread: Math.max(0, Number(to.friendMeta[fromUsername]?.unread) || 0) + 1,
      group: to.friendMeta[fromUsername]?.group || '我的好友'
    };
    persist();
    const notificationMuted = friendNotificationsMuted(to, fromUsername);
    const floatingNoticeMuted = to.friendMeta?.[fromUsername]?.floatingNotice === false;
    for (const member of accountOnlineMembers(toUsername)) {
      io.to(member.socketId).emit('friend-message', { ...message, notificationMuted, floatingNoticeMuted });
    }
    return { success: true, message };
  }

  function markFriendMessagesRead(readerUsername, friendUsername) {
    const reader = state.accounts[readerUsername];
    const friend = state.accounts[friendUsername];
    if (!reader || !friend || !reader.friends?.includes(friendUsername)) return { ids: [], readAt: '' };
    const readAt = new Date().toISOString();
    const ids = (reader.friendMessages || [])
      .filter((message) => message.from === friendUsername && message.to === readerUsername && !message.readAt)
      .map((message) => message.id);
    if (!ids.length) {
      const previousUnread = Math.max(0, Number(reader.friendMeta[friendUsername]?.unread) || 0);
      reader.friendMeta[friendUsername] = { ...(reader.friendMeta[friendUsername] || {}), unread: 0 };
      if (previousUnread) persist();
      return { ids, readAt: '' };
    }
    const idSet = new Set(ids);
    for (const owner of [reader, friend]) for (const message of owner.friendMessages || []) if (idSet.has(message.id)) message.readAt = readAt;
    reader.friendMeta[friendUsername] = { ...(reader.friendMeta[friendUsername] || {}), unread: 0 };
    persist();
    const receipt = { username: readerUsername, messageIds: ids, readAt };
    for (const member of accountOnlineMembers(friendUsername)) io.to(member.socketId).emit('friend-message-read', receipt);
    for (const member of accountOnlineMembers(readerUsername)) io.to(member.socketId).emit('friend-message-read', receipt);
    return { ids, readAt };
  }

  function roomStoragePolicy(roomIdValue = currentRoomId()) {
    const room = roomConfig(roomIdValue);
    const limitBytes = Math.max(0, Math.min(MAX_ROOM_STORAGE_LIMIT_BYTES, Math.floor(Number(room.storageLimitBytes) || 0)));
    const usedBytes = roomStorageSummary(room.id).originalBytes;
    return { limitBytes, usedBytes, remainingBytes: limitBytes ? Math.max(0, limitBytes - usedBytes) : null };
  }

  function mediaUploadBanFor(roomIdValue, originalName) {
    const roomId = normalizeRoomId(roomIdValue);
    const normalized = normalizeOriginalName(originalName).toLocaleLowerCase();
    if (!roomId || !normalized) return null;
    return (Array.isArray(state.admin.mediaUploadBans) ? state.admin.mediaUploadBans : [])
      .find((entry) => entry && entry.enabled !== false && entry.roomId === roomId
        && String(entry.originalName || '').toLocaleLowerCase() === normalized) || null;
  }

  function accountProfile(username, roomIdValue = currentRoomId()) {
    const account = state.accounts[username];
    if (!account) return null;
    const online = accountIsOnline(username);
    const room = roomConfig(roomIdValue);
    const history = account.watchHistory.filter((item) => !item.roomId || item.roomId === room.id).slice(-100).reverse().map((item) => ({ ...item, id: cleanText(item.id || `${item.fileId}:${item.lastWatchTime}`, 160), file: findFile(item.fileId) ? publicFile(findFile(item.fileId)) : null }));
    const watchLevel = watchLevelSummary(account);
    return {
      id: account.id, username, displayName: account.displayName || username, email: account.email, emailVerified: account.emailVerified === true, avatar: account.avatar,
      signature: account.signature || '', gender: account.gender || 'private', age: account.age || null, createdAt: account.createdAt,
      lastLogin: account.lastLogin, online, ...watchLevel, registrationDays: registrationDays(account), onlineSeconds: cumulativeOnlineSeconds(username, account), superAdmin: Boolean(account.superAdmin), guest: Boolean(account.guest), mustChangePassword: Boolean(account.mustChangePassword),
      accountDeletionConfirmation: `注销账号 ${username}`,
      roomQuota: account.roomQuota, ownedRoomCount: ownedRooms(username).length, recentRooms: roomListForAccount(username),
      tier: accountTier(username), tierId: account.tierId, uploadLimitBytes: uploadLimitForAccount(username),
      acceptedAgreementVersion: account.acceptedAgreementVersion || '', multiDeviceLogin: concurrentLoginAllowed(username),
      stats: { ...account.stats, onlineSeconds: cumulativeOnlineSeconds(username, account) }, devices: account.devices, history, favorites: account.favorites,
      favoriteMeta: account.favoriteMeta, mediaNotes: account.mediaNotes, mediaCategories: account.mediaCategories, roomMeta: account.roomMeta,
      friendSettings: normalizeFriendSettings(account.friendSettings),
      notificationPreferences: normalizeNotificationSettings(account.notificationSettings),
      viewPreferences: normalizeViewPreferences(account.viewPreferences),
      friends: (Array.isArray(account.friends) ? account.friends : []).map((friend) => ({
        username: friend, displayName: state.accounts[friend]?.displayName || friend, avatar: state.accounts[friend]?.avatar || '',
        online: accountIsOnline(friend), remark: cleanText(account.friendMeta?.[friend]?.remark, 40),
        group: cleanText(account.friendMeta?.[friend]?.group || '我的好友', 40), pinned: account.friendMeta?.[friend]?.pinned === true, unread: Math.max(0, Number(account.friendMeta?.[friend]?.unread) || 0),
        muteUntil: cleanText(account.friendMeta?.[friend]?.muteUntil, 40),
        floatingNotice: account.friendMeta?.[friend]?.floatingNotice !== false,
        room: friendRoomStatus(username, friend)
      })).filter((friend) => state.accounts[friend.username]),
      friendRequests: (Array.isArray(account.friendRequests) ? account.friendRequests : []).map((request) => ({ ...request, displayName: state.accounts[request.from || request.username]?.displayName || request.from || request.username })).slice(-100),
      friendRoomRequests: retainPersistentRequests(account.friendRoomRequests).filter((request) => request.status === 'pending').map((request) => ({
        ...request, displayName: state.accounts[request.from]?.displayName || request.from,
        roomName: state.rooms[request.roomId]?.name || request.roomName || request.roomId
      })).slice(-100),
      friendNotifications: friendUnreadNotifications(username),
      favoriteFiles: account.favorites.map(findFile).filter((file) => file?.roomId === room.id).map((file) => ({ ...publicFile(file), note: cleanText(account.favoriteMeta?.[file.id]?.note || file.note, 500), collection: cleanText(account.favoriteMeta?.[file.id]?.category || file.collection || '未分类', 80) || '未分类' })),
      myFiles: state.files.filter((file) => file.roomId === room.id && file.uploadedBy === username).map((file) => ({ ...publicFile(file), note: cleanText(account.mediaNotes?.[file.id]?.note || file.note, 500), collection: cleanText(account.mediaNotes?.[file.id]?.category || file.collection || '未分类', 80) || '未分类' })),
      rooms: Object.values(state.rooms).filter((entry) => entry.ownerUsername === username && visibleRoom(entry)).map((entry) => ({
        ...roomDirectorySummary(entry, username), archivedAt: entry.archivedAt || '',
        files: state.files.filter((file) => file.roomId === entry.id).length
      })),
      room: { ...room, passwordHash: undefined, permissions: undefined, permissionGroups: undefined, memberGroups: undefined, queue: undefined, savedState: undefined, online: roomUsers(room.id).length }
    };
  }

  const roomUsers = (roomIdValue = currentRoomId()) => [...users.values()].filter((user) => user.roomId === (normalizeRoomId(roomIdValue) || currentRoomId()));
  const usersList = (roomIdValue = currentRoomId()) => {
    const room = roomConfig(roomIdValue);
    return roomUsers(room.id).filter((user) => user.connectionState !== 'reconnecting').map(publicUser).sort((left, right) => {
      const leftRank = left.isOwner ? 0 : left.isSuperAdmin ? 1 : left.isAdmin ? 2 : 3;
      const rightRank = right.isOwner ? 0 : right.isSuperAdmin ? 1 : right.isAdmin ? 2 : 3;
      return leftRank - rightRank || String(left.displayName || left.username).localeCompare(String(right.displayName || right.username), 'zh-CN');
    });
  };

  function playbackSnapshot(roomIdValue = currentRoomId()) {
    const now = Date.now();
    const playback = { ...roomRuntime(roomIdValue).roomState.playback };
    playback.playbackRate = Math.max(0.5, Math.min(3, Number(playback.playbackRate ?? playback.rate ?? playback.speed ?? 1) || 1));
    playback.speed = playback.playbackRate;
    // The source media advances at its shared rate. Returning wall-clock time
    // here would make every periodic snapshot fall behind clients at >1x.
    if (playback.isPlaying && !playback.stalled) playback.currentTime += Math.max(0, now - playback.updatedAt) / 1000 * playback.playbackRate;
    playback.updatedAt = now;
    return playback;
  }

  function resetTextReadingState(file, username, roomIdValue = currentRoomId()) {
    const runtime = roomRuntime(roomIdValue);
    runtime.roomState.textReading = normalizeTextReadingState({
      fileId: file?.category === 'text' ? file.id : '', position: 0, page: 1, characterOffset: 0,
      updatedAt: Date.now(), changedBy: username, revision: Number(runtime.roomState.textReading?.revision || 0) + 1
    });
    return runtime.roomState.textReading;
  }

  function freezePlaybackForOwnerDisconnect(user) {
    const room = roomConfig(user?.roomId);
    const runtime = roomRuntime(room.id);
    if (!user || user.username !== room.ownerUsername || !runtime.roomState.playback.fileId
      || !runtime.roomState.playback.isPlaying || runtime.roomState.playback.stalled) return false;
    const snapshot = playbackSnapshot(room.id);
    runtime.roomState.playback = {
      ...runtime.roomState.playback, currentTime: snapshot.currentTime, stalled: true,
      updatedAt: Date.now(), changedBy: user.username, revision: runtime.roomState.playback.revision + 1
    };
    io.to(roomChannel(room.id)).emit('playback-state', playbackSnapshot(room.id));
    return true;
  }

  function roomSnapshot(roomIdValue = currentRoomId()) {
    const room = roomConfig(roomIdValue);
    const runtime = roomRuntime(room.id);
    const online = roomUsers(room.id).length;
    const storage = roomStorageSummary(room.id);
    return {
      ...room, passwordHash: undefined, permissions: undefined, permissionGroups: undefined, memberGroups: undefined, savedState: undefined,
      passwordRequired: Boolean(room.passwordHash), lightsOn: runtime.roomState.lightsOn, playback: playbackSnapshot(room.id),
      textReading: normalizeTextReadingState(runtime.roomState.textReading),
      screenShare: { ...runtime.roomState.screenShare }, audioShare: { ...runtime.roomState.audioShare }, webShare: { ...runtime.roomState.webShare }, queue: [...room.queue], playbackMode: normalizePlaybackMode(room.playbackMode), skipSettings: normalizePlaybackSkipSettings(room.skipSettings),
      online, storage, marqueeNotice: normalizeMarqueeNotice(state.admin.marqueeNotice), entryNotice: effectiveRoomEntryNotice(room.id),
      status: room.banned ? '已被服务器封禁' : room.closed ? '已关闭，等待重新进入' : online ? '同步正常' : '90 秒后自动关闭'
    };
  }

  function getSessionToken(req) {
    const authorization = String(req.headers.authorization || '');
    if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim();
    const cookieToken = parseCookies(req).syncwatch_session || '';
    if (cookieToken) return cookieToken;
    // Native media elements cannot attach an Authorization header.  A
    // session token query fallback keeps tunneled/embedded playback working
    // when a reverse proxy drops the HttpOnly session cookie.  It is accepted
    // only for protected media paths, never for JSON APIs.
    if (/^\/(?:media|compatible-media|host-media|thumbnail|avatar|chat-image)\//i.test(String(req.path || ''))) {
      const queryToken = String(req.query?.syncwatch_token || '').trim();
      if (/^[A-Za-z0-9_-]{32,}$/.test(queryToken)) return queryToken;
    }
    return '';
  }

  function expireSession(token, session, message = '登录已过期，请重新登录') {
    sessions.delete(token);
    const member = users.get(session?.socketId);
    if (!member || member.sessionToken !== token) return;
    const targetSocket = io.sockets.sockets.get(member.socketId);
    targetSocket?.emit('auth-error', message);
    stopScreenShare(member.socketId);
    removeOnlineUser(member.socketId);
    setImmediate(() => targetSocket?.connected && targetSocket.disconnect(true));
  }

  function validSession(token, touch = true) {
    const session = sessions.get(token);
    if (!session) return null;
    const now = Date.now();
    const sessionRoomId = normalizeRoomId(session.roomId);
    if (!state.accounts[session.username] || !sessionRoomId || !state.rooms[sessionRoomId]
      || now >= session.expiresAt || now - session.lastSeenAt >= sessionIdleTimeoutMs) {
      expireSession(token, session);
      return null;
    }
    if (touch) session.lastSeenAt = now;
    return session;
  }

  function adminSessionLimit() {
    return Math.max(1, Math.min(20, Math.floor(Number(state.admin.adminMaxConcurrentSessions) || 5)));
  }

  function adminSessionCapacityError(username, exceptToken = '') {
    if (username !== 'admin') return null;
    let active = 0;
    for (const [token, session] of [...sessions]) {
      if (token !== exceptToken && session.username === 'admin' && validSession(token, false)) active += 1;
    }
    const limit = adminSessionLimit();
    return active >= limit
      ? { success: false, code: 'ADMIN_SESSION_LIMIT', error: `admin 同时登录已达到 ${limit} 个会话上限，请先退出其他设备或调高上限` }
      : null;
  }

  function trimAdminSessions(preferredToken = '') {
    const active = [...sessions]
      .filter(([token, session]) => session.username === 'admin' && validSession(token, false))
      .sort((left, right) => Number(right[0] === preferredToken) - Number(left[0] === preferredToken)
        || Number(right[1].createdAt || 0) - Number(left[1].createdAt || 0));
    for (const [token, session] of active.slice(adminSessionLimit())) {
      expireSession(token, session, `admin 同时登录会话已超过 ${adminSessionLimit()} 个上限，请重新登录`);
    }
  }

  function isSuperAdmin(username) { return Boolean(state.accounts[cleanUsername(username)]?.superAdmin); }

  function sessionHasRoomAccess(session) {
    if (!session) return false;
    const room = roomConfig(session.roomId);
    return canBypassRoomPassword(session.username, room) || !room.passwordHash || Number(session.roomAccessRevision) === Number(room.accessRevision);
  }

  function newSessionDetails(input) {
    const now = Date.now();
    const room = roomConfig(input.roomId);
    return { ...input, roomAccessRevision: room.accessRevision, createdAt: now, lastSeenAt: now, expiresAt: now + sessionMaxAgeMs };
  }

  function requireSession(req, res, next) {
    const token = getSessionToken(req);
    const session = validSession(token);
    if (!session) return res.status(401).json({ success: false, error: '登录已失效，请重新登录' });
    if (isIpBanned(getRequestIp(req))) {
      sessions.delete(token);
      return res.status(403).json({ success: false, error: '此设备地址已被禁止访问' });
    }
    if (!sessionHasRoomAccess(session) && req.path !== '/api/logout') {
      return res.status(403).json({ success: false, code: 'ROOM_PASSWORD_REQUIRED', error: '房间密码已更新，请重新验证后继续' });
    }
    if (!agreementAccepted(session.username) && !['/api/session', '/api/logout'].includes(req.path)) {
      return res.status(451).json({ success: false, code: 'AGREEMENT_REQUIRED', error: '请先阅读并同意软件使用协议' });
    }
    req.syncWatchSession = session;
    req.syncWatchToken = token;
    req.syncWatchSessionRoomId = normalizeRoomId(session.roomId);
    return withRoom(req.syncWatchSessionRoomId, next);
  }

  function requireHost(req, res, next) {
    if (!req.syncWatchSession?.isServerHost && !state.accounts[req.syncWatchSession?.username]?.superAdmin) return res.status(403).json({ success: false, error: '此功能仅服务器主机或超级管理员可用' });
    return next();
  }

  function requireServerAdministrator(req, res, next) {
    const session = req.syncWatchSession;
    if (!(session?.isServerHost || isSuperAdmin(session?.username) || session?.adminVerifiedAt)) {
      return res.status(403).json({ success: false, error: '只有服务器主机或超级管理员可以管理登录资源' });
    }
    return next();
  }

  function writeAdminPasswordHash(passwordHash) {
    fs.mkdirSync(adminSecretsDir, { recursive: true });
    atomicWriteJson(adminPasswordFile, { version: 1, passwordHash: String(passwordHash || ''), updatedAt: new Date().toISOString() });
    try { fs.chmodSync(adminPasswordFile, 0o600); } catch (_) {}
  }
  function setAdminPasswordHash(passwordHash) {
    state.admin.passwordHash = String(passwordHash || '');
    state.admin.passwordChangedAt = new Date().toISOString();
    writeAdminPasswordHash(state.admin.passwordHash);
  }
  function verifyAdminAsync(password) { return verifyPasswordAsync(String(password || ''), state.admin.passwordHash); }
  function canControl(user) {
    if (!user) return false;
    if (state.accounts[user.username]?.superAdmin) return true;
    const room = roomConfig(user.roomId);
    if (user.username === room.ownerUsername && room.passwordEnforcementRequired && !room.passwordHash) return false;
    if (user.username === room.ownerUsername) return true;
    const effective = permissionFor(user.username, room.id);
    if (effective.administrator) return true;
    if (room.permissions[user.username]?.control === true) return true;
    return !room.controlLocked && effective.control;
  }

  function canSeek(user) {
    if (!user) return false;
    if (canControl(user)) return true;
    const room = roomConfig(user.roomId);
    return permissionFor(user.username, room.id).seek === true;
  }

  function canUndoRoomOperation(user, operation) {
    if (!user || !operation || operation.roomId !== user.roomId) return false;
    const room = roomConfig(user.roomId);
    if (user.username === room.ownerUsername || operation.actor === user.username || isSuperAdmin(user.username)) return true;
    if (operation.action === 'select-file') return canControl(user);
    if (['file-upload', 'file-delete'].includes(operation.action)) {
      const permissions = permissionFor(user.username, user.roomId);
      return Boolean(permissions.administrator || permissions.delete || permissions.manageRoom);
    }
    return false;
  }
  function ownerSockets(roomIdValue = currentRoomId()) {
    const room = roomConfig(roomIdValue);
    return roomUsers(room.id).filter((user) => user.username === room.ownerUsername).map((user) => io.sockets.sockets.get(user.socketId)).filter(Boolean);
  }

  function appendMessage(message) {
    rememberChatMessage(message);
    pendingChatLines.push(`${JSON.stringify(message)}\n`);
    if (!chatFlushTimer) {
      chatFlushTimer = setTimeout(() => flushPendingChatLines(), 200);
      chatFlushTimer.unref?.();
    }
  }

  function flushPendingChatLines() {
    if (chatFlushTimer) clearTimeout(chatFlushTimer);
    chatFlushTimer = null;
    if (!pendingChatLines.length) return chatWriteChain;
    const contents = pendingChatLines.join('');
    pendingChatLines = [];
    chatWriteChain = chatWriteChain
      .then(() => fs.promises.appendFile(chatFile, contents, 'utf8'))
      .catch((error) => console.error('保存聊天记录失败:', error.message));
    return chatWriteChain;
  }

  function messageVisible(message, username, roomIdValue = currentRoomId()) {
    return message.roomId === (normalizeRoomId(roomIdValue) || currentRoomId()) && (!message.to || message.from === username || message.to === username);
  }

  function emitMessage(message) {
    if (!message.to) return io.to(roomChannel(message.roomId)).emit('chat-message', message);
    for (const user of users.values()) {
      if (user.roomId === message.roomId && (user.username === message.from || user.username === message.to)) io.to(user.socketId).emit('chat-message', message);
    }
  }

  function createMessage(user, input, roomIdValue = user?.roomId) {
    const type = ['text', 'announcement', 'voice', 'image', 'danmaku'].includes(input.type) ? input.type : 'text';
    const to = cleanUsername(input.to || '');
    const fromAccount = state.accounts[user.username];
    const toAccount = state.accounts[to];
    const messageRoomId = normalizeRoomId(roomIdValue);
    if (!messageRoomId || messageRoomId !== normalizeRoomId(user?.roomId) || !state.rooms[messageRoomId]) throw new Error('消息房间上下文无效');
    return {
      id: crypto.randomUUID(), roomId: messageRoomId, type, from: user.username, fromName: fromAccount?.displayName || user.username,
      to: to || null, toName: to ? toAccount?.displayName || to : null,
      text: cleanText(input.text, type === 'announcement' ? 500 : type === 'danmaku' ? 100 : 300),
      voiceUrl: cleanText(input.voiceUrl, 300), imageUrl: cleanText(input.imageUrl, 300),
      imageName: cleanText(input.imageName, 120), channel: ['public', 'private', 'danmaku'].includes(input.channel) ? input.channel : (to ? 'private' : 'public'),
      color: /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color : '#ff75b5',
      timestamp: new Date().toISOString()
    };
  }

  function publicOperation(operation) {
    return {
      id: operation.id, roomId: operation.roomId, actor: operation.actor, actorName: operation.actorName,
      action: operation.action, summary: operation.summary, createdAt: operation.createdAt,
      reversible: operationUndoAvailable(operation), undone: Boolean(operation.undone),
      undoneAt: operation.undoneAt || '', undoneBy: operation.undoneBy || '', scope: operation.scope || 'room',
      undoExpiresAt: trashBackedUndo(operation.undo) ? operation.undo.expiresAt || '' : '', undoExpiredAt: operation.undoExpiredAt || ''
    };
  }

  function recordOperation({ id = '', roomId: roomIdValue = currentRoomId(), actor = 'system', action, summary, undo = null, scope = 'room' }) {
    const account = state.accounts[actor];
    const normalizedUndo = undo && trashBackedUndo(undo) && !undo.expiresAt
      ? { ...undo, expiresAt: new Date(Date.now() + trashRetentionMs).toISOString() }
      : undo;
    const operation = {
      id: id || crypto.randomUUID(), roomId: normalizeRoomId(roomIdValue) || currentRoomId(), actor,
      actorName: account?.displayName || actor, action: cleanText(action, 60), summary: cleanText(summary, 300),
      createdAt: new Date().toISOString(), scope, undo: normalizedUndo, undone: false
    };
    state.operations.push(operation);
    state.serverLogs = Array.isArray(state.serverLogs) ? state.serverLogs : [];
    state.serverLogs.push({
      id: crypto.randomUUID(), timestamp: operation.createdAt, level: 'info', category: scope === 'server' ? 'server' : 'operation',
      actor: operation.actor, actorName: operation.actorName, action: operation.action, summary: operation.summary,
      roomId: operation.roomId, reversible: operationUndoAvailable(operation)
    });
    if (state.serverLogs.length > 5000) state.serverLogs = state.serverLogs.slice(-5000);
    schedulePersist(200);
    return operation;
  }

  function recordAccountAudit({
    category, action = '', result = 'success', username = '', displayName = '', ipAddress = '',
    deviceName = '', platform = '', browser = '', actor = '', actorName = '', message = ''
  }) {
    const normalizedUsername = cleanUsername(username);
    const account = state.accounts[normalizedUsername];
    const entry = {
      id: crypto.randomUUID(), timestamp: new Date().toISOString(),
      category: ['register', 'login', 'logout', 'account-delete'].includes(category) ? category : 'login',
      action: cleanText(action, 40), result: result === 'success' ? 'success' : 'failure',
      username: normalizedUsername, displayName: cleanText(displayName || account?.displayName || normalizedUsername, 60),
      ipAddress: normalizeIp(ipAddress), deviceName: cleanText(deviceName, 80),
      platform: cleanText(platform, 40), browser: cleanText(browser, 40),
      actor: cleanUsername(actor), actorName: cleanText(actorName, 60), message: cleanText(message, 240)
    };
    state.accountAuditLogs = Array.isArray(state.accountAuditLogs) ? state.accountAuditLogs : [];
    state.accountAuditLogs.push(entry);
    if (state.accountAuditLogs.length > 10000) state.accountAuditLogs = state.accountAuditLogs.slice(-10000);
    // Authentication and deletion records must be durable before the caller
    // can take a backup or compare a rollback baseline. A delayed write here
    // would let a just-completed login mutate config.json after that baseline.
    persist();
    return entry;
  }

  function normalizeStoredMessage(message) {
    if (!message || typeof message !== 'object' || !message.id) return null;
    const normalizedRoomId = normalizeRoomId(message.roomId);
    message.roomId = normalizedRoomId && state.rooms[normalizedRoomId] ? normalizedRoomId : state.defaultRoomId;
    return message;
  }

  async function readAllChatMessagesFromFile() {
    const messages = [];
    if (!fs.existsSync(chatFile)) return messages;
    const input = fs.createReadStream(chatFile, { encoding: 'utf8' });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line) continue;
      try {
        const message = normalizeStoredMessage(JSON.parse(line));
        if (message) messages.push(message);
      } catch (_) {}
    }
    return messages;
  }

  async function writeAllChatMessages(messages) {
    const temporary = `${chatFile}.rewrite-${crypto.randomUUID()}.tmp`;
    const handle = await fs.promises.open(temporary, 'w');
    try {
      for (let index = 0; index < messages.length; index += 500) {
        const contents = messages.slice(index, index + 500).map((entry) => `${JSON.stringify(entry)}\n`).join('');
        if (contents) await handle.write(contents, null, 'utf8');
      }
    } finally { await handle.close(); }
    await fs.promises.rename(temporary, chatFile);
  }

  async function mutateStoredChatMessages(mutator) {
    await flushPendingChatLines();
    let result;
    const task = chatWriteChain.then(async () => {
      const messages = await readAllChatMessagesFromFile();
      result = await mutator(messages);
      await writeAllChatMessages(messages);
    });
    chatWriteChain = task.catch((error) => console.error('重写聊天记录失败:', error.message));
    await task;
    return result;
  }

  function recalculateChatWindowCounts() {
    chatRoomWindowCounts.clear();
    for (const message of chatMessages) chatRoomWindowCounts.set(message.roomId, (chatRoomWindowCounts.get(message.roomId) || 0) + 1);
  }

  async function readChatPage(roomIdValue, username, before, beforeId, limit, participant = '', channel = '', filters = {}) {
    await flushPendingChatLines();
    const id = normalizeRoomId(roomIdValue) || currentRoomId();
    const requestedParticipants = Array.isArray(filters.usernames) ? filters.usernames : [];
    const filteredParticipants = [...new Set([participant, ...requestedParticipants].map(cleanUsername).filter(Boolean))].slice(0, 50);
    const filteredChannel = ['public', 'private', 'danmaku', 'announcement', 'voice', 'image'].includes(channel) ? channel : '';
    const fromTimestamp = Number.isFinite(filters.fromTimestamp) ? filters.fromTimestamp : -Infinity;
    const toTimestamp = Number.isFinite(filters.toTimestamp) ? filters.toTimestamp : Infinity;
    const query = cleanText(filters.query, 120).toLocaleLowerCase();
    const page = [];
    let matched = 0;
    let cursorFound = !beforeId;
    if (!fs.existsSync(chatFile)) return { messages: page, hasMore: false, cursorFound };
    const input = fs.createReadStream(chatFile, { encoding: 'utf8' });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line) continue;
      try {
        const message = normalizeStoredMessage(JSON.parse(line));
        if (!message || !messageVisible(message, username, id)) continue;
        if (filteredParticipants.length && !filteredParticipants.some((name) => message.from === name || message.to === name)) continue;
        if (filteredChannel) {
          const messageChannel = message.type === 'danmaku' || message.channel === 'danmaku' ? 'danmaku'
            : message.type === 'announcement' ? 'announcement' : message.type === 'voice' ? 'voice'
              : message.type === 'image' ? 'image' : message.to ? 'private' : 'public';
          if (messageChannel !== filteredChannel) continue;
        }
        const messageTimestamp = Date.parse(message.timestamp);
        if (!Number.isFinite(messageTimestamp) || messageTimestamp < fromTimestamp || messageTimestamp > toTimestamp) continue;
        if (query) {
          const searchable = [message.from, message.fromName, message.to, message.toName, message.text, message.imageName]
            .map((value) => String(value || '').toLocaleLowerCase()).join('\n');
          if (!searchable.includes(query)) continue;
        }
        if (beforeId) {
          if (message.id === beforeId) { cursorFound = true; break; }
        } else if (Date.parse(message.timestamp) >= before) continue;
        matched += 1;
        page.push(message);
        if (page.length > limit) page.shift();
      } catch (_) {}
    }
    return { messages: page, hasMore: matched > page.length, cursorFound };
  }

  async function readChatParticipants(roomIdValue) {
    await flushPendingChatLines();
    const id = normalizeRoomId(roomIdValue) || currentRoomId();
    const participants = new Map();
    const remember = (username, displayName) => {
      const name = cleanUsername(username);
      if (!name) return;
      const currentName = state.accounts[name]?.displayName;
      const label = cleanUsername(currentName || displayName || name) || name;
      if (!participants.has(name) || participants.get(name) === name) participants.set(name, label);
    };
    if (!fs.existsSync(chatFile)) return [];
    const input = fs.createReadStream(chatFile, { encoding: 'utf8' });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line) continue;
      try {
        const message = normalizeStoredMessage(JSON.parse(line));
        if (!message || message.roomId !== id) continue;
        remember(message.from, message.fromName);
        remember(message.to, message.toName);
      } catch (_) {}
    }
    return [...participants.entries()]
      .map(([username, displayName]) => ({ username, displayName }))
      .sort((left, right) => (left.displayName || left.username).localeCompare(right.displayName || right.username, 'zh-CN'));
  }

  async function findStoredMessage(messageId, roomIdValue = currentRoomId()) {
    await flushPendingChatLines();
    const id = normalizeRoomId(roomIdValue) || currentRoomId();
    if (!fs.existsSync(chatFile)) return null;
    const input = fs.createReadStream(chatFile, { encoding: 'utf8' });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line) continue;
      try {
        const message = normalizeStoredMessage(JSON.parse(line));
        if (message?.roomId === id && message.id === messageId) return message;
      } catch (_) {}
    }
    return null;
  }

  async function findStoredVoiceMessage(voiceUrl, roomIdValue = currentRoomId()) {
    await flushPendingChatLines();
    const id = normalizeRoomId(roomIdValue) || currentRoomId();
    if (!fs.existsSync(chatFile)) return null;
    const input = fs.createReadStream(chatFile, { encoding: 'utf8' });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line) continue;
      try {
        const message = normalizeStoredMessage(JSON.parse(line));
        if (message?.roomId === id && message.voiceUrl === voiceUrl) return message;
      } catch (_) {}
    }
    return null;
  }

  async function findStoredImageMessage(imageUrl, roomIdValue = currentRoomId()) {
    await flushPendingChatLines();
    const id = normalizeRoomId(roomIdValue) || currentRoomId();
    if (!fs.existsSync(chatFile)) return null;
    const input = fs.createReadStream(chatFile, { encoding: 'utf8' });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line) continue;
      try {
        const message = normalizeStoredMessage(JSON.parse(line));
        if (message?.roomId === id && message.imageUrl === imageUrl) return message;
      } catch (_) {}
    }
    return null;
  }

  async function removeChatMessages(predicate) {
    const removed = await mutateStoredChatMessages((messages) => {
      const matches = [];
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (!predicate(messages[index])) continue;
        matches.push(messages[index]);
        messages.splice(index, 1);
      }
      return matches.reverse();
    });
    if (removed.length) {
      const ids = new Set(removed.map((message) => message.id));
      for (let index = chatMessages.length - 1; index >= 0; index -= 1) if (ids.has(chatMessages[index].id)) chatMessages.splice(index, 1);
      recalculateChatWindowCounts();
    }
    return removed;
  }

  async function restoreChatMessages(messages) {
    const restored = (messages || []).filter((message) => message?.id);
    if (!restored.length) return;
    await mutateStoredChatMessages((stored) => {
      const existing = new Set(stored.map((message) => message.id));
      for (const message of restored) if (!existing.has(message.id)) stored.push(message);
      stored.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    });
    for (const message of restored) {
      if (message.from) chatParticipants.add(message.from);
      if (message.to) chatParticipants.add(message.to);
    }
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clonedArtifactName(sourceName, fallbackExtension = '') {
    const extension = path.extname(String(sourceName || '')).toLowerCase();
    const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : fallbackExtension;
    return `${crypto.randomUUID()}${safeExtension}`;
  }

  function copyNamedArtifact(kind, sourceName, targetName, createdArtifacts) {
    const directory = artifactDirectory(kind);
    if (!directory || !safeStoredName(sourceName) || !safeStoredName(targetName)) throw new Error('房间数据包含不安全的文件路径');
    const source = path.resolve(directory, sourceName);
    const target = path.resolve(directory, targetName);
    const directoryPrefix = `${path.resolve(directory)}${path.sep}`;
    if (!source.startsWith(directoryPrefix) || !target.startsWith(directoryPrefix)) throw new Error('房间文件路径越界');
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`源房间文件缺失：${sourceName}`);
    const temporary = `${target}.room-copy-${process.pid}-${crypto.randomBytes(5).toString('hex')}.tmp`;
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch (_) {}
      throw error;
    }
    createdArtifacts.push(target);
  }

  function cloneRoomFileRecord(sourceFile, targetRoomId, idMap, createdArtifacts) {
    const cloned = cloneJson(sourceFile);
    const newId = crypto.randomUUID();
    idMap.set(sourceFile.id, newId);
    cloned.id = newId;
    cloned.roomId = targetRoomId;
    cloned.uploadedAt = new Date().toISOString();
    cloned.compatibility = cloned.compatibility && typeof cloned.compatibility === 'object' ? cloned.compatibility : {};
    const remote = sourceFile.sourceType === 'remote' && /^https:\/\/[^\s]+$/i.test(String(sourceFile.sourceUrl || ''));
    if (remote) {
      cloned.storedName = '';
    } else {
      const storedName = clonedArtifactName(sourceFile.storedName, path.extname(sourceFile.originalName || '').toLowerCase());
      copyNamedArtifact('upload', sourceFile.storedName, storedName, createdArtifacts);
      cloned.storedName = storedName;
    }
    if (sourceFile.thumbnailName && safeStoredName(sourceFile.thumbnailName)
      && fs.existsSync(path.join(thumbnailsDir, sourceFile.thumbnailName))) {
      cloned.thumbnailName = clonedArtifactName(sourceFile.thumbnailName, '.jpg');
      copyNamedArtifact('thumbnail', sourceFile.thumbnailName, cloned.thumbnailName, createdArtifacts);
    } else cloned.thumbnailName = '';
    if (sourceFile.vttName && safeStoredName(sourceFile.vttName)
      && fs.existsSync(path.join(subtitlesDir, sourceFile.vttName))) {
      cloned.vttName = clonedArtifactName(sourceFile.vttName, '.vtt');
      copyNamedArtifact('subtitle', sourceFile.vttName, cloned.vttName, createdArtifacts);
    } else cloned.vttName = '';
    const compatibleSourceName = sourceFile.compatibility?.fileName || (mediaNeedsCompatibility(sourceFile) ? compatibilityFileName(sourceFile) : '');
    if (compatibleSourceName && safeStoredName(compatibleSourceName)
      && fs.existsSync(path.join(compatibleMediaDir, compatibleSourceName))) {
      const compatibleName = clonedArtifactName(compatibleSourceName, '.mp4');
      copyNamedArtifact('compatible', compatibleSourceName, compatibleName, createdArtifacts);
      cloned.compatibility = { ...cloned.compatibility, fileName: compatibleName };
    } else if (cloned.compatibility) {
      cloned.compatibility = { ...cloned.compatibility, fileName: '', status: cloned.compatibility.status === 'ready' ? 'pending' : cloned.compatibility.status };
    }
    return cloned;
  }

  function cloneRoomChatMessage(sourceMessage, targetRoomId, createdArtifacts) {
    const cloned = { ...cloneJson(sourceMessage), id: crypto.randomUUID(), roomId: targetRoomId };
    const voiceMatch = /^\/voice\/([^/?#]+)$/i.exec(String(sourceMessage.voiceUrl || ''));
    if (voiceMatch) {
      const sourceName = decodeURIComponent(voiceMatch[1]);
      const targetName = clonedArtifactName(sourceName, '.webm');
      copyNamedArtifact('voice', sourceName, targetName, createdArtifacts);
      cloned.voiceUrl = `/voice/${encodeURIComponent(targetName)}`;
    }
    const imageMatch = /^\/chat-image\/([^/?#]+)$/i.exec(String(sourceMessage.imageUrl || ''));
    if (imageMatch) {
      const sourceName = decodeURIComponent(imageMatch[1]);
      const targetName = clonedArtifactName(sourceName, '.jpg');
      copyNamedArtifact('chat-image', sourceName, targetName, createdArtifacts);
      cloned.imageUrl = `/chat-image/${encodeURIComponent(targetName)}`;
      cloned.imageName = targetName;
    }
    return cloned;
  }

  function roomTransferDiskRequirement(sourceFiles) {
    let bytes = 0;
    for (const file of sourceFiles) {
      for (const artifact of fileArtifactPaths(file)) {
        try { if (fs.existsSync(artifact.path)) bytes += fs.statSync(artifact.path).size; } catch (_) {}
      }
    }
    return bytes;
  }

  async function copyRoomDataTransactional({ sourceRoomId, targetRoomId = '', targetOwner, requestedRoomName = '', overwrite = false, actor }) {
    const sourceId = normalizeRoomId(sourceRoomId);
    const sourceRoom = sourceId && state.rooms[sourceId];
    if (!visibleRoom(sourceRoom) || sourceRoom.temporary) throw new Error('源房间不存在、已存档或属于临时房间');
    let destinationId = normalizeRoomId(targetRoomId);
    const existingTarget = destinationId ? state.rooms[destinationId] : null;
    if (overwrite) {
      if (!visibleRoom(existingTarget) || existingTarget.temporary) throw new Error('目标房间不存在、已存档或属于临时房间');
      if (destinationId === sourceId) throw new Error('源房间和目标房间不能相同');
    } else {
      do { destinationId = roomId(); } while (state.rooms[destinationId]);
    }
    const ownerUsername = cleanUsername(targetOwner || existingTarget?.ownerUsername);
    if (!state.accounts[ownerUsername]) throw new Error('目标房主账号不存在');
    const claimKeys = [sourceId, destinationId].sort();
    if (claimKeys.some((key) => roomTransferClaims.has(key))) throw new Error('相关房间正在执行其他复制或迁移操作');
    for (const key of claimKeys) roomTransferClaims.add(key);

    const transactionId = `room-transfer-${crypto.randomUUID()}`;
    const createdArtifacts = [];
    const sourceFiles = state.files.filter((file) => file.roomId === sourceId);
    const requiredBytes = roomTransferDiskRequirement(sourceFiles);
    try {
      if (typeof fs.statfsSync === 'function') {
        const disk = fs.statfsSync(dataDir);
        const available = Number(disk.bavail) * Number(disk.bsize);
        if (Number.isFinite(available) && requiredBytes + 64 * 1024 * 1024 > available) throw new Error('磁盘剩余空间不足，无法安全复制房间媒体');
      }
      const idMap = new Map();
      const clonedFiles = sourceFiles.map((file) => cloneRoomFileRecord(file, destinationId, idMap, createdArtifacts));
      for (let index = 0; index < sourceFiles.length; index += 1) {
        clonedFiles[index].subtitleVideoId = idMap.get(sourceFiles[index].subtitleVideoId) || '';
      }
      const sourceData = cloneJson(sourceRoom);
      const roomOptions = {
        ...sourceData,
        id: destinationId,
        name: cleanText(requestedRoomName || (overwrite ? sourceRoom.name : `${sourceRoom.name} · 副本`), 40) || sourceRoom.name,
        ownerUsername,
        createdBy: overwrite ? (existingTarget.createdBy || ownerUsername) : ownerUsername,
        createdAt: overwrite ? existingTarget.createdAt : new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        archived: false, archivedAt: '', banned: false, banReason: '', closed: false, closedAt: '', temporary: false, systemRoom: false,
        permissions: cloneJson(sourceRoom.permissions || {}),
        memberGroups: cloneJson(sourceRoom.memberGroups || {}),
        mediaManagementGrants: cloneJson(sourceRoom.mediaManagementGrants || {}),
        queue: sourceRoom.queue.map((fileId) => idMap.get(fileId)).filter(Boolean),
        queueFileModes: Object.fromEntries(Object.entries(sourceRoom.queueFileModes || {})
          .map(([fileId, mode]) => [idMap.get(fileId), normalizePlaybackMode(mode)]).filter(([fileId]) => fileId)),
        savedState: sourceRoom.savedState ? cloneJson(sourceRoom.savedState) : null
      };
      if (roomOptions.savedState?.playback?.fileId) roomOptions.savedState.playback.fileId = idMap.get(roomOptions.savedState.playback.fileId) || null;
      if (roomOptions.savedState?.textReading?.fileId) roomOptions.savedState.textReading.fileId = idMap.get(roomOptions.savedState.textReading.fileId) || '';
      const replacementRoom = freshRoom(destinationId, ownerUsername, roomOptions);
      const previousRoom = existingTarget ? cloneJson(existingTarget) : null;
      const previousFiles = state.files.filter((file) => file.roomId === destinationId).map(cloneJson);
      const previousRuntime = roomRuntimes.get(destinationId) || null;
      const ownerAccount = state.accounts[ownerUsername];
      const previousCreatedRoomCount = Math.max(0, Number(ownerAccount.stats?.createdRooms) || 0);
      const previousRecentRooms = Array.isArray(ownerAccount.recentRooms) ? [...ownerAccount.recentRooms] : [];
      const previousOperationCount = state.operations.length;
      const previousServerLogCount = Array.isArray(state.serverLogs) ? state.serverLogs.length : 0;
      let previousStoredMessages = [];
      let clonedMessages = [];
      try {
        await mutateStoredChatMessages((messages) => {
          const sourceMessages = messages.filter((message) => message.roomId === sourceId);
          previousStoredMessages = messages.filter((message) => message.roomId === destinationId).map(cloneJson);
          clonedMessages = sourceMessages.map((message) => cloneRoomChatMessage(message, destinationId, createdArtifacts));
          if (overwrite) {
            for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index].roomId === destinationId) messages.splice(index, 1);
          }
          messages.push(...clonedMessages);
          messages.sort((left, right) => Date.parse(left.timestamp || 0) - Date.parse(right.timestamp || 0));
        });
        state.rooms[destinationId] = replacementRoom;
        state.files = state.files.filter((file) => file.roomId !== destinationId).concat(clonedFiles);
        roomRuntimes.delete(destinationId);
        roomRuntime(destinationId);
        if (!overwrite) ownerAccount.stats.createdRooms = Math.max(0, Number(ownerAccount.stats.createdRooms) || 0) + 1;
        rememberRecentRoom(ownerUsername, destinationId);
        persist();

        for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
          if (overwrite && chatMessages[index].roomId === destinationId) chatMessages.splice(index, 1);
        }
        for (const message of clonedMessages) rememberChatMessage(message);
        recalculateChatWindowCounts();
        recordOperation({
          roomId: destinationId, actor, action: overwrite ? 'room-migrate' : 'room-copy', scope: 'server',
          summary: `${overwrite ? '迁移覆盖' : '复制'}房间 ${sourceId} → ${destinationId}`
        });
        io.to(roomChannel(destinationId)).emit('room-data-migrated', {
          sourceRoomId: sourceId, targetRoomId: destinationId, overwrite, room: roomSnapshot(destinationId), copiedFiles: clonedFiles.length, copiedMessages: clonedMessages.length
        });
        io.to(roomChannel(destinationId)).emit('room-state', roomSnapshot(destinationId));
        io.to(roomChannel(destinationId)).emit('queue-state', replacementRoom.queue);
        emitRoomDirectoryChanged(destinationId, overwrite ? 'room-migrated' : 'room-copied');
        for (const oldFile of previousFiles) {
          try { moveFileArtifactsToTrash(oldFile, `${transactionId}-${oldFile.id}`); } catch (_) {}
        }
        return { room: roomSnapshot(destinationId), copiedFiles: clonedFiles.length, copiedMessages: clonedMessages.length };
      } catch (error) {
        if (previousRoom) state.rooms[destinationId] = previousRoom;
        else delete state.rooms[destinationId];
        state.files = state.files.filter((file) => file.roomId !== destinationId).concat(previousFiles);
        ownerAccount.stats = ownerAccount.stats && typeof ownerAccount.stats === 'object' ? ownerAccount.stats : {};
        ownerAccount.stats.createdRooms = previousCreatedRoomCount;
        ownerAccount.recentRooms = previousRecentRooms;
        state.operations.splice(previousOperationCount);
        if (Array.isArray(state.serverLogs)) state.serverLogs.splice(previousServerLogCount);
        roomRuntimes.delete(destinationId);
        if (previousRuntime && previousRoom) roomRuntimes.set(destinationId, previousRuntime);
        try {
          const clonedIds = new Set(clonedMessages.map((message) => message.id));
          await mutateStoredChatMessages((messages) => {
            for (let index = messages.length - 1; index >= 0; index -= 1) {
              if (clonedIds.has(messages[index].id) || (overwrite && messages[index].roomId === destinationId)) messages.splice(index, 1);
            }
            messages.push(...previousStoredMessages);
            messages.sort((left, right) => Date.parse(left.timestamp || 0) - Date.parse(right.timestamp || 0));
          });
        } catch (_) {}
        const clonedIds = new Set(clonedMessages.map((message) => message.id));
        for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
          if (clonedIds.has(chatMessages[index].id) || (overwrite && chatMessages[index].roomId === destinationId)) chatMessages.splice(index, 1);
        }
        if (overwrite) for (const message of previousStoredMessages) rememberChatMessage(message);
        recalculateChatWindowCounts();
        try { persist(); } catch (_) {}
        throw error;
      }
    } finally {
      for (const filename of createdArtifacts) {
        const stillReferenced = state.files.some((file) => fileArtifactPaths(file).some((artifact) => artifact.path === filename))
          || chatMessages.some((message) => [message.voiceUrl, message.imageUrl].some((url) => String(url || '').includes(encodeURIComponent(path.basename(filename)))));
        if (!stillReferenced) try { fs.rmSync(filename, { force: true }); } catch (_) {}
      }
      for (const key of claimKeys) roomTransferClaims.delete(key);
    }
  }

  async function renameStoredChatDisplayName(username, displayName) {
    await mutateStoredChatMessages((messages) => {
      for (const message of messages) {
        if (message.from === username) message.fromName = displayName;
        if (message.to === username) message.toName = displayName;
      }
    });
    for (const message of chatMessages) {
      if (message.from === username) message.fromName = displayName;
      if (message.to === username) message.toName = displayName;
    }
  }

  async function renameStoredChatIdentity(previousUsername, nextUsername, displayName) {
    await mutateStoredChatMessages((messages) => {
      for (const message of messages) {
        if (message.from === previousUsername) {
          message.from = nextUsername;
          message.fromName = displayName;
        }
        if (message.to === previousUsername) {
          message.to = nextUsername;
          message.toName = displayName;
        }
        if (message.username === previousUsername) message.username = nextUsername;
      }
    });
    for (const message of chatMessages) {
      if (message.from === previousUsername) { message.from = nextUsername; message.fromName = displayName; }
      if (message.to === previousUsername) { message.to = nextUsername; message.toName = displayName; }
      if (message.username === previousUsername) message.username = nextUsername;
    }
    chatParticipants.delete(previousUsername);
    chatParticipants.add(nextUsername);
  }

  function freeDiskBytes() {
    try {
      if (diskSpaceProvider) return Number(diskSpaceProvider());
      const stats = fs.statfsSync(dataDir);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (_) { return Infinity; }
  }

  function diskSpaceError() {
    const error = new Error('服务器磁盘空间不足，至少需要保留 512MB 可用空间');
    error.code = 'INSUFFICIENT_STORAGE';
    error.statusCode = 507;
    return error;
  }

  function hasDiskSpace(extraBytes = 0) {
    const free = freeDiskBytes();
    return !Number.isFinite(free) || free - Math.max(0, Number(extraBytes) || 0) >= DISK_RESERVE_BYTES;
  }

  function ensureDiskSpace(req, res, next) {
    const contentLength = Math.max(0, Number(req.headers['content-length']) || 0);
    if (!hasDiskSpace(contentLength)) return res.status(507).json({ success: false, error: diskSpaceError().message });
    return next();
  }

  function managedPartialPath(value) {
    if (!value) return '';
    const target = path.resolve(String(value));
    const parent = path.dirname(target);
    return [path.resolve(uploadsDir), path.resolve(voiceDir), path.resolve(chatImagesDir), path.resolve(avatarsDir), path.resolve(loginMusicDir), path.resolve(loginVideoDir)].includes(parent) ? target : '';
  }

  async function removeManagedPartialFile(value) {
    const target = managedPartialPath(value);
    if (!target) return;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await fs.promises.rm(target, { force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {});
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function monitoredDiskStorage(destination, makeFilename) {
    return {
      _handleFile(req, file, callback) {
        makeFilename(req, file, (filenameError, requestedName) => {
          if (filenameError) return callback(filenameError);
          const filename = path.basename(String(requestedName || ''));
          if (!filename || filename !== requestedName) return callback(new Error('无效的上传文件名'));
          if (!hasDiskSpace(diskCheckIntervalBytes)) return callback(diskSpaceError());
          const target = path.join(destination, filename);
          if (!req.syncWatchPartialUploads) req.syncWatchPartialUploads = new Set();
          req.syncWatchPartialUploads.add(target);
          const output = fs.createWriteStream(target, { flags: 'wx' });
          let size = 0;
          let bytesSinceCheck = 0;
          const monitor = new Transform({
            transform(chunk, encoding, done) {
              size += chunk.length;
              const streamLimit = Math.max(0, Number(req.syncWatchStreamLimitBytes) || 0);
              if (streamLimit && size > streamLimit) {
                const error = new Error(req.syncWatchStreamLimitMessage || '上传文件超过允许大小');
                error.code = req.syncWatchStreamLimitCode || 'LIMIT_FILE_SIZE';
                return done(error);
              }
              bytesSinceCheck += chunk.length;
              if (bytesSinceCheck >= diskCheckIntervalBytes) {
                bytesSinceCheck = 0;
                if (!hasDiskSpace(diskCheckIntervalBytes)) return done(diskSpaceError());
              }
              return done(null, chunk);
            }
          });
          pipeline(file.stream, monitor, output, (error) => {
            if (!error) {
              req.syncWatchPartialUploads?.delete(target);
              return callback(null, { destination, filename, path: target, size });
            }
            let cleanupStarted = false;
            let cleanupTimer;
            const cleanup = () => {
              if (cleanupStarted) return;
              cleanupStarted = true;
              clearTimeout(cleanupTimer);
              removeManagedPartialFile(target).finally(() => {
                req.syncWatchPartialUploads?.delete(target);
                callback(error);
              });
            };
            if (output.closed) cleanup();
            else {
              output.once('close', cleanup);
              output.destroy();
              cleanupTimer = setTimeout(cleanup, 1000);
            }
          });
        });
      },
      _removeFile(req, file, callback) {
        const target = file?.path;
        delete file.destination;
        delete file.filename;
        delete file.path;
        if (!target) return callback(null);
        removeManagedPartialFile(target).then(() => callback(null), callback);
      }
    };
  }

  function normalizeRelativePath(value) {
    const parts = String(value || '').replace(/\\/g, '/').split('/').map((part) => cleanText(part, 120)).filter((part) => part && part !== '.' && part !== '..');
    return parts.slice(0, 20).join('/').slice(0, 500);
  }

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const peer = normalizeIp(req.socket?.remoteAddress);
    if (lanAddress && peer !== '127.0.0.1' && normalizeIp(req.socket?.localAddress) !== lanAddress) {
      return res.status(403).json({ success: false, error: '当前网卡未在服务器启动设置中开放' });
    }
    return next();
  });
  app.use((req, res, next) => withRoom(state.defaultRoomId, next));
  app.use((req, res, next) => {
    if (state.admin.lanAccessEnabled !== false || !requestIsLanClient(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(403).json({ success: false, code: 'LAN_ACCESS_DISABLED', error: '服务器已关闭局域网地址访问，请使用公网地址连接' });
    return res.status(403).type('text/plain').send('SyncWatch同步观影 已关闭局域网地址访问，请使用公网地址连接。');
  });
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Geolocation is opt-in at the browser prompt; blocking it here made
    // every member permanently appear as "未授权" even on HTTPS.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(self), display-capture=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-src 'self' http: https:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
    next();
  });
  app.use((req, res, next) => {
    const fetchDestination = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
    const fetchMode = String(req.headers['sec-fetch-mode'] || '').toLowerCase();
    const acceptsHtml = /(?:^|,)\s*text\/html(?:\s*;|\s*,|$)/i.test(String(req.headers.accept || ''));
    const topLevelNavigation = ['GET', 'HEAD'].includes(req.method) && acceptsHtml
      && (!fetchDestination || fetchDestination === 'document') && (!fetchMode || fetchMode === 'navigate');
    if (topLevelNavigation) rememberNavigationSocketHost(req);
    next();
  });
  app.use(compression({
    filter(req, res) {
      return !requestSkipsCompression(req) && compression.filter(req, res);
    }
  }));
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!acceptingMutations) {
      res.setHeader('Connection', 'close');
      return res.status(503).json({ success: false, error: '服务器正在安全关闭，请稍后重试' });
    }
    let complete;
    const active = new Promise((resolve) => { complete = resolve; });
    activeHttpMutations.add(active);
    activeHttpRequests.add(req);
    req.syncWatchMutationPromise = active;
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      activeHttpMutations.delete(active);
      activeHttpRequests.delete(req);
      if (req.syncWatchMutationPromise === active) delete req.syncWatchMutationPromise;
      complete();
    };
    res.once('finish', finish);
    res.once('close', finish);
    return next();
  });
  // Backup imports can legitimately contain embedded original/transcoded media.
  // Keep the larger parser scoped to this authenticated endpoint; all normal
  // API requests retain the much smaller defensive limit below.
  app.use('/api/host/data/import', requireSession, requireHost, express.json({ limit: '2gb' }));
  app.use(express.json({ limit: '128kb' }));

  app.use('/default-avatar', (req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method) && !/^(?:\/(?:[1-9]\d?|100)\.svg)$/.test(req.path)) {
      return res.status(404).type('text/plain').send('Avatar not found');
    }
    return next();
  });

  app.get('/default-avatar/:id.svg', (req, res) => {
    const rawId = String(req.params.id || '');
    if (!/^(?:[1-9]\d?|100)$/.test(rawId)) return res.status(404).type('text/plain').send('Avatar not found');
    const svg = defaultAvatarSvg(Number(rawId));
    if (!svg) return res.status(404).type('text/plain').send('Avatar not found');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(svg));
    return res.send(svg);
  });

  app.post('/api/location/reverse', requireSession, httpRateLimit('location-reverse', 20, 10 * 60 * 1000), async (req, res) => {
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180
      || (Math.abs(latitude) < 0.000001 && Math.abs(longitude) < 0.000001)) {
      return res.status(400).json({ success: false, error: '定位坐标无效' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const endpoint = new URL('https://nominatim.openstreetmap.org/reverse');
      endpoint.searchParams.set('format', 'jsonv2');
      endpoint.searchParams.set('addressdetails', '1');
      endpoint.searchParams.set('zoom', '18');
      endpoint.searchParams.set('lat', latitude.toFixed(7));
      endpoint.searchParams.set('lon', longitude.toFixed(7));
      endpoint.searchParams.set('accept-language', 'zh-CN');
      const response = await fetch(endpoint, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': `SyncWatch/${APP_VERSION} location-reverse` }
      });
      if (!response.ok) return res.status(502).json({ success: false, error: `位置服务返回 ${response.status}` });
      const result = await response.json();
      const address = result?.address && typeof result.address === 'object' ? result.address : {};
      const streetName = address.road || address.pedestrian || address.footway || address.path
        || address.residential || address.neighbourhood || address.quarter || '';
      const street = [streetName, address.house_number || ''].filter(Boolean).join(' ');
      return res.json({
        success: true,
        location: {
          country: cleanText(address.country, 80),
          province: cleanText(address.state || address.province || address.region, 80),
          city: cleanText(address.city || address.town || address.village || address.municipality, 80),
          district: cleanText(address.city_district || address.county || address.suburb || address.borough, 80),
          street: cleanText(street, 120),
          displayName: cleanText(result.display_name, 300)
        }
      });
    } catch (error) {
      return res.status(502).json({ success: false, error: error?.name === 'AbortError' ? '位置服务响应超时' : '暂时无法解析街道位置' });
    } finally {
      clearTimeout(timeout);
    }
  });

  app.get('/login-cube-image/:faceId', (req, res, next) => {
    const faceId = String(req.params.faceId || '').toLowerCase();
    if (!LOGIN_CUBE_FACE_IDS.includes(faceId)) return res.status(404).end();
    const configured = normalizeLoginCubeSettings(state.admin.loginCube).faces.find((face) => face.id === faceId);
    if (!configured?.image?.startsWith(`/login-cube-image/${faceId}`)) return res.status(404).end();
    const filename = loginCubeFaceFile(faceId);
    if (!filename) return res.status(404).end();
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })[path.extname(filename).toLowerCase()];
    if (mime) res.type(mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(filename, (error) => { if (error && !res.headersSent) next(error); });
  });

  app.get('/login-cube-model/:name', (req, res, next) => {
    const name = path.basename(String(req.params.name || ''));
    const model = normalizeLoginCubeSettings(state.admin.loginCube).model;
    if (!model.url || name !== model.storedName || !/^[a-f0-9-]+\.glb$/i.test(name)) return res.status(404).end();
    const filename = loginCubeModelFile(model);
    if (!filename) return res.status(404).end();
    res.type('model/gltf-binary');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(filename, (error) => { if (error && !res.headersSent) next(error); });
  });

  app.get('/login-music/:name', (req, res, next) => {
    const name = path.basename(req.params.name || '');
    if (!/^[a-f0-9-]+\.[a-z0-9]{2,8}$/i.test(name)) return res.status(404).end();
    const track = normalizeLoginMusic(state.admin.loginMusic).tracks.find((entry) => entry.storedName === name || path.basename(entry.url) === name);
    if (!track) return res.status(404).end();
    const target = path.join(loginMusicDir, name);
    if (!fs.existsSync(target)) return res.status(404).end();
    return serveMediaRange(req, res, target, track.mimeType || 'audio/mpeg');
  });

  app.get('/login-video/:name', (req, res) => {
    const name = path.basename(req.params.name || '');
    if (!/^[a-f0-9-]+\.(?:mp4|webm)$/i.test(name)) return res.status(404).end();
    const video = normalizeLoginVideo(state.admin.loginVideo);
    if (video.storedName !== name && path.basename(video.url) !== name) return res.status(404).end();
    const target = path.join(loginVideoDir, name);
    if (!fs.existsSync(target)) return res.status(404).end();
    return serveMediaRange(req, res, target, video.mimeType || 'video/mp4');
  });

  function downloadAssetDetails() {
    const describe = (filename) => {
      try {
        const stats = fs.statSync(filename);
        return stats.isFile() && stats.size > 0 ? {
          available: true, filename: path.basename(filename), size: stats.size, updatedAt: stats.mtime.toISOString()
        } : { available: false };
      } catch (_) { return { available: false }; }
    };
    return {
      windowsClient: describe(activeClientDownloadPath()),
      androidClient: describe(activeAndroidApkPath())
    };
  }

  function downloadAssetPublicState() {
    const details = downloadAssetDetails();
    return {
      androidApkAvailable: details.androidClient.available,
      clientDownloadAvailable: details.windowsClient.available,
      downloadAssetDetails: details
    };
  }

  function downloadAssetUploadSpec(req, file = {}) {
    const kind = cleanText(req.params?.kind, 40).toLowerCase();
    const extension = path.extname(String(file.originalname || '')).toLowerCase();
    if (kind === 'windows-server' && extension === '.exe') {
      return { kind, extension, target: managedClientDownloadPath, label: 'Windows 服务器客户端' };
    }
    if (kind === 'android-client' && extension === '.apk') {
      return { kind, extension, target: managedAndroidApkPath, label: 'Android 客户端' };
    }
    return null;
  }

  function validateDownloadAssetFile(filename, spec) {
    const stats = fs.statSync(filename);
    if (!stats.isFile() || stats.size < DOWNLOAD_ASSET_MIN_BYTES) throw new Error('安装文件不完整，必须至少为 1 MB');
    const handle = fs.openSync(filename, 'r');
    try {
      const first = Buffer.alloc(4); fs.readSync(handle, first, 0, first.length, 0);
      if (spec.extension === '.exe' && first.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('EXE 文件头无效');
      if (['.apk', '.zip'].includes(spec.extension) && first.subarray(0, 2).toString('ascii') !== 'PK') throw new Error('ZIP/APK 文件头无效');
      if (spec.extension === '.dmg') {
        const footer = Buffer.alloc(Math.min(512, stats.size));
        fs.readSync(handle, footer, 0, footer.length, stats.size - footer.length);
        if (!footer.includes(Buffer.from('koly'))) throw new Error('DMG 文件尾签名无效');
      }
    } finally { fs.closeSync(handle); }
    return stats;
  }

  function replaceDownloadAsset(temporary, target) {
    const backup = `${target}.previous-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
    let backedUp = false;
    try {
      if (fs.existsSync(target)) { fs.renameSync(target, backup); backedUp = true; }
      fs.renameSync(temporary, target);
      if (backedUp) fs.rmSync(backup, { force: true });
    } catch (error) {
      if (!fs.existsSync(target) && backedUp && fs.existsSync(backup)) {
        try { fs.renameSync(backup, target); } catch (_) {}
      }
      throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
      if (fs.existsSync(target)) fs.rmSync(backup, { force: true });
    }
  }

  const downloadAssetUpload = multer({
    storage: multer.diskStorage({
      destination(req, file, callback) { callback(null, downloadAssetTemporaryDir); },
      filename(req, file, callback) { callback(null, `.upload-${crypto.randomUUID()}.tmp`); }
    }),
    limits: { files: 1, fileSize: DOWNLOAD_ASSET_FILE_LIMIT_BYTES },
    fileFilter(req, file, callback) {
      const spec = downloadAssetUploadSpec(req, file);
      if (spec) return callback(null, true);
      const error = new Error('文件类型不受支持：Windows 仅允许 EXE，Android 仅允许 APK');
      error.statusCode = 415;
      return callback(error);
    }
  });

  app.post('/api/download-assets/:kind', requireSession, requireHost, httpRateLimit('download-asset-upload', 12, 60 * 60 * 1000), downloadAssetUpload.single('file'), (req, res) => {
    const spec = downloadAssetUploadSpec(req, req.file);
    if (!req.file?.path || !spec) return res.status(400).json({ success: false, error: '请选择有效的安装文件' });
    try {
      const stats = validateDownloadAssetFile(req.file.path, spec);
      replaceDownloadAsset(req.file.path, spec.target);
      const downloads = downloadAssetPublicState();
      io.emit('download-assets-updated', downloads);
      recordOperation({ actor: req.syncWatchSession.username, action: 'download-asset-upload', summary: `更新${spec.label}下载文件：${path.basename(spec.target)}`, scope: 'server' });
      return res.json({ success: true, filename: path.basename(spec.target), size: stats.size, downloads, message: `${spec.label}下载文件已更新` });
    } catch (error) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(400).json({ success: false, error: error.message || '安装文件校验失败' });
    }
  });

  app.get('/api/releases/latest', httpRateLimit('latest-release', 20, 5 * 60 * 1000), async (req, res) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    const result = await latestReleaseChecker.check({ forceRefresh: String(req.query.refresh || '') === '1' });
    if (result.success) return res.json(result);
    return res.status(result.code === 'GITHUB_TIMEOUT' ? 504 : 502).json(result);
  });

  app.get('/api/tunnel-health', (_req, res) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    return res.json({ status: 'ok', name: 'SyncWatch同步观影', version: APP_VERSION });
  });

  app.get('/api/public-config', async (req, res) => {
    // Refresh tunnel state before publishing publicAddress. A Quick Tunnel
    // may exit between polling requests; stale URLs must never be advertised.
    if (tunnelManager?.status) {
      try { synchronizeTunnelUrl(await tunnelManager.status()); }
      catch (_) { forgetTunnelUrl(); }
    }
    const directServerHost = Boolean(directLoopbackHostRequest(requestPeerAddress(req), req.headers)
      && (!hostControlToken || isHostToken(req.headers['x-syncwatch-host-token'])));
    const requestHost = cleanText(req.get('host'), 255);
    const addressState = clientFacingAddressState({
      runtimeRole: directServerHost ? 'server' : 'client',
      currentOrigin: requestHost ? `${req.protocol === 'https' ? 'https' : 'http'}://${requestHost}` : '',
      configuredPublicAddress: activeTunnelPublicUrl || configuredPublicUrl,
      lanAddresses: advertisedNetworkAddresses()
    });
    const uploadLimitBytes = Number(state.admin.uploadLimitBytes);
    const uploadMinBytes = Number(state.admin.uploadMinBytes);
    return res.json({
    name: 'SyncWatch同步观影', version: APP_VERSION, roomName: roomConfig(state.defaultRoomId).name, roomId: state.defaultRoomId,
    defaultRoomId: state.defaultRoomId, roomsEnabled: true,
    accessPasswordRequired: Boolean(roomConfig(state.defaultRoomId).passwordHash), defaultAdminPassword: Boolean(state.admin.mustChangePassword),
    // Zero explicitly means unlimited. Do not fall back to the basic tier's
    // 10 GiB hint, otherwise clients keep showing a limit after the admin
    // disabled both upload guards.
    minUploadBytes: Number.isFinite(uploadMinBytes) && uploadMinBytes >= 0 ? uploadMinBytes : 0, maxUploadBytes: Number.isFinite(uploadLimitBytes) && uploadLimitBytes >= 0 ? uploadLimitBytes : 0, uploadTimeLimitSeconds: state.admin.uploadTimeLimitSeconds, uploadVideoDurationLimitSeconds: state.admin.uploadVideoDurationLimitSeconds,
    allowedUploadCategories: allowedUploadCategories(), allowTextUploads: state.admin.allowTextUploads !== false,
    supportedExtensions: [...FILE_TYPES.keys()].map((extension) => extension.slice(1)), port: actualPort,
    addresses: addressState.addresses, publicAddress: addressState.shareAddress,
    lanAccessEnabled: state.admin.lanAccessEnabled !== false,
    ...downloadAssetPublicState(),
    serverHostLoginAvailable: directServerHost,
    serverHostPasswordlessManagementAvailable: Boolean(state.admin.localPasswordlessManagementEnabled !== false
      && directLoopbackHostRequest(requestPeerAddress(req), req.headers)
      && hostControlToken && isHostToken(req.headers['x-syncwatch-host-token'])),
    serverHostPasswordlessRoomAvailable: Boolean(state.admin.localPasswordlessRoomEnabled !== false
      && directLoopbackHostRequest(requestPeerAddress(req), req.headers)
      && hostControlToken && isHostToken(req.headers['x-syncwatch-host-token'])),
    // Compatibility alias for older clients. It represents only the
    // management-only entry and cannot switch the server-side session mode.
    serverHostPasswordlessAvailable: Boolean(state.admin.localPasswordlessManagementEnabled !== false
      && directLoopbackHostRequest(requestPeerAddress(req), req.headers)
      && hostControlToken && isHostToken(req.headers['x-syncwatch-host-token'])),
    passwordRecoveryAvailable: mailRecoveryAvailable('account') || mailRecoveryAvailable('admin'),
    accountPasswordRecoveryAvailable: mailRecoveryAvailable('account'), adminPasswordRecoveryAvailable: mailRecoveryAvailable('admin'),
    registrationEmailVerificationRequired: registrationEmailVerificationAvailable(), emailBindingAvailable: emailBindingAvailable(),
    passwordPolicy: normalizePasswordPolicy(state.admin.passwordPolicy), usernamePolicy: normalizeUsernamePolicy(state.admin.usernamePolicy), experiencePerMinute: Math.max(0, Math.floor(Number(state.admin.experiencePerMinute) || 0)),
    contact: normalizeAdminContact(state.admin.contact), legalAgreement: normalizeLegalAgreement(state.admin.legalAgreement), marqueeNotice: normalizeMarqueeNotice(state.admin.marqueeNotice),
    loginCube: normalizeLoginCubeSettings(state.admin.loginCube),
    loginMusic: normalizeLoginMusic(state.admin.loginMusic),
    loginVideo: normalizeLoginVideo(state.admin.loginVideo),
    f11PromptEnabled: state.admin.f11PromptEnabled !== false,
    initialPasswordReminderEnabled: state.admin.initialPasswordReminderEnabled !== false,
    downloadButtonsVisible: state.admin.downloadButtonsVisible !== false,
    locationStatusNoticesEnabled: state.admin.locationStatusNoticesEnabled !== false,
    locationAuthorizationRequestsEnabled: state.admin.locationAuthorizationRequestsEnabled !== false,
    roomEntryNotice: normalizeRoomEntryNotice(state.admin.roomEntryNotice),
    // Start every new client on source quality. Users may still choose and
    // retain smooth/auto locally, but proxy headers must not downgrade them.
    defaultPlaybackQuality: 'original', branding: normalizeBranding(state.admin.branding), uiCopy: normalizeUiCopy(state.admin.uiCopy), roomIdPolicy: normalizeRoomIdPolicy(state.admin.roomIdPolicy),
    clientIp: normalizeIp(getRequestIp(req))
    });
  });

  app.post('/api/host/reset-admin-password', httpRateLimit('host-reset-admin-password', 5, 10 * 60 * 1000), async (req, res) => {
    const localHost = !hostControlToken && directLoopbackHostRequest(requestPeerAddress(req), req.headers);
    if (!isHostToken(req.headers['x-syncwatch-host-token']) && !localHost) {
      return res.status(403).json({ success: false, error: '仅服务器设备可以使用一键重置管理员密码' });
    }
    const newPassword = String(req.body?.newPassword || '');
    const passwordError = passwordPolicyError(newPassword, { administrator: true });
    if (passwordError) return res.status(400).json({ success: false, error: passwordError });
    const passwordHash = await makePasswordHashAsync(newPassword);
    setAdminPasswordHash(passwordHash); state.admin.mustChangePassword = false;
    clearAdminVerification();
    if (state.accounts.admin) {
      state.accounts.admin.passwordHash = passwordHash;
      state.accounts.admin.mustChangePassword = false;
      state.accounts.admin.passwordChangedAt = state.admin.passwordChangedAt;
    }
    clearPasswordResetState('admin'); clearPasswordResetState('account:admin');
    revokeUserSessions('admin', 'auth-error', '管理员密码已在服务器设备上重置，请使用新密码登录');
    recordOperation({ actor: 'server-host', action: 'admin-password-reset', summary: '服务器设备一键重置超级管理员密码', scope: 'server' });
    persist();
    return res.json({ success: true, message: '超级管理员密码已重置，现有 admin 登录已退出' });
  });

  app.get('/api/online-rooms', httpRateLimit('online-rooms', 60, 60 * 1000), (req, res) => res.json({
    success: true,
    rooms: Object.values(state.rooms).filter(discoverableRoom).map((room) => ({
      id: room.id, name: room.name, ownerUsername: room.ownerUsername,
      ownerName: state.accounts[room.ownerUsername]?.displayName || room.ownerUsername,
      maxUsers: room.maxUsers, online: roomUsers(room.id).length,
      passwordRequired: Boolean(room.passwordHash), closed: Boolean(room.closed), temporary: Boolean(room.temporary), allowGuests: room.allowGuests !== false
    })).sort((left, right) => right.online - left.online || String(left.name).localeCompare(String(right.name), 'zh-CN'))
  }));

  app.get('/api/client-download', httpRateLimit('client-download', 12, 60 * 60 * 1000), (req, res) => {
    const target = activeClientDownloadPath();
    if (!target || !fs.existsSync(target)) return res.status(404).json({ success: false, error: '电脑客户端安装程序尚未放入服务器部署目录' });
    return serveFileDownload(req, res, target, 'SyncWatch-Experience-Client-Portable-v2.4.3-x64.exe');
  });

  app.get('/api/lan-rooms', httpRateLimit('lan-rooms', 60, 60 * 1000), (req, res) => res.json({
    success: true, server: os.hostname(), version: APP_VERSION, port: actualPort, addresses: advertisedNetworkAddresses(),
    rooms: Object.values(state.rooms).filter(discoverableRoom).map((room) => ({
      id: room.id, name: room.name, ownerUsername: room.ownerUsername,
      ownerName: state.accounts[room.ownerUsername]?.displayName || room.ownerUsername,
      maxUsers: room.maxUsers, online: roomUsers(room.id).length, passwordRequired: Boolean(room.passwordHash),
      temporary: Boolean(room.temporary), allowGuests: room.allowGuests !== false
    }))
  }));

  app.get('/api/rooms/:roomId/public', httpRateLimit('room-info', 60, 60 * 1000), (req, res) => {
    const id = normalizeRoomId(req.params.roomId);
    const room = id && state.rooms[id];
    if (!discoverableRoom(room)) return res.status(404).json({ success: false, error: room?.banned ? '房间已被服务器封禁' : '房间号不存在或已由房主存档' });
    return res.json({ success: true, room: { id: room.id, name: room.name, maxUsers: room.maxUsers, online: roomUsers(room.id).length, passwordRequired: Boolean(room.passwordHash), temporary: Boolean(room.temporary), allowGuests: room.allowGuests !== false } });
  });

  app.post('/api/session', requireSession, (req, res) => {
    const secure = requestUsesForwardedHttps(req);
    const maxAge = Math.max(1, Math.floor((req.syncWatchSession.expiresAt - Date.now()) / 1000));
    res.setHeader('Set-Cookie', `syncwatch_session=${encodeURIComponent(req.syncWatchToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
    res.json({ success: true });
  });

  app.post('/api/logout', requireSession, async (req, res) => {
    const session = req.syncWatchSession;
    const room = roomConfig(session.roomId);
    const ownerExitAction = ['close', 'delete', 'leave'].includes(req.body?.ownerExitAction) ? req.body.ownerExitAction : 'leave';
    const account = state.accounts[session.username];
    const clientIp = getRequestIp(req);
    const isGuest = Boolean(account?.guest);
    const device = account?.devices?.find((entry) => entry.id === session.deviceId) || account?.devices?.[0] || {};
    recordAccountAudit({
      category: 'logout', action: ownerExitAction === 'leave' ? 'logout' : `logout-${ownerExitAction}`, result: 'success',
      username: session.username, ipAddress: getRequestIp(req), deviceName: device.name,
      platform: device.platform, browser: device.browser, message: '用户主动退出登录'
    });
    if (session.username === room.ownerUsername && ownerExitAction !== 'leave') {
      const result = await dissolveRoom(room.id, session.username, ownerExitAction === 'close');
      if (isGuest) await purgeGuestAccount(session.username, clientIp);
      res.setHeader('Set-Cookie', 'syncwatch_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return res.json(result);
    }
    sessions.delete(req.syncWatchToken);
    res.setHeader('Set-Cookie', 'syncwatch_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    // Remove the member before acknowledging logout so every remaining
    // client receives the presence update in the same turn. Deferring this
    // to setImmediate left a short window where a logged-out account still
    // appeared online and could block a replacement login.
    const targetSocket = io.sockets.sockets.get(session.socketId);
    stopScreenShare(session.socketId);
    removeOnlineUser(session.socketId, { scheduleClose: false, reason: 'logout' });
    res.json({ success: true });
    setImmediate(() => {
      targetSocket?.disconnect(true);
      if (isGuest) void purgeGuestAccount(session.username, clientIp).catch((error) => console.error('清除游客数据失败:', error.message));
    });
  });

  app.get('/api/server-info', requireSession, (req, res) => res.json({
    version: APP_VERSION, port: actualPort, addresses: advertisedNetworkAddresses(), users: usersList(),
    filesCount: state.files.filter((file) => file.roomId === currentRoomId() && file.status === 'approved').length,
    ...(req.syncWatchSession.isServerHost ? { dataDir } : {}),
    room: roomSnapshot(), permissions: permissionFor(req.syncWatchSession.username), isServerHost: Boolean(req.syncWatchSession.isServerHost)
  }));

  app.post('/api/web-probe', requireSession, httpRateLimit('web-probe', 20, 60 * 1000), async (req, res) => {
    const targetUrl = cleanText(req.body?.url, SHARED_WEB_URL_LIMIT);
    if (!targetUrl) return res.status(400).json({ success: false, error: '请输入要识别的网页地址' });
    try {
      const result = await probePublicWebPage(targetUrl);
      return res.json({ success: true, ...result });
    } catch (error) {
      return res.status(400).json({ success: false, error: cleanText(error.message, 180) || '无法识别该网页的公开媒体资源' });
    }
  });

  app.get('/api/files', requireSession, (req, res) => {
    res.json(state.files.filter((file) => canSeeFile(req.syncWatchSession, file)).map(publicFile).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt))));
  });

  app.get('/api/android-apk', httpRateLimit('android-apk-download', 12, 60 * 60 * 1000), (req, res) => {
    const target = activeAndroidApkPath();
    if (!fs.existsSync(target)) return res.status(404).json({ success: false, error: '安卓安装包尚未生成' });
    return serveFileDownload(req, res, target, 'SyncWatch-Android-v2.4.3-universal.apk');
  });

  const mediaRoute = (req, res) => {
    const storedName = safeStoredName(req.params.storedName) ? req.params.storedName : '';
    const file = state.files.find((entry) => entry.storedName === storedName);
    if (!file || !canSeeFile(req.syncWatchSession, file)) return res.status(404).end();
    const availability = mediaFileAvailability(file);
    if (!availability.available) return sendUnavailableMedia(res, file);
    if (file.category === 'text') {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      return serveMediaRange(req, res, availability.target, 'text/plain; charset=utf-8');
    }
    return serveMediaRange(req, res, availability.target, file.mimeType);
  };
  app.get('/media/:storedName', requireSession, mediaRoute);
  app.head('/media/:storedName', requireSession, mediaRoute);

  const compatibleMediaRoute = (req, res) => {
    const name = path.basename(req.params.name);
    if (!/^[a-f0-9-]{16,80}\.mp4$/i.test(name)) return res.status(404).end();
    const file = state.files.find((entry) => compatibilityFileName(entry) === name);
    if (!file || !canSeeFile(req.syncWatchSession, file)) return res.status(404).end();
    const compatibility = mediaCompatibilitySummary(file);
    if (!compatibility.required || !compatibility.ready) {
      if (compatibility.required) enqueueMediaCompatibility(file, { priority: true });
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ success: false, code: 'MEDIA_COMPATIBILITY_PREPARING', error: '服务器正在生成公网兼容版，请稍后重试', compatibility });
    }
    return serveMediaRange(req, res, path.join(compatibleMediaDir, name), 'video/mp4');
  };
  app.get('/compatible-media/:name', requireSession, compatibleMediaRoute);
  app.head('/compatible-media/:name', requireSession, compatibleMediaRoute);

  app.get('/thumbnail/:name', requireSession, (req, res) => {
    const name = path.basename(req.params.name);
    if (!state.files.some((file) => file.thumbnailName === name && canSeeFile(req.syncWatchSession, file))) return res.status(404).end();
    // Thumbnails are generated asynchronously after upload. Prevent a
    // transient 404/partial response from being cached by Android WebView;
    // the client can retry once when generation finishes.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.sendFile(path.join(thumbnailsDir, name));
  });

  app.get('/subtitle/:name', requireSession, (req, res) => {
    const name = path.basename(req.params.name);
    if (!state.files.some((file) => file.vttName === name && canSeeFile(req.syncWatchSession, file))) return res.status(404).end();
    res.type('text/vtt; charset=utf-8');
    return res.sendFile(path.join(subtitlesDir, name));
  });

  app.get('/voice/:name', requireSession, async (req, res, next) => {
    try {
      const sessionRoomId = req.syncWatchSessionRoomId;
      const name = path.basename(req.params.name);
      if (!/^[a-f0-9-]+\.(webm|ogg|mp4|m4a|mp3|aac|wav)$/i.test(name)) return res.status(404).end();
      const voiceUrl = `/voice/${name}`;
      const message = await findStoredVoiceMessage(voiceUrl, sessionRoomId);
      if (!message || !messageVisible(message, req.syncWatchSession.username, sessionRoomId)) return res.status(404).end();
      return res.sendFile(path.join(voiceDir, name));
    } catch (error) { return next(error); }
  });

  app.get('/chat-image/:name', requireSession, async (req, res, next) => {
    try {
      const sessionRoomId = req.syncWatchSessionRoomId;
      const name = path.basename(req.params.name);
      if (!/^[a-f0-9-]+\.(jpg|jpeg|png|webp|gif)$/i.test(name)) return res.status(404).end();
      const imageUrl = `/chat-image/${name}`;
      const message = await findStoredImageMessage(imageUrl, sessionRoomId);
      const friendMessage = (state.accounts[req.syncWatchSession.username]?.friendMessages || [])
        .find((entry) => entry.imageUrl === imageUrl
          && (entry.from === req.syncWatchSession.username || entry.to === req.syncWatchSession.username));
      if ((!message || !messageVisible(message, req.syncWatchSession.username, sessionRoomId)) && !friendMessage) return res.status(404).end();
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.sendFile(path.join(chatImagesDir, name));
    } catch (error) { return next(error); }
  });

  app.get('/avatar/:name', requireSession, (req, res) => {
    const name = path.basename(req.params.name);
    if (!/^[a-f0-9-]+\.(jpg|jpeg|png|webp|gif)$/i.test(name)
      || !Object.values(state.accounts).some((account) => account.avatar === `/avatar/${name}`)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(path.join(avatarsDir, name));
  });

  const mediaStorage = monitoredDiskStorage(uploadsDir, (req, file, callback) => {
    callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  });

  const loginMusicStorage = monitoredDiskStorage(loginMusicDir, (req, file, callback) => {
    callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase() || '.audio'}`);
  });
  const loginMusicUpload = multer({
    storage: loginMusicStorage,
    limits: { files: LOGIN_MUSIC_TRACK_LIMIT, fields: 2, parts: LOGIN_MUSIC_TRACK_LIMIT + 4, fileSize: LOGIN_MUSIC_FILE_LIMIT_BYTES },
    fileFilter(req, file, callback) {
      const extension = path.extname(file.originalname).toLowerCase();
      const known = FILE_TYPES.get(extension);
      const mime = String(file.mimetype || '').toLowerCase();
      const accepted = (known?.[0] === 'audio' || mime.startsWith('audio/')) && extension.length <= 10;
      callback(accepted ? null : new Error('登录音乐仅支持常见音频格式（MP3、WAV、M4A、AAC、OGG、FLAC 等）'), accepted);
    }
  }).array('music', LOGIN_MUSIC_TRACK_LIMIT);

  async function removeLoginMusicUploads(files) {
    await Promise.all((Array.isArray(files) ? files : [])
      .map((file) => file?.path)
      .filter(Boolean)
      .map((filename) => removeManagedPartialFile(filename)));
  }

  const loginMusicFormatsByExtension = new Map([
    ['.mp3', ['mp3']], ['.wav', ['wav']], ['.m4a', ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2']],
    ['.aac', ['aac']], ['.flac', ['flac']], ['.ogg', ['ogg']], ['.opus', ['ogg']], ['.oga', ['ogg']],
    ['.wma', ['asf']], ['.ape', ['ape']], ['.amr', ['amr']], ['.ac3', ['ac3']],
    ['.aiff', ['aiff']], ['.aif', ['aiff']], ['.mid', ['smf']], ['.midi', ['smf']]
  ]);

  async function validateLoginMusicUpload(file) {
    let probe;
    try {
      const output = await captureProcess(ffprobePath, [
        '-v', 'error', '-print_format', 'json', '-select_streams', 'a', '-count_frames',
        '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels,nb_read_frames,duration:format=format_name,duration',
        file.path
      ], 60000);
      probe = JSON.parse(output);
    } catch (_) {
      const error = new Error(`登录音乐无法解码：${normalizeOriginalName(file.originalname)}`);
      error.code = 'LOGIN_MUSIC_INVALID';
      throw error;
    }
    const audioStream = Array.isArray(probe.streams)
      ? probe.streams.find((stream) => stream?.codec_type === 'audio')
      : null;
    const extension = path.extname(String(file.originalname || '')).toLowerCase();
    const expectedFormats = loginMusicFormatsByExtension.get(extension) || [];
    const detectedFormats = String(probe.format?.format_name || '').toLowerCase().split(',').filter(Boolean);
    if (!audioStream || !String(audioStream.codec_name || '').trim()
      || Number(audioStream.sample_rate) <= 0 || Number(audioStream.channels) <= 0
      || Number(audioStream.nb_read_frames) <= 0
      || !expectedFormats.some((format) => detectedFormats.includes(format))) {
      const error = new Error(`登录音乐不包含可解码的音频流：${normalizeOriginalName(file.originalname)}`);
      error.code = 'LOGIN_MUSIC_INVALID';
      throw error;
    }
  }

  app.post('/api/login-music-upload', requireSession, ensureDiskSpace, loginMusicUpload, async (req, res) => {
    const session = req.syncWatchSession;
    if (!(session?.isServerHost || isSuperAdmin(session?.username) || session?.adminVerifiedAt)) {
      await removeLoginMusicUploads(req.files);
      return res.status(403).json({ success: false, error: '只有服务器主机或超级管理员可以上传登录音乐' });
    }
    if (!req.files?.length) return res.status(400).json({ success: false, error: '没有选择音乐文件' });
    if (!ffprobePath || !fs.existsSync(ffprobePath)) {
      await removeLoginMusicUploads(req.files);
      return res.status(503).json({ success: false, error: '服务器未找到 FFprobe，无法安全校验登录音乐' });
    }
    try {
      for (const file of req.files) await validateLoginMusicUpload(file);
    } catch (error) {
      await removeLoginMusicUploads(req.files);
      return res.status(415).json({ success: false, code: error.code || 'LOGIN_MUSIC_INVALID', error: error.message });
    }
    const tracks = (req.files || []).map((file) => ({
      id: crypto.randomUUID(), title: normalizeOriginalName(file.originalname).replace(/\.[^.]+$/, ''), originalName: normalizeOriginalName(file.originalname),
      storedName: file.filename, url: `/login-music/${encodeURIComponent(file.filename)}`, mimeType: file.mimetype || 'audio/mpeg', size: file.size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex'), createdAt: new Date().toISOString()
    }));
    return res.json({ success: true, tracks, url: tracks[0].url, message: `已上传 ${tracks.length} 首登录音乐` });
  });

  const loginCubeModelUpload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fields: 0, parts: 2, fileSize: LOGIN_CUBE_MODEL_LIMIT_BYTES },
    fileFilter(req, file, callback) {
      const extension = path.extname(String(file.originalname || '')).toLowerCase();
      const mime = String(file.mimetype || '').toLowerCase();
      const accepted = extension === '.glb' && (!mime || ['application/octet-stream', 'model/gltf-binary'].includes(mime));
      const error = accepted ? null : Object.assign(new Error('仅支持单文件 GLB 2.0 模型，不支持 JSON GLTF 或外部资源'), { statusCode: 415 });
      callback(error, accepted);
    }
  }).single('model');

  app.post('/api/login-cube-model', requireSession, requireServerAdministrator, ensureDiskSpace, loginCubeModelUpload, (req, res) => {
    const session = req.syncWatchSession;
    if (!req.file?.buffer?.length) return res.status(400).json({ success: false, error: '没有选择 GLB 模型文件' });
    try { validateLoginCubeGlb(req.file.buffer); }
    catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    const storedName = `${crypto.randomUUID()}.glb`;
    const target = path.join(loginCubeModelDir, storedName);
    const temporary = path.join(loginCubeModelDir, `.${storedName}.${process.pid}.tmp`);
    const previous = normalizeLoginCubeSettings(state.admin.loginCube);
    const previousFilename = loginCubeModelFile(previous.model);
    let installed = false;
    try {
      fs.mkdirSync(loginCubeModelDir, { recursive: true });
      fs.writeFileSync(temporary, req.file.buffer, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, target); installed = true;
      const timestamp = Date.now();
      const model = normalizeLoginCubeModel({
        url: `/login-cube-model/${storedName}?v=${timestamp}`, storedName,
        originalName: normalizeOriginalName(req.file.originalname), size: req.file.buffer.length,
        sha256: crypto.createHash('sha256').update(req.file.buffer).digest('hex'), uploadedAt: new Date(timestamp).toISOString()
      });
      state.admin.loginCube = normalizeLoginCubeSettings({ ...previous, model, updatedAt: new Date().toISOString() }, previous);
      persist();
      if (previousFilename && previousFilename !== target) fs.rmSync(previousFilename, { force: true });
      io.emit('login-cube-updated', state.admin.loginCube);
      recordOperation({ actor: session.username, action: 'login-cube-model', summary: `上传登录页 GLB 模型：${model.originalName}`, scope: 'server' });
      return res.json({ success: true, loginCube: state.admin.loginCube, model, message: 'GLB 模型已通过安全校验并同步' });
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      if (installed) fs.rmSync(target, { force: true });
      state.admin.loginCube = previous;
      return res.status(500).json({ success: false, error: `保存登录模型失败：${error.message}` });
    }
  });

  app.delete('/api/login-cube-model', requireSession, requireServerAdministrator, (req, res) => {
    const session = req.syncWatchSession;
    const previous = normalizeLoginCubeSettings(state.admin.loginCube);
    const target = loginCubeModelFile(previous.model);
    state.admin.loginCube = normalizeLoginCubeSettings({
      ...previous, displayMode: previous.displayMode === 'model' ? 'cube' : previous.displayMode,
      model: {}, updatedAt: new Date().toISOString()
    }, previous);
    persist();
    if (target) fs.rmSync(target, { force: true });
    io.emit('login-cube-updated', state.admin.loginCube);
    recordOperation({ actor: session.username, action: 'login-cube-model-delete', summary: '删除登录页自定义 GLB 模型', scope: 'server' });
    return res.json({ success: true, loginCube: state.admin.loginCube, message: '自定义模型已删除，登录页已恢复 3D 立方体' });
  });

  const loginVideoStorage = monitoredDiskStorage(loginVideoDir, (req, file, callback) => {
    callback(null, `${crypto.randomUUID()}.source`);
  });
  const loginVideoUpload = multer({
    storage: loginVideoStorage,
    limits: { files: 1, fields: 2, parts: 4, fileSize: LOGIN_VIDEO_FILE_LIMIT_BYTES },
    fileFilter(req, file, callback) {
      // Extension and MIME labels are unreliable. FFprobe below is the
      // authority for whether this privileged upload is a decodable video.
      callback(null, true);
    }
  }).single('video');

  app.post('/api/login-video-upload', requireSession, ensureDiskSpace, loginVideoUpload, async (req, res, next) => {
    const session = req.syncWatchSession;
    if (!(session?.isServerHost || isSuperAdmin(session?.username) || session?.adminVerifiedAt)) {
      if (req.file?.path) fs.rmSync(req.file.path, { force: true });
      return res.status(403).json({ success: false, error: '只有服务器主机或超级管理员可以上传登录背景视频' });
    }
    if (!req.file?.path) return res.status(400).json({ success: false, error: '没有选择登录背景视频' });
    const source = req.file.path;
    const finalName = `${crypto.randomUUID()}.mp4`;
    const finalPath = path.join(loginVideoDir, finalName);
    const partialPath = path.join(loginVideoDir, `${finalName}.partial.mp4`);
    try {
      if (!ffprobePath || !fs.existsSync(ffprobePath) || !ffmpegPath || !fs.existsSync(ffmpegPath)) {
        throw new Error('服务器未找到 FFmpeg/FFprobe，无法安全探测和转换登录背景视频');
      }
      const probeOutput = await captureProcess(ffprobePath, [
        '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', source
      ], 60000);
      const probe = JSON.parse(probeOutput);
      const videoStream = probe.streams?.find((stream) => stream.codec_type === 'video');
      if (!videoStream || Number(videoStream.width) < 2 || Number(videoStream.height) < 2) throw new Error('上传文件不包含有效的视频画面');
      const width = Math.max(2, Number(videoStream.width) || LOGIN_VIDEO_MAX_WIDTH);
      const height = Math.max(2, Number(videoStream.height) || LOGIN_VIDEO_MAX_HEIGHT);
      const ratio = Math.min(1, LOGIN_VIDEO_MAX_WIDTH / width, LOGIN_VIDEO_MAX_HEIGHT / height);
      const targetWidth = Math.max(2, Math.floor((width * ratio) / 2) * 2);
      const targetHeight = Math.max(2, Math.floor((height * ratio) / 2) * 2);
      const duration = Math.max(1, Number(probe.format?.duration) || Number(videoStream.duration) || 1);
      const timeoutMs = Math.min(12 * 60 * 60 * 1000, Math.max(10 * 60 * 1000, duration * 10000));
      await captureProcess(ffmpegPath, [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', source,
        '-map', '0:v:0', '-an', '-sn', '-dn',
        '-vf', `scale=${targetWidth}:${targetHeight}:flags=lanczos,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-r', '30', '-g', '60',
        '-movflags', '+faststart', partialPath
      ], timeoutMs);
      const outputProbe = JSON.parse(await captureProcess(ffprobePath, [
        '-v', 'quiet', '-print_format', 'json', '-show_streams', partialPath
      ], 60000));
      const outputVideo = outputProbe.streams?.find((stream) => stream.codec_type === 'video');
      if (String(outputVideo?.codec_name || '').toLowerCase() !== 'h264' || String(outputVideo?.pix_fmt || '').toLowerCase() !== 'yuv420p') {
        throw new Error('FFmpeg 未生成浏览器兼容的 H.264 视频');
      }
      fs.renameSync(partialPath, finalPath);
      const video = normalizeLoginVideo({
        enabled: false, title: normalizeOriginalName(req.file.originalname).replace(/\.[^.]+$/, ''),
        storedName: finalName, originalName: normalizeOriginalName(req.file.originalname),
        mimeType: 'video/mp4', size: fs.statSync(finalPath).size,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      return res.json({ success: true, loginVideo: video, video, ...video, message: '登录背景视频已上传并转换为浏览器兼容格式' });
    } catch (error) {
      fs.rmSync(partialPath, { force: true });
      fs.rmSync(finalPath, { force: true });
      return next(error);
    } finally {
      fs.rmSync(source, { force: true });
    }
  });

  function mediaUpload(req, res, next) {
    const sessionRoomId = req.syncWatchSessionRoomId;
    const permission = permissionFor(req.syncWatchSession.username, sessionRoomId);
    if (!permission.upload) return res.status(403).json({ success: false, error: '您没有上传权限，请联系房主' });
    const policyExempt = uploadPolicyExempt(req.syncWatchSession);
    const limit = policyExempt ? HARD_MEDIA_UPLOAD_LIMIT_BYTES : uploadLimitForAccount(req.syncWatchSession.username);
    const middleware = multer({
      storage: mediaStorage, limits: { files: 1, fields: 2, parts: 4, fieldSize: 2048, fileSize: limit },
      fileFilter(request, file, callback) {
        const extension = path.extname(file.originalname).toLowerCase();
        const type = resolveFileType(file.originalname, file.mimetype);
        if (!type) return callback(new Error('不支持此文件格式'));
        const [category, defaultMime] = type;
        if (category === 'text' && state.admin.allowTextUploads === false) {
          const error = new Error('服务器已关闭文本文件上传');
          error.code = 'TEXT_UPLOAD_DISABLED';
          return callback(error);
        }
        if (category === 'text' && !textUploadMimeAllowed(file.mimetype)) {
          const error = new Error('文本文件的扩展名与 MIME 类型不匹配');
          error.code = 'INVALID_TEXT_CONTENT';
          return callback(error);
        }
        if (category === 'text') {
          request.syncWatchStreamLimitBytes = TEXT_UPLOAD_LIMIT_BYTES;
          request.syncWatchStreamLimitCode = 'TEXT_FILE_TOO_LARGE';
          request.syncWatchStreamLimitMessage = '单个文本文件不能超过 10MB';
        }
        const uploadBan = mediaUploadBanFor(request.syncWatchSessionRoomId, file.originalname);
        if (uploadBan) {
          const error = new Error('该影片已被服务器管理员禁止上传');
          error.code = 'MEDIA_UPLOAD_BANNED';
          error.originalName = normalizeOriginalName(file.originalname);
          return callback(error);
        }
        if (!policyExempt && !uploadCategoryAllowed(category)) {
          const error = new Error(`当前服务器只允许上传${allowedUploadCategories().join('、')}类型文件`);
          error.code = 'UPLOAD_CATEGORY_NOT_ALLOWED';
          error.category = category;
          error.originalName = normalizeOriginalName(file.originalname);
          return callback(error);
        }
        request.syncWatchUploadCategory = category;
        request.syncWatchUploadMime = defaultMime;
        return callback(null, true);
      }
    }).single('file');
    let expired = false;
    const seconds = state.admin.uploadTimeLimitSeconds;
    const timer = seconds > 0 ? setTimeout(() => {
      expired = true;
      req.destroy(new Error(`上传超过管理员设置的 ${seconds} 秒限制`));
    }, seconds * 1000) : null;
    const cleanupAborted = () => { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); };
    req.once('aborted', cleanupAborted);
    middleware(req, res, (error) => {
      req.off('aborted', cleanupAborted);
      if (timer) clearTimeout(timer);
      if (expired && !error) return next(new Error(`上传超过管理员设置的 ${seconds} 秒限制`));
      if (!error && req.file && !uploadPolicyExempt(req.syncWatchSession)) {
        const minimum = Math.max(0, Number(state.admin.uploadMinBytes) || 0);
        if (minimum > 0 && Number(req.file.size) < minimum) {
          fs.rmSync(req.file.path, { force: true });
          const minimumError = new Error(`文件小于管理员设置的最小 ${formatBytesForUploadError(minimum)} 上传限制`);
          minimumError.code = 'LIMIT_FILE_SIZE_MIN';
          return next(minimumError);
        }
      }
      return next(error);
    });
  }

  let ffprobePath = options.ffprobePath;
  let ffmpegPath = options.ffmpegPath;
  try { if (ffprobePath === undefined) ffprobePath = require('ffprobe-static').path; } catch (_) { ffprobePath = ''; }
  try { if (ffmpegPath === undefined) ffmpegPath = require('ffmpeg-static'); } catch (_) { ffmpegPath = ''; }
  ffprobePath = unpackedBinary(ffprobePath);
  ffmpegPath = unpackedBinary(ffmpegPath);

  function updateCompatibilityProgress(record, progress, force = false, processedSeconds = 0, durationSeconds = 0) {
    if (!record || cancelledMediaRecords.has(record) || state.files.find((file) => file.id === record.id) !== record) return;
    const current = record.compatibility || {};
    const nextProgress = Math.max(0, Math.min(99, Math.floor(Number(progress) || 0)));
    const now = Date.now();
    if (!force && nextProgress < Number(current.progress || 0) + 5 && now - Number(current.lastBroadcastAt || 0) < 5000) return;
    const startedAtMs = Date.parse(current.startedAt || '') || now;
    const elapsedSeconds = Math.max(0, (now - startedAtMs) / 1000);
    const processed = Math.max(0, Number(processedSeconds) || 0);
    const duration = Math.max(processed, Number(durationSeconds) || 0);
    const speedRatio = elapsedSeconds > 0 && processed > 0 ? processed / elapsedSeconds : 0;
    const etaSeconds = speedRatio > 0 && duration > processed ? (duration - processed) / speedRatio : 0;
    record.compatibility = {
      ...current, fileName: compatibilityFileName(record), status: 'converting', progress: nextProgress,
      lastBroadcastAt: now, elapsedSeconds, speedRatio, etaSeconds, error: ''
    };
    emitFileToVisible('file-updated', record);
  }

  function runCompatibilityProcess(args, record) {
    return new Promise((resolve, reject) => {
      const duration = Math.max(1, Number(record.metadata?.duration) || 1);
      const timeoutMs = Math.min(12 * 60 * 60 * 1000, Math.max(60 * 60 * 1000, duration * 8000));
      const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      child.syncWatchRecord = record;
      mediaCompatibilityProcesses.add(child);
      let settled = false;
      let stderr = '';
      let progressBuffer = '';
      let timer = null;
      let forceTimer = null;
      let settleTimer = null;
      let abortedError = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceTimer);
        clearTimeout(settleTimer);
        callback(value);
      };
      child.syncWatchAbort = (reason = '服务器关闭，兼容媒体生成已终止') => {
        abortedError = new Error(reason);
        abortedError.code = 'SERVER_SHUTDOWN';
        terminateProcessTree(child, true);
      };
      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        if (stderr.length < 1024 * 1024) stderr += text;
        progressBuffer += text;
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() || '';
        for (const line of lines) {
          const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
          if (!match) continue;
          const seconds = Number(match[1]) / 1000000;
          updateCompatibilityProgress(record, (seconds / duration) * 100, false, seconds, duration);
        }
      });
      child.on('error', (error) => { mediaCompatibilityProcesses.delete(child); finish(reject, abortedError || error); });
      child.on('close', (code) => {
        mediaCompatibilityProcesses.delete(child);
        if (abortedError) return finish(reject, abortedError);
        if (code === 0) return finish(resolve);
        return finish(reject, new Error(stderr.slice(-1200).trim() || `FFmpeg 退出码 ${code}`));
      });
      timer = setTimeout(() => {
        abortedError = new Error('兼容媒体生成超时，已终止转码进程');
        abortedError.code = 'MEDIA_CONVERSION_TIMEOUT';
        terminateProcessTree(child, false);
        forceTimer = setTimeout(() => {
          terminateProcessTree(child, true);
          settleTimer = setTimeout(() => finish(reject, abortedError), PROCESS_TERMINATION_GRACE_MS * 2);
          settleTimer.unref?.();
        }, PROCESS_TERMINATION_GRACE_MS);
        forceTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();
    });
  }

  function compatibilityTargetDimensions(record) {
    const sourceWidth = Math.max(2, Number(record.metadata?.width) || MEDIA_COMPATIBILITY_MAX_WIDTH);
    const sourceHeight = Math.max(2, Number(record.metadata?.height) || MEDIA_COMPATIBILITY_MAX_HEIGHT);
    const ratio = Math.min(1, MEDIA_COMPATIBILITY_MAX_WIDTH / sourceWidth, MEDIA_COMPATIBILITY_MAX_HEIGHT / sourceHeight);
    return {
      width: Math.max(2, Math.floor((sourceWidth * ratio) / 2) * 2),
      height: Math.max(2, Math.floor((sourceHeight * ratio) / 2) * 2)
    };
  }

  function compatibilityOutputArguments(record, input, output, hardware) {
    const target = compatibilityTargetDimensions(record);
    const metadata = record.metadata || {};
    const duration = Number(metadata.duration) || 0;
    const averageBitrate = duration > 0 && Number(record.size) > 0 ? Number(record.size) * 8 / duration : Infinity;
    const copyVideo = ['H264', 'AVC', 'AVC1'].includes(String(metadata.videoCodec || '').toUpperCase())
      && String(metadata.pixelFormat || '').toLowerCase() === 'yuv420p'
      && Number(metadata.width) <= MEDIA_COMPATIBILITY_MAX_WIDTH && Number(metadata.height) <= MEDIA_COMPATIBILITY_MAX_HEIGHT
      && averageBitrate <= MEDIA_COMPATIBILITY_MAX_VIDEO_BITRATE + MEDIA_COMPATIBILITY_AUDIO_BITRATE;
    if (copyVideo) return [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', String(MEDIA_COMPATIBILITY_AUDIO_BITRATE), '-ac', '2', '-movflags', '+faststart', '-max_muxing_queue_size', '2048',
      '-progress', 'pipe:2', '-nostats', output
    ];
    const inputArgs = hardware
      ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', input]
      : ['-i', input];
    const videoArgs = hardware
      ? ['-vf', `scale_cuda=${target.width}:${target.height}:format=yuv420p`, '-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-rc', 'vbr', '-cq', '28', '-b:v', '0']
      : ['-vf', `scale=${target.width}:${target.height}:flags=fast_bilinear,format=yuv420p`, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', '26', '-threads', String(Math.max(1, Math.floor((os.availableParallelism?.() || os.cpus().length || 1) / mediaCompatibilityConcurrency())))];
    return [
      '-y', '-hide_banner', '-loglevel', 'error', ...inputArgs,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', ...videoArgs,
      '-profile:v', 'high', '-level:v', '4.1', '-maxrate', String(MEDIA_COMPATIBILITY_MAX_VIDEO_BITRATE),
      '-bufsize', String(MEDIA_COMPATIBILITY_MAX_VIDEO_BITRATE * 2),
      '-c:a', 'aac', '-b:a', String(MEDIA_COMPATIBILITY_AUDIO_BITRATE), '-ac', '2', '-movflags', '+faststart', '-max_muxing_queue_size', '2048',
      '-progress', 'pipe:2', '-nostats', output
    ];
  }

  async function validateCompatibleMedia(filename, record) {
    if (!ffprobePath || !fs.existsSync(ffprobePath)) return compatibilityTargetDimensions(record);
    const output = await captureProcess(ffprobePath, [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', filename
    ], 30000, mediaCompatibilityProcesses, { record });
    const info = JSON.parse(output);
    const video = info.streams?.find((stream) => stream.codec_type === 'video');
    const audio = info.streams?.find((stream) => stream.codec_type === 'audio');
    const width = Number(video?.width) || 0;
    const height = Number(video?.height) || 0;
    if (String(video?.codec_name || '').toLowerCase() !== 'h264' || String(video?.pix_fmt || '').toLowerCase() !== 'yuv420p'
      || width < 2 || height < 2 || width > MEDIA_COMPATIBILITY_MAX_WIDTH || height > MEDIA_COMPATIBILITY_MAX_HEIGHT
      || (audio && String(audio.codec_name || '').toLowerCase() !== 'aac')) {
      const error = new Error('兼容媒体输出校验失败');
      error.code = 'MEDIA_OUTPUT_INVALID';
      throw error;
    }
    return { width, height };
  }

  function compatibilityPublicError(error) {
    if (error?.code === 'INSUFFICIENT_STORAGE') return '服务器可用存储空间不足，无法生成兼容版';
    if (error?.code === 'MEDIA_CONVERSION_TIMEOUT') return '影片转换时间过长，任务已安全终止，请重试';
    if (error?.code === 'MEDIA_OUTPUT_INVALID') return '服务器生成的兼容版校验失败，请重新尝试';
    if (error?.code === 'SOURCE_CHANGED') return '转换期间源影片发生变化，服务器将重新生成兼容版';
    return '服务器未能生成兼容版，请确认源文件完整后重试';
  }

  async function generateCompatibleMedia(record) {
    const input = path.join(uploadsDir, record.storedName);
    const fileName = compatibilityFileName(record);
    const output = path.join(compatibleMediaDir, fileName);
    const partial = path.join(compatibleMediaDir, `${path.basename(fileName, '.mp4')}.partial-${crypto.randomUUID()}.mp4`);
    const isActive = () => !analysisClosing && !cancelledMediaRecords.has(record)
      && state.files.find((file) => file.id === record.id) === record && fs.existsSync(input);
    if (!isActive() || !mediaNeedsCompatibility(record)) return;
    const existing = mediaCompatibilitySummary(record);
    if (existing.ready) {
      record.compatibility = { ...record.compatibility, ...existing, fileName, status: 'ready', progress: 100, error: '' };
      return;
    }
    try {
      const sourceBefore = mediaSourceSnapshot(record);
      if (!sourceBefore) return;
      const duration = Math.max(1, Number(record.metadata?.duration) || 1);
      const bitrateEstimate = duration * ((MEDIA_COMPATIBILITY_MAX_VIDEO_BITRATE + MEDIA_COMPATIBILITY_AUDIO_BITRATE) / 8);
      const requiredBytes = Math.min(8 * 1024 * 1024 * 1024, Math.max(sourceBefore.size, bitrateEstimate));
      if (!hasDiskSpace(requiredBytes)) throw diskSpaceError();
      record.compatibility = { ...record.compatibility, fileName, status: 'converting', progress: 0, error: '', startedAt: new Date().toISOString(), elapsedSeconds: 0, speedRatio: 0, etaSeconds: 0 };
      emitFileToVisible('file-updated', record);
      let usedHardware = false;
      if (mediaCompatibilityHardware) {
        try {
          await runCompatibilityProcess(compatibilityOutputArguments(record, input, partial, true), record);
          usedHardware = true;
        } catch (error) {
          try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch (_) {}
          if (!isActive()) throw error;
          await runCompatibilityProcess(compatibilityOutputArguments(record, input, partial, false), record);
        }
      } else await runCompatibilityProcess(compatibilityOutputArguments(record, input, partial, false), record);
      if (!isActive()) {
        try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch (_) {}
        return;
      }
      const stats = fs.statSync(partial);
      if (!stats.isFile() || stats.size <= 0) throw new Error('FFmpeg 没有生成有效的兼容媒体文件');
      const sourceAfter = mediaSourceSnapshot(record);
      if (!sourceAfter || sourceAfter.size !== sourceBefore.size || sourceAfter.mtimeMs !== sourceBefore.mtimeMs) {
        const error = new Error('转换期间源影片发生变化'); error.code = 'SOURCE_CHANGED'; throw error;
      }
      const validated = await validateCompatibleMedia(partial, record);
      if (!isActive()) { try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch (_) {} return; }
      if (fs.existsSync(output)) fs.unlinkSync(output);
      fs.renameSync(partial, output);
      const outputStats = fs.statSync(output);
      record.compatibility = {
        fileName, status: 'ready', progress: 100, size: outputStats.size,
        recipeVersion: MEDIA_COMPATIBILITY_RECIPE_VERSION, maxWidth: MEDIA_COMPATIBILITY_MAX_WIDTH, maxHeight: MEDIA_COMPATIBILITY_MAX_HEIGHT,
        width: validated.width, height: validated.height, videoCodec: 'H264', audioCodec: 'AAC', generatedAt: new Date().toISOString(),
        sourceSize: sourceAfter.size, sourceMtimeMs: sourceAfter.mtimeMs, outputMtimeMs: Math.trunc(Number(outputStats.mtimeMs) || 0),
        encoder: compatibilityOutputArguments(record, input, partial, false).includes('copy') ? 'VideoCopy' : usedHardware ? 'GPU' : 'CPU', error: ''
      };
      persist();
      emitFileToVisible('file-updated', record);
      console.log(`公网兼容版已生成: ${record.originalName} (${record.compatibility.encoder})`);
    } catch (error) {
      try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch (_) {}
      if (state.files.find((file) => file.id === record.id) !== record || cancelledMediaRecords.has(record)) return;
      if (analysisClosing || closing || error?.code === 'SERVER_SHUTDOWN') {
        record.compatibility = { ...record.compatibility, fileName, status: 'queued', progress: 0, error: '' };
        return;
      }
      if (error?.code === 'SOURCE_CHANGED') {
        record.compatibility = { ...record.compatibility, fileName, status: 'queued', progress: 0, error: '' };
        if (!mediaCompatibilityQueue.includes(record)) mediaCompatibilityQueue.push(record);
        schedulePersist(0);
        return;
      }
      record.compatibility = {
        ...record.compatibility, fileName, status: 'failed', progress: 0,
        error: compatibilityPublicError(error), failedAt: new Date().toISOString()
      };
      persist();
      emitFileToVisible('file-updated', record);
      console.warn(`公网兼容版生成失败 ${record.originalName}:`, error.message);
    }
  }

  function enqueueMediaCompatibility(record, { priority = false, retry = false } = {}) {
    if (analysisClosing || !isPlayableFile(record) || !mediaNeedsCompatibility(record)) return false;
    const summary = mediaCompatibilitySummary(record);
    if (summary.ready) {
      record.compatibility = { ...record.compatibility, ...summary, fileName: summary.fileName, status: 'ready', progress: 100, error: '' };
      return true;
    }
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      record.compatibility = { ...record.compatibility, fileName: compatibilityFileName(record), status: 'unavailable', progress: 0, error: '当前服务器没有可用的媒体转码组件' };
      return false;
    }
    if (record.compatibility?.manualReason === 'user-stopped' && !priority) return false;
    if (!mediaCompatibilityAutoConvert() && !priority) {
      record.compatibility = { ...record.compatibility, fileName: summary.fileName, status: 'manual', progress: 0, error: '' };
      return false;
    }
    const active = [...mediaCompatibilityJobs].some((job) => job.record === record);
    const queuedIndex = mediaCompatibilityQueue.findIndex((entry) => entry === record);
    if (active) return true;
    if (queuedIndex >= 0) {
      if (priority && queuedIndex > 0) mediaCompatibilityQueue.unshift(...mediaCompatibilityQueue.splice(queuedIndex, 1));
      return true;
    }
    if (record.compatibility?.status === 'failed' && !retry && !priority) return false;
    record.compatibility = { ...record.compatibility, fileName: compatibilityFileName(record), status: 'queued', progress: 0, error: '', manualReason: '' };
    if (priority) mediaCompatibilityQueue.unshift(record); else mediaCompatibilityQueue.push(record);
    schedulePersist(0);
    emitFileToVisible('file-updated', record);
    pumpMediaCompatibilityQueue();
    return true;
  }

  function pumpMediaCompatibilityQueue() {
    while (!analysisClosing && mediaCompatibilityJobs.size < mediaCompatibilityConcurrency() && mediaCompatibilityQueue.length) {
      const record = mediaCompatibilityQueue.shift();
      if (cancelledMediaRecords.has(record) || !isPlayableFile(record)
        || state.files.find((entry) => entry.id === record.id) !== record || !mediaNeedsCompatibility(record)) continue;
      const job = Promise.resolve().then(() => generateCompatibleMedia(record)).catch((error) => {
        console.warn(`兼容媒体任务失败 ${record.originalName}:`, error.message);
      }).finally(() => {
        mediaCompatibilityJobs.delete(job);
        pumpMediaCompatibilityQueue();
        emitMediaProcessingSnapshots();
      });
      job.record = record;
      mediaCompatibilityJobs.add(job);
    }
  }

  async function analyzeMedia(record) {
    if (!['video', 'audio'].includes(record.category)) return;
    const input = path.join(uploadsDir, record.storedName);
    const isActive = () => !analysisClosing && !cancelledMediaRecords.has(record)
      && state.files.find((file) => file.id === record.id) === record && fs.existsSync(input);
    if (!isActive()) return;
    const extension = path.extname(record.originalName || record.storedName || '').toLowerCase();
    if (record.category === 'video' && (HLS_EXTENSIONS.has(extension) || /mpegurl/i.test(String(record.mimeType || '')))) {
      // A playlist has no self-contained duration/thumbnail and may reference
      // remote segments. Do not run ffprobe/thumbnail FFmpeg against it or
      // repeatedly log missing-segment errors; it is already browser-native.
      record.metadata = { ...(record.metadata || {}), analysisVersion: MEDIA_ANALYSIS_VERSION, duration: 0, width: 0, height: 0, videoCodec: '', audioCodec: '' };
      persist();
      emitFileToVisible('file-updated', record);
      return;
    }
    try {
      if (ffprobePath && fs.existsSync(ffprobePath)) {
        try {
          const output = await captureProcess(ffprobePath, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', input], 30000, mediaAnalysisProcesses, { record });
          if (!isActive()) return;
          const info = JSON.parse(output);
          const video = info.streams?.find((stream) => stream.codec_type === 'video');
          const audio = info.streams?.find((stream) => stream.codec_type === 'audio');
          record.metadata = {
            analysisVersion: MEDIA_ANALYSIS_VERSION,
            duration: Number(info.format?.duration) || 0, width: Number(video?.width) || 0, height: Number(video?.height) || 0,
            videoCodec: cleanText(video?.codec_name || '', 30).toUpperCase(), audioCodec: cleanText(audio?.codec_name || '', 30).toUpperCase(),
            pixelFormat: cleanText(video?.pix_fmt || '', 30).toLowerCase(), profile: cleanText(video?.profile || '', 60),
            bitDepth: Number(video?.bits_per_raw_sample) || Number(String(video?.pix_fmt || '').match(/p(\d{2})(?:le|be)?$/i)?.[1]) || 8,
            language: cleanText(audio?.tags?.language || info.format?.tags?.language || '', 30)
          };
        } catch (error) {
          if (!isActive()) return;
          console.warn(`媒体编码检测失败 ${record.originalName}:`, error.message);
        }
      }
      if (record.category === 'video' && ffmpegPath && fs.existsSync(ffmpegPath)) {
        const thumbnailName = `${record.id}.jpg`;
        const thumbnailPath = path.join(thumbnailsDir, thumbnailName);
        try {
          const duration = Math.max(0, Number(record.metadata?.duration) || 0);
          // Pick a safe point from the middle 40% of the video. The old fixed
          // -ss 3 path failed for short clips and left mobile cards with a
          // broken/black image, so clamp the seek point inside the stream.
          const randomPoint = duration * (0.3 + Math.random() * 0.4);
          const safePoint = duration > 0.5
            ? Math.min(Math.max(0, duration - 0.1), Math.max(0, randomPoint))
            : 0;
          const seekSeconds = safePoint.toFixed(3);
          await captureProcess(ffmpegPath, ['-y', '-ss', seekSeconds, '-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumbnailPath], 60000, mediaAnalysisProcesses, { record });
          if (!isActive()) { if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath); return; }
          const thumbnailStats = fs.statSync(thumbnailPath);
          if (!thumbnailStats.isFile() || thumbnailStats.size <= 0) throw new Error('缩略图输出为空');
          record.thumbnailName = thumbnailName;
        } catch (error) {
          try { if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath); } catch (_) {}
          if (!isActive()) return;
          console.warn(`缩略图生成失败 ${record.originalName}:`, error.message);
        }
      }
      if (!isActive()) return;
      persist();
      emitFileToVisible('file-updated', record);
      enqueueMediaCompatibility(record);
    } catch (error) {
      if (analysisClosing || closing) return;
      if (!isActive()) return;
      console.warn(`媒体分析失败 ${record.originalName}:`, error.message);
      persist();
      emitFileToVisible('file-updated', record);
    }
  }

  function enqueueMediaAnalysis(record) {
    if (analysisClosing || !isPlayableFile(record)) return;
    if (cancelledMediaRecords.has(record) || mediaAnalysisQueue.includes(record) || [...mediaAnalysisJobs].some((job) => job.record === record)) return;
    mediaAnalysisQueue.push(record);
    pumpMediaAnalysisQueue();
  }

  function pumpMediaAnalysisQueue() {
    while (!analysisClosing && mediaAnalysisJobs.size < MEDIA_ANALYSIS_CONCURRENCY && mediaAnalysisQueue.length) {
      const record = mediaAnalysisQueue.shift();
      if (cancelledMediaRecords.has(record) || !isPlayableFile(record) || state.files.find((entry) => entry.id === record.id) !== record) continue;
      const job = Promise.resolve().then(() => analyzeMedia(record)).catch((error) => {
        console.warn(`媒体分析任务失败 ${record.originalName}:`, error.message);
      }).finally(() => {
        mediaAnalysisJobs.delete(job);
        pumpMediaAnalysisQueue();
      });
      job.record = record;
      mediaAnalysisJobs.add(job);
    }
  }

  function removeQueuedMediaRecord(queue, record) {
    for (let index = queue.length - 1; index >= 0; index -= 1) if (queue[index] === record) queue.splice(index, 1);
  }

  async function cancelMediaWork(record, reason = '文件已删除，后台媒体任务已终止') {
    if (!record) return true;
    cancelledMediaRecords.add(record);
    removeQueuedMediaRecord(mediaAnalysisQueue, record);
    removeQueuedMediaRecord(mediaCompatibilityQueue, record);
    const processes = [...mediaAnalysisProcesses, ...mediaCompatibilityProcesses].filter((child) => child.syncWatchRecord === record);
    for (const child of processes) {
      if (typeof child.syncWatchAbort === 'function') child.syncWatchAbort(reason);
      else terminateProcessTree(child, true);
    }
    const jobs = [...mediaAnalysisJobs, ...mediaCompatibilityJobs].filter((job) => job.record === record);
    return !jobs.length || settleWithin(Promise.allSettled(jobs), closeAbortGraceMs);
  }

  function resumeMediaWork(record) {
    if (!record) return;
    cancelledMediaRecords.delete(record);
    if (state.files.find((entry) => entry.id === record.id) !== record || !isPlayableFile(record)) return;
    if ((mediaMetadataNeedsAnalysis(record) || mediaThumbnailNeedsAnalysis(record))
      && (ffprobePath && fs.existsSync(ffprobePath) || ffmpegPath && fs.existsSync(ffmpegPath))) enqueueMediaAnalysis(record);
    else enqueueMediaCompatibility(record, { retry: true });
  }

  function associateSubtitle(record) {
    const possible = state.files.find((file) => file.roomId === record.roomId && file.category === 'video' && file.status === 'approved' && baseName(file.originalName) === baseName(record.originalName));
    if (possible) record.subtitleVideoId = possible.id;
    const extension = path.extname(record.originalName).toLowerCase();
    const contents = decodeSubtitle(fs.readFileSync(path.join(uploadsDir, record.storedName)));
    record.vttName = `${record.id}.vtt`;
    fs.writeFileSync(path.join(subtitlesDir, record.vttName), subtitleToVtt(contents, extension), 'utf8');
  }

  function reassociateSubtitles(roomIdValue = currentRoomId()) {
    const id = normalizeRoomId(roomIdValue) || currentRoomId();
    const changed = [];
    for (const subtitle of state.files.filter((file) => file.roomId === id && file.category === 'subtitle')) {
      const video = state.files.find((file) => file.roomId === subtitle.roomId && file.category === 'video' && file.status === 'approved' && baseName(file.originalName) === baseName(subtitle.originalName));
      const nextVideoId = video?.id || '';
      if ((subtitle.subtitleVideoId || '') === nextVideoId) continue;
      subtitle.subtitleVideoId = nextVideoId;
      changed.push(subtitle);
    }
    return changed;
  }

  app.post('/api/upload', requireSession, httpRateLimit('upload', 120, 60 * 1000), ensureDiskSpace, mediaUpload, async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: '请选择文件' });
    const sessionRoomId = req.syncWatchSessionRoomId;
    const sessionRoom = roomConfig(sessionRoomId);
    const uploadBan = mediaUploadBanFor(sessionRoomId, req.file.originalname);
    if (uploadBan) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(403).json({ success: false, code: 'MEDIA_UPLOAD_BANNED', originalName: normalizeOriginalName(req.file.originalname), error: '该影片已被服务器管理员禁止上传' });
    }
    const resolvedType = resolveFileType(req.file.originalname || req.file.filename, req.file.mimetype)
      || (req.syncWatchUploadCategory ? [req.syncWatchUploadCategory, req.syncWatchUploadMime || req.file.mimetype] : null);
    if (!resolvedType) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(415).json({ success: false, error: '不支持此文件格式' });
    }
    const [category, defaultMime] = resolvedType;
    const currentSession = validSession(req.syncWatchToken, false);
    const stillAuthorized = currentSession === req.syncWatchSession
      && normalizeRoomId(currentSession?.roomId) === sessionRoomId
      && Boolean(state.accounts[currentSession?.username])
      && !isIpBanned(getRequestIp(req))
      && permissionFor(currentSession?.username, sessionRoomId).upload;
    if (!stillAuthorized) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(409).json({ success: false, error: '上传期间登录状态或权限已变化，请重新登录后再试' });
    }
    if (category === 'text') {
      if (state.admin.allowTextUploads === false) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(415).json({ success: false, code: 'TEXT_UPLOAD_DISABLED', error: '服务器已关闭文本文件上传' });
      }
      if (req.file.size > TEXT_UPLOAD_LIMIT_BYTES) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(413).json({ success: false, code: 'TEXT_FILE_TOO_LARGE', error: '单个文本文件不能超过 10MB' });
      }
      if (!bufferLooksLikeText(fs.readFileSync(req.file.path))) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(415).json({ success: false, code: 'INVALID_TEXT_CONTENT', error: '文件内容包含二进制数据，不能作为文本阅读' });
      }
    }
    if (category === 'subtitle' && req.file.size > SUBTITLE_LIMIT_BYTES) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(413).json({ success: false, error: '字幕文件不能超过 10MB' });
    }
    const storagePolicy = roomStoragePolicy(sessionRoomId);
    if (!uploadPolicyExempt(req.syncWatchSession) && storagePolicy.limitBytes
      && storagePolicy.usedBytes + req.file.size > storagePolicy.limitBytes) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(413).json({
        success: false, code: 'ROOM_STORAGE_LIMIT_REACHED', requestable: true,
        error: '当前房间的上传容量已满，可以向管理员申请扩容',
        storage: storagePolicy, fileSize: req.file.size
      });
    }
    const videoDurationLimit = Math.max(0, Number(state.admin.uploadVideoDurationLimitSeconds) || 0);
    if (category === 'video' && videoDurationLimit > 0 && !uploadPolicyExempt(req.syncWatchSession)) {
      if (!ffprobePath || !fs.existsSync(ffprobePath)) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(503).json({ success: false, code: 'MEDIA_DURATION_PROBE_UNAVAILABLE', error: '服务器未找到 FFprobe，无法校验视频时长限制' });
      }
      try {
        const probe = JSON.parse(await captureProcess(ffprobePath, ['-v', 'quiet', '-print_format', 'json', '-show_entries', 'format=duration:stream=codec_type,duration', req.file.path], 60000));
        const stream = Array.isArray(probe.streams) ? probe.streams.find((entry) => entry?.codec_type === 'video') : null;
        const duration = Math.max(0, Number(probe.format?.duration) || Number(stream?.duration) || 0);
        if (duration > videoDurationLimit + 0.25) {
          if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
          return res.status(413).json({ success: false, code: 'MEDIA_DURATION_LIMIT', duration, limitSeconds: videoDurationLimit, error: `视频时长超过管理员设置的 ${videoDurationLimit} 秒限制` });
        }
      } catch (error) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(415).json({ success: false, code: 'MEDIA_DURATION_PROBE_FAILED', error: `无法读取视频时长：${error.message}` });
      }
    }
    const isOwner = req.syncWatchSession.username === sessionRoom.ownerUsername;
    const record = {
      id: crypto.randomUUID(), originalName: normalizeOriginalName(req.file.originalname), storedName: req.file.filename,
      size: req.file.size, mimeType: defaultMime.split(';')[0] || req.file.mimetype, category,
      roomId: sessionRoomId, relativePath: normalizeRelativePath(req.body.relativePath),
      collection: cleanText(req.body.collection || '', 80).replace(/[\\/]/g, '').trim(),
      uploadedAt: new Date().toISOString(), uploadedBy: req.syncWatchSession.username,
      status: sessionRoom.requireUploadApproval && !isOwner ? 'pending' : 'approved', metadata: {}, thumbnailName: '', subtitleVideoId: ''
    };
    try { if (category === 'subtitle') associateSubtitle(record); } catch (error) { console.warn('字幕转换失败:', error.message); }
    state.files.push(record);
    const reassociated = reassociateSubtitles(sessionRoomId);
    persist();
    const visible = publicFile(record);
    emitFileToVisible('file-uploaded', record);
    for (const changed of reassociated) if (changed.id !== record.id) emitFileToVisible('file-updated', changed);
    if (record.status !== 'approved') for (const ownerSocket of ownerSockets(sessionRoomId)) ownerSocket.emit('upload-pending', visible);
    const operation = recordOperation({ roomId: sessionRoomId, actor: req.syncWatchSession.username, action: 'file-upload', summary: `上传文件：${record.originalName}`, undo: { kind: 'file-upload', fileId: record.id } });
    broadcastMediaMutation(sessionRoomId, operation, record, 'upload');
    emitRoomDirectoryChanged(sessionRoomId, 'media-uploaded');
    res.json({ success: true, file: visible, pending: record.status === 'pending' });
    setImmediate(() => enqueueMediaAnalysis(record));
  });

  const voiceStorage = monitoredDiskStorage(voiceDir, (req, file, callback) => {
    const allowed = ['.webm', '.ogg', '.mp4', '.m4a', '.mp3', '.aac', '.wav'];
    const originalExtension = path.extname(file.originalname).toLowerCase();
    const extension = allowed.includes(originalExtension) ? originalExtension : '.webm';
    callback(null, `${crypto.randomUUID()}${extension}`);
  });

  const voiceUpload = multer({
    storage: voiceStorage,
    limits: { files: 1, fields: 1, parts: 3, fieldSize: 1024, fileSize: VOICE_LIMIT_BYTES },
    fileFilter(req, file, callback) {
      const extension = path.extname(file.originalname).toLowerCase();
      const allowed = ['.webm', '.ogg', '.mp4', '.m4a', '.mp3', '.aac', '.wav'];
      callback(allowed.includes(extension) ? null : new Error('语音仅支持 WebM、OGG、M4A/MP4、MP3、AAC 或 WAV'), allowed.includes(extension));
    }
  }).single('voice');

  app.post('/api/voice', requireSession, httpRateLimit('voice-upload', 30, 60 * 1000), ensureDiskSpace, voiceUpload, (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: '没有语音内容' });
    const sessionRoomId = req.syncWatchSessionRoomId;
    const currentSession = validSession(req.syncWatchToken, false);
    if (currentSession !== req.syncWatchSession || normalizeRoomId(currentSession?.roomId) !== sessionRoomId || isIpBanned(getRequestIp(req))) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(409).json({ success: false, error: '上传期间登录状态已变化，请重新登录后再试' });
    }
    const user = users.get(req.syncWatchSession.socketId);
    if (!user || user.sessionToken !== req.syncWatchToken || user.username !== req.syncWatchSession.username || user.roomId !== sessionRoomId) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(409).json({ success: false, error: '连接或房间状态已变化，请重试' });
    }
    const to = cleanUsername(req.body.to || '');
    if (to && !state.accounts[to]) { fs.unlinkSync(req.file.path); return res.status(400).json({ success: false, error: '私聊对象不存在' }); }
    const message = createMessage(user, { type: 'voice', to, text: '语音消息', voiceUrl: `/voice/${req.file.filename}` }, sessionRoomId);
    appendMessage(message);
    emitMessage(message);
    return res.json({ success: true, message });
  });

  const imageExtensions = new Map([
    ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif']
  ]);
  function imageUpload(storageDirectory, fieldName, limitBytes) {
    const storage = monitoredDiskStorage(storageDirectory, (req, file, callback) => {
      const extension = imageExtensions.get(String(file.mimetype || '').toLowerCase()) || path.extname(file.originalname).toLowerCase();
      callback(null, `${crypto.randomUUID()}${extension === '.jpeg' ? '.jpg' : extension}`);
    });
    return multer({
      storage, limits: { files: 1, fields: 5, parts: 8, fieldSize: 4096, fileSize: limitBytes },
      fileFilter(req, file, callback) {
        const allowed = imageExtensions.has(String(file.mimetype || '').toLowerCase())
          && ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(path.extname(file.originalname).toLowerCase());
        callback(allowed ? null : new Error('图片仅支持 JPG、PNG、WebP 或 GIF'), allowed);
      }
    }).single(fieldName);
  }

  const chatImageUpload = imageUpload(chatImagesDir, 'image', CHAT_IMAGE_LIMIT_BYTES);
  app.post('/api/friend-image', requireSession, httpRateLimit('friend-image-upload', 20, 60 * 1000), ensureDiskSpace, chatImageUpload, (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: '没有图片内容' });
    const currentSession = validSession(req.syncWatchToken, false);
    const user = users.get(req.syncWatchSession.socketId);
    if (currentSession !== req.syncWatchSession || !user || user.sessionToken !== req.syncWatchToken
      || user.username !== req.syncWatchSession.username || isIpBanned(getRequestIp(req))) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(409).json({ success: false, error: '上传期间登录状态已变化，请重试' });
    }
    const friend = cleanUsername(req.body.to);
    const result = storeFriendMessage(user.username, friend, {
      type: 'image', text: req.body.text, imageUrl: `/chat-image/${req.file.filename}`,
      imageName: req.file.originalname, replyToId: req.body.replyToId
    });
    if (!result.success) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(result.code === 'BLOCKED_WORD' ? 422 : 400).json(result);
    }
    return res.json(result);
  });

  app.post('/api/chat-image', requireSession, httpRateLimit('chat-image-upload', 30, 60 * 1000), ensureDiskSpace, chatImageUpload, (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: '没有图片内容' });
    const sessionRoomId = req.syncWatchSessionRoomId;
    const currentSession = validSession(req.syncWatchToken, false);
    const user = users.get(req.syncWatchSession.socketId);
    if (currentSession !== req.syncWatchSession || normalizeRoomId(currentSession?.roomId) !== sessionRoomId
      || !user || user.sessionToken !== req.syncWatchToken || user.roomId !== sessionRoomId || isIpBanned(getRequestIp(req))) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(409).json({ success: false, error: '上传期间连接或房间状态已变化，请重试' });
    }
    const channel = ['public', 'private', 'danmaku'].includes(req.body.channel) ? req.body.channel : 'public';
    const to = channel === 'private' ? cleanUsername(req.body.to) : '';
    if (channel === 'private' && (!to || !state.accounts[to])) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(400).json({ success: false, error: '请选择有效的私聊对象' });
    }
    const blockedWord = blockedWordMatch(req.body.text);
    if (blockedWord) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(422).json({ success: false, code: 'BLOCKED_WORD', blockedWord, error: `消息包含服务器屏蔽词“${blockedWord}”，请修改后再发送` });
    }
    const message = createMessage(user, {
      type: 'image', channel, to, text: cleanText(req.body.text, 120),
      imageUrl: `/chat-image/${req.file.filename}`, imageName: normalizeOriginalName(req.file.originalname), color: req.body.color
    }, sessionRoomId);
    appendMessage(message);
    if (channel === 'danmaku') io.to(roomChannel(sessionRoomId)).emit('danmaku', message);
    else emitMessage(message);
    return res.json({ success: true, message });
  });

  const avatarUpload = imageUpload(avatarsDir, 'avatar', AVATAR_LIMIT_BYTES);
  app.post('/api/avatar', requireSession, httpRateLimit('avatar-upload', 10, 60 * 1000), ensureDiskSpace, avatarUpload, (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: '没有头像图片' });
    const account = state.accounts[req.syncWatchSession.username];
    const currentSession = validSession(req.syncWatchToken, false);
    if (!account || currentSession !== req.syncWatchSession || isIpBanned(getRequestIp(req))) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(409).json({ success: false, error: '上传期间登录状态已变化，请重试' });
    }
    const previous = String(account.avatar || '').match(/^\/avatar\/([^/?#]+)$/);
    account.avatar = `/avatar/${req.file.filename}`;
    persist();
    if (previous) fs.rmSync(path.join(avatarsDir, path.basename(previous[1])), { force: true });
    for (const id of Object.keys(state.rooms)) io.to(roomChannel(id)).emit('users-list', usersList(id));
    return res.json({ success: true, profile: accountProfile(req.syncWatchSession.username), avatar: account.avatar });
  });

  function aiRelayErrorResponse(res, error) {
    const upstreamStatus = Math.floor(Number(error?.upstreamStatus || error?.status) || 0);
    const status = upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : 502;
    return res.status(status).json({
      success: false, code: cleanText(error?.code || 'AI_RELAY_ERROR', 80),
      error: cleanText(error?.message || 'AI 服务请求失败', 500) || 'AI 服务请求失败'
    });
  }

  function aiRelayCredentials(body = {}) {
    return {
      baseUrl: cleanText(body.baseUrl, 2048),
      apiKey: String(body.apiKey || '').trim(),
      lookup: lookupHost
    };
  }

  function normalizeAiMessages(value) {
    const source = Array.isArray(value) ? value : [];
    const messages = [];
    let totalLength = 0;
    for (const item of source.slice(-60)) {
      const role = ['system', 'developer', 'user', 'assistant'].includes(item?.role) ? item.role : 'user';
      const content = cleanText(item?.content, 20000);
      if (!content) continue;
      totalLength += content.length;
      if (totalLength > 120000) break;
      messages.push({ role, content });
    }
    return messages;
  }

  app.post('/api/ai/models', requireSession, httpRateLimit('ai-models', 12, 60 * 1000), async (req, res) => {
    try {
      const credentials = aiRelayCredentials(req.body);
      const endpoints = modelEndpointCandidates(credentials.baseUrl, req.body?.modelsPath || '/models');
      let payload = null;
      let endpoint = endpoints[0];
      let models = [];
      let lastError = null;
      for (const candidate of endpoints) {
        try {
          const candidatePayload = await proxyAiJson({ ...credentials, method: 'GET', endpoint: candidate, timeoutMs: 45000 });
          const candidateModels = extractAiModelIds(candidatePayload, 500).map((item) => cleanText(item, 160)).filter(Boolean);
          if (!payload || candidateModels.length) { payload = candidatePayload; endpoint = candidate; models = candidateModels; }
          if (candidateModels.length) break;
        } catch (error) {
          lastError = error;
          const canTryNext = [404, 405, 501].includes(Number(error?.upstreamStatus)) || error?.code === 'AI_RESPONSE_INVALID';
          if (!canTryNext && !payload) throw error;
        }
      }
      if (!payload) throw lastError || new Error('AI 服务没有返回模型列表');
      return res.json({ success: true, models, endpoint, raw: payload });
    } catch (error) { return aiRelayErrorResponse(res, error); }
  });

  app.post('/api/ai/chat', requireSession, httpRateLimit('ai-chat', 30, 60 * 1000), async (req, res) => {
    const body = req.body || {};
    const model = cleanText(body.model, 160);
    const messages = normalizeAiMessages(body.messages);
    const systemPrompt = cleanText(body.systemPrompt, 20000);
    if (!model || !messages.length) return res.status(400).json({ success: false, error: '请选择对话模型并输入消息' });
    const protocol = ['responses', 'chat'].includes(body.protocol) ? body.protocol : 'auto';
    const responseBody = {
      model, input: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages
    };
    if (Number.isFinite(Number(body.temperature))) responseBody.temperature = Math.max(0, Math.min(2, Number(body.temperature)));
    const chatBody = { ...responseBody, messages: responseBody.input };
    delete chatBody.input;
    try {
      let payload;
      let usedProtocol = protocol === 'chat' ? 'chat' : 'responses';
      if (protocol === 'chat') {
        payload = await proxyAiJson({
          ...aiRelayCredentials(body), endpoint: normalizeEndpointPath(body.chatPath, '/chat/completions'),
          body: chatBody, timeoutMs: 3 * 60 * 1000
        });
      } else {
        try {
          payload = await proxyAiJson({
            ...aiRelayCredentials(body), endpoint: normalizeEndpointPath(body.responsesPath, '/responses'),
            body: responseBody, timeoutMs: 3 * 60 * 1000
          });
        } catch (error) {
          const fallbackAllowed = protocol === 'auto' && [400, 404, 405, 415, 422, 500, 501].includes(Number(error?.upstreamStatus));
          if (!fallbackAllowed || protocol === 'responses') throw error;
          usedProtocol = 'chat';
          payload = await proxyAiJson({
            ...aiRelayCredentials(body), endpoint: normalizeEndpointPath(body.chatPath, '/chat/completions'),
            body: chatBody, timeoutMs: 3 * 60 * 1000
          });
        }
      }
      let text = extractAiText(payload);
      if (!text && protocol === 'auto' && usedProtocol === 'responses') {
        usedProtocol = 'chat';
        payload = await proxyAiJson({
          ...aiRelayCredentials(body), endpoint: normalizeEndpointPath(body.chatPath, '/chat/completions'),
          body: chatBody, timeoutMs: 3 * 60 * 1000
        });
        text = extractAiText(payload);
      }
      if (!text) return res.status(502).json({ success: false, code: 'AI_EMPTY_RESPONSE', error: 'AI 服务返回成功，但没有可显示的文本内容', raw: payload });
      return res.json({ success: true, protocol: usedProtocol, text, raw: payload });
    } catch (error) { return aiRelayErrorResponse(res, error); }
  });

  app.post('/api/ai/image', requireSession, httpRateLimit('ai-image', 10, 5 * 60 * 1000), async (req, res) => {
    const body = req.body || {};
    const model = cleanText(body.model, 160);
    const prompt = cleanText(body.prompt, 20000);
    if (!model || !prompt) return res.status(400).json({ success: false, error: '请选择生图模型并填写画面描述' });
    const requestBody = { model, prompt, n: Math.max(1, Math.min(4, Math.floor(Number(body.n) || 1))) };
    if (/^\d{2,5}x\d{2,5}$/.test(String(body.size || ''))) requestBody.size = String(body.size);
    if (['low', 'medium', 'high', 'auto', 'standard', 'hd'].includes(body.quality)) requestBody.quality = body.quality;
    if (['url', 'b64_json'].includes(body.responseFormat)) requestBody.response_format = body.responseFormat;
    try {
      const payload = await proxyAiJson({
        ...aiRelayCredentials(body), endpoint: normalizeEndpointPath(body.imagePath, '/images/generations'),
        body: requestBody, timeoutMs: 8 * 60 * 1000
      });
      return res.json({ success: true, images: Array.isArray(payload?.data) ? payload.data : [], raw: payload });
    } catch (error) { return aiRelayErrorResponse(res, error); }
  });

  app.post('/api/ai/video', requireSession, httpRateLimit('ai-video', 8, 10 * 60 * 1000), async (req, res) => {
    const body = req.body || {};
    const action = body.action === 'status' ? 'status' : 'create';
    try {
      if (action === 'status') {
        const videoId = cleanText(body.videoId, 180);
        if (!/^[A-Za-z0-9._-]{2,180}$/.test(videoId)) return res.status(400).json({ success: false, error: '视频任务编号无效' });
        const endpoint = normalizeEndpointPath(`${String(body.videoPath || '/videos').replace(/\/$/, '')}/${encodeURIComponent(videoId)}`, `/videos/${encodeURIComponent(videoId)}`);
        const payload = await proxyAiJson({ ...aiRelayCredentials(body), method: 'GET', endpoint, timeoutMs: 60000 });
        return res.json({ success: true, video: payload });
      }
      const model = cleanText(body.model, 160);
      const prompt = cleanText(body.prompt, 20000);
      if (!model || !prompt) return res.status(400).json({ success: false, error: '请选择视频模型并填写画面描述' });
      const requestBody = { model, prompt };
      if (/^\d{2,5}x\d{2,5}$/.test(String(body.size || ''))) requestBody.size = String(body.size);
      if ([4, 8, 12, 16, 20].includes(Number(body.seconds))) requestBody.seconds = String(Number(body.seconds));
      const payload = await proxyAiJson({
        ...aiRelayCredentials(body), endpoint: normalizeEndpointPath(body.videoPath, '/videos'),
        body: requestBody, timeoutMs: 10 * 60 * 1000
      });
      return res.json({ success: true, video: payload });
    } catch (error) { return aiRelayErrorResponse(res, error); }
  });

  app.get('/api/files/:id/download', requireSession, (req, res) => {
    const file = findFile(cleanText(req.params.id, 80));
    if (!file || !canSeeFile(req.syncWatchSession, file)) return res.status(404).json({ success: false, error: '文件不存在' });
    if (file.sourceType === 'remote') return res.status(400).json({ success: false, code: 'REMOTE_SOURCE', error: '云端视频由对象存储直接播放，不经过服务器下载' });
    const availability = mediaFileAvailability(file);
    if (!availability.available) return sendUnavailableMedia(res, file);
    return serveFileDownload(req, res, availability.target, file.originalName, file.mimeType);
  });

  app.get('/api/host/rooms/:roomId/files', requireSession, requireHost, (req, res) => {
    const roomIdValue = normalizeRoomId(req.params.roomId);
    const room = roomIdValue && state.rooms[roomIdValue];
    if (!room || !visibleRoom(room)) return res.status(404).json({ success: false, error: '房间不存在' });
    const tokenQuery = req.syncWatchToken ? `?syncwatch_token=${encodeURIComponent(req.syncWatchToken)}` : '';
    const files = state.files.filter((file) => file.roomId === roomIdValue && file.status === 'approved').map((file) => ({
      id: file.id, originalName: file.originalName, category: file.category, mimeType: file.mimeType, size: file.size,
      collection: mediaCollectionName(file), duration: Math.max(0, Number(file.metadata?.duration) || 0),
      playable: isPlayableFile(file), remote: file.sourceType === 'remote',
      previewUrl: file.sourceType === 'remote' ? file.sourceUrl : `/host-media/${encodeURIComponent(roomIdValue)}/${encodeURIComponent(file.id)}${tokenQuery}`
    }));
    return res.json({ success: true, room: { id: room.id, name: room.name }, files });
  });

  const hostMediaPreviewRoute = (req, res) => {
    const roomIdValue = normalizeRoomId(req.params.roomId);
    const file = findFile(cleanText(req.params.fileId, 80));
    if (!roomIdValue || !file || file.roomId !== roomIdValue || file.status !== 'approved') return res.status(404).end();
    if (file.sourceType === 'remote') return res.redirect(302, file.sourceUrl);
    const availability = mediaFileAvailability(file);
    if (!availability.available) return sendUnavailableMedia(res, file);
    return serveMediaRange(req, res, availability.target, file.mimeType);
  };
  app.get('/host-media/:roomId/:fileId', requireSession, requireHost, hostMediaPreviewRoute);
  app.head('/host-media/:roomId/:fileId', requireSession, requireHost, hostMediaPreviewRoute);

  app.patch('/api/files/rename/batch', requireSession, (req, res) => {
    const entries = Array.isArray(req.body?.renames) ? req.body.renames.slice(0, 500) : [];
    if (!entries.length) return res.status(400).json({ success: false, error: '请选择需要重命名的影片' });
    const roomId = req.syncWatchSessionRoomId;
    const username = req.syncWatchSession.username;
    const ids = entries.map((entry) => cleanText(entry?.fileId || entry?.id, 80)).filter(Boolean);
    if (new Set(ids).size !== ids.length) return res.status(400).json({ success: false, error: '批量重命名列表包含重复影片' });
    const files = ids.map(findFile);
    if (files.some((file) => !file || file.roomId !== roomId)) return res.status(404).json({ success: false, error: '部分影片不存在或不属于当前房间' });
    const denied = files.find((file) => username !== file.uploadedBy && !canManageMediaLibrary(username, roomId));
    if (denied) return res.status(403).json({ success: false, error: `没有管理影片“${denied.originalName}”的权限` });
    const planned = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const rawName = String(entries[index]?.originalName ?? entries[index]?.name ?? '').trim();
      if (!rawName) return res.status(400).json({ success: false, error: `影片“${file.originalName}”的新文件名不能为空` });
      let nextName = normalizeOriginalName(rawName);
      const extension = path.extname(file.originalName || '');
      if (!path.extname(nextName) && extension) nextName += extension;
      if (!nextName || nextName.length > 180) return res.status(400).json({ success: false, error: `影片“${file.originalName}”的新文件名无效` });
      planned.push({ file, before: file.originalName, nextName });
    }
    const selectedIds = new Set(files.map((file) => file.id));
    const reserved = new Set(state.files.filter((file) => file.roomId === roomId && !selectedIds.has(file.id)).map((file) => String(file.originalName || '').toLocaleLowerCase()));
    const plannedNames = new Set();
    for (const { nextName, file } of planned) {
      const key = nextName.toLocaleLowerCase();
      if (reserved.has(key) || plannedNames.has(key)) return res.status(409).json({ success: false, error: `影片“${nextName}”已存在，请调整重命名规则后重试` });
      plannedNames.add(key);
    }
    const changed = planned.filter(({ file, nextName }) => file.originalName !== nextName);
    if (!changed.length) return res.json({ success: true, files: files.map(publicFile), renamed: 0, message: '所选影片名称没有变化' });
    for (const { file, nextName } of changed) file.originalName = nextName;
    const reassociated = reassociateSubtitles(roomId);
    persist();
    for (const { file, before, nextName } of changed) {
      emitFileToVisible('file-updated', file);
      recordOperation({ roomId, actor: username, action: 'file-rename', summary: `重命名文件：${before} → ${nextName}`, undo: { kind: 'file-rename', fileId: file.id, before, after: nextName } });
    }
    for (const changedSubtitle of reassociated) emitFileToVisible('file-updated', changedSubtitle);
    const actorName = state.accounts[username]?.displayName || username;
    broadcastRoomNotice(roomId, `${actorName} 批量重命名了 ${changed.length} 个影片`, { kind: 'file-rename-batch', actor: username, actorName, fileIds: changed.map(({ file }) => file.id), important: true });
    return res.json({ success: true, files: files.map(publicFile), renamed: changed.length, message: `已批量重命名 ${changed.length} 个影片` });
  });

  app.patch('/api/files/:id', requireSession, (req, res) => {
    const file = findFile(cleanText(req.params.id, 80));
    if (!file || file.roomId !== currentRoomId()) return res.status(404).json({ success: false, error: '文件不存在' });
    const username = req.syncWatchSession.username;
    const allowed = username === file.uploadedBy || canManageMediaLibrary(username, file.roomId);
    if (!allowed) return res.status(403).json({ success: false, error: '没有管理此文件的权限' });
    let name = req.body.originalName === undefined ? file.originalName : normalizeOriginalName(req.body.originalName);
    const originalExtension = path.extname(file.originalName);
    if (!path.extname(name) && originalExtension) name += originalExtension;
    if (!name || name === originalExtension) return res.status(400).json({ success: false, error: '文件名不能为空' });
    const previousName = file.originalName;
    const previousNote = cleanText(file.note, 500);
    file.originalName = name;
    if (req.body.note !== undefined) file.note = cleanText(req.body.note, 500);
    const reassociated = reassociateSubtitles();
    persist();
    emitFileToVisible('file-updated', file);
    for (const changed of reassociated) if (changed.id !== file.id) emitFileToVisible('file-updated', changed);
    const actorName = state.accounts[username]?.displayName || username;
    if (previousName !== name) {
      broadcastRoomNotice(file.roomId, `${actorName} 在影片库中将“${previousName}”重命名为“${name}”`, {
        kind: 'file-rename', actor: username, actorName, previousName, nextName: name, fileId: file.id, important: true
      });
      recordOperation({ actor: username, action: 'file-rename', summary: `重命名文件：${previousName} → ${name}`, undo: { kind: 'file-rename', fileId: file.id, before: previousName, after: name } });
    } else if (previousNote !== file.note) recordOperation({ actor: username, action: 'file-note', summary: `更新影片备注：${name}` });
    return res.json({ success: true, file: publicFile(file), message: previousName !== name ? '影片已重命名' : '影片备注已保存' });
  });

  app.patch('/api/files/:id/category', requireSession, (req, res) => {
    const file = findFile(cleanText(req.params.id, 80));
    if (!file || file.roomId !== currentRoomId()) return res.status(404).json({ success: false, error: '文件不存在' });
    const username = req.syncWatchSession.username;
    const allowed = username === file.uploadedBy || canManageMediaLibrary(username, file.roomId);
    if (!allowed) return res.status(403).json({ success: false, error: '没有管理此文件分类的权限' });
    const collection = cleanText(req.body?.collection || '未分类', 80).replace(/[\\/]/g, '').trim() || '未分类';
    const previous = mediaCollectionName(file);
    file.collection = collection;
    persist();
    emitFileToVisible('file-updated', file);
    recordOperation({ actor: username, action: 'file-category', summary: `调整影片分类：${file.originalName}（${previous} → ${collection}）` });
    return res.json({ success: true, file: publicFile(file), message: `影片已归入“${collection}”` });
  });

  app.patch('/api/files/category/batch', requireSession, (req, res) => {
    const fileIds = [...new Set((Array.isArray(req.body?.fileIds) ? req.body.fileIds : [])
      .map((id) => cleanText(id, 80)).filter(Boolean))].slice(0, 500);
    if (!fileIds.length) return res.status(400).json({ success: false, error: '请选择需要移动分类的影片' });
    const roomId = currentRoomId();
    const files = fileIds.map(findFile);
    if (files.some((file) => !file || file.roomId !== roomId)) return res.status(404).json({ success: false, error: '部分影片不存在或不属于当前房间' });
    const username = req.syncWatchSession.username;
    const denied = files.find((file) => username !== file.uploadedBy && !canManageMediaLibrary(username, file.roomId));
    if (denied) return res.status(403).json({ success: false, error: `没有管理影片“${denied.originalName}”分类的权限` });
    const collection = cleanText(req.body?.collection || '未分类', 80).replace(/[\\/]/g, '').trim() || '未分类';
    const changed = [];
    for (const file of files) {
      const previous = mediaCollectionName(file);
      if (previous === collection) continue;
      file.collection = collection;
      changed.push({ file, previous });
    }
    if (!changed.length) return res.json({ success: true, files: files.map(publicFile), moved: 0, message: `所选影片已经位于“${collection}”` });
    persist();
    for (const entry of changed) emitFileToVisible('file-updated', entry.file);
    const sourceCollections = [...new Set(changed.map((entry) => entry.previous))];
    recordOperation({
      actor: username, action: 'file-category-batch',
      summary: `批量调整 ${changed.length} 个影片分类：${sourceCollections.join('、')} → ${collection}`
    });
    return res.json({ success: true, files: files.map(publicFile), moved: changed.length, message: `已将 ${changed.length} 个影片移入“${collection}”` });
  });

  app.patch('/api/files/manage/batch', requireSession, (req, res) => {
    const fileIds = [...new Set((Array.isArray(req.body?.fileIds) ? req.body.fileIds : []).map((id) => cleanText(id, 80)).filter(Boolean))].slice(0, 500);
    if (!fileIds.length) return res.status(400).json({ success: false, error: '请选择需要管理的影片' });
    const files = fileIds.map(findFile);
    const roomId = req.syncWatchSessionRoomId;
    if (files.some((file) => !file || file.roomId !== roomId)) return res.status(404).json({ success: false, error: '部分影片不存在或不属于当前房间' });
    const username = req.syncWatchSession.username;
    const denied = files.find((file) => username !== file.uploadedBy && !canManageMediaLibrary(username, roomId));
    if (denied) return res.status(403).json({ success: false, error: `没有管理影片“${denied.originalName}”的权限` });
    const hasCollection = req.body.collection !== undefined;
    const hasNote = req.body.note !== undefined;
    if (!hasCollection && !hasNote) return res.status(400).json({ success: false, error: '没有需要保存的管理内容' });
    const collection = hasCollection ? cleanText(req.body.collection || '未分类', 80).replace(/[\\/]/g, '').trim() || '未分类' : '';
    const note = hasNote ? cleanText(req.body.note, 500) : '';
    for (const file of files) {
      if (hasCollection) file.collection = collection;
      if (hasNote) file.note = note;
    }
    persist();
    for (const file of files) emitFileToVisible('file-updated', file);
    recordOperation({ actor: username, action: 'file-manage-batch', summary: `批量管理 ${files.length} 个影片${hasCollection ? `，分类为“${collection}”` : ''}${hasNote ? '，并更新备注' : ''}` });
    return res.json({ success: true, files: files.map(publicFile), message: `已更新 ${files.length} 个影片` });
  });

  app.post('/api/files/cover/batch', requireSession, httpRateLimit('file-cover-batch', 8, 60 * 1000), async (req, res) => {
    const fileIds = [...new Set((Array.isArray(req.body?.fileIds) ? req.body.fileIds : [])
      .map((id) => cleanText(id, 80)).filter(Boolean))].slice(0, 200);
    if (!fileIds.length) return res.status(400).json({ success: false, error: '请选择需要更新封面的影片' });
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) return res.status(503).json({ success: false, error: '服务器未配置 FFmpeg，无法生成视频封面' });
    const roomId = currentRoomId();
    const username = req.syncWatchSession.username;
    const files = fileIds.map(findFile);
    if (files.some((file) => !file || file.roomId !== roomId || file.category !== 'video' || file.sourceType === 'remote')) {
      return res.status(400).json({ success: false, error: '只能为当前房间中的本地视频批量生成封面' });
    }
    const denied = files.find((file) => username !== file.uploadedBy && !canManageMediaLibrary(username, roomId));
    if (denied) return res.status(403).json({ success: false, error: `没有管理影片“${denied.originalName}”封面的权限` });
    const updated = [];
    for (const file of files) {
      const input = path.join(uploadsDir, file.storedName);
      if (!fs.existsSync(input)) continue;
      const thumbnailName = `${file.id}.jpg`;
      const thumbnailPath = path.join(thumbnailsDir, thumbnailName);
      const duration = Math.max(0, Number(file.metadata?.duration) || 0);
      const seekSeconds = duration > 8 ? (duration * (0.3 + Math.random() * 0.4)).toFixed(3) : '3';
      try {
        await captureProcess(ffmpegPath, ['-y', '-ss', seekSeconds, '-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumbnailPath], 60000, mediaAnalysisProcesses, { record: file });
        const stats = fs.statSync(thumbnailPath);
        if (!stats.isFile() || stats.size <= 0) throw new Error('封面输出为空');
        file.thumbnailName = thumbnailName;
        updated.push(file);
      } catch (error) {
        try { if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath); } catch (_) {}
        console.warn(`批量封面生成失败 ${file.originalName}:`, error.message);
      }
    }
    persist();
    updated.forEach((file) => emitFileToVisible('file-updated', file));
    if (updated.length) recordOperation({ roomId, actor: username, action: 'file-cover-batch', summary: `批量更新 ${updated.length} 个视频封面` });
    return res.json({ success: true, files: updated.map(publicFile), updated: updated.length, message: `已更新 ${updated.length}/${files.length} 个视频封面` });
  });

  app.delete('/api/files/:id', requireSession, httpRateLimit('file-delete', 30, 60 * 1000), async (req, res) => {
    const sessionRoomId = req.syncWatchSessionRoomId;
    const sessionRoom = roomConfig(sessionRoomId);
    const runtime = roomRuntime(sessionRoomId);
    const file = findFile(cleanText(req.params.id, 80));
    if (!file || file.roomId !== sessionRoomId) return res.status(404).json({ success: false, error: '文件不存在' });
    const username = req.syncWatchSession.username;
    let allowed = username === file.uploadedBy || canManageMediaLibrary(username, sessionRoomId);
    if (!allowed && req.headers['x-admin-password'] && (!state.admin.mustChangePassword || req.syncWatchSession.isServerHost)) {
      allowed = await verifyAdminAsync(req.headers['x-admin-password']);
    }
    if (!allowed) return res.status(403).json({ success: false, error: '没有删除权限' });
    const deletionId = crypto.randomUUID();
    const fileSnapshot = JSON.parse(JSON.stringify(file));
    const queueBefore = [...sessionRoom.queue];
    const playbackBefore = runtime.roomState.playback.fileId === file.id ? playbackSnapshot(sessionRoomId) : null;
    if (!await cancelMediaWork(file)) {
      resumeMediaWork(file);
      return res.status(503).json({ success: false, error: '后台媒体任务暂时无法安全停止，请稍后再删除' });
    }
    let artifacts;
    try { artifacts = moveFileArtifactsToTrash(file, deletionId); }
    catch (_) {
      resumeMediaWork(file);
      return res.status(500).json({ success: false, error: '文件移动到可回溯区失败，原文件未删除' });
    }
    state.files = state.files.filter((entry) => entry.id !== file.id);
    sessionRoom.queue = sessionRoom.queue.filter((id) => id !== file.id);
    const reassociated = reassociateSubtitles(sessionRoomId);
    let textReading = null;
    if (runtime.roomState.playback.fileId === file.id) {
      runtime.playbackGeneration += 1;
      runtime.roomState.playback = {
        fileId: null, isPlaying: false, stalled: false, currentTime: 0, volume: runtime.roomState.playback.volume, muted: Boolean(runtime.roomState.playback.muted), playbackRate: runtime.roomState.playback.playbackRate || 1,
        updatedAt: Date.now(), changedBy: null, revision: runtime.roomState.playback.revision + 1
      };
      textReading = resetTextReadingState(null, username, sessionRoomId);
    }
    persist();
    const operation = recordOperation({ id: deletionId, roomId: sessionRoomId, actor: username, action: 'file-delete', summary: `删除文件：${file.originalName}`, undo: { kind: 'file-delete', file: fileSnapshot, artifacts, queueBefore, playbackBefore } });
    broadcastMediaMutation(sessionRoomId, operation, fileSnapshot, 'delete');
    io.to(roomChannel(sessionRoomId)).emit('file-deleted', file.id);
    if (textReading) io.to(roomChannel(sessionRoomId)).emit('text-reading-state', textReading);
    for (const member of users.values()) {
      if (member.username === file.uploadedBy && member.roomId !== sessionRoomId) io.to(member.socketId).emit('file-deleted', file.id);
    }
    emitMediaProcessingSnapshots();
    for (const changed of reassociated) emitFileToVisible('file-updated', changed);
    io.to(roomChannel(sessionRoomId)).emit('queue-state', sessionRoom.queue);
    io.to(roomChannel(sessionRoomId)).emit('playback-state', playbackSnapshot(sessionRoomId));
    emitRoomDirectoryChanged(sessionRoomId, 'media-deleted');
    return res.json({ success: true });
  });

  app.get('/api/room/qr', requireSession, async (req, res, next) => {
    try {
      const url = String(req.query.url || '');
      if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+(?:\/.*)?$/.test(url) || url.length > 500) return res.status(400).json({ success: false, error: '地址无效' });
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 220, color: { dark: '#201327', light: '#ffffff' } });
      res.type('image/svg+xml').send(svg);
    } catch (error) { next(error); }
  });

  const BACKUP_SCOPES = ['config', 'accounts', 'rooms', 'media-index', 'chat'];
  const BACKUP_TRANSIENT_ROOTS = new Set([
    DATA_LOCK_DIRECTORY_NAME, 'imports', 'cache', 'logs', 'crash-dumps', 'electron-profile',
    '数据目录说明.txt', '服务器运行信息.txt', 'portable-move-marker.txt'
  ]);
  const BACKUP_TRANSIENT_FILE_PATTERN = /(?:\.tmp$|\.partial$|\.part$|\.download(?:-|\.)|\.rewrite-|\.corrupt-)/i;

  function normalizeBackupScopes(input, fallback = BACKUP_SCOPES) {
    const raw = Array.isArray(input) ? input : String(input || '').split(',');
    const scopes = [...new Set(raw.map((value) => String(value || '').trim()).filter(Boolean))];
    if (scopes.includes('all') || !scopes.length) return [...fallback];
    return scopes.filter((scope) => BACKUP_SCOPES.includes(scope));
  }

  function isFullBackupScope(scopes) {
    return BACKUP_SCOPES.every((scope) => scopes.includes(scope));
  }

  function backupDataDirectoryKey() {
    return crypto.createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex');
  }

  function normalizeBackupRelativePath(value) {
    const raw = String(value || '').replace(/\\/g, '/');
    if (!raw || raw.length > 1024 || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
      throw new Error('备份条目路径无效');
    }
    const normalized = path.posix.normalize(raw);
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      throw new Error('备份条目路径越界');
    }
    return normalized;
  }

  function backupPathScope(relativePath) {
    const root = String(relativePath || '').split('/')[0];
    if (root === 'avatars') return 'accounts';
    if (root === 'uploads' || root === 'compatible-media' || root === 'thumbnails' || root === 'subtitles' || root === 'trash' || root === 'download-assets') return 'media-index';
    if (root === 'chat-history.jsonl' || root === 'chat-images' || root === 'voice') return 'chat';
    return 'config';
  }

  function shouldExportBackupPath(relativePath, scopes) {
    const scope = backupPathScope(relativePath);
    return scopes.includes(scope);
  }

  function sha256FileSync(filename) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filename, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let bytesRead = 0;
      do { bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null); if (bytesRead) hash.update(buffer.subarray(0, bytesRead)); } while (bytesRead);
    } finally { fs.closeSync(fd); }
    return hash.digest('hex');
  }

  function walkBackupFiles(rootDirectory, relative = '', output = []) {
    const directory = path.join(rootDirectory, relative);
    if (!fs.existsSync(directory)) return output;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && BACKUP_TRANSIENT_ROOTS.has(entry.name)) continue;
      if (BACKUP_TRANSIENT_FILE_PATTERN.test(entry.name)) continue;
      const childPath = path.join(rootDirectory, childRelative);
      const stats = fs.lstatSync(childPath);
      if (stats.isSymbolicLink()) throw new Error(`备份目录不支持符号链接：${childRelative}`);
      if (stats.isDirectory()) walkBackupFiles(rootDirectory, childRelative, output);
      else if (stats.isFile()) output.push({
        relativePath: normalizeBackupRelativePath(childRelative), path: childPath,
        size: stats.size, sha256: sha256FileSync(childPath), scope: backupPathScope(childRelative)
      });
    }
    return output;
  }

  function backupDataEntries(scopes) {
    return walkBackupFiles(dataDir).filter((entry) => shouldExportBackupPath(entry.relativePath, scopes));
  }

  function exportMediaArtifacts(files) {
    const artifacts = [];
    for (const file of files || []) {
      for (const entry of fileArtifactPaths(file)) {
        if (!entry?.path || !fs.existsSync(entry.path)) continue;
        const stats = fs.statSync(entry.path);
        if (!stats.isFile()) continue;
        artifacts.push({ fileId: file.id, kind: entry.kind, name: path.basename(entry.path), size: stats.size, data: fs.readFileSync(entry.path).toString('base64') });
      }
    }
    return artifacts;
  }

  function importMediaArtifacts(artifacts, files) {
    const fileMap = new Map((files || []).map((file) => [file.id, file]));
    let restored = 0;
    for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
      const file = fileMap.get(cleanText(artifact?.fileId, 80));
      const kind = ['upload', 'thumbnail', 'subtitle', 'compatible'].includes(artifact?.kind) ? artifact.kind : '';
      if (!file || !kind || typeof artifact.data !== 'string') continue;
      const target = fileArtifactPaths(file).find((entry) => entry.kind === kind)?.path;
      if (!target) continue;
      const decoded = Buffer.from(artifact.data, 'base64');
      if (!decoded.length && Number(artifact.size) > 0) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, decoded);
      restored += 1;
    }
    return restored;
  }

  const BACKUP_ARCHIVE_MAGIC = Buffer.from('SYNCWATCH-BACKUP-2\n', 'ascii');

  function backupArtifactEntries(files) {
    const entries = [];
    for (const file of files || []) {
      for (const artifact of fileArtifactPaths(file)) {
        if (!artifact?.path || !fs.existsSync(artifact.path)) continue;
        const stats = fs.statSync(artifact.path);
        if (!stats.isFile()) continue;
        entries.push({ fileId: file.id, kind: artifact.kind, name: path.basename(artifact.path), size: stats.size, path: artifact.path, sha256: sha256FileSync(artifact.path) });
      }
    }
    return entries;
  }

  async function writeResponseChunk(res, chunk) {
    if (res.destroyed || res.writableEnded) throw new Error('备份下载连接已中断');
    if (!res.write(chunk)) await new Promise((resolve, reject) => {
      const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose); res.off('error', onError); };
      const onDrain = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error('备份下载连接已关闭')); };
      const onError = (error) => { cleanup(); reject(error); };
      res.once('drain', onDrain); res.once('close', onClose); res.once('error', onError);
    });
  }

  async function streamBackupArchive(res, metadata, entries) {
    res.type('application/vnd.syncwatch.backup');
    res.setHeader('Content-Disposition', attachmentContentDisposition(`SyncWatch同步观影-${APP_VERSION}-${metadata.scope}.swbackup`));
    const metadataBuffer = Buffer.from(JSON.stringify(metadata), 'utf8');
    const entryBuffers = entries.map((entry) => ({
      entry,
      header: Buffer.from(JSON.stringify({
        fileId: entry.fileId, kind: entry.kind, name: entry.name,
        relativePath: entry.relativePath, scope: entry.scope, sha256: entry.sha256
      }), 'utf8')
    }));
    const contentLength = BACKUP_ARCHIVE_MAGIC.length + 8 + metadataBuffer.length + 4
      + entryBuffers.reduce((total, item) => total + 4 + item.header.length + 8 + item.entry.size, 0);
    res.setHeader('Content-Length', String(contentLength));
    await writeResponseChunk(res, BACKUP_ARCHIVE_MAGIC);
    const metadataLength = Buffer.alloc(8); metadataLength.writeBigUInt64BE(BigInt(metadataBuffer.length));
    await writeResponseChunk(res, metadataLength); await writeResponseChunk(res, metadataBuffer);
    for (const { entry, header } of entryBuffers) {
      const headerLength = Buffer.alloc(4); headerLength.writeUInt32BE(header.length);
      const dataLength = Buffer.alloc(8); dataLength.writeBigUInt64BE(BigInt(entry.size));
      await writeResponseChunk(res, headerLength); await writeResponseChunk(res, header); await writeResponseChunk(res, dataLength);
      for await (const chunk of fs.createReadStream(entry.path)) await writeResponseChunk(res, chunk);
    }
    await writeResponseChunk(res, Buffer.alloc(4));
    res.end();
  }

  function readBackupChunk(fd, length, position) {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('备份块长度无效');
    const buffer = Buffer.alloc(length); let offset = 0;
    while (offset < length) {
      const read = fs.readSync(fd, buffer, offset, length - offset, position + offset);
      if (!read) throw new Error('备份文件不完整');
      offset += read;
    }
    return buffer;
  }

  function parseBackupArchive(archivePath) {
    const fd = fs.openSync(archivePath, 'r');
    try {
      const stats = fs.fstatSync(fd); let position = 0;
      const magic = readBackupChunk(fd, BACKUP_ARCHIVE_MAGIC.length, position); position += magic.length;
      if (!magic.equals(BACKUP_ARCHIVE_MAGIC)) throw new Error('不是有效的 SyncWatch同步观影 二进制备份');
      const metadataLength = Number(readBackupChunk(fd, 8, position).readBigUInt64BE()); position += 8;
      if (!Number.isSafeInteger(metadataLength) || metadataLength <= 0 || metadataLength > 512 * 1024 * 1024) throw new Error('备份元数据长度无效');
      const metadata = JSON.parse(readBackupChunk(fd, metadataLength, position).toString('utf8')); position += metadataLength;
      const artifacts = [];
      while (position < stats.size) {
        const headerLength = readBackupChunk(fd, 4, position).readUInt32BE(); position += 4;
        if (!headerLength) break;
        if (headerLength > 64 * 1024) throw new Error('备份条目头过大');
        const header = JSON.parse(readBackupChunk(fd, headerLength, position).toString('utf8')); position += headerLength;
        const size = Number(readBackupChunk(fd, 8, position).readBigUInt64BE()); position += 8;
        if (!Number.isSafeInteger(size) || size < 0 || position + size > stats.size) throw new Error('备份媒体条目不完整');
        if (artifacts.length >= 200000) throw new Error('备份条目数量过多');
        artifacts.push({ ...header, size, start: position }); position += size;
      }
      return { metadata, artifacts };
    } finally { fs.closeSync(fd); }
  }

  function restoreBinaryArtifact(archivePath, artifact, files) {
    const file = (files || []).find((entry) => entry.id === cleanText(artifact.fileId, 80));
    const kind = ['upload', 'thumbnail', 'subtitle', 'compatible'].includes(artifact.kind) ? artifact.kind : '';
    const target = file && kind ? fileArtifactPaths(file).find((entry) => entry.kind === kind)?.path : '';
    if (!target) return Promise.resolve(false);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!artifact.size) { fs.writeFileSync(target, Buffer.alloc(0)); return Promise.resolve(true); }
    return new Promise((resolve, reject) => pipeline(
      fs.createReadStream(archivePath, { start: artifact.start, end: artifact.start + artifact.size - 1 }),
      fs.createWriteStream(target),
      (error) => error ? reject(error) : resolve(true)
    ));
  }

  async function stageFullBackupArchive(archivePath, payload, artifacts, stageDirectory) {
    if (!payload?.fullSnapshot || Number(payload.archiveVersion) < 3) throw new Error('备份不是可迁移的完整数据快照');
    const seen = new Set();
    const manifest = new Map((Array.isArray(payload.dataManifest) ? payload.dataManifest : []).map((entry) => [String(entry.relativePath || ''), entry]));
    let totalBytes = 0;
    for (const artifact of artifacts) {
      const relativePath = normalizeBackupRelativePath(artifact.relativePath);
      if (BACKUP_TRANSIENT_ROOTS.has(relativePath.split('/')[0])) throw new Error('备份包含运行时或临时目录');
      if (!shouldExportBackupPath(relativePath, BACKUP_SCOPES)) throw new Error('备份条目范围无效');
      if (seen.has(relativePath)) throw new Error(`备份条目重复：${relativePath}`);
      seen.add(relativePath);
      if (!Number.isSafeInteger(Number(artifact.size)) || Number(artifact.size) < 0) throw new Error(`备份文件大小无效：${relativePath}`);
      totalBytes += Number(artifact.size);
      if (totalBytes > 2 * 1024 * 1024 * 1024 * 1024) throw new Error('备份文件总大小超过安全上限');
      const expectedHash = String(artifact.sha256 || manifest.get(relativePath)?.sha256 || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error(`备份缺少文件校验值：${relativePath}`);
      const target = path.join(stageDirectory, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) throw new Error(`备份条目目标重复：${relativePath}`);
      if (artifact.size > 0) {
        await new Promise((resolve, reject) => pipeline(
          fs.createReadStream(archivePath, { start: artifact.start, end: artifact.start + artifact.size - 1 }),
          fs.createWriteStream(target, { flags: 'wx' }),
          (error) => error ? reject(error) : resolve()
        ));
      } else fs.writeFileSync(target, Buffer.alloc(0), { flag: 'wx' });
      const stats = fs.statSync(target);
      if (stats.size !== Number(artifact.size) || sha256FileSync(target) !== expectedHash) throw new Error(`备份文件校验失败：${relativePath}`);
    }
    if (manifest.size && manifest.size !== seen.size) throw new Error('备份清单与文件条目数量不一致');
    for (const [relativePath] of manifest) if (!seen.has(normalizeBackupRelativePath(relativePath))) throw new Error(`备份缺少清单文件：${relativePath}`);
    return { restoredFiles: seen.size, restoredBytes: totalBytes };
  }

  async function stageFullBackupJson(payload, stageDirectory) {
    if (!payload?.fullSnapshot || Number(payload.archiveVersion) < 3) throw new Error('备份不是可迁移的完整数据快照');
    const files = Array.isArray(payload.dataFiles) ? payload.dataFiles : [];
    const manifest = new Map((Array.isArray(payload.dataManifest) ? payload.dataManifest : []).map((entry) => [String(entry.relativePath || ''), entry]));
    if (manifest.size && manifest.size !== files.length) throw new Error('备份清单与文件条目数量不一致');
    const seen = new Set(); let totalBytes = 0;
    for (const entry of files) {
      const relativePath = normalizeBackupRelativePath(entry?.relativePath);
      if (BACKUP_TRANSIENT_ROOTS.has(relativePath.split('/')[0])) throw new Error('备份包含运行时或临时目录');
      if (!shouldExportBackupPath(relativePath, BACKUP_SCOPES)) throw new Error('备份条目范围无效');
      if (seen.has(relativePath)) throw new Error(`备份条目重复：${relativePath}`);
      seen.add(relativePath);
      if (typeof entry.data !== 'string') throw new Error(`备份缺少文件内容：${relativePath}`);
      const decoded = Buffer.from(entry.data, 'base64');
      if (!Number.isSafeInteger(Number(entry.size)) || Number(entry.size) !== decoded.length) throw new Error(`备份文件大小无效：${relativePath}`);
      totalBytes += decoded.length;
      if (totalBytes > 2 * 1024 * 1024 * 1024 * 1024) throw new Error('备份文件总大小超过安全上限');
      const expectedHash = String(entry.sha256 || manifest.get(relativePath)?.sha256 || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error(`备份缺少文件校验值：${relativePath}`);
      const target = path.join(stageDirectory, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, decoded, { flag: 'wx' });
      if (sha256FileSync(target) !== expectedHash) throw new Error(`备份文件校验失败：${relativePath}`);
    }
    for (const [relativePath] of manifest) if (!seen.has(normalizeBackupRelativePath(relativePath))) throw new Error(`备份缺少清单文件：${relativePath}`);
    return { restoredFiles: seen.size, restoredBytes: totalBytes };
  }

  function backupManagedRootEntries() {
    return fs.readdirSync(dataDir, { withFileTypes: true })
      .filter((entry) => !BACKUP_TRANSIENT_ROOTS.has(entry.name) && !BACKUP_TRANSIENT_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  }

  async function replaceManagedDataFromStage(stageDirectory, afterInstall = null) {
    const importsDir = path.join(dataDir, 'imports');
    const rollbackDirectory = path.join(importsDir, `rollback-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(rollbackDirectory, { recursive: true });
    const movedOut = [];
    const movedIn = [];
    try {
      for (const name of backupManagedRootEntries()) {
        const source = path.join(dataDir, name); const target = path.join(rollbackDirectory, name);
        fs.renameSync(source, target); movedOut.push(name);
      }
      for (const name of fs.readdirSync(stageDirectory)) {
        const source = path.join(stageDirectory, name); const target = path.join(dataDir, name);
        fs.renameSync(source, target); movedIn.push(name);
      }
      for (const directory of [uploadsDir, thumbnailsDir, subtitlesDir, voiceDir, chatImagesDir, avatarsDir, loginCubeDir, loginCubeModelDir, loginMusicDir, loginVideoDir, compatibleMediaDir, downloadAssetsDir, downloadAssetTemporaryDir, trashDir, secretsDir, adminSecretsDir]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      const result = await afterInstall?.();
      fs.rmSync(rollbackDirectory, { recursive: true, force: true });
      return result === undefined ? true : result;
    } catch (error) {
      for (const name of [...movedIn].reverse()) { try { fs.rmSync(path.join(dataDir, name), { recursive: true, force: true }); } catch (_) {} }
      for (const name of [...movedOut].reverse()) { try { fs.renameSync(path.join(rollbackDirectory, name), path.join(dataDir, name)); } catch (_) {} }
      fs.rmSync(rollbackDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async function reloadImportedState() {
    const imported = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const migrated = migrateState(imported);
    if (fs.existsSync(adminPasswordFile)) {
      try {
        const secret = JSON.parse(fs.readFileSync(adminPasswordFile, 'utf8'));
        if (typeof secret?.passwordHash === 'string' && secret.passwordHash.startsWith('pbkdf2$')) {
          migrated.admin.passwordHash = secret.passwordHash;
          if (migrated.accounts.admin) migrated.accounts.admin.passwordHash = secret.passwordHash;
        }
      } catch (error) { throw new Error(`超级管理员密码文件损坏：${error.message}`); }
    }
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, migrated);
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    mailKeyCache = null;
    try { mailTransportCache?.close?.(); } catch (_) {}
    mailTransportCache = null;
    chatMessages.length = 0; chatRoomWindowCounts.clear(); chatParticipants.clear();
    const importedMessages = await readAllChatMessagesFromFile();
    for (const message of importedMessages) rememberChatMessage(message);
    roomRuntimes.clear(); roomRuntime(state.defaultRoomId);
    snapshotAllRoomRuntimes();
    atomicWriteJson(stateFile, state);
  }

  async function revokeSessionsAfterMigration(keepToken = '') {
    const preservedSession = keepToken ? sessions.get(keepToken) : null;
    const preservedRoomId = preservedSession && state.rooms[normalizeRoomId(preservedSession.roomId)]
      ? normalizeRoomId(preservedSession.roomId) : state.defaultRoomId;
    if (preservedSession) {
      preservedSession.roomId = preservedRoomId;
      preservedSession.roomAccessRevision = state.rooms[preservedRoomId]?.accessRevision || 1;
      preservedSession.lastSeenAt = Date.now();
      preservedSession.expiresAt = Date.now() + sessionMaxAgeMs;
    }
    for (const member of users.values()) {
      if (keepToken && member.sessionToken === keepToken) continue;
      io.to(member.socketId).emit('server-data-imported', { message: '服务器数据已迁移，请重新登录' });
    }
    for (const [token] of sessions) if (token !== keepToken) sessions.delete(token);
    for (const [socketId, member] of users) {
      if (keepToken && member.sessionToken === keepToken) { member.roomId = preservedRoomId; continue; }
      users.delete(socketId);
    }
    registrationClaims.clear(); roomCreateClaims.clear(); guestSessionsByIp.clear();
    for (const timer of disconnectTimers.values()) clearTimeout(timer);
    disconnectTimers.clear();
  }

  app.get('/api/host/data/export', requireSession, requireHost, async (req, res, next) => {
    try {
      req.setTimeout?.(0); res.setTimeout?.(0);
      const scopes = normalizeBackupScopes(req.query.scopes || req.query.scope);
      const fullSnapshot = isFullBackupScope(scopes);
      const output = { kind: 'syncwatch-data-export', version: APP_VERSION, archiveVersion: 3, fullSnapshot, sourceDataDirectoryKey: backupDataDirectoryKey(), scope: fullSnapshot ? 'all' : scopes[0] || 'all', scopes, exportedAt: new Date().toISOString() };
      const clone = (value) => JSON.parse(JSON.stringify(value));
      snapshotAllRoomRuntimes();
      await flushPendingChatLines();
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
      atomicWriteJson(stateFile, state);
      if (scopes.includes('config')) output.configState = { admin: clone(state.admin), defaultRoomId: state.defaultRoomId };
      if (scopes.includes('accounts')) {
        output.accounts = clone(state.accounts); output.blacklist = clone(state.blacklist); output.deletedUsernames = clone(state.deletedUsernames);
        output.accountAuditLogs = clone(state.accountAuditLogs || []);
      }
      if (scopes.includes('rooms')) { output.defaultRoomId = state.defaultRoomId; output.rooms = clone(state.rooms); }
      if (scopes.includes('media-index')) {
        output.files = clone(state.files);
        if (req.query.format !== 'binary') output.mediaArtifacts = exportMediaArtifacts(state.files);
      }
      if (scopes.includes('chat')) output.chatMessages = await readAllChatMessagesFromFile();
      if (fullSnapshot) {
        output.state = clone(state);
        const entries = backupDataEntries(scopes);
        output.dataManifest = entries.map(({ relativePath, size, sha256, scope }) => ({ relativePath, size, sha256, scope }));
        if (req.query.format !== 'binary') output.dataFiles = entries.map((entry) => ({ relativePath: entry.relativePath, size: entry.size, sha256: entry.sha256, scope: entry.scope, data: fs.readFileSync(entry.path).toString('base64') }));
      }
      output.note = '导出文件包含所选 SyncWatch同步观影 业务数据、配置、秘密密钥与媒体文件；不包含 cache、日志、客户端缓存、运行锁和导入临时文件。';
      if (req.query.format === 'binary') {
        const entries = fullSnapshot ? backupDataEntries(scopes) : (scopes.includes('media-index') ? backupArtifactEntries(state.files) : []);
        return await streamBackupArchive(res, output, entries);
      }
      res.setHeader('Content-Disposition', attachmentContentDisposition(`SyncWatch同步观影-${APP_VERSION}-${output.scope}.json`));
      return res.json(output);
    } catch (error) { return next(error); }
  });

  app.post('/api/host/data/import-binary', requireSession, requireHost, async (req, res) => {
    const importsDir = path.join(dataDir, 'imports'); fs.mkdirSync(importsDir, { recursive: true });
    const temporary = path.join(importsDir, `backup-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.swbackup`);
    const stageDirectory = path.join(importsDir, `staging-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
    const activeMutation = req.syncWatchMutationPromise;
    activeHttpMutations.delete(activeMutation);
    acceptingMutations = false;
    try {
      await new Promise((resolve, reject) => pipeline(req, fs.createWriteStream(temporary, { flags: 'wx' }), (error) => error ? reject(error) : resolve()));
      const { metadata: payload, artifacts } = parseBackupArchive(temporary);
      if (!payload || payload.kind !== 'syncwatch-data-export') throw new Error('不是有效的 SyncWatch同步观影 备份文件');
      const scopes = normalizeBackupScopes(req.query.scopes || payload.scopes || payload.scope);
      const clone = (value) => JSON.parse(JSON.stringify(value));
      if (payload.fullSnapshot && Number(payload.archiveVersion) >= 3 && isFullBackupScope(scopes)) {
        await drainMutations(CLOSE_DRAIN_TIMEOUT_MS);
        fs.mkdirSync(stageDirectory, { recursive: true });
        const staged = await stageFullBackupArchive(temporary, payload, artifacts, stageDirectory);
        const stagedConfig = path.join(stageDirectory, 'config.json');
        if (!fs.existsSync(stagedConfig)) throw new Error('完整备份缺少 config.json');
        const stagedState = migrateState(JSON.parse(fs.readFileSync(stagedConfig, 'utf8')));
        const stagedAdminSecret = path.join(stageDirectory, 'secrets', 'admin-password.json');
        if (!fs.existsSync(stagedAdminSecret)) throw new Error('完整备份缺少超级管理员密码密钥');
        try {
          const secret = JSON.parse(fs.readFileSync(stagedAdminSecret, 'utf8'));
          if (typeof secret?.passwordHash !== 'string' || !secret.passwordHash.startsWith('pbkdf2$')) throw new Error('超级管理员密码密钥格式无效');
          stagedState.admin.passwordHash = secret.passwordHash;
          if (stagedState.accounts.admin) stagedState.accounts.admin.passwordHash = secret.passwordHash;
        } catch (error) { throw new Error(`超级管理员密码密钥无效：${error.message}`); }
        await replaceManagedDataFromStage(stageDirectory, async () => {
          await reloadImportedState();
          return true;
        });
        if (payload.sourceDataDirectoryKey !== backupDataDirectoryKey()) await revokeSessionsAfterMigration(req.syncWatchToken);
        io.emit('server-policy-updated', { version: APP_VERSION });
        return res.json({ success: true, restoredFiles: staged.restoredFiles, restoredBytes: staged.restoredBytes, restoredArtifacts: staged.restoredFiles, message: `已安全迁移全部服务器数据、配置、账号、房间、聊天、密钥和 ${staged.restoredFiles} 个文件` });
      }
      const merged = clone(state);
      if (scopes.includes('config')) {
        if (payload.configState?.admin) merged.admin = payload.configState.admin;
        if (payload.configState?.defaultRoomId) merged.defaultRoomId = payload.configState.defaultRoomId;
        if (payload.state && typeof payload.state === 'object') Object.assign(merged, clone(payload.state));
      }
      if (scopes.includes('accounts') && payload.accounts) {
        merged.accounts = payload.accounts; merged.blacklist = payload.blacklist || merged.blacklist; merged.deletedUsernames = payload.deletedUsernames || merged.deletedUsernames;
        merged.accountAuditLogs = payload.accountAuditLogs || merged.accountAuditLogs;
      }
      if (scopes.includes('rooms') && payload.rooms) { merged.rooms = payload.rooms; merged.defaultRoomId = payload.defaultRoomId || merged.defaultRoomId; }
      if (scopes.includes('media-index') && payload.files) merged.files = payload.files;
      const migrated = migrateState(merged); for (const key of Object.keys(state)) delete state[key]; Object.assign(state, migrated);
      if (scopes.includes('chat') && Array.isArray(payload.chatMessages)) await writeAllChatMessages(payload.chatMessages);
      let restoredArtifacts = 0;
      if (scopes.includes('media-index')) for (const artifact of artifacts) if (await restoreBinaryArtifact(temporary, artifact, state.files)) restoredArtifacts += 1;
      persist(); io.emit('server-policy-updated', { version: APP_VERSION });
      return res.json({ success: true, restoredArtifacts, message: `已导入 ${isFullBackupScope(scopes) ? '全部' : scopes.join('、')} 数据和 ${restoredArtifacts} 个媒体文件` });
    } catch (error) { return res.status(400).json({ success: false, error: `二进制备份导入失败：${error.message}` }); }
    finally {
      acceptingMutations = true;
      try { fs.rmSync(temporary, { force: true }); } catch (_) {}
      try { fs.rmSync(stageDirectory, { recursive: true, force: true }); } catch (_) {}
    }
  });

  app.post('/api/host/data/import', requireSession, requireHost, async (req, res, next) => {
    try {
      const payload = req.body && typeof req.body === 'object' ? req.body : null;
      if (!payload || payload.kind !== 'syncwatch-data-export') return res.status(400).json({ success: false, error: '不是有效的 SyncWatch同步观影 备份文件' });
      const scopes = normalizeBackupScopes(req.query.scopes || payload.scopes || payload.scope);
      const clone = (value) => JSON.parse(JSON.stringify(value));
      if (payload.fullSnapshot && Number(payload.archiveVersion) >= 3 && isFullBackupScope(scopes)) {
        const importsDir = path.join(dataDir, 'imports'); const stageDirectory = path.join(importsDir, `staging-json-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
        activeHttpMutations.delete(req.syncWatchMutationPromise);
        acceptingMutations = false;
        try {
          await drainMutations(CLOSE_DRAIN_TIMEOUT_MS);
          fs.mkdirSync(stageDirectory, { recursive: true });
          const staged = await stageFullBackupJson(payload, stageDirectory);
          const stagedConfig = path.join(stageDirectory, 'config.json');
          if (!fs.existsSync(stagedConfig)) throw new Error('完整备份缺少 config.json');
          migrateState(JSON.parse(fs.readFileSync(stagedConfig, 'utf8')));
          const stagedAdminSecret = path.join(stageDirectory, 'secrets', 'admin-password.json');
          if (!fs.existsSync(stagedAdminSecret)) throw new Error('完整备份缺少超级管理员密码密钥');
          await replaceManagedDataFromStage(stageDirectory, async () => { await reloadImportedState(); return true; });
          if (payload.sourceDataDirectoryKey !== backupDataDirectoryKey()) await revokeSessionsAfterMigration(req.syncWatchToken);
          return res.json({ success: true, restoredFiles: staged.restoredFiles, restoredBytes: staged.restoredBytes, restoredArtifacts: staged.restoredFiles, message: `已安全迁移全部服务器数据、配置、账号、房间、聊天、密钥和 ${staged.restoredFiles} 个文件` });
        } finally { acceptingMutations = true; try { fs.rmSync(stageDirectory, { recursive: true, force: true }); } catch (_) {} }
      }
      const merged = clone(state);
      if (scopes.includes('config')) {
        if (payload.configState?.admin) merged.admin = payload.configState.admin;
        if (payload.configState?.defaultRoomId) merged.defaultRoomId = payload.configState.defaultRoomId;
        if (payload.state && typeof payload.state === 'object') Object.assign(merged, clone(payload.state));
      }
      if (scopes.includes('accounts') && payload.accounts) {
        merged.accounts = payload.accounts; merged.blacklist = payload.blacklist || merged.blacklist; merged.deletedUsernames = payload.deletedUsernames || merged.deletedUsernames;
        merged.accountAuditLogs = payload.accountAuditLogs || merged.accountAuditLogs;
      }
      if (scopes.includes('rooms') && payload.rooms) { merged.rooms = payload.rooms; merged.defaultRoomId = payload.defaultRoomId || merged.defaultRoomId; }
      if (scopes.includes('media-index') && payload.files) merged.files = payload.files;
      const migrated = migrateState(merged); for (const key of Object.keys(state)) delete state[key]; Object.assign(state, migrated);
      if (scopes.includes('chat') && Array.isArray(payload.chatMessages)) await writeAllChatMessages(payload.chatMessages);
      const restoredArtifacts = scopes.includes('media-index') ? importMediaArtifacts(payload.mediaArtifacts, state.files) : 0;
      persist(); io.emit('server-policy-updated', { version: APP_VERSION });
      return res.json({ success: true, restoredArtifacts, message: `已导入 ${isFullBackupScope(scopes) ? '全部' : scopes.join('、')} 数据；已保存，在线客户端会自动刷新配置` });
    } catch (error) { return res.status(400).json({ success: false, error: `备份导入失败：${error.message}` }); }
  });

  app.get('/api/host/tunnel/status', requireSession, requireHost, async (req, res) => {
    const status = tunnelManager ? await tunnelManager.status() : { state: 'unavailable', error: '当前不是桌面服务器版本' };
    synchronizeTunnelUrl(status);
    res.json({ success: true, status });
  });
  app.get('/api/host/tunnel/startup', requireSession, requireHost, async (req, res, next) => {
    try {
      const settings = tunnelManager?.startupSettings ? await tunnelManager.startupSettings() : { autoStartTunnel: false, mode: 'quick', publicUrl: '', bypassProxy: false, autoDiagnose: true, tokenConfigured: false };
      return res.json({ success: true, settings });
    } catch (error) { return next(error); }
  });
  app.post('/api/host/tunnel/startup', requireSession, requireHost, async (req, res, next) => {
    if (!tunnelManager?.saveStartupSettings) return res.status(501).json({ success: false, error: '当前环境不支持保存公网自动启动设置' });
    try {
      const settings = await tunnelManager.saveStartupSettings({
        autoStartTunnel: req.body?.autoStartTunnel === true,
        mode: req.body?.mode === 'named' ? 'named' : 'quick',
        token: String(req.body?.token || ''), publicUrl: cleanText(req.body?.publicUrl, 500), bypassProxy: req.body?.bypassProxy !== false,
        autoDiagnose: req.body?.autoDiagnose !== false
      });
      return res.json({ success: true, settings, message: settings.autoStartTunnel ? '已开启随系统启动并自动开启公网访问' : '已关闭公网自动启动' });
    } catch (error) { return next(error); }
  });
  app.post('/api/host/tunnel/start', requireSession, requireHost, async (req, res, next) => {
    if (!tunnelManager) return res.status(501).json({ success: false, error: '当前环境不支持公网隧道' });
    if (tunnelStartPromise || tunnelLifecycleLocked()) return res.status(409).json({ success: false, error: '公网隧道正在启动或已经运行，请稍后重试' });
    try {
      const unprotectedRooms = Object.values(state.rooms).filter((room) => visibleRoom(room) && !room.archived && !room.passwordHash);
      if (unprotectedRooms.length && req.body?.confirmUnprotectedRooms !== true) {
        const roomLabels = unprotectedRooms.slice(0, 5).map((room) => `${room.name}（${room.id}）`).join('、');
        return res.status(409).json({
          success: false, code: 'PUBLIC_ROOMS_UNPROTECTED', requiresConfirmation: true,
          rooms: unprotectedRooms.map((room) => ({ id: room.id, name: room.name })),
          error: `以下房间未设置访问密码：${roomLabels}`
        });
      }
      tunnelPolicyLocked = true;
      const mode = req.body.mode === 'named' ? 'named' : 'quick';
      const tunnelOptions = {
        mode, token: String(req.body.token || ''), publicUrl: cleanText(req.body.publicUrl, 500), bypassProxy: req.body?.bypassProxy !== false
      };
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'autoDiagnose')) tunnelOptions.autoDiagnose = req.body.autoDiagnose !== false;
      await tunnelManager.saveStartupSettings?.({ bypassProxy: tunnelOptions.bypassProxy });
      tunnelStartPromise = Promise.resolve().then(() => tunnelManager.start(tunnelOptions));
      const status = await tunnelStartPromise;
      synchronizeTunnelUrl(status);
      return res.json({ success: true, status });
    } catch (error) { return next(error); }
    finally {
      tunnelStartPromise = null;
      tunnelPolicyLocked = false;
    }
  });
  app.post('/api/host/tunnel/stop', requireSession, requireHost, async (req, res, next) => {
    try {
      const status = tunnelManager ? await tunnelManager.stop() : { state: 'stopped' };
      forgetTunnelUrl();
      return res.json({ success: true, status });
    }
    catch (error) { return next(error); }
  });
  app.get('/api/host/tunnel/diagnostics', requireSession, requireHost, async (req, res, next) => {
    try {
      const diagnostics = tunnelManager?.diagnostics ? await tunnelManager.diagnostics({ bypassProxy: req.query?.bypassProxy !== '0' }) : { state: 'unavailable', message: '当前环境不支持桌面端公网诊断' };
      return res.json({ success: true, diagnostics });
    } catch (error) { return next(error); }
  });
  app.post('/api/host/tunnel/repair', requireSession, requireHost, async (req, res, next) => {
    try {
      if (!tunnelManager?.repair) return res.status(501).json({ success: false, error: '当前环境不支持公网网络修复' });
      const status = await tunnelManager.repair({ bypassProxy: req.body?.bypassProxy !== false });
      synchronizeTunnelUrl(status);
      return res.json({ success: true, status, message: '已重新建立公网映射并完成网络修复尝试' });
    } catch (error) { return next(error); }
  });

  app.use(express.static(publicDir, { index: 'index.html', etag: true, maxAge: 0 }));

  function socketUser(socket, acknowledgement) {
    const user = users.get(socket.id);
    const session = user && validSession(user.sessionToken);
    if (user && session && sessionHasRoomAccess(session) && agreementAccepted(user.username)) return user;
    if (user && session && sessionHasRoomAccess(session)) {
      const agreement = normalizeLegalAgreement(state.admin.legalAgreement);
      const result = { success: false, code: 'AGREEMENT_REQUIRED', agreement, error: '请先阅读并同意软件使用协议' };
      socket.emit('agreement-required', agreement);
      if (typeof acknowledgement === 'function') acknowledgement(result);
      return null;
    }
    if (user && session) {
      const result = { success: false, code: 'ROOM_PASSWORD_REQUIRED', error: '房间密码已更新，请重新验证后继续' };
      socket.emit('room-password-verification-required', { roomId: user.roomId, message: result.error });
      if (typeof acknowledgement === 'function') acknowledgement(result);
      return null;
    }
    if (user) {
      stopScreenShare(socket.id);
      removeOnlineUser(socket.id);
      setImmediate(() => socket.disconnect(true));
    }
    const result = { success: false, error: '请先登录' };
    if (typeof acknowledgement === 'function') acknowledgement(result); else socket.emit('auth-error', result.error);
    return null;
  }

  function isHostToken(value) {
    return Boolean(hostControlToken && value && safeEqualText(hostControlToken, String(value)));
  }

  function canBootstrapServerHost(ipAddress, username, roomIdValue = state.defaultRoomId) {
    if (hostControlToken || normalizeIp(ipAddress) !== '127.0.0.1') return false;
    const defaultRoom = roomConfig(state.defaultRoomId);
    const defaultOwner = defaultRoom.ownerUsername;
    if (!defaultOwner && defaultRoom.systemRoom) {
      const requestedRoom = roomConfig(roomIdValue);
      return isSuperAdmin(username) || Boolean(requestedRoom && visibleRoom(requestedRoom) && requestedRoom.ownerUsername === username);
    }
    return defaultOwner ? defaultOwner === username : roomIdValue === state.defaultRoomId;
  }

  function onlineUsername(username, exceptSocketId = '', sessionToken = '') {
    return [...users.values()].some((user) => user.username === username && user.socketId !== exceptSocketId
      && (user.sessionToken !== sessionToken || user.connectionState !== 'reconnecting'));
  }

  function emitRoomEntryNotice(socket, roomIdValue) {
    const configured = effectiveRoomEntryNotice(roomIdValue);
    if (!configured.enabled || !configured.text) return null;
    const notice = {
      ...configured,
      id: crypto.randomUUID(),
      roomId: normalizeRoomId(roomIdValue) || currentRoomId(),
      shownAt: new Date().toISOString()
    };
    socket.emit('room-entry-notice', notice);
    return notice;
  }

  function attachUser(socket, session, clientInfo = {}) {
    const previousPresence = [...users.values()].find((entry) => entry.sessionToken === session.token && entry.roomId === session.roomId) || null;
    const resumedAudioShare = Boolean(previousPresence
      && roomRuntime(session.roomId).roomState.audioShare?.active
      && roomRuntime(session.roomId).roomState.audioShare.socketId === previousPresence.socketId);
    const alreadyPresent = Boolean(previousPresence);
    const wasAccountOnline = alreadyPresent || accountIsOnline(session.username);
    const currentUser = users.get(socket.id);
    if (currentUser && currentUser.sessionToken !== session.token) {
      socket.leave(roomChannel(currentUser.roomId));
      removeOnlineUser(socket.id, { scheduleClose: true, reason: 'session-replaced' });
    }
    for (const [oldSocketId, oldUser] of users) {
      if (oldUser.sessionToken !== session.token) continue;
      clearTimeout(disconnectTimers.get(oldSocketId));
      disconnectTimers.delete(oldSocketId);
      clearScreenFrameDelivery(roomRuntime(oldUser.roomId), oldSocketId);
      if (oldUser.roomId === session.roomId) users.delete(oldSocketId);
      else removeOnlineUser(oldSocketId, { scheduleClose: true, reason: 'session-room-changed' });
      if (oldSocketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        oldSocket?.leave(roomChannel(oldUser.roomId));
        oldSocket?.disconnect(true);
      }
    }
    const info = {
      socketId: socket.id, username: session.username, roomId: session.roomId, ipAddress: getSocketIp(socket), peerAddress: normalizeIp(socket.handshake?.address), deviceName: cleanText(clientInfo.deviceName || '浏览器设备', 50),
      platform: cleanText(clientInfo.platform || '未知平台', 40), browser: cleanText(clientInfo.browser || '浏览器', 40),
      joinedAt: previousPresence?.joinedAt || new Date().toISOString(), onlineStartedAt: previousPresence?.onlineStartedAt || Date.now(),
      sessionToken: session.token, latency: previousPresence?.latency ?? null, syncPercent: previousPresence?.syncPercent ?? 100,
      playbackQuality: previousPresence?.playbackQuality || 'original', drift: previousPresence?.drift ?? 0, connectionState: 'online',
      deviceId: cleanText(clientInfo.deviceId || session.deviceId || '', 80),
      location: previousPresence?.location || { status: '未授权位置', country: '', province: '', city: '', district: '', street: '', latitude: null, longitude: null }
    };
    session.socketId = socket.id;
    session.isServerHost = session.isServerHost || isHostToken(clientInfo.hostToken);
    const room = roomConfig(session.roomId);
    markRoomActive(room.id);
    if (session.isServerHost && room.id === state.defaultRoomId && !room.ownerUsername) {
      room.ownerUsername = session.username;
      const ownerAccount = state.accounts[session.username];
      if (ownerAccount) ownerAccount.stats.createdRooms = Math.max(1, Number(ownerAccount.stats.createdRooms) || 0);
      persist();
    }
    users.set(socket.id, info);
    broadcastAccountPresence(info.username, true, { announceOnline: !wasAccountOnline });
    socket.join(roomChannel(session.roomId));
    const resumedAudioRuntime = resumedAudioShare ? roomRuntime(session.roomId) : null;
    if (resumedAudioRuntime) resumedAudioRuntime.roomState.audioShare.socketId = socket.id;
    io.to(roomChannel(session.roomId)).emit('users-list', usersList(session.roomId));
    emitRoomDirectoryChanged(session.roomId, 'member-joined');
    if (!alreadyPresent) {
      broadcastMemberPresence(room.id, info, 'join', { reason: 'login' });
      if (isSuperAdmin(info.username)) {
        io.to(roomChannel(room.id)).emit('danmaku', {
          id: crypto.randomUUID(), roomId: room.id, type: 'announcement', channel: 'danmaku',
          from: info.username, username: info.username, displayName: state.accounts[info.username]?.displayName || info.username,
          text: '超级管理员已进入当前房间', color: '#f3c96a', timestamp: new Date().toISOString()
        });
      }
    }
    socket.emit('room-state', roomSnapshot(session.roomId));
    socket.emit('web-share-state', { roomId: session.roomId, ...roomRuntime(session.roomId).roomState.webShare, serverTime: Date.now() });
    if (resumedAudioRuntime) {
      io.to(roomChannel(session.roomId)).emit('audio-share-state', { ...resumedAudioRuntime.roomState.audioShare });
      socket.to(roomChannel(session.roomId)).emit('audio-share-webrtc-request', { sharerSocketId: socket.id });
    }
    if (!alreadyPresent) emitRoomEntryNotice(socket, session.roomId);
    if (agreementAccepted(session.username)) setImmediate(() => emitPendingClientModeRequests(socket, session.username));
    const runtime = roomRuntime(session.roomId);
    if (runtime.roomState.screenShare.active && runtime.latestScreenFrame) queueScreenFrameForSocket(session.roomId, socket, runtime.latestScreenFrame);
    return info;
  }

  function authResult(session, user) {
    const agreement = normalizeLegalAgreement(state.admin.legalAgreement);
    const account = state.accounts[user.username];
    const notifications = Array.isArray(account?.pendingNotifications) ? account.pendingNotifications.slice(-100) : [];
    if (notifications.length) {
      account.pendingNotifications = [];
      schedulePersist(0);
    }
    const claimedRegistrationRequests = [];
    if (user.username === 'admin' && agreementAccepted(user.username)) {
      const claimedAt = new Date().toISOString();
      for (const request of state.admin.registrationRequests) {
        if (request?.status !== 'pending' || cleanUsername(request.popupClaimedBy)) continue;
        request.popupClaimedBy = user.username;
        request.popupClaimedAt = claimedAt;
        claimedRegistrationRequests.push({
          id: request.id, username: request.username,
          requestedCount: registrationRequestCount(request.requestedCount),
          remainingCount: Math.max(0, Number(request.remainingCount ?? request.requestedCount) || 0),
          totalRequestedCount: Math.max(0, Number(request.totalRequestedCount) || registrationRequestCount(request.requestedCount)),
          withdrawnCount: Math.max(0, Number(request.withdrawnCount) || 0),
          reason: cleanText(request.reason, 200), createdAt: request.createdAt
        });
      }
      if (claimedRegistrationRequests.length) schedulePersist(0);
    }
    return {
      success: true, token: session.token, expiresAt: session.expiresAt,
      sessionMode: session.sessionMode === 'management' ? 'management' : 'room',
      user: publicUser(user), room: roomSnapshot(user.roomId), serverTime: Date.now(),
      permissions: permissionFor(user.username, user.roomId), capabilities: {
        serverHost: Boolean(session.isServerHost), owner: Boolean(session.isServerHost || user.username === roomConfig(user.roomId).ownerUsername),
        admin: isRoomAdmin(user), superAdmin: isSuperAdmin(user.username),
        mustChangeAdminPassword: Boolean(session.isServerHost && (state.admin.mustChangePassword || passwordExpired('admin', { adminSecret: true }))),
        mustChangeAccountPassword: Boolean(user.username === 'admin'
          && (state.accounts[user.username]?.mustChangePassword || passwordExpired(user.username))),
        canSetInitialAccountPassword: Boolean(session.isServerHost && user.username === 'admin'
          && state.admin.mustChangePassword === true && state.accounts[user.username]?.mustChangePassword),
        // A password-authenticated admin session already verified the
        // credential immediately before this first-login prompt.  Keep this
        // separate from canSetInitialAccountPassword so local passwordless
        // host sessions still require an explicit credential confirmation.
        canSkipInitialAccountPasswordVerification: Boolean(session.isServerHost && user.username === 'admin'
          && state.admin.mustChangePassword === true && state.accounts[user.username]?.mustChangePassword
          && session.passwordAuthenticated === true),
        agreementRequired: !agreementAccepted(user.username)
      }, agreement, notifications, claimedRegistrationRequests,
      friendNotifications: friendUnreadNotifications(user.username),
      friendRoomRequests: retainPersistentRequests(account?.friendRoomRequests).filter((request) => request.status === 'pending').slice(-100).map((request) => ({
        ...request, displayName: state.accounts[request.from]?.displayName || request.from,
        roomName: state.rooms[request.roomId]?.name || request.roomName || request.roomId
      })),
      friendSettings: normalizeFriendSettings(account?.friendSettings),
      // Keep a compact, account-scoped resume map in the auth response so a
      // fresh client can continue unfinished videos without exposing history
      // from other accounts.
      resumeHistory: (Array.isArray(account?.watchHistory) ? account.watchHistory : []).slice(-200).map((item) => ({
        roomId: cleanText(item.roomId || '', 80), fileId: cleanText(item.fileId || '', 80),
        progress: Math.max(0, Number(item.progress) || 0), duration: Math.max(0, Number(item.duration) || 0),
        lastWatchTime: cleanText(item.lastWatchTime || '', 40)
      })),
      roomEntryNotice: effectiveRoomEntryNotice(user.roomId)
    };
  }

  function restoreArchivedRoomForOwner(room, username) {
    if (!room?.archived) return true;
    if (room.ownerUsername !== username && !isSuperAdmin(username)) return false;
    room.archived = false;
    room.archivedAt = '';
    persist();
    return true;
  }

  function switchUserRoom(socket, user, session, targetRoom) {
    const previousRoomId = user.roomId;
    if (previousRoomId === targetRoom.id) return user;
    const switchedAt = Date.now();
    broadcastMemberPresence(previousRoomId, user, 'leave', {
      reason: 'room-switch', timestamp: switchedAt, targetRoomId: targetRoom.id
    });
    leaveLiveVoice(user, 'room-switch');
    stopScreenShare(socket.id, previousRoomId);
    clearScreenFrameDelivery(roomRuntime(previousRoomId), socket.id);
    socket.leave(roomChannel(previousRoomId));
    user.roomId = targetRoom.id;
    user.joinedAt = new Date().toISOString();
    session.roomId = targetRoom.id;
    session.roomAccessRevision = targetRoom.accessRevision;
    markRoomActive(targetRoom.id);
    socket.join(roomChannel(targetRoom.id));
    withRoom(previousRoomId, () => io.to(roomChannel(previousRoomId)).emit('users-list', usersList(previousRoomId)));
    if (state.rooms[previousRoomId]?.temporary) void deleteTemporaryRoomIfEmpty(previousRoomId);
    withRoom(targetRoom.id, () => {
      io.to(roomChannel(targetRoom.id)).emit('users-list', usersList(targetRoom.id));
      broadcastMemberPresence(targetRoom.id, user, 'join', {
        reason: 'room-switch', timestamp: switchedAt, previousRoomId
      });
      socket.emit('room-state', roomSnapshot(targetRoom.id));
      socket.emit('queue-state', [...targetRoom.queue]);
      socket.emit('web-share-state', { roomId: targetRoom.id, ...roomRuntime(targetRoom.id).roomState.webShare, serverTime: Date.now() });
      emitRoomEntryNotice(socket, targetRoom.id);
    });
    emitRoomDirectoryChanged(previousRoomId, 'member-left');
    emitRoomDirectoryChanged(targetRoom.id, 'member-joined');
    const account = state.accounts[user.username];
    if (account) account.stats.joinedRooms = Math.max(1, Number(account.stats.joinedRooms) || 0) + 1;
    persist();
    return user;
  }

  async function dissolveRoom(roomIdValue, ownerUsername, preserveData, options = {}) {
    const id = normalizeRoomId(roomIdValue);
    const room = id && state.rooms[id];
    if (!room || (!options.force && room.ownerUsername !== ownerUsername)) return { success: false, error: '房间不存在或您不是房主' };
    snapshotRoomRuntime(id);
    const affectedUsers = roomUsers(id);
    const roomLabel = room.name || id;
    const offlineKnownUsers = new Set(Object.entries(state.accounts)
      .filter(([username, account]) => !affectedUsers.some((member) => member.username === username)
        && ((account.recentRooms || []).includes(id) || (account.pinnedRooms || []).includes(id) || account.roomAccessGrants?.[id]))
      .map(([username]) => username));
    if (preserveData) {
      room.archived = true;
      room.archivedAt = new Date().toISOString();
    } else {
      const roomFiles = state.files.filter((file) => file.roomId === id);
      for (const file of roomFiles) {
        await cancelMediaWork(file, '房间已解散，后台媒体任务已终止').catch(() => {});
        try { removeFileArtifacts(file); } catch (_) {}
      }
      state.files = state.files.filter((file) => file.roomId !== id);
      const removedMessages = await removeChatMessages((message) => message.roomId === id);
      for (const message of removedMessages) {
        for (const [urlValue, prefix, directory] of [[message.voiceUrl, '/voice/', voiceDir], [message.imageUrl, '/chat-image/', chatImagesDir]]) {
          const match = String(urlValue || '').match(new RegExp(`^${prefix.replace(/\//g, '\\/')}([^/?#]+)$`));
          if (match) fs.rmSync(path.join(directory, path.basename(decodeURIComponent(match[1]))), { force: true });
        }
      }
      state.operations = state.operations.filter((operation) => operation.roomId !== id);
      for (const account of Object.values(state.accounts)) {
        account.recentRooms = (account.recentRooms || []).filter((roomEntry) => roomEntry !== id);
        account.pinnedRooms = (account.pinnedRooms || []).filter((roomEntry) => roomEntry !== id);
        if (account.roomAccessGrants) delete account.roomAccessGrants[id];
      }
      delete state.rooms[id];
      roomRuntimes.delete(id);
    }
    const affectedNames = new Set(affectedUsers.map((member) => member.username));
    for (const [username, account] of Object.entries(state.accounts)) {
      if (affectedNames.has(username) || !offlineKnownUsers.has(username)) continue;
      account.pendingNotifications = Array.isArray(account.pendingNotifications) ? account.pendingNotifications : [];
      account.pendingNotifications.push({ id: crypto.randomUUID(), kind: 'room-dissolved', roomId: id, roomName: roomLabel,
        message: preserveData ? `房间“${roomLabel}”（${id}）已被房主关闭并存档` : `房间“${roomLabel}”（${id}）已被删除，房间数据已清除`,
        preserved: Boolean(preserveData), createdAt: new Date().toISOString(), important: true });
      account.pendingNotifications = account.pendingNotifications.slice(-100);
    }
    if (state.defaultRoomId === id || !state.rooms[state.defaultRoomId] || state.rooms[state.defaultRoomId].archived) {
      const replacement = Object.values(state.rooms).find((entry) => !entry.archived && !entry.temporary);
      if (replacement) state.defaultRoomId = replacement.id;
      else {
        let replacementId;
        do { replacementId = roomId(); } while (state.rooms[replacementId]);
        const waitingRoom = freshRoom(replacementId, '', { name: '系统候场室', createdBy: '', systemRoom: true });
        state.rooms[replacementId] = waitingRoom;
        state.defaultRoomId = replacementId;
      }
      state.admin.accessPasswordHash = roomConfig(state.defaultRoomId).passwordHash || '';
    }
    persist();
    for (const member of affectedUsers) {
      const memberSession = sessions.get(member.sessionToken);
      if (memberSession) sessions.delete(member.sessionToken);
      const targetSocket = io.sockets.sockets.get(member.socketId);
      if (!options.temporaryCleanup) targetSocket?.emit('room-dissolved', {
        roomId: id, preserved: Boolean(preserveData), nextRoomId: state.defaultRoomId,
        roomName: roomLabel,
        message: preserveData ? `房主已关闭房间“${roomLabel}”，影片和记录均已保留` : `房间“${roomLabel}”已被删除，房间数据已清除`
      });
      stopScreenShare(member.socketId, id);
      users.delete(member.socketId);
      setImmediate(() => targetSocket?.disconnect(true));
    }
    emitRoomDirectoryChanged(id, preserveData ? 'archived' : 'deleted');
    return {
      success: true, preserved: Boolean(preserveData), roomId: id, nextRoomId: state.defaultRoomId,
      message: preserveData ? `房间 ${id} 已关闭并存档；下次使用房主账号进入此房间号即可完整恢复` : `房间 ${id} 及其数据已删除`
    };
  }

  async function removeRoomsForAccount(username, roomIds, confirmOwnedDeletion = false) {
    const account = state.accounts[username];
    if (!account) return { success: false, error: '账号不存在' };
    const ids = [...new Set((Array.isArray(roomIds) ? roomIds : []).map(normalizeRoomId).filter(Boolean))];
    if (!ids.length) return { success: false, error: '请选择至少一个房间' };
    const visibleIds = new Set(roomListForAccount(username).map((room) => room.id));
    const allowedIds = ids.filter((id) => visibleIds.has(id));
    if (!allowedIds.length) return { success: false, error: '所选房间不在“我的房间”列表中' };
    const owned = allowedIds.filter((id) => state.rooms[id]?.ownerUsername === username);
    if (owned.length && confirmOwnedDeletion !== true) {
      return { success: false, code: 'OWNED_ROOM_CONFIRMATION_REQUIRED', error: '删除自己拥有的房间会永久清除其中的影片和记录，请再次确认' };
    }
    const removedHistory = [];
    const deletedRooms = [];
    for (const id of allowedIds.filter((entry) => !owned.includes(entry))) {
      const before = account.recentRooms?.length || 0;
      account.recentRooms = (account.recentRooms || []).filter((entry) => entry !== id);
      account.pinnedRooms = (account.pinnedRooms || []).filter((entry) => entry !== id);
      if ((account.recentRooms?.length || 0) !== before) removedHistory.push(id);
    }
    const activeRoomIds = new Set(accountOnlineMembers(username).map((member) => member.roomId));
    owned.sort((left, right) => Number(activeRoomIds.has(left)) - Number(activeRoomIds.has(right)));
    for (const id of owned) {
      const result = await dissolveRoom(id, username, false, { actor: username });
      if (result.success) deletedRooms.push(id);
    }
    persist();
    return {
      success: true, deletedRooms, removedHistory, rooms: roomListForAccount(username),
      message: `已永久删除 ${deletedRooms.length} 个自有房间，并移除 ${removedHistory.length} 条房间记录`
    };
  }

  function generateGuestUsername() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let username = '';
    do {
      const length = 4 + crypto.randomInt(3);
      let suffix = '';
      for (let index = 0; index < length; index += 1) suffix += alphabet[crypto.randomInt(alphabet.length)];
      username = cleanUsername(`游客${suffix}`);
    } while (!username || state.accounts[username]);
    return username;
  }

  async function purgeGuestAccount(username, clientIp) {
    const normalized = cleanUsername(username);
    const account = state.accounts[normalized];
    if (!account?.guest) return { success: false, error: '该账号不是游客账号' };
    for (const room of Object.values(state.rooms)) {
      delete room.permissions[normalized];
      delete room.memberGroups[normalized];
    }
    for (const [otherUsername, otherAccount] of Object.entries(state.accounts)) {
      if (otherUsername === normalized) continue;
      otherAccount.friends = Array.isArray(otherAccount.friends) ? otherAccount.friends.filter((name) => name !== normalized) : [];
      if (otherAccount.friendMeta && typeof otherAccount.friendMeta === 'object') delete otherAccount.friendMeta[normalized];
      otherAccount.friendRequests = Array.isArray(otherAccount.friendRequests)
        ? otherAccount.friendRequests.filter((request) => request?.from !== normalized && request?.to !== normalized) : [];
      otherAccount.friendBlocks = Array.isArray(otherAccount.friendBlocks) ? otherAccount.friendBlocks.filter((name) => name !== normalized) : [];
    }
    const ownedRoomIds = Object.keys(state.rooms).filter((id) => state.rooms[id]?.ownerUsername === normalized);
    for (const id of ownedRoomIds) {
      await dissolveRoom(id, normalized, false, { force: true, temporaryCleanup: true }).catch(() => {});
    }
    const guestFiles = state.files.filter((file) => file.uploadedBy === normalized);
    for (const file of guestFiles) {
      const roomId = normalizeRoomId(file.roomId) || state.defaultRoomId;
      const room = state.rooms[roomId];
      const runtime = roomRuntime(roomId);
      try {
        await cancelMediaWork(file, '游客退出，后台媒体任务已终止').catch(() => {});
        try { moveFileArtifactsToTrash(file, crypto.randomUUID()); }
        catch (_) { try { removeFileArtifacts(file); } catch (__) {} }
        state.files = state.files.filter((entry) => entry.id !== file.id);
        if (room) room.queue = room.queue.filter((id) => id !== file.id);
        if (runtime.roomState.playback.fileId === file.id) {
          runtime.playbackGeneration += 1;
          runtime.roomState.playback = {
            fileId: null, isPlaying: false, stalled: false, currentTime: 0, volume: runtime.roomState.playback.volume,
            muted: Boolean(runtime.roomState.playback.muted), playbackRate: runtime.roomState.playback.playbackRate || 1,
            updatedAt: Date.now(), changedBy: null, revision: runtime.roomState.playback.revision + 1
          };
        }
        if (room) {
          for (const changed of reassociateSubtitles(room.id)) emitFileToVisible('file-updated', changed);
          io.to(roomChannel(room.id)).emit('queue-state', room.queue);
          io.to(roomChannel(room.id)).emit('playback-state', playbackSnapshot(room.id));
        }
      } catch (_) {
        resumeMediaWork(file);
      }
    }
    for (const [ip, entry] of guestSessionsByIp) {
      if (entry?.username === normalized || ip === normalizeIp(clientIp)) guestSessionsByIp.delete(ip);
    }
    for (const [token, entry] of guestSessionRecords) {
      if (entry?.username === normalized || entry?.ipAddress === normalizeIp(clientIp)) guestSessionRecords.delete(token);
    }
    for (const key of ['registrationRequests', 'roomQuotaRequests', 'uploadPolicyRequests', 'storageQuotaRequests', 'mediaManagementRequests', 'mediaUploadBans']) {
      state.admin[key] = (Array.isArray(state.admin[key]) ? state.admin[key] : [])
        .filter((entry) => !['username', 'requestedBy', 'targetUsername', 'addedBy'].some((field) => cleanUsername(entry?.[field]) === normalized));
    }
    revokeUserSessions(normalized, 'auth-error', '游客会话已退出并清除');
    delete state.accounts[normalized];
    emailBindingCodes.delete(normalized);
    clearPasswordResetState(`account:${normalized}`);
    persist();
    return { success: true };
  }

  function renameObjectIdentityKey(target, previousUsername, nextUsername) {
    if (!target || typeof target !== 'object' || Array.isArray(target) || !(previousUsername in target)) return;
    if (!(nextUsername in target)) target[nextUsername] = target[previousUsername];
    delete target[previousUsername];
  }

  function replaceIdentityFields(value, previousUsername, nextUsername, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return;
    const identityKeys = new Set([
      'username', 'actor', 'from', 'to', 'ownerUsername', 'createdBy', 'uploadedBy',
      'resolvedBy', 'addedBy', 'undoneBy', 'changedBy', 'requestedBy', 'targetUsername'
    ]);
    for (const [key, entry] of Object.entries(value)) {
      if (identityKeys.has(key) && entry === previousUsername) value[key] = nextUsername;
      else if (entry && typeof entry === 'object') replaceIdentityFields(entry, previousUsername, nextUsername, depth + 1);
    }
  }

  function migrateGuestIdentity(previousUsername, nextUsername, account) {
    for (const room of Object.values(state.rooms)) {
      if (room.ownerUsername === previousUsername) room.ownerUsername = nextUsername;
      if (room.createdBy === previousUsername) room.createdBy = nextUsername;
      renameObjectIdentityKey(room.permissions, previousUsername, nextUsername);
      renameObjectIdentityKey(room.memberGroups, previousUsername, nextUsername);
      renameObjectIdentityKey(room.mediaManagementGrants, previousUsername, nextUsername);
      replaceIdentityFields(room.savedState, previousUsername, nextUsername);
    }
    for (const [username, otherAccount] of Object.entries(state.accounts)) {
      if (!otherAccount || username === previousUsername) continue;
      otherAccount.friends = (Array.isArray(otherAccount.friends) ? otherAccount.friends : [])
        .map((entry) => entry === previousUsername ? nextUsername : entry);
      otherAccount.friendBlocks = (Array.isArray(otherAccount.friendBlocks) ? otherAccount.friendBlocks : [])
        .map((entry) => entry === previousUsername ? nextUsername : entry);
      renameObjectIdentityKey(otherAccount.friendMeta, previousUsername, nextUsername);
      renameObjectIdentityKey(otherAccount.userRemarks, previousUsername, nextUsername);
      for (const collection of ['friendRequests', 'friendMessages', 'friendRoomRequests', 'pendingNotifications']) {
        replaceIdentityFields(otherAccount[collection], previousUsername, nextUsername);
      }
    }
    for (const collection of ['friendRequests', 'friendMessages', 'friendRoomRequests', 'pendingNotifications']) {
      replaceIdentityFields(account[collection], previousUsername, nextUsername);
    }
    renameObjectIdentityKey(account.friendMeta, previousUsername, nextUsername);
    renameObjectIdentityKey(account.userRemarks, previousUsername, nextUsername);
    account.friends = (Array.isArray(account.friends) ? account.friends : []).map((entry) => entry === previousUsername ? nextUsername : entry);
    account.friendBlocks = (Array.isArray(account.friendBlocks) ? account.friendBlocks : []).map((entry) => entry === previousUsername ? nextUsername : entry);
    for (const file of state.files) replaceIdentityFields(file, previousUsername, nextUsername);
    for (const operation of state.operations) replaceIdentityFields(operation, previousUsername, nextUsername);
    for (const entry of state.blacklist) replaceIdentityFields(entry, previousUsername, nextUsername);
    for (const key of ['registrationRequests', 'roomQuotaRequests', 'uploadPolicyRequests', 'storageQuotaRequests', 'mediaManagementRequests', 'mediaUploadBans']) {
      replaceIdentityFields(state.admin[key], previousUsername, nextUsername);
    }
    for (const runtime of roomRuntimes.values()) {
      replaceIdentityFields(runtime.roomState, previousUsername, nextUsername);
      replaceIdentityFields(runtime.playbackChanges, previousUsername, nextUsername);
    }
  }

  // Login names are the primary key for account data. Keep the same
  // migration guarantees as guest conversion when a signed-in account
  // changes that key, including pending requests and in-memory presence.
  function migrateAccountIdentity(previousUsername, nextUsername, account) {
    migrateGuestIdentity(previousUsername, nextUsername, account);
    for (const key of ['loginLimitRequests', 'roomCopyRequests']) {
      replaceIdentityFields(state.admin[key], previousUsername, nextUsername);
    }
    for (const key of ['accountAuditLogs', 'serverLogs', 'verificationCodeRecords']) {
      replaceIdentityFields(state[key], previousUsername, nextUsername);
    }
    for (const session of sessions.values()) {
      if (session.username === previousUsername) session.username = nextUsername;
    }
    for (const member of users.values()) {
      if (member.username === previousUsername) member.username = nextUsername;
    }
    for (const entry of guestSessionsByIp.values()) {
      if (entry?.username === previousUsername) entry.username = nextUsername;
    }
  }

  function updateAccountLogin(username, payload, session) {
    const account = state.accounts[username];
    const now = new Date().toISOString();
    const deviceId = cleanText(payload.deviceId || crypto.randomUUID(), 80);
    const device = {
      id: deviceId, name: cleanText(payload.deviceName || '浏览器设备', 50),
      platform: cleanText(payload.platform || '未知平台', 40), browser: cleanText(payload.browser || '浏览器', 40),
      lastSeen: now, current: true
    };
    account.devices = account.devices.map((item) => ({ ...item, current: false })).filter((item) => item.id !== deviceId);
    account.devices.unshift(device);
    account.devices = account.devices.slice(0, 20);
    account.lastLogin = now;
    account.stats.joinedRooms = Math.max(1, Number(account.stats.joinedRooms) || 0);
    account.loginHistory.unshift({ time: now, ip: cleanText(session.ipAddress, 80), device: `${device.browser} · ${device.platform}` });
    account.loginHistory = account.loginHistory.slice(0, 50);
    session.deviceId = deviceId;
    rememberRecentRoom(username, session.roomId);
    persist();
  }

  function enforceRoomCapacity(username, roomIdValue = currentRoomId(), { serverHost = false } = {}) {
    const room = roomConfig(roomIdValue);
    if (isSuperAdmin(username)) return false;
    if (username && username === room.ownerUsername) return false;
    if (serverHost) return false;
    return roomUsers(room.id).length >= room.maxUsers && !roomUsers(room.id).some((user) => user.username === username);
  }

  function identityReserved(username) {
    return state.deletedUsernames.includes(username)
      || state.files.some((file) => file.uploadedBy === username)
      || chatParticipants.has(username);
  }

  function registrationsForIp(ipAddress) {
    const ip = normalizeIp(ipAddress);
    return Object.entries(state.accounts).filter(([, account]) => normalizeIp(account?.registrationIp) === ip);
  }

  function registrationIpWhitelisted(ipAddress) {
    const ip = normalizeIp(ipAddress);
    return Boolean(ip && state.admin.registrationIpWhitelist.includes(ip));
  }

  function consumeRegistrationAllowance(ipAddress) {
    const ip = normalizeIp(ipAddress);
    const count = Math.max(0, Number(state.admin.registrationAllowances[ip]) || 0);
    if (!count) return false;
    if (count <= 1) delete state.admin.registrationAllowances[ip];
    else state.admin.registrationAllowances[ip] = count - 1;
    return true;
  }

  io.on('connection', (socket) => {
    const clientIp = getSocketIp(socket);
    const defaultRoom = roomConfig(state.defaultRoomId);
    socket.emit('server-meta', {
      accessPasswordRequired: Boolean(defaultRoom.passwordHash), version: APP_VERSION, roomId: defaultRoom.id,
      roomsEnabled: true, branding: normalizeBranding(state.admin.branding), uiCopy: normalizeUiCopy(state.admin.uiCopy), loginCube: normalizeLoginCubeSettings(state.admin.loginCube),
      passwordPolicy: normalizePasswordPolicy(state.admin.passwordPolicy), usernamePolicy: normalizeUsernamePolicy(state.admin.usernamePolicy), contact: normalizeAdminContact(state.admin.contact)
    });

    function onSafe(eventName, handler, options = {}) {
      socket.on(eventName, (...incoming) => {
        let acknowledgement = null;
        if (typeof incoming[incoming.length - 1] === 'function') acknowledgement = incoming.pop();
        let acknowledged = false;
        const safeAcknowledgement = acknowledgement ? (result) => {
          if (acknowledged) return;
          acknowledged = true;
          acknowledgement(result);
        } : undefined;
        if (!acceptingMutations) {
          const result = { success: false, error: '服务器正在安全关闭，请稍后重试' };
          if (safeAcknowledgement) safeAcknowledgement(result);
          else socket.emit('operation-error', result.error);
          return;
        }
        const payload = incoming.length ? incoming[0] : {};
        if (!options.allowAnyPayload && !isPlainPayload(payload)) {
          const result = { success: false, error: '请求参数格式错误' };
          if (safeAcknowledgement) safeAcknowledgement(result);
          else socket.emit('operation-error', result.error);
          return;
        }
        try {
          const sessionForPayload = eventName === 'session-resume' ? sessions.get(String(payload?.token || '')) : null;
          const requestedLoginRoomId = ['user-login', 'guest-login'].includes(eventName) ? normalizeRoomId(payload?.roomId) : '';
          const contextRoomId = requestedLoginRoomId || users.get(socket.id)?.roomId || sessionForPayload?.roomId || normalizeRoomId(payload?.roomId) || state.defaultRoomId;
          const active = Promise.resolve().then(() => withRoom(contextRoomId, () => handler(payload, safeAcknowledgement))).catch((error) => {
            const errorId = `SW-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
            console.error(`Socket 事件 ${eventName} 处理失败 [${errorId}]:`, error.message, error.stack || '');
            const result = { success: false, error: '服务器处理请求失败', code: 'SOCKET_EVENT_FAILED', event: eventName, errorId };
            if (safeAcknowledgement) safeAcknowledgement(result);
            else socket.emit('operation-error', result);
          });
          activeSocketHandlers.add(active);
          active.finally(() => activeSocketHandlers.delete(active)).catch(() => {});
        } catch (error) {
          const errorId = `SW-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
          console.error(`Socket 事件 ${eventName} 处理失败 [${errorId}]:`, error.message, error.stack || '');
          const result = { success: false, error: '服务器处理请求失败', code: 'SOCKET_EVENT_FAILED', event: eventName, errorId };
          if (safeAcknowledgement) safeAcknowledgement(result);
          else socket.emit('operation-error', result);
        }
      });
    }

    let loginPageVisitRecorded = false;
    onSafe('login-page-visit', (payload = {}, acknowledgement) => {
      if (!loginPageVisitRecorded) {
        loginPageVisitRecorded = true;
        recordAccessAttempt({
          ipAddress: clientIp, username: cleanUsername(payload.username),
          deviceName: cleanText(payload.deviceName || '浏览器设备', 80),
          platform: cleanText(payload.platform, 40), browser: cleanText(payload.browser, 40),
          action: 'visit', result: 'viewed', message: '打开登录页面'
        });
      }
      return acknowledgement?.({ success: true, recorded: true });
    });

    onSafe('password-reset-request', async (payload = {}, acknowledgement) => {
      if (isIpBanned(clientIp)) return acknowledgement?.({ success: false, error: '此设备地址已被禁止访问' });
      return acknowledgement?.(await requestPasswordReset(socket, payload));
    });

    onSafe('password-reset-verify', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'password-reset-verify', 10, 10 * 60 * 1000, acknowledgement)) return;
      return acknowledgement?.(verifyPasswordReset(payload));
    });

    onSafe('password-reset-complete', async (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'password-reset-complete', 5, 10 * 60 * 1000, acknowledgement)) return;
      return acknowledgement?.(await completePasswordReset(payload));
    });

    onSafe('email-bind-request', async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (payload.clear === true || payload.action === 'clear' || payload.mode === 'unbind') return acknowledgement?.(await requestEmailUnbinding(user, socket, payload));
      return acknowledgement?.(await requestEmailBinding(user, socket, payload));
    });

    onSafe('email-bind-verify', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (socketRateLimited(socket, 'email-bind-verify', 10, 10 * 60 * 1000, acknowledgement)) return;
      if (payload.clear === true || payload.action === 'clear' || payload.mode === 'unbind') return acknowledgement?.(verifyEmailUnbinding(user, payload));
      return acknowledgement?.(verifyEmailBinding(user, payload));
    });

    const handleEmailUnbindRequest = async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      return acknowledgement?.(await requestEmailUnbinding(user, socket, payload));
    };
    const handleEmailUnbindVerify = (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (socketRateLimited(socket, 'email-unbind-verify', 10, 10 * 60 * 1000, acknowledgement)) return;
      return acknowledgement?.(verifyEmailUnbinding(user, payload));
    };
    onSafe('email-unbind-request', handleEmailUnbindRequest);
    onSafe('email-unbind-verify', handleEmailUnbindVerify);
    // Compatibility aliases used by older clients.
    onSafe('email-clear-request', handleEmailUnbindRequest);
    onSafe('email-clear-verify', handleEmailUnbindVerify);

    onSafe('registration-email-code-request', async (payload = {}, acknowledgement) => {
      if (isIpBanned(clientIp)) return acknowledgement?.({ success: false, error: '此设备地址已被禁止访问' });
      return acknowledgement?.(await requestRegistrationEmailCode(socket, payload));
    });

    onSafe('registration-request', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'registration-request', 5, 60 * 60 * 1000, acknowledgement)) return;
      if (isIpBanned(clientIp)) return acknowledgement?.({ success: false, error: '此设备地址已被禁止访问' });
      const username = cleanUsername(payload.username);
      const usernameError = usernamePolicyError(payload.username, state.admin.usernamePolicy);
      if (usernameError) return acknowledgement?.({ success: false, error: usernameError });
      if (!registrationsForIp(clientIp).length || registrationIpWhitelisted(clientIp)) return acknowledgement?.({ success: true, approved: true, message: '当前 IP 无需额外批准，请直接注册' });
      const pending = state.admin.registrationRequests.find((entry) => entry.ip === clientIp && entry.username === username && entry.status === 'pending');
      if (pending) {
        Object.assign(pending, normalizeRegistrationRequestCounts(pending));
        const totalRequestedCount = registrationRequestCount(payload.requestedCount ?? pending.totalRequestedCount);
        if (totalRequestedCount <= pending.withdrawnCount) {
          return acknowledgement?.({ success: false, error: `申请总数量必须大于已撤回数量 ${pending.withdrawnCount}` });
        }
        pending.requesterSocketId = socket.id;
        pending.deviceName = cleanText(payload.deviceName || pending.deviceName || '浏览器设备', 50);
        pending.reason = cleanText(payload.reason || pending.reason, 200);
        pending.totalRequestedCount = totalRequestedCount;
        pending.requestedCount = totalRequestedCount - pending.withdrawnCount;
        pending.remainingCount = pending.requestedCount;
        pending.updatedAt = new Date().toISOString();
        persist();
        return acknowledgement?.({ success: true, request: pending, message: '申请已提交，请等待服务器管理员处理' });
      }
      const requestedCount = registrationRequestCount(payload.requestedCount);
      const request = {
        id: crypto.randomUUID(), ip: clientIp, username,
        deviceName: cleanText(payload.deviceName || '浏览器设备', 50), reason: cleanText(payload.reason, 200),
        requestedCount, remainingCount: requestedCount, totalRequestedCount: requestedCount, withdrawnCount: 0,
        requesterSocketId: socket.id,
        status: 'pending', createdAt: new Date().toISOString(), resolvedAt: '', resolvedBy: '',
        popupClaimedBy: '', popupClaimedAt: ''
      };
      const firstOnlineSuperAdmin = [...users.values()]
        .filter((member) => member.username === 'admin' && member.connectionState !== 'reconnecting')
        .sort((left, right) => Date.parse(left.joinedAt || 0) - Date.parse(right.joinedAt || 0))[0];
      if (firstOnlineSuperAdmin) {
        request.popupClaimedBy = firstOnlineSuperAdmin.username;
        request.popupClaimedAt = new Date().toISOString();
      }
      state.admin.registrationRequests.push(request);
      state.admin.registrationRequests = retainPersistentRequests(state.admin.registrationRequests);
      persist();
      if (firstOnlineSuperAdmin) io.to(firstOnlineSuperAdmin.socketId).emit('registration-requested', request);
      return acknowledgement?.({ success: true, request, message: `申请已发送，管理员同意后可注册 ${request.requestedCount} 个账号` });
    });

    onSafe('registration-request-withdraw', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'registration-request-withdraw', 20, 10 * 60 * 1000, acknowledgement)) return;
      const request = state.admin.registrationRequests.find((entry) => entry.id === cleanText(payload.requestId, 80));
      const username = cleanUsername(payload.username || request?.username);
      if (!request || request.status !== 'pending' || request.ip !== clientIp || request.username !== username) {
        return acknowledgement?.({ success: false, error: '注册申请不存在、已处理或不属于当前设备' });
      }
      Object.assign(request, normalizeRegistrationRequestCounts(request));
      const available = request.remainingCount;
      const withdrawCount = Number(payload.withdrawCount);
      if (!Number.isInteger(withdrawCount) || withdrawCount < 1 || withdrawCount > available) {
        return acknowledgement?.({ success: false, error: `撤回数量必须是 1 到 ${available} 之间的整数` });
      }
      request.withdrawnCount = Math.max(0, Math.floor(Number(request.withdrawnCount) || 0)) + withdrawCount;
      request.requestedCount = available - withdrawCount;
      request.remainingCount = request.requestedCount;
      request.updatedAt = new Date().toISOString();
      if (request.requestedCount <= 0) {
        request.requestedCount = 0;
        request.status = 'withdrawn';
        request.resolvedAt = request.updatedAt;
        request.resolvedBy = username || 'requester';
      }
      persist();
      recordAccountAudit({
        category: 'register', action: 'registration-request-withdraw', result: 'success', username,
        ipAddress: clientIp, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser,
        actor: username, message: `撤回 ${withdrawCount} 个注册名额申请，剩余 ${request.requestedCount} 个`
      });
      const event = {
        requestId: request.id, username, withdrawCount, remainingCount: request.remainingCount,
        totalRequestedCount: request.totalRequestedCount, withdrawnCount: request.withdrawnCount,
        status: request.status, updatedAt: request.updatedAt
      };
      for (const member of accountOnlineMembers('admin')) io.to(member.socketId).emit('registration-request-withdrawn', event);
      return acknowledgement?.({ success: true, request, ...event, message: request.status === 'withdrawn' ? '注册申请已全部撤回' : `已撤回 ${withdrawCount} 个名额，仍申请 ${request.requestedCount} 个` });
    });

    onSafe('login-limit-clear-request', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'login-limit-clear-request', 6, 10 * 60 * 1000, acknowledgement)) return;
      const username = cleanUsername(payload.username);
      const ipAddress = getSocketIp(socket);
      const keys = loginFailureKeysForIp(ipAddress, username);
      const activelyLimited = keys.some((key) => {
        const bucket = rateBuckets.get(key);
        return bucket && bucket.expiresAt > Date.now() && bucket.count >= (key.includes('login-failure-user:') ? 15 : 60);
      });
      if (!activelyLimited) return acknowledgement?.({ success: false, code: 'LOGIN_LIMIT_NOT_ACTIVE', error: '当前登录限制已解除，请直接重新登录' });
      let request = state.admin.loginLimitRequests.find((entry) => entry.status === 'pending'
        && entry.ipAddress === ipAddress && entry.username === username);
      if (!request) {
        request = {
          id: crypto.randomUUID(), username, ipAddress,
          deviceName: cleanText(payload.deviceName || '浏览器设备', 80), reason: cleanText(payload.reason, 240),
          requesterSocketId: socket.id, status: 'pending', createdAt: new Date().toISOString(),
          resolvedAt: '', resolvedBy: ''
        };
        state.admin.loginLimitRequests.push(request);
        state.admin.loginLimitRequests = retainPersistentRequests(state.admin.loginLimitRequests).slice(-1000);
      } else {
        request.requesterSocketId = socket.id;
        request.deviceName = cleanText(payload.deviceName || request.deviceName || '浏览器设备', 80);
        request.reason = cleanText(payload.reason || request.reason, 240);
      }
      persist();
      const adminPayload = { ...request };
      for (const member of accountOnlineMembers('admin')) io.to(member.socketId).emit('login-limit-clear-requested', adminPayload);
      return acknowledgement?.({
        success: true,
        request: { id: request.id, username: request.username, status: request.status, createdAt: request.createdAt },
        message: '解除登录限制申请已提交，等待内置 admin 处理'
      });
    });

    onSafe('login-concurrency-request', async (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'login-concurrency-request', 6, 10 * 60 * 1000, acknowledgement)) return;
      const requester = users.get(socket.id);
      const requesterSession = requester && validSession(requester.sessionToken, false);
      const username = cleanUsername(requesterSession?.username || requester?.username || payload.username);
      const accountForRequest = state.accounts[username];
      if (!requesterSession) {
        if (!accountForRequest || accountForRequest.guest || !await verifyPasswordAsync(payload.password || '', accountForRequest.passwordHash)) {
          return acknowledgement?.({ success: false, error: '请先输入正确的账号和密码后再申请多设备登录' });
        }
      }
      const account = state.accounts[username];
      if (!account || account.guest) return acknowledgement?.({ success: false, error: '账号不存在或游客不能申请多设备登录' });
      const limit = accountSessionLimit(username);
      const requestedLimit = Math.max(limit + 1, Math.min(20, Math.floor(Number(payload.requestedLimit) || limit + 1)));
      let request = state.admin.loginConcurrencyRequests.find((entry) => entry.status === 'pending' && entry.username === username);
      if (!request) {
        request = { id: crypto.randomUUID(), username, requestedBy: username, requestedLimit, currentLimit: limit,
          reason: cleanText(payload.reason, 240), requesterSocketId: socket.id, status: 'pending',
          createdAt: new Date().toISOString(), resolvedAt: '', resolvedBy: '' };
        state.admin.loginConcurrencyRequests.push(request);
      } else {
        request.requestedLimit = requestedLimit; request.requesterSocketId = socket.id;
        request.reason = cleanText(payload.reason || request.reason, 240);
      }
      state.admin.loginConcurrencyRequests = retainPersistentRequests(state.admin.loginConcurrencyRequests).slice(-1000);
      persist();
      for (const member of accountOnlineMembers('admin')) io.to(member.socketId).emit('login-concurrency-requested', request);
      return acknowledgement?.({ success: true, request, message: '多设备登录申请已提交，等待内置 admin 审批' });
    });

    onSafe('client-mode-request-response', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const request = (state.admin.clientModeRequests || []).find((entry) => entry.id === cleanText(payload.requestId, 80));
      if (!request || request.username !== user.username || request.status !== 'pending') {
        return acknowledgement?.({ success: false, error: '客户端模式申请不存在、已取消或已经处理' });
      }
      const accepted = payload.accepted === true;
      request.status = accepted ? 'approved' : 'denied';
      request.resolvedAt = new Date().toISOString();
      request.resolvedBy = user.username;
      const applied = accepted ? applyClientModeRequest(state.accounts[user.username], request.mode) : {
        viewPreferences: normalizeViewPreferences(state.accounts[user.username]?.viewPreferences),
        notificationSettings: normalizeNotificationSettings(state.accounts[user.username]?.notificationSettings)
      };
      persist();
      const result = {
        requestId: request.id, username: user.username, mode: request.mode,
        status: request.status, accepted, ...applied,
        message: accepted ? `${clientModeRequestPayload(request).modeLabel}已应用到当前账号` : '已拒绝本次客户端模式切换申请'
      };
      for (const member of accountOnlineMembers(user.username)) {
        io.to(member.socketId).emit('client-mode-request-resolved', result);
        if (accepted) io.to(member.socketId).emit('account-view-preferences-updated', applied);
      }
      for (const member of accountOnlineMembers('admin')) io.to(member.socketId).emit('client-mode-request-updated', clientModeRequestPayload(request));
      return acknowledgement?.({ success: true, ...result });
    });

    onSafe('user-register', async (payload = {}, acknowledgement) => {
      const username = cleanUsername(payload.username);
      const password = String(payload.password || '');
      const finishRegistration = (result) => {
        recordAccountAudit({
          category: 'register', action: 'register', result: result?.success ? 'success' : 'failure', username,
          ipAddress: clientIp, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser,
          message: result?.success ? '账号注册成功' : (result?.error || '账号注册失败')
        });
        return acknowledgement?.(result);
      };
      if (socketRateLimited(socket, 'registration', 60, 5 * 60 * 1000, acknowledgement)) {
        recordAccountAudit({ category: 'register', action: 'register', result: 'failure', username, ipAddress: clientIp, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser, message: '注册请求过于频繁' });
        return;
      }
      if (username && socketRateLimited(socket, `registration-user:${username.toLocaleLowerCase()}`, 12, 5 * 60 * 1000, acknowledgement)) {
        recordAccountAudit({ category: 'register', action: 'register', result: 'failure', username, ipAddress: clientIp, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser, message: '该账号注册请求过于频繁' });
        return;
      }
      if (isIpBanned(clientIp)) return finishRegistration({ success: false, error: '此设备地址已被禁止访问' });
      const usernameError = usernamePolicyError(payload.username, state.admin.usernamePolicy);
      if (usernameError) return finishRegistration({ success: false, error: usernameError });
      const passwordError = passwordPolicyError(password);
      if (passwordError) return finishRegistration({ success: false, error: passwordError });
      if (state.accounts[username]) return finishRegistration({ success: false, error: '账号已存在' });
      if (identityReserved(username)) return finishRegistration({ success: false, error: '此账号名属于已删除的历史账号，不能再次注册' });
      const email = cleanText(payload.email, 120).toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return finishRegistration({ success: false, error: '邮箱格式不正确' });
      if (email && Object.values(state.accounts).some((account) => String(account.email || '').toLowerCase() === email)) return finishRegistration({ success: false, error: '邮箱已被使用' });
      const registrationMail = publicMailSettings();
      const policyRequiresEmail = registrationMail.registrationVerificationEnabled === true;
      if (policyRequiresEmail && (!registrationMail.enabled || !registrationMail.configured)) {
        return finishRegistration({
          success: false, code: 'REGISTRATION_EMAIL_SMTP_UNAVAILABLE',
          error: email
            ? '填写邮箱后必须完成验证码验证；当前 SMTP 服务不可用，请清空邮箱继续注册或联系管理员修复邮件设置'
            : '服务器要求使用邮箱验证码注册，但 SMTP 配置不可用，请管理员检查邮件设置或恢复 SyncWatch同步观影-Data/.secrets/mail.key'
        });
      }
      if (policyRequiresEmail && !email) return finishRegistration({ success: false, code: 'REGISTRATION_EMAIL_REQUIRED', error: '当前服务器要求使用邮箱验证码注册，请先填写邮箱' });
      if (email && (!registrationMail.enabled || !registrationMail.configured)) {
        return finishRegistration({
          success: false,
          code: 'REGISTRATION_EMAIL_SMTP_UNAVAILABLE',
          error: registrationMail.enabled
            ? '填写邮箱后必须完成验证码验证；当前 SMTP 配置不可用，请清空邮箱继续注册或联系管理员修复邮件设置'
            : '填写邮箱后必须完成验证码验证；服务器当前未启用 SMTP 邮件服务，请清空邮箱继续注册或联系管理员启用邮件服务'
        });
      }
      if (email && !verifyRegistrationEmailCode(email, payload.emailVerificationCode ?? payload.emailCode)) {
        return finishRegistration({ success: false, code: 'REGISTRATION_EMAIL_CODE_INVALID', error: '注册邮箱验证码无效或已过期，请重新获取' });
      }
      const requiresEmailVerification = Boolean(email);
      const existingRegistrations = registrationsForIp(clientIp);
      // A verified mailbox is an explicit identity check for this registration
      // attempt, so it can proceed without consuming the per-IP allowance.
      // Unverified registrations retain the existing administrator approval gate.
      const verifiedAllowance = Math.max(0, Number(verifiedRegistrationAllowances.get(socket.id) || 0));
      const needsRegistrationApproval = existingRegistrations.length > 0 && !registrationIpWhitelisted(clientIp) && !requiresEmailVerification && verifiedAllowance <= 0;
      const approvedOnce = needsRegistrationApproval ? consumeRegistrationAllowance(clientIp) : false;
      if (needsRegistrationApproval && !approvedOnce) return finishRegistration({
        success: false, code: 'REGISTRATION_IP_LIMIT', canRequest: true, ipAddress: clientIp,
        error: `当前 IP 地址已注册账号 ${existingRegistrations.map(([name]) => name).join('、')}。如需新增账号，请向服务器管理员申请一次注册名额。`
      });
      const claimKeys = [`username:${username}`, ...(email ? [`email:${email}`] : [])];
      if (claimKeys.some((key) => registrationClaims.has(key))) return finishRegistration({ success: false, error: '该账号或邮箱正在注册，请稍后重试' });
      for (const key of claimKeys) registrationClaims.add(key);
      try {
        const passwordHash = await makePasswordHashAsync(password);
        if (state.accounts[username]) return finishRegistration({ success: false, error: '账号已存在' });
        if (email && Object.values(state.accounts).some((account) => String(account.email || '').toLowerCase() === email)) return finishRegistration({ success: false, error: '邮箱已被使用' });
        const id = claimNextAccountId(new Set(Object.values(state.accounts).map((account) => account.id).filter(Boolean)));
        state.accounts[username] = {
          id, displayName: username, email, emailVerified: Boolean(email && requiresEmailVerification), passwordHash, avatar: '', createdAt: new Date().toISOString(), lastLogin: '',
          signature: '', gender: 'private', age: null, registrationIp: clientIp, passwordChangedAt: new Date().toISOString(),
          devices: [], watchHistory: [], favorites: [], favoriteMeta: {}, mediaNotes: {}, mediaCategories: [], loginHistory: [],
          roomMeta: {}, friends: [], friendMeta: {}, friendSettings: normalizeFriendSettings(), notificationSettings: normalizeNotificationSettings(), viewPreferences: normalizeViewPreferences(), friendRequests: [], friendBlocks: [], friendMessages: [], friendRoomRequests: [], stats: { joinedRooms: 0, createdRooms: 0, watchSeconds: 0, onlineSeconds: 0 },
          experience: 0, experienceRemainderSeconds: 0, levelOverride: null, superAdmin: false, mustChangePassword: false, roomCreationBlocked: false,
        roomQuota: 1, recentRooms: [], pinnedRooms: [], roomVisitCounts: {}, roomAccessGrants: {}, pendingNotifications: [], acceptedAgreementVersion: '', multiDeviceLogin: false, loginSessionLimit: 0, tierId: 'basic'
        };
        if (requiresEmailVerification) registrationEmailCodes.delete(email);
        if (requiresEmailVerification) verifiedRegistrationAllowances.set(socket.id, 1);
        else if (verifiedAllowance > 0) verifiedRegistrationAllowances.set(socket.id, verifiedAllowance - 1);
        persist();
        recordOperation({ roomId: state.defaultRoomId, actor: username, action: 'account-register', summary: `注册账号：${username}`, scope: 'server' });
        if (state.admin.registrationAccountNoticeEnabled !== false) {
          const registrationNotice = {
            kind: 'account-registration', actor: 'system', actorName: 'SyncWatch同步观影',
            message: `新账号已注册：${state.accounts[username].displayName || username}（${username}）`,
            username, displayName: state.accounts[username].displayName || username,
            registeredAt: state.accounts[username].createdAt
          };
          accountChangeNotice('admin', registrationNotice);
        }
        return finishRegistration({ success: true, accountId: id, emailVerified: requiresEmailVerification, message: requiresEmailVerification ? '注册成功，邮箱已验证，请登录' : '注册成功，请登录' });
      } finally {
        for (const key of claimKeys) registrationClaims.delete(key);
      }
    });

    onSafe('account-room-list', async (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'account-room-list', 20, 5 * 60 * 1000, acknowledgement)) return;
      const username = cleanUsername(payload.username);
      const account = state.accounts[username];
      if (!account || !await verifyPasswordAsync(payload.password || '', account.passwordHash)) return acknowledgement?.({ success: false, error: '账号或密码错误' });
      return acknowledgement?.({
        success: true, username, displayName: account.displayName || username,
        roomQuota: account.roomQuota, ownedRoomCount: ownedRooms(username).length,
        rooms: roomListForAccount(username)
      });
    });

    onSafe('account-room-remove', async (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'account-room-remove', 10, 5 * 60 * 1000, acknowledgement)) return;
      const username = cleanUsername(payload.username);
      const account = state.accounts[username];
      if (!account || !await verifyPasswordAsync(payload.password || '', account.passwordHash)) {
        return acknowledgement?.({ success: false, error: '账号或密码错误' });
      }
      const result = await removeRoomsForAccount(username, payload.roomIds, payload.confirmOwnedDeletion === true);
      if (result.success) recordOperation({ roomId: state.defaultRoomId, actor: username, action: 'account-room-remove', summary: result.message, scope: 'account' });
      return acknowledgement?.({
        ...result, username, displayName: account.displayName || username,
        roomQuota: account.roomQuota, ownedRoomCount: ownedRooms(username).length
      });
    });

    onSafe('host-admin-login', async (payload = {}, acknowledgement) => {
      const finishHostLogin = (result) => {
        recordAccountAudit({
          category: 'login', action: 'host-admin-login', result: result?.success ? 'success' : 'failure', username: 'admin',
          ipAddress: clientIp, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser,
          message: result?.success ? '服务器主机登录成功' : (result?.error || '服务器主机登录失败')
        });
        return acknowledgement?.(result);
      };
      if (socketRateLimited(socket, 'host-admin-login', 20, 5 * 60 * 1000, acknowledgement)) {
        recordAccountAudit({ category: 'login', action: 'host-admin-login', result: 'failure', username: 'admin', ipAddress: clientIp, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser, message: '登录请求过于频繁' });
        return;
      }
      const directHostRequest = directLoopbackHostRequest(socket.handshake?.address, socket.handshake?.headers);
      const validHostToken = isHostToken(payload.hostToken);
      const directHostLogin = directHostRequest && (!hostControlToken || validHostToken);
      const serverHostLogin = Boolean(validHostToken || directHostLogin);
      if (!serverHostLogin) return finishHostLogin({ success: false, error: '此入口只允许在服务器设备上使用' });
      // Passwordless access has two dedicated events below. Never let a
      // client-controlled flag select the privilege/session mode here.
      if (payload.passwordless === true) return finishHostLogin({ success: false, code: 'DEDICATED_PASSWORDLESS_EVENT_REQUIRED', error: '请使用本机免密管理或本机免密入房专用入口' });
      if (!await verifyAdminAsync(payload.adminPassword || payload.password || '')) return finishHostLogin({ success: false, error: '服务器管理员密码错误' });
      const username = 'admin';
      const rawRoomId = cleanText(payload.roomId, 32).toUpperCase();
      const requestedRoomId = normalizeRoomId(rawRoomId);
      if (rawRoomId && !requestedRoomId) return finishHostLogin({ success: false, error: '房间号格式不正确' });
      const room = requestedRoomId ? state.rooms[requestedRoomId] : createTemporaryRoom(username);
      if (!room) return finishHostLogin({ success: false, error: '房间号不存在' });
      const currentUser = users.get(socket.id);
      const capacityError = adminSessionCapacityError(username, currentUser?.sessionToken || '');
      if (capacityError) {
        if (room.temporary) void deleteTemporaryRoomIfEmpty(room.id);
        return finishHostLogin(capacityError);
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const session = newSessionDetails({ token, username, roomId: room.id, socketId: socket.id, isServerHost: true, sessionMode: 'management', passwordAuthenticated: true, ipAddress: clientIp });
      if (currentUser?.sessionToken) sessions.delete(currentUser.sessionToken);
      sessions.set(token, session);
      updateAccountLogin(username, payload, session);
      const user = attachUser(socket, session, payload);
      return finishHostLogin(authResult(session, user));
    });

    async function localPasswordlessHostLogin(mode, payload = {}, acknowledgement) {
      const action = mode === 'management' ? 'host-passwordless-management-login' : 'host-passwordless-room-login';
      const finish = (result) => {
        recordAccountAudit({
          category: 'login', action, result: result?.success ? 'success' : 'failure', username: 'admin',
          ipAddress: clientIp, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser,
          message: result?.success ? (mode === 'management' ? '本机免密进入管理中心' : '本机免密进入房间') : (result?.error || '本机免密登录失败')
        });
        return acknowledgement?.(result);
      };
      if (socketRateLimited(socket, action, 20, 5 * 60 * 1000, acknowledgement)) return;
      const headers = socket.handshake?.headers || {};
      const directRequest = directLoopbackHostRequest(socket.handshake?.address, headers);
      const validHostToken = isHostToken(payload.hostToken);
      if (!directRequest || !hostControlToken || !validHostToken) {
        return finish({ success: false, code: 'LOCAL_PASSWORDLESS_FORBIDDEN', error: '本机免密入口只允许服务器设备通过回环地址直接访问' });
      }
      const enabled = mode === 'management'
        ? state.admin.localPasswordlessManagementEnabled !== false
        : state.admin.localPasswordlessRoomEnabled !== false;
      if (!enabled) return finish({ success: false, code: 'LOCAL_PASSWORDLESS_DISABLED', error: mode === 'management' ? '服务器已关闭本机免密管理入口' : '服务器已关闭本机免密进入房间入口' });

      const username = 'admin';
      const rawRoomId = cleanText(payload.roomId, 32).toUpperCase();
      const requestedRoomId = normalizeRoomId(rawRoomId);
      if (rawRoomId && !requestedRoomId) return finish({ success: false, error: '房间号格式不正确' });
      if (mode === 'room' && !requestedRoomId) return finish({ success: false, code: 'ROOM_REQUIRED', error: '请选择要进入的房间' });
      const room = mode === 'management' ? createTemporaryRoom(username) : state.rooms[requestedRoomId];
      if (!room || (mode === 'room' && !discoverableRoom(room))) return finish({ success: false, error: '房间号不存在或已存档' });
      if (room.banned) return finish({ success: false, error: room.banReason ? `房间已被服务器封禁：${room.banReason}` : '房间已被服务器封禁' });
      const currentUser = users.get(socket.id);
      const capacityError = adminSessionCapacityError(username, currentUser?.sessionToken || '');
      if (capacityError) {
        if (room.temporary) void deleteTemporaryRoomIfEmpty(room.id);
        return finish(capacityError);
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const session = newSessionDetails({
        token, username, roomId: room.id, socketId: socket.id, isServerHost: true,
        sessionMode: mode, localPasswordless: true, passwordAuthenticated: false, ipAddress: clientIp
      });
      if (currentUser?.sessionToken) sessions.delete(currentUser.sessionToken);
      sessions.set(token, session);
      updateAccountLogin(username, payload, session);
      const user = attachUser(socket, session, payload);
      return finish(authResult(session, user));
    }

    onSafe('host-passwordless-management-login', (payload = {}, acknowledgement) => {
      return localPasswordlessHostLogin('management', payload, acknowledgement);
    });

    onSafe('host-passwordless-room-login', (payload = {}, acknowledgement) => {
      return localPasswordlessHostLogin('room', payload, acknowledgement);
    });

    onSafe('guest-login', async (payload = {}, acknowledgement) => {
      const finishGuestLogin = (result) => {
        recordAccountAudit({
          category: 'login', action: 'guest-login', result: result?.success ? 'success' : 'failure', username: result?.user?.username || '',
          ipAddress: clientIp, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser,
          message: result?.success ? '游客登录成功' : (result?.error || '游客登录失败')
        });
        return acknowledgement?.(result);
      };
      if (socketRateLimited(socket, 'guest-login', 30, 5 * 60 * 1000, acknowledgement)) return;
      if (isIpBanned(clientIp)) return finishGuestLogin({ success: false, error: '此设备地址已被禁止访问' });
      const existingGuest = guestSessionsByIp.get(clientIp);
      if (existingGuest) {
        const existingSession = sessions.get(existingGuest.token);
        if (existingSession && state.accounts[existingSession.username]?.guest) {
          const guestLimit = loginPolicy().guestSessionsPerIp;
          if (!guestIpWhitelisted(clientIp) && guestSessionsForIp(clientIp).length >= guestLimit) {
            const occupiedMessage = normalizeUiCopy(state.admin.uiCopy)['login.guestIpOccupied'];
            return finishGuestLogin({ success: false, code: guestLimit === 1 ? 'GUEST_IP_OCCUPIED' : 'GUEST_IP_LIMIT', canRequest: true, error: guestLimit === 1 ? occupiedMessage : `当前 IP 已有 ${guestLimit} 个游客在线，已达到服务器限制` });
          }
        }
        guestSessionsByIp.delete(clientIp);
      }
      const guestLimit = loginPolicy().guestSessionsPerIp;
      if (!guestIpWhitelisted(clientIp) && guestSessionsForIp(clientIp).length >= guestLimit) {
        return finishGuestLogin({ success: false, code: 'GUEST_IP_LIMIT', canRequest: true,
          error: `当前 IP 已有 ${guestLimit} 个游客在线，已达到服务器限制` });
      }
      const rawRoomId = cleanText(payload.roomId, 32).toUpperCase();
      const requestedRoomId = normalizeRoomId(rawRoomId);
      if (rawRoomId && !requestedRoomId) return finishGuestLogin({ success: false, error: '房间号格式不正确' });
      const username = generateGuestUsername();
      const accountId = claimNextAccountId(new Set(Object.values(state.accounts).map((account) => account.id).filter(Boolean)));
      const createdAt = new Date().toISOString();
      state.accounts[username] = {
        id: accountId, displayName: username, email: '', emailVerified: false,
        passwordHash: makePasswordHash(`${crypto.randomUUID()}${Date.now()}${username}`), avatar: '', signature: '',
        gender: 'private', age: null, registrationIp: clientIp, createdAt, lastLogin: '', passwordChangedAt: createdAt,
        devices: [], watchHistory: [], favorites: [], favoriteMeta: {}, mediaNotes: {}, mediaCategories: [], loginHistory: [],
        roomMeta: {}, friends: [], friendMeta: {}, friendSettings: normalizeFriendSettings(), notificationSettings: normalizeNotificationSettings(), viewPreferences: normalizeViewPreferences(),
        friendRequests: [], friendBlocks: [], friendMessages: [], friendRoomRequests: [], stats: { joinedRooms: 0, createdRooms: 0, watchSeconds: 0, onlineSeconds: 0 },
        experience: 0, experienceRemainderSeconds: 0, levelOverride: null, superAdmin: false, mustChangePassword: false,
        roomCreationBlocked: false, roomQuota: 1, recentRooms: [], pinnedRooms: [], roomVisitCounts: {}, roomAccessGrants: {}, pendingNotifications: [],
        acceptedAgreementVersion: '', multiDeviceLogin: false, loginSessionLimit: 0, tierId: 'basic', guest: true
      };
      let room = requestedRoomId ? state.rooms[requestedRoomId] : createGuestTemporaryRoom(username);
      let roomFallback = null;
      // Only an actually missing room falls back to a fresh temporary room.
      // Invalid IDs, passwords, bans, capacity limits and guest policies keep
      // their original errors and must never be silently bypassed.
      if (requestedRoomId && !room) {
        room = createGuestTemporaryRoom(username);
        roomFallback = { requestedRoomId, temporaryRoomId: room.id };
      }
      const failGuestLogin = (result) => {
        delete state.accounts[username];
        if (room.temporary) void deleteTemporaryRoomIfEmpty(room.id);
        return finishGuestLogin(result);
      };
      if (guestsDisallowed(username, room)) return failGuestLogin({ success: false, code: 'GUESTS_DISABLED', error: '房主已禁止游客进入该房间' });
      if (room.banned) return failGuestLogin({ success: false, error: room.banReason ? `房间已被服务器封禁：${room.banReason}` : '房间已被服务器封禁' });
      if (room.passwordHash && !canBypassRoomPassword(username, room) && !accountHasRoomAccess(username, room)) {
        if (!String(payload.roomPassword ?? payload.accessPassword ?? '')) {
          return failGuestLogin({ success: false, code: 'ROOM_PASSWORD_REQUIRED', error: '请输入房间密码' });
        }
        if (!await verifyPasswordAsync(payload.roomPassword ?? payload.accessPassword ?? '', room.passwordHash)) {
          return failGuestLogin({ success: false, code: 'ROOM_PASSWORD_REQUIRED', error: '房间密码错误' });
        }
        rememberRoomAccess(username, room);
      }
      if (!restoreArchivedRoomForOwner(room, username)) return failGuestLogin({ success: false, error: '房间号不存在或已由房主存档' });
      if (enforceRoomCapacity(username, room.id)) return failGuestLogin({ success: false, error: '房间人数已满' });
      const token = crypto.randomBytes(32).toString('base64url');
      const session = newSessionDetails({ token, username, roomId: room.id, socketId: socket.id, ipAddress: clientIp });
      sessions.set(token, session);
      guestSessionRecords.set(token, { username, ipAddress: clientIp });
      guestSessionsByIp.set(clientIp, { token, username });
      updateAccountLogin(username, payload, session);
      const user = attachUser(socket, session, payload);
      recordAccessAttempt({ ipAddress: clientIp, username, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser, action: 'guest-login', result: 'success', message: '游客登录成功' });
      return finishGuestLogin({ ...authResult(session, user), roomFallback, fallbackTemporary: Boolean(roomFallback) });
    });

    onSafe('guest-convert-account', async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (socketRateLimited(socket, `guest-convert-account:${socket.id}`, 8, 30 * 60 * 1000, acknowledgement)) return;
      const currentSession = validSession(user.sessionToken, false);
      const previousUsername = user.username;
      const account = state.accounts[previousUsername];
      if (!currentSession || !account?.guest) return acknowledgement?.({ success: false, code: 'NOT_GUEST_ACCOUNT', error: '当前账号不是可转换的游客账号' });

      const username = cleanUsername(payload.username);
      const password = String(payload.password || '');
      const email = cleanText(payload.email, 120).toLowerCase();
      const usernameError = usernamePolicyError(payload.username, state.admin.usernamePolicy);
      if (usernameError) return acknowledgement?.({ success: false, error: usernameError });
      const passwordError = passwordPolicyError(password);
      if (passwordError) return acknowledgement?.({ success: false, error: passwordError });
      if (state.accounts[username] || identityReserved(username)) return acknowledgement?.({ success: false, error: state.accounts[username] ? '账号已存在' : '此账号名属于已删除的历史账号，不能再次注册' });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return acknowledgement?.({ success: false, error: '邮箱格式不正确' });
      if (email && Object.values(state.accounts).some((entry) => entry !== account && String(entry?.email || '').toLowerCase() === email)) {
        return acknowledgement?.({ success: false, error: '邮箱已被使用' });
      }
      if (email && !verifyRegistrationEmailCode(email, payload.emailCode ?? payload.emailVerificationCode)) {
        return acknowledgement?.({ success: false, code: 'REGISTRATION_EMAIL_CODE_INVALID', error: '填写邮箱后必须输入有效的邮箱验证码' });
      }

      const claimKeys = [`username:${username}`, ...(email ? [`email:${email}`] : [])];
      if (claimKeys.some((key) => registrationClaims.has(key))) return acknowledgement?.({ success: false, error: '该账号或邮箱正在注册，请稍后重试' });
      for (const key of claimKeys) registrationClaims.add(key);
      try {
        const passwordHash = await makePasswordHashAsync(password);
        if (state.accounts[previousUsername] !== account || !account.guest || users.get(socket.id) !== user
          || sessions.get(user.sessionToken) !== currentSession) return acknowledgement?.({ success: false, error: '游客会话已失效，请重新进入' });
        if (state.accounts[username]) return acknowledgement?.({ success: false, error: '账号已存在' });
        if (email && Object.values(state.accounts).some((entry) => entry !== account && String(entry?.email || '').toLowerCase() === email)) {
          return acknowledgement?.({ success: false, error: '邮箱已被使用' });
        }

        await renameStoredChatIdentity(previousUsername, username, username);
        migrateGuestIdentity(previousUsername, username, account);
        delete state.accounts[previousUsername];
        state.accounts[username] = account;
        account.displayName = username;
        account.email = email;
        account.emailVerified = Boolean(email);
        account.passwordHash = passwordHash;
        account.passwordChangedAt = new Date().toISOString();
        account.guest = false;
        account.roomCreationBlocked = false;
        account.roomQuota = Math.max(1, Number(account.roomQuota) || 1);
        account.tierId = state.admin.accountTiers?.[account.tierId] ? account.tierId : 'basic';
        account.mustChangePassword = false;

        let convertedRooms = 0;
        for (const room of Object.values(state.rooms)) {
          if (!room.temporary || (room.ownerUsername !== username && room.createdBy !== username)) continue;
          room.ownerUsername = username;
          room.temporary = false;
          room.systemRoom = false;
          room.closed = false;
          room.closedAt = '';
          room.lastActivityAt = new Date().toISOString();
          room.allowGuests = room.allowGuests !== false;
          convertedRooms += 1;
          rememberRecentRoom(username, room.id);
        }
        if (convertedRooms) account.stats.createdRooms = Math.max(convertedRooms, Number(account.stats?.createdRooms) || 0);

        for (const [token, session] of sessions) if (session.username === previousUsername) sessions.delete(token);
        const token = crypto.randomBytes(32).toString('base64url');
        const replacement = newSessionDetails({
          token, username, roomId: currentSession.roomId || user.roomId, socketId: socket.id,
          isServerHost: Boolean(currentSession.isServerHost), ipAddress: clientIp,
          deviceId: currentSession.deviceId || user.deviceId || ''
        });
        sessions.set(token, replacement);
        user.username = username;
        user.sessionToken = token;
        for (const [ip, entry] of guestSessionsByIp) if (entry?.username === previousUsername) guestSessionsByIp.delete(ip);
        if (email) registrationEmailCodes.delete(email);
        persist();
        recordAccountAudit({
          category: 'register', action: 'guest-convert-account', result: 'success', username,
          ipAddress: clientIp, deviceName: user.deviceName, platform: user.platform, browser: user.browser,
          message: '游客账号已原地转换为正式账号'
        });
        recordOperation({ roomId: user.roomId, actor: username, action: 'guest-convert-account', summary: `游客账号转换为正式账号：${username}`, scope: 'account' });
        for (const id of Object.keys(state.rooms)) io.to(roomChannel(id)).emit('users-list', usersList(id));
        emitRoomDirectoryChanged(user.roomId, 'guest-account-converted');
        const auth = authResult(replacement, user);
        return acknowledgement?.({ ...auth, profile: accountProfile(username), convertedRooms, message: '已转换为正式成员，当前房间和账号资料均已保留' });
      } finally {
        for (const key of claimKeys) registrationClaims.delete(key);
      }
    });

    onSafe('user-login', async (payload = {}, acknowledgement) => {
      const loginIdentifier = String(payload.username ?? payload.email ?? payload.identifier ?? '').normalize('NFC').trim();
      let username = cleanUsername(loginIdentifier);
      let account = state.accounts[username];
      // A verified account email is an alternate login identifier. Never
      // accept an unverified address so a typo cannot silently select an
      // account, and keep the canonical username for all subsequent checks.
      if (!account && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginIdentifier)) {
        const emailIdentifier = loginIdentifier.toLowerCase();
        const match = Object.entries(state.accounts).find(([, value]) => value?.emailVerified === true
          && String(value?.email || '').toLowerCase() === emailIdentifier);
        if (match) {
          username = match[0];
          account = match[1];
        }
      }
      const rawRoomId = cleanText(payload.roomId, 32).toUpperCase();
      const requestedRoomId = normalizeRoomId(rawRoomId);
      const finishLogin = (result) => {
        recordAccountAudit({
          category: 'login', action: 'password-login', result: result?.success ? 'success' : 'failure', username,
          ipAddress: clientIp, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser,
          message: result?.success ? '账号登录成功' : (result?.error || '账号登录失败')
        });
        return acknowledgement?.(result);
      };
      if (loginFailureLimited(socket, username, acknowledgement)) {
        recordAccountAudit({ category: 'login', action: 'password-login', result: 'failure', username, ipAddress: clientIp, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser, message: '登录失败次数过多' });
        return;
      }
      if (isIpBanned(clientIp)) return finishLogin({ success: false, error: '此设备地址已被禁止访问' });
      if (!account || state.accounts[username] !== account) {
        recordLoginFailure(socket, username);
        recordAccessAttempt({ ipAddress: clientIp, username, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser, action: 'login', result: 'failure', message: '账户不存在' });
        return finishLogin({ success: false, error: '账户不存在' });
      }
      if (!await verifyPasswordAsync(payload.password || '', account.passwordHash) || state.accounts[username] !== account) {
        recordLoginFailure(socket, username);
        recordAccessAttempt({ ipAddress: clientIp, username, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser, action: 'login', result: 'failure', message: '密码错误' });
        return finishLogin({ success: false, error: state.accounts[username] === account ? '密码错误' : '账户不存在' });
      }
      clearLoginFailures(socket, username);
      if (rawRoomId && !requestedRoomId) return finishLogin({ success: false, error: '房间号格式不正确' });
      const room = requestedRoomId ? state.rooms[requestedRoomId] : createTemporaryRoom(username);
      if (!room) return finishLogin({ success: false, error: '房间号不存在' });
      if (room.banned && !account.superAdmin) return finishLogin({ success: false, error: room.banReason ? `房间已被服务器封禁：${room.banReason}` : '房间已被服务器封禁' });
      if (room.passwordHash && !canBypassRoomPassword(username, room) && !accountHasRoomAccess(username, room)) {
        if (!String(payload.roomPassword ?? payload.accessPassword ?? '')) return finishLogin({ success: false, code: 'ROOM_PASSWORD_REQUIRED', error: '请输入房间密码' });
        if (!await verifyPasswordAsync(payload.roomPassword ?? payload.accessPassword ?? '', room.passwordHash)) return finishLogin({ success: false, code: 'ROOM_PASSWORD_REQUIRED', error: '房间密码错误' });
        rememberRoomAccess(username, room);
      }
      if (!restoreArchivedRoomForOwner(room, username)) return finishLogin({ success: false, error: '房间号不存在或已由房主存档' });
      if (!String(account.passwordHash).startsWith('pbkdf2$')) {
        const upgradedPasswordHash = await makePasswordHashAsync(payload.password);
        if (state.accounts[username] !== account) return finishLogin({ success: false, error: '账户不存在' });
        account.passwordHash = upgradedPasswordHash;
      }
      const currentUserBeforeLogin = users.get(socket.id);
      const currentSessionBeforeLogin = currentUserBeforeLogin?.username === username
        ? validSession(currentUserBeforeLogin.sessionToken, false) : null;
      const loginCapacityError = concurrencyError(username, clientIp, currentSessionBeforeLogin?.token || '');
      if (loginCapacityError) {
        if (room.temporary) void deleteTemporaryRoomIfEmpty(room.id);
        recordAccessAttempt({ ipAddress: clientIp, username, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser, action: 'login', result: 'concurrency-limit', message: loginCapacityError.error });
        return finishLogin(loginCapacityError);
      }
      const currentUser = currentUserBeforeLogin || users.get(socket.id);
      const currentSession = currentSessionBeforeLogin || (currentUser?.username === username ? validSession(currentUser.sessionToken, false) : null);
      const capacityError = adminSessionCapacityError(username, currentSession?.token || '');
      if (capacityError) {
        if (room.temporary) void deleteTemporaryRoomIfEmpty(room.id);
        return finishLogin(capacityError);
      }
      const serverHostLogin = Boolean(currentSession?.isServerHost
        || isHostToken(payload.hostToken) || canBootstrapServerHost(clientIp, username, room.id));
      if (enforceRoomCapacity(username, room.id, { serverHost: serverHostLogin })) {
        if (room.temporary) void deleteTemporaryRoomIfEmpty(room.id);
        return finishLogin({ success: false, error: '房间人数已满' });
      }
      if (!accountIpWhitelisted(username, clientIp) && accountSessionLimit(username) <= 1) {
        for (const [token, oldSession] of sessions) if (oldSession.username === username) sessions.delete(token);
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const session = newSessionDetails({
        token, username, roomId: room.id, socketId: socket.id,
        isServerHost: serverHostLogin, passwordAuthenticated: true, ipAddress: clientIp
      });
      if (currentSession?.token) sessions.delete(currentSession.token);
      sessions.set(token, session);
      updateAccountLogin(username, payload, session);
      const user = attachUser(socket, session, payload);
      recordAccessAttempt({ ipAddress: clientIp, username, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser, action: 'login', result: 'success', message: '账号登录成功' });
      return finishLogin(authResult(session, user));
    });

    onSafe('room-create', async (payload = {}, acknowledgement) => {
      const existingUser = users.get(socket.id);
      const existingSession = existingUser ? validSession(existingUser.sessionToken, false) : null;
      const existingSessionToken = existingUser?.sessionToken || '';
      const username = existingSession ? existingSession.username : cleanUsername(payload.username);
      const account = state.accounts[username];
      const password = String(payload.password || '');
      const roomPassword = String(payload.roomPassword || '');
      const requestedCustomId = cleanText(payload.customRoomId, 12).toUpperCase();
      if (socketRateLimited(socket, 'room-create', 10, 10 * 60 * 1000, acknowledgement)) return;
      if (isIpBanned(clientIp)) return acknowledgement?.({ success: false, error: '此设备地址已被禁止访问' });
      if (!account) return acknowledgement?.({ success: false, error: '账户不存在' });
      if (account.guest) return acknowledgement?.({ success: false, code: 'GUEST_REGISTRATION_REQUIRED', error: '游客仅使用普通成员权限，注册后才能创建正式房间' });
      if (account.roomCreationBlocked && !account.superAdmin) return acknowledgement?.({ success: false, error: '服务器管理员已禁止此账号创建房间' });
      const quota = Math.max(1, Number(account.roomQuota) || 1);
      if (!account.superAdmin && ownedRooms(username).length >= quota) return acknowledgement?.({
        success: false, code: 'ROOM_QUOTA_REACHED', canRequestQuota: true, roomQuota: quota,
        error: `当前账号最多可创建 ${quota} 个房间。如需更多房间，请向服务器管理员申请提高额度。`
      });
      if (roomPassword.length > 72) return acknowledgement?.({ success: false, error: '房间密码不能超过 72 位' });
      if (requestedCustomId) {
        const validatedRoomId = validateCustomRoomId(requestedCustomId, state.admin.roomIdPolicy);
        if (!validatedRoomId || validatedRoomId !== String(requestedCustomId).trim().toUpperCase()) {
          const policy = normalizeRoomIdPolicy(state.admin.roomIdPolicy);
          const description = policy.enabled
            ? `${policy.minLength}-${policy.maxLength} 位，规则：${policy.mode === 'custom' ? '自定义正则' : policy.mode}`
            : '4-32 位大写字母或数字（默认不限制字符组合）';
          return acknowledgement?.({ success: false, error: `自定义房间号不符合服务器规则：${description}` });
        }
      }
      if (roomCreateClaims.has(username)) return acknowledgement?.({ success: false, error: '该账号正在创建房间，请稍后重试' });
      roomCreateClaims.add(username);
      try {
        const accountPasswordValid = existingSession || await verifyPasswordAsync(password, account.passwordHash);
        if (!accountPasswordValid) return acknowledgement?.({ success: false, error: '密码错误' });
        const passwordHash = roomPassword ? await makePasswordHashAsync(roomPassword) : '';
        const isTunnelPolicyActive = roomPassword ? false : await tunnelPasswordPolicyActive();

        // 所有耗时操作完成后再做一次同步核验，并在后续无 await 的提交段内一次性创建房间。
        if (state.accounts[username] !== account) return acknowledgement?.({ success: false, error: '账户不存在' });
        if (existingSession) {
          const currentUser = users.get(socket.id);
          if (!currentUser || currentUser.sessionToken !== existingSessionToken
            || sessions.get(existingSessionToken) !== existingSession || !validSession(existingSessionToken, false)) {
            return acknowledgement?.({ success: false, error: '登录已失效，请重新登录' });
          }
        }
        const capacityError = existingSession ? null : adminSessionCapacityError(username);
        if (capacityError) return acknowledgement?.(capacityError);
        const createCapacityError = existingSession ? null : concurrencyError(username, clientIp);
        if (createCapacityError) return acknowledgement?.(createCapacityError);
        if (!roomPassword && (isTunnelPolicyActive || tunnelPasswordPolicyLocked())) return acknowledgement?.({ success: false, error: '公网访问开启期间，新房间必须设置访问密码' });

        let id = requestedCustomId ? validateCustomRoomId(requestedCustomId, state.admin.roomIdPolicy) : '';
        if (id && state.rooms[id]) return acknowledgement?.({ success: false, error: '自定义房间号已被使用，请更换一个' });
        if (!id) do { id = roomId(); } while (state.rooms[id]);
        const room = freshRoom(id, username, {
          name: cleanText(payload.roomName || `${account.displayName || username} 的房间`, 40),
          maxUsers: payload.maxUsers, passwordHash, createdBy: username
        });
        state.rooms[id] = room;
        account.stats.createdRooms = Math.max(0, Number(account.stats.createdRooms) || 0) + 1;
        if (account.guest && existingSession && existingUser) {
          existingSession.isServerHost = Boolean(existingSession.isServerHost || isHostToken(payload.hostToken));
          const user = switchUserRoom(socket, existingUser, existingSession, room);
          rememberRecentRoom(username, id);
          persist();
          return withRoom(id, () => {
            recordOperation({ actor: username, action: 'room-create', summary: `创建房间：${room.name}（${id}）` });
            broadcastRoomNotice(id, `房间已创建：${id}（正式房间）`, { kind: 'room-created', actor: username, actorName: account.displayName || username, roomType: 'formal', important: true });
            return acknowledgement?.(authResult(existingSession, user));
          });
        }
        if (!accountIpWhitelisted(username, clientIp) && accountSessionLimit(username) <= 1) {
          for (const [token, oldSession] of sessions) if (oldSession.username === username) sessions.delete(token);
        }
        const token = crypto.randomBytes(32).toString('base64url');
        const session = newSessionDetails({
          token,
          username,
          roomId: id,
          socketId: socket.id,
          isServerHost: Boolean(existingSession?.isServerHost || isHostToken(payload.hostToken)),
          passwordAuthenticated: existingSession ? Boolean(existingSession.passwordAuthenticated) : true,
          ipAddress: clientIp
        });
        sessions.set(token, session);
        updateAccountLogin(username, payload, session);
        persist();
        return withRoom(id, () => {
          recordOperation({ actor: username, action: 'room-create', summary: `创建房间：${room.name}（${id}）` });
          broadcastRoomNotice(id, `房间已创建：${id}（正式房间）`, { kind: 'room-created', actor: username, actorName: account.displayName || username, roomType: 'formal', important: true });
          const user = attachUser(socket, session, payload);
          return acknowledgement?.(authResult(session, user));
        });
      } finally {
        roomCreateClaims.delete(username);
      }
    });

    onSafe('session-resume', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'session-resume', 60, 5 * 60 * 1000, acknowledgement)) return;
      const session = validSession(String(payload.token || ''));
      if (!session || isIpBanned(clientIp)) return acknowledgement?.({ success: false, error: '登录已失效' });
      const attachedElsewhere = [...users.values()].find((member) => member.sessionToken === session.token
        && member.socketId !== socket.id && member.connectionState === 'online'
        && io.sockets.sockets.get(member.socketId)?.connected !== false);
      if (attachedElsewhere) return acknowledgement?.({ success: false, code: 'SESSION_ALREADY_ATTACHED', error: '该登录会话正在另一台设备或另一端使用，请先退出原窗口' });
      session.roomId = normalizeRoomId(session.roomId) || state.defaultRoomId;
      if (!state.rooms[session.roomId]) return acknowledgement?.({ success: false, error: '原房间已不存在，请重新登录' });
      if (state.rooms[session.roomId].banned && !isSuperAdmin(session.username)) return acknowledgement?.({ success: false, error: '原房间已被服务器封禁，请重新选择房间' });
      if (guestsDisallowed(session.username, state.rooms[session.roomId])) return acknowledgement?.({ success: false, code: 'GUESTS_DISABLED', error: '房主已禁止游客进入该房间' });
      if (!restoreArchivedRoomForOwner(state.rooms[session.roomId], session.username)) return acknowledgement?.({ success: false, error: '原房间已由房主存档，请重新选择房间' });
      const resumeCapacityError = concurrencyError(session.username, clientIp, session.token);
      if (resumeCapacityError) return acknowledgement?.(resumeCapacityError);
      const resumedAsServerHost = Boolean(session.isServerHost || isHostToken(payload.hostToken));
      if (enforceRoomCapacity(session.username, session.roomId, { serverHost: resumedAsServerHost })) return acknowledgement?.({ success: false, error: '房间人数已满' });
      session.isServerHost = resumedAsServerHost;
      session.ipAddress = clientIp;
      updateAccountLogin(session.username, payload, session);
      const user = attachUser(socket, session, payload);
      recordAccountAudit({
        category: 'login', action: 'session-resume', result: 'success', username: session.username,
        ipAddress: clientIp, deviceName: payload.deviceName, platform: payload.platform, browser: payload.browser,
        message: '自动登录会话恢复成功'
      });
      return acknowledgement?.(authResult(session, user));
    });

    onSafe('network-ping', (payload, acknowledgement) => {
      if (socketRateLimited(socket, `network-ping:${socket.id}`, 30, 10 * 1000, acknowledgement)) return;
      acknowledgement?.({ success: true, serverTime: Date.now() });
    });
    onSafe('room-refresh', (payload, acknowledgement) => {
      if (!socketUser(socket, acknowledgement)) return;
      return acknowledgement?.({ success: true, room: roomSnapshot(), users: usersList(), queue: state.queue });
    });
    onSafe('media-processing-status', (payload, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const session = validSession(user.sessionToken, false);
      return acknowledgement?.({ success: true, status: mediaProcessingSnapshot(user, session) });
    });
    onSafe('media-processing-cancel', async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const session = validSession(user.sessionToken, false);
      const file = state.files.find((entry) => entry.id === cleanText(payload.taskId, 80) && entry.category === 'video');
      if (!session || !file) return acknowledgement?.({ success: false, error: '媒体处理任务不存在或登录已失效' });
      const canConfigure = Boolean(session.isServerHost || session.adminVerifiedAt || isSuperAdmin(user.username));
      if (!(canConfigure || file.uploadedBy === user.username || canManageMediaLibrary(user.username, file.roomId))) {
        return acknowledgement?.({ success: false, error: '您没有停止此媒体处理任务的权限' });
      }
      const compatibility = mediaCompatibilitySummary(file);
      if (!['queued', 'converting'].includes(compatibility.status)) return acknowledgement?.({ success: false, error: '该任务当前不在处理队列中' });
      if (!await cancelMediaWork(file, '用户手动停止媒体转换')) {
        resumeMediaWork(file);
        return acknowledgement?.({ success: false, error: '转换进程未能及时停止，请稍后重试' });
      }
      cancelledMediaRecords.delete(file);
      file.compatibility = {
        ...file.compatibility, fileName: compatibilityFileName(file), status: 'manual', manualReason: 'user-stopped',
        progress: 0, speedRatio: 0, etaSeconds: 0, error: '', stoppedAt: new Date().toISOString()
      };
      persist();
      emitFileToVisible('file-updated', file);
      recordOperation({ roomId: file.roomId, actor: user.username, action: 'media-processing-cancel', summary: `停止转换：${file.originalName}`, scope: 'media' });
      return acknowledgement?.({ success: true, message: '已停止转换，源视频保留不变；点击播放可重新处理', status: mediaProcessingSnapshot(user, session) });
    });
    onSafe('media-processing-dismiss', async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const session = validSession(user.sessionToken, false);
      const account = state.accounts[user.username];
      if (!account || !session) return acknowledgement?.({ success: false, error: '登录已失效' });
      const requestedIds = [...new Set((Array.isArray(payload.taskIds) ? payload.taskIds : [payload.taskId])
        .map((id) => cleanText(id, 80)).filter(Boolean))].slice(0, 500);
      if (!requestedIds.length) return acknowledgement?.({ success: false, error: '请先选择要删除的处理记录' });
      const deleteSource = payload.deleteSource === true;
      const canConfigure = Boolean(session.isServerHost || session.adminVerifiedAt || isSuperAdmin(user.username));
      const dismissibleFiles = requestedIds.map((id) => state.files.find((entry) => entry.id === id && entry.category === 'video')).filter((file) => {
        if (!file) return false;
        const allowed = deleteSource
          ? (canConfigure || file.uploadedBy === user.username || canManageMediaLibrary(user.username, file.roomId))
          : (canConfigure || file.uploadedBy === user.username || canSeeFile(user, file));
        if (!allowed) return false;
        const compatibility = mediaCompatibilitySummary(file);
        return !['queued', 'converting'].includes(compatibility.status)
          && (compatibility.ready || ['native', 'ready', 'failed', 'unavailable'].includes(compatibility.status));
      });
      if (!dismissibleFiles.length) return acknowledgement?.({ success: false, error: deleteSource ? '转换中或无删除权限的源影片不能删除' : '转换中或无权查看的记录不能删除' });

      if (!deleteSource) {
        const dismissibleIds = dismissibleFiles.map((file) => file.id);
        const existing = Array.isArray(account.mediaProcessingDismissed) ? account.mediaProcessingDismissed : [];
        account.mediaProcessingDismissed = [...new Set([...existing, ...dismissibleIds])]
          .filter((id) => state.files.some((file) => file.id === id)).slice(-2000);
        persist();
        recordOperation({ roomId: user.roomId, actor: user.username, action: 'media-processing-dismiss', summary: `清理 ${dismissibleIds.length} 条媒体处理记录`, scope: 'account' });
        emitMediaProcessingSnapshots();
        return acknowledgement?.({
          success: true, dismissed: dismissibleIds.length, sourceDeleted: 0,
          message: `已删除 ${dismissibleIds.length} 条处理记录，影片和转换文件均已保留`,
          status: mediaProcessingSnapshot(user, session)
        });
      }

      const actorName = state.accounts[user.username]?.displayName || user.username;
      const deletedIds = [];
      for (const candidate of dismissibleFiles) {
        const file = state.files.find((entry) => entry === candidate && entry.category === 'video');
        if (!file) continue;
        const allowed = canConfigure || file.uploadedBy === user.username || canManageMediaLibrary(user.username, file.roomId);
        const compatibility = mediaCompatibilitySummary(file);
        if (!allowed || ['queued', 'converting'].includes(compatibility.status)) continue;
        const room = state.rooms[file.roomId];
        if (!room) continue;
        const runtime = roomRuntime(file.roomId);
        const deletionId = crypto.randomUUID();
        const fileSnapshot = JSON.parse(JSON.stringify(file));
        const queueBefore = [...room.queue];
        const playbackBefore = runtime.roomState.playback.fileId === file.id ? playbackSnapshot(file.roomId) : null;
        if (!await cancelMediaWork(file, '源影片已从媒体处理记录中删除')) {
          resumeMediaWork(file);
          continue;
        }
        let artifacts;
        try {
          artifacts = moveFileArtifactsToTrash(file, deletionId);
          if (!artifacts.length) throw new Error('源影片文件不存在');
        } catch (_) {
          resumeMediaWork(file);
          continue;
        }
        state.files = state.files.filter((entry) => entry.id !== file.id);
        room.queue = room.queue.filter((id) => id !== file.id);
        const reassociated = reassociateSubtitles(file.roomId);
        if (runtime.roomState.playback.fileId === file.id) {
          runtime.playbackGeneration += 1;
          runtime.roomState.playback = {
            fileId: null, isPlaying: false, stalled: false, currentTime: 0,
            volume: runtime.roomState.playback.volume, muted: Boolean(runtime.roomState.playback.muted),
            playbackRate: runtime.roomState.playback.playbackRate || 1,
            updatedAt: Date.now(), changedBy: null, revision: runtime.roomState.playback.revision + 1
          };
        }
        const scope = canConfigure && file.roomId !== user.roomId ? 'server' : 'room';
        const operation = recordOperation({
          id: deletionId, roomId: file.roomId, actor: user.username, action: 'media-processing-source-delete',
          summary: `删除处理记录及源影片：${file.originalName}`, scope,
          undo: { kind: 'file-delete', file: fileSnapshot, artifacts, queueBefore, playbackBefore }
        });
        broadcastMediaMutation(file.roomId, operation, fileSnapshot, 'delete');
        io.to(roomChannel(file.roomId)).emit('file-deleted', file.id);
        for (const member of users.values()) {
          if (member.username === file.uploadedBy && member.roomId !== file.roomId) io.to(member.socketId).emit('file-deleted', file.id);
        }
        for (const changed of reassociated) emitFileToVisible('file-updated', changed);
        io.to(roomChannel(file.roomId)).emit('queue-state', room.queue);
        io.to(roomChannel(file.roomId)).emit('playback-state', playbackSnapshot(file.roomId));
        io.to(roomChannel(file.roomId)).emit('room-state', roomSnapshot(file.roomId));
        emitRoomDirectoryChanged(file.roomId, 'media-deleted');
        const message = `${actorName} 删除了影片《${file.originalName}》的处理记录和源文件，可在操作记录中撤销`;
        if (room.ownerUsername && room.ownerUsername !== user.username) {
          accountChangeNotice(room.ownerUsername, { kind: 'media-source-delete', roomId: file.roomId, actor: user.username, actorName, important: true, message });
        }
        if (file.uploadedBy && file.uploadedBy !== user.username && file.uploadedBy !== room.ownerUsername) {
          accountChangeNotice(file.uploadedBy, { kind: 'media-source-delete', roomId: file.roomId, actor: user.username, actorName, important: true, message });
        }
        broadcastRoomNotice(file.roomId, message, { kind: 'media-source-delete', actor: user.username, actorName, important: true });
        deletedIds.push(file.id);
      }
      if (!deletedIds.length) return acknowledgement?.({ success: false, error: '源影片无法安全移入可恢复区，请检查文件状态后重试' });
      for (const currentAccount of Object.values(state.accounts)) {
        if (Array.isArray(currentAccount.mediaProcessingDismissed)) {
          currentAccount.mediaProcessingDismissed = currentAccount.mediaProcessingDismissed.filter((id) => !deletedIds.includes(id));
        }
      }
      persist();
      emitMediaProcessingSnapshots();
      return acknowledgement?.({
        success: true, dismissed: deletedIds.length, sourceDeleted: deletedIds.length,
        failed: dismissibleFiles.length - deletedIds.length,
        message: `已删除 ${deletedIds.length} 条处理记录和源影片，文件已移入可恢复区`,
        status: mediaProcessingSnapshot(user, session)
      });
    });
    onSafe('room-password-verify', async (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `room-password-verify:${socket.id}`, 10, 5 * 60 * 1000, acknowledgement)) return;
      const user = users.get(socket.id);
      const session = user && validSession(user.sessionToken);
      if (!user || !session) return acknowledgement?.({ success: false, error: '登录已失效，请重新登录' });
      const room = roomConfig(user.roomId);
      if (!room.passwordHash || canBypassRoomPassword(user.username, room)) {
        session.roomAccessRevision = room.accessRevision;
        rememberRoomAccess(user.username, room);
        return acknowledgement?.({ success: true, message: '房间无需重新验证' });
      }
      if (!await verifyPasswordAsync(payload.roomPassword || '', room.passwordHash)) return acknowledgement?.({ success: false, error: '房间密码错误' });
      session.roomAccessRevision = room.accessRevision;
      rememberRoomAccess(user.username, room);
      persist();
      socket.emit('room-state', roomSnapshot(room.id));
      return acknowledgement?.({ success: true, room: roomSnapshot(room.id), message: '房间密码验证成功' });
    });
    onSafe('room-switch', async (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `room-switch:${socket.id}`, 20, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const session = validSession(user.sessionToken, false);
      const id = normalizeRoomId(payload.roomId);
      const targetRoom = id && state.rooms[id];
      if (!session || !targetRoom || (!discoverableRoom(targetRoom) && !isSuperAdmin(user.username))) return acknowledgement?.({ success: false, error: '目标房间不存在' });
      if (targetRoom.banned && !isSuperAdmin(user.username)) return acknowledgement?.({ success: false, error: targetRoom.banReason ? `目标房间已被封禁：${targetRoom.banReason}` : '目标房间已被服务器封禁' });
      if (guestsDisallowed(user.username, targetRoom)) return acknowledgement?.({ success: false, code: 'GUESTS_DISABLED', error: '房主已禁止游客进入该房间' });
      if (!restoreArchivedRoomForOwner(targetRoom, user.username)) return acknowledgement?.({ success: false, error: '目标房间已由房主存档' });
      if (targetRoom.passwordHash && !canBypassRoomPassword(user.username, targetRoom) && !accountHasRoomAccess(user.username, targetRoom)) {
        if (!await verifyPasswordAsync(payload.roomPassword || '', targetRoom.passwordHash)) return acknowledgement?.({ success: false, code: 'ROOM_PASSWORD_REQUIRED', error: '房间密码错误' });
        rememberRoomAccess(user.username, targetRoom);
      }
      if (enforceRoomCapacity(user.username, targetRoom.id, { serverHost: Boolean(session.isServerHost) })) return acknowledgement?.({ success: false, error: '目标房间人数已满' });
      switchUserRoom(socket, user, session, targetRoom);
      rememberRecentRoom(user.username, targetRoom.id);
      persist();
      recordOperation({ roomId: targetRoom.id, actor: user.username, action: 'room-switch', summary: `切换到房间：${targetRoom.name}（${targetRoom.id}）` });
      return acknowledgement?.(authResult(session, user));
    });

    onSafe('agreement-accept', (payload = {}, acknowledgement) => {
      const user = users.get(socket.id);
      const session = user && validSession(user.sessionToken);
      if (!user || !session) return acknowledgement?.({ success: false, error: '请先登录' });
      const agreement = normalizeLegalAgreement(state.admin.legalAgreement);
      if (cleanText(payload.version, 40) !== agreement.version || payload.accepted !== true) return acknowledgement?.({ success: false, error: '协议版本无效，请重新打开后阅读' });
      state.accounts[user.username].acceptedAgreementVersion = agreement.version;
      const claimedRegistrationRequests = [];
      if (isSuperAdmin(user.username)) {
        const claimedAt = new Date().toISOString();
        for (const request of state.admin.registrationRequests) {
          if (request?.status !== 'pending' || cleanUsername(request.popupClaimedBy)) continue;
          request.popupClaimedBy = user.username;
          request.popupClaimedAt = claimedAt;
          claimedRegistrationRequests.push({
            id: request.id, username: request.username,
            requestedCount: registrationRequestCount(request.requestedCount),
            remainingCount: Math.max(0, Number(request.remainingCount ?? request.requestedCount) || 0),
            totalRequestedCount: Math.max(0, Number(request.totalRequestedCount) || registrationRequestCount(request.requestedCount)),
            withdrawnCount: Math.max(0, Number(request.withdrawnCount) || 0),
            reason: cleanText(request.reason, 200), createdAt: request.createdAt
          });
        }
      }
      persist();
      recordOperation({ roomId: user.roomId, actor: user.username, action: 'agreement-accept', summary: `同意软件使用协议 ${agreement.version}`, scope: 'server' });
      setImmediate(() => emitPendingClientModeRequests(socket, user.username));
      return acknowledgement?.({ success: true, version: agreement.version, claimedRegistrationRequests, message: '协议已确认，后续登录无需重复阅读' });
    });

    onSafe('room-quota-request', async (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'room-quota-request', 8, 10 * 60 * 1000, acknowledgement)) return;
      const user = users.get(socket.id);
      const username = user?.username || cleanUsername(payload.username);
      const account = state.accounts[username];
      if (!account) return acknowledgement?.({ success: false, error: '账号不存在，请检查账号和密码' });
      if (account.guest) return acknowledgement?.({ success: false, code: 'GUEST_REGISTRATION_REQUIRED', error: '游客不能申请建房额度，请先注册为正式账号' });
      if (!user && !await verifyPasswordAsync(payload.password || '', account.passwordHash)) {
        return acknowledgement?.({ success: false, error: '账号或密码错误，无法提交建房额度申请' });
      }
      if (account.superAdmin || username === 'admin') {
        return acknowledgement?.({ success: true, unlimited: true, message: '超级管理员账号不受建房数量限制，无需申请额度' });
      }
      const currentQuota = Math.max(1, Number(account.roomQuota) || 1);
      const requestedQuota = Math.max(currentQuota + 1, Math.min(9999, Math.floor(Number(payload.requestedQuota) || currentQuota + 1)));
      const pending = state.admin.roomQuotaRequests.find((entry) => entry.username === username && entry.status === 'pending');
      if (pending) return acknowledgement?.({ success: true, request: pending, message: '建房额度申请已经提交，请等待服务器管理员处理' });
      const request = {
        id: crypto.randomUUID(), username, currentQuota, requestedQuota,
        reason: cleanText(payload.reason, 240), status: 'pending', createdAt: new Date().toISOString(), resolvedAt: '', resolvedBy: ''
      };
      state.admin.roomQuotaRequests.push(request);
      state.admin.roomQuotaRequests = retainPersistentRequests(state.admin.roomQuotaRequests);
      persist();
      for (const member of users.values()) {
        const memberSession = validSession(member.sessionToken, false);
        if (memberSession?.isServerHost || isSuperAdmin(member.username)) io.to(member.socketId).emit('room-quota-requested', request);
      }
      return acknowledgement?.({ success: true, request, message: '建房额度申请已发送' });
    });
    onSafe('upload-policy-request', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'upload-policy-request', 8, 10 * 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!permissionFor(user.username, user.roomId).upload) return acknowledgement?.({ success: false, error: '您没有上传权限，无法提交文件类型申请' });
      const category = cleanText(payload.category, 32).toLowerCase();
      if (!UPLOAD_CATEGORIES.has(category) || category === 'video') return acknowledgement?.({ success: false, error: '申请的文件类型无效' });
      if (uploadCategoryAllowed(category)) return acknowledgement?.({ success: true, alreadyAllowed: true, message: '管理员已经允许上传此类型文件' });
      const pending = state.admin.uploadPolicyRequests.find((entry) => entry.status === 'pending'
        && entry.username === user.username && entry.roomId === user.roomId && entry.category === category);
      if (pending) return acknowledgement?.({ success: true, request: pending, message: '此文件类型申请已经提交，请等待管理员处理' });
      const request = {
        id: crypto.randomUUID(), type: 'upload-category', roomId: user.roomId,
        username: user.username, displayName: state.accounts[user.username]?.displayName || user.username,
        category, fileName: normalizeOriginalName(payload.fileName), reason: cleanText(payload.reason, 240),
        status: 'pending', createdAt: new Date().toISOString(), resolvedAt: '', resolvedBy: '', resolvedByName: ''
      };
      state.admin.uploadPolicyRequests.push(request);
      state.admin.uploadPolicyRequests = retainPersistentRequests(state.admin.uploadPolicyRequests);
      persist();
      for (const member of users.values()) {
        const memberSession = validSession(member.sessionToken, false);
        if (memberSession?.isServerHost || isSuperAdmin(member.username)) io.to(member.socketId).emit('upload-policy-requested', request);
      }
      return acknowledgement?.({ success: true, request, message: '文件类型申请已发送，管理员处理前会一直保留' });
    });
    onSafe('storage-quota-request', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'storage-quota-request', 8, 10 * 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!permissionFor(user.username, user.roomId).upload) return acknowledgement?.({ success: false, error: '您没有上传权限，无法提交扩容申请' });
      const room = roomConfig(user.roomId);
      const storage = roomStoragePolicy(room.id);
      const minimum = Math.max(storage.usedBytes + 1, storage.limitBytes + 1);
      const requestedLimitBytes = Math.max(minimum, Math.min(MAX_ROOM_STORAGE_LIMIT_BYTES, Math.floor(Number(payload.requestedLimitBytes) || minimum)));
      if (requestedLimitBytes > MAX_ROOM_STORAGE_LIMIT_BYTES) return acknowledgement?.({ success: false, error: '申请容量超过服务器安全上限' });
      const pending = state.admin.storageQuotaRequests.find((entry) => entry.status === 'pending'
        && entry.username === user.username && entry.roomId === room.id);
      if (pending) return acknowledgement?.({ success: true, request: pending, message: '扩容申请已经提交，请等待管理员处理' });
      const request = {
        id: crypto.randomUUID(), type: 'room-storage', roomId: room.id, roomName: room.name,
        username: user.username, displayName: state.accounts[user.username]?.displayName || user.username,
        currentLimitBytes: storage.limitBytes, usedBytes: storage.usedBytes, requestedLimitBytes,
        reason: cleanText(payload.reason, 240), status: 'pending', createdAt: new Date().toISOString(),
        resolvedAt: '', resolvedBy: '', resolvedByName: ''
      };
      state.admin.storageQuotaRequests.push(request);
      state.admin.storageQuotaRequests = retainPersistentRequests(state.admin.storageQuotaRequests);
      persist();
      for (const member of roomUsers(room.id)) {
        const memberSession = validSession(member.sessionToken, false);
        if (isRoomAdmin(member) || memberSession?.isServerHost || isSuperAdmin(member.username)) io.to(member.socketId).emit('storage-quota-requested', request);
      }
      return acknowledgement?.({ success: true, request, message: '房间扩容申请已发送，管理员处理前会一直保留' });
    });
    onSafe('media-management-request', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, 'media-management-request', 8, 10 * 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const room = roomConfig(user.roomId);
      if (canManageMediaLibrary(user.username, room.id)) {
        return acknowledgement?.({ success: true, alreadyGranted: true, message: '您已经拥有影片库管理权限' });
      }
      const pending = state.admin.mediaManagementRequests.find((entry) => entry.status === 'pending'
        && entry.username === user.username && entry.roomId === room.id);
      if (pending) return acknowledgement?.({ success: true, request: pending, message: '影片库管理申请正在等待管理员处理' });
      const request = {
        id: crypto.randomUUID(), type: 'media-management', roomId: room.id, roomName: room.name,
        username: user.username, displayName: state.accounts[user.username]?.displayName || user.username,
        reason: cleanText(payload.reason, 240), status: 'pending', createdAt: new Date().toISOString(),
        resolvedAt: '', resolvedBy: '', resolvedByName: ''
      };
      state.admin.mediaManagementRequests.push(request);
      state.admin.mediaManagementRequests = retainPersistentRequests(state.admin.mediaManagementRequests);
      persist();
      for (const member of users.values()) {
        const memberSession = validSession(member.sessionToken, false);
        const roomAdministrator = member.roomId === room.id && isRoomAdmin(member);
        if (roomAdministrator || memberSession?.isServerHost || isSuperAdmin(member.username)) {
          io.to(member.socketId).emit('media-management-requested', request);
        }
      }
      return acknowledgement?.({ success: true, request, message: '影片库管理申请已发送' });
    });
    onSafe('network-quality', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `network-quality:${socket.id}`, 5, 10 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const quality = applyNetworkQualitySample(user, payload);
      if (!quality.ignored) broadcastUsersSoon();
      return acknowledgement?.({ success: true, ignored: quality.ignored, connectionState: user.connectionState });
    });

    onSafe('quality-change-request', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `quality-change-request:${socket.id}`, 20, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const requesterSession = validSession(user.sessionToken, false);
      const room = roomConfig(user.roomId);
      const serverAdministrator = Boolean(user.username === 'admin' || requesterSession?.isServerHost || requesterSession?.adminVerifiedAt);
      if (!serverAdministrator && user.username !== room.ownerUsername) {
        return acknowledgement?.({ success: false, error: '只有房主或服务器管理员可以申请调整成员清晰度' });
      }
      const username = cleanUsername(payload.username);
      const target = [...users.values()].find((member) => member.username === username
        && (serverAdministrator || member.roomId === user.roomId));
      if (!target) return acknowledgement?.({ success: false, error: '目标用户当前不在线或不在可管理房间中' });
      if (target.username === user.username) return acknowledgement?.({ success: false, error: '请直接在本机切换清晰度' });
      const quality = ['auto', 'smooth', 'original'].includes(payload.quality) ? payload.quality : '';
      if (!quality) return acknowledgement?.({ success: false, error: '清晰度只支持自动、流畅版或原画' });
      const request = {
        id: crypto.randomUUID(), roomId: target.roomId, username: target.username,
        requestedBy: user.username, requestedByName: state.accounts[user.username]?.displayName || user.username,
        requesterSocketId: socket.id, targetSocketId: target.socketId, quality,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), status: 'pending',
        message: `${state.accounts[user.username]?.displayName || user.username} 申请将您的播放清晰度切换为${quality === 'smooth' ? '流畅版' : quality === 'auto' ? '自动' : '原画'}`
      };
      qualityChangeRequests.set(request.id, request);
      io.to(target.socketId).emit('quality-change-requested', request);
      return acknowledgement?.({ success: true, request, message: '清晰度调整申请已发送，等待用户确认' });
    });

    onSafe('quality-change-response', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `quality-change-response:${socket.id}`, 30, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const request = qualityChangeRequests.get(cleanText(payload.requestId, 80));
      if (!request || request.status !== 'pending' || request.username !== user.username || request.targetSocketId !== socket.id) {
        return acknowledgement?.({ success: false, error: '清晰度调整申请不存在、已过期或不属于当前设备' });
      }
      if (Date.parse(request.expiresAt) <= Date.now()) {
        request.status = 'expired'; qualityChangeRequests.delete(request.id);
        return acknowledgement?.({ success: false, code: 'QUALITY_REQUEST_EXPIRED', error: '清晰度调整申请已过期' });
      }
      const accepted = payload.accepted === true;
      request.status = accepted ? 'approved' : 'denied';
      request.resolvedAt = new Date().toISOString();
      if (accepted) {
        user.playbackQuality = request.quality;
        io.to(socket.id).emit('quality-change-applied', { requestId: request.id, quality: request.quality, roomId: user.roomId });
        broadcastUsersSoon(user.roomId);
      }
      const result = {
        requestId: request.id, username: user.username, quality: request.quality, accepted,
        resolvedAt: request.resolvedAt,
        message: accepted ? `${state.accounts[user.username]?.displayName || user.username} 已同意切换清晰度` : `${state.accounts[user.username]?.displayName || user.username} 已拒绝切换清晰度`
      };
      io.to(request.requesterSocketId).emit('quality-change-resolved', result);
      qualityChangeRequests.delete(request.id);
      return acknowledgement?.({ success: true, ...result });
    });

    onSafe('ai-config-sync-request', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (socketRateLimited(socket, 'ai-config-sync-request', 4, 10 * 60 * 1000, acknowledgement)) return;
      const scope = payload.scope === 'online' ? 'online' : 'room';
      let config;
      try {
        config = JSON.parse(JSON.stringify(payload.config && typeof payload.config === 'object' ? payload.config : {}));
        if (JSON.stringify(config).length > 120000) throw new Error('AI 配置过大');
      } catch (error) { return acknowledgement?.({ success: false, error: error.message || 'AI 配置格式无效' }); }
      const fields = ['baseUrl', 'apiKey', 'imageBaseUrl', 'imageApiKey', 'videoBaseUrl', 'videoApiKey', 'protocol', 'modelsPath', 'responsesPath', 'chatPath', 'imagePath', 'videoPath', 'chatModel', 'imageModel', 'videoModel', 'imageSize', 'imageQuality', 'videoSize', 'videoSeconds', 'systemPrompt'];
      const normalized = Object.fromEntries(fields.filter((field) => Object.hasOwn(config, field)).map((field) => [field, typeof config[field] === 'string' ? cleanText(config[field], field.toLowerCase().includes('key') ? 4096 : 4096) : config[field]]));
      if (Array.isArray(config.modelCatalog)) normalized.modelCatalog = config.modelCatalog.slice(0, 200).map((item) => ({ id: cleanText(item?.id, 160), name: cleanText(item?.name, 160) })).filter((item) => item.id);
      const recipientMembers = [...users.values()].filter((member) => member.username !== user.username
        && (scope === 'online' || member.roomId === user.roomId)
        && validSession(member.sessionToken));
      if (!recipientMembers.length) return acknowledgement?.({ success: false, error: scope === 'online' ? '当前没有其他在线用户' : '当前房间没有其他在线成员' });
      const requestId = `ai-sync-${crypto.randomUUID()}`;
      const request = {
        id: requestId, fromUsername: user.username, fromSocketId: socket.id, scope,
        config: normalized, recipients: new Set(recipientMembers.map((member) => member.socketId)),
        createdAt: Date.now()
      };
      aiConfigSyncRequests.set(requestId, request);
      const preview = payload.preview && typeof payload.preview === 'object' ? {
        baseUrl: cleanText(payload.preview.baseUrl, 2048), chatModel: cleanText(payload.preview.chatModel, 160), imageModel: cleanText(payload.preview.imageModel, 160), videoModel: cleanText(payload.preview.videoModel, 160)
      } : {};
      for (const member of recipientMembers) io.to(member.socketId).emit('ai-config-sync-requested', { id: requestId, username: user.username, displayName: state.accounts[user.username]?.displayName || user.username, scope, preview });
      acknowledgement?.({ success: true, requestId, recipients: recipientMembers.length, message: `AI 配置同步请求已发送给 ${recipientMembers.length} 位在线成员` });
    });

    onSafe('ai-config-sync-response', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const request = aiConfigSyncRequests.get(String(payload.requestId || ''));
      if (!request || !request.recipients.has(socket.id) || Date.now() - request.createdAt > 10 * 60 * 1000) return acknowledgement?.({ success: false, error: 'AI 配置同步请求不存在或已过期' });
      request.recipients.delete(socket.id);
      const accepted = payload.accepted === true;
      if (accepted) io.to(socket.id).emit('ai-config-sync-delivered', { requestId: request.id, username: request.fromUsername, displayName: state.accounts[request.fromUsername]?.displayName || request.fromUsername, config: request.config });
      io.to(request.fromSocketId).emit('ai-config-sync-resolved', { requestId: request.id, username: user.username, displayName: state.accounts[user.username]?.displayName || user.username, accepted });
      if (!request.recipients.size) aiConfigSyncRequests.delete(request.id);
      acknowledgement?.({ success: true, accepted, config: accepted ? request.config : undefined, message: accepted ? '已同意接收 AI 配置' : '已拒绝 AI 配置同步' });
    });
    onSafe('member-location', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const source = payload && typeof payload === 'object' ? payload : {};
      const authorized = source.status === 'authorized';
      const latitude = authorized && source.latitude !== null && source.latitude !== '' ? Number(source.latitude) : NaN;
      const longitude = authorized && source.longitude !== null && source.longitude !== '' ? Number(source.longitude) : NaN;
      const validCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude)
        && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
        && !(Math.abs(latitude) < 0.000001 && Math.abs(longitude) < 0.000001);
      user.location = {
        status: source.status === 'denied' ? '已拒绝位置授权' : source.status === 'revoked' ? '已撤销位置授权' : source.status === 'suppressed' ? '已关闭位置授权提示' : source.status === 'unavailable' ? '当前客户端无法定位' : source.status === 'requested' ? '等待授权' : validCoordinates ? '已授权位置' : '定位失败',
        country: validCoordinates ? cleanText(source.country, 80) : '', province: validCoordinates ? cleanText(source.province, 80) : '', city: validCoordinates ? cleanText(source.city, 80) : '',
        district: validCoordinates ? cleanText(source.district, 80) : '', street: validCoordinates ? cleanText(source.street, 120) : '',
        latitude: validCoordinates ? latitude : null,
        longitude: validCoordinates ? longitude : null,
        accuracy: validCoordinates && Number.isFinite(Number(source.accuracy)) ? Math.max(0, Math.min(100000, Number(source.accuracy))) : null,
        updatedAt: new Date().toISOString()
      };
      io.to(roomChannel(user.roomId)).emit('users-list', usersList(user.roomId));
      if (source.status !== 'requested' && state.admin.locationStatusNoticesEnabled !== false) {
        const account = state.accounts[user.username];
        const status = validCoordinates ? 'authorized' : ['denied', 'revoked', 'suppressed', 'unavailable'].includes(source.status) ? source.status : 'failed';
        const event = {
          username: user.username, displayName: account?.displayName || user.username, roomId: user.roomId,
          status, statusText: user.location.status, location: publicMemberLocation(user.location, true), updatedAt: user.location.updatedAt
        };
        for (const member of users.values()) {
          if (member.username === 'admin') io.to(member.socketId).emit('member-location-status', event);
        }
        recordOperation({ roomId: user.roomId, actor: user.username, action: `location-${status}`, summary: `${account?.displayName || user.username}${user.location.status}`, scope: 'server' });
      }
      return acknowledgement?.({ success: true, location: user.location });
    });
    onSafe('member-location-revoke', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      user.location = {
        status: '已撤销位置授权', country: '', province: '', city: '', district: '', street: '',
        latitude: null, longitude: null, accuracy: null, updatedAt: new Date().toISOString()
      };
      io.to(roomChannel(user.roomId)).emit('users-list', usersList(user.roomId));
      const account = state.accounts[user.username];
      const event = {
        username: user.username, displayName: account?.displayName || user.username, roomId: user.roomId,
        status: 'revoked', statusText: user.location.status, location: publicMemberLocation(user.location, true), updatedAt: user.location.updatedAt
      };
      if (state.admin.locationStatusNoticesEnabled !== false) {
        for (const member of users.values()) {
          if (member.username === 'admin') io.to(member.socketId).emit('member-location-status', event);
        }
      }
      recordOperation({ roomId: user.roomId, actor: user.username, action: 'location-revoked', summary: `${account?.displayName || user.username} 已撤销位置授权`, scope: 'server' });
      return acknowledgement?.({ success: true, location: user.location, status: 'revoked' });
    });
    onSafe('member-location-request', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const requesterSession = validSession(user.sessionToken, false);
      const serverAdministrator = Boolean(isSuperAdmin(user.username) || requesterSession?.isServerHost || requesterSession?.adminVerifiedAt);
      if (!serverAdministrator && !isRoomAdmin(user)) return acknowledgement?.({ success: false, error: '只有房主或房间管理员可以重新发起位置授权请求' });
      if (state.admin.locationAuthorizationRequestsEnabled === false) return acknowledgement?.({ success: false, code: 'LOCATION_REQUESTS_DISABLED', error: '服务器已关闭位置授权提醒' });
      const requested = Array.isArray(payload.usernames) ? payload.usernames : [payload.username];
      const targetNames = [...new Set(requested.map((value) => cleanUsername(value)).filter(Boolean))].slice(0, 100);
      // The account console may target users in other rooms or offline users;
      // room owners remain restricted to members of their own room.
      const targetUsernames = serverAdministrator && targetNames.length
        ? targetNames.filter((username) => username !== user.username && Boolean(state.accounts[username]))
        : roomUsers(user.roomId).map((member) => member.username).filter((username) => username !== user.username
          && (!targetNames.length || targetNames.includes(username)));
      const targets = [...new Set(targetUsernames)];
      const actorName = state.accounts[user.username]?.displayName || user.username;
      const request = {
        id: crypto.randomUUID(), roomId: user.roomId, requestedBy: user.username, requestedByName: actorName,
        targetUsernames: targets, createdAt: new Date().toISOString(),
        message: `${actorName} 邀请您重新授权位置，授权后房间管理员可以查看您的大致位置`
      };
      for (const username of targets) {
        const event = { ...request, username };
        const onlineMembers = accountOnlineMembers(username);
        if (onlineMembers.length) {
          for (const target of onlineMembers) io.to(target.socketId).emit('location-authorization-requested', event);
        } else {
          accountChangeNotice(username, { kind: 'location-authorization-request', ...event });
        }
      }
      recordOperation({ roomId: user.roomId, actor: user.username, action: 'location-request', summary: `重新发起位置授权：${request.targetUsernames.length} 人`, scope: 'room' });
      return acknowledgement?.({ success: true, request, targetUsernames: request.targetUsernames, message: request.targetUsernames.length ? '位置授权请求已发送' : '当前房间没有可请求的在线成员' });
    });
    onSafe('member-profile', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `member-profile:${socket.id}`, 30, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const username = cleanUsername(payload.username || user.username);
      const account = state.accounts[username];
      const member = roomUsers(user.roomId).find((entry) => entry.username === username);
      if (!account || (!member && username !== user.username)) return acknowledgement?.({ success: false, error: '该成员不在当前房间' });
      const level = watchLevelSummary(account);
      const onlineSeconds = cumulativeOnlineSeconds(username, account);
      const requesterSession = validSession(user.sessionToken, false);
      const canEditAccount = Boolean(isSuperAdmin(user.username) || requesterSession?.isServerHost || requesterSession?.adminVerifiedAt);
      const canGrantRoomPermissions = Boolean(isSuperAdmin(user.username) || user.username === roomConfig(user.roomId).ownerUsername || isRoomAdmin(user));
      const canGrantSuperAdmin = Boolean(isSuperAdmin(user.username) || requesterSession?.isServerHost && user.username === 'admin');
      const effectivePermissions = permissionFor(username, user.roomId);
      return acknowledgement?.({
        success: true,
        profile: {
          id: account.id, username, displayName: account.displayName || username, avatar: account.avatar || '',
          signature: account.signature || '', gender: account.gender || 'private', age: account.age || null,
          createdAt: account.createdAt || '', online: Boolean(member), ...level,
          registrationDays: registrationDays(account), onlineSeconds, onlineStartedAt: member?.onlineStartedAt || null,
          stats: { ...account.stats, onlineSeconds }, tier: { id: accountTier(username).id, name: accountTier(username).name },
          isOwner: username === roomConfig(user.roomId).ownerUsername, isSuperAdmin: Boolean(account.superAdmin),
          permissions: effectivePermissions,
          permissionGroup: roomConfig(user.roomId).permissionGroups?.[effectivePermissions.groupId] || null,
          privateRemark: cleanText(state.accounts[user.username]?.userRemarks?.[username], 80),
          canSetPrivateRemark: username !== user.username,
          canGrantRoomPermissions: canGrantRoomPermissions && username !== user.username && username !== roomConfig(user.roomId).ownerUsername,
          canGrantSuperAdmin: canGrantSuperAdmin && username !== user.username,
          adminRemark: canEditAccount ? cleanText(account.adminRemark, 80) : '', canEditAccount,
          location: publicMemberLocation(member?.location)
        }
      });
    });
    onSafe('member-location-list', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `member-location-list:${socket.id}`, 30, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (user.username !== 'admin') return acknowledgement?.({ success: false, error: '位置授权详情仅内置 admin 可以查看' });
      const members = roomUsers(user.roomId).map((member) => ({
          socketId: member.socketId, username: member.username,
          displayName: state.accounts[member.username]?.displayName || member.username,
          avatar: state.accounts[member.username]?.avatar || '',
          privateRemark: cleanText(state.accounts[user.username]?.userRemarks?.[member.username], 80),
          adminRemark: cleanText(state.accounts[member.username]?.adminRemark, 80),
          location: publicMemberLocation(member.location, true)
        }));
      return acknowledgement?.({ success: true, members, count: members.length });
    });

    onSafe('add-remote-video', async (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `remote-video:${socket.id}`, 10, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!permissionFor(user.username, user.roomId).upload && !canControl(user)) return acknowledgement?.({ success: false, error: '您没有添加云端视频的权限' });
      const sourceUrl = normalizeRemoteVideoUrl(payload.url || payload.sourceUrl);
      if (!sourceUrl) return acknowledgement?.({ success: false, error: '云端视频必须使用 HTTPS 直链，且不能指向本机或内网地址' });
      const originalName = normalizeOriginalName(payload.name || sourceUrl.split('/').pop() || '云端视频.mp4');
      const uploadBan = mediaUploadBanFor(user.roomId, originalName);
      if (uploadBan) return acknowledgement?.({ success: false, code: 'MEDIA_UPLOAD_BANNED', error: '该影片已被服务器管理员禁止上传' });
      const extension = path.extname(originalName).toLowerCase();
      if (!['.mp4', '.webm', '.m3u8', '.mov', '.mkv', '.avi'].includes(extension)) return acknowledgement?.({ success: false, error: '云端视频名称需要包含常见视频扩展名（mp4、webm、m3u8 等）' });
      const id = crypto.randomUUID();
      const file = {
        id, originalName, storedName: '', sourceType: 'remote', sourceUrl,
        thumbnailUrl: normalizeRemoteVideoUrl(payload.thumbnailUrl || ''), size: Math.max(0, Number(payload.size) || 0),
        mimeType: cleanText(payload.mimeType || 'video/mp4', 80), category: 'video', uploadedAt: new Date().toISOString(),
        uploadedBy: user.username, roomId: user.roomId, relativePath: '', collection: cleanText(payload.collection || '云端视频', 80) || '云端视频',
        status: 'approved', metadata: {
          duration: Math.max(0, Number(payload.duration) || 0), width: Math.max(0, Number(payload.width) || 0),
          height: Math.max(0, Number(payload.height) || 0), videoCodec: cleanText(payload.videoCodec, 40), audioCodec: cleanText(payload.audioCodec, 40),
          source: 'COS/OSS'
        }, compatibility: { required: false, ready: true, status: 'native', progress: 100 }
      };
      state.files.push(file);
      if (!state.queue.includes(file.id)) state.queue.push(file.id);
      persist();
      emitFileToVisible('file-uploaded', file);
      io.to(roomChannel(user.roomId)).emit('queue-state', state.queue);
      const operation = recordOperation({ roomId: user.roomId, actor: user.username, action: 'file-upload', summary: `添加云端视频：${file.originalName}`, undo: { kind: 'file-upload', fileId: file.id } });
      broadcastMediaMutation(user.roomId, operation, file, 'upload');
      emitRoomDirectoryChanged(user.roomId, 'media-uploaded');
      return acknowledgement?.({ success: true, file: publicFile(file), message: '云端视频已添加；播放时由每位用户直接从 COS/OSS 拉流' });
    });

    onSafe('select-file', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `playback:${socket.id}`, 60, 10 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!canControl(user)) return acknowledgement?.({
        success: false, code: 'PLAYBACK_PERMISSION_REQUIRED', canRequestPlayback: true,
        error: state.room.controlLocked ? '房主已锁定播放控制，可以向房主申请播放' : '您没有播放控制权限，可以向房主申请播放'
      });
      const file = findFile(cleanText(payload.fileId, 80));
      if (!isSelectableFile(file) || file.roomId !== user.roomId) return acknowledgement?.({
        success: false, code: 'MEDIA_NOT_AVAILABLE_IN_ROOM', refreshFiles: true,
        error: '当前房间没有此已审核媒体，请刷新影片库后重试'
      });
      const availability = mediaFileAvailability(file);
      if (!availability.available) return acknowledgement?.(unavailableMediaResult(file));
      if (mediaMetadataNeedsAnalysis(file) && ffprobePath && fs.existsSync(ffprobePath)) {
        enqueueMediaAnalysis(file);
      }
      let compatibility = mediaCompatibilitySummary(file);
      if (compatibility.required && !compatibility.ready && ffmpegPath && fs.existsSync(ffmpegPath)) {
        enqueueMediaCompatibility(file, { priority: true, retry: true });
        compatibility = mediaCompatibilitySummary(file);
      }
      const previousFileId = roomState.playback.fileId;
      const skipSettings = normalizePlaybackSkipSettings(state.room.skipSettings);
      const initialTime = isPlayableFile(file) && skipSettings.enabled ? skipSettings.introSeconds : 0;
      roomRuntime().playbackGeneration += 1;
      roomState.playback = {
        fileId: file.id, isPlaying: isPlayableFile(file), stalled: false, currentTime: initialTime, volume: roomState.playback.volume, muted: Boolean(roomState.playback.muted), playbackRate: roomState.playback.playbackRate || 1,
        updatedAt: Date.now(), changedBy: user.username, revision: roomState.playback.revision + 1
      };
      const textReading = resetTextReadingState(file, user.username);
      if (isPlayableFile(file) && !state.queue.includes(file.id)) { state.queue.push(file.id); persist(); io.to(roomChannel()).emit('queue-state', state.queue); }
      io.to(roomChannel()).emit('playback-state', playbackSnapshot());
      io.to(roomChannel()).emit('text-reading-state', textReading);
      const previousFile = findFile(previousFileId);
      const operation = recordOperation({ actor: user.username, action: 'select-file', summary: `选择播放：${file.originalName}`, undo: previousFileId ? { kind: 'select-file', beforeFileId: previousFileId, afterFileId: file.id } : null });
      const switchNotice = {
        operationId: operation.id, actor: operation.actor, actorName: operation.actorName, operatedAt: operation.createdAt,
        previousFileId: previousFile?.id || '', previousFileName: previousFile?.originalName || '空白画面',
        nextFileId: file.id, nextFileName: file.originalName
      };
      for (const member of roomUsers(user.roomId)) {
        if (normalizeViewPreferences(state.accounts[member.username]?.viewPreferences).conciseMode) continue;
        io.to(member.socketId).emit('video-switch-notice', { ...switchNotice, canUndo: Boolean(operation.undo && canControl(member)) });
      }
      return acknowledgement?.({
        success: true, compatibility, previewCategory: STATIC_PREVIEW_CATEGORIES.has(file.category) ? file.category : '',
        directPlay: Boolean(compatibility.required && !compatibility.ready)
      });
    });

    onSafe('request-playback', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `playback-request:${socket.id}`, 3, 30 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const file = findFile(cleanText(payload.fileId, 80));
      if (!isSelectableFile(file) || file.roomId !== user.roomId) return acknowledgement?.({ success: false, error: '申请的媒体不存在或暂不可预览' });
      if (canControl(user)) return acknowledgement?.({ success: false, code: 'CONTROL_ALREADY_GRANTED', error: '您已经拥有播放权限，可以直接播放' });
      const runtime = roomRuntime(user.roomId);
      const now = Date.now();
      const suppressedUntil = Number(runtime.playbackRequestSuppressions?.get(user.username) || 0);
      if (suppressedUntil > now) return acknowledgement?.({ success: false, code: 'PLAYBACK_REQUEST_SUPPRESSED', retryAt: suppressedUntil, error: `房主暂时关闭了您的播放申请提醒，请在 ${formatLocalDateTime(suppressedUntil)} 后重试` });
      const duplicate = runtime.playbackRequests.find((entry) => entry.status === 'pending' && entry.username === user.username);
      if (duplicate) return acknowledgement?.({ success: false, code: 'PLAYBACK_REQUEST_DUPLICATE', error: '您的播放申请已发送，请等待房主处理后再申请其他影片' });
      const request = {
        id: crypto.randomUUID(), roomId: user.roomId, fileId: file.id, fileName: file.originalName,
        username: user.username, displayName: state.accounts[user.username]?.displayName || user.username,
        createdAt: now, status: 'pending'
      };
      runtime.playbackRequests.push(request);
      const managers = roomUsers(user.roomId).filter((member) => isRoomAdmin(member));
      for (const manager of managers) io.to(manager.socketId).emit('playback-requested', request);
      return acknowledgement?.({ success: true, request, message: managers.length ? '播放申请已发送，请等待房主或管理员处理' : '申请已记录，房主上线后可以处理' });
    });

    onSafe('playback-request-action', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `playback-request-action:${socket.id}`, 30, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!isRoomAdmin(user)) return acknowledgement?.({ success: false, error: '只有房主或管理员可以处理播放申请' });
      const runtime = roomRuntime(user.roomId);
      const request = runtime.playbackRequests.find((entry) => entry.id === cleanText(payload.requestId, 80) && entry.status === 'pending');
      if (!request) return acknowledgement?.({ success: false, error: '播放申请不存在或已处理' });
      const approved = payload.approved === true;
      request.status = approved ? 'approved' : 'denied';
      request.resolvedAt = Date.now();
      request.resolvedBy = user.username;
      request.resolvedByName = state.accounts[user.username]?.displayName || user.username;
      const suppressDurationMs = Math.max(0, Math.min(30 * 24 * 60 * 60 * 1000, Number(payload.suppressDurationMs) || 0));
      if (suppressDurationMs) runtime.playbackRequestSuppressions.set(request.username, Date.now() + suppressDurationMs);
      if (approved) {
        const file = findFile(request.fileId);
        if (!isSelectableFile(file) || file.roomId !== user.roomId || !mediaFileAvailability(file).available) {
          request.status = 'failed';
          return acknowledgement?.({ success: false, error: '媒体已经不可用，无法批准预览' });
        }
        roomRuntime().playbackGeneration += 1;
        roomState.playback = {
          fileId: file.id, isPlaying: isPlayableFile(file), stalled: false, currentTime: 0, volume: roomState.playback.volume, muted: Boolean(roomState.playback.muted), playbackRate: roomState.playback.playbackRate || 1,
          updatedAt: Date.now(), changedBy: user.username, revision: roomState.playback.revision + 1
        };
        const textReading = resetTextReadingState(file, user.username);
        if (isPlayableFile(file) && !state.queue.includes(file.id)) state.queue.push(file.id);
        persist();
        io.to(roomChannel()).emit('queue-state', state.queue);
        io.to(roomChannel()).emit('playback-state', playbackSnapshot());
        io.to(roomChannel()).emit('text-reading-state', textReading);
        broadcastRoomNotice(user.roomId, `${state.accounts[user.username]?.displayName || user.username} 已同意 ${request.displayName} 的播放申请，正在播放《${file.originalName}》`, { kind: 'playback-request', actor: user.username });
      }
      const applicantMessage = approved
        ? `${request.resolvedByName} 已同意您的播放申请，影片开始播放`
        : `${request.resolvedByName} 已拒绝您的播放申请`;
      accountChangeNotice(request.username, { kind: 'playback-request', roomId: user.roomId, message: applicantMessage, approved, requestId: request.id }, 'playback-request-resolved', { ...request, approved, message: applicantMessage });
      for (const member of roomUsers(user.roomId).filter((entry) => isRoomAdmin(entry) && entry.username !== request.username)) {
        const message = approved
          ? `播放申请已由 ${request.resolvedByName} 同意并开始播放`
          : `播放申请已由 ${request.resolvedByName} 拒绝`;
        io.to(member.socketId).emit('playback-request-resolved', { ...request, approved, message });
      }
      return acknowledgement?.({ success: true, request, message: approved ? '已同意并开始播放' : '已拒绝播放申请' });
    });

    onSafe('theme-sync-request', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `theme-sync-request:${socket.id}`, 6, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!isRoomAdmin(user)) return acknowledgement?.({ success: false, error: '只有房主或管理员可以发起界面风格同步' });
      const themeId = cleanText(payload.themeId, 40);
      const themeName = UI_THEME_NAMES.get(themeId);
      if (!themeName) return acknowledgement?.({ success: false, error: '界面风格不存在' });
      const runtime = roomRuntime(user.roomId);
      const now = Date.now();
      const requestedTargets = Array.isArray(payload.targetUsernames)
        ? [...new Set(payload.targetUsernames.map((value) => cleanUsername(value)).filter(Boolean))].slice(0, 200)
        : [];
      const request = {
        id: crypto.randomUUID(), roomId: user.roomId, themeId, themeName,
        requestedBy: user.username, requestedByName: state.accounts[user.username]?.displayName || user.username,
        requestedBySocketId: socket.id, createdAt: now, targetUsernames: requestedTargets, responses: {}
      };
      runtime.themeSyncRequests.push(request);
      const recipients = roomUsers(user.roomId).filter((member) => member.socketId !== socket.id
        && (!requestedTargets.length || requestedTargets.includes(member.username)));
      const recipientUsernames = [...new Set(recipients.map((member) => member.username))];
      request.targetUsernames = requestedTargets.length ? recipientUsernames : [];
      const publicRequest = { id: request.id, roomId: request.roomId, themeId, themeName, requestedBy: request.requestedBy, requestedByName: request.requestedByName, createdAt: request.createdAt, targetUsernames: request.targetUsernames };
      for (const member of recipients) io.to(member.socketId).emit('theme-sync-requested', publicRequest);
      return acknowledgement?.({ success: true, request: publicRequest, recipientCount: recipients.length, message: recipients.length ? `已向 ${recipients.length} 个在线客户端发送风格同步邀请` : '当前没有其他在线客户端' });
    });

    onSafe('theme-sync-response', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `theme-sync-response:${socket.id}`, 12, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const runtime = roomRuntime(user.roomId);
      const now = Date.now();
      const request = runtime.themeSyncRequests.find((entry) => entry.id === cleanText(payload.requestId, 80));
      if (!request) return acknowledgement?.({ success: false, error: '风格同步邀请不存在或已处理' });
      if (request.requestedBySocketId === socket.id) return acknowledgement?.({ success: false, error: '发起人无需响应自己的邀请' });
      if (request.targetUsernames?.length && !request.targetUsernames.includes(user.username)) return acknowledgement?.({ success: false, error: '这次风格同步邀请未指定给当前账号' });
      if (request.responses[socket.id]) return acknowledgement?.({ success: true, duplicate: true, accepted: request.responses[socket.id].accepted });
      const accepted = payload.accepted === true;
      const alreadyApplied = accepted && payload.alreadyApplied === true;
      const response = {
        accepted, username: user.username, displayName: state.accounts[user.username]?.displayName || user.username,
        alreadyApplied, socketId: socket.id, respondedAt: now
      };
      request.responses[socket.id] = response;
      const resultPayload = {
        requestId: request.id, themeId: request.themeId, themeName: request.themeName,
        accepted, alreadyApplied, username: response.username, displayName: response.displayName,
        message: alreadyApplied ? `${response.displayName}已经在使用“${request.themeName}”界面风格`
          : `${response.displayName}${accepted ? '已同意' : '已拒绝'}同步“${request.themeName}”界面风格`
      };
      accountChangeNotice(request.requestedBy, {
        kind: 'theme-sync', roomId: user.roomId, approved: accepted,
        actor: response.username, actorName: response.displayName,
        requestId: request.id, message: resultPayload.message
      }, 'theme-sync-responded', resultPayload);
      return acknowledgement?.({ success: true, accepted, alreadyApplied, themeId: request.themeId, themeName: request.themeName });
    });

    onSafe('text-reading-update', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `text-reading:${socket.id}`, 40, 10 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!canControl(user)) return acknowledgement?.({ success: false, error: state.room.controlLocked ? '房主已锁定阅读控制' : '请先申请控制权' });
      const fileId = cleanText(payload.fileId, 80);
      const file = findFile(fileId);
      if (!file || file.category !== 'text' || file.status !== 'approved' || file.roomId !== user.roomId || roomState.playback.fileId !== fileId) {
        return acknowledgement?.({ success: false, error: '请先打开当前房间的文本文件' });
      }
      const position = Number(payload.position);
      const page = Number(payload.page);
      const rawCharacterOffset = payload.characterOffset ?? payload.anchorOffset;
      const hasRawCharacterOffset = rawCharacterOffset !== undefined && rawCharacterOffset !== null && String(rawCharacterOffset).trim() !== '';
      const characterOffset = Number(rawCharacterOffset);
      const hasCharacterOffset = hasRawCharacterOffset && Number.isSafeInteger(characterOffset) && characterOffset >= 0 && characterOffset <= 50_000_000;
      if (!Number.isFinite(position) || position < 0 || position > 1 || !Number.isFinite(page) || page < 1 || page > 1000000
        || (hasRawCharacterOffset && !hasCharacterOffset)) {
        return acknowledgement?.({ success: false, error: '阅读位置无效' });
      }
      const runtime = roomRuntime(user.roomId);
      runtime.roomState.textReading = normalizeTextReadingState({
        fileId, position, page, characterOffset: hasCharacterOffset ? characterOffset : null,
        updatedAt: Date.now(), changedBy: user.username,
        revision: Number(runtime.roomState.textReading?.revision || 0) + 1
      });
      schedulePersist(300);
      const snapshot = runtime.roomState.textReading;
      io.to(roomChannel(user.roomId)).emit('text-reading-state', snapshot);
      return acknowledgement?.({ success: true, textReading: snapshot });
    });

    onSafe('playback-command', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `playback:${socket.id}`, 60, 10 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const action = String(payload.action || '').toLowerCase();
      if (!['play', 'pause', 'seek', 'volume', 'rate', 'speed', 'playback-rate'].includes(action)) return acknowledgement?.({ success: false, error: '无效播放操作' });
      if (action === 'seek' ? !canSeek(user) : !canControl(user)) {
        return acknowledgement?.({
          success: false,
          error: state.room.controlLocked ? '房主已锁定播放控制' : (action === 'seek' ? '没有快进或拖动进度的权限' : '请先申请控制权')
        });
      }
      const selectedFile = findFile(roomState.playback.fileId);
      if (!isPlayableFile(selectedFile) || selectedFile.roomId !== user.roomId) return acknowledgement?.({
        success: false, code: 'MEDIA_NOT_AVAILABLE_IN_ROOM', refreshFiles: true,
        error: '请先选择当前房间可播放的已审核影片'
      });
      const availability = mediaFileAvailability(selectedFile);
      if (!availability.available) return acknowledgement?.(unavailableMediaResult(selectedFile));
      if (mediaMetadataNeedsAnalysis(selectedFile) && ffprobePath && fs.existsSync(ffprobePath)) {
        enqueueMediaAnalysis(selectedFile);
        return acknowledgement?.({ success: false, code: 'MEDIA_ANALYSIS_PREPARING', error: '影片编码尚未检测完成，请稍后再试' });
      }
      const compatibility = mediaCompatibilitySummary(selectedFile);
      if (compatibility.required && !compatibility.ready && ffmpegPath && fs.existsSync(ffmpegPath)) {
        enqueueMediaCompatibility(selectedFile, { priority: true, retry: true });
      }
      const currentTime = Number(payload.currentTime);
      const volume = Number(payload.volume);
      const muted = payload.muted === true;
      const playbackRate = Number(payload.playbackRate ?? payload.rate ?? payload.speed);
      if (!['volume', 'rate', 'speed', 'playback-rate'].includes(action) && (!Number.isFinite(currentTime) || currentTime < 0 || currentTime > 30 * 24 * 3600)) return acknowledgement?.({ success: false, error: '无效播放时间' });
      if (action === 'volume' && (!Number.isFinite(volume) || volume < 0 || volume > 1)) return acknowledgement?.({ success: false, error: '无效音量' });
      if (['rate', 'speed', 'playback-rate'].includes(action) && (!Number.isFinite(playbackRate) || playbackRate < 0.5 || playbackRate > 3)) return acknowledgement?.({ success: false, error: '播放倍率需在 0.5x 到 3x 之间' });
      const current = playbackSnapshot();
      const beforeRevision = roomState.playback.revision;
      const before = { currentTime: current.currentTime, isPlaying: roomState.playback.isPlaying, stalled: roomState.playback.stalled, volume: roomState.playback.volume, muted: Boolean(roomState.playback.muted), playbackRate: roomState.playback.playbackRate || 1 };
      roomState.playback = {
        ...roomState.playback,
        isPlaying: action === 'play' ? true : action === 'pause' ? false : roomState.playback.isPlaying,
        stalled: action === 'volume' ? roomState.playback.stalled : false,
        currentTime: ['volume', 'rate', 'speed', 'playback-rate'].includes(action) ? current.currentTime : currentTime,
        volume: action === 'volume' ? volume : roomState.playback.volume,
        muted: action === 'volume' ? muted : Boolean(roomState.playback.muted),
        playbackRate: ['rate', 'speed', 'playback-rate'].includes(action) ? playbackRate : (roomState.playback.playbackRate || 1),
        updatedAt: Date.now(), changedBy: user.username, revision: roomState.playback.revision + 1
      };
      const change = {
        id: crypto.randomUUID(), action, fileId: roomState.playback.fileId, generation: roomRuntime().playbackGeneration, changedBy: user.username, before,
        after: { currentTime: roomState.playback.currentTime, isPlaying: roomState.playback.isPlaying, stalled: roomState.playback.stalled, volume: roomState.playback.volume, muted: Boolean(roomState.playback.muted), playbackRate: roomState.playback.playbackRate || 1 },
        beforeRevision, afterRevision: roomState.playback.revision, undone: false, timestamp: Date.now()
      };
      playbackChanges.push(change);
      if (playbackChanges.length > 100) playbackChanges.shift();
      recordOperation({ actor: user.username, action: `playback-${action}`, summary: `播放操作：${action}`, undo: { kind: 'playback', changeId: change.id } });
      const snapshot = playbackSnapshot();
      io.to(roomChannel()).emit('playback-command', { ...snapshot, action, sourceSocketId: socket.id, serverTime: snapshot.updatedAt });
      io.to(roomChannel()).emit('playback-change', change);
      return acknowledgement?.({ success: true, change });
    });

    onSafe('clear-playback', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `clear-playback:${socket.id}`, 20, 10 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!canControl(user)) return acknowledgement?.({ success: false, error: '没有清空画面的权限' });
      const previous = playbackSnapshot();
      roomRuntime().playbackGeneration += 1;
      roomState.playback = {
        fileId: null, isPlaying: false, stalled: false, currentTime: 0,
        volume: roomState.playback.volume, muted: Boolean(roomState.playback.muted), playbackRate: 1, updatedAt: Date.now(), changedBy: user.username,
        revision: roomState.playback.revision + 1
      };
      const textReading = resetTextReadingState(null, user.username);
      roomState.webShare = { active: false, mode: 'live', url: '', title: '', changedBy: user.username, updatedAt: Date.now(), revision: Math.max(0, Number(roomState.webShare.revision) || 0) + 1 };
      const screenShareStopped = stopScreenShare('', user.roomId);
      persist();
      recordOperation({ actor: user.username, action: 'clear-playback', summary: '清空当前播放画面', undo: { kind: 'clear-playback', before: previous } });
      io.to(roomChannel()).emit('playback-state', playbackSnapshot());
      io.to(roomChannel()).emit('text-reading-state', textReading);
      io.to(roomChannel()).emit('web-share-state', { active: false, mode: 'live', url: '', title: '', sharedBy: '', updatedAt: Date.now() });
      const actorName = state.accounts[user.username]?.displayName || user.username;
      const notice = broadcastRoomNotice(user.roomId, `${actorName} 清空了画面`, {
        kind: 'playback-cleared', actor: user.username, actorName, important: true
      });
      return acknowledgement?.({ success: true, playback: playbackSnapshot(), screenShareStopped, notice });
    });

    onSafe('undo-playback-change', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `playback:${socket.id}`, 60, 10 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!canControl(user)) return acknowledgement?.({ success: false, error: '没有播放控制权限' });
      const original = playbackChanges.find((item) => item.id === cleanText(payload.changeId, 80));
      if (!original || original.action === 'undo') return acknowledgement?.({ success: false, error: '此操作记录已失效' });
      if (original.undone) return acknowledgement?.({ success: false, error: '此操作已经撤回，不能重复撤回' });
      if (original.fileId !== roomState.playback.fileId) return acknowledgement?.({ success: false, error: '不能跨影片撤回播放操作' });
      if (original.generation !== roomRuntime().playbackGeneration) return acknowledgement?.({ success: false, error: '不能撤回上一轮影片的播放操作' });
      const latestUndoable = [...playbackChanges].reverse().find((item) => item.generation === roomRuntime().playbackGeneration && item.action !== 'undo' && !item.undone);
      if (latestUndoable !== original) return acknowledgement?.({ success: false, error: '只能撤回当前影片最近一次播放操作' });
      const beforeUndo = { currentTime: playbackSnapshot().currentTime, isPlaying: roomState.playback.isPlaying, stalled: roomState.playback.stalled, volume: roomState.playback.volume, muted: Boolean(roomState.playback.muted), playbackRate: roomState.playback.playbackRate || 1 };
      roomState.playback = { ...roomState.playback, ...original.before, updatedAt: Date.now(), changedBy: user.username, revision: roomState.playback.revision + 1 };
      original.undone = true;
      original.undoneBy = user.username;
      original.undoneAt = Date.now();
      const change = {
        id: crypto.randomUUID(), action: 'undo', fileId: roomState.playback.fileId, generation: roomRuntime().playbackGeneration, changedBy: user.username,
        before: beforeUndo, after: { ...original.before }, beforeRevision: roomState.playback.revision - 1,
        afterRevision: roomState.playback.revision, undoOf: original.id, undone: false, timestamp: Date.now()
      };
      playbackChanges.push(change);
      if (playbackChanges.length > 100) playbackChanges.shift();
      io.to(roomChannel()).emit('playback-state', playbackSnapshot());
      io.to(roomChannel()).emit('playback-change', change);
      return acknowledgement?.({ success: true, change });
    });

    onSafe('playback-progress', (payload = {}) => {
      if (socketRateLimited(socket, `playback-progress:${socket.id}`, 10, 10 * 1000)) return;
      const user = socketUser(socket);
      if (!user || user.username !== state.room.ownerUsername || cleanText(payload.fileId, 80) !== roomState.playback.fileId) return;
      const reportedRevision = Number(payload.revision);
      if (!Number.isSafeInteger(reportedRevision) || reportedRevision !== roomState.playback.revision) return;
      const reportedTime = Number(payload.currentTime);
      if (!Number.isFinite(reportedTime) || reportedTime < 0 || reportedTime > 30 * 24 * 3600) return;
      const wasPlaying = roomState.playback.isPlaying;
      const wasStalled = Boolean(roomState.playback.stalled);
      const nextPlaying = Boolean(payload.isPlaying);
      const nextStalled = nextPlaying && Boolean(payload.stalled);
      const projected = playbackSnapshot();
      // The owner reports its local media clock periodically. At an elevated
      // rate, a delayed report can be older than the server's current
      // projection and would otherwise rewind every client on the next sync.
      // Explicit seek/rate commands create a new revision and are unaffected.
      const currentTime = wasPlaying && nextPlaying && !wasStalled && !nextStalled
        ? Math.max(reportedTime, projected.currentTime - 0.25)
        : reportedTime;
      if (!wasPlaying && !nextPlaying && !wasStalled && Math.abs(roomState.playback.currentTime - currentTime) < 0.05) return;
      roomState.playback.currentTime = currentTime;
      roomState.playback.isPlaying = nextPlaying;
      roomState.playback.stalled = nextStalled;
      roomState.playback.updatedAt = Date.now();
      const stateChanged = wasPlaying !== roomState.playback.isPlaying || wasStalled !== nextStalled;
      if (stateChanged) roomState.playback.revision += 1;
      if (stateChanged) io.to(roomChannel()).emit('playback-state', playbackSnapshot());
    });

    onSafe('playback-ended', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `playback-ended:${socket.id}`, 10, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const fileId = cleanText(payload.fileId, 80);
      if (!fileId || roomState.playback.fileId !== fileId) return acknowledgement?.({ success: true, stale: true });
      if (!canControl(user)) return acknowledgement?.({ success: false, error: '没有结束当前影片的控制权限' });
      const reportedPosition = Number(payload.currentTime);
      const playbackMode = state.room.queueFileModes?.[fileId]
        ? normalizePlaybackMode(state.room.queueFileModes[fileId])
        : normalizePlaybackMode(state.room.playbackMode);
      const queueFiles = state.queue.map(findFile).filter((file) => isPlayableFile(file) && file.roomId === user.roomId);
      const queueIndex = queueFiles.findIndex((file) => file.id === fileId);
      let nextFile = null;
      if (playbackMode.mode === 'single') nextFile = findFile(fileId);
      else if (playbackMode.mode === 'list' && queueFiles.length) nextFile = queueFiles[(Math.max(0, queueIndex) + 1) % queueFiles.length];
      else if (playbackMode.mode === 'reverse' && queueFiles.length) nextFile = queueFiles[(queueIndex > 0 ? queueIndex : queueFiles.length) - 1];
      else if (playbackMode.mode === 'autoplay' && queueIndex >= 0) nextFile = queueFiles[queueIndex + 1] || null;
      else if (playbackMode.mode === 'category') {
        const current = findFile(fileId);
        const category = playbackMode.category || mediaCollectionName(current);
        const categoryFiles = state.files.filter((file) => isPlayableFile(file) && file.roomId === user.roomId && mediaCollectionName(file) === category)
          .sort((left, right) => String(left.uploadedAt || '').localeCompare(String(right.uploadedAt || '')));
        const categoryIndex = categoryFiles.findIndex((file) => file.id === fileId);
        if (categoryFiles.length) nextFile = categoryFiles[(Math.max(0, categoryIndex) + 1) % categoryFiles.length];
      }
      if (isPlayableFile(nextFile) && nextFile.roomId === user.roomId) {
        const skipSettings = normalizePlaybackSkipSettings(state.room.skipSettings);
        roomRuntime().playbackGeneration += 1;
        roomState.playback = {
          fileId: nextFile.id, isPlaying: true, stalled: false, currentTime: skipSettings.enabled ? skipSettings.introSeconds : 0, volume: roomState.playback.volume, muted: Boolean(roomState.playback.muted), playbackRate: roomState.playback.playbackRate || 1,
          updatedAt: Date.now(), changedBy: user.username, revision: roomState.playback.revision + 1
        };
      } else {
        const position = reportedPosition;
        roomState.playback = {
          ...roomState.playback, isPlaying: false, stalled: false,
          currentTime: Number.isFinite(position) && position >= 0 ? position : roomState.playback.currentTime,
          updatedAt: Date.now(), changedBy: user.username, revision: roomState.playback.revision + 1
        };
      }
      io.to(roomChannel()).emit('playback-state', playbackSnapshot());
      return acknowledgement?.({ success: true, playback: playbackSnapshot() });
    });

    onSafe('watch-progress', (payload = {}) => {
      if (socketRateLimited(socket, `watch-progress:${socket.id}`, 5, 10 * 1000)) return;
      const user = socketUser(socket);
      const file = findFile(cleanText(payload.fileId, 80));
      const position = Number(payload.currentTime);
      const duration = Number(payload.duration);
      if (!user || !file || file.roomId !== user.roomId || !Number.isFinite(position) || position < 0) return;
      const account = state.accounts[user.username];
      const previous = account.watchHistory.find((item) => item.fileId === file.id && (!item.roomId || item.roomId === user.roomId));
      const now = new Date().toISOString();
      if (previous) Object.assign(previous, { progress: position, duration: Number.isFinite(duration) ? duration : previous.duration, lastWatchTime: now });
      else account.watchHistory.push({ roomId: user.roomId, fileId: file.id, progress: position, duration: Number.isFinite(duration) ? duration : 0, lastWatchTime: now });
      account.watchHistory = account.watchHistory.slice(-200);
      const watchedSeconds = Math.max(0, Math.min(30, Number(payload.watchedSeconds) || 0));
      account.stats.watchSeconds = Math.max(0, Number(account.stats.watchSeconds) || 0) + watchedSeconds;
      const experienceSeconds = Math.max(0, Number(account.experienceRemainderSeconds) || 0) + watchedSeconds;
      const completedMinutes = Math.floor(experienceSeconds / 60);
      const gainedExperience = completedMinutes * Math.max(0, Math.floor(Number(state.admin.experiencePerMinute) || 0));
      if (gainedExperience) account.experience = Math.max(0, Math.floor(Number(account.experience) || 0)) + gainedExperience;
      account.experienceRemainderSeconds = experienceSeconds % 60;
      schedulePersist();
    });

    onSafe('verify-current-password', async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (socketRateLimited(socket, `verify-current-password:${user.username}`, 10, 5 * 60 * 1000, acknowledgement)) return;
      const session = validSession(user.sessionToken, false);
      const account = state.accounts[user.username];
      if (!session || !account) return acknowledgement?.({ success: false, error: '登录已失效，请重新登录' });
      const valid = await verifyPasswordAsync(payload.currentPassword || '', account.passwordHash);
      if (!valid || state.accounts[user.username] !== account || sessions.get(user.sessionToken) !== session) {
        return acknowledgement?.({ success: false, code: 'CURRENT_PASSWORD_INVALID', error: '当前密码错误' });
      }
      return acknowledgement?.({ success: true, verified: true, message: '当前密码验证通过' });
    });

    onSafe('account-action', async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (socketRateLimited(socket, `account:${user.username}`, 180, 60 * 1000, acknowledgement)) return;
      const account = state.accounts[user.username];
      const action = String(payload.action || 'get-profile');
      if (action === 'get-profile') return acknowledgement?.({ success: true, profile: accountProfile(user.username) });
      if (action === 'set-view-preferences') {
        const current = normalizeViewPreferences(account.viewPreferences);
        const next = normalizeViewPreferences({ ...current, ...payload });
        account.viewPreferences = next;
        account.notificationSettings = normalizeNotificationSettings({
          ...account.notificationSettings,
          conciseMode: next.conciseMode
        });
        if (next.conciseMode) account.pendingNotifications = [];
        persist();
        return acknowledgement?.({
          success: true, viewPreferences: next, profile: accountProfile(user.username),
          message: next.conciseMode ? '简洁模式已开启，仅保留进出房和进度拖动通知' : '界面偏好已保存'
        });
      }
      if (action === 'set-notification-preferences' || action === 'set-notice-preferences') {
        const current = normalizeNotificationSettings(account.notificationSettings);
        const next = normalizeNotificationSettings({ ...current, ...payload });
        const confirmationText = '关闭全部通知';
        if (next.allNotifications === false && cleanText(payload.confirmation, 40) !== confirmationText) {
          return acknowledgement?.({ success: false, code: 'NOTIFICATION_CONFIRMATION_REQUIRED', confirmationText, fillValue: confirmationText, error: `关闭全部通知会隐藏普通提醒，仅保留需要确认的申请、好友消息和安全通知。请输入“${confirmationText}”确认。` });
        }
        account.notificationSettings = next;
        account.viewPreferences = normalizeViewPreferences({ ...account.viewPreferences, conciseMode: next.conciseMode });
        persist();
        return acknowledgement?.({ success: true, notificationPreferences: next, noticePreferences: next, allNotificationsEnabled: next.allNotifications, profile: accountProfile(user.username), message: next.allNotifications ? '普通通知已恢复' : '普通通知已关闭，仅保留重要通知' });
      }
      if (action === 'delete-own-account') {
        const requiredConfirmation = `注销账号 ${user.username}`;
        const auditBase = {
          category: 'account-delete', action: 'delete-own-account', username: user.username,
          displayName: account.displayName || user.username, ipAddress: getSocketIp(socket),
          deviceName: user.deviceName, platform: user.platform, browser: user.browser, actor: user.username,
          actorName: account.displayName || user.username
        };
        if (user.username === 'admin') {
          recordAccountAudit({ ...auditBase, result: 'failure', message: '内置 admin 账号不能注销' });
          return acknowledgement?.({ success: false, requiredConfirmation, error: '内置 admin 超级管理员账号不能注销' });
        }
        if (cleanText(payload.confirmation, 80) !== requiredConfirmation) {
          recordAccountAudit({ ...auditBase, result: 'failure', message: '注销确认文字不匹配' });
          return acknowledgement?.({ success: false, requiredConfirmation, error: `请完整输入“${requiredConfirmation}”确认注销` });
        }
        if (ownedRooms(user.username).length) {
          recordAccountAudit({ ...auditBase, result: 'failure', message: '账号仍拥有正式房间' });
          return acknowledgement?.({ success: false, requiredConfirmation, error: '账号仍拥有正式房间，请先删除或转移这些房间后再注销' });
        }
        for (const room of Object.values(state.rooms)) {
          delete room.permissions[user.username];
          delete room.memberGroups[user.username];
        }
        for (const [otherUsername, otherAccount] of Object.entries(state.accounts)) {
          if (otherUsername === user.username) continue;
          otherAccount.friends = Array.isArray(otherAccount.friends) ? otherAccount.friends.filter((name) => name !== user.username) : [];
          if (otherAccount.friendMeta && typeof otherAccount.friendMeta === 'object') delete otherAccount.friendMeta[user.username];
          otherAccount.friendRequests = Array.isArray(otherAccount.friendRequests)
            ? otherAccount.friendRequests.filter((request) => request?.from !== user.username && request?.to !== user.username) : [];
          otherAccount.friendBlocks = Array.isArray(otherAccount.friendBlocks) ? otherAccount.friendBlocks.filter((name) => name !== user.username) : [];
        }
        recordAccountAudit({ ...auditBase, result: 'success', message: '用户已主动永久注销账号' });
        delete state.accounts[user.username];
        emailBindingCodes.delete(user.username);
        clearPasswordResetState(`account:${user.username}`);
        if (!state.deletedUsernames.includes(user.username)) state.deletedUsernames.push(user.username);
        recordOperation({ actor: user.username, action: 'account-self-delete', summary: `用户主动注销账号：${user.username}`, scope: 'server' });
        persist();
        acknowledgement?.({ success: true, username: user.username, message: '账号已永久注销，当前设备即将退出登录' });
        setImmediate(() => revokeUserSessions(user.username, 'auth-error', '账号已注销'));
        return;
      }
      if (action === 'set-user-remark') {
        const targetUsername = cleanUsername(payload.username);
        const target = state.accounts[targetUsername];
        if (!target || targetUsername === user.username) return acknowledgement?.({ success: false, error: target ? '无需为自己设置备注' : '账号不存在' });
        account.userRemarks = account.userRemarks && typeof account.userRemarks === 'object' && !Array.isArray(account.userRemarks) ? account.userRemarks : {};
        const remark = cleanText(payload.remark, 80);
        if (remark) account.userRemarks[targetUsername] = remark;
        else delete account.userRemarks[targetUsername];
        persist();
        return acknowledgement?.({
          success: true, username: targetUsername, remark,
          message: remark ? `已将 ${target.displayName || targetUsername} 备注为 ${remark}` : `已清除 ${target.displayName || targetUsername} 的私人备注`
        });
      }
      if (action === 'update-profile') {
        const email = cleanText(payload.email, 120).toLowerCase();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return acknowledgement?.({ success: false, error: '邮箱格式不正确' });
        const currentEmail = cleanText(account.email, 120).toLowerCase();
        if (email !== currentEmail) {
          return acknowledgement?.({
            success: false, code: 'EMAIL_VERIFICATION_REQUIRED', currentEmail, requestedEmail: email,
            bindingAvailable: emailBindingAvailable(),
            error: email ? '更换绑定邮箱前请先获取并填写验证码' : '为保护账号安全，不能在资料保存中直接清除绑定邮箱'
          });
        }
        const gender = ['male', 'female', 'other', 'private'].includes(payload.gender) ? payload.gender : 'private';
        const parsedAge = payload.age === '' || payload.age === null || payload.age === undefined ? null : Number(payload.age);
        if (parsedAge !== null && (!Number.isInteger(parsedAge) || parsedAge < 1 || parsedAge > 150)) return acknowledgement?.({ success: false, error: '年龄需为 1-150 的整数或留空' });
        const before = { email: account.email, avatar: account.avatar, signature: account.signature || '', gender: account.gender || 'private', age: account.age || null };
        const requestedAvatar = cleanText(payload.avatar, 500);
        const validAvatar = !requestedAvatar || DEFAULT_AVATAR_PATH.test(requestedAvatar)
          || /^\/avatar\/[a-f0-9-]+\.(jpg|jpeg|png|webp|gif)$/i.test(requestedAvatar)
          || /^https?:\/\/[^\s]+$/i.test(requestedAvatar);
        if (!validAvatar) return acknowledgement?.({ success: false, code: 'INVALID_AVATAR', error: '头像地址格式不正确，请选择默认头像、上传头像文件或填写 HTTP/HTTPS 图片地址' });
        account.avatar = requestedAvatar;
        account.signature = cleanText(payload.signature, 160);
        account.gender = gender;
        account.age = parsedAge;
        persist();
        if (before.avatar !== account.avatar) {
          for (const id of Object.keys(state.rooms)) io.to(roomChannel(id)).emit('users-list', usersList(id));
        }
        recordOperation({ actor: user.username, action: 'profile-update', summary: '更新个人资料', scope: 'account', undo: { kind: 'profile', username: user.username, before, after: { email: account.email, avatar: account.avatar, signature: account.signature, gender: account.gender, age: account.age } } });
        return acknowledgement?.({ success: true, profile: accountProfile(user.username), message: '资料已保存' });
      }
      if (action === 'change-display-name') {
        const displayName = cleanUsername(payload.displayName);
        if (!validUsername(displayName)) return acknowledgement?.({ success: false, error: '名字需为 2-24 位中文、字母、数字、下划线或短横线' });
        if (Object.entries(state.accounts).some(([name, entry]) => name !== user.username && String(entry.displayName || name).toLocaleLowerCase() === displayName.toLocaleLowerCase())) return acknowledgement?.({ success: false, error: '此名字已被其他账号使用' });
        const before = account.displayName || user.username;
        if (before === displayName) return acknowledgement?.({ success: true, profile: accountProfile(user.username), message: '名字没有变化' });
        account.displayName = displayName;
        try { await renameStoredChatDisplayName(user.username, displayName); }
        catch (error) { account.displayName = before; throw error; }
        persist();
        recordOperation({ actor: user.username, action: 'display-name', summary: `修改名字：${before} → ${displayName}`, scope: 'account', undo: { kind: 'display-name', username: user.username, before, after: displayName } });
        for (const id of Object.keys(state.rooms)) io.to(roomChannel(id)).emit('users-list', usersList(id));
        return acknowledgement?.({ success: true, profile: accountProfile(user.username), message: '账户名字已更新' });
      }
      if (action === 'change-login-username') {
        const currentSession = validSession(user.sessionToken, false);
        const previousUsername = user.username;
        const nextUsername = cleanUsername(payload.username);
        if (!currentSession || !account || state.accounts[previousUsername] !== account) {
          return acknowledgement?.({ success: false, error: '登录已失效，请重新登录' });
        }
        if (previousUsername === 'admin' || account.guest) {
          return acknowledgement?.({ success: false, error: previousUsername === 'admin' ? '内置 admin 登录账号不能修改' : '游客账号请先转换为正式账号后再修改登录账号' });
        }
        const usernameError = usernamePolicyError(payload.username, state.admin.usernamePolicy);
        if (usernameError) return acknowledgement?.({ success: false, error: usernameError });
        if (nextUsername === previousUsername) return acknowledgement?.({ success: true, profile: accountProfile(previousUsername), message: '登录账号没有变化' });
        if (state.accounts[nextUsername] || identityReserved(nextUsername)) {
          return acknowledgement?.({ success: false, code: 'USERNAME_TAKEN', error: state.accounts[nextUsername] ? '该登录账号已存在' : '该登录账号属于已删除的历史账号，不能再次使用' });
        }
        if (!await verifyPasswordAsync(payload.currentPassword || '', account.passwordHash)) {
          return acknowledgement?.({ success: false, code: 'CURRENT_PASSWORD_INVALID', error: '当前密码错误' });
        }
        const previousDisplayName = account.displayName;
        let chatMigrated = false;
        let identityMigrated = false;
        try {
          await renameStoredChatIdentity(previousUsername, nextUsername, account.displayName || nextUsername);
          chatMigrated = true;
          migrateAccountIdentity(previousUsername, nextUsername, account);
          identityMigrated = true;
          delete state.accounts[previousUsername];
          state.accounts[nextUsername] = account;
          if (account.displayName === previousUsername) account.displayName = nextUsername;
          persist();
        } catch (error) {
          if (identityMigrated) {
            migrateAccountIdentity(nextUsername, previousUsername, account);
            delete state.accounts[nextUsername];
            state.accounts[previousUsername] = account;
            account.displayName = previousDisplayName;
          }
          if (chatMigrated) {
            try { await renameStoredChatIdentity(nextUsername, previousUsername, previousDisplayName || previousUsername); } catch (_) {}
          }
          try { persist(); } catch (_) {}
          return acknowledgement?.({ success: false, error: `登录账号修改失败：${cleanText(error.message, 180)}` });
        }
        for (const id of Object.keys(state.rooms)) io.to(roomChannel(id)).emit('users-list', usersList(id));
        recordOperation({ actor: nextUsername, action: 'account-username-change', summary: `修改登录账号：${previousUsername} → ${nextUsername}`, scope: 'account' });
        accountChangeNotice(nextUsername, {
          kind: 'account-profile', actor: nextUsername, actorName: account.displayName || nextUsername,
          changed: ['username'], previousUsername, username: nextUsername,
          message: `登录账号已从 ${previousUsername} 修改为 ${nextUsername}`
        }, 'account-profile-updated', { kind: 'account-profile', profile: accountProfile(nextUsername), changed: ['username'], message: '登录账号已更新' });
        return acknowledgement?.({ success: true, username: nextUsername, previousUsername, profile: accountProfile(nextUsername), message: '登录账号已更新，相关房间、好友、聊天和媒体记录已同步迁移' });
      }
      if (action === 'change-password') {
        const currentSession = validSession(user.sessionToken, false);
        if (!currentSession) return acknowledgement?.({ success: false, error: '登录已失效，请重新登录' });
        const initialServerAdminSetup = Boolean(payload.initialSetup && currentSession.isServerHost && user.username === 'admin'
          && state.admin.mustChangePassword === true && account.mustChangePassword);
        // The password login that created this session already authenticated
        // the bootstrap credential.  Permit the first-login wizard to omit a
        // redundant current-password field, but never grant that bypass to
        // local passwordless sessions or later password changes.
        const skipCurrentPasswordVerification = Boolean(initialServerAdminSetup
          && currentSession.passwordAuthenticated === true
          && !String(payload.currentPassword || ''));
        if ((!skipCurrentPasswordVerification && !await verifyPasswordAsync(payload.currentPassword || '', account.passwordHash))
          || state.accounts[user.username] !== account) return acknowledgement?.({ success: false, code: 'CURRENT_PASSWORD_INVALID', error: '当前密码错误' });
        const nextPassword = String(payload.newPassword || '');
        const passwordError = passwordPolicyError(nextPassword, { administrator: user.username === 'admin' });
        if (passwordError) return acknowledgement?.({ success: false, error: passwordError });
        if (state.accounts[user.username] !== account || sessions.get(user.sessionToken) !== currentSession) {
          return acknowledgement?.({ success: false, error: '登录已失效，请重新登录' });
        }
        if (await verifyPasswordAsync(nextPassword, account.passwordHash)) {
          return acknowledgement?.({ success: false, code: 'PASSWORD_REUSE', error: '新密码不能与当前密码相同' });
        }
        const nextPasswordHash = await makePasswordHashAsync(nextPassword);
        if (state.accounts[user.username] !== account || sessions.get(user.sessionToken) !== currentSession) {
          return acknowledgement?.({ success: false, error: '登录已失效，请重新登录' });
        }
        account.passwordHash = nextPasswordHash;
        account.mustChangePassword = false;
        account.passwordChangedAt = new Date().toISOString();
        const synchronizedServerAdminPassword = user.username === 'admin';
        if (synchronizedServerAdminPassword) {
          setAdminPasswordHash(nextPasswordHash);
          state.admin.mustChangePassword = false;
          clearAdminVerification();
        }
        clearPasswordResetState(`account:${user.username}`);
        for (const [token, session] of sessions) if (session.username === user.username) sessions.delete(token);
        const token = crypto.randomBytes(32).toString('base64url');
        const replacement = newSessionDetails({
          token, username: user.username, roomId: currentSession.roomId || user.roomId, socketId: socket.id, isServerHost: Boolean(currentSession.isServerHost),
          sessionMode: currentSession.sessionMode === 'management' ? 'management' : 'room', localPasswordless: Boolean(currentSession.localPasswordless),
          passwordAuthenticated: Boolean(currentSession.passwordAuthenticated),
          ipAddress: getSocketIp(socket), deviceId: currentSession.deviceId || user.deviceId || ''
        });
        sessions.set(token, replacement);
        user.sessionToken = token;
        persist();
        recordOperation({ actor: user.username, action: 'account-password', summary: '修改登录密码', scope: 'account' });
        return acknowledgement?.({
          success: true, token, expiresAt: replacement.expiresAt,
          mustChangePassword: false,
          initialSetup: initialServerAdminSetup || synchronizedServerAdminPassword,
          message: synchronizedServerAdminPassword ? 'admin 登录密码与服务器管理员密码已同步更新' : '登录密码已修改，其他会话已退出'
        });
      }
      if (action === 'remove-device') {
        const deviceId = cleanText(payload.deviceId, 80);
        account.devices = account.devices.filter((item) => item.id !== deviceId);
        for (const [token, session] of sessions) if (session.username === user.username && session.deviceId === deviceId && session.socketId !== socket.id) {
          sessions.delete(token);
          const targetSocket = io.sockets.sockets.get(session.socketId);
          removeOnlineUser(session.socketId);
          targetSocket?.disconnect(true);
        }
        persist(); return acknowledgement?.({ success: true, profile: accountProfile(user.username), message: '设备已移除' });
      }
      if (action === 'revoke-device') {
        const deviceId = cleanText(payload.deviceId, 80);
        if (!deviceId) return acknowledgement?.({ success: false, error: '设备标识无效' });
        const current = deviceId === cleanText(validSession(user.sessionToken, false)?.deviceId, 80);
        account.devices = account.devices.filter((item) => item.id !== deviceId);
        const sessionsToExpire = [...sessions.entries()].filter(([, session]) => session.username === user.username && session.deviceId === deviceId);
        for (const [token, session] of sessionsToExpire) {
          if (session.socketId === socket.id) continue;
          sessions.delete(token);
          const targetSocket = io.sockets.sockets.get(session.socketId);
          removeOnlineUser(session.socketId);
          targetSocket?.emit('auth-error', '此设备的自动登录授权已被取消，请重新输入密码');
          targetSocket?.disconnect(true);
        }
        persist();
        return acknowledgement?.({ success: true, current, profile: accountProfile(user.username), message: current ? '当前设备已取消记住密码，下次登录需要重新输入' : '所选设备的自动登录授权已取消' });
      }
      if (action === 'revoke-devices') {
        const deviceIds = [...new Set((Array.isArray(payload.deviceIds) ? payload.deviceIds : [])
          .map((value) => cleanText(value, 80)).filter(Boolean))].slice(0, 50);
        if (!deviceIds.length) return acknowledgement?.({ success: false, error: '请选择要取消自动登录的设备' });
        const knownIds = new Set(account.devices.map((item) => cleanText(item.id, 80)));
        const revokedIds = deviceIds.filter((id) => knownIds.has(id));
        if (!revokedIds.length) return acknowledgement?.({ success: false, error: '所选设备已经不在授权列表中' });
        const revokedSet = new Set(revokedIds);
        const currentDeviceId = cleanText(validSession(user.sessionToken, false)?.deviceId, 80);
        const current = revokedSet.has(currentDeviceId);
        account.devices = account.devices.filter((item) => !revokedSet.has(cleanText(item.id, 80)));
        const sessionsToExpire = [...sessions.entries()].filter(([, session]) => session.username === user.username
          && revokedSet.has(cleanText(session.deviceId, 80)));
        for (const [token, session] of sessionsToExpire) {
          if (session.socketId === socket.id) continue;
          sessions.delete(token);
          const targetSocket = io.sockets.sockets.get(session.socketId);
          removeOnlineUser(session.socketId);
          targetSocket?.emit('auth-error', '此设备的自动登录授权已被取消，请重新输入密码');
          targetSocket?.disconnect(true);
        }
        persist();
        return acknowledgement?.({
          success: true, current, revoked: revokedIds.length, revokedIds,
          profile: accountProfile(user.username),
          message: current
            ? `已取消 ${revokedIds.length} 台设备的自动登录授权；当前设备下次登录需要重新输入密码`
            : `已取消 ${revokedIds.length} 台设备的自动登录授权`
        });
      }
      if (action === 'toggle-favorite') {
        const fileId = cleanText(payload.fileId, 80);
        if (findFile(fileId)?.roomId !== currentRoomId()) return acknowledgement?.({ success: false, error: '影片不存在' });
        account.favorites = account.favorites.includes(fileId) ? account.favorites.filter((id) => id !== fileId) : [...account.favorites, fileId];
        persist(); return acknowledgement?.({ success: true, profile: accountProfile(user.username) });
      }
      if (action === 'organize-items') {
        const kind = ['favorites', 'media', 'rooms'].includes(payload.kind) ? payload.kind : '';
        const ids = [...new Set((Array.isArray(payload.ids) ? payload.ids : []).map((value) => cleanText(value, 80)).filter(Boolean))].slice(0, 500);
        if (!kind || !ids.length) return acknowledgement?.({ success: false, error: '请选择需要管理的项目' });
        account.favoriteMeta = account.favoriteMeta && typeof account.favoriteMeta === 'object' ? account.favoriteMeta : {};
        account.mediaNotes = account.mediaNotes && typeof account.mediaNotes === 'object' ? account.mediaNotes : {};
        account.roomMeta = account.roomMeta && typeof account.roomMeta === 'object' ? account.roomMeta : {};
        const target = kind === 'favorites' ? account.favoriteMeta : kind === 'media' ? account.mediaNotes : account.roomMeta;
        for (const id of ids) {
          target[id] = { ...(target[id] || {}) };
          if (payload.note !== undefined) target[id].note = cleanText(payload.note, 500);
          if (payload.category !== undefined) target[id].category = cleanText(payload.category || '未分类', 80) || '未分类';
        }
        if (payload.remove === true && kind === 'favorites') account.favorites = account.favorites.filter((id) => !ids.includes(id));
        persist();
        return acknowledgement?.({ success: true, profile: accountProfile(user.username), message: `已更新 ${ids.length} 个项目` });
      }
      if (action === 'history-delete') {
        const ids = new Set((Array.isArray(payload.ids) ? payload.ids : []).map((value) => cleanText(value, 80)).filter(Boolean));
        if (!ids.size) return acknowledgement?.({ success: false, error: '请选择观影记录' });
        const before = account.watchHistory.length;
        account.watchHistory = account.watchHistory.filter((item) => !ids.has(cleanText(item.id || `${item.fileId}:${item.lastWatchTime}`, 160)));
        persist(); return acknowledgement?.({ success: true, profile: accountProfile(user.username), message: `已删除 ${before - account.watchHistory.length} 条观影记录` });
      }
      if (action === 'friend-search') {
        const query = cleanText(payload.query, 80).toLocaleLowerCase();
        const accounts = Object.entries(state.accounts).filter(([username, item]) => username !== user.username && !account.friendBlocks.includes(username)
          && (!query || [username, item.displayName, item.id].join(' ').toLocaleLowerCase().includes(query))).map(([username, item]) => {
            const pendingRequest = (item.friendRequests || []).find((request) => request.from === user.username
              && request.to === username && request.status === 'pending');
            return {
              username, id: item.id, displayName: item.displayName || username, avatar: item.avatar || '', online: accountIsOnline(username),
              friend: account.friends.includes(username), pending: Boolean(pendingRequest),
              pendingRequestId: pendingRequest?.id || '', pendingRequestMessage: pendingRequest?.message || '',
              pendingRequestEditedAt: pendingRequest?.editedAt || ''
            };
          }).sort((left, right) => Number(right.online) - Number(left.online)
            || String(left.displayName).localeCompare(String(right.displayName), 'zh-CN')
            || left.username.localeCompare(right.username, 'zh-CN'));
        return acknowledgement?.({ success: true, accounts });
      }
      if (action === 'friend-request') {
        const targetName = cleanUsername(payload.username); const target = state.accounts[targetName];
        if (!target || targetName === user.username) return acknowledgement?.({ success: false, error: '好友账号不存在' });
        if (!normalizeFriendSettings(target.friendSettings).allowFriendRequests) return acknowledgement?.({ success: false, code: 'FRIEND_REQUESTS_DISABLED', error: '对方已关闭好友申请' });
        if (account.friendBlocks.includes(targetName) || target.friendBlocks?.includes(user.username)) return acknowledgement?.({ success: false, error: '当前无法向该账号发送好友申请' });
        if (account.friends.includes(targetName)) return acknowledgement?.({ success: true, profile: accountProfile(user.username), message: '对方已经是您的好友' });
        const existing = (target.friendRequests || []).find((request) => request.from === user.username && request.status === 'pending');
        if (existing) return acknowledgement?.({ success: true, message: '好友申请正在等待对方处理' });
        const request = { id: crypto.randomUUID(), from: user.username, to: targetName, message: friendRequestMessage(payload.message), status: 'pending', createdAt: new Date().toISOString() };
        target.friendRequests.push(request); target.friendRequests = target.friendRequests.slice(-200);
        persist();
        for (const member of users.values()) if (member.username === targetName) io.to(member.socketId).emit('friend-request', { ...request, displayName: account.displayName || user.username, avatar: account.avatar || '' });
        return acknowledgement?.({ success: true, message: '好友申请已发送，对方离线时会在下次登录看到' });
      }
      if (action === 'friend-request-withdraw' || action === 'friend-request-edit') {
        const requestId = cleanText(payload.requestId, 80);
        const requestedTarget = cleanUsername(payload.username);
        let targetName = requestedTarget;
        let target = targetName ? state.accounts[targetName] : null;
        let request = target?.friendRequests?.find((entry) => entry.id === requestId && entry.status === 'pending' && entry.from === user.username);
        if (!request && requestId) {
          for (const [candidateName, candidate] of Object.entries(state.accounts)) {
            const candidateRequest = (candidate.friendRequests || []).find((entry) => entry.id === requestId
              && entry.status === 'pending' && entry.from === user.username);
            if (candidateRequest) {
              targetName = candidateName; target = candidate; request = candidateRequest; break;
            }
          }
        }
        if (!target || !request) return acknowledgement?.({ success: false, error: '好友申请不存在、已被处理，或不属于当前账号' });
        const actorName = state.accounts[user.username]?.displayName || user.username;
        if (action === 'friend-request-withdraw') {
          request.status = 'withdrawn';
          request.resolvedAt = new Date().toISOString();
          request.resolvedBy = user.username;
          request.withdrawnAt = request.resolvedAt;
          request.withdrawnBy = user.username;
        } else {
          const previousMessage = request.message;
          request.message = friendRequestMessage(payload.message);
          request.editedAt = new Date().toISOString();
          request.editedBy = user.username;
          request.previousMessage = previousMessage;
        }
        target.friendRequests = (target.friendRequests || []).slice(-200);
        const eventName = action === 'friend-request-withdraw' ? 'friend-request-withdrawn' : 'friend-request-updated';
        const message = action === 'friend-request-withdraw'
          ? `${actorName} 撤回了好友申请`
          : `${actorName} 更新了好友申请说明：${request.message}`;
        const resultPayload = {
          request: { ...request, displayName: actorName, avatar: state.accounts[user.username]?.avatar || '' },
          requestId: request.id, username: user.username, displayName: actorName, message,
          withdrawn: action === 'friend-request-withdraw', edited: action === 'friend-request-edit'
        };
        accountChangeNotice(targetName, {
          kind: eventName, actor: user.username, actorName, requestId: request.id,
          message, request: resultPayload.request
        }, eventName, resultPayload);
        persist();
        return acknowledgement?.({ success: true, request, requestId: request.id, username: targetName, message });
      }
      if (action === 'friend-respond') {
        const request = account.friendRequests.find((item) => item.id === cleanText(payload.requestId, 80) && item.status === 'pending');
        if (!request) return acknowledgement?.({ success: false, error: '好友申请不存在或已经处理' });
        const sender = state.accounts[request.from]; const accepted = payload.accepted === true;
        request.status = accepted ? 'accepted' : 'rejected'; request.resolvedAt = new Date().toISOString();
        if (accepted && sender) {
          if (!account.friends.includes(request.from)) account.friends.push(request.from);
          if (!sender.friends.includes(user.username)) sender.friends.push(user.username);
          account.friendMeta[request.from] = { ...(account.friendMeta[request.from] || {}), group: '我的好友', unread: 0 };
          sender.friendMeta = sender.friendMeta && typeof sender.friendMeta === 'object' ? sender.friendMeta : {};
          sender.friendMeta[user.username] = { ...(sender.friendMeta[user.username] || {}), group: '我的好友', unread: 0 };
        }
        persist();
        const friendResult = {
          accepted, requestId: request.id, username: user.username,
          displayName: account.displayName || user.username,
          message: `${account.displayName || user.username}${accepted ? '已同意' : '已拒绝'}您的好友申请`
        };
        accountChangeNotice(request.from, {
          kind: 'friend-request', approved: accepted, requestId: request.id,
          actor: user.username, actorName: account.displayName || user.username,
          message: friendResult.message
        }, 'friend-request-resolved', friendResult);
        return acknowledgement?.({ success: true, profile: accountProfile(user.username), message: accepted ? '已添加为好友' : '已拒绝好友申请' });
      }
      if (action === 'friend-settings') {
        account.friendSettings = normalizeFriendSettings({ ...normalizeFriendSettings(account.friendSettings), ...payload });
        persist();
        return acknowledgement?.({ success: true, profile: accountProfile(user.username), friendSettings: account.friendSettings, message: '好友接收设置已保存' });
      }
      if (action === 'friend-notification-mute') {
        const friend = cleanUsername(payload.username);
        if (!account.friends.includes(friend)) return acknowledgement?.({ success: false, error: '对方不是您的好友' });
        const duration = Math.max(0, Math.min(3650 * 24 * 60 * 60 * 1000, Number(payload.durationMs) || 0));
        account.friendMeta[friend] = { ...(account.friendMeta[friend] || {}), muteUntil: duration ? new Date(Date.now() + duration).toISOString() : '' };
        persist();
        return acknowledgement?.({ success: true, profile: accountProfile(user.username), message: duration ? '已暂时关闭该好友的消息提醒' : '已恢复该好友的消息提醒' });
      }
      if (action === 'friend-update') {
        const friend = cleanUsername(payload.username); if (!account.friends.includes(friend)) return acknowledgement?.({ success: false, error: '对方不是您的好友' });
        const previous = account.friendMeta[friend] || {};
        account.friendMeta[friend] = {
          ...previous,
          remark: Object.hasOwn(payload, 'remark') ? cleanText(payload.remark, 40) : cleanText(previous.remark, 40),
          group: Object.hasOwn(payload, 'group') ? cleanText(payload.group || '我的好友', 40) || '我的好友' : cleanText(previous.group || '我的好友', 40) || '我的好友',
          pinned: Object.hasOwn(payload, 'pinned') ? payload.pinned === true : previous.pinned === true,
          floatingNotice: Object.hasOwn(payload, 'floatingNotice') ? payload.floatingNotice !== false : previous.floatingNotice !== false,
          unread: Math.max(0, Number(previous.unread) || 0)
        };
        persist(); return acknowledgement?.({ success: true, profile: accountProfile(user.username), message: '好友设置已保存' });
      }
      if (action === 'friend-remove') {
        const friend = cleanUsername(payload.username); const other = state.accounts[friend];
        account.friends = account.friends.filter((name) => name !== friend); delete account.friendMeta[friend];
        if (other) { other.friends = (other.friends || []).filter((name) => name !== user.username); if (other.friendMeta) delete other.friendMeta[user.username]; }
        persist(); return acknowledgement?.({ success: true, profile: accountProfile(user.username), message: '好友已删除，双方历史消息仍各自保留' });
      }
      if (action === 'friend-history') {
        const friend = cleanUsername(payload.username); if (!account.friends.includes(friend)) return acknowledgement?.({ success: false, error: '对方不是您的好友' });
        const unreadOnly = payload.unreadOnly === true;
        const receipt = unreadOnly ? { ids: [], readAt: '' } : markFriendMessagesRead(user.username, friend);
        const query = cleanText(payload.query, 160).toLocaleLowerCase();
        const type = ['text', 'image'].includes(payload.type) ? payload.type : '';
        const fromDate = Date.parse(String(payload.fromDate || ''));
        const toDateRaw = Date.parse(String(payload.toDate || ''));
        const toDate = Number.isFinite(toDateRaw) && /^\d{4}-\d{2}-\d{2}$/.test(String(payload.toDate || ''))
          ? toDateRaw + 24 * 60 * 60 * 1000 - 1 : toDateRaw;
        const messages = account.friendMessages.filter((message) => {
          if (!((message.from === friend && message.to === user.username)
            || (message.from === user.username && message.to === friend))) return false;
          if (type && message.type !== type) return false;
          const timestamp = Date.parse(message.timestamp || '');
          if (Number.isFinite(fromDate) && (!Number.isFinite(timestamp) || timestamp < fromDate)) return false;
          if (Number.isFinite(toDate) && (!Number.isFinite(timestamp) || timestamp > toDate)) return false;
          if (unreadOnly && !(message.to === user.username && !message.readAt)) return false;
          if (query) {
            const searchable = [message.text, message.fromName, message.toName, message.imageName, message.replyTo?.text]
              .map((value) => String(value || '').toLocaleLowerCase()).join(' ');
            if (!searchable.includes(query)) return false;
          }
          return true;
        }).slice(-500);
        return acknowledgement?.({
          success: true, receipt,
          filters: { query, fromDate: payload.fromDate || '', toDate: payload.toDate || '', type, unreadOnly },
          messages
        });
      }
      if (action === 'friend-message') {
        return acknowledgement?.(storeFriendMessage(user.username, cleanUsername(payload.username), {
          type: payload.type === 'image' ? 'image' : 'text', text: payload.text,
          imageUrl: payload.imageUrl, imageName: payload.imageName, replyToId: payload.replyToId
        }));
      }
      if (action === 'friend-read') {
        const friend = cleanUsername(payload.username);
        if (!account.friends.includes(friend)) return acknowledgement?.({ success: false, error: '对方不是您的好友' });
        const receipt = markFriendMessagesRead(user.username, friend);
        return acknowledgement?.({ success: true, receipt, profile: accountProfile(user.username) });
      }
      if (action === 'friend-delete-messages') {
        const friend = cleanUsername(payload.username);
        if (!account.friends.includes(friend)) return acknowledgement?.({ success: false, error: '对方不是您的好友' });
        const ids = new Set((Array.isArray(payload.messageIds) ? payload.messageIds : [payload.messageId])
          .map((id) => cleanText(id, 80)).filter(Boolean).slice(0, 500));
        if (!ids.size) return acknowledgement?.({ success: false, error: '请选择要删除的聊天记录' });
        const before = account.friendMessages.length;
        account.friendMessages = account.friendMessages.filter((message) => !ids.has(message.id)
          || !((message.from === friend && message.to === user.username) || (message.from === user.username && message.to === friend)));
        const removedIds = [...ids].filter((id) => !account.friendMessages.some((message) => message.id === id));
        persist();
        for (const member of accountOnlineMembers(user.username, socket.id)) io.to(member.socketId).emit('friend-messages-deleted', { username: friend, messageIds: removedIds });
        return acknowledgement?.({ success: true, removed: before - account.friendMessages.length, messageIds: removedIds, message: `已从您的聊天记录中删除 ${before - account.friendMessages.length} 条消息` });
      }
      if (action === 'friend-clear') {
        const friend = cleanUsername(payload.username);
        if (!account.friends.includes(friend)) return acknowledgement?.({ success: false, error: '对方不是您的好友' });
        const before = account.friendMessages.length;
        account.friendMessages = account.friendMessages.filter((message) => message.from !== friend && message.to !== friend);
        persist(); return acknowledgement?.({ success: true, removed: before - account.friendMessages.length, message: '您这一侧的好友聊天记录已清空' });
      }
      if (action === 'friend-room-invite' || action === 'friend-room-join-request') {
        const friend = cleanUsername(payload.username);
        const target = state.accounts[friend];
        if (!target || !account.friends.includes(friend) || !target.friends?.includes(user.username)) return acknowledgement?.({ success: false, error: '只能向好友发送房间邀请' });
        let targetRoom;
        let kind;
        if (action === 'friend-room-invite') {
          targetRoom = state.rooms[user.roomId]; kind = 'invite';
          const friendMember = accountOnlineMembers(friend)[0];
          if (friendMember?.roomId === targetRoom?.id) {
            return acknowledgement?.({
              success: true, alreadyTogether: true,
              message: `您和 ${target.displayName || friend} 已经在同一个房间，正在一起观影啦~`
            });
          }
        } else {
          const friendMember = accountOnlineMembers(friend)[0];
          targetRoom = friendMember && state.rooms[friendMember.roomId]; kind = 'join';
          if (!friendMember || !targetRoom) return acknowledgement?.({ success: false, error: '该好友当前不在房间中' });
        }
        if (!targetRoom || targetRoom.banned) return acknowledgement?.({ success: false, error: '目标房间当前不可加入' });
        target.friendRoomRequests = retainPersistentRequests(target.friendRoomRequests);
        const existing = target.friendRoomRequests.find((entry) => entry.status === 'pending' && entry.kind === kind
          && entry.from === user.username && entry.roomId === targetRoom.id);
        if (existing) return acknowledgement?.({ success: true, request: existing, message: '房间请求正在等待好友处理' });
        const request = {
          id: crypto.randomUUID(), kind, from: user.username, to: friend,
          roomId: targetRoom.id, roomName: targetRoom.name, roomOwner: targetRoom.ownerUsername,
          status: 'pending', createdAt: new Date().toISOString(), snoozedUntil: ''
        };
        target.friendRoomRequests.push(request); target.friendRoomRequests = retainPersistentRequests(target.friendRoomRequests).slice(-500);
        persist();
        const publicRequest = { ...request, displayName: account.displayName || user.username };
        for (const member of accountOnlineMembers(friend)) io.to(member.socketId).emit('friend-room-request', publicRequest);
        return acknowledgement?.({ success: true, request: publicRequest, message: kind === 'invite' ? '房间邀请已发送' : '加入好友房间的申请已发送' });
      }
      if (action === 'friend-room-direct-join') {
        const friend = cleanUsername(payload.username);
        if (!account.friends.includes(friend)) return acknowledgement?.({ success: false, error: '对方不是您的好友' });
        const friendMember = accountOnlineMembers(friend)[0];
        const targetRoom = friendMember && state.rooms[friendMember.roomId];
        if (!friendMember || !targetRoom) return acknowledgement?.({ success: false, error: '该好友当前不在房间中' });
        const directAllowed = targetRoom.ownerUsername === friend
          && normalizeFriendSettings(state.accounts[friend]?.friendSettings).allowPasswordlessOwnRoomJoin;
        if (!directAllowed) return acknowledgement?.({ success: false, code: 'FRIEND_APPROVAL_REQUIRED', error: '需要先获得好友同意才能加入该房间' });
        if (targetRoom.banned || targetRoom.archived) return acknowledgement?.({ success: false, error: '目标房间当前不可加入' });
        if (guestsDisallowed(user.username, targetRoom)) return acknowledgement?.({ success: false, code: 'GUESTS_DISABLED', error: '房主已禁止游客进入该房间' });
        const session = validSession(user.sessionToken, false);
        if (!session || enforceRoomCapacity(user.username, targetRoom.id, { serverHost: Boolean(session.isServerHost) })) return acknowledgement?.({ success: false, error: '目标房间人数已满' });
        switchUserRoom(socket, user, session, targetRoom); rememberRecentRoom(user.username, targetRoom.id); persist();
        return acknowledgement?.({ success: true, auth: authResult(session, user), message: `已免密加入 ${state.accounts[friend]?.displayName || friend} 的房间` });
      }
      if (action === 'friend-room-request-snooze') {
        const request = (account.friendRoomRequests || []).find((entry) => entry.id === cleanText(payload.requestId, 80) && entry.status === 'pending');
        if (!request) return acknowledgement?.({ success: false, error: '房间请求不存在或已处理' });
        const duration = Math.max(60 * 1000, Math.min(30 * 24 * 60 * 60 * 1000, Number(payload.durationMs) || 60 * 60 * 1000));
        request.snoozedUntil = new Date(Date.now() + duration).toISOString(); persist();
        return acknowledgement?.({ success: true, request, message: '已按所选时长暂停显示此请求' });
      }
      if (action === 'friend-room-respond') {
        const request = (account.friendRoomRequests || []).find((entry) => entry.id === cleanText(payload.requestId, 80) && entry.status === 'pending');
        if (!request) return acknowledgement?.({ success: false, error: '房间请求不存在或已处理' });
        const accepted = payload.accepted === true;
        const targetRoom = state.rooms[request.roomId];
        request.status = accepted ? 'accepted' : 'rejected'; request.resolvedAt = new Date().toISOString(); request.resolvedBy = user.username;
        let auth = null;
        let movedUsername = '';
        if (accepted) {
          if (!targetRoom || targetRoom.banned || targetRoom.archived) { request.status = 'failed'; persist(); return acknowledgement?.({ success: false, error: '目标房间已经不可加入' }); }
          if (request.kind === 'invite') {
            if (guestsDisallowed(user.username, targetRoom)) { request.status = 'pending'; return acknowledgement?.({ success: false, code: 'GUESTS_DISABLED', error: '房主已禁止游客进入该房间' }); }
            const session = validSession(user.sessionToken, false);
            if (!session || enforceRoomCapacity(user.username, targetRoom.id, { serverHost: Boolean(session.isServerHost) })) {
              request.status = 'pending'; return acknowledgement?.({ success: false, error: '目标房间人数已满' });
            }
            switchUserRoom(socket, user, session, targetRoom); rememberRecentRoom(user.username, targetRoom.id);
            auth = authResult(session, user); movedUsername = user.username;
          } else {
            const requester = accountOnlineMembers(request.from)[0];
            const requesterSocket = requester && io.sockets.sockets.get(requester.socketId);
            const requesterSession = requester && validSession(requester.sessionToken, false);
            if (!requester || !requesterSocket || !requesterSession) { request.status = 'pending'; return acknowledgement?.({ success: false, error: '申请人当前已离线，暂时无法加入' }); }
            if (guestsDisallowed(requester.username, targetRoom)) { request.status = 'pending'; return acknowledgement?.({ success: false, code: 'GUESTS_DISABLED', error: '房主已禁止游客进入该房间' }); }
            if (enforceRoomCapacity(requester.username, targetRoom.id, { serverHost: Boolean(requesterSession.isServerHost) })) {
              request.status = 'pending'; return acknowledgement?.({ success: false, error: '目标房间人数已满' });
            }
            switchUserRoom(requesterSocket, requester, requesterSession, targetRoom); rememberRecentRoom(requester.username, targetRoom.id);
            auth = authResult(requesterSession, requester); movedUsername = requester.username;
          }
        }
        persist();
        const actorName = account.displayName || user.username;
        const resolution = {
          requestId: request.id, kind: request.kind, accepted, roomId: request.roomId,
          roomName: targetRoom?.name || request.roomName, username: user.username, displayName: actorName,
          message: `${actorName}${accepted ? '已同意' : '已拒绝'}${request.kind === 'invite' ? '房间邀请' : '加入房间申请'}`
        };
        for (const member of accountOnlineMembers(request.from)) {
          io.to(member.socketId).emit('friend-room-request-resolved', {
            ...resolution, auth: accepted && movedUsername === request.from && member.username === movedUsername ? auth : null
          });
        }
        if (!accountIsOnline(request.from)) accountChangeNotice(request.from, { ...resolution, kind: 'friend-room-request' });
        return acknowledgement?.({ success: true, request, accepted, auth: accepted && movedUsername === user.username ? auth : null, message: resolution.message });
      }
      if (action === 'pin-room') {
        const id = normalizeRoomId(payload.roomId);
        if (!id || !visibleRoom(state.rooms[id]) || !roomListForAccount(user.username).some((room) => room.id === id)) {
          return acknowledgement?.({ success: false, error: '房间不在“我的房间”列表中' });
        }
        account.pinnedRooms = Array.isArray(account.pinnedRooms) ? account.pinnedRooms : [];
        if (payload.pinned === false) account.pinnedRooms = account.pinnedRooms.filter((entry) => entry !== id);
        else if (!account.pinnedRooms.includes(id)) account.pinnedRooms.push(id);
        persist();
        return acknowledgement?.({ success: true, profile: accountProfile(user.username), message: payload.pinned === false ? '已取消置顶' : '房间已置顶' });
      }
      if (action === 'remove-rooms') {
        const result = await removeRoomsForAccount(user.username, payload.roomIds, payload.confirmOwnedDeletion === true);
        return acknowledgement?.({ ...result, profile: result.success ? accountProfile(user.username) : undefined });
      }
      return acknowledgement?.({ success: false, error: '未知账户操作' });
    });

    onSafe('request-control', (payload, acknowledgement) => {
      if (socketRateLimited(socket, `request-control:${socket.id}`, 5, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (canControl(user)) return acknowledgement?.({ success: true, alreadyGranted: true, message: '您已经拥有播放控制权限' });
      const runtime = roomRuntime(user.roomId);
      const existing = runtime.controlRequests.find((entry) => entry.username === user.username && entry.status === 'pending');
      if (existing) return acknowledgement?.({ success: true, request: existing, message: '控制申请已发送，请等待房主或管理员处理' });
      const request = {
        id: crypto.randomUUID(), roomId: user.roomId, username: user.username,
        displayName: state.accounts[user.username]?.displayName || user.username,
        requesterSocketId: socket.id, createdAt: Date.now(), status: 'pending'
      };
      runtime.controlRequests.push(request);
      runtime.controlRequests = runtime.controlRequests.slice(-100);
      const managers = roomUsers(user.roomId).filter((member) => isRoomAdmin(member) && member.socketId !== socket.id);
      for (const manager of managers) io.to(manager.socketId).emit('control-request', request);
      return acknowledgement?.({ success: true, request, message: managers.length ? '已向房主或管理员发送控制申请' : '申请已记录，房主或管理员上线后可以处理' });
    });

    onSafe('room-copy-request', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `room-copy-request:${socket.id}`, 5, 10 * 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const sourceRoomId = normalizeRoomId(payload.sourceRoomId);
      const sourceRoom = sourceRoomId && state.rooms[sourceRoomId];
      if (!visibleRoom(sourceRoom) || sourceRoom.temporary) return acknowledgement?.({ success: false, error: '源房间不存在、已存档或属于临时房间' });
      if (!sourceRoom.ownerUsername) return acknowledgement?.({ success: false, error: '系统房间不能作为复制来源' });
      if (sourceRoom.ownerUsername === user.username) return acknowledgement?.({ success: false, error: '自己的房间无需申请复制，可由管理员执行迁移' });
      const account = state.accounts[user.username];
      const quota = Math.max(1, Number(account.roomQuota) || 1);
      if (!account.superAdmin && ownedRooms(user.username).length >= quota) return acknowledgement?.({ success: false, code: 'ROOM_QUOTA_REACHED', error: `当前账号最多可创建 ${quota} 个房间，请先申请提高建房额度` });
      let request = state.admin.roomCopyRequests.find((entry) => entry.status === 'pending'
        && entry.sourceRoomId === sourceRoomId && entry.requestedBy === user.username);
      if (!request) {
        request = {
          id: crypto.randomUUID(), sourceRoomId, sourceRoomName: sourceRoom.name,
          sourceOwner: sourceRoom.ownerUsername, requestedBy: user.username,
          requestedByName: account.displayName || user.username,
          requestedRoomName: cleanText(payload.requestedRoomName, 40), reason: cleanText(payload.reason, 240),
          status: 'pending', createdAt: new Date().toISOString(), resolvedAt: '', resolvedBy: '', targetRoomId: ''
        };
        state.admin.roomCopyRequests.push(request);
        state.admin.roomCopyRequests = retainPersistentRequests(state.admin.roomCopyRequests).slice(-1000);
      } else {
        request.requestedRoomName = cleanText(payload.requestedRoomName || request.requestedRoomName, 40);
        request.reason = cleanText(payload.reason || request.reason, 240);
      }
      persist();
      const ownerMembers = accountOnlineMembers(sourceRoom.ownerUsername);
      if (!normalizeViewPreferences(state.accounts[sourceRoom.ownerUsername]?.viewPreferences).conciseMode) {
        for (const ownerMember of ownerMembers) io.to(ownerMember.socketId).emit('room-copy-requested', request);
      }
      return acknowledgement?.({ success: true, request, message: ownerMembers.length ? '复制申请已发送给源房主' : '复制申请已记录，源房主上线后可以处理' });
    });

    onSafe('room-copy-request-action', async (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `room-copy-request-action:${socket.id}`, 10, 10 * 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const request = state.admin.roomCopyRequests.find((entry) => entry.id === cleanText(payload.requestId, 80));
      if (!request || request.status !== 'pending') return acknowledgement?.({ success: false, error: '房间复制申请不存在或已处理' });
      const sourceRoom = state.rooms[request.sourceRoomId];
      if (!visibleRoom(sourceRoom) || sourceRoom.ownerUsername !== user.username || request.sourceOwner !== user.username) {
        return acknowledgement?.({ success: false, error: '只有当前源房主可以处理这项复制申请' });
      }
      const approved = payload.approved === true;
      if (!approved) {
        request.status = 'denied'; request.resolvedAt = new Date().toISOString(); request.resolvedBy = user.username;
        persist();
        const result = { requestId: request.id, approved: false, status: request.status, message: '源房主已拒绝房间复制申请' };
        accountChangeNotice(request.requestedBy, { kind: 'room-copy-request', roomId: request.sourceRoomId, ...result }, 'room-copy-request-resolved', result);
        return acknowledgement?.({ success: true, request, ...result });
      }
      const requester = state.accounts[request.requestedBy];
      if (!requester) return acknowledgement?.({ success: false, error: '申请账号已不存在' });
      const quota = Math.max(1, Number(requester.roomQuota) || 1);
      if (!requester.superAdmin && ownedRooms(request.requestedBy).length >= quota) {
        return acknowledgement?.({ success: false, code: 'ROOM_QUOTA_REACHED', error: `申请账号最多可创建 ${quota} 个房间，暂时无法复制` });
      }
      try {
        const copied = await copyRoomDataTransactional({
          sourceRoomId: request.sourceRoomId, targetOwner: request.requestedBy,
          requestedRoomName: request.requestedRoomName, overwrite: false, actor: user.username
        });
        request.status = 'approved'; request.resolvedAt = new Date().toISOString(); request.resolvedBy = user.username; request.targetRoomId = copied.room.id;
        persist();
        const result = {
          requestId: request.id, approved: true, status: request.status, room: copied.room,
          copiedFiles: copied.copiedFiles, copiedMessages: copied.copiedMessages,
          message: `源房主已同意，房间数据已复制到 ${copied.room.id}`
        };
        accountChangeNotice(request.requestedBy, { kind: 'room-copy-request', roomId: copied.room.id, ...result }, 'room-copy-request-resolved', result);
        return acknowledgement?.({ success: true, request, ...result });
      } catch (error) {
        return acknowledgement?.({ success: false, code: 'ROOM_COPY_FAILED', error: `房间复制失败，未修改源房间：${cleanText(error.message, 180)}` });
      }
    });

    onSafe('control-request-action', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `control-request-action:${socket.id}`, 30, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!isRoomAdmin(user)) return acknowledgement?.({ success: false, error: '只有房主或管理员可以处理控制申请' });
      const runtime = roomRuntime(user.roomId);
      const request = runtime.controlRequests.find((entry) => entry.id === cleanText(payload.requestId, 80) && entry.status === 'pending');
      if (!request) return acknowledgement?.({ success: false, error: '控制申请不存在或已处理' });
      const approved = payload.approved === true;
      request.status = approved ? 'approved' : 'denied';
      request.resolvedAt = Date.now();
      request.resolvedBy = user.username;
      request.resolvedByName = state.accounts[user.username]?.displayName || user.username;
      if (approved) {
        state.permissions[request.username] = { ...(state.permissions[request.username] || {}), control: true, seek: true };
        persist();
        io.to(roomChannel(user.roomId)).emit('users-list', usersList(user.roomId));
      }
      const message = approved
        ? `${request.resolvedByName} 已同意您的播放控制申请`
        : `${request.resolvedByName} 已拒绝您的播放控制申请`;
      const resolved = { ...request, approved, message, permissions: permissionFor(request.username, user.roomId) };
      accountChangeNotice(request.username, {
        kind: 'control-request', roomId: user.roomId, actor: user.username, actorName: request.resolvedByName,
        approved, requestId: request.id, permissions: resolved.permissions, changed: approved ? ['control', 'seek'] : [], message
      }, 'control-request-resolved', resolved);
      for (const manager of roomUsers(user.roomId).filter((member) => isRoomAdmin(member) && member.username !== request.username && member.socketId !== socket.id)) {
        io.to(manager.socketId).emit('control-request-resolved', {
          ...resolved, message: `${request.displayName} 的控制申请已由 ${request.resolvedByName}${approved ? '同意' : '拒绝'}`
        });
      }
      return acknowledgement?.({ success: true, request: resolved, message: approved ? '已开放播放控制权限' : '已拒绝控制申请' });
    });

    onSafe('room-playback-skip-settings', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `room-skip-settings:${socket.id}`, 20, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!isRoomAdmin(user, 'skipSettings')) return acknowledgement?.({ success: false, error: '只有房主、房间管理员或获授权成员可以设置跳过片头片尾' });
      const skipSettings = normalizePlaybackSkipSettings(payload.skipSettings || payload);
      state.room.skipSettings = skipSettings;
      state.room.lastActivityAt = new Date().toISOString();
      persist();
      recordOperation({ actor: user.username, action: 'room-skip-settings', summary: skipSettings.enabled
        ? `设置跳过片头 ${skipSettings.introSeconds} 秒、片尾 ${skipSettings.outroSeconds} 秒`
        : '关闭自动跳过片头片尾' });
      const update = { roomId: user.roomId, skipSettings, changedBy: user.username, updatedAt: new Date().toISOString() };
      io.to(roomChannel(user.roomId)).emit('room-skip-settings-updated', update);
      io.to(roomChannel(user.roomId)).emit('room-state', roomSnapshot(user.roomId));
      return acknowledgement?.({ success: true, ...update, message: skipSettings.enabled ? '跳过片头片尾设置已同步' : '已关闭自动跳过片头片尾' });
    });

    onSafe('owner-action', async (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `owner:${socket.id}`, 60, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (user.username !== state.room.ownerUsername && !isSuperAdmin(user.username)) return acknowledgement?.({ success: false, error: '仅房主或超级管理员可执行此操作' });
      const action = String(payload.action || '');
      if (action === 'dissolve-room') return acknowledgement?.(await dissolveRoom(user.roomId, user.username, Boolean(payload.preserveData)));
      const before = { controlLocked: state.room.controlLocked, volumeSync: state.room.volumeSync, allowGuests: state.room.allowGuests !== false, permissions: JSON.parse(JSON.stringify(state.permissions)) };
      if (action === 'toggle-lock') state.room.controlLocked = Boolean(payload.locked);
      else if (action === 'volume-sync') {
        state.room.volumeSync = Boolean(payload.enabled);
        if (state.room.volumeSync) io.to(roomChannel()).emit('playback-state', playbackSnapshot());
      }
      else if (action === 'force-sync') io.to(roomChannel()).emit('playback-state', playbackSnapshot());
      else if (action === 'allow-guests') state.room.allowGuests = payload.enabled !== false;
      else if (action === 'grant-control' || action === 'revoke-control') {
        const username = cleanUsername(payload.username);
        if (!state.accounts[username]) return acknowledgement?.({ success: false, error: '成员不存在' });
        state.permissions[username] = { ...(state.permissions[username] || {}), control: action === 'grant-control', seek: action === 'grant-control' };
        const updatedPermissions = permissionFor(username);
        for (const member of roomUsers().filter((entry) => entry.username === username)) io.to(member.socketId).emit('permissions-changed', {
          permissions: updatedPermissions, changed: ['control', 'seek'], grantedBy: state.accounts[user.username]?.displayName || user.username,
          message: action === 'grant-control' ? '房主已向您开放播放控制权限' : '房主已收回您的播放控制权限'
        });
      } else return acknowledgement?.({ success: false, error: '未知房主操作' });
      const sharingUser = users.get(roomState.screenShare.socketId);
      if (roomState.screenShare.active && !canControl(sharingUser)) stopScreenShare(roomState.screenShare.socketId);
      persist();
      if (action !== 'force-sync') recordOperation({ actor: user.username, action: `owner-${action}`, summary: `房主操作：${action}`, undo: { kind: 'owner-settings', before, after: { controlLocked: state.room.controlLocked, volumeSync: state.room.volumeSync, allowGuests: state.room.allowGuests !== false, permissions: JSON.parse(JSON.stringify(state.permissions)) } } });
      io.to(roomChannel()).emit('room-state', roomSnapshot());
      io.to(roomChannel()).emit('users-list', usersList());
      const actorName = state.accounts[user.username]?.displayName || user.username;
      if (action === 'toggle-lock') broadcastRoomNotice(user.roomId, `${actorName}${state.room.controlLocked ? '已锁定播放控制' : '已开放播放控制'}`, { kind: 'room-control', actor: user.username });
      else if (action === 'volume-sync') broadcastRoomNotice(user.roomId, `${actorName}${state.room.volumeSync ? '已开启音量同步' : '已关闭音量同步'}`, { kind: 'room-control', actor: user.username });
      else if (action === 'allow-guests') broadcastRoomNotice(user.roomId, `${actorName}${state.room.allowGuests !== false ? '已允许' : '已禁止'}游客进入`, { kind: 'room-access', actor: user.username, important: state.room.allowGuests === false });
      else if (action === 'force-sync') broadcastRoomNotice(user.roomId, `${actorName} 已让所有成员重新同步播放进度`, { kind: 'room-control', actor: user.username });
      return acknowledgement?.({ success: true, room: roomSnapshot() });
    });

    onSafe('queue-action', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `queue:${socket.id}`, 30, 10 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!canControl(user)) return acknowledgement?.({ success: false, error: '没有播放队列控制权限' });
      const id = cleanText(payload.fileId, 80);
      const action = String(payload.action || '');
      if (action === 'set-mode') {
        const before = normalizePlaybackMode(state.room.playbackMode);
        const next = normalizePlaybackMode({ mode: payload.mode, category: payload.category });
        if (next.mode === 'category' && !next.category) return acknowledgement?.({ success: false, error: '请选择要循环播放的影片分类' });
        state.room.playbackMode = next;
        persist();
        recordOperation({ actor: user.username, action: 'queue-mode', summary: `切换播放模式：${next.mode}`, undo: { kind: 'playback-mode', before, after: next } });
        io.to(roomChannel()).emit('room-state', roomSnapshot());
        const actorName = state.accounts[user.username]?.displayName || user.username;
        const beforeLabel = before.mode === 'category' ? `分类循环（${before.category || '未分类'}）` : before.mode;
        const nextLabel = next.mode === 'category' ? `分类循环（${next.category || '未分类'}）` : next.mode;
        const notice = broadcastRoomNotice(user.roomId, `${actorName} 将播放模式从“${beforeLabel}”更新为“${nextLabel}”`, { kind: 'playback-mode', actor: user.username, actorName, before, after: next, important: true });
        return acknowledgement?.({ success: true, playbackMode: next, notice, message: `播放模式已更新：${beforeLabel} → ${nextLabel}` });
      }
      if (action === 'set-file-mode') {
        const file = findFile(id);
        if (!isPlayableFile(file) || file.roomId !== currentRoomId() || !state.queue.includes(id)) {
          return acknowledgement?.({ success: false, error: '只能设置当前播放队列中的影片' });
        }
        state.room.queueFileModes = state.room.queueFileModes && typeof state.room.queueFileModes === 'object' ? state.room.queueFileModes : {};
        const requestedMode = cleanText(payload.mode, 20).toLowerCase();
        if (!requestedMode || requestedMode === 'inherit') delete state.room.queueFileModes[id];
        else {
          const next = normalizePlaybackMode({ mode: requestedMode, category: payload.category || mediaCollectionName(file) });
          state.room.queueFileModes[id] = next;
        }
        persist();
        recordOperation({ actor: user.username, action: 'queue-file-mode', summary: `设置影片播放模式：${file.originalName}` });
        io.to(roomChannel()).emit('room-state', roomSnapshot());
        return acknowledgement?.({ success: true, fileMode: state.room.queueFileModes[id] || null, message: '影片独立播放模式已更新' });
      }
      if (action === 'batch-add' || action === 'batch-remove') {
        const fileIds = [...new Set((Array.isArray(payload.fileIds) ? payload.fileIds : [])
          .map((value) => cleanText(value, 80)).filter(Boolean))].slice(0, 500);
        if (!fileIds.length) return acknowledgement?.({ success: false, error: '请至少选择一个队列项目' });
        if (action === 'batch-add') {
          const invalid = fileIds.filter((fileId) => {
            const file = findFile(fileId);
            return !isPlayableFile(file) || file.roomId !== currentRoomId();
          });
          if (invalid.length) return acknowledgement?.({ success: false, code: 'QUEUE_BATCH_INVALID_FILES', invalid, error: '批量加入失败：所选项目包含未审核或不属于当前房间的媒体' });
        }
        const before = [...state.queue];
        let changed;
        if (action === 'batch-add') {
          changed = fileIds.filter((fileId) => !state.queue.includes(fileId));
          state.queue.push(...changed);
        } else {
          changed = fileIds.filter((fileId) => state.queue.includes(fileId));
          const removed = new Set(changed);
          state.queue = state.queue.filter((fileId) => !removed.has(fileId));
          if (state.room.queueFileModes) for (const fileId of removed) delete state.room.queueFileModes[fileId];
        }
        persist();
        recordOperation({ actor: user.username, action: `queue-${action}`, summary: `${action === 'batch-add' ? '批量加入' : '批量移除'}播放队列：${changed.length} 项`, undo: { kind: 'queue', before, after: [...state.queue] } });
        io.to(roomChannel()).emit('queue-state', state.queue);
        return acknowledgement?.({
          success: true, queue: state.queue, playbackMode: normalizePlaybackMode(state.room.playbackMode),
          added: action === 'batch-add' ? changed : [], removed: action === 'batch-remove' ? changed : [],
          message: `${action === 'batch-add' ? '已加入' : '已移除'} ${changed.length} 个队列项目`
        });
      }
      const file = findFile(id);
      if (action === 'add' && (!isPlayableFile(file) || file.roomId !== currentRoomId())) return acknowledgement?.({ success: false, error: '播放队列只能加入当前房间已审核的视频或音频' });
      const before = [...state.queue];
      if (action === 'add' && !state.queue.includes(id)) state.queue.push(id);
      else if (action === 'remove') {
        state.queue = state.queue.filter((entry) => entry !== id);
        if (state.room.queueFileModes) delete state.room.queueFileModes[id];
      }
      else if (action === 'move') {
        const from = state.queue.indexOf(id);
        const to = Math.max(0, Math.min(state.queue.length - 1, Number(payload.index) || 0));
        if (from >= 0) state.queue.splice(to, 0, state.queue.splice(from, 1)[0]);
      } else if (!(action === 'add' && state.queue.includes(id))) return acknowledgement?.({ success: false, error: '队列操作无效' });
      persist();
      recordOperation({ actor: user.username, action: `queue-${action}`, summary: `调整播放队列：${action}`, undo: { kind: 'queue', before, after: [...state.queue] } });
      io.to(roomChannel()).emit('queue-state', state.queue);
      return acknowledgement?.({ success: true, queue: state.queue });
    });

    onSafe('chat-history', async (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `chat-history:${socket.id}`, 10, 10 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const limit = Math.max(20, Math.min(300, Number(payload.limit) || 100));
      const parsedBefore = payload.before ? Date.parse(payload.before) : Infinity;
      const beforeId = cleanText(payload.beforeId || payload.cursor, 80);
      const usernames = Array.isArray(payload.usernames) ? payload.usernames
        : Array.isArray(payload.participants) ? payload.participants : [];
      const fromTimestamp = payload.fromDate || payload.from ? Date.parse(payload.fromDate || payload.from) : NaN;
      const toTimestamp = payload.toDate || payload.to ? Date.parse(payload.toDate || payload.to) : NaN;
      const page = await readChatPage(user.roomId, user.username, Number.isFinite(parsedBefore) ? parsedBefore : Infinity, beforeId, limit,
        cleanUsername(payload.participant || payload.usernameFilter || ''), cleanText(payload.channel, 20).toLowerCase(), {
          usernames, fromTimestamp, toTimestamp, query: payload.query || payload.search || payload.keyword || ''
        });
      if (!page.cursorFound) return acknowledgement?.({ success: false, error: '聊天历史游标无效或无权访问' });
      const oldest = page.messages[0];
      const nextBeforeId = page.hasMore && oldest ? oldest.id : '';
      const nextBefore = page.hasMore && oldest ? oldest.timestamp || '' : '';
      return acknowledgement?.({
        success: true, messages: page.messages, hasMore: page.hasMore,
        nextBeforeId, nextBefore, nextCursor: nextBeforeId,
        filters: { usernames, channel: cleanText(payload.channel, 20).toLowerCase(), fromTimestamp: Number.isFinite(fromTimestamp) ? fromTimestamp : null, toTimestamp: Number.isFinite(toTimestamp) ? toTimestamp : null, query: cleanText(payload.query || payload.search || payload.keyword, 120) }
      });
    });

    onSafe('chat-message', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `chat:${socket.id}`, 30, 10 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const to = cleanUsername(payload.to || '');
      if (to && !state.accounts[to]) return acknowledgement?.({ success: false, error: '私聊对象不存在' });
      const type = payload.type === 'announcement' ? 'announcement' : 'text';
      if (type === 'announcement' && user.username !== state.room.ownerUsername) return acknowledgement?.({ success: false, error: '只有房主可以发布公告' });
      const blockedWord = blockedWordMatch(payload.text);
      if (blockedWord) return acknowledgement?.({ success: false, code: 'BLOCKED_WORD', blockedWord, error: `消息包含服务器屏蔽词“${blockedWord}”，请修改后再发送` });
      const message = createMessage(user, { type, to, text: payload.text });
      if (!message.text) return acknowledgement?.({ success: false, error: '消息不能为空' });
      appendMessage(message);
      emitMessage(message);
      return acknowledgement?.({ success: true, message });
    });

    onSafe('screen-notice', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `screen-notice:${socket.id}`, 12, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const session = validSession(user.sessionToken, false);
      const permissions = permissionFor(user.username, user.roomId);
      if (!(session?.isServerHost || isSuperAdmin(user.username) || user.username === state.room.ownerUsername || permissions.sendNotice)) {
        return acknowledgement?.({ success: false, error: '没有发送屏幕公告的权限' });
      }
      const text = cleanText(payload.text, 500);
      if (!text) return acknowledgement?.({ success: false, error: '请输入公告内容' });
      const color = /^#[0-9a-f]{6}$/i.test(String(payload.color || '')) ? String(payload.color) : '#ffffff';
      const font = ['system', 'serif', 'monospace', 'rounded'].includes(payload.font) ? payload.font : 'system';
      const durationSeconds = Math.max(2, Math.min(60, Number(payload.durationSeconds) || 8));
      const fontSize = Math.max(16, Math.min(72, Number(payload.fontSize) || 28));
      const scope = payload.scope === 'server' && (session?.isServerHost || isSuperAdmin(user.username)) ? 'server' : 'room';
      const notice = {
        id: crypto.randomUUID(), text, color, font, durationSeconds, fontSize, scope,
        from: user.username, fromName: state.accounts[user.username]?.displayName || user.username,
        roomId: user.roomId, timestamp: new Date().toISOString()
      };
      const recipients = scope === 'server' ? [...users.values()] : roomUsers(user.roomId);
      const deliveredSocketIds = new Set();
      for (const member of recipients) {
        if (!member?.socketId || deliveredSocketIds.has(member.socketId)) continue;
        if (normalizeViewPreferences(state.accounts[member.username]?.viewPreferences).conciseMode) continue;
        deliveredSocketIds.add(member.socketId);
        io.to(member.socketId).emit('screen-notice', notice);
      }
      recordOperation({ roomId: user.roomId, actor: user.username, action: 'screen-notice', summary: `${scope === 'server' ? '全服务器' : '房间'}公告：${text.slice(0, 60)}`, scope: scope === 'server' ? 'server' : 'room' });
      return acknowledgement?.({
        success: true, notice, deliveredCount: deliveredSocketIds.size,
        message: scope === 'server' ? '公告已发送到未开启简洁模式的在线设备' : '公告已发送到当前房间中未开启简洁模式的设备'
      });
    });

    onSafe('web-share-state-request', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const webShare = { roomId: user.roomId, ...roomRuntime(user.roomId).roomState.webShare, serverTime: Date.now() };
      socket.emit('web-share-state', webShare);
      return acknowledgement?.({ success: true, webShare });
    });

    onSafe('web-share-start', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `web-share:${socket.id}`, 20, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const permissions = permissionFor(user.username, user.roomId);
      if (!(user.username === state.room.ownerUsername || isSuperAdmin(user.username) || permissions.shareWeb || permissions.manageRoom)) {
        return acknowledgement?.({ success: false, error: '没有共享网址的权限' });
      }
      const url = normalizeSharedWebUrl(payload.url);
      if (!url) return acknowledgement?.({ success: false, error: '请输入有效的 HTTP 或 HTTPS 网址' });
      const liveMode = payload.mode === 'live';
      if (!liveMode) stopScreenShare(roomState.screenShare.socketId, user.roomId);
      // A URL share replaces the synchronized media surface. Clear the
      // previous video/audio state first so clients cannot keep rendering a
      // stale player underneath the shared page.
      roomRuntime().playbackGeneration += 1;
      roomState.playback = {
        fileId: null, isPlaying: false, stalled: false, currentTime: 0,
        volume: roomState.playback.volume, muted: Boolean(roomState.playback.muted), playbackRate: 1,
        updatedAt: Date.now(), changedBy: user.username, revision: roomState.playback.revision + 1
      };
      const textReading = resetTextReadingState(null, user.username);
      roomState.webShare = {
        active: true, mode: liveMode ? 'live' : 'url', url, title: cleanText(payload.title || '共享网页', 120),
        changedBy: user.username, updatedAt: Date.now(), revision: Math.max(0, Number(roomState.webShare.revision) || 0) + 1
      };
      persist();
      io.to(roomChannel()).emit('playback-state', playbackSnapshot());
      io.to(roomChannel()).emit('text-reading-state', textReading);
      io.to(roomChannel()).emit('web-share-state', { roomId: user.roomId, ...roomState.webShare, serverTime: Date.now() });
      recordOperation({ actor: user.username, action: 'web-share-start', summary: `共享网址：${url}` });
      return acknowledgement?.({ success: true, webShare: { ...roomState.webShare }, message: liveMode ? '网页已同步为实时画面，房间成员将看到同一标签页或窗口' : '网址已同步到当前房间；原播放画面已清空。网址由各端独立加载，如需相同实时画面请使用标签页/窗口共享' });
    });

    onSafe('web-share-stop', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const permissions = permissionFor(user.username, user.roomId);
      if (!(user.username === state.room.ownerUsername || isSuperAdmin(user.username) || permissions.shareWeb || permissions.manageRoom)) {
        return acknowledgement?.({ success: false, error: '没有停止网址共享的权限' });
      }
      const stoppedScreenShare = stopScreenShare(roomState.screenShare.socketId, user.roomId);
      roomState.webShare = { active: false, mode: 'live', url: '', title: '', changedBy: user.username, updatedAt: Date.now(), revision: Math.max(0, Number(roomState.webShare.revision) || 0) + 1 };
      persist();
      io.to(roomChannel()).emit('web-share-state', { roomId: user.roomId, ...roomState.webShare, serverTime: Date.now() });
      const actorName = state.accounts[user.username]?.displayName || user.username;
      const notice = broadcastRoomNotice(user.roomId, `${actorName} 清空了画面`, {
        kind: 'playback-cleared', actor: user.username, actorName, important: true
      });
      return acknowledgement?.({ success: true, message: '网址共享已停止', screenShareStopped: stoppedScreenShare, notice });
    });

    onSafe('chat-delete', async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const messageId = cleanText(payload.messageId, 80);
      const message = await findStoredMessage(messageId, user.roomId);
      if (!message) return acknowledgement?.({ success: false, error: '聊天记录不存在' });
      if (message.from !== user.username && !isRoomAdmin(user, 'manageChat')) return acknowledgement?.({ success: false, error: '只能删除自己的聊天记录，聊天管理员可管理本房间全部记录' });
      const deletionId = crypto.randomUUID();
      const removed = await removeChatMessages((entry) => entry.roomId === currentRoomId() && entry.id === messageId);
      if (!removed.length) return acknowledgement?.({ success: false, error: '聊天记录已被删除' });
      let artifacts;
      try { artifacts = moveChatArtifactsToTrash(removed, deletionId); }
      catch (error) { await restoreChatMessages(removed); throw error; }
      const messageKind = message.type === 'danmaku' || message.channel === 'danmaku' ? '弹幕'
        : message.to ? '私聊消息' : message.type === 'voice' ? '语音消息' : message.type === 'image' ? '图片消息' : message.type === 'announcement' ? '房主公告' : '公共消息';
      recordOperation({ id: deletionId, actor: user.username, action: 'chat-delete', summary: `删除${messageKind}`, undo: { kind: 'chat', messages: removed, artifacts } });
      io.to(roomChannel()).emit('chat-records-changed', { action: 'delete', ids: [messageId] });
      return acknowledgement?.({ success: true, message: '聊天记录已删除' });
    });

    onSafe('chat-admin', async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!isRoomAdmin(user, 'manageChat')) return acknowledgement?.({ success: false, error: '只有房主或聊天管理员可以管理本房间聊天记录' });
      if (socketRateLimited(socket, 'chat-admin', 30, 60 * 1000, acknowledgement)) return;
      const action = String(payload.action || '');
      const targetUsername = cleanUsername(payload.username);
      const channel = cleanText(payload.channel, 20).toLowerCase();
      const messageId = cleanText(payload.messageId, 80);
      if (action === 'list-accounts') {
        const accounts = await readChatParticipants(user.roomId);
        return acknowledgement?.({ success: true, accounts });
      }
      if (action === 'list-messages') {
        const limit = Math.max(20, Math.min(300, Number(payload.limit) || 100));
        const parsedBefore = payload.before ? Date.parse(payload.before) : Infinity;
        const beforeId = cleanText(payload.beforeId || payload.cursor, 80);
        const parseBoundary = (value, endOfDay = false) => {
          const textValue = cleanText(value, 40);
          if (!textValue) return endOfDay ? Infinity : -Infinity;
          const timestamp = Date.parse(textValue);
          if (!Number.isFinite(timestamp)) return endOfDay ? Infinity : -Infinity;
          return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(textValue) ? timestamp + 24 * 60 * 60 * 1000 - 1 : timestamp;
        };
        const usernames = Array.isArray(payload.usernames) ? payload.usernames : [];
        const requestedChannel = cleanText(payload.type || payload.channel, 20).toLowerCase();
        const page = await readChatPage(
          user.roomId,
          user.username,
          Number.isFinite(parsedBefore) ? parsedBefore : Infinity,
          beforeId,
          limit,
          targetUsername,
          requestedChannel,
          {
            usernames,
            fromTimestamp: parseBoundary(payload.fromDate),
            toTimestamp: parseBoundary(payload.toDate, true),
            query: payload.query
          }
        );
        if (!page.cursorFound) return acknowledgement?.({ success: false, error: '聊天管理历史游标无效或无权访问' });
        const oldest = page.messages[0];
        const nextBeforeId = page.hasMore && oldest ? oldest.id : '';
        const nextBefore = page.hasMore && oldest ? oldest.timestamp || '' : '';
        return acknowledgement?.({
          success: true, messages: page.messages, hasMore: page.hasMore,
          nextBeforeId, nextBefore, nextCursor: nextBeforeId
        });
      }
      let removed = [];
      if (action === 'delete-message') removed = await removeChatMessages((entry) => entry.roomId === currentRoomId() && entry.id === messageId);
      else if (action === 'clear-user') {
        if (!targetUsername) return acknowledgement?.({ success: false, error: '请选择要清空的账号' });
        removed = await removeChatMessages((entry) => entry.roomId === currentRoomId() && (entry.from === targetUsername || entry.to === targetUsername));
      } else if (action === 'clear-channel') {
        if (!['public', 'private', 'danmaku', 'announcement', 'voice', 'image'].includes(channel)) return acknowledgement?.({ success: false, error: '请选择要清理的消息类型' });
        removed = await removeChatMessages((entry) => {
          if (entry.roomId !== currentRoomId()) return false;
          const entryChannel = entry.type === 'danmaku' || entry.channel === 'danmaku' ? 'danmaku'
            : entry.type === 'announcement' ? 'announcement' : entry.type === 'voice' ? 'voice'
              : entry.type === 'image' ? 'image' : entry.to ? 'private' : 'public';
          return entryChannel === channel;
        });
      } else if (action === 'clear-room') removed = await removeChatMessages((entry) => entry.roomId === currentRoomId());
      else return acknowledgement?.({ success: false, error: '未知聊天记录管理操作' });
      if (!removed.length) return acknowledgement?.({ success: true, message: '没有符合条件的聊天记录', removed: 0 });
      const deletionId = crypto.randomUUID();
      let artifacts;
      try { artifacts = moveChatArtifactsToTrash(removed, deletionId); }
      catch (error) { await restoreChatMessages(removed); throw error; }
      recordOperation({ id: deletionId, actor: user.username, action: `chat-${action}`, summary: `聊天记录管理：${action}，共 ${removed.length} 条`, undo: { kind: 'chat', messages: removed, artifacts } });
      io.to(roomChannel()).emit('chat-records-changed', { action: action === 'delete-message' ? 'delete' : 'reset', ids: removed.map((entry) => entry.id) });
      return acknowledgement?.({ success: true, message: `已删除 ${removed.length} 条聊天记录`, removed: removed.length });
    });

    onSafe('reaction', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `reaction:${socket.id}`, 40, 10 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const emoji = ['😂', '❤️', '🔥', '👏', '😮'].includes(payload.emoji) ? payload.emoji : '';
      if (!emoji) return acknowledgement?.({ success: false, error: '不支持的观影反应' });
      io.to(roomChannel()).emit('reaction', { emoji, username: user.username, displayName: state.accounts[user.username]?.displayName || user.username, timestamp: Date.now() });
      return acknowledgement?.({ success: true });
    });

    onSafe('danmaku', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `danmaku:${socket.id}`, 20, 10 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const text = cleanText(payload.text, 100);
      if (!text) return acknowledgement?.({ success: false, error: '弹幕不能为空' });
      const blockedWord = blockedWordMatch(text);
      if (blockedWord) return acknowledgement?.({ success: false, code: 'BLOCKED_WORD', blockedWord, error: `弹幕包含服务器屏蔽词“${blockedWord}”，请修改后再发送` });
      const message = createMessage(user, { type: 'danmaku', channel: 'danmaku', text, color: payload.color });
      appendMessage(message);
      io.to(roomChannel()).emit('danmaku', message);
      return acknowledgement?.({ success: true, message });
    });

    onSafe('voice-room-join', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `voice-room:${socket.id}`, 10, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!permissionFor(user.username, user.roomId).voiceChat) return acknowledgement?.({ success: false, error: '您没有使用语音聊天的权限' });
      leaveLiveVoice(user, 'mode-change');
      user.voiceMode = 'room';
      user.voicePeerSocketId = '';
      const peers = voicePeersFor(user).map(publicUser);
      for (const peer of voicePeersFor(user)) io.to(peer.socketId).emit('voice-peer-joined', { peer: publicUser(user) });
      io.to(roomChannel(user.roomId)).emit('users-list', usersList(user.roomId));
      return acknowledgement?.({ success: true, mode: 'room', peers, message: '已加入全麦语音' });
    });

    onSafe('voice-call', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `voice-call:${socket.id}`, 3, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!permissionFor(user.username, user.roomId).voiceChat) return acknowledgement?.({ success: false, error: '您没有使用语音聊天的权限' });
      const targetUsername = cleanUsername(payload.username);
      if (!targetUsername || targetUsername === user.username) return acknowledgement?.({ success: false, error: '请选择其他在线成员进行私聊语音' });
      const sameRoomTarget = roomUsers(user.roomId).find((member) => member.username === targetUsername && member.connectionState === 'online');
      const friendTarget = state.accounts[user.username]?.friends?.includes(targetUsername) ? [...users.values()].find((member) => member.username === targetUsername && member.connectionState === 'online') : null;
      const target = sameRoomTarget || friendTarget;
      if (!target) return acknowledgement?.({ success: false, error: '对方当前不在线' });
      if (!permissionFor(target.username, target.roomId).voiceChat) return acknowledgement?.({ success: false, error: '对方没有语音聊天权限' });
      if (target.voiceMode) return acknowledgement?.({ success: false, error: '对方正在其他语音中，请稍后再试' });
      const call = {
        id: crypto.randomUUID(), roomId: user.roomId, callerSocketId: user.socketId, callerUsername: user.username,
        callerName: state.accounts[user.username]?.displayName || user.username, targetSocketId: target.socketId,
        targetUsername: target.username, createdAt: Date.now()
      };
      pendingVoiceCalls.set(call.id, call);
      const timer = setTimeout(() => {
        const pending = pendingVoiceCalls.get(call.id);
        if (!pending) return;
        pendingVoiceCalls.delete(call.id);
        io.to(pending.callerSocketId).emit('voice-call-resolved', {
          callId: pending.id,
          accepted: false,
          message: `${state.accounts[pending.targetUsername]?.displayName || pending.targetUsername} 未在 30 秒内接听私聊语音`
        });
      }, 30 * 1000); timer.unref?.();
      io.to(target.socketId).emit('voice-call-incoming', call);
      return acknowledgement?.({ success: true, callId: call.id, message: '私聊语音邀请已发送' });
    });

    onSafe('voice-call-response', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const call = pendingVoiceCalls.get(cleanText(payload.callId, 80));
      if (!call || call.targetSocketId !== user.socketId || Date.now() - call.createdAt > 30 * 1000) return acknowledgement?.({ success: false, error: '语音邀请已失效' });
      pendingVoiceCalls.delete(call.id);
      const caller = users.get(call.callerSocketId);
      const crossRoomFriends = caller && state.accounts[caller.username]?.friends?.includes(user.username) && state.accounts[user.username]?.friends?.includes(caller.username);
      if (!caller || (caller.roomId !== user.roomId && !crossRoomFriends)) return acknowledgement?.({ success: false, error: '邀请人已经离开房间' });
      if (payload.accepted !== true) {
        io.to(caller.socketId).emit('voice-call-resolved', { callId: call.id, accepted: false, message: `${state.accounts[user.username]?.displayName || user.username} 暂未接听私聊语音` });
        return acknowledgement?.({ success: true, accepted: false, message: '已拒绝语音邀请' });
      }
      leaveLiveVoice(caller, 'mode-change');
      leaveLiveVoice(user, 'mode-change');
      caller.voiceMode = 'private'; caller.voicePeerSocketId = user.socketId;
      user.voiceMode = 'private'; user.voicePeerSocketId = caller.socketId;
      io.to(caller.socketId).emit('voice-call-resolved', { callId: call.id, accepted: true, peer: publicUser(user), initiator: true, message: '对方已接听私聊语音' });
      io.to(user.socketId).emit('voice-call-resolved', { callId: call.id, accepted: true, peer: publicUser(caller), initiator: false, message: '私聊语音已接通' });
      io.to(roomChannel(user.roomId)).emit('users-list', usersList(user.roomId));
      return acknowledgement?.({ success: true, accepted: true, peer: publicUser(caller), message: '私聊语音已接通' });
    });

    onSafe('voice-signal', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `voice-signal:${socket.id}`, 300, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const targetSocketId = cleanText(payload.targetSocketId, 80);
      const target = users.get(targetSocketId);
      if (!target || !voicePeersFor(user).some((peer) => peer.socketId === targetSocketId)) {
        return acknowledgement?.({ success: false, error: '语音连接目标已离线或不在当前语音中' });
      }
      const signal = payload.description && typeof payload.description === 'object'
        ? { description: payload.description }
        : payload.candidate && typeof payload.candidate === 'object' ? { candidate: payload.candidate } : null;
      if (!signal) return acknowledgement?.({ success: false, error: '语音信令格式错误' });
      io.to(targetSocketId).emit('voice-signal', { fromSocketId: user.socketId, ...signal });
      return acknowledgement?.({ success: true });
    });

    onSafe('voice-leave', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      leaveLiveVoice(user, 'left');
      return acknowledgement?.({ success: true, message: '已退出实时语音' });
    });

    onSafe('screen-share-start', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (!permissionFor(user.username).shareScreen && !canControl(user)) return acknowledgement?.({ success: false, error: '只有房主、管理员或获授权成员可共享屏幕' });
      const runtime = roomRuntime();
      if (roomState.screenShare.active && roomState.screenShare.socketId !== socket.id) {
        const result = { success: false, error: `${roomState.screenShare.username} 正在共享屏幕`, screenShare: { ...roomState.screenShare } };
        acknowledgement?.(result);
        if (runtime.latestScreenFrame) setImmediate(() => queueScreenFrameForSocket(currentRoomId(), socket, runtime.latestScreenFrame));
        return;
      }
      const requestedSettings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
      const screenSettings = {
        resolution: cleanText(requestedSettings.resolution || 'native', 32) || 'native',
        fps: Math.max(5, Math.min(240, Math.round(Number(requestedSettings.requestedFps || requestedSettings.fps) || 60))),
        quality: ['balanced', 'high', 'ultra'].includes(requestedSettings.quality) ? requestedSettings.quality : 'ultra',
        systemAudio: requestedSettings.systemAudio !== false,
        actualFps: Math.max(0, Math.min(240, Math.round(Number(requestedSettings.actualFps) || 0))),
        actualWidth: Math.max(0, Math.min(16384, Math.round(Number(requestedSettings.actualWidth) || 0))),
        actualHeight: Math.max(0, Math.min(16384, Math.round(Number(requestedSettings.actualHeight) || 0))),
        hasAudio: requestedSettings.hasAudio === true,
        capabilities: Object.fromEntries(['mouse', 'keyboard', 'fileTransfer', 'sound', 'camera', 'remoteOpen'].map((key) => [key, Boolean(requestedSettings.capabilities?.[key])] ))
      };
      stopAudioShare('', user.roomId);
      roomState.screenShare = { active: true, socketId: socket.id, username: user.username, settings: screenSettings };
      if (roomState.webShare?.active) {
        roomState.webShare = { active: false, url: '', title: '', changedBy: user.username, updatedAt: Date.now(), revision: Math.max(0, Number(roomState.webShare.revision) || 0) + 1 };
        persist();
        io.to(roomChannel()).emit('web-share-state', { roomId: user.roomId, ...roomState.webShare, serverTime: Date.now() });
      }
      runtime.latestScreenFrame = null;
      runtime.screenFrameSequence = 0;
      runtime.screenFrameGeneration += 1;
      runtime.screenWebrtcViewers.clear();
      clearScreenFrameDeliveries(runtime);
      io.to(roomChannel()).emit('screen-share-started', { ...roomState.screenShare });
      socket.to(roomChannel()).emit('screen-share-webrtc-request', { sharerSocketId: socket.id });
      const fallbackViewerCount = emitScreenFallbackState(user.roomId);
      return acknowledgement?.({ success: true, screenShare: { ...roomState.screenShare }, fallbackViewerCount });
    });
    onSafe('screen-share-frame', (frame, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (roomState.screenShare.socketId !== socket.id) return acknowledgement?.({ success: false, error: '当前连接没有共享屏幕' });
      if (!permissionFor(user.username).shareScreen && !canControl(user)) { stopScreenShare(socket.id); return acknowledgement?.({ success: false, error: '屏幕共享权限已被收回' }); }
      const now = Date.now();
      if (now - Number(socket.data.lastScreenFrameAt || 0) < 70) return acknowledgement?.({ success: true, dropped: true });
      const runtime = roomRuntime();
      const packet = normalizeScreenFrame(frame, runtime);
      if (!packet) return acknowledgement?.({ success: false, error: '共享画面帧格式或大小无效' });
      socket.data.lastScreenFrameAt = now;
      runtime.latestScreenFrame = packet;
      const viewers = broadcastScreenFrame(currentRoomId(), packet);
      return acknowledgement?.({ success: true, sequence: packet.sequence, viewers });
    }, { allowAnyPayload: true });
    onSafe('screen-share-viewer-ready', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const sharerSocketId = roomState.screenShare.socketId;
      if (!sharerSocketId || sharerSocketId === socket.id) return acknowledgement?.({ success: false, error: '当前没有可连接的远程共享画面' });
      const sharer = users.get(sharerSocketId);
      if (!sharer || sharer.roomId !== user.roomId) return acknowledgement?.({ success: false, error: '共享者已离线' });
      io.to(sharerSocketId).emit('screen-share-viewer-ready', { viewerSocketId: socket.id });
      emitScreenFallbackState(user.roomId);
      return acknowledgement?.({ success: true });
    });
    onSafe('screen-share-transport-state', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const runtime = roomRuntime(user.roomId);
      const sharerSocketId = runtime.roomState.screenShare.socketId;
      if (!sharerSocketId || sharerSocketId === socket.id) return acknowledgement?.({ success: false, error: '当前没有可更新的共享画面传输' });
      if (payload.transport === 'webrtc') runtime.screenWebrtcViewers.add(socket.id);
      else runtime.screenWebrtcViewers.delete(socket.id);
      clearScreenFrameDelivery(runtime, socket.id);
      const fallbackViewerCount = emitScreenFallbackState(user.roomId);
      return acknowledgement?.({ success: true, transport: payload.transport === 'webrtc' ? 'webrtc' : 'fallback', fallbackViewerCount });
    });
    onSafe('screen-share-signal', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `screen-share-signal:${socket.id}`, 240, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const targetSocketId = cleanText(payload.targetSocketId, 80);
      const target = users.get(targetSocketId);
      const sharerSocketId = roomState.screenShare.socketId;
      if (!target || target.roomId !== user.roomId || !sharerSocketId
        || !([socket.id, targetSocketId].includes(sharerSocketId))) return acknowledgement?.({ success: false, error: '屏幕共享信令目标无效' });
      const description = payload.description && typeof payload.description === 'object'
        ? { type: cleanText(payload.description.type, 20), sdp: cleanText(payload.description.sdp, 200000) } : null;
      const candidate = payload.candidate && typeof payload.candidate === 'object'
        ? { candidate: cleanText(payload.candidate.candidate, 4000), sdpMid: cleanText(payload.candidate.sdpMid, 100), sdpMLineIndex: Number(payload.candidate.sdpMLineIndex) || 0 } : null;
      if (!description && !candidate) return acknowledgement?.({ success: false, error: '屏幕共享信令内容无效' });
      if (description && !['offer', 'answer'].includes(description.type)) return acknowledgement?.({ success: false, error: '屏幕共享信令类型无效' });
      if (description?.type === 'offer' && (socket.id !== sharerSocketId || targetSocketId === sharerSocketId)) return acknowledgement?.({ success: false, error: '只有共享者可以发送画面连接请求' });
      if (description?.type === 'answer' && (targetSocketId !== sharerSocketId || socket.id === sharerSocketId)) return acknowledgement?.({ success: false, error: '只有观看者可以回复画面连接请求' });
      io.to(targetSocketId).emit('screen-share-signal', { fromSocketId: socket.id, description, candidate });
      return acknowledgement?.({ success: true });
    });
    onSafe('audio-share-start', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement); if (!user) return;
      if (!permissionFor(user.username).shareAudio && !canControl(user)) return acknowledgement?.({ success: false, error: '当前账号没有共享电脑音源权限，请向房主或管理员申请' });
      if (roomState.screenShare.active) return acknowledgement?.({ success: false, error: '当前房间正在共享屏幕，请先停止屏幕共享' });
      if (roomState.audioShare?.active && roomState.audioShare.socketId !== socket.id) return acknowledgement?.({ success: false, error: `${roomState.audioShare.displayName || roomState.audioShare.username} 正在共享电脑音源` });
      const requestedPlatform = cleanText(payload.platform, 180);
      const platform = ['system', 'netease', 'qqmusic', 'kugou', 'qishui'].includes(requestedPlatform)
        || /^native:window:[\w-]+$/i.test(requestedPlatform) ? requestedPlatform : 'system';
      const metadata = sanitizeAudioSourceMetadata(payload);
      const volume = Math.max(0, Math.min(1, Number(payload.volume) || 0));
      roomState.audioShare = { active: true, socketId: socket.id, username: user.username, displayName: state.accounts[user.username]?.displayName || user.username, platform, ...metadata, volume };
      io.to(roomChannel()).emit('audio-share-state', { ...roomState.audioShare });
      socket.to(roomChannel()).emit('audio-share-webrtc-request', { sharerSocketId: socket.id });
      broadcastRoomNotice(user.roomId, `${roomState.audioShare.displayName} 开始共享电脑音源`, { kind: 'audio-share', actor: user.username });
      return acknowledgement?.({ success: true, audioShare: { ...roomState.audioShare } });
    });
    onSafe('audio-share-viewer-ready', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement); if (!user) return;
      const sharerSocketId = roomState.audioShare?.socketId;
      if (!roomState.audioShare?.active || !sharerSocketId || sharerSocketId === socket.id) return acknowledgement?.({ success: false, error: '当前没有可连接的电脑音源' });
      const sharer = users.get(sharerSocketId);
      if (!sharer || sharer.roomId !== user.roomId) return acknowledgement?.({ success: false, error: '音源共享者已离线' });
      io.to(sharerSocketId).emit('audio-share-viewer-ready', { viewerSocketId: socket.id });
      return acknowledgement?.({ success: true });
    });
    onSafe('audio-share-signal', (payload = {}, acknowledgement) => {
      if (socketRateLimited(socket, `audio-share-signal:${socket.id}`, 240, 60 * 1000, acknowledgement)) return;
      const user = socketUser(socket, acknowledgement); if (!user) return;
      const targetSocketId = cleanText(payload.targetSocketId, 80);
      const target = users.get(targetSocketId);
      const sharerSocketId = roomState.audioShare?.socketId;
      if (!roomState.audioShare?.active || !target || target.roomId !== user.roomId || !sharerSocketId
        || ![socket.id, targetSocketId].includes(sharerSocketId)) return acknowledgement?.({ success: false, error: '电脑音源信令目标无效' });
      const description = payload.description && typeof payload.description === 'object'
        ? { type: cleanText(payload.description.type, 20), sdp: cleanText(payload.description.sdp, 200000) } : null;
      const candidate = payload.candidate && typeof payload.candidate === 'object'
        ? { candidate: cleanText(payload.candidate.candidate, 4000), sdpMid: cleanText(payload.candidate.sdpMid, 100), sdpMLineIndex: Number(payload.candidate.sdpMLineIndex) || 0 } : null;
      if (!description && !candidate) return acknowledgement?.({ success: false, error: '电脑音源信令内容无效' });
      if (description && !['offer', 'answer'].includes(description.type)) return acknowledgement?.({ success: false, error: '电脑音源信令类型无效' });
      if (description?.type === 'offer' && (socket.id !== sharerSocketId || targetSocketId === sharerSocketId)) return acknowledgement?.({ success: false, error: '只有音源共享者可以发送连接请求' });
      if (description?.type === 'answer' && (targetSocketId !== sharerSocketId || socket.id === sharerSocketId)) return acknowledgement?.({ success: false, error: '只有音源观看者可以回复连接请求' });
      io.to(targetSocketId).emit('audio-share-signal', { fromSocketId: socket.id, description, candidate });
      return acknowledgement?.({ success: true });
    });
    onSafe('audio-share-update', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement); if (!user) return;
      if (!roomState.audioShare?.active || roomState.audioShare.socketId !== socket.id) return acknowledgement?.({ success: false, error: '当前连接没有共享电脑音源' });
      roomState.audioShare.volume = Math.max(0, Math.min(1, Number(payload.volume) || 0));
      io.to(roomChannel()).emit('audio-share-state', { ...roomState.audioShare });
      return acknowledgement?.({ success: true, audioShare: { ...roomState.audioShare } });
    });
    onSafe('audio-share-stop', (payload = {}, acknowledgement) => {
      if (!socketUser(socket, acknowledgement)) return;
      const stopped = stopAudioShare(socket.id);
      return acknowledgement?.({ success: stopped, message: stopped ? '已停止共享电脑音源' : '当前没有共享电脑音源' });
    });
    onSafe('screen-share-audio', (packet, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const sharingScreen = roomState.screenShare.socketId === socket.id;
      const sharingAudio = roomState.audioShare?.active && roomState.audioShare.socketId === socket.id;
      if (!sharingScreen && !sharingAudio) return acknowledgement?.({ success: false, error: '当前连接没有共享屏幕或电脑音源' });
      const data = packet?.data;
      const size = Buffer.isBuffer(data) ? data.length : data instanceof ArrayBuffer ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : 0;
      const sampleRate = Math.round(Number(packet?.sampleRate));
      const channels = Math.round(Number(packet?.channels));
      if (!size || size > SCREEN_AUDIO_LIMIT_BYTES || sampleRate < 8000 || sampleRate > 96000 || channels < 1 || channels > 2) return acknowledgement?.({ success: false, error: '共享音频数据无效' });
      socket.to(roomChannel()).emit('screen-share-audio', {
        data, sampleRate, channels, sequence: Math.max(0, Number(packet.sequence) || 0),
        sampleFormat: packet.sampleFormat === 's16' ? 's16' : 'f32',
        volume: sharingAudio ? roomState.audioShare.volume : 1,
        source: sharingAudio ? 'audio-share' : 'screen-share', latencyHint: 'interactive'
      });
      return acknowledgement?.({ success: true });
    }, { allowAnyPayload: true });
    onSafe('screen-share-stop', (payload = {}, acknowledgement) => {
      if (!socketUser(socket, acknowledgement)) return;
      stopScreenShare(socket.id);
      return acknowledgement?.({ success: true });
    });

    onSafe('toggle-lights', (payload, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const before = roomState.lightsOn;
      roomState.lightsOn = Boolean(payload);
      io.to(roomChannel()).emit('lights-status', roomState.lightsOn);
      if (before !== roomState.lightsOn) recordOperation({ actor: user.username, action: 'lights', summary: roomState.lightsOn ? '打开观影灯光' : '关闭观影灯光' });
      return acknowledgement?.({ success: true });
    }, { allowAnyPayload: true });

    onSafe('server-logs', async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const session = validSession(user.sessionToken, false);
      const allowed = Boolean(session?.isServerHost || isSuperAdmin(user.username));
      if (!allowed) return acknowledgement?.({ success: false, error: '只有超级管理员或服务器管理员可以查看服务器日志' });
      const query = cleanText(payload.query, 120).toLowerCase();
      const accountQuery = cleanText(payload.accountQuery, 120).toLowerCase();
      const category = String(payload.category || '').trim().toLowerCase();
      const level = String(payload.level || '').trim().toLowerCase();
      const limit = Math.max(20, Math.min(1000, Number(payload.limit) || 200));
      const logs = (Array.isArray(state.serverLogs) ? state.serverLogs : []).filter((entry) => {
        if (category && String(entry.category || '').toLowerCase() !== category) return false;
        if (level && String(entry.level || '').toLowerCase() !== level) return false;
        if (accountQuery && ![entry.actor, entry.actorName].some((value) => String(value || '').toLowerCase().includes(accountQuery))) return false;
        if (!query) return true;
        return [entry.actor, entry.actorName, entry.action, entry.summary, entry.roomId].some((value) => String(value || '').toLowerCase().includes(query));
      }).slice(-limit).reverse();
      return acknowledgement?.({ success: true, logs, categories: [...new Set((state.serverLogs || []).map((entry) => entry.category).filter(Boolean))] });
    });

    onSafe('operation-history', async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const roomOwner = user.username === state.room.ownerUsername;
      const limit = Math.max(20, Math.min(500, Number(payload.limit) || 200));
      const eligible = state.operations.filter((operation) => operation.roomId === currentRoomId()
        && (roomOwner || operation.actor === user.username));
      const beforeId = cleanText(payload.beforeId || payload.cursor || payload.before, 80);
      let end = eligible.length;
      if (beforeId) {
        end = eligible.findIndex((operation) => operation.id === beforeId);
        if (end < 0) return acknowledgement?.({ success: false, error: '操作历史游标无效或无权访问' });
      }
      const start = Math.max(0, end - limit);
      const operations = eligible.slice(start, end).reverse().map(publicOperation);
      const nextCursor = start > 0 && operations.length ? operations[operations.length - 1].id : '';
      return acknowledgement?.({
        success: true, operations, canManage: roomOwner, hasMore: start > 0,
        nextBeforeId: nextCursor, nextBefore: nextCursor, nextCursor
      });
    });

    onSafe('operation-history-delete', (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (socketRateLimited(socket, 'operation-history-delete', 10, 60 * 1000, acknowledgement)) return;
      const session = validSession(user.sessionToken, false);
      const canManageAll = Boolean(session?.isServerHost || session?.adminVerifiedAt || isSuperAdmin(user.username) || user.username === state.room.ownerUsername);
      if (!canManageAll) return acknowledgement?.({ success: false, error: '只有房主或服务器管理员可以删除操作历史' });
      const ids = new Set((Array.isArray(payload.operationIds) ? payload.operationIds : []).map((id) => cleanText(id, 80)).filter(Boolean).slice(0, 1000));
      if (!ids.size) return acknowledgement?.({ success: false, error: '请至少选择一条操作历史' });
      const before = state.operations.length;
      state.operations = state.operations.filter((operation) => !(operation.roomId === currentRoomId() && ids.has(operation.id)));
      const deleted = before - state.operations.length;
      if (!deleted) return acknowledgement?.({ success: false, error: '所选操作历史不存在或不属于当前房间' });
      persist();
      io.to(roomChannel()).emit('operation-history-changed');
      return acknowledgement?.({ success: true, deleted, message: `已删除 ${deleted} 条操作历史` });
    });

    onSafe('rollback-operation', async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      if (socketRateLimited(socket, 'operation-rollback', 20, 60 * 1000, acknowledgement)) return;
      const operation = state.operations.find((entry) => entry.id === cleanText(payload.operationId, 80));
      if (!operation || operation.roomId !== currentRoomId()) return acknowledgement?.({ success: false, error: '操作记录不存在或不属于当前房间' });
      if (operation.undone || !operation.undo) return acknowledgement?.({ success: false, error: '此操作不可回溯或已经回溯' });
      if (!operationUndoAvailable(operation)) return acknowledgement?.({ success: false, error: operation.undoExpiredAt || undoExpiry(operation) <= Date.now() ? '此操作已超过 30 天回溯期限' : '回溯所需文件已不存在' });
      const roomOwner = user.username === state.room.ownerUsername;
      if (operation.scope === 'server') {
        if (socketRateLimited(socket, 'admin', 20, 60 * 1000, acknowledgement)) return;
        const session = validSession(user.sessionToken);
        if (state.admin.mustChangePassword && !session?.isServerHost) return acknowledgement?.({ success: false, error: '服务器管理员密码尚未初始化' });
        if (!session?.adminVerifiedAt && !isSuperAdmin(user.username)) {
          if (!await verifyAdminAsync(payload.adminPassword)) return acknowledgement?.({ success: false, error: '服务器管理员密码错误' });
          session.adminVerifiedAt = Date.now();
        }
      } else if (!canUndoRoomOperation(user, operation)) return acknowledgement?.({ success: false, error: '没有回溯此操作的权限' });
      const undo = operation.undo;
      const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
      let changed = true;
      if (undo.kind === 'file-upload') {
        const file = findFile(undo.fileId);
        if (!file || file.roomId !== currentRoomId()) changed = false;
        else {
          if (!await cancelMediaWork(file)) { resumeMediaWork(file); changed = false; }
          else {
            state.files = state.files.filter((entry) => entry.id !== file.id); state.queue = state.queue.filter((id) => id !== file.id); removeFileArtifacts(file);
            io.to(roomChannel()).emit('file-deleted', file.id); io.to(roomChannel()).emit('queue-state', state.queue);
          }
        }
      } else if (undo.kind === 'file-delete') {
        if (findFile(undo.file?.id) || !restoreTrashArtifacts(undo.artifacts)) changed = false;
        else {
          state.files.push(undo.file);
          state.queue = (undo.queueBefore || []).filter((id) => state.files.some((file) => file.id === id && file.roomId === currentRoomId()));
          if (undo.playbackBefore) {
            roomState.playback = { ...undo.playbackBefore, updatedAt: Date.now(), revision: roomState.playback.revision + 1 };
            const textReading = resetTextReadingState(undo.file, user.username);
            io.to(roomChannel()).emit('text-reading-state', textReading);
          }
          if (mediaMetadataNeedsAnalysis(undo.file) && ffprobePath && fs.existsSync(ffprobePath)) enqueueMediaAnalysis(undo.file);
          else enqueueMediaCompatibility(undo.file, { retry: true });
          emitFileToVisible('file-uploaded', undo.file); io.to(roomChannel()).emit('queue-state', state.queue); io.to(roomChannel()).emit('playback-state', playbackSnapshot());
        }
      } else if (undo.kind === 'file-rename') {
        const file = findFile(undo.fileId);
        if (!file || file.roomId !== currentRoomId() || file.originalName !== undo.after) changed = false;
        else { file.originalName = undo.before; emitFileToVisible('file-updated', file); }
      } else if (undo.kind === 'queue') {
        if (!same(state.queue, undo.after)) changed = false;
        else { state.queue = [...undo.before]; io.to(roomChannel()).emit('queue-state', state.queue); }
      } else if (undo.kind === 'playback-mode') {
        if (!same(normalizePlaybackMode(state.room.playbackMode), normalizePlaybackMode(undo.after))) changed = false;
        else { state.room.playbackMode = normalizePlaybackMode(undo.before); io.to(roomChannel()).emit('room-state', roomSnapshot()); }
      } else if (undo.kind === 'owner-settings') {
        const current = { controlLocked: state.room.controlLocked, volumeSync: state.room.volumeSync, allowGuests: state.room.allowGuests !== false, permissions: JSON.parse(JSON.stringify(state.permissions)) };
        if (!same(current, undo.after)) changed = false;
        else {
          state.room.controlLocked = undo.before.controlLocked; state.room.volumeSync = undo.before.volumeSync; state.room.allowGuests = undo.before.allowGuests !== false; state.permissions = JSON.parse(JSON.stringify(undo.before.permissions));
          io.to(roomChannel()).emit('room-state', roomSnapshot()); io.to(roomChannel()).emit('users-list', usersList());
        }
      } else if (undo.kind === 'chat') {
        if (!restoreTrashArtifacts(undo.artifacts)) changed = false;
        else { await restoreChatMessages(undo.messages); io.to(roomChannel()).emit('chat-records-changed', { action: 'reset', ids: [] }); }
      } else if (undo.kind === 'room-password') {
        if (state.room.passwordHash !== undo.after) changed = false;
        else if (!undo.before && await tunnelPasswordPolicyActive()) return acknowledgement?.({ success: false, error: '公网访问开启期间不能回溯为无密码房间' });
        else {
          state.room.passwordHash = undo.before;
          if (currentRoomId() === state.defaultRoomId) state.admin.accessPasswordHash = undo.before;
          io.to(roomChannel()).emit('access-password-changed', { required: Boolean(undo.before) });
        }
      } else if (undo.kind === 'upload-limits') {
        const current = { uploadMinBytes: state.admin.uploadMinBytes, uploadLimitBytes: state.admin.uploadLimitBytes, uploadTimeLimitSeconds: state.admin.uploadTimeLimitSeconds, uploadVideoDurationLimitSeconds: state.admin.uploadVideoDurationLimitSeconds };
        if (!same(current, undo.after)) changed = false;
        else {
          Object.assign(state.admin, undo.before);
          for (const id of Object.keys(state.rooms)) io.to(roomChannel(id)).emit('upload-limits', { minUploadBytes: state.admin.uploadMinBytes, maxUploadBytes: state.admin.uploadLimitBytes, uploadTimeLimitSeconds: state.admin.uploadTimeLimitSeconds, uploadVideoDurationLimitSeconds: state.admin.uploadVideoDurationLimitSeconds });
        }
      } else if (undo.kind === 'room-settings') {
        const current = { name: state.room.name, maxUsers: state.room.maxUsers, requireUploadApproval: state.room.requireUploadApproval, allowGuests: state.room.allowGuests !== false };
        if (!same(current, undo.after)) changed = false;
        else { Object.assign(state.room, undo.before); io.to(roomChannel()).emit('room-state', roomSnapshot()); emitRoomDirectoryChanged(user.roomId, 'room-settings'); }
      } else if (undo.kind === 'permissions') {
        const current = state.permissions[undo.username] ? { ...state.permissions[undo.username] } : null;
        if (!same(current, undo.after)) changed = false;
        else {
          if (undo.before) state.permissions[undo.username] = { ...undo.before }; else delete state.permissions[undo.username];
          io.to(roomChannel()).emit('users-list', usersList());
        }
      } else if (undo.kind === 'upload-status') {
        const file = findFile(undo.fileId);
        if (!file || file.roomId !== currentRoomId() || file.status !== undo.after) changed = false;
        else {
          file.status = undo.before;
          const reassociated = reassociateSubtitles(currentRoomId());
          if (file.status !== 'approved') {
            state.queue = state.queue.filter((id) => id !== file.id);
            if (roomState.playback.fileId === file.id) {
              roomRuntime().playbackGeneration += 1;
              roomState.playback = {
                fileId: '', isPlaying: false, stalled: false, currentTime: 0, volume: roomState.playback.volume, muted: Boolean(roomState.playback.muted), playbackRate: roomState.playback.playbackRate || 1,
                updatedAt: Date.now(), changedBy: user.username, revision: roomState.playback.revision + 1
              };
            }
            io.to(roomChannel()).emit('file-deleted', file.id);
            io.to(roomChannel()).emit('queue-state', state.queue);
            io.to(roomChannel()).emit('playback-state', playbackSnapshot());
            emitFileToVisible('file-updated', file);
            if (file.status === 'pending') for (const ownerSocket of ownerSockets(currentRoomId())) ownerSocket.emit('upload-pending', publicFile(file));
          } else emitFileToVisible('file-updated', file);
          for (const subtitle of reassociated) if (subtitle.id !== file.id) emitFileToVisible('file-updated', subtitle);
        }
      } else if (undo.kind === 'display-name') {
        const account = state.accounts[undo.username];
        if (!account || account.displayName !== undo.after) changed = false;
        else {
          account.displayName = undo.before;
          try { await renameStoredChatDisplayName(undo.username, undo.before); }
          catch (error) { account.displayName = undo.after; throw error; }
          for (const id of Object.keys(state.rooms)) io.to(roomChannel(id)).emit('users-list', usersList(id));
        }
      } else if (undo.kind === 'account-delete') {
        if (state.accounts[undo.username]) changed = false;
        else {
          state.accounts[undo.username] = undo.account;
          state.deletedUsernames = state.deletedUsernames.filter((name) => name !== undo.username);
          for (const [id, permissions] of Object.entries(undo.permissions || {})) if (state.rooms[id]) state.rooms[id].permissions[undo.username] = permissions;
        }
      } else if (undo.kind === 'profile') {
        const account = state.accounts[undo.username];
        const current = account && { email: account.email, avatar: account.avatar, signature: account.signature || '', gender: account.gender || 'private', age: account.age || null };
        if (!account || !same(current, undo.after)) changed = false; else Object.assign(account, undo.before);
      } else if (undo.kind === 'playback') {
        const original = playbackChanges.find((item) => item.id === undo.changeId);
        const latestUndoable = [...playbackChanges].reverse().find((item) => item.generation === roomRuntime().playbackGeneration && item.action !== 'undo' && !item.undone);
        if (!original || original.undone || latestUndoable !== original || original.fileId !== roomState.playback.fileId) changed = false;
        else {
          roomState.playback = { ...roomState.playback, ...original.before, updatedAt: Date.now(), changedBy: user.username, revision: roomState.playback.revision + 1 };
          original.undone = true; original.undoneBy = user.username; original.undoneAt = Date.now();
          io.to(roomChannel()).emit('playback-state', playbackSnapshot());
        }
      } else if (undo.kind === 'select-file') {
        const previous = findFile(undo.beforeFileId);
        if (roomState.playback.fileId !== undo.afterFileId || !isSelectableFile(previous) || previous.roomId !== currentRoomId()) changed = false;
        else {
          roomRuntime().playbackGeneration += 1;
          roomState.playback = { fileId: previous.id, isPlaying: false, stalled: false, currentTime: 0, volume: roomState.playback.volume, muted: Boolean(roomState.playback.muted), playbackRate: roomState.playback.playbackRate || 1, updatedAt: Date.now(), changedBy: user.username, revision: roomState.playback.revision + 1 };
          const textReading = resetTextReadingState(previous, user.username);
          io.to(roomChannel()).emit('playback-state', playbackSnapshot());
          io.to(roomChannel()).emit('text-reading-state', textReading);
        }
      } else changed = false;
      if (!changed) return acknowledgement?.({ success: false, error: '当前数据已发生后续变化，为避免覆盖新操作，本次回溯已取消' });
      operation.undone = true; operation.undoneAt = new Date().toISOString(); operation.undoneBy = user.username;
      persist();
      recordOperation({ actor: user.username, action: 'operation-rollback', summary: `回溯操作：${operation.summary}`, scope: operation.scope });
      emitRoomDirectoryChanged(user.roomId, 'operation-rollback');
      broadcastRoomNotice(user.roomId, `${state.accounts[user.username]?.displayName || user.username} 已撤销“${operation.summary}”`, {
        kind: 'operation-rollback', actor: user.username, actorName: state.accounts[user.username]?.displayName || user.username,
        operationId: operation.id, important: true
      });
      io.to(roomChannel()).emit('operation-history-changed');
      return acknowledgement?.({ success: true, message: '操作已安全回溯' });
    });

    onSafe('admin-action', async (payload = {}, acknowledgement) => {
      const user = socketUser(socket, acknowledgement);
      if (!user) return;
      const action = String(payload.action || '');
      const session = validSession(user.sessionToken);
      const roomOwner = user.username === state.room.ownerUsername;
      const roomAdministrator = isRoomAdmin(user);
      const superAdmin = isSuperAdmin(user.username);
      let serverAdmin = Boolean(superAdmin || session?.adminVerifiedAt);
      // A plaintext admin password never grants a remote room owner server
      // control. It can only complete verification for an already established
      // server-host session (for example, the local host-token bootstrap).
      if (!serverAdmin && session?.isServerHost && String(payload.adminPassword || '')) {
        if (socketRateLimited(socket, 'admin', 20, 60 * 1000, acknowledgement)) return;
        serverAdmin = await verifyAdminAsync(payload.adminPassword);
        if (serverAdmin) session.adminVerifiedAt = Date.now();
      }
      const serverOnlyActions = new Set([
        'change-admin-password', 'set-upload-limits', 'set-mail-settings', 'test-mail-connection', 'test-mail-settings', 'restore-mail-template', 'reset-account-password',
        'delete-account', 'force-display-name', 'set-account-remark', 'unban', 'ban-user', 'approve-registration-request', 'deny-registration-request',
        'add-registration-whitelist', 'remove-registration-whitelist', 'set-branding', 'set-super-admin', 'set-room-creation-block',
        'set-account-level', 'set-room-ban', 'batch-room-action', 'delete-room', 'delete-rooms', 'factory-reset', 'set-password-policy', 'set-username-policy', 'set-admin-contact',
        'set-legal-agreement', 'set-admin-session-limit', 'set-local-passwordless-access', 'set-account-room-quota', 'resolve-room-quota-request', 'rename-room', 'set-marquee-notice', 'set-account-tier', 'save-account-tier', 'delete-account-tier', 'set-room-id-policy', 'set-public-password-policy',
        'set-upload-policy', 'set-text-upload-policy', 'resolve-upload-policy-request', 'set-experience-policy', 'set-default-account-password', 'set-account-password', 'batch-account-action', 'set-account-email', 'set-registration-account-notice',
        'set-blocked-words', 'set-lan-access', 'set-media-processing', 'set-login-cube-settings', 'set-login-cube-image', 'restart-server', 'get-account-audit-logs', 'delete-account-audit-logs',
        'set-account-number-policy', 'set-account-number', 'get-verification-codes', 'delete-verification-codes', 'set-verification-code-policy', 'unblock-verification-device', 'set-login-music', 'delete-login-music', 'set-login-video', 'delete-login-video', 'set-notice-preferences',
        'delete-room-files', 'set-media-upload-ban', 'get-ui-copy', 'set-ui-copy', 'import-ui-copy', 'export-ui-copy', 'reset-ui-copy',
        'resolve-login-limit-request', 'login-concurrency-policy', 'resolve-login-concurrency-request', 'revoke-login-concurrency', 'get-access-records', 'set-access-record-policy',
        'send-client-mode-request', 'cancel-client-mode-request', 'migrate-room', 'delete-registration-request', 'delete-registration-requests', 'get-account-overview', 'get-application-requests'
      ]);
      // Audit records and super-admin grants are account-wide operations and
      // require an actual logged-in super-admin. Email overrides retain the
      // existing verified server-admin password path for compatibility with
      // room-owner administration, while still requiring an authenticated
      // socket user and never exposing credentials.
      const superAdminOnlyActions = new Set(['set-super-admin']);
      if (!roomAdministrator && !serverAdmin) return acknowledgement?.({ success: false, error: String(payload.adminPassword || '') ? '服务器级设置只能由已登录的服务器主机或超级管理员执行' : '只有房主、房间管理员或服务器管理员可执行此操作' });
      if (serverOnlyActions.has(action) && !serverAdmin) return acknowledgement?.({ success: false, error: '请先登录超级管理员账号，或在服务器主机上登录后再执行此操作' });
      if (superAdminOnlyActions.has(action) && !superAdmin) return acknowledgement?.({ success: false, error: '此操作只允许已登录的超级管理员执行（仅 admin 或已授予的超级管理员）' });
      if (action === 'rename-room-id' && !serverAdmin && !(roomOwner && normalizeRoomId(payload.roomId) === currentRoomId())) {
        return acknowledgement?.({ success: false, error: '只有当前房主或超级管理员可以修改当前房间号' });
      }
      if (['get-ui-copy', 'export-ui-copy'].includes(action)) {
        const uiCopy = normalizeUiCopy(state.admin.uiCopy);
        const result = { success: true, version: UI_COPY_VERSION, uiCopy, entries: uiCopy };
        if (action === 'export-ui-copy') {
          result.filename = `SyncWatch-ui-copy-${APP_VERSION}.json`;
          result.json = JSON.stringify({ version: UI_COPY_VERSION, uiCopy }, null, 2);
        }
        return acknowledgement?.(result);
      }
      if (['set-ui-copy', 'import-ui-copy'].includes(action)) {
        let patch;
        try {
          patch = uiCopyPayload(action === 'import-ui-copy'
            ? (payload.json ?? payload.data ?? payload.entries ?? payload.uiCopy ?? payload.dictionary)
            : (payload.entries ?? payload.uiCopy ?? payload.dictionary));
        } catch (error) {
          return acknowledgement?.({ success: false, code: 'UI_COPY_INVALID', error: error.message || '文案字典无效' });
        }
        const before = normalizeUiCopy(state.admin.uiCopy);
        state.admin.uiCopy = normalizeUiCopy({ ...before, ...patch });
        state.admin.uiCopyUpdatedAt = new Date().toISOString();
        persist();
        const snapshot = { version: UI_COPY_VERSION, uiCopy: normalizeUiCopy(state.admin.uiCopy), entries: normalizeUiCopy(state.admin.uiCopy), updatedAt: state.admin.uiCopyUpdatedAt };
        recordOperation({ actor: user.username, action: action === 'import-ui-copy' ? 'ui-copy-import' : 'ui-copy-update', summary: action === 'import-ui-copy' ? '导入统一界面文案' : '更新统一界面文案', scope: 'server' });
        io.emit('ui-copy-state', snapshot);
        return acknowledgement?.({ success: true, ...snapshot, message: action === 'import-ui-copy' ? '界面文案已导入并同步' : '界面文案已保存并同步' });
      }
      if (action === 'reset-ui-copy') {
        state.admin.uiCopy = defaultUiCopy();
        state.admin.uiCopyUpdatedAt = new Date().toISOString();
        persist();
        const snapshot = { version: UI_COPY_VERSION, uiCopy: normalizeUiCopy(state.admin.uiCopy), entries: normalizeUiCopy(state.admin.uiCopy), updatedAt: state.admin.uiCopyUpdatedAt };
        recordOperation({ actor: user.username, action: 'ui-copy-reset', summary: '恢复默认界面文案', scope: 'server' });
        io.emit('ui-copy-state', snapshot);
        return acknowledgement?.({ success: true, ...snapshot, message: '界面文案已恢复默认并同步' });
      }
      const onlineSessionsByUsername = new Map();
      for (const member of users.values()) {
        const list = onlineSessionsByUsername.get(member.username) || [];
        list.push({ roomId: member.roomId, socketId: member.socketId, deviceName: member.deviceName, platform: member.platform,
          browser: member.browser, ipAddress: member.ipAddress, joinedAt: member.joinedAt, connectionState: member.connectionState,
          latency: member.latency, syncPercent: member.syncPercent, location: member.location || null });
        onlineSessionsByUsername.set(member.username, list);
      }
      if (action === 'get-account-overview') {
        if (!serverAdmin) return acknowledgement?.({ success: false, error: '只有服务器管理员可以查看账号总览' });
        const limit = Math.max(1, Math.min(1000, Number(payload.limit) || 500));
        const accounts = Object.keys(state.accounts).sort((left, right) => left.localeCompare(right, 'zh-CN')).slice(0, limit).map((username) => {
          const profile = accountProfile(username);
          const account = state.accounts[username] || {};
          const latestDevice = account.devices?.[0] || {};
          const latestLogin = account.loginHistory?.[0] || {};
          return {
            ...profile, history: undefined, favoriteFiles: undefined, myFiles: undefined,
            registrationIp: account.registrationIp || '', lastIp: latestLogin.ip || '',
            deviceName: latestDevice.name || latestLogin.device || '', platform: latestDevice.platform || '', browser: latestDevice.browser || '',
            loginHistory: Array.isArray(account.loginHistory) ? account.loginHistory.slice(0, 20) : [],
             onlineSessions: onlineSessionsByUsername.get(username) || [],
            adminRemark: cleanText(account.adminRemark, 80),
            passwordStatus: {
              configured: Boolean(account.passwordHash), changedAt: account.passwordChangedAt || account.createdAt || '',
              mustChange: Boolean(account.mustChangePassword), expired: passwordExpired(username)
            },
            superAdmin: user.username === 'admin' ? Boolean(account.superAdmin) : username === user.username && Boolean(account.superAdmin),
            mustChangePassword: Boolean(account.mustChangePassword), roomCreationBlocked: Boolean(account.roomCreationBlocked),
            roomQuota: account.roomQuota, ownedRoomCount: ownedRooms(username).length, multiDeviceLogin: concurrentLoginAllowed(username), loginSessionLimit: accountSessionLimit(username)
          };
        });
        return acknowledgement?.({ success: true, accounts });
      }
      if (action === 'get-application-requests') {
        if (!serverAdmin) return acknowledgement?.({ success: false, error: '只有服务器管理员可以读取全部申请' });
        const currentRoom = currentRoomId();
        return acknowledgement?.({ success: true, applications: {
          pendingFiles: state.files.filter((file) => file.roomId === currentRoom && file.status === 'pending').map(publicFile),
          registrationRequests: state.admin.registrationRequests.map(normalizeRegistrationRequestCounts).reverse(),
          roomQuotaRequests: state.admin.roomQuotaRequests.slice().reverse(),
          loginLimitRequests: user.username === 'admin' ? state.admin.loginLimitRequests.slice().reverse() : [],
          loginConcurrencyRequests: user.username === 'admin' ? (state.admin.loginConcurrencyRequests || []).slice().reverse() : [],
          uploadPolicyRequests: state.admin.uploadPolicyRequests.filter((entry) => serverAdmin || entry.roomId === currentRoom).slice().reverse(),
          storageQuotaRequests: state.admin.storageQuotaRequests.filter((entry) => serverAdmin || entry.roomId === currentRoom).slice().reverse(),
          mediaManagementRequests: state.admin.mediaManagementRequests.filter((entry) => serverAdmin || entry.roomId === currentRoom).slice().reverse(),
          roomCopyRequests: state.admin.roomCopyRequests.filter((entry) => serverAdmin || entry.sourceOwner === user.username || entry.requestedBy === user.username).slice().reverse(),
          clientModeRequests: (state.admin.clientModeRequests || []).slice().reverse().map(clientModeRequestPayload)
        }});
      }
      if (action === 'get-settings') {
       return acknowledgement?.({ success: true, admin: {
        serverAdmin, superAdmin, roomOwner, roomAdministrator, canManageSuperAdmins: user.username === 'admin',
        uploadMinBytes: state.admin.uploadMinBytes, uploadLimitBytes: state.admin.uploadLimitBytes, uploadTimeLimitSeconds: state.admin.uploadTimeLimitSeconds, uploadVideoDurationLimitSeconds: state.admin.uploadVideoDurationLimitSeconds,
        allowedUploadCategories: allowedUploadCategories(), allowTextUploads: state.admin.allowTextUploads !== false, blockedWords: serverAdmin ? normalizeBlockedWords(state.admin.blockedWords) : [], roomStorageLimitBytes: Math.max(0, Number(state.room.storageLimitBytes) || 0),
        branding: normalizeBranding(state.admin.branding), uiCopy: normalizeUiCopy(state.admin.uiCopy), loginCube: normalizeLoginCubeSettings(state.admin.loginCube), loginMusic: normalizeLoginMusic(state.admin.loginMusic), loginVideo: normalizeLoginVideo(state.admin.loginVideo), marqueeNotice: normalizeMarqueeNotice(state.admin.marqueeNotice),
        f11PromptEnabled: state.admin.f11PromptEnabled !== false,
        initialPasswordReminderEnabled: state.admin.initialPasswordReminderEnabled !== false,
        downloadButtonsVisible: state.admin.downloadButtonsVisible !== false,
        locationStatusNoticesEnabled: state.admin.locationStatusNoticesEnabled !== false,
        locationAuthorizationRequestsEnabled: state.admin.locationAuthorizationRequestsEnabled !== false,
        roomEntryNotice: normalizeRoomEntryNotice(state.admin.roomEntryNotice),
        roomEntryNoticeTargets: Object.values(state.rooms)
          .filter((entry) => visibleRoom(entry) && (serverAdmin || entry.ownerUsername === user.username))
          .map((entry) => ({
            id: entry.id, name: entry.name, ownerUsername: entry.ownerUsername,
            notice: entry.entryNotice ? normalizeRoomEntryNotice(entry.entryNotice) : null,
            effectiveNotice: effectiveRoomEntryNotice(entry.id)
          })),
        contact: normalizeAdminContact(state.admin.contact), legalAgreement: normalizeLegalAgreement(state.admin.legalAgreement),
        passwordPolicy: normalizePasswordPolicy(state.admin.passwordPolicy), usernamePolicy: normalizeUsernamePolicy(state.admin.usernamePolicy), roomIdPolicy: normalizeRoomIdPolicy(state.admin.roomIdPolicy), accountNumberPolicy: normalizeAccountNumberPolicy(state.admin.accountNumberPolicy), verificationCodePolicy: normalizeVerificationCodePolicy(state.admin.verificationCodePolicy), adminMaxConcurrentSessions: adminSessionLimit(),
        requireRoomPasswordForPublicAccess: state.admin.requireRoomPasswordForPublicAccess === true,
        loginPolicy: serverAdmin ? loginPolicy() : { ...loginPolicy(), accountSessionWhitelistIps: [], guestIpWhitelistIps: [] },
        lanAccessEnabled: state.admin.lanAccessEnabled !== false,
        localPasswordlessManagementEnabled: state.admin.localPasswordlessManagementEnabled !== false,
        localPasswordlessRoomEnabled: state.admin.localPasswordlessRoomEnabled !== false,
        mediaCompatibilityAutoConvert: state.admin.mediaCompatibilityAutoConvert !== false,
        mediaCompatibilityConcurrency: mediaCompatibilityConcurrency(),
        mail: serverAdmin ? publicMailSettings() : { enabled: mailRecoveryAvailable('account') || mailRecoveryAvailable('admin'), configured: mailRecoveryAvailable('account') || mailRecoveryAvailable('admin'), user: '', fromName: '' },
        defaultPermissions: state.admin.defaultPermissions, requireUploadApproval: state.room.requireUploadApproval,
         roomId: currentRoomId(), roomName: state.room.name, roomOwnerUsername: state.room.ownerUsername || '', maxUsers: state.room.maxUsers, allowGuests: state.room.allowGuests !== false, roomPasswordRequired: Boolean(state.room.passwordHash),
        blacklist: serverAdmin ? state.blacklist : [], permissions: state.permissions,
        permissionGroups: state.room.permissionGroups, memberGroups: state.room.memberGroups,
         registrationIpWhitelist: serverAdmin ? state.admin.registrationIpWhitelist : [],
         registrationAccountNoticeEnabled: serverAdmin && state.admin.registrationAccountNoticeEnabled !== false,
         verificationCodes: serverAdmin ? state.verificationCodeRecords.slice(-5000).reverse() : [],
        registrationRequests: serverAdmin ? state.admin.registrationRequests.map(normalizeRegistrationRequestCounts).reverse() : [],
        loginLimitRequests: user.username === 'admin' ? state.admin.loginLimitRequests.slice().reverse() : [],
        accessRecords: user.username === 'admin' ? (state.admin.accessRecords || []).slice(-5000).reverse() : [],
        loginConcurrencyRequests: user.username === 'admin' ? (state.admin.loginConcurrencyRequests || []).slice().reverse() : [],
        clientModeRequests: serverAdmin ? (state.admin.clientModeRequests || []).slice().reverse().map(clientModeRequestPayload) : [],
        roomCopyRequests: state.admin.roomCopyRequests
          .filter((entry) => serverAdmin || entry.sourceOwner === user.username || entry.requestedBy === user.username)
          .slice().reverse(),
        roomQuotaRequests: serverAdmin ? state.admin.roomQuotaRequests.slice().reverse() : [],
        uploadPolicyRequests: serverAdmin ? state.admin.uploadPolicyRequests.slice().reverse() : [],
        mediaManagementRequests: state.admin.mediaManagementRequests
          .filter((entry) => serverAdmin || entry.roomId === currentRoomId()).slice().reverse(),
        storageQuotaRequests: state.admin.storageQuotaRequests
          .filter((entry) => serverAdmin || entry.roomId === currentRoomId()).slice().reverse(),
        watchLevels: WATCH_LEVELS, experiencePerMinute: Math.max(0, Math.floor(Number(state.admin.experiencePerMinute) || 0)),
        accountTiers: serverAdmin ? state.admin.accountTiers : {},
        defaultAccountPasswordConfigured: serverAdmin && Boolean(state.admin.defaultAccountPasswordHash),
        rooms: serverAdmin ? Object.values(state.rooms).filter(visibleRoom).map((entry) => roomDirectorySummary(entry)) : [],
        pendingFiles: state.files.filter((file) => file.roomId === currentRoomId() && file.status === 'pending').map(publicFile),
        accounts: (serverAdmin ? Object.keys(state.accounts) : [...new Set(roomUsers().map((member) => member.username).concat(state.room.ownerUsername).filter(Boolean))]).sort()
          .map((username) => {
            const profile = accountProfile(username);
            const account = state.accounts[username] || {};
            const latestDevice = account.devices?.[0] || {};
            const latestLogin = account.loginHistory?.[0] || {};
            return {
              ...profile, history: undefined, favoriteFiles: undefined, myFiles: undefined,
              registrationIp: account.registrationIp || '', lastIp: latestLogin.ip || '',
              deviceName: latestDevice.name || latestLogin.device || '', platform: latestDevice.platform || '', browser: latestDevice.browser || '',
              loginHistory: Array.isArray(account.loginHistory) ? account.loginHistory.slice(0, 20) : [],
               onlineSessions: onlineSessionsByUsername.get(username) || [],
              adminRemark: cleanText(account.adminRemark, 80),
              passwordStatus: serverAdmin ? {
                configured: Boolean(account.passwordHash), changedAt: account.passwordChangedAt || account.createdAt || '',
                mustChange: Boolean(account.mustChangePassword), expired: passwordExpired(username)
              } : undefined,
              superAdmin: user.username === 'admin' ? Boolean(account.superAdmin) : username === user.username && Boolean(account.superAdmin),
              mustChangePassword: Boolean(account.mustChangePassword), roomCreationBlocked: Boolean(account.roomCreationBlocked),
              roomQuota: account.roomQuota, ownedRoomCount: ownedRooms(username).length, multiDeviceLogin: concurrentLoginAllowed(username), loginSessionLimit: accountSessionLimit(username)
            };
          })
       } });
      }
      if (action === 'migrate-room') {
        if (!serverAdmin) return acknowledgement?.({ success: false, error: '只有服务器主机或超级管理员可以迁移覆盖房间' });
        const sourceRoomId = normalizeRoomId(payload.sourceRoomId);
        const targetRoomId = normalizeRoomId(payload.targetRoomId);
        const sourceRoom = sourceRoomId && state.rooms[sourceRoomId];
        const targetRoom = targetRoomId && state.rooms[targetRoomId];
        if (!visibleRoom(sourceRoom) || sourceRoom.temporary || sourceRoom.systemRoom) return acknowledgement?.({ success: false, error: '源房间不存在或不能迁移' });
        if (!visibleRoom(targetRoom) || targetRoom.temporary || targetRoom.systemRoom) return acknowledgement?.({ success: false, error: '目标房间不存在或不能被覆盖' });
        if (sourceRoomId === targetRoomId) return acknowledgement?.({ success: false, error: '源房间和目标房间不能相同' });
        const requiredConfirmation = `迁移覆盖 ${targetRoomId}`;
        if (cleanText(payload.confirmation, 80) !== requiredConfirmation) {
          return acknowledgement?.({ success: false, code: 'ROOM_MIGRATION_CONFIRMATION_REQUIRED', requiredConfirmation, error: `请完整输入“${requiredConfirmation}”确认覆盖目标房间` });
        }
        try {
          const copied = await copyRoomDataTransactional({
            sourceRoomId, targetRoomId, targetOwner: targetRoom.ownerUsername,
            requestedRoomName: payload.targetRoomName || sourceRoom.name, overwrite: true, actor: user.username
          });
          return acknowledgement?.({
            success: true, sourceRoomId, targetRoomId, ...copied,
            message: `已将 ${sourceRoomId} 的配置、数据和媒体复制覆盖到 ${targetRoomId}；源房间未被修改`
          });
        } catch (error) {
          return acknowledgement?.({ success: false, code: 'ROOM_MIGRATION_FAILED', error: `房间迁移失败，目标已回滚：${cleanText(error.message, 180)}` });
        }
      }
      if (action === 'convert-temporary-room') {
        const roomIdValue = normalizeRoomId(payload.roomId) || currentRoomId();
        const targetRoom = state.rooms[roomIdValue];
        if (!targetRoom) return acknowledgement?.({ success: false, error: '临时房间不存在' });
        if (!serverAdmin && roomIdValue !== currentRoomId()) return acknowledgement?.({ success: false, error: '房间管理员只能转换当前所在的临时房间' });
        if (!targetRoom.temporary) return acknowledgement?.({ success: true, room: roomSnapshot(roomIdValue), message: '当前房间已经是正式房间' });
        const name = cleanText(payload.name || targetRoom.name, 40);
        if (!name) return acknowledgement?.({ success: false, error: '请输入正式房间名称' });
        const roomIdMode = ['custom', 'random'].includes(payload.roomIdMode) ? payload.roomIdMode : 'keep';
        let finalRoomId = roomIdValue;
        if (roomIdMode === 'custom') {
          const requestedRoomId = cleanText(payload.newRoomId, 32).trim().toUpperCase();
          const validatedRoomId = validateCustomRoomId(requestedRoomId, state.admin.roomIdPolicy);
          if (!validatedRoomId || validatedRoomId !== requestedRoomId) {
            const policy = normalizeRoomIdPolicy(state.admin.roomIdPolicy);
            const description = policy.enabled
              ? `${policy.minLength}-${policy.maxLength} 位，规则：${policy.mode === 'custom' ? '自定义正则' : policy.mode}`
              : '4-32 位大写字母或数字';
            return acknowledgement?.({ success: false, error: `正式房间号不符合服务器规则：${description}` });
          }
          finalRoomId = validatedRoomId;
        } else if (roomIdMode === 'random') {
          do { finalRoomId = roomId(); } while (state.rooms[finalRoomId]);
        }
        if (finalRoomId !== roomIdValue) {
          const renamed = await renameRoomIdForAdmin(roomIdValue, finalRoomId, user.username, 'room-convert-id-changed');
          if (!renamed.success) return acknowledgement?.(renamed);
        }
        if (payload.passwordProvided === true) {
          const password = String(payload.roomPassword || '');
          if (password.length > 72) return acknowledgement?.({ success: false, error: '房间密码不能超过 72 位' });
          targetRoom.passwordHash = password ? await makePasswordHashAsync(password) : '';
          targetRoom.accessRevision = Math.max(1, Number(targetRoom.accessRevision) || 1) + 1;
        }
        targetRoom.name = name;
        targetRoom.temporary = false;
        targetRoom.createdBy = targetRoom.createdBy || user.username;
        targetRoom.closed = false;
        targetRoom.closedAt = '';
        targetRoom.lastActivityAt = new Date().toISOString();
        const ownerAccount = state.accounts[targetRoom.ownerUsername];
        if (ownerAccount) ownerAccount.stats.createdRooms = Math.max(0, Number(ownerAccount.stats.createdRooms) || 0) + 1;
        rememberRecentRoom(targetRoom.ownerUsername || user.username, finalRoomId);
        rememberRoomAccess(targetRoom.ownerUsername || user.username, targetRoom);
        for (const member of roomUsers(finalRoomId)) {
          const memberSession = validSession(member.sessionToken, false);
          if (memberSession) memberSession.roomAccessRevision = targetRoom.accessRevision;
        }
        persist();
        recordOperation({ roomId: finalRoomId, actor: user.username, action: 'room-convert', summary: `临时房间转为正式房间：${name}（${finalRoomId}）` });
        io.to(roomChannel(finalRoomId)).emit('room-state', roomSnapshot(finalRoomId));
        broadcastRoomNotice(finalRoomId, `${state.accounts[user.username]?.displayName || user.username} 已将当前临时房间转为正式房间`, { kind: 'room-converted', actor: user.username, important: true });
        return acknowledgement?.({ success: true, room: roomSnapshot(finalRoomId), message: `临时房间已转为正式房间，房间号：${finalRoomId}` });
      }
      if (action === 'set-access-password') {
        const value = String(payload.accessPassword || '');
        if (value.length > 72) return acknowledgement?.({ success: false, error: '访问密码不能超过 72 位' });
        if (!value && await tunnelPasswordPolicyActive()) return acknowledgement?.({ success: false, error: '公网访问开启期间不能关闭任何房间的访问密码' });
        const before = state.room.passwordHash;
        state.room.passwordHash = value ? await makePasswordHashAsync(value) : '';
        if (value) state.room.passwordEnforcementRequired = false;
        state.room.accessRevision = Math.max(1, Number(state.room.accessRevision) || 1) + 1;
        if (currentRoomId() === state.defaultRoomId) state.admin.accessPasswordHash = state.room.passwordHash;
        for (const member of roomUsers()) {
          const memberSession = validSession(member.sessionToken, false);
          if (!memberSession) continue;
          if (!value || canBypassRoomPassword(member.username, state.room) || member.socketId === socket.id) memberSession.roomAccessRevision = state.room.accessRevision;
          else {
            memberSession.roomAccessRevision = 0;
            io.to(member.socketId).emit('room-password-verification-required', {
              roomId: state.room.id, message: '房间密码已更新，请输入新密码后继续观看'
            });
          }
        }
        persist();
        recordOperation({ actor: user.username, action: 'room-password', summary: value ? '设置房间密码' : '关闭房间密码', undo: { kind: 'room-password', before, after: state.room.passwordHash } });
        io.to(roomChannel()).emit('access-password-changed', { required: Boolean(value) });
        broadcastRoomNotice(user.roomId, value ? `${state.accounts[user.username]?.displayName || user.username} 已更新房间密码，当前成员需要重新验证` : `${state.accounts[user.username]?.displayName || user.username} 已关闭房间密码`, { kind: 'room-password', actor: user.username, important: Boolean(value) });
        return acknowledgement?.({ success: true, message: value ? '房间密码已设置' : '房间密码已关闭' });
      }
      if (action === 'change-admin-password') {
        const value = String(payload.newAdminPassword || '');
        const passwordError = passwordPolicyError(value, { administrator: true });
        if (passwordError) return acknowledgement?.({ success: false, error: passwordError });
        const nextHash = await makePasswordHashAsync(value);
        setAdminPasswordHash(nextHash); state.admin.mustChangePassword = false;
        if (state.accounts.admin) {
          state.accounts.admin.passwordHash = nextHash;
          state.accounts.admin.mustChangePassword = false;
          state.accounts.admin.passwordChangedAt = state.admin.passwordChangedAt;
        }
        clearAdminVerification(session);
        clearPasswordResetState('admin');
        persist();
        recordOperation({ actor: user.username, action: 'admin-password', summary: '修改服务器管理员密码', scope: 'server' });
        return acknowledgement?.({ success: true, message: '管理员密码已修改' });
      }
      if (action === 'set-public-password-policy') {
        const enabled = payload.enabled === true;
        state.admin.requireRoomPasswordForPublicAccess = enabled;
        const pendingRooms = [];
        for (const room of Object.values(state.rooms).filter((entry) => visibleRoom(entry) && !entry.archived)) {
          room.passwordEnforcementRequired = Boolean(enabled && !room.passwordHash);
          if (!room.passwordEnforcementRequired) continue;
          pendingRooms.push(room.id);
          const ownerOnline = roomUsers(room.id).some((member) => member.username === room.ownerUsername);
          if (ownerOnline) {
            accountChangeNotice(room.ownerUsername, { kind: 'room-password-required', roomId: room.id, message: `服务器要求为房间“${room.name}”设置访问密码；设置前房主无法控制播放` });
          }
          io.to(roomChannel(room.id)).emit('room-state', roomSnapshot(room.id));
        }
        persist();
        recordOperation({ actor: user.username, action: 'public-password-policy', summary: `${enabled ? '开启' : '关闭'}公网房间密码限制`, scope: 'server' });
        return acknowledgement?.({
          success: true, enabled, pendingRooms,
          message: enabled ? `已要求 ${pendingRooms.length} 个未加密房间的房主设置访问密码；房主离线时不影响当前成员` : '已取消公网房间强制密码限制'
        });
      }
      if (action === 'set-experience-policy') {
        const value = Number(payload.experiencePerMinute);
        if (!Number.isFinite(value) || value < 0 || value > 1000 || !Number.isInteger(value)) return acknowledgement?.({ success: false, error: '每分钟经验必须是 0-1000 的整数' });
        state.admin.experiencePerMinute = value;
        persist();
        recordOperation({ actor: user.username, action: 'experience-policy', summary: `更新观影经验规则：每分钟 ${value} 经验`, scope: 'server' });
        io.emit('experience-policy-updated', { experiencePerMinute: value });
        return acknowledgement?.({ success: true, experiencePerMinute: value, message: `经验规则已更新：观看一分钟获得 ${value} 经验` });
      }
      if (action === 'set-blocked-words') {
        state.admin.blockedWords = normalizeBlockedWords(payload.blockedWords);
        persist();
        recordOperation({ actor: user.username, action: 'blocked-words', summary: `更新服务器屏蔽词：${state.admin.blockedWords.length} 个`, scope: 'server' });
        return acknowledgement?.({
          success: true, blockedWords: state.admin.blockedWords,
          message: state.admin.blockedWords.length ? `已启用 ${state.admin.blockedWords.length} 个屏蔽词` : '已清空服务器屏蔽词'
        });
      }
      if (action === 'set-branding') {
        const owner = cleanText(payload.owner, 60);
        const notice = cleanText(payload.notice, 240);
        if (!owner) return acknowledgement?.({ success: false, error: '版权所有者名称不能为空' });
        state.admin.branding = normalizeBranding({ owner, notice: notice || `版权所有 © ${owner}，保留所有权利。` });
        persist();
        recordOperation({ actor: user.username, action: 'branding', summary: `更新版权所有者：${state.admin.branding.owner}`, scope: 'server' });
        io.emit('branding-updated', state.admin.branding);
        return acknowledgement?.({ success: true, branding: state.admin.branding, message: '版权信息已保存并同步到所有客户端' });
      }
      if (action === 'set-login-cube-settings') {
        const previous = normalizeLoginCubeSettings(state.admin.loginCube);
        const next = normalizeLoginCubeSettings({
          autoRotate: payload.autoRotate,
          inertia: payload.inertia,
          rotationSpeed: payload.rotationSpeed,
          displayMode: payload.displayMode,
          rotationDirection: payload.rotationDirection,
          faces: payload.faces,
          model: previous.model,
          updatedAt: new Date().toISOString()
        }, previous);
        for (const oldFace of previous.faces) {
          const nextFace = next.faces.find((face) => face.id === oldFace.id);
          if (oldFace.image.startsWith(`/login-cube-image/${oldFace.id}`) && nextFace?.image !== oldFace.image) removeLoginCubeFaceFiles(oldFace.id);
        }
        state.admin.loginCube = next;
        persist();
        io.emit('login-cube-updated', next);
        recordOperation({ actor: user.username, action: 'login-cube-settings', summary: '更新登录页 3D 立方体六面内容与旋转设置', scope: 'server' });
        return acknowledgement?.({ success: true, loginCube: next, message: '登录立方体设置已保存并同步到所有访问端' });
      }
      if (action === 'set-login-cube-image') {
        const faceId = cleanText(payload.faceId, 16).toLowerCase();
        if (!LOGIN_CUBE_FACE_IDS.includes(faceId)) return acknowledgement?.({ success: false, error: '立方体面标识无效' });
        let decoded;
        try { decoded = decodeLoginCubeImage(payload.dataUrl); }
        catch (error) { return acknowledgement?.({ success: false, error: error.message }); }
        fs.mkdirSync(loginCubeDir, { recursive: true });
        const target = path.join(loginCubeDir, `${faceId}.${decoded.extension}`);
        const temporary = path.join(loginCubeDir, `.${faceId}-${process.pid}-${Date.now()}.tmp`);
        const oldFiles = ['png', 'jpg', 'webp', 'gif']
          .map((extension) => path.join(loginCubeDir, `${faceId}.${extension}`))
          .filter((filename) => fs.existsSync(filename));
        const backups = oldFiles.map((filename, index) => ({
          filename,
          backup: path.join(loginCubeDir, `.${faceId}-backup-${process.pid}-${Date.now()}-${index}.tmp`)
        }));
        let installed = false;
        try {
          // Stage the replacement before moving the current image aside. A
          // failed disk write must leave the previous face image usable.
          fs.writeFileSync(temporary, decoded.buffer, { flag: 'wx', mode: 0o600 });
          for (const entry of backups) fs.renameSync(entry.filename, entry.backup);
          fs.renameSync(temporary, target);
          installed = true;
        } catch (error) {
          fs.rmSync(temporary, { force: true });
          if (!installed) {
            fs.rmSync(target, { force: true });
            for (const entry of backups) {
              if (fs.existsSync(entry.backup)) {
                try { fs.renameSync(entry.backup, entry.filename); } catch (_) {}
              }
            }
          }
          return acknowledgement?.({ success: false, error: `保存立方体图片失败：${error.message}` });
        }
        for (const entry of backups) {
          try { fs.rmSync(entry.backup, { force: true }); } catch (_) {}
        }
        const image = `/login-cube-image/${faceId}?v=${Date.now()}`;
        const loginCube = updateLoginCubeFaceImage(faceId, image);
        recordOperation({ actor: user.username, action: 'login-cube-image', summary: `更新登录立方体 ${faceId} 面图片`, scope: 'server' });
        return acknowledgement?.({ success: true, faceId, image, loginCube, message: '立方体图片已上传并同步' });
      }
      if (action === 'set-password-policy') {
        if (!PASSWORD_POLICY_MODES.has(payload.mode)) return acknowledgement?.({ success: false, error: '密码规则类型无效' });
        const passwordLengthRestricted = Object.prototype.hasOwnProperty.call(payload, 'lengthRestricted')
          ? payload.lengthRestricted === true
          : ['minLength', 'maxLength'].some((key) => Object.prototype.hasOwnProperty.call(payload, key));
        const policy = normalizePasswordPolicy({
          mode: payload.mode, lengthRestricted: passwordLengthRestricted,
          minLength: payload.minLength, maxLength: payload.maxLength, expiryDays: payload.expiryDays
        });
        const nestedUsernamePolicy = payload.usernamePolicy && typeof payload.usernamePolicy === 'object' && !Array.isArray(payload.usernamePolicy);
        const hasUsernamePolicy = nestedUsernamePolicy
          || ['usernameMode', 'usernameMinLength', 'usernameMaxLength'].some((key) => Object.prototype.hasOwnProperty.call(payload, key));
        const usernameLengthRestricted = nestedUsernamePolicy && Object.prototype.hasOwnProperty.call(payload.usernamePolicy, 'lengthRestricted')
          ? payload.usernamePolicy.lengthRestricted === true
          : (nestedUsernamePolicy
            ? ['minLength', 'maxLength'].some((key) => Object.prototype.hasOwnProperty.call(payload.usernamePolicy, key))
            : ['usernameMinLength', 'usernameMaxLength'].some((key) => Object.prototype.hasOwnProperty.call(payload, key)));
        const usernameInput = nestedUsernamePolicy
          ? payload.usernamePolicy
          : { mode: payload.usernameMode, minLength: payload.usernameMinLength, maxLength: payload.usernameMaxLength };
        if (hasUsernamePolicy && !USERNAME_POLICY_MODES.has(usernameInput.mode)) return acknowledgement?.({ success: false, error: '账号规则类型无效' });
        const usernamePolicy = hasUsernamePolicy
          ? normalizeUsernamePolicy({ ...usernameInput, lengthRestricted: usernameLengthRestricted })
          : normalizeUsernamePolicy(state.admin.usernamePolicy);
        state.admin.passwordPolicy = policy;
        if (hasUsernamePolicy) state.admin.usernamePolicy = usernamePolicy;
        persist();
        recordOperation({ actor: user.username, action: 'password-policy', summary: `更新用户密码规则：${policy.mode} / ${policy.lengthRestricted ? `${policy.minLength}-${policy.maxLength} 位` : '不限制字符长度'}${hasUsernamePolicy ? `；账号 ${usernamePolicy.mode} / ${usernamePolicy.lengthRestricted ? `${usernamePolicy.minLength}-${usernamePolicy.maxLength} 位` : '不限制字符长度'}` : ''}`, scope: 'server' });
        const update = { passwordPolicy: policy };
        if (hasUsernamePolicy) update.usernamePolicy = usernamePolicy;
        io.emit('server-policy-updated', update);
        return acknowledgement?.({ success: true, passwordPolicy: policy, usernamePolicy, message: hasUsernamePolicy ? '账号与密码规则已保存并同步' : '用户密码规则已保存并同步' });
      }
      if (action === 'set-username-policy') {
        if (!USERNAME_POLICY_MODES.has(payload.mode)) return acknowledgement?.({ success: false, error: '账号规则类型无效' });
        const lengthRestricted = Object.prototype.hasOwnProperty.call(payload, 'lengthRestricted')
          ? payload.lengthRestricted === true
          : ['minLength', 'maxLength'].some((key) => Object.prototype.hasOwnProperty.call(payload, key));
        const policy = normalizeUsernamePolicy({
          mode: payload.mode, lengthRestricted, minLength: payload.minLength, maxLength: payload.maxLength
        });
        state.admin.usernamePolicy = policy;
        persist();
        recordOperation({ actor: user.username, action: 'username-policy', summary: `更新注册账号规则：${policy.mode} / ${policy.lengthRestricted ? `${policy.minLength}-${policy.maxLength} 位` : '不限制字符长度'}`, scope: 'server' });
        io.emit('server-policy-updated', { usernamePolicy: policy });
        return acknowledgement?.({ success: true, usernamePolicy: policy, message: '注册账号规则已保存并同步' });
      }
      if (action === 'set-room-id-policy') {
        state.admin.roomIdPolicy = normalizeRoomIdPolicy(payload.policy || payload);
        persist();
        recordOperation({ actor: user.username, action: 'room-id-policy', summary: state.admin.roomIdPolicy.enabled ? '启用自定义房间号规则' : '关闭自定义房间号规则', scope: 'server' });
        io.emit('server-policy-updated', { roomIdPolicy: state.admin.roomIdPolicy });
        return acknowledgement?.({ success: true, roomIdPolicy: state.admin.roomIdPolicy, message: state.admin.roomIdPolicy.enabled ? '房间号规则已启用' : '房间号规则已关闭' });
      }
      if (action === 'set-account-number-policy') {
        const nextPolicy = normalizeAccountNumberPolicy(payload.policy || payload);
        state.admin.accountNumberPolicy = nextPolicy;
        persist();
        recordOperation({ actor: user.username, action: 'account-number-policy', summary: `更新账户编号规则：${formatAccountNumber(nextPolicy.nextNumber, nextPolicy)}`, scope: 'server' });
        return acknowledgement?.({ success: true, accountNumberPolicy: nextPolicy, message: '账户编号规则已保存，新注册账号将按新规则编号' });
      }
      if (action === 'set-account-number') {
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        const accountId = cleanText(payload.accountId, 32).toUpperCase();
        if (!account) return acknowledgement?.({ success: false, error: '账号不存在' });
        if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(accountId)) return acknowledgement?.({ success: false, error: '账户编号需为 2-32 位大写字母、数字、下划线或短横线' });
        if (Object.entries(state.accounts).some(([name, item]) => name !== username && String(item?.id || '').toUpperCase() === accountId)) return acknowledgement?.({ success: false, error: '账户编号已被其他账号使用' });
        const previousId = account.id; account.id = accountId;
        persist();
        accountChangeNotice(username, { kind: 'account-id', message: `管理员已将您的账户编号从 ${previousId} 修改为 ${accountId}`, previousId, accountId });
        recordOperation({ actor: user.username, action: 'account-number-change', summary: `修改 ${username} 的账户编号：${previousId} → ${accountId}`, scope: 'server' });
        return acknowledgement?.({ success: true, username, accountId, previousId, message: '账户编号已修改并同步' });
      }
      if (action === 'set-verification-code-policy') {
        state.admin.verificationCodePolicy = normalizeVerificationCodePolicy(payload.policy || payload);
        persist();
        return acknowledgement?.({ success: true, verificationCodePolicy: state.admin.verificationCodePolicy, message: state.admin.verificationCodePolicy.rateLimitEnabled ? '验证码请求限制已启用' : '验证码请求限制已关闭' });
      }
      if (action === 'unblock-verification-device') {
        const deviceId = cleanText(payload.deviceId || payload.ip, 160);
        if (!deviceId) return acknowledgement?.({ success: false, error: '缺少设备或 IP 标识' });
        const policy = normalizeVerificationCodePolicy(state.admin.verificationCodePolicy);
        delete policy.blockedDevices[deviceId];
        for (const key of [...rateBuckets.keys()]) if (key.includes(deviceId)) rateBuckets.delete(key);
        state.admin.verificationCodePolicy = policy; persist();
        return acknowledgement?.({ success: true, verificationCodePolicy: policy, message: '该设备的验证码请求限制已解除' });
      }
      if (action === 'get-verification-codes') {
        const query = cleanText(payload.query || payload.search, 120).toLocaleLowerCase();
        const type = cleanText(payload.type, 40); const status = cleanText(payload.status, 20);
        const from = Date.parse(payload.fromDate || '') || 0; const to = Date.parse(payload.toDate || '') || 0;
        const records = state.verificationCodeRecords.filter((record) => {
          const effective = record.status === 'active' && record.expiresAt && Date.parse(record.expiresAt) <= Date.now() ? 'expired' : record.status;
          return (!type || record.type === type) && (!status || effective === status)
            && (!query || [record.accountName, record.senderEmail, record.recipientEmail, record.requestIp, record.deviceId].join(' ').toLocaleLowerCase().includes(query))
            && (!from || Date.parse(record.createdAt) >= from) && (!to || Date.parse(record.createdAt) <= to + 86400000 - 1);
        }).map((record) => ({ ...record, status: record.status === 'active' && record.expiresAt && Date.parse(record.expiresAt) <= Date.now() ? 'expired' : record.status }));
        return acknowledgement?.({ success: true, records: records.slice(-5000).reverse(), verificationCodePolicy: normalizeVerificationCodePolicy(state.admin.verificationCodePolicy) });
      }
      if (action === 'delete-verification-codes') {
        const ids = Array.isArray(payload.ids) ? payload.ids.map((id) => cleanText(id, 80)).filter(Boolean) : [];
        if (!ids.length) return acknowledgement?.({ success: false, error: '请先选择验证码记录' });
        const idSet = new Set(ids); const before = state.verificationCodeRecords.length;
        state.verificationCodeRecords = state.verificationCodeRecords.filter((record) => !idSet.has(record.id));
        persist();
        return acknowledgement?.({ success: true, deleted: before - state.verificationCodeRecords.length, message: `已删除 ${before - state.verificationCodeRecords.length} 条验证码记录` });
      }
      if (action === 'set-admin-contact') {
        const contact = normalizeAdminContact(payload.contact || payload);
        if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) return acknowledgement?.({ success: false, error: '管理员联系邮箱格式不正确' });
        state.admin.contact = contact;
        persist();
        recordOperation({ actor: user.username, action: 'admin-contact', summary: '更新服务器管理员联系方式', scope: 'server' });
        io.emit('server-contact-updated', contact);
        return acknowledgement?.({ success: true, contact, message: '管理员联系方式已保存并同步到登录界面' });
      }
      if (action === 'set-legal-agreement') {
        const agreement = normalizeLegalAgreement(payload.agreement || payload);
        if (!agreement.text || agreement.text.length < 80) return acknowledgement?.({ success: false, error: '协议正文至少需要 80 个字符' });
        state.admin.legalAgreement = agreement;
        persist();
        recordOperation({ actor: user.username, action: 'legal-agreement', summary: `更新软件使用协议：${agreement.version}`, scope: 'server' });
        io.emit('agreement-required', agreement);
        return acknowledgement?.({ success: true, legalAgreement: agreement, message: '使用协议已更新，所有账号下次进入时需要重新确认' });
      }
      if (action === 'set-admin-session-limit') {
        state.admin.adminMaxConcurrentSessions = Math.max(1, Math.min(20, Math.floor(Number(payload.limit) || 1)));
        trimAdminSessions(user.sessionToken);
        persist();
        return acknowledgement?.({ success: true, limit: adminSessionLimit(), message: `admin 最多允许 ${adminSessionLimit()} 个会话同时登录` });
      }
      if (action === 'login-concurrency-policy' || action === 'set-access-record-policy') {
        const current = loginPolicy();
        const next = normalizeLoginPolicy({
          ...current,
          ...(action === 'login-concurrency-policy' ? (payload.policy || payload) : {}),
          accountSessionLimit: action === 'set-access-record-policy' && payload.accountSessionLimit !== undefined ? payload.accountSessionLimit : (payload.policy?.accountSessionLimit ?? current.accountSessionLimit),
          guestSessionsPerIp: action === 'set-access-record-policy' && payload.guestSessionsPerIp !== undefined ? payload.guestSessionsPerIp : (payload.policy?.guestSessionsPerIp ?? current.guestSessionsPerIp),
          accountSessionWhitelistIps: action === 'set-access-record-policy' && payload.accountSessionWhitelistIps !== undefined ? payload.accountSessionWhitelistIps : (payload.policy?.accountSessionWhitelistIps ?? current.accountSessionWhitelistIps),
          guestIpWhitelistIps: action === 'set-access-record-policy' && payload.guestIpWhitelistIps !== undefined ? payload.guestIpWhitelistIps : (payload.policy?.guestIpWhitelistIps ?? current.guestIpWhitelistIps)
        });
        state.admin.loginPolicy = next;
        const accountName = cleanUsername(payload.username || payload.accountUsername);
        if (accountName) {
          const account = state.accounts[accountName];
          if (!account || account.guest) return acknowledgement?.({ success: false, error: '账号不存在或游客账号不能设置独立设备上限' });
          const rawLimit = payload.accountSessionLimitOverride ?? payload.sessionLimit;
          if (rawLimit !== undefined) {
            const numericLimit = Math.floor(Number(rawLimit));
            if (!Number.isFinite(numericLimit) || numericLimit < 0 || numericLimit > 20) {
              return acknowledgement?.({ success: false, error: '账号设备上限必须是 0-20 的整数，0 表示跟随服务器默认值' });
            }
            account.loginSessionLimit = numericLimit;
          }
        }
        if (payload.clearAccessRecords === true) state.admin.accessRecords = [];
        persist();
        io.emit('login-policy-updated', next);
        return acknowledgement?.({ success: true, loginPolicy: next, accountUsername: accountName, accountSessionLimit: accountName ? state.accounts[accountName].loginSessionLimit : undefined, message: '登录并发与游客 IP 策略已保存并同步' });
      }
      if (action === 'get-access-records') {
        const query = cleanText(payload.query || payload.search, 120).toLocaleLowerCase();
        const records = (Array.isArray(state.admin.accessRecords) ? state.admin.accessRecords : []).filter((entry) => !query
          || [entry.username, entry.ipAddress, entry.deviceName, entry.platform, entry.browser, entry.result, entry.message].join(' ').toLocaleLowerCase().includes(query));
        return acknowledgement?.({ success: true, records: records.slice(-5000).reverse(), loginPolicy: loginPolicy() });
      }
      if (action === 'send-client-mode-request') {
        const mode = ['notifications-off', 'concise', 'professional'].includes(payload.mode) ? payload.mode : '';
        const scope = ['users', 'room', 'server'].includes(payload.scope) ? payload.scope : 'users';
        if (!mode) return acknowledgement?.({ success: false, error: '请选择要申请切换的客户端模式' });
        const roomIdValue = normalizeRoomId(payload.roomId || user.roomId);
        let targets = [];
        if (scope === 'server') targets = Object.keys(state.accounts);
        else if (scope === 'room') {
          if (!roomIdValue || !state.rooms[roomIdValue]) return acknowledgement?.({ success: false, error: '目标房间不存在' });
          targets = roomUsers(roomIdValue).map((member) => member.username);
        } else targets = Array.isArray(payload.usernames) ? payload.usernames : [payload.username];
        targets = [...new Set(targets.map(cleanUsername).filter((username) => {
          const account = state.accounts[username];
          return username && username !== user.username && account && !account.guest;
        }))].slice(0, 500);
        if (!targets.length) return acknowledgement?.({ success: false, error: '没有可发送申请的目标账号；请选择其他注册用户' });
        const createdAt = new Date().toISOString();
        const batchId = crypto.randomUUID();
        const requests = targets.map((username) => ({
          id: crypto.randomUUID(), batchId, username, mode, scope,
          roomId: scope === 'room' ? roomIdValue : '',
          requestedBy: user.username,
          requestedByName: state.accounts[user.username]?.displayName || user.username,
          reason: cleanText(payload.reason, 240), status: 'pending', createdAt,
          resolvedAt: '', resolvedBy: ''
        }));
        state.admin.clientModeRequests = [...(state.admin.clientModeRequests || []), ...requests].slice(-1000);
        persist();
        for (const request of requests) {
          for (const member of accountOnlineMembers(request.username)) {
            io.to(member.socketId).emit('client-mode-requested', clientModeRequestPayload(request));
          }
        }
        recordOperation({
          actor: user.username, action: 'send-client-mode-request', scope: scope === 'room' ? 'room' : 'server',
          roomId: scope === 'room' ? roomIdValue : '',
          summary: `发送客户端模式申请：${clientModeRequestPayload(requests[0]).modeLabel}，目标 ${requests.length} 个账号`
        });
        return acknowledgement?.({
          success: true, batchId, requests: requests.map(clientModeRequestPayload),
          message: `已向 ${requests.length} 个账号发送“${clientModeRequestPayload(requests[0]).modeLabel}”申请`
        });
      }
      if (action === 'cancel-client-mode-request') {
        const request = (state.admin.clientModeRequests || []).find((entry) => entry.id === cleanText(payload.requestId, 80));
        if (!request || request.status !== 'pending') return acknowledgement?.({ success: false, error: '客户端模式申请不存在或已处理' });
        request.status = 'cancelled'; request.resolvedAt = new Date().toISOString(); request.resolvedBy = user.username;
        persist();
        const result = { requestId: request.id, username: request.username, mode: request.mode, status: request.status, message: '管理员已取消本次客户端模式切换申请' };
        for (const member of accountOnlineMembers(request.username)) io.to(member.socketId).emit('client-mode-request-cancelled', result);
        recordOperation({ actor: user.username, action: 'cancel-client-mode-request', scope: 'server', summary: `取消客户端模式申请：${request.username}` });
        return acknowledgement?.({ success: true, request: clientModeRequestPayload(request), ...result });
      }
      if (action === 'resolve-login-concurrency-request') {
        if (user.username !== 'admin') return acknowledgement?.({ success: false, error: '多设备登录申请只能由内置 admin 处理' });
        const request = state.admin.loginConcurrencyRequests.find((entry) => entry.id === cleanText(payload.requestId, 80));
        if (!request || request.status !== 'pending') return acknowledgement?.({ success: false, error: '多设备登录申请不存在或已处理' });
        const approved = payload.approved === true;
        request.status = approved ? 'approved' : 'denied'; request.resolvedAt = new Date().toISOString(); request.resolvedBy = user.username;
        if (approved && state.accounts[request.username]) state.accounts[request.username].loginSessionLimit = Math.max(1, Math.min(20, Number(request.requestedLimit) || 1));
        persist();
        const result = { requestId: request.id, username: request.username, approved, status: request.status, sessionLimit: accountSessionLimit(request.username), message: approved ? `管理员已允许该账号同时登录 ${accountSessionLimit(request.username)} 台设备` : '管理员已拒绝多设备登录申请' };
        if (request.requesterSocketId) io.to(request.requesterSocketId).emit('login-concurrency-resolved', result);
        return acknowledgement?.({ success: true, request, ...result });
      }
      if (action === 'revoke-login-concurrency') {
        if (user.username !== 'admin') return acknowledgement?.({ success: false, error: '多设备登录授权只能由内置 admin 取消' });
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        if (!account || account.guest || username === 'admin') return acknowledgement?.({ success: false, error: '目标账号不存在或不能取消授权' });
        account.loginSessionLimit = 0;
        const request = (state.admin.loginConcurrencyRequests || []).find((entry) => entry.id === cleanText(payload.requestId, 80) && entry.username === username);
        if (request && request.status === 'approved') {
          request.status = 'revoked'; request.revokedAt = new Date().toISOString(); request.revokedBy = user.username;
        }
        persist();
        const result = { username, sessionLimit: accountSessionLimit(username), status: 'revoked', message: `已取消 ${username} 的独立多设备授权，恢复服务器默认上限` };
        for (const member of accountOnlineMembers(username)) io.to(member.socketId).emit('login-concurrency-resolved', result);
        return acknowledgement?.({ success: true, request, ...result });
      }
      if (action === 'set-local-passwordless-access') {
        state.admin.localPasswordlessManagementEnabled = payload.managementEnabled !== false;
        state.admin.localPasswordlessRoomEnabled = payload.roomEnabled !== false;
        persist();
        const policy = {
          localPasswordlessManagementEnabled: state.admin.localPasswordlessManagementEnabled,
          localPasswordlessRoomEnabled: state.admin.localPasswordlessRoomEnabled
        };
        io.emit('server-policy-updated', policy);
        recordOperation({
          actor: user.username, action: 'set-local-passwordless-access', scope: 'server',
          summary: `本机免密入口：管理中心${policy.localPasswordlessManagementEnabled ? '开启' : '关闭'}，进入房间${policy.localPasswordlessRoomEnabled ? '开启' : '关闭'}`
        });
        return acknowledgement?.({ success: true, ...policy, message: '本机免密入口设置已保存' });
      }
      if (action === 'set-account-room-quota') {
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        if (!account) return acknowledgement?.({ success: false, error: '账号不存在' });
        const quota = Math.max(1, Math.min(9999, Math.floor(Number(payload.roomQuota) || 1)));
        if (quota < ownedRooms(username).length) return acknowledgement?.({ success: false, error: `该账号已有 ${ownedRooms(username).length} 个房间，额度不能低于现有数量` });
        account.roomQuota = username === 'admin' ? 9999 : quota;
        persist();
        accountChangeNotice(username, {
          kind: 'account-permissions', actor: user.username, actorName: state.accounts[user.username]?.displayName || user.username,
          changed: ['roomQuota'], roomQuota: account.roomQuota,
          message: `管理员已将您的建房额度调整为 ${account.roomQuota}`
        }, 'permissions-changed', { changed: ['roomQuota'], roomQuota: account.roomQuota, message: `管理员已将您的建房额度调整为 ${account.roomQuota}` });
        return acknowledgement?.({ success: true, roomQuota: account.roomQuota, message: `已将 ${username} 的建房额度设置为 ${account.roomQuota}` });
      }
      if (action === 'resolve-room-quota-request') {
        const request = state.admin.roomQuotaRequests.find((entry) => entry.id === cleanText(payload.requestId, 80));
        if (!request || request.status !== 'pending') return acknowledgement?.({ success: false, error: '建房额度申请不存在或已处理' });
        const approved = payload.approved === true;
        const account = state.accounts[request.username];
        request.status = approved ? 'approved' : 'denied'; request.resolvedAt = new Date().toISOString(); request.resolvedBy = user.username;
        if (approved && account) account.roomQuota = Math.max(account.roomQuota || 1, request.requestedQuota || 1);
        const resultPayload = { approved, roomQuota: account?.roomQuota || 1, message: approved ? '您的建房额度申请已通过' : '管理员已拒绝您的建房额度申请' };
        accountChangeNotice(request.username, { kind: 'room-quota-request', message: resultPayload.message, approved, requestId: request.id }, 'room-quota-resolved', resultPayload);
        persist();
        return acknowledgement?.({ success: true, message: approved ? '已批准建房额度申请' : '已拒绝建房额度申请' });
      }
      if (action === 'set-mail-settings') {
        const currentMail = normalizeMailSettings(state.admin.mail);
        const host = cleanText(payload.host || currentMail.host || 'smtp.qq.com', 253).toLowerCase();
        const port = Math.floor(Number(payload.port ?? currentMail.port));
        const secure = typeof payload.secure === 'boolean' ? payload.secure : currentMail.secure;
        const useTls = typeof payload.useTls === 'boolean' ? payload.useTls : currentMail.useTls;
        const userAddress = cleanText(payload.user, 254);
        const fromEmail = cleanText(payload.fromEmail || userAddress, 254).toLowerCase();
        const recoveryEmail = Object.hasOwn(payload, 'recoveryEmail')
          ? cleanText(payload.recoveryEmail, 254).toLowerCase()
          : currentMail.recoveryEmail;
        const fromName = cleanText(payload.fromName || 'SyncWatch同步观影', 60) || 'SyncWatch同步观影';
        const authCode = String(payload.password ?? payload.authCode ?? '');
        const enabled = Boolean(payload.enabled);
        if (!host || /[^a-z0-9.\-_:]/i.test(host) || /:\/\//.test(host)) return acknowledgement?.({ success: false, error: 'SMTP 主机格式不正确，请只填写域名或 IP 地址' });
        if (!Number.isInteger(port) || port < 1 || port > 65535) return acknowledgement?.({ success: false, error: 'SMTP 端口必须是 1-65535 之间的整数' });
        if (userAddress.length > 254 || /[\r\n]/.test(userAddress)) return acknowledgement?.({ success: false, error: 'SMTP 用户名格式不正确' });
        if (fromEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) return acknowledgement?.({ success: false, error: '发件人邮箱格式不正确' });
        if (recoveryEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail)) return acknowledgement?.({ success: false, error: '密码找回邮箱格式不正确' });
        if (authCode.length > 512 || /[\r\n]/.test(authCode)) return acknowledgement?.({ success: false, error: 'SMTP 密码或授权码格式不正确' });
        const previousIdentity = `${currentMail.host}\n${currentMail.port}\n${currentMail.user}`;
        const nextIdentity = `${host}\n${port}\n${userAddress}`;
        if (nextIdentity !== previousIdentity && !authCode) return acknowledgement?.({ success: false, error: '更换 SMTP 主机、端口或用户名时必须填写新密码/授权码' });
        const encryptedAuthCode = authCode ? encryptMailSecret(authCode) : String(state.admin.mail?.encryptedAuthCode || '');
        if (enabled && (!host || !userAddress || !fromEmail || !encryptedAuthCode)) return acknowledgement?.({ success: false, error: '启用邮件服务前必须填写 SMTP 主机、用户名、密码/授权码和发件邮箱' });
        const templates = payload.templates && typeof payload.templates === 'object' ? payload.templates : currentMail.templates;
        for (const [key, template] of Object.entries(templates || {})) {
          if (!Object.hasOwn(defaultMailTemplates(), key)) continue;
          if (String(template?.subject || '').length > MAIL_TEMPLATE_SUBJECT_LIMIT) return acknowledgement?.({ success: false, error: `邮件主题不能超过 ${MAIL_TEMPLATE_SUBJECT_LIMIT} 个字符` });
          const safetyError = mailTemplateSafetyError(template?.html);
          if (safetyError) return acknowledgement?.({ success: false, error: safetyError });
        }
        state.admin.mail = normalizeMailSettings({
          enabled, host, port, secure, useTls, user: userAddress, fromEmail, recoveryEmail, fromName, encryptedAuthCode,
          registrationVerificationEnabled: payload.registrationVerificationEnabled === true,
          bindingVerificationEnabled: payload.bindingVerificationEnabled !== false,
          accountRecoveryEnabled: payload.accountRecoveryEnabled !== false,
          adminRecoveryEnabled: payload.adminRecoveryEnabled !== false,
          defaultLocale: payload.defaultLocale,
          templates
        });
        mailTransportCache = null;
        passwordResetCodes.clear();
        passwordResetTokens.clear();
        emailBindingCodes.clear();
        registrationEmailCodes.clear();
        persist();
        io.emit('mail-policy-updated', {
          passwordRecoveryAvailable: mailRecoveryAvailable('account') || mailRecoveryAvailable('admin'),
          accountPasswordRecoveryAvailable: mailRecoveryAvailable('account'),
          adminPasswordRecoveryAvailable: mailRecoveryAvailable('admin'),
          registrationEmailVerificationRequired: registrationEmailVerificationAvailable(),
          emailBindingAvailable: emailBindingAvailable()
        });
        recordOperation({ actor: user.username, action: 'mail-settings', summary: enabled ? `启用 SMTP 邮件服务：${host}:${port}` : '关闭 SMTP 邮件服务', scope: 'server' });
        return acknowledgement?.({ success: true, mail: publicMailSettings(), message: enabled ? 'SMTP 邮件服务与验证码流程已保存' : 'SMTP 配置已保存，邮件服务当前关闭' });
      }
      if (action === 'restore-mail-template') {
        const event = MAIL_TEMPLATE_EVENTS.has(payload.event) ? payload.event : '';
        const locale = MAIL_TEMPLATE_LOCALES.has(payload.locale) ? payload.locale : '';
        if (!event || !locale) return acknowledgement?.({ success: false, error: '邮件模板事件或语言无效' });
        const key = `${event}:${locale}`;
        const mail = normalizeMailSettings(state.admin.mail);
        mail.templates[key] = { ...defaultMailTemplates()[key] };
        state.admin.mail = mail;
        persist();
        recordOperation({ actor: user.username, action: 'mail-template-restore', summary: `恢复官方邮件模板：${key}`, scope: 'server' });
        return acknowledgement?.({ success: true, mail: publicMailSettings(), template: mail.templates[key], message: '已恢复官方邮件模板并保存' });
      }
      if (action === 'test-mail-connection') {
        try {
          await verifyConfiguredMailConnection();
        } catch (error) {
          console.error('SMTP 连接测试失败:', error.message);
          return acknowledgement?.({ success: false, error: `SMTP 连接失败：${cleanText(error.message, 180) || '请检查主机、端口、TLS、账号密码和网络'}` });
        }
        return acknowledgement?.({ success: true, message: `SMTP 连接成功：${publicMailSettings().provider}` });
      }
      if (action === 'test-mail-settings') {
        const recipient = cleanText(payload.recipient || state.admin.mail?.recoveryEmail || state.admin.mail?.user, 254).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return acknowledgement?.({ success: false, error: '测试收件邮箱格式不正确' });
        const templateEvent = payload.templateEvent === 'password-reset' || payload.templateEvent === 'passwordReset' ? 'passwordReset' : 'verification';
        const templateLabel = templateEvent === 'passwordReset' ? '密码重置验证码模板' : '邮箱验证码模板';
        const rendered = renderMailTemplate(templateEvent, {
          recipientName: '测试用户', recipientEmail: recipient, verificationCode: '123456',
          actionName: templateEvent === 'passwordReset' ? '重置密码' : '验证邮箱', accountName: '测试用户'
        });
        try {
          await sendConfiguredMail({
            to: recipient, subject: rendered.subject, text: rendered.text, html: rendered.html
          });
        } catch (error) {
          console.error('发送 SMTP 测试邮件失败:', error.message);
          return acknowledgement?.({ success: false, error: `测试邮件发送失败：${cleanText(error.message, 180) || '请检查 SMTP 配置和服务器网络'}` });
        }
        return acknowledgement?.({ success: true, templateEvent, message: `已发送${templateLabel}到 ${recipient}` });
      }
      if (action === 'set-upload-policy') {
        const allowed = normalizeAllowedUploadCategories(payload.allowedUploadCategories);
        state.admin.allowedUploadCategories = allowed;
        persist();
        recordOperation({ actor: user.username, action: 'upload-policy', summary: `允许上传的文件类型：${allowed.join('、')}`, scope: 'server' });
        io.emit('upload-policy-updated', { allowedUploadCategories: allowed });
        return acknowledgement?.({ success: true, allowedUploadCategories: allowed, message: '上传文件类型规则已保存并同步' });
      }
      if (action === 'set-text-upload-policy') {
        state.admin.allowTextUploads = payload.allowTextUploads !== false;
        persist();
        recordOperation({ actor: user.username, action: 'text-upload-policy', summary: state.admin.allowTextUploads ? '允许上传文本文件' : '关闭文本文件上传', scope: 'server' });
        io.emit('text-upload-policy-updated', { allowTextUploads: state.admin.allowTextUploads });
        return acknowledgement?.({ success: true, allowTextUploads: state.admin.allowTextUploads, message: state.admin.allowTextUploads ? '已允许上传安全文本文件' : '已关闭文本文件上传' });
      }
      if (action === 'resolve-upload-policy-request') {
        const request = state.admin.uploadPolicyRequests.find((entry) => entry.id === cleanText(payload.requestId, 80));
        if (!request || request.status !== 'pending') return acknowledgement?.({ success: false, error: '文件类型申请不存在或已处理' });
        const approved = payload.approved === true;
        request.status = approved ? 'approved' : 'denied';
        request.resolvedAt = new Date().toISOString();
        request.resolvedBy = user.username;
        request.resolvedByName = state.accounts[user.username]?.displayName || user.username;
        if (approved) state.admin.allowedUploadCategories = normalizeAllowedUploadCategories([...allowedUploadCategories(), request.category]);
        const resultPayload = {
          request, approved, allowedUploadCategories: allowedUploadCategories(),
          message: approved ? `管理员已允许上传 ${request.category} 类型文件，请重新选择文件上传` : '管理员已拒绝您的文件类型申请'
        };
        accountChangeNotice(request.username, { kind: 'upload-policy-request', roomId: request.roomId, message: resultPayload.message, approved, requestId: request.id }, 'upload-policy-resolved', resultPayload);
        persist();
        if (approved) io.emit('upload-policy-updated', { allowedUploadCategories: allowedUploadCategories() });
        return acknowledgement?.({ success: true, request, allowedUploadCategories: allowedUploadCategories(), message: approved ? '已批准文件类型申请' : '已拒绝文件类型申请' });
      }
      if (action === 'resolve-media-management-request' || action === 'media-management-request-action') {
        const request = state.admin.mediaManagementRequests.find((entry) => entry.id === cleanText(payload.requestId, 80));
        if (!request || request.status !== 'pending') return acknowledgement?.({ success: false, error: '影片库管理申请不存在或已经处理' });
        if (!serverAdmin && request.roomId !== currentRoomId()) return acknowledgement?.({ success: false, error: '房间管理员只能处理当前房间的申请' });
        const targetRoom = state.rooms[request.roomId];
        if (!targetRoom) return acknowledgement?.({ success: false, error: '申请对应的房间已经不存在' });
        const approved = payload.approved === true;
        request.status = approved ? 'approved' : 'denied';
        request.resolvedAt = new Date().toISOString();
        request.resolvedBy = user.username;
        request.resolvedByName = state.accounts[user.username]?.displayName || user.username;
        targetRoom.mediaManagementGrants = targetRoom.mediaManagementGrants && typeof targetRoom.mediaManagementGrants === 'object'
          ? targetRoom.mediaManagementGrants : {};
        if (approved) targetRoom.mediaManagementGrants[request.username] = true;
        const resultPayload = {
          request, approved, roomId: targetRoom.id, roomName: targetRoom.name,
          granted: approved === true, message: approved
            ? '影片库管理权限申请已通过，您现在可以管理房间影片'
            : '影片库管理权限申请已被拒绝'
        };
        accountChangeNotice(request.username, {
          kind: 'media-management-request', roomId: targetRoom.id, actor: user.username,
          actorName: request.resolvedByName, approved, requestId: request.id, message: resultPayload.message
        }, 'media-management-request-resolved', resultPayload);
        persist();
        io.to(roomChannel(targetRoom.id)).emit('media-management-permission-updated', {
          username: request.username, roomId: targetRoom.id, granted: approved, requestId: request.id
        });
        io.to(roomChannel(targetRoom.id)).emit('users-list', usersList(targetRoom.id));
        recordOperation({ roomId: targetRoom.id, actor: user.username, action: 'media-management-request-resolved',
          summary: `${approved ? '通过' : '拒绝'} ${request.username} 的影片库管理申请` });
        return acknowledgement?.({ success: true, request, granted: approved, message: resultPayload.message });
      }
      if (action === 'set-upload-limits') {
        const minBytes = payload.uploadMinBytes === undefined ? 0 : Number(payload.uploadMinBytes);
        const bytes = Number(payload.uploadLimitBytes);
        const seconds = Number(payload.uploadTimeLimitSeconds);
        const videoDurationSeconds = Number(payload.uploadVideoDurationLimitSeconds ?? 0);
        if (!Number.isFinite(minBytes) || minBytes < 0 || !Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(videoDurationSeconds) || videoDurationSeconds < 0) return acknowledgement?.({ success: false, error: '限制值必须是非负数' });
        if (minBytes > HARD_MEDIA_UPLOAD_LIMIT_BYTES || bytes > HARD_MEDIA_UPLOAD_LIMIT_BYTES) return acknowledgement?.({ success: false, error: '上传大小不能超过服务器 32GB 安全上限' });
        if (bytes > 0 && minBytes > bytes) return acknowledgement?.({ success: false, error: '文件下限不能大于上限' });
        if (seconds > HARD_REQUEST_TIMEOUT_MS / 1000) return acknowledgement?.({ success: false, error: '上传时间不能超过服务器 2 小时安全上限' });
        if (videoDurationSeconds > HARD_MEDIA_DURATION_LIMIT_SECONDS) return acknowledgement?.({ success: false, error: '视频时长不能超过服务器 30 天安全上限' });
        const before = { uploadMinBytes: state.admin.uploadMinBytes, uploadLimitBytes: state.admin.uploadLimitBytes, uploadTimeLimitSeconds: state.admin.uploadTimeLimitSeconds, uploadVideoDurationLimitSeconds: state.admin.uploadVideoDurationLimitSeconds, uploadVideoDurationLimitConfigured: state.admin.uploadVideoDurationLimitConfigured === true, uploadVideoDurationLimitConfiguredAt: state.admin.uploadVideoDurationLimitConfiguredAt || '', uploadVideoDurationLimitPolicyVersion: Number(state.admin.uploadVideoDurationLimitPolicyVersion) || 0 };
        state.admin.uploadMinBytes = Math.floor(minBytes); state.admin.uploadLimitBytes = Math.floor(bytes); state.admin.uploadTimeLimitSeconds = Math.floor(seconds); state.admin.uploadVideoDurationLimitSeconds = Math.floor(videoDurationSeconds); state.admin.uploadVideoDurationLimitConfigured = true; state.admin.uploadVideoDurationLimitConfiguredAt = new Date().toISOString(); state.admin.uploadVideoDurationLimitPolicyVersion = UPLOAD_DURATION_POLICY_VERSION;
        persist();
        recordOperation({ actor: user.username, action: 'upload-limits', summary: '修改服务器上传限制', scope: 'server', undo: { kind: 'upload-limits', before, after: { uploadMinBytes: state.admin.uploadMinBytes, uploadLimitBytes: state.admin.uploadLimitBytes, uploadTimeLimitSeconds: state.admin.uploadTimeLimitSeconds, uploadVideoDurationLimitSeconds: state.admin.uploadVideoDurationLimitSeconds, uploadVideoDurationLimitConfigured: true, uploadVideoDurationLimitConfiguredAt: state.admin.uploadVideoDurationLimitConfiguredAt, uploadVideoDurationLimitPolicyVersion: UPLOAD_DURATION_POLICY_VERSION } } });
        for (const id of Object.keys(state.rooms)) io.to(roomChannel(id)).emit('upload-limits', { minUploadBytes: state.admin.uploadMinBytes, maxUploadBytes: state.admin.uploadLimitBytes, uploadTimeLimitSeconds: state.admin.uploadTimeLimitSeconds, uploadVideoDurationLimitSeconds: state.admin.uploadVideoDurationLimitSeconds });
        return acknowledgement?.({ success: true, minUploadBytes: state.admin.uploadMinBytes, maxUploadBytes: state.admin.uploadLimitBytes, uploadTimeLimitSeconds: state.admin.uploadTimeLimitSeconds, uploadVideoDurationLimitSeconds: state.admin.uploadVideoDurationLimitSeconds, message: minBytes || bytes || seconds || videoDurationSeconds ? '上传限制已保存' : '已取消上传大小和时长限制' });
      }
      if (action === 'set-room-storage-limit') {
        const targetRoomId = normalizeRoomId(payload.roomId) || currentRoomId();
        if (payload.roomId && !serverAdmin) return acknowledgement?.({ success: false, error: '只有服务器管理员可以调整其他房间的容量' });
        const targetRoom = state.rooms[targetRoomId];
        if (!targetRoom) return acknowledgement?.({ success: false, error: '房间不存在' });
        const bytes = Number(payload.storageLimitBytes);
        if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_ROOM_STORAGE_LIMIT_BYTES) return acknowledgement?.({ success: false, error: '房间容量限制无效' });
        const usedBytes = roomStoragePolicy(targetRoomId).usedBytes;
        if (bytes > 0 && bytes < usedBytes) return acknowledgement?.({ success: false, error: `房间现有文件已占用 ${usedBytes} 字节，容量不能低于当前用量` });
        targetRoom.storageLimitBytes = Math.floor(bytes);
        persist();
        const actorName = state.accounts[user.username]?.displayName || user.username;
        recordOperation({ roomId: targetRoomId, actor: user.username, action: 'room-storage-limit', summary: bytes ? `设置房间容量上限：${Math.floor(bytes)} 字节` : '取消房间容量上限', ...(serverAdmin && targetRoomId !== currentRoomId() ? { scope: 'server' } : {}) });
        io.to(roomChannel(targetRoomId)).emit('room-state', roomSnapshot(targetRoomId));
        if (serverAdmin && targetRoom.ownerUsername && targetRoom.ownerUsername !== user.username) {
          const ownerMessage = bytes
            ? `服务器管理员已将房间 ${targetRoomId} 容量调整为 ${Math.floor(bytes)} 字节`
            : `服务器管理员已取消房间 ${targetRoomId} 的容量限制`;
          accountChangeNotice(targetRoom.ownerUsername, { kind: 'room-storage-limit', roomId: targetRoomId, actor: user.username, actorName, message: ownerMessage });
        }
        return acknowledgement?.({ success: true, roomId: targetRoomId, storage: roomStoragePolicy(targetRoomId), message: bytes ? '房间容量限制已保存' : '已取消房间容量限制' });
      }
      if (action === 'delete-room-files') {
        const targetRoomId = normalizeRoomId(payload.roomId);
        const targetRoom = state.rooms[targetRoomId];
        if (!targetRoom) return acknowledgement?.({ success: false, error: '房间不存在' });
        const fileIds = [...new Set((Array.isArray(payload.fileIds) ? payload.fileIds : []).map((id) => cleanText(id, 80)).filter(Boolean))].slice(0, 100);
        if (!fileIds.length) return acknowledgement?.({ success: false, error: '请选择要删除的文件' });
        const files = fileIds.map(findFile).filter((file) => file && file.roomId === targetRoomId);
        if (!files.length) return acknowledgement?.({ success: false, error: '所选文件不存在或不属于该房间' });
        const actorName = state.accounts[user.username]?.displayName || user.username;
        let deleted = 0;
        const deletedIds = [];
        const deletedNames = [];
        for (const file of files) {
          const runtime = roomRuntime(targetRoomId);
          const deletionId = crypto.randomUUID();
          const fileSnapshot = JSON.parse(JSON.stringify(file));
          const queueBefore = [...targetRoom.queue];
          const playbackBefore = runtime.roomState.playback.fileId === file.id ? playbackSnapshot(targetRoomId) : null;
          if (!await cancelMediaWork(file)) {
            resumeMediaWork(file);
            continue;
          }
          let artifacts;
          try { artifacts = moveFileArtifactsToTrash(file, deletionId); }
          catch (_) {
            resumeMediaWork(file);
            continue;
          }
          state.files = state.files.filter((entry) => entry.id !== file.id);
          targetRoom.queue = targetRoom.queue.filter((id) => id !== file.id);
          const reassociated = reassociateSubtitles(targetRoomId);
          if (runtime.roomState.playback.fileId === file.id) {
            runtime.playbackGeneration += 1;
            runtime.roomState.playback = {
              fileId: null, isPlaying: false, stalled: false, currentTime: 0, volume: runtime.roomState.playback.volume,
              muted: Boolean(runtime.roomState.playback.muted), playbackRate: runtime.roomState.playback.playbackRate || 1,
              updatedAt: Date.now(), changedBy: null, revision: runtime.roomState.playback.revision + 1
            };
            const textReading = resetTextReadingState(null, user.username, targetRoomId);
            io.to(roomChannel(targetRoomId)).emit('text-reading-state', textReading);
          }
          const operation = recordOperation({ id: deletionId, roomId: targetRoomId, actor: user.username, action: 'file-delete-admin', summary: `删除文件：${file.originalName}`, undo: { kind: 'file-delete', file: fileSnapshot, artifacts, queueBefore, playbackBefore } });
          broadcastMediaMutation(targetRoomId, operation, fileSnapshot, 'delete');
          io.to(roomChannel(targetRoomId)).emit('file-deleted', file.id);
          for (const member of users.values()) {
            if (member.username === file.uploadedBy && member.roomId !== targetRoomId) io.to(member.socketId).emit('file-deleted', file.id);
          }
          for (const changed of reassociated) emitFileToVisible('file-updated', changed);
          io.to(roomChannel(targetRoomId)).emit('queue-state', targetRoom.queue);
          io.to(roomChannel(targetRoomId)).emit('playback-state', playbackSnapshot(targetRoomId));
          emitRoomDirectoryChanged(targetRoomId, 'media-deleted');
          if (targetRoom.ownerUsername && targetRoom.ownerUsername !== user.username) {
            accountChangeNotice(targetRoom.ownerUsername, { kind: 'media-admin-delete', roomId: targetRoomId, actor: user.username, actorName, message: `服务器管理员删除了您房间的《${file.originalName}》` });
          }
          broadcastRoomNotice(targetRoomId, `服务器管理员删除了影片《${file.originalName}》`, { kind: 'media-admin-delete', actor: user.username, important: true });
          deleted += 1;
          deletedIds.push(file.id);
          deletedNames.push(file.originalName);
        }
        persist();
        emitMediaProcessingSnapshots();
        return acknowledgement?.({ success: true, deleted, fileIds: deletedIds, names: deletedNames, message: `已删除 ${deleted} 个文件` });
      }
      if (action === 'set-media-upload-ban') {
        const targetRoomId = normalizeRoomId(payload.roomId);
        const targetRoom = state.rooms[targetRoomId];
        if (!targetRoom) return acknowledgement?.({ success: false, error: '房间不存在' });
        const originalName = normalizeOriginalName(payload.originalName);
        if (!originalName) return acknowledgement?.({ success: false, error: '请输入要禁止上传的影片文件名' });
        const banned = payload.banned !== false;
        const normalized = originalName.toLocaleLowerCase();
        const bans = Array.isArray(state.admin.mediaUploadBans) ? state.admin.mediaUploadBans : (state.admin.mediaUploadBans = []);
        const existing = bans.find((entry) => entry && entry.roomId === targetRoomId && String(entry.originalName || '').toLocaleLowerCase() === normalized);
        let entry = existing;
        if (!existing && banned) {
          entry = { id: crypto.randomUUID(), roomId: targetRoomId, originalName, addedBy: user.username, addedAt: new Date().toISOString(), enabled: true };
          bans.push(entry);
        } else if (existing) {
          if (banned) existing.enabled = true;
          else state.admin.mediaUploadBans = bans.filter((item) => item !== existing);
        }
        persist();
        const actorName = state.accounts[user.username]?.displayName || user.username;
        recordOperation({ roomId: targetRoomId, actor: user.username, action: 'media-upload-ban', summary: banned ? `禁止上传《${originalName}》` : `解除禁止上传《${originalName}》` });
        const message = banned
          ? `服务器管理员已禁止《${originalName}》上传到房间“${targetRoom.name}”`
          : `服务器管理员已解除《${originalName}》的上传限制`;
        if (targetRoom.ownerUsername && targetRoom.ownerUsername !== user.username) {
          accountChangeNotice(targetRoom.ownerUsername, { kind: 'media-upload-ban', roomId: targetRoomId, actor: user.username, actorName, message });
        }
        broadcastRoomNotice(targetRoomId, message, { kind: 'media-upload-ban', actor: user.username, important: Boolean(banned) });
        const remaining = state.admin.mediaUploadBans.find((item) => item === entry) || null;
        return acknowledgement?.({ success: true, banned, entry: remaining, message });
      }
      if (action === 'resolve-storage-quota-request') {
        const request = state.admin.storageQuotaRequests.find((entry) => entry.id === cleanText(payload.requestId, 80));
        if (!request || request.status !== 'pending') return acknowledgement?.({ success: false, error: '扩容申请不存在或已处理' });
        if (!serverAdmin && request.roomId !== currentRoomId()) return acknowledgement?.({ success: false, error: '房间管理员只能处理当前房间的扩容申请' });
        const targetRoom = state.rooms[request.roomId];
        if (!targetRoom) return acknowledgement?.({ success: false, error: '申请对应的房间不存在' });
        const approved = payload.approved === true;
        request.status = approved ? 'approved' : 'denied';
        request.resolvedAt = new Date().toISOString();
        request.resolvedBy = user.username;
        request.resolvedByName = state.accounts[user.username]?.displayName || user.username;
        if (approved) {
          const approvedLimit = Math.floor(Number(payload.approvedLimitBytes) || request.requestedLimitBytes);
          const minimum = Math.max(roomStoragePolicy(targetRoom.id).usedBytes, request.currentLimitBytes || 0);
          if (!Number.isFinite(approvedLimit) || approvedLimit < minimum || approvedLimit > MAX_ROOM_STORAGE_LIMIT_BYTES) {
            request.status = 'pending'; request.resolvedAt = ''; request.resolvedBy = ''; request.resolvedByName = '';
            return acknowledgement?.({ success: false, error: '批准的房间容量无效或低于当前用量' });
          }
          targetRoom.storageLimitBytes = approvedLimit;
        }
        const resultPayload = {
          request, approved, storage: roomStoragePolicy(targetRoom.id),
          message: approved ? '管理员已批准房间扩容申请，请重新上传文件' : '管理员已拒绝您的房间扩容申请'
        };
        accountChangeNotice(request.username, { kind: 'storage-quota-request', roomId: targetRoom.id, message: resultPayload.message, approved, requestId: request.id }, 'storage-quota-resolved', resultPayload);
        persist();
        io.to(roomChannel(targetRoom.id)).emit('room-state', roomSnapshot(targetRoom.id));
        return acknowledgement?.({ success: true, request, storage: roomStoragePolicy(targetRoom.id), message: approved ? '已批准房间扩容申请' : '已拒绝房间扩容申请' });
      }
      if (action === 'set-room') {
        const before = { name: state.room.name, maxUsers: state.room.maxUsers, requireUploadApproval: state.room.requireUploadApproval, allowGuests: state.room.allowGuests !== false };
        state.room.name = cleanText(payload.roomName || '私人影院', 40) || '私人影院';
        state.room.maxUsers = Math.max(2, Math.min(100, Math.floor(Number(payload.maxUsers) || 8)));
        state.room.requireUploadApproval = Boolean(payload.requireUploadApproval);
        state.room.allowGuests = payload.allowGuests !== false;
        persist();
        recordOperation({ actor: user.username, action: 'room-settings', summary: `修改房间设置：${state.room.name}`, undo: { kind: 'room-settings', before, after: { name: state.room.name, maxUsers: state.room.maxUsers, requireUploadApproval: state.room.requireUploadApproval, allowGuests: state.room.allowGuests !== false } } });
        io.to(roomChannel()).emit('room-state', roomSnapshot());
        emitRoomDirectoryChanged(user.roomId, 'room-settings');
        broadcastRoomNotice(user.roomId, `${state.accounts[user.username]?.displayName || user.username} 已更新房间设置：${state.room.name}，人数上限 ${state.room.maxUsers}`, { kind: 'room-settings', actor: user.username });
        return acknowledgement?.({ success: true, message: '房间设置已保存' });
      }
      if (action === 'save-permission-group') {
        const requestedId = cleanText(payload.groupId, 32).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const existing = state.room.permissionGroups[requestedId];
        if (!requestedId || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(requestedId)) return acknowledgement?.({ success: false, error: '权限组标识需为 2-32 位字母、数字、下划线或短横线' });
        if (existing?.system) return acknowledgement?.({ success: false, error: '系统权限组不能覆盖，可新建自定义权限组' });
        const group = normalizePermissionGroup({
          id: requestedId, name: payload.name, permissions: {
            control: payload.control, seek: payload.seek === undefined ? payload.control : payload.seek, upload: payload.upload, delete: payload.delete, manageMedia: payload.manageMedia,
            shareScreen: payload.shareScreen, shareAudio: payload.shareAudio, shareWeb: payload.shareWeb, voiceChat: payload.voiceChat,
            manageChat: payload.manageChat, manageRoom: payload.manageRoom, skipSettings: payload.skipSettings, sendNotice: payload.sendNotice
          }
        }, requestedId);
        if (!group?.name) return acknowledgement?.({ success: false, error: '请输入权限组名称' });
        state.room.permissionGroups[group.id] = group;
        persist();
        recordOperation({ actor: user.username, action: 'permission-group-save', summary: `保存权限组：${group.name}` });
        io.to(roomChannel()).emit('users-list', usersList());
        return acknowledgement?.({ success: true, group, message: '权限组已保存' });
      }
      if (action === 'delete-permission-group') {
        const groupId = cleanText(payload.groupId, 32).toLowerCase();
        const group = state.room.permissionGroups[groupId];
        if (!group) return acknowledgement?.({ success: false, error: '权限组不存在' });
        if (group.system) return acknowledgement?.({ success: false, error: '系统权限组不能删除' });
        const assignedUsers = Object.entries(state.room.memberGroups).filter(([, assigned]) => assigned === groupId).map(([username]) => username);
        if (assignedUsers.length && payload.forceRemoveMembers !== true) {
          return acknowledgement?.({ success: false, code: 'PERMISSION_GROUP_IN_USE', assignedUsers, error: `该权限组仍有 ${assignedUsers.length} 名成员使用，请确认先将成员移出权限组` });
        }
        delete state.room.permissionGroups[groupId];
        for (const [username, assigned] of Object.entries(state.room.memberGroups)) if (assigned === groupId) state.room.memberGroups[username] = 'member';
        persist();
        recordOperation({ actor: user.username, action: 'permission-group-delete', summary: `删除权限组：${group.name}` });
        io.to(roomChannel()).emit('users-list', usersList());
        return acknowledgement?.({ success: true, message: '权限组已删除，原成员已恢复为普通成员' });
      }
      if (action === 'delete-permission-groups') {
        const groupIds = [...new Set((Array.isArray(payload.groupIds) ? payload.groupIds : []).map((id) => cleanText(id, 32).toLowerCase()).filter(Boolean))].slice(0, 100);
        if (!groupIds.length) return acknowledgement?.({ success: false, error: '请先选择要删除的权限组' });
        const removable = groupIds.map((id) => state.room.permissionGroups[id]).filter((group) => group && !group.system);
        const assignedUsers = Object.entries(state.room.memberGroups).filter(([, assigned]) => removable.some((group) => group.id === assigned)).map(([username]) => username);
        if (assignedUsers.length && payload.forceRemoveMembers !== true) {
          return acknowledgement?.({ success: false, code: 'PERMISSION_GROUP_IN_USE', assignedUsers, error: `所选权限组仍有 ${assignedUsers.length} 名成员使用，请确认先将成员移出` });
        }
        for (const group of removable) delete state.room.permissionGroups[group.id];
        for (const [username, assigned] of Object.entries(state.room.memberGroups)) if (removable.some((group) => group.id === assigned)) state.room.memberGroups[username] = 'member';
        persist();
        recordOperation({ actor: user.username, action: 'permission-group-delete-batch', summary: `批量删除权限组：${removable.map((group) => group.name).join('、')}` });
        io.to(roomChannel()).emit('users-list', usersList());
        return acknowledgement?.({ success: true, deleted: removable.map((group) => group.id), message: `已删除 ${removable.length} 个权限组，相关成员已恢复为普通成员` });
      }
      if (action === 'set-permissions') {
        const username = cleanUsername(payload.username);
        if (!state.accounts[username]) return acknowledgement?.({ success: false, error: '账号不存在' });
        if (username === state.room.ownerUsername) return acknowledgement?.({ success: false, error: '房主始终拥有全部权限，无需调整' });
        const before = state.permissions[username] ? { ...state.permissions[username] } : null;
        const beforeEffective = permissionFor(username);
        const requestedGroupId = cleanText(payload.groupId || state.room.memberGroups[username] || 'member', 32).toLowerCase();
        if (!state.room.permissionGroups[requestedGroupId]) return acknowledgement?.({ success: false, error: '所选权限组不存在' });
        state.room.memberGroups[username] = Boolean(payload.administrator) ? 'administrator' : requestedGroupId;
        state.permissions[username] = {
          control: Boolean(payload.control), seek: payload.seek === undefined ? Boolean(payload.control) : Boolean(payload.seek), upload: Boolean(payload.upload), delete: Boolean(payload.delete), manageMedia: Boolean(payload.manageMedia),
          shareScreen: Boolean(payload.shareScreen), shareAudio: Boolean(payload.shareAudio), shareWeb: Boolean(payload.shareWeb), voiceChat: payload.voiceChat !== false,
          manageChat: Boolean(payload.manageChat), manageRoom: Boolean(payload.manageRoom), skipSettings: Boolean(payload.skipSettings), sendNotice: Boolean(payload.sendNotice),
          administrator: Boolean(payload.administrator)
        };
        const afterEffective = permissionFor(username);
        const sharingUser = roomUsers().find((member) => member.username === username);
        if (roomState.screenShare.active && roomState.screenShare.username === username && !afterEffective.shareScreen) stopScreenShare(roomState.screenShare.socketId);
        if (roomState.audioShare.active && roomState.audioShare.username === username && !afterEffective.shareAudio) stopAudioShare(roomState.audioShare.socketId, currentRoomId());
        persist();
        recordOperation({ actor: user.username, action: 'room-permissions', summary: `修改成员权限：${username}`, undo: { kind: 'permissions', username, before, after: { ...state.permissions[username] } } });
        io.to(roomChannel()).emit('users-list', usersList());
        const changed = Object.keys(afterEffective).filter((key) => beforeEffective[key] !== afterEffective[key] && !['groupId'].includes(key));
        const permissionNotice = {
          permissions: afterEffective, changed, grantedBy: state.accounts[user.username]?.displayName || user.username,
          message: `房间权限已更新：${changed.length ? changed.join('、') : '权限组已调整'}`
        };
        const delivered = accountChangeNotice(username, {
          kind: 'room-permissions', roomId: currentRoomId(), actor: user.username,
          actorName: state.accounts[user.username]?.displayName || user.username,
          changed, permissions: afterEffective, message: permissionNotice.message
        }, 'permissions-changed', permissionNotice);
        if (!delivered) persist();
        return acknowledgement?.({ success: true, permissions: afterEffective, message: Boolean(payload.administrator) ? '已赋予房间管理员权限' : '成员权限已保存' });
      }
      if (action === 'get-account-audit-logs') {
        const query = cleanText(payload.query, 120).trim().toLowerCase();
        const category = cleanText(payload.category, 40).toLowerCase();
        const resultFilter = cleanText(payload.result, 20).toLowerCase();
        const offset = Math.max(0, Math.floor(Number(payload.offset) || 0));
        const limit = Math.max(20, Math.min(1000, Math.floor(Number(payload.limit) || 200)));
        const allLogs = Array.isArray(state.accountAuditLogs) ? state.accountAuditLogs : [];
        const filtered = allLogs.filter((entry) => {
          if (category && entry.category !== category) return false;
          if (resultFilter && entry.result !== resultFilter) return false;
          if (!query) return true;
          return [entry.username, entry.displayName, entry.ipAddress, entry.deviceName, entry.platform, entry.browser, entry.actor, entry.actorName, entry.message]
            .some((value) => String(value || '').toLowerCase().includes(query));
        }).reverse();
        return acknowledgement?.({
          success: true, logs: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit,
          hasMore: offset + limit < filtered.length,
          categories: ['register', 'login', 'logout', 'account-delete'], results: ['success', 'failure']
        });
      }
      if (action === 'delete-account-audit-logs') {
        const allLogs = Array.isArray(state.accountAuditLogs) ? state.accountAuditLogs : [];
        if (payload.all === true) {
          const requiredConfirmation = '清空账户日志';
          if (cleanText(payload.confirmation, 40) !== requiredConfirmation) {
            return acknowledgement?.({ success: false, requiredConfirmation, error: `请完整输入“${requiredConfirmation}”后再清空全部账户日志` });
          }
          const deleted = allLogs.length;
          state.accountAuditLogs = [];
          persist();
          recordOperation({ actor: user.username, action: 'account-audit-clear', summary: `清空账户审计日志：${deleted} 条`, scope: 'server' });
          return acknowledgement?.({ success: true, deleted, remaining: 0, message: `已清空 ${deleted} 条账户日志` });
        }
        const ids = new Set((Array.isArray(payload.ids) ? payload.ids : []).map((id) => cleanText(id, 80)).filter(Boolean).slice(0, 1000));
        if (!ids.size) return acknowledgement?.({ success: false, error: '请选择要删除的账户日志' });
        const before = allLogs.length;
        state.accountAuditLogs = allLogs.filter((entry) => !ids.has(entry.id));
        const deleted = before - state.accountAuditLogs.length;
        persist();
        recordOperation({ actor: user.username, action: 'account-audit-delete', summary: `删除账户审计日志：${deleted} 条`, scope: 'server' });
        return acknowledgement?.({ success: true, deleted, remaining: state.accountAuditLogs.length, message: `已删除 ${deleted} 条账户日志` });
      }
      if (action === 'set-account-email') {
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        const email = cleanText(payload.email, 120).toLowerCase();
        if (!account) return acknowledgement?.({ success: false, error: '账号不存在' });
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return acknowledgement?.({ success: false, error: '邮箱格式不正确' });
        if (email && Object.entries(state.accounts).some(([name, item]) => name !== username && String(item.email || '').toLowerCase() === email)) {
          return acknowledgement?.({ success: false, error: '邮箱已被其他账号使用' });
        }
        const previousEmail = cleanText(account.email, 120).toLowerCase();
        if (previousEmail === email) return acknowledgement?.({ success: true, profile: accountProfile(username), message: '邮箱没有变化' });
        account.email = email;
        account.emailVerified = Boolean(email);
        emailBindingCodes.delete(username);
        clearPasswordResetState(`account:${username}`);
        persist();
        recordOperation({ actor: user.username, action: 'account-email', summary: `修改账号邮箱：${username}`, scope: 'server' });
        const profile = accountProfile(username);
        accountChangeNotice(username, {
          kind: 'account-email', actor: user.username, actorName: state.accounts[user.username]?.displayName || user.username,
          changed: ['email'], email, previousEmail,
          message: email ? `管理员已将您的登录邮箱更新为 ${email}` : '管理员已清除您的登录邮箱'
        }, 'account-profile-updated', {
          kind: 'account-email', profile, changed: ['email'], email,
          message: email ? `管理员已将您的登录邮箱更新为 ${email}` : '管理员已清除您的登录邮箱'
        });
        return acknowledgement?.({ success: true, profile, cleared: !email, message: email ? `已强制更新并绑定 ${account.displayName || username} 的邮箱` : `已清除 ${account.displayName || username} 的邮箱绑定` });
      }
      if (action === 'set-account-level') {
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        if (!account) return acknowledgement?.({ success: false, error: '账号不存在' });
        const beforeLevel = watchLevelSummary(account);
        const experience = Number(payload.experience);
        const overrideInput = payload.levelOverride;
        if (!Number.isFinite(experience) || experience < 0 || experience > 10000000) return acknowledgement?.({ success: false, error: '经验值需为 0-10000000 的数字' });
        const levelOverride = overrideInput === '' || overrideInput === null || overrideInput === undefined || Number(overrideInput) === 0
          ? null : Number(overrideInput);
        if (levelOverride !== null && (!Number.isInteger(levelOverride) || levelOverride < 1 || levelOverride > WATCH_LEVELS.length)) {
          return acknowledgement?.({ success: false, error: `等级需为 1-${WATCH_LEVELS.length}，或设为 0 让系统按经验自动升级` });
        }
        let registrationDaysValue = null;
        let onlineSecondsValue = null;
        if (payload.registrationDays !== undefined) {
          registrationDaysValue = Number(payload.registrationDays);
          if (!Number.isFinite(registrationDaysValue) || registrationDaysValue < 0 || registrationDaysValue > 36500) return acknowledgement?.({ success: false, error: '注册天数需为 0-36500 的数字' });
        }
        if (payload.onlineSeconds !== undefined) {
          onlineSecondsValue = Number(payload.onlineSeconds);
          if (!Number.isFinite(onlineSecondsValue) || onlineSecondsValue < 0 || onlineSecondsValue > 3153600000) return acknowledgement?.({ success: false, error: '累计在线秒数需为 0-3153600000 的数字' });
        }
        account.experience = Math.floor(experience);
        account.experienceRemainderSeconds = 0;
        account.levelOverride = levelOverride;
        if (registrationDaysValue !== null) account.createdAt = new Date(Date.now() - Math.floor(registrationDaysValue) * 86400000).toISOString();
        if (onlineSecondsValue !== null) {
          account.stats = { ...(account.stats || {}), onlineSeconds: Math.floor(onlineSecondsValue) };
          for (const member of users.values()) if (member.username === username) member.onlineStartedAt = Date.now();
        }
        if (payload.signature !== undefined) account.signature = cleanText(payload.signature, 160);
        persist();
        recordOperation({ actor: user.username, action: 'account-level', summary: `调整账号等级：${username}`, scope: 'server' });
        const profile = accountProfile(username);
        const changed = ['experience'];
        if (profile.level !== beforeLevel.level || profile.levelOverride !== beforeLevel.levelOverride) changed.push('level');
        if (registrationDaysValue !== null) changed.push('registrationDays');
        if (onlineSecondsValue !== null) changed.push('onlineSeconds');
        if (payload.signature !== undefined) changed.push('signature');
        const levelIncreased = profile.level > beforeLevel.level;
        const noticeMessage = levelIncreased
          ? `管理员将您的经验调整为 ${profile.experience}，等级已升级为 Lv.${profile.level} ${profile.levelName}`
          : `管理员已更新您的经验和等级：${profile.experience} 经验，Lv.${profile.level} ${profile.levelName}`;
        const delivered = accountChangeNotice(username, {
          kind: 'account-level', actor: user.username, actorName: state.accounts[user.username]?.displayName || user.username,
          level: profile.level, levelName: profile.levelName, previousLevel: beforeLevel.level, experience: profile.experience,
          changed, levelIncreased, message: noticeMessage
        }, 'account-level-updated', { ...profile, kind: 'account-level', previousLevel: beforeLevel.level, changed, levelIncreased, message: noticeMessage });
        if (!delivered) persist();
        return acknowledgement?.({ success: true, profile, message: `已将 ${account.displayName || username} 调整为 Lv.${profile.level} ${profile.levelName}` });
      }
      if (action === 'set-super-admin') {
        if (user.username !== 'admin') return acknowledgement?.({ success: false, error: '只有内置 admin 账号可以查看、授予或撤销超级管理员权限' });
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        if (!account) return acknowledgement?.({ success: false, error: '账号不存在' });
        if (username === 'admin' && payload.enabled === false) return acknowledgement?.({ success: false, error: '内置 admin 超级管理员不能被撤销' });
        account.superAdmin = payload.enabled !== false;
        if (username !== 'admin' && account.superAdmin) account.mustChangePassword = false;
        persist();
        recordOperation({ actor: user.username, action: 'super-admin', summary: `${account.superAdmin ? '授予' : '撤销'}超级管理员：${username}`, scope: 'server' });
        for (const id of Object.keys(state.rooms)) io.to(roomChannel(id)).emit('users-list', usersList(id));
        const permissionsMessage = account.superAdmin ? '您已被授予超级管理员权限' : '您的超级管理员权限已被撤销';
        accountChangeNotice(username, {
          kind: 'account-permissions', actor: user.username, actorName: state.accounts[user.username]?.displayName || user.username,
          changed: ['superAdmin'], superAdmin: account.superAdmin, message: permissionsMessage
        }, 'permissions-changed', (member) => ({
          permissions: permissionFor(username, member.roomId), changed: ['superAdmin'], grantedBy: state.accounts[user.username]?.displayName || user.username,
          superAdmin: account.superAdmin, message: permissionsMessage
        }));
        return acknowledgement?.({ success: true, message: account.superAdmin ? '已授予超级管理员权限' : '已撤销超级管理员权限' });
      }
      if (action === 'set-room-creation-block') {
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        if (!account) return acknowledgement?.({ success: false, error: '账号不存在' });
        if (username === 'admin') return acknowledgement?.({ success: false, error: '不能禁止内置 admin 创建房间' });
        account.roomCreationBlocked = payload.blocked !== false;
        persist();
        recordOperation({ actor: user.username, action: 'room-create-policy', summary: `${account.roomCreationBlocked ? '禁止' : '允许'}创建房间：${username}`, scope: 'server' });
        accountChangeNotice(username, {
          kind: 'account-permissions', actor: user.username, actorName: state.accounts[user.username]?.displayName || user.username,
          changed: ['roomCreationBlocked'], roomCreationBlocked: account.roomCreationBlocked,
          message: account.roomCreationBlocked ? '管理员已禁止您的账号继续创建房间' : '管理员已恢复您的账号创建房间权限'
        }, 'permissions-changed', {
          changed: ['roomCreationBlocked'], roomCreationBlocked: account.roomCreationBlocked,
          message: account.roomCreationBlocked ? '管理员已禁止您的账号继续创建房间' : '管理员已恢复您的账号创建房间权限'
        });
        return acknowledgement?.({ success: true, message: account.roomCreationBlocked ? '已禁止该账号创建房间' : '已恢复该账号创建房间的权限' });
      }
      if (action === 'set-account-tier') {
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        const tierId = cleanText(payload.tierId, 32);
        if (!account) return acknowledgement?.({ success: false, error: '账号不存在' });
        if (!state.admin.accountTiers?.[tierId]) return acknowledgement?.({ success: false, error: '权限等级不存在' });
        if (account.superAdmin || username === 'admin') return acknowledgement?.({ success: false, error: '超级管理员始终使用 S级服务器（超级节点）权限' });
        const tier = state.admin.accountTiers[tierId];
        account.tierId = tierId;
        account.roomQuota = Math.max(ownedRooms(username).length, Math.max(1, Number(tier.roomQuota) || 1));
        persist();
        recordOperation({ actor: user.username, action: 'account-tier', summary: `设置账号权限等级：${username} -> ${tier.name}`, scope: 'server' });
        const tierNotice = accountChangeNotice(username, {
          kind: 'account-tier', actor: user.username,
          actorName: state.accounts[user.username]?.displayName || user.username,
          tierId, tierName: tier.name, roomQuota: account.roomQuota,
          uploadLimitBytes: Number(tier.uploadLimitBytes) || 0,
          message: `您的账号权限等级已更新为 ${tier.name}`
        });
        if (!tierNotice) persist();
        return acknowledgement?.({ success: true, message: `已将 ${username} 设置为 ${tier.name}` });
      }
      if (action === 'save-account-tier') {
        const tier = normalizeAccountTier({ id: payload.tierId, name: payload.name, uploadLimitBytes: payload.uploadLimitBytes, roomQuota: payload.roomQuota, description: payload.description }, payload.tierId);
        if (!tier || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(tier.id)) return acknowledgement?.({ success: false, error: '权限等级标识需为 2-32 位字母、数字、下划线或短横线' });
        if (tier.id === 's_node' || tier.id === 'basic' || tier.id === 'advanced' || tier.id === 'professional') return acknowledgement?.({ success: false, error: '系统权限等级不能覆盖，请新建自定义等级' });
        state.admin.accountTiers[tier.id] = tier;
        persist();
        recordOperation({ actor: user.username, action: 'account-tier-save', summary: `保存账户权限等级：${tier.name}`, scope: 'server' });
        return acknowledgement?.({ success: true, tier, accountTiers: state.admin.accountTiers, message: '账户权限等级已保存' });
      }
      if (action === 'delete-account-tier') {
        const tierId = cleanText(payload.tierId, 32).toLowerCase();
        const tier = state.admin.accountTiers?.[tierId];
        if (!tier) return acknowledgement?.({ success: false, error: '权限等级不存在' });
        if (['s_node', 'basic', 'advanced', 'professional'].includes(tierId)) return acknowledgement?.({ success: false, error: '系统权限等级不能删除' });
        delete state.admin.accountTiers[tierId];
        const affectedUsernames = [];
        for (const [username, account] of Object.entries(state.accounts)) if (account.tierId === tierId) {
          account.tierId = 'basic';
          affectedUsernames.push(username);
        }
        persist();
        for (const username of affectedUsernames) accountChangeNotice(username, {
          kind: 'account-tier', actor: user.username, actorName: state.accounts[user.username]?.displayName || user.username,
          changed: ['tierId'], tierId: 'basic', tierName: state.admin.accountTiers.basic?.name || '基础账号',
          message: `原权限等级“${tier.name}”已删除，您的账号已恢复为基础权限等级`
        });
        recordOperation({ actor: user.username, action: 'account-tier-delete', summary: `删除账户权限等级：${tier.name}`, scope: 'server' });
        return acknowledgement?.({ success: true, accountTiers: state.admin.accountTiers, message: '账户权限等级已删除，受影响账号已恢复基础等级' });
      }
      if (action === 'rename-room') {
        const roomIdValue = normalizeRoomId(payload.roomId);
        const targetRoom = roomIdValue && state.rooms[roomIdValue];
        const name = cleanText(payload.name, 40);
        if (!targetRoom) return acknowledgement?.({ success: false, error: '房间不存在' });
        if (!name) return acknowledgement?.({ success: false, error: '请输入房间名称' });
        const previousName = targetRoom.name;
        targetRoom.name = name;
        targetRoom.lastActivityAt = new Date().toISOString();
        persist();
        recordOperation({ actor: user.username, action: 'room-force-rename', summary: `强制修改房间名称：${previousName} -> ${name}`, scope: 'server' });
        io.to(roomChannel(targetRoom.id)).emit('room-state', roomSnapshot(targetRoom.id));
        return acknowledgement?.({ success: true, message: `已将房间 ${targetRoom.id} 重命名为 ${name}` });
      }
      if (action === 'rename-room-id') {
        return acknowledgement?.(await renameRoomIdForAdmin(payload.roomId, payload.newRoomId, user.username));
      }
      if (action === 'batch-room-action') {
        const operation = cleanText(payload.operation, 24);
        const roomIds = [...new Set((Array.isArray(payload.roomIds) ? payload.roomIds : []).map(normalizeRoomId).filter((id) => visibleRoom(state.rooms[id])))];
        if (!['stop', 'ban', 'rename', 'rename-id', 'require-password'].includes(operation)) return acknowledgement?.({ success: false, error: '批量房间操作无效' });
        if (!roomIds.length) return acknowledgement?.({ success: false, error: '请至少选择一个房间' });
        const actorName = state.accounts[user.username]?.displayName || user.username;
        if (operation === 'rename') {
          const names = payload.names && typeof payload.names === 'object' && !Array.isArray(payload.names) ? payload.names : {};
          for (const id of roomIds) if (!cleanText(names[id], 40)) return acknowledgement?.({ success: false, error: `请填写房间 ${id} 的新名称` });
        }
        if (operation === 'rename-id') {
          const mapping = payload.roomIdsMap && typeof payload.roomIdsMap === 'object' && !Array.isArray(payload.roomIdsMap) ? payload.roomIdsMap : {};
          const nextIds = roomIds.map((id) => normalizeRoomId(mapping[id]));
          if (nextIds.some((id) => !id || !/^[A-Z0-9]{4,32}$/.test(id))) return acknowledgement?.({ success: false, error: '全部新房间号都必须是 4-32 位大写字母或数字' });
          if (new Set(nextIds).size !== nextIds.length) return acknowledgement?.({ success: false, error: '新的房间号存在重复冲突' });
          for (let index = 0; index < roomIds.length; index += 1) {
            if (nextIds[index] !== roomIds[index] && state.rooms[nextIds[index]]) return acknowledgement?.({ success: false, error: `新的房间号 ${nextIds[index]} 已存在` });
          }
        }
        const affected = [];
        const renamed = [];
        if (operation === 'stop') {
          for (const id of roomIds) {
            const runtime = roomRuntime(id);
            const snapshot = playbackSnapshot(id);
            runtime.roomState.playback = {
              ...runtime.roomState.playback, currentTime: snapshot.currentTime, isPlaying: false, stalled: false,
              updatedAt: Date.now(), changedBy: user.username, revision: Number(runtime.roomState.playback.revision || 0) + 1
            };
            io.to(roomChannel(id)).emit('playback-state', playbackSnapshot(id));
            broadcastRoomNotice(id, `${actorName} 通过服务器控制台停止了当前房间的播放`, {
              kind: 'batch-room-stop', actor: user.username, actorName, important: true
            });
            affected.push(id);
          }
        } else if (operation === 'ban') {
          const reason = cleanText(payload.reason || '服务器管理员批量封禁', 200);
          for (const id of roomIds) {
            const targetRoom = state.rooms[id];
            broadcastRoomNotice(id, `${actorName} 已封禁当前房间：${reason}`, {
              kind: 'batch-room-ban', actor: user.username, actorName, important: true, reason
            });
            targetRoom.banned = true;
            targetRoom.banReason = reason;
            targetRoom.lastActivityAt = new Date().toISOString();
            for (const member of [...roomUsers(id)]) {
              if (isSuperAdmin(member.username)) continue;
              const targetSocket = io.sockets.sockets.get(member.socketId);
              targetSocket?.emit('room-banned', { roomId: id, message: `房间已被服务器封禁：${reason}` });
              sessions.delete(member.sessionToken);
              removeOnlineUser(member.socketId);
              setImmediate(() => targetSocket?.disconnect(true));
            }
            affected.push(id);
          }
        } else if (operation === 'require-password') {
          for (const id of roomIds) {
            const targetRoom = state.rooms[id];
            targetRoom.passwordEnforcementRequired = !targetRoom.passwordHash;
            if (targetRoom.passwordEnforcementRequired && targetRoom.ownerUsername) {
              accountChangeNotice(targetRoom.ownerUsername, { kind: 'room-password-required', roomId: id, message: `服务器管理员要求为房间“${targetRoom.name}”设置访问密码；设置前房主无法控制播放` });
            }
            io.to(roomChannel(id)).emit('room-state', roomSnapshot(id));
            broadcastRoomNotice(id, `${actorName} 要求房主为当前房间设置访问密码；房主离线时不影响其他成员继续观看`, { kind: 'room-password-required', actor: user.username, actorName, important: true });
            affected.push(id);
          }
        } else if (operation === 'rename') {
          const names = payload.names;
          for (const id of roomIds) {
            const targetRoom = state.rooms[id];
            const previousName = targetRoom.name;
            targetRoom.name = cleanText(names[id], 40);
            targetRoom.lastActivityAt = new Date().toISOString();
            io.to(roomChannel(id)).emit('room-state', roomSnapshot(id));
            broadcastRoomNotice(id, `${actorName} 将房间名称从“${previousName}”修改为“${targetRoom.name}”`, {
              kind: 'batch-room-rename', actor: user.username, actorName, important: true, previousName, nextName: targetRoom.name
            });
            affected.push(id);
          }
        } else {
          const mapping = payload.roomIdsMap;
          for (const id of roomIds) {
            const result = await renameRoomIdForAdmin(id, mapping[id], user.username, 'batch-room-rename-id');
            if (!result.success) return acknowledgement?.(result);
            affected.push(result.newRoomId);
            renamed.push({ oldRoomId: result.oldRoomId, newRoomId: result.newRoomId });
          }
        }
        persist();
        recordOperation({
          actor: user.username, action: `batch-room-${operation}`, scope: 'server',
          summary: `批量房间操作 ${operation}：${roomIds.join('、')}`
        });
        return acknowledgement?.({
          success: true, operation, affected, renamed,
          message: `已完成 ${affected.length} 个房间的${operation === 'stop' ? '停止播放' : operation === 'ban' ? '封禁' : operation === 'rename' ? '改名' : operation === 'require-password' ? '密码设置要求' : '房间号修改'}`
        });
      }
      if (action === 'set-marquee-notice') {
        const next = normalizeMarqueeNotice({ enabled: payload.enabled, loginEnabled: payload.loginEnabled, text: payload.text, color: payload.color, speed: payload.speed, scope: payload.scope, updatedAt: new Date().toISOString() });
        state.admin.marqueeNotice = next;
        persist();
        io.emit('room-marquee', next);
        recordOperation({ actor: user.username, action: 'set-marquee-notice', summary: next.enabled ? `更新实时滚动公告：${next.text.slice(0, 60)}` : '关闭实时滚动公告', scope: 'server' });
        return acknowledgement?.({ success: true, marqueeNotice: next, message: next.enabled ? '实时滚动公告已同步到所有在线设备' : '实时滚动公告已关闭' });
      }
      if (action === 'set-notice-preferences') {
        state.admin.f11PromptEnabled = payload.f11PromptEnabled !== false;
        state.admin.initialPasswordReminderEnabled = payload.initialPasswordReminderEnabled !== false;
        state.admin.downloadButtonsVisible = payload.downloadButtonsVisible !== false;
        if (Object.prototype.hasOwnProperty.call(payload, 'locationStatusNoticesEnabled')) {
          state.admin.locationStatusNoticesEnabled = payload.locationStatusNoticesEnabled !== false;
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'locationAuthorizationRequestsEnabled')) {
          state.admin.locationAuthorizationRequestsEnabled = payload.locationAuthorizationRequestsEnabled !== false;
        }
        persist();
        const preferences = {
          f11PromptEnabled: state.admin.f11PromptEnabled,
          initialPasswordReminderEnabled: state.admin.initialPasswordReminderEnabled,
          downloadButtonsVisible: state.admin.downloadButtonsVisible,
          locationStatusNoticesEnabled: state.admin.locationStatusNoticesEnabled,
          locationAuthorizationRequestsEnabled: state.admin.locationAuthorizationRequestsEnabled
        };
        io.emit('notice-preferences-updated', preferences);
        recordOperation({ actor: user.username, action: 'notice-preferences', summary: '更新登录和全屏提醒设置', scope: 'server' });
        return acknowledgement?.({ success: true, ...preferences, message: '提醒设置已保存并同步' });
      }
      if (action === 'set-login-music') {
        const currentRaw = normalizeLoginMusic(state.admin.loginMusic);
        const current = normalizeLoginMusic({ ...currentRaw, tracks: currentRaw.tracks.map((track) => {
          if (track.sha256 || !track.storedName) return track;
          const filename = path.basename(track.storedName);
          const target = path.join(loginMusicDir, filename);
          try { if (fs.existsSync(target)) return { ...track, sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') }; } catch (_) {}
          return track;
        }) });
        const incomingTracks = Array.isArray(payload.tracks) ? payload.tracks : [];
        const added = incomingTracks.map((track) => ({
          id: cleanText(track?.id, 80) || crypto.randomUUID(), title: cleanText(track?.title || track?.originalName || '登录音乐', 100), originalName: cleanText(track?.originalName, 180),
          storedName: path.basename(String(track?.storedName || '')), url: cleanText(track?.url, 2048), mimeType: cleanText(track?.mimeType || 'audio/mpeg', 120), size: Math.max(0, Math.floor(Number(track?.size) || 0)),
          sha256: /^[a-f0-9]{64}$/i.test(String(track?.sha256 || '')) ? String(track.sha256).toLowerCase() : '', createdAt: new Date().toISOString()
        })).filter((track) => track.url && (track.url.startsWith('/login-music/') || /^https:\/\//i.test(track.url)));
        for (const track of added) {
          if (!track.storedName) continue;
          const filename = path.basename(track.storedName);
          const target = path.join(loginMusicDir, filename);
          if (!/^[a-f0-9-]+\.[a-z0-9]{2,8}$/i.test(filename) || !fs.existsSync(target)) continue;
          track.storedName = filename;
          track.url = `/login-music/${encodeURIComponent(filename)}`;
          track.size = fs.statSync(target).size;
          track.sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        }
        const requestedUrl = cleanText(payload.url, 2048);
        if (requestedUrl && !added.some((track) => track.url === requestedUrl)) {
          if (requestedUrl.startsWith('/login-music/')) {
            const storedName = path.basename(decodeURIComponent(requestedUrl.slice('/login-music/'.length)));
            const target = path.join(loginMusicDir, storedName);
            if (/^[a-f0-9-]+\.[a-z0-9]{2,8}$/i.test(storedName) && fs.existsSync(target)) {
              added.push({ id: crypto.randomUUID(), title: cleanText(payload.title || storedName.replace(/\.[^.]+$/, ''), 100), originalName: storedName, storedName, url: `/login-music/${encodeURIComponent(storedName)}`, mimeType: 'audio/mpeg', size: fs.statSync(target).size, createdAt: new Date().toISOString() });
            }
          } else if (/^https:\/\//i.test(requestedUrl)) {
            const fallbackTitle = path.basename(requestedUrl.split('?')[0]) || '登录音乐';
            added.push({ id: crypto.randomUUID(), title: cleanText(payload.title || fallbackTitle, 100), originalName: '', storedName: '', url: requestedUrl, mimeType: 'audio/mpeg', size: 0, createdAt: new Date().toISOString() });
          }
        }
        // An explicit tracks array is the complete desired playlist. Do not
        // merge it with the previous state: doing so leaves stale file URLs
        // after an administrator replaces the uploaded music.
        const tracks = Array.isArray(payload.tracks)
          ? added.slice(-LOGIN_MUSIC_TRACK_LIMIT)
          : [...current.tracks, ...added].slice(-LOGIN_MUSIC_TRACK_LIMIT);
        const requestedId = cleanText(payload.currentTrackId, 80);
        const selected = tracks.find((track) => track.id === requestedId)
          || tracks.find((track) => track.url === requestedUrl)
          || tracks[0] || null;
        const next = normalizeLoginMusic({ ...current, ...payload, tracks, currentTrackId: selected?.id || '', url: selected?.url || '' });
        const retainedFiles = new Set(next.tracks.map((track) => path.basename(track.storedName || '')).filter(Boolean));
        if (Array.isArray(payload.tracks)) {
          for (const track of current.tracks) {
            const stored = path.basename(track.storedName || '');
            if (stored && !retainedFiles.has(stored)) fs.rmSync(path.join(loginMusicDir, stored), { force: true });
          }
          for (const track of added) {
            const stored = path.basename(track.storedName || '');
            if (stored && !retainedFiles.has(stored)) fs.rmSync(path.join(loginMusicDir, stored), { force: true });
          }
        }
        state.admin.loginMusic = next;
        let loginVideo = normalizeLoginVideo(state.admin.loginVideo);
        if (next.enabled) {
          loginVideo = normalizeLoginVideo({ ...loginVideo, enabled: false, updatedAt: new Date().toISOString() });
          state.admin.loginVideo = loginVideo;
        }
        persist();
        io.emit('login-music-updated', next);
        if (next.enabled) io.emit('login-video-updated', loginVideo);
        return acknowledgement?.({ success: true, loginMusic: next, loginVideo, message: next.enabled && next.url ? '登录音乐已启用，背景视频已自动关闭' : '登录音乐设置已保存' });
      }
      if (action === 'delete-login-music') {
        const ids = new Set((Array.isArray(payload.ids) ? payload.ids : []).map((id) => cleanText(id, 80)).filter(Boolean));
        const current = normalizeLoginMusic(state.admin.loginMusic);
        const removed = current.tracks.filter((track) => ids.has(track.id));
        for (const track of removed) {
          const stored = path.basename(track.storedName || path.basename(track.url));
          if (stored) fs.rmSync(path.join(loginMusicDir, stored), { force: true });
        }
        const remainingTracks = current.tracks.filter((track) => !ids.has(track.id));
        const next = normalizeLoginMusic({ ...current, tracks: remainingTracks, url: remainingTracks[0]?.url || '', title: remainingTracks[0]?.title || '', currentTrackId: remainingTracks[0]?.id || '' });
        state.admin.loginMusic = next; persist(); io.emit('login-music-updated', next);
        return acknowledgement?.({ success: true, loginMusic: next, deleted: removed.length, message: `已删除 ${removed.length} 首登录音乐` });
      }
      if (action === 'set-login-video') {
        const current = normalizeLoginVideo(state.admin.loginVideo);
        const requestedStoredName = path.basename(String(payload.storedName || current.storedName || ''));
        const requestedUrl = cleanText(payload.url || current.url, 2048);
        const storedName = requestedStoredName || path.basename(decodeURIComponent(requestedUrl.replace(/^\/login-video\//, '')));
        const target = storedName ? path.join(loginVideoDir, storedName) : '';
        if (!storedName || !/^[a-f0-9-]+\.(?:mp4|webm)$/i.test(storedName) || !target || !fs.existsSync(target)) {
          return acknowledgement?.({ success: false, error: '登录背景视频不存在或尚未完成上传转换' });
        }
        const next = normalizeLoginVideo({
          ...current, ...payload, storedName, url: `/login-video/${encodeURIComponent(storedName)}`,
          mimeType: path.extname(storedName).toLowerCase() === '.webm' ? 'video/webm' : 'video/mp4',
          size: fs.statSync(target).size, createdAt: current.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
        });
        if (current.storedName && current.storedName !== storedName) fs.rmSync(path.join(loginVideoDir, current.storedName), { force: true });
        state.admin.loginVideo = next;
        let loginMusic = normalizeLoginMusic(state.admin.loginMusic);
        if (next.enabled) {
          loginMusic = normalizeLoginMusic({ ...loginMusic, enabled: false });
          state.admin.loginMusic = loginMusic;
        }
        persist();
        for (const entry of fs.readdirSync(loginVideoDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name !== storedName) fs.rmSync(path.join(loginVideoDir, entry.name), { force: true });
        }
        io.emit('login-video-updated', next);
        if (next.enabled) io.emit('login-music-updated', loginMusic);
        recordOperation({ actor: user.username, action: 'set-login-video', summary: next.enabled ? '启用登录背景视频并关闭登录音乐' : '保存登录背景视频设置', scope: 'server' });
        return acknowledgement?.({ success: true, loginVideo: next, loginMusic, message: next.enabled ? '登录背景视频已启用，背景音乐已自动关闭' : '登录背景视频设置已保存' });
      }
      if (action === 'delete-login-video') {
        const current = normalizeLoginVideo(state.admin.loginVideo);
        if (current.storedName) fs.rmSync(path.join(loginVideoDir, current.storedName), { force: true });
        const next = normalizeLoginVideo();
        state.admin.loginVideo = next;
        persist();
        for (const entry of fs.readdirSync(loginVideoDir, { withFileTypes: true })) {
          if (entry.isFile()) fs.rmSync(path.join(loginVideoDir, entry.name), { force: true });
        }
        io.emit('login-video-updated', next);
        recordOperation({ actor: user.username, action: 'delete-login-video', summary: '移除登录背景视频', scope: 'server' });
        return acknowledgement?.({ success: true, loginVideo: next, message: current.url ? '登录背景视频已移除' : '当前没有登录背景视频' });
      }
      if (action === 'set-registration-account-notice') {
        state.admin.registrationAccountNoticeEnabled = payload.enabled !== false;
        persist();
        recordOperation({ actor: user.username, action: 'set-registration-account-notice', summary: state.admin.registrationAccountNoticeEnabled ? '开启新账号注册通知' : '关闭新账号注册通知', scope: 'server' });
        return acknowledgement?.({ success: true, enabled: state.admin.registrationAccountNoticeEnabled, message: state.admin.registrationAccountNoticeEnabled ? '新账号注册通知已开启' : '新账号注册通知已关闭' });
      }
      if (action === 'set-lan-access') {
        const enabled = payload.enabled !== false;
        state.admin.lanAccessEnabled = enabled;
        persist();
        let disconnected = 0;
        if (!enabled) {
          for (const member of [...users.values()]) {
            const targetSocket = io.sockets.sockets.get(member.socketId);
            if (!targetSocket || !socketIsLanClient(targetSocket)) continue;
            disconnected += 1;
            targetSocket.emit('auth-error', '服务器已关闭局域网地址访问，请改用公网地址重新连接');
            targetSocket.disconnect(true);
          }
        }
        io.emit('server-policy-updated', { lanAccessEnabled: enabled });
        recordOperation({ actor: user.username, action: 'set-lan-access', summary: enabled ? '开启局域网地址访问' : '关闭局域网地址访问', scope: 'server' });
        return acknowledgement?.({ success: true, enabled, disconnected, message: enabled ? '局域网地址访问已开启' : `局域网地址访问已关闭${disconnected ? `，已断开 ${disconnected} 个局域网会话` : ''}` });
      }
      if (action === 'set-media-processing') {
        const value = Number(payload.concurrency);
        if (!Number.isInteger(value) || value < 1 || value > MAX_MEDIA_COMPATIBILITY_CONCURRENCY) {
          return acknowledgement?.({ success: false, error: `并发转换数必须是 1-${MAX_MEDIA_COMPATIBILITY_CONCURRENCY} 的整数` });
        }
        const previousAutoConvert = mediaCompatibilityAutoConvert();
        const autoConvert = Object.prototype.hasOwnProperty.call(payload, 'autoConvert')
          ? payload.autoConvert !== false : previousAutoConvert;
        state.admin.mediaCompatibilityConcurrency = value;
        state.admin.mediaCompatibilityAutoConvert = autoConvert;
        if (!autoConvert) {
          for (const record of mediaCompatibilityQueue.splice(0)) {
            record.compatibility = { ...record.compatibility, fileName: compatibilityFileName(record), status: 'manual', progress: 0, error: '' };
            emitFileToVisible('file-updated', record);
          }
        } else if (!previousAutoConvert) {
          for (const record of state.files) enqueueMediaCompatibility(record);
        }
        persist();
        pumpMediaCompatibilityQueue();
        emitMediaProcessingSnapshots();
        recordOperation({ actor: user.username, action: 'set-media-processing', summary: `媒体自动转换${autoConvert ? '开启' : '关闭'}，并发数设置为 ${value}`, scope: 'server' });
        return acknowledgement?.({
          success: true,
          concurrency: mediaCompatibilityConcurrency(),
          status: mediaProcessingSnapshot(user, session),
          message: `${autoConvert ? '已开启上传后自动兼容转换' : '已关闭上传后自动转换，播放时仍可按需处理'}；同时转换上限为 ${value}`
        });
      }
      if (action === 'set-room-entry-notice') {
        const requestedScope = payload.scope === 'room' || normalizeRoomId(payload.roomId) ? 'room' : 'global';
        const targetRoomId = requestedScope === 'room' ? (normalizeRoomId(payload.roomId) || currentRoomId()) : '';
        const targetRoom = targetRoomId ? state.rooms[targetRoomId] : null;
        if (requestedScope === 'global' && !serverAdmin) return acknowledgement?.({ success: false, error: '只有超级管理员可以修改全服务器默认进房通知' });
        if (requestedScope === 'room' && (!visibleRoom(targetRoom) || (!serverAdmin && targetRoom.ownerUsername !== user.username))) {
          return acknowledgement?.({ success: false, error: '只能修改自己拥有的房间进房通知' });
        }
        const updatedAt = new Date().toISOString();
        if (requestedScope === 'room' && payload.inheritGlobal === true) {
          targetRoom.entryNotice = null;
          targetRoom.lastActivityAt = updatedAt;
          persist();
          const effective = effectiveRoomEntryNotice(targetRoom.id);
          io.to(roomChannel(targetRoom.id)).emit('room-entry-notice-updated', effective);
          emitRoomDirectoryChanged(targetRoom.id, 'entry-notice');
          recordOperation({ roomId: targetRoom.id, actor: user.username, action: 'set-room-entry-notice', summary: `房间 ${targetRoom.name} 恢复使用全局进房通知` });
          return acknowledgement?.({ success: true, scope: 'room', roomId: targetRoom.id, roomEntryNotice: effective, inherited: true, message: '该房间已恢复使用全服务器默认进房通知' });
        }
        const next = normalizeRoomEntryNotice({
          enabled: payload.enabled,
          title: payload.title,
          text: payload.text,
          timeoutSeconds: payload.timeoutSeconds ?? payload.durationSeconds,
          version: updatedAt,
          updatedAt,
          updatedBy: user.username
        });
        if (next.enabled && !next.text) return acknowledgement?.({ success: false, error: '启用进房通知前请填写通知内容' });
        if (requestedScope === 'global') state.admin.roomEntryNotice = next;
        else {
          targetRoom.entryNotice = next;
          targetRoom.lastActivityAt = updatedAt;
        }
        persist();
        const published = requestedScope === 'global'
          ? { ...next, scope: 'global', roomId: '' }
          : effectiveRoomEntryNotice(targetRoom.id);
        if (requestedScope === 'global') io.emit('room-entry-notice-updated', published);
        else {
          io.to(roomChannel(targetRoom.id)).emit('room-entry-notice-updated', published);
          emitRoomDirectoryChanged(targetRoom.id, 'entry-notice');
        }
        recordOperation({
          roomId: requestedScope === 'room' ? targetRoom.id : currentRoomId(), actor: user.username,
          action: 'set-room-entry-notice', summary: next.enabled
            ? `更新${requestedScope === 'global' ? '全局' : `房间 ${targetRoom.name}`}进房通知：${next.title}`
            : `关闭${requestedScope === 'global' ? '全局' : `房间 ${targetRoom.name}`}进房通知`,
          scope: requestedScope === 'global' ? 'server' : 'room'
        });
        return acknowledgement?.({
          success: true, scope: requestedScope, roomId: targetRoom?.id || '', roomEntryNotice: published,
          message: next.enabled
            ? `${requestedScope === 'global' ? '全服务器默认' : `房间 ${targetRoom.id}`}进房通知已启用`
            : `${requestedScope === 'global' ? '全服务器默认' : `房间 ${targetRoom.id}`}进房通知已关闭`
        });
      }
      if (action === 'restart-server') {
        if (!restartHandler) return acknowledgement?.({ success: false, error: '当前服务器运行方式不支持从界面重启，请在服务器设备上重新启动程序' });
        acknowledgement?.({ success: true, restarting: true, message: '服务器软件将在几秒内重新启动' });
        setTimeout(() => Promise.resolve(restartHandler()).catch((error) => console.error('服务器重启失败:', error.message)), 250).unref?.();
        return;
      }
      if (action === 'set-room-ban') {
        const roomIdValue = normalizeRoomId(payload.roomId);
        const targetRoom = roomIdValue && state.rooms[roomIdValue];
        if (!targetRoom) return acknowledgement?.({ success: false, error: '房间不存在' });
        targetRoom.banned = payload.banned !== false;
        targetRoom.banReason = targetRoom.banned ? cleanText(payload.reason || '违反服务器房间规则', 200) : '';
        targetRoom.lastActivityAt = new Date().toISOString();
        persist();
        recordOperation({ actor: user.username, action: 'room-ban', summary: `${targetRoom.banned ? '封禁' : '解除封禁'}房间：${targetRoom.name}（${targetRoom.id}）`, scope: 'server' });
        if (targetRoom.banned) {
          for (const member of [...roomUsers(targetRoom.id)]) {
            if (isSuperAdmin(member.username)) continue;
            const targetSocket = io.sockets.sockets.get(member.socketId);
            targetSocket?.emit('room-banned', { roomId: targetRoom.id, message: `房间已被服务器封禁：${targetRoom.banReason}` });
            const memberSession = sessions.get(member.sessionToken);
            if (memberSession) sessions.delete(member.sessionToken);
            removeOnlineUser(member.socketId);
            setImmediate(() => targetSocket?.disconnect(true));
          }
        }
        return acknowledgement?.({ success: true, message: targetRoom.banned ? '房间已封禁，普通成员已退出' : '房间封禁已解除' });
      }
      if (action === 'delete-room') {
        const roomIdValue = normalizeRoomId(payload.roomId);
        const targetRoom = roomIdValue && state.rooms[roomIdValue];
        if (!visibleRoom(targetRoom)) return acknowledgement?.({ success: false, error: '房间不存在' });
        return acknowledgement?.(await dissolveRoom(roomIdValue, targetRoom.ownerUsername, false, { force: true, actor: user.username }));
      }
      if (action === 'delete-rooms') {
        if (cleanText(payload.confirmation, 40) !== DANGEROUS_ACTION_CONFIRMATION) return acknowledgement?.({ success: false, error: `请完整输入“${DANGEROUS_ACTION_CONFIRMATION}”后再执行批量删除` });
        const roomIds = [...new Set((Array.isArray(payload.roomIds) ? payload.roomIds : []).map(normalizeRoomId).filter((id) => visibleRoom(state.rooms[id])))];
        if (!roomIds.length) return acknowledgement?.({ success: false, error: '请选择至少一个要删除的房间' });
        roomIds.sort((left, right) => Number(left === user.roomId) - Number(right === user.roomId));
        const deleted = [];
        for (const roomIdValue of roomIds) {
          const targetRoom = state.rooms[roomIdValue];
          if (!visibleRoom(targetRoom)) continue;
          const result = await dissolveRoom(roomIdValue, targetRoom.ownerUsername, false, { force: true, actor: user.username });
          if (result.success) deleted.push(roomIdValue);
        }
        return acknowledgement?.({ success: true, deleted, message: `已永久删除 ${deleted.length} 个房间及其全部数据` });
      }
      if (action === 'factory-reset') {
        if (cleanText(payload.confirmation, 40) !== DANGEROUS_ACTION_CONFIRMATION) return acknowledgement?.({ success: false, error: `请完整输入“${DANGEROUS_ACTION_CONFIRMATION}”后再恢复出厂设置` });
        if (factoryResetHandler) {
          acknowledgement?.({ success: true, restarting: true, message: '恢复出厂设置已确认，服务器即将清空全部数据并重新启动' });
          setTimeout(() => Promise.resolve(factoryResetHandler({ dataDir, confirmation: DANGEROUS_ACTION_CONFIRMATION })).catch((error) => console.error('恢复出厂设置失败:', error.message)), 250).unref?.();
          return;
        }
        await resetServerDataInPlace();
        return acknowledgement?.({ success: true, message: '服务器已恢复出厂设置，全部账户、房间、媒体、聊天、配置和缓存均已清空' });
      }
      if (action === 'resolve-login-limit-request') {
        if (user.username !== 'admin') return acknowledgement?.({ success: false, error: '登录安全限制只能由内置 admin 处理' });
        const request = state.admin.loginLimitRequests.find((entry) => entry.id === cleanText(payload.requestId, 80));
        if (!request || request.status !== 'pending') return acknowledgement?.({ success: false, error: '解除登录限制申请不存在或已处理' });
        const approved = payload.approved === true;
        request.status = approved ? 'approved' : 'denied';
        request.resolvedAt = new Date().toISOString();
        request.resolvedBy = user.username;
        if (approved) for (const key of loginFailureKeysForIp(request.ipAddress, request.username)) rateBuckets.delete(key);
        persist();
        recordOperation({ actor: user.username, action: 'login-limit-resolve', summary: `${approved ? '同意' : '拒绝'}解除登录限制：${request.username || '未知账号'}`, scope: 'server' });
        const result = {
          requestId: request.id, username: request.username, approved, status: request.status, resolvedAt: request.resolvedAt,
          message: approved ? '管理员已解除登录限制，请重新登录' : '管理员未同意解除登录限制'
        };
        const recipients = new Set();
        if (request.requesterSocketId) recipients.add(request.requesterSocketId);
        for (const [socketId, connectedSocket] of io.sockets.sockets) if (getSocketIp(connectedSocket) === request.ipAddress) recipients.add(socketId);
        for (const socketId of recipients) io.to(socketId).emit('login-limit-clear-resolved', result);
        return acknowledgement?.({ success: true, request, ...result });
      }
      if (action === 'delete-registration-request' || action === 'delete-registration-requests') {
        if (user.username !== 'admin') return acknowledgement?.({ success: false, error: '注册申请记录只能由内置 admin 删除' });
        const ids = new Set((action === 'delete-registration-request'
          ? [payload.requestId] : (Array.isArray(payload.requestIds) ? payload.requestIds : []))
          .map((id) => cleanText(id, 80)).filter(Boolean).slice(0, 500));
        if (!ids.size) return acknowledgement?.({ success: false, error: '请选择要删除的注册申请' });
        const deleted = state.admin.registrationRequests.filter((entry) => ids.has(entry.id));
        if (!deleted.length) return acknowledgement?.({ success: false, error: '未找到可删除的注册申请' });
        state.admin.registrationRequests = state.admin.registrationRequests.filter((entry) => !ids.has(entry.id));
        persist();
        for (const request of deleted) {
          const counts = normalizeRegistrationRequestCounts(request);
          recordOperation({ actor: user.username, action: 'registration-request-delete', summary: `删除注册申请：${request.username}（剩余 ${counts.remainingCount} / 总计 ${counts.totalRequestedCount} 个名额）`, scope: 'server' });
        }
        return acknowledgement?.({ success: true, deleted: deleted.map((entry) => entry.id), count: deleted.length, message: `已删除 ${deleted.length} 条注册申请记录` });
      }
      if (action === 'approve-registration-request' || action === 'deny-registration-request') {
        const request = state.admin.registrationRequests.find((entry) => entry.id === cleanText(payload.requestId, 80));
        if (!request || request.status !== 'pending') return acknowledgement?.({ success: false, error: '注册申请不存在或已处理' });
        Object.assign(request, normalizeRegistrationRequestCounts(request));
        const approvedCount = request.remainingCount;
        request.status = action === 'approve-registration-request' ? 'approved' : 'denied';
        request.resolvedAt = new Date().toISOString();
        request.resolvedBy = user.username;
        const registrationResult = request.status === 'approved'
          ? { approved: true, username: request.username, requestId: request.id, requestedCount: approvedCount, remainingCount: approvedCount, totalRequestedCount: request.totalRequestedCount, message: `管理员已同意 ${approvedCount} 个注册名额，请继续完成注册` }
          : { approved: false, username: request.username, requestId: request.id, message: '管理员已拒绝本次注册申请' };
        if (request.status === 'approved') {
          state.admin.registrationAllowances[request.ip] = Math.max(0, Number(state.admin.registrationAllowances[request.ip]) || 0) + approvedCount;
        }
        const notifiedSockets = new Set();
        if (request.requesterSocketId) notifiedSockets.add(request.requesterSocketId);
        for (const [socketId, connectedSocket] of io.sockets.sockets) {
          if (getSocketIp(connectedSocket) === request.ip) notifiedSockets.add(socketId);
        }
        for (const socketId of notifiedSockets) io.to(socketId).emit('registration-request-resolved', registrationResult);
        persist();
        return acknowledgement?.({ success: true, message: request.status === 'approved' ? `已允许该 IP 再注册 ${approvedCount} 个账号` : '已拒绝注册申请' });
      }
      if (action === 'add-registration-whitelist' || action === 'remove-registration-whitelist') {
        const ipAddress = normalizeIp(payload.ipAddress);
        if (!ipAddress || !net.isIP(ipAddress)) return acknowledgement?.({ success: false, error: 'IP 地址格式不正确' });
        if (action === 'add-registration-whitelist' && !state.admin.registrationIpWhitelist.includes(ipAddress)) state.admin.registrationIpWhitelist.push(ipAddress);
        if (action === 'remove-registration-whitelist') state.admin.registrationIpWhitelist = state.admin.registrationIpWhitelist.filter((entry) => entry !== ipAddress);
        persist();
        return acknowledgement?.({ success: true, message: action === 'add-registration-whitelist' ? 'IP 已加入多账号注册白名单' : 'IP 已移出注册白名单' });
      }
      if (action === 'set-default-account-password') {
        const newPassword = String(payload.newPassword || '');
        const passwordError = passwordPolicyError(newPassword);
        if (passwordError) return acknowledgement?.({ success: false, error: passwordError });
        state.admin.defaultAccountPasswordHash = await makePasswordHashAsync(newPassword);
        persist();
        recordOperation({ actor: user.username, action: 'default-account-password', summary: '更新账户默认重置密码', scope: 'server' });
        return acknowledgement?.({ success: true, message: '账户默认重置密码已更新' });
      }
      if (action === 'set-account-password') {
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        if (!account || account.guest) return acknowledgement?.({ success: false, error: '账号不存在或游客不能设置密码' });
        const newPassword = String(payload.newPassword ?? '');
        const passwordError = passwordPolicyError(newPassword);
        if (passwordError) return acknowledgement?.({ success: false, error: passwordError });
        account.passwordHash = await makePasswordHashAsync(newPassword);
        account.mustChangePassword = false;
        account.passwordChangedAt = new Date().toISOString();
        clearPasswordResetState(`account:${username}`);
        revokeUserSessions(username, 'auth-error', '密码已被管理员更新，请使用新密码重新登录');
        persist();
        recordOperation({ actor: user.username, action: 'account-password-set', summary: `管理员为 ${username} 设置新密码`, scope: 'server' });
        return acknowledgement?.({ success: true, username, message: '密码已更新；出于安全原因系统不会保存或再次显示明文，请将刚设置的密码交给用户' });
      }
      if (action === 'batch-account-action') {
        const usernames = [...new Set((Array.isArray(payload.usernames) ? payload.usernames : []).map(cleanUsername).filter(Boolean))].slice(0, 500);
        const batchAction = cleanText(payload.batchAction, 40);
        if (!usernames.length) return acknowledgement?.({ success: false, error: '请先选择账号' });
        if (!['reset-password', 'block-rooms', 'delete'].includes(batchAction)) return acknowledgement?.({ success: false, error: '批量账号操作无效' });
        const completed = [];
        const skipped = [];
        for (const username of usernames) {
          const account = state.accounts[username];
          if (!account) { skipped.push(`${username}（不存在）`); continue; }
          if (batchAction === 'reset-password') {
            account.passwordHash = state.admin.defaultAccountPasswordHash || makePasswordHash('123456');
            account.mustChangePassword = true;
            account.passwordChangedAt = new Date().toISOString();
            clearPasswordResetState(`account:${username}`);
            revokeUserSessions(username, 'auth-error', '密码已被管理员重置为服务器默认密码，请重新登录并修改密码');
            completed.push(username);
          } else if (batchAction === 'block-rooms') {
            if (username === 'admin') { skipped.push(`${username}（内置管理员）`); continue; }
            account.roomCreationBlocked = true;
            accountChangeNotice(username, { kind: 'room-create-policy', actor: user.username, message: '管理员已禁止该账号继续创建房间' }, 'permissions-changed', { changed: ['roomCreationBlocked'], message: '管理员已禁止该账号继续创建房间' });
            completed.push(username);
          } else {
            if (username === 'admin') { skipped.push(`${username}（内置管理员）`); continue; }
            if (ownedRooms(username).length) { skipped.push(`${username}（仍拥有房间）`); continue; }
            for (const room of Object.values(state.rooms)) {
              delete room.permissions[username];
              delete room.memberGroups[username];
            }
            delete state.accounts[username];
            if (!state.deletedUsernames.includes(username)) state.deletedUsernames.push(username);
            revokeUserSessions(username, 'auth-error', '账号已被管理员删除');
            completed.push(username);
          }
        }
        persist();
        recordOperation({ actor: user.username, action: `account-batch-${batchAction}`, summary: `批量账号操作 ${batchAction}：成功 ${completed.length}，跳过 ${skipped.length}`, scope: 'server' });
        return acknowledgement?.({ success: true, completed, skipped, message: `批量操作完成：成功 ${completed.length} 个${skipped.length ? `，跳过 ${skipped.length} 个` : ''}` });
      }
      if (action === 'reset-account-password') {
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        const newPassword = String(payload.newPassword || '');
        if (!account) return acknowledgement?.({ success: false, error: '账号不存在' });
        if (payload.useDefault === true) account.passwordHash = state.admin.defaultAccountPasswordHash || makePasswordHash('123456');
        else {
          const passwordError = passwordPolicyError(newPassword);
          if (passwordError) return acknowledgement?.({ success: false, error: passwordError });
          account.passwordHash = await makePasswordHashAsync(newPassword);
        }
        account.mustChangePassword = true;
        account.passwordChangedAt = new Date().toISOString();
        clearPasswordResetState(`account:${username}`);
        revokeUserSessions(username, 'auth-error', '密码已被管理员重置，请使用新密码登录');
        persist(); recordOperation({ actor: user.username, action: 'account-password-reset', summary: `重置账号密码：${username}`, scope: 'server' });
        return acknowledgement?.({ success: true, message: '密码已重置，该账号已下线' });
      }
      if (action === 'force-display-name') {
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        const displayName = cleanUsername(payload.displayName);
        if (!account) return acknowledgement?.({ success: false, error: '账号不存在' });
        if (!validUsername(displayName)) return acknowledgement?.({ success: false, error: '名字需为 2-24 位中文、字母、数字、下划线或短横线' });
        if (Object.entries(state.accounts).some(([name, entry]) => name !== username && String(entry.displayName || name).toLocaleLowerCase() === displayName.toLocaleLowerCase())) return acknowledgement?.({ success: false, error: '此名字已被其他账号使用' });
        const before = account.displayName || username;
        account.displayName = displayName;
        try { await renameStoredChatDisplayName(username, displayName); }
        catch (error) { account.displayName = before; throw error; }
        persist();
        recordOperation({ actor: user.username, action: 'display-name-force', summary: `强制改名：${before} → ${displayName}`, scope: 'server', undo: { kind: 'display-name', username, before, after: displayName } });
        for (const id of Object.keys(state.rooms)) io.to(roomChannel(id)).emit('users-list', usersList(id));
        accountChangeNotice(username, {
          kind: 'account-profile', actor: user.username, actorName: state.accounts[user.username]?.displayName || user.username,
          changed: ['displayName'], previousDisplayName: before, displayName,
          message: `管理员已将您的显示名称从 ${before} 修改为 ${displayName}`
        }, 'account-profile-updated', { kind: 'account-profile', profile: accountProfile(username), changed: ['displayName'], message: `管理员已将您的显示名称修改为 ${displayName}` });
        return acknowledgement?.({ success: true, message: '账户名字已更新', username, displayName });
      }
      if (action === 'set-account-remark') {
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        if (!account) return acknowledgement?.({ success: false, error: '账号不存在' });
        account.adminRemark = cleanText(payload.remark, 80);
        persist();
        recordOperation({ actor: user.username, action: 'account-remark', summary: `更新账号备注：${username}${account.adminRemark ? `（${account.adminRemark}）` : ''}`, scope: 'server' });
        return acknowledgement?.({ success: true, username, remark: account.adminRemark, message: account.adminRemark ? '账号备注已保存' : '账号备注已清除' });
      }
      if (action === 'delete-account') {
        const username = cleanUsername(payload.username);
        const account = state.accounts[username];
        if (!account) return acknowledgement?.({ success: false, error: '账号不存在' });
        if (username === 'admin') return acknowledgement?.({ success: false, error: '内置 admin 超级管理员不能删除，只能在服务器上重置密码' });
        if (ownedRooms(username).length) return acknowledgement?.({ success: false, error: '不能删除仍拥有房间的账号' });
        const permissions = {};
        for (const room of Object.values(state.rooms)) if (room.permissions[username]) { permissions[room.id] = room.permissions[username]; delete room.permissions[username]; }
        delete state.accounts[username];
        emailBindingCodes.delete(username);
        clearPasswordResetState(`account:${username}`);
        if (!state.deletedUsernames.includes(username)) state.deletedUsernames.push(username);
        revokeUserSessions(username, 'auth-error', '账号已被管理员删除');
        persist();
        recordOperation({ actor: user.username, action: 'account-delete', summary: `删除账号：${username}`, scope: 'server', undo: { kind: 'account-delete', username, account, permissions } });
        return acknowledgement?.({ success: true, message: '账号已删除（其上传文件保留，可在操作历史中回溯）' });
      }
      if (action === 'approve-upload' || action === 'reject-upload') {
        const file = findFile(cleanText(payload.fileId, 80));
        if (!file || file.roomId !== currentRoomId() || file.status !== 'pending') return acknowledgement?.({ success: false, error: '待审核文件不存在' });
        if (action === 'approve-upload') {
          file.status = 'approved';
          const reassociated = reassociateSubtitles();
          persist();
          emitFileToVisible('file-uploaded', file);
          for (const changed of reassociated) if (changed.id !== file.id) emitFileToVisible('file-updated', changed);
          setImmediate(() => enqueueMediaAnalysis(file));
          recordOperation({ actor: user.username, action: 'upload-approve', summary: `审核通过：${file.originalName}`, undo: { kind: 'upload-status', fileId: file.id, before: 'pending', after: 'approved' } });
        }
        else {
          const deletionId = crypto.randomUUID();
          const fileSnapshot = JSON.parse(JSON.stringify(file));
          const artifacts = moveFileArtifactsToTrash(file, deletionId);
          state.files = state.files.filter((entry) => entry.id !== file.id);
          const reassociated = reassociateSubtitles();
          persist();
          recordOperation({ id: deletionId, actor: user.username, action: 'upload-reject', summary: `拒绝上传：${file.originalName}`, undo: { kind: 'file-delete', file: fileSnapshot, artifacts, queueBefore: [...state.queue], playbackBefore: null } });
          io.to(roomChannel()).emit('file-deleted', file.id);
          for (const changed of reassociated) emitFileToVisible('file-updated', changed);
        }
        const approved = action === 'approve-upload';
        const applicantMessage = approved ? `管理员已审核通过您上传的《${file.originalName}》` : `管理员已拒绝您上传的《${file.originalName}》`;
        accountChangeNotice(file.uploadedBy, { kind: 'upload-review', roomId: file.roomId, message: applicantMessage, approved, fileId: file.id });
        persist();
        return acknowledgement?.({ success: true, message: approved ? '已允许上传' : '已拒绝并删除文件' });
      }
      if (action === 'unban') {
        state.blacklist = state.blacklist.filter((item) => item.id !== cleanText(payload.id, 80)); persist();
        recordOperation({ actor: user.username, action: 'unban', summary: '解除设备封禁', scope: 'server' });
        return acknowledgement?.({ success: true, message: '已解除封禁', blacklist: state.blacklist });
      }
      if (action === 'ban-user' && payload.ipAddress) {
        const ip = normalizeIp(payload.ipAddress);
        if (!ip || !net.isIP(ip)) return acknowledgement?.({ success: false, error: 'IP 地址格式不正确' });
        const entry = { id: crypto.randomUUID(), ip, username: cleanText(payload.username || `IP ${ip}`, 120), deviceName: cleanText(payload.deviceName, 80), createdAt: new Date().toISOString() };
        if (!state.blacklist.some((item) => item.ip === ip)) state.blacklist.push(entry);
        persist(); recordOperation({ actor: user.username, action: 'ban-user', summary: `封禁设备地址：${ip}`, scope: 'server' }); revokeIpSessions(ip, 'banned', '此设备地址已被管理员封禁');
        return acknowledgement?.({ success: true, message: `IP ${ip} 已被封禁`, blacklist: state.blacklist });
      }
      const target = users.get(cleanText(payload.targetSocketId, 80));
      if (!target || target.roomId !== currentRoomId()) return acknowledgement?.({ success: false, error: '目标用户已离线或不在当前房间' });
      if (isSuperAdmin(target.username)) return acknowledgement?.({ success: false, error: '超级管理员受服务器保护，不能被移出或封禁' });
      if (action === 'kick-user') { recordOperation({ actor: user.username, action: 'kick-user', summary: `移出成员：${target.username}` }); revokeUserSessions(target.username, 'kicked', '您已被管理员移出房间'); return acknowledgement?.({ success: true, message: '用户已被移出' }); }
      if (action === 'ban-user') {
        const entry = { id: crypto.randomUUID(), ip: target.ipAddress, username: target.username, deviceName: target.deviceName, createdAt: new Date().toISOString() };
        if (!state.blacklist.some((item) => item.ip === entry.ip)) state.blacklist.push(entry);
        persist(); recordOperation({ actor: user.username, action: 'ban-user', summary: `封禁设备：${target.username} / ${entry.ip}`, scope: 'server' }); revokeIpSessions(entry.ip, 'banned', '此设备地址已被管理员封禁');
        return acknowledgement?.({ success: true, message: '用户已被封禁' });
      }
      return acknowledgement?.({ success: false, error: '未知管理操作' });
    });

    socket.on('disconnect', (reason) => {
      const user = users.get(socket.id);
      if (user) {
        const runtime = roomRuntime(user.roomId);
        clearScreenFrameDelivery(runtime, socket.id);
        if (runtime.screenWebrtcViewers.delete(socket.id)) emitScreenFallbackState(user.roomId);
        leaveLiveVoice(user, 'disconnect');
        if (closing) { users.delete(socket.id); return; }
        const explicitDisconnect = reason === 'client namespace disconnect' || reason === 'server namespace disconnect';
        if (explicitDisconnect) removeOnlineUser(socket.id, { scheduleClose: false, reason: 'disconnect' });
        else scheduleDisconnectedUserRemoval(socket.id);
      }
      stopScreenShare(socket.id, user?.roomId);
    });
  });

  const syncTimer = setInterval(() => {
    for (const [id, runtime] of roomRuntimes) {
      if (runtime.roomState.playback.fileId && runtime.roomState.playback.isPlaying) {
        withRoom(id, () => io.to(roomChannel(id)).emit('playback-sync', playbackSnapshot(id)));
      }
    }
  }, 2000);
  syncTimer.unref?.();
  const rateCleanupTimer = setInterval(() => {
    const now = Date.now();
    const resetNow = passwordResetNow();
    for (const [key, bucket] of rateBuckets) if (bucket.expiresAt <= now) rateBuckets.delete(key);
    for (const [key, entry] of passwordResetCodes) if (entry.expiresAt <= resetNow) passwordResetCodes.delete(key);
    for (const [token, entry] of passwordResetTokens) if (entry.expiresAt <= resetNow) passwordResetTokens.delete(token);
    for (const [username, entry] of emailBindingCodes) if (entry.expiresAt <= resetNow) emailBindingCodes.delete(username);
    for (const [email, entry] of registrationEmailCodes) if (entry.expiresAt <= resetNow) registrationEmailCodes.delete(email);
    for (const [token, session] of sessions) {
      if (now < session.expiresAt && now - session.lastSeenAt < sessionIdleTimeoutMs) continue;
      expireSession(token, session);
    }
    for (const [ip, entry] of guestSessionsByIp) {
      const guestSession = sessions.get(entry?.token);
      if (!guestSession || guestSession.username !== entry?.username || !state.accounts[entry?.username]?.guest) guestSessionsByIp.delete(ip);
    }
    for (const [token, entry] of guestSessionRecords) {
      const guestSession = sessions.get(token);
      if (!guestSession || guestSession.username !== entry?.username || !state.accounts[entry?.username]?.guest) guestSessionRecords.delete(token);
    }
    cleanupTrash();
  }, 10 * 60 * 1000);
  rateCleanupTimer.unref?.();

  app.use('/api', (req, res) => res.status(404).json({ success: false, error: '接口不存在' }));
  app.use((req, res) => {
    if (req.method === 'GET' && req.accepts('html')) return res.sendFile(path.join(publicDir, 'index.html'));
    return res.status(404).json({ success: false, error: '接口不存在' });
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if (closing && (req.aborted || req.destroyed || error?.code === 'ECONNRESET' || error?.message === 'Request aborted')) return res.destroy();
    if (error?.code === 'INSUFFICIENT_STORAGE' || error?.statusCode === 507) {
      return res.status(507).json({ success: false, error: diskSpaceError().message });
    }
    if (error?.code === 'UPLOAD_CATEGORY_NOT_ALLOWED') {
      return res.status(415).json({
        success: false, code: error.code, requestable: true,
        category: cleanText(error.category, 32), originalName: normalizeOriginalName(error.originalName),
        allowedUploadCategories: allowedUploadCategories(), error: error.message
      });
    }
    if (['TEXT_UPLOAD_DISABLED', 'INVALID_TEXT_CONTENT'].includes(error?.code)) {
      return res.status(415).json({ success: false, code: error.code, error: error.message });
    }
    if (error?.code === 'TEXT_FILE_TOO_LARGE') {
      return res.status(413).json({ success: false, code: error.code, error: error.message });
    }
    if (error?.code === 'LIMIT_FILE_SIZE_MIN') {
      return res.status(413).json({ success: false, code: error.code, error: error.message });
    }
    if (error?.code === 'MEDIA_UPLOAD_BANNED') {
      return res.status(403).json({
        success: false, code: error.code, originalName: normalizeOriginalName(error.originalName),
        error: error.message
      });
    }
    if (Number(error?.statusCode) === 415) {
      return res.status(415).json({ success: false, error: error.message || '文件格式不受支持' });
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      if (req.path.startsWith('/api/download-assets/')) return res.status(413).json({ success: false, error: '安装文件不能超过 4 GB' });
      if (req.path === '/api/login-cube-model') return res.status(413).json({ success: false, error: '自定义 GLB 模型不能超过 25 MB' });
      if (req.path === '/api/voice') return res.status(413).json({ success: false, error: '语音文件不能超过 25MB' });
      const effectiveLimit = uploadPolicyExempt(req.syncWatchSession)
        ? HARD_MEDIA_UPLOAD_LIMIT_BYTES : uploadLimitForAccount(req.syncWatchSession?.username || '');
      if (effectiveLimit >= HARD_MEDIA_UPLOAD_LIMIT_BYTES) return res.status(413).json({ success: false, error: '文件超过服务器 32GB 安全上限' });
      const mb = Math.round(effectiveLimit / 1024 / 1024);
      return res.status(413).json({ success: false, error: `文件超过 ${mb}MB 上传限制` });
    }
    console.error('请求处理失败:', error.message);
    return res.status(400).json({ success: false, error: error.message || '请求失败' });
  });

  async function listen() {
    const start = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : DEFAULT_PORT;
    const randomPorts = (count) => Array.from({ length: count }, () => crypto.randomInt(20000, 45000));
    const candidates = start === 0 ? randomPorts(30) : [start, ...randomPorts(portFallbackCount)];
    const wildcardHost = !host || host === '0.0.0.0' || host === '::';
    const loopbackPortAvailable = (port) => new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', (error) => {
        if (['EADDRINUSE', 'EACCES'].includes(error.code)) resolve(false);
        else reject(error);
      });
      probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
        probe.close((error) => error ? reject(error) : resolve(true));
      });
    });
    let lastError;
    for (const candidate of candidates) {
      try {
        if (wildcardHost && !await loopbackPortAvailable(candidate)) {
          const error = new Error(`Loopback port ${candidate} is already in use`);
          error.code = 'EADDRINUSE';
          throw error;
        }
        await new Promise((resolve, reject) => {
          const onError = (error) => { httpServer.off('listening', onListening); reject(error); };
          const onListening = () => { httpServer.off('error', onError); resolve(); };
          httpServer.once('error', onError); httpServer.once('listening', onListening); httpServer.listen(candidate, host);
        });
        actualPort = httpServer.address().port;
        return;
      } catch (error) {
        lastError = error;
        // Windows reserves dynamic port ranges and may report EACCES for a
        // random high port. Port 0 mode is used by tests/embedded launches,
        // so keep trying bounded candidates instead of failing nondeterministically.
        if (['EADDRINUSE', 'EACCES'].includes(error.code)) continue;
        throw error;
      }
    }
    const error = lastError || new Error('没有可用端口');
    if (start > 0 && options.strictPort) {
      error.message = `端口 ${start} 已被占用，未随机切换端口；请关闭占用程序或在服务器设置中改用其他端口`;
      error.code = error.code || 'EADDRINUSE';
    }
    throw error;
  }

  await listen();
  const addresses = advertisedNetworkAddresses();
  rememberAllowedUrl(`http://127.0.0.1:${actualPort}`);
  rememberAllowedUrl(`http://localhost:${actualPort}`);
  rememberAllowedUrl(`http://${os.hostname()}:${actualPort}`);
  for (const address of addresses) rememberAllowedUrl(address);
  console.log(`SyncWatch同步观影 ${APP_VERSION} 已启动: http://127.0.0.1:${actualPort}`);
  for (const address of addresses) console.log(`局域网地址: ${address}`);
  if (requestedPort !== 0 && options.discovery !== false) {
    try {
      discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      discoverySocket.on('message', (message, remote) => {
        if (!privateOrLoopbackAddress(remote.address) || String(message).trim() !== 'SYNCWATCH_DISCOVER_V1') return;
        const payload = Buffer.from(JSON.stringify({
          protocol: 'SYNCWATCH_DISCOVER_V1', name: `SyncWatch同步观影-${APP_VERSION}`, server: os.hostname(), version: APP_VERSION,
          port: actualPort, addresses: advertisedNetworkAddresses(),
          rooms: Object.values(state.rooms).filter((room) => visibleRoom(room) && !room.archived).map((room) => ({
            id: room.id, name: room.name, ownerUsername: room.ownerUsername,
            ownerName: state.accounts[room.ownerUsername]?.displayName || room.ownerUsername,
            maxUsers: room.maxUsers, online: roomUsers(room.id).length, passwordRequired: Boolean(room.passwordHash)
          }))
        }), 'utf8');
        discoverySocket?.send(payload, remote.port, remote.address, () => {});
      });
      discoverySocket.on('error', (error) => console.warn('局域网房间发现服务不可用:', error.message));
      discoverySocket.bind(discoveryPort, '0.0.0.0', () => { try { discoverySocket?.setBroadcast(true); } catch (_) {} });
    } catch (error) { console.warn('局域网房间发现服务启动失败:', error.message); }
  }
  setImmediate(() => {
    try {
      for (const entry of fs.readdirSync(compatibleMediaDir)) {
        if (!entry.includes('.partial-')) continue;
        try { fs.unlinkSync(path.join(compatibleMediaDir, entry)); } catch (_) {}
      }
    } catch (_) {}
    for (const file of state.files) {
      if (!isPlayableFile(file)) continue;
      if ((file.category === 'video' && (mediaMetadataNeedsAnalysis(file) || mediaThumbnailNeedsAnalysis(file)))
        || (file.category === 'audio' && !file.metadata?.audioCodec)) enqueueMediaAnalysis(file);
      else enqueueMediaCompatibility(file);
    }
  });

  async function settleWithin(promise, timeoutMs) {
    let timer;
    const completed = Promise.resolve(promise).then(() => true, () => true);
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const result = await Promise.race([completed, timedOut]);
    clearTimeout(timer);
    return result;
  }

  async function drainMutations(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (activeSocketHandlers.size || activeHttpMutations.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const snapshot = Promise.allSettled([...activeSocketHandlers, ...activeHttpMutations]);
      if (!await settleWithin(snapshot, remaining)) return false;
    }
    return true;
  }

  async function waitForMediaProcesses(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (mediaAnalysisProcesses.size || mediaCompatibilityProcesses.size) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }

  async function startConfiguredTunnel() {
    if (!tunnelManager?.startConfiguredTunnel || !tunnelManager?.startupSettings) return { state: 'unavailable', error: '当前环境不支持公网隧道' };
    const startup = await tunnelManager.startupSettings();
    if (!startup?.autoStartTunnel) return tunnelManager.status();
    const existing = await tunnelManager.status();
    if (existing?.state === 'running') { synchronizeTunnelUrl(existing); return existing; }
    const status = await tunnelManager.startConfiguredTunnel();
    synchronizeTunnelUrl(status);
    return status;
  }

  return {
    app, io, httpServer, port: actualPort, host, addresses, dataDir, uploadsDir, compatibleMediaDir, startConfiguredTunnel,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        let safeToReleaseLock = false;
        let shutdownError = null;
        try {
          acceptingMutations = false;
          closing = true;
          passwordResetCodes.clear();
          passwordResetTokens.clear();
          emailBindingCodes.clear();
          registrationEmailCodes.clear();
          clearInterval(syncTimer);
          clearInterval(rateCleanupTimer);
          clearTimeout(qualityBroadcastTimer);
          if (discoverySocket) {
            try { discoverySocket.close(); } catch (_) {}
            discoverySocket = null;
          }
          for (const timer of disconnectTimers.values()) clearTimeout(timer);
          for (const timer of emptyRoomTimers.values()) clearTimeout(timer);
          emptyRoomTimers.clear();
          for (const runtime of roomRuntimes.values()) clearScreenFrameDeliveries(runtime);

          const earlyTunnelStop = Promise.resolve().then(() => tunnelManager?.stop?.()).catch(() => {});
          forgetTunnelUrl();

          try {
            if (!await drainMutations(closeDrainTimeoutMs)) {
              const partialCleanup = [];
              for (const req of [...activeHttpRequests]) {
                for (const filename of req.syncWatchPartialUploads || []) partialCleanup.push(removeManagedPartialFile(filename));
                try { req.destroy(); } catch (_) {}
                try { req.socket?.destroy(); } catch (_) {}
              }
              httpServer.closeIdleConnections?.();
              await settleWithin(Promise.allSettled([...activeSocketHandlers, ...activeHttpMutations, ...partialCleanup]), closeAbortGraceMs);
            }

            analysisClosing = true;
            mediaAnalysisQueue.length = 0;
            mediaCompatibilityQueue.length = 0;
            for (const child of [...mediaAnalysisProcesses]) {
              if (typeof child.syncWatchAbort === 'function') child.syncWatchAbort('服务器关闭，媒体分析已终止');
              else terminateProcessTree(child, true);
            }
            for (const child of [...mediaCompatibilityProcesses]) {
              if (typeof child.syncWatchAbort === 'function') child.syncWatchAbort('服务器关闭，兼容媒体生成已终止');
              else terminateProcessTree(child, true);
            }
            const analysisStopped = !mediaAnalysisJobs.size || await settleWithin(Promise.allSettled([...mediaAnalysisJobs]), closeFinalTimeoutMs);
            const compatibilityStopped = !mediaCompatibilityJobs.size || await settleWithin(Promise.allSettled([...mediaCompatibilityJobs]), closeFinalTimeoutMs);
            const processesStopped = await waitForMediaProcesses(closeFinalTimeoutMs);
            const mailStopped = !mailDeliveryJobs.size || await settleWithin(Promise.allSettled([...mailDeliveryJobs]), closeFinalTimeoutMs);
            if (!analysisStopped || !compatibilityStopped || !processesStopped || !mailStopped) {
              throw new Error('后台任务未能在安全时限内停止，数据目录锁将保留到本进程退出');
            }

            cleanupTrash(false);
            await flushPendingChatLines();
            if (persistTimer) clearTimeout(persistTimer);
            persistTimer = null;
            snapshotAllRoomRuntimes();
            atomicWriteJson(stateFile, state);
          } catch (error) { shutdownError = error; }

          try {
            const finalTunnelStop = Promise.resolve().then(() => tunnelManager?.stop?.()).catch(() => {});
            const tunnelStopped = await settleWithin(Promise.allSettled([earlyTunnelStop, finalTunnelStop]), closeFinalTimeoutMs);
            forgetTunnelUrl();
            const closed = new Promise((resolve) => io.close(resolve));
            httpServer.closeAllConnections?.();
            const networkStopped = await settleWithin(closed, closeFinalTimeoutMs);
            if (!tunnelStopped || !networkStopped) throw new Error('网络服务未能在安全时限内停止，数据目录锁将保留到本进程退出');
          } catch (error) {
            shutdownError = shutdownError ? new AggregateError([shutdownError, error], '服务器关闭时发生多个错误') : error;
          }

          if (shutdownError) throw shutdownError;
          safeToReleaseLock = true;
        } finally {
          if (safeToReleaseLock) dataDirectoryLock.release();
        }
      })();
      return closePromise;
    }
  };
  } catch (error) {
    try { dataDirectoryLock.release(); }
    catch (releaseError) { console.error(`启动失败后释放数据目录锁失败：${releaseError.message}`); }
    throw error;
  }
}

if (require.main === module) {
  let controller = null;
  let stopping = false;
  let startPromise = null;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    try {
      const activeController = controller || await startPromise?.catch(() => null);
      await activeController?.close();
    }
    catch (error) { console.error(`收到 ${signal} 后安全关闭失败：`, error); process.exitCode = 1; }
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  startPromise = startSyncWatchServer().then(async (started) => {
    controller = started;
    if (stopping) await controller.close();
    return controller;
  }).catch((error) => { console.error('服务器启动失败:', error); process.exitCode = 1; throw error; });
  startPromise.catch(() => {});
}

module.exports = {
  APP_VERSION, FILE_TYPES, startSyncWatchServer, resolveDefaultDataDir,
  _test: {
    captureProcess, requestHostHeader, requestUsesForwardedHttps, requestUsesPublicProxy, socketOriginAllowed, pipeMediaFileResponse,
    createTrustedProxyMatcher, normalizeTrustedProxyEntries, resolveClientIp,
    attachmentContentDisposition, downloadMimeType,
    clampMediaRangeEnd, requestSkipsCompression,
    OPEN_ENDED_MEDIA_RANGE_CHUNK_THRESHOLD_BYTES, MAX_OPEN_ENDED_MEDIA_RANGE_BYTES,
    resolveFileType, HLS_EXTENSIONS,
    applyNetworkQualitySample
  }
};
