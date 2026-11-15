// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// The MSSL records and JA21 contracts: valid, current, and saying what the implementation does. And the earlier
// releases' league files: a league written before this release opens, verifies and takes new commits.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestContractsStaticRecordsValidAndCurrent(t *testing.T) {
	root := repoRoot(t)
	for _, r := range contractTable() {
		raw := string(mustRead(t, filepath.Join(root, "contracts", "mssl", r.file)))
		_, err := validateMSSL(raw)
		fatalIf(t, err != nil, "%s: %v", r.file, err)
		fatalIf(t, raw != msslDocument(recordIdentity(r.module), r.module, r.facts), "%s is stale (rinkvt-photon contracts write)", r.file)
	}
}

func TestContractsTheCorpusExamplesAgree(t *testing.T) {
	// a document the corpus validator accepts, and the damage it refuses
	good := msslDocument("mssl:test:x:1", "test.x", Obj{{"a", "b"}, {"n", 3}, {"list", []any{"x"}}, {"map", Obj{{"k", true}}}})
	_, err := validateMSSL(good)
	fatalIf(t, err != nil, "a well-formed record: %v", err)
	for _, d := range [][2]string{{`"n":3`, `"n":4`}, {"δ≡5", "δ≡6"}, {`"0002"`, `"0003"`}, {"}⇒⊤", "}"}, {"MSSL{", "MSL{"}, {`"learn.a":"b"`, `"learn.a":"c"`}} {
		bad := strings.Replace(good, d[0], d[1], 1)
		fatalIf(t, bad == good, "the damage %q did not apply", d[0])
		_, err := validateMSSL(bad)
		fatalIf(t, err == nil, "damage %q was accepted", d[0])
	}
}

func TestContractsJAStructure(t *testing.T) {
	root := repoRoot(t)
	for _, f := range jaFiles {
		p := checkJA(filepath.Join(root, "contracts", "ja", f))
		fatalIf(t, len(p) > 0, "%s: %v", f, p)
	}
}

func TestContractsConstantsMatchTheImplementation(t *testing.T) {
	p := crossChecks(repoRoot(t))
	fatalIf(t, len(p) > 0, "%v", p)
}

func TestContractsCheckerRefusesWhatTheSuiteRefuses(t *testing.T) {
	for why, text := range map[string]string{"no policy": "ja source 0.3\nmodule a.b\nuse Core\n", "braces": "ja source 0.3\nmodule a.b\npolicy no_network\nrecord A { x: Count\n",
		"header": "module a.b\nja source 0.3\npolicy no_network\n", "stray": "ja source 0.3\nmodule a.b\npolicy no_network\nwhatever x\n",
		"tab": "ja source 0.3\nmodule a.b\npolicy no_network\nrecord A {\n\tx: Count\n}\n"} {
		f := filepath.Join(t.TempDir(), "x.ja")
		os.WriteFile(f, []byte(text), 0o644)
		fatalIf(t, len(checkJA(f)) == 0, "%s was accepted", why)
	}
}

// ---- leagues written by earlier releases ----------------------------------------------------------------------

// A league written by the earlier host verifies, opens and takes new commits and events.
func TestCompatEarlierLeagueVerifiesOpensAndTakesCommits(t *testing.T) {
	data := filepath.Join(t.TempDir(), "league")
	copyTree(t, filepath.Join("testdata", "earlier-league"), data, nil)
	rep := verifyFolder(data)
	ok, _ := rep.Get("ok")
	fatalIf(t, ok != true, "the earlier league does not verify: %s", pyDumps(rep, false, false))
	s, err := openLeagueStore(data)
	fatalIf(t, err != nil, "it does not open: %v", err)
	fatalIf(t, len(s.ledgers["G1"].pairs) != 3 || s.events.seq != 3, "it opened with %d pairs and %d events", len(s.ledgers["G1"].pairs), s.events.seq)
	fatalIf(t, !strings.Contains(s.registryText, `Zo\u00eb \u00c5ngstr\u00f6m`), "the registry text did not come back whole")
	u := s.ledgers["G1"].uuid
	mustCommit(t, s, nil, batch("G1", u, 3, testPairs(u, 3, 2)))
	s.events.add("note", Obj{{"text", "Zoë · 🏒"}})
	ok, _ = verifyFolder(data).Get("ok")
	fatalIf(t, ok != true, "it does not verify after this release wrote to it")
}

func TestCompatEarlierDeviceFileAndLeaseTable(t *testing.T) {
	dir := t.TempDir()
	copyTree(t, filepath.Join("testdata", "earlier-league"), dir, nil)
	d, err := loadDevice(filepath.Join(dir, "device.json"), machine(machineA), false)
	fatalIf(t, err != nil || d == nil || len(d.notes) > 0, "the earlier device file: %v", err)
	fatalIf(t, d.address() != "127.26.220.77" || d.fleet() != `C:\Users\Zoë\fleet`, "the earlier device file reads %s %s", d.address(), d.fleet())
	tb, err := newLeaseTable(filepath.Join(dir, "loopback", "leases"), defaultPool, 128, 65536, true)
	fatalIf(t, err != nil || tb.lookup(d.key()) != "127.26.220.77" || tb.lookup("203.0.113.5") != "127.20.66.113", "the earlier lease table: %v", err)
}
