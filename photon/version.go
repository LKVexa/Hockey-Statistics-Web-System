// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

// RINK-VT, LK/Vexa edition: the Photon host.
//
// The control plane that takes Node's place, as one native program per platform: nothing is installed to run it —
// no Python, no Node.js, no runtime of any kind. It follows the VEC1 Design Photon model (a main process, a
// Chromium-family window as the renderer, a loopback JSON API guarded by Host, Origin and a per-launch token, a
// release-integrity gate) and keeps the league: the registry, every game's ledger, and the static loopback lease of
// this laptop. Built from this folder with the Go toolchain's standard library alone (see build.cmd / build.sh).
package main

const (
	VERSION = "2.5.0-lkvexa.4"
	ENGINE  = "2.5.0-rinkvt.1+startframe+whistle+overtime"
	PRODUCT = "RINK-VT"
	EDITION = "LK/Vexa edition (Photon-hosted)"
)
