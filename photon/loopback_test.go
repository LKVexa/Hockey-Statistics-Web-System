// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// Static loopback leases: a laptop keeps one 127.x.y.z address; an IP address gets the one the reference edition
// gives it.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var referenceAddresses = map[string]string{
	"203.0.113.5": "127.20.66.113", "198.51.100.7": "127.25.34.133", "10.0.0.1": "127.18.240.207",
	"::ffff:192.0.2.44": "127.26.105.28", "2001:db8::1": "127.18.166.142", "[2001:db8::2]:443": "127.22.152.35",
	"192.0.2.44:8080": "127.26.105.28", "fe80::1%eth0": "127.29.105.216",
}
var referenceSmallPool = []string{"127.200.0.83", "127.200.0.253", "127.200.0.225", "127.200.0.55", "127.200.0.198", "127.200.0.199"}

const devA, devB = "device:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "device:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func memTable(t *testing.T, pool string, max int) *LeaseTable {
	tb, err := newLeaseTable("", pool, 128, max, true)
	fatalIf(t, err != nil, "%v", err)
	return tb
}

func lease(t *testing.T, tb *LeaseTable, key, prefer string) (string, bool, bool) {
	t.Helper()
	a, _, fresh, moved, err := tb.lease(key, prefer)
	fatalIf(t, err != nil, "%s: %v", key, err)
	return a, fresh, moved
}

func TestLoopbackCanonicalForms(t *testing.T) {
	for raw, want := range map[string]string{"192.0.2.44:8080": "192.0.2.44", "[2001:DB8::2]:443": "2001:db8::2", "::ffff:192.0.2.44": "192.0.2.44",
		"fe80::1%eth0": "fe80::1", " 10.0.0.1 ": "10.0.0.1", "2001:db8:0:0:1:0:0:1": "2001:db8::1:0:0:1"} {
		got, ok := canonicalIP(raw)
		fatalIf(t, !ok || got != want, "%q gave %q, not %q", raw, got, want)
	}
	for _, raw := range []string{"", "nope", "999.1.1.1", "010.0.0.1", strings.Repeat("1", 70)} {
		_, ok := canonicalIP(raw)
		fatalIf(t, ok, "%q was taken for an address", raw)
	}
}

func TestLoopbackIPv6PrefixKeys(t *testing.T) {
	k, _ := clientKey("2001:db8::1234", 64)
	fatalIf(t, k != "2001:db8::/64", "a /64 key: %s", k)
	k, _ = clientKey("203.0.113.5", 64)
	fatalIf(t, k != "203.0.113.5", "IPv4 keys are whole addresses: %s", k)
}

// The default pool and its capacity, and pools refused: outside 127/8, overlapping 127.0.0.0/16, wider than /9 or
// narrower than /24, or not a network address.
func TestLoopbackPools(t *testing.T) {
	p, err := newPool(defaultPool)
	fatalIf(t, err != nil || p.capacity != 1040384 || p.addressAt(0) != "127.16.0.1" || p.addressAt(254) != "127.16.1.1", "the default pool: %v", err)
	for _, bad := range []string{"10.0.0.0/12", "127.0.0.0/12", "127.16.0.0/8", "127.16.0.0/25", "127.16.0.1/12", "127.16/12", "127.0.200.0/24"} {
		_, err := newPool(bad)
		fatalIf(t, loopCode(err) != "POOL", "%s was accepted", bad)
	}
}

func TestLoopbackSameAddressesAsTheReferenceEdition(t *testing.T) {
	tb := memTable(t, defaultPool, 65536)
	for raw, want := range referenceAddresses {
		a, _, _ := lease(t, tb, raw, "")
		fatalIf(t, a != want, "%s: %s, not %s", raw, a, want)
	}
}

func TestLoopbackSameProbingAsTheReferenceEdition(t *testing.T) {
	tb := memTable(t, "127.200.0.0/24", 254)
	for i, want := range referenceSmallPool {
		a, _, _ := lease(t, tb, fmt.Sprintf("192.0.2.%d", i), "")
		fatalIf(t, a != want, "192.0.2.%d: %s, not %s", i, a, want)
	}
}

func TestLoopbackIPv6PrefixAgreement(t *testing.T) {
	tb, _ := newLeaseTable("", defaultPool, 64, 65536, true)
	a1, _, _, _, _ := tb.lease("2001:db8::1", "")
	a2, _, _, _, _ := tb.lease("2001:db8::ffff", "")
	fatalIf(t, a1 != "127.25.77.133" || a2 != a1, "a /64 shares one lease: %s %s", a1, a2)
}

func TestLoopbackStaticAcrossRestarts(t *testing.T) {
	f := filepath.Join(t.TempDir(), "leases")
	first, _ := newLeaseTable(f, defaultPool, 128, 65536, true)
	a, fresh, _ := lease(t, first, devA, "")
	fatalIf(t, !fresh, "a first lease is fresh")
	again, _ := newLeaseTable(f, defaultPool, 128, 65536, true)
	b, fresh2, _ := lease(t, again, devA, "")
	fatalIf(t, a != b || fresh2, "a lease changed across a restart")
}

func TestLoopbackUniqueForManyAddresses(t *testing.T) {
	tb := memTable(t, defaultPool, 65536)
	seen := map[string]bool{}
	for i := 0; i < 3000; i++ {
		a, _, _ := lease(t, tb, fmt.Sprintf("10.%d.%d.%d", i/65536, i/256%256, i%256), "")
		fatalIf(t, seen[a], "%s given twice", a)
		seen[a] = true
	}
}

// A table whose leases fill its maximum refuses a new key (FULL) and keeps every lease it has.
func TestLoopbackFull(t *testing.T) {
	tb := memTable(t, "127.200.0.0/24", 3)
	held := map[string]string{}
	for i := 0; i < 3; i++ {
		k := fmt.Sprintf("192.0.2.%d", i)
		held[k], _, _ = lease(t, tb, k, "")
	}
	_, _, _, _, err := tb.lease("192.0.2.200", "")
	fatalIf(t, loopCode(err) != "FULL", "a full table: %v", err)
	for k, a := range held {
		got, fresh, _ := lease(t, tb, k, "")
		fatalIf(t, got != a || fresh, "%s lost its lease %s after the refusal: %s", k, a, got)
	}
}

func TestLoopbackSharedFileBetweenTwoTables(t *testing.T) {
	f := filepath.Join(t.TempDir(), "fleet")
	one, _ := newLeaseTable(f, defaultPool, 128, 65536, true)
	two, _ := newLeaseTable(f, defaultPool, 128, 65536, true)
	a, _, _ := lease(t, one, devA, "")
	b, _, _ := lease(t, two, devB, a) // two asks for one's address: it is taken there
	fatalIf(t, a == b, "two tables on one file gave one address twice")
	a2, _, _ := lease(t, two, devA, "")
	fatalIf(t, a2 != a, "the second table does not see the first one's lease")
}

func TestLoopbackTornLastLineDropped(t *testing.T) {
	f := filepath.Join(t.TempDir(), "leases")
	tb, _ := newLeaseTable(f, defaultPool, 128, 65536, true)
	lease(t, tb, devA, "")
	h, _ := os.OpenFile(f, os.O_APPEND|os.O_WRONLY, 0)
	h.WriteString("127.16.0.9 device:cccc")
	h.Close()
	again, err := newLeaseTable(f, defaultPool, 128, 65536, true)
	fatalIf(t, err != nil || len(again.byKey) != 1, "the cut-off lease line was not dropped: %v", err)
}

func TestLoopbackDamageRefused(t *testing.T) {
	f := filepath.Join(t.TempDir(), "leases")
	tb, _ := newLeaseTable(f, defaultPool, 128, 65536, true)
	a, _, _ := lease(t, tb, devA, "")
	raw, _ := os.ReadFile(f)
	os.WriteFile(f, []byte(strings.Replace(string(raw), a+" ", "127.16.0.2 ", 1)), 0o600)
	_, err := newLeaseTable(f, defaultPool, 128, 65536, true)
	fatalIf(t, loopCode(err) != "DAMAGED", "an edited lease line: %v", err)
}

func TestLoopbackPoolChangeRefused(t *testing.T) {
	f := filepath.Join(t.TempDir(), "leases")
	newLeaseTable(f, defaultPool, 128, 65536, true)
	_, err := newLeaseTable(f, "127.32.0.0/12", 128, 65536, true)
	fatalIf(t, loopCode(err) != "POOL_CHANGED", "another pool on one file: %v", err)
}

func TestLoopbackSlotIsTheDocumentedHash(t *testing.T) {
	h := shaHex("RINK-VT loopback 1\x00203.0.113.5")
	var v uint64
	fmt.Sscanf(h[:16], "%x", &v)
	fatalIf(t, slotOf("203.0.113.5", 1040384) != int(v%1040384), "the slot is not SHA-256 mod capacity")
}

func TestLoopbackDeviceKeysAreKeys(t *testing.T) {
	k, ok := clientKey(" "+devA+" ", 128)
	fatalIf(t, !ok || k != devA, "a device key is a key as it stands")
	_, ok = clientKey("device:xyz", 128)
	fatalIf(t, ok, "a malformed device key was taken")
}

func TestLoopbackNewTablesAreFormat2AndHoldDeviceKeys(t *testing.T) {
	f := filepath.Join(t.TempDir(), "leases")
	tb, _ := newLeaseTable(f, defaultPool, 128, 65536, true)
	lease(t, tb, devA, "")
	raw, _ := os.ReadFile(f)
	fatalIf(t, !strings.HasPrefix(string(raw), "# RINK-VT loopback leases · format 2 · pool 127.16.0.0/12 · ipv6 /128\n"), "the header is not format 2")
}

func TestLoopbackAPinIsHonouredWhereItIsFree(t *testing.T) {
	tb := memTable(t, defaultPool, 65536)
	a, _, moved := lease(t, tb, devA, "127.30.1.2")
	fatalIf(t, a != "127.30.1.2" || moved, "a free pin was not given")
	b, _, moved := lease(t, tb, devB, "127.30.1.2")
	fatalIf(t, b == a || !moved, "a pin held by another laptop was given again")
	c, _, _ := lease(t, memTable(t, defaultPool, 65536), devB, "10.0.0.1")
	fatalIf(t, c == "10.0.0.1", "a pin outside the pool was used")
}

func TestLoopbackFormat1TableUpgradedOnceLinesKept(t *testing.T) {
	f := filepath.Join(t.TempDir(), "leases")
	body := "203.0.113.5 203.0.113.5 2026-11-01T00:00:00Z"
	old := "# RINK-VT loopback leases · format 1 · pool 127.16.0.0/12 · ipv6 /128\n127.20.66.113 " + body[12:] + " " + shaHex("127.20.66.113 " + body[12:])[:16] + "\n"
	os.WriteFile(f, []byte(old), 0o600)
	tb, err := newLeaseTable(f, defaultPool, 128, 65536, true)
	fatalIf(t, err != nil || tb.fileFormat != 1, "a format 1 table: %v", err)
	lease(t, tb, devA, "")
	fatalIf(t, !tb.upgraded, "the table was not upgraded")
	raw, _ := os.ReadFile(f)
	lines := strings.Split(string(raw), "\n")
	fatalIf(t, !strings.Contains(lines[0], "format 2") || lines[1] != strings.Split(old, "\n")[1], "the upgrade did not keep the lines")
	again, err := newLeaseTable(f, defaultPool, 128, 65536, true)
	fatalIf(t, err != nil || len(again.byKey) != 2, "the upgraded table did not read back: %v", err)
}

func TestLoopbackDeviceKeyInAFormat1TableIsDamage(t *testing.T) {
	f := filepath.Join(t.TempDir(), "leases")
	body := "127.16.0.9 " + devA + " 2026-11-01T00:00:00Z"
	os.WriteFile(f, []byte("# RINK-VT loopback leases · format 1 · pool 127.16.0.0/12 · ipv6 /128\n"+body+" "+shaHex(body)[:16]+"\n"), 0o600)
	_, err := newLeaseTable(f, defaultPool, 128, 65536, true)
	fatalIf(t, loopCode(err) != "DAMAGED", "a device key in a format 1 table: %v", err)
}
