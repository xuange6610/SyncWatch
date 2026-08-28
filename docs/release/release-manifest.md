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

v2.2.6 当前只是候选；旧线上 Release 资产不能作为本轮修复证据，必须完成最终 Tag 构建、哈希回读和 26+2 文件核对后才可重新标记 Latest。

v2.1.7、v2.1.8、v2.1.9、v2.2.0、v2.2.3、v2.2.4 和 v2.2.5 的历史 Release 保持原有 26 个维护者资产与两个 GitHub 源码归档。v2.2.6 的旧 26 项曾被用户确认未包含本轮源码修正，因此旧 Actions、旧 Tag SHA 和旧远端哈希只作为线上基线，不能作为同版本更正版完成证据。

v2.2.4 的 17 个 SyncWatch 应用资产（Windows 4、Android 1、macOS 12）已从最终 Tag 重新构建并验证；Node.js 4 项和 cloudflared 5 项已按官方原始分发另行核对来源、版本、平台/架构、字节数和 SHA-256。v2.2.6 同版本更正版必须重新完成同样的证据链。

同版本替换使用安全切换：旧 26 项保持在线到新 26 项全部构建；最终短暂转草稿，新文件以临时名上传并完成远端哈希回读，再把旧文件改为备份名、新文件切换正式名。新集合完整验证前失败必须恢复旧名称和公开状态；新集合验证后才删除旧资产并发布，最终 API 必须恰有 26 项。
