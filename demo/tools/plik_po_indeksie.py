#!/usr/bin/env python3
"""Pobiera cały plik z agregatu PoRep po numerze wpisu w indeksie Data Segment (FRC-0058).

Użycie: plik_po_indeksie.py <URL SP> <PieceCID v2 agregatu> [numer wpisu] [plik wyjściowy]
Przez HTTP idzie tylko: końcówka agregatu z indeksem oraz bajty wybranego pliku (Range).
"""
import base64, hashlib, sys, urllib.request

def get(url, start, end):
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req) as r:
        return r.read()

def uvarint(b, i=0):
    x = s = 0
    while True:
        c = b[i]; i += 1
        x |= (c & 0x7F) << s; s += 7
        if c < 0x80: return x, i

def piece_v2(cid):
    """PieceCID v2 (FRC-0069): multihash = uvarint(padding) | wysokość drzewa | korzeń CommP."""
    raw = base64.b32decode(cid[1:].upper() + "=" * (-len(cid[1:]) % 8))
    i = 0
    for _ in range(4): _, i = uvarint(raw, i)   # wersja CID, kodek, kod multihasha, długość digestu
    padding, i = uvarint(raw, i)
    height = raw[i]; root = raw[i + 1:i + 33]
    padded = 32 << height
    return root, padded, padded * 127 // 128 - padding

def fr32_pad(data):
    """127 bajtów → 4 × 254 bity, każde w 32 bajtach (tak SP zapisuje dane w drzewie CommP)."""
    out = bytearray()
    for k in range(0, len(data), 127):
        n = int.from_bytes(data[k:k + 127], "little")
        for j in range(4):
            out += ((n >> (254 * j)) & ((1 << 254) - 1)).to_bytes(32, "little")
    return bytes(out)

sp, agg = sys.argv[1], sys.argv[2]
want = int(sys.argv[3]) if len(sys.argv) > 3 else None
url = f"{sp}/piece/{agg}"

_, agg_padded, _ = piece_v2(agg)
# Indeks leży na końcu agregatu: max wpisów = rozmiar/2048/64 (go-data-segment MaxIndexEntriesInDeal), wpis = 64 B.
x = agg_padded // 2048 // 64
n_entries = max(4, 1 << (x - 1).bit_length()) if x > 0 else 4
idx_padded = n_entries * 64
idx_start = (agg_padded - idx_padded) * 127 // 128
idx = fr32_pad(get(url, idx_start, idx_start + idx_padded * 127 // 128 - 1))
print(f"agregat {agg[:20]}… ({agg_padded} B), indeks: {n_entries} miejsc od bajtu {idx_start}")

entries = []
for e in range(n_entries):
    rec = idx[e * 64:(e + 1) * 64]
    root, off, size = rec[:32], int.from_bytes(rec[32:40], "little"), int.from_bytes(rec[40:48], "little")
    if size == 0: continue
    ok = hashlib.sha256(rec[:48] + bytes(16)).digest()[:16]   # go-data-segment computeChecksum
    ok = bytes(ok[:15]) + bytes([ok[15] & 0x3F]) == rec[48:64]
    entries.append((root, off, size))
    print(f"  [{len(entries) - 1}] offset {off * 127 // 128:>8} (padded {off}), miejsce {size} B, "
          f"CommP {root.hex()[:16]}…, suma kontrolna {'OK' if ok else 'ZŁA'}")

if want is None: sys.exit(0)
root, off, size = entries[want]
start = off * 127 // 128
data = get(url, start, start + size * 127 // 128 - 1)
print(f"\nwpis [{want}]: pobrano {len(data)} B (całe miejsce w agregacie, z zerami na końcu)")
if len(sys.argv) > 5:                     # opcjonalnie: PieceCID v2 pliku → dokładna długość
    croot, _, rawsize = piece_v2(sys.argv[5])
    assert croot == root, "ten PieceCID nie pasuje do wpisu w indeksie"
    data = data[:rawsize]
    print(f"PieceCID v2 pliku zgadza się z wpisem, przycięto do {rawsize} B")
out = sys.argv[4] if len(sys.argv) > 4 else f"wpis{want}.bin"
open(out, "wb").write(data)
print(f"zapisano {out}, sha256 {hashlib.sha256(data).hexdigest()[:16]}…")
