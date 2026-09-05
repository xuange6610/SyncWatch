# SyncWatch同步观影 v2.4.2 发布说明

## 产品简介

SyncWatch同步观影 是开源、自托管的跨平台同步观影与实时协作系统。房主运行自己的服务器，成员通过 Windows、Android 或浏览器加入同一房间。

首次启动后请立即修改默认管理员密码，并妥善保存新的凭据。

## 下载文件怎么选

| 下载文件 | 版本标识 | 最适合谁 | 一句话说明 |
| --- | --- | --- | --- |
| `SyncWatch-Experience-Client-Portable-v2.4.2-x64.exe` | Windows 体验版 | 普通成员 | 连接已有服务器，不启动本机服务端。 |
| `SyncWatch-v2.4.2-Full-Offline-Portable-x64.exe` | Windows 完整便携版 | 房主 | 双击即可开房，包含完整运行环境。 |
| `SyncWatch-Android-v2.4.2-universal.apk` | Android 通用 APK | 手机成员或房主 | 加入房间，受支持设备可运行手机服务器。 |
| `node-v24.19.0-*.msi` | Node.js 官方环境包 | 开发者/独立服务器 | 仅源码和独立 Node 服务端需要。 |
| `cloudflared-windows-*` | cloudflared 独立工具 | 公网部署用户 | Cloudflare Tunnel 连接器，不是 SyncWatch 启动程序。 |

## 更新公告

- 修复 MP4 在公网 HTTPS/Tunnel 场景下无法播放的问题：视频 Range 响应不再被强制标记为 `application/octet-stream`，继续保留真实 `video/*` MIME、`Content-Range` 和 `Accept-Ranges`。
- 扩展视频上传分类，覆盖 MP4、AVI、MOV、MKV、FLV、WMV、RM、RMVB、3GP、M4V、ASF、ASX、DAT、VOB、TS、WebM、MPEG、MPG、DivX、XviD、ProRes、AV1、H.264、H.265 和 VP9 常见扩展名。
- 文件、文件夹和登录背景视频选择器同步展示上述格式；桌面服务器继续使用 FFprobe/FFmpeg 生成浏览器兼容的 H.264/AAC 版本，无法探测或损坏的内容仍会被拒绝或标记不可用。
- 新增媒体格式上传与公网 Range/MIME 回归测试，并执行真实 FFmpeg H.264、HEVC、10-bit、HLS、缩略图、兼容转码、缓存失效和无 FFmpeg Android 式服务器测试。
- 同步更新 Windows、Android、Docker、下载中心、Pages、仓库 Wiki、发布清单和版本标识为 v2.4.2；历史 v2.4.1 及更早 Release、Tag 和资产保持不变。

## 使用说明

- 普通用户怎么选：Windows 成员下载 Experience；房主下载 Full Offline；手机用户安装 Android APK；也可直接用浏览器加入。
- Windows + Android 套装：房主使用 Windows 完整便携版，成员使用 Experience 或 Android APK。
- 一键运行包含什么：Windows 完整便携版已包含服务端、前端、媒体处理和客户端/Android 离线资源。
- 架构支持边界：Windows 应用提供 x64；Android APK 包含 arm64-v8a、armeabi-v7a、x86_64；小米 14/HyperOS 真机未在本轮实测。
- cloudflared 独立工具：只从 Cloudflare 官方 Release 获取并按官方校验值核对，用于把自建服务器转为 HTTPS 公网入口。
- Node.js 官方环境包：仅用于源码开发或独立服务器，Windows 应用本身不要求另装 Node.js。
- 编码边界：扩展名表示可上传的视频输入类型；实际能否解码取决于文件是否完整、FFmpeg 是否包含对应解码器，以及观看端浏览器支持。桌面服务器会优先提供兼容 MP4，Android 无 FFmpeg 时保留原片并明确显示不可生成兼容版。

## 资产与验收

正式 Release 已包含 8 个维护者资产，GitHub 页面另有 2 个源码归档，共 10 个可见文件。原子发布运行 `33942963223` 已从最终 v2.4.2 Tag 真实重建 Windows/Android 应用，并完成启动、版本、平台、大小和 SHA-256 核验；Node.js 与 cloudflared 文件已按官方来源和固定哈希核验。逐项哈希记录见 [Release 资产清单](release/release-manifest.md)。

项目采用 Apache-2.0 许可证，发布时保留原始版权与修改说明。
