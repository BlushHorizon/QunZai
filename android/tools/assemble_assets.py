"""
把群崽服务端 + 内置 Node 运行时组装成 Android assets。

产物结构（打进 app/src/main/assets/）：
  qz-app/server/*.js      群崽服务端
  qz-app/public/*         面板前端
  qz-app/config.json      默认配置（安卓专用）
  qz-rt/arm64/bin/node    Termux node 26.12.1 (arm64)
  qz-rt/arm64/lib/*.so    运行时依赖库
  qz-rt/arm64/ca-bundle.crt
  qz-rt/x86_64/...        同上（x86_64 版）
  qz-rt/ca-bundle.crt     CA 证书（两份都放一份，避免被清掉）

运行时按设备 ABI 选（arm64-v8a / x86_64），服务端启动时由
QUNZAI_ROOT / QUNZAI_DATA_DIR 指到应用私有目录。
"""
import json
import os
import shutil
import sys

SRC = r"C:\Users\14132\Documents\默认项目\open-source\DeepPupil"
BUILD = r"D:\qz-build"
ASSETS = os.path.join(BUILD, "android", "app", "src", "main", "assets")

# ABI -> 运行时目录（runtime-slim 是 arm64，runtime-slim-x64 是 x86_64）
RUNTIMES = {
    "arm64": os.path.join(BUILD, "runtime-slim"),
    "x86_64": os.path.join(BUILD, "runtime-slim-x64"),
}


def copytree(src, dst, skip_ext=()):
    os.makedirs(dst, exist_ok=True)
    n = 0
    for name in os.listdir(src):
        s = os.path.join(src, name)
        d = os.path.join(dst, name)
        if os.path.isdir(s):
            n += copytree(s, d, skip_ext)
        else:
            if name.endswith(skip_ext):
                continue
            shutil.copy2(s, d)
            n += 1
    return n


def main():
    if os.path.isdir(ASSETS):
        shutil.rmtree(ASSETS)
    os.makedirs(ASSETS, exist_ok=True)

    # 1) 服务端
    srv_dst = os.path.join(ASSETS, "qz-app", "server")
    n = copytree(os.path.join(SRC, "app", "server"), srv_dst)
    print(f"[assets] server files: {n}")

    # 2) 前端
    pub_dst = os.path.join(ASSETS, "qz-app", "public")
    n = copytree(os.path.join(SRC, "app", "public"), pub_dst)
    print(f"[assets] public files: {n}")

    # 3) 安卓专用默认配置
    #    - QQ 走 OneBot 正向 WS（APK 内不含 NapCat，手机上跑不动）
    #    - AI 默认用 API 模式（安卓没有可驱动的网页版浏览器）
    #    - 关闭 QQ 内核自动启动（安卓上没有 windows 版监视器）
    #    - 关闭自动更新（用户明确说安卓版不做更新）
    cfg = {
        "server": {"host": "127.0.0.1", "port": 8787},
        "qq": {
            "mode": "onebot",
            "onebot": {
                "wsUrl": "ws://127.0.0.1:3001",
                "accessToken": "",
            },
            "engine": {
                "enabled": False,
                "autoStart": False,
                "source": "auto",
                "dir": "",
                "account": "",
                "apiPort": 3000,
            },
        },
        "ai": {
            "enabled": True,
            "provider": "openai-compatible",
            "cdpPort": 9222,
            "browserPath": "",
            "webPrompt": "",
            "webMaxRounds": 50,
            "baseUrl": "https://api.deepseek.com",
            "apiKey": "",
            "model": "deepseek-chat",
            "systemPrompt": (
                "你是「网页版 QQ 助手」，正在通过 QQ 与好友聊天。"
                "要求：中文回复、简洁自然、不要用 Markdown 语法、"
                "不要自称 AI 模型、长度控制在 100 字以内。"
            ),
            "scope": "all",
            "replyMode": "all",
            "targetChatKey": "",
            "targetChatKeys": [],
            "requireMentionInGroup": False,
            "groupReplyChance": 100,
            "groupKeywords": "",
            "quietEnabled": False,
            "quietFrom": "23:00",
            "quietTo": "08:00",
            "commandSenders": "",
            "imageReply": True,
            "groupAtSender": True,
            "groupQuote": True,
            "minIntervalMs": 2500,
            "historyTurns": 8,
            "replyDelayMs": 900,
        },
        "update": {
            "manifestUrl": "https://blushhorizon.github.io/QunZai/update.json",
            "autoCheck": False,
        },
    }
    with open(os.path.join(ASSETS, "qz-app", "config.json"), "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    print("[assets] config.json written (android defaults)")

    # 4) Node 运行时（按 ABI 分目录）
    #
    #    只放 node 可执行文件和 CA 证书；.so 一律不打进 assets——
    #    它们在 jniLibs 里（lib/<abi>/），那是系统 linker 一定会搜的位置。
    #    app 私有目录里的 .so 在真机上受 linker namespace 隔离，linker
    #    根本不会去那里找，所以 assets 里放一份纯属浪费 90MB 体积。
    rt_root = os.path.join(ASSETS, "qz-rt")
    for abi, src in RUNTIMES.items():
        dst = os.path.join(rt_root, abi)
        os.makedirs(os.path.join(dst, "bin"), exist_ok=True)
        shutil.copy2(os.path.join(src, "bin", "node"),
                     os.path.join(dst, "bin", "node"))
        # 只带一份 CA 证书，放运行时根目录，两种 ABI 共用
        print(f"[assets] runtime[{abi}]: node only")

    # CA 证书（运行时根目录 + 每个 ABI 目录各一份）
    shutil.copy2(os.path.join(RUNTIMES["arm64"], "ca-bundle.crt"),
                 os.path.join(rt_root, "ca-bundle.crt"))
    for abi, src in RUNTIMES.items():
        shutil.copy2(os.path.join(src, "ca-bundle.crt"),
                     os.path.join(rt_root, abi, "ca-bundle.crt"))

    # 5) jniLibs：把 .so 也打进 APK 的 lib/<abi>/ 目录
    #
    #    为什么必须打两份（assets + jniLibs）：
    #    Android 的动态链接器有 namespace 隔离，app 私有目录里的 .so 在
    #    真机上常常无法按 RUNPATH/LD_LIBRARY_PATH 找到（模拟器走 NDK 转译
    #    很宽松，把这个问题掩盖了）。只有打进 jniLibs 的库才会被装进
    #    /data/app/.../lib/<abi>/，那是 linker 一定会去搜的位置。
    #
    #    而 AGP 只打包 *.so 后缀的文件，所以库的版本号后缀必须去掉
    #    （libz.so.1 -> libz.so），同时把 DT_NEEDED 改成对应的新名字，
    #    否则 linker 找的是 "libz.so.1"，APK 里却只有 "libz.so"。
    #    这套改名由 strip_so_versions.py 在 runtime-slim* 上完成。
    jni_root = os.path.join(BUILD, "android", "app", "src", "main", "jniLibs")
    if os.path.isdir(jni_root):
        shutil.rmtree(jni_root)
    for abi, src in RUNTIMES.items():
        src_lib = os.path.join(src, "lib")
        if not os.path.isdir(src_lib):
            continue
        dst = os.path.join(jni_root, "arm64-v8a" if abi == "arm64" else "x86_64")
        os.makedirs(dst, exist_ok=True)
        n = 0
        for name in sorted(os.listdir(src_lib)):
            p = os.path.join(src_lib, name)
            if not os.path.isfile(p) or not name.endswith(".so"):
                continue
            shutil.copy2(p, os.path.join(dst, name))
            n += 1
        print(f"[jniLibs] {os.path.basename(dst)}: {n} file(s)")

    # 6) 统计体积
    total = 0
    for root, _dirs, files in os.walk(ASSETS):
        for f in files:
            total += os.path.getsize(os.path.join(root, f))
    print(f"[assets] total: {total/1024/1024:.1f} MB")


if __name__ == "__main__":
    main()
