// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// This laptop's identity: the key its static loopback address belongs to.
//
// An IP address is not a laptop: a laptop takes a new one on every network, and two laptops on two networks can hold
// the same one. So the lease belongs to the laptop instead. Its identity is derived from the operating system's own
// machine identifier, which stays the same across networks, users, reinstalls of RINK-VT and data folders:
//
//	Windows   HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
//	macOS     IOPlatformUUID (ioreg)
//	Linux     /etc/machine-id, else /var/lib/dbus/machine-id
//
//	device key = "device:" + the first 32 hex digits of HMAC-SHA-256(key "RINK-VT device 1", machine identifier)
//
// The machine identifier itself is never stored or shown, only this application-specific digest of it. A computer
// that has no machine identifier gets a random 128-bit key instead, kept in its device file.
//
// The device file, one per user and laptop, outside every data folder, keeps the key and the laptop's pinned
// address: the 127 address the laptop received first (or from its fleet register) and asks for in every lease table.
//
//	Windows   %LOCALAPPDATA%\RINK-VT\device.json
//	macOS     ~/Library/Application Support/RINK-VT/device.json
//	Linux     $XDG_DATA_HOME/rink-vt/device.json (~/.local/share/rink-vt/device.json)
//	any       RINKVT_DEVICE_FILE, or the host's --device-file

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const deviceFormat = "rinkvt.device.v1"

type DeviceError struct{ Msg string }

func (e *DeviceError) Error() string { return e.Msg }

// deriveDeviceKey is the device key of a machine identifier (an application-specific digest; the identifier is not
// recoverable from it).
func deriveDeviceKey(machineID string) string {
	m := hmac.New(sha256.New, []byte("RINK-VT device 1"))
	m.Write([]byte(strings.ToLower(strings.TrimSpace(machineID))))
	return "device:" + hex.EncodeToString(m.Sum(nil))[:32]
}

func defaultDevicePath() string {
	if env := os.Getenv("RINKVT_DEVICE_FILE"); env != "" {
		p, _ := filepath.Abs(env)
		return p
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "RINK-VT", "device.json")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "RINK-VT", "device.json")
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "rink-vt", "device.json")
}

// deviceSeal seals every field but the seal itself (sorted keys, compact, ASCII), as every release has.
func deviceSeal(doc Obj) string {
	body := Obj{}
	for _, kv := range doc {
		if kv.K != "seal" {
			body = append(body, kv)
		}
	}
	return sha256Hex([]byte(pyDumps(body, true, true)))[:16]
}

// Device is the identity and pinned address of this laptop, as its device file keeps them.
type Device struct {
	path  string
	doc   Obj
	notes []string
}

func (d *Device) key() string    { return d.doc.Str("device") }
func (d *Device) source() string { return d.doc.Str("source") }
func (d *Device) label() string  { return "device " + d.key()[7:15] }
func (d *Device) address() string {
	return d.doc.Str("address")
}
func (d *Device) pool() string  { return d.doc.Str("pool") }
func (d *Device) fleet() string { return d.doc.Str("fleet") }

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// loadDevice returns the device of this laptop. With create, a missing, damaged or foreign file is replaced (and
// said so); without it, a missing or unusable file gives nil.
func loadDevice(path string, machine func() string, create bool) (*Device, error) {
	if path == "" {
		path = defaultDevicePath()
	}
	path, _ = filepath.Abs(path)
	mine := ""
	if mid := machine(); mid != "" {
		mine = deriveDeviceKey(mid)
	}
	var notes []string
	var doc Obj
	if exists(path) {
		raw, err := os.ReadFile(path)
		if err == nil {
			var v any
			if v, err = parseJSON(string(raw)); err == nil {
				o, ok := v.(Obj)
				if !ok || o.Str("format") != deviceFormat || !deviceRE.MatchString(o.Str("device")) || o.Str("seal") != deviceSeal(o) {
					err = fmt.Errorf("not a sealed device file")
				} else {
					doc = o
				}
			}
		}
		if err != nil {
			msg := err.Error()
			if len(msg) > 80 {
				msg = msg[:80]
			}
			notes = append(notes, fmt.Sprintf("the device file %s was unreadable (%s); a new one was made", path, msg))
			doc = nil
		}
		if doc != nil && doc.Str("source") == "machine" && mine != "" && doc.Str("device") != mine {
			notes = append(notes, "the device file was made on another computer (copied with a user profile); this laptop has an identity of its own")
			doc = nil
		}
	}
	if doc == nil {
		if !create {
			return nil, nil
		}
		key, source := mine, "machine"
		if key == "" {
			b := make([]byte, 16)
			if _, err := rand.Read(b); err != nil {
				return nil, err
			}
			key, source = "device:"+hex.EncodeToString(b), "random"
		}
		doc = Obj{{"format", deviceFormat}, {"device", key}, {"source", source}, {"created", time.Now().UTC().Format("2006-01-02T15:04:05Z")},
			{"address", nil}, {"pool", nil}, {"pinned", nil}, {"fleet", nil}}
		d := &Device{path: path, doc: doc, notes: notes}
		if err := d.save(); err != nil {
			return nil, err
		}
		return d, nil
	}
	return &Device{path: path, doc: doc, notes: notes}, nil
}

func (d *Device) save() error {
	d.doc = d.doc.Set("seal", deviceSeal(d.doc))
	data := []byte(pyDumpsIndent(d.doc, 1, true, true) + "\n")
	fail := func(err error) error {
		return &DeviceError{fmt.Sprintf("the device file %s cannot be written (%v); give one with --device-file", d.path, err)}
	}
	if err := os.MkdirAll(filepath.Dir(d.path), 0o700); err != nil {
		return fail(err)
	}
	tmp := fmt.Sprintf("%s.%d.tmp", d.path, os.Getpid())
	if err := writeDurable(tmp, data); err != nil {
		return fail(err)
	}
	if err := os.Rename(tmp, d.path); err != nil {
		os.Remove(tmp)
		return fail(err)
	}
	return nil
}

// pin records the address this laptop keeps (and the fleet register that gave it, if one did).
func (d *Device) pin(address, pool, fleet string) (bool, error) {
	changed := d.address() != address || d.pool() != pool || (fleet != "" && fleet != d.fleet())
	if !changed {
		return false, nil
	}
	d.doc = d.doc.Set("address", address).Set("pool", pool).Set("pinned", time.Now().UTC().Format("2006-01-02T15:04:05Z"))
	if fleet != "" {
		d.doc = d.doc.Set("fleet", fleet)
	}
	return true, d.save()
}

func (d *Device) report() Obj {
	return Obj{{"device", d.key()}, {"label", d.label()}, {"source", d.source()}, {"address", nullable(d.address())}, {"pool", nullable(d.pool())},
		{"fleet", nullable(d.fleet())}, {"file", d.path}}
}
