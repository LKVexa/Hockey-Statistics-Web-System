// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const usageText = `RINK-VT %s · %s — the Photon host (native; no Python, no Node.js)

  rinkvt-photon [--data DIR] [--port N] [--device-file FILE] [--fleet FILE] [--leases FILE]
                [--pool 127.16.0.0/12] [--no-browser] [--allow-default-browser-fallback] [--verify-only]
        start the host and open the workbench (START_RINKVT does this)
  rinkvt-photon verify [--data DIR] [--device-file FILE]
        check the release, the renderer bundle, the MSSL and JA21 contracts, the host itself, and the league
        (VERIFY_RINKVT does this); writes nothing
  rinkvt-photon leases --this-laptop | --enroll FLEET_FILE | [--data DIR | --file FILE] [KEY ...]
        this laptop's identity and address, enrolment in a fleet register, a lease table and its lookups
  rinkvt-photon bundle [--check]          build ui/workbench.js and ui/workbench.html from engine/ and ui/
  rinkvt-photon seal [--check]            write (or check) RELEASE_MANIFEST.json
  rinkvt-photon contracts write | check | qualify
        the MSSL records and JA21 contracts of the edition (qualify runs the test suite: go test)
  rinkvt-photon handguide [--out FILE] [--html FILE]
        print the Technical Handguide (docs/handguide/) with an installed Edge, Chrome or Chromium
  rinkvt-photon --version | help
`

// releaseRoot is the folder of the release: RINKVT_ROOT, else two levels above photon/bin/<executable>, else the
// working folder (or its parent when that is photon/, as go test runs).
func releaseRoot() string {
	if r := os.Getenv("RINKVT_ROOT"); r != "" {
		abs, _ := filepath.Abs(r)
		return abs
	}
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		bin := filepath.Dir(exe)
		if filepath.Base(bin) == "bin" && filepath.Base(filepath.Dir(bin)) == "photon" {
			return filepath.Dir(filepath.Dir(bin))
		}
	}
	wd, _ := os.Getwd()
	if exists(filepath.Join(wd, "photon", "go.mod")) {
		return wd
	}
	if filepath.Base(wd) == "photon" && exists(filepath.Join(wd, "go.mod")) {
		return filepath.Dir(wd)
	}
	return wd
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		rest := args[1:]
		switch args[0] {
		case "verify":
			return cmdVerify(rest)
		case "leases":
			return cmdLeases(rest)
		case "bundle":
			return cmdBundle(rest)
		case "seal":
			return cmdSeal(rest)
		case "contracts":
			return cmdContracts(rest)
		case "handguide":
			return cmdHandguide(rest)
		case "help":
			fmt.Printf(usageText, VERSION, EDITION)
			return exitOK
		}
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", args[0])
		fmt.Fprintf(os.Stderr, usageText, VERSION, EDITION)
		return exitUsage
	}
	return runHost(args)
}

func cmdSeal(args []string) int {
	root := releaseRoot()
	if len(args) > 0 && args[0] == "--check" {
		r := verifyRelease(root, "all")
		printJSON(os.Stdout, r)
		if ok, _ := r.Get("ok"); ok == true {
			return exitOK
		}
		return exitFail
	}
	n, err := writeManifest(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitFail
	}
	fmt.Printf("%s: %d files sealed\n", manifestName, n)
	return exitOK
}
