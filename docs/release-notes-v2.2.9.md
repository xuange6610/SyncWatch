# SyncWatch同步观影 v2.2.9 发布说明

和朋友、家人、情侣远程一起看电影。v2.2.9 已完成最终构建、启动验收、哈希核对并公开为 Latest。

> 第一次使用服务器请用默认账号 `admin`、默认密码 `admin888` 登录，并立即修改默认密码。

| 下载文件 | 运行角色 | 版本标识 | 最适合谁 | 一句话说明 |
| --- | --- | --- | --- | --- |
| `SyncWatch-Experience-Client-Portable-v2.2.9-x64.exe` | 客户端 | Windows 体验版 | 普通成员 | 填服务器地址，加入已有房间 |
| `SyncWatch-v2.2.9-Full-Offline-Portable-x64.exe` | 服务器 | Windows 完整便携版 | 房主 | 解压后双击，直接开房 |
| `SyncWatch-Android-v2.2.9-universal.apk` | 客户端 | Android | 手机用户 | 连接房间，也可在支持的设备上运行手机服务器 |
| `node-v24.19.0-x64.msi` / `node-v24.19.0-arm64.msi` | 服务器环境 | Node.js 24.19.0 | 源码或独立服务器用户 | 官方 Node.js 安装包，桌面完整包不用另装 |
| `cloudflared-windows-x64.exe` / 两个 Windows MSI | 服务器工具 | Cloudflare Tunnel | 需要公网访问的用户 | 官方公网连接工具，不是 SyncWatch 启动程序 |

## 从 v2.2.8 到 v2.2.9 的更新

- 版本号、Android `versionName`/`versionCode`、下载文件名和页面文案统一到 v2.2.9。
- 当前新版本只构建和上传 Windows、Android 以及 Windows 上使用的 Node.js/cloudflared 工具；不再构建或上传 macOS 新包，历史 Release 保持不变。
- Release 清单收敛为 8 个维护者资产，加 GitHub 自动生成的 2 个源码归档，共 10 个可见文件；不再提供标准版和完整安装版入口。
- Pages 首屏下载按钮改为直接下载 Windows 完整便携版；下载列表明确标注“客户端、服务器、服务器工具、服务器环境”。
- README、Pages、Wiki 镜像和发布清单改用更容易理解的中文，并明确 GitHub Pages 只是展示页，实际服务需下载并运行程序。
- Windows 构建脚本只生成体验客户端和完整便携版，所有正式文件输出到根目录 `dist/`；Android 构建继续使用签名 APK。
- 房间详情与公网访问按钮统一使用“分享房间号 / 分享内网地址 / 分享公网地址 / 分享地址”，同一份前端资源会进入浏览器、Windows 客户端和 Android WebView。
- 全屏补齐 `L` 锁定/解锁快捷键；`F2` 与回车都能打开“边看边聊”并把焦点放到输入框，输入期间不会劫持按键。
- 顶部“选项 / 房间操作 / 设置”菜单关闭时会真正隐藏内部按钮，修复手机宽度下按钮在屏幕外参与布局、挤压右侧账户区的问题。
- 桌面顶栏菜单改为悬停临时展开、点击固定，离开未固定菜单后自动收起；手机端改为完整单列手风琴列表，展开项不再错位或被拆成多列。
- 右侧“在线成员”整个面板的折叠按钮移入可见标题区并保持高亮；局域网服务详情复制增加 Electron 原生剪贴板回退。
- 登录页关键输入框增加高亮提醒，房间密码状态会随房间查询实时显示；空房间密码与错误房间密码现在使用不同提示。
- Windows Full Offline 便携版在上传前新增 Microsoft Defender 实文件扫描门禁；扫描服务不可用、文件被隔离或产生检测记录时发布立即停止。该门禁用于验证本次成品，不冒充所有第三方杀毒厂商的永久零误报承诺。
- 修复高 DPI、大字号和高级主题下顶部房间状态栏偶发只显示颜色条的问题；房间名、在线人数和同步状态改为可收缩五列布局，超长文字在列内省略。
- Electron 先显示主题启动页再加载服务端重模块，慢机器首次启动能立即看到反馈；“运行信息”改为与银幕主题一致的深色金色窗口，并可直接复制或打开局域网地址与数据目录。

## 保持不变

房间创建与加入、同步播放、字幕、聊天、弹幕、语音、网页/屏幕共享、账号权限、备份恢复、临时公网链接和 Node.js 独立服务器功能继续保留。默认端口仍为 `20311`。

## 普通用户怎么选

- 只加入朋友房间：下载 Windows 体验版、Android APK，或直接使用浏览器。
- 自己在 Windows 上开房：下载完整离线便携版，解压后双击即可运行。
- 需要公网入口：在 Windows 上使用内置或独立的 cloudflared；手机端连接已开启 HTTPS/Tunnel 的服务器。

## Windows + Android 套装

房主使用 Windows 完整离线便携版，成员使用 Windows 体验版或 Android APK。完整包内置经过验证的 Android APK 和运行环境，普通用户无需另装 Node.js 或 cloudflared。

## 一键运行包含什么

完整离线便携版包含 SyncWatch 服务端、Windows 客户端、Android APK 离线资源、Node.js Mobile 运行时和 cloudflared；它是可启动的应用包，Release 中的 Source code 归档仍仅用于阅读和自行构建。

## 架构支持边界

v2.2.9 新构建支持 Windows x64、Windows on ARM 的官方 Node.js 环境、Android 通用 APK 和浏览器；macOS 仅保留历史 Release，不再提供新包。小米 14/HyperOS 真机未在本轮验证。

## cloudflared 独立工具

Release 中的 Windows x64 EXE、x64 MSI 和 x86 MSI 均为 Cloudflare 官方原始分发文件，用于公网 Tunnel，不是 SyncWatch 启动程序。请按 [公网访问教程](wiki/04-公网访问与Cloudflare-Tunnel.md) 配置并核对官方 SHA-256。

## Node.js 官方环境包

Release 中的 `node-v24.19.0-x64.msi` 和 `node-v24.19.0-arm64.msi` 仅用于源码或独立 Node.js 服务端。Windows 完整离线包已经内置运行环境，普通用户无需重复安装。

## 测试与限制

发布前已运行仓库规范、核心集成、平台契约、完整离线包和隐私检查；最终 Tag 对应的 Actions 已完成 Windows/Android 构建、启动流程、文件大小与 SHA-256 核验，并完成 8 个维护者资产加 2 个源码归档的 10 文件审计。

所有 SyncWatch 应用资产必须由最终 Tag 对应源码真实重建，不能用旧包改名或占位文件替代。

版权所有 © 2026 xuan · Apache-2.0
