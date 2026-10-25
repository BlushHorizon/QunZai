package com.qunzai.app;

import android.content.Context;
import android.os.Build;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.List;

/**
 * 内置 Node 运行时的启动与守护。
 *
 * 运行时从 assets 解压到应用私有目录（assets 不可执行），
 * 群崽服务端同样解压出来，通过环境变量 QUNZAI_ROOT / QUNZAI_DATA_DIR 指过去，
 * 这样服务端读写的数据都在应用私有目录里，卸载即清空。
 *
 * 运行时按设备 ABI 选择：assets/qz-rt/arm64/ 与 assets/qz-rt/x86_64/，
 * 解压后都摊平成同一个目录（bin/node + lib/ + ca-bundle.crt），
 * 下面的取用逻辑就与 ABI 无关了。
 */
public final class NodeHost {

    /**
     * 设备主 ABI，映射到 assets/qz-rt/ 下的子目录名。
     * 取 SUPPORTED_ABIS[0]（系统优先级最高的那个），再归一到我们打包的两个。
     */
    public static String abi() {
        String[] abis = Build.SUPPORTED_ABIS;
        String pick = "";
        if (abis != null && abis.length > 0) pick = abis[0];
        if (pick == null) pick = "";
        pick = pick.toLowerCase();
        if (pick.startsWith("arm64")) return "arm64";
        if (pick.startsWith("x86_64")) return "x86_64";
        // 兜底：SUPPORTED_ABIS 为空或是非预期值时按 64 位判断
        if (Build.SUPPORTED_64_BIT_ABIS != null && Build.SUPPORTED_64_BIT_ABIS.length > 0) {
            String a = Build.SUPPORTED_64_BIT_ABIS[0].toLowerCase();
            if (a.startsWith("arm64")) return "arm64";
            if (a.startsWith("x86_64")) return "x86_64";
        }
        return "arm64";
    }

    /** 应用私有目录下的运行时根目录 */
    public static File runtimeDir(Context ctx) {
        File dir = new File(ctx.getFilesDir(), "qz-runtime");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /** 应用私有目录下的群崽程序根目录（server/ + public/） */
    public static File appRoot(Context ctx) {
        File dir = new File(ctx.getFilesDir(), "qz-app");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /** 数据目录：config.json / runtime.json / app.log / 聊天记录 */
    public static File dataDir(Context ctx) {
        File dir = new File(ctx.getFilesDir(), "qz-data");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /**
     * 从 assets 解压内置资源到目标目录（已存在则跳过）。
     * assets/qz/ 下的目录结构原样保留。
     */
    public static void extractAssets(Context ctx, String assetPrefix, File target) {
        try {
            String[] entries = ctx.getAssets().list(assetPrefix);
            if (entries == null || entries.length == 0) {
                // 可能是文件
                copyAssetFile(ctx, assetPrefix, new File(target, basename(assetPrefix)));
                return;
            }
            for (String name : entries) {
                String child = assetPrefix + "/" + name;
                File out = new File(target, name);
                String[] sub = ctx.getAssets().list(child);
                if (sub != null && sub.length > 0) {
                    out.mkdirs();
                    extractAssets(ctx, child, out);
                } else {
                    copyAssetFile(ctx, child, out);
                }
            }
        } catch (Exception e) {
            // 解压失败时上层会看到 node 启动不了
        }
    }

    private static void copyAssetFile(Context ctx, String assetPath, File out) {
        try {
            // 已解压过就跳过：运行时近百 MB，每次启动重解压要好几秒。
            // 判据是「存在且非空」，宁可多解压一次也不能用半个文件。
            if (out.exists() && out.isFile() && out.length() > 0) {
                out.setExecutable(true, false);
                out.setReadable(true, false);
                return;
            }
            File parent = out.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            try (java.io.InputStream in = ctx.getAssets().open(assetPath);
                 java.io.OutputStream os = new java.io.FileOutputStream(out)) {
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            out.setExecutable(true, false);
            out.setReadable(true, false);
        } catch (Exception ignored) { }
    }

    private static String basename(String p) {
        int i = p.lastIndexOf('/');
        return i >= 0 ? p.substring(i + 1) : p;
    }

    /**
     * 拉起内置 Node，跑群崽服务端。
     * 返回进程对象；调用方负责读 stdout/stderr 写日志。
     */
    public static Process startServer(Context ctx, LogSink sink) throws Exception {
        File rt = runtimeDir(ctx);
        File bin = new File(rt, "bin/node");
        if (!bin.exists()) {
            throw new IllegalStateException("内置 Node 运行时缺失");
        }
        bin.setExecutable(true, false);

        File root = appRoot(ctx);
        File data = dataDir(ctx);

        // 删掉上一轮遗留的 runtime.json：里面记的是旧端口，
        // 不清的话 WebView 会拿着过期地址去连，报 ERR_CONNECTION_REFUSED。
        File stale = new File(data, "runtime.json");
        if (stale.exists()) stale.delete();

        List<String> cmd = new ArrayList<>();
        cmd.add(bin.getAbsolutePath());
        cmd.add(new File(root, "server/server.js").getAbsolutePath());

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(root);
        pb.redirectErrorStream(true);

        java.util.Map<String, String> env = pb.environment();
        env.put("QUNZAI_ROOT", root.getAbsolutePath());
        env.put("QUNZAI_DATA_DIR", data.getAbsolutePath());
        env.put("QUNZAI_SERVER_HOST", "127.0.0.1");
        env.put("QUNZAI_EMBEDDED", "1");
        env.put("NODE_PATH", new File(rt, "lib").getAbsolutePath());
        // 让 node 里的动态库能找到（bionic 通过 DT_RUNPATH $ORIGIN/../lib）
        env.put("LD_LIBRARY_PATH", new File(rt, "lib").getAbsolutePath());
        // Termux 的 node 依赖自带的 ICU 资源路径
        env.put("NODE_ICU_DATA", new File(rt, "lib").getAbsolutePath());
        // Android 系统 CA 证书库不认 node 的 openssl，联网会报
        // "unable to get local issuer certificate"，需显式挂上内置的 ca-bundle
        File ca = new File(rt, "ca-bundle.crt");
        if (ca.exists()) {
            env.put("NODE_EXTRA_CA_CERTS", ca.getAbsolutePath());
        }
        env.put("HOME", data.getAbsolutePath());
        env.put("TMPDIR", data.getAbsolutePath());

        Process p = pb.start();
        pump(p, sink);
        return p;
    }

    private static void pump(Process p, LogSink sink) {
        Thread t = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null) {
                    if (sink != null) sink.onLine(line);
                }
            } catch (Exception ignored) { }
        });
        t.setDaemon(true);
        t.start();
    }

    /** 读取服务端写出的实际端口，拼出面板地址。 */
    public static String readServerUrl(Context ctx) {
        File f = new File(dataDir(ctx), "runtime.json");
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new java.io.FileInputStream(f)))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            org.json.JSONObject o = new org.json.JSONObject(sb.toString());
            if (o.optBoolean("stopped", false)) return null;
            int port = o.optInt("serverPort", 0);
            if (port <= 0) return null;
            String host = o.optString("host", "127.0.0.1");
            if (host.isEmpty() || "0.0.0.0".equals(host)) host = "127.0.0.1";
            return "http://" + host + ":" + port;
        } catch (Exception e) {
            return null;
        }
    }

    public interface LogSink {
        void onLine(String line);
    }
}
