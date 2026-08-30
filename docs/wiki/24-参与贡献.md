# 为 SyncWatch同步观影 贡献代码

感谢你愿意改进项目。第一次参与开源也没有关系，请按下面的顺序操作。

## 开始之前

1. 安装 Git、Node.js 22 或更高版本，推荐 Node.js 24 LTS。
2. Fork 本仓库，再把你的 Fork 克隆到电脑。
3. 从 `main` 新建分支，名称使用小写英文和连字符，例如 `fix/mobile-server-start`。
4. 不要提交 `SyncWatch同步观影-Data/`、账号、密钥、真实 IP、聊天记录、媒体文件或构建产物。

## 仓库怎样允许大家共同维护

本仓库公开接受 Issue、Fork 和 Pull Request。为了让每一项修改都经过 xuan 确认，稳定分支采用以下权限边界：

- 普通贡献者在自己的 Fork 中新建分支，可以上传完整修改记录，但不能直接覆盖本仓库的 `main`。
- 已被邀请为仓库协作者的人，可以在本仓库创建功能分支，同样必须通过 Pull Request 合并。
- `main` 开启分支保护，禁止强制推送和删除；Pull Request 必须通过自动检查、解决评审对话，并取得维护者批准。
- xuan 审核代码、测试结果、安全影响和兼容性后负责合并。合并后才属于正式源码，后续再按版本号生成 Release。

这种方式不是拒绝贡献，而是让“谁修改了什么、谁确认了、测试是否通过”都能在 GitHub 中追溯。请不要把访问令牌、账号数据或签名密钥发到 Issue、讨论区或 Pull Request。

### 普通贡献者：使用 Fork

1. 在 GitHub 仓库右上角点击 **Fork**，创建自己的副本。
2. 克隆你的 Fork，并把本仓库添加为 `upstream`：

```bash
git clone https://github.com/你的用户名/SyncWatch.git
cd SyncWatch
git remote add upstream https://github.com/xuange6610/SyncWatch.git
```

3. 同步最新 `main`，再新建分支：

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch -c fix/简短问题名称
```

4. 修改、测试、提交并推送到你的 Fork：

```bash
git add 你修改的文件
git commit -m "修复：简要说明问题"
git push -u origin fix/简短问题名称
```

5. 回到 GitHub，点击 **Compare & pull request**，目标选择 `xuange6610/SyncWatch:main`，等待自动检查和维护者审核。

### 仓库协作者：使用功能分支

协作者不需要 Fork，但仍不能直接推送 `main`。请从最新 `main` 创建 `feature/*`、`fix/*`、`docs/*` 或 `refactor/*` 分支，推送后提交 Pull Request。不要共享个人 GitHub Token，也不要把自己的账号交给其他人操作。

## 本地运行

```bash
npm ci
npm start
```

只运行独立服务端：

```bash
npm run start:server
```

## 修改规范

- 面向用户显示的产品名称统一写作 `SyncWatch同步观影`。
- 文件名优先使用小写英文和连字符；GitHub 约定文件保留标准大写名称，如 `README.md`、`LICENSE`。
- 文本文件使用 UTF-8；普通源码使用 LF，Windows PowerShell 和 CMD 脚本使用 CRLF。
- 保留既有包名、协议字段和迁移兼容逻辑，除非变更同时提供升级方案和测试。
- 修复缺陷时请添加最小回归测试，不要顺手重构无关代码。

## 提交前检查

```bash
npm run test:repo
npm test
```

影响多个模块、构建或发布时，再运行：

```bash
npm run test:all
```

完整测试会使用 Electron、FFmpeg、Android 或 cloudflared，缺少相应环境时请在 Pull Request 中写明未运行的项目和原因。

## 提交 Pull Request

1. 使用简短、明确的提交说明，例如 `修复 Android 手机服务器资源打包`。
2. 在 Pull Request 中说明问题、修改内容、验证命令和界面截图。
3. 一个 Pull Request 只解决一个主题，避免混入格式化整个仓库等无关修改。
4. 提交代码即表示你同意按本项目的 [Apache-2.0 License](LICENSE) 发布该贡献。
5. 收到评审意见后继续向原分支推送提交，Pull Request 会自动更新；不要关闭后重复创建。
6. 修改范围较大时，维护者可以要求拆分为多个 Pull Request，或先补充迁移方案和回归测试。

## 维护者审核与发布新版本

1. 检查 Pull Request 的作者、提交记录和修改范围，确认没有混入密钥、数据目录、签名材料或无关二进制文件。
2. 等待 **Repository checks** 自动检查通过；涉及平台构建时核对贡献者列出的本地测试证据。
3. 在 Files changed 中逐文件审核；有问题就提交 Review，贡献者修正后重新检查。
4. 批准并合并到 `main`。普通修改推荐 Squash merge，保留一个清晰的正式提交。
5. 需要发布成品时更新版本号与变更说明，真实构建并验证 Windows EXE、Android APK 和独立服务端文件，再创建新的 GitHub Release。
6. GitHub Pages 会在 `main` 中的文档发生变化后自动部署；程序新版本不会只因为合并代码就自动生成，仍需完成发布验收。
