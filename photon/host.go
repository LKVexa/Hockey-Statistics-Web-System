// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// Starting the Photon host: check the release, take the data folder, open the league, identify this laptop and give
// it its static loopback address — the same on every network and in every league, and never another laptop's —
// listen on it, and open the workbench in an isolated Chromium-family window.

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

const (
	exitOK        = 0
	exitFail      = 1
	exitUsage     = 2
	exitIntegrity = 4
	exitLocked    = 5
	exitData      = 6
	exitNetwork   = 7
)

type hostOptions struct {
	data, deviceFile, fleet, leases, pool string
	port                                  int
	noBrowser, allowDefault, verifyOnly   bool
}

// leaseThisLaptop identifies this laptop and gives it its address: the pin its device file keeps (from its first
// lease, or from the fleet register when there is one), granted in this league's own lease table unless another
// laptop holds it there. Uniqueness within a table always wins: two laptops never share an address in one table.
func leaseThisLaptop(o hostOptions, machine func() string) (Obj, error) {
	dev, err := loadDevice(o.deviceFile, machine, true)
	if err != nil {
		return nil, err
	}
	notes := append([]string{}, dev.notes...)
	pool, err := newPool(o.pool) // refused here when it is not a valid loopback pool
	if err != nil {
		return nil, err
	}
	most := pool.capacity
	if most > 65536 {
		most = 65536
	}
	pin := ""
	if dev.pool() == pool.text {
		pin = dev.address()
	}
	if dev.address() != "" && pin == "" {
		notes = append(notes, fmt.Sprintf("this laptop's pinned address %s is from the pool %s; this start uses %s", dev.address(), dev.pool(), pool.text))
	}
	fleetPath := dev.fleet()
	if o.fleet != "" {
		fleetPath, _ = filepath.Abs(o.fleet)
	}
	var fleetState any
	fleetGiven := ""
	if fleetPath != "" {
		fleet, ferr := newLeaseTable(fleetPath, o.pool, 128, most, false)
		var fa string
		var fresh, moved bool
		if ferr == nil {
			fa, _, fresh, moved, ferr = fleet.lease(dev.key(), pin)
		}
		if ferr != nil {
			state := "unreachable (" + truncate(ferr.Error(), 120) + ")"
			if pin != "" {
				state += "; the pinned address is used"
			}
			fleetState = state
		} else {
			if moved {
				notes = append(notes, fmt.Sprintf("the fleet register already gives %s to another laptop; this laptop is enrolled as %s", pin, fa))
			}
			fleetState = "registered"
			if fresh {
				fleetState = "enrolled now"
			}
			pin, fleetGiven = fa, fleetPath
		}
	}
	tablePath := o.leases
	if tablePath == "" {
		tablePath = filepath.Join(o.data, "loopback", "leases")
	}
	table, err := newLeaseTable(tablePath, o.pool, 128, most, true)
	if err != nil {
		return nil, err
	}
	local, _, _, moved, err := table.lease(dev.key(), pin)
	if err != nil {
		return nil, err
	}
	var conflict any
	if moved {
		conflict = fmt.Sprintf("in this league's lease table another laptop holds %s, this laptop's address; here it is %s. "+
			"Enrol every laptop in one fleet register so that no two can meet on one address", pin, local)
	}
	if table.upgraded {
		notes = append(notes, "the league's lease table was upgraded to format 2 for device keys; every lease in it was kept")
	}
	keep := pin
	if keep == "" {
		keep = local
	}
	if _, err := dev.pin(keep, table.pool.text, fleetGiven); err != nil {
		return nil, err
	}
	noteList := []any{}
	for _, n := range notes {
		noteList = append(noteList, n)
	}
	leases, _ := table.stats().Get("leases")
	return Obj{{"local", local}, {"client", dev.label()}, {"device", dev.key()}, {"device_source", dev.source()}, {"device_file", dev.path},
		{"pinned", nullable(dev.address())}, {"pool", table.pool.text}, {"leases", leases}, {"fleet", nullable(fleetPath)},
		{"fleet_state", fleetState}, {"conflict", conflict}, {"notes", noteList}}, nil
}

func addrNotAvailable(err error) bool {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch uintptr(errno) {
		case 49, 99, 10049: // EADDRNOTAVAIL (macOS, Linux), WSAEADDRNOTAVAIL: this system has no such loopback address
			return true
		}
	}
	return false
}

// bind listens on this computer's loopback lease; where the system only answers on 127.0.0.1 (macOS), there.
func bind(local string, port int) (net.Listener, error) {
	ports := []int{port}
	if port == 0 {
		ports = nil
		for p := 8800; p < 8830; p++ {
			ports = append(ports, p)
		}
		ports = append(ports, 0)
	}
	var last error
	for _, address := range []string{local, "127.0.0.1"} {
		for _, p := range ports {
			ln, err := net.Listen("tcp4", fmt.Sprintf("%s:%d", address, p))
			if err == nil {
				return ln, nil
			}
			last = err
			if addrNotAvailable(err) {
				break
			}
		}
	}
	return nil, fmt.Errorf("no loopback port available: %v", last)
}

func newToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func printJSON(w io.Writer, v any) { fmt.Fprintln(w, pyDumpsIndent(v, 2, true, false)) }

func runHost(args []string) int {
	root := releaseRoot()
	fs := flag.NewFlagSet("rinkvt-photon", flag.ContinueOnError)
	var o hostOptions
	fs.StringVar(&o.data, "data", filepath.Join(root, "runtime"), "the data folder: the league, the event ledger, the lease table, the renderer profile")
	fs.IntVar(&o.port, "port", 0, "a fixed port; by default the first free one of 8800-8829")
	fs.StringVar(&o.deviceFile, "device-file", "", "this laptop's device file (identity and pinned address); by default in the user's application data")
	fs.StringVar(&o.fleet, "fleet", "", "the fleet register: one lease table every laptop of the club or league shares; remembered once given")
	fs.StringVar(&o.leases, "leases", "", "this league's lease table (default DIR/loopback/leases)")
	fs.StringVar(&o.pool, "pool", defaultPool, "where loopback leases come from (inside 127.0.0.0/8, not 127.0.0.0/16)")
	fs.BoolVar(&o.noBrowser, "no-browser", false, "do not open the renderer window")
	fs.BoolVar(&o.allowDefault, "allow-default-browser-fallback", false, "use the ordinary browser profile when no Edge/Chrome/Chromium is found")
	fs.BoolVar(&o.verifyOnly, "verify-only", false, "check the release and the league, print the report, exit")
	version := fs.Bool("version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if *version {
		fmt.Printf("%s %s · %s\n", PRODUCT, VERSION, EDITION)
		return exitOK
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "REFUSED: unexpected argument %q (rinkvt-photon help lists the commands)\n", fs.Arg(0))
		return exitUsage
	}
	if o.port < 0 || o.port > 65535 {
		fmt.Fprintln(os.Stderr, "REFUSED: the port must be 0-65535")
		return exitUsage
	}
	o.data, _ = filepath.Abs(o.data)
	if o.verifyOnly {
		return verifyOnly(root, o)
	}
	release := verifyRelease(root, "code")
	if ok, _ := release.Get("ok"); ok != true {
		fmt.Fprintln(os.Stderr, "REFUSED: the code of this release does not match RELEASE_MANIFEST.json (changed, missing or unlisted files "+
			"under photon/, ui/ or engine/). Restore it, or reseal a deliberate change with: rinkvt-photon seal")
		printJSON(os.Stderr, release)
		return exitIntegrity
	}
	if err := os.MkdirAll(o.data, 0o700); err != nil {
		fmt.Fprintf(os.Stderr, "REFUSED: the data folder %s cannot be made: %v\n", o.data, err)
		return exitData
	}
	lock := &InstanceLock{path: filepath.Join(o.data, ".rinkvt.lock")}
	if err := lock.acquire(); err != nil {
		fmt.Fprintf(os.Stderr, "REFUSED: %v\n", err)
		return exitLocked
	}
	defer lock.release()
	store, err := openLeagueStore(o.data)
	if err != nil {
		fmt.Fprintf(os.Stderr, "REFUSED: the league in %s cannot be opened: %v. Run with --verify-only for the full report; restore the folder from a backup.\n", o.data, err)
		return exitData
	}
	info, err := leaseThisLaptop(o, machineIdentifier)
	if err != nil {
		fmt.Fprintf(os.Stderr, "REFUSED: loopback lease: %v\n", err)
		return exitNetwork
	}
	local := info.Str("local")
	ln, err := bind(local, o.port)
	if err != nil {
		fmt.Fprintf(os.Stderr, "REFUSED: %v\n", err)
		return exitNetwork
	}
	info = info.Set("data", o.data)
	bound := ln.Addr().(*net.TCPAddr)
	info = info.Set("bound", bound.IP.String())
	host := newPhotonHost(ln, store, newToken(), filepath.Join(root, "ui"), info)
	url := fmt.Sprintf("http://%s:%d/", bound.IP.String(), bound.Port)
	fleetState, _ := info.Get("fleet_state")
	pinned, _ := info.Get("pinned")
	conflict, _ := info.Get("conflict")
	_ = store.events.add("start", Obj{{"version", VERSION}, {"local", local}, {"bound", bound.IP.String()}, {"port", bound.Port}, {"device", info.Str("client")},
		{"pinned", pinned}, {"fleet", fleetState}, {"conflict", conflict != nil}})
	fmt.Printf("%s %s · %s\n", PRODUCT, VERSION, EDITION)
	where := ""
	if bound.IP.String() != local {
		where = " (this system answers only on 127.0.0.1: listening there)"
	}
	fmt.Printf("  loopback %s · static for this laptop (%s)%s\n", local, info.Str("client"), where)
	if info.Str("fleet") != "" {
		fmt.Printf("  fleet      %s: %v\n", info.Str("fleet"), fleetState)
	}
	fmt.Printf("  workbench  %s\n", url)
	fmt.Printf("  league     %s (%d games)\n", o.data, store.gameCount())
	notes, _ := info.Get("notes")
	for _, n := range notes.([]any) {
		fmt.Printf("  NOTE: %v\n", n)
	}
	if conflict != nil {
		fmt.Printf("  WARNING: %v\n", conflict)
	}
	fmt.Println("  The listener is loopback only; Host, Origin and a per-launch token guard it. Ctrl+C stops the host.")
	if !o.noBrowser {
		time.AfterFunc(300*time.Millisecond, func() {
			if launchRenderer(url, filepath.Join(o.data, "browser_profile"), o.allowDefault) == "" {
				fmt.Fprintf(os.Stderr, "  No Edge, Chrome or Chromium was found: open %s yourself, or restart with --allow-default-browser-fallback.\n", url)
			}
		})
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP) // Ctrl+C, a service manager, a closed console
	go func() { <-sig; host.shutdown() }()
	err = host.serve()
	signal.Stop(sig)
	_ = store.events.add("stop", nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "the listener failed: %v\n", err)
		return exitNetwork
	}
	return exitOK
}

// verifyOnly checks the release (every file) and the league, read only: no lock is made or taken over, nothing is
// repaired, and a folder a running host holds is left to that host's own store verify.
func verifyOnly(root string, o hostOptions) int {
	release := verifyRelease(root, "all")
	report := Obj{{"release", release}}
	var league Obj
	if st, err := os.Stat(filepath.Join(o.data, "league")); err != nil || !st.IsDir() {
		league = Obj{{"ok", true}, {"note", fmt.Sprintf("no league in %s yet", o.data)}}
	} else if holder := (&InstanceLock{path: filepath.Join(o.data, ".rinkvt.lock")}).holder(); holder != "" {
		league = Obj{{"ok", true}, {"skipped", holder + ". Type store verify in its workbench to check the league it holds."}}
	} else {
		league = verifyFolder(o.data)
	}
	report = append(report, KV{"league", league})
	dev, err := loadDevice(o.deviceFile, machineIdentifier, false)
	if err == nil && dev != nil {
		report = append(report, KV{"device", append(dev.report(), KV{"ok", true})})
	} else {
		report = append(report, KV{"device", Obj{{"ok", true}, {"note", "this laptop has no device file yet; the first start makes it"}}})
	}
	printJSON(os.Stdout, report)
	rok, _ := release.Get("ok")
	lok, _ := league.Get("ok")
	if rok == true && lok == true {
		return exitOK
	}
	return exitFail
}
