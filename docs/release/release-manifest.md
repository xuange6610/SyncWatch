# Release 资产清单

## 数量规则

每个正式版本在 GitHub Release 页面应显示 28 个文件：

- 2 个 GitHub 自动生成的源码归档：`Source code (zip)`、`Source code (tar.gz)`。
- 26 个维护者上传的真实构建资产，按下表分组。

Release API 的 `assets` 数量必须为 26；页面把两个源码归档也算进去后就是用户看到的 28 个文件。源码归档不需要手工上传，也不计入 26 个构建资产的 SHA-256 清单。

## 26 个维护者资产

| 数量 | 分组 | 文件模式 |
| ---: | --- | --- |
| 4 | Windows 桌面 | `SyncWatch-Experience-Client-Portable-vX.Y.Z-x64.exe`、`SyncWatch-Standard-Server-Portable-vX.Y.Z-x64.exe`、`SyncWatch-vX.Y.Z-Full-Offline-Installer-x64.exe`、`SyncWatch-vX.Y.Z-Full-Offline-Portable-x64.exe` |
| 1 | Android | `SyncWatch-Android-vX.Y.Z-universal.apk` |
| 4 | macOS 客户端 | `SyncWatch-Client-macOS-vX.Y.Z-{x64,arm64}.{dmg,zip}` |
| 4 | macOS 服务器 | `SyncWatch-Server-macOS-vX.Y.Z-{x64,arm64}.{dmg,zip}` |
| 4 | macOS 完整离线版 | `SyncWatch-Full-Offline-macOS-vX.Y.Z-{x64,arm64}.{dmg,zip}` |
| 4 | Node.js 运行时 | `node-v24.19.0-x64.msi`、`node-v24.19.0-arm64.msi`、`node-v24.19.0-macos-x64.pkg`、`node-v24.19.0-darwin-arm64.tar.gz` |
| 5 | cloudflared | `cloudflared-windows-x64.exe`、Windows x64/x86 installer MSI、`cloudflared-macos-x64`、`cloudflared-macos-arm64` |

## 发布前检查

1. 将 `X.Y.Z` 替换为当前 `package.json`、Android `versionName` 和 Git tag 的同一版本。
2. 确认每个模式各有对应的真实文件，macOS x64 与 arm64 不互相冒充，Windows 体验/标准/完整版用途不混淆。
3. 对每个资产记录字节大小和 SHA-256；禁止空文件、改名旧版本、重复内容或个人数据进入 Release。
4. 执行 `npm run test:repo`、`node tests/desktop-release-contract.test.js`、`node tests/android-package.test.js --source-only`、`node tests/cloudflared-bundle.test.js` 和对应平台的实际构建/验收。
5. 用 `gh release view <tag> --json assets` 确认 API 资产数为 26；再在网页上确认包含两个 GitHub 源码归档后总数为 28。

## 同版本替换规则

发现已发布资产有缺陷时，只清理当前版本 Release API 中的维护者资产，不删除历史 Release、历史 tag 或其他版本文件。修复必须先通过对应平台运行验证；随后一次性恢复本清单的 26 个真实资产，最后再更新 Release 正文并核对页面 28 个可见文件。重传中间状态不是完整发布，不能对外宣称完成。

## 当前记录

v2.1.7、v2.1.8、v2.1.9、v2.2.0 和 v2.2.3 的 Release API 均已验证有 26 个维护者资产，加上 GitHub 自动源码归档后每个版本都是 28 个可见文件。v2.2.3 于 2026-08-27 复核为 Latest，Release API 有 26 项。后续版本只有在真实构建、哈希和 Release API 校验完成后，才能声明达到相同的 26 + 2 清单；不能因为 README 或公告列出名称就视为文件已经上传。

v2.2.4 发布前必须从最终 Tag 重新构建并验证 17 个 SyncWatch 应用资产（Windows 4、Android 1、macOS 12）；Node.js 4 项和 cloudflared 5 项必须按官方原始分发另行核对来源、版本、平台/架构、字节数和 SHA-256。两类文件都完成后才可形成 26 个维护者资产，不能复用、复制或改名 v2.2.3 应用包。

v2.2.4 仍处于候选阶段时，README、Wiki 和 Release 说明必须把 v2.2.3 标为上一正式版本，不能提前把候选资产写成已经可下载。发布完成后，以 Release API 恰有 26 个维护者资产、页面 28 个文件、Latest 指向 v2.2.4 和逐项远端哈希回读为一次性切换正式状态的证据。
