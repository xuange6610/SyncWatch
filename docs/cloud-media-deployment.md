# SyncWatch同步观影 云端视频与商业部署说明

## 已实现的运行方式

当前版本已经支持在影片库点击“添加云端视频”，保存腾讯云 COS / 阿里云 OSS 的 HTTPS 视频直链。服务器只保存视频名称、直链、封面/时长等元数据；客户端播放时直接访问对象存储，播放、暂停、拖动和房间状态仍由现有 Socket.IO 服务同步，因此视频流量不会经过 SyncWatch同步观影 服务器。

推荐使用 H.264 + AAC 的 MP4 文件。浏览器原生不统一支持 MKV、AVI、HEVC、10-bit H.264 或部分 MOV；云端直链不会经过本机 FFmpeg 转码。

## COS / OSS 必需配置

对象存储文件必须满足：

- 使用 HTTPS 公网地址，不使用内网域名、临时本机地址或带账号密码的 URL。
- 响应 `Content-Type: video/mp4`。
- 支持 `HEAD` 和 HTTP Range，范围请求返回 `206 Partial Content`、`Accept-Ranges: bytes`、`Content-Range` 和正确的 `Content-Length`。
- Bucket CORS 允许观影网站域名执行 `GET`、`HEAD`，允许请求头 `Range`，暴露 `Accept-Ranges`、`Content-Range`、`Content-Length`、`Content-Type`、`ETag`。
- 私有 Bucket 使用 CDN 签名 Cookie 或足够长的签名 URL。不要把永久 SecretId、SecretKey、AccessKey 写入前端或 SyncWatch同步观影 数据文件。

建议 CORS 规则：

```json
{
  "allowedOrigins": ["https://movie.example.com"],
  "allowedMethods": ["GET", "HEAD"],
  "allowedHeaders": ["Range", "Origin", "Accept", "Content-Type"],
  "exposeHeaders": ["Accept-Ranges", "Content-Range", "Content-Length", "Content-Type", "ETag"],
  "maxAgeSeconds": 86400
}
```

## 播放同步协议

现有房间服务通过 Socket.IO 保存权威播放快照：

```text
fileId, currentTime, isPlaying, stalled, volume, revision, updatedAt, changedBy
```

客户端控制对应 `playback-command` 的 `play`、`pause`、`seek`、`volume`，服务器增加单调递增的 `revision` 后广播。客户端根据服务器时间、网络往返延迟和本地播放器时间计算漂移，小漂移调整播放速度，大漂移直接校准。云端视频和本机上传视频共用同一套同步逻辑。

## 商业化架构建议

当前桌面/局域网版本继续使用 `SyncWatch同步观影-Data`，这样离线部署、Windows EXE 和 Android 本机服务器不依赖数据库。面向公网多实例部署时，建议按下面方式演进，而不是让单机 JSON 被多个容器同时写入：

```text
Vue 3 + TypeScript + Vite + Video.js
                |
            HTTPS/WSS
                |
       Nginx / Load Balancer
                |
      Node.js + Express + Socket.IO
          |                 |
        MySQL             Redis
  账号/房间/视频元数据   Socket.IO Adapter/房间热状态
                |
          COS / OSS / CDN
```

MySQL 表至少包含：`users`、`rooms`、`room_members`、`videos`、`room_playback_snapshots`、`audit_logs`。Redis 保存在线成员、Socket.IO Pub/Sub、播放租约和限流计数；MySQL 保存可恢复的最终播放快照。对象存储仅保存视频、字幕、封面，不保存房间权限。

多实例时必须使用 `@socket.io/redis-adapter`，并为每个房间的播放写入增加 Redis 分布式锁或基于 `revision` 的乐观并发控制，防止两个节点同时接受过期播放命令。

## Nginx 反向代理

```nginx
server {
    listen 443 ssl http2;
    server_name movie.example.com;

    ssl_certificate /etc/letsencrypt/live/movie.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/movie.example.com/privkey.pem;

    client_max_body_size 32g;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location /socket.io/ {
        proxy_pass http://syncwatch:20311;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        proxy_pass http://syncwatch:20311;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

生产环境应设置 `SYNCWATCH_PUBLIC_URL=https://movie.example.com`，只开放 80/443，把 20311 端口限制在 Docker 网络或安全组内。数据库、Redis 和对象存储密钥使用云密钥管理服务或 Docker Secret，不进入镜像和 Git。

## 故障检查

云端视频无法播放时依次检查：

1. 在浏览器开发者工具中确认视频 URL 返回 200/206，而不是 302 登录页、403、404 或 416。
2. 对 `Range: bytes=0-1` 的请求确认返回 `Content-Range: bytes 0-1/总大小`。
3. 检查签名 URL 是否过期，所有用户所在网络是否都能访问 COS/OSS/CDN 域名。
4. 检查文件编码是否为浏览器可播放的 H.264/AAC MP4。
5. 检查 Bucket CORS 是否包含实际网站域名、`GET`、`HEAD` 和 `Range`。

