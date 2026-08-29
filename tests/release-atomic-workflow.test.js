'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflowDirectory = path.join(root, '.github', 'workflows');
const filenames = {
  atomic: path.join(workflowDirectory, 'release-atomic.yml'),
  windows: path.join(workflowDirectory, 'release-windows.yml'),
};
const workflows = Object.fromEntries(
  Object.entries(filenames).map(([key, filename]) => [key, fs.readFileSync(filename, 'utf8')])
);
const androidEmulatorSmokePath = path.join(root, 'scripts', 'android-emulator-smoke.sh');
const androidEmulatorSmoke = fs.readFileSync(androidEmulatorSmokePath, 'utf8');

function count(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

for (const [name, filename] of Object.entries(filenames)) {
  assert.ok(fs.statSync(filename).isFile(), `${name} release workflow must exist`);
  try {
    require('js-yaml').load(workflows[name]);
  } catch (error) {
    assert.fail(`${path.basename(filename)} is not valid YAML: ${error.message}`);
  }
}

assert.equal(
  Object.values(workflows).filter((source) => /\bworkflow_dispatch\s*:/.test(source)).length,
  1,
  'only the atomic orchestrator may be dispatched manually'
);
assert.match(workflows.atomic, /\bworkflow_dispatch\s*:/);
for (const source of [workflows.windows]) {
  assert.match(source, /\bworkflow_call\s*:/);
  assert.doesNotMatch(source, /\bworkflow_dispatch\s*:/);
  assert.doesNotMatch(source, /contents:\s*write/);
  assert.doesNotMatch(source, /gh release (?:create|upload|edit|delete|delete-asset)/);
  assert.doesNotMatch(source, /\/latest\//);
  assert.match(source, /release-third-party-assets\.js/);
}

assert.equal(
  count(Object.values(workflows).join('\n'), /contents:\s*write/g),
  1,
  'only the final atomic publication job may have contents:write'
);
assert.match(
  workflows.atomic,
  /final:\s*[\s\S]*?permissions:\s*\n\s+contents:\s*write/,
  'the final job must own the only Release write token'
);
assert.match(workflows.atomic, /test "\$WORKFLOW_REF" = "refs\/tags\/\$\{RELEASE_TAG\}"/);
assert.match(workflows.atomic, /git cat-file -t "refs\/tags\/\$\{RELEASE_TAG\}"/);
assert.match(workflows.atomic, /test "\$WORKFLOW_SHA" = "\$commit_sha"/);
assert.match(
  workflows.atomic,
  /source_tests:[\s\S]*?ELECTRON_DISABLE_SANDBOX:\s*['"]?1['"]?/,
  'Ubuntu release source gates must configure Electron for runners without the chrome-sandbox SUID bit'
);
assert.match(
  workflows.atomic,
  /source_tests:[\s\S]*?release-third-party-assets\.js[\s\S]*?--only cloudflared-windows-x64\.exe[\s\S]*?vendor\/cloudflared\.exe/,
  'Ubuntu source gates must stage the pinned cloudflared fixture before test:all'
);
assert.match(workflows.atomic, /source_tree="\$\(git rev-parse "\$\{RELEASE_TAG\}\^\{tree\}"\)"/);
assert.match(
  workflows.atomic,
  /artifact_prefix=release-\$\{RELEASE_TAG\}-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/
);
assert.match(workflows.atomic, /existing Release must contain zero, partial legacy 6, legacy 11 .* legacy 26, or current 10 assets/);
assert.match(workflows.atomic, /Release target changed after preparation/);
assert.match(workflows.atomic, /replacement-upload/);
assert.match(workflows.atomic, /\.replacement-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
assert.match(workflows.atomic, /\.previous-\$\{process\.env\.GITHUB_RUN_ID\}-\$\{process\.env\.GITHUB_RUN_ATTEMPT\}/);
assert.match(workflows.atomic, /replacement_ready=1/);
assert.match(workflows.atomic, /previous 10 assets and public Release state were restored/);

for (const source of [workflows.windows]) {
  const uploadBlocks = source.match(/uses:\s*actions\/upload-artifact@v4[\s\S]*?retention-days:\s*3/g) || [];
  assert.ok(uploadBlocks.length >= 4, 'each reusable build workflow must upload candidates and evidence');
  for (const block of uploadBlocks) {
    assert.match(block, /name:\s*\$\{\{ inputs\.artifact_prefix \}\}/);
  }
  assert.match(source, /ref:\s*\$\{\{ inputs\.commit_sha \}\}/);
  assert.match(source, /HEAD\^\{tree\}/);
  assert.match(source, /--run-id \S*GITHUB_RUN_ID/);
  assert.match(source, /--run-attempt \S*GITHUB_RUN_ATTEMPT/);
}

assert.match(workflows.atomic, /phase:\s*android/);
assert.match(workflows.atomic, /phase:\s*base/);
assert.match(workflows.atomic, /phase:\s*full/);
assert.match(workflows.atomic, /official_assets:/);
assert.match(
  workflows.atomic,
  /windows_base:\s*[\s\S]*?needs:\s*\[prepare, source_tests, official_assets\]/,
  'Windows base must wait for and consume same-run official assets'
);
assert.match(workflows.atomic, /needs:\s*\[prepare, source_tests, android, windows_base, official_assets, windows_full\]/);
assert.match(workflows.atomic, /--output dist/);
assert.match(workflows.atomic, /--selection bundle/);
assert.match(workflows.atomic, /SHA256SUMS-all-12\.txt/);
assert.match(workflows.atomic, /SHA256SUMS-release-10\.txt/);
assert.match(workflows.atomic, /release-files-10\.txt/);
assert.match(workflows.atomic, /find dist -maxdepth 1 -type f[\s\S]*= "12"/);
assert.match(workflows.atomic, /--evidence-directory \.build\/evidence/);

assert.equal(
  count(workflows.atomic, /gh release upload /g),
  1,
  'all 10 maintained assets must be uploaded by one command'
);
assert.match(workflows.atomic, /gh release upload "\$RELEASE_TAG" "\$\{replacement_files\[@\]\}"/);
assert.doesNotMatch(workflows.atomic, /gh release upload[^\n]*(?:\*|--clobber)/);
assert.match(workflows.atomic, /test "\$\{#files\[@\]\}" -eq 10/);
assert.match(workflows.atomic, /releases\?per_page=100/);
assert.match(workflows.atomic, /release_id="\$\(RELEASES_JSON=/);
assert.match(workflows.atomic, /releases\/\$\{release_id\}/);
assert.ok(
  count(workflows.atomic, /-f tag_name="\$RELEASE_TAG"/g) >= 4,
  'draft creation and every draft update must preserve the requested tag name'
);
assert.match(workflows.atomic, /--method DELETE "repos\/\$\{GITHUB_REPOSITORY\}\/releases\/assets\/\$\{old_id\}"/);
assert.doesNotMatch(workflows.atomic, /releases\/tags\/\$\{RELEASE_TAG\}" > \.build\/(?:pre-upload|uploaded)-release\.json/);
assert.match(workflows.atomic, /-F draft=true/);
assert.match(workflows.atomic, /Atomic replacement failed/);
assert.ok(
  count(workflows.atomic, /--expected-manifest \.build\/SHA256SUMS-release-10\.txt/g) >= 2,
  'remote digests must be checked both before and after publication'
);
assert.match(workflows.atomic, /releases\/latest/);
assert.match(workflows.atomic, /assert_remote_tag/);
assert.match(workflows.atomic, /git\/ref\/tags\/\$\{RELEASE_TAG\}/);
assert.match(workflows.atomic, /git\/tags\/\$\{tag_object\}/);
assert.match(workflows.atomic, /git\/commits\/\$\{remote_commit\}/);
assert.match(workflows.atomic, /download-verification\.tsv/);
assert.match(workflows.atomic, /Accept: application\/octet-stream/);
assert.match(workflows.atomic, /releases\/assets\/\$\{asset_id\}/);
assert.match(workflows.atomic, /\| sha256sum \| awk/);
assert.match(workflows.atomic, /Downloaded SHA-256 mismatch/);
assert.match(workflows.atomic, /download-urls\.txt/);
assert.match(workflows.atomic, /curl --retry 3 --retry-all-errors -fsSIL/);
assert.match(workflows.atomic, /archive\/refs\/tags\/\$\{RELEASE_TAG\}\.zip/);
assert.match(workflows.atomic, /archive\/refs\/tags\/\$\{RELEASE_TAG\}\.tar\.gz/);
assert.match(workflows.atomic, /unzip -t \.build\/github-source\.zip/);
assert.match(workflows.atomic, /tar -tzf \.build\/github-source\.tar\.gz/);

assert.match(workflows.windows, /split-desktop-artifact-smoke\.js/);
assert.match(
  workflows.windows,
  /name:\s*Verify Windows desktop audio capture[\s\S]*?npm run test:audio-source:electron/,
  'Windows release runner must execute the real desktop audio capture smoke'
);
assert.match(
  workflows.windows,
  /name:\s*Verify Windows desktop audio capture[\s\S]*?SYNCWATCH_ALLOW_MISSING_AUDIO_LOOPBACK:\s*['"]?1['"]?/,
  'Windows hosted audio fallback must be explicitly enabled and visible in the workflow'
);
assert.match(
  fs.readFileSync(path.join(root, 'tests', 'audio-source-electron-smoke.js'), 'utf8'),
  /GITHUB_ACTIONS.*RUNNER_OS.*Windows/s,
  'Audio fallback must remain restricted to GitHub-hosted Windows runners'
);
assert.match(
  workflows.windows,
  /name:\s*Verify Windows broken-pipe shutdown handling[\s\S]*?node tests\/epipe-smoke\.js/,
  'Windows release runner must execute the real broken-pipe shutdown smoke'
);
assert.match(workflows.windows, /android_startup:/);
assert.match(
  workflows.windows,
  /name:\s*Restore verified third-party release cache[\s\S]*?name:\s*Download same-run verified official assets[\s\S]*?actions\/download-artifact@v4[\s\S]*?inputs\.artifact_prefix \}\}-official[\s\S]*?path:\s*\.cache\/release-third-party/,
  'Windows base must stage same-run official assets before preparing cloudflared'
);
assert.match(workflows.windows, /node_mobile_build:/);
assert.match(
  workflows.windows,
  /android:\s*\n\s+name:\s*Build signed Android artifact[\s\S]*?if:\s*\$\{\{\s*always\(\)[\s\S]*?needs\.node_mobile_combine\.result\s*==\s*'success'/,
  'Android signing must still run when the optional runtime build matrix is skipped'
);
assert.match(
  workflows.windows,
  /android_startup:\s*\n\s+name:\s*Install and launch Android artifact in an emulator[\s\S]*?if:\s*\$\{\{\s*always\(\)[\s\S]*?needs\.android\.result\s*==\s*'success'/,
  'Android startup verification must run after the signed APK job'
);
assert.match(
  workflows.windows,
  /name:\s*Setup Java 17 for Android Gradle Plugin[\s\S]*?uses:\s*actions\/setup-java@v4[\s\S]*?distribution:\s*temurin[\s\S]*?java-version:\s*['"]17['"]/,
  'Android release builds must use a supported Java runtime'
);
assert.match(
  workflows.windows,
  /&\s+\.\\mobile\\build-apk\.ps1[\s\S]*?\$buildExitCode\s*=\s*\$LASTEXITCODE[\s\S]*?Set-Location\s+-LiteralPath\s+\$env:GITHUB_WORKSPACE[\s\S]*?Missing exact Android output/,
  'Android post-build checks must restore the repository working directory'
);
assert.match(workflows.windows, /repository:\s*nodejs-mobile\/nodejs-mobile/);
assert.match(workflows.windows, /ref:\s*ff4e063f1f1911047c067335ad0a3d81336236ca/);
assert.match(workflows.windows, /LDFLAGS:\s*-Wl,-z,max-page-size=16384/);
assert.match(workflows.windows, /node_mobile_combine:/);
assert.match(workflows.windows, /node-mobile-runtime/);
assert.match(workflows.atomic, /node_mobile_runtime_run_id:/);
assert.match(workflows.atomic, /node_mobile_runtime_artifact_name:/);
assert.match(workflows.atomic, /node_mobile_runtime_run_id:\s*\$\{\{ inputs\.node_mobile_runtime_run_id \}\}/);
assert.match(workflows.atomic, /node_mobile_runtime_artifact_name:\s*\$\{\{ inputs\.node_mobile_runtime_artifact_name \}\}/);
assert.match(workflows.atomic, /permissions:\s*\n\s+contents:\s*read\s*\n\s+actions:\s*read/);
assert.match(workflows.windows, /actions:\s*read/);
assert.match(
  workflows.atomic,
  /name:\s*Prepare pinned Cloudflare binary for source smoke[\s\S]*?env:\s*\n\s+GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/,
  'Source release gates must authenticate official Cloudflare downloads'
);
assert.match(workflows.windows, /github-token:\s*\$\{\{ github\.token \}\}/);
assert.match(workflows.windows, /run-id:\s*\$\{\{ inputs\.node_mobile_runtime_run_id \}\}/);
assert.match(workflows.windows, /name:\s*\$\{\{ inputs\.node_mobile_runtime_artifact_name \}\}/);
assert.match(workflows.windows, /EXPECTED_SOURCE_REVISION:\s*ff4e063f1f1911047c067335ad0a3d81336236ca/);
assert.match(workflows.windows, /python3 - <<'PY'[\s\S]*?actual != expected[\s\S]*?type\(actual\.get\('pageSize'\)\) is not int/,
  'reused Node.js Mobile provenance must be parsed and checked by exact typed fields');
assert.doesNotMatch(workflows.windows, /(?:tr -d ['"]\\r\\n['"]|jq -e)/,
  'runtime provenance must not depend on byte-for-byte JSON line formatting');
assert.match(workflows.windows, /sha256sum --check --strict/,
  'reused Node.js Mobile digest failures must identify the exact file');
assert.match(
  workflows.windows,
  /sha256sum --check --strict node-mobile-runtime\/libnode-sha256\.txt/,
  'fresh Node.js Mobile ABI outputs must be verified against the runtime digest manifest'
);
assert.ok(
  workflows.windows.includes('Unexpected ELF LOAD alignment') && workflows.windows.includes("'^0x4000$'"),
  'Node.js Mobile ABI outputs must retain the 16 KB ELF page-size contract'
);
assert.match(workflows.windows, /Download official Node\.js Mobile 16 KB runtime/);
assert.match(workflows.windows, /reactivecircus\/android-emulator-runner@a421e43855164a8197daf9d8d40fe71c6996bb0d/);
assert.match(
  workflows.windows,
  /script:\s*bash scripts\/android-emulator-smoke\.sh/,
  'the emulator runner must invoke one script because it executes inline lines in separate shells'
);
assert.doesNotMatch(workflows.windows, /script:\s*\|[\s\S]{0,300}apk=/);
assert.ok(fs.statSync(androidEmulatorSmokePath).isFile(), 'Android emulator smoke script must exist');
assert.match(androidEmulatorSmoke, /GITHUB_WORKSPACE:\?GITHUB_WORKSPACE is required/);
assert.match(androidEmulatorSmoke, /SyncWatch-Android-v\$\{version\}-universal\.apk/);
assert.match(androidEmulatorSmoke, /adb install --no-streaming/);
assert.match(workflows.windows, /& \.\\mobile\\build-apk\.ps1/);
assert.doesNotMatch(workflows.windows, /powershell\.exe[^\r\n]*build-apk\.ps1/i);
assert.match(androidEmulatorSmoke, /dumpsys package com\.xuan\.syncwatch/);
assert.match(androidEmulatorSmoke, /am start -W -n com\.xuan\.syncwatch\/\.MainActivity/);
assert.match(androidEmulatorSmoke, /Status: \(ok\|timeout\)/);
assert.match(androidEmulatorSmoke, /pidof com\.xuan\.syncwatch/);
assert.match(androidEmulatorSmoke, /logcat -d -b crash/);
assert.match(androidEmulatorSmoke, /dumpsys activity activities/);
assert.match(androidEmulatorSmoke, /screencap -p/);
assert.match(workflows.windows, /\.build\/android-smoke\/launch\.txt/);
assert.match(workflows.windows, /Start-Process -FilePath \$client/);
assert.match(workflows.windows, /Start-Process -FilePath \$installer/);
assert.match(workflows.windows, /Test-ServerExecutable \$installed\.FullName/);
assert.match(workflows.windows, /Test-ServerExecutable \$portable/);
assert.match(workflows.windows, /dist\\builder-debug\.yml/);
for (const source of [workflows.windows]) {
  assert.match(source, /path:\s*\.build\/full-inputs\/windows/);
  assert.match(source, /path:\s*\.build\/full-inputs\/android/);
  assert.match(
    source,
    /prepare-full-offline-bundle\.js[\s\S]{0,180}verify-full-offline-bundle\.js/,
    'Full Offline builds must curate exactly two Windows/Android inputs before packaging'
  );
}
assert.doesNotMatch(workflows.windows, /path:\s*\.build\/offline-bundle\/(?:windows|android|mac)/);
console.log('atomic Windows/Android release workflow, provenance, rollback, and native startup contracts passed.');
