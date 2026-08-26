#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required (Node.js 24 LTS recommended)." >&2
  exit 1
fi

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [ "$node_major" -lt 22 ]; then
  echo "Node.js 22+ is required (Node.js 24 LTS recommended)." >&2
  exit 1
fi

dependencies_ready=1
if [ ! -f node_modules/express/package.json ]; then
  dependencies_ready=0
elif ! node -e "const fs=require('fs'); const ffmpeg=require('ffmpeg-static'); const ffprobe=require('ffprobe-static').path; process.exit(ffmpeg&&ffprobe&&fs.existsSync(ffmpeg)&&fs.existsSync(ffprobe)?0:1)"; then
  dependencies_ready=0
fi

if [ "$dependencies_ready" -ne 1 ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "Production dependencies are missing and npm was not found. Restore the complete server package or install Node.js with npm." >&2
    exit 1
  fi
  npm ci --omit=dev --no-audit --no-fund
fi

exec node ./server-standalone.js "$@"
