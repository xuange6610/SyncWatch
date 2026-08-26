#!/usr/bin/env bash

set -euo pipefail

workspace="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
version="${RELEASE_VERSION:?RELEASE_VERSION is required}"
smoke_dir="$workspace/.build/android-smoke"
apk="$smoke_dir/SyncWatch-Android-v${version}-universal.apk"

test -s "$apk"
adb install --no-streaming "$apk"

installed_version="$(adb shell dumpsys package com.xuan.syncwatch | sed -n 's/^[[:space:]]*versionName=//p' | head -n 1 | tr -d '\r')"
test "$installed_version" = "$version"

adb logcat -c
adb shell am force-stop com.xuan.syncwatch
launch="$(adb shell am start -W -n com.xuan.syncwatch/.MainActivity | tr -d '\r')"
printf '%s\n' "$launch" | tee "$smoke_dir/launch.txt"
grep -Eq '^Status: (ok|timeout)$' <<< "$launch"
grep -q '^Activity: com.xuan.syncwatch/.MainActivity$' <<< "$launch"

started=0
for _ in {1..12}; do
  pid="$(adb shell pidof com.xuan.syncwatch | tr -d '\r')"
  adb shell dumpsys activity activities > "$smoke_dir/activities.txt"
  if [[ -n "$pid" ]] && grep -q 'com.xuan.syncwatch/.MainActivity' "$smoke_dir/activities.txt"; then
    started=1
    break
  fi
  sleep 5
done
test "$started" = 1

adb logcat -d -b crash > "$smoke_dir/crash-log.txt"
if grep -q 'com.xuan.syncwatch' "$smoke_dir/crash-log.txt"; then
  cat "$smoke_dir/crash-log.txt"
  exit 1
fi

adb exec-out screencap -p > "$smoke_dir/startup.png"
test -s "$smoke_dir/startup.png"
