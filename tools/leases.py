# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""Read a loopback lease table: which IP address holds which 127.x.y.z address, and since when.

    python tools/leases.py [--data DIR | --file FILE] [--pool 127.16.0.0/12] [ADDRESS ...]

With addresses, prints the lease each one holds (or would be offered first, if it has none yet). The table is only
read: leases are made by the host when an address first starts it, and never change or expire.
"""
import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "photon"))
from host.loopback import DEFAULT_POOL, HEADER_RE, LoopbackError, Pool, client_key, slot_of  # noqa: E402


def main(argv):
    ap = argparse.ArgumentParser(prog="leases", description=__doc__.split("\n")[0])
    ap.add_argument("--data", default=os.path.join(ROOT, "runtime"))
    ap.add_argument("--file", default=None)
    ap.add_argument("--pool", default=DEFAULT_POOL)
    ap.add_argument("address", nargs="*")
    ns = ap.parse_args(argv)
    path = ns.file or os.path.join(ns.data, "loopback", "leases")
    rows, pool_text, v6 = [], ns.pool, 128
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            lines = f.read().split("\n")
        h = HEADER_RE.match(lines[0]) if lines else None
        if not h:
            print(f"{path}: not a lease table", file=sys.stderr)
            return 1
        pool_text, v6 = h.group(2), int(h.group(3))
        rows = [ln.split(" ") for ln in lines[1:] if ln.strip()]
    try:
        pool = Pool(pool_text)
    except LoopbackError as e:
        print(str(e), file=sys.stderr)
        return 1
    by_key = {r[1]: r for r in rows if len(r) == 4}
    if ns.address:
        for a in ns.address:
            key = client_key(a, v6)
            if key is None:
                print(f"{a}: not an IP address")
            elif key in by_key:
                print(f"{a}: {by_key[key][0]} (leased {by_key[key][2]})")
            else:
                print(f"{a}: no lease yet; it would be offered {pool.address_at(slot_of(key, pool.capacity))} first")
        return 0
    print(f"{path}\npool {pool.text} · capacity {pool.capacity} · IPv6 keys /{v6} · {len(rows)} lease{'' if len(rows) == 1 else 's'}")
    for r in rows:
        print("  " + "  ".join(r[:3]) if len(r) == 4 else "  (damaged line)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
