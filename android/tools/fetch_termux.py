"""Resolve + download Termux nodejs deb and its shared-library deps from a mirror.

Reads the Packages index, walks Depends (first alternative only), downloads each
deb with a resume loop, and extracts the .so payloads we care about.
"""
import gzip
import io
import os
import subprocess
import sys
import tarfile
import urllib.request

MIRROR = "https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main"
ARCH = sys.argv[1] if len(sys.argv) > 1 else "aarch64"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/d/qz-build/termux"
DEB_DIR = os.path.join(OUT, "debs")
os.makedirs(DEB_DIR, exist_ok=True)

WANT = ["nodejs"]
SKIP = {"nodejs-dev", "nodejs-lts", "nodejs-current", "npm", "nodejs-dep"}


def fetch(url, dest, expect=None):
    """Download with resume; returns final size or None on failure."""
    for attempt in range(40):
        have = os.path.getsize(dest) if os.path.exists(dest) else 0
        if expect and have >= expect:
            return have
        cmd = ["curl", "-sSL", "-C", "-", "--max-time", "180",
               "--speed-limit", "1024", "--speed-time", "30", "-o", dest, url]
        subprocess.run(cmd, check=False)
        now = os.path.getsize(dest) if os.path.exists(dest) else 0
        if expect and now >= expect:
            return now
        if not expect and now > 0:
            return now
    return None


def load_index():
    url = f"{MIRROR}/dists/stable/main/binary-{ARCH}/Packages.gz"
    raw = subprocess.run(["curl", "-sSL", "--max-time", "180", url],
                         capture_output=True, check=False).stdout
    if not raw:
        raise SystemExit("failed to fetch Packages.gz")
    text = gzip.decompress(raw).decode("utf-8", "replace")
    pkgs = {}
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        fields = {}
        key = None
        for line in block.split("\n"):
            if line.startswith((" ", "\t")) and key:
                fields[key] += "\n" + line.strip()
            elif ":" in line:
                key, _, val = line.partition(":")
                fields[key] = val.strip()
        name = fields.get("Package")
        if name:
            pkgs[name] = fields
    return pkgs


def all_deps(dep_str):
    """Every comma-separated dependency (first alternative of each)."""
    out = []
    for chunk in (dep_str or "").split(","):
        alt = chunk.split("|")[0].strip()
        if not alt:
            continue
        pkg = alt.split()[0]
        if pkg:
            out.append(pkg)
    return out


def main():
    pkgs = load_index()
    print(f"index entries: {len(pkgs)}")
    resolved = {}
    queue = list(WANT)
    while queue:
        name = queue.pop(0)
        if name in resolved or name in SKIP:
            continue
        meta = pkgs.get(name)
        if not meta:
            print(f"  ! missing in index: {name}")
            continue
        resolved[name] = meta
        for dep in all_deps(meta.get("Depends", "")):
            if dep not in resolved:
                queue.append(dep)

    print("resolved:", sorted(resolved))
    for name, meta in sorted(resolved.items()):
        fname = meta["Filename"]
        url = f"{MIRROR}/{fname}"
        # Debian epoch/version separators use ':' which is illegal on Windows.
        local = os.path.basename(fname).replace(":", "_")
        dest = os.path.join(DEB_DIR, local)
        size = int(meta.get("Size", 0))
        if os.path.exists(dest) and os.path.getsize(dest) == size:
            print(f"  = {name} cached {size}")
            continue
        got = fetch(url, dest, size)
        status = "OK" if got == size else f"MISMATCH got={got} want={size}"
        print(f"  + {name} {status}")
        if got != size:
            if os.path.exists(dest):
                os.remove(dest)
            print(f"  ! FAILED {name}")
    with open(os.path.join(OUT, "resolved.txt"), "w") as fh:
        for name, meta in sorted(resolved.items()):
            fh.write(f"{name}\t{meta['Filename']}\t{meta.get('Size')}\n")
    print("done")

if __name__ == "__main__":
    main()
