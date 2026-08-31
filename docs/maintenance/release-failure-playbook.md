# SyncWatch 发布失败技术复盘与执行手册

本文只记录已验证的工程故障、根因、修复约束和发布顺序。它是发布排障的统一技术参考；产品功能说明以 `PRODUCT.md` 为准，固定资产名称以 `docs/release/release-manifest.md` 为准。

## 1. 发布状态模型

- `pending`：任一源码门禁、构建、启动、扫描、哈希、资产数量或远端回读未完成。不得上传残缺集合，也不得宣称发布完成。
- `draft`：资产可能已上传，但 Release 正文、数量、哈希或页面一致性尚未完成。不得设为 Latest。
- `published/live verified`：最终 Tag、源码、构建成品、Release API、下载回读、README、Pages、Wiki 和 Latest 全部一致。
- 失败运行产生的 artifact 只属于该次运行，不能作为正式 Release 文件；历史 Release、Tag 和历史资产不得删除。

## 2. 已确认的失败根因

### 2.1 源码、版本和 Tag 漂移

- Android 构建脚本曾写死 `versionCode 20209` / `versionName 2.2.9`，升级到 `v2.3.0` 后 Gradle 成功但元数据门禁失败。版本校验必须从 `package.json` 的 SemVer 动态计算并与 Android `versionName`、Tag 和 Release 目标一致。
- Docker、示例清单和部署配置残留旧版本文件名，会在构建前的平台契约阶段失败。版本升级后必须搜索旧版本字符串并运行平台契约测试。
- 必须锁定注释 Tag、提交哈希、树哈希和 Release 目标；修复提交后只移动唯一 `vX.Y.Z` Tag，再触发一次工作流。

### 2.2 PowerShell 表达式和脚本契约

- PowerShell 不应把 `Where-Object` 管道直接嵌入 `if (-or ...)` 条件；先收集数组再判断数量，避免合法版本被误报。
- 构建脚本的版本、架构、文件名和路径检查必须有静态契约测试，不能只依赖一次人工执行。

### 2.3 Windows Electron EPIPE 冒烟超时

故障都发生在 Windows 无头 Electron 生产 smoke 的退出生命周期，表现为 stdout/stderr 已触发 EPIPE，但进程在 20 秒内未退出。

- Electron 原生消息循环下，`unref()` 计时器可能永远不调度；测试兜底计时器必须保持引用。
- `app.quit()` / `app.exit()` 可能进入隐藏渲染器或原生窗口关闭流程；生产 smoke 的测试子进程在确定触发 EPIPE 后使用仅限测试场景的 `process.exit(0)`。
- `webContents.executeJavaScript()` 可能在调用本身同步阻塞主线程；超时 Promise 必须先创建，但更可靠的做法是在 `SYNCWATCH_SMOKE_MODE=1` 下跳过非必要的启动页脚本更新。
- `Tray` 初始化可能阻塞同一主线程；测试 smoke 可在 `SYNCWATCH_SMOKE_MODE=1` 跳过托盘初始化，正式程序仍必须创建托盘。
- 托管 Windows 的第二个隐藏 `BrowserWindow` 也可能让生产 EPIPE smoke 卡在 `app:browser-window-created`；仅在 `SYNCWATCH_EPIPE_CASE=production` 的测试分支跳过主窗口创建，其他 smoke 和正式程序仍创建完整主窗口。
- 每次调整生命周期都要记录阶段日志（窗口创建、EPIPE、强制退出），并用 `npm run test:epipe` 和静态契约测试锁定测试专用分支，不能改变正常应用关闭路径。
- 2026-08-31 的 `33365811610` 曾在 `app:browser-window-created` 后超时；该轮已取消且未产生正式资产。后续修复已由最终运行 `33370280271` 验证并成功发布，不能继续把该历史失败当作当前状态。

### 2.4 Android 模拟器和 ADB

- API 35 runner 不保证存在 `pixel_7` 硬件 profile；不要固定过时 profile，使用 runner 默认可用 profile。
- `INSTALL_FAILED_VERIFICATION_FAILURE` 属于 ADB 包校验超时，可只对隔离模拟器关闭校验并重试一次；其他安装错误必须立即失败。
- `Failure calling service input: Broken pipe (32)` 可能发生在 action 内部的 ADB 初始化，而不是 APK 崩溃。`reactivecircus/android-emulator-runner` 在 `script` 返回后会清理模拟器，因此不能把 smoke 拆到后置步骤；在同一 `script` 内等待 ADB、`sys.boot_completed`，再安装、启动、抓崩溃日志和截图。
- 原子运行 `33367347110` 在设备已启动后于 `adb install --no-streaming` 收到 `cmd: Failure calling service package: Broken pipe (32)`；APK 已成功构建，smoke 尚未进入版本/启动检查。该错误属于安装阶段的瞬态 ADB/package-service 断连：脚本现在最多重试 3 次，先 `adb reconnect device`、重启 ADB 并重新等待 `sys.boot_completed`；非该明确错误仍立即失败。修复后必须从新提交的最终 Tag 重新执行一次完整原子发布。

### 2.5 第三方文件与 GitHub API

- Node.js/cloudflared 是官方原始分发文件，不由项目源码生成。首次下载后保存到 `.cache/release-third-party/`，后续只复用已核验缓存，并逐项回读来源、版本、平台/架构、非空大小和 SHA-256。
- Full Offline 与 Windows base 即使已有同轮 artifact，也可能先访问 cloudflared manifest；GitHub API 请求必须显式传入 `GH_TOKEN: ${{ github.token }}`，否则匿名限流会返回 403。
- API 403 时先检查认证、缓存和请求顺序，不要盲目重跑或下载替代文件。

### 2.6 构建、资产和 Release 收尾

- Windows 完整离线包的体积门禁必须匹配当前平台闭包；停用 macOS 后最低体积改为 300 MiB，上限保持 2 GiB，不能用旧阈值误拒绝真实成品。
- 同版本替换必须先读取当前 Release，精确删除该版本维护者资产；删除后重新读取 Release，再计算遗留资产，避免对已删除对象再次 DELETE 导致 404。
- 预检要识别“当前 10 项 + 可清理遗留”状态（例如 11 项），清理后最终仍必须严格为 8 个维护者资产加 2 个 GitHub 源码归档。
- 5 个 SyncWatch 应用资产必须从最终 Tag 重新构建并完成启动/核心流程、版本、架构、非空大小、闭包、SHA-256 和 Microsoft Defender 验证；不能改名旧包、使用占位文件或只通过源码检查。
- Node.js/cloudflared 的 5 个官方文件必须单独核验来源和哈希，不能描述成 SyncWatch 启动程序。
- 发布收尾必须回读 Release API、下载链接、仓库首页、Pages canonical URL、Wiki 和 Latest；任一页面或链接仍指向旧版，状态保持 `pending`。

### 2.7 浏览器和媒体 smoke 的环境差异

- 无头 Chromium 可能报告不支持 `(hover: hover) and (pointer: fine)`；只在测试用例内部临时模拟精细指针媒体能力，产品端仍按真实设备能力判断。
- 浏览器媒体恢复 smoke 的人为断网窗口要有界；过长会耗尽 Chromium 缓冲，导致 Range 恢复进度为 0。保留可观测的恢复进度和 Socket.IO 重认证断言。

## 3. 固定执行顺序

1. 读取根目录 `AGENTS.md`、`docs/maintenance/maintainer-requirements.md` 和受影响的产品/设计/使用文档。
2. 检查 `git status`、当前分支、remote、最近提交、Tag、Release API 和 Actions；确认只有一个 `release/vX.Y.Z` 分支和一个目标注释 Tag。
3. 搜索旧版本字符串、旧资产名、平台退役引用和硬编码哈希；先修复契约漂移。
4. 本地运行受影响测试，至少包括 `npm run test:repo`、核心测试、平台契约、`npm run test:privacy`、`npm run test:epipe` 和发布工作流契约。
5. 提交并推送修复；核对提交哈希和工作树，再将唯一注释 Tag 移到该提交。
6. 只触发一次完整原子工作流。轮询只读状态，不并行启动重复运行。
7. 任何 job 失败时先读取 `gh run view <run> --json status,conclusion,jobs` 和失败 job 日志；必要时取消整轮。禁止用旧 artifact 或改名文件补齐。
8. 修复已确认的单一根因后，重复第 2 至 7 步；不为同一版本创建额外 release 分支或 Tag。
9. 只有源码门禁、Windows/Android 成品、模拟器启动、Defender、官方文件、8 项资产汇总和 10 文件审计全部成功，才允许替换当前版本资产。
10. 上传后逐项回读文件名、版本、平台/架构、大小、SHA-256、数量、下载响应和页面内容；全部一致后才设为 Latest 并标记 `published/live verified`。

## 4. 每次发布的最小证据集

```text
source: tag object, commit SHA, tree SHA, package/Android version
tests: source/repository/platform/privacy/epipe results
apps: Windows + Android build logs, startup/core-flow evidence, Defender result
third-party: official URL, version/arch, non-empty size, SHA-256
release: 8 maintainer assets + 2 source archives, API listing, remote hash readback
surfaces: README, Pages canonical, Wiki, Release body, Latest link
```

缺少任何一项时，发布状态为 `pending`，并保留失败日志和候选 artifact 的隔离边界。

## 5. v2.3.0 最终成功基线

- 注释 Tag 对象：`11203ae2587029415b7332b9409b22ac0f64bdaf`；目标提交：`c2086ca6fa1a64a4ffa117361ae42921b3ab4956`。
- 原子运行 `33370280271` 成功完成源码、官方文件、Android、Windows、Defender、10 文件审计、上传和远端 SHA-256 回读。
- Release API 有 8 个维护者资产，页面另有 2 个源码归档，v2.3.0 已公开为 Latest。
- 该 Tag 后的工作区改动不属于首次公开的 v2.3.0 资产。用户已授权执行同版本纠正覆盖；仍必须从新最终 Tag 重新执行本手册的完整证据链，并仅在新 8 项远端回读成功后删除被替换的 v2.3.0 旧资产。
