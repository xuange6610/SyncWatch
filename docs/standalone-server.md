# SyncWatch同步观影 Standalone Server

The package contains runtime files only. Build caches, tests, Android signing keys, Electron output, and unrelated source artifacts are excluded.

For complete Windows Server, Linux, Docker Compose, HTTPS reverse proxy, tunnel, backup, migration, recovery, and upgrade instructions, read [服务器部署与使用教程](server-deployment-guide.md).

All accounts, rooms, permissions, uploaded files, thumbnails, subtitles, voice messages, chat history, recovery trash, mail encryption keys, and the owner token are stored in `SyncWatch同步观影-Data/` beside the program. Stop the server and copy the complete directory when moving the deployment. Do not copy only `config.json`; QQ SMTP credentials require `SyncWatch同步观影-Data/.secrets/mail.key` as well.

Windows x64: install Node.js 24 LTS, edit `SyncWatch同步观影-Data/server-config.json`, then double-click `start-server.cmd`. The ZIP already contains the locked Windows production dependencies and media binaries, so normal first start does not need npm or a network download.

Linux x64:

```bash
chmod +x start-server.sh
./start-server.sh
```

The archive is built on Windows. On Linux x64, `start-server.sh` detects the platform-specific FFmpeg binary; if it is missing, the script automatically runs the locked production install once. This release is validated for Windows x64 and Linux x64/`linux/amd64`, not Linux ARM64. For a consistent Linux cloud deployment, use Docker Compose.

Docker:

```bash
SYNCWATCH_PORT=20311 docker compose up -d --build
```

Open the selected TCP port in the cloud firewall/security group. The private owner URL is written to `SyncWatch同步观影-Data/服务器运行信息.txt`; never share a URL containing `#host=` with normal users.

For HTTPS/reverse proxies, set `SYNCWATCH_PUBLIC_URL=https://watch.example.com` and forward both HTTP and WebSocket traffic. The server learns same-origin forwarded hosts after a real document navigation and supports `X-Forwarded-Host` from local/private proxy peers.

To enable real QQ email codes, sign in as the server owner, open Admin Settings, provide the server administrator password, and configure the QQ mailbox plus its SMTP authorization code. Save first, then send a test email. The server uses `smtp.qq.com:465` with TLS. The authorization code is encrypted at rest and is never returned to the browser.

