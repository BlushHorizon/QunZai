"""Minimal ELF64 dynamic-section reader: dump DT_NEEDED / DT_RPATH / DT_RUNPATH / DT_SONAME."""
import struct
import sys

DT_NAMES = {
    0: "DT_NULL", 1: "DT_NEEDED", 2: "DT_PLTRELSZ", 3: "DT_PLTGOT", 4: "DT_HASH",
    5: "DT_STRTAB", 6: "DT_SYMTAB", 7: "DT_RELA", 8: "DT_RELASZ", 9: "DT_RELAENT",
    10: "DT_STRSZ", 11: "DT_SYMENT", 12: "DT_INIT", 13: "DT_FINI", 14: "DT_SONAME",
    15: "DT_RPATH", 17: "DT_REL", 20: "DT_PLTREL", 21: "DT_DEBUG", 23: "DT_JMPREL",
    29: "DT_RUNPATH", 0x6ffffef5: "DT_GNU_HASH", 0x6ffffff0: "DT_VERSYM",
    0x6ffffffc: "DT_VERDEF", 0x6ffffffe: "DT_VERNEED", 0x6ffffff9: "DT_RELACOUNT",
    3: "DT_PLTGOT",
}


def read_elf(path):
    with open(path, "rb") as fh:
        data = fh.read()
    assert data[:4] == b"\x7fELF", "not ELF"
    is64 = data[4] == 2
    assert is64, "only ELF64 supported"
    e_machine = struct.unpack_from("<H", data, 18)[0]
    e_type = struct.unpack_from("<H", data, 16)[0]
    e_phoff = struct.unpack_from("<Q", data, 32)[0]
    e_phentsize = struct.unpack_from("<H", data, 54)[0]
    e_phnum = struct.unpack_from("<H", data, 56)[0]

    loads = []
    dyn_off = dyn_sz = None
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type = struct.unpack_from("<I", data, off)[0]
        p_offset = struct.unpack_from("<Q", data, off + 8)[0]
        p_vaddr = struct.unpack_from("<Q", data, off + 16)[0]
        p_filesz = struct.unpack_from("<Q", data, off + 32)[0]
        if p_type == 1:  # PT_LOAD
            loads.append((p_vaddr, p_offset, p_filesz))
        elif p_type == 2:  # PT_DYNAMIC
            dyn_off = p_offset
            dyn_sz = p_filesz

    def v2o(vaddr):
        for pv, po, ps in loads:
            if pv <= vaddr < pv + ps:
                return po + (vaddr - pv)
        return None

    out = {"machine": e_machine, "type": e_type, "needed": [], "rpath": None, "runpath": None, "soname": None}
    if dyn_off is None:
        return out
    strtab_va = strsz = None
    entries = []
    for i in range(dyn_sz // 16):
        d_tag, d_val = struct.unpack_from("<qQ", data, dyn_off + i * 16)
        entries.append((d_tag, d_val))
        if d_tag == 5:
            strtab_va = d_val
        elif d_tag == 10:
            strsz = d_val
        if d_tag == 0:
            break
    if strtab_va is None:
        return out
    stro = v2o(strtab_va)
    if stro is None:
        return out

    def s(idx):
        end = data.index(b"\x00", stro + idx)
        return data[stro + idx:end].decode("utf-8", "replace")

    for d_tag, d_val in entries:
        if d_tag == 1:
            out["needed"].append(s(d_val))
        elif d_tag == 15:
            out["rpath"] = s(d_val)
        elif d_tag == 29:
            out["runpath"] = s(d_val)
        elif d_tag == 14:
            out["soname"] = s(d_val)
    return out


if __name__ == "__main__":
    for p in sys.argv[1:]:
        r = read_elf(p)
        print("==", p)
        print("  machine:", r["machine"], "(62=x86_64, 183=aarch64)  type:", r["type"], "(3=shared/dyn)")
        print("  soname:", r["soname"])
        print("  rpath:", r["rpath"], " runpath:", r["runpath"])
        print("  needed:", r["needed"])
