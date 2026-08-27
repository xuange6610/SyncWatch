'use strict';

const net = require('net');

function normalizeWebOrigin(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) return '';
    return parsed.origin;
  } catch (_) { return ''; }
}

function unwrappedHostname(origin) {
  try { return new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
  catch (_) { return ''; }
}

function privateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] === 0;
}

function privateIpv6(hostname) {
  const lower = hostname.toLowerCase();
  return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower);
}

function isPrivateWebOrigin(value) {
  const origin = normalizeWebOrigin(value);
  if (!origin) return true;
  const hostname = unwrappedHostname(origin);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true;
  const addressType = net.isIP(hostname);
  if (addressType === 4) return privateIpv4(hostname);
  if (addressType === 6) return privateIpv6(hostname);
  return !hostname.includes('.');
}

function uniqueOrigins(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeWebOrigin).filter(Boolean))];
}

function trustedPublicOrigin(currentOrigin, configuredPublicAddress) {
  const current = normalizeWebOrigin(currentOrigin);
  if (current && !isPrivateWebOrigin(current)) return current;
  const configured = normalizeWebOrigin(configuredPublicAddress);
  return configured && !isPrivateWebOrigin(configured) ? configured : '';
}

function clientFacingAddressState({
  runtimeRole = 'client',
  currentOrigin = '',
  configuredPublicAddress = '',
  lanAddresses = []
} = {}) {
  const publicOrigin = trustedPublicOrigin(currentOrigin, configuredPublicAddress);
  if (runtimeRole !== 'server') {
    return {
      statusAddress: '',
      shareAddress: publicOrigin,
      addresses: publicOrigin ? [publicOrigin] : [],
      public: Boolean(publicOrigin)
    };
  }
  const localOrigins = uniqueOrigins(lanAddresses);
  return {
    statusAddress: localOrigins[0] || '',
    shareAddress: publicOrigin || normalizeWebOrigin(currentOrigin) || localOrigins[0] || '',
    addresses: localOrigins,
    public: Boolean(publicOrigin)
  };
}

module.exports = {
  normalizeWebOrigin,
  isPrivateWebOrigin,
  trustedPublicOrigin,
  clientFacingAddressState
};
