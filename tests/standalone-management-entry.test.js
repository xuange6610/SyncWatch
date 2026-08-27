'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronServer = fs.readFileSync(path.join(root, 'electron-pink.js'), 'utf8');
const standalone = require('../server-standalone');
const {
  commandLineFlag,
  standaloneHelp,
  standaloneManagementSummary,
  systemBrowserCommand
} = standalone._test;

assert.equal(commandLineFlag('open-browser', ['node', 'server-standalone.js', '--open-browser']), true);
assert.equal(commandLineFlag('open-browser', ['node', 'server-standalone.js', '--open-browser=false']), false);
assert.equal(commandLineFlag('open-browser', ['node', 'server-standalone.js', '--port', '5000']), false);

const help = standaloneHelp();
assert.match(help, /纯控制台服务端/);
assert.match(help, /不会显示 Electron 原生菜单/);
assert.match(help, /--open-browser/);
assert.match(help, /--port/);
assert.match(help, /--trusted-proxies/);
assert.match(help, /服务器运行信息\.txt/);
assert.match(help, /桌面服务器程序/);

const summary = standaloneManagementSummary({
  ownerUrl: 'http://127.0.0.1:5000/#host=secret-test-token',
  dataDir: 'C:\\SyncWatch\\Data',
  settingsFile: 'C:\\SyncWatch\\Data\\server-config.json',
  runtimeInfoFile: 'C:\\SyncWatch\\Data\\服务器运行信息.txt'
});
assert.match(summary, /纯控制台模式/);
assert.match(summary, /http:\/\/127\.0\.0\.1:5000\/#host=secret-test-token/);
assert.match(summary, /server-config\.json/);
assert.match(summary, /浏览器.*F5.*F11.*Ctrl\+0/);
assert.doesNotMatch(summary, /顶部菜单可用/);

assert.deepEqual(systemBrowserCommand('https://watch.example.com', 'win32'), {
  command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'https://watch.example.com/']
});
assert.deepEqual(systemBrowserCommand('https://watch.example.com', 'darwin'), {
  command: 'open', args: ['https://watch.example.com/']
});
assert.deepEqual(systemBrowserCommand('https://watch.example.com', 'linux'), {
  command: 'xdg-open', args: ['https://watch.example.com/']
});
assert.equal(systemBrowserCommand('file:///etc/passwd', 'linux'), null);

assert.match(electronServer, /function buildMenu\(\)/);
for (const label of ['系统', '视图', '帮助', '服务器启动设置']) assert.ok(electronServer.includes(label));
assert.match(electronServer, /click:\s*openServerSettings/);

const helpRun = spawnSync(process.execPath, [path.join(root, 'server-standalone.js'), '--help'], {
  cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true
});
assert.equal(helpRun.status, 0, helpRun.stderr || helpRun.stdout);
assert.match(helpRun.stdout, /纯控制台服务端/);
assert.doesNotMatch(helpRun.stdout, /已启动|访问地址：/);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitFor(check, timeoutMs = 20_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const inspect = () => {
      try { if (check()) return resolve(); }
      catch (error) { return reject(error); }
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('等待独立服务端控制台入口超时'));
      setTimeout(inspect, 50);
    };
    inspect();
  });
}

async function smokeStandaloneConsole() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwatch-standalone-entry-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server-standalone.js'), `--port=${port}`], {
    cwd: root,
    env: { ...process.env, SYNCWATCH_DATA_DIR: dataDir, SYNCWATCH_PUBLIC_URL: '', PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  try {
    await waitFor(() => output.includes('纯控制台模式：') && output.includes(`http://127.0.0.1:${port}/#host=`));
    const response = await fetch(`http://127.0.0.1:${port}/api/public-config`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.ok, true);
    assert.match(output, /此窗口只显示服务日志，不提供 Electron 原生顶部菜单/);
    assert.match(output, /命令帮助：node server-standalone\.js --help/);
    assert.equal(fs.existsSync(path.join(dataDir, '服务器运行信息.txt')), true);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
    if (child.exitCode === null) child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

smokeStandaloneConsole().then(() => {
  console.log('desktop menu and standalone console management entry contracts passed.');
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
