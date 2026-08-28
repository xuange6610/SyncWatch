# SyncWatch同步观影 v2.2.6 发布说明

和朋友、家人、情侣远程一起看电影。v2.2.6 基于 v2.2.5 正式版，集中修复 PC 简洁模式、全屏退出残留、全屏误触和画中画失败提示，并补充 F2 边看边聊、全屏锁定、亮度/音量手势。

> 本说明对应 `v2.2.6` 同版本更正版。发布完成必须同时满足：annotated Tag、`main` 和构建源码一致；原子工作流成功；Release API 恰有 10 个维护者资产；页面连同两个 GitHub 源码归档共 12 个可见文件；Latest 指向 `v2.2.6`；10 项均完成远端哈希回读。任一条件未满足时，当前状态仍是待重传，旧 `v2.2.6` 安装包不能作为本轮修复证据。

> 第一次使用服务器请用默认账号 `admin`、默认密码 `admin888` 登录，并立即修改默认密码。首次改密豁免只适用于内置 `admin` 完成账号密码认证后的初始化流程；被授予超级管理员的普通账号不强制改密。

| 下载文件 | 版本标识 | 最适合谁 | 一句话说明 |
| --- | --- | --- | --- |
| [`SyncWatch-Experience-Client-Portable-v2.2.6-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.6/SyncWatch-Experience-Client-Portable-v2.2.6-x64.exe) | 体验版 | Windows 普通成员 | 连接已有服务器，不在本机启动服务端 |
| [`SyncWatch-Standard-Server-Portable-v2.2.6-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.6/SyncWatch-Standard-Server-Portable-v2.2.6-x64.exe) | 标准版 | Windows 房主 | 便携启动基本服务器，内置运行环境和 cloudflared |
| [`SyncWatch-v2.2.6-Full-Offline-Installer-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.6/SyncWatch-v2.2.6-Full-Offline-Installer-x64.exe) | 完整安装版 | Windows 房主 | 安装向导、完整服务器和跨平台离线下载中心 |
| [`SyncWatch-v2.2.6-Full-Offline-Portable-x64.exe`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.6/SyncWatch-v2.2.6-Full-Offline-Portable-x64.exe) | 完整便携版 | Windows 房主 | 独立 EXE 直接运行，内容与安装版一致 |
| [`SyncWatch-Android-v2.2.6-universal.apk`](https://github.com/xuange6610/SyncWatch/releases/download/v2.2.6/SyncWatch-Android-v2.2.6-universal.apk) | Android | 手机成员或房主 | 连接现有服务器，也可运行受支持的手机内嵌服务 |
| macOS 客户端 x64/arm64 的 DMG/ZIP（4 项） | macOS 客户端 | Intel / Apple Silicon 成员 | 按芯片和文件格式选择纯客户端 |
| macOS 服务器 x64/arm64 的 DMG/ZIP（4 项） | macOS 服务器 | Intel / Apple Silicon 房主 | 按芯片选择可开房的服务器包 |
| macOS 完整离线版 x64/arm64 的 DMG/ZIP（4 项） | macOS 完整版 | Intel / Apple Silicon 房主 | 服务器、cloudflared 与跨平台离线下载中心 |
| Node.js 24.19.0 官方环境包（4 项） | 第三方运行时 | 源码或独立服务器用户 | 官方原始分发，桌面 SyncWatch 包无需重复安装 |
| cloudflared 官方工具（5 项） | 第三方公网工具 | 手工 Tunnel 用户 | Cloudflare 官方原始工具，不是 SyncWatch 启动程序 |

## 从 v2.2.5 到 v2.2.6 的更新公告

本节只记录当前源码相对 v2.2.5 的真实变化。更早版本已经具备的房间复制、权限、地址隐私、队列、简洁模式和全屏聊天能力继续保留，不在本节重复包装成新增功能。

### PC 简洁模式与布局

- 简洁模式现在控制真实的 `.workspace` 三栏容器，切换后隐藏两侧栏并使用单列剧场布局，播放器不会落入错误网格列，也不会被侧栏挤压。
- 聊天面板改为命名区域和稳定的八行 Grid，聊天记录占用弹性高度，实时语音栏不再错误拉高或挤压消息列表。
- 账户偏好仍按账号保存；重新登录或刷新后会恢复该账号的简洁模式状态。

### 登录并发、访问记录与客户端模式申请

- 达到账号并发上限时，登录页提供“申请更多设备”入口；用户可填写 2–20 台和原因，内置 `admin` 在用户申请中心批准、拒绝或取消已批准授权，取消后恢复服务器默认上限。
- 服务器设置新增普通账号设备上限、单 IP 游客上限、两类 IP 白名单和登录页访问记录；管理员可从记录直接加入账号白名单、游客白名单或 IP 黑名单。
- 管理员可向指定用户、当前房间或全服务器发送“关闭普通通知 / 简洁模式 / 专业模式”申请。用户明确同意后才应用到账号；离线用户下次登录补投，管理员可在用户确认前取消。
- 拒绝使用协议会主动撤销登录态并停止自动重连，不再错误显示游客进入；头像资料卡继续提供好友申请入口。
- 登录页 3D 立方体提供 50 种预制风格；未登录时服务器设置入口保持隐藏。
- 正式房间与临时房间的创建提示明确标注类型；房主退出确认默认高亮“只退出房间”。

### 全屏退出与边看边聊

- 原生全屏和伪全屏共用幂等清理流程，退出时会清除全屏类名、通知、定时器、播放手势、旋转/缩放、亮度滤镜和锁定状态，并兼容标准与 WebKit 全屏事件。
- 全屏中按 `F2` 呼出“边看边聊”并自动聚焦输入框；输入框、文本域和可编辑元素获得焦点时不会劫持该快捷键。
- 双击全屏画面只打开“边看边聊”，不会再因为双击触发播放或暂停。
- 全屏首次进入提示按账号和本地日历日记录，当天只提示一次；用户可以选择“永远不提示”。账号安全设置提供恢复提示入口。

### 全屏锁定与触控手势

- 全屏左上角增加锁定按钮。锁定后禁用画面播放/暂停、原生控件和进度拖动，但保留解锁、F2 聊天和退出全屏。
- 全屏左半区上下滑动调节当前媒体画面亮度，右半区上下滑动调节当前播放器音量；手势只作用于本地显示和音量，不发送房间播放命令。
- 手势有最小位移阈值、指针捕获和取消清理，避免轻微触碰造成误操作。浏览器只能可靠调节媒体亮度/音量，不能代替系统亮度或系统音量控制。

### 画中画失败恢复

- 画中画入口不再在一次用户点击中串行调用两个需要用户激活的 API，避免 Document PiP 消耗激活后导致系统 PiP 再次失败。
- Document PiP 失败时显示明确的“改用系统画中画”重试动作，由用户再次点击完成新的激活；错误提示保留浏览器权限检查建议。

### Android、Windows、macOS 与 UI

- Android `versionName` 更新为 `2.2.6`，`versionCode` 更新为 `20206`；User-Agent、内嵌 APK 名和构建配置同步更新。
- 修正 Android 发布脚本的 APK 元数据门禁，使 `versionName 2.2.6` 与最终包内版本严格一致，避免构建成功后被旧版本校验误拒。
- Windows 体验版、标准版、完整安装版和完整便携版的构建输出统一使用 v2.2.6，并继续要求所有应用包从最终 Tag 重新构建；macOS 新包不再构建或上传。
- 全屏锁、首次提示和手势提示沿用现有深色影院控件、可见焦点和移动端安全区域；本轮没有引入新前端框架或改变既有主题体系。

### 文档、构建与测试

- README、PRODUCT、DESIGN、Pages 源与生成页面、仓库内 `docs/wiki/`、维护要求、发布清单和本版本 Wiki 公告同步到 v2.2.6 同版本更正版；旧 Tag SHA、旧 Actions run 和旧资产只作为线上基线，不冒充本轮证据。
- 新增 v2.2.6 登录并发和客户端模式申请的真实 Socket.IO 集成测试，并保留 v2.2.4/v2.2.5 历史回归；浏览器烟测覆盖桌面和移动视口、简洁模式、F2、全屏锁、亮度手势及退出清理。
- 原子发布工作流支持安全替换同版本资产：新 10 项全部构建或核验后以临时名上传并回读哈希，再切换正式名称；旧资产只在新集合验证完整后删除，切换前失败会恢复旧 Release。
- 发布仍使用唯一 `release/v2.2.6` 分支、annotated Tag 和原子工作流。根目录 `dist/` 必须先形成恰好 12 个非空文件，再只上传 10 个维护者资产；GitHub 自动生成另外两个源码归档。
- 5 个 SyncWatch 应用资产（Windows 4、Android 1）必须由最终 Tag 对应源码真实重建；Node.js 2 项和 cloudflared 3 项必须按官方来源核验或读取已核验缓存后复核。

## 保持不变的核心能力

- 房间创建/加入、多房间、播放/暂停/拖动/倍速同步、原画/流畅版、片头片尾和播放队列继续保留。
- 公聊、私聊、弹幕、语音、好友、屏幕共享、网页共享、简洁模式和仅聊天继续保留。
- 房间复制申请、超级管理员迁移覆盖、登录限流解限申请、成员权限组和独立快进权限继续保留。
- 普通客户端不显示服务器 LAN IP，公网分享只使用可信公网地址；服务器窗口仍可显示局域网地址。

## 发布门禁与验证状态

| 项目 | v2.2.6 门禁 |
| --- | --- |
| 源码身份 | `release/v2.2.6` 最终提交、annotated Tag、Git tree、package 与 Android 版本一致 |
| 源码与 UI | 仓库规范、核心集成、v2.2.6 专项、桌面/移动浏览器冒烟和发布契约通过 |
| Windows 4 项 | 最终 Tag 在 Windows runner 重建，完成启动、闭包、版本、大小和 SHA-256 验证 |
| Android 1 项 | 最终 Tag 签名构建，完成 ABI、签名、模拟器安装/启动/登录和包内资源验证；小米 14/HyperOS 未验证 |
| Node.js / cloudflared 5 项 | 固定官方版本和来源，核对平台/架构、字节大小和 SHA-256 |
| `dist/` 与 Release | 最终目录恰好 12 个文件；Release API 恰好 10 个维护者资产并逐项远端回读哈希 |
| Latest 与下载 | 只有 Release 公开、非预发布、`releases/latest` 指向 v2.2.6、10 条下载直链可访问并完成本轮远端哈希回读，才可标记完成 |

## 普通用户怎么选

- 只加入别人服务器：Windows 体验版、Android APK、macOS 客户端或浏览器。
- Windows 自己开房：标准服务器便携版；需要全平台离线下载中心时选择完整安装版或完整便携版。
- Mac 自己开房：按 Intel x64 或 Apple Silicon arm64 选择服务器版；需要离线下载中心时选择完整离线版。
- 源码或独立服务器：安装官方 Node.js 22+；正式桌面包已内置运行时，无需重复安装。

## 跨平台完整套装

完整离线包只接收同一最终 Tag 构建并验证的 Windows 客户端、Android APK、macOS x64/arm64 客户端与服务器 ZIP。缺少任一真实文件时，完整包构建必须失败，不能嵌入旧版本或占位文件。

## 一键运行包含什么

Windows 正式服务器包内置 Electron/Node.js、应用前后端、生产依赖、Socket.IO、FFmpeg、FFprobe 和 Windows cloudflared。启动时初始化数据目录、检查端口、启动 HTTP/WebSocket 服务，并只在服务器窗口显示局域网地址。

## macOS

客户端、服务器和完整离线版分别提供 Intel x64 与 Apple Silicon arm64 的 DMG/ZIP，共 12 项；必须由真实 macOS runner 从最终 Tag 构建，Windows 文件不能冒充。

## 架构支持边界

- Windows 桌面：x64。
- Android 通用 APK：`armeabi-v7a`、`arm64-v8a`、`x86_64`，以 APK 解包和签名检查为准。
- macOS：Intel x64 与 Apple Silicon arm64。
- Android 本机不内嵌桌面版 cloudflared；手机跨网访问应连接已开启 HTTPS/Tunnel 的服务器。

## cloudflared 独立工具

Release 提供 Windows x64 EXE、Windows x64/x86 MSI、macOS x64/arm64 二进制共 5 项。它们来自 Cloudflare 官方分发，用于手工 Tunnel 与诊断，不是 SyncWatch 启动程序。

## Node.js 官方环境包

Release 提供 Windows x64/ARM64 MSI、macOS x64 PKG 和 macOS arm64 tar.gz 共 4 项，供源码和独立服务器使用；正式桌面包已内置运行时。

## 首次启动、升级与安全

1. 首次启动使用 `admin` / `admin888` 登录并立即修改默认密码；公网部署前先完成局域网测试。
2. 升级前停止旧服务器并备份整个 `SyncWatch同步观影-Data/`，不要只复制 `config.json`。
3. 全屏锁定只保护当前设备的画面误触，不会改变房间同步权限；结束观影前停止公网 Tunnel。
4. 不公开数据目录、SMTP 授权码、Tunnel 令牌、签名文件、聊天记录或真实 IP。

## 已知限制

1. 当前没有小米 14 / HyperOS 真机安装、后台保活、全屏手势和屏幕共享证据；移动浏览器和模拟器不能替代该真机证据。
2. 画面亮度手势是媒体 CSS 滤镜，音量手势是当前播放器音量；浏览器不会因此改变系统屏幕亮度或系统总音量。
3. macOS 签名、公证和 Gatekeeper 状态以最终 Actions 证据为准；没有签名证书时系统可能要求用户确认打开。
