// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// The renderer bundle and the lease tool.
//
// ui/workbench.js is the module loader (ui/loader.js) holding the engine's modules and data, the rink drawing
// (engine/rink/web/rink.js) and the page (ui/app.js); ui/workbench.html is ui/workbench.template.html with the version.
// Nothing is minified or rewritten: the page runs the engine's own source text; the data tables are written compactly.

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var bundleModules = []string{
	"rink/shared/codes.js", "rink/shared/hcl.js", "rink/shared/wire.js", "rink/shared/xg.js", "rink/shared/fmt.js", "rink/shared/assist.js", "rink/shared/hash.js",
	"rink/server/overtime.js", "rink/server/registry.js", "rink/server/demo.js", "rink/server/actor.js", "rink/server/driver.js", "rink/server/derive.js", "rink/server/models.js", "rink/server/heat.js",
	"rink/server/ssdram.js", "rink/server/query.js", "rink/server/hkbridge.js", "rink/server/sim.js", "rink/server/roster-file.js", "rink/server/roster-plan.js",
	"rink/server/importer.js", "rink/server/service.js", "rink/server/inproc.js",
	"rink/hk001/gomath.js", "rink/hk001/engine.js", "rink/hk001/adapter.js", "rink/hk001/inputs.js", "rink/hk001/catalog.js", "rink/hk001/lab.js",
	"rink/term/render.js", "src/main/spiral/registry.js", "src/main/spiral/commands/rink.js",
}
var bundleJSONs = []string{"rink/corpus/corpus.json", "rink/hk001/html5-entities.json", "rink/hk001/go-tables.json"}

func readRel(root string, parts ...string) (string, error) {
	b, err := os.ReadFile(filepath.Join(append([]string{root}, parts...)...))
	return string(b), err
}

// engineJS is the module loader holding the engine's modules and data tables: what the page runs, without the page.
func engineJS(root string) (string, error) {
	var mods strings.Builder
	for _, m := range bundleModules {
		src, err := readRel(root, append([]string{"engine"}, strings.Split(m, "/")...)...)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&mods, "D[%s]=function(module,exports,require,__dirname,__filename){\n%s\n};\n", pyString(m, true), src)
	}
	for _, m := range bundleJSONs {
		src, err := readRel(root, append([]string{"engine"}, strings.Split(m, "/")...)...)
		if err != nil {
			return "", err
		}
		v, err := parseJSON(src)
		if err != nil {
			return "", fmt.Errorf("engine/%s: %v", m, err)
		}
		fmt.Fprintf(&mods, "J[%s]=%s;\n", pyString(m, true), pyDumps(v, false, false))
	}
	loader, err := readRel(root, "ui", "loader.js")
	if err != nil {
		return "", err
	}
	if strings.Count(loader, "/*MODULES*/") != 1 {
		return "", fmt.Errorf("ui/loader.js: the /*MODULES*/ mark is missing")
	}
	return strings.Replace(loader, "/*MODULES*/", mods.String(), 1), nil
}

func buildBundle(root string) (js, html string, err error) {
	eng, err := engineJS(root)
	if err != nil {
		return "", "", err
	}
	rinkJS, err := readRel(root, "engine", "rink", "web", "rink.js")
	if err != nil {
		return "", "", err
	}
	app, err := readRel(root, "ui", "app.js")
	if err != nil {
		return "", "", err
	}
	js = "/* RINK-VT " + VERSION + " · LK/Vexa edition · the renderer bundle, built by rinkvt-photon bundle from engine/ and ui/.\n" +
		" * Copyright (C) 2026 RUSSELL PHILIP SMITHSON · SPDX-License-Identifier: GPL-3.0-only · no warranty: see LICENSE.\n" +
		" * The engine's Go-derived parts keep their notices in engine/rink/hk001/NOTICE.md. */\n" + eng + "\n" + rinkJS + "\n" + app
	tpl, err := readRel(root, "ui", "workbench.template.html")
	if err != nil {
		return "", "", err
	}
	return js, strings.ReplaceAll(tpl, "@VERSION@", VERSION), nil
}

// bundleStale names the built files that are not what the sources give.
func bundleStale(root string) ([]string, error) {
	js, html, err := buildBundle(root)
	if err != nil {
		return nil, err
	}
	var stale []string
	for _, f := range [][2]string{{"workbench.js", js}, {"workbench.html", html}} {
		if have, err := readRel(root, "ui", f[0]); err != nil || have != f[1] {
			stale = append(stale, f[0])
		}
	}
	return stale, nil
}

func cmdBundle(args []string) int {
	root := releaseRoot()
	if len(args) > 0 && args[0] == "--check" {
		stale, err := bundleStale(root)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return exitFail
		}
		if len(stale) > 0 {
			fmt.Printf("stale: %s (run rinkvt-photon bundle)\n", strings.Join(stale, ", "))
			return exitFail
		}
		fmt.Println("the renderer bundle matches its sources")
		return exitOK
	}
	js, html, err := buildBundle(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitFail
	}
	for _, f := range [][2]string{{"workbench.js", js}, {"workbench.html", html}} {
		if err := os.WriteFile(filepath.Join(root, "ui", f[0]), []byte(f[1]), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return exitFail
		}
	}
	fmt.Printf("ui/workbench.js %d KiB (%d modules + %d JSON) · ui/workbench.html\n", len(js)/1024, len(bundleModules), len(bundleJSONs))
	return exitOK
}

// cmdLeases: this laptop's identity and address, enrolment in a fleet register, a lease table and its lookups.
// Only --enroll writes (one lease line in the register, and the pin in this laptop's device file). Leases are made
// by a host or an enrolment and never change or expire.
func cmdLeases(args []string) int {
	root := releaseRoot()
	fs := flag.NewFlagSet("leases", flag.ContinueOnError)
	data := fs.String("data", filepath.Join(root, "runtime"), "the data folder whose lease table to list")
	file := fs.String("file", "", "a lease table to list (a league's, or a fleet register)")
	poolSpec := fs.String("pool", defaultPool, "the loopback pool")
	devFile := fs.String("device-file", "", "this laptop's device file")
	this := fs.Bool("this-laptop", false, "this laptop's device key, its pinned 127 address and the fleet register it belongs to")
	enroll := fs.String("enroll", "", "enrol this laptop in a fleet register (FLEET_FILE)")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if *this {
		dev, err := loadDevice(*devFile, machineIdentifier, false)
		if err != nil || dev == nil {
			fmt.Println("this laptop has no device file yet: the first start of the host, or --enroll, makes it")
			return exitOK
		}
		src := "random identity"
		if dev.source() == "machine" {
			src = "machine identifier"
		}
		pinned := dev.address()
		if pinned == "" {
			pinned = "none yet"
		}
		if dev.pool() != "" {
			pinned += " in " + dev.pool()
		}
		fleet := dev.fleet()
		if fleet == "" {
			fleet = "none"
		}
		fmt.Printf("%s  (%s, from the %s)\n  pinned address  %s\n  fleet register  %s\n  device file     %s\n", dev.label(), dev.key(), src, pinned, fleet, dev.path)
		for _, n := range dev.notes {
			fmt.Println("  note: " + n)
		}
		return exitOK
	}
	if *enroll != "" {
		path, _ := filepath.Abs(*enroll)
		dev, err := loadDevice(*devFile, machineIdentifier, true)
		var pool *Pool
		if err == nil {
			pool, err = newPool(*poolSpec)
		}
		var addr string
		var fresh, moved bool
		pin := ""
		if err == nil {
			if dev.pool() == pool.text {
				pin = dev.address()
			}
			most := pool.capacity
			if most > 65536 {
				most = 65536
			}
			var t *LeaseTable
			if t, err = newLeaseTable(path, *poolSpec, 128, most, false); err == nil {
				if addr, _, fresh, moved, err = t.lease(dev.key(), pin); err == nil {
					_, err = dev.pin(addr, pool.text, path)
				}
			}
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "REFUSED: %v\n", err)
			return exitFail
		}
		state := "already enrolled"
		if fresh {
			state = "enrolled now"
		}
		fmt.Printf("%s: %s in the fleet register %s (%s)\n", dev.label(), addr, path, state)
		if moved {
			fmt.Printf("  another laptop of the register holds %s; this laptop's address is now %s everywhere\n", pin, addr)
		}
		return exitOK
	}
	path := *file
	if path == "" {
		path = filepath.Join(*data, "loopback", "leases")
	}
	var rows [][]string
	poolText, v6, format := *poolSpec, 128, "—"
	if raw, err := os.ReadFile(path); err == nil {
		lines := strings.Split(string(raw), "\n")
		h := leaseHeaderRE.FindStringSubmatch(lines[0])
		if h == nil {
			fmt.Fprintf(os.Stderr, "%s: not a lease table\n", path)
			return exitFail
		}
		format, poolText = h[1], h[2]
		fmt.Sscan(h[3], &v6)
		for _, ln := range lines[1:] {
			if strings.TrimSpace(ln) != "" {
				rows = append(rows, strings.Split(ln, " "))
			}
		}
	}
	pool, err := newPool(poolText)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitFail
	}
	byKey := map[string][]string{}
	devices := 0
	for _, r := range rows {
		if len(r) == 4 {
			byKey[r[1]] = r
			if strings.HasPrefix(r[1], "device:") {
				devices++
			}
		}
	}
	if fs.NArg() > 0 {
		for _, a := range fs.Args() {
			key, ok := clientKey(a, v6)
			switch {
			case !ok:
				fmt.Printf("%s: neither a device key nor an IP address\n", a)
			case byKey[key] != nil:
				fmt.Printf("%s: %s (leased %s)\n", a, byKey[key][0], byKey[key][2])
			default:
				fmt.Printf("%s: no lease yet; it would be offered %s first\n", a, pool.addressAt(slotOf(key, pool.capacity)))
			}
		}
		return exitOK
	}
	plural := func(n int, w string) string {
		if n == 1 {
			return fmt.Sprintf("%d %s", n, w)
		}
		return fmt.Sprintf("%d %ss", n, w)
	}
	fmt.Printf("%s\nformat %s · pool %s · capacity %d · IPv6 keys /%d · %s (%s)\n", path, format, pool.text, pool.capacity, v6, plural(len(rows), "lease"), plural(devices, "laptop"))
	for _, r := range rows {
		if len(r) != 4 {
			fmt.Println("  (damaged line)")
			continue
		}
		who := r[1]
		if strings.HasPrefix(who, "device:") {
			who = "device " + who[7:15]
		}
		fmt.Printf("  %-16s %-40s %s\n", r[0], who, r[2])
	}
	return exitOK
}
