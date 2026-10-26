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
import java.util.Map;

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
     * 启动 Node 的几种策略，按顺序尝试，用第一个能跑起来的。
     *
     * 为什么要有好几套：Android 的动态链接器有「namespace 隔离」，
     * 从 Android 7/8 起，app 自己带的一堆 .so 在某些机型上并不能靠
     * LD_LIBRARY_PATH 找到（系统会优先用 /system/lib64 下的同名库，
     * 或干脆忽略 LD_LIBRARY_PATH），于是 node 一 exec 就报
     * "CANNOT LINK EXECUTABLE"。
     * 三套依次是：
     *   0  直接 exec，并设置 LD_LIBRARY_PATH=解压出来的 lib
     *   1  直接 exec，不设 LD_LIBRARY_PATH（交给系统的 nativeLibraryDir 解析）
     *   2  交给系统 linker 显式指定库目录：/system/bin/linker64 --library-path ...
     * 哪套在本机可用是未知的，运行时现试现用。
     */
    private static final String[] STRATEGY_NAMES = {
            "直接启动 + LD_LIBRARY_PATH",
            "直接启动（不设 LD_LIBRARY_PATH）",
            "系统 linker 显式指定库目录"
    };

    /** 已经验证在本机可用的策略编号；-1 = 还没试出来。 */
    private static volatile int workingStrategy = -1;

    /** 一条 node 命令的执行结果。 */
    private static final class RunResult {
        int code;
        String output;
        RunResult(int c, String o) { code = c; output = o; }
    }

    /**
     * 跑一条 node 命令，依次尝试各启动策略，返回第一个成功的。
     * 全都失败时抛异常，错误信息里带上每套策略的输出，便于定位。
     */
    private static RunResult runNode(File bin, File rt, String[] args, int timeoutSec)
            throws Exception {
        StringBuilder report = new StringBuilder();
        Exception lastError = null;

        int start = workingStrategy >= 0 ? workingStrategy : 0;
        for (int i = 0; i < STRATEGY_NAMES.length; i++) {
            int s = (start + i) % STRATEGY_NAMES.length;
            try {
                RunResult r = runNodeWithStrategy(s, bin, rt, args, timeoutSec);
                if (r.code == 0) {
                    workingStrategy = s;
                    Log.i(TAG, "node launch strategy ok: " + STRATEGY_NAMES[s]);
                    return r;
                }
                report.append("[").append(STRATEGY_NAMES[s]).append("] exit=")
                      .append(r.code).append(" ").append(r.output).append("\n");
            } catch (Exception e) {
                lastError = e;
                report.append("[").append(STRATEGY_NAMES[s]).append("] ")
                      .append(e.getClass().getSimpleName()).append(": ")
                      .append(e.getMessage()).append("\n");
            }
        }
        throw new IllegalStateException(
                "内置 Node 无法启动（已尝试 " + STRATEGY_NAMES.length + " 种方式）：\n" + report
                        + "设备 ABI：" + Build.SUPPORTED_ABIS[0]);
    }

    /** 用指定的策略跑一次 node。 */
    private static RunResult runNodeWithStrategy(int strategy, File bin, File rt,
                                                  String[] args, int timeoutSec)
            throws Exception {
        List<String> cmd = buildCmd(strategy, bin, rt, args);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(rt);
        pb.redirectErrorStream(true);
        applyEnv(pb.environment(), strategy, rt);

        Process p = pb.start();
        StringBuilder sb = new StringBuilder();
        Thread reader = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line).append('\n');
            } catch (Exception ignored) { }
        });
        reader.setDaemon(true);
        reader.start();

        boolean done = p.waitFor(timeoutSec, java.util.concurrent.TimeUnit.SECONDS);
        if (!done) {
            p.destroyForcibly();
            return new RunResult(-1, "启动超时（" + timeoutSec + " 秒内没有输出）\n" + sb);
        }
        reader.join(1500);
        return new RunResult(p.exitValue(), sb.toString().trim());
    }

    /** 拼出该策略下的命令行。 */
    private static List<String> buildCmd(int strategy, File bin, File rt, String[] args) {
        List<String> cmd = new ArrayList<>();
        if (strategy == 2) {
            cmd.add("/system/bin/linker64");
            cmd.add("--library-path");
            cmd.add(libSearchPath(rt));
        }
        cmd.add(bin.getAbsolutePath());
        for (String a : args) cmd.add(a);
        return cmd;
    }

    /**
     * 库的搜索路径：运行时自己的 lib 目录 + 应用自带的 nativeLibraryDir。
     * 两者都要有——前者给 RUNPATH 用，后者是 linker 一定去搜的地方。
     */
    private static String libSearchPath(File rt) {
        String lib = new File(rt, "lib").getAbsolutePath();
        try {
            String nativeDir = nativeLibDir;
            if (nativeDir != null && !nativeDir.isEmpty()) {
                return lib + ":" + nativeDir;
            }
        } catch (Exception ignored) { }
        return lib;
    }

    /** 应用自带的原生库目录（jniLibs 装到这里），启动时记下来。 */
    private static volatile String nativeLibDir = null;

    /** 设置进程环境变量。 */
    private static void applyEnv(Map<String, String> env, int strategy, File rt) {
        String lib = new File(rt, "lib").getAbsolutePath();
        // 策略 0 依赖 LD_LIBRARY_PATH；策略 2 由 linker64 --library-path 负责。
        if (strategy == 0) {
            env.put("LD_LIBRARY_PATH", libSearchPath(rt));
        } else if (strategy == 1) {
            env.remove("LD_LIBRARY_PATH");
        }
        env.put("NODE_ICU_DATA", lib);
        env.put("NODE_PATH", lib);
    }

    /**
     * 把 APK 里的原生库（jniLibs）复制到运行时的 lib 目录。
     *
     * 为什么必须这么做：node 依赖的一批 .so 在 Android 上有两个坑。
     *
     * 坑一（namespace 隔离）：Android 7/8 起动态链接器有 namespace 隔离，
     * 应用私有目录里的 .so 常常**不能**被 linker 按 RUNPATH 找到
     * （模拟器走 NDK 转译很宽松，真机走原生 linker64 就常失败），
     * 于是 node 一 exec 就报 CANNOT LINK EXECUTABLE。
     * 把 .so 打进 APK 的 jniLibs 后，它们会被装到
     * /data/app/~~xxx/com.qunzai.app-xxx/lib/arm64/ —— 也就是应用自己的
     * nativeLibraryDir，这个位置 linker 一定会去搜。启动前把它们复制到
     * 运行时目录的 lib/ 下，RUNPATH 的 $ORIGIN/../lib 就能命中。
     *
     * 坑二（版本号后缀）：AGP 只打包 *.so 后缀的文件，libz.so.1 这种带
     * 版本号的会被直接丢掉。所以打包时统一改成 .so 结尾，运行时按
     * 清单还原原名——打包时已经把 DT_NEEDED 也一并改掉了，所以这里的
     * 「还原」其实是还原成与 DT_NEEDED 完全一致的名字。
     *
     * 重要：nativeLibraryDir 里是**设备 ABI** 的库，而运行时解压出来的
     * 库是**assets 里那一套 ABI** 的。两者在真机上相同，但在模拟器上
     * 强制跑另一种 ABI 时不同——曾经因此把 arm64 的 libz.so.1 覆盖成
     * x86_64 的，报 "is for EM_X86_64 instead of EM_AARCH64"。
     * 所以这里先比对本机库与目标库的架构，只有架构一致才允许覆盖。
     */
    public static int copyNativeLibs(Context ctx) throws Exception {
        File rt = runtimeDir(ctx);
        File libDir = new File(rt, "lib");
        if (!libDir.exists() && !libDir.mkdirs()) {
            throw new IllegalStateException("无法创建目录：" + libDir.getAbsolutePath());
        }
        // jniLibs 装到应用的 nativeLibraryDir，linker 一定会去这里搜。
        try {
            nativeLibDir = ctx.getApplicationInfo().nativeLibraryDir;
        } catch (Exception ignored) { }
        if (nativeLibDir == null) {
            Log.w(TAG, "nativeLibraryDir 不可用，只能用运行时自带 lib");
        }

        // 运行时这一套的架构（assets 里选中的那套）。
        // 注意：assets 里现在只放 node，不再放 .so，所以架构要从 bin/node 读，
        // 不能再读 lib/libz.so（那个文件此时还不存在）。
        int rtMachine = elfMachine(new File(rt, "bin/node"));
        if (rtMachine == 0) {
            rtMachine = elfMachine(new File(libDir, "libz.so"));
        }
        if (rtMachine == 0) {
            rtMachine = elfMachine(new File(libDir, "libz.so.1"));
        }

        // 清掉上一次运行残留的、架构不对的库。
        // 换 ABI 跑（比如设备 ABI 变了、或强制 arm64 调试）时，旧库会留在
        // lib/ 里，linker 挑到它就会报 "is for EM_X86_64 instead of EM_AARCH64"。
        if (rtMachine != 0) {
            File[] olds = libDir.listFiles();
            if (olds != null) {
                for (File f : olds) {
                    if (!f.isFile()) continue;
                    String n = f.getName();
                    if (!n.endsWith(".so")) continue;
                    int m = elfMachine(f);
                    if (m != 0 && m != rtMachine) {
                        Log.w(TAG, "remove stale " + n + ": arch " + m + " != " + rtMachine);
                        try { f.delete(); } catch (Exception ignored) { }
                    }
                }
            }
        }

        int copied = 0;
        if (nativeLibDir != null) {
            // jniLibs 装进去后，库在 <nativeLibraryDir>/<abi>/ 子目录里，
            // 根目录下只有 ABI 名的文件夹（真机 linker 只搜这一层）。
            // 早期版本只遍历根目录，结果一个库都没复制到运行时目录，
            // 真机上 node 就报「内置 Node 自检失败」。
            List<File> pool = new ArrayList<File>();
            File[] roots = new File(nativeLibDir).listFiles();
            if (roots != null) {
                for (File r : roots) {
                    if (r.isDirectory()) {
                        File[] sub = r.listFiles();
                        if (sub != null) {
                            for (File f : sub) {
                                if (f.isFile()) pool.add(f);
                            }
                        }
                    } else if (r.isFile()) {
                        pool.add(r);
                    }
                }
            }
            for (File f : pool) {
                {
                    String packed = f.getName();
                    if (!packed.endsWith(".so")) continue;
                    File out = new File(libDir, packed);
                    // 架构不一致就跳过：不能拿别的 ABI 的库盖掉运行时自己的。
                    if (rtMachine != 0) {
                        int m = elfMachine(f);
                        if (m != 0 && m != rtMachine) {
                            Log.w(TAG, "skip " + packed + ": arch " + m
                                    + " != runtime " + rtMachine);
                            continue;
                        }
                    }
                    if (out.exists() && out.length() == f.length()) continue;
                    try {
                        java.io.FileInputStream in = new java.io.FileInputStream(f);
                        java.io.FileOutputStream os = new java.io.FileOutputStream(out);
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                        os.flush(); os.close(); in.close();
                        copied++;
                    } catch (Exception e) {
                        Log.w(TAG, "copy native lib failed: " + packed, e);
                    }
                }
            }
            Log.i(TAG, "native lib pool: " + pool.size() + " file(s) in " + nativeLibDir);
        }
        return copied;
    }

    /**
     * 读一个 ELF 文件的机器类型：183 = AArch64，62 = x86_64，0 = 读不出来。
     * 用来判断 jniLibs 里的库和运行时解压出来的库是不是同一个架构。
     */
    private static int elfMachine(File f) {
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            byte[] head = new byte[20];
            int n = in.read(head);
            if (n < 20) return 0;
            if (head[0] != 0x7f || head[1] != 'E' || head[2] != 'L' || head[3] != 'F') {
                return 0;
            }
            if (head[4] != 2) return 0; // 只处理 ELF64
            int machine = (head[18] & 0xff) | ((head[19] & 0xff) << 8);
            return machine;
        } catch (Exception e) {
            return 0;
        }
    }

    /** 读 qz-nativelibs.json：打包名 -> 原始名。 */
    private static java.util.Map<String, String> readNativeLibManifest(Context ctx) {
        java.util.Map<String, String> m = new java.util.HashMap<>();
        try (InputStream in = ctx.getAssets().open("qz-nativelibs.json")) {
            StringBuilder sb = new StringBuilder();
            BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            org.json.JSONObject root = new org.json.JSONObject(sb.toString());
            String abi = abi();
            org.json.JSONObject one = root.optJSONObject(abi);
            if (one == null) {
                // 兜底：取任意一个（两个 ABI 的库名一致）
                java.util.Iterator<String> it = root.keys();
                if (it.hasNext()) one = root.optJSONObject(it.next());
            }
            if (one != null) {
                java.util.Iterator<String> it = one.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    m.put(k, one.optString(k, k));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "read native lib manifest failed", e);
        }
        return m;
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

        // 先把 APK 里的原生库搬到运行时 lib/（linker namespace 问题的正解）
        int n = copyNativeLibs(ctx);
        Log.i(TAG, "native libs ready: " + n + " file(s) copied");

        RunResult r = runNode(bin, rt, new String[]{
                "-p", "process.version + ' ' + process.arch"}, 20);
        if (r.code != 0) {
            throw new IllegalStateException("内置 Node 自检失败（exit " + r.code + "）：" + r.output);
        }
        Log.i(TAG, "node self check: " + r.output);
        return r.output;
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

        // 服务端用与自检相同的启动策略（真机上只有某一种能过 linker 检查）
        Process p = startNodeProcess(bin, rt, new File(root, "server/server.js").getAbsolutePath(),
                root, data);
        pump(p, sink);
        writeStatus(ctx, "start", "群崽服务已启动，正在等待端口…", 0, 0, null);
        return p;
    }

    /**
     * 按已验证可行的策略拉起 node 跑群崽服务端。
     * 与自检共用同一套策略，自检怎么成功，服务端就怎么起。
     */
    private static Process startNodeProcess(File bin, File rt, String script,
                                            File root, File data) throws Exception {
        int start = workingStrategy >= 0 ? workingStrategy : 0;
        Exception last = null;
        for (int i = 0; i < STRATEGY_NAMES.length; i++) {
            int s = (start + i) % STRATEGY_NAMES.length;
            try {
                List<String> cmd = buildCmd(s, bin, rt, new String[]{script});
                ProcessBuilder pb = new ProcessBuilder(cmd);
                pb.directory(root);
                pb.redirectErrorStream(true);
                Map<String, String> env = pb.environment();
                applyEnv(env, s, rt);
                env.put("QUNZAI_ROOT", root.getAbsolutePath());
                env.put("QUNZAI_DATA_DIR", data.getAbsolutePath());
                env.put("QUNZAI_SERVER_HOST", "127.0.0.1");
                env.put("QUNZAI_EMBEDDED", "1");
                env.put("HOME", data.getAbsolutePath());
                env.put("TMPDIR", data.getAbsolutePath());
                File ca = new File(rt, "ca-bundle.crt");
                if (ca.exists()) {
                    env.put("NODE_EXTRA_CA_CERTS", ca.getAbsolutePath());
                }
                Process p = pb.start();
                // 给它一点点时间确认没被 linker 立刻拒绝
                Thread.sleep(400);
                if (p.isAlive()) {
                    workingStrategy = s;
                    Log.i(TAG, "server launch strategy: " + STRATEGY_NAMES[s]);
                    return p;
                }
                int code = p.exitValue();
                last = new IllegalStateException("策略「" + STRATEGY_NAMES[s]
                        + "」下服务端进程立即退出，exit=" + code);
            } catch (InterruptedException e) {
                throw e;
            } catch (Exception e) {
                last = e;
            }
        }
        throw new IllegalStateException("内置 Node 无法启动群崽服务端：" +
                (last == null ? "未知原因" : last.getMessage()));
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
