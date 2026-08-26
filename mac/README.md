# macOS 安装包嵌入目录

目录中的 `.zip` 是真实的 macOS `.app` 分发包。Windows/Linux 构建机可以通过 `scripts/build-macos-portable.js` 生成未签名 ZIP；macOS 构建机再额外生成 DMG、Developer ID 签名和公证产物。没有真实文件时，下载接口会显示“暂无可用选项”，不会发布空壳安装包。

在 macOS 构建机执行 `bash scripts/build-macos.sh` 后，真实 DMG/ZIP 会生成到根目录 `dist/`。Windows 的 `build-windows.ps1` 会从该目录读取真实 ZIP 并构建完整离线包；本目录只保留可选的 HTTPS manifest。

支持的标准文件名：

- `SyncWatch-Server-macOS-v2.2.3-arm64.dmg` / `.zip`
- `SyncWatch-Server-macOS-v2.2.3-x64.dmg` / `.zip`
- `SyncWatch-Client-macOS-v2.2.3-arm64.dmg` / `.zip`
- `SyncWatch-Client-macOS-v2.2.3-x64.dmg` / `.zip`

也可以在本目录放置 `mac-distribution.json`，配置已经发布到 HTTPS 的真实安装包地址。示例见项目根目录的 `mac-distribution.example.json`。Windows 无法生成、签名或公证可运行的 macOS 安装包，因此这里不接受伪造的空 DMG。
