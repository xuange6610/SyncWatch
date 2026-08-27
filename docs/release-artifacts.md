# 发布文件与下载说明

GitHub Release 是给普通用户下载成品的地方；仓库首页的 `Source code (zip)` 只是源码快照，不是完整安装包。每一个上传文件都必须有版本号、平台、角色和架构说明。

当前最新正式版本是 v2.2.4。Release API 已验证有 26 个维护者资产，连同 GitHub 自动生成的两个源码归档共 28 个可见文件；文件名仍不能替代对版本、平台/架构、大小、SHA-256、包闭包和启动结果的逐项核验。

## 文件分类

| 文件类型 | 文件名模式 | 谁下载 | 能做什么 | 注意事项 |
| --- | --- | --- | --- | --- |
| Windows 体验版 | `SyncWatch-Experience-Client-Portable-v版本-x64.exe` | 普通成员 | 输入已有服务器地址加入房间，不在本机运行服务器 | 体积较小但不包含服务端；需要房主先启动服务 |
| Windows 标准版 | `SyncWatch-Standard-Server-Portable-v版本-x64.exe` | 房主、服务器管理员 | 绿色便携运行，启动服务器、管理房间、上传媒体和配置公网访问 | 内置 Electron/Node、FFmpeg/FFprobe 和 cloudflared |
| Windows 安装完整版 | `SyncWatch-v版本-Full-Offline-Installer-x64.exe` | 希望正常安装并给各平台成员分发客户端的房主 | 安装目录、快捷方式、卸载入口、完整 Windows 服务端和内嵌的 Windows/Android/macOS 下载文件 | 不需要另装 Node.js/cloudflared；文件超过 1 GB；首次登录立即修改 `admin888` |
| Windows 独立 EXE 完整版 | `SyncWatch-v版本-Full-Offline-Portable-x64.exe` | 不想安装但需要完整离线下载中心的房主 | 直接双击运行完整 Windows 服务端，内嵌内容与安装完整版一致 | 文件超过 1 GB；运行目录必须有写入权限 |
| Android APK | `SyncWatch-Android-v版本-universal.apk` | Android 用户 | 加入房间；支持的设备可以启动手机服务器 | 包含 `arm64-v8a`、`armeabi-v7a` 和 `x86_64` ABI |
| 独立服务器 ZIP | `SyncWatch同步观影-Server-v版本.zip` | Windows/Linux/Docker 管理员 | 使用 Node.js、启动脚本或 Docker 长期部署 | 包含生产依赖、FFmpeg/FFprobe、cloudflared、客户端和 APK |
| macOS 服务器 DMG/ZIP | `SyncWatch-Server-macOS-v版本-x64/arm64.*` | Mac 房主 | Intel 或 Apple Silicon 上运行服务器 | 必须由 macOS 主机或 macOS CI 生成，不能用 Windows 文件冒充 |
| macOS 客户端 DMG/ZIP | `SyncWatch-Client-macOS-v版本-x64/arm64.*` | Mac 成员 | Intel 或 Apple Silicon 上加入房间 | 需要系统允许网络、麦克风或屏幕共享权限时按提示授权 |
| macOS 完整版 DMG/ZIP | `SyncWatch-Full-Offline-macOS-v版本-x64/arm64.*` | Mac 房主 | 当前架构的完整服务端、cloudflared 和全平台离线下载中心 | Intel 选 x64，Apple Silicon 选 arm64；每个文件超过 1 GB |
| cloudflared 安装包 | `cloudflared-windows-x64-installer.msi` / `cloudflared-windows-x86-installer.msi` | 需要手工配置 Tunnel 的 Windows 管理员 | MSI 提供安装入口；安装后可在终端调用 `cloudflared` | 只从 [Cloudflare 官网](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 或 [官方 Release 下载](https://github.com/cloudflare/cloudflared/releases/latest) 并校验 SHA-256；命令行 EXE 双击不会显示安装向导 |
| Node.js 环境包 | `node-v24.19.0-x64.msi` / `arm64.msi` / macOS 包 | 源码开发、独立服务器管理员 | 提供 `node` 与 `npm`，用于源码安装依赖和启动独立服务器 | 从 [Node.js 官网](https://nodejs.org/) 或 [官方下载](https://nodejs.org/en/download) 获取对应平台包；正式 Windows EXE 已内置 Node.js |

## 选择流程

1. 你是房主：Windows 下载服务器 EXE；Mac 下载 macOS 服务器包；Linux 优先下载独立服务器 ZIP 或使用 Docker。
2. 你是成员：下载对应平台的客户端；也可以直接用浏览器打开房主发来的地址。
3. 你只想试用：先看 GitHub Pages 展示站；它展示真实界面，但不能替代服务器。
4. 你要开发：下载源码，安装 Node.js 22+，执行 `npm ci` 和 `npm start`。
5. 看到不存在的平台资产：不要下载相似名称的第三方文件；按 `docs/macos-build.md` 或构建脚本自行生成。

## 下载后校验

在 Release 页面打开对应文件旁的 SHA-256 校验值，PowerShell 使用：

```powershell
Get-FileHash .\SyncWatch-v2.2.4-Full-Offline-Installer-x64.exe -Algorithm SHA256
```

Linux/macOS 使用：

```bash
shasum -a 256 SyncWatch-Android-v2.2.4-universal.apk
```

如果哈希不同、文件大小为 0，或者文件名中的版本与 Release 不一致，请删除文件并重新下载。

## 完整版为什么很大

Windows、macOS、Android 的运行时、签名方式、CPU 架构和系统权限不同，不能互相运行。离线完整版不会把它们伪装成 Windows 功能，而是把真实构建的 Windows 客户端、Android APK、macOS x64/arm64 客户端与服务器 ZIP 作为本机下载资源保存。房主安装并启动后，成员通过登录页或账号菜单下载适合自己的文件，因此即使现场没有 GitHub 网络也能完成分发。标准版和体验版仍保持较小体积。

cloudflared 与 Node.js 的区别、官方地址、安装步骤和命令示例见 [cloudflared 与 Node.js 安装使用教程](runtime-installation.md)。

## Release 备注应包含的内容

每次发布说明至少写明：版本号、构建提交、支持的平台和架构、服务器/客户端区别、默认登录后的安全动作、是否包含 cloudflared、已验证的测试、已知未提供的成品，以及数据备份和授权内容边界。

17 个 SyncWatch 应用资产（Windows 4、Android 1、macOS 12）必须全部由最终 Tag 对应源码重新构建，逐项验证应用版本、平台/架构、非空大小、SHA-256、包内源码/资源闭包和实际启动/核心流程；不得复用、复制或改名上一版本成品。Node.js 4 项和 cloudflared 5 项是上游官方原始分发文件，必须另行核对官方来源、版本、平台/架构、大小和 SHA-256。只有根目录 `dist/` 恰好 28 个最终文件且全部门禁通过后，才允许一次性完整上传 26 个维护者资产。

v2.2.4 发布说明已逐项记录项目主页/Wiki/关于入口、注册申请数量撤回与删除、密码状态与安全重置、网页 URL 权威同步及跨域边界、Node 控制台等价管理入口，以及本轮全屏、简洁模式、地址隐私、迁移、队列和权限变化；没有当前构建或运行证据的内容仍须标记为未验证。
