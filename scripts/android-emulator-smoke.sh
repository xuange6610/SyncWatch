#!/usr/bin/env bash

set -euo pipefail

workspace="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
version="${RELEASE_VERSION:?RELEASE_VERSION is required}"
smoke_dir="$workspace/.build/android-smoke"
apk="$smoke_dir/SyncWatch-Android-v${version}-universal.apk"

test -s "$apk"
# The emulator action may report a transient post-boot ADB Broken pipe while
# leaving the device alive. Re-establish the connection before strict checks.
adb start-server >/dev/null
timeout 60s adb wait-for-device
for _ in {1..20}; do
  if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
    break
  fi
  sleep 2
done
test "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1"
install_output="$(adb install --no-streaming "$apk" 2>&1)" || {
  printf '%s\n' "$install_output" >&2
  if grep -q 'INSTALL_FAILED_VERIFICATION_FAILURE: Integrity verification timed out' <<< "$install_output"; then
    # Large release APKs can exceed the emulator package-verifier window.
    # Disable ADB verification for this isolated smoke emulator, then retry once.
    adb shell settings put global package_verifier_enable 0 || true
    adb shell settings put global verifier_verify_adb_installs 0 || true
    adb install --no-streaming "$apk"
  else
    exit 1
  fi
}

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
