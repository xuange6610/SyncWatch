# macOS 构建与发布

SyncWatch同步观影 的 macOS 服务器和客户端使用 Electron，支持 Intel x64 与 Apple Silicon arm64。macOS 产物必须在 macOS 主机或 macOS CI 上构建，Windows 不能生成可运行、可签名和可 notarize 的 macOS DMG。

## 构建前

1. 安装 Node.js 22+、Xcode Command Line Tools，并执行 `npm ci`。
2. 保持网络可访问 GitHub。构建脚本会读取 Cloudflare 官方 Release API，下载 Intel/Apple Silicon 资产并强制校验 GitHub 提供的 SHA256 摘要。
3. 生产发布时配置 Apple Developer ID、签名证书、公证凭据和 `CSC_LINK`/`CSC_KEY_PASSWORD`。

脚本会分别以 `npm_config_arch=x64` 与 `npm_config_arch=arm64` 重装锁定依赖后再打包，确保 FFmpeg/FFprobe 与各自架构一致，避免把主机构架的媒体二进制误装进另一架构的 DMG。

## 构建

```bash
bash scripts/build-macos.sh
```

在 Windows 或 Linux 上执行同一条命令会生成四个未签名、可直接解压运行的 macOS `.app` ZIP：脚本使用 Electron 官方 Darwin 运行时，保留框架符号链接，并把目标架构的 ffmpeg、ffprobe 和 cloudflared 一起放入服务器包。Windows/Linux 不能生成真实 DMG，也不能完成 Apple Developer ID 签名或公证；这几步必须在 macOS 主机或 macOS CI 上执行。

也可以在 Windows PowerShell 中只生成 ZIP：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-macos-portable.ps1
```

生成到根目录 `dist/` 的文件：

- `SyncWatch-Server-macOS-v2.2.0-x64.dmg` / `.zip`
- `SyncWatch-Server-macOS-v2.2.0-arm64.dmg` / `.zip`
- `SyncWatch-Client-macOS-v2.2.0-x64.dmg` / `.zip`
- `SyncWatch-Client-macOS-v2.2.0-arm64.dmg` / `.zip`

不再在项目根目录或 `dist-mac-*` 保留重复副本。ZIP 适合企业内部分发和完整离线包内嵌；Windows 发布机不会伪造 macOS 文件。

GitHub Release 使用仅含 ASCII 的公共下载名，避免平台上传接口删除中文后造成客户端与服务器同名覆盖：

- `SyncWatch-Server-macOS-v2.2.0-x64.dmg` / `.zip`
- `SyncWatch-Server-macOS-v2.2.0-arm64.dmg` / `.zip`
- `SyncWatch-Client-macOS-v2.2.0-x64.dmg` / `.zip`
- `SyncWatch-Client-macOS-v2.2.0-arm64.dmg` / `.zip`

## 下载产物如何发布

服务器会自动检查以下位置（优先使用 DMG，没有 DMG 时使用 ZIP）：

- 与服务器可执行文件同级的 `mac/`；
- 项目根目录的 `dist/`；
- 部署包中的 `mac/` 目录。

文件名必须与以下格式一致：
正式资产使用 `SyncWatch-Server-macOS-v2.2.0-x64.dmg`、`SyncWatch-Server-macOS-v2.2.0-arm64.zip`（客户端同理）。旧的中文本地文件名仍可被服务器兼容读取；只有真实存在且非空的文件才会出现在下载按钮和 `/api/public-config` 中。

### 从 HTTPS 发布站点提供产物

如果不想占用服务器磁盘，在服务器根目录的 `mac/mac-distribution.json` 中配置真实的 HTTPS URL。可从 `mac-distribution.example.json` 复制并修改；示例中的 `downloads.example.com` 不是可用地址，不会被当成产物。也可使用环境变量 `SYNCWATCH_MAC_SERVER_ARM64_DMG_URL` 等单个地址，或 `SYNCWATCH_MAC_RELEASE_BASE_URL` 以标准文件名提供全部八个产物。远程下载使用 302 重定向，不经过 SyncWatch同步观影 服务器传输视频或安装包。

查看可用枞举：`GET /api/public-config`。如果没有真实产物，下载接口会返回 `MACOS_ARTIFACT_UNAVAILABLE` 和构建/配置指引，不会返回一个伪造的 DMG。

## Windows 发布机的可交付边界

Windows 无法生成可运行、可签名和可公证的 macOS DMG。请在 macOS 主机或 macOS CI 运行 `bash scripts/build-macos.sh`，然后将生成的 DMG/ZIP 放入上述目录，或上传到 HTTPS 发布站点并配置 manifest。未配置真实产物时界面显示“尚未提供”是正确状态，不应下载一个伪造文件。
