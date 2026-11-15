// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// The edition's component contracts, in the LK/Vexa languages: the table they are written from.
//
//	contracts/mssl/*.mssl   MSSL 0.3 records (the observed module/learn subset of the MSSL Writers Corpus 1.0.0):
//	                        the suite's identity, one record per component, and the qualification of this release
//	contracts/ja/*.ja       JA21 JA Core 0.3 contract sources (the suite's provisional grammar)
//
// A change to a contract is a change to this table; rinkvt-photon contracts write writes the records from it.

const qualificationFile = "90_qualification.mssl"

var jaFiles = []string{"rinkvt_frame.ja", "rinkvt_overtime.ja", "rinkvt_loopback.ja", "rinkvt_store.ja", "rinkvt_host.ja"}

var components = []any{"rinkvt.lkvexa.photon_host", "rinkvt.lkvexa.league_store", "rinkvt.lkvexa.loopback_leases",
	"rinkvt.lkvexa.release_integrity", "rinkvt.lkvexa.renderer", "rinkvt.lkvexa.engine"}

type contractRecord struct {
	file, module string
	facts        Obj
}

func jaContractList() []any {
	out := []any{}
	for _, f := range jaFiles {
		out = append(out, "contracts/ja/"+f)
	}
	return out
}

func contractTable() []contractRecord {
	return []contractRecord{
		{"00_suite_identity.mssl", "rinkvt.lkvexa.suite", Obj{
			{"suite_id", "RINKVT-LKVEXA"},
			{"suite_name", "RINK-VT Workbench, LK/Vexa edition"},
			{"version", VERSION},
			{"engine_version", ENGINE},
			{"role", "hockey statistics workbench: a scorer's command language, 64-byte frames, an event-sourced game actor, statistical models and the HK001 laboratory"},
			{"runtime", "Photon host: one native executable per platform (Windows x64 and ARM64, macOS Apple silicon and Intel, Linux x64 and ARM64), started by START_RINKVT, with a Chromium-family renderer window on an isolated profile; nothing is installed to run it"},
			{"node_runtime", false},
			{"python_runtime", false},
			{"laptop_addresses", "every laptop keeps its own static 127 address, leased to a device key derived from its machine identifier; unique in every lease table, and everywhere among the laptops of one fleet register"},
			{"components", components},
			{"ja_contracts", jaContractList()},
			{"authoritative_source", "bundled: photon/ (the host's Go source and its executables), ui/ and engine/, sealed by RELEASE_MANIFEST.json"},
			{"license", "GPL-3.0-only"},
			{"copyright", "Copyright (C) 2026 RUSSELL PHILIP SMITHSON"},
			{"maturity", "OPERATIONAL"},
			{"evidence", []any{"contracts/mssl/" + qualificationFile}},
			{"scope_limit", "as qualified by the qualification record, on the platform it names; other platforms are not qualified by it"},
		}},
		{"10_photon_host.mssl", "rinkvt.lkvexa.photon_host", Obj{
			{"component", "photon/host.go, photon/server.go; photon/bin/rinkvt-photon-<system>-<machine>"},
			{"contract", "serves the workbench and a JSON API on this computer's static loopback address only; a request whose Host header does not name that address and port is refused (421); every /api route except /api/health needs the per-launch X-VEC1-Token (403); a change is accepted only as application/json from the same origin (415, 403); a body is at most 32 MiB and never chunked (413, 411)"},
			{"interfaces", []any{"GET /", "GET /workbench.js", "GET /workbench.css", "GET /api/health", "GET /api/edition", "GET /api/league", "GET /api/ledgers?sha=", "GET /api/verify", "POST /api/commit", "POST /api/shutdown"}},
			{"invariants", []any{"one host per data folder, held by an exclusive lock file", "the code of the release matches RELEASE_MANIFEST.json before anything else is opened; otherwise the start is refused with exit code 4", "requests are not logged; the host's event ledger records starts, commits and stops", "the laptop is identified by its device key, derived from the machine identifier, which is never stored or shown", "every response carries a Content-Security-Policy of default-src 'self' with no inline script or style"}},
			{"state_model", []any{"checking the release", "taking the data folder", "opening the league", "identifying this laptop", "leasing its loopback address", "listening", "stopped"}},
			{"exit_codes", Obj{{"0", "stopped"}, {"1", "verification failed"}, {"2", "usage"}, {"4", "release integrity"}, {"5", "data folder in use"}, {"6", "the league cannot be opened"}, {"7", "device file, loopback lease or listener"}}},
			{"ja_contract", "contracts/ja/rinkvt_host.ja"},
			{"maturity", "OPERATIONAL"},
			{"evidence", []any{"photon/server_test.go", "photon/browser_test.go"}},
		}},
		{"20_league_store.mssl", "rinkvt.lkvexa.league_store", Obj{
			{"component", "photon/store.go"},
			{"contract", "a commit carries the registry text (optional), the registry seal the window last saw, and the new ledger entry pairs of each game; it is refused unless that seal is current (409), every stored game is kept with its uuid, each batch starts where its ledger ends, and every pair passes the engine's own seals; the answer is sent only after the registry and the ledger lines are synced to disk"},
			{"files", []any{"league/registry/registry.json", "league/registry/registry.sha256", "league/ledger/<key>-<uuid8>.jsonl", "events.jsonl"}},
			{"seals", Obj{{"registry", "SHA-256 of registry.json, kept in registry.sha256 and replaced through registry.sha256.new and two renames"}, {"ledger", "line n carries prev, the hash of line n-1, and hash = SHA-256(prev LF frame-hex meta-hex LF n); the first prev is SHA-256('RINK-VT ledger 1' NUL key NUL uuid)"}, {"frame", "CRC-32C of bytes 0-59, big-endian at bytes 60-63; bytes 32-35 are the first four bytes of the game's uuid"}, {"meta", "magic CMT1 (0x31544D43, little-endian) at bytes 0-3; CRC-32C of bytes 0-59, little-endian at bytes 60-63"}}},
			{"recovery", "a last line without its newline was never acknowledged: opening the league drops it; a verification reports it and repairs nothing"},
			{"limits", Obj{{"registry_bytes", 16777216}, {"pairs_per_game", 40000}}},
			{"ja_contract", "contracts/ja/rinkvt_store.ja"},
			{"maturity", "OPERATIONAL"},
			{"evidence", []any{"photon/store_test.go", "photon/server_test.go", "photon/browser_test.go"}},
		}},
		{"30_loopback_leases.mssl", "rinkvt.lkvexa.loopback_leases", Obj{
			{"component", "photon/device.go, photon/loopback.go, photon/host.go (leaseThisLaptop), rinkvt-photon leases"},
			{"contract", "every laptop keeps one 127.x.y.z address for good: the address is leased to the laptop's device key, pinned in its device file, and asked for in every lease table the laptop meets; a table grants it unless another laptop holds it there, so no table ever gives one address to two laptops; a fleet register that every laptop shares makes the addresses unique everywhere; a lease is written, synced and sealed before the address is used"},
			{"device_key", "device: followed by the first 32 hex digits of HMAC-SHA-256 with the key 'RINK-VT device 1' over the trimmed, lower-cased machine identifier; the identifier itself is never stored; a computer without one gets a random 128-bit key"},
			{"machine_identifier", Obj{{"windows", "HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid"}, {"macos", "IOPlatformUUID"}, {"linux", "/etc/machine-id or /var/lib/dbus/machine-id"}}},
			{"device_file", Obj{{"windows", "%LOCALAPPDATA%\\RINK-VT\\device.json"}, {"macos", "~/Library/Application Support/RINK-VT/device.json"}, {"linux", "$XDG_DATA_HOME/rink-vt/device.json"}, {"override", "RINKVT_DEVICE_FILE or --device-file"}}},
			{"pool", "127.16.0.0/12"},
			{"capacity", 1040384},
			{"slot", "the first 16 hex digits of SHA-256('RINK-VT loopback 1' NUL key), modulo the capacity; then linear probing over host addresses .1 to .254"},
			{"keys", "a device key; or, as the reference edition keys its clients, the canonical text of an IP address (RFC 5952; an IPv4-mapped IPv6 address is its IPv4 address)"},
			{"file_format", "a header line '# RINK-VT loopback leases · format 2 · pool P · ipv6 /N', then one line per lease: address, key, time and a 16-digit seal; a format 1 table (IP keys only) is read, and upgraded once, every line kept, when it receives a device key"},
			{"fleet_register", "a lease table on a share or a removable disk that every laptop of a club or league uses (--fleet, remembered once given); never created where its folder is missing; when it cannot be reached, the pinned address is used"},
			{"refusals", []any{"an edited or damaged line", "a second lease for one key or one address", "a pool or IPv6 prefix other than the file's", "a device key in a format 1 table", "a full pool"}},
			{"ja_contract", "contracts/ja/rinkvt_loopback.ja"},
			{"maturity", "OPERATIONAL"},
			{"evidence", []any{"photon/loopback_test.go", "photon/device_test.go", "photon/browser_test.go"}},
		}},
		{"40_release_integrity.mssl", "rinkvt.lkvexa.release_integrity", Obj{
			{"component", "photon/integrity.go, photon/tools.go (rinkvt-photon seal, rinkvt-photon bundle)"},
			{"contract", "RELEASE_MANIFEST.json lists every file of the release with its SHA-256; a start is refused when a file under photon/, ui/ or engine/ is changed, missing or unlisted; a verification checks every file; the host's own executables are sealed with the code they were built from; the renderer bundle is built from engine/ and ui/ by the host itself, without Node.js, and checked to be current"},
			{"scopes", Obj{{"code", "photon/, ui/ and engine/, at every start"}, {"all", "every file, at verification"}}},
			{"maturity", "OPERATIONAL"},
			{"evidence", []any{"photon/release_test.go"}},
		}},
		{"50_renderer.mssl", "rinkvt.lkvexa.renderer", Obj{
			{"component", "photon/renderer.go, ui/"},
			{"contract", "opens the workbench in an installed Edge, Chrome or Chromium in app mode on a profile of its own under the data folder; the page loads only from the host; without such a browser the host says so, and uses the ordinary browser only with --allow-default-browser-fallback"},
			{"page_policy", "default-src 'self'; script-src 'self'; style-src 'self'; no inline script, style or event handler; no external fonts or scripts"},
			{"maturity", "OPERATIONAL"},
			{"evidence", []any{"photon/browser_test.go", "photon/release_test.go"}},
		}},
		{"60_engine.mssl", "rinkvt.lkvexa.engine", Obj{
			{"component", "engine/ (33 modules and 3 data tables: the reference edition's engine 2.5.0-rinkvt.1 with the start frame, the whistle and the league overtime rules of this release), ui/loader.js, ui/app.js"},
			{"contract", "the command language, frames, game actor, models, roster importer and HK001 run in the renderer as the reference edition runs them; the window sends the host every change a command made and shows the command's result only after the host has it on disk; when the host refuses, the window loads the league again"},
			{"engine_version", ENGINE},
			{"start_frame", "START is the game's start frame, a !CLK frame with the action byte 66 (B): the opening faceoff. In a game created under the start-frame rule, as every game created in this edition is, the clock runs only after it and GO is refused until then; a game created by an earlier build starts with its first GO, so its ledger replays unchanged"},
			{"whistle", "WHISTLE is the whistle, a !CLK frame with the action byte 87 (W): it stops the running clock and play is dead until the faceoff. WHISTLE mm:ss also sets the clock to the time on the official clock when the whistle went; on a clock a whistle already stopped it sets that whistle's time, on a clock STOP stopped it makes the stoppage a whistle. It is refused before the clock has run in the period, in the shootout, and (without a time) on a stopped clock. Esc in the workbench is the whistle while the clock runs; every whistle is counted on the scoreboard"},
			{"overtime_rules", "a league's overtime rules (rink overtime LEAGUE preset | ot= skaters= shootout= playoff-ot= playoff-skaters= playoff-shootout= | clear) decide a game that is level after regulation: the overtime's length (none, or 1:00 to 20:00), skaters a side (3, 4 or 5), shootout rounds (none, or 1 to 10, then sudden death); a regular block for regular-season and preseason games, a playoff block for playoff and championship games, where no shootout means sudden-death periods up to OT9. Presets: standard, four-on-four, international, overtime-then-tie, shootout-only, ties. Each game keeps a copy of its league's rules from its creation (the home team's league, else the away team's); a game without one keeps the built-in rules, exactly as earlier builds played it. A tie that stands earns a point each"},
			{"ja_contract", []any{"contracts/ja/rinkvt_frame.ja", "contracts/ja/rinkvt_overtime.ja"}},
			{"maturity", "OPERATIONAL"},
			{"evidence", []any{"photon/browser_test.go", "photon/store_test.go"}},
			{"scope_limit", "the engine's own test suite belongs to the reference edition (Node.js), whose 78 engine tests pass on this engine, and whose 128 other tests pass with it; this edition exercises the engine through its browser tests"},
		}},
	}
}
