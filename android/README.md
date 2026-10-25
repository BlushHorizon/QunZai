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
