'use strict';

const DEFAULT_RELEASE_API = 'https://api.github.com/repos/xuange6610/SyncWatch/releases/latest';
const DEFAULT_RELEASE_ATOM = 'https://github.com/xuange6610/SyncWatch/releases.atom';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RELEASE_RESPONSE_BYTES = 512 * 1024;
const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/i;

function normalizeReleaseTag(value) {
  const candidate = String(value || '').trim();
  const match = candidate.match(SEMVER_TAG);
  if (!match) return '';
  if (match[4]?.split('.').some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return '';
  return `v${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}${match[5] ? `+${match[5]}` : ''}`;
}

function semverParts(value) {
  const normalized = normalizeReleaseTag(value);
  if (!normalized) return null;
  const match = normalized.match(SEMVER_TAG);
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function comparePrerelease(left = [], right = []) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) return BigInt(left[index]) > BigInt(right[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function compareReleaseTags(left, right) {
  const leftParts = semverParts(left);
  const rightParts = semverParts(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts.core[index] !== rightParts.core[index]) return leftParts.core[index] > rightParts.core[index] ? 1 : -1;
  }
  return comparePrerelease(leftParts.prerelease, rightParts.prerelease);
}

function cleanText(value, limit) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function extractAtomReleaseTag(feedText) {
  const entries = String(feedText || '').match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || [];
  for (const entry of entries) {
    const fields = [
      entry.match(/<id\b[^>]*>([\s\S]*?)<\/id>/i)?.[1],
      entry.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1],
      entry.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i)?.[1]
    ];
    for (const field of fields) {
      const candidate = String(field || '').replace(/&amp;/gi, '&').trim();
      const match = candidate.match(/(?:^|\/)(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:$|[?#\s<])/i)
        || candidate.match(/\b(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/i);
      const tagName = normalizeReleaseTag(match?.[1]);
      if (tagName) return tagName;
    }
  }
  return '';
}

function releaseValue(payload, checkedAt) {
  const tagName = normalizeReleaseTag(payload?.tag_name);
  if (!tagName || payload?.draft === true) {
    return { success: false, code: 'GITHUB_INVALID_RELEASE', networkFailure: false, cached: false, stale: false, error: 'GitHub Latest 版本信息无效' };
  }
  let releaseUrl = '';
  try {
    const parsed = new URL(String(payload?.html_url || ''));
    if (parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'github.com') releaseUrl = parsed.toString();
  } catch (_) {}
  return {
    success: true,
    tag_name: tagName,
    name: cleanText(payload?.name, 120),
    html_url: releaseUrl,
    prerelease: payload?.prerelease === true,
    checkedAt
  };
}

function failureFor(error) {
  if (error?.releaseCheckFailure) return error.releaseCheckFailure;
  if (['AbortError', 'TimeoutError'].includes(error?.name) || error?.code === 'ETIMEDOUT') {
    return { success: false, code: 'GITHUB_TIMEOUT', networkFailure: true, cached: false, stale: false, error: '连接 GitHub 超时' };
  }
  return { success: false, code: 'GITHUB_NETWORK_ERROR', networkFailure: true, cached: false, stale: false, error: '无法连接 GitHub' };
}

function asFailure(details) {
  const error = new Error(details.error);
  error.releaseCheckFailure = { success: false, cached: false, stale: false, networkFailure: false, ...details };
  return error;
}

function normalizeInitialCache(initialCache) {
  if (!initialCache || typeof initialCache !== 'object' || initialCache.value?.success !== true) return null;
  const value = releaseValue(initialCache.value, Number(initialCache.value.checkedAt) || 0);
  if (!value.success) return null;
  return {
    value,
    etag: cleanText(initialCache.etag, 200),
    expiresAt: Math.max(0, Number(initialCache.expiresAt) || 0),
    fetchedAt: Math.max(0, Number(initialCache.fetchedAt) || 0)
  };
}

function createLatestReleaseChecker({
  fetchImpl = globalThis.fetch,
  apiUrl = DEFAULT_RELEASE_API,
  fallbackUrl = DEFAULT_RELEASE_ATOM,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  now = Date.now,
  userAgent = 'SyncWatch update-check',
  initialCache = null
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须是函数');
  let cache = normalizeInitialCache(initialCache);
  let pending = null;

  function snapshot() {
    if (!cache) return null;
    return { value: { ...cache.value }, etag: cache.etag, expiresAt: cache.expiresAt, fetchedAt: cache.fetchedAt };
  }

  async function requestLatest() {
    const checkedAt = now();
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': userAgent,
      'Cache-Control': 'no-cache',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (cache?.etag) headers['If-None-Match'] = cache.etag;
    const signal = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const response = await fetchImpl(apiUrl, { method: 'GET', headers, redirect: 'follow', signal });
    if (response.status === 304) {
      if (!cache) throw asFailure({ code: 'GITHUB_CACHE_MISS', error: 'GitHub 返回 304，但本地没有可复用的版本缓存' });
      cache.expiresAt = checkedAt + cacheTtlMs;
      cache.fetchedAt = checkedAt;
      cache.value = { ...cache.value, checkedAt };
      return { ...cache.value, source: 'revalidated-cache', cached: true, stale: false };
    }
    if (!response.ok) {
      // GitHub's unauthenticated REST API is frequently rate limited (403).
      // The public Atom feed is served separately and still exposes the latest
      // tag, so use it as a read-only fallback without hiding other failures.
      if (response.status === 403 && fallbackUrl) {
        const fallbackResponse = await fetchImpl(fallbackUrl, {
          method: 'GET',
          headers: { Accept: 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8', 'User-Agent': userAgent },
          redirect: 'follow',
          signal
        });
        if (fallbackResponse.ok) {
          const feedText = await fallbackResponse.text();
          if (Buffer.byteLength(feedText) <= MAX_RELEASE_RESPONSE_BYTES) {
            const tagName = extractAtomReleaseTag(feedText);
            if (tagName) {
              const value = releaseValue({
                tag_name: tagName,
                name: `SyncWatch同步观影 ${tagName}`,
                html_url: `https://github.com/xuange6610/SyncWatch/releases/tag/${tagName}`
              }, checkedAt);
              cache = { value, etag: '', fetchedAt: checkedAt, expiresAt: checkedAt + cacheTtlMs };
              return { ...value, source: 'atom-fallback', cached: false, stale: false };
            }
          }
        }
      }
      throw asFailure({ code: 'GITHUB_HTTP_ERROR', httpStatus: response.status, networkFailure: true, error: `GitHub 返回 ${response.status}` });
    }
    const declaredLength = Number(response.headers.get('content-length')) || 0;
    if (declaredLength > MAX_RELEASE_RESPONSE_BYTES) throw asFailure({ code: 'GITHUB_INVALID_RESPONSE', error: 'GitHub 版本响应过大' });
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RELEASE_RESPONSE_BYTES) throw asFailure({ code: 'GITHUB_INVALID_RESPONSE', error: 'GitHub 版本响应过大' });
    let payload;
    try { payload = JSON.parse(text); }
    catch (_) { throw asFailure({ code: 'GITHUB_INVALID_RESPONSE', error: 'GitHub 版本响应不是有效 JSON' }); }
    const value = releaseValue(payload, checkedAt);
    if (!value.success) throw asFailure(value);
    cache = {
      value,
      etag: cleanText(response.headers.get('etag'), 200),
      fetchedAt: checkedAt,
      expiresAt: checkedAt + cacheTtlMs
    };
    return { ...value, source: 'network', cached: false, stale: false };
  }

  async function refresh() {
    try { return await requestLatest(); }
    catch (error) {
      const failure = failureFor(error);
      if (cache && failure.networkFailure) {
        return {
          ...cache.value,
          source: 'stale-cache',
          cached: true,
          stale: true,
          warningCode: failure.code,
          warning: failure.error
        };
      }
      return failure;
    }
  }

  async function check({ forceRefresh = false } = {}) {
    const checkedAt = now();
    if (!forceRefresh && cache?.expiresAt > checkedAt) {
      return { ...cache.value, source: 'fresh-cache', cached: true, stale: false };
    }
    if (!pending) pending = refresh().finally(() => { pending = null; });
    return pending;
  }

  return Object.freeze({ check, snapshot });
}

module.exports = {
  DEFAULT_RELEASE_API,
  DEFAULT_RELEASE_ATOM,
  extractAtomReleaseTag,
  normalizeReleaseTag,
  compareReleaseTags,
  createLatestReleaseChecker
};
