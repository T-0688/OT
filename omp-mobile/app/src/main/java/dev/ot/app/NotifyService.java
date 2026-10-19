package dev.ot.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONObject;

/**
 * 后台通知服务：原生 WebSocket 长连接 + 心跳 + 重连，
 * 收到 notify 就发系统通知。不依赖 WebView / JS。
 */
public class NotifyService extends Service {
    private static final String CHANNEL_TASK = "ot_tasks";
    private static final String CHANNEL_FG = "ot_keepalive";
    private static final int FG_ID = 1001;

    public static volatile boolean RUNNING = false;
    public static volatile String STATE = "idle";
    private volatile boolean running;
    private volatile OtWsClient client;
    private volatile long lastSeen = System.currentTimeMillis();
    private PowerManager.WakeLock lock;
    private ConnectivityManager.NetworkCallback networkCallback;

    private final OtWsClient.Listener listener = new OtWsClient.Listener() {
        @Override
        public void onOpen() {
            lastSeen = System.currentTimeMillis();
        }

        @Override
        public void onText(String text) {
            lastSeen = System.currentTimeMillis();
            if (text.contains("\"t\":\"notify\"")) {
                try {
                    JSONObject obj = new JSONObject(text);
                    String title = obj.optString("title", "OT");
                    String body = obj.optString("body", "当前任务完成");
                    notifyTask(title, body);
                } catch (Exception ignored) {
                }
            }
        }

        @Override
        public void onClosed(String reason) {
            /* 由循环负责重连 */
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannels();
        startForeground(FG_ID, foregroundNotification());

        if (lock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OT:notify");
                lock.setReferenceCounted(false);
                lock.acquire();
            }
        }
        if (!running) {
            running = true;
            RUNNING = true;
            watchNetwork();
            new Thread(this::connectLoop, "ot-ws-loop").start();
            new Thread(this::heartbeatLoop, "ot-ws-heartbeat").start();
        }
        return START_STICKY;
    }

    private void setState(String state) {
        STATE = state;
        try {
            getSharedPreferences("omp", MODE_PRIVATE).edit().putString("svc_state", state).apply();
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(FG_ID, foregroundNotification());
        } catch (Exception ignored) {
        }
    }

    private String wsUrl() {
        SharedPreferences prefs = getSharedPreferences("omp", MODE_PRIVATE);
        String host = prefs.getString("ws_host", "");
        String token = prefs.getString("ws_token", "");
        String proto = prefs.getString("ws_proto", "wss");
        if (host == null || host.isEmpty()) return null;
        return proto + "://" + host + "/ws?token=" + token;
    }

    private void connectLoop() {
        long backoff = 800;
        int failures = 0;
        while (running) {
            String url = wsUrl();
            if (url == null) {
                sleep(2000);
                continue;
            }
            try {
                setState("连接中");
                OtWsClient c = OtWsClient.connect(url, listener);
                client = c;
                lastSeen = System.currentTimeMillis();
                listener.onOpen();
                setState("已连接");
                backoff = 800;
                failures = 0;
                while (running && !c.isClosed()) {
                    sleep(1000);
                }
            } catch (Exception ignored) {
                failures++;
                setState("连接失败");
                if (failures == 3) {
                    notifyTask("OT", "后台连接失败，请打开一次 OT 检查网络");
                }
            } finally {
                OtWsClient c = client;
                client = null;
                if (c != null) {
                    try {
                        c.close();
                    } catch (Exception ignored) {
                    }
                }
            }
            if (!running) break;
            sleep(backoff);
            backoff = Math.min(8000, (long) (backoff * 1.6));
        }
    }

    private void heartbeatLoop() {
        while (running) {
            sleep(10000);
            if (!running) break;
            OtWsClient c = client;
            if (c != null && !c.isClosed()) {
                c.ping();
                if (System.currentTimeMillis() - lastSeen > 35000) {
                    try {
                        c.close();
                    } catch (Exception ignored) {
                    }
                }
            }
        }
    }

    private void watchNetwork() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return;
            if (networkCallback != null) return;
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    OtWsClient c = client;
                    if (c != null) {
                        try {
                            c.close();
                        } catch (Exception ignored) {
                        }
                    }
                }
            };
            cm.registerDefaultNetworkCallback(networkCallback);
        } catch (Exception ignored) {
        }
    }

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_FG) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_FG, "保持连接", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("OT 在后台保持与电脑的连接");
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CHANNEL_TASK) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_TASK, "任务完成", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("OT 任务完成提醒");
            nm.createNotificationChannel(ch);
        }
    }

    private PendingIntent openIntent() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification foregroundNotification() {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_FG)
                : new Notification.Builder(this);
        return b.setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("OT")
                .setContentText("后台：" + STATE)
                .setContentIntent(openIntent())
                .setOngoing(true)
                .build();
    }

    private void notifyTask(String title, String body) {
        try {
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_TASK)
                    : new Notification.Builder(this);
            b.setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(title == null || title.isEmpty() ? "OT" : title)
                    .setContentText(body == null || body.isEmpty() ? "当前任务完成" : body)
                    .setAutoCancel(true)
                    .setContentIntent(openIntent())
                    .setDefaults(Notification.DEFAULT_ALL);
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        RUNNING = false;
        OtWsClient c = client;
        client = null;
        if (c != null) {
            try {
                c.close();
            } catch (Exception ignored) {
            }
        }
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm != null && networkCallback != null) cm.unregisterNetworkCallback(networkCallback);
        } catch (Exception ignored) {
        }
        if (lock != null && lock.isHeld()) lock.release();
        super.onDestroy();
    }
}



