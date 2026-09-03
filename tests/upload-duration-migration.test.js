'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startSyncWatchServer } = require('../server');

async function readPublicConfig(server) {
  return (await fetch(`http://127.0.0.1:${server.port}/api/public-config`, { cache: 'no-store' })).json();
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-upload-duration-'));
  const dataDir = path.join(root, 'SyncWatch同步观影-Data');
  fs.mkdirSync(dataDir, { recursive: true });
  // Previous v2.3.9 candidates could have persisted the former five-minute
  // default with no policy marker or with policy version 1. Upgrading must
  // clear both forms.
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    version: 13,
    admin: { uploadVideoDurationLimitSeconds: 300, uploadVideoDurationLimitConfigured: true, uploadVideoDurationLimitPolicyVersion: 1 }
  }));
  let server = await startSyncWatchServer({
    host: '127.0.0.1', port: 0, dataDir, publicDir: path.resolve(__dirname, '..', 'public'),
    ffprobePath: '', ffmpegPath: '', discovery: false, hostControlToken: 'upload-duration-migration'
  });
  try {
    let config = await readPublicConfig(server);
    assert.equal(config.uploadVideoDurationLimitSeconds, 0, '旧候选配置的 300 秒限制必须迁移为不限');
    const migrated = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(migrated.admin.uploadVideoDurationLimitConfigured, false);
    assert.equal(migrated.admin.uploadVideoDurationLimitPolicyVersion, 2);
    await server.close();

    // An administrator explicitly saving a limit in the current release must
    // survive a restart and remain enforceable.
    migrated.admin.uploadVideoDurationLimitSeconds = 600;
    migrated.admin.uploadVideoDurationLimitConfigured = true;
    migrated.admin.uploadVideoDurationLimitPolicyVersion = 2;
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(migrated));
    server = await startSyncWatchServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir: path.resolve(__dirname, '..', 'public'),
      ffprobePath: '', ffmpegPath: '', discovery: false, hostControlToken: 'upload-duration-migration'
    });
    config = await readPublicConfig(server);
    assert.equal(config.uploadVideoDurationLimitSeconds, 600, '当前版本明确保存的时长限制必须保留');
    console.log('upload duration migration and explicit policy persistence passed');
  } finally {
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
