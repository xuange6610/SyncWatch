# SyncWatch同步观影 v2.4.1 发布说明

## 产品简介

SyncWatch同步观影 是开源、自托管的跨平台同步观影与实时协作系统。房主运行自己的服务器，成员通过 Windows、Android 或浏览器加入同一房间。

首次启动后请立即修改默认管理员密码，并妥善保存新的凭据。

## 更新公告

- 修复 v2.4.0 手机端回归：片库、聊天和成员模块现在可通过移动端模块导航正常打开、切换和返回观影。
- 修复触控布局的 CSS 优先级冲突：侧栏只在未打开时隐藏，打开状态不会再被 `display: none !important` 覆盖。
- 修复聊天模块在手机端被播放器空白网格行推到屏幕外的问题，聊天历史区恢复可见、可滚动布局。
- 新增 390×844 手机尺寸浏览器回归，覆盖片库、聊天、成员连续点击和模块状态恢复。
- 新增微信内置浏览器上传提示：说明微信相册选择器可能限制超过五分钟的视频，并引导改用系统浏览器或 Windows/Android 客户端；服务端默认上传策略仍不设置五分钟时长限制。
- 更新 Windows、Android、Docker、下载中心和文档版本标识为 v2.4.1。

## 下载文件怎么选

| 下载文件 | 版本标识 | 最适合谁 | 一句话说明 |
| --- | --- | --- | --- |
| `SyncWatch-Experience-Client-Portable-v2.4.1-x64.exe` | Windows 体验版 | 普通成员 | 连接已有服务器，不启动本机服务端。 |
| `SyncWatch-v2.4.1-Full-Offline-Portable-x64.exe` | Windows 完整便携版 | 房主 | 双击即可开房，包含完整运行环境。 |
| `SyncWatch-Android-v2.4.1-universal.apk` | Android 通用 APK | 手机成员或房主 | 加入房间，受支持设备可运行手机服务器。 |
| `node-v24.19.0-*.msi` | Node.js 官方环境包 | 开发者/独立服务器 | 仅源码和独立 Node 服务端需要。 |
| `cloudflared-windows-*` | cloudflared 独立工具 | 公网部署用户 | Cloudflare Tunnel 连接器，不是 SyncWatch 启动程序。 |

## 使用说明

- 普通用户怎么选：Windows 成员下载 Experience；房主下载 Full Offline；手机用户安装 Android APK；也可直接用浏览器加入。
- Windows + Android 套装：房主使用 Windows 完整便携版，成员使用 Experience 或 Android APK。
- 一键运行包含什么：Windows 完整便携版已包含服务端、前端、媒体处理和客户端/Android 离线资源。
- 架构支持边界：Windows 应用提供 x64；Android APK 包含 arm64-v8a、armeabi-v7a、x86_64；小米 14/HyperOS 真机未在本轮实测。
- cloudflared 独立工具：只从 Cloudflare 官方 Release 获取并按官方校验值核对，用于把自建服务器转为 HTTPS 公网入口。
- Node.js 官方环境包：仅用于源码开发或独立服务器，Windows 应用本身不要求另装 Node.js。

## 资产与验收

正式 Release 应包含 8 个维护者资产，GitHub 页面另有 2 个源码归档，共 10 个可见文件。上传前必须从最终 v2.4.1 Tag 真实重建 Windows/Android 应用，并完成启动、版本、平台、大小和 SHA-256 核验；本轮本地候选构建尚未创建该 Tag。

本阶段先完成本地 `dist/` 构建与手机尺寸回归，未上传 GitHub；上传前等待维护者确认。

项目采用 Apache-2.0 许可证，发布时保留原始版权与修改说明。
