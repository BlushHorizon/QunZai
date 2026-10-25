package com.qunzai.app;

import android.content.Context;
import android.os.Build;
import android.os.StatFs;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
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

    private static final String TAG = "QunZai";

    /**
     * 每个解压出来的文件旁边放一个 .qzok 标记，内容是「来源标签:源文件大小」。
     *
     * 为什么不能只看「文件存在且非空」：解压到一半被系统杀进程或存储写满，
     * 会留下一个非空的半截文件，下次启动被判成「已解压」直接跳过，
     * 结果就是一个永远跑不起来的 node。标记 + 大小校验可以自愈这种情况。
     *
     * 为什么还要带「来源标签」：arm64 与 x86_64 两套运行时的文件大小可能
     * 恰好接近，只比大小会把上一套 ABI 的残留当成本套的完整文件，
     * 于是启动的是别的架构的 node（表现为自检报的 arch 与设备不符）。
     * 标签取自 assets 前缀（如 qz-rt/arm64），换 ABI 时标签自然不同。
     */
    private static final String OK_SUFFIX = ".qzok";

    /** 进度回调：让界面能显示「正在解压 37/42」，而不是干等。 */
    public interface Progress {
        void onProgress(int doneFiles, int totalFiles, String currentName);
    }

    /* ------------------------------------------------------------------ */
    /* 启动状态：让界面能显示当前到底卡在哪一步，而不是一句「加载中」       */
    /* ------------------------------------------------------------------ */

    /** 状态文件名（放在数据目录里，界面轮询它）。 */
    private static final String STATUS_FILE = "qz-status.json";

    /**
     * 写启动状态。界面按这个文件显示「正在解压运行时 12/42」或具体错误原因。
     * 整个过程只用 FileOutputStream 原子替换，避免读到半截 JSON。
     */
    public static void writeStatus(Context ctx, String phase, String message,
                                   int done, int total, String error) {
        File f = new File(dataDir(ctx), STATUS_FILE);
        File tmp = new File(f.getAbsolutePath() + ".tmp");
        byte[] payload;
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("phase", phase == null ? "" : phase);
            o.put("message", message == null ? "" : message);
            o.put("done", done);
            o.put("total", total);
            o.put("error", error == null ? "" : error);
            o.put("ts", System.currentTimeMillis());
            payload = o.toString().getBytes("UTF-8");
        } catch (Exception e) {
            return;
        }
        try (OutputStream os = new FileOutputStream(tmp)) {
            os.write(payload);
            os.flush();
        } catch (Exception e) {
            Log.w(TAG, "write status failed", e);
            return;
        }
        // 原子替换：先删旧文件再改名，避免读到半截 JSON。
        if (f.exists() && !f.delete()) {
            Log.w(TAG, "delete old status failed");
        }
        if (!tmp.renameTo(f)) {
            try (InputStream in = new java.io.FileInputStream(tmp);
                 OutputStream out = new FileOutputStream(f)) {
                byte[] b = new byte[4096];
                int n;
                while ((n = in.read(b)) > 0) out.write(b, 0, n);
                out.flush();
            } catch (Exception e) {
                Log.w(TAG, "fallback status write failed", e);
            }
        }
    }

    /** 读启动状态；没有文件时返回 null。 */
    public static org.json.JSONObject readStatus(Context ctx) {
        File f = new File(dataDir(ctx), STATUS_FILE);
        if (!f.exists()) return null;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new java.io.FileInputStream(f), "UTF-8"))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            return new org.json.JSONObject(sb.toString());
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 设备主 ABI，映射到 assets/qz-rt/ 下的子目录名。
     * 取 SUPPORTED_ABIS[0]（系统优先级最高的那个），再归一到我们打包的两个。
     */
    public static String abi() {
        return abi(null);
    }

    /**
     * 同 abi()，但允许外部指定（Intent extra "qz_abi"）。
     * 用来在 x86_64 模拟器上强制走 arm64 那条解压与执行路径，
     * 免得真机专属的分支永远测不到。
     */
    public static String abi(String forced) {
        if (forced != null) {
            String f = forced.trim().toLowerCase();
            if (f.startsWith("arm64")) return "arm64";
            if (f.startsWith("x86_64")) return "x86_64";
        }
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
     * 统计 assets 目录下总文件数，用于进度显示。
     */
    private static int countFiles(Context ctx, String assetPrefix) {
        String[] entries = safeList(ctx, assetPrefix);
        if (entries == null) return 0;
        if (entries.length == 0) return 1; // 单个文件
        int n = 0;
        for (String name : entries) {
            String child = assetPrefix + "/" + name;
            String[] sub = safeList(ctx, child);
            if (sub != null && sub.length > 0) n += countFiles(ctx, child);
            else n += 1;
        }
        return n;
    }

    private static String[] safeList(Context ctx, String path) {
        try {
            return ctx.getAssets().list(path);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 从 assets 解压内置资源到目标目录。
     *
     * 幂等判据是「同名 .qzok 标记存在且记录的大小与实际文件一致」，
     * 任何半截文件都会被重新解压覆盖。
     *
     * 失败时抛异常（不再静默吞掉）——解压失败必须让用户看见，
     * 否则表现就是「一直卡在加载中」。
     */
    public static void extractAssets(Context ctx, String assetPrefix, File target, Progress progress)
            throws Exception {
        int total = countFiles(ctx, assetPrefix);
        final int[] done = {0};
        extractDir(ctx, assetPrefix, target, progress, done, total);
    }

    private static void extractDir(Context ctx, String assetPrefix, File target,
                                   Progress progress, int[] done, int total) throws Exception {
        String[] entries = safeList(ctx, assetPrefix);
        if (entries == null || entries.length == 0) {
            copyAssetFile(ctx, assetPrefix, new File(target, basename(assetPrefix)),
                    progress, done, total, tagOf(assetPrefix));
            return;
        }
        if (!target.exists() && !target.mkdirs()) {
            throw new IllegalStateException("无法创建目录：" + target.getAbsolutePath());
        }
        for (String name : entries) {
            String child = assetPrefix + "/" + name;
            File out = new File(target, name);
            String[] sub = safeList(ctx, child);
            if (sub != null && sub.length > 0) {
                extractDir(ctx, child, out, progress, done, total);
            } else {
                copyAssetFile(ctx, child, out, progress, done, total, tagOf(assetPrefix));
            }
        }
    }

    /**
     * 来源标签：取 assets 前缀里最能区分来源的那一段。
     * qz-rt/arm64/... → arm64；qz-rt/x86_64/... → x86_64；
     * qz-app/...     → qz-app。
     */
    private static String tagOf(String assetPrefix) {
        String p = assetPrefix == null ? "" : assetPrefix;
        String[] seg = p.split("/");
        for (int i = seg.length - 1; i >= 0; i--) {
            String s = seg[i];
            if (s.startsWith("arm64") || s.startsWith("x86_64") || s.startsWith("armeabi")
                    || s.startsWith("arm-")) {
                return s;
            }
        }
        return seg.length > 0 ? seg[seg.length - 1] : "root";
    }

    private static void copyAssetFile(Context ctx, String assetPath, File out,
                                      Progress progress, int[] done, int total,
                                      String sourceTag) throws Exception {
        File parent = out.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IllegalStateException("无法创建目录：" + parent.getAbsolutePath());
        }

        // 已经完整解压过就跳过：运行时近百 MB，每次启动重解压要好几秒。
        // 判据是「标记文件记录的来源与大小 == 本次来源与实际大小」，
        // 半截文件、以及别的 ABI 留下的残留，都会被重解。
        if (isComplete(out, sourceTag)) {
            out.setExecutable(true, false);
            out.setReadable(true, false);
            done[0]++;
            if (progress != null) progress.onProgress(done[0], total, out.getName());
            return;
        }

        if (progress != null) progress.onProgress(done[0], total, out.getName());

        // 先写 .part 再改名：中途被杀不会留下「看起来完整」的目标文件。
        File part = new File(out.getAbsolutePath() + ".part");
        try (InputStream in = ctx.getAssets().open(assetPath);
             OutputStream os = new FileOutputStream(part)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            long totalBytes = 0;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                totalBytes += n;
            }
            os.flush();
            ((FileOutputStream) os).getFD().sync();
        } catch (Exception e) {
            // 解压失败要清掉半成品，否则下次会拿它当完整文件用。
            try { if (part.exists()) part.delete(); } catch (Exception ignored) { }
            throw new IllegalStateException("解压失败：" + assetPath + "（" + e.getMessage() + "）", e);
        }

        long size = part.length();
        if (size <= 0) {
            try { part.delete(); } catch (Exception ignored) { }
            throw new IllegalStateException("解压结果为空：" + assetPath);
        }

        // 覆盖前先删旧的（Windows 上 rename 到已存在文件会失败，这里是 Android，
        // 但先删更保险，避免旧文件残留）
        if (out.exists() && !out.delete()) {
            try { if (part.exists()) part.delete(); } catch (Exception ignored) { }
            throw new IllegalStateException("无法覆盖文件：" + out.getAbsolutePath());
        }
        if (!part.renameTo(out)) {
            try { if (part.exists()) part.delete(); } catch (Exception ignored) { }
            throw new IllegalStateException("重命名失败：" + out.getAbsolutePath());
        }

        out.setExecutable(true, false);
        out.setReadable(true, false);

        // 写标记，记录这次成功解压的字节数与来源标签
        try (OutputStream ok = new FileOutputStream(new File(out.getAbsolutePath() + OK_SUFFIX))) {
            ok.write((sourceTag + ":" + size).getBytes("UTF-8"));
            ok.flush();
        } catch (Exception ignored) { }

        done[0]++;
        if (progress != null) progress.onProgress(done[0], total, out.getName());
    }

    /** 该文件是否已完整解压（标记存在、来源一致且大小一致）。 */
    private static boolean isComplete(File out, String sourceTag) {
        if (!out.exists() || !out.isFile()) return false;
        File ok = new File(out.getAbsolutePath() + OK_SUFFIX);
        if (!ok.exists() || !ok.isFile()) return false;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(
                new java.io.FileInputStream(ok), "UTF-8"))) {
            String s = r.readLine();
            if (s == null) return false;
            s = s.trim();
            int colon = s.indexOf(':');
            if (colon < 0) return false;
            String tag = s.substring(0, colon);
            long size = Long.parseLong(s.substring(colon + 1).trim());
            if (!tag.equals(sourceTag)) return false;
            return size == out.length();
        } catch (Exception e) {
            return false;
        }
    }

    private static String basename(String p) {
        int i = p.lastIndexOf('/');
        return i >= 0 ? p.substring(i + 1) : p;
    }

    /**
     * 检查可用存储空间。运行时解压需要约 110MB，留 200MB 余量，
     * 不够就直接报错，别让用户等半天最后失败。
     */
    public static long requireFreeSpace(Context ctx, long needBytes) throws Exception {
        StatFs fs = new StatFs(ctx.getFilesDir().getAbsolutePath());
        long avail = fs.getAvailableBytes();
        if (avail < needBytes) {
            throw new IllegalStateException(
                    "存储空间不足：解压内置运行时至少需要 " + (needBytes / 1048576) + "MB，"
                            + "当前可用 " + (avail / 1048576) + "MB");
        }
        return avail;
    }

    /**
     * 启动前的自检：真的把 node 跑起来问它版本号。
     *
     * 这一步很关键——node 是从 assets 解压出来、由系统 linker 装载的动态库，
     * 缺一个 .so 或架构不匹配都只会在 exec 时报一句 CANNOT LINK EXECUTABLE。
     * 先自检能把这类问题变成一句人话，而不是面板上无限期的「加载中」。
     */
    public static String selfCheck(Context ctx) throws Exception {
        File rt = runtimeDir(ctx);
        File bin = new File(rt, "bin/node");
        if (!bin.exists()) {
            throw new IllegalStateException("内置 Node 运行时缺失（" + bin.getAbsolutePath() + "）");
        }
        bin.setExecutable(true, false);

        List<String> cmd = new ArrayList<>();
        cmd.add(bin.getAbsolutePath());
        cmd.add("-p");
        cmd.add("process.version + ' ' + process.arch");

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(rt);
        pb.redirectErrorStream(true);
        java.util.Map<String, String> env = pb.environment();
        env.put("LD_LIBRARY_PATH", new File(rt, "lib").getAbsolutePath());
        env.put("NODE_ICU_DATA", new File(rt, "lib").getAbsolutePath());
        env.put("HOME", dataDir(ctx).getAbsolutePath());
        env.put("TMPDIR", dataDir(ctx).getAbsolutePath());

        Process p = pb.start();
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
        }
        int code = p.waitFor();
        String out = sb.toString().trim();
        if (code != 0) {
            throw new IllegalStateException("内置 Node 自检失败（exit " + code + "）：" + out);
        }
        Log.i(TAG, "node self check: " + out);
        return out;
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

        // 运行时自检：真机是原生 arm64，缺库或架构不匹配只会在 exec 时
        // 抛一句 CANNOT LINK EXECUTABLE。先自己跑一下 node -p，
        // 把这类问题变成一句人话。
        writeStatus(ctx, "check", "正在校验内置 Node 运行时…", 0, 0, null);
        String ver = selfCheck(ctx);
        writeStatus(ctx, "check", "内置 Node 运行时就绪（" + ver + "）", 0, 0, null);
        Log.i(TAG, "node self check ok: " + ver);

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
        writeStatus(ctx, "start", "群崽服务已启动，正在等待端口…", 0, 0, null);
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
