package com.qunzai.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * 前台服务：托管群崽服务端进程。
 *
 * 为什么必须前台服务
 *   Android 8 以后，后台进程随时可能被系统回收，服务端一死面板就断线。
 *   前台服务 + 常驻通知是唯一能保证「群崽一直在跑」的方式。
 */
public class NodeService extends Service {

    private static final String CHANNEL_ID = "qunzai_service";
    private static final int NOTIF_ID = 1001;
    private static final String TAG = "QunZai";

    private Process proc;
    private Thread logPump;

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, NodeService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(NOTIF_ID, buildNotification("正在启动群崽…"));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (proc == null) {
            startServer();
        }
        return START_STICKY;
    }

    private void startServer() {
        new Thread(() -> {
            try {
                // 首次启动才解压资源（幂等：已存在则跳过）
                NodeHost.extractAssets(this, "qz-app", NodeHost.appRoot(this));
                // 运行时按设备 ABI 选一份，摊平解压到同一个目录
                String abi = NodeHost.abi();
                NodeHost.extractAssets(this, "qz-rt/" + abi, NodeHost.runtimeDir(this));
                Log.i(TAG, "runtime abi: " + abi);

                proc = NodeHost.startServer(this, line -> {
                    Log.i(TAG, line);
                    if (line.contains("网页版 QQ 助手已启动") || line.contains("地址：")) {
                        updateNotification("群崽已启动");
                    }
                });
            } catch (Throwable t) {
                Log.e(TAG, "启动失败", t);
                updateNotification("启动失败：" + t.getMessage());
            }
        }).start();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "群崽服务", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("保持群崽 AI 助手在后台运行");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        return b.setContentTitle("群崽 QunZai")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_send)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            nm.notify(NOTIF_ID, buildNotification(text));
        }
    }

    @Override
    public void onDestroy() {
        if (proc != null) {
            try { proc.destroy(); } catch (Exception ignored) { }
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
