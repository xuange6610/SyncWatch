# 发布文件与下载说明

GitHub Release 是下载成品的地方；仓库里的 Source code 压缩包只是源码，不是双击即用的程序。v2.3.8 正在完成最终 Tag 构建和远端验收；完成后 Release API 应包含 8 个上传文件，页面另有 GitHub 自动生成的 2 个源码归档，共 10 个可见文件。

## 文件分类

| 文件 | 谁使用 | 作用 |
| --- | --- | --- |
| `SyncWatch-Experience-Client-Portable-v版本-x64.exe` | Windows 普通成员 | 填服务器地址，加入已有房间，不在本机开服务器 |
| `SyncWatch-v版本-Full-Offline-Portable-x64.exe` | Windows 房主 | 无需安装，双击即可启动服务器，内含离线资源 |
| `SyncWatch-Android-v版本-universal.apk` | Android 用户 | 加入房间；支持的设备可运行手机服务器 |
| `node-v24.19.0-x64.msi` / `node-v24.19.0-arm64.msi` | 源码或独立服务器用户 | 安装 Node.js 和 npm；完整 EXE 不需要另装 |
| `cloudflared-windows-x64.exe` / 两个 Windows MSI | 需要公网访问的 Windows 用户 | Cloudflare 官方 Tunnel 工具，不是 SyncWatch 启动程序 |

新版本不再构建或上传 macOS 安装包；历史 Release 仍按历史记录保留。标准版和完整安装版也不在 v2.3.8 下载清单中。

## 选择流程

1. 你是房主：下载 Windows 完整便携版，双击即可开房。
2. 你是成员：下载 Windows 体验版、Android APK，或直接用浏览器打开房主地址。
3. 你要源码部署：安装 Node.js，执行 `npm ci` 和 `npm start`。
4. 你要公网访问：先启动服务器，再按教程安装 cloudflared 并开启临时 HTTPS 地址。

## 下载后校验

PowerShell 示例：

```powershell
Get-FileHash .\SyncWatch-v2.3.1-Full-Offline-Portable-x64.exe -Algorithm SHA256
```

文件为空、哈希不一致或版本号对不上时，请删除后重新下载，不要给旧文件改名。

## 完整便携版包含什么

完整便携版包含 Windows 服务器、Windows 体验客户端和 Android APK 所需的离线资源。Windows、Android 和浏览器使用各自的客户端，服务器状态通过同一个地址同步。macOS 不属于当前新版本的构建和下载范围。

## 发布说明应该写什么

每次发布要写清版本、文件名、平台、角色、默认端口 `20311`、默认密码修改提醒、测试结果和未提供的成品。8 个上传文件必须逐项核对非空大小、SHA-256、版本和实际来源；根目录 `dist/` 需恰好有 10 个文件（8 个上传资产加 2 个源码归档）后才能发布。

