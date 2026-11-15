// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// The league store: commits, their refusals, and damage found on opening or verification.

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func storeWithGame(t *testing.T) (*LeagueStore, string, string) {
	dir := t.TempDir()
	s, err := openLeagueStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	u := newUUID()
	mustCommit(t, s, str(testRegistry([][2]string{{"G1", u}})))
	return s, dir, u
}

func TestStoreRoundTripAcrossReopen(t *testing.T) {
	s, dir, u := storeWithGame(t)
	mustCommit(t, s, nil, batch("G1", u, 0, testPairs(u, 0, 3)))
	mustCommit(t, s, nil, batch("G1", u, 3, testPairs(u, 3, 2)))
	again, err := openLeagueStore(dir)
	fatalIf(t, err != nil, "reopen: %v", err)
	fatalIf(t, len(again.ledgers["G1"].pairs) != 5 || again.ledgers["G1"].tip != s.ledgers["G1"].tip, "the ledger did not come back as written")
	_, blob, _ := again.snapshot()
	fatalIf(t, !bytes.Equal(blob, testPairs(u, 0, 5)), "the snapshot is not the pairs committed")
	ok, _ := verifyFolder(dir).Get("ok")
	fatalIf(t, ok != true, "a sound league did not verify")
}

func TestStoreEngineEntriesAccepted(t *testing.T) {
	key, u, pairs := engineFixture(t)
	s, err := openLeagueStore(t.TempDir())
	fatalIf(t, err != nil, "%v", err)
	mustCommit(t, s, str(testRegistry([][2]string{{key, u}})), batch(key, u, 0, pairs))
	fatalIf(t, len(s.ledgers[key].pairs) != len(pairs)/pairLen, "the engine's own pairs were not all kept")
}

func TestStoreStaleBaseRefused(t *testing.T) {
	s, _, u := storeWithGame(t)
	old := s.registrySha
	mustCommit(t, s, str(testRegistry([][2]string{{"G1", u}, {"G2", newUUID()}})))
	_, err := s.commit(nil, old, []Obj{batch("G1", u, 0, testPairs(u, 0, 1))})
	fatalIf(t, storeCode(err) != "CONFLICT", "a commit from an old view: %v", err)
	_, err = s.commit(nil, nil, nil)
	fatalIf(t, storeCode(err) != "CONFLICT", "a commit without a base: %v", err)
}

func TestStoreStartMustBeTheEnd(t *testing.T) {
	s, _, u := storeWithGame(t)
	mustCommit(t, s, nil, batch("G1", u, 0, testPairs(u, 0, 3)))
	for _, start := range []int{0, 2, 5} {
		_, err := s.commit(nil, s.registrySha, []Obj{batch("G1", u, start, testPairs(u, start, 1))})
		fatalIf(t, storeCode(err) != "CONFLICT", "a batch starting at %d: %v", start, err)
	}
}

func TestStoreGamesAreNeverRemoved(t *testing.T) {
	s, _, u := storeWithGame(t)
	_, err := s.commit(str(testRegistry(nil)), s.registrySha, nil)
	fatalIf(t, storeCode(err) != "CONFLICT", "dropping a game: %v", err)
	_, err = s.commit(str(testRegistry([][2]string{{"G1", newUUID()}})), s.registrySha, nil)
	fatalIf(t, storeCode(err) != "CONFLICT", "changing a game's uuid: %v", err)
	_ = u
}

func TestStoreBadEntriesRefusedAndNothingWritten(t *testing.T) {
	s, dir, u := storeWithGame(t)
	good := testPairs(u, 0, 2)
	badCRC := append([]byte(nil), good...)
	badCRC[5] ^= 1
	badMeta := append([]byte(nil), good...)
	badMeta[64+20] ^= 1
	other := testPairs(newUUID(), 0, 1)
	cases := map[string]Obj{
		"frame CRC":   batch("G1", u, 0, badCRC),
		"meta CRC":    batch("G1", u, 0, badMeta),
		"other game":  batch("G1", u, 0, other),
		"half a pair": batch("G1", u, 0, good[:100]),
		"not base64":  {{"game", "G1"}, {"uuid", u}, {"start", 0}, {"data", "%%%"}},
	}
	for name, b := range cases {
		_, err := s.commit(nil, s.registrySha, []Obj{b})
		code := storeCode(err)
		fatalIf(t, code != "BAD_PAIR" && code != "BAD_REQUEST", "%s: %v", name, err)
	}
	fatalIf(t, exists(filepath.Join(dir, "league", "ledger", "G1-"+u[:8]+".jsonl")), "a refused commit wrote a ledger")
	mustCommit(t, s, nil, batch("G1", u, 0, good))
}

func TestStoreUnknownGameRefused(t *testing.T) {
	s, _, u := storeWithGame(t)
	for _, b := range []Obj{batch("G9", u, 0, testPairs(u, 0, 1)), batch("G1", newUUID(), 0, testPairs(u, 0, 1)), {{"uuid", u}, {"start", 0}, {"data", ""}}} {
		_, err := s.commit(nil, s.registrySha, []Obj{b})
		fatalIf(t, storeCode(err) != "BAD_REQUEST", "%v", err)
	}
}

func TestStoreRegistryChecks(t *testing.T) {
	s, _, u := storeWithGame(t)
	bad := []string{
		"not json",
		`{"schema":"chlvt.registry.v1","teams":[],"players":[],"games":[],"notes":[]}`,
		`{"schema":"rinkvt.registry.v1","teams":{},"players":[],"games":[],"notes":[]}`,
		`{"schema":"rinkvt.registry.v1","teams":[],"players":[],"games":[{"key":"G 1","uuid":"` + u + `"}],"notes":[]}`,
		`{"schema":"rinkvt.registry.v1","teams":[],"players":[],"games":[{"key":"G1","uuid":"` + u + `"},{"key":"G1","uuid":"` + u + `"}],"notes":[]}`,
		`{"schema":"rinkvt.registry.v1","schema":"x","teams":[],"players":[],"games":[],"notes":[]}`,
		`{"schema":"rinkvt.registry.v1","teams":[],"players":[],"games":[],"notes":[],"n":NaN}`,
		strings.Repeat(" ", maxRegistry+1),
	}
	for _, text := range bad {
		_, err := s.commit(&text, s.registrySha, nil)
		code := storeCode(err)
		fatalIf(t, code != "BAD_REGISTRY" && code != "TOO_LARGE", "%.60q: %v", text, err)
	}
}

func TestStoreEventLedgerRecordsCommits(t *testing.T) {
	s, dir, u := storeWithGame(t)
	mustCommit(t, s, nil, batch("G1", u, 0, testPairs(u, 0, 2)))
	ev, err := openEventLedger(filepath.Join(dir, "events.jsonl"), true)
	fatalIf(t, err != nil || ev.seq != 2, "the event ledger: %v (%d events)", err, ev.seq)
	raw, _ := os.ReadFile(filepath.Join(dir, "events.jsonl"))
	fatalIf(t, !strings.Contains(string(raw), `"pairs":2,"games":["G1"]`), "the commit event does not say what it recorded")
}

// ---- damage --------------------------------------------------------------------------------------------------

func damagedStore(t *testing.T) (string, string, string) {
	s, dir, u := storeWithGame(t)
	mustCommit(t, s, nil, batch("G1", u, 0, testPairs(u, 0, 3)))
	return dir, u, filepath.Join(dir, "league", "ledger", "G1-"+u[:8]+".jsonl")
}

func TestStoreTornLastLineDroppedOnOpen(t *testing.T) {
	dir, u, path := damagedStore(t)
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"n":3,"frame":"00`)
	f.Close()
	s, err := openLeagueStore(dir)
	fatalIf(t, err != nil, "%v", err)
	fatalIf(t, len(s.ledgers["G1"].pairs) != 3 || len(s.recovered) != 1, "the cut-off line was not dropped and reported")
	mustCommit(t, s, nil, batch("G1", u, 3, testPairs(u, 3, 1)))
}

func TestStoreVerifyDoesNotRepair(t *testing.T) {
	dir, _, path := damagedStore(t)
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"n":3,"fr`)
	f.Close()
	before, _ := os.ReadFile(path)
	rep := verifyFolder(dir)
	after, _ := os.ReadFile(path)
	ok, _ := rep.Get("ok")
	fatalIf(t, ok != false || !bytes.Equal(before, after), "verification repaired or passed a cut-off line")
}

func TestStoreEditedEntryRefused(t *testing.T) {
	dir, _, path := damagedStore(t)
	raw, _ := os.ReadFile(path)
	lines := strings.Split(string(raw), "\n")
	at := strings.Index(lines[2], `"frame":"`) + len(`"frame":"`)
	b := []byte(lines[2])
	if b[at] == 'a' {
		b[at] = 'b'
	} else {
		b[at] = 'a'
	}
	lines[2] = string(b)
	os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600)
	_, err := openLeagueStore(dir)
	fatalIf(t, storeCode(err) != "DAMAGED", "an edited entry opened: %v", err)
	ok, _ := verifyFolder(dir).Get("ok")
	fatalIf(t, ok != false, "an edited entry verified")
}

func TestStoreRemovedLineRefused(t *testing.T) {
	dir, _, path := damagedStore(t)
	raw, _ := os.ReadFile(path)
	lines := strings.Split(string(raw), "\n")
	os.WriteFile(path, []byte(strings.Join(append(lines[:2], lines[3:]...), "\n")), 0o600)
	_, err := openLeagueStore(dir)
	fatalIf(t, storeCode(err) != "DAMAGED", "a removed line opened: %v", err)
}

func TestStoreEditedRegistryRefused(t *testing.T) {
	dir, _, _ := damagedStore(t)
	p := filepath.Join(dir, "league", "registry", "registry.json")
	raw, _ := os.ReadFile(p)
	os.WriteFile(p, bytes.Replace(raw, []byte(`"seq": 1`), []byte(`"seq": 2`), 1), 0o600)
	_, err := openLeagueStore(dir)
	fatalIf(t, storeCode(err) != "DAMAGED", "an edited registry opened: %v", err)
}

func TestStoreCommitCutOffBeforeItsRename(t *testing.T) {
	dir, u, _ := damagedStore(t)
	reg := filepath.Join(dir, "league", "registry")
	next := testRegistry([][2]string{{"G1", u}, {"G2", newUUID()}})
	os.WriteFile(filepath.Join(reg, "registry.sha256.new"), []byte(sha256Hex([]byte(next))+"  registry.json\n"), 0o600)
	os.WriteFile(filepath.Join(reg, "registry.json.4242.tmp"), []byte(next), 0o600)
	s, err := openLeagueStore(dir)
	fatalIf(t, err != nil, "%v", err)
	fatalIf(t, strings.Contains(s.registryText, "G2") || exists(filepath.Join(reg, "registry.sha256.new")) || exists(filepath.Join(reg, "registry.json.4242.tmp")),
		"a commit that never reached its rename was not discarded")
}

func TestStoreInterruptedSealCompletedOnOpen(t *testing.T) {
	dir, u, _ := damagedStore(t)
	reg := filepath.Join(dir, "league", "registry")
	next := testRegistry([][2]string{{"G1", u}, {"G2", newUUID()}})
	os.WriteFile(filepath.Join(reg, "registry.sha256.new"), []byte(sha256Hex([]byte(next))+"  registry.json\n"), 0o600)
	os.WriteFile(filepath.Join(reg, "registry.json"), []byte(next), 0o600)
	ok, _ := verifyFolder(dir).Get("ok")
	fatalIf(t, ok != false, "verification passed a seal one rename behind")
	s, err := openLeagueStore(dir)
	fatalIf(t, err != nil || !strings.Contains(s.registryText, "G2"), "the interrupted commit was not completed: %v", err)
	fatalIf(t, readSeal(filepath.Join(reg, "registry.sha256")) != sha256Hex([]byte(next)), "the seal was not completed")
}
