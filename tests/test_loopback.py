# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""Static loopback leases: a laptop keeps one 127.x.y.z address; an IP address gets the one the reference edition gives it."""
import os
import unittest

from helpers import tempdir

from host.loopback import DEFAULT_POOL, LeaseTable, LoopbackError, Pool, canonical, client_key, slot_of

# Computed with the reference (Node.js) edition's gateway/loopback.js, 2.5.0-rinkvt.1: both editions must agree.
REFERENCE = {
    "203.0.113.5": "127.20.66.113", "198.51.100.7": "127.25.34.133", "10.0.0.1": "127.18.240.207",
    "::ffff:192.0.2.44": "127.26.105.28", "2001:db8::1": "127.18.166.142", "[2001:db8::2]:443": "127.22.152.35",
    "192.0.2.44:8080": "127.26.105.28", "fe80::1%eth0": "127.29.105.216",
}
REFERENCE_SMALL_POOL = ["127.200.0.83", "127.200.0.253", "127.200.0.225", "127.200.0.55", "127.200.0.198", "127.200.0.199"]


class Canonical(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(canonical("192.0.2.1"), "192.0.2.1")
        self.assertEqual(canonical(" 192.0.2.1:8080 "), "192.0.2.1")
        self.assertEqual(canonical("::ffff:192.0.2.1"), "192.0.2.1")
        self.assertEqual(canonical("[2001:DB8:0:0::1]:443"), "2001:db8::1")
        self.assertEqual(canonical("fe80::1%eth0"), "fe80::1")
        for bad in ("", "x", "999.1.1.1", "1.2.3", None, 12, "1" * 80):
            self.assertIsNone(canonical(bad), bad)

    def test_ipv6_prefix_keys(self):
        self.assertEqual(client_key("2001:db8::1", 64), "2001:db8::/64")
        self.assertEqual(client_key("2001:db8::ffff", 64), "2001:db8::/64")
        self.assertEqual(client_key("192.0.2.1", 64), "192.0.2.1")


class Pools(unittest.TestCase):
    def test_default(self):
        p = Pool(DEFAULT_POOL)
        self.assertEqual(p.capacity, 1040384)
        self.assertFalse(p.contains("127.16.0.0"))
        self.assertFalse(p.contains("127.16.0.255"))
        self.assertTrue(p.contains("127.16.0.1"))

    def test_refused(self):
        for bad in ("127.0.0.0/8", "127.0.0.0/16", "10.0.0.0/12", "127.16.0.0/25", "127.16.0.1/24", "127.16.0.0/8", "nonsense"):
            with self.assertRaises(LoopbackError, msg=bad):
                Pool(bad)


class Agreement(unittest.TestCase):
    def test_same_addresses_as_the_reference_edition(self):
        t = LeaseTable()
        for raw, want in REFERENCE.items():
            self.assertEqual(t.lease(raw)[0], want, raw)

    def test_same_probing_as_the_reference_edition(self):
        t = LeaseTable(pool="127.200.0.0/24", max_leases=254)
        self.assertEqual([t.lease(f"192.0.2.{i}")[0] for i in range(6)], REFERENCE_SMALL_POOL)

    def test_ipv6_prefix_agreement(self):
        t = LeaseTable(ipv6_prefix=64)
        self.assertEqual(t.lease("2001:db8::1")[0], "127.25.77.133")
        self.assertEqual(t.lease("2001:db8::ffff")[0], "127.25.77.133")


class Static(unittest.TestCase):
    def test_static_across_restarts(self):
        f = os.path.join(tempdir(self), "leases")
        a = LeaseTable(f)
        first = {ip: a.lease(ip)[0] for ip in ("192.0.2.1", "192.0.2.2", "2001:db8::7")}
        b = LeaseTable(f)
        for ip, addr in first.items():
            got, _, fresh, _ = b.lease(ip)
            self.assertEqual(got, addr)
            self.assertFalse(fresh)

    def test_unique_for_many_addresses(self):
        t = LeaseTable(pool="127.200.0.0/16", max_leases=4000)
        seen = {t.lease(f"10.{i // 250}.{i % 250}.1")[0] for i in range(4000)}
        self.assertEqual(len(seen), 4000)

    def test_full(self):
        t = LeaseTable(pool="127.200.0.0/24", max_leases=254)
        for i in range(254):
            t.lease(f"192.0.2.{i}" if i < 250 else f"198.51.100.{i}")
        with self.assertRaises(LoopbackError) as e:
            t.lease("203.0.113.9")
        self.assertEqual(e.exception.code, "FULL")

    def test_shared_file_between_two_tables(self):
        f = os.path.join(tempdir(self), "leases")
        a, b = LeaseTable(f), LeaseTable(f)
        x = a.lease("192.0.2.1")[0]
        self.assertEqual(b.lease("192.0.2.1")[0], x)                 # b re-reads the file under the lock
        y = b.lease("192.0.2.2")[0]
        self.assertNotEqual(x, y)
        self.assertEqual(a.lease("192.0.2.2")[0], y)

    def test_torn_last_line_dropped(self):
        f = os.path.join(tempdir(self), "leases")
        t = LeaseTable(f)
        addr = t.lease("192.0.2.1")[0]
        with open(f, "ab") as fh:
            fh.write(b"127.16.0.9 192.0.2.99 2026-01")             # cut off: never handed out
        t2 = LeaseTable(f)
        self.assertEqual(t2.lease("192.0.2.1")[0], addr)
        with open(f, "rb") as fh:
            self.assertTrue(fh.read().endswith(b"\n"))

    def test_damage_refused(self):
        f = os.path.join(tempdir(self), "leases")
        LeaseTable(f).lease("192.0.2.1")
        with open(f, encoding="utf-8") as fh:
            text = fh.read()
        with open(f, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text.replace("192.0.2.1", "192.0.2.8"))
        with self.assertRaises(LoopbackError) as e:
            LeaseTable(f)
        self.assertEqual(e.exception.code, "DAMAGED")

    def test_pool_change_refused(self):
        f = os.path.join(tempdir(self), "leases")
        LeaseTable(f).lease("192.0.2.1")
        with self.assertRaises(LoopbackError) as e:
            LeaseTable(f, pool="127.200.0.0/24", max_leases=254)
        self.assertEqual(e.exception.code, "POOL_CHANGED")

    def test_slot_is_the_documented_hash(self):
        import hashlib
        key = "203.0.113.5"
        want = int(hashlib.sha256(("RINK-VT loopback 1\0" + key).encode()).hexdigest()[:16], 16) % 1040384
        self.assertEqual(slot_of(key, 1040384), want)


DEV_A = "device:" + "a" * 32
DEV_B = "device:" + "b" * 32


class Devices(unittest.TestCase):
    def test_device_keys_are_keys(self):
        self.assertEqual(client_key(DEV_A), DEV_A)
        for bad in ("device:" + "A" * 32, "device:" + "a" * 31, "device:" + "g" * 32, "device " + "a" * 32):
            self.assertIsNone(client_key(bad), bad)

    def test_new_tables_are_format_2_and_hold_device_keys(self):
        f = os.path.join(tempdir(self), "leases")
        t = LeaseTable(f)
        a = t.lease(DEV_A)[0]
        with open(f, encoding="utf-8") as fh:
            self.assertTrue(fh.readline().startswith("# RINK-VT loopback leases · format 2 · pool 127.16.0.0/12"))
        self.assertEqual(LeaseTable(f).lease(DEV_A)[0], a)

    def test_a_pin_is_honoured_where_it_is_free(self):
        t = LeaseTable(pool="127.200.0.0/24", max_leases=254)
        self.assertEqual(t.lease(DEV_A, prefer="127.200.0.7")[:4:3], ("127.200.0.7", False))
        addr, _, fresh, moved = t.lease(DEV_B, prefer="127.200.0.7")         # another laptop holds it here
        self.assertTrue(fresh and moved)
        self.assertNotEqual(addr, "127.200.0.7")
        self.assertEqual(t.lease(DEV_A, prefer="127.200.0.7")[3], False)      # the holder keeps it
        self.assertEqual(t.lease("192.0.2.9", prefer="10.0.0.1")[3], False)  # a pin outside the pool is no preference

    def test_format_1_table_upgraded_once_lines_kept(self):
        f = os.path.join(tempdir(self), "leases")
        body = "127.20.66.113 203.0.113.5 2026-11-15T17:32:10Z"
        import hashlib
        line = f"{body} {hashlib.sha256(body.encode()).hexdigest()[:16]}\n"
        with open(f, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("# RINK-VT loopback leases · format 1 · pool 127.16.0.0/12 · ipv6 /128\n" + line)
        t = LeaseTable(f)
        self.assertEqual(t.lease("203.0.113.5")[0], "127.20.66.113")              # read as it is
        with open(f, encoding="utf-8") as fh:
            self.assertIn("format 1", fh.readline())
        t.lease(DEV_A)                                                         # a device key: the header becomes 2
        with open(f, encoding="utf-8") as fh:
            lines = fh.read().split("\n")
        self.assertIn("format 2", lines[0])
        self.assertEqual(lines[1] + "\n", line)
        self.assertTrue(t.upgraded)
        self.assertEqual(LeaseTable(f).lease("203.0.113.5")[0], "127.20.66.113")

    def test_device_key_in_a_format_1_table_is_damage(self):
        f = os.path.join(tempdir(self), "leases")
        body = f"127.16.0.9 {DEV_A} 2026-11-15T17:32:10Z"
        import hashlib
        with open(f, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("# RINK-VT loopback leases · format 1 · pool 127.16.0.0/12 · ipv6 /128\n" + f"{body} {hashlib.sha256(body.encode()).hexdigest()[:16]}\n")
        with self.assertRaises(LoopbackError):
            LeaseTable(f)


if __name__ == "__main__":
    unittest.main()
