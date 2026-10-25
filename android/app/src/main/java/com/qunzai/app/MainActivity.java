package com.qunzai.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

/**
 * 群崽 QunZai · 安卓版主界面
 *
 * 架构：
 *   NodeService      —— 前台服务，托管内置 Node 运行时拉起的群崽服务端进程
 *   NodeHost (WebView)—— 承载群崽的网页面板（public/），与服务端同源
 *
 * 这里的 WebView 只做「显示」，所有业务逻辑都在内置 Node 服务端里，
 * 所以面板行为和 Windows 版完全一致，不做两套 UI。
 *
 * 启动时序：
 *   1. 拉起 NodeService（解压运行时 + 拉起服务端，过程写进 qz-status.json）
 *   2. 本界面轮询 runtime.json 拿端口，并要求 HTTP 200 才算就绪
 *   3. 就绪后加载面板；期间把解压进度显示在顶部状态条上
 *
 * 真机上首次启动要解压近 100MB 运行时，耗时可达几十秒，
 * 所以等待上限放到 5 分钟，并且每 500ms 刷新一次状态文案，
 * 避免用户只看到一句没反应的「加载中」。
 */
public class MainActivity extends AppCompatActivity {

    /** 等待服务端就绪的上限：5 分钟。 */
    private static final long WAIT_TIMEOUT_MS = 5 * 60 * 1000L;
    private static final long POLL_INTERVAL_MS = 500L;

    private WebView web;
    private TextView status;
    private String serverUrl;
    private volatile boolean loaded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        status = findViewById(R.id.status);
        web = findViewById(R.id.web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 混合内容：本地 http 服务 + https 外链
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // 外部链接（官网、GitHub、DeepSeek 网页版）交给系统浏览器，
                // 不在本地面板里打开，避免污染群崽的服务端会话。
                // serverUrl 还没拿到时（服务端仍在启动）一律放行给本地页。
                if (url == null) return false;
                if (serverUrl == null) return false;
                if (!url.startsWith(serverUrl)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)));
                    } catch (Exception ignored) { }
                    return true;
                }
                return false;
            }
        });

        // 启动内置服务端
        // 支持通过 Intent extra 强制 ABI（adb shell am start -n com.qunzai.app/.MainActivity --ez qz_abi arm64），
        // 用来在 x86_64 模拟器上把真机专属的 arm64 路径也测一遍。
        String forcedAbi = null;
        try {
            if (getIntent() != null) forcedAbi = getIntent().getStringExtra("qz_abi");
        } catch (Exception ignored) { }
        NodeService.start(this, forcedAbi);
        waitForServer();
    }

    /** 轮询 runtime.json 拿到实际端口，再加载面板。 */
    private void waitForServer() {
        status.setText("正在启动群崽服务…");
        new Thread(() -> {
            long deadline = System.currentTimeMillis() + WAIT_TIMEOUT_MS;
            String url = null;
            String lastMsg = "正在启动群崽服务…";
            while (System.currentTimeMillis() < deadline) {
                url = NodeHost.readServerUrl(this);
                // 光有 runtime.json 不够：必须确认这个端口真的在应答，
                // 否则会拿着还没起来（或已经换掉）的地址去连，白屏一片。
                if (url != null && ping(url)) break;
                url = null;

                // 刷新状态文案：解压进度 / 具体错误
                String msg = currentStatusMessage(lastMsg);
                if (!msg.equals(lastMsg)) {
                    lastMsg = msg;
                    final String m = msg;
                    runOnUiThread(() -> status.setText(m));
                }

                try { Thread.sleep(POLL_INTERVAL_MS); } catch (InterruptedException e) { return; }
            }
            final String finalUrl = url;
            final String finalMsg = (url == null) ? lastMsg : "群崽服务已就绪";
            runOnUiThread(() -> {
                if (finalUrl == null) {
                    status.setVisibility(View.VISIBLE);
                    status.setText(finalMsg);
                    return;
                }
                serverUrl = finalUrl;
                loaded = true;
                status.setVisibility(View.GONE);
                web.loadUrl(finalUrl + "/");
            });
        }).start();
    }

    /** 从服务写下的 qz-status.json 里取一句人话状态。 */
    private String currentStatusMessage(String fallback) {
        try {
            org.json.JSONObject o = NodeHost.readStatus(this);
            if (o == null) return fallback;
            String phase = o.optString("phase", "");
            String msg = o.optString("message", "");
            String err = o.optString("error", "");
            if (!err.isEmpty()) {
                return "启动失败：" + err;
            }
            if (!msg.isEmpty()) return msg;
            if ("running".equals(phase)) return "群崽服务运行中";
            return fallback;
        } catch (Exception e) {
            return fallback;
        }
    }

    /** 探一下面板是否已应答（200 即算活着）。 */
    private boolean ping(String base) {
        java.net.HttpURLConnection c = null;
        try {
            java.net.URL u = new java.net.URL(base + "/");
            c = (java.net.HttpURLConnection) u.openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(1500);
            c.setRequestMethod("GET");
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    @Override
    public void onBackPressed() {
        // 面板里能后退就后退，退无可退才退出应用
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从后台回到前台时，面板可能因为 WebView 被回收而白屏，重载一次
        if (loaded && serverUrl != null && web != null) {
            web.loadUrl(serverUrl + "/");
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
        }
    }
}
