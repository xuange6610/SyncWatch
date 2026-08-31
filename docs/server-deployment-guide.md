# SyncWatch同步观影 服务器部署与使用教程

适用版本：v2.3.0 正式版（文档更新于 2026-08-31，Release API、Actions 与下载回读已核验）

本文面向需要把 SyncWatch同步观影 放到 Windows Server、Linux 云服务器、Docker 或内网穿透环境长期运行的用户。文中的 `vX.Y.Z` 表示实际部署版本；当前正式下载为 v2.3.0，文件名、大小和 SHA-256 以 GitHub Release 页面为准。

## 1. 先理解“程序”和“数据”

独立服务器包只包含运行程序、网页、Android APK 和锁定的生产依赖。所有会持续变化的数据都保存在服务器包根目录的 `SyncWatch同步观影-Data/`：

- `config.json`：账户密码哈希、显示名字、邮箱、房间、权限、队列、影片索引、管理员设置和操作历史。
- `chat-history.jsonl`：公共聊天与私聊记录。
- `uploads/`：上传的视频、音频和字幕原文件。
- `thumbnails/`、`subtitles/`、`voice/`：缩略图、转换后的字幕和语音消息。
- `trash/`：用于删除恢复和操作回溯的临时回收数据。
- `.secrets/mail.key`：解密 QQ SMTP 授权码所需的本机密钥。
- `.secrets/server-host-token.txt`：独立服务器房主入口令牌。
- `secrets/admin-password.json`：独立的超级管理员密码哈希。删除非隐藏的整个 `secrets/` 目录后，下次启动会恢复 `admin/admin888` 初始登录并重建该文件。
- `.syncwatch-instance.lock/`：服务器运行期间的数据目录单实例锁，正常关闭会自动删除。
- `服务器运行信息.txt`：最近一次启动的地址、端口和私密房主入口。

因此，“搬迁服务器”必须停止服务后完整移动 `SyncWatch同步观影-Data/`，其中也包含 `server-config.json`。不能只复制 `config.json`，不能遗漏隐藏的 `.secrets/`，也不要把两套数据目录直接混合覆盖。

独立服务器不会把数据写回源码目录之外，也不会使用 Windows AppData。桌面 EXE 同样默认把账户、媒体、缓存、日志和密钥写入 EXE 同目录的 `SyncWatch同步观影-Data/`。Android 内置服务器受 Android 系统限制，数据位于应用的私有存储中；升级 APK 时应直接覆盖安装，不要先卸载。

## 2. 选择部署方式

| 方式 | 适合场景 | 首次网络要求 | 数据位置 |
| --- | --- | --- | --- |
| Windows Server ZIP | Windows 云主机、家用 Windows 主机 | ZIP 已带 Windows x64 生产依赖，正常启动不需要 npm 下载；仍需预装 Node.js | `服务器目录/SyncWatch同步观影-Data` |
| Linux x64 直接部署 | 已有 Node.js 运维环境 | Windows 生成的 ZIP 首次会为 Linux 重装锁定依赖，需要访问 npm | `服务器目录/SyncWatch同步观影-Data` |
| Docker Compose（linux/amd64） | Linux x64 云服务器、需要一致环境 | 首次构建需要拉取 Node 镜像和依赖 | 宿主机 `./SyncWatch同步观影-Data` |
| 桌面 EXE | Windows 图形界面房主、需要内置 Cloudflare Tunnel | EXE 本身无需 Node.js | `EXE目录/SyncWatch同步观影-Data` |

生产云服务器优先推荐 Docker Compose；Windows Server 可直接使用 ZIP。直接部署需要 Node.js 22 或更高版本；截至 2026-08-05，推荐使用处于 Active LTS 的 Node.js 24，Dockerfile 也固定为 `node:24-bookworm-slim`。本发布包已验证 Windows x64 和 Linux x64/`linux/amd64`；由于 FFprobe 依赖未提供 Linux ARM64 成品，不应把本版本直接部署到 ARM 云主机。

### 2.1 纯 Node.js 控制台怎样进入管理

`node server-standalone.js` 是纯控制台服务端，不会显示 Electron 的“系统 / 视图 / 帮助”原生菜单。它提供等价而可脚本化的入口：

```powershell
node server-standalone.js --help
node server-standalone.js --port=20311 --open-browser
```

服务就绪后，控制台摘要和 `SyncWatch同步观影-Data/服务器运行信息.txt` 都会列出带 `#host=` 的私密管理 URL、配置文件、数据目录与实际监听端口；`--open-browser` 仅在本机默认浏览器打开该 URL。不要公开或写入代理日志。浏览器中的刷新、全屏、缩放使用 F5、F11、Ctrl+0；项目主页与 Wiki 从页面“关于”进入。原有“服务器配置怎么选”顺延为下一小节。

### 2.2 服务器配置怎么选

SyncWatch同步观影 的网页、聊天和同步状态本身很轻，真正消耗资源的是媒体存储、同一影片向多名用户传输，以及不兼容视频的 FFmpeg 转码。服务器不会把一份公网流自动变成运营商组播；同一原画影片有多少名远程观看者，就大致需要多少份服务器出网带宽。

| 使用规模 | 建议 CPU / 内存 | 建议磁盘 | 建议公网带宽 | 适用情况 |
| --- | --- | --- | --- | --- |
| 1-5 人轻量使用 | 2 核 / 4 GB | 系统盘 40 GB，加 100 GB SSD 数据盘 | 上下行 20-50 Mbps | 720p/1080p、小文件、很少转码 |
| 5-15 人家庭或小团队 | 4 核 / 8 GB | 200-500 GB SSD | 上下行 100 Mbps | 多房间、1080p、聊天和上传并发 |
| 15-50 人长期公网 | 8 核 / 16 GB 起 | 1 TB SSD 或独立对象/存储规划 | 200 Mbps-1 Gbps | 多房间、较多原画流、经常转码 |
| 4K 或高频转码 | 12-16 核 / 32 GB 起 | NVMe SSD，容量按片库计算 | 500 Mbps-1 Gbps 起 | HEVC/10-bit 转 H.264、多人 4K |

带宽估算公式：`影片平均码率 Mbps × 同时观看人数 × 1.25`。例如一部 8 Mbps 的 1080p 影片有 10 人同时看，建议至少准备约 100 Mbps 的实际可用服务器上行；25 Mbps 的 4K 影片有 10 人同时看，建议至少约 313 Mbps。云厂商标注的“带宽”通常是服务器出公网方向的峰值，购买前还要确认月流量包、超额费用和是否限速。

磁盘至少要容纳：原始上传文件、转换后的兼容版本、缩略图/字幕/语音、30 天回收数据以及一份离线备份。准备 200 GB 片库时，建议数据盘不要小于 450-500 GB。CPU 较弱但不需要转码时，应尽量提前把影片转换为 H.264/AAC MP4。

### 2.3 小白最稳妥的 0 到 1 路线

推荐成品架构：`域名 -> HTTPS 的 Caddy/Nginx -> 127.0.0.1:20311 的 SyncWatch同步观影 -> 独立 SyncWatch同步观影-Data 数据盘`。

1. 购买一台 `x86_64/AMD64` 云服务器，推荐 Ubuntu 24.04 LTS、4 核 8 GB、100 Mbps 带宽、200 GB 以上 SSD。
2. 购买或准备一个域名，在 DNS 控制台添加 A 记录，例如 `watch.example.com` 指向服务器公网 IPv4。
3. 云安全组放行 TCP 22、80、443；SSH 的 22 端口尽量只允许自己的公网 IP。
4. 按本文第 7 章安装 Docker，把服务器 ZIP 解压到 `/opt/syncwatch`。
5. 创建 `.env`，把容器端口绑定到 `127.0.0.1`，避免 20311 直接暴露公网。
6. 执行 `docker compose up -d --build`，确认服务器本机能访问 `http://127.0.0.1:20311/api/public-config`。
7. 按第 11 章安装 Caddy，配置域名并自动申请 HTTPS 证书。
8. 打开 `https://watch.example.com`，使用私密服务器入口初始化超级管理员，创建正式房间并设置强密码。
9. 用手机蜂窝网络实际测试注册、房间号、登录、播放、聊天、WebSocket、上传和断线恢复。
10. 按第 17 章做第一次完整备份，并记录恢复步骤和管理员联系方式。

## 3. 解压与目录要求

建议使用独立、可写、不会被系统自动清理的目录：

- Windows：`D:\SyncWatch同步观影-Server\`
- Linux：`/opt/syncwatch/`

不要直接在 ZIP 压缩包内运行，也不建议放进 Windows 的 `Program Files` 后以普通用户运行，因为程序必须能创建和修改 `SyncWatch同步观影-Data/`。目录所在磁盘要预留影片、缩略图、回收数据和备份所需空间。

解压后至少应看到：

```text
SyncWatch同步观影-Server-vX.Y.Z/
├─ server/
├─ public/
├─ dist/SyncWatch-Android-vX.Y.Z-universal.apk
├─ node_modules/
├─ SyncWatch同步观影-Data/
│  └─ server-config.json
├─ server-standalone.js
├─ start-server.cmd
├─ start-server.ps1
├─ start-server.sh
├─ docker-compose.yml
└─ Dockerfile
```

## 4. 自定义端口和公网地址

默认端口为 `20311`。当指定端口被占用时，服务器会自动随机选择一个可用端口，并把实际端口写入 `SyncWatch同步观影-Data/服务器运行信息.txt`。

### Windows 桌面服务器的网卡选择

Windows EXE 首次启动时会监听所有本机 IPv4 网卡的 `20311` 端口，并自动选择首选物理网卡作为局域网分享入口。需要固定使用有线、Wi-Fi、VPN 或 TUN 中的某一个 IPv4 时：

1. 在服务器窗口左上角打开“系统 → 服务器启动设置”。
2. 端口保持 `20311`，在“局域网网卡”选择“自动选择（推荐）”或具体的“网卡名称 · IPv4”。
3. 点击“保存并自动重启”。窗口会先释放数据目录锁和端口，再重新启动；关闭服务失败时不会强行重启。
4. 重启后在“系统 → 分享内网地址”查看结果，用同一网络的手机打开该地址验证。

手动网卡断开、IP 变化或不再存在时，启动不会失败，而是自动回退到当前可用网卡。`127.0.0.1` 本机管理入口始终保留。网卡选择控制 SyncWatch 接受哪个本机 IPv4 上的局域网请求；Windows 防火墙属于系统权限，首次提示时仍需手工允许专用网络，或按本章后文添加入站规则。

端口优先级从高到低为：

1. 命令行 `--port`
2. 环境变量 `PORT`
3. `SyncWatch同步观影-Data/server-config.json` 的 `port`

最简单的方法是修改 `SyncWatch同步观影-Data/server-config.json`。首次启动时程序会自动生成该文件：

```json
{
  "port": 20311,
  "publicUrl": "",
  "allowedHosts": []
}
```

直接命令行启动示例：

```powershell
node .\server-standalone.js --port 7000
```

```bash
node ./server-standalone.js --port 7000
```

使用启动脚本时可设置环境变量：

```powershell
$env:PORT = '7000'
.\start-server.ps1
```

```bash
PORT=7000 ./start-server.sh
```

三个独立包启动器 `start-server.cmd` / `start-server.ps1` / `start-server.sh` 都会把额外参数转发给 `server-standalone.js`，因此可直接使用 `--port=20311` 和 `--trusted-proxies=IP/CIDR,...`。

使用域名或反向代理时，建议同时设置：

```json
{
  "port": 20311,
  "publicUrl": "https://watch.example.com",
  "allowedHosts": ["watch.example.com"]
}
```

`publicUrl` 必须是完整的 `http://` 或 `https://` 根地址，不要附加 `/syncwatch` 等子路径；`allowedHosts` 只写 `主机名` 或 `主机名:端口`，不要写协议和路径。环境变量 `SYNCWATCH_ALLOWED_HOSTS` 可使用英文逗号分隔多个值。

代理与 SyncWatch 不在同一回环/本机网卡路径时，还要声明受控代理地址，才能恢复真实客户端 IP：

```powershell
$env:SYNCWATCH_TRUSTED_PROXIES = '172.18.0.0/16,10.0.0.5'
node .\server-standalone.js --port 20311

# 也可直接使用启动参数；它会优先于同名环境变量
.\start-server.ps1 --trusted-proxies '172.18.0.0/16,10.0.0.5' --port 20311
```

```bash
SYNCWATCH_TRUSTED_PROXIES=172.18.0.0/16,10.0.0.5 node ./server-standalone.js --port 20311

# 独立包 POSIX 启动器同样转发参数
./start-server.sh --trusted-proxies=172.18.0.0/16,10.0.0.5 --port=20311
```

只填写真实运行 Nginx、Caddy、Docker ingress 或 frp 的精确 IP/CIDR。不得使用 `0.0.0.0/0`、`::/0`、整个办公网或不受控网段；两个 `/0` 全网段会被源码当作无效条目 fail-closed 忽略。参数存在但没有值时服务器会拒绝启动，避免误把后续开关当成地址。不可信 TCP 对端的 `X-Forwarded-For`、`CF-Connecting-IP` 和 `X-Real-IP` 会被故意忽略。内置 cloudflared 回源到本机时无需手工设置。

Windows EXE 可直接在“系统 → 服务器启动设置 → 公网根地址”填写同一值。正确填写顺序是：

1. 先把域名 DNS 指向公网入口，并在 Caddy/Nginx/Cloudflare 配置可用的 HTTPS 证书与 WebSocket 反向代理。
2. 从外部网络验证 `https://watch.example.com/api/public-config` 能打开。
3. 再填写 `https://watch.example.com`。只填协议、主机名和可选端口，不填账号、密码、查询参数、`#` 片段或子路径。
4. 保存自动重启后，该地址作为分享地址和 Host/Origin 信任校验；如果当前有已验证的 Cloudflare Tunnel，分享时优先显示 Tunnel 地址，Tunnel 停止后回退至该公网根地址。

此字段不会代为购买域名、配置 DNS、申请证书、设置路由器端口转发或启动反向代理。仅使用 Cloudflare 临时公网访问时可以留空。

## 5. Windows Server 直接部署

1. 从 Node.js 官方网站安装 64 位 Node.js 24 LTS，并确认新的 PowerShell 中能执行：

   ```powershell
   node --version
   npm --version
   ```

2. 解压服务器 ZIP 到可写目录。
3. 先启动一次生成数据目录，再修改 `SyncWatch同步观影-Data/server-config.json` 并重启服务。
4. 双击 `start-server.cmd`，或在 PowerShell 中执行：

   ```powershell
   Set-Location 'D:\SyncWatch同步观影-Server'
   .\start-server.ps1
   ```

5. 控制台显示地址后，先在服务器本机打开 `http://127.0.0.1:端口`。
6. 私密房主入口同时写入 `SyncWatch同步观影-Data/服务器运行信息.txt`。设置了 `publicUrl` 时，该入口会使用公网地址；未设置时默认是 `127.0.0.1`。远程管理者可在已经正确配置 `publicUrl`/`allowedHosts` 和反代后，把链接的地址部分换成实际公网地址，但必须原样保留 `#host=` 后的令牌。包含 `#host=` 的完整链接只能由服务器管理者使用，不能发给普通用户。

ZIP 已包含 Windows x64 的锁定生产依赖、FFmpeg 和 FFprobe。只有依赖被删坏时，启动脚本才会执行 `npm ci --omit=dev` 修复。

### Windows 防火墙

局域网或直接公网访问时，以管理员 PowerShell 放行实际端口：

```powershell
New-NetFirewallRule -DisplayName 'SyncWatch同步观影 TCP 20311' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 20311
```

如果以后改端口，应修改或删除旧规则。使用同机 Nginx/Caddy 反代时，公网只需开放 80/443，20311 可限制为本机或内网访问。

### Windows 开机常驻

可在“任务计划程序”中创建“计算机启动时”任务，操作设置为：

- 程序：`powershell.exe`
- 参数：`-NoProfile -ExecutionPolicy Bypass -File "D:\SyncWatch同步观影-Server\start-server.ps1"`
- 起始于：`D:\SyncWatch同步观影-Server`

运行任务的账户必须对服务器目录有读写权限，而且能在 PATH 中找到 Node.js。建议使用专门的低权限服务账户，不要让普通用户同时修改正在运行的数据目录。

## 6. Linux 直接部署

以下以 Debian/Ubuntu 为例。先安装 Node.js 22+（推荐 24 LTS），然后：

```bash
cd /opt/syncwatch
chmod +x start-server.sh
./start-server.sh
```

服务器 ZIP 在 Windows 上构建，包内媒体二进制也是 Windows x64 版本。`start-server.sh` 会检查当前平台；在 Linux 第一次运行时会执行锁定的 `npm ci --omit=dev`，下载 Linux 对应的生产依赖和媒体工具。因此首次启动需要能够访问 npm。完成后再次启动不需要重复安装。

若系统还没有专用服务账户，先创建一个不允许交互登录的账户，再授予服务器目录权限：

```bash
sudo useradd --system --home-dir /opt/syncwatch --shell /usr/sbin/nologin syncwatch
sudo chown -R syncwatch:syncwatch /opt/syncwatch
```

如果 `syncwatch` 账户已经存在，`useradd` 提示已存在可以忽略，只执行 `chown`。

### systemd 后台常驻

创建 `/etc/systemd/system/syncwatch.service`：

```ini
[Unit]
Description=SyncWatch同步观影 Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=syncwatch
Group=syncwatch
WorkingDirectory=/opt/syncwatch
Environment=NODE_ENV=production
ExecStart=/opt/syncwatch/start-server.sh
Restart=on-failure
RestartSec=3
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
```

启用并查看日志：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now syncwatch
sudo systemctl status syncwatch
sudo journalctl -u syncwatch -f
```

`ExecStart` 使用项目启动脚本，是为了让每次换到新的 Linux 版本目录后都能重新检查平台依赖和 FFmpeg/FFprobe。确保已经执行 `chmod +x /opt/syncwatch/start-server.sh`，并让 systemd 服务账户的 PATH 能找到 Node.js。不要用 `kill -9` 作为正常停机方式；使用 `systemctl stop syncwatch`，让服务器完成安全保存并释放数据目录锁。

### Linux 防火墙

直接开放 20311：

```bash
sudo ufw allow 20311/tcp
```

使用 HTTPS 反代时只开放：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## 7. Docker Compose 部署

下面以全新 Ubuntu 24.04 LTS 为例安装 Docker Engine 和 Compose 插件。先通过 SSH 登录服务器，然后按 Docker 官方仓库方式安装：

```bash
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker run --rm hello-world
sudo docker compose version
```

如果最后两条命令成功，说明 Docker 和 Compose 已就绪。把与目标 Tag 一致、已经验证的 `SyncWatch同步观影-Server-vX.Y.Z.zip` 上传到服务器后解压：

```bash
sudo apt install -y unzip
sudo mkdir -p /opt/syncwatch
sudo unzip ~/SyncWatch同步观影-Server-vX.Y.Z.zip -d /opt/syncwatch
cd /opt/syncwatch
```

若 ZIP 内还有一层同名目录，应进入真正包含 `docker-compose.yml` 的那一层再继续。生产服务器不要使用 `latest` 标签或网上来源不明的 Compose 文件，本项目 Dockerfile 已固定 Node.js 24 的 Debian Bookworm 基础镜像。

长期部署建议先在 `docker-compose.yml` 同目录创建 `.env`，这样升级或重建容器时不会忘记原端口和域名：

```dotenv
SYNCWATCH_PORT=20311
SYNCWATCH_BIND_ADDRESS=127.0.0.1
SYNCWATCH_PUBLIC_URL=https://watch.example.com
SYNCWATCH_ALLOWED_HOSTS=watch.example.com
SYNCWATCH_TRUSTED_PROXIES=172.18.0.1
```

然后执行：

```bash
docker compose up -d --build
```

临时测试也可以只给单次命令设置环境变量：

```bash
SYNCWATCH_PORT=20311 \
SYNCWATCH_PUBLIC_URL=https://watch.example.com \
SYNCWATCH_ALLOWED_HOSTS=watch.example.com \
SYNCWATCH_TRUSTED_PROXIES=172.18.0.1 \
docker compose up -d --build
```

单次命令前的环境变量只对该次 Compose 解析有效；正式服务器应保留 `.env`，以后升级时在同一目录执行命令。

Compose 会把宿主机的 `./SyncWatch同步观影-Data` 绑定到容器的 `/app/SyncWatch同步观影-Data`，并给安全关闭保留 90 秒。删除或重建容器不会删除宿主机数据；但删除服务器目录、误删绑定目录或使用错误的工作目录仍会造成数据丢失。

`SYNCWATCH_BIND_ADDRESS=127.0.0.1` 适用于同机 Caddy/Nginx 反代，公网只能通过 80/443 访问；如果确实需要让局域网设备直接打开 `http://服务器IP:20311`，改为 `0.0.0.0`，并同步配置安全组和防火墙。Docker 发布端口可能绕过部分 UFW 直觉规则，因此生产反代场景优先绑定到 `127.0.0.1`。

常用命令：

```bash
docker compose ps
docker compose logs -f
docker compose restart
docker compose down
docker compose up -d --build
```

自定义端口使用 `SYNCWATCH_PORT`，Compose 会同时修改宿主机映射端口和容器内 `PORT`。`SYNCWATCH_TRUSTED_PROXIES` 也会由 Compose 明确映射到容器；这里填的应是容器看到的实际反向代理对端，不是任意公网来源。不要只改 `Dockerfile` 的 `EXPOSE`。

## 8. 云服务器安全组

云厂商安全组和操作系统防火墙是两层控制，两边都必须正确：

- 直接以 `http://IP:20311` 访问：放行 TCP 20311。
- 使用 Nginx/Caddy HTTPS：放行 TCP 80 和 443，不建议向公网放行 20311。
- 管理用途的 SSH/RDP 应只允许可信来源地址。
- IPv6 部署时还要检查 IPv6 安全组和系统防火墙。

修改规则后，可先在服务器本机访问 `http://127.0.0.1:端口/api/public-config`。本机正常、外部失败通常是安全组、防火墙、NAT 或反代配置问题。

## 9. 域名和 HTTPS

1. 在 DNS 服务商创建 A 记录指向服务器公网 IPv4；使用 IPv6 时再创建 AAAA 记录。
2. 等待 DNS 生效，并确认 80/443 已放行。
3. 使用 Caddy 自动申请证书，或使用 Nginx 配合受信任证书。
4. 把 `SyncWatch同步观影-Data/server-config.json` 的 `publicUrl` 设置为最终 HTTPS 地址，并把域名加入 `allowedHosts`。
5. 重启 SyncWatch同步观影 和反向代理。

网页通过 HTTPS 打开时，Socket.IO/WebSocket 也必须经过同一个 HTTPS 域名。不要让 HTTPS 页面连接明文 `ws://` 或另一个未受信任端口，否则浏览器会阻止连接。

如果域名使用 Cloudflare DNS：

- 灰云“仅 DNS”不会经过 Cloudflare HTTP 代理，最适合需要上传几百 MB 或数 GB 视频的 SyncWatch同步观影。
- 橙云“已代理”支持 WebSocket，但请求体仍受 Cloudflare 套餐上传上限约束。官方当前列出的默认上限为 Free/Pro 100 MB、Business 200 MB、Enterprise 500 MB；超过时会在到达 SyncWatch同步观影 前返回 413。
- 因此需要大文件上传时，应把 SyncWatch同步观影 记录设为“仅 DNS”，或使用支持更大上传上限的企业配置。Cloudflare Tunnel 同样经过 Cloudflare 边缘，不能把应用的 32 GiB 上限误当成代理也能接受 32 GiB。
- 使用橙云时，到 Cloudflare 控制台确认 WebSockets 已启用，并只代理 Cloudflare 支持的 HTTP/HTTPS 端口。最简单的是只对外使用 443，内部仍反代到 20311。

## 10. Nginx 反向代理与 WebSocket

以下最终配置假定 SyncWatch同步观影 在 `127.0.0.1:20311`，并且证书已经位于示例中的 Let’s Encrypt 路径。证书尚未签发时可先使用 Caddy，或按系统发行版安装 Certbot 并为域名签发证书，再启用 443 配置。先在 Nginx 的 `http {}` 级别加入连接升级映射：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

站点配置如下：

```nginx
server {
    listen 80;
    server_name watch.example.com;

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name watch.example.com;

    ssl_certificate /etc/letsencrypt/live/watch.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/watch.example.com/privkey.pem;

    # 让 SyncWatch同步观影 自己执行 32 GiB 媒体上限和管理员限制，避免 multipart
    # 边界开销使接近上限的文件被 Nginx 提前按 413 拒绝。
    client_max_body_size 0;
    client_body_timeout 7200s;

    location / {
        proxy_pass http://127.0.0.1:20311;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 7200s;
        proxy_send_timeout 7200s;
    }
}
```

`client_max_body_size 0` 表示不让 Nginx 另加请求体大小限制；SyncWatch同步观影 管理界面的“最大文件 MB”设置为 0 表示不增加用户配置限制，但服务端仍有 32 GiB 安全上限，语音消息上限为 25 MB。上传时长设置为 0 表示不增加管理员自定义限制，但单次 HTTP 请求仍有 2 小时安全上限。

示例中的 `$proxy_add_x_forwarded_for` 会追加完整代理链。若 Nginx 与 SyncWatch 位于不同主机或容器网段，还要按第 4 章设置 `SYNCWATCH_TRUSTED_PROXIES`；服务端从 XFF 右侧向左剥离可信 hop，首个不可信地址作为真实客户端。不要把 `X-Forwarded-For` 固定写成代理 IP，也不要为了“能读到头”而信任所有来源。

修改后执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 11. Caddy 反向代理与 WebSocket

Caddy 会自动处理 HTTPS 和 WebSocket 升级。Ubuntu 可按 Caddy 官方稳定仓库安装：

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

编辑 `/etc/caddy/Caddyfile`，常用配置只需要：

```caddyfile
watch.example.com {
    reverse_proxy 127.0.0.1:20311
}
```

保存后执行：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy
```

确保 80/443 可从公网访问，DNS 已指向本机，并设置 SyncWatch同步观影 的 `publicUrl` 与 `allowedHosts`。Caddy 标准 `reverse_proxy` 不需要手写 `Upgrade`/`Connection` 头。首次申请证书失败时，先检查 DNS 是否已经指向当前公网 IP、80/443 是否被安全组和防火墙放行，以及同一域名是否被另一台服务器占用。

## 12. 内网穿透

### 桌面 EXE 的内置穿透

Windows 桌面 EXE 的“管理 → 公网访问”包含 Cloudflare Tunnel 管理器：

- 临时模式会启动 Quick Tunnel，生成 `trycloudflare.com` HTTPS 地址。连接器默认使用 `--protocol auto`，由 cloudflared 优先协商 QUIC，无法使用时回退 HTTP/2；程序会根据预检和失败结果，在物理 IPv4/DoH Edge 直连、HTTP/2 与继承系统代理的自动协议之间切换。若系统出口可用而绑定物理网卡失败，会优先系统网络；界面会显示实际连接策略。
- 连接器已注册但新地址在启动验证窗口内仍不可访问时，会停止该未发布连接器并切换下一连接策略；已经验证成功的地址只会在短暂探测波动时显示降级，不会因为一次超时立即更换。
- Clash/FlClash/VPN/TUN Fake-IP 环境下，如果浏览器可联网但“绕过系统代理”失败，请取消勾选；并确保 `cloudflared.exe`、`api.trycloudflare.com`、`*.trycloudflare.com` 与 `*.argotunnel.com` 使用同一条可用网络规则。
- 稳定模式使用 Cloudflare Tunnel 令牌和已经绑定的 HTTPS 域名；令牌只传给子进程，不保存到配置。
- 开启前会提示确认未设置访问密码的房间，建议先为所有公网房间设置独立强密码。

### 独立服务器 ZIP 的差异

独立 ZIP、Linux 和 Docker 版本没有桌面进程，因此不提供管理界面的内置 cloudflared 下载/启停功能；相关按钮会显示当前环境不支持。应使用云服务器本身的 Nginx/Caddy、公网 IP，或单独运行 cloudflared、frp 等穿透程序。

Cloudflare 临时隧道可在服务器外部单独运行：

```bash
cloudflared tunnel --url http://127.0.0.1:20311 --protocol auto --no-autoupdate
```

`auto` 是推荐的默认值；只有排查 QUIC/UDP 被拦截时，才临时改用 `--protocol http2` 做对照测试。Quick Tunnel 仍是临时入口，不提供固定域名、带宽或可用性保证。

无论使用哪种穿透，都必须满足：

- HTTP、Socket.IO polling 和 WebSocket 都转发到同一个 SyncWatch同步观影 端口。
- 内置 cloudflared 的本机回源会自动按可信代理链恢复真实来源 IP；外置代理/容器必须通过 `SYNCWATCH_TRUSTED_PROXIES` 精确声明。HTTP 与 Socket.IO 使用同一解析结果，所以账号审计、封禁和同 IP 游客限制不会把所有公网客户端误归为代理本身。
- 公网网页客户端会优先连接 WebSocket，失败时自动回退 polling；v2.2.6 正式客户端默认播放原画，反向代理或 Tunnel 不会自动改成流畅版。网络受限时可在播放器手动选择流畅版；该 H.264/AAC 低带宽兼容版本目标不高于 854×480、视频约 900 kbps、音频 96 kbps。即使源文件已经是浏览器可解码的 H.264 MP4，只要分辨率或平均码率超过预算也会生成低带宽版本。
- 稳定域名应写入 `publicUrl` 和 `allowedHosts`。临时域名每次会变化，可以先通过该地址进行一次正常页面导航，让本机/内网代理转发的同源主机自动加入当前进程；服务器重启或地址变化后需要重新访问。
- 所有房间设置强密码，不公开带 `#host=` 的房主链接。
- 穿透服务需要长期运行时交给 systemd、Windows 任务计划或对应服务管理器。

## 13. 首次注册和管理员初始化

1. 使用 `SyncWatch同步观影-Data/服务器运行信息.txt` 中带 `#host=` 的私密入口打开服务器。若文件里是 `127.0.0.1` 而管理浏览器不在服务器本机，请先正确设置公网地址和允许主机，再按第 5 章的方法保留令牌并替换地址部分。
2. 在服务器设备登录页选择“服务器超级管理员登录”，使用初始账号 `admin` 和密码 `admin888` 完成认证。
3. 首次登录先阅读并同意使用协议，然后可直接填写新密码和确认密码；本次账号密码会话不需要再次输入 `admin888`。也可点“暂不更改”先进入，但开放公网前必须完成更换。本机免密管理会话没有密码认证凭据，仍要求当前密码。
4. 验证成功后直接打开管理中心服务器设置，观影主界面保持隐藏；超级管理员只有主动选择房间入口后才进入观影流程，不会因房间号留空自动创建临时管理房间。
5. 普通账号注册不要求房间号或房间密码；登录时房间号留空会列出账号拥有或连接过的房间，并允许选择已有房间或临时房间。用户也可在登录后创建自己的第一个正式房间。
6. 普通账号可绑定 QQ 邮箱用于找回密码。登录页会显示当前设备 IP、在线房间、房间即时人数和已连接/拥有的房间入口。
7. 为房间设置访问密码、人数、成员权限、上传审核和上传限制，再开放给其他设备或公网。

新账号名和普通密码默认允许空格、标点、符号及 Unicode，不启用业务字符数限制；服务端保留用户名 1024 UTF-8 字节、密码 4096 UTF-8 字节的防滥用上限。管理员可在“服务器设置 → 账号与密码规则”显式启用字符集和字符数范围。

注册限制申请支持填写多个账号名额，并在仍待处理时按数量部分撤回或全部撤回；内置 `admin` 可在用户申请中心删除单条或批量记录。管理员读取账户清单时只获得密码是否已设置、待修改/过期状态和更新时间，不会获得明文或哈希；“重置为默认密码”会撤销旧会话，操作前应确认默认密码策略并通过安全通道通知本人。

房间“同步网址”仅保证服务器保存和广播同一 HTTP/HTTPS URL/revision；每台设备仍在自己的沙箱 iframe 中加载。跨域、登录 Cookie、地区、CSP/X-Frame-Options 和第三方页面状态可能导致结果不同，服务器和反向代理不应为了“同步交互”关闭这些安全头。需要同一像素画面与主持人操作时使用浏览器标签页或窗口实时共享。

服务器密码有效期默认为 7 天，可在“服务器设置 → 用户密码规则”中修改，设为 0 表示关闭定期修改。未登录时也可在顶栏打开“服务器设置”，输入任一超级管理员账号与密码直接验证，成功后验证输入区会自动隐藏。

超级管理员可在“服务器设置 → 统一界面文案”双击固定白名单条目编辑文字，或集中编辑、导入、导出和恢复默认；更新通过服务端实时同步在线客户端。导入只接受声明过的 key 和纯文本值，不能写入 HTML、脚本、选择器或任意配置路径。

普通用户不要使用房主链接。房主令牌文件属于服务器密钥；如果泄露，应先停止服务，备份后删除 `SyncWatch同步观影-Data/.secrets/server-host-token.txt`，再启动服务器生成新令牌，并检查账户与操作历史。旧的 `#host=` 链接随后失效。

## 14. 房间创建、加入和权限

- 每个已注册账户默认只能创建 1 个房间，服务器生成六位房间号。需要更多房间时，用户可在建房窗口提交额度申请，由服务器管理员审批或直接设置更高额度。
- 创建时可设置房间名称、可选密码和 2 至 100 人的人数上限。
- 除超级管理员外，所有用户进入时必须填写房间号。输入后登录页立即显示房间名称、在线人数、人数上限和是否需要密码，也可以从“选择在线房间”中直接选择。
- 用户在登录页填写房间号和房间密码加入；房间无密码时密码栏留空。服务器不会再把内部候场室显示成在线房间。
- 房间创建者是该房间房主，各房间的聊天、媒体、队列、同步状态和权限相互隔离。
- 当前房主或超级管理员可在房间号区域直接修改房间号，相关媒体、聊天、播放记录和在线会话会原子迁移。
- 同一 IP 已注册而需要新增账号时，注册页常驻“申请一次注册名额”按钮；填写准备注册的账号和原因后，管理员可在管理中心审批。
- 公网隧道策略生效期间，新房间必须设置密码。
- 开启“上传需审核”后，未审核媒体不能被选择播放。
- 房主主动退出时会明确选择“关闭房间”“删除房间”或“只退出，不关闭房间”，三种操作使用不同颜色；掉线、崩溃或意外退出一律按“只退出，不关闭房间”处理。
- 超级管理员不能被任何房主或成员移出。服务器设备与超级管理员进入任意正式房间后拥有完整管理权限，但媒体、聊天和播放上下文仍只作用于当前房间。

若出现“只能选择当前房间已审核的视频或音频”，先确认当前账号进入的是上传文件所属房间、文件没有被删除，并由房主完成审核。即使是服务器设备或超级管理员，也必须先进入文件所属的那个房间，不能在 A 房间直接播放 B 房间的媒体。

## 15. QQ 邮箱 SMTP 授权码

SyncWatch同步观影 使用真实 `smtp.qq.com:465`、TLS 1.2 或更高版本发送邮件。这里需要的是 QQ 邮箱的 SMTP 授权码，不是 QQ 登录密码。

配置流程：

1. 在 QQ 邮箱网页设置中开启 SMTP 服务并生成授权码。
2. 通过服务器房主入口登录，打开“管理”。
3. 输入正确的服务器管理员密码并加载管理设置。
4. 填写 QQ 发件邮箱、SMTP 授权码和发件人名称。可选填写“密码找回邮箱”，用于接收服务器管理员找回码；留空时回退到 SMTP 登录邮箱。 “测试收件邮箱”只用于本次测试，留空时测试邮件发送到密码找回邮箱或 QQ 发件邮箱。
5. 勾选“启用邮箱验证码找回账户和服务器管理员密码”，先保存。
6. 点击“发送测试邮件”，确认真实邮箱收到邮件。

支持 `qq.com`、`foxmail.com` 和 `vip.qq.com` 发件地址。授权码使用 AES-256-GCM 加密后写入 `config.json`，解密密钥单独保存在 `SyncWatch同步观影-Data/.secrets/mail.key`；浏览器不会读取已保存的授权码。更换发件邮箱时必须填写新授权码。

云厂商可能封锁出站 TCP 465。保存成功但测试邮件失败时，应检查授权码、SMTP 开关、DNS、系统时间、出站防火墙和云厂商邮件端口策略。

## 16. 邮箱找回密码的完整回路

账户找回：

1. 用户先在个人账户绑定邮箱。
2. 登录页点击“忘记密码”。
3. 输入登录账号或绑定邮箱。
4. 服务器生成六位验证码并真实发送邮件。
5. 用户填写验证码，服务器校验摘要、有效期和错误次数。
6. 校验成功后服务器签发一次性重置令牌。
7. 用户设置新密码，服务器修改密码并撤销该账户所有旧会话。

服务器管理员密码找回：

1. 登录页点击“忘记密码”。
2. 选择服务器管理员，或按界面提示输入“服务器管理员”。
3. 验证码发送到管理设置中的“密码找回邮箱”；未填写时回退到 SMTP 登录邮箱，不使用仅用于显示的发件人地址。
4. 验证成功后设置新的服务器管理员密码。

验证码和重置令牌均为 10 分钟有效、一次性使用；验证码最多允许 5 次错误。服务器还会限制同一来源和同一目标的请求频率，并使用统一响应避免泄露某个账号是否存在。

找回功能依赖完整的 `config.json` 和 `.secrets/mail.key`。只恢复其中一个文件会导致邮件授权码无法解密。

## 17. 备份 `SyncWatch同步观影-Data`

一致性备份必须先停止服务器：

```powershell
# Windows：在运行窗口按 Ctrl+C，或先停止任务计划中的服务
```

```bash
sudo systemctl stop syncwatch
```

随后整体复制：

```powershell
New-Item -ItemType Directory -Path 'E:\Backup' -Force | Out-Null
Copy-Item -LiteralPath 'D:\SyncWatch同步观影-Server\SyncWatch同步观影-Data' -Destination 'E:\Backup\SyncWatch同步观影-Data-2026-08-05' -Recurse
```

```bash
sudo mkdir -p /srv/backup
sudo cp -a /opt/syncwatch/SyncWatch同步观影-Data /srv/backup/SyncWatch同步观影-Data-2026-08-05
```

`server-config.json` 已位于 `SyncWatch同步观影-Data/` 中，完整备份数据目录时会一起保存。备份后至少检查文件数量、总大小，并抽查 `config.json`、`chat-history.jsonl`、`.secrets/` 和大型影片；重要服务器可再生成 SHA-256 清单。

`cache/`、`logs/` 和 `crash-dumps/` 是桌面端可再生目录，可在停止程序后清理；账户、聊天、上传、缩略图、字幕、语音、`trash/` 和 `.secrets/` 不能当作缓存删除。

## 18. 搬迁和恢复

### 搬到另一台服务器

1. 停止旧服务器。
2. 完整复制整个服务器目录，或把新服务器程序和旧 `SyncWatch同步观影-Data/` 一起复制到目标位置。
3. 校验文件数量和总大小；不要在复制期间启动任一服务器。
4. 根据新环境修改端口、`publicUrl`、`allowedHosts`、防火墙和反代。
5. 启动新服务器，核对账户数、房间、聊天、媒体、缩略图、邮件测试和操作回溯。
6. 验证完成前保留旧服务器目录作为只读备份。

### 从备份恢复

1. 停止服务器。
2. 先把当前 `SyncWatch同步观影-Data/` 改名或完整备份，避免误操作无法回退。
3. 用同一时间点的完整备份替换整个 `SyncWatch同步观影-Data/`。
4. 不要把旧、新两套目录逐个文件混合；这可能造成媒体索引、聊天、回收记录和密钥不一致。
5. 启动后进行登录、房间、播放、聊天、QQ 测试邮件和历史回溯检查。

旧版桌面程序可能在 `%APPDATA%\sync-watch-lan\data` 留有数据。新版 EXE 首次启动会在目标 `SyncWatch同步观影-Data/` 不存在有效配置时复制并校验旧数据，但会保留旧目录作为安全备份。确认新目录完整运行前绝不能删除旧 AppData 数据。

## 19. 升级 EXE、APK 和服务器 ZIP

### Windows EXE

1. 退出旧 EXE，确认进程已经结束。
2. 备份整个 `SyncWatch同步观影-Data/`，其中已经包含 `server-config.json`。
3. 用新版 EXE 替换旧 EXE，保持同一目录结构。
4. 启动并检查版本、账户、房间、媒体和聊天。

只移动一个 EXE 不会自动带走旁边的数据；搬迁时要移动 EXE 所在的完整程序目录。

### Android APK

直接安装新版 APK 覆盖旧版，保留应用私有数据。不要先卸载旧版；卸载会清除 Android 内置服务器的数据和本地设置。若系统提示签名不一致，说明 APK 不是由原发布密钥签名，不能安全覆盖安装。

### 独立服务器 ZIP

推荐解压到一个新的版本目录：

1. 停止旧服务并备份旧 `SyncWatch同步观影-Data/`。
2. 解压新版 ZIP 到新目录。
3. 新版 ZIP 自带一个只含说明文件的 `SyncWatch同步观影-Data/` 占位目录。先确认它没有真实数据，再把它改名为 `SyncWatch同步观影-Data.placeholder/`；不要直接把旧目录移动到这个同名目录中，否则可能形成错误的 `SyncWatch同步观影-Data/SyncWatch同步观影-Data/` 嵌套。
4. 把旧版完整的 `SyncWatch同步观影-Data/` 作为一个目录移动到新版根目录，确认最终路径正好是 `新版目录/SyncWatch同步观影-Data/config.json`。旧版根目录若还有 `server-config.json`，首次启动会自动迁移到数据目录；禁止把新旧两套数据逐文件合并覆盖。
5. 启动新版并验收；确认无误后再归档旧程序目录，并删除已经确认无用的 `SyncWatch同步观影-Data.placeholder/`。

Docker 升级时，先备份宿主机 `SyncWatch同步观影-Data/`，再执行 `docker compose up -d --build`。绑定目录不会因容器重建而改变。

## 20. 日志和运行状态

- 前台启动：主要日志输出到控制台。
- 独立服务器：地址、端口和房主入口写入 `SyncWatch同步观影-Data/服务器运行信息.txt`。
- systemd：使用 `journalctl -u syncwatch -f`。
- Docker：使用 `docker compose logs -f`。
- 桌面 EXE：缓存、日志和崩溃目录位于 `SyncWatch同步观影-Data/cache`、`logs`、`crash-dumps`。

发生故障时，先记录错误原文、启动方式、端口、访问 URL 和反代配置，再重启。不要在服务器运行时手工编辑 `config.json` 或删除 `.secrets/`。

## 21. 常见故障

### 页面右上角一直“正在连接”或显示“连接失败”

依次检查：

1. 服务器本机能否打开 `http://127.0.0.1:端口/api/public-config`。
2. 云安全组和系统防火墙是否放行正确端口。
3. Nginx 是否包含 WebSocket 的 `Upgrade`、`Connection` 和 HTTP/1.1 设置。
4. HTTPS 页面是否仍在连接明文 HTTP/WS 地址。
5. `publicUrl`、`allowedHosts` 和实际域名是否一致。
6. 反代是否把 `/socket.io/` 和普通 HTTP 请求一起转发。

### `EADDRINUSE` 或“端口已被占用”

指定端口已被其他程序占用。停止占用进程或修改端口；SyncWatch同步观影 不会自动换端口。

### 外网能打开页面，但登录、同步或聊天断开

通常是 WebSocket 反代、代理超时或负载均衡配置问题。先使用本文 Nginx/Caddy 配置，确保同一客户端的 HTTP 与 Socket.IO 到达同一个 SyncWatch同步观影 实例。当前程序不是多节点共享状态架构，不要同时启动多个实例指向同一数据目录。

### 上传返回 413

检查 Nginx `client_max_body_size`、SyncWatch同步观影 管理设置和 32 GB 服务端安全上限。反代还应关闭请求缓冲并延长上传超时。

### Linux 启动提示 FFmpeg/FFprobe 缺失

运行 `./start-server.sh` 让脚本安装当前平台的锁定生产依赖，或改用 Docker。不要把 Windows `ffmpeg.exe` 当作 Linux 可执行文件。

### QQ 邮件保存成功但收不到验证码

先使用“发送测试邮件”。检查 SMTP 授权码而非 QQ 密码、QQ 邮箱 SMTP 服务、QQ 发件邮箱或本次填写的测试收件邮箱、垃圾邮件、服务器时间、DNS 和出站 TCP 465。真实投递失败时服务器不会向未登录用户暴露账户是否存在。

### 移动后账户或影片消失

程序启动到了新的空 `SyncWatch同步观影-Data/`。停止服务，把原目录完整放到新程序根目录，尤其不能遗漏隐藏的 `.secrets/`。不要让两个服务器同时使用同一网络共享数据目录。

### 配置损坏后服务器拒绝启动

`config.json` 无法解析或迁移时，服务器会保留原文件、生成同目录的 `config.json.corrupt-时间戳` 备份并停止启动，不会静默创建空账号库。不要反复覆盖原文件；应先复制整个数据目录，再从最近一次完整备份恢复 `config.json`，并核对聊天、媒体和 `.secrets/` 是否属于同一备份时间点。

### 提示数据目录正在被另一个实例占用

先检查是否同时运行了桌面 EXE、独立服务器、Docker 容器或另一个端口的 Node 进程，并正常关闭原实例。异常崩溃且原 PID 已不存在时程序会自动回收旧锁；只有在确认所有 SyncWatch同步观影 进程都已停止后，才可备份并人工处理损坏的 `.syncwatch-instance.lock/`。运行中的锁绝不能强删。

### 影片卡片存在，但播放或下载返回 `MEDIA_FILE_UNAVAILABLE`

服务器会在磁盘、挂载或权限暂时异常时保留媒体索引和队列，而不是删除元数据。检查 `SyncWatch同步观影-Data/uploads/` 是否已完整挂载、服务账户是否有读取权限、文件是否复制完成；原文件恢复到相同文件名后即可重新播放，无需重建影片库。

### 邮件密钥损坏或授权码无法解密

从同一份完整备份恢复 `config.json` 与 `.secrets/mail.key`。无法只靠 `config.json` 还原 SMTP 授权码。

## 22. 上线安全检查

- 已修改默认管理员密码 `admin888`。
- 所有公网房间均设置独立强密码，并合理限制人数和成员权限。
- 普通用户只拿到普通 URL，没有拿到包含 `#host=` 的链接。
- 公网使用 HTTPS；后端端口不直接暴露或只允许可信来源。
- `publicUrl` 和 `allowedHosts` 与真实域名一致。
- QQ SMTP 授权码只在管理页配置，没有写入脚本、聊天或公开文档。
- `.secrets/`、Android `mobile/.keys/` 和备份目录均限制访问权限。
- 已制定 `SyncWatch同步观影-Data/` 定期离线备份和恢复演练计划。
- 单个数据目录只由一个 SyncWatch同步观影 实例写入；程序会用 `.syncwatch-instance.lock/` 阻止同一目录被不同端口或不同启动方式同时打开。
- 系统、Node.js、Docker、Nginx/Caddy 和 TLS 证书保持更新。

## 23. 升级后验收清单

1. `/api/public-config` 返回正确版本和端口。
2. 普通 HTTP、Socket.IO polling 和 WebSocket 均能连接。
3. 原账户、房间号、密码、权限和人数限制存在。
4. 原影片可播放，新文件和文件夹可上传、可中止。
5. 房主同步播放、聊天、私聊、弹幕和全屏操作正常。
6. 聊天记录管理、删除、清空和操作回溯正常。
7. QQ 测试邮件、验证码和账户/管理员密码找回正常。
8. Android APK 可下载、覆盖安装并连接服务器。
9. 重启服务后数据仍存在，`SyncWatch同步观影-Data/服务器运行信息.txt` 更新。
10. 备份可以在隔离目录恢复并独立启动。
11. Windows 窗口关闭时可选择最小化到托盘、退出程序、重新启动或取消；选择退出后端口和数据目录锁会正常释放。

## 24. 官方资料与版本核对

本文在 2026-08-05 按以下官方资料核对。以后升级服务器组件时，应优先阅读这些原始文档，不要直接复制来路不明的一键脚本：

- Node.js 发布状态与 LTS 生命周期：<https://nodejs.org/en/about/previous-releases>
- Docker Engine Ubuntu 官方安装：<https://docs.docker.com/engine/install/ubuntu/>
- Nginx WebSocket 反向代理：<https://nginx.org/en/docs/http/websocket.html>
- Caddy `reverse_proxy`：<https://caddyserver.com/docs/caddyfile/directives/reverse_proxy>
- Cloudflare WebSockets：<https://developers.cloudflare.com/network/websockets/>
- Cloudflare 413 与上传大小限制：<https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/>
- Cloudflare 支持代理的网络端口：<https://developers.cloudflare.com/fundamentals/reference/network-ports/>
