# SyncWatch同步观影 v2.4.4 发布说明

## 产品简介

SyncWatch同步观影 是开源、自托管的跨平台同步观影与实时协作系统。房主运行自己的服务器，成员通过 Windows、Android 或浏览器加入同一房间。

首次启动后请立即修改默认管理员密码，并妥善保存新的凭据。

## 下载文件怎么选

| 下载文件 | 版本标识 | 最适合谁 | 一句话说明 |
| --- | --- | --- | --- |
| `SyncWatch-Experience-Client-Portable-v2.4.4-x64.exe` | Windows 体验版 | 普通成员 | 连接已有服务器，不启动本机服务端。 |
| `SyncWatch-v2.4.4-Full-Offline-Portable-x64.exe` | Windows 完整便携版 | 房主 | 双击即可开房，包含完整运行环境。 |
| `SyncWatch-Android-v2.4.4-universal.apk` | Android 通用 APK | 手机成员或房主 | 加入房间，受支持设备可运行手机服务器。 |
| `node-v24.19.0-*.msi` | Node.js 官方环境包 | 开发者/独立服务器 | 仅源码和独立 Node 服务端需要。 |
| `cloudflared-windows-*` | cloudflared 独立工具 | 公网部署用户 | Cloudflare Tunnel 连接器，不是 SyncWatch 启动程序。 |

## 更新公告

- 修复长时间保持房间播放时的权威时钟越界：服务端按已知媒体时长投影播放进度，到达末尾自动暂停并广播最终时间；新加入成员不再跳到影片末尾之后而持续缓冲。
- 修复原画偏好在公网或浏览器环境下选择不可解码源的问题：当 MKV、HEVC、10-bit 或其他高风险容器/编码已有已验证兼容 MP4 时，客户端自动选择 H.264/AAC 兼容源；可直接播放的 H.264/MP4 仍保留原画。
- 增加播放时钟封顶、自动兼容源选择和缺少媒体时长时的时钟投影回归测试；既有媒体 Range、NAT/反向代理、格式分类和网络恢复测试继续覆盖。
- 同步更新 Windows、Android、Docker、下载中心、Pages、仓库 Wiki、版本字段与发布清单为 v2.4.4。候选版本必须完成最终 Tag 的真实构建、启动、哈希和远端页面验收后才公开为 Latest。

## 使用说明

- 普通用户怎么选：Windows 成员下载 Experience；房主下载 Full Offline；手机用户安装 Android APK；也可直接用浏览器加入。
- Windows + Android 套装：房主使用 Windows 完整便携版，成员使用 Experience 或 Android APK。
- 一键运行包含什么：Windows 完整便携版包含服务端、前端、媒体处理和客户端/Android 离线资源。
- 架构支持边界：Windows 应用提供 x64；Android APK 包含 arm64-v8a、armeabi-v7a、x86_64；小米 14/HyperOS 真机未在本轮实测。
- cloudflared 独立工具：只从 Cloudflare 官方 Release 获取并按官方校验值核对，用于把自建服务器转为 HTTPS 公网入口。
- Node.js 官方环境包：仅用于源码开发或独立服务器，Windows 应用本身不要求另装 Node.js。
- 编码边界：扩展名表示可上传的视频输入类型；实际能否解码取决于文件完整性、FFmpeg 解码器和观看端浏览器。桌面服务器优先提供兼容 MP4，Android 无 FFmpeg 时保留原片并显示无法生成兼容版。

## 首次启动

先在同一 Wi-Fi 下验证登录、上传、播放、暂停、拖动和倍速，再配置 NAT、反向代理或 Cloudflare Tunnel 公网入口。公网部署后必须回读 `/api/public-config` 为 v2.4.4，并使用已认证媒体请求确认 `206`、`Content-Range`、`Content-Length` 和 `video/*` MIME。

## 资产与验收

本文件描述 v2.4.4 候选版本。Windows 体验版、完整便携版和 Android APK 必须由最终 v2.4.4 Tag 对应源码真实重建，并完成启动/核心流程、版本、平台、非空大小和 SHA-256 核验；Node.js 与 cloudflared 文件必须按官方来源和固定缓存哈希核验。Release API 未达到 8 个维护者资产加 2 个源码归档前，版本状态保持 pending，不得上传残缺集合或复用旧包。

项目采用 Apache-2.0 许可证，发布时保留原始版权与修改说明。
