"""
把群崽服务端（server/ + public/ + config.json）打成 tar.gz，用于推送到安卓设备实测。
"""
import json
import os
import shutil
import sys

SRC = r"C:\Users\14132\Documents\默认项目\open-source\DeepPupil"
OUT = r"D:\qz-build\qzapp.tgz"
STAGE = r"D:\qz-build\stage-qzapp"


def copytree(src, dst):
    os.makedirs(dst, exist_ok=True)
    for name in os.listdir(src):
        s = os.path.join(src, name)
        d = os.path.join(dst, name)
        if os.path.isdir(s):
            copytree(s, d)
        else:
            shutil.copy2(s, d)


def main():
    if os.path.isdir(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(STAGE)

    copytree(os.path.join(SRC, "app", "server"), os.path.join(STAGE, "server"))
    copytree(os.path.join(SRC, "app", "public"), os.path.join(STAGE, "public"))

    cfg = {
        "server": {"host": "127.0.0.1", "port": 8787},
        "qq": {
            "mode": "onebot",
            "onebot": {"wsUrl": "ws://127.0.0.1:3001", "accessToken": ""},
            "engine": {"enabled": False, "autoStart": False, "source": "auto",
                       "dir": "", "account": "", "apiPort": 3000},
        },
        "ai": {
            "enabled": True,
            "provider": "openai-compatible",
            "baseUrl": "https://api.deepseek.com",
            "apiKey": "",
            "model": "deepseek-chat",
            "scope": "all",
            "replyMode": "all",
            "quietEnabled": False,
            "groupReplyChance": 100,
            "minIntervalMs": 2500,
            "historyTurns": 8,
            "replyDelayMs": 900,
        },
        "update": {"autoCheck": False},
    }
    with open(os.path.join(STAGE, "config.json"), "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)

    import tarfile
    with tarfile.open(OUT, "w:gz") as tf:
        for name in os.listdir(STAGE):
            tf.add(os.path.join(STAGE, name), arcname=name)
    print(f"[stage] {OUT} {os.path.getsize(OUT)} bytes")


if __name__ == "__main__":
    main()
