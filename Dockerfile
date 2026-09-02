FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public
COPY dist/SyncWatch-Android-v2.3.5-universal.apk ./mobile/SyncWatch同步观影-v2.3.5.apk
COPY dist/SyncWatch-Experience-Client-Portable-v2.3.5-x64.exe ./client/SyncWatch同步观影-Client-v2.3.5.exe
COPY server-standalone.js ./server-standalone.js

ENV NODE_ENV=production PORT=20311 SYNCWATCH_DATA_DIR=/app/SyncWatch同步观影-Data
EXPOSE 20311
VOLUME ["/app/SyncWatch同步观影-Data"]
CMD ["node", "server-standalone.js"]
