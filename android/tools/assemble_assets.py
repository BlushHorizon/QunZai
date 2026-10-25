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
    rt_root = os.path.join(ASSETS, "qz-rt")
    for abi, src in RUNTIMES.items():
        dst = os.path.join(rt_root, abi)
        n = copytree(src, dst)
        print(f"[assets] runtime[{abi}] files: {n}")

    # CA 证书兜底（放一份在 qz-rt 根，两种 ABI 共用）
    shutil.copy2(os.path.join(RUNTIMES["arm64"], "ca-bundle.crt"),
                 os.path.join(rt_root, "ca-bundle.crt"))

    # 5) 统计体积
    total = 0
    for root, _dirs, files in os.walk(ASSETS):
        for f in files:
            total += os.path.getsize(os.path.join(root, f))
    print(f"[assets] total: {total/1024/1024:.1f} MB")


if __name__ == "__main__":
    main()
