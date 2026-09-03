# Release 资产清单

v2.3.9 当前只是候选：完成最终 Tag 构建、启动/核心流程、版本/平台/大小/SHA-256 与远端 Release API 回读后，才能声明 8 个维护者资产加 2 个源码归档共 10 个可见文件。历史资产保持不变。

## 数量规则

按当前维护者范围，每个新正式版本只发布 Windows 与 Android，页面应显示 10 个文件：

- 2 个 GitHub 自动生成的源码归档：`Source code (zip)`、`Source code (tar.gz)`。
- 8 个维护者上传的真实构建资产，按下表分组。

Release API 的 `assets` 数量必须为 8；页面把两个源码归档也算进去后就是用户看到的 10 个文件。源码归档不需要手工上传，也不计入 8 个构建资产的 SHA-256 清单。

## 8 个维护者资产（Windows + Android）

| 数量 | 分组 | 文件模式 |
| ---: | --- | --- |
| 2 | Windows 桌面 | `SyncWatch-Experience-Client-Portable-vX.Y.Z-x64.exe`、`SyncWatch-vX.Y.Z-Full-Offline-Portable-x64.exe` |
| 1 | Android | `SyncWatch-Android-vX.Y.Z-universal.apk` |
| 2 | Node.js Windows 运行时 | `node-v24.19.0-x64.msi`、`node-v24.19.0-arm64.msi` |
| 3 | cloudflared Windows 工具 | `cloudflared-windows-x64.exe`、Windows x64/x86 installer MSI |

## 发布前检查

1. 将 `X.Y.Z` 替换为当前 `package.json`、Android `versionName` 和 Git tag 的同一版本。
2. 确认 Windows 体验版、完整便携版与 Android 各有对应的真实文件，平台用途不混淆。
3. 对每个资产记录字节大小和 SHA-256；禁止空文件、改名旧版本、重复内容或个人数据进入 Release。
4. 执行 `npm run test:repo`、`node tests/desktop-release-contract.test.js`、`node tests/android-package.test.js --source-only`、`node tests/cloudflared-bundle.test.js` 和对应平台的实际构建/验收。
5. 用 `gh release view <tag> --json assets` 确认 API 资产数为 8；再在网页上确认包含两个 GitHub 源码归档后总数为 10。

## 同版本替换规则

发现已发布资产有缺陷时，只清理当前版本 Release API 中的维护者资产，不删除历史 Release、历史 tag 或其他版本文件。修复必须先通过 Windows/Android 运行验证；随后一次性恢复本清单的 8 个真实资产，最后再更新 Release 正文并核对页面 10 个可见文件。重传中间状态不是完整发布，不能对外宣称完成。

## 当前记录

v2.3.0 同版本纠正覆盖于 2026-08-31 完成最终 Tag 构建、哈希回读和 8+2 文件核对，并公开为 Latest。最终注释 Tag 对象为 `d5db7eff01faa57624b7d750f161eba982fb0d0c`，指向提交 `f931bf2097c03712d90d3aa7c30314c675e8d5e7`，原子运行 `33405585536` 成功。下表记录当前 Release API 回读的新 8 项维护者资产。

| 维护者资产 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `SyncWatch-Experience-Client-Portable-v2.3.0-x64.exe` | 176761018 | `66852eb044b5ae1ea7ea93c8b58c20a60f7cc76989ac5ccf84ed2e0349557f2a` |
| `SyncWatch-v2.3.0-Full-Offline-Portable-x64.exe` | 402448677 | `39265451a947004eda5a9c9e39b3eb223a732309e0e10ac78574eea80653dfb6` |
| `SyncWatch-Android-v2.3.0-universal.apk` | 161644959 | `135510a7ebd98d009bf9299c62acfcdc811c37c18c6472394155b1a4e058fd6a` |
| `node-v24.19.0-x64.msi` | 32972800 | `f0f66c2a80c08a30a5ab5179ee9ea9e45f9b46289436a8cc87ff833b852db351` |
| `node-v24.19.0-arm64.msi` | 29491200 | `47b16e1b1012b1b9ad62169b3a466adb6bc758b2cb8bd8224683c086836484f8` |
| `cloudflared-windows-x64.exe` | 54893480 | `c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5` |
| `cloudflared-windows-x64-installer.msi` | 19357696 | `7067806367266ad66ae8e742b2856827a8ff07e1eb45f8fcbb335d4a28988a23` |
| `cloudflared-windows-x86-installer.msi` | 19090432 | `c8d16c3cf20106958ec907361844c170cbeafb1f1c8ba24c906f332413381dc5` |

共享性能、音源状态、主题回执和桌面启动重试已经由最终 Tag 重新构建进入当前应用资产，没有重用、改名或复制旧应用包。原子切换成功后只删除了被新 8 项替换的 v2.3.0 旧资产，所有历史 Release 保持不变。

v2.1.7、v2.1.8、v2.1.9、v2.2.0、v2.2.3、v2.2.4 和 v2.2.5 的历史 Release 保持原有 26 个维护者资产与两个 GitHub 源码归档。v2.2.6 的旧 26 项曾被用户确认未包含本轮源码修正，因此旧 Actions、旧 Tag SHA 和旧远端哈希只作为线上基线，不能作为同版本更正版完成证据。

v2.2.4 的 17 个 SyncWatch 应用资产（Windows 4、Android 1、macOS 12）已从最终 Tag 重新构建并验证；Node.js 4 项和 cloudflared 5 项已按官方原始分发另行核对来源、版本、平台/架构、字节数和 SHA-256。v2.2.6 同版本更正版必须重新完成同样的证据链。

同版本替换使用安全切换：旧 8 项保持在线到新 8 项全部构建；最终短暂转草稿，新文件以临时名上传并完成远端哈希回读，再把旧文件改为备份名、新文件切换正式名。新集合完整验证前失败必须恢复旧名称和公开状态；新集合验证后才删除旧资产并发布，最终 API 必须恰有 8 项。

