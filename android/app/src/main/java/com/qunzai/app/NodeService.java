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
 *
 * 启动流程（每一步都写进 qz-status.json，界面据此显示进度或错误）：
 *   1. 预检存储空间
 *   2. 解压群崽程序（server/ + public/）
 *   3. 按 ABI 解压内置 Node 运行时（约 100MB，真机首次要几秒到几十秒）
 *   4. node 自检（跑一次 node -p）
 *   5. 拉起群崽服务端进程
 */
public class NodeService extends Service {

    private static final String CHANNEL_ID = "qunzai_service";
    private static final int NOTIF_ID = 1001;
    private static final String TAG = "QunZai";

    /** 运行时解压大约需要 100MB 空间，留 200MB 余量。 */
    private static final long SPACE_REQUIRED = 220L * 1024 * 1024;

    private Process proc;
    private volatile boolean booting = false;
    private volatile boolean booted = false;

    /** 由 onStartCommand 的 Intent 带来的强制 ABI（"arm64" / "x86_64"）。 */
    private volatile String forcedAbiValue = null;

    public static void start(Context ctx) {
        start(ctx, null);
    }

    /**
     * @param forcedAbi 强制使用某个 ABI 的运行时（"arm64" / "x86_64"）。
     *                   正常传 null，按设备自动选。
     */
    public static void start(Context ctx, String forcedAbi) {
        Intent i = new Intent(ctx, NodeService.class);
        if (forcedAbi != null && !forcedAbi.isEmpty()) {
            i.putExtra("qz_abi", forcedAbi);
        }
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
        // Service 没有 getIntent()，强制 ABI 只能从 onStartCommand 的参数里取。
        if (intent != null) {
            try {
                forcedAbiValue = intent.getStringExtra("qz_abi");
            } catch (Exception ignored) { }
        }
        if (proc == null && !booting) {
            booting = true;
            startServer();
        }
        return START_STICKY;
    }

    private void startServer() {
        new Thread(() -> {
            try {
                // 1. 空间预检：不够就别解压了，直接告诉用户差多少
                NodeHost.writeStatus(this, "space", "正在检查存储空间…", 0, 0, null);
                NodeHost.requireFreeSpace(this, SPACE_REQUIRED);

                // 2. 解压群崽程序（server/ + public/），幂等
                NodeHost.writeStatus(this, "extract-app", "正在准备群崽程序…", 0, 0, null);
                NodeHost.extractAssets(this, "qz-app", NodeHost.appRoot(this),
                        (done, total, name) ->
                                NodeHost.writeStatus(this, "extract-app",
                                        "正在准备群崽程序 " + done + "/" + total, done, total, null));

                // 3. 解压内置 Node 运行时，按设备 ABI 选一份
                String abi = NodeHost.abi(forcedAbi());
                Log.i(TAG, "runtime abi: " + abi);
                NodeHost.writeStatus(this, "extract-rt",
                        "正在解压内置运行时（" + abi + "，约 100MB，请勿退出）", 0, 0, null);
                final String abiFinal = abi;
                NodeHost.extractAssets(this, "qz-rt/" + abi, NodeHost.runtimeDir(this),
                        (done, total, name) ->
                                NodeHost.writeStatus(this, "extract-rt",
                                        "正在解压内置运行时 " + done + "/" + total + "：" + name,
                                        done, total, null));
                Log.i(TAG, "runtime extracted for " + abiFinal);

                // 4 + 5. 自检并拉起服务端
                proc = NodeHost.startServer(this, line -> {
                    Log.i(TAG, line);
                    if (line.contains("网页版 QQ 助手已启动") || line.contains("地址：")
                            || line.contains("群崽")) {
                        booted = true;
                        updateNotification("群崽已启动");
                    }
                });
                NodeHost.writeStatus(this, "running", "群崽服务运行中", 0, 0, null);
            } catch (Throwable t) {
                Log.e(TAG, "启动失败", t);
                String msg = t.getMessage();
                if (msg == null || msg.isEmpty()) {
                    msg = t.getClass().getSimpleName();
                }
                booting = false;
                NodeHost.writeStatus(this, "error", "启动失败", 0, 0, msg);
                updateNotification("启动失败：" + msg);
            }
        }).start();
    }

    /**
     * 允许通过 Intent extra 指定 ABI（"qz_abi"）。
     * 用途：在 x86_64 模拟器上强制走 arm64 分支，把真机专属路径也测一遍。
     * 值由 onStartCommand 写入。
     */
    private String forcedAbi() {
        return forcedAbiValue;
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
            try {
                nm.notify(NOTIF_ID, buildNotification(text));
            } catch (Exception ignored) { }
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
