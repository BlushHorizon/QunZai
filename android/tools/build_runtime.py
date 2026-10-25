"""Build the final Android runtime tree for Node 26 (Termux binaries).

Steps:
  1. copy the extracted Termux root into a staging tree
  2. create soname aliases the node binary actually asks for
  3. collect CA certificates into a single bundle for NODE_EXTRA_CA_CERTS
"""
import os
import shutil
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "termux/root"
DST = sys.argv[2] if len(sys.argv) > 2 else "android-runtime"
LIB = os.path.join(DST, "lib")

# soname -> file we actually have
ALIASES = {
    "libicui18n.so.78": "libicui18n.so.78.3",
    "libicuuc.so.78": "libicuuc.so.78.3",
    "libicudata.so.78": "libicudata.so.78.3",
    "libsqlite3.so": "libsqlite3.so.3.54.1",
    "libz.so.1": "libz.so.1.3.2",
    "libcrypto.so.3": "libcrypto.so.3",
    "libssl.so.3": "libssl.so.3",
}

CA_SOURCES = [
    "usr/etc/tls/certs/ca-certificates.crt",
    "usr/etc/ssl/certs/ca-certificates.crt",
    "etc/ssl/certs/ca-certificates.crt",
]


def main():
    os.makedirs(LIB, exist_ok=True)
    src_lib = os.path.join(SRC, "usr", "lib")
    skip = ("pkgIndex.tcl",)
    for name in os.listdir(src_lib):
        p = os.path.join(src_lib, name)
        if not os.path.isfile(p) or name in skip:
            continue
        shutil.copy2(p, os.path.join(LIB, name))

    # node binary
    os.makedirs(os.path.join(DST, "bin"), exist_ok=True)
    shutil.copy2(os.path.join(SRC, "usr", "bin", "node"),
                 os.path.join(DST, "bin", "node"))
    os.chmod(os.path.join(DST, "bin", "node"), 0o755)

    # soname aliases
    for alias, target in ALIASES.items():
        if alias == target:
            continue
        src = os.path.join(LIB, target)
        if not os.path.exists(src):
            print(f"  ! missing base for alias {alias} -> {target}")
            continue
        dst = os.path.join(LIB, alias)
        if os.path.exists(dst):
            os.remove(dst)
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)

    # CA bundle
    ca_out = os.path.join(DST, "ca-bundle.crt")
    parts = []
    for rel in CA_SOURCES:
        p = os.path.join(SRC, rel.replace("/", os.sep))
        if os.path.exists(p):
            parts.append(open(p, encoding="utf-8", errors="replace").read())
    if not parts:
        # Termux keeps the trust store as a directory of hashed .0 files.
        for cand in ("usr/etc/tls/certs", "usr/share/ca-certificates",
                     "etc/ssl/certs", "system/etc/security/cacerts"):
            certdir = os.path.join(SRC, cand.replace("/", os.sep))
            if not os.path.isdir(certdir):
                continue
            for name in sorted(os.listdir(certdir)):
                f = os.path.join(certdir, name)
                if not os.path.isfile(f):
                    continue
                try:
                    body = open(f, encoding="utf-8", errors="replace").read()
                except OSError:
                    continue
                if "BEGIN CERTIFICATE" in body:
                    parts.append(body)
            if parts:
                break
    with open(ca_out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts))
    print(f"CA bundle: {len(parts)} part(s), {os.path.getsize(ca_out)} bytes")

    total = sum(os.path.getsize(os.path.join(LIB, f)) for f in os.listdir(LIB))
    node_sz = os.path.getsize(os.path.join(DST, "bin", "node"))
    print(f"lib dir: {len(os.listdir(LIB))} files, {total} bytes")
    print(f"node: {node_sz} bytes")
    print(f"runtime total: {total + node_sz + os.path.getsize(ca_out)} bytes")


if __name__ == "__main__":
    main()
