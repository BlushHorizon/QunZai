import struct, sys, os
PAGE=16384
def segs(path):
    with open(path,'rb') as f:
        d=f.read(64)
        if d[:4]!=b'\x7fELF': return None
        is64=d[4]==2
        if is64:
            e_phoff=struct.unpack_from('<Q',d,32)[0]; e_phes=struct.unpack_from('<H',d,54)[0]; e_phnum=struct.unpack_from('<H',d,56)[0]
        else:
            e_phoff=struct.unpack_from('<I',d,28)[0]; e_phes=struct.unpack_from('<H',d,42)[0]; e_phnum=struct.unpack_from('<H',d,44)[0]
        f.seek(e_phoff); ph=f.read(e_phes*e_phnum)
        out=[]
        for i in range(e_phnum):
            o=i*e_phes
            if is64:
                t=struct.unpack_from('<I',ph,o)[0]; off=struct.unpack_from('<Q',ph,o+8)[0]
                va=struct.unpack_from('<Q',ph,o+16)[0]; fsz=struct.unpack_from('<Q',ph,o+32)[0]
                al=struct.unpack_from('<Q',ph,o+48)[0]
            else:
                t=struct.unpack_from('<I',ph,o)[0]; off=struct.unpack_from('<I',ph,o+4)[0]
                va=struct.unpack_from('<I',ph,o+8)[0]; fsz=struct.unpack_from('<I',ph,o+16)[0]
                al=struct.unpack_from('<I',ph,o+28)[0]
            if t==1: out.append((off,va,fsz,al))
        return out
bad=[]
for root in sys.argv[1:]:
    for dp,_,fs in os.walk(root):
        for fn in sorted(fs):
            if not (fn.endswith('.so') or fn=='node'): continue
            p=os.path.join(dp,fn); s=segs(p)
            if not s: continue
            prob=[]
            for off,va,fsz,al in s:
                if al % PAGE != 0: prob.append(f"align={al}")
                if (va-off) % PAGE != 0: prob.append(f"va-off={va-off}")
            if prob: bad.append((p,prob))
            print(f"{'OK ' if not prob else 'BAD'} {p} {';'.join(sorted(set(prob)))[:70]}")
print("--- bad:",len(bad))
