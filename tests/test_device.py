# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""Every laptop keeps its own 127 address: the same on every network and in every league, and never another laptop's."""
import json
import os
import subprocess
import sys
import unittest
from types import SimpleNamespace

from helpers import ROOT, tempdir

from host.device import Device, DeviceError, derive
from host.loopback import LeaseTable, slot_of, Pool

sys.path.insert(0, os.path.join(ROOT, "photon"))
import rinkvt  # noqa: E402

MACHINE_A = "4c4c4544003910398053b4c04f584e33"
MACHINE_B = "9f1e2d3c4b5a69788796a5b4c3d2e1f0"


def laptop(test, machine):
    return SimpleNamespace(device_file=os.path.join(tempdir(test), "device.json"), machine=machine)


def start(ns_laptop, data, fleet=None, pool="127.16.0.0/12", monkey=None):
    """The host's lease step for one laptop, as a start runs it."""
    ns = SimpleNamespace(device_file=ns_laptop.device_file, fleet=fleet, leases=None, data=data, pool=pool)
    real = Device.load
    Device.load = classmethod(lambda cls, path=None, machine=None, create=True: real.__func__(cls, path, machine=lambda: ns_laptop.machine, create=create))
    try:
        return rinkvt.lease_this_laptop(ns)
    finally:
        Device.load = real


class Identity(unittest.TestCase):
    def test_key_is_an_application_digest_of_the_machine(self):
        k = derive(MACHINE_A)
        self.assertRegex(k, r"^device:[0-9a-f]{32}$")
        self.assertEqual(k, derive(MACHINE_A.upper()))
        self.assertNotEqual(k, derive(MACHINE_B))
        self.assertNotIn(MACHINE_A[:12], k)

    def test_device_file_sealed_and_kept(self):
        f = os.path.join(tempdir(self), "d", "device.json")
        d = Device.load(f, machine=lambda: MACHINE_A)
        self.assertEqual(d.key, derive(MACHINE_A))
        d.pin("127.20.1.1", "127.16.0.0/12")
        again = Device.load(f, machine=lambda: MACHINE_A)
        self.assertEqual((again.address, again.notes), ("127.20.1.1", []))
        with open(f, encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertNotIn(MACHINE_A, json.dumps(doc))                      # the machine identifier is never stored

    def test_a_copied_device_file_does_not_make_two_laptops_one(self):
        f = os.path.join(tempdir(self), "device.json")
        Device.load(f, machine=lambda: MACHINE_A).pin("127.20.1.1", "127.16.0.0/12")
        b = Device.load(f, machine=lambda: MACHINE_B)                    # the profile moved to another laptop
        self.assertEqual(b.key, derive(MACHINE_B))
        self.assertIsNone(b.address)
        self.assertTrue(b.notes)

    def test_damaged_file_is_replaced_and_said(self):
        f = os.path.join(tempdir(self), "device.json")
        Device.load(f, machine=lambda: MACHINE_A)
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(" ")
        with open(f, "r+", encoding="utf-8") as fh:
            text = fh.read().replace('"source": "machine"', '"source": "random"')
            fh.seek(0)
            fh.write(text)
        d = Device.load(f, machine=lambda: MACHINE_A)
        self.assertEqual(d.key, derive(MACHINE_A))                       # recomputed: the same laptop, the same key
        self.assertTrue(d.notes)

    def test_without_a_machine_identifier_a_random_identity_is_kept(self):
        f = os.path.join(tempdir(self), "device.json")
        a = Device.load(f, machine=lambda: None)
        self.assertEqual(a.source, "random")
        self.assertEqual(Device.load(f, machine=lambda: None).key, a.key)

    def test_unwritable_device_file_refused(self):
        d = tempdir(self)
        blocker = os.path.join(d, "file")
        with open(blocker, "w") as fh:
            fh.write("x")
        with self.assertRaises(DeviceError):
            Device.load(os.path.join(blocker, "device.json"), machine=lambda: MACHINE_A)


class PerLaptop(unittest.TestCase):
    def test_static_across_leagues_networks_and_restarts(self):
        a = laptop(self, MACHINE_A)
        first = start(a, os.path.join(tempdir(self), "league1"))
        self.assertEqual(first["local"], first["pinned"])
        self.assertEqual(start(a, os.path.join(tempdir(self), "league2"))["local"], first["local"])   # another league
        self.assertEqual(start(a, os.path.join(tempdir(self), "league2"))["local"], first["local"])   # a restart
        pool = Pool("127.16.0.0/12")
        self.assertEqual(first["local"], pool.address_at(slot_of(derive(MACHINE_A), pool.capacity)))  # no IP in it

    def test_two_laptops_in_one_league_never_share(self):
        league = os.path.join(tempdir(self), "league")
        a, b = laptop(self, MACHINE_A), laptop(self, MACHINE_B)
        ra = start(a, league, pool="127.200.0.0/24")
        # make B's pin collide with A's address: B's first league gave it the same address elsewhere
        Device.load(b.device_file, machine=lambda: MACHINE_B).pin(ra["local"], "127.200.0.0/24")
        rb = start(b, league, pool="127.200.0.0/24")
        self.assertNotEqual(rb["local"], ra["local"])
        self.assertIn("another laptop holds", rb["conflict"])
        self.assertEqual(rb["pinned"], ra["local"])                       # its identity elsewhere is unchanged

    def test_fleet_register_makes_every_laptop_unique_everywhere(self):
        fleet_dir = tempdir(self)
        fleet = os.path.join(fleet_dir, "fleet-leases")
        a, b = laptop(self, MACHINE_A), laptop(self, MACHINE_B)
        # both laptops already picked the same address on their own (the rare collision a register prevents)
        for x in (a, b):
            Device.load(x.device_file, machine=lambda m=x.machine: m).pin("127.200.0.42", "127.200.0.0/24")
        ra = start(a, os.path.join(tempdir(self), "la"), fleet=fleet, pool="127.200.0.0/24")
        rb = start(b, os.path.join(tempdir(self), "lb"), fleet=fleet, pool="127.200.0.0/24")
        self.assertEqual(ra["local"], "127.200.0.42")
        self.assertNotEqual(rb["local"], ra["local"])
        self.assertEqual((ra["fleet_state"], rb["fleet_state"]), ("enrolled now", "enrolled now"))
        # the register is remembered: later starts consult it without --fleet, and the address holds
        rb2 = start(b, os.path.join(tempdir(self), "lc"), pool="127.200.0.0/24")
        self.assertEqual((rb2["local"], rb2["fleet_state"]), (rb["local"], "registered"))
        self.assertIsNone(rb2["conflict"])

    def test_unreachable_register_keeps_the_pin(self):
        a = laptop(self, MACHINE_A)
        r1 = start(a, os.path.join(tempdir(self), "l1"), fleet=os.path.join(tempdir(self), "fleet"))
        gone = os.path.join(tempdir(self), "absent-share", "fleet")       # the share is not connected
        r2 = start(a, os.path.join(tempdir(self), "l2"), fleet=gone)
        self.assertEqual(r2["local"], r1["local"])
        self.assertIn("unreachable", r2["fleet_state"])
        self.assertFalse(os.path.exists(os.path.dirname(gone)))           # never made in its place

    def test_enrol_tool(self):
        f = os.path.join(tempdir(self), "device.json")
        fleet = os.path.join(tempdir(self), "fleet")
        env = dict(os.environ, RINKVT_DEVICE_FILE=f)
        p = subprocess.run([sys.executable, "-I", "-B", os.path.join(ROOT, "tools", "leases.py"), "--enroll", fleet], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("enrolled now", p.stdout)
        p = subprocess.run([sys.executable, "-I", "-B", os.path.join(ROOT, "tools", "leases.py"), "--this-laptop"], capture_output=True, text=True, env=env, timeout=60)
        self.assertIn(fleet, p.stdout)
        table = LeaseTable(fleet)
        self.assertEqual(table.stats()["leases"], 1)


if __name__ == "__main__":
    unittest.main()
