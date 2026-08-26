# cloudflared 与 Node.js 安装使用

普通用户安装 `SyncWatch-v2.2.0-Full-Offline-Installer-x64.exe` 或运行 `SyncWatch-Standard-Server-Portable` 时无需另装环境。cloudflared 负责临时/固定公网入口，Node.js 只用于源码和独立服务器。Release 另提供 Cloudflare 官方 Windows MSI：x64 用户下载 `cloudflared-windows-x64-installer.msi`，32 位 Windows 下载 `cloudflared-windows-x86-installer.msi`；双击 MSI 才会启动安装向导，命令行 EXE 直接双击只会打开黑色终端，这是正常行为。

最新正式下载仍为 v2.2.0。v2.2.3 的 Node.js 4 项和 cloudflared 5 项尚待核对官方来源、平台/架构、字节数和 SHA-256；这些文件不是 SyncWatch 源码生成的启动程序，候选公告列出名称不等于已经上传。

![公网访问设置与网络诊断](https://raw.githubusercontent.com/xuange6610/SyncWatch/main/docs/screenshots/public-access-settings.png)

## 官方地址

- Cloudflare Tunnel 文档：<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>
- cloudflared 官方下载：<https://github.com/cloudflare/cloudflared/releases/latest>
- Node.js 官网与下载：<https://nodejs.org/> · <https://nodejs.org/en/download>
- 本仓库 Release：<https://github.com/xuange6610/SyncWatch/releases/latest>

## cloudflared 快速使用

Windows 下载 `cloudflared-windows-x64.exe` 后重命名为 `cloudflared.exe`：

```powershell
.\cloudflared.exe --version
.\cloudflared.exe tunnel --url http://127.0.0.1:5000 --protocol http2
```

macOS 使用 Homebrew：

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:5000 --protocol http2
```

出现 `https://随机名称.trycloudflare.com` 后，把地址发给可信成员；按 `Ctrl+C` 停止。临时地址重启后会变化，没有长期可用性保证。

## 临时地址接口超时

新版会自动尝试直连和系统网络回退。依次确认本机 `127.0.0.1:5000` 可访问、Windows 防火墙允许 TCP 443/TCP 7844/UDP 7844，并在 VPN/TUN 中将 cloudflared 与 Cloudflare 域名设为直连。必须经过代理的网络可以取消“绕过系统代理”，再执行“网络诊断与修复”。

## Node.js 安装

Windows x64 使用 `node-v24.19.0-x64.msi`，Windows ARM 使用 `node-v24.19.0-arm64.msi`。安装后重新打开终端并验证：

```powershell
node --version
npm --version
git clone https://github.com/xuange6610/SyncWatch.git
Set-Location SyncWatch
npm ci
npm start
```

Intel Mac 可使用 `node-v24.19.0-macos-x64.pkg`；Apple Silicon 新手应从 Node.js 官网下载 arm64 安装包或运行 `brew install node@24`。Release 中的 arm64 TAR.GZ 是便携运行时，不是图形安装器。

更完整的逐步说明、卸载方式和安全注意事项见[仓库教程](https://github.com/xuange6610/SyncWatch/blob/main/docs/runtime-installation.md)。

\n
