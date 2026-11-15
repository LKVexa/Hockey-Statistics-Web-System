# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""The league, kept by the Photon host.

  league/registry/registry.json + registry.sha256   the registry, as the reference edition writes it, sealed
  league/ledger/<key>-<uuid8>.jsonl                 one hash-chained ledger per game (VEC1 style)
  events.jsonl                                      the host's own hash-chained event ledger

A game ledger is a header line and then one line per ledger entry pair: the engine's 64-byte frame and the 64-byte
meta line that records who typed it, when, and from which loopback address. Every line carries the SHA-256 of the
line before it, so a ledger is verified from its first line to its last; a line cut off by a crash was never
acknowledged and is dropped. A commit writes the registry first and the ledger lines after it, each synced to disk
before the renderer is told the line was recorded.
"""
import base64
import hashlib
import json
import os
import re
import threading
from datetime import datetime, timezone

from . import strictjson
from .crc32c import crc32c

SCHEMA = "rinkvt.registry.v1"
LEDGER_FORMAT = "rinkvt.vec1-ledger.v1"
FRAME, PAIR = 64, 128
META_MAGIC = 0x31544D43           # "CMT1", little-endian
MAX_REGISTRY = 16 * 1024 * 1024
MAX_PAIRS_PER_GAME = 2 * 20000    # the engine accepts at most 20 000 frames per game, each with its meta line


class StoreError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _sha(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(p if isinstance(p, bytes) else p.encode("utf-8"))
    return h.hexdigest()


def _fsync_dir(d):
    try:
        fd = os.open(d, os.O_RDONLY)
    except OSError:
        return                                     # a directory cannot be opened on Windows; renames are still atomic
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


BINARY = getattr(os, "O_BINARY", 0)              # Windows: no newline translation, ever


def write_all(fd, data):
    """os.write may write less than it was given; a ledger line is written whole or the commit fails."""
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        if n <= 0:
            raise OSError("the disk accepted no bytes")
        view = view[n:]


def append_durable(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | BINARY, 0o600)
    try:
        write_all(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_durable(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | BINARY, 0o600)
    try:
        write_all(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)


def _read_lines(path, readonly, what):
    """The complete lines of an append-only file. A last line without its newline was cut off by a crash and never
    acknowledged: a host opening the file drops it; a verification (readonly) reports it instead."""
    with open(path, "rb") as f:
        raw = f.read()
    cut = raw.rfind(b"\n") + 1
    torn = cut < len(raw)
    if torn:
        if readonly:
            raise StoreError("DAMAGED", f"{what} ends with an unfinished line (a stop during a write); starting the host drops it")
        with open(path, "r+b") as f:
            f.truncate(cut)
            os.fsync(f.fileno())
        raw = raw[:cut]
    return raw.decode("utf-8").split("\n")[:-1], torn


def check_pair(frame, meta, game_hash, where):
    """The engine's own seals: the frame's CRC-32C (big-endian, bytes 60-63) and game hash, the meta line's magic and CRC."""
    if len(frame) != FRAME or len(meta) != FRAME:
        raise StoreError("BAD_PAIR", f"{where}: a ledger entry is 64 bytes")
    if int.from_bytes(frame[60:64], "big") != crc32c(frame, 60):
        raise StoreError("BAD_PAIR", f"{where}: the frame does not match its CRC-32C")
    if frame[32:36] != game_hash:
        raise StoreError("BAD_PAIR", f"{where}: the frame belongs to another game")
    if int.from_bytes(meta[0:4], "little") != META_MAGIC or int.from_bytes(meta[60:64], "little") != crc32c(meta, 60):
        raise StoreError("BAD_PAIR", f"{where}: the meta line does not match its CRC-32C")


class GameLedger:
    def __init__(self, path, key, uuid, readonly=False):
        self.path, self.key, self.uuid = path, key, uuid
        self.game_hash = bytes.fromhex(uuid.replace("-", ""))[:4]
        self.genesis = _sha("RINK-VT ledger 1\0", key, "\0", uuid)
        self.pairs, self.tip, self.dropped = [], self.genesis, False
        if os.path.exists(path):
            self._load(readonly)

    def _load(self, readonly):
        lines, self.dropped = _read_lines(self.path, readonly, os.path.basename(self.path))
        if not lines:
            return
        head = strictjson.loads(lines[0])
        if head.get("ledger") != LEDGER_FORMAT or head.get("game") != self.key or head.get("uuid") != self.uuid:
            raise StoreError("DAMAGED", f"{os.path.basename(self.path)}: the header names another ledger, game or format")
        tip = self.genesis
        for n, line in enumerate(lines[1:]):
            where = f"{os.path.basename(self.path)} line {n + 2}"
            try:
                r = strictjson.loads(line)
            except ValueError as e:
                raise StoreError("DAMAGED", f"{where} is not JSON ({e})")
            if set(r) != {"n", "frame", "meta", "prev", "hash"} or r["n"] != n or r["prev"] != tip:
                raise StoreError("DAMAGED", f"{where} breaks the chain (sequence or previous hash)")
            if not (isinstance(r["frame"], str) and isinstance(r["meta"], str) and re.fullmatch(r"[0-9a-f]{128}", r["frame"]) and re.fullmatch(r"[0-9a-f]{128}", r["meta"])):
                raise StoreError("DAMAGED", f"{where} does not hold two 64-byte entries")
            if _sha(tip, "\n", r["frame"], r["meta"], "\n", str(n)) != r["hash"]:
                raise StoreError("DAMAGED", f"{where} does not match its hash (edited or damaged)")
            frame, meta = bytes.fromhex(r["frame"]), bytes.fromhex(r["meta"])
            check_pair(frame, meta, self.game_hash, where)
            self.pairs.append(frame + meta)
            tip = r["hash"]
        self.tip = tip

    def append(self, blobs):
        """Append pairs (128 bytes each), synced to disk before returning."""
        out, tip, n0 = [], self.tip, len(self.pairs)
        if not os.path.exists(self.path):
            out.append(json.dumps({"ledger": LEDGER_FORMAT, "game": self.key, "uuid": self.uuid, "created": _now()}, separators=(",", ":")) + "\n")
        for i, b in enumerate(blobs):
            fh, mh, n = b[:FRAME].hex(), b[FRAME:].hex(), n0 + i
            h = _sha(tip, "\n", fh, mh, "\n", str(n))
            out.append(json.dumps({"n": n, "frame": fh, "meta": mh, "prev": tip, "hash": h}, separators=(",", ":")) + "\n")
            tip = h
        append_durable(self.path, "".join(out).encode("utf-8"))
        self.pairs.extend(blobs)
        self.tip = tip


class EventLedger:
    """The host's own events (start, commits, verification, stop), hash-chained like a game ledger."""

    def __init__(self, path, readonly=False):
        self.path, self.tip, self.seq = path, _sha("RINK-VT events 1"), 0
        self.lock = threading.Lock()
        if os.path.exists(path):
            lines, _ = _read_lines(path, readonly, "events.jsonl")
            for i, line in enumerate(lines):
                try:
                    r = strictjson.loads(line)
                except ValueError as e:
                    raise StoreError("DAMAGED", f"events.jsonl line {i + 1} is not JSON ({e})")
                if not isinstance(r, dict) or not all(k in r for k in ("seq", "at", "event", "detail")):
                    raise StoreError("DAMAGED", f"events.jsonl line {i + 1} is not an event")
                body = {k: r[k] for k in ("seq", "at", "event", "detail")}
                if r.get("prev") != self.tip or r.get("seq") != i or _sha(self.tip, json.dumps(body, sort_keys=True, separators=(",", ":"))) != r.get("hash"):
                    raise StoreError("DAMAGED", f"events.jsonl line {i + 1} breaks the chain")
                self.tip, self.seq = r["hash"], i + 1

    def add(self, event, **detail):
        with self.lock:                             # the host's threads (requests, start, stop) share one ledger
            body = {"seq": self.seq, "at": _now(), "event": event, "detail": detail}
            h = _sha(self.tip, json.dumps(body, sort_keys=True, separators=(",", ":")))
            line = json.dumps(dict(body, prev=self.tip, hash=h), separators=(",", ":")) + "\n"
            append_durable(self.path, line.encode("utf-8"))
            self.tip, self.seq = h, self.seq + 1


class LeagueStore:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.reg_dir = os.path.join(self.root, "league", "registry")
        self.led_dir = os.path.join(self.root, "league", "ledger")
        os.makedirs(self.reg_dir, exist_ok=True)
        os.makedirs(self.led_dir, exist_ok=True)
        self.lock = threading.Lock()
        self.events = EventLedger(os.path.join(self.root, "events.jsonl"))
        self.registry_text, self.registry_sha = self._load_registry()
        self.ledgers = {}
        self.recovered = []
        if self.registry_text is not None:
            for g in self._games(strictjson.loads(self.registry_text)):
                led = self._ledger(g["key"], g["uuid"])
                if led.dropped:
                    self.recovered.append(g["key"])

    # ---- the registry ---------------------------------------------------------------------------------------
    def _load_registry(self, readonly=False):
        f, seal_f = os.path.join(self.reg_dir, "registry.json"), os.path.join(self.reg_dir, "registry.sha256")
        if not os.path.exists(f):
            return None, None
        with open(f, "rb") as fh:
            raw = fh.read()
        have = hashlib.sha256(raw).hexdigest()
        def seal(p):                                # closed at once: on Windows an open handle blocks the rename
            if not os.path.exists(p):
                return None
            with open(p, encoding="utf-8") as fh:
                words = fh.read().split()
            return words[0] if words else None
        if seal(seal_f) != have:
            if seal(seal_f + ".new") == have and readonly:
                raise StoreError("DAMAGED", "registry.sha256 is behind registry.json (a stop between two renames); starting the host completes it")
            if seal(seal_f + ".new") == have:      # the crash fell between the two renames: finish the commit
                os.replace(seal_f + ".new", seal_f)
                _fsync_dir(self.reg_dir)
            else:
                raise StoreError("DAMAGED", "registry.json does not match registry.sha256 (edited or damaged)")
        elif os.path.exists(seal_f + ".new") and not readonly:
            os.remove(seal_f + ".new")              # the stop fell before the text was renamed: the old seal stands
        if not readonly:                            # a text written by a commit that never reached its rename
            for name in os.listdir(self.reg_dir):
                if re.fullmatch(r"registry\.json\.\d+\.tmp", name):
                    try:
                        os.remove(os.path.join(self.reg_dir, name))
                    except OSError:
                        pass
        text = raw.decode("utf-8")
        self._check_registry(text)
        return text, have

    @staticmethod
    def _games(reg):
        return [g for g in reg.get("games", []) if isinstance(g, dict)]

    def _check_registry(self, text):
        if len(text.encode("utf-8")) > MAX_REGISTRY:
            raise StoreError("TOO_LARGE", "the registry is larger than 16 MiB")
        try:
            reg = strictjson.loads(text)
        except ValueError as e:
            raise StoreError("BAD_REGISTRY", f"the registry is not JSON ({e})")
        if not isinstance(reg, dict) or reg.get("schema") != SCHEMA:
            raise StoreError("BAD_REGISTRY", f"the registry has schema {str(reg.get('schema') if isinstance(reg, dict) else None)[:40]}; this host keeps {SCHEMA}")
        for k in ("teams", "players", "games", "notes"):
            if not isinstance(reg.get(k), list):
                raise StoreError("BAD_REGISTRY", f'registry: "{k}" must be a list')
        seen = set()
        for g in reg["games"]:
            if not (isinstance(g, dict) and isinstance(g.get("key"), str) and re.fullmatch(r"[A-Za-z0-9_-]{1,24}", g["key"]) and isinstance(g.get("uuid"), str) and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", g["uuid"])):
                raise StoreError("BAD_REGISTRY", "registry: a game without a valid key and uuid")
            if g["key"] in seen:
                raise StoreError("BAD_REGISTRY", f"registry: game {g['key']} twice")
            seen.add(g["key"])
        return reg

    def _save_registry(self, text):
        data = text.encode("utf-8")
        f, seal_f = os.path.join(self.reg_dir, "registry.json"), os.path.join(self.reg_dir, "registry.sha256")
        have = hashlib.sha256(data).hexdigest()
        _write_durable(seal_f + ".new", f"{have}  registry.json\n".encode())
        tmp = f"{f}.{os.getpid()}.tmp"
        _write_durable(tmp, data)
        os.replace(tmp, f)
        os.replace(seal_f + ".new", seal_f)
        _fsync_dir(self.reg_dir)
        self.registry_text, self.registry_sha = text, have

    # ---- ledgers --------------------------------------------------------------------------------------------
    def _ledger(self, key, uuid):
        led = self.ledgers.get(key)
        if led is None:
            led = GameLedger(os.path.join(self.led_dir, f"{key}-{uuid[:8]}.jsonl"), key, uuid)
            self.ledgers[key] = led
        elif led.uuid != uuid:
            raise StoreError("CONFLICT", f"game {key} is {led.uuid}, not {uuid}")
        return led

    # ---- what the renderer asks ------------------------------------------------------------------------------
    def snapshot(self):
        """The registry text and each game's pairs, in registry order: (index, blob)."""
        with self.lock:
            index, chunks = [], []
            if self.registry_text is not None:
                for g in self._games(strictjson.loads(self.registry_text)):
                    led = self._ledger(g["key"], g["uuid"])
                    index.append({"key": g["key"], "uuid": g["uuid"], "pairs": len(led.pairs)})
                    chunks.extend(led.pairs)
            return {"registry": self.registry_text, "registrySha": self.registry_sha, "games": index}, b"".join(chunks)

    def commit(self, registry=None, base=None, ledgers=()):
        """Record what the renderer changed: the new registry text (if any) and new ledger pairs. `base` is the
        registry seal the renderer last saw; a commit made from an older view is refused (409) and the renderer
        reloads. Each ledger batch must start where its ledger ends."""
        with self.lock:
            if (base or None) != self.registry_sha:
                raise StoreError("CONFLICT", "the league changed since this window loaded it (another window?); reload")
            reg = self._check_registry(registry) if registry is not None else (strictjson.loads(self.registry_text) if self.registry_text else None)
            games = {g["key"]: g["uuid"] for g in self._games(reg)} if reg else {}
            if self.registry_text is not None:
                for g in self._games(strictjson.loads(self.registry_text)):
                    if games.get(g["key"]) != g["uuid"]:
                        raise StoreError("CONFLICT", f"the new registry drops or changes game {g['key']}; games are never removed")
            plan = []
            for b in ledgers:
                key, uuid, start = b.get("game"), b.get("uuid"), b.get("start")
                if not isinstance(key, str) or games.get(key) != uuid:
                    raise StoreError("BAD_REQUEST", f"ledger batch for unknown game {str(key)[:24]}")
                try:
                    data = base64.b64decode(b.get("data", ""), validate=True)
                except (ValueError, TypeError):
                    raise StoreError("BAD_REQUEST", f"{key}: the entries are not base64")
                if len(data) % PAIR:
                    raise StoreError("BAD_REQUEST", f"{key}: entries come in 128-byte pairs (a frame and its meta line)")
                led = self._ledger(key, uuid)
                if start != len(led.pairs):
                    raise StoreError("CONFLICT", f"{key}: this batch starts at {start}; the ledger holds {len(led.pairs)}")
                blobs = [data[i:i + PAIR] for i in range(0, len(data), PAIR)]
                if len(led.pairs) + len(blobs) > MAX_PAIRS_PER_GAME:
                    raise StoreError("TOO_LARGE", f"{key}: more entries than a game may hold")
                for i, blob in enumerate(blobs):
                    check_pair(blob[:FRAME], blob[FRAME:], led.game_hash, f"{key} entry {start + i}")
                plan.append((led, blobs))
            if registry is not None and registry != self.registry_text:
                self._save_registry(registry)
            for led, blobs in plan:
                if blobs:
                    led.append(blobs)
            added = sum(len(b) for _, b in plan)
            if registry is not None or added:
                self.events.add("commit", registry=registry is not None, pairs=added, games=[led.key for led, b in plan if b])
            return {"registrySha": self.registry_sha, "counts": {led.key: len(led.pairs) for led, _ in plan}}

    def verify(self):
        """Re-read everything from disk, as a fresh start would, and repair nothing."""
        with self.lock:
            return verify_folder(self.root, self.events.lock)


def verify_folder(root, events_lock=None):
    """Check a data folder without opening it for use: the registry seal, every game's chain and seals, and the event
    ledger. Nothing is written, so it is safe on a copy, a backup, or a folder no host has open."""
    reg_dir = os.path.join(root, "league", "registry")
    led_dir = os.path.join(root, "league", "ledger")
    report = {"ok": True, "registry": None, "games": [], "events": None}
    try:
        probe = LeagueStore.__new__(LeagueStore)               # only its readers are used: no folder is created
        probe.reg_dir = reg_dir
        text, sha = probe._load_registry(readonly=True)
        games = LeagueStore._games(strictjson.loads(text)) if text else []
        report["registry"] = {"ok": True, "sha256": sha, "games": len(games)}
    except StoreError as e:
        report["ok"] = False
        report["registry"] = {"ok": False, "error": str(e)}
        return report
    for g in games:
        try:
            led = GameLedger(os.path.join(led_dir, f"{g['key']}-{g['uuid'][:8]}.jsonl"), g["key"], g["uuid"], readonly=True)
            report["games"].append({"key": g["key"], "ok": True, "pairs": len(led.pairs), "tip": led.tip})
        except StoreError as e:
            report["ok"] = False
            report["games"].append({"key": g["key"], "ok": False, "error": str(e)})
    try:
        path = os.path.join(root, "events.jsonl")
        if events_lock is not None:
            with events_lock:
                ev = EventLedger(path, readonly=True)
        else:
            ev = EventLedger(path, readonly=True)
        report["events"] = {"ok": True, "events": ev.seq}
    except StoreError as e:
        report["ok"] = False
        report["events"] = {"ok": False, "error": str(e)}
    return report
