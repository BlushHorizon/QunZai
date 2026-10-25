"""Extract Termux .deb payloads into a flat runtime tree.

Debs: ar archive with debian-binary / control.tar.xz / data.tar.xz members.
We unpack data.tar.xz and copy the interesting files into an output root.
"""
import os
import shutil
import sys
import tarfile

DEB_DIR = sys.argv[1]
OUT = sys.argv[2]
KEEP_PREFIXES = (
    "usr/bin/",
    "usr/lib/",
    "usr/share/",
    "lib/",
)
# Termux debs unpack under ./data/data/com.termux/files/<real path>
TERMUX_PREFIX = "./data/data/com.termux/files/"


def real_name(name):
    """Strip the Termux packaging prefix; return the path inside $PREFIX."""
    if name.startswith(TERMUX_PREFIX):
        return name[len(TERMUX_PREFIX):]
    if name.startswith("./"):
        name = name[2:]
    if name.startswith("data/data/com.termux/files/"):
        return name[len("data/data/com.termux/files/"):]
    return name


def ar_members(path):
    data = open(path, "rb").read()
    if data[:8] != b"!<arch>\n":
        raise SystemExit(f"{path} is not an ar archive")
    off = 8
    out = {}
    while off + 60 <= len(data):
        hdr = data[off:off + 60]
        name = hdr[0:16].decode("latin1").strip().rstrip("/")
        size = int(hdr[48:58].decode("latin1").strip())
        out[name] = data[off + 60:off + 60 + size]
        off += 60 + size + (size % 2)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    for deb in sorted(os.listdir(DEB_DIR)):
        if not deb.endswith(".deb"):
            continue
        path = os.path.join(DEB_DIR, deb)
        mems = ar_members(path)
        data = mems.get("data.tar.xz") or mems.get("data.tar.gz") or mems.get("data.tar.zst")
        if data is None:
            print(f"{deb}: no data member ({list(mems)})")
            continue
        mode = "r:xz" if "data.tar.xz" in mems else ("r:gz" if "data.tar.gz" in mems else "r:*")
        tmp = os.path.join(DEB_DIR, deb + ".data")
        with open(tmp, "wb") as fh:
            fh.write(data)
        count = 0
        links = []
        with tarfile.open(tmp, mode) as tf:
            for member in tf.getmembers():
                name = real_name(member.name)
                if not name.startswith(KEEP_PREFIXES):
                    continue
                if member.isdir():
                    continue
                target = os.path.join(OUT, name.replace("/", os.sep))
                os.makedirs(os.path.dirname(target), exist_ok=True)
                if member.issym() or member.islnk():
                    # Remember the link; resolved after the whole tree is written.
                    links.append((target, real_name(member.linkname)))
                    continue
                src = None
                try:
                    src = tf.extractfile(member)
                except KeyError:
                    continue
                if src is None:
                    continue
                with open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                if member.mode & 0o111:
                    os.chmod(target, 0o755)
                count += 1
        os.remove(tmp)
        # Materialize symlinks as hardlinks (Windows-safe, no extra bytes).
        made = 0
        for link_path, link_target in links:
            src_path = os.path.join(OUT, link_target.replace("/", os.sep))
            if not os.path.exists(src_path):
                continue
            if os.path.exists(link_path):
                os.remove(link_path)
            try:
                os.link(src_path, link_path)
                made += 1
            except OSError:
                shutil.copyfile(src_path, link_path)
                made += 1
        print(f"{deb}: extracted {count} files, {made} links")


if __name__ == "__main__":
    main()
