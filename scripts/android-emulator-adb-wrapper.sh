#!/usr/bin/env bash

set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
real_adb="$script_dir/adb.syncwatch-real"

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
