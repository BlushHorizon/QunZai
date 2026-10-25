"""Rewrite an ELF64 binary's DT_RUNPATH/DT_RPATH to $ORIGIN/../lib.

Termux binaries carry RUNPATH=/data/data/com.termux/files/usr/lib, which does
not exist on a stock Android device (and under the emulator's arm64
translation layer the LD_LIBRARY_PATH override is not honoured).  Pointing
RUNPATH at $ORIGIN/../lib makes the dynamic linker find the bundled .so
files relative to the binary itself, so the runtime works from any folder.

Only rewrites in place when the replacement is not longer than the current
string; the remaining bytes are NUL-padded.
"""
import struct
import sys

NEW = b"$ORIGIN/../lib"


def patch(path, new=NEW):
    with open(path, "rb") as fh:
        data = bytearray(fh.read())
    assert data[:4] == b"\x7fELF" and data[4] == 2, "only ELF64"
    e_phoff = struct.unpack_from("<Q", data, 32)[0]
    e_phentsize = struct.unpack_from("<H", data, 54)[0]
    e_phnum = struct.unpack_from("<H", data, 56)[0]
    loads, dyn_off, dyn_sz = [], None, None
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type = struct.unpack_from("<I", data, off)[0]
        p_offset = struct.unpack_from("<Q", data, off + 8)[0]
        p_vaddr = struct.unpack_from("<Q", data, off + 16)[0]
        p_filesz = struct.unpack_from("<Q", data, off + 32)[0]
        if p_type == 1:
            loads.append((p_vaddr, p_offset, p_filesz))
        elif p_type == 2:
            dyn_off, dyn_sz = p_offset, p_filesz

    def v2o(vaddr):
        for pv, po, ps in loads:
            if pv <= vaddr < pv + ps:
                return po + (vaddr - pv)
        return None

    strtab_va = None
    entries = []
    for i in range(dyn_sz // 16):
        d_tag, d_val = struct.unpack_from("<qQ", data, dyn_off + i * 16)
        entries.append((d_tag, d_val))
        if d_tag == 5:
            strtab_va = d_val
        if d_tag == 0:
            break
    stro = v2o(strtab_va)

    def s(idx):
        end = data.index(b"\x00", stro + idx)
        return bytes(data[stro + idx:end])

    changed = False
    for d_tag, d_val in entries:
        if d_tag not in (15, 29):  # DT_RPATH / DT_RUNPATH
            continue
        cur = s(d_val)
        print(f"  {path}: current {'rpath' if d_tag == 15 else 'runpath'} = {cur!r}")
        if len(new) > len(cur):
            print("  ! replacement longer than the existing string, skipped")
            continue
        off = stro + d_val
        data[off:off + len(new)] = new
        data[off + len(new):off + len(cur)] = b"\x00" * (len(cur) - len(new))
        changed = True
        print(f"  -> patched to {new!r}")
    if changed:
        with open(path, "wb") as fh:
            fh.write(data)
    return changed


if __name__ == "__main__":
    ok = False
    for p in sys.argv[1:]:
        ok = patch(p) or ok
    sys.exit(0 if ok else 1)
