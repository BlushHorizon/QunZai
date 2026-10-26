"""Strip version suffixes from an ELF64 library's DT_SONAME, and rewrite the
DT_NEEDED entries of the binaries that depend on it.

Why this exists
---------------
Android's build system (AGP) only packages files whose name ends in ``.so``
into ``jniLibs``.  A library like ``libz.so.1`` is therefore *dropped* from
the APK, and the dynamic linker on a real device fails with

    CANNOT LINK EXECUTABLE "node": library "libz.so.1" not found

The libraries must therefore be renamed to plain ``*.so`` names *and* the
``DT_NEEDED`` entries of every dependent binary must be rewritten to match,
otherwise the linker looks for a name that no longer exists.

The bundled runtime is used by:

    node            -> libz.so.1, libcares.so, libsqlite3.so, libffi.so,
                       libcrypto.so.3, libssl.so.3, libicui18n.so.78,
                       libicuuc.so.78, libc++_shared.so
    libsqlite3.so  -> libz.so.1
    libssl.so.3    -> libcrypto.so.3
    libicui18n.so.78 -> libicuuc.so.78, libc++_shared.so
    libicuuc.so.78 -> libicudata.so.78, libc++_shared.so

So the rename table is:

    libz.so.1        -> libz.so
    libcrypto.so.3   -> libcrypto.so
    libssl.so.3      -> libssl.so
    libicui18n.so.78 -> libicui18n.so
    libicuuc.so.78   -> libicuuc.so
    libicudata.so.78 -> libicudata.so

``libcares.so`` / ``libffi.so`` / ``libsqlite3.so`` / ``libc++_shared.so``
already have plain names and stay as they are.

The rewrite is done in place on the dynamic string table: a name is only
replaced when the new name is *not longer* than the old one, otherwise the
remaining bytes are NUL-padded (a shorter string is a valid ELF name).

Note on ``libicudata.so.78``: it is 33 MB of data, not code, but it is still
a DT_NEEDED of libicuuc, so it has to be renamed and shipped as well.
"""
import os
import shutil
import struct
import sys

# soname (as it appears in DT_NEEDED) -> new name without version suffix
RENAME = {
    "libz.so.1": "libz.so",
    "libcrypto.so.3": "libcrypto.so",
    "libssl.so.3": "libssl.so",
    "libicui18n.so.78": "libicui18n.so",
    "libicuuc.so.78": "libicuuc.so",
    "libicudata.so.78": "libicudata.so",
    # The system already ships /system/lib64/libc++_shared.so.  If the linker
    # ever resolves that one instead of ours, Termux's C++ runtime gets mixed
    # with the platform's and symbols mismatch.  A unique name removes the
    # ambiguity entirely.  It has to be *shorter* than the original, because
    # the rewrite happens in place in the ELF string table.
    "libc++_shared.so": "libc++_qz.so",
}


class Elf:
    """Minimal ELF64 reader/writer for the dynamic section."""

    def __init__(self, path):
        self.path = path
        with open(path, "rb") as fh:
            self.data = bytearray(fh.read())
        d = self.data
        assert d[:4] == b"\x7fELF" and d[4] == 2, "only ELF64"
        self.e_machine = struct.unpack_from("<H", d, 18)[0]
        e_phoff = struct.unpack_from("<Q", d, 32)[0]
        e_phentsize = struct.unpack_from("<H", d, 54)[0]
        e_phnum = struct.unpack_from("<H", d, 56)[0]
        self.loads = []
        self.dyn_off = self.dyn_sz = None
        for i in range(e_phnum):
            off = e_phoff + i * e_phentsize
            p_type = struct.unpack_from("<I", d, off)[0]
            p_offset = struct.unpack_from("<Q", d, off + 8)[0]
            p_vaddr = struct.unpack_from("<Q", d, off + 16)[0]
            p_filesz = struct.unpack_from("<Q", d, off + 32)[0]
            if p_type == 1:
                self.loads.append((p_vaddr, p_offset, p_filesz))
            elif p_type == 2:
                self.dyn_off, self.dyn_sz = p_offset, p_filesz
        self.entries = []
        self.strtab_va = None
        if self.dyn_off is not None:
            for i in range(self.dyn_sz // 16):
                d_tag, d_val = struct.unpack_from("<qQ", d, self.dyn_off + i * 16)
                self.entries.append((d_tag, d_val))
                if d_tag == 5:
                    self.strtab_va = d_val
                if d_tag == 0:
                    break
        self.strtab_off = self.v2o(self.strtab_va) if self.strtab_va else None

    def v2o(self, vaddr):
        for pv, po, ps in self.loads:
            if pv <= vaddr < pv + ps:
                return po + (vaddr - pv)
        return None

    def str_at(self, idx):
        end = self.data.index(b"\x00", self.strtab_off + idx)
        return bytes(self.data[self.strtab_off + idx:end]).decode("utf-8", "replace")

    def str_offset(self, idx):
        return self.strtab_off + idx

    def needed(self):
        return [self.str_at(v) for t, v in self.entries if t == 1]

    def soname(self):
        for t, v in self.entries:
            if t == 14:
                return self.str_at(v)
        return None

    def write(self):
        with open(self.path, "wb") as fh:
            fh.write(self.data)


def rewrite_string(elf, idx, new):
    """Overwrite the string at strtab offset idx with `new` (NUL padded)."""
    old = elf.str_at(idx)
    if len(new) > len(old):
        return False
    off = elf.str_offset(idx)
    elf.data[off:off + len(new)] = new.encode("utf-8")
    elf.data[off + len(new):off + len(old)] = b"\x00" * (len(old) - len(new))
    return True


def patch_needed(path, report):
    """Rewrite DT_NEEDED entries of `path` according to RENAME."""
    elf = Elf(path)
    changed = False
    for t, v in list(elf.entries):
        if t != 1:
            continue
        cur = elf.str_at(v)
        new = RENAME.get(cur)
        if not new:
            continue
        if rewrite_string(elf, v, new):
            report.append(f"    DT_NEEDED {cur} -> {new}")
            changed = True
    if changed:
        elf.write()
    return changed


def patch_soname(path, report):
    """Rewrite DT_SONAME of `path` according to RENAME."""
    elf = Elf(path)
    for t, v in elf.entries:
        if t == 14:
            cur = elf.str_at(v)
            new = RENAME.get(cur)
            if new and rewrite_string(elf, v, new):
                report.append(f"    DT_SONAME {cur} -> {new}")
                elf.write()
                return True
    return False


def main():
    if len(sys.argv) < 2:
        print("usage: strip_so_versions.py <runtime-dir> [<runtime-dir> ...]")
        return 1
    ok = True
    for root in sys.argv[1:]:
        lib = os.path.join(root, "lib")
        if not os.path.isdir(lib):
            print(f"  ! no lib dir: {lib}")
            ok = False
            continue
        print(f"== {root}")
        # 0) 清理上一轮改名留下的残骸（例如 libc++_shared_qz.so），
        #    避免目录里同时存在两个 C++ 运行时，linker 挑到旧的那个。
        for name in sorted(os.listdir(lib)):
            if name in RENAME.values():
                continue
            base = name.split("_qz.so")[0]
            stale = base + "_qz.so"
            if stale in RENAME.values() and name.endswith("_qz.so"):
                os.remove(os.path.join(lib, name))
                print(f"  removed stale {name}")
        # 1) rename the library files themselves
        for old, new in RENAME.items():
            src = os.path.join(lib, old)
            if not os.path.exists(src):
                continue
            dst = os.path.join(lib, new)
            if os.path.exists(dst):
                os.remove(dst)
            os.rename(src, dst)
            print(f"  renamed {old} -> {new}")
        # 2) fix DT_SONAME inside each library
        for name in sorted(os.listdir(lib)):
            p = os.path.join(lib, name)
            if not os.path.isfile(p) or not name.endswith(".so"):
                continue
            patch_soname(p, [])
        # 3) fix DT_NEEDED in the node binary and in every library
        targets = [os.path.join(root, "bin", "node")]
        targets += [os.path.join(lib, n) for n in sorted(os.listdir(lib))
                    if os.path.isfile(os.path.join(lib, n)) and n.endswith(".so")]
        for p in targets:
            if not os.path.exists(p):
                continue
            report = []
            if patch_needed(p, report):
                print(f"  patched {os.path.relpath(p, root)}")
                for line in report:
                    print(line)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
