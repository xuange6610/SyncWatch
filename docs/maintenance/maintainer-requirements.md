# SyncWatch 长期维护与交付要求

当前 `release/v2.3.0` 正在候选发布阶段；源码版本已切换到 `v2.3.0`，但在最终构建、启动验收、哈希和 8+2 文件核验完成前，Release `v2.2.9` 仍保持 Latest。

本文记录用户已经确认、需要后续 Codex 会话持续执行的现役要求。它是详细工作规范；根目录 `AGENTS.md` 是自动加载入口，具体产品、设计、使用和发布资产事实分别以 `PRODUCT.md`、`DESIGN.md`、`README.md` 和 `docs/release/release-manifest.md` 为准。

这些要求只适用于 SyncWatch同步观影。新项目只继承 Codex 全局 `AGENTS.md` 中的通用工作流程，不得自动继承本项目的名称、版本号、28 文件或平台清单。

## 1. 事实来源与优先级

1. 用户当前明确指令优先于历史要求。
2. 当前磁盘代码、Git 历史、构建配置、测试和已验证运行结果优先于聊天记录、旧截图或旧说明。
3. 文档与代码冲突时先核实代码和运行态，再修正文档；不能为了让文档“看起来完成”而虚构功能或成品。
4. 不确定的内容标记“待确认”或“未验证”，不得写成已经实现、已经测试或已经发布。
5. 历史请求若已被后续用户指令撤销，以当前代码和最新 Git 历史为准。例如当前 UI 基线是已完成回滚后的界面，不得根据更早的聊天再次恢复被撤销的重构。

## 2. 每次开始任务必须执行

1. 确认仓库根目录为 `SyncWatch同步观影`，读取根目录 `AGENTS.md` 和本文。
2. 按任务读取 `PRODUCT.md`、`DESIGN.md`、`README.md`、`docs/index.md` 以及 `docs/` 内相关专题。
3. 检查当前分支、`git status`、remote、最近相关提交和受影响文件历史；区分当前任务改动、用户已有改动与未跟踪备份。
4. 检查真实源码、配置、测试、构建脚本、GitHub Actions 和当前 Release/API 状态，不能只依据聊天摘要判断。
5. 使用 Skill Router 选择能力，但只执行与任务真实相关的技能；路由误选的 UI、Office、图片、数据库等无关能力不得扩大改动范围。
6. 在修改前明确受影响范围、验证方式和是否涉及版本、发布、外部写入或删除。

## 3. 实现与内容保留

- 除非用户明确要求删除，现有功能、按钮、教程、截图入口、下载说明和 Release 固定章节都必须保留。重新排版或重构不能减少内容或改变已经验证的业务行为。
- 修改应贴合现有模块和技术栈，避免为了形式引入新框架、生产依赖或大范围重写。
- 功能变化必须同时检查权限、错误、加载、空状态、移动端和失败恢复；按风险增加自动测试。
- 不能用改名旧包、占位文件、静态页面、模拟响应或只通过源码检查来冒充真实构建、运行测试、在线服务或平台支持。
- 用户要求修复缺陷时必须定位根因、增加回归测试并验证真实调用链；没有实际复现条件时要明确说明验证边界。

## 4. UI、网站与图文教程

- UI 修改前先读取 `DESIGN.md` 并审计当前界面。保持现有内容、操作入口、文案和业务状态，不得只换颜色后称为完整重构，也不得擅自恢复已经撤销的 UI 方案。
- 超级管理员登录页和管理中心验证表单必须使用管理专用会话：权限验证成功后直接停留在管理中心服务器设置，不能先显示观影房间；管理流程完成后由管理员主动进入房间。
- UI、颜色、排版、交互或动画发生任何用户可见变化，都要执行适当的桌面/移动端截图或浏览器验证，并写入对应版本更新公告。
- GitHub Pages 是静态展示站，不能宣称它运行 Node.js、Socket.IO、文件上传、AI 中转或 Cloudflare Tunnel。真实功能必须通过下载包或自托管服务器体验。
- 面向用户的主要教程入口应优先打开设计完成的 HTML 阅读页，同时保留 Markdown 源文档入口。3D 和动画不能妨碍正文阅读、键盘操作、移动端布局或“减少动态效果”偏好。
- 管理中心 11 个模块的图文必须与模块真实功能对应，不能重复套用无关截图；截图必须清晰、脱敏并能说明操作前后结果。
- 仓库、Pages、Wiki 和文档链接统一使用当前地址：`https://github.com/xuange6610/SyncWatch` 与 `https://xuange6610.github.io/SyncWatch/`。

## 5. 名称、署名、隐私与安全

- 用户可见产品名称使用 `SyncWatch同步观影`；仓库 slug 保持 `SyncWatch`；公开作者署名统一使用 `xuan`。
- 源码、文档、截图、安装程序、APK、压缩包、日志和 Release 资产不得暴露用户真实姓名或其他私人身份字段。构建前运行 `npm run test:privacy`，发布成品后运行 `npm run test:privacy:release`。
- 不提交或上传管理员密码、SMTP 授权码、Tunnel 令牌、签名密钥、Cookie、真实 IP、聊天记录、媒体文件名或 `SyncWatch同步观影-Data/` 运行数据。
- 首次使用说明必须提醒用户立即修改默认管理员密码，并先完成局域网测试，再开启公网访问。
- 安全问题按 `SECURITY.md` 处理；公开 Issue 和截图只能使用脱敏数据。

## 6. 版本升级

- 同一个版本只保留一个正式 `release/vX.Y.Z` 工作分支；不要并行遗留多个 `codex/*release*` 临时分支，临时分支在合并或放弃后立即精确删除。
1. 使用 `release/vX.Y.Z` 分支承载待发布更新；`main` 保持可验证的最新稳定源码。
2. 同步更新 `package.json`、锁文件/构建配置中的版本、Android `versionName`/`versionCode`、协议或公开配置版本、文件名、下载链接、文档、Wiki、tag 和 Release 标题。Git 标签、Release 标题/URL、发布分支和用户可见版本必须使用 `vX.Y.Z`；不得同时保留 `X.Y.Z` 与 `vX.Y.Z` 两个标签。`package.json` 和 Android `versionName` 按工具链要求继续使用纯数字 SemVer `X.Y.Z`。
3. 不能只修改显示文字或旧文件名冒充新版本；所有包必须从目标提交真实构建。
4. 发布完成后确认仓库首页和 `releases/latest` 指向当前最新版本，分支、tag、Release 和源码版本关系清楚可核验。
5. 普通文档维护不自动递增版本或移动历史 tag；只有实际版本发布流程才更新版本标识。

## 7. GitHub Release 固定标准

- 每个正式版本严格遵守 [Release 资产清单](../release/release-manifest.md)：8 个维护者真实资产，加 GitHub 自动生成的 2 个源码归档，页面共 10 个可见文件。
- 固定分组为 Windows 体验版与完整便携版 2、Android 1、Node.js Windows 2、cloudflared Windows 3。任何缺失、重复、空文件或额外旧式资产都不算完整发布。
- Windows 当前只提供体验版和完整离线便携版；标准版和完整安装版不进入 v2.2.9 新发布集合。
- 完整离线便携版必须包含其承诺的服务器运行环境、cloudflared、Windows 客户端和 Android APK 离线资源，并通过文件闭包与体积门禁。
- v2.2.9 起不再构建或上传 macOS 新包；Android APK 必须使用项目发布签名并包含声明的 ABI，历史 macOS Release 资产不得删除。
- 每个资产发布前核对名称、版本、平台、架构、非空字节大小、SHA-256、包内文件和实际启动/功能结果。
- 任何历史 Release、历史 tag 和旧版本资产都必须保留。发现当前版本资产有问题时，只能处理当前版本维护者资产；修复验证后必须一次恢复完整 8 项，再对外宣称完成。
- GitHub API 资产数不足 26、网页总数不足 28 或 Actions/验收失败时，版本状态必须标记未完成。

## 8. Release 正文与更新公告

- Release 第一屏必须包含：产品简短介绍、首次修改默认管理员密码提示，以及“下载文件 / 版本标识 / 最适合谁 / 一句话说明”表格。
- 每个下载名称必须是可点击的当前版本真实资产链接，并说明体验版、完整便携版、平台/架构、用途、运行方式和必要环境。
- 永久说明必须保留上一正式版本已有的完整结构，包括“普通用户怎么选”“Windows + Android 套装”“一键运行包含什么”“架构支持边界”“cloudflared 独立工具”“Node.js 官方环境包”“首次启动”“安全与许可”。
- “从上一版本到当前版本的更新公告”只列实际变化；未变化的功能放在“保持不变”中，不能把旧功能重新包装成新增。
- 公告必须逐项检查并写全：版本字段、缺陷修复、Android、Windows、UI/颜色/排版/交互、文档与链接、构建脚本、测试、Actions、Release 资产和已知限制。任何实际提交中的用户可见变化都不能遗漏。
- 公告中的能力、测试数量、设备、哈希、文件大小和在线状态必须有代码、日志、Actions 或 Release API 证据。

## 9. Android 验收要求

- Android 源码检查和 APK 解包检查只是前置门禁，不能单独证明手机可用。
- 与登录或手机服务器有关的修复至少验证：APK 安装、内嵌 Node.js 服务启动、管理员登录、普通成员或游客登录、进入同一房间、断开与重新连接，并检查 Logcat 无对应 FATAL、Node 退出或服务端事件异常。
- 保留 Node.js Mobile 18 对缺少 `crypto.randomUUID` 和全局 `Intl` 的兼容回归测试；修改相关服务端逻辑时运行 `npm run test:android-node-compat`。
- 用户报告特定真机问题时，应尽量在该设备或等价系统环境复现；没有设备控制权时必须明确写“该真机未验证”，不能声称已经在该机型测试通过。
- Android 本机服务器可用于本机、同一 Wi-Fi 或热点局域网。APK 不内嵌桌面系统的 cloudflared；手机跨网连接应使用已开启 Tunnel/HTTPS 的 Windows、Linux 或云服务器，不能虚假宣传手机本机一键 Tunnel 已实现。

## 10. 文档、Wiki 与贡献流程

- README 面向普通用户和开发者：先说明产品价值、真实主界面和下载入口，再讲技术架构；新手步骤要从下载、启动、登录、改密码、创建房间、成员连接一直写到公网访问和排错。
- `docs/index.md` 是仓库文档导航；用户操作变化更新 README/使用文档，产品能力变化更新 `PRODUCT.md`，UI/架构变化更新 `DESIGN.md`，长期技术知识更新 `docs/`。
- GitHub Wiki 与仓库内 `docs/wiki/` 保持可追溯镜像；不能把 Wiki 页面存在当成同步完成，需核对真实 Wiki 仓库或在线页面。
- 外部贡献采用 Fork/分支/Pull Request，原则上在维护者审核和自动检查通过后合并；如果用户在当前对话明确授权使用仓库管理员权限合并指定 PR，可仅针对该 PR 使用管理员合并满足必需 Review 门槛，但仍必须自动检查通过、核对提交身份，不得强推、改写历史或跳过构建、成品、隐私和资产门禁。未经确认的贡献不得直接覆盖稳定源码。

## 11. Git、上传与本地清理

- 提交信息使用 `feat:`、`fix:`、`perf:`、`style:`、`refactor:`、`docs:`、`test:`、`ci:` 或 `release:` 等清晰前缀。
- 推送前检查 diff、状态、分支和 remote；版本发布后核对目标 commit、tag、Release、Actions 和用户实际访问地址。
- 不重写或删除重要 Git 历史，不使用占位提交掩盖缺少的成品，不覆盖用户已有工作。
- 本地 `release/`、`dist*/`、`output/` 中被新构建取代的旧成品，只能在新包验证和发布完成后按精确路径清理。未跟踪备份、签名材料、Wiki 副本和来源不明目录未经用户确认不得删除。
- 本地成品清理不等于 GitHub 历史清理；历史版本 Release 和资产始终保留。
- 本次版本发布必须一次完成：先完成所有代码、配置、文档和测试改动，再在本地运行回归测试与必要 build；确认真实成品、SHA-256、平台架构和当前 10+2 文件清单均通过后，才删除当前版本 Release 中的旧维护者资产并完整上传新资产。中途不能先上传部分文件，也不能用占位文件凑数；任何一项未验证都必须暂停发布并标记未完成。
- 固定 Node.js/cloudflared 分发文件只需首次下载并核验后保存在 `.cache/release-third-party/` 这一份本地缓存集合；后续版本直接复用该集合并复制到 `dist/`，但每次上传前仍须回读官方来源、版本/架构、非空大小和 SHA-256。缓存文件损坏或校验不一致时停止发布，不得重新命名旧包或用占位文件凑数；SyncWatch 应用安装包不适用此复用规则。
- 每个上传文件必须来自当前修改后源码的真实构建，或来自已核验官方来源的第三方分发；应用包上传前必须完成启动与核心流程验证，并记录版本、平台/架构、大小和 SHA-256 证据。旧包改名、占位文件和仅源码通过均不得上传。
- Windows Full Offline 便携包在上传前必须由构建机 Microsoft Defender 完成自定义扫描，确认防病毒服务可用、目标文件未被隔离且没有针对该路径的检测记录；扫描不可用或发现威胁时停止发布。当前没有受信任 Windows 代码签名证书，不能把 Defender 单机扫描宣称为“所有杀毒软件永不误报”，也不能用自签名证书冒充受信任发行者。

## 12. 每次任务完成必须执行

1. 检查 `git diff --check`、`git diff`、`git status` 和最终文件范围。
2. 运行与风险相称的测试；常规门禁至少考虑 `npm run test:repo` 和 `npm test`，发布任务还要运行平台与成品契约。
3. 运行必要 build 或真实运行验证；缺少平台环境时明确列出未运行项。
4. 按实际变化同步 `PRODUCT.md`、`DESIGN.md`、`README.md`、`docs/`、Wiki 与 Release notes，避免无意义全量重写。
5. 涉及发布时核对 8 个 API 资产、10 个页面可见文件、哈希、大小、下载链接、Release 正文、latest 标记和 Actions 状态。
6. 涉及线上页面时验证 canonical URL，而不只检查本地文件或缓存规避链接。
7. 最终汇报必须说明改了什么、提交/分支、测试与构建证据、线上状态、未验证项和剩余风险。
8. 未经最终确认不删除用户备份或无法恢复的材料；不得为了“看起来干净”隐藏残留和警告。

## 13. 当前发布基线

- 当前线上正式版本：`v2.2.9`；Release API 有 8 个维护者资产，GitHub 页面另含 2 个源码归档，Latest 已指向本版本。旧版本资产仍仅作历史记录。
- 当前候选版本：`v2.3.0`；唯一发布分支为 `release/v2.3.0`，待 PR 合并和原子发布工作流完成后再更新正式版本快照。
- 当前仓库：`https://github.com/xuange6610/SyncWatch`。
- 当前源码与发布状态：`v2.2.9` 的最终注释 Tag 对象 `f3fea87172734d1da9eeb74c1411c2076ed960f5` 指向提交 `bf659447f5cc3aac920ad4e4ce337a306eff585f`；Actions run `33330356910`、8 个维护者资产、2 个源码归档、Latest 和远端哈希均已核对完成；Windows 体验版/完整便携版、Android 模拟器和 Microsoft Defender 扫描均通过。
- 当前 Pages：`https://xuange6610.github.io/SyncWatch/`。
- v2.1.7、v2.1.8、v2.1.9、v2.2.0、v2.2.3、v2.2.4、v2.2.5、v2.2.6、v2.2.7、v2.2.8 的历史 Release 保持不变；v2.2.9 当前为 Latest。
- 版本、资产或在线状态变化后必须更新本节和对应权威文档；不得让该快照长期冒充新状态。

### 14. v2.2.9 原子发布模拟器复盘（2026-08-30）

- 原子运行 `33285110772` 的源码门禁、官方资产、Android 签名构建和 Windows base 构建均成功；失败仅发生在 Android 模拟器准备阶段，Ubuntu 22.04 的 API 35 SDK 镜像没有 `pixel_7` 硬件 profile，`avdmanager create avd` 返回 `No device found matching --device pixel_7`。修复：移除 `release-windows.yml` 中过时的 `profile: pixel_7`，让 `reactivecircus/android-emulator-runner` 使用当前 runner 可用的默认 profile，并在 `tests/release-atomic-workflow.test.js` 固化不得重新 pin 该 profile；应用包仍须从修复后的最终 Tag 重新执行一次完整原子发布。

### 15. v2.2.9 原子发布 Cloudflare API 限流复盘（2026-08-30）

- 原子运行 `33291265772` 的源码门禁、官方资产、Android 签名/模拟器启动和 Windows base 构建均成功；Windows Full Offline job `99206165386` 在准备 pinned cloudflared 时失败，`release-third-party-assets.js` 访问 cloudflared GitHub API 返回 HTTP 403。
- 根因是 Full Offline job 虽已下载同轮 `official` artifact 到 `.cache/release-third-party`，但脚本仍会先校验上游 manifest；该 job 没有显式注入 `GH_TOKEN`，匿名 API 请求在托管 runner 上触发限流。修复：Windows base/full 两个 pinned Cloudflare 校验步骤均传入 `GH_TOKEN: ${{ github.token }}`，并在 `tests/release-atomic-workflow.test.js` 固化认证契约。
- 失败运行未进入 Full Offline 打包、10 文件汇总或 Release 上传；不得使用候选 artifact。修复提交后必须将唯一 `v2.2.9` Tag 指向修复提交，再只触发一次完整原子发布。

### 16. v2.2.7 登录快捷按钮尺寸回归（2026-08-29）

- Electron 服务端登录页的五个服务器快捷入口必须保留，但按钮必须保持紧凑：`public/css/style.css` 中普通规则和 `body.electron-server` 粗指针覆盖均固定 30px 高；Electron 实测高度 30px、内边距 `3px 8px`、字号 11px。
- 新增/维护 `tests/round29-layout.test.js` 中的 CSS 回归断言，防止通用触控目标样式再次覆盖桌面快捷入口。入口在普通观影房间隐藏，Android 客户端不复制到触控操作面板。
- 本轮验证：默认端口契约、Round 29 布局契约、`npm run test:ui-close`、`npm run test:tunnel` 通过；完整 `npm run test:all` 的唯一失败是公网 Polling 瞬态断开，随后独立 Tunnel 冒烟重跑通过。

### 17. v2.2.9 原子发布无头浏览器悬停能力复盘（2026-08-31）

- 原子运行 `33323029225` 已通过源码身份锁定，但源码门禁中的 `tests/browser-ui-smoke.js` 失败。Linux 无头 Chromium 报告不具备 `(hover: hover) and (pointer: fine)`，产品端因而正确忽略合成的悬停事件，旧测试却要求菜单必须展开。
- 冒烟测试应只在该用例内部临时模拟精细指针悬停媒体能力，保留点击固定、点击外部关闭、悬停展开和移出关闭四项断言，并在用例结束后恢复原生 `matchMedia`；产品端设备能力判断不放宽。
- 本次失败未进入 Windows/Android 构建，也未替换当前 Release 的 8 个维护者资产。修复必须先通过本地和 PR 检查，再移动唯一注释 Tag，并且只重新触发一次完整原子发布。

### 18. v2.2.9 最终原子重发完成（2026-08-31）

- PR #66 的必需仓库检查通过后使用管理员权限合并；`main`、`release/v2.2.9` 与最终注释 Tag 对齐到 `ba18ae482ae3604a2bca92246eeb365b8236735f`。
- 原子运行 `33323728228` 成功完成源码门禁、官方运行时核验、Android 签名构建及模拟器启动、Windows 体验版和 Full Offline 构建启动、Microsoft Defender 扫描、10 文件审计、远端 SHA-256 回读及 Latest 发布。
- Release API 最终为 8 个维护者资产，页面另有 2 个 GitHub 源码归档；README、Pages、Wiki 和 Release 正文必须继续以本次最终证据为准。

### 19. v2.2.9 顶栏菜单悬停兼容修复（2026-08-31）

- 用户再次反馈截图中的“选项 / 房间操作 / 设置 / 账号”菜单未按要求自动收起。根因是旧实现完全依赖 `(hover: hover) and (pointer: fine)` 媒体查询；Electron 或 Windows 触控笔记本即使有真实鼠标，也可能返回 `false`，导致悬停路径被跳过。
- 修复按真实 `pointerType` 判断桌面鼠标/触控笔，补充文档级 `pointermove` 关闭兜底，并让三组顶栏菜单与账号下拉互相关闭；未点击固定的菜单离开后自动收起，手机端仍只通过点击展开。
- 本地真实浏览器冒烟在强制媒体查询为 `false` 时验证三组菜单和账号入口的点击固定、点击外部关闭、鼠标移入展开和移出收起；核心集成、隐私、发布工作流契约和布局契约均通过。当时 v2.2.9 线上资产尚未替换，后续已从最终 Tag 重新构建并一次性重传完整 8 项资产（见下方最终原子重发记录）。

### 22. v2.2.9 Android 模拟器 ADB Broken pipe 复盘（2026-08-31）

- 原子运行 `33327086419` 的源码门禁、官方文件、Android 签名 APK 和 Windows 基础包均通过；失败发生在 `reactivecircus/android-emulator-runner` 启动后的内部 ADB 输入/设置超时命令，错误为 `Failure calling service input: Broken pipe (32)`，仓库 smoke 尚未执行，线上 Release 资产保持不变。
- 尝试拆分 runner 与 smoke 后确认该 action 会在 `script` 返回后无条件清理 emulator，后置步骤无法复用设备，因此撤回拆分方案。最终保留同一步仓库 smoke，并在脚本中重新等待 ADB/`sys.boot_completed`；安装、启动、崩溃日志和截图门禁仍严格执行。修复提交合并并移动最终注释 Tag 后只触发一次完整原子发布。

### 23. v2.3.0 首次原子运行构建门禁复盘（2026-08-31）

- 原子运行 `33353935801` 的源码门禁、官方资产与 Node.js Mobile 运行时复用均通过；Android 构建在 Gradle 成功后被 `mobile/build-apk.ps1` 的 APK 元数据检查拒绝，原因是校验仍写死 `versionCode 20209` / `versionName 2.2.9`。
- 同一运行的 Windows 基础包在 `tests/epipe-smoke.js` 的生产 Electron 退出阶段超过 20 秒，停在窗口创建后的生命周期；本地重复运行可稳定通过。修复为让启动页脚本执行具备 2 秒有界超时，避免无头页面脚本阻塞服务器启动和 smoke 退出。
- Android 校验现从 `package.json` 的数字 SemVer 动态计算 `major*10000 + minor*100 + patch`，并匹配当前 `versionName`；本地 `npm run test:repo`、`node tests/android-package.test.js --source-only`、`node tests/release-atomic-workflow.test.js`、`npm run test:epipe` 均通过。
- 失败运行未进入 Windows/Android 应用成品上传、10 文件审计或 Release 资产替换；下一步必须提交并推送修复、移动唯一 `v2.3.0` 注释 Tag 后仅重新触发一次完整原子发布。

### 24. v2.3.0 第二次原子运行门禁复盘（2026-08-31）

- 原子运行 `33354804242` 已通过源码、官方文件和运行时复用；Android 失败原因为 PowerShell 将 `Where-Object` 管道直接置于 `if -or` 条件，合法版本 `2.3.0` 仍被判定为非法；Windows EPIPE 生产 smoke 在隐藏渲染器关闭阶段仍超过 20 秒。
- 修复为先把非法版本段收集到数组再判断数量；仅在 `SYNCWATCH_EPIPE_CASE=production` 的专用 smoke 场景使用 `app.exit(0)`，普通启动与其他 smoke 仍走优雅 `app.quit()`。本地 PowerShell 解析、`npm run test:epipe`、`npm run test:repo`、Android 源码门禁和原子工作流契约均通过。
- 该失败运行未生成或上传应用资产，未替换 v2.2.9；下一次从新修复提交移动唯一 `v2.3.0` 注释 Tag 后再触发一次完整原子发布。

### 25. v2.3.0 第三次原子运行 EPIPE 复盘（2026-08-31）

- 原子运行 `33355477589` 的源码、官方文件和 Node.js Mobile 运行时复用通过；Android 已进入构建，Windows 仍在生产 EPIPE smoke 的隐藏渲染器退出阶段超时，未生成应用资产。
- EPIPE 专用子进程现先保留生产入口的优雅退出请求，并在 5 秒测试兜底后调用 `app.exit(0)`；仅作用于 `tests/epipe-electron-child.js` 的生产 smoke，不改变正常应用和其他 smoke 的关闭路径。修复后本地 `npm run test:epipe` 与原子工作流契约通过。
- 该运行未替换任何 Release 资产；需将候选标签移动到本修复提交后再触发一次完整原子发布。

### 26. v2.3.0 第四次原子运行 EPIPE 复盘（2026-08-31）

- 原子运行 `33357161907` 使用 `f84b4db` 候选标签；Android 签名构建已通过并进入模拟器验收，Windows 仍在生产 Electron EPIPE smoke 的隐藏渲染器退出阶段超时，整轮在生成/上传应用资产前取消，线上 `v2.2.9` 资产保持不变。
- 根因仍局限于测试子进程优雅退出请求在无头 Windows runner 中未及时结束；将 `tests/epipe-electron-child.js` 的 5 秒测试专用兜底从 `app.exit(0)` 改为 `process.exit(0)`。该兜底只在 `SYNCWATCH_EPIPE_CASE=production` smoke 生效，不改变正常应用关闭路径，也不跳过 EPIPE 断言。
- 修复后必须先通过本地 EPIPE、仓库和发布工作流契约，再移动唯一 `v2.3.0` 注释标签并只触发一次完整原子发布；失败运行的候选 artifact 不得作为 Release 资产。

### 27. v2.3.0 第五次原子运行 EPIPE 复盘（2026-08-31）

- 原子运行 `33358197230` 的源码门禁、官方文件、Node.js Mobile 复用和 Android 签名构建均通过；Windows 日志确认 stdout/stderr 已真实产生 EPIPE，但 5 秒测试兜底没有执行，生产 smoke 在 20 秒后超时。整轮已强制取消，未生成或上传 Windows/Full Offline/正式 Release 资产。
- 根因是测试兜底计时器调用了 `unref()`；GitHub Windows Electron 在只剩原生消息循环而没有 Node 引用型句柄时，不保证调度该计时器。修复为保留 5 秒计时器引用，触发前记录 `smoke:force-exit`，再调用仅限测试子进程的 `process.exit(0)`；EPIPE 真实触发与退出码断言仍保留。
- `tests/epipe-smoke.js` 增加静态契约，防止该强制退出计时器再次被 `unref()`。下一次触发前必须通过本地 EPIPE、仓库与发布工作流契约，并从新的最终候选标签只运行一次完整原子发布。

### 28. v2.3.0 第六次原子运行 EPIPE 复盘（2026-08-31）

- 原子运行 `33360205011` 的源码、官方文件、Node.js Mobile 复用和 Android 签名构建均通过；Windows EPIPE 日志确认 stdout/stderr 已产生多次 EPIPE，但生产 smoke 在 20 秒后超时，且子进程 5 秒兜底没有写入 `smoke:force-exit`。该轮已取消，未生成或上传 Windows/Full Offline/正式 Release 资产。
- 根因是生产 smoke 的 1.6 秒 `app.exit(0)` 先进入 Electron 关闭生命周期，Windows runner 在隐藏渲染器阶段不再调度 Node 定时器；因此子进程计时器即使保持引用也无法执行。修复为在 `SYNCWATCH_EPIPE_CASE=production` 的 smoke 回调中直接调用测试专用 `process.exit(0)`，在进入 Electron 生命周期阻塞前确定退出；普通桌面运行和其他 smoke 继续使用 `app.quit()`。
- `tests/epipe-smoke.js` 增加静态断言锁定该生产 smoke 路径。修复后必须通过本地 EPIPE、仓库与发布工作流契约，再移动唯一 `v2.3.0` 注释标签并只触发一次完整原子发布。
