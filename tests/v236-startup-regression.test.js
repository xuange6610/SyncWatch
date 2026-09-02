'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { startSyncWatchServer } = require('../server');

const publicDir = path.resolve(__dirname, '..', 'public');

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-v236-startup-'));
  const source = path.join(root, 'legacy');
  const migrated = path.join(root, 'portable');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'config.json'), JSON.stringify({ version: 13, admin: {}, rooms: {}, accounts: {}, files: [] }));
  fs.mkdirSync(path.join(source, '.syncwatch-instance.lock'), { recursive: true });
  fs.writeFileSync(path.join(source, '.syncwatch-instance.lock', 'owner.json'), '{"pid":1}');
  fs.cpSync(source, migrated, { recursive: true });
  fs.rmSync(path.join(migrated, '.syncwatch-instance.lock'), { recursive: true, force: true });

  let controller;
  let reserved;
  try {
    controller = await startSyncWatchServer({ host: '127.0.0.1', port: 0, dataDir: migrated, discovery: false, publicDir, ffmpegPath: '', ffprobePath: '', hostControlToken: 'v236-regression' });
    assert.ok(fs.existsSync(path.join(migrated, 'config.json')), '已有数据目录必须保留并可启动');
    await controller.close();
    controller = null;

    reserved = await reservePort();
    await assert.rejects(
      () => startSyncWatchServer({ host: '127.0.0.1', port: reserved.port, strictPort: true, dataDir: path.join(root, 'occupied'), discovery: false, publicDir, ffmpegPath: '', ffprobePath: '', hostControlToken: 'v236-occupied' }),
      (error) => error.code === 'EADDRINUSE' && /未随机切换端口/.test(error.message)
    );
  } finally {
    await controller?.close().catch(() => {});
    reserved?.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('v2.3.6 startup compatibility and strict-port regression passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
