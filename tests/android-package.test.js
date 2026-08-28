'use strict';

require('./epipe-guard');

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const repositoryRoot = path.resolve(__dirname, '..');
const packageVersion = require('../package.json').version;
const mobileRoot = path.join(repositoryRoot, 'mobile');
const appRoot = path.join(mobileRoot, 'app');
const sourceOnly = process.argv.includes('--source-only');
const explicitApk = process.argv.find((argument) => /\.apk$/i.test(argument));
const apkPath = path.resolve(explicitApk || path.join(repositoryRoot, 'dist', `SyncWatch-Android-v${packageVersion}-universal.apk`));

const NODE_MOBILE = Object.freeze({
  version: '18.20.4',
  sourceRevision: 'ff4e063f1f1911047c067335ad0a3d81336236ca',
  archiveUrl: 'https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip',
  archiveSha256: 'BD7321EAA1A7602FBE0BB87302DF2D79D87835CF4363FBDD17C350DBB485C2AF',
  libraries: Object.freeze({
    'arm64-v8a': '5AFCD3BE4891F2FCF434F5218CE5FAAD08380789B6B080D30EA5D5867B1FC4F4',
    'armeabi-v7a': 'D0C41551F6CFBB0EFD5A6C94ED7C3EFC0E74594FE60095147C4C20A6E81A1D58',
    x86_64: '57BAD09BA77FF33BB0A518EB57ED52CBA21A24BDC9F99042A3C407BFDC2F907D'
  }),
  packagedLibraries: Object.freeze({
    'arm64-v8a': '4ACF028FD4EE6FAF97CE4672CE8174CF01E7B55AF9D84CBAAE801F85D04804C5',
    'armeabi-v7a': '9EB306E8467D4B5AC600022B0052718398AFBFD0CBFECA52B11BF7B03E9319F5',
    x86_64: '0F83FC6720E51FE115B928F0A04D2D8EDC0E227D1E517A398C00381F14ED4B6D'
  })
});

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

function expectedMobileServerSource() {
  const source = fs.readFileSync(path.join(repositoryRoot, 'server/index.js'), 'utf8');
  const gradle = read('mobile/app/build.gradle');
  const compatibility = gradle.match(/^\s*def mobileValidationLine = '([^'\r\n]+)'\s*$/m);
  assert.ok(compatibility, 'Node.js Mobile username compatibility line is missing from app/build.gradle');
  const sourceLine = source.match(/^function validUsername\(value\)[^\r\n]*/m);
  assert.ok(sourceLine, 'unable to derive the expected Node.js Mobile server compatibility patch');
  return Buffer.from(source.slice(0, sourceLine.index) + compatibility[1]
    + source.slice(sourceLine.index + sourceLine[0].length), 'utf8');
}

function walkFiles(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

function productionDependencyClosure() {
  const applicationManifest = JSON.parse(read('package.json'));
  const mobileExcludedPackages = new Set(['ffmpeg-static', 'ffprobe-static']);
  const queue = Object.keys(applicationManifest.dependencies || {})
    .filter((packageName) => !mobileExcludedPackages.has(packageName));
  const packages = new Set();
  while (queue.length) {
    const packageName = queue.shift();
    if (packages.has(packageName)) continue;
    packages.add(packageName);
    const manifestPath = path.join(repositoryRoot, 'node_modules', ...packageName.split('/'), 'package.json');
    assert.ok(fs.existsSync(manifestPath), `production dependency is missing: ${packageName}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    queue.push(...Object.keys(manifest.dependencies || {}));
  }
  return [...packages].sort();
}

function verifySources() {
  const buildScript = read('mobile/build-apk.ps1');
  assert.match(buildScript, /\$aaptExitCode\s*=\s*\$LASTEXITCODE[\s\S]{0,200}\$aaptExitCode\s+-ne\s+0/,
    'APK metadata verification must capture aapt exit status before piping its output');
  assert.match(buildScript, new RegExp(NODE_MOBILE.version.replace(/\./g, '\\.')));
  assert.ok(buildScript.includes(NODE_MOBILE.sourceRevision), 'build script does not pin the 16 KB Node.js Mobile source revision');
  assert.ok(buildScript.includes(NODE_MOBILE.archiveUrl), 'build script does not pin the official Node.js Mobile URL');
  assert.ok(buildScript.includes(NODE_MOBILE.archiveSha256), 'build script does not pin the Node.js Mobile archive SHA-256');
  for (const [abi, digest] of Object.entries(NODE_MOBILE.libraries)) {
    assert.ok(buildScript.includes(`'${abi}'`), `build script does not validate ${abi}`);
    assert.ok(buildScript.includes(digest), `build script does not pin the ${abi} libnode.so SHA-256`);
    assert.ok(buildScript.includes(NODE_MOBILE.packagedLibraries[abi]), `build script does not pin the packaged ${abi} libnode.so SHA-256`);
  }
  assert.doesNotMatch(buildScript, /\bgenkeypair\b/i, 'release build must not silently create a replacement signing identity');
  assert.match(buildScript, /real release keystore is required/i);
  assert.match(buildScript, /was not signed by the configured release keystore/i);
  assert.match(buildScript, /Assert-ApkPayload/);
  assert.match(buildScript, new RegExp(`\\.\\.\\\\dist[\\s\\S]{0,160}SyncWatch-Android-v${packageVersion.replaceAll('.', '\\.')}\\-universal\\.apk`),
    'the signed APK must publish directly to the root dist directory');
  assert.doesNotMatch(buildScript, new RegExp(`SyncWatch同步观影-v${packageVersion.replaceAll('.', '\\.')}\\.apk`),
    'the Android build must not keep a duplicate delivery APK under mobile');

  const mobileServerSource = expectedMobileServerSource().toString('utf8');
  assert.doesNotMatch(mobileServerSource, /\\p\{Script=Han\}/,
    'the Android server still contains a Unicode script escape unsupported by Node.js Mobile 18');
  assert.doesNotThrow(() => new Function(mobileServerSource),
    'the generated Android server entrypoint must parse before the embedded runtime starts');

  const gradle = read('mobile/app/build.gradle');
  assert.match(gradle, /prepareMobileServerAssets/);
  assert.match(gradle, /new File\(repositoryRoot, 'server'\)[\s\S]{0,120}into 'syncwatch\/server'/,
    'Gradle must package the complete server source directory, not only server/index.js');
  assert.match(buildScript, /Get-ChildItem[\s\S]{0,300}server[\s\S]{0,300}-Recurse[\s\S]{0,300}\*\.js/,
    'the release verifier must enumerate every bundled server JavaScript file');
  assert.match(gradle, /const ID_START = \/\^\[\$_A-Za-z\]\$\//,
    'Gradle asset preparation must retain the path-to-regexp ID_START compatibility patch');
  assert.match(gradle, /const ID_CONTINUE = \/\^\[\$_A-Za-z0-9\]\$\//,
    'Gradle asset preparation must retain the path-to-regexp ID_CONTINUE compatibility patch');
  assert.match(gradle, /const ID = \/\^\[\$_A-Za-z\]\[\$_A-Za-z0-9\]\*\$\//,
    'Gradle asset preparation must retain the path-to-regexp ID compatibility patch');
  assert.match(gradle, /new File\(repositoryRoot, 'public'\)/);
  assert.match(gradle, /assets\.srcDir generatedServerAssets/);
  assert.match(gradle, /jniLibs\.srcDir/);
  assert.match(gradle, /-Wl,-z,max-page-size=16384/,
    'the embedded Node bridge must be linked for Android 16 KB page-size devices');
  assert.match(gradle, /-Wl,-z,common-page-size=16384/,
    'native Android libraries must use a 16 KB common page size');
  assert.match(gradle, /libc\+\+_static\.a/,
    'the arm32 C++ runtime must be relinked from the NDK static archive');
  assert.match(gradle, /libc\+\+abi\.a/,
    'the arm32 C++ ABI runtime must be relinked from the NDK static archive');
  assert.match(gradle, /useLegacyPackaging\s*=\s*false/,
    'native libraries must use modern uncompressed APK packaging for 16 KB alignment');
  assert.doesNotMatch(gradle, /signingConfig\s+signingConfigs\.debug/, 'release Gradle configuration still falls back to the debug key');

  const packageListMatch = gradle.match(/def bundledRuntimePackages\s*=\s*\[([\s\S]*?)\n\]/);
  assert.ok(packageListMatch, 'unable to find bundledRuntimePackages in app/build.gradle');
  const bundledPackages = new Set([...packageListMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
  const dependencyClosure = productionDependencyClosure();
  for (const packageName of dependencyClosure) {
    assert.ok(bundledPackages.has(packageName), `Gradle asset bundle omits production dependency: ${packageName}`);
  }

  const manifest = read('mobile/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_SPECIAL_USE/);
  assert.match(manifest, /android:name="\.MobileServerService"/);
  assert.match(manifest, /android:foregroundServiceType="specialUse"/);
  assert.match(manifest, /android\.app\.PROPERTY_SPECIAL_USE_FGS_SUBTYPE/);

  const service = read('mobile/app/src/main/java/com/xuan/syncwatch/MobileServerService.java');
  assert.match(service, /System\.loadLibrary\("syncwatch-node"\)/);
  assert.match(service, /assets\/syncwatch|"syncwatch"/);
  assert.match(service, /server','mobile-index\.js/,
    'the Android server must run the generated Node.js Mobile compatibility entrypoint');
  assert.match(service, /ACTION_START/);
  assert.match(service, /ACTION_STOP/);
  assert.match(service, /ANDROID_TUNNEL_UNAVAILABLE_MESSAGE[\s\S]*?Android[\s\S]*?cloudflared/,
    'the Android local server must explain why its own public tunnel is unavailable');
  assert.match(service, /state:'unavailable',platform:'android'/,
    'the Android local server must expose a truthful unavailable tunnel capability');
  assert.match(service, /error\.code='ANDROID_TUNNEL_RUNTIME_UNAVAILABLE'/,
    'attempting to start an unavailable Android tunnel must fail explicitly');
  assert.match(service, /hostControlToken:hostToken,tunnelManager,androidApkPath/,
    'the Android bootstrap must pass its explicit tunnel capability to the shared server');
  assert.match(service, new RegExp(`androidApkPath:path\\.join\\(dataRoot,'SyncWatch同步观影-v${packageVersion.replaceAll('.', '\\.')}\\.apk'\\)`),
    'the Android bootstrap must point download metadata at the current APK');
  assert.doesNotMatch(service, /v2\.1\.7/, 'the Android bootstrap must not retain the previous APK version');
  const activity = read('mobile/app/src/main/java/com/xuan/syncwatch/MainActivity.java');
  assert.match(activity, /STATUS_STOPPED[\s\S]{0,300}leaveStoppedLocalServerPage\("手机服务器已停止"\)/,
    'notification stop broadcasts must immediately leave a stopped local-server page');
  assert.match(activity, /private void leaveStoppedLocalServerPage\(String message\)[\s\S]*?remove\(PREF_SERVER\)[\s\S]*?showConnectionScreen\(message\);/,
    'stopped local-server cleanup must clear the saved local origin and show the connection screen');
  assert.match(activity, /setOnClickListener\(view -> requestMobileServerStart\(\)\)/,
    'the mobile-server start button must use the notification-aware start flow');
  assert.match(activity, /private void requestMobileServerStart\(\)[\s\S]*?POST_NOTIFICATIONS[\s\S]*?REQUEST_SERVER_NOTIFICATION/,
    'Android 13+ mobile-server startup must request notification permission');
  assert.match(activity, /requestCode == REQUEST_SERVER_NOTIFICATION[\s\S]*?startMobileServer\(\);/,
    'mobile-server startup must continue after the notification permission decision');
  assert.match(activity, /连接现有服务器/);
  assert.match(activity, /本机服务器/);
  assert.match(activity, /setMinHeight\(dp\(48\)\)/,
    'native Android controls must retain at least a 48dp touch target');
  assert.match(activity, /isLocationPermissionGranted:function/);
  assert.match(activity, /requestLocationPermission:function/);
  assert.match(activity, /ACTION_APPLICATION_DETAILS_SETTINGS/,
    'the Android location retry flow must reach system app permissions after a permanent denial');
  assert.match(activity, /syncwatch-native-location-permission/,
    'the web application must be notified after Android location permission changes');

  const capture = read('mobile/app/src/main/java/com/xuan/syncwatch/ScreenCaptureService.java');
  assert.match(capture, /static final int TARGET_FPS = 12;/,
    'native Android screen sharing must target 12fps on healthy devices');
  assert.match(capture, /static final int MAX_CAPTURE_DIMENSION = 1920;/,
    'native Android screen sharing must retain up to 1080p-class detail');
  assert.match(capture, /static final int LOW_MEMORY_CAPTURE_DIMENSION = 1600;/,
    'native screen sharing must have a bounded low-memory resolution');
  assert.match(capture, /int\[\] qualities = \{88, 82, 76, 68, 60, 52, 44\};/,
    'native capture must begin with a high-quality JPEG and adapt under the frame limit');
  assert.match(capture, /updateAdaptiveFrameInterval\(encodeDurationMs, jpeg\.length\)/,
    'native capture must adapt its frame rate to encoding and payload pressure');
  assert.match(capture, /jpeg\.length > MAX_JPEG_BYTES/,
    'native capture must enforce the shared server frame-size ceiling');
  assert.ok(fs.existsSync(path.join(appRoot, 'src/main/cpp/native-node.cpp')), 'native Node.js bridge is missing');
  assert.ok(fs.existsSync(path.join(appRoot, 'CMakeLists.txt')), 'Node.js Mobile CMake configuration is missing');

  return dependencyClosure;
}

function parseZip(buffer) {
  const minimumEocdOffset = Math.max(0, buffer.length - 65_557);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  assert.notEqual(eocdOffset, -1, 'APK ZIP end record was not found');
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  assert.notEqual(entryCount, 0xffff, 'ZIP64 APKs are not supported by this offline verifier');
  assert.notEqual(centralOffset, 0xffffffff, 'ZIP64 APKs are not supported by this offline verifier');

  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, `invalid ZIP central entry at ${offset}`);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `invalid local ZIP entry for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, { name, method, compressedSize, size, localOffset, dataOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  function extract(entryName) {
    const entry = entries.get(entryName);
    assert.ok(entry, `APK entry is missing: ${entryName}`);
    assert.equal(buffer.readUInt32LE(entry.localOffset), 0x04034b50, `invalid local ZIP entry for ${entryName}`);
    const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
    let content;
    if (entry.method === 0) content = compressed;
    else if (entry.method === 8) content = zlib.inflateRawSync(compressed);
    else assert.fail(`unsupported ZIP compression method ${entry.method} for ${entryName}`);
    assert.equal(content.length, entry.size, `uncompressed size mismatch for ${entryName}`);
    return content;
  }

  return { entries, extract };
}

function elfLoadAlignments(buffer, entryName) {
  assert.ok(buffer.length >= 52, `${entryName} is too small to be a valid ELF library`);
  assert.deepEqual([...buffer.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46], `${entryName} is not an ELF library`);
  const elfClass = buffer[4];
  assert.ok(elfClass === 1 || elfClass === 2, `${entryName} has an unsupported ELF class`);
  assert.equal(buffer[5], 1, `${entryName} must use little-endian ELF encoding`);
  const programOffset = elfClass === 2 ? Number(buffer.readBigUInt64LE(32)) : buffer.readUInt32LE(28);
  const programEntrySize = buffer.readUInt16LE(elfClass === 2 ? 54 : 42);
  const programEntryCount = buffer.readUInt16LE(elfClass === 2 ? 56 : 44);
  const alignments = [];
  for (let index = 0; index < programEntryCount; index += 1) {
    const offset = programOffset + (index * programEntrySize);
    assert.ok(offset >= 0 && offset + programEntrySize <= buffer.length, `${entryName} has an invalid ELF program table`);
    if (buffer.readUInt32LE(offset) !== 1) continue;
    alignments.push(elfClass === 2 ? Number(buffer.readBigUInt64LE(offset + 48)) : buffer.readUInt32LE(offset + 28));
  }
  assert.ok(alignments.length > 0, `${entryName} does not contain a loadable ELF segment`);
  return alignments;
}

function verifyApk(dependencyClosure) {
  assert.ok(fs.existsSync(apkPath), `APK was not found: ${apkPath}`);
  const apk = parseZip(fs.readFileSync(apkPath));
  const allowGeneratedRuntime = process.env.SYNCWATCH_ALLOW_GENERATED_NODE_MOBILE === '1';
  const requiredEntries = [
    'AndroidManifest.xml',
    'assets/syncwatch/server/mobile-index.js',
    'assets/syncwatch/public/index.html',
    'assets/syncwatch/public/js/app.js',
    'assets/syncwatch/public/js/avatar-tools.js',
    'assets/syncwatch/public/js/media-network-recovery.js',
    'assets/syncwatch/public/css/avatar-tools.css',
    'assets/syncwatch/public/css/style.css',
    'assets/syncwatch/runtime-version.txt'
  ];
  const serverRoot = path.join(repositoryRoot, 'server');
  const serverSources = walkFiles(serverRoot).filter((sourceFile) => sourceFile.endsWith('.js'));
  for (const sourceFile of serverSources) {
    const relative = path.relative(serverRoot, sourceFile).split(path.sep).join('/');
    requiredEntries.push(`assets/syncwatch/server/${relative}`);
  }
  for (const abi of Object.keys(NODE_MOBILE.libraries)) {
    requiredEntries.push(`lib/${abi}/libnode.so`, `lib/${abi}/libsyncwatch-node.so`, `lib/${abi}/libc++_shared.so`);
  }
  for (const entryName of requiredEntries) {
    const entry = apk.entries.get(entryName);
    assert.ok(entry && entry.size > 0, `APK payload is missing or empty: ${entryName}`);
  }

  for (const [abi, expectedDigest] of Object.entries(NODE_MOBILE.packagedLibraries)) {
    const actualDigest = sha256(apk.extract(`lib/${abi}/libnode.so`));
    if (allowGeneratedRuntime) {
      assert.match(actualDigest, /^[A-F0-9]{64}$/, `APK contains an invalid ${abi} libnode.so digest`);
    } else {
      assert.equal(actualDigest, expectedDigest, `APK contains an unexpected ${abi} libnode.so`);
    }
  }
  for (const abi of Object.keys(NODE_MOBILE.libraries)) {
    for (const libraryName of ['libnode.so', 'libsyncwatch-node.so', 'libc++_shared.so']) {
      const entryName = `lib/${abi}/${libraryName}`;
      const entry = apk.entries.get(entryName);
      assert.equal(entry.method, 0, `${entryName} must remain uncompressed for direct Android loading`);
      assert.equal(entry.dataOffset % 16_384, 0, `${entryName} is not 16 KB aligned inside the APK`);
      const loadAlignments = elfLoadAlignments(apk.extract(entryName), entryName);
      assert.ok(loadAlignments.every((alignment) => alignment >= 16_384),
        `${entryName} contains a LOAD segment below 16 KB alignment: ${loadAlignments.join(', ')}`);
    }
  }

  for (const sourceFile of serverSources) {
    const relative = path.relative(serverRoot, sourceFile).split(path.sep).join('/');
    assert.equal(sha256(apk.extract(`assets/syncwatch/server/${relative}`)),
      sha256(fs.readFileSync(sourceFile)), `APK server source is stale: ${relative}`);
  }
  assert.equal(sha256(apk.extract('assets/syncwatch/server/mobile-index.js')),
    sha256(expectedMobileServerSource()), 'APK mobile-index.js is stale');
  const publicRoot = path.join(repositoryRoot, 'public');
  for (const sourceFile of walkFiles(publicRoot)) {
    const relative = path.relative(publicRoot, sourceFile).split(path.sep).join('/');
    const entryName = `assets/syncwatch/public/${relative}`;
    assert.equal(sha256(apk.extract(entryName)), sha256(fs.readFileSync(sourceFile)), `APK public asset is stale: ${relative}`);
  }
  for (const packageName of dependencyClosure) {
    const entryName = `assets/syncwatch/node_modules/${packageName}/package.json`;
    const entry = apk.entries.get(entryName);
    assert.ok(entry && entry.size > 0, `APK is missing production Node.js dependency: ${packageName}`);
    const sourceManifest = fs.readFileSync(path.join(repositoryRoot, 'node_modules', ...packageName.split('/'), 'package.json'));
    assert.equal(sha256(apk.extract(entryName)), sha256(sourceManifest), `APK dependency manifest is stale: ${packageName}`);
  }
  const runtimeMarker = apk.extract('assets/syncwatch/runtime-version.txt').toString('utf8').trim();
  assert.match(runtimeMarker, /^[a-f0-9]{64}$/);
  const runtimeDigest = crypto.createHash('sha256');
  const runtimeEntries = [...apk.entries.keys()]
    .filter((name) => name.startsWith('assets/syncwatch/')
      && name !== 'assets/syncwatch/runtime-version.txt' && !name.endsWith('/'))
    .sort();
  for (const entryName of runtimeEntries) {
    runtimeDigest.update(entryName.slice('assets/syncwatch/'.length), 'utf8');
    runtimeDigest.update(apk.extract(entryName));
  }
  assert.equal(runtimeMarker, runtimeDigest.digest('hex'),
    'APK runtime-version.txt does not match the packaged runtime assets');

  const routeText = apk.extract('assets/syncwatch/node_modules/path-to-regexp/dist/index.js').toString('utf8');
  assert.match(routeText, /const ID_START = \/\^\[\$_A-Za-z\]\$\//);
  assert.match(routeText, /const ID_CONTINUE = \/\^\[\$_A-Za-z0-9\]\$\//);
  assert.match(routeText, /const ID = \/\^\[\$_A-Za-z\]\[\$_A-Za-z0-9\]\*\$\//);
  assert.ok(![...apk.entries.keys()].some((name) => /^assets\/syncwatch\/(?:mobile\/)?SyncWatch同步观影-v2\.1\.7\.apk$/.test(name)), 'APK recursively embeds itself');
}

const dependencyClosure = verifySources();
if (!sourceOnly) verifyApk(dependencyClosure);
console.log(`Android package verification passed (${dependencyClosure.length} production Node.js packages${sourceOnly ? ', source-only' : ', APK unpacked'}).`);
