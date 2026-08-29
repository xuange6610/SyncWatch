# 公网访问与 Cloudflare Tunnel

`cloudflared` 是 Cloudflare Tunnel 连接器，负责把本机 HTTP、Socket.IO 和媒体 Range 请求转发到 Cloudflare Edge；它不保存 SyncWatch 账号或影片。

## 临时公网访问

1. 先完成局域网登录、建房和同步播放测试。
2. 打开“服务器设置 → 公网访问”，选择临时公网访问。
3. 完整服务器包优先使用 `vendor/cloudflared.exe`；源码/独立 ZIP 缺少文件时会从 Cloudflare 官方 Release 下载并校验 SHA-256。
4. 等待界面出现 HTTPS 地址，点击连接诊断确认 HTTP、WebSocket 和媒体 Range。
5. 只把地址和房间密码发给可信成员。临时地址重启后可能变化。

## 固定域名

在 Cloudflare 控制台创建 Tunnel，配置 DNS 和访问策略，把本地服务指向 `http://127.0.0.1:20311`。令牌只存放在服务器数据目录的 secrets 中，不要提交 Git。

## 连接失败

新版默认使用 `--protocol auto`：cloudflared 会优先协商 QUIC，失败或被拦截时自动回退 HTTP/2。桌面端按预检结果尝试物理 IPv4/DoH Edge 直连，必要时切换到继承系统代理的自动协议；每个候选连接器都要通过固定小响应 `/api/tunnel-health` 验证后才发布地址。应用配置仍可用 `/api/public-config` 检查。只有排查 QUIC/UDP 被拦截时，才临时使用 `--protocol http2` 做对照测试。

允许 cloudflared 出站访问 TCP 443、TCP 7844 和 UDP 7844；VPN/TUN 或 Fake-IP DNS 可能拦截连接，建议对 cloudflared 和 Cloudflare 域名设置直连。必须经过代理时取消“绕过系统代理”，再运行“网络诊断与修复”。完整错误、平台和时间应从日志中心导出并脱敏。

完整安装和命令示例见 [cloudflared 与 Node.js 安装使用](10-Cloudflared与Node安装)。
