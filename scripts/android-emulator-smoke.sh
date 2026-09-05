#!/usr/bin/env bash

set -euo pipefail

workspace="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
version="${RELEASE_VERSION:?RELEASE_VERSION is required}"
smoke_dir="$workspace/.build/android-smoke"
apk="$smoke_dir/SyncWatch-Android-v${version}-universal.apk"

test -s "$apk"
# The emulator action may report a transient post-boot ADB Broken pipe while
# leaving the device alive. Re-establish the connection before strict checks.
wait_for_android() {
  adb start-server >/dev/null
  timeout 60s adb wait-for-device
  for _ in {1..20}; do
    if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
      return 0
    fi
    sleep 2
  done
  test "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1"
}

wait_for_storage_service() {
  # Android can report boot completion before StorageManagerService has a
  # usable binder. Package installation calls StorageManager.getVolumes(), so
  # probe the same service before attempting to install the APK.
  local attempt=1 service_output='' storage_output=''
  while (( attempt <= 30 )); do
    service_output="$(adb shell service check mount 2>&1 || true)"
    storage_output="$(adb shell sm list-volumes all 2>&1 || true)"
    if grep -q 'Service mount: found' <<< "$service_output" \
      && ! grep -qE 'Can.t find service|Broken pipe|NullPointerException|Exception occurred|Error:' <<< "$storage_output"; then
      return 0
    fi
    if grep -qE 'Broken pipe|Can.t find service' <<< "$service_output$storage_output"; then
      adb reconnect device >/dev/null 2>&1 || true
      adb kill-server >/dev/null 2>&1 || true
      wait_for_android
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  printf '%s\n%s\n' "$service_output" "$storage_output" >&2
  return 1
}

wait_for_package_service() {
  # Android may expose sys.boot_completed before package-manager startup;
  # this also covers the transient ADB Broken pipe (32) recovery path.
  local attempt=1 package_output=''
  while (( attempt <= 30 )); do
    if package_output="$(adb shell cmd package list packages 2>&1)" \
      && ! grep -q 'Can.t find service: package' <<< "$package_output" \
      && ! grep -q 'Broken pipe' <<< "$package_output"; then
      return 0
    fi
    if grep -q 'Broken pipe' <<< "$package_output"; then
      adb reconnect device >/dev/null 2>&1 || true
      adb kill-server >/dev/null 2>&1 || true
      wait_for_android
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  printf '%s\n' "$package_output" >&2
  return 1
}

install_apk() {
  local attempt=1 install_output=''
  while (( attempt <= 3 )); do
    if install_output="$(adb install --no-streaming "$apk" 2>&1)"; then
      printf '%s\n' "$install_output"
      return 0
    fi
    printf '%s\n' "$install_output" >&2
    if grep -q 'INSTALL_FAILED_VERIFICATION_FAILURE: Integrity verification timed out' <<< "$install_output"; then
      # Large release APKs can exceed the emulator package-verifier window.
      # Disable ADB verification for this isolated smoke emulator, then retry.
      adb shell settings put global package_verifier_enable 0 || true
      adb shell settings put global verifier_verify_adb_installs 0 || true
    elif grep -qE 'Broken pipe \(32\)|Can.t find service: package' <<< "$install_output" \
      || (grep -q 'StorageManager' <<< "$install_output" && grep -q 'getVolumes' <<< "$install_output"); then
      # The package service can briefly lose its ADB transport after boot.
      # Reconnect and wait for a fully booted device before retrying the install.
      adb reconnect device >/dev/null 2>&1 || true
      adb kill-server >/dev/null 2>&1 || true
      wait_for_android
      wait_for_storage_service
      wait_for_package_service
    else
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

wait_for_android
wait_for_storage_service
wait_for_package_service
install_apk

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
