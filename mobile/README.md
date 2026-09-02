# SyncWatch同步观影 Android

This is the Android client and phone-hosted server for SyncWatch同步观影 v2.3.5. The APK
embeds the same production `server/index.js`, web UI, Express/Socket.IO stack, and
an official Node.js Mobile 18.20.4 runtime for arm64-v8a, armeabi-v7a, and x86_64.
The phone server runs in a dedicated `specialUse` foreground-service process so
the WebView stays responsive and other devices on the phone's Wi-Fi/hotspot can join.

It includes an Android 10-15 native MediaProjection bridge because Android WebView
does not expose `navigator.mediaDevices.getDisplayMedia`. Capture runs in a
`mediaProjection` foreground service, follows display rotation without reusing the
one-shot Android 14 authorization token, emits about 8 JPEG frames per second, and
stops on screen lock, authorization revocation, task removal, server/page changes,
or final Activity destruction.

## Web bridge contract

The bridge is available only to the configured server's top-level origin. The raw
JavaScript interface requires a per-page random token that is never exposed to
cross-origin frames. The trusted page receives:

```javascript
window.SyncWatchAndroid.isScreenCaptureSupported(); // boolean, Android 10+
window.SyncWatchAndroid.startScreenCapture();       // boolean: request accepted
window.SyncWatchAndroid.stopScreenCapture();        // boolean: request accepted
window.SyncWatchAndroid.chooseFolder();             // arm the next file-input click
```

The page must define these callbacks before starting capture:

```javascript
window.__syncWatchNativeCaptureState = (state, message) => {
  // state: "started", "stopped", "error", or "permission-denied"
};

window.__syncWatchNativeCaptureFrame = (base64, width, height, sequence) => {
  // Decode raw JPEG base64 to Uint8Array and reuse the existing
  // screen-share-frame Socket.IO payload.
};
```

For folder upload, call `chooseFolder()` and immediately click the existing file
input. The next chooser uses Android's document-tree picker. Before the input's
`change` event, native code sets `window.__syncWatchNativeFolderPaths` to an array
whose order matches the returned `FileList`. Paths include the selected root folder.
Scanning is limited to 2,000 matching files, 1,000 directories, and 24 levels.

Build the signed APK on the prepared Windows host:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-apk.ps1
```

The script uses Android Studio's bundled JBR, Android SDK platform/build-tools 35,
and locally cached Gradle 8.13/Android Gradle Plugin 8.11.1. It accepts a verified
`NODEJS_MOBILE_ANDROID_HOME`, a verified `app/libnode`, or downloads the pinned
official Node.js Mobile archive into the per-user SyncWatch同步观影 build cache. The archive,
header, and every `libnode.so` ABI are checked against fixed SHA-256 digests.

A pre-existing `.keys/syncwatch-release.jks` and matching `.keys/release.properties`
are mandatory. The build fails if the release identity is missing; it never creates a
replacement key or silently signs a release with Android's debug certificate. Keep the
`.keys` directory backed up because Android updates must use the same certificate.

After Gradle finishes, the script verifies package/version metadata, cryptographic
signature and signing-certificate identity, all three native ABIs, the embedded Node
dependency closure, and byte-for-byte freshness of `server/index.js` and `public/**`.
The verified artifact is written to `SyncWatch同步观影-v2.3.5.apk`.

## Android 15 / 16 KB pages

Android 15 devices and the 16 KB emulator require every native `libnode.so`,
`libsyncwatch-node.so`, and `libc++_shared.so` load segment to use at least
16 KB alignment. Older APKs bundled the official 4 KB Node.js Mobile binaries;
on a 16 KB device that can crash the isolated server process with
`SIGSEGV (SEGV_ACCERR)` while the UI remains stuck at “正在准备手机服务器”.
The release build now uses the rebuilt 16 KB Node.js Mobile runtime, links the
native bridge with a 16 KB maximum page size, keeps JNI libraries uncompressed,
and verifies ELF plus APK ZIP alignment before the APK is accepted. The pinned
runtime source revision is `ff4e063f1f1911047c067335ad0a3d81336236ca`.

From the repository root, an additional offline source/APK inspection can be run
through the included PowerShell wrapper (it uses `node.exe` or the installed Electron
runtime):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\android-package.ps1 -SourceOnly
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\android-package.ps1 -ApkPath .\dist\SyncWatch-Android-v2.3.5-universal.apk
```


