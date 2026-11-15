// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// Every laptop keeps its own static 127 address: its identity, its device file, its leases in every league, and a
// fleet register that makes the addresses unique everywhere.

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const machineA, machineB = "4c4c4544003910398053b4c04f584e33", "0f1e2d3c4b5a69788796a5b4c3d2e1f0"

func machine(id string) func() string { return func() string { return id } }

func startLaptop(t *testing.T, deviceFile, data, fleet, id string) Obj {
	t.Helper()
	info, err := leaseThisLaptop(hostOptions{data: data, deviceFile: deviceFile, fleet: fleet, pool: defaultPool}, machine(id))
	fatalIf(t, err != nil, "start: %v", err)
	return info
}

func TestDeviceKeyIsAnApplicationDigestOfTheMachine(t *testing.T) {
	k := deriveDeviceKey(machineA)
	fatalIf(t, k != "device:786ccb4ad0fe713fbca602c54b373160", "the device key of the vector: %s", k)
	fatalIf(t, deriveDeviceKey(" "+strings.ToUpper(machineA)+"\n") != k, "case and spaces change the key")
	fatalIf(t, strings.Contains(k, machineA[:8]), "the key shows the machine identifier")
}

func TestDeviceFileSealedAndKept(t *testing.T) {
	f := filepath.Join(t.TempDir(), "device.json")
	d, err := loadDevice(f, machine(machineA), true)
	fatalIf(t, err != nil || d.source() != "machine", "%v", err)
	d.pin("127.26.220.77", defaultPool, "")
	raw, _ := os.ReadFile(f)
	fatalIf(t, strings.Contains(string(raw), machineA), "the device file keeps the machine identifier")
	again, _ := loadDevice(f, machine(machineA), false)
	fatalIf(t, again == nil || again.address() != "127.26.220.77" || len(again.notes) > 0, "the device file was not kept")
}

func TestDeviceACopiedDeviceFileDoesNotMakeTwoLaptopsOne(t *testing.T) {
	f := filepath.Join(t.TempDir(), "device.json")
	a, _ := loadDevice(f, machine(machineA), true)
	b, _ := loadDevice(f, machine(machineB), true)
	fatalIf(t, a.key() == b.key() || len(b.notes) != 1 || !strings.Contains(b.notes[0], "another computer"), "a copied device file made two laptops one")
}

func TestDeviceDamagedFileIsReplacedAndSaid(t *testing.T) {
	f := filepath.Join(t.TempDir(), "device.json")
	loadDevice(f, machine(machineA), true)
	raw, _ := os.ReadFile(f)
	os.WriteFile(f, bytes.Replace(raw, []byte(`"source": "machine"`), []byte(`"source": "random"`), 1), 0o600)
	d, err := loadDevice(f, machine(machineA), true)
	fatalIf(t, err != nil || len(d.notes) != 1 || !strings.Contains(d.notes[0], "unreadable"), "a damaged device file: %v %v", err, d.notes)
	fatalIf(t, d.key() != deriveDeviceKey(machineA), "the new device file has another identity")
}

func TestDeviceWithoutAMachineIdentifierARandomIdentityIsKept(t *testing.T) {
	f := filepath.Join(t.TempDir(), "device.json")
	a, _ := loadDevice(f, machine(""), true)
	b, _ := loadDevice(f, machine(""), true)
	fatalIf(t, a.source() != "random" || a.key() != b.key(), "a random identity was not kept")
}

func TestDeviceUnwritableDeviceFileRefused(t *testing.T) {
	// a folder that cannot be made, on every system and for every account: its parent is a file
	blocker := filepath.Join(t.TempDir(), "not-a-folder")
	os.WriteFile(blocker, []byte("x"), 0o600)
	_, err := loadDevice(filepath.Join(blocker, "RINK-VT", "device.json"), machine(machineA), true)
	_, isDev := err.(*DeviceError)
	fatalIf(t, !isDev, "an unwritable device file: %v", err)
}

func TestDeviceStaticAcrossLeaguesNetworksAndRestarts(t *testing.T) {
	f := filepath.Join(t.TempDir(), "device.json")
	one := startLaptop(t, f, t.TempDir(), "", machineA)
	two := startLaptop(t, f, t.TempDir(), "", machineA)
	again := startLaptop(t, f, t.TempDir(), "", machineA)
	fatalIf(t, one.Str("local") != "127.26.220.77" || two.Str("local") != one.Str("local") || again.Str("local") != one.Str("local"),
		"one laptop, three leagues: %s %s %s", one.Str("local"), two.Str("local"), again.Str("local"))
}

func TestDeviceTwoLaptopsInOneLeagueNeverShare(t *testing.T) {
	data := t.TempDir()
	fa, fb := filepath.Join(t.TempDir(), "a.json"), filepath.Join(t.TempDir(), "b.json")
	a := startLaptop(t, fa, data, "", machineA)
	db, _ := loadDevice(fb, machine(machineB), true)
	db.pin(a.Str("local"), defaultPool, "") // laptop B already holds A's address somewhere else
	b := startLaptop(t, fb, data, "", machineB)
	conflict, _ := b.Get("conflict")
	fatalIf(t, a.Str("local") == b.Str("local") || conflict == nil, "two laptops met on one address in one league")
}

func TestDeviceFleetRegisterMakesEveryLaptopUniqueEverywhere(t *testing.T) {
	fleet := filepath.Join(t.TempDir(), "fleet")
	fa, fb := filepath.Join(t.TempDir(), "a.json"), filepath.Join(t.TempDir(), "b.json")
	db, _ := loadDevice(fb, machine(machineB), true)
	db.pin("127.26.220.77", defaultPool, "") // B's pin collides with A's natural address
	a := startLaptop(t, fa, t.TempDir(), fleet, machineA)
	b := startLaptop(t, fb, t.TempDir(), fleet, machineB)
	fatalIf(t, a.Str("local") == b.Str("local"), "the fleet register gave one address twice")
	again := startLaptop(t, fb, t.TempDir(), "", machineB) // remembered without --fleet
	fatalIf(t, again.Str("local") != b.Str("local") || again.Str("fleet") != fleet, "the register was not remembered")
}

func TestDeviceUnreachableRegisterKeepsThePin(t *testing.T) {
	f := filepath.Join(t.TempDir(), "device.json")
	first := startLaptop(t, f, t.TempDir(), "", machineA)
	gone := filepath.Join(t.TempDir(), "unplugged-disk", "fleet")
	info := startLaptop(t, f, t.TempDir(), gone, machineA)
	state, _ := info.Get("fleet_state")
	fatalIf(t, info.Str("local") != first.Str("local") || !strings.HasPrefix(state.(string), "unreachable"), "an unreachable register: %v", state)
	fatalIf(t, exists(filepath.Dir(gone)), "a missing register was created in its place")
}

func captureStdout(t *testing.T, fn func() int) (string, int) {
	t.Helper()
	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w
	code := fn()
	w.Close()
	os.Stdout = old
	out, _ := io.ReadAll(r)
	return string(out), code
}

func TestDeviceEnrolTool(t *testing.T) {
	f := filepath.Join(t.TempDir(), "device.json")
	fleet := filepath.Join(t.TempDir(), "fleet")
	t.Setenv("RINKVT_DEVICE_FILE", f)
	out, code := captureStdout(t, func() int { return cmdLeases([]string{"--enroll", fleet}) })
	fatalIf(t, code != 0 || !strings.Contains(out, "enrolled now"), "enrol: %d %s", code, out)
	out, _ = captureStdout(t, func() int { return cmdLeases([]string{"--this-laptop"}) })
	fatalIf(t, !strings.Contains(out, fleet), "this laptop does not name its register: %s", out)
	tb, err := newLeaseTable(fleet, defaultPool, 128, 65536, false)
	fatalIf(t, err != nil || len(tb.byKey) != 1, "the register: %v", err)
}
