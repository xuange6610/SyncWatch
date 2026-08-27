# SyncWatch同步观影 v2.2.5 发布说明

和朋友、家人、情侣远程一起看电影。v2.2.5 在 v2.2.4 的稳定基线上，重点完善影片批量管理、登录账号身份迁移、退出即时生效、协议拒绝后的登录恢复，以及邮件模板即时预览。

> 第一次使用服务器请用默认账号 `admin`、默认密码 `admin888` 登录，并立即修改默认密码。首次改密豁免只适用于内置 `admin` 刚完成账号密码认证后的初始化流程；被授予超级管理员的普通账号不强制改密。

| 下载文件 | 版本标识 | 最适合谁 | 一句话说明 |
| --- | --- | --- | --- |
| [`SyncWatch-Experience-Client-Portable-v2.2.5-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.5/SyncWatch-Experience-Client-Portable-v2.2.5-x64.exe) | 体验版 | Windows 普通成员 | 连接已有服务器，不在本机启动服务端 |
| [`SyncWatch-Standard-Server-Portable-v2.2.5-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.5/SyncWatch-Standard-Server-Portable-v2.2.5-x64.exe) | 标准版 | Windows 房主 | 便携启动基本服务器，内置运行环境和 cloudflared |
| [`SyncWatch-v2.2.5-Full-Offline-Installer-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.5/SyncWatch-v2.2.5-Full-Offline-Installer-x64.exe) | 完整安装版 | Windows 房主 | 安装向导、完整服务器和跨平台离线下载中心 |
| [`SyncWatch-v2.2.5-Full-Offline-Portable-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.5/SyncWatch-v2.2.5-Full-Offline-Portable-x64.exe) | 完整便携版 | Windows 房主 | 独立 EXE 直接运行，内容与安装版一致 |
| [`SyncWatch-Android-v2.2.5-universal.apk`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.5/SyncWatch-Android-v2.2.5-universal.apk) | Android | 手机成员或房主 | 连接现有服务器，也可运行受支持的手机内嵌服务 |
| macOS 客户端 x64/arm64 的 DMG/ZIP（4 项） | macOS 客户端 | Intel / Apple Silicon 成员 | 按芯片和文件格式选择纯客户端 |
| macOS 服务器 x64/arm64 的 DMG/ZIP（4 项） | macOS 服务器 | Intel / Apple Silicon 房主 | 按芯片选择可开房的服务器包 |
| macOS 完整离线版 x64/arm64 的 DMG/ZIP（4 项） | macOS 完整版 | Intel / Apple Silicon 房主 | 服务器、cloudflared 与跨平台离线下载中心 |
| Node.js 24.19.0 官方环境包（4 项） | 第三方运行时 | 源码或独立服务器用户 | 官方原始分发，桌面 SyncWatch 包无需重复安装 |
| cloudflared 官方工具（5 项） | 第三方公网工具 | 手工 Tunnel 用户 | Cloudflare 官方原始工具，不是 SyncWatch 启动程序 |

## 从 v2.2.4 到 v2.2.5 的更新公告

本节只记录 v2.2.5 源码相对 v2.2.4 的真实变化；v2.2.4 已实现并继续保留的全屏、简洁模式、权限、房间复制迁移、批量队列、地址隐私和更新检查等能力放在“保持不变”中，不重复包装成新增。

### 我的影片：批量重命名与独立预览

- “我的影片 / 上传视频管理系统”新增批量重命名入口，可对选中影片按统一规则生成新名称。
- 规则支持 `{name}`、`{index}`、`{ext}` 占位符，可配置查找替换、起始序号和补零位数；提交前展示逐项预览。
- 前端会拦截空名称、超长名称和本批次重复名称；服务端再次校验房间归属、管理权限、扩展名、目标冲突和文件状态。
- 新增 `PATCH /api/files/rename/batch` 原子接口：任意一项失败时整批拒绝，不留下部分重命名；成功后同步媒体索引、字幕关联、操作记录和房间通知。
- 视频管理系统新增独立预览播放器。预览使用当前会话鉴权地址，不会改变房间正在播放的影片、队列或全员进度。

### 登录账号名称与身份迁移

- 个人资料把“显示名称”和“登录账号”分开：显示名称仍用于备注式展示，普通正式账号可在验证当前密码后修改登录账号。
- 登录账号修改后立即迁移房间所有者、权限、媒体、好友、聊天、操作记录、申请、审计和在线会话身份；新账号可立即登录，旧账号立即失效。
- 内置 `admin` 登录名保持不可修改，游客需先转为正式账号；新名称继续执行服务器账号规则和重复检查。
- 身份迁移写盘或校验失败时返回明确错误并尝试回滚，避免出现房间仍属于旧账号或好友/聊天引用断裂的半迁移状态。

### 退出房间与退出登录即时生效

- `/api/logout` 在响应前同步清理在线用户、房间成员和会话映射，修复用户点击退出后仍需等待数秒才从成员列表消失的问题。
- 回归测试验证退出响应返回后，新设备可立即使用同一账号登录，不再被旧在线会话短暂占用。

### 协议拒绝后的登录恢复

- 用户在《SyncWatch同步观影 使用协议与合规声明》中选择“不同意并退出登录”后，客户端主动撤销服务器会话并断开 Socket，状态显示“未登录”。
- 取消了拒绝协议后错误出现的“已以游客身份进入”和持续“正在自动重连”提示。
- 用户稍后重新点击账号登录或游客登录时，客户端会先重建 Socket 连接，再提交认证，不需要刷新整个页面。

### 邮件模板即时预览

- 邮件设置中的“内置模板”选择器改为选中即应用并刷新主题、HTML 编辑内容和安全预览。
- “应用模板”按钮继续保留，方便键盘操作和明确重复应用；不再要求用户必须额外点击一次才能看到所选模板。
- 浏览器 UI 冒烟测试覆盖模板下拉框的即时预览行为。

### 超级管理员房间额度显示

- 内置超级管理员的“我的房间”额度显示为 `已拥有 n/99999 个房间`，与无限房间权限的产品语义一致，不再误显示 `0/1`。

### Android、Windows、macOS 与 UI

- Android `versionName` 更新为 `2.2.5`，`versionCode` 更新为 `20205`，User-Agent、内嵌 APK 名和发布 APK 名同步更新。
- Windows 体验版、标准版、完整安装版和完整便携版的构建配置与下载闭包统一使用 v2.2.5 文件名；17 个 SyncWatch 应用资产（Windows 4、Android 1、macOS 12）将在最终 Tag 上真实重建并验证。
- macOS 客户端、服务器和完整离线版的 x64/arm64 DMG/ZIP 构建名统一使用 v2.2.5；12 项包仍必须由真实 macOS runner 构建。
- 影片批量重命名面板在桌面与移动视口采用现有深色影院控件、清晰错误状态和可滚动预览；没有引入新前端框架或重做现有主题。

### 文档、Wiki、构建与测试

- README、PRODUCT、DESIGN、Pages 源与生成页面、仓库内 `docs/wiki/` 镜像、GitHub Wiki、发布文件说明、维护规则和版本快照同步到 v2.2.5。
- 新增 v2.2.5 前端、后端和构建闭包测试；原有 v2.2.4 全屏、简洁模式、队列、房间迁移等回归继续执行。
- 发布继续使用唯一 `release/v2.2.5` 分支、annotated Tag 和原子工作流；源码、Windows、Android、macOS、第三方工具与最终远端下载哈希必须来自同一轮证据链。
- 根目录 `dist/` 是唯一最终交付目录。工作流必须先形成恰好 28 个非空文件，再只上传 26 个维护者资产；GitHub 自动提供另外两个源码归档。

## 保持不变的核心能力

- 房间创建/加入、多房间、播放/暂停/拖动/倍速同步、原画/流畅版、片头片尾和播放队列继续保留。
- 公聊、私聊、弹幕、语音、好友、屏幕共享、网页共享、简洁模式和仅聊天继续保留。
- 全屏双击手势消歧、全屏弹幕、边看边聊、F12 全屏和全屏零普通弹窗继续保留。
- 房间复制申请、超级管理员房间迁移覆盖、登录限流解限申请、成员权限组和独立快进权限继续保留。
- 普通客户端不显示服务器 LAN IP，公网分享只使用一个可信公网地址；服务器窗口仍可显示局域网地址。
- Windows、Android、macOS 和浏览器支持范围继续以本 Release 的真实资产和验证记录为准。

## 发布门禁与验证状态

| 项目 | 正式发布要求 |
| --- | --- |
| 源码身份 | `release/v2.2.5` 最终提交、annotated Tag、Git tree、package 与 Android 版本一致 |
| 源码与 UI | 仓库规范、核心集成、v2.2.5 专项、桌面/移动浏览器冒烟和发布契约通过 |
| Windows 4 项 | 最终 Tag 在 Windows runner 重建，完成启动、安装、闭包、版本、大小和 SHA-256 验证 |
| Android 1 项 | 最终 Tag 签名构建，完成 ABI、签名、模拟器安装/启动/登录和包内资源验证 |
| macOS 12 项 | 真实 Intel 与 Apple Silicon runner 构建，验证原生架构、DMG/ZIP、启动和闭包 |
| Node.js / cloudflared 9 项 | 固定官方版本和来源，核对平台/架构、字节大小和 SHA-256 |
| `dist/` 与 Release | 最终目录恰好 28 个文件；Release API 恰好 26 个维护者资产并逐项远端回读哈希 |
| Latest 与下载 | Release 公开、非预发布、`releases/latest` 指向 v2.2.5，26 条下载直链均可访问 |
| 小米 14 / HyperOS 真机 | 未验证；Android 模拟器和移动浏览器视口不能替代该真机证据 |

## 普通用户怎么选

- 只加入别人服务器：Windows 体验版、Android APK、macOS 客户端或浏览器。
- Windows 自己开房：标准服务器便携版；需要全平台离线下载中心时选择完整安装版或完整便携版。
- Mac 自己开房：按 Intel x64 或 Apple Silicon arm64 选择服务器版；需要离线下载中心时选择完整离线版。
- 源码或独立服务器：安装官方 Node.js 22+；正式桌面包已内置运行时，无需重复安装。
- 只从 [GitHub Release v2.2.5](https://github.com/xuange6610/SyncWatch/releases/tag/v2.2.5) 下载；若文件名、大小或哈希与 Release 不一致，应停止安装。

## 跨平台完整套装

完整离线包把同一最终 Tag 构建并验证的 Windows 客户端、Android APK、macOS x64/arm64 客户端与服务器 ZIP 放入房主端下载中心。缺少任一平台真实文件时，完整包构建必须失败，不能嵌入旧版本、空文件或占位文件继续发布。

## 一键运行包含什么

Windows 正式服务器包内置 Electron/Node.js 运行时、应用前后端、生产依赖、Socket.IO、FFmpeg、FFprobe 和 Windows cloudflared。启动时初始化数据目录、检查端口、启动 HTTP/WebSocket 服务，并只在服务器窗口显示局域网地址。

## macOS

v2.2.5 的客户端、服务器和完整离线版分别提供 Intel x64 与 Apple Silicon arm64 的 DMG/ZIP，共 12 项。它们必须由真实 macOS runner 从最终 Tag 构建；Windows 产物、改名旧包或只修改显示版本不能替代。

## 架构支持边界

- Windows 桌面：x64；当前不承诺未经完整验证的 32 位桌面组合。
- Android 通用 APK：`armeabi-v7a`、`arm64-v8a`、`x86_64`，以 APK 解包和签名检查为准。
- macOS：Intel x64 与 Apple Silicon arm64；现代 Electron/macOS 不提供 32 位桌面包。
- 独立服务器：以 Node.js 22+ 对目标系统和架构的官方支持为准。
- Android 本机不内嵌桌面版 cloudflared；手机跨网访问应连接已开启 HTTPS/Tunnel 的服务器。

## cloudflared 独立工具

Release 提供 Windows x64 EXE、Windows x64/x86 MSI、macOS x64/arm64 二进制共 5 项。它们来自 Cloudflare 官方分发，用于手工 Tunnel 与诊断，不是 SyncWatch 启动程序；发布工作流核对固定来源、平台、架构、大小和 SHA-256。

## Node.js 官方环境包

Release 提供 Windows x64/ARM64 MSI、macOS x64 PKG 和 macOS arm64 tar.gz 共 4 项，供源码和独立服务器使用。它们是 Node.js 官方分发，不由 SyncWatch 源码生成；正式桌面包已内置运行时。

## 首次启动、升级与安全

1. 首次启动使用 `admin` / `admin888` 登录并立即修改默认密码；公网部署前先完成局域网测试。
2. 升级前停止旧服务器并备份整个 `SyncWatch同步观影-Data/`，不要只复制 `config.json`。
3. 批量重命名前先检查预览；房间迁移、批量删除和账号登录名修改前保留完整数据备份。
4. 不公开数据目录、SMTP 授权码、Tunnel 令牌、签名文件、聊天记录、真实 IP 或带权限的房间链接。
5. 下载后按 Release 记录核对文件名、平台/架构、字节大小和 SHA-256。

## 已知限制

1. 当前没有小米 14 / HyperOS 真机安装、后台保活、全屏手势和屏幕共享证据；工作流模拟器不能冒充特定真机通过。
2. Android 客户端仍使用原生 Android 外壳、WebView 与嵌入式 Node.js 服务组合；网页共享目标站的跨域、Cookie、CSP 和禁止嵌入策略不由 SyncWatch 绕过。
3. 登录账号迁移会更新服务器内现有引用；外部脚本、第三方反向代理规则或用户自行保存的旧用户名需要管理员同步修改。
4. macOS 签名、公证和 Gatekeeper 状态以最终 Actions 证据为准；没有签名证书时系统可能要求用户确认打开。
5. Cloudflare Quick Tunnel、家庭上行和 VPN/TUN/Fake-IP 网络没有固定 SLA；默认原画带宽较高，弱网用户可手动选择流畅版。
