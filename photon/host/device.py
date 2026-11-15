# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""This laptop's identity: the key its static loopback address belongs to.

An IP address is not a laptop: a laptop takes a new one on every network, and two laptops on two networks can hold
the same one. So the lease belongs to the laptop instead. Its identity is derived from the operating system's own
machine identifier, which stays the same across networks, users, reinstalls of RINK-VT and data folders:

  Windows   HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid
  macOS     IOPlatformUUID (ioreg)
  Linux     /etc/machine-id, else /var/lib/dbus/machine-id

    device key = "device:" + the first 32 hex digits of HMAC-SHA-256(key "RINK-VT device 1", machine identifier)

The machine identifier itself is never stored or shown, only this application-specific digest of it. A computer
that has no machine identifier gets a random 128-bit key instead, kept in its device file.

The device file, one per user and laptop, outside every data folder, keeps the key and the laptop's pinned address:
the 127 address the laptop received first (or from its fleet register) and asks for in every lease table it meets.

  Windows   %LOCALAPPDATA%\\RINK-VT\\device.json
  macOS     ~/Library/Application Support/RINK-VT/device.json
  Linux     $XDG_DATA_HOME/rink-vt/device.json (~/.local/share/rink-vt/device.json)
  any       RINKVT_DEVICE_FILE, or the host's --device-file
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
from datetime import datetime, timezone

FORMAT = "rinkvt.device.v1"
DEVICE_RE = re.compile(r"device:[0-9a-f]{32}")
_HMAC_KEY = b"RINK-VT device 1"


class DeviceError(Exception):
    pass


def derive(machine_identifier):
    """The device key of a machine identifier (an application-specific digest; the identifier is not recoverable)."""
    raw = str(machine_identifier).strip().lower().encode("utf-8")
    return "device:" + hmac.new(_HMAC_KEY, raw, hashlib.sha256).hexdigest()[:32]


def machine_identifier():
    """The operating system's machine identifier, or None."""
    try:
        if os.name == "nt":
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography", 0,
                                winreg.KEY_READ | getattr(winreg, "KEY_WOW64_64KEY", 0)) as k:
                v = str(winreg.QueryValueEx(k, "MachineGuid")[0]).strip()
                return v or None
        if sys.platform == "darwin":
            out = subprocess.run(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], capture_output=True, text=True, timeout=10).stdout
            m = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', out)
            return m.group(1) if m else None
        for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
            try:
                with open(p, encoding="ascii") as f:
                    v = f.read().strip()
                if re.fullmatch(r"[0-9a-fA-F]{32}", v):
                    return v
            except OSError:
                continue
    except (OSError, ValueError, subprocess.SubprocessError, ImportError):
        return None
    return None


def default_path():
    env = os.environ.get("RINKVT_DEVICE_FILE")
    if env:
        return os.path.abspath(env)
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
        return os.path.join(base, "RINK-VT", "device.json")
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "RINK-VT", "device.json")
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "rink-vt", "device.json")


def _seal(doc):
    body = {k: doc[k] for k in sorted(doc) if k != "seal"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:16]


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Device:
    """The identity and pinned address of this laptop, as its device file keeps them."""

    def __init__(self, path, doc, notes):
        self.path, self.doc, self.notes = path, doc, notes

    key = property(lambda self: self.doc["device"])
    source = property(lambda self: self.doc["source"])
    address = property(lambda self: self.doc.get("address"))
    pool = property(lambda self: self.doc.get("pool"))
    fleet = property(lambda self: self.doc.get("fleet"))
    label = property(lambda self: "device " + self.key[7:15])

    @classmethod
    def load(cls, path=None, machine=machine_identifier, create=True):
        """The device of this laptop. With create, a missing, damaged or foreign file is replaced (and said so)."""
        path = os.path.abspath(path or default_path())
        mid = machine()
        mine = derive(mid) if mid else None
        notes, doc = [], None
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    doc = json.load(f)
                if not (isinstance(doc, dict) and doc.get("format") == FORMAT and isinstance(doc.get("device"), str)
                        and DEVICE_RE.fullmatch(doc["device"]) and doc.get("seal") == _seal(doc)):
                    raise ValueError("not a sealed device file")
            except (OSError, ValueError) as e:
                notes.append(f"the device file {path} was unreadable ({str(e)[:80]}); a new one was made")
                doc = None
            if doc is not None and doc.get("source") == "machine" and mine and doc["device"] != mine:
                notes.append("the device file was made on another computer (copied with a user profile); this laptop has an identity of its own")
                doc = None
        if doc is None:
            if not create:
                return None
            doc = {"format": FORMAT, "device": mine or "device:" + secrets.token_hex(16), "source": "machine" if mine else "random",
                   "created": _now(), "address": None, "pool": None, "pinned": None, "fleet": None}
            dev = cls(path, doc, notes)
            dev.save()
            return dev
        return cls(path, doc, notes)

    def save(self):
        self.doc["seal"] = _seal(self.doc)
        d = os.path.dirname(self.path)
        try:
            os.makedirs(d, exist_ok=True)
            tmp = f"{self.path}.{os.getpid()}.tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
            try:
                data = (json.dumps(self.doc, indent=1, sort_keys=True) + "\n").encode("utf-8")
                view = memoryview(data)
                while view:
                    n = os.write(fd, view)
                    if n <= 0:
                        raise OSError("the disk accepted no bytes")
                    view = view[n:]
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp, self.path)
        except OSError as e:
            raise DeviceError(f"the device file {self.path} cannot be written ({e.strerror or e}); give one with --device-file") from e

    def pin(self, address, pool, fleet=None):
        """Record the address this laptop keeps (and the fleet register that gave it, if one did)."""
        changed = (self.doc.get("address"), self.doc.get("pool")) != (address, pool) or (fleet and fleet != self.doc.get("fleet"))
        if changed:
            self.doc.update({"address": address, "pool": pool, "pinned": _now()})
            if fleet:
                self.doc["fleet"] = fleet
            self.save()
        return changed

    def report(self):
        return {"device": self.key, "label": self.label, "source": self.source, "address": self.address, "pool": self.pool,
                "fleet": self.fleet, "file": self.path}
