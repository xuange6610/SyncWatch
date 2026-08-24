# 仓库文件地图

这份页面解释 GitHub 首页中每一个主要文件夹和根目录文件的职责。新手可以先看“从哪里开始”，维护者可以按“构建与发布”定位脚本。

## 从哪里开始

1. 想先了解产品：阅读根目录 `README.md`，再打开 GitHub Pages 展示站。
2. 想实际使用：阅读 `docs/user-guide.md`，下载 Releases 中的服务器版或客户端。
3. 想部署服务器：阅读 `docs/server-deployment-guide.md`，需要 Docker 时查看根目录 `Dockerfile` 和 `docker-compose.yml`。
4. 想修改代码：先阅读 `docs/architecture.md`、`CONTRIBUTING.md` 和 `PRODUCT.md`，再运行 `npm ci` 与测试。
5. 想重新打包：Windows 使用 `build-windows.ps1`，独立服务端使用 `build-server-package.ps1`，macOS 需要 macOS 主机或 macOS CI。

## 文件夹说明

| 路径 | 用途 | 新手是否需要修改 |
| --- | --- | --- |
| `.github/` | Issue/PR 模板、代码所有者、贡献检查和 Pages 自动部署工作流 | 通常不需要；修改工作流前先阅读 YAML |
| `.impeccable/` | 展示站设计系统的机器可读侧车文件 | 不要直接删；视觉变更后同步设计文档 |
| `assets/` | 应用图标和品牌资源 | 只有更换图标时修改 |
| `docs/` | GitHub Pages、3D 管理中心 HTML、截图、用户教程、错误处理、技巧与架构说明 | 文档贡献主要在这里 |
| `mac/` | macOS 发布说明和平台资源清单 | macOS 构建者使用 |
| `mobile/` | Android 客户端、手机服务器、Gradle 工程和 APK 构建脚本 | Android 构建者使用 |
| `public/` | 实际浏览器界面、样式、前端逻辑和本地化资源 | 修改界面功能时使用 |
| `scripts/` | macOS 构建、Cloudflare 工具准备、清理和发布辅助脚本 | 按平台文档调用 |
| `server/` | HTTP API、Socket.IO、认证、房间、媒体、AI 和公网隧道 | 后端功能主要在这里 |
| `tests/` | 集成、前端契约、桌面成品、Android、隧道和发布验收 | 每次功能变更都应补充或运行相关测试 |
| `dist/` | 唯一正式构建成品目录；已被 Git 忽略 | 完整版本必须直接包含固定 28 个文件 |

## 根目录规范文件

| 文件 | 作用 |
| --- | --- |
| `.dockerignore` | Docker 构建时排除源码缓存、测试和无关成品，同时保留服务器需要的客户端文件 |
| `.editorconfig` | 统一缩进、换行、编码和末尾空格，减少不同编辑器造成的格式差异 |
| `.gitattributes` | 告诉 Git 哪些文件使用文本处理、LF 换行和二进制方式存储 |
| `.gitignore` | 排除 `node_modules`、构建目录、运行数据、临时输出和签名材料 |
| `CODE_OF_CONDUCT.md` | 社区参与者的行为规范和投诉边界 |
| `CONTRIBUTING.md` | 分支命名、提交、测试、文档和 Pull Request 要求 |
| `DESIGN.md` | Pages 展示站的设计方向、色板、排版、布局和无障碍约束 |
| `Dockerfile` | 构建 Linux/amd64 独立服务器容器 |
| `LICENSE` | Apache License 2.0 全文，规定使用、修改、专利和再发布条件 |
| `NOTICE` | 原始项目和版权归属信息，再发布时应保留 |
| `PRODUCT.md` | 产品定位、用户、能力边界、数据保护和展示站事实依据 |
| `README.md` | GitHub 首页的新手入口、功能概览、下载选择和文档索引 |
| `SECURITY.md` | 私密报告安全漏洞的方式和提交前脱敏要求 |
| `build-server-package.ps1` | 把独立服务器源码、生产依赖、启动脚本、cloudflared 和客户端文件打成 ZIP |
| `build-windows.ps1` | Windows 发布总入口，构建服务器 EXE、客户端 EXE、Android APK 并验证成品 |
| `client-launcher.html` | 独立 Windows 客户端的登录和服务器地址入口 |
| `docker-compose.yml` | 用持久化数据目录启动独立服务器容器 |
| `electron-builder-client.json` | Windows 客户端 Electron 打包配置 |
| `electron-builder-mac-client.json` | macOS 客户端 x64/arm64 DMG 和 ZIP 配置 |
| `electron-builder-mac-server.json` | macOS 服务器 x64/arm64 DMG 和 ZIP 配置 |
| `electron-builder-mac-full.json` | macOS Intel/Apple Silicon 离线完整版 DMG 和 ZIP 配置 |
| `electron-builder-windows-full-portable.json` | Windows 无需安装的独立 EXE 离线完整版配置 |
| `electron-client-preload.js` | 客户端渲染进程可用的最小安全 IPC 接口 |
| `electron-client.js` | Windows/macOS 独立客户端主进程 |
| `electron-main-preload.js` | 服务器桌面端渲染进程的安全 IPC 接口 |
| `electron-pink.js` | Windows/macOS 服务器桌面端主进程 |
| `electron-settings-preload.js` | 服务器设置窗口的受限 IPC 接口 |
| `mac-distribution.example.json` | macOS 成品下载地址清单示例；没有真实文件时界面显示不可用 |
| `package.json` | 项目版本、依赖、脚本、Electron 产品名和打包文件白名单 |
| `package-lock.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` | 锁定依赖版本和包管理工作区，避免不同机器安装出不同结果 |
| `server-standalone.js` | 不启动 Electron、直接运行 Node.js 独立服务端 |
| `start-server.cmd` / `start-server.ps1` / `start-server.sh` | Windows CMD、PowerShell、Linux/macOS 三种启动入口 |

## GitHub Actions 与 Pages

`.github/workflows/pages.yml` 只发布 `docs/` 静态目录。它会先运行 `node tests/repository-standards.test.js`，通过后才上传 Pages artifact 并部署。它不打包服务器，也不会接触用户运行数据。

`.github/workflows/ci.yml` 在 Pull Request 和 `main` 更新时安装锁定依赖，运行仓库规范检查与核心集成测试。`.github/CODEOWNERS` 指定 `@xuange6610` 为源码审核者；配合 `main` 分支保护，外部贡献必须经过 Pull Request、自动检查和维护者批准，不能直接强制覆盖正式源码。

## 修改和提交建议

- 修改 `public/` 或 `server/` 后运行 `npm test` 和相关专项测试。
- 修改 `docs/`、README 或许可证后运行 `npm run test:repo`。
- 不提交 `dist/`、`release/`、`output/`、`.env`、密钥、APK 签名文件和真实用户数据。
- 提交信息使用简短动词，例如 `完善管理中心文档`、`修复移动端灯箱布局`。
