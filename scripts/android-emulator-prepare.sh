#!/usr/bin/env sh

set -eu

adb_path="$ANDROID_HOME/platform-tools/adb"
real_adb="$ANDROID_HOME/platform-tools/adb.syncwatch-real"

if [ ! -x "$real_adb" ]; then
  mv "$adb_path" "$real_adb"
fi
cp scripts/android-emulator-adb-wrapper.sh "$adb_path"
chmod +x "$adb_path"
