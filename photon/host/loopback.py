# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""Static loopback leases: every laptop gets one address of its own in 127.0.0.0/8 and keeps it.

The rule and the algorithm are the reference edition's (gateway/loopback.js); the key differs:

  pool          127.16.0.0/12 by default; never overlapping 127.0.0.0/16; addresses ending in .0 or .255 not used
  first choice  SHA-256("RINK-VT loopback 1" NUL key) mod the pool size; a taken slot moves the newcomer on by one
  key           in this edition, the laptop's device key (host/device.py): "device:" and 32 hex digits, the same on
                every network; the reference edition keys a client by its IP address in canonical form (RFC 5952;
                IPv4-mapped IPv6 is IPv4), which a table here can also hold and the tools can look up
  pinned        a laptop asks every table for the address it already has (its pin); a table gives it unless another
                laptop holds it there, so one table never gives one address to two laptops
  lease file    append-only; one sealed line per lease, synced to disk before the address is used. Format 1 holds IP
                keys only (the reference edition's); format 2 also holds device keys. A format 1 table that receives
                a device key is upgraded once: its header names format 2 and every line stays as it was.

A fleet register is a lease table every laptop of a club or league shares (on a network share or a removable disk):
each allocation happens under an exclusive lock and re-reads the file first, so no two laptops enrolled in one
register can ever hold the same address.
"""
import hashlib
import ipaddress
import os
import re
import socket
import time
from datetime import datetime, timezone

DEFAULT_POOL = "127.16.0.0/12"
FORMAT = 2                                         # what this build writes
READ_FORMATS = (1, 2)
DEVICE_RE = re.compile(r"device:[0-9a-f]{32}")
HEADER_RE = re.compile(r"^# RINK-VT loopback leases · format (\d+) · pool (\S+) · ipv6 /(\d+)$")


class LoopbackError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def canonical(raw):
    """The canonical text of an IP address as a socket or a person writes it, or None."""
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s or len(s) > 64:
        return None
    m = re.fullmatch(r"\[([^\]]+)\](?::\d{1,5})?", s) or re.fullmatch(r"(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}", s)
    if m:
        s = m.group(1)
    s = s.split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(s)
    except ValueError:
        return None
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return str(ip)


def client_key(addr, ipv6_prefix=128):
    """The key a lease belongs to: a laptop's device key as it stands, or an IP address in canonical form."""
    if isinstance(addr, str) and DEVICE_RE.fullmatch(addr.strip()):
        return addr.strip()
    c = canonical(addr)
    if c is None:
        return None
    ip = ipaddress.ip_address(c)
    if ip.version == 4 or ipv6_prefix >= 128:
        return c
    net = ipaddress.ip_network(f"{c}/{ipv6_prefix}", strict=False)
    return f"{net.network_address}/{ipv6_prefix}"


class Pool:
    def __init__(self, spec):
        m = re.fullmatch(r"(\d{1,3}(?:\.\d{1,3}){3})/(\d{1,2})", str(spec or ""))
        if not m:
            raise LoopbackError("POOL", f"the loopback pool {str(spec)[:40]} is not of the form 127.A.B.C/N")
        try:
            base = int(ipaddress.IPv4Address(m.group(1)))
        except ValueError:
            raise LoopbackError("POOL", f"the loopback pool {spec} is not inside 127.0.0.0/8")
        length = int(m.group(2))
        if base >> 24 != 127:
            raise LoopbackError("POOL", f"the loopback pool {spec} is not inside 127.0.0.0/8")
        if not 9 <= length <= 24:
            raise LoopbackError("POOL", f"the loopback pool {spec}: the prefix length must be 9 to 24")
        size = 2 ** (32 - length)
        if base % size:
            raise LoopbackError("POOL", f"the loopback pool {spec}: {m.group(1)} is not the first address of a /{length}")
        last = base + size - 1
        lo, hi = int(ipaddress.IPv4Address("127.0.0.0")), int(ipaddress.IPv4Address("127.0.255.255"))
        if base <= hi and last >= lo:
            raise LoopbackError("POOL", f"the loopback pool {spec} overlaps 127.0.0.0/16, which this computer itself uses (127.0.0.1 ...)")
        self.base, self.len, self.last = base, length, last
        self.text = f"{ipaddress.IPv4Address(base)}/{length}"
        self.capacity = size // 256 * 254

    def address_at(self, i):
        return str(ipaddress.IPv4Address(self.base + (i // 254) * 256 + (i % 254) + 1))

    def contains(self, a):
        try:
            n = int(ipaddress.IPv4Address(a))
        except ValueError:
            return False
        return self.base <= n <= self.last and (n & 255) not in (0, 255)


def slot_of(key, capacity):
    return int(_sha("RINK-VT loopback 1\0" + key)[:16], 16) % capacity


def primary_address():
    """This computer's primary IP address: the source address of its default route (no packet is sent), else the
    address of its host name, else 127.0.0.1."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            a = s.getsockname()[0]
            if a and a != "0.0.0.0":
                return a
    except OSError:
        pass
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return "127.0.0.1"


class LeaseTable:
    """The lease table, kept in memory and, with a file, on disk. With a file, every allocation takes an exclusive
    lock beside it and re-reads the file first, so several computers can share one table."""

    LOCK_WAIT_S = 15.0
    LOCK_STALE_S = 60.0

    def __init__(self, file=None, pool=DEFAULT_POOL, ipv6_prefix=128, max_leases=65536, create_dirs=True):
        self.pool = Pool(pool)
        if not (isinstance(ipv6_prefix, int) and 32 <= ipv6_prefix <= 128):
            raise LoopbackError("CONFIG", "the IPv6 lease prefix must be 32 to 128")
        if not (isinstance(max_leases, int) and max_leases >= 1):
            raise LoopbackError("CONFIG", "the most leases must be a positive whole number")
        if max_leases > self.pool.capacity:
            raise LoopbackError("CONFIG", f"the most leases ({max_leases}) is more than the pool {self.pool.text} holds ({self.pool.capacity})")
        self.ipv6_prefix, self.max = ipv6_prefix, max_leases
        self.header = f"# RINK-VT loopback leases · format {FORMAT} · pool {self.pool.text} · ipv6 /{ipv6_prefix}"
        self.file = os.path.abspath(file) if file else None
        self.by_key, self.by_addr, self._read_upto, self.file_format = {}, {}, 0, FORMAT
        self.upgraded = False
        if self.file:
            if create_dirs:
                os.makedirs(os.path.dirname(self.file), exist_ok=True)
            elif not os.path.isdir(os.path.dirname(self.file)):
                # a fleet register on a share or a removable disk that is not there now: never made in its place
                raise LoopbackError("UNREACHABLE", f"the folder of {self.file} is not there (share or disk not connected)")
            with self._locked():
                if not os.path.exists(self.file):
                    self._append(self.header + "\n")
                self._refresh()

    # ---- the file -------------------------------------------------------------------------------------------
    def _append(self, text):
        fd = os.open(self.file, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o600)
        try:
            view = memoryview(text.encode("utf-8"))
            while view:                             # os.write may write less than it was given
                n = os.write(fd, view)
                if n <= 0:
                    raise OSError("the disk accepted no bytes")
                view = view[n:]
            os.fsync(fd)
        finally:
            os.close(fd)

    def _refresh(self):
        """Read what was appended since the last read (by this process or by another computer)."""
        with open(self.file, "rb") as f:
            raw = f.read()
        cut = raw.rfind(b"\n") + 1
        if cut < len(raw):
            # a line cut off by a crash was never handed out: drop it (under the lock, so no writer is mid-line)
            with open(self.file, "r+b") as f:
                f.truncate(cut)
                os.fsync(f.fileno())
            raw = raw[:cut]
        lines = raw.decode("utf-8").split("\n")[:-1]
        if not lines:
            raise LoopbackError("DAMAGED", f"{self.file}: the file is empty; it should begin with a lease header")
        h = HEADER_RE.match(lines[0])
        if not h:
            raise LoopbackError("DAMAGED", f"{self.file}: line 1 is not a loopback lease header")
        if int(h.group(1)) not in READ_FORMATS:
            raise LoopbackError("DAMAGED", f"{self.file} is lease format {h.group(1)}; this build reads formats 1 and 2")
        self.file_format = int(h.group(1))
        if h.group(2) != self.pool.text or int(h.group(3)) != self.ipv6_prefix:
            raise LoopbackError("POOL_CHANGED", f"{self.file} holds leases from pool {h.group(2)} with IPv6 keys /{h.group(3)}; "
                                f"this host is set to {self.pool.text} and /{self.ipv6_prefix}. Leases are static: use the pool the file was written with")
        for i in range(max(1, self._read_upto), len(lines)):
            f = lines[i].split(" ")
            where = f"{self.file}: line {i + 1}"
            if len(f) != 4:
                raise LoopbackError("DAMAGED", f"{where} does not have four fields")
            addr, key, at, seal = f
            if _sha(f"{addr} {key} {at}")[:16] != seal:
                raise LoopbackError("DAMAGED", f"{where} does not match its seal (edited or damaged)")
            if not self.pool.contains(addr):
                raise LoopbackError("DAMAGED", f"{where} names {addr}, which is not in the pool")
            if client_key(re.sub(r"/\d+$", "", key), self.ipv6_prefix) != key:
                raise LoopbackError("DAMAGED", f"{where} has a client key that is not canonical")
            if self.file_format == 1 and DEVICE_RE.fullmatch(key):
                raise LoopbackError("DAMAGED", f"{where} holds a device key, which a format 1 table cannot")
            if key in self.by_key:
                raise LoopbackError("DAMAGED", f"{where} leases {key} a second time")
            if addr in self.by_addr:
                raise LoopbackError("DAMAGED", f"{where} gives {addr} a second time")
            self.by_key[key] = (addr, at)
            self.by_addr[addr] = key
        self._read_upto = len(lines)

    class _Lock:
        def __init__(self, table):
            self.t, self.path, self.held = table, table.file + ".lock", False

        def __enter__(self):
            end = time.monotonic() + self.t.LOCK_WAIT_S
            while True:
                try:
                    fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
                    os.write(fd, f"{os.getpid()} {socket.gethostname()} {time.time():.0f}\n".encode())
                    os.close(fd)
                    self.held = True
                    return self
                except FileExistsError:
                    try:
                        if time.time() - os.path.getmtime(self.path) > self.t.LOCK_STALE_S:
                            os.remove(self.path)       # a holder that died mid-allocation; allocations take milliseconds
                            continue
                    except OSError:
                        pass
                    if time.monotonic() > end:
                        raise LoopbackError("LOCKED", f"the loopback lease file is locked by another process ({self.path}); "
                                            "if it is a reference-edition gateway, give this edition a file of its own")
                    time.sleep(0.05)

        def __exit__(self, *exc):
            if self.held:
                try:
                    os.remove(self.path)
                except OSError:
                    pass

    def _locked(self):
        return LeaseTable._Lock(self)

    # ---- leases ---------------------------------------------------------------------------------------------
    def lease(self, raw, prefer=None):
        """(address, key, fresh, moved) for this key; made on first contact and kept for good. `prefer` is the address
        the key already holds elsewhere (a laptop's pin): it is given when it is free here. `moved` says it was not."""
        key = client_key(raw, self.ipv6_prefix)
        if key is None:
            raise LoopbackError("ADDRESS", "neither a device key nor an IP address")
        if prefer is not None and not self.pool.contains(prefer):
            prefer = None                           # a pin from another pool is no preference here
        if key in self.by_key:
            a = self.by_key[key][0]
            return a, key, False, prefer is not None and a != prefer
        if self.file:
            with self._locked():
                self._refresh()
                if key in self.by_key:
                    a = self.by_key[key][0]
                    return a, key, False, prefer is not None and a != prefer
                return self._allocate(key, prefer)
        return self._allocate(key, prefer)

    def _allocate(self, key, prefer=None):
        if len(self.by_key) >= self.max:
            raise LoopbackError("FULL", f"all {self.max} loopback leases are taken")
        addr = prefer if prefer is not None and prefer not in self.by_addr else None
        if addr is None:
            start = slot_of(key, self.pool.capacity)
            for k in range(self.pool.capacity):
                a = self.pool.address_at((start + k) % self.pool.capacity)
                if a not in self.by_addr:
                    addr = a
                    break
        if addr is None:
            raise LoopbackError("FULL", f"the pool {self.pool.text} has no free address")
        at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if self.file:
            if self.file_format == 1 and DEVICE_RE.fullmatch(key):
                self._upgrade()
            body = f"{addr} {key} {at}"
            self._append(f"{body} {_sha(body)[:16]}\n")   # on disk before anyone is told the address
            with open(self.file, "rb") as f:
                self._read_upto = f.read().decode("utf-8").count("\n")
        self.by_key[key] = (addr, at)
        self.by_addr[addr] = key
        return addr, key, True, prefer is not None and addr != prefer

    def _upgrade(self):
        """A format 1 table (IP keys only) about to hold a device key: rewrite its header as format 2, under the
        lock, keeping every lease line byte for byte."""
        with open(self.file, "rb") as f:
            raw = f.read()
        nl = raw.index(b"\n")
        data = self.header.encode("utf-8") + raw[nl:]
        tmp = f"{self.file}.{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
        try:
            view = memoryview(data)
            while view:
                n = os.write(fd, view)
                if n <= 0:
                    raise OSError("the disk accepted no bytes")
                view = view[n:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, self.file)
        self.file_format, self.upgraded = FORMAT, True

    def lookup(self, raw):
        key = client_key(raw, self.ipv6_prefix) or str(raw)
        hit = self.by_key.get(key)
        return hit[0] if hit else None

    def stats(self):
        return {"pool": self.pool.text, "capacity": self.pool.capacity, "max": self.max, "leases": len(self.by_key), "persistent": bool(self.file),
                "format": self.file_format}
