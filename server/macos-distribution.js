'use strict';

const fs = require('fs');
const path = require('path');

const MAC_ARCHITECTURES = ['arm64', 'x64'];
const MAC_FORMATS = ['dmg', 'zip'];
const MAC_KINDS = ['server', 'client'];

function releaseVersion(value) {
  const normalized = String(value || '2.2.2').trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : '2.2.2';
}

function macArtifactFilename(kind, architecture, format, version = '2.2.2') {
  const label = kind === 'server' ? '服务器' : '客户端';
  if (!MAC_ARCHITECTURES.includes(architecture)) throw new Error(`不支持的 macOS 架构：${architecture}`);
  if (!MAC_FORMATS.includes(format)) throw new Error(`不支持的 macOS 产物格式：${format}`);
  return `SyncWatch同步观影-${label}-v${releaseVersion(version)}-${architecture}.${format}`;
}

function emptyDistribution() {
  return {
    arm64: { dmg: null, zip: null },
    x64: { dmg: null, zip: null },
    warnings: []
  };
}

function uniqueRoots(values = []) {
  const seen = new Set();
  const roots = [];
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(String(value));
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(resolved);
  }
  return roots;
}

function defaultMacDistributionRoots(extraRoots = [], includeDefaults = true) {
  const requestedRoots = Array.isArray(extraRoots) ? extraRoots : [extraRoots];
  const portableFile = String(process.env.PORTABLE_EXECUTABLE_FILE || '').trim();
  const portableDirectory = String(process.env.PORTABLE_EXECUTABLE_DIR || '').trim()
    || (portableFile ? path.dirname(portableFile) : '');
  const executableDirectory = typeof process.execPath === 'string' && process.execPath
    ? path.dirname(process.execPath) : '';
  const resourcesDirectory = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const projectRoot = path.resolve(__dirname, '..');
  const bases = uniqueRoots([
    ...requestedRoots,
    ...(includeDefaults ? [portableDirectory, executableDirectory, resourcesDirectory, projectRoot, process.cwd()] : [])
  ]);
  return uniqueRoots(includeDefaults ? [
    ...bases.flatMap((base) => [path.join(base, 'mac'), base]),
    path.join(projectRoot, 'dist')
  ] : bases.flatMap((base) => [path.join(base, 'mac'), base]));
}

function inferFormat(value) {
  const candidate = String(value || '').split(/[?#]/, 1)[0].toLowerCase();
  if (candidate.endsWith('.dmg')) return 'dmg';
  if (candidate.endsWith('.zip')) return 'zip';
  return '';
}

function localArtifact(value, defaults = {}) {
  if (!value) return null;
  const candidate = path.resolve(defaults.baseDir || process.cwd(), String(value));
  let stats;
  try {
    stats = fs.statSync(candidate);
    if (!stats.isFile() || stats.size <= 0) return null;
  } catch (_) { return null; }
  const inferredFormat = inferFormat(candidate);
  const format = defaults.format || inferredFormat;
  if (!MAC_FORMATS.includes(format) || inferredFormat !== format) return null;
  return {
    source: 'local', format, path: candidate,
    filename: defaults.filename || path.basename(candidate)
  };
}

function remoteArtifact(value, defaults = {}) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return null;
    const format = defaults.format || inferFormat(parsed.pathname);
    if (!MAC_FORMATS.includes(format)) return null;
    return {
      source: 'remote', format, url: parsed.toString(),
      filename: defaults.filename || path.posix.basename(parsed.pathname)
    };
  } catch (_) { return null; }
}

function addArtifact(distribution, architecture, format, value, defaults = {}) {
  if (!MAC_ARCHITECTURES.includes(architecture) || !MAC_FORMATS.includes(format) || distribution[architecture][format]) return;
  const text = typeof value === 'string' ? value : '';
  const descriptor = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const raw = descriptor.path || descriptor.url || text;
  if (!raw) return;
  const canonicalFilename = defaults.filename;
  const artifact = /^https:\/\//i.test(String(raw))
    ? remoteArtifact(raw, { format, filename: canonicalFilename })
    : localArtifact(raw, { baseDir: defaults.baseDir, format, filename: canonicalFilename });
  if (artifact) distribution[architecture][format] = artifact;
  else distribution.warnings.push(`已忽略无效的 ${architecture} ${format.toUpperCase()} 产物配置`);
}

function addArchitectureConfig(distribution, architecture, value, defaults = {}) {
  if (!value) return;
  if (typeof value === 'string') {
    const format = inferFormat(value);
    if (format) addArtifact(distribution, architecture, format, value, defaults);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) addArchitectureConfig(distribution, architecture, entry, defaults);
    return;
  }
  if (typeof value !== 'object') return;
  for (const format of MAC_FORMATS) addArtifact(distribution, architecture, format, value[format], defaults);
  if (value.path || value.url) {
    const format = MAC_FORMATS.includes(value.format) ? value.format : inferFormat(value.path || value.url);
    if (format) addArtifact(distribution, architecture, format, value, defaults);
  }
}

function addKindConfig(distribution, config, defaults = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return;
  for (const architecture of MAC_ARCHITECTURES) {
    addArchitectureConfig(distribution, architecture, config[architecture], defaults);
  }
}

function loadManifest(filename, distribution, kind, version) {
  if (!filename || !fs.existsSync(filename)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const manifestVersion = Number(parsed?.manifestVersion || 1);
    if (manifestVersion !== 1) throw new Error(`不支持的 manifestVersion ${manifestVersion}`);
    addKindConfig(distribution, parsed[kind], {
      baseDir: path.dirname(filename),
      filename: undefined,
      version
    });
  } catch (error) {
    distribution.warnings.push(`无法读取 ${path.basename(filename)}：${error.message}`);
  }
}

function environmentConfig(kind, env = process.env) {
  const prefix = `SYNCWATCH_MAC_${kind.toUpperCase()}`;
  const config = { arm64: {}, x64: {} };
  for (const architecture of MAC_ARCHITECTURES) {
    const architectureKey = architecture.toUpperCase();
    for (const format of MAC_FORMATS) {
      config[architecture][format] = env[`${prefix}_${architectureKey}_${format.toUpperCase()}_URL`] || '';
    }
    const legacy = env[`${prefix}_${architectureKey}_URL`];
    if (legacy) config[architecture][inferFormat(legacy) || 'dmg'] = legacy;
  }
  return config;
}

function addReleaseBaseUrl(distribution, kind, value, version) {
  if (!value) return;
  let base;
  try {
    base = new URL(String(value));
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('必须为 HTTPS 目录地址');
    if (!base.pathname.endsWith('/')) base.pathname += '/';
  } catch (error) {
    distribution.warnings.push(`SYNCWATCH_MAC_RELEASE_BASE_URL 无效：${error.message}`);
    return;
  }
  for (const architecture of MAC_ARCHITECTURES) {
    for (const format of MAC_FORMATS) {
      const filename = `SyncWatch-${kind === 'server' ? 'Server' : 'Client'}-macOS-v${releaseVersion(version)}-${architecture}.${format}`;
      addArtifact(distribution, architecture, format, new URL(encodeURIComponent(filename), base).toString(), { filename });
    }
  }
}

function createMacDistribution({
  kind, version = '2.2.2', legacyPaths = {}, configured = {}, roots = [],
  manifestPaths = [], env = process.env, includeDefaultRoots = true
} = {}) {
  if (!MAC_KINDS.includes(kind)) throw new Error(`不支持的 macOS 产物类型：${kind}`);
  const normalizedVersion = releaseVersion(version);
  const distribution = emptyDistribution();

  addKindConfig(distribution, legacyPaths);
  const distributionRoots = defaultMacDistributionRoots(roots, includeDefaultRoots);
  for (const root of distributionRoots) {
    for (const architecture of MAC_ARCHITECTURES) {
      for (const format of MAC_FORMATS) {
        const filename = macArtifactFilename(kind, architecture, format, normalizedVersion);
        const publicFilename = `SyncWatch-${kind === 'server' ? 'Server' : 'Client'}-macOS-v${normalizedVersion}-${architecture}.${format}`;
        addArtifact(distribution, architecture, format, path.join(root, filename), { filename });
        addArtifact(distribution, architecture, format, path.join(root, publicFilename), { filename });
      }
    }
  }
  addKindConfig(distribution, configured);

  const requestedManifests = Array.isArray(manifestPaths) ? manifestPaths : [manifestPaths];
  const manifests = uniqueRoots([
    ...requestedManifests,
    ...distributionRoots.map((root) => path.join(root, 'mac-distribution.json'))
  ]);
  for (const filename of manifests) loadManifest(filename, distribution, kind, normalizedVersion);

  addKindConfig(distribution, environmentConfig(kind, env));
  addReleaseBaseUrl(distribution, kind, env.SYNCWATCH_MAC_RELEASE_BASE_URL, normalizedVersion);
  return distribution;
}

function availableMacArchitectures(distribution = {}) {
  return MAC_ARCHITECTURES.filter((architecture) => {
    const entry = distribution[architecture];
    if (typeof entry === 'string') return Boolean(entry);
    return Boolean(entry && (entry.dmg || entry.zip));
  });
}

function macDownloadSummary(distribution = {}) {
  return availableMacArchitectures(distribution).map((architecture) => {
    const entry = distribution[architecture];
    const formats = typeof entry === 'string' ? [inferFormat(entry) || 'dmg'] : MAC_FORMATS.filter((format) => Boolean(entry[format]));
    return {
      architecture,
      formats,
      preferredFormat: formats.includes('dmg') ? 'dmg' : formats[0],
      sources: [...new Set(formats.map((format) => entry?.[format]?.source).filter(Boolean))]
    };
  });
}

function preferredMacArchitecture(req, distribution = {}) {
  const available = availableMacArchitectures(distribution);
  const requested = String(req?.query?.arch || '').trim().toLowerCase();
  if (requested) return MAC_ARCHITECTURES.includes(requested) && available.includes(requested) ? requested : '';
  const userAgent = String(req?.headers?.['user-agent'] || '').toLowerCase();
  if (/(?:arm64|aarch64|apple\s*silicon)/.test(userAgent) && available.includes('arm64')) return 'arm64';
  if (available.includes('x64')) return 'x64';
  return available[0] || '';
}

function selectMacArtifact(req, distribution = {}) {
  const architecture = preferredMacArchitecture(req, distribution);
  if (!architecture) return null;
  const entry = distribution[architecture];
  if (typeof entry === 'string') {
    const format = inferFormat(entry) || 'dmg';
    return { architecture, artifact: localArtifact(entry, { format }) };
  }
  const requestedFormat = String(req?.query?.format || '').trim().toLowerCase();
  if (requestedFormat) {
    if (!MAC_FORMATS.includes(requestedFormat) || !entry?.[requestedFormat]) return null;
    return { architecture, artifact: entry[requestedFormat] };
  }
  const artifact = entry?.dmg || entry?.zip || null;
  return artifact ? { architecture, artifact } : null;
}

module.exports = {
  MAC_ARCHITECTURES,
  MAC_FORMATS,
  availableMacArchitectures,
  createMacDistribution,
  defaultMacDistributionRoots,
  inferFormat,
  macArtifactFilename,
  macDownloadSummary,
  preferredMacArchitecture,
  selectMacArtifact,
  _test: { addReleaseBaseUrl, environmentConfig, localArtifact, remoteArtifact, releaseVersion }
};
