'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflowDirectory = path.join(root, '.github', 'workflows');
const filenames = {
  atomic: path.join(workflowDirectory, 'release-atomic.yml'),
  windows: path.join(workflowDirectory, 'release-windows.yml'),
  macos: path.join(workflowDirectory, 'release-macos.yml')
};
const workflows = Object.fromEntries(
  Object.entries(filenames).map(([key, filename]) => [key, fs.readFileSync(filename, 'utf8')])
);

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
for (const source of [workflows.windows, workflows.macos]) {
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
assert.match(workflows.atomic, /source_tree="\$\(git rev-parse "\$\{RELEASE_TAG\}\^\{tree\}"\)"/);
assert.match(
  workflows.atomic,
  /artifact_prefix=release-\$\{RELEASE_TAG\}-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/
);
assert.match(workflows.atomic, /existing Release must be an empty draft/);
assert.match(workflows.atomic, /Release target changed after preparation/);

for (const source of [workflows.windows, workflows.macos]) {
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
assert.match(workflows.atomic, /needs:\s*\[prepare, source_tests, android, windows_base, mac_base, official_assets, windows_full, mac_full\]/);
assert.match(workflows.atomic, /--output dist/);
assert.match(workflows.atomic, /--selection bundle/);
assert.match(workflows.atomic, /SHA256SUMS-all-28\.txt/);
assert.match(workflows.atomic, /SHA256SUMS-release-26\.txt/);
assert.match(workflows.atomic, /release-files-26\.txt/);
assert.match(workflows.atomic, /find dist -maxdepth 1 -type f[\s\S]*= "28"/);
assert.match(workflows.atomic, /--evidence-directory \.build\/evidence/);

assert.equal(
  count(workflows.atomic, /gh release upload /g),
  1,
  'all 26 maintained assets must be uploaded by one command'
);
assert.match(workflows.atomic, /gh release upload "\$RELEASE_TAG" "\$\{files\[@\]\}"/);
assert.doesNotMatch(workflows.atomic, /gh release upload[^\n]*(?:\*|--clobber)/);
assert.match(workflows.atomic, /test "\$\{#files\[@\]\}" -eq 26/);
assert.match(workflows.atomic, /gh release delete-asset "\$RELEASE_TAG" "\$name"/);
assert.match(workflows.atomic, /--draft=true/);
assert.match(workflows.atomic, /Atomic publication failed/);
assert.ok(
  count(workflows.atomic, /--expected-manifest \.build\/SHA256SUMS-release-26\.txt/g) >= 2,
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
assert.match(workflows.windows, /android_startup:/);
assert.match(workflows.windows, /reactivecircus\/android-emulator-runner@a421e43855164a8197daf9d8d40fe71c6996bb0d/);
assert.match(workflows.windows, /adb install --no-streaming/);
assert.match(workflows.windows, /am start -W -n com\.xuan\.syncwatch\/\.MainActivity/);
assert.match(workflows.windows, /pidof com\.xuan\.syncwatch/);
assert.match(workflows.windows, /logcat -d -b crash/);
assert.match(workflows.windows, /Start-Process -FilePath \$client/);
assert.match(workflows.windows, /Start-Process -FilePath \$installer/);
assert.match(workflows.windows, /Test-ServerExecutable \$installed\.FullName/);
assert.match(workflows.windows, /Test-ServerExecutable \$portable/);
assert.match(workflows.macos, /runner:\s*macos-15-intel/);
assert.match(workflows.macos, /runner:\s*macos-15(?:\s|$)/m);
assert.match(workflows.macos, /assert_native_bundle/);
assert.match(workflows.macos, /Mach-O/);
assert.match(workflows.macos, /find "\$app\/Contents\/MacOS" "\$app\/Contents\/Frameworks" -type f/);
assert.match(workflows.macos, /cloudflared-darwin-x64" \| grep -q 'x86_64'/);
assert.match(workflows.macos, /cloudflared-darwin-arm64" \| grep -q 'arm64'/);
assert.match(workflows.macos, /verify_container "\$zip" zip/);
assert.match(workflows.macos, /verify_container "\$dmg" dmg/);
assert.match(workflows.macos, /smoke_client/);
assert.match(workflows.macos, /smoke_server/);
assert.match(workflows.macos, /smoke_full_server/);
assert.match(workflows.macos, /androidApkAvailable===true/);
assert.match(workflows.macos, /clientDownloadAvailable===true/);

console.log('atomic 28-file release workflow, provenance, rollback, and native startup contracts passed.');
