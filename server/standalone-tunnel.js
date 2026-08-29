'use strict';

// Minimal cloudflared supervisor for the Node-only server distribution. The
// Electron desktop app has a richer supervisor, but the standalone package
// must expose the same HTTP API without importing Electron.
const crypto = require('crypto');
const fs = require('fs');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fetch: undiciFetch, EnvHttpProxyAgent } = require('undici');
const { ensureCloudflaredBinary } = require('./cloudflared-installer');

const DEFAULT_BYPASS_PROXY = true;
const MAX_ATTEMPTS = 4;
const START_TIMEOUT_MS = 30000;
const VERIFY_TIMEOUT_MS = 8000;
const CLOUDFLARE_EDGE_PORT = 7844;
const MAX_EDGE_ADDRESSES = 4;
const QUICK_ATTEMPT_COUNT = 4;
const TUNNEL_HEALTH_PATH = '/api/tunnel-health';
const MAX_TUNNEL_HEALTH_BYTES = 8 * 1024;

function atomicWrite(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filename);
}

function physicalNetworkCandidates(interfaces = os.networkInterfaces() || {}) {
  const blockedName = /(?:vpn|\btun\d*\b|\btap\d*\b|utun|wintun|wireguard|tailscale|zerotier|clash|v2ray|代理|虚拟|virtual|loopback|vethernet|wsl|docker|hyper-?v|vmware|virtualbox|parallels|hamachi|npcap|\bbridge\d*\b|\bawdl\d*\b|\bllw\d*\b)/i;
  const preferredName = /(?:ethernet|以太网|wi-?fi|wlan|无线|en\d+|eth\d+)/i;
  const accepted = []; const rejected = []; let order = 0;
  for (const [name, entries] of Object.entries(interfaces || {})) for (const entry of entries || []) {
    const address = String(entry?.address || ''); let reason = '';
    if (blockedName.test(name)) reason = 'virtual-or-tunnel-adapter';
    else if (entry?.internal) reason = 'internal-adapter';
    else if (entry?.family !== 'IPv4' && entry?.family !== 4) reason = 'not-ipv4';
    else if (!address || /^(?:0\.0\.0\.0|127\.|169\.254\.)/.test(address)) reason = 'unusable-address';
    if (reason) { rejected.push({ name, address, reason }); continue; }
    const privateAddress = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address);
    const preferred = preferredName.test(name);
    accepted.push({ name, address, privateAddress, preferredName: preferred, score: (privateAddress ? 4 : 0) + (preferred ? 2 : 0), order: order++ });
  }
  accepted.sort((left, right) => right.score - left.score || left.order - right.order);
  return { selected: accepted[0] || null, accepted, rejected };
}

function networkAddress() { return physicalNetworkCandidates().selected?.address || ''; }

function isTunnelFakeIp(address) {
  const parts = String(address || '').split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

function isPublicIpv4Address(value) {
  const parts = String(value || '').trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second, third] = parts;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 192 && second === 0 && third === 0) return false;
  if (first === 192 && second === 0 && third === 2) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function normalizeEdgeAddresses(values) {
  const output = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const address = String(value || '').trim().replace(/:\d+$/, '');
    if (!isPublicIpv4Address(address) || output.includes(address)) continue;
    output.push(address); if (output.length >= MAX_EDGE_ADDRESSES) break;
  }
  return output;
}

function probeTcp(host, port, localAddress = '') {
  return new Promise((resolve) => {
    const startedAt = Date.now(); let settled = false;
    const socket = net.createConnection({ host, port, ...(localAddress ? { localAddress } : {}) });
    const finish = (ok, error = '') => { if (settled) return; settled = true; socket.destroy(); resolve({ ok, host, port, localAddress, latencyMs: Date.now() - startedAt, error: String(error || '') }); };
    socket.setTimeout(4500, () => finish(false, 'timeout'));
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(false, error.code || error.message));
  });
}

function queryDoh(name, type = 'A', timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL('https://cloudflare-dns.com/dns-query');
    endpoint.searchParams.set('name', name); endpoint.searchParams.set('type', type);
    const request = https.get(endpoint, { family: 4, headers: { accept: 'application/dns-json', 'user-agent': 'SyncWatch-Standalone' } }, (response) => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; if (body.length > 256 * 1024) response.destroy(new Error('DoH 响应过大')); });
      response.once('end', () => { if (response.statusCode !== 200) return reject(new Error(`DoH HTTP ${response.statusCode || 0}`)); try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('DoH 返回内容不是有效 JSON')); } });
      response.once('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('DoH 请求超时')));
    request.once('error', reject);
  });
}

async function resolveDirectEdgeAddresses() {
  const fallback = ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com'];
  let targets = fallback;
  try {
    const srv = await queryDoh('_v2-origintunneld._tcp.argotunnel.com', 'SRV');
    const found = (srv.Answer || []).filter((entry) => entry.type === 33).map((entry) => String(entry.data || '').trim().split(/\s+/).pop()?.replace(/\.$/, '')).filter(Boolean);
    if (found.length) targets = [...new Set(found)];
  } catch (_) {}
  const addresses = [];
  for (const target of targets.slice(0, MAX_EDGE_ADDRESSES)) {
    try {
      const answer = await queryDoh(target, 'A');
      for (const entry of answer.Answer || []) if (entry.type === 1) addresses.push(entry.data);
    } catch (_) {}
    if (addresses.length >= MAX_EDGE_ADDRESSES) break;
  }
  return normalizeEdgeAddresses(addresses);
}

async function runPreflight(bypassProxy) {
  const candidates = physicalNetworkCandidates(); const physicalIpv4 = candidates.selected?.address || '';
  let dnsAddresses = [];
  try { dnsAddresses = await new Promise((resolve) => dns.resolve4('api.trycloudflare.com', (error, values) => resolve(error ? [] : values || []))); } catch (_) {}
  const fakeIpDns = dnsAddresses.some(isTunnelFakeIp);
  const edgeAddresses = bypassProxy && fakeIpDns ? await resolveDirectEdgeAddresses() : [];
  const edgeProbeTargets = edgeAddresses.length ? edgeAddresses : ['region1.v2.argotunnel.com'];
  const edgeProbe = await probeTcp(edgeProbeTargets[0], CLOUDFLARE_EDGE_PORT, bypassProxy ? physicalIpv4 : '');
  const apiProbe = await probeTcp('api.trycloudflare.com', 443, bypassProxy ? physicalIpv4 : '');
  return { candidates, physicalIpv4, dnsAddresses, fakeIpDns, edgeAddresses, checks: { apiProbe, edgeProbe }, failureCode: fakeIpDns && !edgeAddresses.length ? 'VPN_TUN_FAKE_IP' : (!apiProbe.ok ? 'QUICK_API_TIMEOUT' : (!edgeProbe.ok ? 'EDGE_PORT_7844_BLOCKED' : '')) };
}

function connectionStrategies(options, preflight = {}) {
  const direct = options.bypassProxy !== false; const bind = preflight.physicalIpv4 || '';
  const strategies = [];
  const quickMode = options.mode === 'quick';
  if (quickMode && direct && bind && preflight.edgeAddresses?.length) strategies.push({ id: 'direct-auto-pinned-edge', protocol: 'auto', bindAddress: bind, edgeAddresses: preflight.edgeAddresses, bypassProxy: true });
  if (quickMode) strategies.push({ id: direct ? 'direct-auto' : 'system-auto', protocol: 'auto', bindAddress: '', edgeAddresses: [], bypassProxy: direct });
  if (!quickMode && direct && bind && preflight.edgeAddresses?.length) strategies.push({ id: 'direct-http2-pinned-edge', protocol: 'http2', bindAddress: bind, edgeAddresses: preflight.edgeAddresses, bypassProxy: true });
  if (!quickMode && direct && bind) strategies.push({ id: 'direct-http2-bound', protocol: 'http2', bindAddress: bind, edgeAddresses: [], bypassProxy: true });
  strategies.push({ id: direct ? 'direct-http2' : 'system-http2', protocol: 'http2', bindAddress: '', edgeAddresses: [], bypassProxy: direct });
  if (!quickMode) strategies.push({ id: direct ? 'direct-auto' : 'system-auto', protocol: 'auto', bindAddress: '', edgeAddresses: [], bypassProxy: direct });
  const limit = quickMode ? QUICK_ATTEMPT_COUNT : 2;
  if (quickMode && direct) {
    return [...strategies.filter((strategy) => strategy.id !== 'direct-http2-bound').slice(0, limit - 1), {
      id: 'system-auto-fallback', protocol: 'auto', bindAddress: '', edgeAddresses: [], bypassProxy: false
    }].slice(0, limit);
  }
  return strategies.slice(0, limit);
}

function classifyTunnelFailure(log, code = null, signal = '') {
  const value = String(log || '');
  const loggedIpv4Addresses = value.match(/(?:\d{1,3}\.){3}\d{1,3}/g) || [];
  if (loggedIpv4Addresses.some(isTunnelFakeIp)) return { code: 'VPN_TUN_FAKE_IP', title: 'VPN/TUN Fake-IP 拦截了 cloudflared 连接' };
  if (/7844[^\r\n]{0,180}(?:timeout|timed out|blocked|refused|unreachable)|(?:timeout|timed out|blocked|refused|unreachable)[^\r\n]{0,180}7844/i.test(value)) return { code: 'EDGE_PORT_7844_BLOCKED', title: 'Cloudflare 边缘端口 7844 连接失败' };
  if (/failed to request quick Tunnel|context deadline exceeded|Client\.Timeout exceeded/i.test(value)) return { code: 'QUICK_API_TIMEOUT', title: 'Cloudflare 临时地址接口超时' };
  if (/no such host|DNS|lookup .*failed/i.test(value)) return { code: 'DNS_RESOLUTION_FAILED', title: 'DNS 解析异常' };
  if (/bind|cannot assign requested address|address.*not available/i.test(value)) return { code: 'BIND_ADDRESS_FAILED', title: '物理网卡绑定失败' };
  if (/QUIC|no recent network activity/i.test(value)) return { code: 'QUIC_BLOCKED', title: 'QUIC/UDP 连接失败' };
  if (/TLS handshake|x509|certificate/i.test(value)) return { code: 'TLS_INTERCEPTED', title: 'TLS/证书连接异常' };
  return { code: Number.isInteger(code) ? `PROCESS_EXIT_${code}` : (signal ? 'PROCESS_SIGNAL_EXIT' : 'PROCESS_START_FAILED'), title: 'cloudflared 进程启动失败' };
}

function sanitizeEnvironment(bypassProxy) {
  const env = { ...process.env };
  if (bypassProxy) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
    env.NO_PROXY = '*';
    env.no_proxy = '*';
  }
  return env;
}

function resolveBinary(rootDir, dataDir) {
  const candidates = [
    process.env.SYNCWATCH_CLOUDFLARED_PATH,
    path.join(rootDir, 'vendor', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    path.join(rootDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    path.join(dataDir, 'tools', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  ].filter(Boolean);
  return candidates.map((candidate) => path.resolve(candidate)).find((candidate) => {
    try { return fs.statSync(candidate).isFile() && fs.statSync(candidate).size > 1000000; } catch (_) { return false; }
  }) || '';
}

function extractPublicUrl(value) {
  const matches = String(value || '').matchAll(/https:\/\/([a-z0-9](?:[a-z0-9-]{0,62}))\.trycloudflare\.com\b/ig);
  for (const match of matches) {
    const label = String(match[1] || '').toLowerCase();
    if (label && label.includes('-')) return `https://${label}.trycloudflare.com`;
  }
  return '';
}

function connectorRegistered(value) {
  return /registered tunnel connection|connection [^\r\n]* registered/i.test(String(value || ''));
}

function tunnelProxyAgentOptions(environment = process.env) {
  const httpProxy = String(environment?.http_proxy || environment?.HTTP_PROXY
    || environment?.all_proxy || environment?.ALL_PROXY || '').trim();
  const httpsProxy = String(environment?.https_proxy || environment?.HTTPS_PROXY
    || environment?.all_proxy || environment?.ALL_PROXY || httpProxy).trim();
  const noProxy = String(environment?.no_proxy ?? environment?.NO_PROXY ?? '');
  return { httpProxy, httpsProxy, noProxy };
}

function tunnelProxyConfigured(environment = process.env) {
  const options = tunnelProxyAgentOptions(environment);
  return Boolean(options.httpProxy || options.httpsProxy);
}

function parseTunnelHealthResponse(statusCode, body = '') {
  if (statusCode < 200 || statusCode >= 300) return { ok: false, statusCode };
  try {
    const result = JSON.parse(body);
    return {
      ok: result?.name === 'SyncWatch同步观影' && typeof result.version === 'string' && Boolean(result.version),
      statusCode
    };
  } catch (_) { return { ok: false, statusCode }; }
}

async function readBoundedTunnelHealthBody(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('公网健康检查响应不可读');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_TUNNEL_HEALTH_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('公网健康检查响应过大');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function requestTunnelHealthThroughProxy(parsed, timeoutMs, environment) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  let dispatcher = null;
  try {
    dispatcher = new EnvHttpProxyAgent({
      ...tunnelProxyAgentOptions(environment),
      // Plain HTTP health URLs can use a conventional forward proxy request;
      // HTTPS targets still use CONNECT inside undici.
      proxyTunnel: false
    });
    const response = await undiciFetch(parsed, {
      method: 'GET', dispatcher, signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'SyncWatch-Standalone' }
    });
    const body = await readBoundedTunnelHealthBody(response);
    return parseTunnelHealthResponse(response.status, body);
  } catch (error) {
    return { ok: false, error: error?.message || '公网健康检查失败' };
  } finally {
    clearTimeout(timer);
    if (dispatcher) await dispatcher.destroy().catch(() => {});
  }
}

function requestTunnelHealth(publicUrl, timeoutMs = VERIFY_TIMEOUT_MS, {
  localAddress = '', useSystemProxy = false, environment = process.env
} = {}) {
  let parsed;
  try { parsed = new URL(`${String(publicUrl).replace(/\/$/, '')}${TUNNEL_HEALTH_PATH}`); }
  catch (_) { return Promise.resolve({ ok: false, error: '公网地址无效' }); }
  if (useSystemProxy && !localAddress && tunnelProxyConfigured(environment)) {
    return requestTunnelHealthThroughProxy(parsed, timeoutMs, environment);
  }
  return new Promise((resolve) => {
    let settled = false;
    let responseStarted = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.get(parsed, {
      family: 4,
      ...(localAddress ? { localAddress } : {}),
      headers: { Accept: 'application/json', 'User-Agent': 'SyncWatch-Standalone' }
    }, (response) => {
      responseStarted = true;
      let body = '';
      let bodyBytes = 0;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        bodyBytes += Buffer.byteLength(chunk);
        if (bodyBytes > MAX_TUNNEL_HEALTH_BYTES) {
          finish({ ok: false, statusCode: response.statusCode || 0, error: '公网健康检查响应过大' });
          response.destroy(new Error('公网健康检查响应过大'));
          return;
        }
        body += chunk;
      });
      response.once('end', () => finish(parseTunnelHealthResponse(response.statusCode || 0, body)));
      response.once('aborted', () => finish({ ok: false, error: '公网健康检查响应中断' }));
      response.once('error', (error) => finish({ ok: false, error: error?.message || '公网健康检查响应失败' }));
      response.once('close', () => {
        if (!response.complete) finish({ ok: false, error: '公网健康检查连接提前关闭' });
      });
    });
    request.setTimeout(timeoutMs, () => {
      finish({ ok: false, error: 'timeout' });
      request.destroy(new Error('timeout'));
    });
    request.once('error', (error) => finish({ ok: false, error: error?.message || '公网健康检查请求失败' }));
    request.once('close', () => {
      if (!responseStarted) finish({ ok: false, error: '公网健康检查请求已关闭' });
    });
  });
}

function createStandaloneTunnelManager({
  rootDir, dataDir, getPort, installCloudflared = ensureCloudflaredBinary,
  spawnProcess = spawn, requestTunnelHealthImpl = requestTunnelHealth
} = {}) {
  const resolvedRoot = path.resolve(rootDir || process.cwd());
  const resolvedData = path.resolve(dataDir || path.join(resolvedRoot, 'SyncWatch同步观影-Data'));
  const startupFile = path.join(resolvedData, 'tunnel-startup.json');
  let child = null;
  let generation = 0;
  let desired = null;
  let restartTimer = null;
  let logs = '';
  let current = { state: 'stopped', mode: '', publicUrl: '', verified: false, bypassProxy: DEFAULT_BYPASS_PROXY, activeNetworkMode: '', error: '', latencyMs: null, reconnectCount: 0 };

  function loadSettings() {
    try {
      const value = JSON.parse(fs.readFileSync(startupFile, 'utf8'));
      return {
        autoStartTunnel: value.autoStartTunnel === true,
        mode: value.mode === 'named' ? 'named' : 'quick',
        token: String(value.token || '').trim(), publicUrl: String(value.publicUrl || '').trim(),
        bypassProxy: value.bypassProxy !== false, autoDiagnose: value.autoDiagnose !== false
      };
    } catch (_) {
      return { autoStartTunnel: false, mode: 'quick', token: '', publicUrl: '', bypassProxy: DEFAULT_BYPASS_PROXY, autoDiagnose: true };
    }
  }

  async function stop() {
    generation += 1;
    desired = null;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    const processToStop = child;
    child = null;
    if (processToStop && processToStop.exitCode === null) {
      try { processToStop.kill(); } catch (_) {}
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2500);
        processToStop.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    current = { ...current, state: 'stopped', mode: '', publicUrl: '', verified: false, error: '', latencyMs: null };
    return { ...current };
  }

  async function launch(options, attempt, strategy = {}) {
    const binary = resolveBinary(resolvedRoot, resolvedData);
    if (!binary) throw new Error('未找到内置 cloudflared，请确认服务器包包含 vendor/cloudflared.exe');
    const port = Number(getPort?.()) || 20311;
    const mode = options.mode === 'named' ? 'named' : 'quick';
    if (mode === 'named' && !options.token) throw new Error('稳定隧道需要 Cloudflare Tunnel 令牌');
    const attemptBypassProxy = Object.prototype.hasOwnProperty.call(strategy, 'bypassProxy')
      ? strategy.bypassProxy !== false : options.bypassProxy !== false;
    const protocol = strategy.protocol || 'auto';
    const args = mode === 'quick'
      ? ['tunnel', '--url', `http://127.0.0.1:${port}`, '--protocol', protocol, '--edge-ip-version', '4']
      : ['tunnel', '--protocol', protocol, '--edge-ip-version', '4'];
    for (const edge of normalizeEdgeAddresses(strategy.edgeAddresses || [])) args.push('--edge', `${edge}:${CLOUDFLARE_EDGE_PORT}`);
    if (attemptBypassProxy && strategy.bindAddress) args.push('--edge-bind-address', strategy.bindAddress);
    args.push('--retries', '12', '--no-autoupdate');
    if (mode === 'named') args.push('run');
    const env = sanitizeEnvironment(attemptBypassProxy);
    if (mode === 'named') env.TUNNEL_TOKEN = options.token;
    const startedAt = Date.now();
    const localGeneration = generation;
    const processHandle = spawnProcess(binary, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child = processHandle;
    let candidateUrl = mode === 'named' ? options.publicUrl : '';
    let registered = false;
    let output = '';
    const handle = (chunk) => {
      output = `${output}${String(chunk || '')}`.slice(-16000);
      logs = output;
      if (mode === 'quick') candidateUrl ||= extractPublicUrl(output);
      registered ||= connectorRegistered(output);
    };
    processHandle.stdout.on('data', handle); processHandle.stderr.on('data', handle);
    const ready = await new Promise((resolve) => {
      let settled = false; let timer = null; let poll = null;
      const finish = (value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearInterval(poll); resolve(value);
      };
      timer = setTimeout(() => finish({ ok: false, error: candidateUrl ? '连接器尚未注册' : 'cloudflared 未在限定时间内创建公网地址' }), START_TIMEOUT_MS);
      processHandle.once('error', (error) => finish({ ok: false, error: error.message }));
      processHandle.once('exit', (code, signal) => finish({ ok: false, error: `cloudflared 已退出（${code ?? signal ?? '未知'}）`, code, signal }));
      poll = setInterval(() => {
        if (localGeneration !== generation || child !== processHandle) return finish({ ok: false, error: '公网隧道启动已取消' });
        if (candidateUrl && (registered || mode === 'named')) {
          finish({ ok: true, candidateUrl });
        }
      }, 100);
    });
    if (!ready.ok || localGeneration !== generation || child !== processHandle) {
      try { processHandle.kill(); } catch (_) {}
      return { success: false, error: ready.error || '公网隧道启动失败', process: processHandle, startedAt, output };
    }
    current = { ...current, state: 'verifying', verificationStartedAt: Date.now(), error: '公网地址已生成，正在验证可访问性…' };
    let verified = false;
    let latencyMs = null;
    for (let index = 0; index < 4; index += 1) {
      const probeStarted = Date.now();
      const probe = await requestTunnelHealthImpl(ready.candidateUrl, VERIFY_TIMEOUT_MS, {
        localAddress: attemptBypassProxy ? strategy.bindAddress || '' : '',
        useSystemProxy: !attemptBypassProxy,
        environment: env
      });
      if (probe.ok) { verified = true; latencyMs = Date.now() - probeStarted; break; }
      await new Promise((resolve) => setTimeout(resolve, 500 * (index + 1)));
    }
    if (!verified) {
      try { processHandle.kill(); } catch (_) {}
      return { success: false, error: '公网地址已生成，但 Cloudflare 连接器尚未验证成功', process: processHandle, startedAt, output };
    }
    return {
      success: true, publicUrl: ready.candidateUrl, process: processHandle, startedAt, latencyMs, output, strategy,
      bypassProxy: attemptBypassProxy, activeNetworkMode: attemptBypassProxy ? 'direct' : 'system'
    };
  }

  async function start(input = {}) {
    const options = {
      mode: input.mode === 'named' ? 'named' : 'quick', token: String(input.token || '').trim(), publicUrl: String(input.publicUrl || '').trim(),
      bypassProxy: input.bypassProxy !== false, autoDiagnose: input.autoDiagnose !== false
    };
    await stop();
    const startGeneration = ++generation;
    const operationStartedAt = Date.now();
    desired = { ...options };
    if (!resolveBinary(resolvedRoot, resolvedData)) {
      current = { ...current, state: 'downloading', mode: options.mode, publicUrl: '', verified: false, error: '', operationStartedAt };
      try {
        await installCloudflared({ dataDir: resolvedData });
      } catch (error) {
        desired = null;
        current = { ...current, state: 'error', error: `自动安装 cloudflared 失败：${error.message}` };
        throw new Error(current.error);
      }
    }
    current = { ...current, state: 'diagnosing', mode: options.mode, publicUrl: '', verified: false, bypassProxy: options.bypassProxy, error: '', reconnectCount: 0, operationStartedAt };
    let preflight = { physicalIpv4: networkAddress(), edgeAddresses: [], failureCode: '' };
    if (options.autoDiagnose) {
      try { preflight = await runPreflight(options.bypassProxy); } catch (error) { preflight = { ...preflight, error: error.message, failureCode: 'PREFLIGHT_FAILED' }; }
    }
    const strategies = connectionStrategies(options, preflight);
    let lastError = '';
    for (let attempt = 0; attempt < Math.min(MAX_ATTEMPTS, strategies.length); attempt += 1) {
      if (startGeneration !== generation) throw new Error('公网隧道启动已取消');
      let result;
      const strategy = strategies[attempt] || {};
      const attemptBypassProxy = Object.prototype.hasOwnProperty.call(strategy, 'bypassProxy')
        ? strategy.bypassProxy !== false : options.bypassProxy !== false;
      current = {
        ...current, state: attempt === 0 ? 'starting' : 'reconnecting', attempt: attempt + 1, maxAttempts: Math.min(MAX_ATTEMPTS, strategies.length), strategy: strategy.id,
        strategyLabel: strategy.label || strategy.id, bypassProxy: attemptBypassProxy,
        activeNetworkMode: attemptBypassProxy ? 'direct' : 'system',
        error: attempt === 0 ? '正在启动公网连接器…' : '正在切换备用连接方式…'
      };
      try { result = await launch(options, attempt, strategy); }
      catch (error) { result = { success: false, error: error.message || '公网隧道启动失败' }; }
      if (result.success) {
        current = {
          ...current, state: 'running', mode: options.mode, publicUrl: result.publicUrl, verified: true,
          bypassProxy: result.bypassProxy, activeNetworkMode: result.activeNetworkMode,
          latencyMs: result.latencyMs, error: '', startedAt: new Date().toISOString(),
          strategy: strategy.id, strategyLabel: strategy.label || strategy.id, diagnostics: preflight
        };
        child = result.process;
        result.process.once('exit', (code, signal) => {
          if (child !== result.process || startGeneration !== generation) return;
          child = null;
          const failure = classifyTunnelFailure(logs, code, signal);
          current = { ...current, state: desired ? 'reconnecting' : 'stopped', publicUrl: '', verified: false, failureCode: failure.code, error: `${failure.title}：cloudflared 已退出（${code ?? signal ?? '未知'}）` };
          if (desired) {
            const nextDesired = { ...desired };
            restartTimer = setTimeout(() => {
              restartTimer = null;
              if (!desired) return;
              start(nextDesired).catch((error) => {
                current = { ...current, state: 'error', error: error.message || '公网隧道自动恢复失败' };
              });
            }, 1500);
          }
        });
        return { ...current };
      }
      lastError = result.error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    const failure = classifyTunnelFailure(`${lastError}\n${preflight.error || ''}`, null, '');
    current = { ...current, state: 'error', publicUrl: '', verified: false, failureCode: preflight.failureCode || failure.code, error: lastError || failure.title || '公网隧道启动失败', diagnostics: preflight };
    desired = null;
    throw new Error(current.error);
  }

  async function startupSettings() {
    const settings = loadSettings();
    return { ...settings, tokenConfigured: Boolean(settings.token) };
  }

  async function saveStartupSettings(input = {}) {
    const previous = loadSettings();
    const next = {
      ...previous, ...input, mode: input.mode === 'named' ? 'named' : (input.mode || previous.mode),
      token: Object.prototype.hasOwnProperty.call(input, 'token') ? String(input.token || '').trim() : previous.token,
      bypassProxy: Object.prototype.hasOwnProperty.call(input, 'bypassProxy') ? input.bypassProxy !== false : previous.bypassProxy !== false,
      autoDiagnose: Object.prototype.hasOwnProperty.call(input, 'autoDiagnose') ? input.autoDiagnose !== false : previous.autoDiagnose !== false,
      autoStartTunnel: Object.prototype.hasOwnProperty.call(input, 'autoStartTunnel') ? input.autoStartTunnel === true : previous.autoStartTunnel === true
    };
    if (next.mode === 'named' && next.autoStartTunnel && !next.token) throw new Error('稳定隧道自动启动需要 Cloudflare Tunnel 令牌');
    atomicWrite(startupFile, next);
    return { ...next, tokenConfigured: Boolean(next.token), token: undefined };
  }

  async function startConfiguredTunnel() {
    const settings = loadSettings();
    if (!settings.autoStartTunnel) return { ...current, startup: { ...settings, tokenConfigured: Boolean(settings.token) } };
    return start(settings);
  }

  async function diagnostics({ bypassProxy = current.bypassProxy !== false } = {}) {
    const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
    let preflight;
    try { preflight = await runPreflight(Boolean(bypassProxy)); } catch (error) { preflight = { error: error.message, failureCode: 'PREFLIGHT_FAILED' }; }
    const tunAdapters = Object.entries(os.networkInterfaces() || {})
      .filter(([name, entries]) => /(?:vpn|tun|tap|wintun|wireguard|tailscale|zerotier|clash|v2ray|代理|虚拟|virtual|vethernet|wsl|docker|hyper-?v|vmware)/i.test(name)
        && (entries || []).some((entry) => !entry.internal && (entry.family === 'IPv4' || entry.family === 4)))
      .map(([name]) => name);
    const failureCode = current.failureCode || preflight.failureCode || '';
    const recommendations = [];
    if (failureCode === 'VPN_TUN_FAKE_IP' || preflight.fakeIpDns || tunAdapters.length) recommendations.push('检测到 VPN/TUN 或 Fake-IP DNS。浏览器可联网但物理网卡直连超时时，请先取消“绕过系统代理”；必须直连时再将 cloudflared.exe、trycloudflare.com 和 argotunnel.com 设为直连。');
    if (failureCode === 'EDGE_PORT_7844_BLOCKED' || failureCode === 'QUICK_API_TIMEOUT') recommendations.push('请允许 cloudflared 出站访问 TCP 443、TCP 7844 和 UDP 7844；程序会自动降级 HTTP/2。');
    if (!bypassProxy && !preflight.fakeIpDns && !tunAdapters.length) recommendations.push('建议开启绕过系统代理，避免代理软件接管 cloudflared。');
    recommendations.push('临时 trycloudflare.com 地址没有 uptime 保证；长期 4K 播放建议使用固定 Tunnel 令牌和自有域名。');
    return {
      state: current.state, bypassProxy: Boolean(bypassProxy), binary: resolveBinary(resolvedRoot, resolvedData),
      networkAddress: networkAddress(), proxyEnvironment: Object.fromEntries(proxyKeys.map((key) => [key, Boolean(process.env[key])])),
      physicalNetwork: physicalNetworkCandidates(), tunAdapters, preflight, status: { ...current }, failureCode, recommendations
    };
  }

  async function repair({ bypassProxy = current.bypassProxy !== false } = {}) {
    if (process.platform === 'win32') {
      try { const childProcess = spawn('ipconfig.exe', ['/flushdns'], { windowsHide: true }); await new Promise((resolve) => childProcess.once('exit', resolve)); } catch (_) {}
    }
    if (desired) return start({ ...desired, bypassProxy, autoDiagnose: true });
    return { ...current, repair: { bypassProxy: Boolean(bypassProxy), completedAt: new Date().toISOString() } };
  }

  return {
    start, stop, status: async () => ({ ...current }), startupSettings, saveStartupSettings, startConfiguredTunnel, diagnostics, repair,
    binaryPath: () => resolveBinary(resolvedRoot, resolvedData)
  };
}

module.exports = {
  createStandaloneTunnelManager, extractPublicUrl, connectorRegistered, resolveBinary, sanitizeEnvironment,
  requestTunnelHealth, requestPublicConfig: requestTunnelHealth, connectionStrategies,
  parseTunnelHealthResponse, TUNNEL_HEALTH_PATH
};
