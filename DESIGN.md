---
name: SyncWatch同步观影
description: 面向新手的自托管同步观影产品展示与使用导览
colors:
  cinema-ink: "#101318"
  cinema-surface: "#1a2027"
  paper: "#f2f0ea"
  paper-strong: "#ffffff"
  text-on-dark: "#f8f7f2"
  text-muted-dark: "#b9c2c9"
  text-on-paper: "#1c252b"
  text-muted-paper: "#53616a"
  sync-green: "#28d490"
  sync-green-deep: "#0c6d4b"
  action-coral: "#ff755f"
  focus-amber: "#f2b84a"
  line-dark: "#323b44"
  line-light: "#c7cec9"
  cinema-deepest: "#05070a"
  cinema-image: "#06080b"
  cinema-dialog: "#07090c"
  cinema-footer: "#090b0e"
  cinema-gallery: "#0b0e12"
  control-dark: "#151b20"
  data-green: "#123f35"
  coral-ink: "#1c100d"
  amber-ink: "#20190d"
  control-line: "#2f3a42"
  download-brown: "#32241b"
  amber-text: "#493818"
  dialog-line: "#4d5962"
  green-hover: "#5ce2ad"
  dialog-control-line: "#65727b"
  command-control-line: "#687781"
  quiet-control-line: "#7f8b92"
  footer-muted: "#89949b"
  data-accent: "#8ce5bd"
  dark-lead: "#c6d1d5"
  data-note: "#d7e7df"
  command-text: "#d9f7e9"
  hero-detail: "#dce3e5"
  download-muted: "#e2cec1"
  data-table-text: "#f4fbf7"
  primary-button-text: "#07120e"
  overlay-table: "rgba(0, 0, 0, 0.22)"
  shadow-action: "rgba(0, 0, 0, 0.25)"
  shadow-gallery: "rgba(0, 0, 0, 0.3)"
  shadow-hero-text: "rgba(0, 0, 0, 0.55)"
  shadow-dialog: "rgba(0, 0, 0, 0.56)"
  backdrop-dialog: "rgba(0, 0, 0, 0.82)"
  button-quiet-bg: "rgba(16, 19, 24, 0.78)"
  header-bg: "rgba(16, 19, 24, 0.96)"
  shadow-command: "rgba(21, 27, 31, 0.16)"
  data-line: "rgba(231, 247, 239, 0.2)"
  data-outline: "rgba(231, 247, 239, 0.28)"
  download-line: "rgba(255, 235, 220, 0.26)"
  signal-glow: "rgba(40, 212, 144, 0.32)"
  hero-shade: "rgba(7, 10, 13, 0.7)"
typography:
  display:
    fontFamily: "Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: "64px"
    fontWeight: 900
    lineHeight: 1.08
    letterSpacing: "0"
  headline:
    fontFamily: "Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: "40px"
    fontWeight: 900
    lineHeight: 1.24
    letterSpacing: "0"
  body:
    fontFamily: "Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: "0"
  code:
    fontFamily: "Cascadia Code, SFMono-Regular, Consolas, monospace"
    fontSize: "14px"
    lineHeight: 1.9
  inline-code:
    fontSize: "0.92em"
  caption:
    fontSize: "13px"
  label:
    fontSize: "14px"
  compact-body:
    fontSize: "15px"
  gallery-title:
    fontSize: "17px"
  section-lead:
    fontSize: "18px"
  step-title:
    fontSize: "19px"
  footer-title:
    fontSize: "20px"
  subheading:
    fontSize: "24px"
  mobile-heading:
    fontSize: "31px"
  boundary-heading:
    fontSize: "32px"
  mobile-display:
    fontSize: "42px"
rounded:
  control: "4px"
  surface: "6px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  section: "96px"
components:
  button-primary:
    backgroundColor: "{colors.sync-green}"
    textColor: "#07120e"
    rounded: "{rounded.surface}"
    padding: "10px 18px"
    height: "44px"
  button-quiet:
    backgroundColor: "rgba(16, 19, 24, 0.78)"
    textColor: "#ffffff"
    rounded: "{rounded.surface}"
    padding: "10px 18px"
    height: "44px"
---

# Design System: SyncWatch同步观影

## Overview

**Creative North Star: “放映控制台与使用手册”**

展示站把真实产品的影院感与新手文档的清晰度放在同一页面中。深色区域承载产品画面、截图和命令行，浅色区域承担步骤、解释和索引；绿色信号点与主按钮代表“已连接、可继续”，珊瑚色和琥珀色只用于关键提示。

整体克制、实用、可扫描，不采用装饰性卡片堆叠或夸张营销数字。页面必须明确区分静态展示能力与实际服务器能力，并让首次接触 Node.js 和自托管服务的用户找到下一步。

**Key Characteristics:**

- 深色影院画面与浅色说明区交替，形成明确阅读节奏。
- 真实界面截图优先于抽象插画或无依据的产品宣称。
- 直角感较强的小圆角、细边框和高对比焦点状态。
- 桌面端信息密度适中，手机端退化为单列且不横向溢出。

## Colors

主色板以近黑影院背景、暖灰纸面和同步绿色构成；珊瑚色与琥珀色只承担少量状态提示。

### Primary

- **同步信号绿** (`#28d490`)：主要行动、成功状态、当前步骤和可交互边框。
- **深同步绿** (`#0c6d4b`)：浅色背景上的标题、标签和滚动条。

### Secondary

- **行动珊瑚** (`#ff755f`)：下载说明和需要额外注意的步骤。
- **焦点琥珀** (`#f2b84a`)：键盘焦点、文本选中和 Pages 能力边界提醒。

### Neutral

- **影院墨黑** (`#101318`) 与 **控制台表面** (`#1a2027`)：深色页面和工具区域。
- **说明纸面** (`#f2f0ea`) 与 **纯白纸面** (`#ffffff`)：长文阅读和明亮分区。
- **深色正文** (`#f8f7f2`) / **深色次文** (`#b9c2c9`)：深色背景文字层级。
- **纸面正文** (`#1c252b`) / **纸面次文** (`#53616a`)：浅色背景文字层级。

**稀缺强调规则。** 同一屏幕内不要同时大量使用绿色、珊瑚色和琥珀色；每种颜色只表达一种明确状态。

## Typography

**Display Font:** Microsoft YaHei（回退到 PingFang SC、Noto Sans CJK SC 和系统无衬线）<br>
**Body Font:** Microsoft YaHei（同上）<br>
**Code Font:** Cascadia Code（回退到 SFMono-Regular、Consolas 和等宽字体）

中文系统字体保证 Windows、macOS 和 Android 上无需下载字体即可稳定阅读。标题使用较重字重建立操作层级，正文保持 1.7 行高，命令块使用明显更宽松的 1.9 行高。

### Hierarchy

- **Display**（900，64px，1.08）：仅用于首屏产品名称，手机端降至 42px。
- **Headline**（900，40px，1.24）：页面主要章节标题，手机端降至 31px。
- **Title**（700–900，18–24px）：步骤、截图和功能分类标题。
- **Body**（400，16px，1.7）：说明正文，单段建议不超过 70–75ch。
- **Label**（700–900，13–14px）：导航、按钮、表头和状态文字。

## Layout

内容容器最大宽度为 1180px，桌面端两侧至少保留 20px，手机端至少保留 14px。常规章节上下间距为 96px，700px 以下缩至 68px。功能流程、截图画廊和下载说明在桌面使用多列，940px 和 700px 两个断点逐步变成双列和单列。

首屏使用真实登录界面作为全宽背景，文字直接叠放其上，不增加浮动卡片。登录页桌面顶部留白控制在 12px，移动端控制在 18px；公告仍在登录卡片内流动，避免工具栏下方出现无内容的横向空带。数据表允许自身横向滚动，但不得让整页产生横向滚动。按钮、工具栏和截图容器使用稳定最小高度，避免内容加载时布局跳动。

观影工作区在 924px 以下改为单列，用“观影 / 聊天 / 片库 / 成员”四个显式模块入口取代三栏并排；模块入口属于普通文档流，随页面一起滚动，不悬浮遮住播放器或工具。片库和成员保持可点击的全宽抽屉，聊天只在选中时占用主区域。540px 以下观影工具使用两列重排，触控目标不低于 44px，禁止因字段过多发生整页横向溢出。手机顶栏功能菜单使用 fixed 覆盖层，不参与主界面高度计算；390px 起使用三列，较窄视口使用可滚动两列。账号行只负责展开同一覆盖层内的双列账号菜单，两个退出操作排在首行，Android 触控高度不低于 48px。复选框、单选框与普通文本输入分开定义尺寸，不继承文本框最小高度。

桌面服务器继续在 `0.0.0.0` 监听以保持本机、局域网和 Tunnel 入口，手动网卡选择通过请求的本机目标 IPv4 限定局域网接入，不改变 Electron 主窗必需的 `127.0.0.1` 回环通路。配置网卡不存在时回退至自动选择；公网分享地址优先使用已验证的 Tunnel，否则回退至配置的公网根地址。

临时 Tunnel 的连接顺序由启动预检决定：系统出口可用但物理网卡访问 Cloudflare 失败时，先走系统网络；连接器注册成功但公网地址仍无法回探时继续下一策略。界面展示实际 `activeNetworkMode`，避免把系统回退误写成“已绕过代理”。

HTTP 与 Socket.IO 使用同一套客户端 IP 解析：只有 TCP 对端属于回环、服务器启动时采样的本机网卡地址，或 `SYNCWATCH_TRUSTED_PROXIES` / `--trusted-proxies` 显式声明的 IP/CIDR 时，才读取代理头；命令行值优先于环境变量，IPv4/IPv6 `/0` 全网段一律当作无效配置。有效 `X-Forwarded-For` 从右向左逐个剥离可信 hop，遇到第一个不可信地址即作为客户端；不可信直连一律忽略 `X-Forwarded-For`、`CF-Connecting-IP` 和 `X-Real-IP`。这既让本机 cloudflared 回源区分不同公网访客，也阻止普通客户端用最左侧伪造值逃避游客 IP 限制。

媒体网络恢复复用单一有限重试状态。`MediaError(code=2)` 与连续 12 秒没有播放时间/缓冲增长的 `waiting/stalled` 都进入同一条最多 5 次、500 毫秒到 12 秒渐进退避的恢复路径；设备或 Socket 离线时以 1 秒间隔等待但不消耗重试预算，重连后唤醒恢复，原画次数用尽且已有流畅版时再降级。恢复后要求至少 3 秒连续健康播放才清空次数；如果 Chromium 在网络切换后继续发送 `timeupdate` 却没有补发 `playing/canplay`，健康进度事件会重建同一个稳定观察点，防止恢复键永久遗留。正常缓冲增长、换片和清空画面会取消计时，避免弱网半开连接永久停帧，也避免健康播放被循环重载。超过 32 MiB 的媒体把开放 Range 限制为 8 MiB，减少高 RTT 链路的续段频率，同时不恢复会在拖动后长期占用传输的无限响应。

顶栏“同步正常 / 网络波动 / 连接中断”描述的是 Socket.IO 控制通道，不直接复用视频 `waiting/stalled`。客户端前台每 4 秒发起一个不重叠的顺序探测，单次高延迟或超时不改变状态；连续 3 次超过 500 毫秒或超时才进入 `unstable`，连续 2 次健康样本后恢复。页面进入后台后不启动新探测，已经在途但回调发生于后台的结果直接丢弃；回到前台先重置迟滞状态再立即测量。旧序号、上一连接周期的迟到响应和断线后积压的质量遥测不得覆盖新状态；成员短暂 `reconnecting` 不放大成全房间“网络波动”，本机 socket 真正断开则显示“连接中断”。

本机免密权限只由服务端判断：必须是回环 TCP 对端、loopback Host、同源 Origin、无任何代理转发头并携带不可见主机令牌。管理与入房使用不同事件和服务端签发的 `sessionMode`，两个开关只能收紧能力，客户端字段不能选择更高权限。

文本阅读状态只保存 `fileId`、UTF-16 `characterOffset` 字符锚点、归一化位置、页码、修订号和操作者，不把正文放进 Socket 消息。客户端忽略旧 revision，并始终原样保留服务端下发的精确逻辑 `characterOffset`；Range 几何只负责把该字符所在的本地视觉行滚动到阅读区顶部，不得把因视口宽度和换行产生的本地行首回写成权威锚点。resize、晚加入和断线重连继续使用同一权威状态。文本正文始终以 `text/plain`、`nosniff` 和限制性 CSP 返回，前端使用 `textContent`；扩展名、MIME、全文件二进制检测和 10MB 限制在服务端统一执行。

头像沿用“单击执行原操作，双击查看大图”的交互契约。桌面双击和触摸端 420 毫秒内的第二次点击会取消待执行单击并打开可用 Escape 关闭的预览；普通单击延迟确认后再打开成员资料或账号菜单。等待期间如果成员状态刷新重建了列表节点，逻辑目标按账号重新定位到当前控件再执行，不能因为旧 DOM 已断开而丢失单击。

服务器下载文件上传采用固定 kind/架构到固定路径的映射，先写同数据目录临时文件，校验扩展名与文件签名后原子替换；浏览器不能提交任意目标路径。账户等级、权限组和手机资料等编辑器使用独立模态窗口，主列表只负责选择与摘要。

## Elevation & Depth

页面以色块分层和细边框为主，阴影仅用于主按钮、命令面板、截图悬停和灯箱。静止的文档区不使用悬浮卡片阴影；灯箱使用较深阴影将当前截图与背景分离。

- **轻行动阴影** (`3px 6px 18px rgba(0, 0, 0, 0.25)`)：主要按钮。
- **工具阴影** (`3px 10px 30px rgba(21, 27, 31, 0.16)`)：命令面板。
- **模态阴影** (`4px 16px 50px rgba(0, 0, 0, 0.56)`)：截图灯箱。

**默认扁平规则。** 只有交互状态或临时覆盖层可以明显升起，普通内容区依靠背景和分隔线建立层级。

## Shapes

控件使用 4px 圆角，按钮、表格外框、截图和工具面板使用 6px 圆角。圆形只用于连接状态标记和同步信号点。大面积胶囊、超大圆角和纯装饰圆形不属于本设计系统。

## Components

### Buttons

- **Shape:** 6px 圆角，最小高度 44px，水平内边距 18px。
- **Primary:** 同步绿色背景、深墨绿色文字和轻行动阴影。
- **Hover / Focus:** 悬停提高绿色亮度；键盘焦点统一使用 3px 琥珀色外轮廓。
- **Desktop close choices:** 关闭选择窗的五个操作默认保持中性；鼠标悬停或键盘聚焦到哪个操作，哪个操作才使用与“最小化到托盘”一致的高亮背景、边框和文字对比度，不能把固定选项误画成当前悬停状态。
- **Quiet:** 半透明深色背景、浅色边框和白色文字，用于次要跳转。

### Cards / Containers

- **Corner Style:** 6px 小圆角。
- **Background:** 截图容器和命令面板使用影院墨黑，正文区保持所在分区背景。
- **Shadow Strategy:** 静止时主要用 1px 边框，截图悬停时才出现阴影。
- **Internal Padding:** 常规 16–24px；图片区与说明区由边框分隔。

### Inputs / Fields

- **Style:** 继承系统字体与页面色板，采用小圆角和清楚边框。
- **Focus:** 所有可聚焦控件统一使用琥珀色可见焦点，不依赖颜色细微变化。

### Navigation

顶部导航固定在视口上方，使用近黑不透明背景和细底边。链接为 14px 粗体，默认灰白、悬停纯白；手机端允许导航行横向滚动，但不换成隐藏菜单。

### Screenshot Gallery

截图是产品证据，不是装饰。缩略图保持稳定画幅并附带功能标题和说明；点击后使用原生 `dialog` 灯箱查看完整图片，支持关闭、上一张、下一张和方向键。

## Do's and Don'ts

### Do:

- **Do** 使用真实、去隐私化、能证明实际功能状态的产品截图。
- **Do** 保持深色展示区和浅色阅读区的交替节奏。
- **Do** 为键盘操作保留明显焦点，并尊重减少动态效果偏好。
- **Do** 在手机端把多列内容变为单列，同时保留至少 44px 的可点击高度。

### Don't:

- **Don't** 把 GitHub Pages 描述成能运行 Node.js、WebSocket、上传或临时公网隧道的完整服务器。
- **Don't** 使用装饰性渐变、光斑、嵌套卡片或无依据的用户数与性能数字。
- **Don't** 在截图、文案或示例数据中暴露真实姓名、私人 IP、令牌、媒体名称或个人账号数据。
- **Don't** 把产品名称缩写成面向用户的 `SyncWatch`；仓库地址和兼容标识除外。

## Implementation Notes From Source

以下内容是根据当前源码、构建配置和测试确认的实现事实，不是视觉稿假设。

### 页面与导航

- 产品 Web UI 的入口是 `public/index.html`，主要交互逻辑在 `public/js/app.js`，主题和首屏初始化分别由 `public/js/first-paint-theme.js` 与 `public/css/style.css` 负责。
- GitHub Pages 的入口是 `docs/index.html`；文档 HTML 共用 `docs/assets/site.css`、`guide.css`、`document-guide.css` 和 `pro-max.css`，每个设计页保留对应 Markdown 原文链接。
- 管理中心的 11 个模块使用 `docs/modules/*.html` 独立展示；截图必须与模块一一对应，页面同时提供键盘可用的 3D 监视器/灯箱交互。

### 状态与交互

- 连接、成功、进行中和错误状态分别使用同步绿、低对比中性色、琥珀提示和珊瑚/红色错误；颜色不是唯一信息，必须同时提供文字或图标语义。
- “网络波动”只表示连续控制通道探测异常，不把单次 RTT 尖峰、媒体缓冲或成员短暂重连误画成房间故障；真实 socket 断开使用独立的“连接中断”文案。
- 服务器设备的超级管理员登录是“设置优先”入口：认证成功后保留会话并直接打开管理中心服务器设置，不把房间页面作为必须的中转步骤；普通账号登录仍按房间入口流程执行。
- 内置 `admin` 首次改密免重复当前密码只来自服务端签发的账号密码认证能力；本机免密管理入口不能获得该能力，首次设置成功后也不能再次复用。
- 首次改密等后台定时提醒不能抢占用户已经打开的应用内对话框；当前前台操作完成后再重试提醒，避免按钮文案、输入状态和焦点被异步流程覆盖。
- 头像单击与双击共享同一控件时先消歧：普通单击保留资料/菜单动作，双击和触摸快速双击打开大图；预览支持 Escape、关闭按钮、遮罩关闭和焦点返回。
- 加载状态保持固定的容器尺寸，避免首屏、截图和数据表因异步内容跳动；错误状态显示可执行的下一步，不泄露服务端堆栈。
- 空状态说明为什么为空以及用户下一步能做什么；权限不足状态来自服务端结果，前端不通过隐藏按钮代替授权校验。
- 3D、灯箱和悬停动效必须尊重 `prefers-reduced-motion`，并保留 Escape、方向键、Tab 焦点和可见焦点样式。

### 前后端与数据流

1. `electron-pink.js`、`server-standalone.js` 或 Android `MobileServerService` 启动同一份 `server/index.js`。
2. Express 提供 REST/文件流，Socket.IO 提供房间状态、播放控制、聊天、通知和共享信令；客户端先建立会话再加入房间。
3. 房主操作发送意图，服务端写入权威房间状态并广播带时间/版本的信息；客户端按服务器时间和缓冲偏差校正播放器。本地 `readyState < 3` 或正在缓冲时暂停硬跳转和加速追赶，先保留已经下载的 Range 数据，恢复后再校正。
4. 上传写入 `SyncWatch同步观影-Data/uploads/`，FFprobe/FFmpeg 更新媒体索引和兼容产物；客户端默认使用原画，流畅版是网络受限时可手动选择的低带宽 H.264/AAC 兼容版本（目标不高于 854×480、视频约 900 kbps、音频 96 kbps）。HTTP Range 负责媒体读取，Socket.IO 不承载媒体本体。
5. 配置、账号、房间、日志和密钥落在数据目录及其 secrets 子目录，写盘使用临时文件/原子替换，并用实例锁阻止同目录并发写入。
6. `cloudflared` 是可选边缘入口，只转发本地 HTTP、WebSocket 和 Range 请求，不保存 SyncWatch 账号或媒体。
7. 统一界面文案保存在 `admin.uiCopy`。显式 key 与前端为固定控件生成的不可解释 `ui.auto.*` key 都经过格式校验；扫描器只收录系统标签、按钮和受控属性，排除影片名、账号/IP、Toast、动态对话正文等运行数据。`login.guestIpOccupied` 是服务端游客占用错误的稳定键，保存后下一次拒绝响应直接读取新值，同时通过 `ui-copy-state` 广播在线客户端。服务端限制最多 5000 项、每项 240 个字符、导入 JSON 不超过 2 MB，拒绝未知 key、HTML 标记和可执行协议；前端只使用 `textContent` 或受控文本属性应用，不接受选择器、DOM 路径或 HTML。

### 发布供应链

- Android 的 Node.js Mobile 运行库固定到上游源码提交、NDK 版本和 16 KB linker 参数。Actions 重试可以读取此前成功构建的运行库 artifact 以避免不可重复的 ELF build-id 漂移，但必须先解析 provenance JSON 并严格核对固定 schema、仓库、提交、页大小和精确键集合，再核对头文件与三个 ABI 的原始 SHA-256，最后才作为输入交给最终 Tag 的 APK 构建；JSON 空白或单行排版不参与来源判定。
- 运行库复用不等于复用 SyncWatch 应用包：APK、Windows 和 macOS 应用资产仍必须从最终 Tag 的源码重新构建，并完成各平台签名、闭包、启动和核心流程验证。
- 原子发布器只在 28 个本地交付文件、26 个维护者资产、两份源码归档、SHA-256 清单和远端下载回读全部一致后，才把 Release 从草稿切换为公开并设为 Latest。

### 待确认边界

- macOS runner 的最终窗口行为、签名和权限必须在 macOS 设备/Actions 成品上验证；Windows 工作站不能替代该验证。
- Android 厂商后台限制、通知/媒体投影授权和真实公网网络质量不能从静态源码完全推断。
- 具体接口字段以 `server/index.js` 当前实现和对应测试为准；新增接口必须同时更新架构文档和错误处理说明。
