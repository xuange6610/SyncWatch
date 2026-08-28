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
| macOS 构建与发布 | [macOS 构建](macos-build.md)、[macOS Wiki](wiki/18-macOS构建与发布.md) |
| 错误、诊断、备份和安全 | [故障排查](troubleshooting.md)、[安全策略](../SECURITY.md) |
| Release、文件地图和贡献 | [v2.2.6 发布说明](release-notes-v2.2.6.md)、[v2.2.3 发布说明](release-notes-v2.2.3.md)、[发布文件说明](release-artifacts.md)、[仓库文件地图](repository-map.md)、[参与贡献](contributing.html)、[CONTRIBUTING.md](../CONTRIBUTING.md) |
| Codex 长期维护、版本与交付要求 | [维护者长期要求](maintenance/maintainer-requirements.md)、[Release 固定资产清单](release/release-manifest.md) |

## 文档分层

- `docs/*.md`：可直接链接的当前部署、开发和运维说明。
- `docs/wiki/`：同步到 GitHub Wiki 的完整教程镜像，按编号组织。
- `docs/*.html`：带交互、截图和 3D 导览的 GitHub Pages 页面；对应 Markdown 源文档仍保留。
- `docs/modules/`：管理中心 11 个模块的独立功能导览页。
- `docs/screenshots/` 与 `docs/assets/`：去隐私化的产品截图、联系图片和展示站资源。

## 当前事实边界

- [v2.2.6](https://github.com/xuange6610/SyncWatch/releases/tag/v2.2.6) 正在进行同版本更正发布；线上旧 Release 的 26 个资产不能作为本轮修复证据。最终 Tag 构建、哈希回读、Release、Pages 与 Wiki 核对全部完成前，正式下载以 GitHub Release API 实际资产和发布公告状态为准。
- GitHub Pages 只能提供静态 HTML/CSS/JavaScript，不能执行 Node.js、Socket.IO、文件上传、AI 中转或 Cloudflare Tunnel。
- 可下载的桌面、Android、macOS 和独立服务器成品以 GitHub Releases 中实际存在的资产为准，不以文件名猜测平台支持。
- 运行账号、房间、媒体、聊天和密钥位于服务器旁的 `SyncWatch同步观影-Data/`，迁移和备份必须按完整目录处理。

## v2.2.6 文档同步重点

- Web“关于”与 Electron“帮助”统一指向项目主页和 Wiki；Node 独立服务端用 `--help`、`--open-browser`、启动摘要和 `服务器运行信息.txt` 提供等价管理入口。
- 注册名额申请支持按数量提交、部分/全部撤回和内置 `admin` 删除；账户管理只显示密码状态，安全重置不展示明文或哈希。
- “同步网址”保存房间权威 URL/revision，但各端在沙箱 iframe 中独立加载；跨域、Cookie、登录态、地域和禁止嵌入不由 SyncWatch 绕过，需要同画面时使用实时屏幕/标签页共享。

维护文档前请先读根目录 [AGENTS.md](../AGENTS.md)、[维护者长期要求](maintenance/maintainer-requirements.md)、[PRODUCT.md](../PRODUCT.md)、[DESIGN.md](../DESIGN.md) 和 [README.md](../README.md)。
