#!/usr/bin/env bash

set -euo pipefail

real_adb="${ANDROID_HOME:?}/platform-tools/adb.syncwatch-real"

if [[ "$*" == *"shell input keyevent 82"* ]]; then
  for _ in {1..5}; do
    if "$real_adb" "$@"; then
      exit 0
    fi
    sleep 2
  done
  # The emulator runner treats this unlock command as best effort. The
  # repository smoke performs its own strict ADB readiness checks afterward.
  exit 0
fi

exec "$real_adb" "$@"
