# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""Loopback leases: this laptop's identity and address, a league's lease table, a fleet register.

    python tools/leases.py --this-laptop [--device-file FILE]
            this laptop's device key, its pinned 127 address and the fleet register it belongs to
    python tools/leases.py --enroll FLEET_FILE [--device-file FILE] [--pool 127.16.0.0/12]
            enrol this laptop in a fleet register (one lease table every laptop of the club or league shares):
            it keeps its pinned address when no other laptop holds it there, and pins the address it is given
    python tools/leases.py [--data DIR | --file FILE] [KEY ...]
            list a lease table (a league's, or a fleet register), or look up device keys and IP addresses in it

Only --enroll writes (one lease line in the register, and the pin in this laptop's device file). Leases are made by
a host or an enrolment and never change or expire.
"""
import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "photon"))
from host.device import Device, DeviceError  # noqa: E402
from host.loopback import DEFAULT_POOL, HEADER_RE, LeaseTable, LoopbackError, Pool, client_key, slot_of  # noqa: E402


def main(argv):
    ap = argparse.ArgumentParser(prog="leases", description=__doc__.split("\n")[0])
    ap.add_argument("--data", default=os.path.join(ROOT, "runtime"))
    ap.add_argument("--file", default=None)
    ap.add_argument("--pool", default=DEFAULT_POOL)
    ap.add_argument("--device-file", default=None)
    ap.add_argument("--this-laptop", action="store_true")
    ap.add_argument("--enroll", default=None, metavar="FLEET_FILE")
    ap.add_argument("key", nargs="*")
    ns = ap.parse_args(argv)

    if ns.this_laptop:
        dev = Device.load(ns.device_file, create=False)
        if dev is None:
            print("this laptop has no device file yet: the first start of the host, or --enroll, makes it")
            return 0
        r = dev.report()
        print(f"{r['label']}  ({r['device']}, from the {'machine identifier' if r['source'] == 'machine' else 'random identity'})\n"
              f"  pinned address  {r['address'] or 'none yet'}" + (f" in {r['pool']}" if r['pool'] else "") + "\n"
              f"  fleet register  {r['fleet'] or 'none'}\n  device file     {r['file']}")
        for n in dev.notes:
            print("  note: " + n)
        return 0

    if ns.enroll:
        try:
            dev = Device.load(ns.device_file)
            pool = Pool(ns.pool)
            pin = dev.address if dev.pool == pool.text else None
            fleet = LeaseTable(os.path.abspath(ns.enroll), pool=ns.pool, max_leases=min(65536, pool.capacity), create_dirs=False)
            addr, _, fresh, moved = fleet.lease(dev.key, prefer=pin)
            dev.pin(addr, pool.text, fleet=os.path.abspath(ns.enroll))
        except (DeviceError, LoopbackError, OSError) as e:
            print(f"REFUSED: {e}", file=sys.stderr)
            return 1
        print(f"{dev.label}: {addr} in the fleet register {os.path.abspath(ns.enroll)} ({'enrolled now' if fresh else 'already enrolled'})")
        if moved:
            print(f"  another laptop of the register holds {pin}; this laptop's address is now {addr} everywhere")
        return 0

    path = ns.file or os.path.join(ns.data, "loopback", "leases")
    rows, pool_text, v6, fmt = [], ns.pool, 128, None
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            lines = f.read().split("\n")
        h = HEADER_RE.match(lines[0]) if lines else None
        if not h:
            print(f"{path}: not a lease table", file=sys.stderr)
            return 1
        fmt, pool_text, v6 = int(h.group(1)), h.group(2), int(h.group(3))
        rows = [ln.split(" ") for ln in lines[1:] if ln.strip()]
    try:
        pool = Pool(pool_text)
    except LoopbackError as e:
        print(str(e), file=sys.stderr)
        return 1
    by_key = {r[1]: r for r in rows if len(r) == 4}
    if ns.key:
        for a in ns.key:
            key = client_key(a, v6)
            if key is None:
                print(f"{a}: neither a device key nor an IP address")
            elif key in by_key:
                print(f"{a}: {by_key[key][0]} (leased {by_key[key][2]})")
            else:
                print(f"{a}: no lease yet; it would be offered {pool.address_at(slot_of(key, pool.capacity))} first")
        return 0
    devices = sum(1 for r in rows if len(r) == 4 and r[1].startswith("device:"))
    print(f"{path}\nformat {fmt or '—'} · pool {pool.text} · capacity {pool.capacity} · IPv6 keys /{v6} · "
          f"{len(rows)} lease{'' if len(rows) == 1 else 's'} ({devices} laptop{'' if devices == 1 else 's'})")
    for r in rows:
        if len(r) != 4:
            print("  (damaged line)")
        else:
            print(f"  {r[0]:<16} {('device ' + r[1][7:15]) if r[1].startswith('device:') else r[1]:<40} {r[2]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
