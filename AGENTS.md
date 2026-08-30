# SyncWatch 项目工作规则

当前工作分支为 `release/v2.2.9`，源码版本为 `v2.2.9`；最终构建、启动验收与 8 项维护者资产核验已完成并公开发布。

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
- Android 构建：`powershell -NoProfile -ExecutionPolicy Bypass -File .\mobile\build-apk.ps1`。

## 测试命令

- 仓库检查：`npm run test:repo`；核心测试：`npm test`；完整验收：`npm run test:all`。

## Git 提交规范

- 提交信息使用 `feat:`、`fix:`、`perf:`、`style:`、`refactor:`、`docs:` 等清晰前缀。
- 版本发布工作统一使用一个 `release/vX.Y.Z` 分支并通过 Pull Request 合并；不要为同一版本长期保留多个 `codex/*release*` 临时分支，已合并或放弃的临时分支应及时删除。

## GitHub 发布规范

- `main` 是稳定分支；功能在分支和 Pull Request 中验证后合并。版本由 `package.json`、Android `versionName`、Release tag 和发布说明共同更新，当前版本以源码和最新 Release 为准。
- GitHub Pages 由 `.github/workflows/pages.yml` 发布 `docs/`；Windows/Android Release 由对应 Actions 构建并上传，发布前必须先通过仓库规范和成品契约测试。
- 每个正式版本必须严格按当前 **10 个可见文件**发布：GitHub 自动生成的 `Source code (zip)` 与 `Source code (tar.gz)` 计 2 个，维护者实际上传的 Release 资产计 8 个。不得少传、增加重复资产或把部分集合宣称完整发布。
- 8 个维护者资产固定为：Windows 体验版、Windows 完整便携版（2）；Android 通用 APK（1）；Node.js Windows x64/ARM64 MSI（2）；cloudflared Windows x64 EXE、Windows x64/x86 MSI（3）。不再构建或上传 macOS 新包，历史 Release 资产保留。
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
- 发布运行只允许在“源码门禁成功 + 3 个应用资产真实构建验证 + 5 个官方文件来源/缓存核验 + 8 个维护者资产汇总验证”后覆盖 Release；在此之前状态必须保持 `pending`。
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
- v2.2.7 原子运行 `33182040163` 第一次失败原因：源码门禁执行 `scripts/collect-macos-distribution.ps1` 时，`mac-distribution.example.json` 仍含 `v2.2.6` 示例文件名，导致旧版本文件名被当前版本校验拒绝。修复：将示例清单中的 macOS 文件名更新为当前版本，并在本地通过 macOS 下载/便携包契约测试；后续触发前先搜索示例清单中的旧版本字符串。
- v2.2.7 原子运行 `33182622343` 第二次失败原因：`tests/platform-contracts.test.js` 按当前 `package.json` 版本检查 Docker 部署必须包含对应版本的 Android/Windows 客户端，但根目录 `Dockerfile` 与 `.dockerignore` 仍硬编码 `v2.2.6` 文件名，导致源码门禁在构建前失败。修复：同步更新为 `v2.2.7` 文件名；后续版本升级必须在版本字段变更后搜索 Docker/部署配置中的旧版本字符串并通过平台契约测试，再触发唯一一次原子构建。
- v2.2.7 原子运行 `33185461546` 于 2026-08-29 取消：三个 Node.js Mobile ABI 构建从 2026-08-28 15:36 起长时间无进展，未进入 APK/Full Offline 构建，不能继续等待或宣称发布完成。下一次应传入已成功运行 `33173061399` 生成且未过期的 `release-v2.2.6-33173061399-1-node-mobile-runtime` 作为已核验第三方运行时，避免重复编译 ABI；应用包仍必须从 v2.2.7 最终 Tag 重新构建。
- v2.2.7 原子运行 `33188078161` 取消前已确认复用运行时下载成功，但 combine 门禁仍硬编码旧 ABI SHA-256，导致历史已核验运行时的三个 `libnode.so` 被拒绝。修复：仅固定 Node.js 头文件哈希，改为校验运行时清单自带 SHA-256、三 ABI 数量和 16KB ELF 对齐，并在 Android 打包 job 允许已验证生成运行时；后续复用历史运行时前必须检查此门禁。
- 同一运行的源码契约测试还检查旧的三个 ABI 固定哈希，和新的“运行时清单 + ELF 对齐”策略冲突；已同步测试断言，避免代码门禁在发布前误报失败。
- v2.2.7 原子运行 `33183457621` 已取消，原因是旧版工作流仍包含 macOS base jobs，macOS Server arm64 检查失败且 Windows/Android 构建被依赖链阻断；复用仓库已有的 Windows+Android 发布收敛提交（停用 macOS job、切换 10+2 文件契约、复用第三方缓存和成品门禁修复）后，下一次才允许重新触发一次原子发布。
- v2.2.8 原子运行 `33248083944` 的源码门禁、官方资产、Android 签名构建和模拟器启动均成功；Windows base 在缓存未命中时未接收同轮 `official_assets` artifact，回退下载 cloudflared 被 GitHub API 403 拒绝。修复：`release/v2.2.8` 的 `windows_base` 显式依赖 `official_assets`，Windows reusable workflow 在准备 cloudflared 前下载同轮官方资产到 `.cache/release-third-party`，并由 `tests/release-atomic-workflow.test.js` 固化契约；必须从修复后的最终 Tag 重新执行一次原子发布。

- v2.2.9 原子运行 `33285110772` 的源码门禁、官方资产、Android 签名构建和 Windows base 构建均成功；失败仅发生在 Android 模拟器准备阶段，Ubuntu 22.04 的 API 35 SDK 镜像没有 `pixel_7` 硬件 profile，`avdmanager create avd` 返回 `No device found matching --device pixel_7`。修复：移除 `release-windows.yml` 中过时的 `profile: pixel_7`，让 `reactivecircus/android-emulator-runner` 使用当前 runner 可用的默认 profile，并在 `tests/release-atomic-workflow.test.js` 固化不得重新 pin 该 profile；应用包仍须从修复后的最终 Tag 重新执行一次完整原子发布。

### 2026-08-29 本轮新增功能与验证要求

- 网页浏览与共享分为两条真实路径：同步网址仅同步 URL、各端独立加载；启用前必须清空房间原视频/音频播放状态。要求一致实时画面时使用标签页或窗口共享，文案不得暗示 iframe 能同步画面。
- 本地视频封面由 FFmpeg 从视频中段随机时间截图生成；视频管理系统提供“批量随机封面”，仅允许当前房间本地视频，完成后广播 `file-updated`。第三方云端视频不在服务器截图范围内。
- 账户观影进度通过 `watch-progress` 保存并在认证响应中以 `resumeHistory` 返回；客户端选择未完成影片时提示继续播放，确认后发送权威 seek 命令。不要在未确认时静默跳转或影响其他房间成员。
- 本轮代码变更必须继续使用唯一 `release/v2.2.7` 分支，不创建额外分支；先完成测试、成品和远端状态核对，再触发一次新的原子发布。未完成构建前不得删除 v2.2.7 旧资产。
- 复盘补充：取消未完成的原子运行可能留下部分旧资产（例如 6 个官方 Windows 文件）；下一次发布准备阶段允许识别并清理 6/26 的历史部分集合，但最终发布仍必须严格为当前 10 个 Windows/Android 维护者资产，不能把部分集合当作完成。
- 固定第三方分发文件（Node.js/cloudflared）可作为已核验的本地缓存长期保留：首次下载必须记录官方来源、版本、平台/架构和 SHA-256；后续版本可直接从该缓存复制到根目录 `dist/`，不得重复生成或改名冒充应用包，但上传前仍必须逐项做非空、名称、版本/架构和 SHA-256 回读。缓存不包含 SyncWatch 应用安装包；macOS 应用包仍按上一条范围完全停用。
- 手机网页登录无法上下滑动的根因是移动端固定高度 `main` 与登录页嵌套滚动叠加全局 `body` 溢出策略，触摸手势被错误的滚动容器拦截；已改为移动端 `main`/登录页自动高度、文档统一滚动并保留 `touch-action: pan-y`，`tests/round29-layout.test.js` 增加对应 CSS 容器回归断言，桌面/移动浏览器烟测需继续覆盖。

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
- 当前新版本支持 Windows、Android 和浏览器；macOS 仅保留历史 Release 记录，不再构建或上传新包。GitHub Pages 仅是静态展示站，不得描述成可运行 Node.js、Socket.IO、上传、AI 或公网 Tunnel 的在线服务器。
- 超级管理员在登录页或管理入口验证后，直接停留在管理中心的服务器设置/权限设置，不自动进入观影房间；管理员主动选择房间后才进入观影流程。普通账号的登录、注册和入房流程保持不变。
- 服务器设置应能控制媒体上传、房间密码、公网访问、备份恢复、日志和下载入口；隐藏服务器客户端、苹果服务器、苹果客户端、安卓客户端等入口时，必须同步检查公开配置、前端按钮和权限校验。
- Android 页面要优先保证登录、连接、房间、同步播放、聊天、上传、全屏和屏幕共享等核心操作，竖屏按钮不得拥挤，触控目标要足够大；不为展示完整而堆叠不必要按钮。
- Android APK 不得宣传本机内嵌桌面版 `cloudflared` 或未经验证的“一键公网访问”。当前真实边界是：手机可连接局域网或已由 Windows、Linux 或云服务器开启的 HTTPS/Tunnel；小米 14/HyperOS 真机在没有实际设备证据时必须标记“未验证”。

### 3. 发布版本和文件硬性要求

- 所有公开版本、分支、Tag、Release 标题、下载链接和公告使用 `vX.Y.Z` 前缀；`package.json` 和 Android 工具链字段保留纯数字 SemVer。当前正式版本为 `v2.2.8`，已完成真实构建、哈希回读和 Release API 验证。
- 每个正式 Release 必须有 **10 个可见文件**：8 个维护者真实资产，加 GitHub 自动生成的 `Source code (zip)` 和 `Source code (tar.gz)`。Release API 的维护者资产数必须为 8，不能用空文件、改名旧包、重复文件或占位文件凑数。
- 每次正式版本构建开始前，必须在项目根目录创建或准备唯一的 `dist/`，所有 **10 个最终交付文件都必须直接生成到该目录**：8 个经过验证的构建/运行资产，加与最终 Tag/提交一致的源码 ZIP 和 TAR.GZ。禁止先把正式成品生成到其他位置后再改名冒充；构建配置、脚本和 GitHub Actions 必须以根目录 `dist/` 为最终输出路径。`dist/` 内少于或多于 10 个、存在旧版本、重复、空文件或哈希不一致时，都必须标记构建未完成，不得上传或宣称发布完成。
- `dist/` 中 10 个文件并非全部都是“启动程序”：GitHub 的两个源码归档用于审阅和自行构建，其余 8 个才是应用、安装包或运行工具。文档和交付清单必须如实区分，不能把源码归档宣传成可双击启动的软件。
- 8 个维护者资产固定分组：Windows 体验版与完整便携版 2 个；Android 通用 APK 1 个；Node.js Windows x64/ARM64 MSI 2 个；cloudflared Windows x64 EXE、Windows x64/x86 MSI 3 个。
- 体验版用于连接已有服务器；完整便携版用于开服务器并包含承诺的 Windows/Android 离线资源。标准版、完整安装版和 macOS 新包不再进入 v2.2.9 发布集合。
- 每个资产上传前逐项核对版本、平台、架构、字节大小、SHA-256、非空状态、包内文件闭包和实际启动结果。
- cloudflared 和 Node.js 独立文件必须在 Release、README、Wiki、Pages 教程中分别说明用途、适用系统、安装步骤、命令示例、官方来源和常见错误；完整 SyncWatch 包已内置运行环境时，要明确说明用户无需重复安装。
- 新版本发布顺序固定为：完成源码/配置/文档 → 本地运行和测试 → 真实构建 → 成品契约与哈希检查 → 仅清理当前版本旧资产 → 一次性上传完整 8 项 → 更新完整 Release 正文 → 发布并设为 Latest → 验证首页、latest、Actions、资产数量和下载链接。历史 Release、历史 Tag 和历史资产永远保留。
- 用户曾要求清理旧版本和无用文件；根目录当前正式 `dist/` 的完整 10 文件集合必须保留到下一版本 10 文件全部直接构建、测试、哈希验证并完成原子替换后才能清理。未跟踪 Wiki 镜像、签名密钥备份、个人资料和其他来源不明备份目录不得擅自删除；GitHub 历史版本不得删除。

### 4. README、Wiki 和文档要求

- README 第一屏先说明“和朋友、家人、情侣远程一起看电影”，放真实主界面截图、下载/在线预览/快速开始入口和核心优势，再讲技术实现。README 同时面向普通用户和开发者，保留安装、启动、改默认密码、创建房间、成员连接、公网访问、数据目录、常见错误、构建、Release、贡献、许可证和联系方式。
- Release 更新公告必须区分“从上一版本真实发生的变化”和“保持不变的功能”。每次版本公告都要逐项覆盖代码、功能、Android、Windows、UI/颜色/排版/交互、文档与链接、构建脚本、测试、Actions、资产和已知限制；不能只改版本号，也不能把旧功能冒充新增。
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

- 当前最新正式版本为 `v2.2.9`；最终注释 Tag 对象为 `f3fea87172734d1da9eeb74c1411c2076ed960f5`，指向提交 `bf659447f5cc3aac920ad4e4ce337a306eff585f`；Actions run `33330356910` 已完成 8 个维护者资产、2 个 GitHub 源码归档、Windows/Android 启动、Microsoft Defender、Latest 和远端哈希核对。v2.2.8 及更早版本的历史交付问题仅作复盘记录，不得覆盖当前状态。
- 同版本重传不得先清空公开 Assets。旧 8 项保持可用到新 8 项全部构建与本地门禁完成；最终安全切换时先短暂转草稿，以临时名上传并远端回读新资产，再切换正式名称。新集合完整验证前失败要恢复旧名称和公开状态；只有新集合通过后才能删除旧资产并重新公开为 Latest。
- 维护文档和 Release 说明中的版本、下载名、链接、哈希、大小和测试数量必须以当前 GitHub API、Actions 和源码为准。新会话开始时重新核对，不得只相信本快照。
- 目前没有小米 14/HyperOS 真机证据；后续若用户再次报告 Android 登录或服务器请求失败，先复现并增加回归测试，再重新构建 APK 和 Release，不得仅修改文案或重新命名旧 APK。

### 8. v2.2.7 本轮补充事实（2026-08-29）

- 在唯一 `release/v2.2.7` 分支补充了下载中心与房间/全屏交互：新版下载中心不再展示 macOS 新包入口，Windows 完整便携版行增加“推荐”高亮；macOS 历史 Release 不删除。
- 房间发现、局域网扫描和“我的房间”加入操作现在先提示正在加入，成功通知包含房间名称、房间号、正式/临时类型和房主信息。
- 全屏锁定按钮根据状态显示 `🔒` 或 `🔓`，切换时使用画面内轻量提示；顶部当前主题字段支持双击打开主题风格设置。
- 管理中心打开时先呈现窗口，再异步加载服务器设置，避免首屏空白卡顿；“我的房间”卡片增强名称、编号、类型、房主、密码状态、在线人数和备注层级，并支持窄屏换行。
- 本轮新增回归契约 `tests/v227-round2-contract.test.js`，覆盖 macOS 入口移除、便携版高亮、加入通知、全屏锁图标/提示、主题双击、管理中心加载标记和房间信息可读性。
- v2.2.7 已完成最终源码 Tag 对应的 Windows/Android 真实构建、10 个维护者资产哈希回读和 Release/Pages/Wiki 线上核对。不得使用旧包改名或占位文件。
- 发布收尾记录（2026-08-29）：Actions run `33198318200` 成功，Android 模拟器安装/启动、Windows 启动验证和 10 项 Release 资产均通过；PR #48/#49/#50 已将发布源码与文档合并到 `main`，Pages run `33202569238` 成功，`https://raw.githubusercontent.com/wiki/xuange6610/SyncWatch/Home.md` 已回读 v2.2.7。当前本机 `dist/` 仍只有历史 APK，不能把它宣称为 v2.2.7 的完整本地 12 文件集合；后续若用户要求本地成品，必须从最终 Tag 重新构建到 `dist/`，不得从 Release 下载后改名冒充。

### 9. v2.2.7 追加复核事实（2026-08-29）

- 完整离线安装版的新版资源范围固定为 Windows 与 Android，不再内嵌或展示 macOS 安装包；macOS 历史 Release 资产不得删除。
- 房主在自己房间的“房主控制”区域直接使用“房间设置”按钮进入管理中心的房间模块；顶部房间状态整栏双击可打开主题设置。
- 加入房间成功提示使用独立可读的状态层并标注房间名称、房间号、正式/临时类型和房主；全屏锁定/解锁使用 `🔒/🔓`、动态标题和画面内提醒，不弹出阻塞窗口。
- 管理中心继续采用先显示窗口、再异步加载设置的策略，隐藏模块使用延迟布局以减少首屏卡顿。
- 管理员密码安全边界不变：账号列表只返回密码状态和更新时间，管理员通过“设置新密码”协助用户，不得恢复或显示明文/哈希。
- 旧 Actions run `33193626192` 长时间停留在源码门禁且 `updatedAt` 不再变化；在取消前必须先记录状态和 job，取消后只能从最终 Tag 重新触发一次原子发布，禁止并行重复构建。

### 10. v2.2.7 原子发布失败复盘（2026-08-29）

- Actions run `33195045089` 的源码门禁、第三方运行时核验和 Windows/Android 输入校验均通过，但 Android job `98931577238` 在执行 `mobile/build-apk.ps1` 时失败：`armeabi-v7a/libnode.so` 实际 SHA-256 为 `1F5093C9EC2FBB730D0E9DE0F5E470FDE40B5D157EB4116D4BD7C01853CD2450`，脚本仍按旧官方归档固定值 `D0C41551...` 拒绝了同一运行 Linux combine job 已核验的 16 KB 生成运行时。
- 处理方式：取消已确定失败且仍占用 Windows runner 的运行；在 `mobile/build-apk.ps1` 中仅对显式 `SYNCWATCH_ALLOW_GENERATED_NODE_MOBILE=1` 的 CI 复用路径跳过旧 ABI 固定摘要（Linux combine job 仍负责来源闭包、三 ABI、SHA-256 和 ELF 16 KB 对齐核验），本地未设置该变量时继续执行官方固定摘要门禁；APK 打包后的旧摘要检查同样只在该显式 CI 模式放宽。
- 不得把本次失败运行的候选 artifact 当作发布资产，也不得用旧 APK 改名或占位文件替代；修复后必须从最终 `v2.2.7` Tag 只重跑一次完整原子工作流，并重新核对 Windows/Android 成品、哈希、Release 和文档页面。
- 同一修复后的运行 `33196278435` 中，Android Gradle 已成功生成 `versionCode='20207' versionName='2.2.7'`，但 `mobile/build-apk.ps1` 的 aapt 元数据门禁仍残留 v2.2.6 的 `20206/2.2.6`，导致在签名和 APK 载荷校验前失败；已将门禁更新为 v2.2.7，并要求后续版本同步检查脚本中的版本元数据，避免只更新 Gradle/输出文件名而遗漏验证值。
- 最终运行 `33197263433` 的 Android APK 已成功构建、签名与 `Assert-ApkPayload` 校验，但独立 `tests/android-package.test.js` 仍无视 `SYNCWATCH_ALLOW_GENERATED_NODE_MOBILE=1`，按旧 NDK 打包摘要拒绝了合法生成库（`arm64-v8a` 实际 `BCC0687F...B0209AA2`）。已让该测试在显式 CI 复用模式下接受格式正确的生成摘要，同时保留三 ABI 的非压缩、16 KB ZIP 对齐、ELF LOAD 对齐、源码闭包和载荷完整性检查；普通本地测试仍使用固定官方摘要。
- v2.2.7 修正版原子运行 `33219501154` 的源码、Windows 基础包、Android APK 与模拟器验收均成功；Windows 完整离线包失败于 cloudflared 官方资产下载返回 HTTP 403。根因是 `windows_full` 未等待 `official_assets`，命中旧的 18 MB 缓存后再次请求 GitHub API；修复为让 `windows_full` 依赖 `official_assets` 并下载同一运行的官方资产到 `.cache/release-third-party`，后续只允许重跑一次完整原子工作流。
- 本轮追加修复（2026-08-29）：账户菜单和“我的房间”自有房间卡片均提供“房间设置”入口；进入卡片入口时先切换到目标房间，再打开管理中心。房主范围通过 `managementScope='room-owner'` 强制只显示“房间与上传”“成员与权限组”“聊天与记录”三个导航模块，关闭窗口后恢复完整管理员导航；房间设置数据会通过当前会话重新读取，不能仅依赖旧表单默认值。
- 本轮追加修复（2026-08-29）：登录页在短窗口、网页缩放和高 DPI 下改为顶部起始、外层统一滚动，`.auth-card` 不再使用内部固定高度裁切；新增 `tests/v227-room-settings-login-layout.test.js` 契约测试。最终交付时，所有正式成品必须直接生成并保存在仓库根目录 `dist/`，先完成本地测试、非空/版本/平台/架构/SHA-256 与启动验证，再进行同版本 Release 安全替换；不能只留在临时构建目录或 GitHub Actions artifact。
- v2.2.7 原子运行 `33225695163` 首次重传在源码门禁的 `ui-copy-browser-smoke` 失败，原因是动态确认框密码切换按钮、增强下拉选择器触发器和批量随机封面按钮未纳入统一文案覆盖统计，覆盖率为 99.82%。修复：为动态控件增加 `data-copy-key` 绑定，隐藏模板按钮标记 `data-copy-ignore`；本地与 PR run `33225872074` 均验证按钮覆盖率 100%。后续新增动态按钮必须在文案运行时覆盖统计中有稳定绑定，发布前先运行该浏览器验收，避免只通过静态契约。

### 11. 本轮新增权限与倍速修复（2026-08-29）

- 房主调整共享倍速属于房主固有能力：服务端 `canControl` 和前端倍速控件都必须保证房主可用，不能因成员权限组或控制锁配置误伤房主。
- “跳过片头和片尾设置”使用独立权限键 `skipSettings`。默认成员/观众/协管组关闭，管理员组、房主、服务器主机和超级管理员始终开启；成员权限编辑器、权限组编辑器、权限回显和权限变更通知必须同步维护该字段。
- `room-playback-skip-settings` 必须在服务端以 `isRoomAdmin(user, 'skipSettings')` 重新校验；不能只依赖前端禁用控件。未授权成员提交必须返回失败，授权后立即广播 `room-skip-settings-updated`。
- 本轮回归重点：`tests/v224-backend.test.js` 覆盖房主倍速、未授权跳过设置拒绝、授权后允许和权限组继承；`tests/v224-frontend.test.js` 覆盖新增控件与保存字段。发布前先运行这些测试，再运行仓库/核心/隐私门禁。

### 12. v2.2.7 继续播放功能与最终发布收尾（2026-08-29）

- 账户级未完成影片进度已落地：服务端在认证响应返回 `resumeHistory`，客户端通过 `watch-progress` 保存进度，并在页面 `pagehide` 尽量冲刷最新位置；重新选择未完成影片时显示“继续上次观看”确认，确认后以权威 seek 恢复并同步房间。已通过 `tests/v227-room-settings-login-layout.test.js`、核心集成和浏览器文案验收。
- 原子发布 run `33226003174` 最终成功：源码门禁、Windows 体验/标准/完整安装/完整便携包、Android APK、Android 模拟器安装启动、官方 Node.js/cloudflared 核验、最终 12 文件审计、远端哈希回读和 Release 原子替换全部通过。
- v2.2.9 Release 当前为公开 Latest，维护者资产严格 8 项；注释 Tag `v2.2.9` 对象为 `f3fea87172734d1da9eeb74c1411c2076ed960f5`，指向最终构建提交 `bf659447f5cc3aac920ad4e4ce337a306eff585f`。Actions run `33330356910` 已完成 10 文件审计、远端哈希回读、Windows/Android 启动和 Microsoft Defender 验证。
- 首页 `https://github.com/xuange6610/SyncWatch`、Pages `https://xuange6610.github.io/SyncWatch/`、Wiki `Home.md` 和 v2.2.8 公告均已回读包含当前版本与手机登录滚动修复。

### 14. v2.2.7 重发门禁复盘（2026-08-29）

- 原子运行 `33229114210` 在源码门禁失败，唯一失败断言来自 `tests/browser-ui-smoke.js`：把服务器专用 `#loginHostShortcuts` 移到顶栏后，测试在模拟 Android 视口中仍把该组计入触控操作面板，初始高度从门禁要求的 480px 以下增至 531px。
- 修复方式：`body.android-client .login-host-shortcuts { display:none !important; }`。快捷入口只在桌面/Electron 服务端顶栏显示，不重复进入 Android 触控操作面板；重新运行 `node tests/browser-ui-smoke.js` 已返回 `success:true`，并生成桌面、移动和 Android 账号菜单截图。
- 失败运行未进入任何构建或 Release 上传，不得把其候选产物当成发布文件。当前最新提交为 `01aed20`，必须将唯一 `v2.2.7` 注释标签移动到该提交后再触发一次原子工作流；不得并行或创建额外分支。

### 15. v2.2.7 登录快捷按钮尺寸回归（2026-08-29）

- 用户截图复现 Electron 服务端登录页快捷按钮过大的问题：普通 `.login-host-shortcuts button` 已设为 30px，但 Electron 粗指针媒体规则会把按钮触控高度再次拉伸。
- 修复在 `public/css/style.css` 增加 `body.electron-server .login-host-shortcuts button` 专用覆盖，固定 `height/min-height: 30px`、11px 字号和紧凑内边距；五个服务器快捷入口仍全部保留，并仅在未登录或管理专用会话显示。
- `tests/round29-layout.test.js` 已加入覆盖断言；实际 Electron 浏览器测量为高度 30px、内边距 `3px 8px`、字号 11px，截图保存于 `output/playwright/login-shortcuts-compact.png`。`node tests/default-port-contract.test.js`、`node tests/round29-layout.test.js`、`npm run test:ui-close` 和单独 `npm run test:tunnel` 均通过；`npm run test:all` 仅有一次公网 Polling 瞬态断开，随后单独 Tunnel 冒烟重跑通过。

### 13. v2.2.7 登录页与账号总览修复（2026-08-29）

- 用户反馈服务器 Electron 登录窗口中快捷按钮挤压登录卡片、立体方块被推到视口外且滚轮无法完整浏览。修复为将 `#loginHostShortcuts` 固定放在顶栏中间操作区，使用单行横向滚动按钮；Electron 服务端加 `body.electron-server` 专用布局，登录页外层滚动、登录卡片不再内部裁切、立体方块保持可见。
- 用户反馈管理中心“账号总览”长期停留“正在同步账号状态”。根因是复用完整 `loadAdminSettings()`，任一设置/隧道读取异常都会阻断账号列表。新增服务端 `get-account-overview` action 与前端独立加载/错误态，只返回账号状态元数据，不返回明文或哈希。
- 本轮已通过 `node --check server/index.js`、`node --check public/js/app.js`、`node tests/account-admin-audit.test.js`、`node tests/round29-layout.test.js`、`npm test`、`npm run test:repo`、`npm run test:privacy` 与 `git diff --check`。桌面/移动浏览器截图检查已完成；Electron 原生窗口的真实交互仍以本机启动日志和源码契约为证，未使用额外分支。
- 由于本轮改变了 v2.2.7 最终 Tag 对应源码，线上 Release 仍是旧提交；提交并推送后必须从最终 Tag 重新触发唯一原子工作流。未完成前保持发布状态 `pending`，不得宣称旧 Release 包含本轮修改。

### 16. v2.2.8 手机登录滚动与登录音乐按钮复修（2026-08-29）

- 复核发现普通手机浏览器在 `max-width: 540px` 的后置规则重新把 `body:not(.android-client) main` 固定为视口高度，覆盖了早先的移动端自动高度修复；最终 CSS 覆盖必须让 `html/body/main/.login-page` 使用文档滚动、`overflow: visible` 和 `touch-action: pan-y`。
- 登录背景音乐静音按钮默认同时显示音量与静音两枚 SVG，视觉上像两个按钮；`.login-music-muted-icon` 必须默认 `display: none`，仅在 `.is-muted` 状态显示。
- `tests/browser-ui-smoke.js` 现对不带 `android-client` 的 390x844 登录页执行真实触摸滑动并断言 `scrollY` 增长；发布前继续运行该冒烟、`round29-layout`、仓库与核心测试，再从修复后的最终 Tag 重建并安全替换 v2.2.8 资产。

### 17. v2.2.8 登录音乐曲目同步修复（2026-08-29）

- 根因：前端保存时把旧 `url/title` 与新上传曲目合并，服务端又把旧列表再次拼接，导致更换文件后当前地址或名称仍指向旧曲目。
- 修复：登录音乐配置以完整 `tracks` 列表和 `currentTrackId` 为权威状态；当前名称、地址均从选中曲目派生。选择新文件会立即清除旧 HTTPS 输入并以文件名填入名称；单独 HTTPS 地址会创建列表曲目；显式空列表会清空旧地址、名称和本地文件。
- 验证：`node tests/login-music-upload-validation.test.js`、`node tests/latest26-backend.test.js`、`node tests/round29-backend.test.js`、`npm run test:repo`、`npm test`、`npm run test:privacy`、`node tests/browser-ui-smoke.js` 均通过。

### 18. v2.2.9 原子发布 Cloudflare API 限流复盘（2026-08-30）

- 原子运行 `33291265772` 的源码门禁、官方资产、Android 签名/模拟器启动和 Windows base 构建均成功；Windows Full Offline job `99206165386` 在准备 pinned cloudflared 时失败，`release-third-party-assets.js` 访问 cloudflared GitHub API 返回 HTTP 403。
- 根因是 Full Offline job 虽已下载同轮 `official` artifact 到 `.cache/release-third-party`，但脚本仍会先校验上游 manifest；该 job 没有显式注入 `GH_TOKEN`，匿名 API 请求在托管 runner 上触发限流。修复：Windows base/full 两个 pinned Cloudflare 校验步骤均传入 `GH_TOKEN: ${{ github.token }}`，并在 `tests/release-atomic-workflow.test.js` 固化认证契约。
- 失败运行未进入 Full Offline 打包、10 文件汇总或 Release 上传；不得使用候选 artifact。修复提交后必须将唯一 `v2.2.9` Tag 指向修复提交，再只触发一次完整原子发布。

### 19. v2.2.9 原子发布无头浏览器悬停能力复盘（2026-08-31）

- 原子运行 `33323029225` 的源码身份锁定成功，但源码门禁中的 `tests/browser-ui-smoke.js` 失败；Linux 无头 Chromium 报告 `(hover: hover) and (pointer: fine)` 为不匹配，因此产品代码按设计忽略合成的 `pointerenter`，测试却误判桌面悬停菜单没有展开。
- 修复仅在该浏览器冒烟用例内部临时模拟精细指针悬停媒体能力，并继续验证点击固定、点击外部关闭、悬停展开和移出关闭四条行为，结束后恢复原生 `matchMedia`；不得删除产品端的真实设备能力门禁。
- 该失败发生在任何应用构建和 Release 资产替换之前，线上 8 个维护者资产保持不变；修复经本地与 PR 门禁通过后，必须从新的最终注释 Tag 只触发一次完整原子发布。

### 20. v2.2.9 最终原子重发完成（2026-08-31）

- PR #66 的必需仓库检查通过后使用管理员权限合并；`main`、`release/v2.2.9` 和最终注释 Tag 对齐到 `ba18ae482ae3604a2bca92246eeb365b8236735f`。
- 原子运行 `33323728228` 成功完成源码门禁、官方运行时核验、Android 签名构建和模拟器启动、Windows 体验版与 Full Offline 构建启动、Microsoft Defender 扫描、10 文件审计、远端 SHA-256 回读和 Latest 发布。
- Release API 最终严格为 8 个维护者资产，页面另含 2 个 GitHub 源码归档；本轮替换没有删除或修改任何历史 Release、历史 Tag 或历史资产。

### 21. v2.2.9 顶栏菜单悬停兼容修复（2026-08-31）

- 用户再次反馈截图中的“选项 / 房间操作 / 设置 / 账号”菜单未按要求自动收起。根因是旧实现完全依赖 `(hover: hover) and (pointer: fine)` 媒体查询；Electron 或 Windows 触控笔记本即使有真实鼠标，也可能返回 `false`，导致悬停路径被跳过。
- 修复按真实 `pointerType` 判断桌面鼠标/触控笔，补充文档级 `pointermove` 关闭兜底，并让三组顶栏菜单与账号下拉互相关闭；未点击固定的菜单离开后自动收起，手机端仍只通过点击展开。
- 本地真实浏览器冒烟在强制媒体查询为 `false` 时验证三组菜单和账号入口的点击固定、点击外部关闭、鼠标移入展开和移出收起；核心集成、隐私、发布工作流契约和布局契约均通过。当时 v2.2.9 线上资产尚未替换，后续已从最终 Tag 重新构建并一次性重传完整 8 项资产（见下方最终原子重发记录）。

### 22. v2.2.9 Android 模拟器 ADB Broken pipe 复盘（2026-08-31）

- 原子运行 `33327086419` 的源码门禁、官方文件、Android 签名 APK 和 Windows 基础包均通过；失败发生在 `reactivecircus/android-emulator-runner` 启动后的内部 `adb shell input keyevent 82` / `settings put system screen_off_timeout` 初始化，runner 报 `Failure calling service input: Broken pipe (32)`，仓库 smoke 尚未执行，未替换线上 Release 资产。
- 失败后尝试把 smoke 拆到 runner 后续步骤，但 runner 会在每次 `script` 返回后无条件执行 `emu kill`，导致后置步骤无法连接设备；该方案已撤回。最终保留同一步 `scripts/android-emulator-smoke.sh`，仅由脚本重新等待 ADB 和 `sys.boot_completed`，再严格安装、启动、检查崩溃日志和截图；不得放宽 APK 版本、启动或崩溃门禁。
