# SyncWatch 文档知识库

这是仓库内长期维护的文档入口。页面内容以当前源码、测试、构建配置和 Git 历史为准；GitHub Pages 展示页是这些文档的静态导览，不是运行中的 SyncWatch 服务器。

## 按任务查找

| 目标 | 首选文档 |
| --- | --- |
| 第一次启动、登录和加入房间 | [新手快速开始](quick-start.md)、[普通用户使用说明](user-guide.md) |
| 部署 Windows、Linux、Docker 或公网访问 | [服务器部署](server-deployment-guide.md)、[独立服务器](standalone-server.md)、[运行环境安装](runtime-installation.md) |
| 理解服务端、WebSocket、媒体和数据目录 | [技术架构](architecture.md)、[数据结构与备份迁移](wiki/06-数据结构与备份迁移.md) |
| 管理中心和权限 | [管理中心详细教程](management-center.md)、[管理中心 Wiki](wiki/13-管理中心完整教程.md) |
| Android 构建与手机服务器 | [Android README](../mobile/README.md)、[Android/Wiki 教程](wiki/23-运行环境完整教程.md) |
| 平台说明 | 当前新版本只提供 Windows、Android 和浏览器；历史 macOS 版本仍可在旧 Release 中查看 |
| 错误、诊断、备份和安全 | [故障排查](troubleshooting.md)、[安全策略](../SECURITY.md) |
| Release、文件地图和贡献 | [v2.3.1 发布说明](release-notes-v2.3.1.md)、[v2.3.1 发布说明](release-notes-v2.3.1.md)、[发布文件说明](release-artifacts.md)、[仓库文件地图](repository-map.md)、[参与贡献](contributing.html)、[CONTRIBUTING.md](../CONTRIBUTING.md) |
| Codex 长期维护、版本与交付要求 | [维护者长期要求](maintenance/maintainer-requirements.md)、[发布失败技术手册](maintenance/release-failure-playbook.md)、[Release 固定资产清单](release/release-manifest.md) |

## 文档分层

- `docs/*.md`：可直接链接的当前部署、开发和运维说明。
- `docs/wiki/`：同步到 GitHub Wiki 的完整教程镜像，按编号组织。
- `docs/*.html`：带交互、截图和 3D 导览的 GitHub Pages 页面；对应 Markdown 源文档仍保留。
- `docs/modules/`：管理中心 11 个模块的独立功能导览页。
- `docs/screenshots/` 与 `docs/assets/`：去隐私化的产品截图、联系图片和展示站资源。

## 当前事实边界

- v2.3.0 仍为线上 Latest；v2.3.1 已完成本地共享性能、音源状态、主题回执、Android 启动迁移和桌面启动修复，待新 8 项完成远端资产回读后再原子替换；历史 Release 保持不变。
- GitHub Pages 只能提供静态 HTML/CSS/JavaScript，不能执行 Node.js、Socket.IO、文件上传、AI 中转或 Cloudflare Tunnel。
- v2.3.1 新构建仅提供 Windows 与 Android；不再构建或上传 macOS 新包。
- 运行账号、房间、媒体、聊天和密钥位于服务器旁的 `SyncWatch同步观影-Data/`，迁移和备份必须按完整目录处理。

## v2.3.1 文档同步重点

- Web“关于”与 Electron“帮助”统一指向项目主页和 Wiki；Node 独立服务端用 `--help`、`--open-browser`、启动摘要和 `服务器运行信息.txt` 提供等价管理入口。
- 注册名额申请支持按数量提交、部分/全部撤回和内置 `admin` 删除；账户管理只显示密码状态，安全重置不展示明文或哈希。
- “同步网址”保存房间权威 URL/revision，但各端在沙箱 iframe 中独立加载；跨域、Cookie、登录态、地域和禁止嵌入不由 SyncWatch 绕过，需要同画面时使用实时屏幕/标签页共享。
- 服务器登录页的本机管理快捷入口位于顶栏中间操作区；Electron 服务端窗口采用外层滚动，立体方块不会被登录卡片推离视口。管理中心账号总览使用独立 action 加载，失败时显示明确错误而非无限等待。
- 顶栏“选项 / 房间操作 / 设置”展开后始终显示按钮名称；手机端菜单跨列静态展开，避免按钮被内容裁剪。网页登录页与服务器登录页统一由文档承接上下滚动，短屏和高 DPI 下登录卡片仍可完整访问。

维护文档前请先读根目录 [AGENTS.md](../AGENTS.md)、[维护者长期要求](maintenance/maintainer-requirements.md)、[PRODUCT.md](../PRODUCT.md)、[DESIGN.md](../DESIGN.md) 和 [README.md](../README.md)。
