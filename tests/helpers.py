# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""Shared test helpers: the path to the host, synthetic ledger entries with the engine's seals, a host in a thread."""
import base64
import json
import os
import sys
import tempfile
import threading
import uuid as uuidlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "photon"))

from host.crc32c import crc32c  # noqa: E402
from host.store import META_MAGIC  # noqa: E402

FIXTURES = os.path.join(ROOT, "tests", "fixtures")


def tempdir(test):
    d = tempfile.mkdtemp(prefix="rinkvt-test-")
    test.addCleanup(lambda: __import__("shutil").rmtree(d, ignore_errors=True))
    return d


def new_uuid():
    return str(uuidlib.uuid4())


def frame(game_uuid, n):
    """A 64-byte frame as the engine seals it: game hash at 32..35, CRC-32C (big-endian) of bytes 0..59 at 60..63."""
    b = bytearray(64)
    b[0:16] = uuidlib.uuid4().bytes
    b[16:24] = (1_700_000_000_000_000_000 + n).to_bytes(8, "big")
    b[24:32] = (1_700_000_000_000_000_000 + n + 5).to_bytes(8, "big")
    b[32:36] = bytes.fromhex(game_uuid.replace("-", ""))[:4]
    b[36:40] = (n + 1).to_bytes(4, "big")
    b[40:44] = b"FOCO"
    b[44:48] = b"SMIT"
    b[48:52] = b"S\0\0\0"
    b[60:64] = crc32c(bytes(b), 60).to_bytes(4, "big")
    return bytes(b)


def meta(n):
    """A 64-byte meta line: magic CMT1 (little-endian) at 0..3, CRC-32C (little-endian) of bytes 0..59 at 60..63."""
    b = bytearray(64)
    b[0:4] = META_MAGIC.to_bytes(4, "little")
    b[4:12] = n.to_bytes(8, "little")
    b[12:20] = b"operator"
    b[52:56] = bytes([127, 20, 66, 113])
    b[60:64] = crc32c(bytes(b), 60).to_bytes(4, "little")
    return bytes(b)


def pairs(game_uuid, n0, count):
    return b"".join(frame(game_uuid, n0 + i) + meta(n0 + i) for i in range(count))


def registry(games=(), teams=None):
    return json.dumps({"schema": "rinkvt.registry.v1", "seq": len(games), "leagues": [], "teams": teams or [], "players": [],
                       "games": [{"key": k, "uuid": u} for k, u in games], "notes": []}, indent=1) + "\n"


def b64(data):
    return base64.b64encode(data).decode("ascii")


def engine_fixture():
    with open(os.path.join(FIXTURES, "engine_pairs.json"), encoding="utf-8") as f:
        doc = json.load(f)
    return doc["game"], doc["uuid"], b"".join(bytes.fromhex(p) for p in doc["pairs"])


class RunningHost:
    """A Photon host on 127.0.0.1 and a free port, in a thread of this process."""

    def __init__(self, data, token="t" * 43):
        from host.server import Handler, PhotonHost
        from host.store import LeagueStore
        self.store = LeagueStore(data)
        self.token = token
        info = {"local": "127.0.0.1", "client": "192.0.2.10", "pool": "127.16.0.0/12", "leases": 1, "data": data, "bound": "127.0.0.1"}
        self.httpd = PhotonHost(("127.0.0.1", 0), Handler, store=self.store, token=token, ui_dir=os.path.join(ROOT, "ui"), info=info)
        self.port = self.httpd.server_address[1]
        self.host = f"127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def request(self, method, path, body=None, headers=None, raw=None):
        import http.client
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        h = {"Host": self.host}
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        c.request(method, path, body=raw, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, dict(r.getheaders()), data

    def api(self, method, path, body=None, headers=None):
        h = {"X-VEC1-Token": self.token}
        h.update(headers or {})
        status, hdrs, data = self.request(method, path, body, h)
        try:
            return status, json.loads(data)
        except ValueError:
            return status, data

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
