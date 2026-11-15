# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""RINK-VT, LK/Vexa edition: start the Photon host.

    python photon/rinkvt.py [--data DIR] [--port N] [--device-file FILE] [--fleet FILE] [--leases FILE]
                            [--pool 127.16.0.0/12] [--no-browser] [--allow-default-browser-fallback] [--verify-only]

The host checks the release, takes the data folder for itself, opens the league, identifies this laptop and gives it
its static loopback address — the same on every network and in every league, and never another laptop's — listens on
it, and opens the workbench in an isolated Chromium-family window. Python 3.10 or newer, standard library only. No
Node.js is involved anywhere.
"""
import argparse
import json
import os
import secrets
import signal
import socket
import sys
import threading
import time

sys.dont_write_bytecode = True                      # nothing unchecksummed is written next to the checked release
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from host import EDITION, PRODUCT, VERSION, renderer  # noqa: E402
from host.integrity import verify_release  # noqa: E402
from host.device import Device, DeviceError  # noqa: E402
from host.loopback import DEFAULT_POOL, LeaseTable, LoopbackError, Pool  # noqa: E402
from host.server import Handler, PhotonHost  # noqa: E402
from host.store import LeagueStore, StoreError, verify_folder  # noqa: E402

EXIT = {"ok": 0, "fail": 1, "usage": 2, "integrity": 4, "locked": 5, "data": 6, "network": 7}


def alive(pid):
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False


class InstanceLock:
    """One host per data folder: two hosts appending to the same ledgers would corrupt them."""

    def __init__(self, path):
        self.path, self.held = path, False

    def acquire(self):
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
                os.write(fd, json.dumps({"pid": os.getpid(), "host": socket.gethostname(), "at": time.time()}).encode())
                os.close(fd)
                self.held = True
                return
            except FileExistsError:
                try:
                    with open(self.path, encoding="utf-8") as f:
                        cur = json.load(f)
                except (OSError, ValueError):
                    cur = {}
                if cur.get("host") == socket.gethostname() and isinstance(cur.get("pid"), int) and alive(cur["pid"]):
                    raise RuntimeError(f"the data folder is in use by process {cur['pid']}: one Photon host per data folder. "
                                       f"Stop that host, or delete {self.path} if it is gone")
                if cur.get("host") not in (None, socket.gethostname()):
                    raise RuntimeError(f"the data folder is in use by the host on {cur.get('host')}; a data folder belongs to one computer at a time")
                os.remove(self.path)                # stale: its process is gone
        raise RuntimeError("could not take the data folder")

    def holder(self):
        """Who holds the folder, without taking it: a description, or None when no live host does."""
        try:
            with open(self.path, encoding="utf-8") as f:
                cur = json.load(f)
        except (OSError, ValueError):
            return None
        if not isinstance(cur, dict):
            return None
        if cur.get("host") not in (None, socket.gethostname()):
            return f"the data folder is held by the host on {cur.get('host')}"
        if isinstance(cur.get("pid"), int) and alive(cur["pid"]) and cur["pid"] != os.getpid():
            return f"the data folder is in use by process {cur['pid']}"
        return None

    def release(self):
        if self.held:
            try:
                os.remove(self.path)
            except OSError:
                pass


def lease_this_laptop(ns):
    """Identify this laptop and give it its address: the pin its device file keeps (from its first lease, or from the
    fleet register when there is one), granted in this league's own lease table unless another laptop holds it there.
    Uniqueness within a table always wins: two laptops never share an address in one league or one register."""
    dev = Device.load(ns.device_file)
    notes = list(dev.notes)
    pool = Pool(ns.pool)                                     # refused here when it is not a valid loopback pool
    most = min(65536, pool.capacity)
    pin = dev.address if dev.pool == pool.text else None
    if dev.address and pin is None:
        notes.append(f"this laptop's pinned address {dev.address} is from the pool {dev.pool}; this start uses {pool.text}")
    fleet_path = os.path.abspath(ns.fleet) if ns.fleet else dev.fleet
    fleet_state, fleet_given = None, None
    if fleet_path:
        try:
            fleet = LeaseTable(fleet_path, pool=ns.pool, max_leases=most, create_dirs=False)
            fa, _, fresh, moved = fleet.lease(dev.key, prefer=pin)
            if moved:
                notes.append(f"the fleet register already gives {pin} to another laptop; this laptop is enrolled as {fa}")
            fleet_state = "enrolled now" if fresh else "registered"
            pin, fleet_given = fa, fleet_path
        except (LoopbackError, OSError) as e:
            fleet_state = "unreachable (" + (str(e)[:120] or type(e).__name__) + ")" + ("; the pinned address is used" if pin else "")
    table = LeaseTable(ns.leases or os.path.join(ns.data, "loopback", "leases"), pool=ns.pool, max_leases=most)
    local, _, fresh, moved = table.lease(dev.key, prefer=pin)
    conflict = None
    if moved:
        conflict = (f"in this league's lease table another laptop holds {pin}, this laptop's address; here it is {local}. "
                    "Enrol every laptop in one fleet register so that no two can meet on one address")
    if table.upgraded:
        notes.append("the league's lease table was upgraded to format 2 for device keys; every lease in it was kept")
    dev.pin(pin or local, table.pool.text, fleet=fleet_given)
    return {"local": local, "client": dev.label, "device": dev.key, "device_source": dev.source, "device_file": dev.path,
            "pinned": dev.address, "pool": table.pool.text, "leases": table.stats()["leases"], "fleet": fleet_path,
            "fleet_state": fleet_state, "conflict": conflict, "notes": notes}


def bind(local, port, token, store, info):
    """Listen on this computer's loopback lease; where the system only answers on 127.0.0.1 (macOS), there."""
    ports = [port] if port else list(range(8800, 8830)) + [0]
    for address in (local, "127.0.0.1"):
        last = None
        for p in ports:
            try:
                return PhotonHost((address, p), Handler, store=store, token=token, ui_dir=os.path.join(ROOT, "ui"), info=info)
            except OSError as e:
                last = e
                if e.errno in (49, 99, 10049):      # EADDRNOTAVAIL: this system has no such loopback address
                    break
        if address == "127.0.0.1":
            raise OSError(f"no loopback port available: {last}")
    raise OSError("unreachable")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="rinkvt", description=f"{PRODUCT} {VERSION} · {EDITION}")
    ap.add_argument("--data", default=os.path.join(ROOT, "runtime"), help="the data folder: the league, the event ledger, the lease table, the renderer profile")
    ap.add_argument("--port", type=int, default=0, help="a fixed port; by default the first free one of 8800-8829")
    ap.add_argument("--device-file", default=None, help="this laptop's device file (identity and pinned address); by default in the user's application data")
    ap.add_argument("--fleet", default=None, help="the fleet register: one lease table every laptop of the club or league shares; remembered once given")
    ap.add_argument("--leases", default=None, help="this league's lease table (default DIR/loopback/leases)")
    ap.add_argument("--pool", default=DEFAULT_POOL, help="where loopback leases come from (inside 127.0.0.0/8, not 127.0.0.0/16)")
    ap.add_argument("--no-browser", action="store_true", help="do not open the renderer window")
    ap.add_argument("--allow-default-browser-fallback", action="store_true", help="use the ordinary browser profile when no Edge/Chrome/Chromium is found")
    ap.add_argument("--verify-only", action="store_true", help="check the release and the league, print the report, exit")
    ap.add_argument("--version", action="version", version=f"{PRODUCT} {VERSION} · {EDITION}")
    ns = ap.parse_args(argv)
    if not 0 <= ns.port <= 65535:
        print("REFUSED: the port must be 0-65535", file=sys.stderr)
        return EXIT["usage"]

    release = verify_release(ROOT, "all" if ns.verify_only else "code")
    if ns.verify_only:
        report = {"release": release}
        if not os.path.isdir(os.path.join(ns.data, "league")):
            report["league"] = {"ok": True, "note": f"no league in {os.path.abspath(ns.data)} yet"}
        else:
            holder = InstanceLock(os.path.join(ns.data, ".rinkvt.lock")).holder()
            if holder:                              # a running host is writing: verify from its window instead
                report["league"] = {"ok": True, "skipped": f"{holder}. Type store verify in its workbench to check the league it holds."}
            else:                                   # read only: no lock is made or taken over, nothing is repaired
                report["league"] = verify_folder(ns.data)
        dev = Device.load(ns.device_file, create=False)
        report["device"] = dict(dev.report(), ok=True) if dev else {"ok": True, "note": "this laptop has no device file yet; the first start makes it"}
        print(json.dumps(report, indent=2))
        return EXIT["ok"] if release["ok"] and report["league"]["ok"] else EXIT["fail"]
    if not release["ok"]:
        print("REFUSED: the code of this release does not match RELEASE_MANIFEST.json (changed, missing or unlisted files "
              "under photon/, ui/ or engine/). Restore it, or reseal a deliberate change with tools/seal_release.py.", file=sys.stderr)
        print(json.dumps(release, indent=2), file=sys.stderr)
        return EXIT["integrity"]

    os.makedirs(ns.data, exist_ok=True)
    lock = InstanceLock(os.path.join(ns.data, ".rinkvt.lock"))
    try:
        lock.acquire()
    except RuntimeError as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return EXIT["locked"]
    try:
        try:
            store = LeagueStore(ns.data)
        except StoreError as e:
            print(f"REFUSED: the league in {ns.data} cannot be opened: {e}. Run with --verify-only for the full report; restore the folder from a backup.", file=sys.stderr)
            return EXIT["data"]
        try:
            lease = lease_this_laptop(ns)
        except (LoopbackError, DeviceError) as e:
            print(f"REFUSED: loopback lease: {e}", file=sys.stderr)
            return EXIT["network"]
        local = lease["local"]
        token = secrets.token_urlsafe(32)
        info = dict(lease, data=os.path.abspath(ns.data))
        try:
            httpd = bind(local, ns.port, token, store, info)
        except OSError as e:
            print(f"REFUSED: {e}", file=sys.stderr)
            return EXIT["network"]
        info["bound"] = httpd.server_address[0]
        url = f"http://{httpd.server_address[0]}:{httpd.server_address[1]}/"
        store.events.add("start", version=VERSION, local=local, bound=info["bound"], port=httpd.server_address[1], device=info["client"],
                          pinned=info["pinned"], fleet=info["fleet_state"], conflict=bool(info["conflict"]))
        print(f"{PRODUCT} {VERSION} · {EDITION}", flush=True)
        print(f"  loopback {local} · static for this laptop ({info['client']})" + ("" if info["bound"] == local else f" (this system answers only on 127.0.0.1: listening there)"), flush=True)
        if info["fleet"]:
            print(f"  fleet      {info['fleet']}: {info['fleet_state']}", flush=True)
        print(f"  workbench  {url}", flush=True)
        print(f"  league     {os.path.abspath(ns.data)} ({len(store.ledgers)} games)", flush=True)
        for note in info["notes"]:
            print(f"  NOTE: {note}", flush=True)
        if info["conflict"]:
            print(f"  WARNING: {info['conflict']}", flush=True)
        print("  The listener is loopback only; Host, Origin and a per-launch token guard it. Ctrl+C stops the host.", flush=True)
        if not ns.no_browser:
            def _open():
                if renderer.launch(url, os.path.join(ns.data, "browser_profile"), ns.allow_default_browser_fallback) is None:
                    print(f"  No Edge, Chrome or Chromium was found: open {url} yourself, or restart with --allow-default-browser-fallback.", file=sys.stderr, flush=True)
            threading.Timer(0.3, _open).start()
        def _stop(signum, frame):                    # a service manager or a closed terminal: stop as Ctrl+C does
            threading.Thread(target=httpd.shutdown, daemon=True).start()
        for name in ("SIGTERM", "SIGHUP", "SIGBREAK"):
            if hasattr(signal, name):
                try:
                    signal.signal(getattr(signal, name), _stop)
                except (OSError, ValueError):
                    pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            httpd.server_close()
            store.events.add("stop")
        return EXIT["ok"]
    finally:
        lock.release()


if __name__ == "__main__":
    raise SystemExit(main())
