# SyncWatch同步观影 v2.2.0

和朋友、家人、情侣远程一起看电影。v2.2.0 聚焦登录安全、移动端可用性、媒体处理、公网访问可观测性和多端同步可靠性，并提供 Windows、Android、macOS 与浏览器客户端。

正式下载页：[GitHub Release v2.2.0](https://github.com/xuange6610/SyncWatch/releases/tag/v2.2.0)。

> 第一次使用服务器请用默认账号 `admin`、默认密码 `admin888` 登录，并立即修改默认密码。登录页的“一键填入”只减少首次输入，不会跳过认证或改密要求。

| 下载文件 | 版本标识 | 最适合谁 | 一句话说明 |
| --- | --- | --- | --- |
| [`SyncWatch-Experience-Client-Portable-v2.2.0-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Experience-Client-Portable-v2.2.0-x64.exe) | 体验版 | Windows 普通成员 | 连接已有服务器，不在本机启动服务端 |
| [`SyncWatch-Standard-Server-Portable-v2.2.0-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Standard-Server-Portable-v2.2.0-x64.exe) | 标准版 | Windows 房主 | 内置运行环境与 cloudflared，双击运行 |
| [`SyncWatch-v2.2.0-Full-Offline-Installer-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-v2.2.0-Full-Offline-Installer-x64.exe) | 完整版 | Windows 房主 | 安装向导与跨平台离线下载中心 |
| [`SyncWatch-v2.2.0-Full-Offline-Portable-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-v2.2.0-Full-Offline-Portable-x64.exe) | 完整版 | Windows 房主 | 无需安装的独立完整 EXE |
| [`SyncWatch-Android-v2.2.0-universal.apk`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Android-v2.2.0-universal.apk) | Android | 手机成员或房主 | 加入已有房间；受支持设备可运行局域网服务器 |
| [macOS Intel 完整版 DMG](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Full-Offline-macOS-v2.2.0-x64.dmg) / [ZIP](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Full-Offline-macOS-v2.2.0-x64.zip) | 完整版 | Intel Mac 房主 | x64 服务器与跨平台离线下载中心 |
| [macOS Apple 芯片完整版 DMG](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Full-Offline-macOS-v2.2.0-arm64.dmg) / [ZIP](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Full-Offline-macOS-v2.2.0-arm64.zip) | 完整版 | Apple Silicon 房主 | arm64 服务器与跨平台离线下载中心 |
| [cloudflared Windows x64 MSI](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/cloudflared-windows-x64-installer.msi) / [x86 MSI](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/cloudflared-windows-x86-installer.msi) | 公网工具 | 手工部署 Tunnel 的 Windows 用户 | 安装后运行 `cloudflared --version` |
| [Node.js Windows x64 MSI](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/node-v24.19.0-x64.msi) / [ARM64 MSI](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/node-v24.19.0-arm64.msi) | 开发环境 | 源码或独立服务器用户 | 正式 SyncWatch 桌面包已内置运行时，无需另装 |

## v2.2.0 更新公告

这是从 v2.1.9 到 v2.2.0 的功能与可靠性更新。房间、同步播放、聊天、弹幕、语音、屏幕共享、权限、备份和数据目录继续兼容既有部署；下面只列出本版本真实发生的变化。

### 登录、账户与权限

- 账号密码已填写但房间号留空时，会列出该账号可进入的房间，并允许选择已有房间或临时房间；提示可设置暂不提醒时长，也可在设置中关闭或重新开启。
- 本机服务器登录页新增“本机免密进入管理中心”和“本机免密以 admin 进入所选房间”。两条入口都只接受直接 loopback、正确同源和服务器主机令牌，不把前端显示开关当作授权，也不会让公网访客绕过管理员密码；服务器设置可分别关闭它们。
- 管理专用会话新增“退出管理登录”，会同时撤销服务端令牌、Cookie 与 Socket 会话，不再出现免密进入后无法退出。
- 内置 `admin` 可设置最多同时登录会话数；超过上限时优先保留新会话与当前设置操作者，并撤销最久未活动会话。旧的“不限设备”配置会兼容迁移。
- 游客权限收紧为普通成员基线：不能创建正式房间、申请建房额度或绕过房间游客策略；游客仍可在当前房间原地注册并迁移资料。
- 默认管理员提示旁新增一键填入按钮；重置超级管理员密码入口移动到管理页面更靠上的安全区域。

### 房间、管理与通知

- 超级管理员可在“扫描房间”结果中多选并删除房间，服务端重新校验权限和目标房间。
- 服务器操作日志新增账户名/显示名模糊搜索，并可与类别、级别、关键字组合筛选；结果同时显示显示名和登录账号。
- Windows 服务器会把申请、控制请求、权限变化、主题和重要账户事件同时发送为系统通知；点击通知可恢复并聚焦主窗口。
- 关闭程序选择窗新增“打开新的服务器”，用独立数据目录和主机令牌启动新实例，当前服务器继续运行。
- “通知/通告设置”新增位置状态通知和位置授权请求两个服务器级开关；关闭后服务端不再广播位置状态，也不会自动提示或允许管理员发起位置授权请求。
- 账户权限等级和权限组的“新建 / 查看 / 编辑”改为独立主题窗口，支持保存、取消、右上角关闭和 Escape；扫描房间列表改为紧凑的选择、房间信息与加入按钮布局。

### 服务器网卡与公网访问

- Windows 服务器默认监听全部本机网卡的 `20311` 端口；“系统 → 服务器启动设置”可选择首选局域网 IPv4，用于分享地址。网卡断开或 DHCP 地址失效时会安全回退自动选择，不破坏本机回环访问。
- 启动设置补充公网根地址、反向代理、额外允许域名、端口优先级和防火墙教程；保存后自动重启生效。
- 配置的公网根地址会在没有活动 Tunnel 时作为分享地址；临时 Tunnel 启动后优先使用已验证地址，停止后回落到配置地址。
- 修复取消“绕过系统代理启动 cloudflared”后又被旧自动启动设置重新勾选的问题；启动请求现在把同一偏好部分保存到持久设置。
- 家庭网络存在 VPN/TUN Fake-IP DNS、而物理网卡直连 Cloudflare 超时时，会优先尝试系统网络；某个连接器已注册但公网地址仍无法验证时，会自动切换下一策略，不再提前停在不可用地址。
- 开启临时公网访问时显示横向悬浮进度：下载、预检、连接、验证、重试、已用时间和可计算的阶段剩余时间。关闭只隐藏提示，不会中止后台任务；只有地址实际验证成功才提示完成。
- 顶栏实时显示当前局域网 `IP:端口` 与开放状态，并提供检查更新、项目主页、Latest 下载页和应用内下载中心；帮助菜单补齐作者主页、项目、下载和 Wiki 固定安全链接。
- 服务器设置可为缺失的 Windows 服务器、Android 客户端、macOS 服务器和 macOS 客户端上传固定目标文件；服务端限制类型、架构、文件头、大小和目标路径，并用临时文件原子替换。

### 媒体上传与处理

- 视频上传后默认进行 FFprobe 检测、缩略图生成和浏览器兼容处理，并在顶栏“处理进度”显示队列、进度、速度、已用时间和预计完成时间。
- 兼容视频尽量直接复制 H.264 视频流和兼容音轨；只在编码、像素格式、分辨率或音频不兼容时重新编码，并按 CPU 预算限制并发线程，减少无意义的整片转码。
- 修复“流畅版”对高码率 H.264 MP4 静默回退原片：超过 854×480 或平均码率超过约 1 Mbps 时也生成视频约 900 kbps、音频 96 kbps 的低带宽版本。
- “处理进度”中的活动任务支持“强行停止”；停止后保留源文件和可审计状态，不会马上被队列自动重启。
- 自动转换关闭路径：顶栏“处理进度” → 取消“上传完成后自动生成浏览器兼容版” → “立即应用”。关闭只影响后续自动转换，播放时仍可按需生成兼容版。
- 修复上传完成后媒体卡片缩略图不显示；缺失缩略图会补建，输出格式统一为浏览器可显示格式。
- 新增安全文本上传和同步阅读：支持 TXT、Markdown、日志、CSV/TSV、JSON/XML/YAML、配置文件等常见纯文本，自动识别 UTF-8、UTF-16 BOM 与 GBK/GB18030；连续滚动、页码和阅读位置可由有控制权限的成员同步给全房。服务器可在“房间与上传 → 上传限制”关闭文本上传，关闭后服务端也会强制拒绝。

### 播放与实时共享

- 播放/暂停点击后立即更新图标，同时等待权威房间状态校准，减少按钮看似无响应。
- 倍速命令不再附带强制跳转到旧时间点，修复高倍速下重复播放一小段内容的问题。
- 客户端本地缓冲不足时暂停硬跳转和加速追赶，避免弱网下不断丢弃已下载 Range、长期停在“正在定位”。
- 媒体请求进入 `waiting/stalled` 且连续 12 秒没有播放时间或缓冲增长时，会复用同一条最多 3 次的网络恢复链路；正常缓冲推进不会误触发重载。
- 网页/屏幕共享修复首帧与二进制 JPEG 传播时序，停止共享后可恢复；已用两个独立窗口验证长网址共享和多端画面同步。
- 播放器支持双击/双触进入全屏；全屏隐藏界面会同时隐藏底部进度条，再次双击可唤回聊天、表情和互动层。

### Android 与界面

- 登录、服务器管理、片库、成员、聊天、AI 聊天、API 端口配置、播放器和侧栏按窄屏重新排版，减少上下拥挤和横向溢出。
- 手机点击资料卡改为全屏模态窗口，避免账户菜单挤压导航和下载入口。
- 手机“观影”页下方恢复聊天、表情、互动与全屏操作；语音按钮缩小，展开与折叠状态有明确区别。
- 修复片库侧栏层级覆盖模块导航导致“片库/成员”点击无反应的问题；所有侧边滚动条改为跟随当前主题的细滚动条。
- “观影 / 片库 / 聊天 / 成员”四个模块入口改回普通文档流，随页面一起滚动，不再固定遮住播放器和工具。
- 登录页自动登录勾选框降低高度，与文字基线对齐。
- 手机 AI 工作台固定消息区与发送区的网格位置，会话操作压为单行、API 操作保持双列；长聊天记录限制在主题容器内滚动，发送栏始终紧随列表，不再需要滚过全部历史才能发消息。
- Android 内嵌服务端补齐 Node.js Mobile 18 环境中的 UUID 与时间格式回退；停止前台服务后会退出失效的本机页面并清理保存地址。

### 文档、构建、测试与发布

- `package.json`、Electron、独立服务器、Android `versionName`/`versionCode`、下载文件名、公开配置和帮助链接统一到 v2.2.0。
- README、PRODUCT、DESIGN、架构、部署、排错、运行环境、云媒体、发布清单和 Wiki 镜像按当前代码同步；Pages 继续只作为静态展示与教程站。
- Windows、macOS 与 Android 发布配置统一把正式成品输出到根目录 `dist/`；标准、体验、完整安装和完整便携版继续保持用途分层。
- macOS 客户端、服务器和完整离线版由真实 macOS runner 构建 x64/arm64 DMG/ZIP；Windows runner 构建 4 个真实 EXE，并验证内置运行时、离线资源与隐私边界。
- 贡献检查、核心集成、前后端契约、Electron 双窗口、Android 包闭包、媒体处理、Tunnel runtime、桌面发布与 Pages 检查按冻结源码执行。
- 正式资产继续使用固定的 26 个维护者文件；GitHub 自动生成两个源码归档，页面共显示 28 个文件，不用占位文件、重复文件或旧包改名凑数。

## 与 v2.1.9 保持不变

- 房间创建/加入、房间密码与人数限制、权威播放时钟、聊天/私聊/弹幕、语音、屏幕共享、好友、邮件、备份恢复和管理中心 11 个模块继续保留。
- 默认数据目录仍为 `SyncWatch同步观影-Data/`；升级前应停止服务并备份整个目录，同一目录仍只允许一个实例写入。
- Windows 体验版只连接已有服务器；标准版用于本机开服；完整安装版与完整便携 EXE 提供同等的跨平台离线下载资源。
- GitHub Pages 仍是静态展示站，不能运行 Node.js、Socket.IO、上传、AI 中转或 Cloudflare Tunnel。
- 项目继续采用 Apache-2.0，公开作者署名为 `xuan`；发布包不包含用户账号、聊天记录、真实 IP、令牌、签名密钥或运行数据。

## 验证记录

- `v2.2.0` annotated Tag 解引用到合并提交 `97491a87eb548c25d4f87950ca449c8b9ad18826`；发布分支与该提交的文件树一致。
- 主分支 Contribution checks `32804177550` 与 Pages `32804177566` 成功；Windows 构建 `32804971455` 与 macOS 构建 `32804313554` 均从同一提交完成。
- 12 个 macOS DMG/ZIP 由真实 `macos-14` runner 分架构构建；4 个 Windows EXE 通过用途分层、内置运行环境、离线资源和包闭包检查。
- Android 通用 APK 为 `161,527,006` 字节，SHA-256 为 `69fa0ac54bf500db9bec553a64c514c7501db6217a82db11902237c0952ebc6c`，包含 `armeabi-v7a`、`arm64-v8a`、`x86_64` 三种 ABI；最终 runner 解包检查与本地 `apksigner` v1/v2/v3、RSA-4096 签名验证通过。
- GitHub Release 中的 26 个资产与本地 `dist/` 对应文件逐项比对名称、字节数和 SHA-256，结果为 `26/26` 一致，总计 `11,016,505,063` 字节。
- 两个源码归档由最终 Tag 直接生成，均包含与 Tag 树一致的 373 个文件；本地 `dist/` 恰好为 28 个非空文件，总计 `11,050,977,334` 字节。
- Playwright 覆盖 `1440×900` 桌面、`390×844` 手机、`844×390` 横屏与 Android WebView 模拟；家庭/公司网络对照覆盖 HTTPS、WebSocket/Polling、HTTP Range、共享和 40 次拖动。

真实 Android 手机安装、厂商后台保活和屏幕共享授权仍取决于设备与 ROM；当前没有小米 14/HyperOS 真机证据，因此不把这部分写成已通过。

## 普通用户怎么选

- 只加入别人服务器：Windows 体验版、Android APK、macOS 客户端或浏览器。
- Windows 自己开房：标准服务器便携版；需要跨平台离线下载时选完整安装版或完整便携 EXE。
- Mac 自己开房：按 Intel x64 或 Apple Silicon arm64 选择服务器版；需要离线下载中心时选择完整离线版。
- 源码/独立服务器：安装官方 Node.js 22+；正式 EXE 已内置运行时，无需另装。

## 跨平台完整套装

完整离线包把真实构建的 Windows 客户端、Android APK、macOS x64/arm64 客户端与服务器 ZIP 放入房主端下载中心。成员按设备下载对应文件；管理员可隐藏入口，但不会从包内删除文件。升级或迁移前请停止服务并备份完整的 `SyncWatch同步观影-Data/`。

## 一键运行包含什么

Windows 正式服务器包内置 Electron/Node.js 运行时、应用前后端、生产依赖、Socket.IO、FFmpeg、FFprobe 和 Windows cloudflared。启动时会初始化数据目录、检查端口、启动 HTTP/WebSocket 服务并显示局域网地址。同一数据目录只允许一个实例写入；“打开新的服务器”会使用独立数据目录和主机令牌。

## macOS

macOS 客户端、服务器和完整离线版均提供 Intel x64 与 Apple Silicon arm64：

- 客户端：[Intel DMG](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Client-macOS-v2.2.0-x64.dmg) / [Intel ZIP](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Client-macOS-v2.2.0-x64.zip) / [Apple Silicon DMG](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Client-macOS-v2.2.0-arm64.dmg) / [Apple Silicon ZIP](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Client-macOS-v2.2.0-arm64.zip)
- 服务器：[Intel DMG](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Server-macOS-v2.2.0-x64.dmg) / [Intel ZIP](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Server-macOS-v2.2.0-x64.zip) / [Apple Silicon DMG](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Server-macOS-v2.2.0-arm64.dmg) / [Apple Silicon ZIP](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Server-macOS-v2.2.0-arm64.zip)
- 完整离线版：[Intel DMG](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Full-Offline-macOS-v2.2.0-x64.dmg) / [Intel ZIP](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Full-Offline-macOS-v2.2.0-x64.zip) / [Apple Silicon DMG](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Full-Offline-macOS-v2.2.0-arm64.dmg) / [Apple Silicon ZIP](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/SyncWatch-Full-Offline-macOS-v2.2.0-arm64.zip)

这些包来自真实 macOS runner，但没有 Apple Developer ID 签名或公证。首次打开时可能需要在 Finder 中右键选择“打开”，或在“系统设置 → 隐私与安全性”中确认。

## 架构支持边界

- Windows 桌面：x64；当前不提供未经完整验证的 32 位桌面组合。
- Android 通用 APK：`armeabi-v7a`、`arm64-v8a`、`x86_64`。
- macOS：Intel x64 与 Apple Silicon arm64；现代 Electron/macOS 不提供 32 位桌面包。
- 独立服务器：以 Node.js 22+ 对目标系统与架构的官方支持为准。
- Android 本机不能直接运行桌面版 cloudflared；手机公网访问应连接已开启 HTTPS/Tunnel 的桌面、macOS、Linux 或云服务器。

## cloudflared 独立工具

- [Windows x64 EXE](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/cloudflared-windows-x64.exe) · [Windows x64 MSI](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/cloudflared-windows-x64-installer.msi) · [Windows x86 MSI](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/cloudflared-windows-x86-installer.msi)
- [macOS Intel x64](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/cloudflared-macos-x64) · [macOS Apple Silicon arm64](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/cloudflared-macos-arm64)

这些文件对应 Cloudflare 官方 `2026.5.2` 发布；完整服务器包优先使用内置文件，独立工具用于手工 Tunnel 和诊断。官方文档：[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)。

## Node.js 官方环境包

正式 SyncWatch 桌面包已内置运行时。源码开发、Docker 或独立服务器用户可下载：

- [Windows x64 MSI](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/node-v24.19.0-x64.msi) · [Windows ARM64 MSI](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/node-v24.19.0-arm64.msi)
- [macOS Intel x64 PKG](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/node-v24.19.0-macos-x64.pkg) · [macOS Apple Silicon arm64 tar.gz](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.0/node-v24.19.0-darwin-arm64.tar.gz)

安装后运行 `node --version` 和 `npm --version` 验证。Node.js 官网：[nodejs.org](https://nodejs.org/)。

## 本次构建产物与 SHA-256

Release API 固定包含 26 个维护者资产；GitHub 页面另自动提供 `Source code (zip)` 与 `Source code (tar.gz)`，所以用户可见文件总数为 28。以下摘要与 Release API 的 `size`、`digest` 一致：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `SyncWatch-Experience-Client-Portable-v2.2.0-x64.exe` | 176,624,511 | `24de49eff5ac8d1fc82188160e8caddf5efbe814d9db2e140fa966c3fcea6d2a` |
| `SyncWatch-Standard-Server-Portable-v2.2.0-x64.exe` | 191,310,129 | `15e24744827e919622c1d7db413753e8192ee6829a2acf6f73dd80d81e309329` |
| `SyncWatch-v2.2.0-Full-Offline-Installer-x64.exe` | 1,358,806,595 | `fe2c7b450953309b2d4db5092ab7719f62f7d6758a99a84bc5a70751cbe9b184` |
| `SyncWatch-v2.2.0-Full-Offline-Portable-x64.exe` | 1,324,506,821 | `d48a6f3936642e28f195f024a548a1738b1ace364cd29045209ef5c1a25754ed` |
| `SyncWatch-Android-v2.2.0-universal.apk` | 161,527,006 | `69fa0ac54bf500db9bec553a64c514c7501db6217a82db11902237c0952ebc6c` |
| `SyncWatch-Client-macOS-v2.2.0-arm64.dmg` | 197,377,032 | `8df59fae33b31f881901085d2f0391cc826acd16215ae725201eb8cb78db54ea` |
| `SyncWatch-Client-macOS-v2.2.0-arm64.zip` | 208,052,846 | `8bf9cc552a9a170471f28e86fb42bff87a91cb20b2d310fdcd242ec52788d2a2` |
| `SyncWatch-Client-macOS-v2.2.0-x64.dmg` | 201,382,832 | `690345c61fde57f670f476d0aa954ca316f4a022407ac0b7c18fa778119a0683` |
| `SyncWatch-Client-macOS-v2.2.0-x64.zip` | 213,472,947 | `31b808f7db00c159cad4e791cb96be99dccbb8fcb4229d97ce8f48838316b1d1` |
| `SyncWatch-Full-Offline-macOS-v2.2.0-arm64.dmg` | 1,397,372,541 | `19fab65856aa157b6ee6765e3293fbaf10af14a1056ebd86c3fa0a19409c41a0` |
| `SyncWatch-Full-Offline-macOS-v2.2.0-arm64.zip` | 1,406,721,230 | `046501b2387dd54fedf90a7f495e64f5efd26d563fc223bfe1a51953601fd08e` |
| `SyncWatch-Full-Offline-macOS-v2.2.0-x64.dmg` | 1,401,323,570 | `383847f565edd4cd775ccfdf6e01aee2038de4dc032b8ce3a19b06e5ffe3d380` |
| `SyncWatch-Full-Offline-macOS-v2.2.0-x64.zip` | 1,412,141,331 | `be302ab62851328f4996ec99cd253f8f248f1a292af5d72e49d9a503d824f0b4` |
| `SyncWatch-Server-macOS-v2.2.0-arm64.dmg` | 238,468,814 | `eb905266a696d8e79d9498dce3f5b6fdcf1812c1c21be04393cb73fa060a9497` |
| `SyncWatch-Server-macOS-v2.2.0-arm64.zip` | 250,327,210 | `2d9eccae760f246d202fe911f180b78cd9009883368d1aa525cbad2822f16d8f` |
| `SyncWatch-Server-macOS-v2.2.0-x64.dmg` | 242,415,558 | `457de834d59b04b61006a314b78e8cca7276767ed26595fe8542958708da50dc` |
| `SyncWatch-Server-macOS-v2.2.0-x64.zip` | 255,747,311 | `e00867120b4eb0498060526f286aef446349f9d0670d4990b8ff922de2069f22` |
| `node-v24.19.0-arm64.msi` | 29,491,200 | `47b16e1b1012b1b9ad62169b3a466adb6bc758b2cb8bd8224683c086836484f8` |
| `node-v24.19.0-darwin-arm64.tar.gz` | 52,234,372 | `8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d` |
| `node-v24.19.0-macos-x64.pkg` | 92,775,015 | `13ecebfefa0234e3d618b4a0af8c5803bdeedab30b84ee37cccafb7276d90a0e` |
| `node-v24.19.0-x64.msi` | 32,972,800 | `f0f66c2a80c08a30a5ab5179ee9ea9e45f9b46289436a8cc87ff833b852db351` |
| `cloudflared-macos-arm64` | 38,335,632 | `cd9f764abfd06757b4def10ee5ba3d862381ed9fc02d6c1f06086c23d88695c6` |
| `cloudflared-macos-x64` | 41,145,200 | `c4fdc6021cd63003e32e70b577e17d47d493c6df4e24c7c97169ed74b67a715d` |
| `cloudflared-windows-x64-installer.msi` | 19,043,840 | `30a1a6a8dd4a3c7b695a56f871ccd033234dd56646b75a557187b37f9b0565ea` |
| `cloudflared-windows-x64.exe` | 54,116,816 | `20b9638f685333d623798e733effbad2487093f15ba592f6c7752360ff3b7ab7` |
| `cloudflared-windows-x86-installer.msi` | 18,811,904 | `56725678468a5f3e1a0a4ece6f6323aeca735932c62afc243aa1a9071f4b388c` |

## 首次启动、升级与安全

1. 首次启动使用 `admin` / `admin888` 登录，立即修改默认密码；公网部署前先完成局域网连接测试。
2. 升级前停止旧服务器并备份整个 `SyncWatch同步观影-Data/`，不要只复制 `config.json`。
3. 不公开数据目录、SMTP 密钥、Tunnel 令牌、签名文件、聊天记录、真实 IP 或带权限的房间链接。
4. 同一数据目录不要同时交给桌面端、独立 Node 服务和 Docker 写入。
5. 项目采用 Apache-2.0；再发布时保留许可证、NOTICE、原始版权与修改说明。公开作者署名为 `xuan`。

## 已知限制

1. 当前没有小米 14/HyperOS 真机的安装、后台保活、登录和屏幕共享证据；Android 15 x86_64 模拟器不能替代真实厂商设备。
2. macOS 包来自真实 macOS runner，但没有 Apple Developer ID 签名和公证；首次运行可能触发 Gatekeeper 确认。
3. Cloudflare Quick Tunnel、家庭上行和 VPN/TUN/Fake-IP 网络可能瞬时抖动；有限恢复逻辑不能把第三方临时隧道变成固定 SLA。
4. Android 本机不能直接运行桌面版 cloudflared；公网使用需连接已开启 HTTPS/Tunnel 的桌面、macOS、Linux 或云服务器。
5. GitHub Pages 只提供静态展示和文档导航，不能替代可运行的 SyncWatch 服务器。
