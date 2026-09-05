# SyncWatch同步观影 v2.4.3 发布说明

## 产品简介

SyncWatch同步观影 是开源、自托管的跨平台同步观影与实时协作系统。房主运行自己的服务器，成员通过 Windows、Android 或浏览器加入同一房间。

首次启动后请立即修改默认管理员密码，并妥善保存新的凭据。

## 下载文件怎么选

| 下载文件 | 版本标识 | 最适合谁 | 一句话说明 |
| --- | --- | --- | --- |
| `SyncWatch-Experience-Client-Portable-v2.4.3-x64.exe` | Windows 体验版 | 普通成员 | 连接已有服务器，不启动本机服务端。 |
| `SyncWatch-v2.4.3-Full-Offline-Portable-x64.exe` | Windows 完整便携版 | 房主 | 双击即可开房，包含完整运行环境。 |
| `SyncWatch-Android-v2.4.3-universal.apk` | Android 通用 APK | 手机成员或房主 | 加入房间，受支持设备可运行手机服务器。 |
| `node-v24.19.0-*.msi` | Node.js 官方环境包 | 开发者/独立服务器 | 仅源码和独立 Node 服务端需要。 |
| `cloudflared-windows-*` | cloudflared 独立工具 | 公网部署用户 | Cloudflare Tunnel 连接器，不是 SyncWatch 启动程序。 |

## 更新公告

- 修复 NAT 转发、Nginx/Caddy 等公网代理对媒体响应的兼容性：媒体 Range 响应不再发送可能被误解为压缩编码的 `Content-Encoding: identity`，并增加 `X-Accel-Buffering: no`，继续保留真实 `video/*` MIME、`Accept-Ranges`、`Content-Range` 和 `Content-Length`。
- 纠正媒体文件打开失败时的响应竞态：服务端会先确认文件描述符成功打开再启动 `pipeline`，存储挂载、权限或文件句柄异常现在返回可诊断的 HTTP 错误，不再把已发出的媒体响应直接重置为 `ECONNRESET`。
- 保留并验证 MP4、AVI、MOV、MKV、FLV、WMV、RM、RMVB、3GP、M4V、ASF、ASX、DAT、VOB、TS、WebM、MPEG、MPG、DivX、XviD、ProRes、AV1、H.264、H.265 和 VP9 的上传分类；FFprobe/FFmpeg 可用时继续生成浏览器兼容的 H.264/AAC MP4。
- 新增媒体响应头、文件打开失败和 80 次大文件 Range 中止清理回归断言；媒体扩展名、上传分类、FFmpeg 兼容转码和播放器恢复测试继续通过。
- 同步更新 Windows、Android、Docker、下载中心、Pages、仓库 Wiki、发布清单和版本标识为 v2.4.3；历史 v2.4.2 及更早 Release、Tag 和资产保持不变。

## 使用说明

- 普通用户怎么选：Windows 成员下载 Experience；房主下载 Full Offline；手机用户安装 Android APK；也可直接用浏览器加入。
- Windows + Android 套装：房主使用 Windows 完整便携版，成员使用 Experience 或 Android APK。
- 一键运行包含什么：Windows 完整便携版已包含服务端、前端、媒体处理和客户端/Android 离线资源。
- 架构支持边界：Windows 应用提供 x64；Android APK 包含 arm64-v8a、armeabi-v7a、x86_64；小米 14/HyperOS 真机未在本轮实测。
- cloudflared 独立工具：只从 Cloudflare 官方 Release 获取并按官方校验值核对，用于把自建服务器转为 HTTPS 公网入口。
- Node.js 官方环境包：仅用于源码开发或独立服务器，Windows 应用本身不要求另装 Node.js。
- 编码边界：扩展名表示可上传的视频输入类型；实际能否解码取决于文件是否完整、FFmpeg 是否包含对应解码器，以及观看端浏览器支持。桌面服务器会优先提供兼容 MP4，Android 无 FFmpeg 时保留原片并明确显示不可生成兼容版。

## 资产与验收

v2.4.3 资产已由最终 Tag 对应源码真实重建，并完成启动、核心流程、版本、平台、大小和 SHA-256 核验。Release API 包含 8 个维护者资产，GitHub 页面另有 2 个源码归档，共 10 个可见文件；当前 Release 已公开为 Latest。

项目采用 Apache-2.0 许可证，发布时保留原始版权与修改说明。
