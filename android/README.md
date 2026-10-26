# 群崽 QunZai · 安卓版

把「网页版 QQ 助手」整套塞进一个 APK：安卓应用启动时在应用私有目录里解压内置的
Node 运行时和群崽服务端，用 WebView 打开本地面板。用户在手机上装一次就能用，
不用自己下载任何东西。

## 成品

- 包名 `com.qunzai.app`，minSdk 24 / targetSdk 28 / compileSdk 34
- 架构：arm64-v8a + x86_64（两个 ABI 的 Node 运行时都内置）
- 安装包约 76 MB（绝大部分是内置的 Node 运行时）

## 目录

```
android/
├── app/
│   ├── build.gradle              AGP 8.13.2 / NDK / 签名配置
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/qunzai/app/
│       │   ├── MainActivity.java  拉起服务 → 等端口 → WebView 打开面板
│       │   ├── NodeService.java   前台服务（dataSync），带通知
│       │   └── NodeHost.java      解压资源 / 拼环境变量 / 启进程 / 读 runtime.json
│       ├── res/                   布局、主题、图标（官网 logo 生成）
│       └── assets/
│           ├── qz-app/            群崽服务端 + 面板前端（构建时生成）
│           └── qz-rt/<abi>/       Node 运行时（构建时生成，不入库）
└── tools/                        构建脚本（Python）
```

## 构建步骤

前置：JDK 17、Android SDK（platform 34 / build-tools 34）、Gradle 8.13。
Gradle 与 Maven 源都指向国内镜像（`settings.gradle` 已配阿里云）。

```bash
# 1. 拉取并组装 Termux Node 运行时（arm64 + x86_64）
python tools/fetch_termux.py       # 下载 .deb
python tools/extract_debs.py       # 解出 bin/ + lib/
python tools/build_runtime.py      # 打掉 RPATH、裁剪依赖
python tools/build_ca.py           # 生成 ca-bundle.crt（118 张证书）

# 2. 把群崽服务端 + 面板 + 安卓专用 config.json 打进 assets
python tools/pack_qzapp.py
python tools/assemble_assets.py

# 3. 生成图标（从 site/assets/qunzai-icon-256.png）
python tools/make_icons.py

# 4. 打包
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/android-sdk
gradle --offline assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

`assemble_assets.py` 会从仓库的 `app/dist/` 取服务端和前端，所以
**改完服务端要先跑一遍 Windows 版的 `node app/build-package.js`（或手动同步
`app/server` / `app/public` → `app/dist/`）**。

## 几个关键点

- **targetSdk 必须 ≤ 28**：Android 10+ 对 targetSdk ≥ 29 的应用禁止执行私有目录
  里的文件（SELinux `execute_no_trans`），内置的 `node` 会直接跑不起来。
  Termux 也是这么做的。
- **CA 证书**：`NodeHost` 通过 `NODE_EXTRA_CA_CERTS` 指向 `ca-bundle.crt`，
  否则所有 https 请求报 `unable to get local issuer certificate`。
- **端口**：服务端端口写在 `files/qz-data/runtime.json`，端口被占用会自动往后找。
  `MainActivity` 必须等到 HTTP 200 才让 WebView 加载，否则会白屏。
- **没有更新机制**：按需求，安卓版只做这一版，不内置自更新
  （`platform.js` 里 `selfUpdate: false`）。
- **QQ 接入**：APK 里不含 NapCat（Windows 监视器在安卓上跑不动）。
  用「OneBot 11 正向 WebSocket」模式，在面板里填外部 OneBot 的
  `ws://host:port`，accessToken 可选。
- **AI 大脑**：安卓没有可驱动的桌面浏览器，所以网页版 DeepSeek 模式在安卓上
  被禁用（`platform.js` 里 `webSupported: false`），请在设置里填
  OpenAI 兼容接口（默认 `https://api.deepseek.com` + `deepseek-chat`）。

## 签名

当前用 debug 签名（`signingConfigs.debug`），个人自用安装没问题。
要正式分发请自行生成 keystore 并在 `app/build.gradle` 里配 `signingConfigs.release`。

## 真机踩坑记录（v3 修复）

用户拿到的 v1/v2 包在真机上都起不来：v1 静默卡在「加载中」，v2 报
「内置 Node 自检失败」。模拟器却一切正常——因为模拟器的 linker 比真机宽松，
把三个缺陷全掩盖了。

### 缺陷 1：AGP 只打包 `*.so`

`libz.so.1` / `libcrypto.so.3` / `libssl.so.3` / `libicui18n.so.78` /
`libicuuc.so.78` / `libicudata.so.78` 这些带版本号的文件**不会**被打进
APK 的 `lib/<abi>/`，linker 却仍按 `DT_NEEDED` 里的原名去找，必然找不到。

`tools/strip_so_versions.py` 解决这个：把库的 `DT_SONAME`、以及所有依赖方的
`DT_NEEDED` 一起改成无版本号的名字（`libz.so.1` → `libz.so`），同时把文件
改名。注意新名字必须**不比原名长**（是在 ELF string table 里原地改写）。

`libc++_shared.so` 改成了 `libc++_qz.so`：系统自带的 `/system/lib64/libc++_shared.so`
一旦被 linker 优先选中，Termux 的 C++ 运行时会和平台的混用，符号对不上。

### 缺陷 2：copyNativeLibs 只扫了 nativeLibraryDir 根目录

jniLibs 装进去的库在 `<nativeLibraryDir>/<abi>/` **子目录**里，根目录只有一个
叫 `<abi>` 的文件夹。原来的 `listFiles()` 只列根目录 → 一个库都没复制到运行时
目录 → linker 找不到 → 自检失败。现在改成递归收集子目录与文件。

### 缺陷 3：库只放在 app 私有目录，真机 linker 根本不搜

Android 7+ 的 linker namespace 隔离下，app 私有目录不在许可搜索路径内。
`LD_LIBRARY_PATH` 对 targetSdk ≥ 23 的 app 会被忽略，`DT_RUNPATH` 也不可靠。
**库必须进 jniLibs**（装到 `nativeLibraryDir`，linker 必搜的位置）。

所以 `assemble_assets.py` 里 assets 只放 `bin/node` 和 `ca-bundle.crt`，
**`.so` 一律不进 assets**（真机根本用不上，白占 90MB）。APK 从 226MB 压到 131MB。

### 顺带修的

- `elfMachine()` 架构判定基准从 `lib/libz.so` 改成 `rt/bin/node`（assets 不再带 .so）。
- 换 ABI 跑时清理运行时目录里架构不符的残留 `.so`，否则 linker 会挑到旧库报
  `is for EM_X86_64 (62) instead of EM_AARCH64 (183)`。
- `extractAssets` 原来静默吞掉解压异常，失败时只表现为无限「加载中」。
  现在解压失败直接抛，并显示真实原因。
- 16KB page 对齐：`tools/align_check2.py` 核查 node 与全部 .so
  （判据是 `p_offset % 16384 == 0` 且 `p_vaddr % 16384 == 0` 同余）。

### 怎么在模拟器上验证真机路径

模拟器主 ABI 是 x86_64，nativeLibraryDir 里只有 x86_64 的库，模拟不出真机。
办法是打一个**只含 arm64** 的包（`abiFilters 'arm64-v8a'`），装上后：

```
adb shell am start -n com.qunzai.app/.MainActivity --es qz_abi arm64
```

日志出现 `native libs ready: 10 file(s) copied` + `node self check: v26.12.1 arm64`
就说明真机路径通了。
