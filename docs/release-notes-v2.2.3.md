# SyncWatch同步观影 v2.2.3 发布说明

和朋友、家人、情侣远程一起看电影。v2.2.3 基于 v2.2.0 正式版和未发布的 v2.2.1/v2.2.2 候选继续完成，重点改善同步看小说、长时间播放网络状态、穿透后的真实客户端 IP、手机客户端退出入口、首次管理员改密、默认画质、账号密码策略和统一界面文案。

> 发布状态以 [GitHub Release v2.2.3](https://github.com/xuange6610/SyncWatch/releases/tag/v2.2.3) 的实时结果为准：只有页面已公开、API 恰有 26 个维护者资产且页面连同两个源码归档共显示 28 个文件时，本版本才算发布完成；页面不存在、仍为草稿或资产不足都表示构建尚未完成。

> v2.2.1 和 v2.2.2 都没有创建 Release 或上传资产；v2.2.2 Tag 已固定指向其候选合并提交，不能移动或复用。本轮只使用唯一发布工作分支 `release/v2.2.3`，v2.2.3 使用新的 annotated Tag。

> 第一次使用服务器请用默认账号 `admin`、默认密码 `admin888` 登录，并立即修改默认密码。只有本次会话刚刚通过账号密码认证且处于首次初始化时，改密向导才可免于重复输入当前密码；本机免密管理会话和普通周期改密不会绕过校验。

| 下载文件 | 版本标识 | 最适合谁 | 一句话说明 |
| --- | --- | --- | --- |
| `SyncWatch-Experience-Client-Portable-v2.2.3-x64.exe` | 体验版 | Windows 普通成员 | 连接已有服务器，不在本机启动服务端 |
| `SyncWatch-Standard-Server-Portable-v2.2.3-x64.exe` | 标准版 | Windows 房主 | 便携启动基本服务器，内置运行环境和 cloudflared |
| `SyncWatch-v2.2.3-Full-Offline-Installer-x64.exe` | 完整安装版 | Windows 房主 | 安装向导、完整服务器和跨平台离线下载中心 |
| `SyncWatch-v2.2.3-Full-Offline-Portable-x64.exe` | 完整便携版 | Windows 房主 | 独立 EXE 直接运行，功能与离线资源和安装版一致 |
| `SyncWatch-Android-v2.2.3-universal.apk` | Android | 手机成员或房主 | 连接现有服务器，也可运行受支持的手机内嵌服务 |
| `SyncWatch-Client-macOS-v2.2.3-{x64,arm64}.{dmg,zip}` | macOS 客户端 4 项 | Intel / Apple Silicon 成员 | 按芯片和 DMG/ZIP 格式选择纯客户端 |
| `SyncWatch-Server-macOS-v2.2.3-{x64,arm64}.{dmg,zip}` | macOS 服务器 4 项 | Intel / Apple Silicon 房主 | 按芯片选择可开房的服务器包 |
| `SyncWatch-Full-Offline-macOS-v2.2.3-{x64,arm64}.{dmg,zip}` | macOS 完整版 4 项 | Intel / Apple Silicon 房主 | 服务器、cloudflared 与跨平台离线下载中心 |
| Node.js 24.19.0 官方环境包 4 项 | 第三方运行时 | 源码或独立服务器用户 | 官方原始分发，桌面 SyncWatch 包无需重复安装 |
| cloudflared 官方工具 5 项 | 第三方公网工具 | 手工 Tunnel 用户 | Cloudflare 官方原始工具，不是 SyncWatch 启动程序 |

## 从 v2.2.0 到 v2.2.3 的更新公告

下面只记录当前源码相对最新正式版 v2.2.0 的真实变化。v2.2.1/v2.2.2 没有对外发布，不能把候选文件名、Tag 或文档当成可下载成品。

### 小说、播放和网络恢复

- 房间权威阅读状态新增 UTF-16 `characterOffset` 字符锚点，同时保留 `fileId`、归一化位置、页码、更新时间和递增 `revision`。成员、晚加入客户端和断线重连客户端恢复同一逻辑字符；桌面与手机可以有不同换行和像素位置，但本地视觉行首不能回写覆盖权威偏移。
- 顶栏网络状态只依据 Socket.IO 控制通道：单次 RTT 尖峰、视频 `waiting/stalled`、其他成员重连或后台节流不直接显示“网络波动”。连续 3 次高延迟/超时才降级，连续 2 次健康样本后恢复；旧序号和上一连接周期的结果被隔离。
- 超过 32 MiB 的媒体使用 8 MiB 有界开放 Range；连续 12 秒无播放或缓冲增长时最多执行 5 次渐进恢复，离线等待不消耗次数，原画仍失败且已有流畅版时再自动降级。
- 新客户端默认选择原画，不因局域网、反向代理或 Tunnel 自动切到流畅版；用户仍可手动选择自动或流畅版。

### 穿透后的真实客户端 IP

- HTTP 与 Socket.IO 共用可信代理链解析。回环和服务器启动时采样的本机网卡地址默认可信，解决本机 cloudflared 通过 LAN 地址回源时所有公网访客都显示成同一个代理 IP 的问题。
- `X-Forwarded-For` 从右向左剥离可信 hop，遇到第一个不可信地址即返回；攻击者塞在最左侧的伪造值不能替换真实客户端。不可信直连提交的 XFF、`CF-Connecting-IP` 和 `X-Real-IP` 全部忽略。
- Docker、Nginx、Caddy 或 frp 可通过 `SYNCWATCH_TRUSTED_PROXIES` 或 `--trusted-proxies` 声明受控 IP/CIDR，命令行值优先于环境变量。Node、Electron 与独立包三个启动器已接入同名参数，Compose 显式映射同名环境变量。无效条目按 fail-closed 忽略，`0.0.0.0/0` 与 `::/0` 不会生效。
- 不同真实 IP 的游客可以同时在线；同一真实 IP 的第二个游客仍收到 `GUEST_IP_OCCUPIED`，账号审计、封禁和游客限制使用同一解析结果。

### 登录、账户与可编辑文案

- Android/手机网页点账号行后在功能菜单内展开账号操作，不再直接跳进个人资料而隐藏退出入口。“退出登录，保留账号密码”和普通“退出登录”排在首行；前者退出并清除会话后仅把本次账号密码恢复到登录表单，后者不保留。
- 游客占用提示新增稳定文案键 `login.guestIpOccupied`。超级管理员可在“服务器设置 → 统一界面文案”双击或集中编辑、导入、导出；保存后通过 `ui-copy-state` 实时广播，后续服务端拒绝响应直接使用新文字。
- 内置 `admin` 首次通过账号密码认证后，改密向导只要求新密码和确认密码；一次性能力成功后立即撤销，本机免密会话和普通周期改密仍需当前密码。
- 新注册账号和普通密码默认不限制业务字符类型或字符数，仍保留用户名 1024 UTF-8 字节、密码 4096 UTF-8 字节的防滥用硬上限；管理员可显式启用更窄策略。

### Android、UI、颜色和交互

- 手机顶栏功能菜单保持 fixed 覆盖层，不再参与播放器/主界面高度计算。390px 起改为三列，较窄手机使用两列并在自身区域滚动；账号子菜单使用两列紧凑布局，Android 触控高度仍不低于 48px。
- 账号按钮使用 `aria-controls` / `aria-expanded` disclosure 语义，账号下拉会按桌面/手机视口重新挂载；Escape 可关闭并恢复焦点。房主退出弹窗默认聚焦安全的“只退出房间”，支持 Escape 取消和 Tab 焦点约束。
- 本轮没有更换主题色板；调整集中在信息密度、层级、触控尺寸和退出操作可发现性，保留现有暗色影院与可选主题。
- 成员头像保留单击打开资料，桌面双击或触摸端快速双击打开大图；成员列表异步重绘期间按账号重新定位当前控件。
- 桌面关闭选择窗不再固定只高亮“最小化到托盘”；悬停或键盘聚焦哪个操作，哪个操作使用相同高亮。
- Android `versionName=2.2.3`、`versionCode=20203`。当前只有 Chromium 移动视口和 Android 模拟器级证据，手机菜单、退出、后台、投屏和弱网仍需正式 APK 真机复核。

### Windows、macOS、构建与发布

- Windows 体验版、标准版、完整安装版、完整便携版的配置和内嵌文件名统一为 v2.2.3；Android 下载名、Java User-Agent、内嵌服务器路径和 APK 验证规则同步升级。
- macOS 客户端、服务器、完整离线版的 x64/arm64 DMG/ZIP 文件名统一为 v2.2.3；它们必须由真实 macOS runner 构建，Windows 工作站不能伪造或重命名旧包。
- 修复 macOS 发布 runner 的平台差异：服务器按当前架构校验对应的 Cloudflare 二进制，固定下载使用 GitHub token，并把 Release 资产名映射为应用运行时文件名；客户端基础包按矩阵只生成当前架构，并在候选门禁前移除调试元数据，避免 x64/arm64 混包。
- 修复 Windows 托管 runner 没有 loopback 音频设备时的发布阻塞：仍验证桌面视频捕获，仅在 GitHub Windows runner 且显式开启受控开关时记录缺少音频设备的警告；本地和自托管环境仍要求真实音轨。
- 修复 Windows PowerShell 5.1 解析 Android 构建脚本中正则和长字符串的兼容性，保留 APK 签名、ABI、内容闭包和版本门禁。
- Android 内嵌运行库固定由 `nodejs-mobile/nodejs-mobile` 提交 `ff4e063f1f1911047c067335ad0a3d81336236ca`、NDK r24 和 16 KB linker flag 构建。发布重试可以复用此前 Actions 生成的同一运行库 artifact，但必须重新核对 provenance、头文件和三 ABI 原始 SHA-256；最终 APK 仍由新的 v2.2.3 Tag 源码重新构建、正式签名，并对 Gradle/NDK 处理后的三 ABI 哈希逐项严格校验。
- 根目录 `dist/` 仍是唯一正式输出目录。17 个 SyncWatch 应用资产必须由最终 v2.2.3 Tag 源码真实重建；9 个 Node.js/cloudflared 文件必须核对官方来源和 SHA-256，不能描述成 SyncWatch 启动程序。
- 发布前必须先满足 26 个维护者资产、两个源码归档、非空大小、版本/平台/架构、包内闭包、SHA-256、启动/核心流程和 26+2 数量门禁；资产不齐时 Release 保持未发布，不上传残缺集合。

### 文档、Wiki 与测试

- README、PRODUCT、DESIGN、架构、用户手册、部署/排错、发布清单、Wiki 镜像和 Pages 生成源已加入可信代理、手机退出入口和可编辑游客提示说明。
- 新增 `tests/trusted-proxy-ip.test.js`，覆盖不可信直连伪造、服务器本机回源、可信 CIDR、多跳右向左剥离、恶意最左项、IPv6、两类 `/0` 拒绝，以及真实 HTTP `/api/public-config` 与 Socket.IO 游客登录/审计 IP 一致性。平台契约还覆盖双入口参数和三个独立包启动器/Compose 传递。
- 游客生命周期回归覆盖不同真实 IP 并存、同 IP 阻止、文案实时广播、服务端错误和重启持久化。
- 浏览器 UI 回归覆盖 390×844 三列菜单、375×667 小屏滚动、48px 触控、账号菜单无横向溢出、两个退出操作、保留凭据重新登录和普通退出清空表单。模拟视口不等同于物理手机。
- 浏览器与 Electron 烟测在根目录 `dist/` 已生成当前 Android APK 时，会把同一绝对路径显式传给测试服务器；构建后执行完整回归不再出现“测试期望下载入口可见、服务器却未加载 APK”的环境耦合误报。

## 发布门禁与验证状态

原子发布工作流只有在下列门禁全部通过后才会把 Release 从草稿切为公开并设为 Latest；公开页面本身是这些门禁完成的必要证据。具体运行日志、SHA-256 清单和 provenance 保存在对应 GitHub Actions 运行中。

| 项目 | 状态 |
| --- | --- |
| 源码版本字段 | Tag、提交、文件树、package 版本与 Android 版本必须一致 |
| 可信代理、游客提示、手机菜单与退出 | 单元、集成、浏览器桌面/移动视口与完整仓库门禁必须通过 |
| Windows 4 个应用资产 | 由最终 Tag 在 Windows runner 重建并完成启动、安装与闭包验证 |
| Android APK | 由最终 Tag 签名构建，完成 ABI、签名、模拟器安装/启动/登录验证 |
| macOS 12 个应用资产 | 由真实 Intel 与 Apple Silicon runner 构建，并验证原生架构、DMG/ZIP 和启动流程 |
| Node.js / cloudflared 9 个上游资产 | 从固定官方版本下载，核对来源、平台/架构、字节数和 SHA-256 |
| `dist/` 28 文件、Release API 26 项、页面 28 项 | 最终目录必须恰好 28 个非空文件；仅上传 26 个维护者资产并远端回读 SHA-256 |
| v2.2.3 Release、Latest、下载直链 | 只有上述全部成功才公开 Release、设为 Latest 并逐项探测下载链接 |
| 小米 14 / HyperOS 真机 | 未验证 |

## 普通用户怎么选

- 只加入别人服务器：Windows 体验版、Android APK、macOS 客户端或浏览器。
- Windows 自己开房：标准服务器便携版；需要跨平台离线下载中心时选择完整安装版或完整便携版。
- Mac 自己开房：按 Intel x64 或 Apple Silicon arm64 选择服务器版；需要离线下载中心时选择完整离线版。
- 源码或独立服务器：安装官方 Node.js 22+；正式桌面包已内置运行时，无需重复安装。
- 只从 [GitHub Release v2.2.3](https://github.com/xuange6610/SyncWatch/releases/tag/v2.2.3) 的真实资产列表下载；页面不存在、为草稿或文件数不足时继续使用 [v2.2.0 正式版](https://github.com/xuange6610/SyncWatch/releases/tag/v2.2.0)，不要把文档中的文件名当成下载链接。

## 跨平台完整套装

完整离线包应把同一最终 Tag 真实构建并验证的 Windows 客户端、Android APK、macOS x64/arm64 客户端与服务器 ZIP 放入房主端下载中心。缺少任一平台文件时，Windows/macOS 完整包构建必须失败，不能嵌入旧版本、空文件或占位文件继续发布。

## 一键运行包含什么

Windows 正式服务器包应内置 Electron/Node.js 运行时、应用前后端、生产依赖、Socket.IO、FFmpeg、FFprobe 和 Windows cloudflared。启动时初始化数据目录、检查端口、启动 HTTP/WebSocket 服务并显示局域网地址；实际包含内容必须由最终成品闭包测试证明。

## macOS

v2.2.3 的客户端、服务器和完整离线版分别提供 Intel x64 与 Apple Silicon arm64 的 DMG/ZIP，共 12 项。它们必须由真实 macOS runner 从最终 Tag 构建，不能用 Windows 产物、改名旧包或只更新应用显示版本替代。签名与公证状态以最终构建记录为准。

## 架构支持边界

- Windows 桌面：x64；当前不承诺未经完整验证的 32 位桌面组合。
- Android 通用 APK：包含 `armeabi-v7a`、`arm64-v8a`、`x86_64`，以 Release 工作流的 APK 解包和签名检查为准。
- macOS：Intel x64 与 Apple Silicon arm64；现代 Electron/macOS 不提供 32 位桌面包。
- 独立服务器：以 Node.js 22+ 对目标系统和架构的官方支持为准。
- Android 本机不能直接运行桌面版 cloudflared；手机跨网访问应连接已开启 HTTPS/Tunnel 的 Windows、macOS、Linux 或云服务器。

## cloudflared 独立工具

提供 Windows x64 EXE、Windows x64/x86 MSI、macOS x64/arm64 二进制共 5 项。它们是 Cloudflare 官方工具，用于手工 Tunnel 与诊断，不是 SyncWatch 启动程序；原子发布工作流会核对固定 [Cloudflare 官方 Release](https://github.com/cloudflare/cloudflared/releases/latest) 的版本、平台、架构、大小和 SHA-256。

## Node.js 官方环境包

提供 Windows x64/ARM64 MSI、macOS x64 PKG 和 macOS arm64 tar.gz 共 4 项，供源码和独立服务器使用。它们是 Node.js 官方分发文件，不由 SyncWatch 源码生成；正式桌面包已内置运行时。原子发布工作流会核对 [Node.js 官方下载](https://nodejs.org/en/download) 中固定版本的来源、平台、架构、大小和 SHA-256。

## 首次启动、升级与安全

1. 首次启动使用 `admin` / `admin888` 登录并立即修改默认密码；公网部署前先完成局域网连接测试。
2. 升级前停止旧服务器并备份整个 `SyncWatch同步观影-Data/`，不要只复制 `config.json`。
3. 外置代理只信任精确受控 IP/CIDR；不公开数据目录、SMTP 密钥、Tunnel 令牌、签名文件、聊天记录、真实 IP 或带权限的房间链接。
4. 只在 v2.2.3 Release 已公开且 26+2 文件、哈希、启动证据和在线链接全部验证后升级；否则不要用候选源码覆盖生产环境。

## 已知限制

1. 当前没有小米 14 / HyperOS 真机安装、手机菜单、保留凭据退出、后台保活、登录和屏幕共享证据。
2. 可信本机网卡地址在服务启动时采样；运行中新增网卡后需重启。额外可信代理必须由维护者准确配置。
3. 不同视口的文字换行、视觉行首和像素滚动值可以不同；同步目标是同一文件、最新 revision、精确逻辑 `characterOffset` 与同一锚点字符，不是强制相同像素坐标。
4. macOS 最终签名、公证和 Gatekeeper 行为要等真实 runner 成品完成后确认。
5. Cloudflare Quick Tunnel、家庭上行和 VPN/TUN/Fake-IP 网络没有固定 SLA；默认原画会增加带宽需求，弱网用户应手动选择流畅版。
