"""Build the CA bundle for the Android Node runtimes.

The Termux ca-certificates deb ships the trust store as
  usr/etc/tls/cert.pem
but extract_debs.py only keeps usr/bin, usr/lib, usr/share and lib, so the
file was never unpacked and the runtime's ca-bundle.crt came out empty
(0 bytes -> every TLS handshake fails with a certificate error).
"""
import os
import sys
import tarfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inspect_ca import ar_members, real_name  # noqa: E402

DEB = sys.argv[1]
OUTS = sys.argv[2:]

mems = ar_members(DEB)
data = mems.get("data.tar.xz") or mems.get("data.tar.gz") or mems.get("data.tar.zst")
tmp = DEB + ".data"
with open(tmp, "wb") as fh:
    fh.write(data)
mode = "r:xz" if "data.tar.xz" in mems else ("r:gz" if "data.tar.gz" in mems else "r:*")
bundle = None
with tarfile.open(tmp, mode) as tf:
    for m in tf.getmembers():
        if not m.isfile():
            continue
        name = real_name(m.name)
        if name in ("usr/etc/tls/cert.pem", "etc/ssl/certs/ca-certificates.crt",
                    "usr/etc/ssl/certs/ca-certificates.crt"):
            src = tf.extractfile(m)
            bundle = src.read()
            print("using", name, len(bundle), "bytes")
            break
os.remove(tmp)
if bundle is None:
    raise SystemExit("no CA file found in " + DEB)
for out in OUTS:
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as fh:
        fh.write(bundle)
    print("wrote", out, os.path.getsize(out), "bytes")
