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
 */
public class MainActivity extends AppCompatActivity {

    private WebView web;
    private TextView status;
    private String serverUrl;

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
        NodeService.start(this);
        waitForServer();
    }

    /** 轮询 runtime.json 拿到实际端口，再加载面板。 */
    private void waitForServer() {
        status.setText("正在启动群崽服务…");
        new Thread(() -> {
            String url = null;
            for (int i = 0; i < 120; i++) {
                url = NodeHost.readServerUrl(this);
                // 光有 runtime.json 不够：必须确认这个端口真的在应答，
                // 否则会拿着还没起来（或已经换掉）的地址去连，白屏一片。
                if (url != null && ping(url)) break;
                url = null;
                try { Thread.sleep(500); } catch (InterruptedException e) { return; }
            }
            final String finalUrl = url;
            runOnUiThread(() -> {
                if (finalUrl == null) {
                    status.setText("服务启动失败，请查看通知中的日志");
                    return;
                }
                serverUrl = finalUrl;
                status.setVisibility(View.GONE);
                web.loadUrl(finalUrl + "/");
            });
        }).start();
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
    protected void onDestroy() {
        super.onDestroy();
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
        }
    }
}
