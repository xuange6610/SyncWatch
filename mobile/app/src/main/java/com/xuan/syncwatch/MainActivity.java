package com.xuan.syncwatch;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.PictureInPictureParams;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.text.InputFilter;
import android.text.InputType;
import android.util.Base64;
import android.util.Rational;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class MainActivity extends Activity implements ScreenCaptureService.Listener {
    private static final String PREFS_NAME = "syncwatch_mobile";
    private static final String PREF_SERVER = "server_origin";
    private static final String PREF_LOCAL_SERVER_MODE = "local_server_mode";
    private static final String PREF_LOCAL_SERVER_PORT = "local_server_port";
    private static final String PREF_LOCATION_REQUESTED = "location_permission_requested";
    private static final String INTERNAL_BRIDGE_NAME = "SyncWatchNativeBridgeInternal";
    private static final String PUBLIC_BRIDGE_NAME = "SyncWatchAndroid";
    private static final int NATIVE_BRIDGE_VERSION = 1;
    private static final int REQUEST_FILES = 2001;
    private static final int REQUEST_MICROPHONE = 2002;
    private static final int REQUEST_DOWNLOAD_STORAGE = 2003;
    private static final int REQUEST_NOTIFICATION = 2004;
    private static final int REQUEST_MEDIA_PROJECTION = 2005;
    private static final int REQUEST_FOLDER = 2006;
    private static final int REQUEST_SERVER_NOTIFICATION = 2007;
    private static final int REQUEST_LOCATION = 2008;
    private static final long FOLDER_CHOOSER_WINDOW_MS = 10_000L;
    private static final int FOLDER_MAX_FILES = 2000;
    private static final int FOLDER_MAX_DIRECTORIES = 1000;
    private static final int FOLDER_MAX_DEPTH = 24;
    private static final long PAGE_LOAD_TIMEOUT_MS = 20_000L;
    private static final int COLOR_BACKGROUND = Color.rgb(16, 19, 21);
    private static final int COLOR_SURFACE = Color.rgb(27, 32, 35);
    private static final int COLOR_FIELD = Color.rgb(34, 41, 44);
    private static final int COLOR_BORDER = Color.rgb(59, 70, 74);
    private static final int COLOR_TEXT = Color.rgb(245, 247, 248);
    private static final int COLOR_MUTED = Color.rgb(174, 185, 189);
    private static final int COLOR_ACCENT = Color.rgb(31, 143, 160);
    private static final int COLOR_DANGER = Color.rgb(127, 61, 73);

    private FrameLayout root;
    private WebView webView;
    private View connectionView;
    private EditText serverInput;
    private TextView connectionStatus;
    private TextView mobileServerStatus;
    private TextView mobileServerAddresses;
    private EditText mobileServerPortInput;
    private Button mobileServerStartButton;
    private Button mobileServerStopButton;
    private SharedPreferences preferences;
    private String serverOrigin = "";
    private String lastRequestedUrl = "";
    private String activeTopLevelUrl = "";
    private ValueCallback<Uri[]> pendingFileCallback;
    private PermissionRequest pendingMicrophoneRequest;
    private GeolocationPermissions.Callback pendingLocationCallback;
    private String pendingLocationOrigin = "";
    private boolean locationSettingsPending;
    private PendingDownload pendingDownload;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private final SecureRandom secureRandom = new SecureRandom();
    private volatile String trustedBridgeToken = "";
    private volatile boolean trustedTopLevelPage;
    private boolean projectionPermissionPending;
    private boolean continueProjectionAfterNotificationPermission;
    private boolean cancelPendingProjection;
    private boolean nativeFrameEvaluationPending;
    private String nativeCaptureState = "idle";
    private String nativeCaptureSessionId = "";
    private String nativeCaptureReason = "";
    private String nativeCaptureMessage = "";
    private int nativeCaptureWidth;
    private int nativeCaptureHeight;
    private int nativeCaptureFps = 8;
    private final ExecutorService folderExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "SyncWatchFolderScanner");
        thread.setDaemon(true);
        return thread;
    });
    private volatile long folderChooserRequestedAt;
    private ValueCallback<Uri[]> pendingFolderResultCallback;
    private String[] pendingFolderAcceptTypes = new String[]{"*/*"};
    private boolean localServerMode;
    private boolean localHostPageRequested;
    private boolean mobileServerReceiverRegistered;
    private boolean activityResumed;
    private boolean mediaPlaybackActive;
    private boolean destroyed;
    private boolean topLevelLoadFailed;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Runnable pageLoadTimeoutTask;

    private final BroadcastReceiver mobileServerReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (destroyed || intent == null
                    || !MobileServerService.ACTION_STATUS_CHANGED.equals(intent.getAction())) return;
            if (MobileServerService.STATUS_STOPPED.equals(
                    intent.getStringExtra(MobileServerService.EXTRA_STATUS))) {
                setLocalServerMode(false);
                localHostPageRequested = false;
                leaveStoppedLocalServerPage("手机服务器已停止");
            }
            refreshMobileServerState(activityResumed);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        // Migrate the pre-2.3.1 development default once. Keep any other
        // user-selected port unchanged.
        if (preferences.getInt(PREF_LOCAL_SERVER_PORT, MobileServerService.SERVER_PORT) == 5000) {
            preferences.edit().putInt(PREF_LOCAL_SERVER_PORT, MobileServerService.SERVER_PORT).apply();
        }
        localServerMode = preferences.getBoolean(PREF_LOCAL_SERVER_MODE, false);
        root = new FrameLayout(this);
        root.setBackgroundColor(COLOR_BACKGROUND);
        setContentView(root);
        configureWindowInsets();

        createWebView();
        ScreenCaptureService.setListener(this);
        createConnectionView();
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(connectionView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        registerMobileServerReceiver();

        MobileServerService.Snapshot mobileServer = MobileServerService.getSnapshot(this);
        updateMobileServerUi(mobileServer);
        if (MobileServerService.ACTION_OPEN_LOCAL_SERVER.equals(getIntent().getAction())) {
            setLocalServerMode(true);
        }

        String savedServer = preferences.getString(PREF_SERVER, "");
        serverInput.setText(savedServer == null ? "" : savedServer);
        if (localServerMode && mobileServer.isRunning()) {
            connectToLocalServer(mobileServer.hostUrl);
        } else if (localServerMode) {
            showConnectionScreen(mobileServer.message.isEmpty()
                    ? "正在恢复手机服务器…" : mobileServer.message);
        } else if (savedServer != null && !savedServer.isEmpty()
                && !isLocalServerOrigin(savedServer)) {
            connectToServer(savedServer);
        } else {
            if (savedServer != null && isLocalServerOrigin(savedServer)) {
                preferences.edit().remove(PREF_SERVER).apply();
                serverInput.setText("");
            }
            showConnectionScreen("");
        }
    }

    private void configureWindowInsets() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;

        getWindow().setDecorFitsSystemWindows(false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            Insets safe = windowInsets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsets.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, Math.max(safe.bottom, ime.bottom));
            return windowInsets;
        });
        showSystemUi();
        root.requestApplyInsets();
    }

    private void createWebView() {
        webView = new WebView(this);
        // Match the native connection page while Chromium starts or recovers. A black
        // WebView surface looked like a frozen APK on slower phones even though the
        // connection controls were still being prepared above it.
        webView.setBackgroundColor(COLOR_BACKGROUND);
        webView.setVisibility(View.GONE);
        webView.setKeepScreenOn(false);
        WebView.setWebContentsDebuggingEnabled(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " SyncWatchAndroid/v2.3.4");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new SafeWebViewClient());
        webView.setWebChromeClient(new SyncWatchChromeClient());
        webView.setDownloadListener(new SafeDownloadListener());
        webView.addJavascriptInterface(new NativeScreenBridge(), INTERNAL_BRIDGE_NAME);
    }

    private void createConnectionView() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        scroll.setBackgroundColor(COLOR_BACKGROUND);

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        int screenWidthDp = Math.round(getResources().getDisplayMetrics().widthPixels
                / getResources().getDisplayMetrics().density);
        int horizontalPadding = screenWidthDp >= 600 ? Math.max(20, (screenWidthDp - 560) / 2) : 20;
        panel.setPadding(dp(horizontalPadding), dp(22), dp(horizontalPadding), dp(28));
        scroll.addView(panel, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout brand = new LinearLayout(this);
        brand.setOrientation(LinearLayout.HORIZONTAL);
        brand.setGravity(Gravity.CENTER);
        TextView mark = textView("▶", 25, COLOR_ACCENT, Typeface.BOLD);
        mark.setGravity(Gravity.CENTER);
        brand.addView(mark, new LinearLayout.LayoutParams(dp(34), dp(40)));
        TextView title = textView("SyncWatch同步观影", 23, COLOR_TEXT, Typeface.BOLD);
        title.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(40));
        titleParams.leftMargin = dp(8);
        brand.addView(title, titleParams);
        panel.addView(brand, matchWrap());

        TextView hint = textView("连接服务器，或在本机启动局域网服务器", 14,
                COLOR_MUTED, Typeface.NORMAL);
        hint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintParams = matchWrap();
        hintParams.topMargin = dp(2);
        panel.addView(hint, hintParams);

        LinearLayout connectSection = sectionContainer();
        connectSection.addView(textView("连接现有服务器", 17, COLOR_TEXT, Typeface.BOLD), matchWrap());
        TextView connectHint = textView(
                "输入电脑端显示的地址，例如 http://192.168.1.20:20311 或 HTTPS 公网地址",
                14, COLOR_MUTED, Typeface.NORMAL);
        connectHint.setLineSpacing(dp(2), 1f);
        LinearLayout.LayoutParams connectHintParams = matchWrap();
        connectHintParams.topMargin = dp(6);
        connectSection.addView(connectHint, connectHintParams);

        serverInput = new EditText(this);
        serverInput.setSingleLine(true);
        serverInput.setHint("http://服务器IP:端口");
        serverInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        styleInput(serverInput);
        connectSection.addView(serverInput, fullWidth(dp(50), dp(12)));

        Button connectButton = new Button(this);
        connectButton.setText("连接服务器");
        styleButton(connectButton, COLOR_ACCENT);
        connectButton.setOnClickListener(view -> {
            setLocalServerMode(false);
            connectToServer(serverInput.getText().toString());
        });
        connectSection.addView(connectButton, fullWidth(dp(50), dp(10)));
        panel.addView(connectSection, fullWidth(ViewGroup.LayoutParams.WRAP_CONTENT, dp(20)));

        LinearLayout localSection = sectionContainer();
        localSection.addView(textView("本机服务器", 17, COLOR_TEXT, Typeface.BOLD), matchWrap());
        TextView localHint = textView(
                "供同一 Wi-Fi 或热点内的设备访问。公网使用请连接已开启公网访问的桌面或云服务器。",
                14, COLOR_MUTED, Typeface.NORMAL);
        localHint.setLineSpacing(dp(2), 1f);
        LinearLayout.LayoutParams localHintParams = matchWrap();
        localHintParams.topMargin = dp(6);
        localSection.addView(localHint, localHintParams);

        LinearLayout portRow = new LinearLayout(this);
        portRow.setOrientation(LinearLayout.HORIZONTAL);
        portRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView portLabel = textView("端口", 15, COLOR_MUTED, Typeface.BOLD);
        portRow.addView(portLabel, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        mobileServerPortInput = new EditText(this);
        mobileServerPortInput.setSingleLine(true);
        mobileServerPortInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        mobileServerPortInput.setFilters(new InputFilter[]{new InputFilter.LengthFilter(5)});
        mobileServerPortInput.setHint("20311");
        mobileServerPortInput.setGravity(Gravity.CENTER);
        styleInput(mobileServerPortInput);
        mobileServerPortInput.setText(String.valueOf(preferences.getInt(
                PREF_LOCAL_SERVER_PORT, MobileServerService.SERVER_PORT)));
        LinearLayout.LayoutParams portInputParams = new LinearLayout.LayoutParams(dp(124), dp(48));
        portInputParams.leftMargin = dp(12);
        portRow.addView(mobileServerPortInput, portInputParams);
        localSection.addView(portRow, fullWidth(ViewGroup.LayoutParams.WRAP_CONTENT, dp(12)));

        LinearLayout serverButtons = new LinearLayout(this);
        serverButtons.setOrientation(LinearLayout.HORIZONTAL);
        serverButtons.setGravity(Gravity.CENTER);
        mobileServerStartButton = new Button(this);
        mobileServerStartButton.setText("启动手机服务器");
        styleButton(mobileServerStartButton, COLOR_ACCENT);
        mobileServerStartButton.setOnClickListener(view -> requestMobileServerStart());
        serverButtons.addView(mobileServerStartButton,
                new LinearLayout.LayoutParams(0, dp(50), 1f));

        mobileServerStopButton = new Button(this);
        mobileServerStopButton.setText("停止");
        styleButton(mobileServerStopButton, COLOR_DANGER);
        mobileServerStopButton.setOnClickListener(view -> stopMobileServer());
        LinearLayout.LayoutParams stopParams = new LinearLayout.LayoutParams(0, dp(50), 0.55f);
        stopParams.leftMargin = dp(10);
        serverButtons.addView(mobileServerStopButton, stopParams);
        localSection.addView(serverButtons, fullWidth(ViewGroup.LayoutParams.WRAP_CONTENT, dp(12)));

        mobileServerStatus = textView("手机服务器未启动", 14, COLOR_MUTED, Typeface.BOLD);
        mobileServerStatus.setGravity(Gravity.START);
        mobileServerStatus.setTextIsSelectable(true);
        LinearLayout.LayoutParams mobileStatusParams = matchWrap();
        mobileStatusParams.topMargin = dp(12);
        localSection.addView(mobileServerStatus, mobileStatusParams);

        mobileServerAddresses = textView("", 14, Color.rgb(125, 208, 190), Typeface.NORMAL);
        mobileServerAddresses.setGravity(Gravity.START);
        mobileServerAddresses.setTextIsSelectable(true);
        mobileServerAddresses.setLineSpacing(dp(2), 1f);
        LinearLayout.LayoutParams addressesParams = matchWrap();
        addressesParams.topMargin = dp(8);
        localSection.addView(mobileServerAddresses, addressesParams);
        panel.addView(localSection, fullWidth(ViewGroup.LayoutParams.WRAP_CONTENT, dp(12)));

        connectionStatus = textView("", 14, Color.rgb(255, 155, 164), Typeface.BOLD);
        connectionStatus.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams statusParams = matchWrap();
        statusParams.topMargin = dp(12);
        panel.addView(connectionStatus, statusParams);
        connectionView = scroll;
    }

    private LinearLayout sectionContainer() {
        LinearLayout section = new LinearLayout(this);
        section.setOrientation(LinearLayout.VERTICAL);
        section.setPadding(dp(16), dp(15), dp(16), dp(16));
        section.setBackground(roundedBackground(COLOR_SURFACE, COLOR_BORDER));
        return section;
    }

    private TextView textView(String value, int textSizeSp, int color, int style) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, textSizeSp);
        view.setTypeface(Typeface.create("sans-serif", style));
        view.setIncludeFontPadding(false);
        return view;
    }

    private void styleInput(EditText input) {
        input.setTextColor(COLOR_TEXT);
        input.setHintTextColor(Color.rgb(132, 146, 151));
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        input.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        input.setIncludeFontPadding(false);
        input.setPadding(dp(14), 0, dp(14), 0);
        input.setMinHeight(dp(48));
        input.setBackground(roundedBackground(COLOR_FIELD, COLOR_BORDER));
    }

    private void styleButton(Button button, int color) {
        button.setTextColor(COLOR_TEXT);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        button.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        button.setIncludeFontPadding(false);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setMinHeight(dp(48));
        button.setMinWidth(dp(48));
        button.setPadding(dp(12), 0, dp(12), 0);
        button.setBackground(roundedBackground(color, color));
    }

    private GradientDrawable roundedBackground(int fillColor, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fillColor);
        drawable.setCornerRadius(dp(8));
        drawable.setStroke(dp(1), strokeColor);
        return drawable;
    }

    private LinearLayout.LayoutParams fullWidth(int height, int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, height);
        params.topMargin = topMargin;
        return params;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void setLocalServerMode(boolean enabled) {
        localServerMode = enabled;
        preferences.edit().putBoolean(PREF_LOCAL_SERVER_MODE, enabled).apply();
    }

    private void requestMobileServerStart() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            mobileServerStatus.setText("请允许通知权限，以显示服务器地址和停止按钮…");
            mobileServerStatus.setTextColor(Color.rgb(255, 205, 128));
            try {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        REQUEST_SERVER_NOTIFICATION);
            } catch (RuntimeException error) {
                toast("无法申请通知权限；服务器仍会启动，请在系统设置中手动开启通知");
                startMobileServer();
            }
            return;
        }
        startMobileServer();
    }

    private void startMobileServer() {
        int requestedPort;
        try {
            requestedPort = readRequestedMobileServerPort();
        } catch (IllegalArgumentException error) {
            mobileServerStatus.setText(error.getMessage());
            mobileServerStatus.setTextColor(Color.rgb(255, 126, 145));
            mobileServerPortInput.requestFocus();
            return;
        }
        setLocalServerMode(true);
        preferences.edit().putInt(PREF_LOCAL_SERVER_PORT, requestedPort).apply();
        localHostPageRequested = false;
        mobileServerStatus.setText(String.format(
                Locale.getDefault(), "正在启动手机服务器（端口 %d）…", requestedPort));
        mobileServerStatus.setTextColor(Color.rgb(255, 205, 128));
        mobileServerAddresses.setText("");
        mobileServerStartButton.setEnabled(false);
        mobileServerStopButton.setEnabled(true);
        mobileServerPortInput.setEnabled(false);
        Runnable launch = () -> {
            if (destroyed) return;
            try {
                MobileServerService.start(this, requestedPort);
            } catch (RuntimeException error) {
                setLocalServerMode(false);
                mobileServerStatus.setText(String.format(Locale.getDefault(), "启动失败：%s",
                        safeErrorMessage(error, "系统不允许启动服务")));
                mobileServerStatus.setTextColor(Color.rgb(255, 126, 145));
                mobileServerStartButton.setEnabled(true);
                mobileServerStopButton.setEnabled(false);
                mobileServerPortInput.setEnabled(true);
            }
        };
        MobileServerService.Snapshot previous = MobileServerService.getSnapshot(this);
        if (MobileServerService.STATUS_ERROR.equals(previous.status)) {
            mobileServerStatus.setText("正在清理上次失败的运行环境并重新启动…");
            MobileServerService.prepareRetry(this);
            stopService(new Intent(this, MobileServerService.class));
            mainHandler.postDelayed(launch, 700);
            return;
        }
        launch.run();
    }

    private int readRequestedMobileServerPort() {
        String value = mobileServerPortInput == null
                ? "" : mobileServerPortInput.getText().toString().trim();
        if (value.isEmpty()) throw new IllegalArgumentException("请输入 1 到 65535 之间的服务器端口");
        try {
            int port = Integer.parseInt(value);
            if (port < 1 || port > 65535) throw new NumberFormatException();
            return port;
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("服务器端口必须是 1 到 65535 之间的整数");
        }
    }

    private void stopMobileServer() {
        setLocalServerMode(false);
        localHostPageRequested = false;
        mobileServerStatus.setText("正在停止手机服务器…");
        mobileServerStatus.setTextColor(Color.rgb(255, 205, 128));
        mobileServerStartButton.setEnabled(false);
        mobileServerStopButton.setEnabled(false);
        boolean viewingLocalServer = isLocalServerOrigin(serverOrigin);
        try {
            MobileServerService.stop(this);
        } catch (RuntimeException error) {
            mobileServerStatus.setText(String.format(Locale.getDefault(), "停止失败：%s",
                    safeErrorMessage(error, "无法停止服务")));
            mobileServerStatus.setTextColor(Color.rgb(255, 126, 145));
        }
        if (viewingLocalServer) leaveStoppedLocalServerPage("手机服务器已停止");
    }

    private void leaveStoppedLocalServerPage(String message) {
        if (!isLocalServerOrigin(serverOrigin)) return;
        if (webView != null) webView.stopLoading();
        serverOrigin = "";
        lastRequestedUrl = "";
        activeTopLevelUrl = "";
        preferences.edit().remove(PREF_SERVER).apply();
        serverInput.setText("");
        showConnectionScreen(message);
    }

    private void refreshMobileServerState(boolean autoConnect) {
        MobileServerService.Snapshot snapshot = MobileServerService.getSnapshot(this);
        updateMobileServerUi(snapshot);
        if (autoConnect && localServerMode && snapshot.isRunning()
                && (!localHostPageRequested
                || connectionView.getVisibility() == View.VISIBLE
                || !isLocalServerOrigin(serverOrigin))) {
            connectToLocalServer(snapshot.hostUrl);
        }
    }

    private void updateMobileServerUi(MobileServerService.Snapshot snapshot) {
        if (snapshot == null || mobileServerStatus == null) return;
        String status = snapshot.status;
        String message = snapshot.message == null ? "" : snapshot.message.trim();
        if (MobileServerService.STATUS_RUNNING.equals(status)) {
            mobileServerStatus.setText(message.isEmpty() ? "手机服务器正在运行" : message);
            mobileServerStatus.setTextColor(Color.rgb(128, 224, 173));
        } else if (MobileServerService.STATUS_STARTING.equals(status)) {
            mobileServerStatus.setText(message.isEmpty() ? "正在启动手机服务器…" : message);
            mobileServerStatus.setTextColor(Color.rgb(255, 205, 128));
        } else if (MobileServerService.STATUS_STOPPING.equals(status)) {
            mobileServerStatus.setText(message.isEmpty() ? "正在停止手机服务器…" : message);
            mobileServerStatus.setTextColor(Color.rgb(255, 205, 128));
        } else if (MobileServerService.STATUS_ERROR.equals(status)) {
            mobileServerStatus.setText(message.isEmpty() ? "手机服务器启动失败" : "启动失败：" + message);
            mobileServerStatus.setTextColor(Color.rgb(255, 126, 145));
        } else {
            mobileServerStatus.setText(message.isEmpty() ? "手机服务器未启动" : message);
            mobileServerStatus.setTextColor(COLOR_MUTED);
        }

        boolean starting = MobileServerService.STATUS_STARTING.equals(status);
        boolean running = MobileServerService.STATUS_RUNNING.equals(status);
        boolean stopping = MobileServerService.STATUS_STOPPING.equals(status);
        mobileServerStartButton.setText(MobileServerService.STATUS_ERROR.equals(status)
                ? "重新启动手机服务器" : running ? "服务器运行中" : "启动手机服务器");
        mobileServerStartButton.setEnabled(!(starting || running || stopping));
        mobileServerStopButton.setEnabled(starting || running);
        mobileServerPortInput.setEnabled(!(starting || running || stopping));
        mobileServerStartButton.setAlpha(mobileServerStartButton.isEnabled() ? 1f : 0.48f);
        mobileServerStopButton.setAlpha(mobileServerStopButton.isEnabled() ? 1f : 0.48f);
        mobileServerPortInput.setAlpha(mobileServerPortInput.isEnabled() ? 1f : 0.62f);
        if (snapshot.port >= 1 && snapshot.port <= 65535 && !mobileServerPortInput.hasFocus()) {
            mobileServerPortInput.setText(String.valueOf(snapshot.port));
        }

        if (running) {
            StringBuilder addresses = new StringBuilder();
            if (snapshot.localUrl != null && !snapshot.localUrl.isEmpty()) {
                addresses.append("本机访问：").append(snapshot.localUrl);
            }
            if (snapshot.lanUrls != null && !snapshot.lanUrls.isEmpty()) {
                if (addresses.length() > 0) addresses.append('\n');
                addresses.append("局域网访问：");
                for (int index = 0; index < snapshot.lanUrls.size(); index += 1) {
                    if (index > 0) addresses.append('\n').append("　　　　　　");
                    addresses.append(snapshot.lanUrls.get(index));
                }
            } else {
                if (addresses.length() > 0) addresses.append('\n');
                addresses.append("请连接 Wi-Fi 或开启热点后，再让其他设备访问");
            }
            mobileServerAddresses.setText(addresses.toString());
        } else {
            mobileServerAddresses.setText("");
        }
    }

    private boolean isLocalServerOrigin(String origin) {
        if (origin == null || origin.isEmpty()) return false;
        try {
            Uri uri = Uri.parse(origin);
            String host = lower(uri.getHost());
            return (host.equals("127.0.0.1") || host.equals("localhost"))
                    && effectivePort(uri) >= 1 && effectivePort(uri) <= 65535;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private void registerMobileServerReceiver() {
        if (mobileServerReceiverRegistered) return;
        IntentFilter filter = new IntentFilter(MobileServerService.ACTION_STATUS_CHANGED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(mobileServerReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            //noinspection UnspecifiedRegisterReceiverFlag
            registerReceiver(mobileServerReceiver, filter);
        }
        mobileServerReceiverRegistered = true;
    }

    private void unregisterMobileServerReceiver() {
        if (!mobileServerReceiverRegistered) return;
        try {
            unregisterReceiver(mobileServerReceiver);
        } catch (IllegalArgumentException ignored) {
        }
        mobileServerReceiverRegistered = false;
    }

    private void openLocalServerFromIntent(Intent intent) {
        if (intent == null || !MobileServerService.ACTION_OPEN_LOCAL_SERVER.equals(intent.getAction())) return;
        setLocalServerMode(true);
        MobileServerService.Snapshot snapshot = MobileServerService.getSnapshot(this);
        updateMobileServerUi(snapshot);
        if (snapshot.isRunning()) {
            connectToLocalServer(snapshot.hostUrl);
        } else if (MobileServerService.STATUS_STARTING.equals(snapshot.status)) {
            showConnectionScreen(snapshot.message);
        } else {
            showConnectionScreen("正在启动手机服务器…");
            startMobileServer();
        }
    }

    private void connectToServer(String entered) {
        String normalized;
        try {
            normalized = normalizeServerOrigin(entered);
        } catch (IllegalArgumentException error) {
            showConnectionScreen(error.getMessage());
            return;
        }
        connectToResolvedServer(normalized, normalized + "/", false);
    }

    private void connectToLocalServer(String hostUrl) {
        String requestedUrl = hostUrl == null ? "" : hostUrl.trim();
        if (requestedUrl.isEmpty()) {
            MobileServerService.Snapshot snapshot = MobileServerService.getSnapshot(this);
            requestedUrl = snapshot.hostUrl;
        }
        try {
            String normalized = normalizeServerOrigin(requestedUrl);
            Uri origin = Uri.parse(normalized);
            if (!("127.0.0.1".equals(origin.getHost()) || "localhost".equalsIgnoreCase(origin.getHost()))
                    || effectivePort(origin) < 1 || effectivePort(origin) > 65535) {
                throw new IllegalArgumentException("手机服务器入口无效");
            }
            setLocalServerMode(true);
            connectToResolvedServer(normalized, requestedUrl, true);
        } catch (IllegalArgumentException error) {
            localHostPageRequested = false;
            showConnectionScreen(error.getMessage());
        }
    }

    private void connectToResolvedServer(String normalized, String requestedUrl, boolean localHostPage) {
        if (!serverOrigin.isEmpty() && !serverOrigin.equals(normalized)) {
            cancelPendingProjection = true;
            ScreenCaptureService.stopCapture(this, "server-changed");
        }
        invalidateNativeBridge(false);
        serverOrigin = normalized;
        localHostPageRequested = localHostPage;
        activeTopLevelUrl = requestedUrl;
        lastRequestedUrl = requestedUrl;
        topLevelLoadFailed = false;
        preferences.edit().putString(PREF_SERVER, normalized).apply();
        showPageLoading("正在连接服务器…");
        webView.setVisibility(View.VISIBLE);
        updateKeepScreenOn();
        schedulePageLoadTimeout(requestedUrl);
        webView.loadUrl(requestedUrl);
    }

    private void showPageLoading(String message) {
        if (fullscreenView != null) hideFullscreenView();
        connectionStatus.setText(message == null ? "正在连接服务器…" : message);
        connectionView.setVisibility(View.VISIBLE);
        if (webView != null) webView.setVisibility(View.VISIBLE);
        updateKeepScreenOn();
    }

    private void schedulePageLoadTimeout(String requestedUrl) {
        cancelPageLoadTimeout();
        final String expectedUrl = requestedUrl == null ? "" : requestedUrl;
        pageLoadTimeoutTask = () -> {
            pageLoadTimeoutTask = null;
            if (destroyed || webView == null || serverOrigin.isEmpty()
                    || connectionView == null || connectionView.getVisibility() != View.VISIBLE) return;
            if (!expectedUrl.isEmpty()
                    && !sameDocumentUrl(expectedUrl, activeTopLevelUrl)
                    && !sameDocumentUrl(expectedUrl, lastRequestedUrl)) return;
            webView.stopLoading();
            topLevelLoadFailed = true;
            showConnectionScreen("连接服务器超时，请检查地址、网络、端口和服务器状态后重试");
        };
        mainHandler.postDelayed(pageLoadTimeoutTask, PAGE_LOAD_TIMEOUT_MS);
    }

    private void cancelPageLoadTimeout() {
        if (pageLoadTimeoutTask == null) return;
        mainHandler.removeCallbacks(pageLoadTimeoutTask);
        pageLoadTimeoutTask = null;
    }

    private void revealLoadedPage(String url) {
        Uri uri;
        try {
            uri = Uri.parse(url == null ? "" : url);
        } catch (RuntimeException ignored) {
            return;
        }
        if (!isSameServer(uri) || topLevelLoadFailed) return;
        cancelPageLoadTimeout();
        webView.setVisibility(View.VISIBLE);
        connectionView.setVisibility(View.GONE);
        updateKeepScreenOn();
    }

    private String normalizeServerOrigin(String input) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) throw new IllegalArgumentException("请输入服务器地址");
        try {
            URI parsed = new URI(value);
            String scheme = parsed.getScheme() == null ? "" : parsed.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) {
                throw new IllegalArgumentException("服务器地址必须以 http:// 或 https:// 开头");
            }
            if (parsed.getHost() == null || parsed.getHost().isEmpty() || parsed.getUserInfo() != null) {
                throw new IllegalArgumentException("服务器地址无效，且不能包含用户名或密码");
            }
            int port = parsed.getPort();
            if (port == 0 || port < -1 || port > 65535) {
                throw new IllegalArgumentException("服务器端口无效");
            }
            String path = parsed.getPath();
            if (path != null && !path.isEmpty() && !path.equals("/")) {
                throw new IllegalArgumentException("请输入服务器根地址，不要附加页面路径");
            }
            return new URI(scheme, null, parsed.getHost(), port, null, null, null).toASCIIString();
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("服务器地址格式不正确");
        }
    }

    private void showConnectionScreen(String message) {
        cancelPageLoadTimeout();
        if (fullscreenView != null) hideFullscreenView();
        invalidateNativeBridge(true);
        localHostPageRequested = false;
        if (webView != null) webView.setVisibility(View.GONE);
        connectionView.setVisibility(View.VISIBLE);
        connectionStatus.setText(message == null ? "" : message);
        if (localServerMode) serverInput.clearFocus();
        updateKeepScreenOn();
    }

    private boolean isSameServer(Uri uri) {
        if (uri == null || serverOrigin.isEmpty()) return false;
        Uri expected = Uri.parse(serverOrigin);
        String scheme = lower(uri.getScheme());
        String host = lower(uri.getHost());
        return (scheme.equals("http") || scheme.equals("https"))
                && scheme.equals(lower(expected.getScheme()))
                && host.equals(lower(expected.getHost()))
                && effectivePort(uri) == effectivePort(expected)
                && uri.getUserInfo() == null;
    }

    private static String lower(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT);
    }

    private static int effectivePort(Uri uri) {
        if (uri.getPort() >= 0) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private static String localizeWebError(String description) {
        String value = description == null ? "" : description.trim();
        String normalized = value.toLowerCase(Locale.ROOT);
        if (normalized.contains("err_connection_refused")) {
            return "服务器拒绝连接，请确认服务器已启动且端口填写正确";
        }
        if (normalized.contains("err_name_not_resolved")) {
            return "无法解析服务器域名，请检查地址或网络连接";
        }
        if (normalized.contains("err_internet_disconnected")) {
            return "手机当前没有可用网络，请联网后重试";
        }
        if (normalized.contains("err_connection_timed_out") || normalized.contains("timed out")) {
            return "连接服务器超时，请检查公网转发、端口和防火墙";
        }
        if (normalized.contains("err_address_unreachable")) {
            return "服务器地址无法访问，请检查地址和网络是否互通";
        }
        if (normalized.contains("err_cleartext_not_permitted")) {
            return "系统阻止了该 HTTP 连接，请改用 HTTPS 或检查应用网络设置";
        }
        if (normalized.contains("err_ssl") || normalized.contains("certificate")) {
            return "HTTPS 证书验证失败，连接已被安全拒绝";
        }
        if (normalized.contains("err_too_many_redirects")) {
            return "服务器重定向次数过多，请检查反向代理配置";
        }
        if (normalized.contains("err_empty_response")) {
            return "服务器没有返回内容，请检查服务器或公网转发";
        }
        if (value.matches(".*[\\u3400-\\u9FFF].*")) {
            return "无法连接服务器：" + value;
        }
        return "无法连接服务器，请检查地址、网络、端口和服务器状态后重试";
    }

    private boolean isTrustedTopLevelUrl(String url) {
        if (webView == null || url == null || url.isEmpty()) return false;
        if (connectionView != null && connectionView.getVisibility() == View.VISIBLE) return false;
        Uri uri;
        try {
            uri = Uri.parse(url);
        } catch (RuntimeException error) {
            return false;
        }
        String current = webView.getUrl();
        return current != null && current.equals(url) && isSameServer(uri);
    }

    private void invalidateNativeBridge(boolean stopCapture) {
        trustedTopLevelPage = false;
        trustedBridgeToken = "";
        nativeFrameEvaluationPending = false;
        mediaPlaybackActive = false;
        folderChooserRequestedAt = 0;
        if (projectionPermissionPending) cancelPendingProjection = true;
        if (webView != null) {
            try {
                webView.evaluateJavascript("try{delete window.SyncWatchAndroid;delete window.SyncWatchPlatform;}catch(_){void 0;}", null);
            } catch (RuntimeException ignored) {
            }
        }
        if (stopCapture && ScreenCaptureService.isCaptureActive()) {
            ScreenCaptureService.stopCapture(this, "page-navigation");
        }
        updateKeepScreenOn();
    }

    private void injectNativeBridge(String url) {
        if (!isTrustedTopLevelUrl(url)) {
            invalidateNativeBridge(true);
            return;
        }
        byte[] tokenBytes = new byte[32];
        secureRandom.nextBytes(tokenBytes);
        String token = Base64.encodeToString(tokenBytes,
                Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE);
        trustedBridgeToken = token;
        trustedTopLevelPage = true;

        String script = "(function(){'use strict';"
                + "const raw=window[" + JSONObject.quote(INTERNAL_BRIDGE_NAME) + "];"
                + "if(!raw){return;}"
                + "const token=" + JSONObject.quote(token) + ";"
                + "const api=Object.freeze({"
                + "version:" + NATIVE_BRIDGE_VERSION + ","
                + "isScreenCaptureSupported:function(){try{return !!raw.isScreenCaptureSupported(token);}catch(_){return false;}},"
                + "startScreenCapture:function(){try{return !!raw.startScreenCapture(token);}catch(_){return false;}},"
                + "stopScreenCapture:function(){try{return !!raw.stopScreenCapture(token);}catch(_){return false;}},"
                + "chooseFolder:function(){try{return !!raw.chooseFolder(token);}catch(_){return false;}},"
                + "enterPictureInPicture:function(){try{return !!raw.enterPictureInPicture(token);}catch(_){return false;}},"
                 + "openExternal:function(url){try{return !!raw.openExternal(token,String(url||''));}catch(_){return false;}},"
                 + "readClipboardText:function(){try{return String(raw.readClipboardText(token)||'');}catch(_){return '';}},"
                 + "isLocationPermissionGranted:function(){try{return !!raw.isLocationPermissionGranted(token);}catch(_){return false;}},"
                + "requestLocationPermission:function(){try{return !!raw.requestLocationPermission(token);}catch(_){return false;}},"
                + "setImmersiveMode:function(active){try{return !!raw.setImmersiveMode(token,!!active);}catch(_){return false;}}"
                + "});"
                + "try{Object.defineProperty(window," + JSONObject.quote(PUBLIC_BRIDGE_NAME)
                + ",{value:api,writable:false,enumerable:false,configurable:true});}"
                + "catch(_){window[" + JSONObject.quote(PUBLIC_BRIDGE_NAME) + "]=api;}"
                + "const platform=Object.freeze({version:1,runtime:\"android\",role:\"client\",serverApp:false,clientApp:true,"
                + "localServerMode:" + (localServerMode ? "true" : "false") + "});"
                + "try{Object.defineProperty(window,\"SyncWatchPlatform\","
                + "{value:platform,writable:false,enumerable:false,configurable:true});}"
                + "catch(_){window.SyncWatchPlatform=platform;}"
                + "const syncKeepAwake=function(){try{const active=Array.prototype.some.call("
                + "document.querySelectorAll('video,audio'),function(media){return !media.paused&&!media.ended;});"
                + "raw.setMediaPlaybackActive(token,active);}catch(_){void 0;}};"
                + "document.addEventListener('play',syncKeepAwake,true);"
                + "document.addEventListener('pause',syncKeepAwake,true);"
                + "document.addEventListener('ended',syncKeepAwake,true);"
                + "try{new MutationObserver(syncKeepAwake).observe(document.documentElement,"
                + "{childList:true,subtree:true});}catch(_){void 0;}"
                + "syncKeepAwake();"
                + "})();";
        webView.evaluateJavascript(script, ignored -> {
            if (!isValidBridgeToken(token)) return;
            if ("started".equals(nativeCaptureState)) {
                dispatchNativeCaptureState("started", nativeCaptureMessage);
            }
        });
    }

    private boolean isValidBridgeToken(String token) {
        if (!trustedTopLevelPage || token == null || token.isEmpty()) return false;
        String expected = trustedBridgeToken;
        if (expected.isEmpty()) return false;
        return MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.UTF_8),
                token.getBytes(StandardCharsets.UTF_8));
    }

    private boolean isNativeScreenCaptureSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
    }

    private void requestNativeScreenCapture() {
        if (!trustedTopLevelPage) return;
        if (!isNativeScreenCaptureSupported()) {
            dispatchNativeCaptureState("error", "手机系统版本过低，原生屏幕共享需要 Android 10 或更高版本");
            return;
        }
        if (projectionPermissionPending || continueProjectionAfterNotificationPermission) return;
        if (ScreenCaptureService.isCaptureActive()) {
            ScreenCaptureService.CaptureState state = ScreenCaptureService.getLatestState();
            updateNativeCaptureState(state);
            if ("started".equals(state.state)) {
                dispatchNativeCaptureState("started", state.message);
            }
            return;
        }
        cancelPendingProjection = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            continueProjectionAfterNotificationPermission = true;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATION);
            return;
        }
        launchProjectionPermission();
    }

    private void launchProjectionPermission() {
        if (!trustedTopLevelPage || cancelPendingProjection) return;
        MediaProjectionManager manager = (MediaProjectionManager)
                getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            dispatchNativeCaptureState("error", "系统屏幕捕获服务不可用");
            return;
        }
        try {
            projectionPermissionPending = true;
            startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_MEDIA_PROJECTION);
        } catch (RuntimeException error) {
            projectionPermissionPending = false;
            dispatchNativeCaptureState("error", safeErrorMessage(error, "无法打开系统屏幕共享授权界面"));
        }
    }

    private void stopNativeScreenCapture(String reason) {
        cancelPendingProjection = true;
        continueProjectionAfterNotificationPermission = false;
        if (ScreenCaptureService.isCaptureActive()) {
            ScreenCaptureService.stopCapture(this, reason);
        } else if (!projectionPermissionPending && trustedTopLevelPage) {
            dispatchNativeCaptureState("stopped", "屏幕共享已停止");
        }
    }

    private boolean hasLocationPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void requestLocationPermissionFromPage() {
        if (!trustedTopLevelPage) return;
        if (hasLocationPermission()) {
            allowCurrentServerGeolocation();
            dispatchNativeLocationPermission(true);
            return;
        }
        boolean requestedBefore = preferences.getBoolean(PREF_LOCATION_REQUESTED, false);
        boolean canExplain = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && (shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION)
                || shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_COARSE_LOCATION));
        if (requestedBefore && !canExplain) {
            new AlertDialog.Builder(this)
                    .setTitle("允许获取位置")
                    .setMessage("位置权限已被系统关闭。请在应用权限中允许位置访问，然后返回 SyncWatch同步观影。")
                    .setPositiveButton("打开权限设置", (dialog, which) -> openLocationSettings())
                    .setNegativeButton("取消", null)
                    .show();
            dispatchNativeLocationPermission(false);
            return;
        }
        preferences.edit().putBoolean(PREF_LOCATION_REQUESTED, true).apply();
        try {
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
            }, REQUEST_LOCATION);
        } catch (RuntimeException error) {
            dispatchNativeLocationPermission(false);
            toast("无法打开位置授权，请在系统设置中允许位置权限");
        }
    }

    private void openLocationSettings() {
        locationSettingsPending = true;
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (RuntimeException error) {
            locationSettingsPending = false;
            toast("无法打开应用权限设置");
        }
    }

    private void allowCurrentServerGeolocation() {
        if (serverOrigin == null || serverOrigin.isEmpty()) return;
        try {
            GeolocationPermissions.getInstance().allow(serverOrigin);
        } catch (RuntimeException ignored) {
        }
    }

    private void dispatchNativeLocationPermission(boolean granted) {
        if (!trustedTopLevelPage || webView == null) return;
        String script = "try{window.dispatchEvent(new CustomEvent('syncwatch-native-location-permission',"
                + "{detail:{granted:" + granted + "}}));}catch(_){void 0;}";
        try {
            webView.evaluateJavascript(script, null);
        } catch (RuntimeException ignored) {
        }
    }

    private final class NativeScreenBridge {
        @JavascriptInterface
        public boolean isScreenCaptureSupported(String token) {
            return isValidBridgeToken(token) && isNativeScreenCaptureSupported();
        }

        @JavascriptInterface
        public boolean startScreenCapture(String token) {
            if (!isValidBridgeToken(token)) return false;
            runOnUiThread(() -> {
                if (isValidBridgeToken(token)) requestNativeScreenCapture();
            });
            return true;
        }

        @JavascriptInterface
        public boolean stopScreenCapture(String token) {
            if (!isValidBridgeToken(token)) return false;
            runOnUiThread(() -> {
                if (isValidBridgeToken(token)) stopNativeScreenCapture("user");
            });
            return true;
        }

        @JavascriptInterface
        public boolean chooseFolder(String token) {
            if (!isValidBridgeToken(token)) return false;
            folderChooserRequestedAt = SystemClock.elapsedRealtime();
            return true;
        }

        @JavascriptInterface
        public boolean enterPictureInPicture(String token) {
            if (!isValidBridgeToken(token) || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
            if (Looper.myLooper() == Looper.getMainLooper()) return enterPictureInPictureNow(token);
            AtomicBoolean entered = new AtomicBoolean(false);
            CountDownLatch completed = new CountDownLatch(1);
            runOnUiThread(() -> {
                try {
                    entered.set(enterPictureInPictureNow(token));
                } finally { completed.countDown(); }
            });
            try {
                return completed.await(1500, TimeUnit.MILLISECONDS) && entered.get();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return false;
            }
        }

        private boolean enterPictureInPictureNow(String token) {
            if (!isValidBridgeToken(token) || Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                    || isFinishing() || isDestroyed()) return false;
            if (isInPictureInPictureMode()) return true;
            try {
                int width = webView == null ? 16 : Math.max(1, webView.getWidth());
                int height = webView == null ? 9 : Math.max(1, webView.getHeight());
                double ratio = (double) width / (double) height;
                Rational aspectRatio = ratio >= (1.0 / 2.39) && ratio <= 2.39
                        ? new Rational(width, height) : new Rational(16, 9);
                PictureInPictureParams params = new PictureInPictureParams.Builder()
                        .setAspectRatio(aspectRatio)
                        .build();
                return enterPictureInPictureMode(params);
            } catch (RuntimeException error) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean openExternal(String token, String value) {
            if (!isValidBridgeToken(token)) return false;
            Uri uri;
            try {
                uri = Uri.parse(value == null ? "" : value);
            } catch (RuntimeException error) {
                return false;
            }
            String scheme = lower(uri.getScheme());
            if (!("http".equals(scheme) || "https".equals(scheme)) || uri.getHost() == null) return false;
            runOnUiThread(() -> {
                if (!isValidBridgeToken(token)) return;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (RuntimeException error) {
                    toast("无法调用浏览器打开该地址");
                }
            });
            return true;
        }

        @JavascriptInterface
        public String readClipboardText(String token) {
            if (!isValidBridgeToken(token)) return "";
            try {
                ClipboardManager manager = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (manager == null || !manager.hasPrimaryClip()) return "";
                ClipData clip = manager.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) return "";
                CharSequence value = clip.getItemAt(0).coerceToText(MainActivity.this);
                return value == null ? "" : value.toString();
            } catch (RuntimeException error) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean isLocationPermissionGranted(String token) {
            return isValidBridgeToken(token) && hasLocationPermission();
        }

        @JavascriptInterface
        public boolean requestLocationPermission(String token) {
            if (!isValidBridgeToken(token)) return false;
            runOnUiThread(() -> {
                if (isValidBridgeToken(token)) requestLocationPermissionFromPage();
            });
            return true;
        }

        @JavascriptInterface
        public boolean setImmersiveMode(String token, boolean active) {
            if (!isValidBridgeToken(token)) return false;
            runOnUiThread(() -> {
                if (!isValidBridgeToken(token)) return;
                if (active) hideSystemUi(); else showSystemUi();
            });
            return true;
        }

        @JavascriptInterface
        public boolean setMediaPlaybackActive(String token, boolean active) {
            if (!isValidBridgeToken(token)) return false;
            runOnUiThread(() -> {
                if (!isValidBridgeToken(token)) return;
                mediaPlaybackActive = active;
                updateKeepScreenOn();
            });
            return true;
        }
    }

    @Override
    public void onNativeCaptureState(ScreenCaptureService.CaptureState state) {
        if (state == null) return;
        runOnUiThread(() -> {
            String previous = nativeCaptureState;
            updateNativeCaptureState(state);
            if ("started".equals(state.state)) {
                if (!"started".equals(previous)) {
                    dispatchNativeCaptureState("started", state.message);
                }
            } else if ("stopped".equals(state.state)) {
                if ("starting".equals(previous) || "started".equals(previous)) {
                    dispatchNativeCaptureState("stopped", state.message);
                }
            } else if ("error".equals(state.state)) {
                dispatchNativeCaptureState("error", state.message);
            }
        });
    }

    private void updateNativeCaptureState(ScreenCaptureService.CaptureState state) {
        nativeCaptureState = state.state;
        nativeCaptureSessionId = state.sessionId;
        nativeCaptureReason = state.reason;
        nativeCaptureMessage = state.message;
        nativeCaptureWidth = state.width;
        nativeCaptureHeight = state.height;
        nativeCaptureFps = state.fps;
    }

    @Override
    public void onNativeCaptureFrame(ScreenCaptureService.CaptureFrame frame) {
        if (frame == null) return;
        runOnUiThread(() -> dispatchNativeCaptureFrame(frame));
    }

    private void dispatchNativeCaptureState(String state, String message) {
        if (!trustedTopLevelPage || webView == null) return;
        String script = "try{if(typeof window.__syncWatchNativeCaptureState==='function'){"
                + "window.__syncWatchNativeCaptureState("
                + JSONObject.quote(state == null ? "error" : state) + ","
                + JSONObject.quote(message == null ? "" : message) + ");}}catch(_){void 0;}";
        try {
            webView.evaluateJavascript(script, null);
        } catch (RuntimeException ignored) {
        }
    }

    private void dispatchNativeCaptureFrame(ScreenCaptureService.CaptureFrame frame) {
        if (!trustedTopLevelPage || webView == null || nativeFrameEvaluationPending
                || !"started".equals(nativeCaptureState)
                || !frame.sessionId.equals(nativeCaptureSessionId)) return;
        nativeFrameEvaluationPending = true;
        String script = "try{if(typeof window.__syncWatchNativeCaptureFrame==='function'){"
                + "window.__syncWatchNativeCaptureFrame("
                + JSONObject.quote(frame.jpegBase64) + ","
                + frame.width + "," + frame.height + "," + frame.sequence
                + ");}}catch(_){void 0;}";
        try {
            webView.evaluateJavascript(script, ignored -> nativeFrameEvaluationPending = false);
        } catch (RuntimeException error) {
            nativeFrameEvaluationPending = false;
        }
    }

    private static String safeErrorMessage(Throwable error, String fallback) {
        String message = error == null ? "" : error.getMessage();
        if (message != null && message.matches(".*[\\u3400-\\u9FFF].*")) {
            return message.trim();
        }
        return fallback;
    }

    private void updateKeepScreenOn() {
        boolean keepAwake = activityResumed
                && connectionView != null
                && connectionView.getVisibility() != View.VISIBLE
                && (fullscreenView != null || mediaPlaybackActive);
        if (keepAwake) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    private boolean handleNavigation(Uri uri) {
        if (uri == null) return true;
        String scheme = lower(uri.getScheme());
        if (scheme.equals("about") || scheme.equals("blob") || scheme.equals("data")) return false;
        if (!scheme.equals("http") && !scheme.equals("https")) {
            toast("已阻止不安全的外部链接");
            return true;
        }
        if (uri.getUserInfo() != null) {
            toast("已阻止包含登录凭据的链接");
            return true;
        }
        if (isSameServer(uri)) return false;
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (Exception error) {
            toast("没有可打开此链接的浏览器");
        }
        return true;
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private static boolean sameDocumentUrl(String first, String second) {
        if (first == null || second == null || first.isEmpty() || second.isEmpty()) return false;
        try {
            return Uri.parse(first).buildUpon().fragment(null).build().toString().equals(
                    Uri.parse(second).buildUpon().fragment(null).build().toString());
        } catch (RuntimeException ignored) {
            return first.equals(second);
        }
    }

    private boolean isTopLevelSslFailure(WebView view, SslError error) {
        if (error == null || error.getUrl() == null || error.getUrl().isEmpty()) return false;
        String failedUrl = error.getUrl();
        if (sameDocumentUrl(failedUrl, activeTopLevelUrl)
                || sameDocumentUrl(failedUrl, lastRequestedUrl)) return true;
        try {
            return view != null && sameDocumentUrl(failedUrl, view.getUrl());
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private boolean recoverFromRendererTermination(WebView failedView, RenderProcessGoneDetail detail) {
        if (failedView == null || failedView != webView || destroyed) return false;
        boolean shouldReload = connectionView != null
                && connectionView.getVisibility() != View.VISIBLE
                && !serverOrigin.isEmpty();
        boolean wasLocalHostPage = localHostPageRequested;
        String recoveryUrl = lastRequestedUrl.isEmpty() ? serverOrigin + "/" : lastRequestedUrl;

        if (fullscreenView != null) {
            root.removeView(fullscreenView);
            fullscreenView = null;
            if (fullscreenCallback != null) {
                try {
                    fullscreenCallback.onCustomViewHidden();
                } catch (RuntimeException ignored) {
                }
            }
            fullscreenCallback = null;
            showSystemUi();
        }

        trustedTopLevelPage = false;
        trustedBridgeToken = "";
        nativeFrameEvaluationPending = false;
        mediaPlaybackActive = false;
        if (ScreenCaptureService.isCaptureActive()) {
            ScreenCaptureService.stopCapture(this, "renderer-terminated");
        }
        if (pendingFileCallback != null) {
            try {
                pendingFileCallback.onReceiveValue(null);
            } catch (RuntimeException ignored) {
            }
            pendingFileCallback = null;
        }
        if (pendingMicrophoneRequest != null) {
            try {
                pendingMicrophoneRequest.deny();
            } catch (RuntimeException ignored) {
            }
            pendingMicrophoneRequest = null;
        }
        if (pendingFolderResultCallback != null) {
            try {
                pendingFolderResultCallback.onReceiveValue(null);
            } catch (RuntimeException ignored) {
            }
            pendingFolderResultCallback = null;
        }

        root.removeView(failedView);
        webView = null;
        try {
            failedView.destroy();
        } catch (RuntimeException ignored) {
        }

        createWebView();
        root.addView(webView, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (shouldReload) {
            localHostPageRequested = wasLocalHostPage;
            activeTopLevelUrl = recoveryUrl;
            lastRequestedUrl = recoveryUrl;
            showPageLoading("页面组件已恢复，正在重新连接…");
            schedulePageLoadTimeout(recoveryUrl);
            webView.loadUrl(recoveryUrl);
        } else {
            showConnectionScreen("页面组件已自动恢复，请重新连接服务器");
        }
        updateKeepScreenOn();
        boolean rendererCrashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && detail != null && detail.didCrash();
        toast(rendererCrashed
                ? "网页组件异常退出，已自动恢复" : "网页组件已重新启动");
        return true;
    }

    private final class SafeWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleNavigation(request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNavigation(Uri.parse(url));
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            activeTopLevelUrl = url == null ? "" : url;
            if (lastRequestedUrl.isEmpty() || !sameDocumentUrl(lastRequestedUrl, activeTopLevelUrl)
                    || Uri.parse(lastRequestedUrl).getFragment() == null) {
                lastRequestedUrl = activeTopLevelUrl;
            }
            topLevelLoadFailed = false;
            invalidateNativeBridge(true);
            if (isSameServer(Uri.parse(activeTopLevelUrl))) {
                showPageLoading("正在载入服务器页面…");
                schedulePageLoadTimeout(activeTopLevelUrl);
            }
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            CookieManager.getInstance().flush();
            injectNativeBridge(url);
            revealLoadedPage(url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                topLevelLoadFailed = true;
                String description = error == null || error.getDescription() == null
                        ? "连接失败" : error.getDescription().toString();
                showConnectionScreen(localizeWebError(description));
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        WebResourceResponse errorResponse) {
            super.onReceivedHttpError(view, request, errorResponse);
            if (!request.isForMainFrame()) return;
            topLevelLoadFailed = true;
            int status = errorResponse == null ? 0 : errorResponse.getStatusCode();
            showConnectionScreen(status > 0
                    ? String.format(Locale.getDefault(), "服务器页面返回 HTTP %d，请检查服务器或公网转发配置", status)
                    : "服务器页面返回错误，请检查服务器或公网转发配置");
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (isTopLevelSslFailure(view, error)) {
                topLevelLoadFailed = true;
                showConnectionScreen("HTTPS 证书验证失败，连接已被安全拒绝");
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            return recoverFromRendererTermination(view, detail);
        }
    }

    private final class SyncWatchChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
            if (pendingFolderResultCallback != null) {
                callback.onReceiveValue(null);
                toast("文件夹仍在读取，请稍候");
                return true;
            }
            pendingFileCallback = callback;
            long folderRequestAge = SystemClock.elapsedRealtime() - folderChooserRequestedAt;
            boolean chooseFolder = folderChooserRequestedAt > 0
                    && folderRequestAge >= 0 && folderRequestAge <= FOLDER_CHOOSER_WINDOW_MS;
            folderChooserRequestedAt = 0;
            if (chooseFolder) {
                pendingFolderAcceptTypes = sanitizeMimeTypes(
                        params == null ? null : params.getAcceptTypes());
                Intent treeIntent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                treeIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                try {
                    startActivityForResult(Intent.createChooser(treeIntent, "选择视频文件夹"), REQUEST_FOLDER);
                    return true;
                } catch (Exception error) {
                    pendingFileCallback = null;
                    callback.onReceiveValue(null);
                    toast("无法打开系统文件夹选择器");
                    return false;
                }
            }
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            String[] accepted = sanitizeMimeTypes(params == null ? null : params.getAcceptTypes());
            List<String> pickerMimeTypes = new ArrayList<>();
            boolean containsExtensionRule = false;
            for (String acceptedType : accepted) {
                if (acceptedType.startsWith(".")) containsExtensionRule = true;
                else if (acceptedType.contains("/")) pickerMimeTypes.add(acceptedType);
            }
            if (containsExtensionRule || pickerMimeTypes.isEmpty()) {
                // Android picker extras only accept MIME values. Using */* keeps extension-only
                // formats such as SRT/ASS/MKV/DOCX selectable; the server still validates them.
                intent.setType("*/*");
            } else {
                intent.setType(pickerMimeTypes.size() == 1 ? pickerMimeTypes.get(0) : "*/*");
                if (pickerMimeTypes.size() > 1) {
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, pickerMimeTypes.toArray(new String[0]));
                }
            }
            try {
                startActivityForResult(Intent.createChooser(intent, "选择文件（可多选）"), REQUEST_FILES);
                return true;
            } catch (Exception error) {
                pendingFileCallback = null;
                callback.onReceiveValue(null);
                toast("无法打开系统文件选择器");
                return false;
            }
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(() -> handleWebPermission(request));
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            runOnUiThread(() -> {
                if (pendingMicrophoneRequest == request) pendingMicrophoneRequest = null;
            });
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            Uri uri;
            try {
                uri = Uri.parse(origin);
            } catch (RuntimeException error) {
                callback.invoke(origin, false, false);
                return;
            }
            if (!isSameServer(uri)) {
                callback.invoke(origin, false, false);
                return;
            }
            if (hasLocationPermission()) {
                callback.invoke(origin, true, false);
                return;
            }
            if (pendingLocationCallback != null) {
                try {
                    pendingLocationCallback.invoke(pendingLocationOrigin, false, false);
                } catch (RuntimeException ignored) {
                }
            }
            pendingLocationCallback = callback;
            pendingLocationOrigin = origin;
            preferences.edit().putBoolean(PREF_LOCATION_REQUESTED, true).apply();
            try {
                requestPermissions(new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                }, REQUEST_LOCATION);
            } catch (RuntimeException error) {
                pendingLocationCallback = null;
                pendingLocationOrigin = "";
                callback.invoke(origin, false, false);
                dispatchNativeLocationPermission(false);
            }
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullscreenView != null) {
                callback.onCustomViewHidden();
                return;
            }
            fullscreenView = view;
            fullscreenCallback = callback;
            view.setBackgroundColor(Color.BLACK);
            root.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            webView.setVisibility(View.INVISIBLE);
            connectionView.setVisibility(View.GONE);
            updateKeepScreenOn();
            hideSystemUi();
        }

        @Override
        public void onHideCustomView() {
            hideFullscreenView();
        }
    }

    private String[] sanitizeMimeTypes(String[] rawTypes) {
        Set<String> types = new LinkedHashSet<>();
        if (rawTypes != null) {
            for (String raw : rawTypes) {
                if (raw == null) continue;
                for (String part : raw.split(",")) {
                    String type = part.trim().toLowerCase(Locale.ROOT);
                    if (type.matches("\\.[a-z0-9]{1,16}")
                            || (type.contains("/") && !type.contains(";") && type.length() <= 100)) {
                        types.add(type);
                    }
                }
            }
        }
        if (types.isEmpty()) types.add("*/*");
        return types.toArray(new String[0]);
    }

    private void handleWebPermission(PermissionRequest request) {
        if (request == null || !isSameServer(request.getOrigin())) {
            if (request != null) request.deny();
            return;
        }
        boolean asksForMicrophone = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) asksForMicrophone = true;
        }
        if (!asksForMicrophone) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            return;
        }
        if (pendingMicrophoneRequest != null) pendingMicrophoneRequest.deny();
        pendingMicrophoneRequest = request;
        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MICROPHONE);
    }

    private final class SafeDownloadListener implements DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                    String mimeType, long contentLength) {
            Uri uri = Uri.parse(url);
            String scheme = lower(uri.getScheme());
            if ((!scheme.equals("http") && !scheme.equals("https")) || uri.getUserInfo() != null) {
                toast("已阻止不安全的下载地址");
                return;
            }
            PendingDownload download = new PendingDownload(url, userAgent, contentDisposition, mimeType);
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                    && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                pendingDownload = download;
                requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQUEST_DOWNLOAD_STORAGE);
                return;
            }
            enqueueDownload(download);
        }
    }

    private void enqueueDownload(PendingDownload download) {
        try {
            Uri uri = Uri.parse(download.url);
            String filename = URLUtil.guessFileName(download.url, download.contentDisposition, download.mimeType);
            DownloadManager.Request request = new DownloadManager.Request(uri);
            request.setTitle(filename);
            request.setDescription("SyncWatch同步观影 文件下载");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(false);
            if (download.mimeType != null && !download.mimeType.isEmpty()) request.setMimeType(download.mimeType);
            if (download.userAgent != null && !download.userAgent.isEmpty()) {
                request.addRequestHeader("User-Agent", download.userAgent);
            }
            if (isSameServer(uri)) {
                String cookies = CookieManager.getInstance().getCookie(download.url);
                if (cookies != null && !cookies.isEmpty()) request.addRequestHeader("Cookie", cookies);
                request.addRequestHeader("Referer", serverOrigin + "/");
            }
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) throw new IllegalStateException("系统下载服务不可用");
            manager.enqueue(request);
            toast("已加入系统下载队列");
        } catch (Exception error) {
            toast(safeErrorMessage(error, "下载失败，请检查存储权限和网络连接"));
        }
    }

    private static final class PendingDownload {
        final String url;
        final String userAgent;
        final String contentDisposition;
        final String mimeType;

        PendingDownload(String url, String userAgent, String contentDisposition, String mimeType) {
            this.url = url;
            this.userAgent = userAgent;
            this.contentDisposition = contentDisposition;
            this.mimeType = mimeType;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FOLDER) {
            ValueCallback<Uri[]> callback = pendingFileCallback;
            pendingFileCallback = null;
            if (callback == null) return;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                callback.onReceiveValue(null);
                return;
            }
            Uri treeUri = data.getData();
            int permissionFlags = data.getFlags();
            if ((permissionFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0) {
                try {
                    getContentResolver().takePersistableUriPermission(
                            treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (RuntimeException ignored) {
                }
            }
            pendingFolderResultCallback = callback;
            String[] accepted = pendingFolderAcceptTypes;
            pendingFolderAcceptTypes = new String[]{"*/*"};
            folderExecutor.execute(() -> {
                FolderScanResult result = scanFolderTree(treeUri, accepted);
                runOnUiThread(() -> finishFolderSelection(callback, result));
            });
            return;
        }
        if (requestCode == REQUEST_MEDIA_PROJECTION) {
            projectionPermissionPending = false;
            if (cancelPendingProjection || !trustedTopLevelPage) {
                cancelPendingProjection = false;
                return;
            }
            if (resultCode != RESULT_OK || data == null) {
                nativeCaptureState = "idle";
                dispatchNativeCaptureState("permission-denied", "未获得系统屏幕共享授权");
                return;
            }
            String sessionId = UUID.randomUUID().toString();
            nativeCaptureState = "starting";
            nativeCaptureSessionId = sessionId;
            nativeCaptureMessage = "正在启动屏幕共享";
            try {
                ScreenCaptureService.startCapture(this, resultCode, data, sessionId);
            } catch (RuntimeException error) {
                nativeCaptureState = "error";
                dispatchNativeCaptureState("error",
                        safeErrorMessage(error, "无法启动屏幕共享服务"));
            }
            return;
        }
        if (requestCode != REQUEST_FILES || pendingFileCallback == null) return;
        ValueCallback<Uri[]> callback = pendingFileCallback;
        pendingFileCallback = null;
        Uri[] selected = resultCode == RESULT_OK ? collectSelectedFiles(data) : null;
        clearFolderPathsThen(() -> callback.onReceiveValue(selected));
    }

    private FolderScanResult scanFolderTree(Uri treeUri, String[] acceptedTypes) {
        List<Uri> uris = new ArrayList<>();
        List<String> relativePaths = new ArrayList<>();
        boolean truncated = false;
        String error = "";
        try {
            String rootId = DocumentsContract.getTreeDocumentId(treeUri);
            String rootName = queryDocumentName(
                    DocumentsContract.buildDocumentUriUsingTree(treeUri, rootId));
            if (rootName.isEmpty()) rootName = deriveDocumentName(rootId);
            rootName = sanitizePathSegment(rootName);

            ArrayDeque<FolderNode> queue = new ArrayDeque<>();
            Set<String> visitedDirectories = new HashSet<>();
            queue.add(new FolderNode(rootId, rootName, 0));
            int directoryCount = 0;

            while (!queue.isEmpty() && uris.size() < FOLDER_MAX_FILES
                    && !Thread.currentThread().isInterrupted()) {
                FolderNode directory = queue.removeFirst();
                if (!visitedDirectories.add(directory.documentId)) continue;
                directoryCount += 1;
                if (directoryCount > FOLDER_MAX_DIRECTORIES) {
                    truncated = true;
                    break;
                }
                List<FolderEntry> children = queryFolderChildren(treeUri, directory.documentId);
                Collections.sort(children, (left, right) ->
                        left.displayName.compareToIgnoreCase(right.displayName));
                for (FolderEntry child : children) {
                    if (Thread.currentThread().isInterrupted()) break;
                    String path = directory.relativePath + "/"
                            + sanitizePathSegment(child.displayName);
                    if (child.directory) {
                        if (directory.depth >= FOLDER_MAX_DEPTH) {
                            truncated = true;
                            continue;
                        }
                        queue.addLast(new FolderNode(child.documentId, path, directory.depth + 1));
                    } else if (matchesAcceptedMimeType(
                            child.mimeType, child.displayName, acceptedTypes)) {
                        uris.add(DocumentsContract.buildDocumentUriUsingTree(treeUri, child.documentId));
                        relativePaths.add(path);
                        if (uris.size() >= FOLDER_MAX_FILES) {
                            truncated = true;
                            break;
                        }
                    }
                }
            }
        } catch (RuntimeException errorValue) {
            error = safeErrorMessage(errorValue, "无法读取所选文件夹");
        }
        return new FolderScanResult(uris, relativePaths, truncated, error);
    }

    private String queryDocumentName(Uri documentUri) {
        String[] projection = {DocumentsContract.Document.COLUMN_DISPLAY_NAME};
        try (Cursor cursor = getContentResolver().query(
                documentUri, projection, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                return name == null ? "" : name;
            }
        } catch (RuntimeException ignored) {
        }
        return "";
    }

    private List<FolderEntry> queryFolderChildren(Uri treeUri, String parentDocumentId) {
        List<FolderEntry> entries = new ArrayList<>();
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
                treeUri, parentDocumentId);
        String[] projection = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE
        };
        try (Cursor cursor = getContentResolver().query(
                childrenUri, projection, null, null, null)) {
            if (cursor == null) return entries;
            while (cursor.moveToNext()) {
                String documentId = cursor.getString(0);
                String displayName = cursor.getString(1);
                String mimeType = cursor.getString(2);
                if (documentId == null || documentId.isEmpty()) continue;
                entries.add(new FolderEntry(
                        documentId,
                        displayName == null || displayName.isEmpty() ? "未命名" : displayName,
                        mimeType == null ? "application/octet-stream" : mimeType,
                        DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType)));
            }
        }
        return entries;
    }

    private static boolean matchesAcceptedMimeType(String mimeType, String displayName,
                                                    String[] acceptedTypes) {
        String filename = displayName == null ? "" : displayName.toLowerCase(Locale.ROOT);
        int extensionIndex = filename.lastIndexOf('.');
        String filenameExtension = extensionIndex >= 0 ? filename.substring(extensionIndex) : "";
        String actual = mimeType == null ? "application/octet-stream" : mimeType.toLowerCase(Locale.ROOT);
        if ("application/octet-stream".equals(actual)) {
            String extension = MimeTypeMap.getFileExtensionFromUrl(
                    Uri.encode(displayName == null ? "" : displayName));
            String inferred = MimeTypeMap.getSingleton().getMimeTypeFromExtension(
                    extension == null ? "" : extension.toLowerCase(Locale.ROOT));
            if (inferred != null && !inferred.isEmpty()) actual = inferred.toLowerCase(Locale.ROOT);
        }
        if (acceptedTypes == null || acceptedTypes.length == 0) return true;
        for (String acceptedValue : acceptedTypes) {
            String accepted = acceptedValue == null ? "" : acceptedValue.trim().toLowerCase(Locale.ROOT);
            if (accepted.isEmpty() || "*/*".equals(accepted)) return true;
            if (accepted.startsWith(".")) {
                if (accepted.equals(filenameExtension)) return true;
            } else if (accepted.endsWith("/*")) {
                String prefix = accepted.substring(0, accepted.length() - 1);
                if (actual.startsWith(prefix)) return true;
            } else if (accepted.equals(actual)) {
                return true;
            }
        }
        return false;
    }

    private static String deriveDocumentName(String documentId) {
        if (documentId == null || documentId.isEmpty()) return "已选文件夹";
        int slash = Math.max(documentId.lastIndexOf('/'), documentId.lastIndexOf(':'));
        String value = slash >= 0 && slash + 1 < documentId.length()
                ? documentId.substring(slash + 1) : documentId;
        return value.isEmpty() ? "已选文件夹" : value;
    }

    private static String sanitizePathSegment(String segment) {
        String value = segment == null ? "" : segment.trim();
        value = value.replace('/', '_').replace('\\', '_');
        StringBuilder cleaned = new StringBuilder(Math.min(value.length(), 200));
        for (int index = 0; index < value.length() && cleaned.length() < 200; index++) {
            char character = value.charAt(index);
            if (character >= 32 && character != 127) cleaned.append(character);
        }
        String result = cleaned.toString().trim();
        if (result.isEmpty() || ".".equals(result) || "..".equals(result)) return "未命名";
        return result;
    }

    private void finishFolderSelection(ValueCallback<Uri[]> callback, FolderScanResult result) {
        if (pendingFolderResultCallback != callback) {
            return;
        }
        pendingFolderResultCallback = null;
        if (destroyed || webView == null || !trustedTopLevelPage) {
            callback.onReceiveValue(null);
            return;
        }
        if (!result.error.isEmpty()) {
            callback.onReceiveValue(null);
            toast("读取文件夹失败：" + result.error);
            return;
        }
        if (result.uris.isEmpty()) {
            callback.onReceiveValue(null);
            toast("所选文件夹中没有符合类型的文件");
            return;
        }
        JSONArray paths = new JSONArray();
        for (String path : result.relativePaths) paths.put(path);
        String script = "window.__syncWatchNativeFolderPaths=" + paths + ";";
        Uri[] selected = result.uris.toArray(new Uri[0]);
        try {
            webView.evaluateJavascript(script, ignored -> {
                callback.onReceiveValue(selected);
                if (result.truncated) {
                    toast("文件夹内容过多，已安全限制为前 " + FOLDER_MAX_FILES + " 个文件");
                }
            });
        } catch (RuntimeException error) {
            callback.onReceiveValue(null);
        }
    }

    private void clearFolderPathsThen(Runnable continuation) {
        if (webView == null || !trustedTopLevelPage) {
            continuation.run();
            return;
        }
        try {
            webView.evaluateJavascript("window.__syncWatchNativeFolderPaths=null;",
                    ignored -> continuation.run());
        } catch (RuntimeException error) {
            continuation.run();
        }
    }

    private static final class FolderNode {
        final String documentId;
        final String relativePath;
        final int depth;

        FolderNode(String documentId, String relativePath, int depth) {
            this.documentId = documentId;
            this.relativePath = relativePath;
            this.depth = depth;
        }
    }

    private static final class FolderEntry {
        final String documentId;
        final String displayName;
        final String mimeType;
        final boolean directory;

        FolderEntry(String documentId, String displayName, String mimeType, boolean directory) {
            this.documentId = documentId;
            this.displayName = displayName;
            this.mimeType = mimeType;
            this.directory = directory;
        }
    }

    private static final class FolderScanResult {
        final List<Uri> uris;
        final List<String> relativePaths;
        final boolean truncated;
        final String error;

        FolderScanResult(List<Uri> uris, List<String> relativePaths,
                         boolean truncated, String error) {
            this.uris = uris;
            this.relativePaths = relativePaths;
            this.truncated = truncated;
            this.error = error == null ? "" : error;
        }
    }

    private Uri[] collectSelectedFiles(Intent data) {
        if (data == null) return null;
        List<Uri> selected = new ArrayList<>();
        ClipData clipData = data.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index++) {
                Uri uri = clipData.getItemAt(index).getUri();
                if (uri != null) selected.add(uri);
            }
        } else if (data.getData() != null) {
            selected.add(data.getData());
        }
        if (selected.isEmpty()) return null;
        int flags = data.getFlags();
        for (Uri uri : selected) {
            if ((flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0) {
                try {
                    getContentResolver().takePersistableUriPermission(
                            uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception ignored) {
                }
            }
        }
        return selected.toArray(new Uri[0]);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQUEST_MICROPHONE) {
            PermissionRequest request = pendingMicrophoneRequest;
            pendingMicrophoneRequest = null;
            if (request != null) {
                if (granted && isSameServer(request.getOrigin())) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    request.deny();
                    toast("没有麦克风权限，无法直接录音");
                }
            }
        } else if (requestCode == REQUEST_DOWNLOAD_STORAGE) {
            PendingDownload download = pendingDownload;
            pendingDownload = null;
            if (granted && download != null) enqueueDownload(download);
            else if (download != null) toast("没有存储权限，无法保存下载文件");
        } else if (requestCode == REQUEST_NOTIFICATION) {
            boolean shouldContinue = continueProjectionAfterNotificationPermission;
            continueProjectionAfterNotificationPermission = false;
            if (shouldContinue && !cancelPendingProjection && trustedTopLevelPage) {
                launchProjectionPermission();
            }
        } else if (requestCode == REQUEST_SERVER_NOTIFICATION) {
            if (!granted) {
                toast("通知权限未开启；服务器仍会启动，可在系统设置中开启通知和停止按钮");
            }
            startMobileServer();
        } else if (requestCode == REQUEST_LOCATION) {
            GeolocationPermissions.Callback callback = pendingLocationCallback;
            String origin = pendingLocationOrigin;
            pendingLocationCallback = null;
            pendingLocationOrigin = "";
            boolean locationGranted = hasLocationPermission();
            if (locationGranted) allowCurrentServerGeolocation();
            if (callback != null) callback.invoke(origin, locationGranted, false);
            dispatchNativeLocationPermission(locationGranted);
        }
    }

    private void hideFullscreenView() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        if (webView != null) webView.setVisibility(View.VISIBLE);
        showSystemUi();
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
        updateKeepScreenOn();
    }

    private void hideSystemUi() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            }
            root.requestApplyInsets();
            return;
        }
        //noinspection deprecation
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private void showSystemUi() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.show(WindowInsets.Type.systemBars());
                controller.setSystemBarsAppearance(0,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            }
            if (root != null) root.requestApplyInsets();
            return;
        }
        //noinspection deprecation
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && fullscreenView != null) hideSystemUi();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openLocalServerFromIntent(intent);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (fullscreenView != null) {
            hideFullscreenView();
        } else if (connectionView.getVisibility() == View.VISIBLE) {
            super.onBackPressed();
        } else if (webView.canGoBack()) {
            webView.goBack();
        } else {
            new AlertDialog.Builder(this)
                    .setTitle("SyncWatch同步观影")
                    .setMessage("要退出应用，还是更换服务器？")
                    .setPositiveButton("退出", (dialog, which) -> finish())
                    .setNeutralButton("更换服务器", (dialog, which) -> {
                        webView.stopLoading();
                        setLocalServerMode(false);
                        localHostPageRequested = false;
                        serverInput.setText(serverOrigin);
                        showConnectionScreen("");
                    })
                    .setNegativeButton("取消", null)
                    .show();
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        registerMobileServerReceiver();
        MobileServerService.Snapshot snapshot = MobileServerService.getSnapshot(this);
        updateMobileServerUi(snapshot);
        if (localServerMode) {
            if (snapshot.isRunning()) {
                refreshMobileServerState(true);
            } else if (MobileServerService.STATUS_STOPPED.equals(snapshot.status)) {
                startMobileServer();
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        activityResumed = true;
        if (webView != null) webView.onResume();
        if (locationSettingsPending) {
            locationSettingsPending = false;
            boolean granted = hasLocationPermission();
            if (granted) allowCurrentServerGeolocation();
            dispatchNativeLocationPermission(granted);
        }
        updateKeepScreenOn();
    }

    @Override
    protected void onPause() {
        activityResumed = false;
        updateKeepScreenOn();
        if (webView != null) webView.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onStop() {
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        cancelPageLoadTimeout();
        activityResumed = false;
        unregisterMobileServerReceiver();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        cancelPendingProjection = true;
        continueProjectionAfterNotificationPermission = false;
        invalidateNativeBridge(false);
        ScreenCaptureService.clearListener(this);
        if (!isChangingConfigurations() && ScreenCaptureService.isCaptureActive()) {
            ScreenCaptureService.stopCapture(this, "activity-destroyed");
        }
        if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
        pendingFileCallback = null;
        if (pendingFolderResultCallback != null) pendingFolderResultCallback.onReceiveValue(null);
        pendingFolderResultCallback = null;
        folderExecutor.shutdownNow();
        if (pendingMicrophoneRequest != null) pendingMicrophoneRequest.deny();
        pendingMicrophoneRequest = null;
        if (pendingLocationCallback != null) pendingLocationCallback.invoke(pendingLocationOrigin, false, false);
        pendingLocationCallback = null;
        pendingLocationOrigin = "";
        if (webView != null) {
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
