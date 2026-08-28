# SyncWatch 项目工作规则

## 项目导航

- **项目名称**：SyncWatch同步观影
- **用途**：开源、自托管、跨平台的同步观影与实时协作系统。
- **技术栈**：Node.js 22+、Express 5、Socket.IO 4、原生 HTML/CSS/JavaScript、Electron 41、Android Java/C++/WebView、FFmpeg/FFprobe、Gradle、PowerShell/Bash。
- **主要入口**：`public/index.html`（Web UI）、`server/index.js`（HTTP/Socket.IO 服务）、`electron-pink.js`（桌面服务器）、`electron-client.js`（独立客户端）、`server-standalone.js`（Node 独立服务端）、`mobile/app/src/main/java/com/xuan/syncwatch/MainActivity.java`（Android）。
- **核心目录**：`public/` 前端；`server/` 后端与隧道；`mobile/` Android；`scripts/` 构建辅助；`tests/` 自动化验收；`docs/` 展示站与文档；`.github/` CI、Pages、Release 工作流；根目录 `dist/` 是唯一允许生成和保存正式构建成品的目录（被 Git 忽略）。

## 每次开始新任务

1. 首先读取 `AGENTS.md`。
2. 读取用户确认的长期要求 [docs/maintenance/maintainer-requirements.md](docs/maintenance/maintainer-requirements.md)，并按当前任务执行其中适用的检查。
3. 根据任务内容读取 `PRODUCT.md`。
4. 涉及 UI、交互、架构时读取 `DESIGN.md`。
5. 涉及安装、部署、使用说明时读取 `README.md`。
6. 根据任务内容搜索 `docs/` 中的相关文档。
7. 检查当前实际代码、配置、测试和生成脚本。
8. 检查最近相关 Git 历史、当前分支、remote、Actions 与 Release 状态。
9. 不得仅根据聊天上下文猜测当前项目状态。
10. 当前磁盘代码、Git 历史和最新项目文档是项目真实状态的最高依据。

## 开发规范

- 遵守 `.editorconfig`、`.gitattributes` 和现有模块边界；优先小范围、可验证的改动。
- 用户可见功能必须同时考虑权限、错误、加载、空状态和移动端布局。
- 超级管理员从登录页或管理中心验证时使用管理专用会话：直接打开服务器设置，保持观影主界面隐藏；只有主动选择房间入口后才进入观影。
- 不把静态 GitHub Pages 展示页描述成可运行的 Node.js、WebSocket、上传或公网服务。
- 新增功能应补充对应测试；修改文档时保持链接和代码示例可定位。

## 禁止事项

- 不提交 `node_modules/`、构建产物、真实运行数据、`.env`、密钥、签名文件或个人隐私。
- 不删除或重写重要 Git 历史，不覆盖未审计的用户备份目录。
- 不绕过服务端权限、认证、数据目录锁或 Release 验收。
- 不把计划功能写成已经实现，也不凭旧截图或聊天记录声明当前行为。

## 构建命令

- 安装依赖：`npm ci`（或按锁文件使用 `pnpm install --frozen-lockfile`）。
- 开发启动：`npm start`；独立服务端：`npm run start:server`。
- Windows 构建：`powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1`；独立服务器包：`.\build-server-package.ps1`。
- Android 构建：`powershell -NoProfile -ExecutionPolicy Bypass -File .\mobile\build-apk.ps1`；macOS 构建需 macOS 主机或 GitHub Actions。

## 测试命令

- 仓库检查：`npm run test:repo`；核心测试：`npm test`；完整验收：`npm run test:all`。

## Git 提交规范

- 提交信息使用 `feat:`、`fix:`、`perf:`、`style:`、`refactor:`、`docs:` 等清晰前缀。
- 版本发布工作统一使用一个 `release/vX.Y.Z` 分支并通过 Pull Request 合并；不要为同一版本长期保留多个 `codex/*release*` 临时分支，已合并或放弃的临时分支应及时删除。

## GitHub 发布规范

- `main` 是稳定分支；功能在分支和 Pull Request 中验证后合并。版本由 `package.json`、Android `versionName`、Release tag 和发布说明共同更新，当前版本以源码和最新 Release 为准。
- GitHub Pages 由 `.github/workflows/pages.yml` 发布 `docs/`；Windows/Android Release 由对应 Actions 构建并上传，发布前必须先通过仓库规范和成品契约测试。
- 每个正式版本必须严格按当前 **12 个可见文件**发布：GitHub 自动生成的 `Source code (zip)` 与 `Source code (tar.gz)` 计 2 个，维护者实际上传的 Release 资产计 10 个。不得少传、增加重复资产或把部分集合宣称完整发布。
- 10 个维护者资产固定为：Windows 体验版、标准版、完整版安装 EXE、完整版便携 EXE（4）；Android 通用 APK（1）；Node.js Windows x64/ARM64 MSI（2）；cloudflared Windows x64 EXE、Windows x64/x86 MSI（3）。macOS 新包不再构建或上传，历史 Release 资产保留。
- 每个版本的 Release 正文必须保留并更新“普通用户怎么选”“Windows + Android 套装”“一键运行包含什么”“架构支持边界”“cloudflared 独立工具”“Node.js 官方环境包”等说明，不得只替换版本号后删减原有使用信息。
- Release 正文第一屏必须保留产品简介、首次修改默认管理员密码提示，以及“下载文件 / 版本标识 / 最适合谁 / 一句话说明”选择表。永久使用说明与上一版本保持同等完整度；“更新公告”只写上一版本到当前版本真实发生的变化，并逐项覆盖代码、功能、Android、UI/颜色、文档、构建、测试与发布流程，不得漏写实际改动或把未变化功能冒充新增。
- 同一版本因缺陷需要重传时，只删除该版本的维护者资产并重新上传完整 10 项；不得删除历史 Release、历史 tag 或历史版本资产。重传过程中不得把资产数为 0 或不足 10 的 Release 宣称为发布完成。
- 每次发布的 5 个 SyncWatch 应用资产（Windows 4、Android 1）必须由最终 Tag 对应的修改后源码重新构建，禁止复用、改名或复制上一版本应用包。上传前必须用包内源码/资源闭包、应用版本、平台/架构、签名（适用时）、非空大小、SHA-256 和实际启动/核心流程结果证明它们来自该 Tag。Node.js 与 cloudflared 的 5 个官方原始分发文件不由本项目源码生成，必须核对官方来源、版本、平台/架构和 SHA-256，且不得描述成 SyncWatch 启动程序。任何一项缺少证据时，Release 保持草稿且不得上传残缺集合或对外发布。
- 用户确认的交付规则：上传到 GitHub Release 的每一个文件都必须是当前修改后源码重新生成或已核验来源的真实成品；应用包要先验证能启动并完成对应核心流程，再核对版本、平台/架构、非空大小和 SHA-256 后上传。不得把未验证文件、旧版本改名包、占位文件或只通过源码检查的文件当作启动程序上传。
- 每个版本公开前必须同步更新仓库首页 `README.md`、GitHub Pages 的 `docs/` 源与生成页面、仓库内 `docs/wiki/` 镜像、GitHub Wiki 的 Home/Sidebar/版本公告和受影响教程。完成部署后必须分别读取仓库首页、Pages canonical URL、GitHub Wiki 和 Release 页面，确认版本、下载文件、更新公告与当前 Release 一致；任一页面仍展示旧版、缺少当前版本公告或链接到旧资产时，发布保持 `pending`，不得宣称完成。
- 发布前必须逐项核对文件名、版本号、平台/架构、非空大小、SHA-256 和 Release 资产数量；缺少任一真实构建产物时，标记版本未完成并停止上传，不用改名文件或占位文件凑数。资产清单以 [docs/release/release-manifest.md](docs/release/release-manifest.md) 为准。
- 发布执行顺序固定为“完成全部源码与文档改动 → 本地运行/测试 → 真实构建并验证应用成品、核验缓存第三方文件 → 逐项核对哈希与 10+2 文件数 → 仅清理当前版本旧资产 → 一次性完整覆盖上传”。任何测试、构建或资产校验未完成时不得先发布；历史版本资产不得删除。

## 自动版本规则

- 版本号必须在 `package.json`、Android `versionName`/`versionCode`、Release tag 和 `docs/release-notes-vX.Y.Z.md` 中保持一致；补丁版本递增用于兼容修复，功能版本递增前必须更新发布说明。
- Git 标签、GitHub Release 标题/链接、发布分支和用户可见版本统一使用 `vX.Y.Z`；禁止创建无 `v` 的重复标签。`package.json` 和 Android `versionName` 仍按工具链要求使用纯 SemVer `X.Y.Z`。
- GitHub Actions 只根据受保护分支、Release tag 或手动 workflow 输入发布；不得把未验证的本地 `release/` 文件直接当作 Release 资产。

## 每次任务完成

1. 检查 `git diff`、`git status` 和新增文件是否符合范围。
2. 运行相关测试；必要时运行 `npm run test:repo`、`npm test` 和对应 build。
3. 如果功能发生变化，同步更新 `PRODUCT.md`。
4. 如果 UI、架构、技术方案发生变化，同步更新 `DESIGN.md`。
5. 如果用户使用方式、安装方式、功能介绍发生变化，同步更新 `README.md`。
6. 如果需要长期保留的技术知识发生变化，同步更新 `docs/`。
7. 不要因为小型代码调整无意义地重写整个文档；文档必须与实际代码保持一致。

## 本地成品与历史保留

- `release/`、`dist*/` 和 `output/` 中确认已被新成品取代的本地构建残留，只能在新成品完成测试、哈希核对和发布验证后按精确路径清理。
- 未跟踪备份目录、签名密钥备份、Wiki 镜像、个人主页副本和来源不明文件默认属于用户，不得擅自删除、覆盖或提交。
- 本地清理规则不适用于 GitHub 历史 Release：历史版本、tag 和各版本资产必须保留；同版本重传也只能处理当前版本资产。

## GitHub 与安全规则

- 外部贡献通过 Fork/分支/ Pull Request 进入，维护者审核后合并；不得直接强制覆盖 `main`。
- 发布说明必须列出真实资产、平台/架构、校验或已知限制；没有成品就明确标记未提供。
- 默认管理员密码、SMTP 授权码、Tunnel 令牌、运行数据目录、IP、聊天记录和媒体文件名不得进入提交、截图或 Issue。
- 发现安全问题按 `SECURITY.md` 私密报告；公开 Issue 只提交脱敏日志和最小复现。

## 对话要求归档

### 0. 发布失败复盘与防重复执行（2026-08-28）

- 每次执行任何命令前，必须先读取本文件（`AGENTS.md`）和 `docs/maintenance/maintainer-requirements.md`，再检查当前分支、远端、Actions、Release 状态；不得只依据上一轮聊天摘要。
- v2.2.6 原子发布运行 `33153068879` 的第一次失败原因：复用历史 Android ABI 时，`release-windows.yml` 的输入校验拒绝了合法的 `*` artifact pattern。修复：允许 `[A-Za-z0-9._*-]+`，并保留 `android` phase 限制。
- v2.2.6 原子发布运行 `33153947802` 的第二次失败原因：复用历史 ABI 时没有检出固定版本的 Node.js Mobile 源码，却执行了 `./configure`；同时还尝试下载本次运行尚未生成的 ABI。修复：通配符复用模式仍检出固定源码，只下载历史 ABI，不下载当前运行候选。
- 同一运行的 Android 包检查随后因仍硬编码旧官方 `libnode.so` SHA-256 而失败。修复：在 `SYNCWATCH_ALLOW_GENERATED_NODE_MOBILE=1` 的 CI 复用模式下校验生成哈希格式、来源闭包和 16KB ELF/APK 对齐；普通本地构建继续执行官方固定哈希门禁。
- 失败运行不得删除公开 Release 资产，也不得用占位文件凑数；应先取消失败运行、读取失败 job 日志、做最小修复、提交到唯一 `release/vX.Y.Z` 分支，并从最终 tag 重新触发一次。禁止为同一版本创建新的 `codex/*` 或额外 release 分支。
- 发布运行只允许在“源码门禁成功 + 5 个应用资产真实构建验证 + 5 个官方文件来源/缓存核验 + 10 个维护者资产汇总验证”后覆盖 Release；在此之前状态必须保持 `pending`。
- 防止浪费 token：不要对同一失败原因重复触发构建；先用 `gh run view <run> --json status,conclusion,jobs` 和失败 job 日志确认根因，再修改。长任务只做有间隔的状态查询，不要并行启动重复 workflow。
- 每次本次复盘新增的事实、修复和验证命令都要追加到本节，形成可追溯的自我学习记录；下次任务开始先阅读本节并执行前置检查。
- 用户最新范围变更（2026-08-28）：后续正式构建与 Release 只保留 Windows 桌面/服务器包和 Android APK；不再构建、上传或要求任何 macOS 客户端、服务器、完整离线包、Node.js macOS 包或 cloudflared macOS 二进制。修改工作流、资产清单和文档时必须同步移除 macOS 依赖，并验证 Windows/Android 核心功能不受影响；历史 Release 的 macOS 资产按历史保留规则不得删除。
- 复盘补充：取消未完成的原子运行可能留下部分旧资产（例如 6 个官方 Windows 文件）；下一次发布准备阶段允许识别并清理 6/10 的历史部分集合，但最终发布仍必须严格为当前 10 个 Windows/Android 维护者资产，不能把部分集合当作完成。
- 固定第三方分发文件（Node.js/cloudflared）统一作为一个长期保留的本地缓存集合（`.cache/release-third-party/`）保存：首次下载必须记录官方来源、版本、平台/架构和 SHA-256；后续版本直接从该集合复制到根目录 `dist/`，不再重复下载、生成或改名。复制前后仍必须逐项核对非空、文件名、版本/架构、官方来源和 SHA-256；任一校验失败立即停止，不得覆盖缓存或用占位文件替代。该缓存只适用于固定第三方分发文件，不包含 SyncWatch 应用安装包；macOS 应用包仍按上一条范围完全停用。
- 本地缓存已在 2026-08-28 填充并逐项回读验证：`node-v24.19.0-x64.msi`、`node-v24.19.0-arm64.msi`、`cloudflared-windows-x64.exe`、`cloudflared-windows-x64-installer.msi`、`cloudflared-windows-x86-installer.msi`；后续发布直接复用这 5 个文件，不重复下载。
- v2.2.6 原子发布运行 `33161440282` 的 Android 模拟器失败根因已确认：模拟器已正常启动，失败发生在 `adb install --no-streaming` 的系统包校验阶段（`INSTALL_FAILED_VERIFICATION_FAILURE: Integrity verification timed out`），不是 APK 构建或应用启动崩溃。修复：`scripts/android-emulator-smoke.sh` 仅在该明确错误下关闭隔离模拟器的 ADB 包校验并重试一次，其他安装错误仍立即失败；下次发布需从更新后的最终 tag 重新执行一次完整原子工作流。
- 原子发布运行 `33163785040` 未进入构建，源码门禁中的浏览器媒体恢复 smoke 在 45 秒人为断网后回放恢复进度为 0。该参数过长会在托管 runner 上耗尽 Chromium 缓冲，导致恢复 Range 路径无法观测；将 `tests/media-network-recovery-browser-smoke.js` 的有界断网窗口调整为 25 秒，保留恢复进度至少 5 秒和 Socket.IO 重认证断言，其他错误仍失败。下次仅重跑一次完整原子工作流。
- 原子发布运行 `33164365939` 的源码、Android、Windows 基础包和完整离线包构建均成功；失败仅发生在完整离线包成品门禁，原因是 434,550,852 字节的 Windows/Android 包被旧的 1 GiB 最低体积规则错误拒绝。修复：`scripts/release-candidate-gate.js` 将 Windows 完整离线包最低体积改为 300 MiB、上限保持 2 GiB，以匹配停用 macOS 后的真实闭包；下次从更新后的最终 tag 只执行一次完整原子发布。
- 原子发布运行 `33170193880` 的源码、Windows/Android 应用构建、模拟器启动和完整离线包均成功；最后发布收尾因先删除替换后的旧资产、再使用删除前的 `replacement-ready-release.json` 计算遗留资产，导致对已删除资产再次 DELETE 并返回 404。修复：删除替换旧资产后立即重新读取 Release，再计算并清理遗留资产；同一失败原因不得重复触发构建。
- 随后运行 `33172876079` 在准备阶段发现上一轮恢复留下 11 个资产（10 个当前 Windows/Android/官方文件 + 1 个旧 macOS 资产），原预检只允许 0/6/10/26，因而提前失败。修复：预检与上传阶段允许识别 11 项“当前 10 + 单个可清理遗留”状态，以便安全清理后完成 10 项正式资产发布；不放宽最终成品门禁。
- 用户补充的 v2.2.7 Windows 完整离线资产要求：必须上传并在 Release Assets 中核对 `SyncWatch-v2.2.7-Full-Offline-Installer-x64.exe` 与 `SyncWatch-v2.2.7-Full-Offline-Portable-x64.exe`。这两个文件必须由最终 v2.2.7 Tag 对应的修改后源码真实构建、完成启动/闭包/版本/非空大小/SHA-256 验证后上传；不得使用 v2.2.5 或其他旧包改名、占位文件或未验证文件替代。若本地或 Actions 尚未生成真实成品，Release 保持 `pending`，先完成构建和验证再上传。

本节把本项目历次对话中反复确认的长期要求集中保存，供后续 Codex 会话读取。它不是聊天记录的逐字复制；当同一主题出现冲突时，按“当前用户指令 → 当前代码/运行态 → 最新 Git 历史 → 本节历史要求”的顺序裁决。已经被后续指令撤销的要求只保留为“已覆盖”说明，不得重新执行。

### 1. 产品名称、仓库和署名

- 用户可见产品名称统一写作 **SyncWatch同步观影**；GitHub 仓库 slug 保持 `SyncWatch`。
- 当前仓库地址是 `https://github.com/xuange6610/SyncWatch`，GitHub Pages 是 `https://xuange6610.github.io/SyncWatch/`。README、Wiki、HTML、下载按钮、教程和 Release 正文不得继续使用旧的 `xuange6610-oss` 地址。
- 公开作者署名统一使用 `xuan`。源码、构建产物、截图、日志、压缩包、APK、EXE、Wiki 和 Release 资产不得出现用户真实姓名、真实身份字段、真实 IP、账号数据或其他个人隐私。
- 项目采用 Apache License 2.0；再发布者必须保留许可证、NOTICE、原始版权与修改说明，不得删除原始署名或把原项目/少量修改版本虚假宣传为自己的原创。Apache-2.0 的合法使用、修改、再发布和商业使用权利不能被额外收窄。
- 公开联系方式只从 README 和 Pages 当前实际内容读取；不要把联系方式、密码、邮箱授权码、Tunnel 令牌或签名密钥复制到源码、截图、测试数据或 Release 包中。

### 2. 产品能力与真实边界

- 产品定位是开源、自托管、跨平台 Watch Party/同步观影系统：服务器保存账号、房间、媒体索引、聊天和同步状态，客户端通过 HTTP 与 Socket.IO 加入。
- 长期保留并持续说明的核心能力包括：房间创建与加入、播放/暂停/拖动/倍速同步、媒体上传与字幕、聊天/私聊/弹幕/语音、屏幕或网页共享、账号与权限、管理中心、备份恢复、日志、局域网连接和可选 Cloudflare Tunnel/HTTPS 公网访问。
- 支持平台按 Release 中真实资产说明：Windows、Android、macOS（x64/arm64）和浏览器。GitHub Pages 仅是静态展示站，不得描述成可运行 Node.js、Socket.IO、上传、AI 或公网 Tunnel 的在线服务器。
- 超级管理员在登录页或管理入口验证后，直接停留在管理中心的服务器设置/权限设置，不自动进入观影房间；管理员主动选择房间后才进入观影流程。普通账号的登录、注册和入房流程保持不变。
- 服务器设置应能控制媒体上传、房间密码、公网访问、备份恢复、日志和下载入口；隐藏服务器客户端、苹果服务器、苹果客户端、安卓客户端等入口时，必须同步检查公开配置、前端按钮和权限校验。
- Android 页面要优先保证登录、连接、房间、同步播放、聊天、上传、全屏和屏幕共享等核心操作，竖屏按钮不得拥挤，触控目标要足够大；不为展示完整而堆叠不必要按钮。
- Android APK 不得宣传本机内嵌桌面版 `cloudflared` 或未经验证的“一键公网访问”。当前真实边界是：手机可连接局域网或已由 Windows/macOS/Linux/云服务器开启的 HTTPS/Tunnel；小米 14/HyperOS 真机在没有实际设备证据时必须标记“未验证”。

### 3. 发布版本和文件硬性要求

- 所有公开版本、分支、Tag、Release 标题、下载链接和公告使用 `vX.Y.Z` 前缀；`package.json` 和 Android 工具链字段保留纯数字 SemVer。当前源码候选版本为 `v2.2.7`，正式发布必须完成真实构建、哈希回读和 Release API 验证后才能切换为正式版。
- 每个正式 Release 必须有 **28 个可见文件**：26 个维护者真实资产，加 GitHub 自动生成的 `Source code (zip)` 和 `Source code (tar.gz)`。Release API 的维护者资产数必须为 26，不能用空文件、改名旧包、重复文件或占位文件凑数。
- 每次正式版本构建开始前，必须在项目根目录创建或准备唯一的 `dist/`，所有 **28 个最终交付文件都必须直接生成到该目录**：26 个经过验证的构建/运行资产，加与最终 Tag/提交一致的源码 ZIP 和 TAR.GZ。禁止先把正式成品生成到 `release/`、`dist-client/`、`dist-installer/`、`dist-full-portable/`、`dist-mac-*`、`output/`、项目根目录或其他位置后再复制/汇总；也不得在这些位置保留同一成品副本。构建配置、脚本和 GitHub Actions 必须以根目录 `dist/` 为最终且唯一输出路径。`dist/` 内少于或多于 28 个、存在旧版本、重复、空文件或哈希不一致时，都必须标记构建未完成，不得上传或宣称发布完成。
- `dist/` 中 28 个文件并非全部都是“启动程序”：GitHub 的两个源码归档用于审阅和自行构建，其余 26 个才是应用、安装包或运行工具。文档和交付清单必须如实区分，不能把源码归档宣传成可双击启动的软件。
- 26 个资产固定分组：Windows 体验版/标准版/完整版安装 EXE/完整版便携 EXE 4 个；Android 通用 APK 1 个；macOS 客户端 x64/arm64 DMG/ZIP 4 个；macOS 服务器 x64/arm64 DMG/ZIP 4 个；macOS 完整离线版 x64/arm64 DMG/ZIP 4 个；Node.js Windows x64/ARM64 MSI、macOS x64 PKG/arm64 tar.gz 4 个；cloudflared Windows x64 EXE、Windows x64/x86 MSI、macOS x64/arm64 二进制 5 个。
- 体验版用于连接已有服务器；标准版用于基本服务器运行；完整版安装 EXE 与完整版独立便携 EXE 都必须存在，且完整包应包含承诺的运行环境、cloudflared 和跨平台离线下载资源。安装程序不能替代独立 EXE，独立 EXE 也不能只做快捷方式。
- 每个资产上传前逐项核对版本、平台、架构、字节大小、SHA-256、非空状态、包内文件闭包和实际启动结果；macOS 包必须来自真实 macOS runner，不能在 Windows 上伪造。
- cloudflared 和 Node.js 独立文件必须在 Release、README、Wiki、Pages 教程中分别说明用途、适用系统、安装步骤、命令示例、官方来源和常见错误；完整 SyncWatch 包已内置运行环境时，要明确说明用户无需重复安装。
- 新版本发布顺序固定为：完成源码/配置/文档 → 本地运行和测试 → 真实构建 → 成品契约与哈希检查 → 仅清理当前版本旧资产 → 一次性上传完整 26 项 → 更新完整 Release 正文 → 发布并设为 Latest → 验证首页、latest、Actions、资产数量和下载链接。历史 Release、历史 Tag 和历史资产永远保留。
- 用户曾要求清理旧版本和无用文件；根目录当前正式 `dist/` 的完整 28 文件集合必须保留到下一版本 28 文件全部直接构建、测试、哈希验证并完成原子替换后才能清理。若发现 `release/`、`dist-*`、`output/`、项目根目录或其他位置存在构建成品或副本，应先确认 `dist/` 中对应 28 文件完整可用，再按精确路径删除这些违规残留。未跟踪 Wiki 镜像、签名密钥备份、个人资料和其他来源不明备份目录不得擅自删除；GitHub 历史版本不得删除。

### 4. README、Wiki 和文档要求

- README 第一屏先说明“和朋友、家人、情侣远程一起看电影”，放真实主界面截图、下载/在线预览/快速开始入口和核心优势，再讲技术实现。README 同时面向普通用户和开发者，保留安装、启动、改默认密码、创建房间、成员连接、公网访问、数据目录、常见错误、构建、Release、贡献、许可证和联系方式。
- Release 更新公告必须区分“从上一版本真实发生的变化”和“保持不变的功能”。每次版本公告都要逐项覆盖代码、功能、Android、Windows/macOS、UI/颜色/排版/交互、文档与链接、构建脚本、测试、Actions、资产和已知限制；不能只改版本号，也不能把旧功能冒充新增。
- Wiki 与仓库 `docs/wiki/` 保持可追溯镜像；教程要从打开窗口、输入命令、默认下载目录、启动完成、登录、创建/加入房间、客户端连接、公网访问、备份、升级和排错逐步写清，并解释每个按钮、字段、结果和操作示例。
- 主要 Markdown 教程必须同时有可阅读的 HTML 页面；HTML 页面可以有 3D/360° 互动、动画、截图、章节导航和“下载 Markdown 原文”入口，但动画不能妨碍正文、键盘操作、移动端布局或减少动态效果偏好。
- 管理中心 11 个模块必须各有独立 HTML 页面：房间与上传、全部房间、成员与权限组、聊天与记录、账户与注册、用户申请中心、账户权限等级、通知/通告设置、邮件设置、日志中心管理、服务器设置。每个模块的教程、按钮、字段、结果和示例必须对应真实功能；模块截图应清晰、脱敏、高清，并优先提供各模块自己的多张截图，不能用重复或无关截图套用。
- Pages 首页必须保留真实主界面展示、GitHub 主页跳转、下载入口、快速开始、架构、管理中心、错误处理、文件地图、运行环境、Release 说明、联系方式和打赏/联系图片交互（若资源存在）；Pages 仍然只负责展示和文档导航。

### 5. UI 与技能使用约束

- UI 设计要求是高级、克制、现代、科技感但可读，不要只换颜色或堆叠卡片；需要重新排版时必须保持原有内容、入口和功能，不得恢复用户已经明确撤销的 UI 修改。
- 设计/审计 UI 时优先使用仓库已安装的 `design-taste-frontend`（Taste）、`impeccable` 和 `ui-ux-pro-max` 能力；用户历史中提到的 `lmpeccable` 按同类 `impeccable` 能力处理，不要凭空引入不存在的技能。3D、动画和滚动效果必须服务于层级、导航和教程理解，不能产生遮挡、拥挤或 AI 模板感。
- 用户曾给出 React/Vite、Tailwind、Framer Motion、Lucide 的个人简历示例；该示例是视觉参考，不是 SyncWatch 的技术栈迁移指令。SyncWatch 当前真实前端是原生 HTML/CSS/JavaScript，除非用户再次明确要求并完成架构评估，不要为模仿示例而整体迁移框架。
- 接触移动端或桌面端 UI 时，必须做至少一个桌面视口和一个移动视口的真实浏览器/截图检查；用户可见的颜色、排版、动画或交互变化必须写入对应版本公告。

### 5.1 Codex 技能工作流

- 所有自然语言任务先经过全局 `skill-router`；只执行与当前任务相关的能力，并记录成功或失败。不要因为路由器误选 Office、图片、数据库、新闻或日历能力而扩大任务范围。
- UI/前端任务优先使用已安装的 `design-taste-frontend`（Taste）、`impeccable` 和 `ui-ux-pro-max`；用户所说的 `lmpeccable` 视为 `impeccable` 的拼写别名。先审计当前页面，再改版、验证和截图。
- 复杂实现、Bug 修复和发布收尾使用 Superpowers 类流程：先明确范围/计划，遵守测试驱动或最小回归测试，完成后做验证、代码审查和分支收尾。当前环境没有某个插件时，使用等价的本地规则和测试能力，不声称不存在的 skill 已执行。
- 用户曾提供 React/Vite、Tailwind、Framer Motion、Lucide 的个人简历网站作为视觉示范；这不是 SyncWatch 的迁移要求。只有用户再次明确要求并完成架构评估时，才考虑改变当前原生 HTML/CSS/JavaScript 技术栈。

### 6. 测试、验证和事实声明

- 常规文档/仓库变更至少运行 `npm run test:repo` 和 `git diff --check`；核心行为变更运行 `npm test`；发布变更还要运行 Android、桌面、cloudflared、隐私、成品契约及对应平台真实构建检查。
- Android 源码检查、APK 解包检查和模拟器结果不能代替真机验证。涉及登录、内嵌服务器、房间、断线重连或屏幕共享时，必须记录实际安装/启动/登录/连接证据；没有设备控制权就明确写“未验证”，尤其不能声称小米 14/HyperOS 已通过。
- 任何“已修复、已发布、已部署、可下载、支持某平台、测试通过”的结论必须有当前代码、GitHub API、Actions、运行日志、真实页面或成品检查证据；旧截图和聊天记忆只能作为线索。
- 任务完成前检查 `git diff`、`git status`、分支、remote、最近历史、Actions、Release 和 canonical 用户地址。发现失败、资产缺失、设备未验证或文档与代码冲突时，保留 `pending`/`未验证` 状态，不为了好看删除警告。

### 7. 当前发布快照

- 当前版本号为 `v2.2.6`，但该版本曾发生“公开 Assets 未包含当前修正源码”的交付问题。任何旧 Tag SHA、旧 Actions run、旧 26 个资产和旧哈希都只能作为线上基线，不能作为同版本更正版完成证据。必须从最终修正 Tag 重新构建 17 个应用资产、核验 9 个官方文件，并以当前 Actions、Release API、远端哈希、启动与核心流程结果重新证明交付。
- 同版本重传不得先清空公开 Assets。旧 26 项保持可用到新 26 项全部构建与本地门禁完成；最终安全切换时先短暂转草稿，以临时名上传并远端回读新资产，再切换正式名称。新集合完整验证前失败要恢复旧名称和公开状态；只有新集合通过后才能删除旧资产并重新公开为 Latest。
- 维护文档和 Release 说明中的版本、下载名、链接、哈希、大小和测试数量必须以当前 GitHub API、Actions 和源码为准。新会话开始时重新核对，不得只相信本快照。
- 目前没有小米 14/HyperOS 真机证据；后续若用户再次报告 Android 登录或服务器请求失败，先复现并增加回归测试，再重新构建 APK 和 Release，不得仅修改文案或重新命名旧 APK。
