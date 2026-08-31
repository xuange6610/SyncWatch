# SyncWatch同步观影 v2.3.0 发布说明

本次候选 Release 的 SyncWatch 应用资产与维护者资产必须从最终 Tag 真实重建，并逐项完成版本、平台、大小、SHA-256 与启动验收；当前仍待线上发布核验。

和朋友、家人、情侣远程一起看电影。v2.3.0 是在 v2.2.9 稳定版基础上的候选版本，按相同的 Windows、Android 和第三方工具资产契约准备发布。

> 第一次使用服务器请用默认账号 `admin`、默认密码 `admin888` 登录，并立即修改默认密码。

| 下载文件 | 运行角色 | 版本标识 | 最适合谁 | 一句话说明 |
| --- | --- | --- | --- | --- |
| [`SyncWatch-Experience-Client-Portable-v2.3.0-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.3.0/SyncWatch-Experience-Client-Portable-v2.3.0-x64.exe) | 客户端 | Windows 体验版 | 普通成员 | 填服务器地址，加入已有房间 |
| [`SyncWatch-v2.3.0-Full-Offline-Portable-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.3.0/SyncWatch-v2.3.0-Full-Offline-Portable-x64.exe) | 服务器 | Windows 完整便携版 | 房主 | 解压后双击，直接开房 |
| [`SyncWatch-Android-v2.3.0-universal.apk`](https://github.com/xuange6610/SyncWatch/releases/download/v2.3.0/SyncWatch-Android-v2.3.0-universal.apk) | 客户端 | Android | 手机用户 | 连接房间，也可在支持的设备上运行手机服务器 |
| [`node-v24.19.0-x64.msi`](https://github.com/xuange6610/SyncWatch/releases/download/v2.3.0/node-v24.19.0-x64.msi) / [`node-v24.19.0-arm64.msi`](https://github.com/xuange6610/SyncWatch/releases/download/v2.3.0/node-v24.19.0-arm64.msi) | 服务器环境 | Node.js 24.19.0 | 源码或独立服务器用户 | 官方 Node.js 安装包，桌面完整包不用另装 |
| [`cloudflared-windows-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.3.0/cloudflared-windows-x64.exe) / [`x64 MSI`](https://github.com/xuange6610/SyncWatch/releases/download/v2.3.0/cloudflared-windows-x64-installer.msi) / [`x86 MSI`](https://github.com/xuange6610/SyncWatch/releases/download/v2.3.0/cloudflared-windows-x86-installer.msi) | 服务器工具 | Cloudflare Tunnel | 需要公网访问的用户 | 官方公网连接工具，不是 SyncWatch 启动程序 |

## 从 v2.2.9 到 v2.3.0 的更新

- 统一升级 Node/Electron、Android `versionName`/`versionCode`、前端公开版本、下载文件名和构建配置到 `v2.3.0` / `20300`。
- 继续保持 Windows、Android 和浏览器支持；macOS 新包仍停用，历史 Release、标签和资产保持不变。
- README、Pages 源文档、仓库 Wiki 镜像、运行环境教程和下载说明已切换到 v2.3.0 当前入口；v2.2.9 公告作为历史记录保留。
- 本版本沿用 v2.2.9 已验证的网页同步观影、移动端滚动、菜单折叠、房间搜索、密码状态、启动进度和快捷键功能，没有把未发生的行为包装成新增功能。
- 发布流程继续要求应用包从最终 Tag 对应源码重新构建，第三方 Node.js/cloudflared 文件从已核验官方缓存复用，并逐项核对平台、架构、大小、SHA-256、启动和闭包。

## 保持不变

房间创建与加入、同步播放、字幕、聊天、弹幕、语音、网页/屏幕共享、账号权限、备份恢复、临时公网链接和 Node.js 独立服务器功能继续保留。默认端口仍为 `20311`。

## 普通用户怎么选

- 只加入朋友房间：下载 Windows 体验版、Android APK，或直接使用浏览器。
- 自己在 Windows 上开房：下载完整离线便携版，解压后双击即可运行。
- 需要公网入口：在 Windows 上使用内置或独立的 cloudflared；手机端连接已开启 HTTPS/Tunnel 的服务器。

## Windows + Android 套装

房主使用 Windows 完整离线便携版，成员使用 Windows 体验版或 Android APK。完整包内置经过验证的 Android APK 和运行环境，普通用户无需另装 Node.js 或 cloudflared。

## 一键运行包含什么

完整离线便携版包含 SyncWatch 服务端、Windows 客户端、Android APK 离线资源、Node.js Mobile 运行时和 cloudflared；Release 中的 Source code 归档仍仅用于阅读和自行构建。

## 架构支持边界

v2.3.0 新构建支持 Windows x64、Windows on ARM 的官方 Node.js 环境、Android 通用 APK 和浏览器；macOS 仅保留历史 Release，不再提供新包。小米 14/HyperOS 真机未在本轮验证。

## cloudflared 独立工具

Release 中的 Windows x64 EXE、x64 MSI 和 x86 MSI 均为 Cloudflare 官方原始分发文件，用于公网 Tunnel，不是 SyncWatch 启动程序。请按 [公网访问教程](wiki/04-公网访问与Cloudflare-Tunnel.md) 配置并核对官方 SHA-256。

## Node.js 官方环境包

Release 中的 `node-v24.19.0-x64.msi` 和 `node-v24.19.0-arm64.msi` 仅用于源码或独立 Node.js 服务端。Windows 完整离线包已经内置运行环境，普通用户无需重复安装。

## 测试与限制

公开发布前必须完成仓库规范、核心集成、完整验收、隐私、Android Node 兼容、发布工作流、应用成品和官方资产核验。未完成真实构建或任一资产证据缺失时，v2.3.0 必须保持 `pending`，不得使用旧包改名、占位文件或不完整资产集合。

版权所有 © 2026 xuan · Apache-2.0
