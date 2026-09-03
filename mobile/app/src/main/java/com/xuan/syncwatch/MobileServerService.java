package com.xuan.syncwatch;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.AssetManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Runs the same Node/Express/Socket.IO server used by the desktop build in a dedicated
 * Android process. The separate process keeps the WebView responsive and makes a full
 * stop/restart reliable because Node.js Mobile is intentionally started once per process.
 */
public final class MobileServerService extends Service {
    public static final String ACTION_START =
            "com.xuan.syncwatch.action.START_MOBILE_SERVER";
    public static final String ACTION_STOP =
            "com.xuan.syncwatch.action.STOP_MOBILE_SERVER";
    public static final String ACTION_STATUS_CHANGED =
            "com.xuan.syncwatch.action.MOBILE_SERVER_STATUS_CHANGED";
    public static final String ACTION_OPEN_LOCAL_SERVER =
            "com.xuan.syncwatch.action.OPEN_LOCAL_SERVER";

    public static final String EXTRA_STATUS = "mobile_server_status";
    public static final String EXTRA_MESSAGE = "mobile_server_message";
    public static final String EXTRA_PORT = "mobile_server_port";
    public static final String EXTRA_URL = "mobile_server_url";
    public static final String EXTRA_HOST_URL = "mobile_server_host_url";
    public static final String EXTRA_HOST_TOKEN = "mobile_server_host_token";
    public static final String EXTRA_LAN_URLS = "mobile_server_lan_urls";

    public static final String STATUS_STOPPED = "stopped";
    public static final String STATUS_STARTING = "starting";
    public static final String STATUS_RUNNING = "running";
    public static final String STATUS_STOPPING = "stopping";
    public static final String STATUS_ERROR = "error";

    public static final int SERVER_PORT = 20311;

    private static final String TAG = "SyncWatchMobileServer";
    private static final String CHANNEL_ID = "syncwatch_mobile_server";
    private static final int NOTIFICATION_ID = 4202;
    private static final String ASSET_ROOT = "syncwatch";
    private static final String RUNTIME_VERSION_ASSET = ASSET_ROOT + "/runtime-version.txt";
    private static final String RUNTIME_INSTALL_MARKER = ".installed-runtime-version";
    private static final String MOBILE_PREFERENCES = "syncwatch_mobile";
    private static final String PREF_LOCAL_SERVER_MODE = "local_server_mode";
    private static final String PREF_LOCAL_SERVER_PORT = "local_server_port";
    private static final long STARTUP_TIMEOUT_MS = 60_000L;
    private static final long FORCE_STOP_TIMEOUT_MS = 8_000L;
    private static final long STALE_STARTING_STATUS_MS = STARTUP_TIMEOUT_MS + 15_000L;
    private static final long STALE_STOPPING_STATUS_MS = FORCE_STOP_TIMEOUT_MS + 5_000L;
    // Cloudflare does not publish an Android cloudflared executable. The bundled Windows
    // binary and Linux ELF releases cannot be executed safely from an Android app process.
    static final String ANDROID_TUNNEL_UNAVAILABLE_MESSAGE =
            "APK 本机服务器暂不支持公网隧道：安装包内没有可在 Android 上安全运行的 cloudflared。"
                    + "可连接已开启公网访问的桌面或云服务器。";
    private static final SecureRandom TOKEN_RANDOM = new SecureRandom();
    private static final Object TOKEN_LOCK = new Object();

    private static native int nativeStartNode(String[] arguments);

    private final ExecutorService nodeExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "SyncWatchEmbeddedNode");
        thread.setDaemon(false);
        return thread;
    });
    private final ScheduledExecutorService monitorExecutor =
            Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "SyncWatchServerMonitor");
                thread.setDaemon(true);
                return thread;
            });
    private final AtomicBoolean launchRequested = new AtomicBoolean(false);
    private final AtomicBoolean nodeActive = new AtomicBoolean(false);
    private final AtomicBoolean stopRequested = new AtomicBoolean(false);
    private final Object nativeRuntimeLock = new Object();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private File serviceRoot;
    private File stopFile;
    private File readyFile;
    private File errorFile;
    private String hostToken = "";
    private volatile String currentStatus = STATUS_STOPPED;
    private volatile String currentMessage = "";
    private volatile Snapshot currentSnapshot = Snapshot.stopped();
    private volatile boolean readyObserved;
    private volatile boolean nativeRuntimeLoadAttempted;
    private volatile boolean nativeRuntimeAvailable;
    private volatile String nativeRuntimeError = "";
    private int configuredPort = SERVER_PORT;
    private long startupBeganAt;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    public static void start(Context context) {
        start(context, SERVER_PORT);
    }

    public static void start(Context context, int port) {
        validatePort(port);
        Context application = context.getApplicationContext();
        ensureHostToken(application);
        Intent intent = new Intent(application, MobileServerService.class)
                .setAction(ACTION_START)
                .putExtra(EXTRA_PORT, port);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            application.startForegroundService(intent);
        } else {
            application.startService(intent);
        }
    }

    public static void stop(Context context) {
        Context application = context.getApplicationContext();
        Intent intent = new Intent(application, MobileServerService.class).setAction(ACTION_STOP);
        try {
            application.startService(intent);
        } catch (RuntimeException error) {
            Log.w(TAG, "Unable to deliver stop command to mobile server", error);
            application.stopService(new Intent(application, MobileServerService.class));
        }
    }

    public static void prepareRetry(Context context) {
        File runtimes = new File(serverRoot(context.getApplicationContext()), "runtimes");
        File[] children = runtimes.listFiles();
        if (children == null) return;
        for (File child : children) {
            File marker = new File(child, RUNTIME_INSTALL_MARKER);
            if (marker.isFile() && !marker.delete()) {
                Log.w(TAG, "Unable to invalidate mobile server runtime " + child);
            }
        }
    }

    public static Intent statusIntentFilterProbe() {
        return new Intent(ACTION_STATUS_CHANGED);
    }

    public static Snapshot getSnapshot(Context context) {
        File status = new File(serverRoot(context), "status.json");
        try {
            return reconcilePersistedSnapshot(context,
                    Snapshot.fromJson(new JSONObject(readUtf8(status))));
        } catch (Exception ignored) {
            return Snapshot.stopped();
        }
    }

    private static Snapshot reconcilePersistedSnapshot(Context context, Snapshot snapshot) {
        if (snapshot == null) return Snapshot.stopped();
        long age = snapshot.updatedAt <= 0
                ? Long.MAX_VALUE : Math.max(0L, System.currentTimeMillis() - snapshot.updatedAt);
        boolean persistedActive = STATUS_RUNNING.equals(snapshot.status)
                || STATUS_STARTING.equals(snapshot.status)
                || STATUS_STOPPING.equals(snapshot.status);
        if (persistedActive && !isServerProcessRunning(context)) {
            return Snapshot.stopped(
                    "检测到上次手机服务器已经退出，将自动重新启动…", snapshot.port);
        }
        if (STATUS_RUNNING.equals(snapshot.status)
                && (snapshot.port < 1 || snapshot.port > 65535)) {
            return Snapshot.stopped(
                    "上次手机服务器端口无效，将自动重新启动…", snapshot.port);
        } else if (STATUS_STARTING.equals(snapshot.status) && age > STALE_STARTING_STATUS_MS) {
            return Snapshot.stopped(
                    "上次手机服务器启动未完成，将自动重新启动…", snapshot.port);
        } else if (STATUS_STOPPING.equals(snapshot.status) && age > STALE_STOPPING_STATUS_MS) {
            return Snapshot.stopped("手机服务器已经停止", snapshot.port);
        }
        return snapshot;
    }

    private static boolean isServerProcessRunning(Context context) {
        try {
            ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            if (manager == null) return false;
            String expectedProcess = context.getPackageName() + ":syncwatch_server";
            int expectedUid = context.getApplicationInfo().uid;
            List<ActivityManager.RunningAppProcessInfo> processes = manager.getRunningAppProcesses();
            if (processes == null) return false;
            for (ActivityManager.RunningAppProcessInfo process : processes) {
                if (process != null && process.uid == expectedUid
                        && expectedProcess.equals(process.processName)) return true;
            }
        } catch (RuntimeException error) {
            Log.w(TAG, "Unable to inspect mobile server process", error);
        }
        return false;
    }

    public static String getHostToken(Context context) {
        try {
            return readUtf8(new File(serverRoot(context), "host-token.txt")).trim();
        } catch (IOException ignored) {
            return "";
        }
    }

    public static String getHostUrl(Context context) {
        String token = getHostToken(context);
        Snapshot snapshot = getSnapshot(context);
        int port = snapshot.port > 0 ? snapshot.port : getConfiguredPort(context);
        if (port < 1 || port > 65535) port = SERVER_PORT;
        return token.isEmpty() ? "" : hostUrl(port, token);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        serviceRoot = serverRoot(this);
        if (!serviceRoot.isDirectory() && !serviceRoot.mkdirs()) {
            Log.e(TAG, "Unable to create mobile server directory: " + serviceRoot);
        }
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            getSharedPreferences(MOBILE_PREFERENCES, MODE_PRIVATE).edit()
                    .putBoolean(PREF_LOCAL_SERVER_MODE, false).commit();
            requestStop("已从通知栏停止手机服务器");
            return START_NOT_STICKY;
        }

        if (!launchRequested.compareAndSet(false, true)) {
            publish(currentSnapshot);
            return START_STICKY;
        }
        int savedPort = getConfiguredPort(this);
        configuredPort = intent == null ? savedPort : intent.getIntExtra(EXTRA_PORT, savedPort);
        if (configuredPort < 1 || configuredPort > 65535) {
            configuredPort = SERVER_PORT;
            enterForeground("手机服务器端口无效", Snapshot.error("端口必须是 1-65535 的整数"));
            finishServiceProcess();
            return START_NOT_STICKY;
        }
        getSharedPreferences(MOBILE_PREFERENCES, MODE_PRIVATE).edit()
                .putInt(PREF_LOCAL_SERVER_PORT, configuredPort).commit();
        stopRequested.set(false);
        enterForeground("正在准备手机服务器…",
                Snapshot.starting("正在准备手机服务器…", configuredPort));
        nodeExecutor.execute(this::launchNodeServer);
        return START_STICKY;
    }

    private static int getConfiguredPort(Context context) {
        android.content.SharedPreferences preferences = context.getSharedPreferences(
                MOBILE_PREFERENCES, MODE_PRIVATE);
        int port = preferences.getInt(PREF_LOCAL_SERVER_PORT, SERVER_PORT);
        if (port == 5000) {
            port = SERVER_PORT;
            preferences.edit().putInt(PREF_LOCAL_SERVER_PORT, port).apply();
        }
        return port;
    }

    private void launchNodeServer() {
        File runtimeRoot = null;
        try {
            ensureNativeRuntimeAvailable();

            readyObserved = false;
            hostToken = ensureHostToken(this);
            acquireRuntimeLocks();
            publish(Snapshot.starting("正在释放服务器资源…", configuredPort));

            runtimeRoot = prepareRuntime();
            if (stopRequested.get()) {
                publish(Snapshot.stopped());
                return;
            }
            File dataRoot = new File(serviceRoot, "data");
            if (!dataRoot.isDirectory() && !dataRoot.mkdirs()) {
                throw new IOException("无法创建服务器数据目录");
            }

            stopFile = new File(serviceRoot, "stop.request");
            readyFile = new File(serviceRoot, "ready.json");
            errorFile = new File(serviceRoot, "error.json");
            deleteIfPresent(stopFile);
            deleteIfPresent(readyFile);
            deleteIfPresent(errorFile);

            File bootstrap = new File(runtimeRoot, "mobile-bootstrap.js");
            atomicWrite(bootstrap, buildBootstrap(runtimeRoot, dataRoot));
            startupBeganAt = SystemClock.elapsedRealtime();
            publish(Snapshot.starting("正在启动 " + configuredPort + " 端口…", configuredPort));
            startStatusMonitor();

            nodeActive.set(true);
            int exitCode = nativeStartNode(new String[]{"node", bootstrap.getAbsolutePath()});
            nodeActive.set(false);

            if (stopRequested.get()) {
                publish(Snapshot.stopped());
            } else if (publishReportedStartupError(runtimeRoot)) {
                Log.w(TAG, "Embedded Node.js exited after reporting a startup error: " + exitCode);
            } else if (STATUS_ERROR.equals(currentStatus)) {
                Log.w(TAG, "Embedded Node.js exited after startup error: " + exitCode);
            } else {
                publish(Snapshot.error("手机服务器意外退出（代码 " + exitCode + "）",
                        configuredPort));
            }
        } catch (Throwable error) {
            nodeActive.set(false);
            Log.e(TAG, "Mobile server failed", error);
            publish(Snapshot.error(safeMessage(error, "手机服务器启动失败"), configuredPort));
        } finally {
            releaseRuntimeLocks();
            finishServiceProcess();
        }
    }

    private void ensureNativeRuntimeAvailable() {
        if (!nativeRuntimeLoadAttempted) {
            synchronized (nativeRuntimeLock) {
                if (!nativeRuntimeLoadAttempted) {
                    try {
                        // This service runs in :syncwatch_server. Loading these large native
                        // libraries lazily here keeps the Activity/UI process out of Node.js.
                        System.loadLibrary("node");
                        System.loadLibrary("syncwatch-node");
                        nativeRuntimeAvailable = true;
                    } catch (Throwable error) {
                        String detail = error.getMessage() == null ? "" : error.getMessage().trim();
                        if (detail.length() > 180) detail = detail.substring(0, 180);
                        nativeRuntimeError = "无法加载内嵌 Node.js 运行库（设备架构："
                                + java.util.Arrays.toString(Build.SUPPORTED_ABIS) + "）"
                                + (detail.isEmpty() ? "，请重新安装完整 APK" : "：" + detail);
                        Log.e(TAG, "Unable to load embedded Node.js", error);
                    } finally {
                        nativeRuntimeLoadAttempted = true;
                    }
                }
            }
        }
        if (!nativeRuntimeAvailable) {
            throw new IllegalStateException(nativeRuntimeError.isEmpty()
                    ? "内嵌 Node.js 运行库不可用，请重新安装完整 APK" : nativeRuntimeError);
        }
    }

    private void startStatusMonitor() {
        monitorExecutor.scheduleWithFixedDelay(() -> {
            if (!nodeActive.get() && launchRequested.get()) return;
            try {
                if (!readyObserved && readyFile != null && readyFile.isFile()) {
                    Snapshot ready = snapshotFromReadyFile();
                    readyObserved = true;
                    publish(ready);
                    return;
                }
                if (publishReportedStartupError(null)) {
                    signalNodeStop();
                    return;
                }
                if (!readyObserved && startupBeganAt > 0
                        && SystemClock.elapsedRealtime() - startupBeganAt > STARTUP_TIMEOUT_MS) {
                    publish(Snapshot.error("手机服务器启动超时，请确认 "
                            + configuredPort + " 端口未被占用", configuredPort));
                    signalNodeStop();
                }
            } catch (Exception error) {
                Log.w(TAG, "Unable to read mobile server status", error);
            }
        }, 150, 300, TimeUnit.MILLISECONDS);
    }

    private Snapshot snapshotFromReadyFile() throws Exception {
        JSONObject ready = new JSONObject(readUtf8(readyFile));
        int port = ready.optInt("port", configuredPort);
        if (port != configuredPort) {
            throw new IOException("服务器没有监听预期的 " + configuredPort + " 端口");
        }
        LinkedHashSet<String> urls = new LinkedHashSet<>();
        JSONArray array = ready.optJSONArray("addresses");
        if (array != null) {
            for (int index = 0; index < array.length(); ++index) {
                String value = array.optString(index, "").trim();
                if (value.startsWith("http://") || value.startsWith("https://")) urls.add(value);
            }
        }
        if (urls.isEmpty()) urls.addAll(findLanUrls(port));
        return Snapshot.running(port, new ArrayList<>(urls), hostToken);
    }

    private File prepareRuntime() throws IOException {
        String version = readAssetText(RUNTIME_VERSION_ASSET).trim().toLowerCase(Locale.ROOT);
        if (!version.matches("[a-f0-9]{64}")) {
            throw new IOException("手机服务器资源版本无效");
        }

        File runtimes = new File(serviceRoot, "runtimes");
        if (!runtimes.isDirectory() && !runtimes.mkdirs()) {
            throw new IOException("无法创建服务器运行目录");
        }
        File target = new File(runtimes, version);
        if (runtimeComplete(target, version)) {
            cleanupOldRuntimes(runtimes, target);
            return target;
        }

        File staging = new File(runtimes,
                ".staging-" + android.os.Process.myPid() + "-" + System.nanoTime());
        deleteTree(staging);
        if (!staging.mkdirs()) throw new IOException("无法创建资源释放临时目录");
        try {
            copyAssetTree(ASSET_ROOT, staging);
            if (!runtimePayloadComplete(staging, version)) {
                throw new IOException("手机服务器资源释放不完整");
            }
            atomicWrite(new File(staging, RUNTIME_INSTALL_MARKER), version);
            deleteTree(target);
            if (!staging.renameTo(target)) {
                throw new IOException("无法启用已释放的手机服务器资源");
            }
        } catch (IOException error) {
            deleteTree(staging);
            throw error;
        }
        cleanupOldRuntimes(runtimes, target);
        return target;
    }

    private static boolean runtimeComplete(File root, String expectedVersion) {
        if (!runtimePayloadComplete(root, expectedVersion)) return false;
        try {
            return expectedVersion.equals(readUtf8(
                    new File(root, RUNTIME_INSTALL_MARKER)).trim());
        } catch (IOException ignored) {
            return false;
        }
    }

    private static boolean runtimePayloadComplete(File root, String expectedVersion) {
        if (!new File(root, "server/index.js").isFile()
                || !new File(root, "server/mobile-index.js").isFile()
                || !new File(root, "public/index.html").isFile()
                || !new File(root, "node_modules/socket.io/package.json").isFile()) return false;
        try {
            return expectedVersion.equals(readUtf8(new File(root, "runtime-version.txt")).trim());
        } catch (IOException ignored) {
            return false;
        }
    }

    private void copyAssetTree(String assetPath, File destination) throws IOException {
        AssetManager assets = getAssets();
        String[] children = assets.list(assetPath);
        if (children == null || children.length == 0) {
            File parent = destination.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                throw new IOException("无法创建资源目录: " + parent);
            }
            try (InputStream input = new BufferedInputStream(assets.open(assetPath));
                 FileOutputStream fileOutput = new FileOutputStream(destination);
                 BufferedOutputStream output = new BufferedOutputStream(fileOutput)) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (count > 0) output.write(buffer, 0, count);
                }
                output.flush();
                fileOutput.getFD().sync();
            }
            return;
        }

        if (!destination.isDirectory() && !destination.mkdirs()) {
            throw new IOException("无法创建资源目录: " + destination);
        }
        for (String child : children) {
            copyAssetTree(assetPath + "/" + child, new File(destination, child));
        }
    }

    private String buildBootstrap(File runtimeRoot, File dataRoot) {
        String runtime = JSONObject.quote(runtimeRoot.getAbsolutePath());
        String data = JSONObject.quote(dataRoot.getAbsolutePath());
        String stop = JSONObject.quote(stopFile.getAbsolutePath());
        String ready = JSONObject.quote(readyFile.getAbsolutePath());
        String error = JSONObject.quote(errorFile.getAbsolutePath());
        String token = JSONObject.quote(hostToken);
        String tunnelUnavailable = JSONObject.quote(ANDROID_TUNNEL_UNAVAILABLE_MESSAGE);
        return "'use strict';\n"
                + "const fs=require('fs'); const path=require('path'); const net=require('net');\n"
                + "const runtimeRoot=" + runtime + "; const dataRoot=" + data + ";\n"
                + "const stopFile=" + stop + "; const readyFile=" + ready + "; const errorFile=" + error + ";\n"
                + "const hostToken=" + token + "; const tunnelUnavailableMessage=" + tunnelUnavailable + "; let instance=null; let closing=false;\n"
                + "const tunnelManager=Object.freeze({status:async()=>({state:'unavailable',platform:'android',error:tunnelUnavailableMessage}),start:async()=>{const error=new Error(tunnelUnavailableMessage);error.code='ANDROID_TUNNEL_RUNTIME_UNAVAILABLE';throw error;},stop:async()=>({state:'unavailable',platform:'android',error:tunnelUnavailableMessage})});\n"
                + "process.chdir(runtimeRoot);\n"
                + "function atomic(file,value){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value),'utf8');fs.renameSync(temp,file);}\n"
                + "function messageOf(error){return String(error&&error.message||error||'未知的手机服务器错误').slice(0,1000);}\n"
                + "function report(error){atomic(errorFile,{message:messageOf(error),code:String(error&&error.code||''),stack:String(error&&error.stack||'').slice(0,4000)});}\n"
                + "function assertPortAvailable(port){return new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',error=>reject(new Error(error&&error.code==='EADDRINUSE'?port+' 端口已被其他应用占用':'无法监听 '+port+' 端口：'+messageOf(error))));probe.listen(port,'0.0.0.0',()=>probe.close(resolve));});}\n"
                + "async function shutdown(code){if(closing)return;closing=true;clearInterval(stopTimer);try{if(instance)await instance.close();}catch(error){report(error);code=1;}process.exitCode=code;}\n"
                + "const stopTimer=setInterval(()=>{try{if(fs.existsSync(stopFile))shutdown(0);}catch(error){report(error);shutdown(1);}},250);\n"
                + "process.on('SIGTERM',()=>shutdown(0)); process.on('SIGINT',()=>shutdown(0));\n"
                + "process.on('uncaughtException',error=>{report(error);shutdown(1);});\n"
                + "process.on('unhandledRejection',error=>{report(error);shutdown(1);});\n"
                + "(async()=>{try{const requestedPort=" + configuredPort + ";await assertPortAvailable(requestedPort);const {startSyncWatchServer}=require(path.join(runtimeRoot,'server','mobile-index.js'));instance=await startSyncWatchServer({host:'0.0.0.0',port:requestedPort,publicDir:path.join(runtimeRoot,'public'),dataDir:dataRoot,hostControlToken:hostToken,tunnelManager,androidApkPath:path.join(dataRoot,'SyncWatch同步观影-v2.3.8.apk'),ffprobePath:'',ffmpegPath:''});atomic(readyFile,{port:instance.port,addresses:instance.addresses||[]});}catch(error){report(error);shutdown(1);}})();\n";
    }

    private boolean publishReportedStartupError(File runtimeRoot) {
        if (errorFile == null || !errorFile.isFile()) return false;
        try {
            JSONObject error = new JSONObject(readUtf8(errorFile));
            String message = error.optString("message", "手机服务器启动失败");
            String code = error.optString("code", "").trim();
            String diagnostic = code.isEmpty() ? message : code + ": " + message;
            Log.e(TAG, "Embedded Node.js reported startup error: " + diagnostic
                    + "\n" + error.optString("stack", ""));
            if (!readyObserved && runtimeRoot != null && isRuntimeIntegrityFailure(diagnostic)) {
                invalidateRuntime(runtimeRoot);
            }
            publish(Snapshot.error(localizeServerError(diagnostic), configuredPort));
            return true;
        } catch (Exception error) {
            Log.w(TAG, "Unable to read mobile server startup error", error);
            return false;
        }
    }

    private static boolean isRuntimeIntegrityFailure(String diagnostic) {
        String upper = diagnostic == null ? "" : diagnostic.toUpperCase(Locale.ROOT);
        return upper.contains("MODULE_NOT_FOUND") || upper.contains("CANNOT FIND MODULE")
                || upper.contains("ENOENT") || upper.contains("UNEXPECTED TOKEN")
                || upper.contains("SYNTAXERROR");
    }

    private static void invalidateRuntime(File runtimeRoot) {
        File marker = new File(runtimeRoot, RUNTIME_INSTALL_MARKER);
        if (marker.isFile() && !marker.delete()) {
            Log.w(TAG, "Unable to invalidate incomplete mobile server runtime " + runtimeRoot);
        }
    }

    private void requestStop(String message) {
        stopRequested.set(true);
        publish(Snapshot.stopping(message, configuredPort));
        signalNodeStop();
        if (!launchRequested.get() || !nodeActive.get()) {
            publish(Snapshot.stopped());
            releaseRuntimeLocks();
            finishServiceProcess();
            return;
        }
        mainHandler.postDelayed(() -> {
            if (nodeActive.get()) {
                Log.w(TAG, "Embedded Node.js did not stop in time; terminating service process");
                android.os.Process.killProcess(android.os.Process.myPid());
            }
        }, FORCE_STOP_TIMEOUT_MS);
    }

    private void signalNodeStop() {
        File signal = stopFile != null ? stopFile : new File(serviceRoot, "stop.request");
        try {
            atomicWrite(signal, Long.toString(System.currentTimeMillis()));
        } catch (IOException error) {
            Log.w(TAG, "Unable to write Node stop signal", error);
        }
    }

    private void publish(Snapshot snapshot) {
        currentSnapshot = snapshot;
        currentStatus = snapshot.status;
        currentMessage = snapshot.message;
        try {
            atomicWrite(new File(serviceRoot, "status.json"), snapshot.toJson().toString());
        } catch (Exception error) {
            Log.w(TAG, "Unable to persist mobile server status", error);
        }

        Intent broadcast = new Intent(ACTION_STATUS_CHANGED)
                .setPackage(getPackageName())
                .putExtra(EXTRA_STATUS, snapshot.status)
                .putExtra(EXTRA_MESSAGE, snapshot.message)
                .putExtra(EXTRA_PORT, snapshot.port)
                .putExtra(EXTRA_URL, snapshot.localUrl)
                .putExtra(EXTRA_HOST_URL, snapshot.hostUrl)
                .putExtra(EXTRA_HOST_TOKEN, snapshot.hostToken)
                .putStringArrayListExtra(EXTRA_LAN_URLS, new ArrayList<>(snapshot.lanUrls));
        sendBroadcast(broadcast);

        mainHandler.post(() -> {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && !STATUS_STOPPED.equals(snapshot.status)) {
                manager.notify(NOTIFICATION_ID, buildNotification(snapshot));
            }
        });
    }

    private void enterForeground(String message, Snapshot snapshot) {
        currentSnapshot = snapshot;
        currentStatus = snapshot.status;
        currentMessage = message;
        Notification notification = buildNotification(snapshot);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        publish(snapshot);
    }

    private Notification buildNotification(Snapshot snapshot) {
        Intent openIntent = new Intent(this, MainActivity.class)
                .setAction(ACTION_OPEN_LOCAL_SERVER)
                .setData(snapshot.hostUrl.isEmpty() ? null : Uri.parse(snapshot.hostUrl))
                .putExtra(EXTRA_URL, snapshot.hostUrl)
                .putExtra(EXTRA_HOST_URL, snapshot.hostUrl)
                .putExtra(EXTRA_HOST_TOKEN, snapshot.hostToken)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPending = PendingIntent.getActivity(this, 42020, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent stopIntent = new Intent(this, MobileServerService.class).setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(this, 42021, stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String title;
        if (STATUS_RUNNING.equals(snapshot.status)) title = "手机服务器已开启";
        else if (STATUS_STOPPING.equals(snapshot.status)) title = "正在停止手机服务器";
        else if (STATUS_ERROR.equals(snapshot.status)) title = "手机服务器异常";
        else title = "正在启动手机服务器";

        String detail = snapshot.message;
        if (STATUS_RUNNING.equals(snapshot.status)) {
            detail = snapshot.lanUrls.isEmpty() ? snapshot.localUrl : snapshot.lanUrls.get(0);
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setSmallIcon(R.drawable.ic_server_notification)
                .setContentTitle(title)
                .setContentText(detail)
                .setStyle(new Notification.BigTextStyle().bigText(detail))
                .setContentIntent(openPending)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setOngoing(!STATUS_ERROR.equals(snapshot.status))
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(
                        R.drawable.ic_server_notification, "停止服务器", stopPending).build())
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "手机服务器", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("保持局域网 SyncWatch同步观影 服务器在后台运行");
        channel.setShowBadge(false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void acquireRuntimeLocks() {
        try {
            PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
            if (power != null) {
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                        getPackageName() + ":mobile-server");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
            }
        } catch (RuntimeException error) {
            Log.w(TAG, "Unable to acquire server wake lock", error);
        }
        try {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wifi != null) {
                wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                        getPackageName() + ":mobile-server");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        } catch (RuntimeException error) {
            Log.w(TAG, "Unable to acquire server Wi-Fi lock", error);
        }
    }

    private void releaseRuntimeLocks() {
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (RuntimeException ignored) {
        }
        wifiLock = null;
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (RuntimeException ignored) {
        }
        wakeLock = null;
    }

    private void finishServiceProcess() {
        mainHandler.post(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                //noinspection deprecation
                stopForeground(true);
            }
            stopSelf();
            mainHandler.postDelayed(
                    () -> android.os.Process.killProcess(android.os.Process.myPid()), 250);
        });
    }

    @Override
    public void onDestroy() {
        if (nodeActive.get()) {
            stopRequested.set(true);
            signalNodeStop();
        }
        releaseRuntimeLocks();
        monitorExecutor.shutdownNow();
        nodeExecutor.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static File serverRoot(Context context) {
        return new File(context.getFilesDir(), "mobile-server");
    }

    private static String ensureHostToken(Context context) {
        synchronized (TOKEN_LOCK) {
            File root = serverRoot(context);
            File tokenFile = new File(root, "host-token.txt");
            try {
                String existing = readUtf8(tokenFile).trim();
                if (existing.matches("[A-Za-z0-9_-]{32,100}")) return existing;
            } catch (IOException ignored) {
            }
            if (!root.isDirectory() && !root.mkdirs()) {
                throw new IllegalStateException("无法创建手机服务器配置目录");
            }
            byte[] bytes = new byte[32];
            TOKEN_RANDOM.nextBytes(bytes);
            String token = Base64.encodeToString(bytes,
                    Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            try {
                atomicWrite(tokenFile, token);
            } catch (IOException error) {
                throw new IllegalStateException("无法保存手机服务器主机凭证", error);
            }
            return token;
        }
    }

    private String readAssetText(String assetPath) throws IOException {
        try (InputStream input = getAssets().open(assetPath);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                if (count > 0) output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String readUtf8(File file) throws IOException {
        if (file == null || !file.isFile()) throw new IOException("文件不存在");
        try (InputStream input = new BufferedInputStream(new FileInputStream(file));
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                if (count > 0) output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static void atomicWrite(File file, String value) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("无法创建目录：" + parent);
        }
        File temporary = new File(parent, file.getName() + ".tmp-" + android.os.Process.myPid());
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
            output.flush();
            output.getFD().sync();
        }
        if (file.exists() && !file.delete()) {
            deleteIfPresent(temporary);
            throw new IOException("无法替换文件：" + file);
        }
        if (!temporary.renameTo(file)) {
            deleteIfPresent(temporary);
            throw new IOException("无法保存文件：" + file);
        }
    }

    private static void deleteIfPresent(File file) throws IOException {
        if (file != null && file.exists() && !file.delete()) {
            throw new IOException("无法删除文件：" + file);
        }
    }

    private static void deleteTree(File root) throws IOException {
        if (root == null || !root.exists()) return;
        File[] children = root.listFiles();
        if (children != null) {
            for (File child : children) deleteTree(child);
        }
        if (!root.delete()) throw new IOException("无法删除目录：" + root);
    }

    private static void cleanupOldRuntimes(File runtimes, File keep) {
        File[] children = runtimes.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (child.equals(keep)) continue;
            try {
                deleteTree(child);
            } catch (IOException error) {
                Log.w(TAG, "Unable to remove old mobile server runtime " + child, error);
            }
        }
    }

    private static List<String> findLanUrls(int port) {
        Set<String> urls = new LinkedHashSet<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces != null) {
                for (NetworkInterface network : Collections.list(interfaces)) {
                    if (!network.isUp() || network.isLoopback() || network.isVirtual()) continue;
                    for (InetAddress address : Collections.list(network.getInetAddresses())) {
                        if (!(address instanceof Inet4Address) || address.isLoopbackAddress()
                                || address.isLinkLocalAddress()) continue;
                        urls.add("http://" + address.getHostAddress() + ":" + port);
                    }
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "Unable to enumerate LAN addresses", error);
        }
        List<String> result = new ArrayList<>(urls);
        // List.sort and Comparator's Java 8 factory/default methods are only available
        // from Android API 24. Keep the mobile server compatible with minSdk 23.
        Collections.sort(result, new Comparator<String>() {
            @Override
            public int compare(String left, String right) {
                int rankComparison = Integer.compare(urlRank(left), urlRank(right));
                return rankComparison != 0 ? rankComparison : left.compareTo(right);
            }
        });
        return result;
    }

    private static int urlRank(String value) {
        if (value.contains("//192.168.")) return 0;
        if (value.contains("//10.")) return 1;
        if (value.matches(".*//172\\.(1[6-9]|2[0-9]|3[01])\\..*")) return 2;
        return 10;
    }

    private static String hostUrl(int port, String token) {
        return "http://127.0.0.1:" + port + "/#host=" + Uri.encode(token);
    }

    private static void validatePort(int port) {
        if (port < 1 || port > 65535) {
            throw new IllegalArgumentException("手机服务器端口必须是 1 到 65535 之间的整数");
        }
    }

    private static String safeMessage(Throwable error, String fallback) {
        String message = error == null ? "" : error.getMessage();
        if (message != null && message.matches(".*[\\u3400-\\u9FFF].*")) {
            return message.trim();
        }
        return fallback;
    }

    private static String localizeServerError(String message) {
        String value = message == null ? "" : message.trim();
        String upper = value.toUpperCase(Locale.ROOT);
        if (upper.contains("EADDRINUSE")) return "服务器端口已被其他应用占用";
        if (upper.contains("EACCES") || upper.contains("EPERM")) {
            return "系统不允许访问服务器文件或端口";
        }
        if (upper.contains("ENOSPC")) return "手机存储空间不足";
        if (upper.contains("MODULE_NOT_FOUND")) {
            return "手机服务器资源不完整，请重新安装完整 APK";
        }
        if (value.matches(".*[\\u3400-\\u9FFF].*")) return value;
        return "手机服务器运行失败，请重新启动；仍失败时请重新安装完整 APK";
    }

    public static final class Snapshot {
        public final String status;
        public final String message;
        public final int port;
        public final String localUrl;
        public final String hostUrl;
        public final String hostToken;
        public final List<String> lanUrls;
        public final long updatedAt;

        private Snapshot(String status, String message, int port, String localUrl,
                         String hostUrl, String hostToken, List<String> lanUrls,
                         long updatedAt) {
            this.status = status;
            this.message = message;
            this.port = port;
            this.localUrl = localUrl;
            this.hostUrl = hostUrl;
            this.hostToken = hostToken;
            this.lanUrls = Collections.unmodifiableList(new ArrayList<>(lanUrls));
            this.updatedAt = updatedAt;
        }

        public boolean isRunning() {
            return STATUS_RUNNING.equals(status);
        }

        static Snapshot stopped() {
            return new Snapshot(STATUS_STOPPED, "手机服务器已停止", 0,
                    "", "", "", Collections.emptyList(), System.currentTimeMillis());
        }

        static Snapshot stopped(String message, int port) {
            int safePort = port >= 1 && port <= 65535 ? port : 0;
            return new Snapshot(STATUS_STOPPED,
                    message == null || message.trim().isEmpty() ? "手机服务器已停止" : message,
                    safePort, safePort == 0 ? "" : "http://127.0.0.1:" + safePort + "/",
                    "", "", Collections.emptyList(), System.currentTimeMillis());
        }

        static Snapshot starting(String message, int port) {
            return new Snapshot(STATUS_STARTING, message, port,
                    "http://127.0.0.1:" + port + "/", "", "",
                    Collections.emptyList(), System.currentTimeMillis());
        }

        static Snapshot stopping(String message, int port) {
            return new Snapshot(STATUS_STOPPING, message, port,
                    "http://127.0.0.1:" + port + "/", "", "",
                    Collections.emptyList(), System.currentTimeMillis());
        }

        static Snapshot error(String message) {
            return new Snapshot(STATUS_ERROR, message, 0,
                    "", "", "", Collections.emptyList(), System.currentTimeMillis());
        }

        static Snapshot error(String message, int port) {
            return new Snapshot(STATUS_ERROR, message, port,
                    "http://127.0.0.1:" + port + "/", "", "",
                    Collections.emptyList(), System.currentTimeMillis());
        }

        static Snapshot running(int port, List<String> lanUrls, String token) {
            String local = "http://127.0.0.1:" + port + "/";
            return new Snapshot(STATUS_RUNNING, "手机服务器正在运行", port,
                    local, hostUrl(port, token), token, lanUrls, System.currentTimeMillis());
        }

        JSONObject toJson() throws Exception {
            JSONObject result = new JSONObject();
            result.put("status", status);
            result.put("message", message);
            result.put("port", port);
            result.put("localUrl", localUrl);
            result.put("hostUrl", hostUrl);
            result.put("hostToken", hostToken);
            result.put("lanUrls", new JSONArray(lanUrls));
            result.put("updatedAt", updatedAt);
            return result;
        }

        static Snapshot fromJson(JSONObject value) {
            String status = value.optString("status", STATUS_STOPPED);
            String message = value.optString("message", "");
            int port = value.optInt("port", 0);
            String localUrl = value.optString("localUrl", "");
            String hostUrl = value.optString("hostUrl", "");
            String hostToken = value.optString("hostToken", "");
            List<String> urls = new ArrayList<>();
            JSONArray array = value.optJSONArray("lanUrls");
            if (array != null) {
                for (int index = 0; index < array.length(); ++index) {
                    String item = array.optString(index, "");
                    if (!item.isEmpty()) urls.add(item);
                }
            }
            return new Snapshot(status, message, port, localUrl, hostUrl, hostToken,
                    urls, value.optLong("updatedAt", 0));
        }
    }
}

