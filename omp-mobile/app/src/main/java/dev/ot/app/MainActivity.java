package dev.ot.app;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.JavascriptInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final String DEFAULT_URL =
            "https://omp.t-kepler.cc.cd/?token=50628324ae47c2c19567d9a8";
    private static final String PREFS = "omp";
    private static final String KEY_URL = "url";

    private static final int REQ_FILE = 1001;
    private static final int REQ_NOTIF = 1002;
    private static final String CHANNEL = "ot_tasks";
    private ValueCallback<Uri[]> fileCallback;
    private WebView web;
    private View splash;
    private LinearLayout setup;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ensureChannel();
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String saved = prefs.getString(KEY_URL, null);
        String fromIntent = urlFromIntent(getIntent());
        if (fromIntent != null) {
            prefs.edit().putString(KEY_URL, fromIntent).apply();
            saved = fromIntent;
        }
        if (saved == null || saved.isEmpty()) {
            prefs.edit().putString(KEY_URL, DEFAULT_URL).apply();
            load(DEFAULT_URL);
        } else {
            load(saved);
        }
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        String url = urlFromIntent(intent);
        if (url != null) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, url).apply();
            load(url);
        }
    }

    private String urlFromIntent(android.content.Intent intent) {
        if (intent == null || intent.getData() == null) return null;
        Uri data = intent.getData();
        if (!"omp".equals(data.getScheme())) return null;
        String url = data.getQueryParameter("url");
        if (url == null) return null;
        return url.startsWith("http") ? url : "https://" + url;
    }

    private void load(String url) {
        if (setup != null) {
            setContentView(web);
            setup = null;
        }
        if (web == null) {
            web = new WebView(this);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setUseWideViewPort(true);
            s.setLoadWithOverviewMode(true);
            s.setMediaPlaybackRequiresUserGesture(false);
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            s.setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
            web.setBackgroundColor(Color.parseColor("#151517"));
            web.addJavascriptInterface(new NotifyBridge(), "OTNotify");
            web.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String loadedUrl) {
                    hideSplash();
                }

                @Override
                public void onReceivedError(WebView view, android.webkit.WebResourceRequest request,
                                            android.webkit.WebResourceError error) {
                    if (request != null && request.isForMainFrame()) {
                        showSetup("连不上\n" + view.getUrl() + "\n\n确认电脑端 OMP Desktop 正在运行");
                    }
                }
            });
            web.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                                FileChooserParams params) {
                    if (fileCallback != null) fileCallback.onReceiveValue(null);
                    fileCallback = callback;
                    try {
                        startActivityForResult(params.createIntent(), REQ_FILE);
                        return true;
                    } catch (Exception e) {
                        fileCallback = null;
                        return false;
                    }
                }
            });
            android.widget.FrameLayout root = new android.widget.FrameLayout(this);
            root.setBackgroundColor(Color.parseColor("#151517"));
            root.addView(web, new android.widget.FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            root.addView(buildSplash(), new android.widget.FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            setContentView(root);
        }
        web.loadUrl(shellUrl(url));
    }

    /** http(s) 地址转成本地壳 + token/host 参数，秒开 */
    private String shellUrl(String remote) {
        try {
            Uri uri = Uri.parse(remote);
            String host = uri.getHost();
            String token = uri.getQueryParameter("token");
            if (host == null) return remote;
            return "file:///android_asset/index.html?host=" + Uri.encode(host)
                    + (token != null ? "&token=" + Uri.encode(token) : "");
        } catch (Exception e) {
            return remote;
        }
    }

    private View buildSplash() {
        float d = getResources().getDisplayMetrics().density;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#151517"));

        TextView logo = new TextView(this);
        logo.setText("OMP");
        logo.setTextColor(Color.parseColor("#7c5cff"));
        logo.setTextSize(34);
        logo.setGravity(Gravity.CENTER);
        box.addView(logo);

        android.widget.ProgressBar bar = new android.widget.ProgressBar(this);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                (int) (28 * d), (int) (28 * d));
        lp.topMargin = (int) (20 * d);
        box.addView(bar, lp);

        TextView hint = new TextView(this);
        hint.setText("正在连接电脑…");
        hint.setTextColor(Color.parseColor("#979da6"));
        hint.setTextSize(13);
        hint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp2.topMargin = (int) (14 * d);
        box.addView(hint, lp2);

        this.splash = box;
        return box;
    }

    private void hideSplash() {
        if (splash == null) return;
        final View target = splash;
        splash = null;
        target.animate().alpha(0f).setDuration(180).withEndAction(new Runnable() {
            @Override
            public void run() {
                target.setVisibility(View.GONE);
            }
        }).start();
    }

    private void showSetup(String error) {
        float d = getResources().getDisplayMetrics().density;
        setup = new LinearLayout(this);
        setup.setOrientation(LinearLayout.VERTICAL);
        setup.setGravity(Gravity.CENTER_VERTICAL);
        setup.setBackgroundColor(Color.parseColor("#151517"));
        int pad = (int) (22 * d);
        setup.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("OMP Desktop");
        title.setTextColor(Color.parseColor("#f9fafb"));
        title.setTextSize(24);
        setup.addView(title);

        TextView hint = new TextView(this);
        hint.setText("粘贴电脑上「设置 → 手机访问」里的公网地址（含 ?token=）");
        hint.setTextColor(Color.parseColor("#979da6"));
        hint.setTextSize(13);
        hint.setPadding(0, (int) (8 * d), 0, (int) (16 * d));
        setup.addView(hint);

        EditText input = new EditText(this);
        input.setHint("https://xxx.trycloudflare.com/?token=…");
        input.setHintTextColor(Color.parseColor("#61666b"));
        input.setTextColor(Color.parseColor("#f9fafb"));
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(false);
        setup.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button go = new Button(this);
        go.setText("连接");
        go.setOnClickListener(v -> {
            String url = input.getText().toString().trim();
            if (url.isEmpty()) return;
            if (!url.startsWith("http")) url = "https://" + url;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, url).apply();
            load(url);
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = (int) (14 * d);
        setup.addView(go, lp);

        if (error != null) {
            TextView err = new TextView(this);
            err.setText(error);
            err.setTextColor(Color.parseColor("#f25a5a"));
            err.setTextSize(12);
            setup.addView(err);
        }

        setContentView(setup);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[] { data.getData() };
                }
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(results);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    public class NotifyBridge {
        @JavascriptInterface
        public void setTarget(String host, String token, String proto) {
            String p = proto == null ? "wss" : proto.replace(":", "").replace("/", "");
            if (!p.equals("ws") && !p.equals("wss")) p = "wss";
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString("ws_host", host == null ? "" : host)
                    .putString("ws_token", token == null ? "" : token)
                    .putString("ws_proto", p)
                    .apply();
        }

        @JavascriptInterface
        public boolean serviceRunning() {
            return NotifyService.RUNNING;
        }

        @JavascriptInterface
        public boolean canNotify() {
            if (Build.VERSION.SDK_INT >= 33) {
                return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
            }
            return true;
        }

        @JavascriptInterface
        public void post(String title, String body) {
            notifyTask(title, body);
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "任务完成", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("OT 任务完成提醒");
                nm.createNotificationChannel(ch);
            }
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }

    private void notifyTask(String title, String body) {
        try {
            ensureChannel();
            Intent intent = new Intent(this, MainActivity.class);
            intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(this, 0, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL)
                    : new Notification.Builder(this);
            b.setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(title == null || title.isEmpty() ? "OT" : title)
                    .setContentText(body == null || body.isEmpty() ? "任务完成" : body)
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .setDefaults(Notification.DEFAULT_ALL);
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
        } catch (Exception ignored) {
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        try {
            Intent svc = new Intent(this, NotifyService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc);
            else startService(svc);
        } catch (Exception ignored) {
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        try {
            stopService(new Intent(this, NotifyService.class));
        } catch (Exception ignored) {
        }
        if (web != null) {
            web.evaluateJavascript("window.__otResume && window.__otResume()", null);
        }
    }}





