# cloudflared 与 Node.js 安装使用教程

这两个工具用途不同。普通用户安装 `SyncWatch-v2.2.6-Full-Offline-Installer-x64.exe` 或运行 `SyncWatch-Standard-Server-Portable-v2.2.6-x64.exe` 时，不需要另外安装 Node.js，也不需要另外下载 cloudflared；服务器包已经包含所需运行时。只有手工诊断、公网部署、源码开发或独立服务器才需要本教程。

当前最新正式 Release 是 v2.2.6，已设为 Latest。随正式版本提供的 Node.js 4 项和 cloudflared 5 项已核对官方来源、版本、平台/架构、非空大小与 SHA-256；它们是第三方官方原始分发文件，不由 SyncWatch 源码构建，也不能描述成 SyncWatch 启动程序。

![服务器设置中的公网访问和网络诊断](screenshots/public-access-settings.png)

## 一眼分清用途

- **cloudflared：** Cloudflare Tunnel 连接器，把本机 `http://127.0.0.1:5000` 转发成 HTTPS 地址。手工开启临时公网地址、配置固定 Tunnel 或进行网络诊断时使用。参考 [Cloudflare Tunnel 文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 和 [官方下载](https://github.com/cloudflare/cloudflared/releases/latest)。
- **Node.js：** SyncWatch 服务端 JavaScript 运行环境，同时提供 `npm`。从源码启动、运行独立服务器 ZIP 或参与开发时使用。参考 [Node.js 官网](https://nodejs.org/)、[官方下载](https://nodejs.org/en/download) 和 [API 文档](https://nodejs.org/docs/latest/api/)。

## Windows 安装 cloudflared

Release 同时提供 MSI 安装包和独立命令行 EXE。普通新手优先下载 [`cloudflared-windows-x64-installer.msi`](https://github.com/xuange6610/SyncWatch/releases)；32 位 Windows 下载 [`cloudflared-windows-x86-installer.msi`](https://github.com/xuange6610/SyncWatch/releases)。`cloudflared-windows-x64.exe` 是命令行工具，不是安装程序，直接双击只会打开黑色终端且不会出现安装向导。正式 SyncWatch 服务器 EXE 已内置同一组件，无需重复安装。

1. 下载与 Windows 架构匹配的 MSI，双击后按系统向导完成安装。
2. 重新打开 PowerShell 或 Windows Terminal。
3. 运行版本检查：

```powershell
cloudflared --version
```

4. 先启动 SyncWatch 服务器，确认浏览器可以打开 `http://127.0.0.1:5000`。
5. 手工创建临时地址：

```powershell
cloudflared tunnel --url http://127.0.0.1:5000 --protocol auto
```

6. 等待终端显示 `https://随机名称.trycloudflare.com`，用另一网络的手机测试登录和媒体播放。
7. 按 `Ctrl+C` 停止 Tunnel。终端关闭后临时地址会失效，下次地址可能不同。

需要绿色免安装方式时，才下载 `cloudflared-windows-x64.exe`，放入单独文件夹并在该文件夹打开终端，以 `.\cloudflared-windows-x64.exe --version` 方式运行，不要直接双击。

## macOS 安装 cloudflared

最简单的官方安装方式是 Homebrew：

```bash
brew install cloudflared
cloudflared --version
cloudflared tunnel --url http://127.0.0.1:5000 --protocol auto
```

使用 Release 中的独立文件时，Intel Mac 下载 `cloudflared-macos-x64`，Apple Silicon 下载 `cloudflared-macos-arm64`：

```bash
chmod +x ./cloudflared-macos-arm64
./cloudflared-macos-arm64 --version
./cloudflared-macos-arm64 tunnel --url http://127.0.0.1:5000 --protocol auto
```

## Cloudflare 临时地址超时怎么处理

新版默认使用 `--protocol auto`：cloudflared 会优先协商 QUIC，失败或被拦截时自动回退 HTTP/2。桌面端还会按预检尝试物理 IPv4/DoH Edge 直连，必要时切换到继承系统代理的自动协议；每个候选连接器都要通过固定小响应 `/api/tunnel-health` 验证后才发布地址。应用配置仍可用 `/api/public-config` 检查。只有排查 QUIC/UDP 被拦截时，才临时使用 `--protocol http2` 做对照测试。

仍然失败时按顺序检查：

1. 先确认本机地址 `http://127.0.0.1:5000` 可以打开。
2. 在“服务器设置 → 公网访问”开启“自动网络诊断”。
3. 点击“网络诊断与修复”，查看每次策略、DNS、443/7844 端口和 cloudflared 日志尾部。
4. Windows 防火墙允许 cloudflared 出站访问 TCP 443、TCP 7844 和 UDP 7844。
5. Clash、VPN、TUN、WARP 或杀毒软件中，将 `cloudflared.exe`、`trycloudflare.com` 和 `argotunnel.com` 设置为直连；如果直连不可用，则取消“绕过系统代理”，让最终连接继承系统代理。
6. 临时关闭 VPN/TUN 后重试，以区分软件问题和网络路由问题。
7. 长期使用应在 Cloudflare 控制台建立固定 Tunnel 和自有域名；Quick Tunnel 没有可用性保证。

## Windows 安装 Node.js

1. 普通 Intel/AMD 电脑下载 `node-v24.19.0-x64.msi`；Windows on ARM 下载 `node-v24.19.0-arm64.msi`。
2. 双击 MSI，保持“Add to PATH”和 npm 选项启用，按向导完成安装。
3. 关闭旧终端并重新打开 PowerShell。
4. 验证：

```powershell
node --version
npm --version
```

5. 从源码运行 SyncWatch：

```powershell
git clone https://github.com/xuange6610/SyncWatch.git
Set-Location SyncWatch
npm ci
npm start
```

只运行独立服务端：

```powershell
npm run start:server
```

## macOS 安装 Node.js

Intel Mac 可运行 Release 中的 `node-v24.19.0-macos-x64.pkg` 安装向导。Apple Silicon 建议从 [Node.js 官网](https://nodejs.org/en/download) 选择 macOS arm64 安装包，或使用 Homebrew：

```bash
brew install node@24
node --version
npm --version
```

Release 中的 `node-v24.19.0-darwin-arm64.tar.gz` 是便携运行时，不是图形安装器；新手优先使用官网安装包或 Homebrew。

## 安全与卸载

- 只从本仓库 Release、Cloudflare 官方 Release 和 Node.js 官网下载，下载后核对 GitHub 显示的 SHA-256。
- 不要把 Cloudflare Tunnel Token、管理员密码或 `.secrets/` 上传到 Issue。
- cloudflared 独立文件没有安装服务时，停止进程后删除文件即可；如果使用 Homebrew，运行 `brew uninstall cloudflared`。
- Windows Node.js 可在“设置 → 应用 → 已安装的应用”中卸载；卸载 Node.js 不会删除 SyncWatch 数据目录。
