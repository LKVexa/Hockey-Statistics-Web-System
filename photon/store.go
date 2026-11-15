// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// The league, kept by the Photon host.
//
//	league/registry/registry.json + registry.sha256   the registry, as the reference edition writes it, sealed
//	league/ledger/<key>-<uuid8>.jsonl                 one hash-chained ledger per game (VEC1 style)
//	events.jsonl                                      the host's own hash-chained event ledger
//
// A game ledger is a header line and then one line per ledger entry pair: the engine's 64-byte frame and the 64-byte
// meta line that records who typed it, when, and from which loopback address. Every line carries the SHA-256 of the
// line before it, so a ledger is verified from its first line to its last; a line cut off by a crash was never
// acknowledged and is dropped. A commit writes the registry first and the ledger lines after it, each synced to disk
// before the renderer is told the line was recorded. The files are the ones every earlier release wrote, byte for
// byte, so a league moves between releases unchanged.

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	registrySchema  = "rinkvt.registry.v1"
	ledgerFormat    = "rinkvt.vec1-ledger.v1"
	frameLen        = 64
	pairLen         = 128
	metaMagic       = 0x31544D43 // "CMT1", little-endian
	maxRegistry     = 16 * 1024 * 1024
	maxPairsPerGame = 2 * 20000 // the engine accepts at most 20 000 frames per game, each with its meta line
)

type StoreError struct{ Code, Msg string }

func (e *StoreError) Error() string { return e.Msg }

func storeErr(code, f string, a ...any) error { return &StoreError{code, fmt.Sprintf(f, a...)} }

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

// crc32c is CRC-32C (Castagnoli), as the engine seals its 64-byte frames and meta lines.
func crc32c(b []byte) uint32 { return crc32.Checksum(b, castagnoli) }

func nowMicros() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000000Z") }

func shaHex(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func sha256Hex(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// appendDurable appends the bytes whole and syncs them before it returns.
func appendDurable(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func writeDurable(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func fsyncDir(d string) {
	f, err := os.Open(d) // a directory cannot always be synced (Windows); renames are still atomic
	if err != nil {
		return
	}
	_ = f.Sync()
	_ = f.Close()
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// readLines returns the complete lines of an append-only file. A last line without its newline was cut off by a
// crash and never acknowledged: a host opening the file drops it; a verification (readonly) reports it instead.
func readLines(path string, readonly bool, what string) ([]string, bool, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false, err
	}
	cut := bytes.LastIndexByte(raw, '\n') + 1
	torn := cut < len(raw)
	if torn {
		if readonly {
			return nil, true, storeErr("DAMAGED", "%s ends with an unfinished line (a stop during a write); starting the host drops it", what)
		}
		f, err := os.OpenFile(path, os.O_WRONLY, 0)
		if err != nil {
			return nil, true, err
		}
		err = f.Truncate(int64(cut))
		if err == nil {
			err = f.Sync()
		}
		f.Close()
		if err != nil {
			return nil, true, err
		}
		raw = raw[:cut]
	}
	if !utf8.Valid(raw) {
		return nil, torn, storeErr("DAMAGED", "%s is not UTF-8 text", what)
	}
	lines := strings.Split(string(raw), "\n")
	return lines[:len(lines)-1], torn, nil
}

// checkPair applies the engine's own seals: the frame's CRC-32C (big-endian, bytes 60-63) and game hash, the meta
// line's magic and CRC.
func checkPair(frame, meta, gameHash []byte, where string) error {
	if len(frame) != frameLen || len(meta) != frameLen {
		return storeErr("BAD_PAIR", "%s: a ledger entry is 64 bytes", where)
	}
	be := uint32(frame[60])<<24 | uint32(frame[61])<<16 | uint32(frame[62])<<8 | uint32(frame[63])
	if be != crc32c(frame[:60]) {
		return storeErr("BAD_PAIR", "%s: the frame does not match its CRC-32C", where)
	}
	if !bytes.Equal(frame[32:36], gameHash) {
		return storeErr("BAD_PAIR", "%s: the frame belongs to another game", where)
	}
	le := func(b []byte) uint32 { return uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24 }
	if le(meta[0:4]) != metaMagic || le(meta[60:64]) != crc32c(meta[:60]) {
		return storeErr("BAD_PAIR", "%s: the meta line does not match its CRC-32C", where)
	}
	return nil
}

// ---- a game's ledger -----------------------------------------------------------------------------------------

type GameLedger struct {
	path, key, uuid string
	gameHash        []byte
	genesis, tip    string
	pairs           [][]byte
	dropped         bool
}

var hex128RE = regexp.MustCompile(`^[0-9a-f]{128}$`)

func openGameLedger(path, key, uuid string, readonly bool) (*GameLedger, error) {
	raw, err := hex.DecodeString(strings.ReplaceAll(uuid, "-", ""))
	if err != nil || len(raw) < 4 {
		return nil, storeErr("BAD_REGISTRY", "game %s: the uuid is not hexadecimal", key)
	}
	g := &GameLedger{path: path, key: key, uuid: uuid, gameHash: raw[:4], genesis: shaHex("RINK-VT ledger 1\x00", key, "\x00", uuid)}
	g.tip = g.genesis
	if exists(path) {
		if err := g.load(readonly); err != nil {
			return nil, err
		}
	}
	return g, nil
}

func (g *GameLedger) load(readonly bool) error {
	name := filepath.Base(g.path)
	lines, dropped, err := readLines(g.path, readonly, name)
	if err != nil {
		return err
	}
	g.dropped = dropped
	if len(lines) == 0 {
		return nil
	}
	head, err := parseJSON(lines[0])
	ho, ok := head.(Obj)
	if err != nil || !ok || ho.Str("ledger") != ledgerFormat || ho.Str("game") != g.key || ho.Str("uuid") != g.uuid {
		return storeErr("DAMAGED", "%s: the header names another ledger, game or format", name)
	}
	tip := g.genesis
	for n, line := range lines[1:] {
		where := fmt.Sprintf("%s line %d", name, n+2)
		v, err := parseJSON(line)
		if err != nil {
			return storeErr("DAMAGED", "%s is not JSON (%v)", where, err)
		}
		r, ok := v.(Obj)
		if !ok || len(r) != 5 || !r.Has("n") || !r.Has("frame") || !r.Has("meta") || !r.Has("prev") || !r.Has("hash") {
			return storeErr("DAMAGED", "%s breaks the chain (sequence or previous hash)", where)
		}
		num, _ := r.Get("n")
		if i, ok := numberInt(num); !ok || i != int64(n) || r.Str("prev") != tip {
			return storeErr("DAMAGED", "%s breaks the chain (sequence or previous hash)", where)
		}
		fh, mh := r.Str("frame"), r.Str("meta")
		if !hex128RE.MatchString(fh) || !hex128RE.MatchString(mh) {
			return storeErr("DAMAGED", "%s does not hold two 64-byte entries", where)
		}
		h := shaHex(tip, "\n", fh, mh, "\n", strconv.Itoa(n))
		if hv, _ := r.Get("hash"); hv != h {
			return storeErr("DAMAGED", "%s does not match its hash (edited or damaged)", where)
		}
		frame, _ := hex.DecodeString(fh)
		meta, _ := hex.DecodeString(mh)
		if err := checkPair(frame, meta, g.gameHash, where); err != nil {
			return err
		}
		g.pairs = append(g.pairs, append(frame, meta...))
		tip = h
	}
	g.tip = tip
	return nil
}

// appendPairs appends pairs (128 bytes each), synced to disk before it returns.
func (g *GameLedger) appendPairs(blobs [][]byte) error {
	var out strings.Builder
	tip, n0 := g.tip, len(g.pairs)
	if !exists(g.path) {
		out.WriteString(pyDumps(Obj{{"ledger", ledgerFormat}, {"game", g.key}, {"uuid", g.uuid}, {"created", nowMicros()}}, true, false) + "\n")
	}
	for i, b := range blobs {
		fh, mh, n := hex.EncodeToString(b[:frameLen]), hex.EncodeToString(b[frameLen:]), n0+i
		h := shaHex(tip, "\n", fh, mh, "\n", strconv.Itoa(n))
		out.WriteString(pyDumps(Obj{{"n", n}, {"frame", fh}, {"meta", mh}, {"prev", tip}, {"hash", h}}, true, false) + "\n")
		tip = h
	}
	if err := appendDurable(g.path, []byte(out.String())); err != nil {
		return err
	}
	g.pairs = append(g.pairs, blobs...)
	g.tip = tip
	return nil
}

// ---- the host's event ledger ---------------------------------------------------------------------------------

// EventLedger records the host's own events (start, commits, verification, stop), hash-chained like a game ledger.
type EventLedger struct {
	path, tip string
	seq       int
	mu        sync.Mutex
}

func openEventLedger(path string, readonly bool) (*EventLedger, error) {
	ev := &EventLedger{path: path, tip: shaHex("RINK-VT events 1")}
	if !exists(path) {
		return ev, nil
	}
	lines, _, err := readLines(path, readonly, "events.jsonl")
	if err != nil {
		return nil, err
	}
	for i, line := range lines {
		v, err := parseJSON(line)
		if err != nil {
			return nil, storeErr("DAMAGED", "events.jsonl line %d is not JSON (%v)", i+1, err)
		}
		r, ok := v.(Obj)
		if !ok || !r.Has("seq") || !r.Has("at") || !r.Has("event") || !r.Has("detail") {
			return nil, storeErr("DAMAGED", "events.jsonl line %d is not an event", i+1)
		}
		body := Obj{}
		for _, k := range []string{"seq", "at", "event", "detail"} {
			x, _ := r.Get(k)
			body = append(body, KV{k, x})
		}
		seq, isInt := numberInt(func() any { x, _ := r.Get("seq"); return x }())
		prev, _ := r.Get("prev")
		hash, _ := r.Get("hash")
		if prev != ev.tip || !isInt || seq != int64(i) || shaHex(ev.tip, pyDumps(body, true, true)) != hash {
			return nil, storeErr("DAMAGED", "events.jsonl line %d breaks the chain", i+1)
		}
		ev.tip, ev.seq = hash.(string), i+1
	}
	return ev, nil
}

// add appends one event; detail is an Obj of plain values (strings, numbers, booleans, lists, null).
func (ev *EventLedger) add(event string, detail Obj) error {
	ev.mu.Lock()
	defer ev.mu.Unlock()
	if detail == nil {
		detail = Obj{}
	}
	body := Obj{{"seq", ev.seq}, {"at", nowMicros()}, {"event", event}, {"detail", detail}}
	h := shaHex(ev.tip, pyDumps(body, true, true))
	line := pyDumps(append(append(Obj{}, body...), KV{"prev", ev.tip}, KV{"hash", h}), true, false) + "\n"
	if err := appendDurable(ev.path, []byte(line)); err != nil {
		return err
	}
	ev.tip, ev.seq = h, ev.seq+1
	return nil
}

func (ev *EventLedger) count() int { ev.mu.Lock(); defer ev.mu.Unlock(); return ev.seq }

// ---- the league store ----------------------------------------------------------------------------------------

type LeagueStore struct {
	root, regDir, ledDir string
	mu                   sync.Mutex
	events               *EventLedger
	hasRegistry          bool
	registryText         string
	registrySha          string
	ledgers              map[string]*GameLedger
	recovered            []string
}

var (
	gameKeyRE  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,24}$`)
	gameUUIDRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	tmpRegRE   = regexp.MustCompile(`^registry\.json\.\d+\.tmp$`)
)

func openLeagueStore(root string) (*LeagueStore, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	s := &LeagueStore{root: abs, regDir: filepath.Join(abs, "league", "registry"), ledDir: filepath.Join(abs, "league", "ledger"), ledgers: map[string]*GameLedger{}}
	for _, d := range []string{s.regDir, s.ledDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	if s.events, err = openEventLedger(filepath.Join(abs, "events.jsonl"), false); err != nil {
		return nil, err
	}
	has, text, sha, err := loadRegistry(s.regDir, false)
	if err != nil {
		return nil, err
	}
	s.hasRegistry, s.registryText, s.registrySha = has, text, sha
	if has {
		reg, _ := parseJSON(text)
		for _, g := range registryGames(reg) {
			led, err := s.ledger(g.Str("key"), g.Str("uuid"))
			if err != nil {
				return nil, err
			}
			if led.dropped {
				s.recovered = append(s.recovered, led.key)
			}
		}
	}
	return s, nil
}

func readSeal(p string) string {
	b, err := os.ReadFile(p) // read and closed at once: on Windows an open handle blocks the rename
	if err != nil {
		return ""
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return ""
	}
	return f[0]
}

func loadRegistry(regDir string, readonly bool) (bool, string, string, error) {
	f, sealF := filepath.Join(regDir, "registry.json"), filepath.Join(regDir, "registry.sha256")
	if !exists(f) {
		return false, "", "", nil
	}
	raw, err := os.ReadFile(f)
	if err != nil {
		return false, "", "", err
	}
	have := sha256Hex(raw)
	if readSeal(sealF) != have {
		next := readSeal(sealF + ".new")
		switch {
		case next == have && readonly:
			return false, "", "", storeErr("DAMAGED", "registry.sha256 is behind registry.json (a stop between two renames); starting the host completes it")
		case next == have: // the crash fell between the two renames: finish the commit
			if err := os.Rename(sealF+".new", sealF); err != nil {
				return false, "", "", err
			}
			fsyncDir(regDir)
		default:
			return false, "", "", storeErr("DAMAGED", "registry.json does not match registry.sha256 (edited or damaged)")
		}
	} else if exists(sealF+".new") && !readonly {
		os.Remove(sealF + ".new") // the stop fell before the text was renamed: the old seal stands
	}
	if !readonly { // a text written by a commit that never reached its rename
		if entries, err := os.ReadDir(regDir); err == nil {
			for _, e := range entries {
				if tmpRegRE.MatchString(e.Name()) {
					os.Remove(filepath.Join(regDir, e.Name()))
				}
			}
		}
	}
	if !utf8.Valid(raw) {
		return false, "", "", storeErr("BAD_REGISTRY", "the registry is not UTF-8 text")
	}
	text := string(raw)
	if _, err := checkRegistry(text); err != nil {
		return false, "", "", err
	}
	return true, text, have, nil
}

func registryGames(reg any) []Obj {
	o, ok := reg.(Obj)
	if !ok {
		return nil
	}
	list, _ := o.Get("games")
	items, _ := list.([]any)
	var out []Obj
	for _, x := range items {
		if g, ok := x.(Obj); ok {
			out = append(out, g)
		}
	}
	return out
}

func checkRegistry(text string) (Obj, error) {
	if len(text) > maxRegistry {
		return nil, storeErr("TOO_LARGE", "the registry is larger than 16 MiB")
	}
	v, err := parseJSON(text)
	if err != nil {
		return nil, storeErr("BAD_REGISTRY", "the registry is not JSON (%v)", err)
	}
	reg, ok := v.(Obj)
	if !ok || reg.Str("schema") != registrySchema {
		schema := "None"
		if ok {
			if s, isStr := func() (any, bool) { x, has := reg.Get("schema"); return x, has }(); isStr {
				schema = fmt.Sprint(s)
			}
		}
		if len(schema) > 40 {
			schema = schema[:40]
		}
		return nil, storeErr("BAD_REGISTRY", "the registry has schema %s; this host keeps %s", schema, registrySchema)
	}
	for _, k := range []string{"teams", "players", "games", "notes"} {
		if x, _ := reg.Get(k); func() bool { _, isList := x.([]any); return !isList }() {
			return nil, storeErr("BAD_REGISTRY", `registry: "%s" must be a list`, k)
		}
	}
	seen := map[string]bool{}
	list, _ := reg.Get("games")
	for _, x := range list.([]any) {
		g, ok := x.(Obj)
		if !ok || !gameKeyRE.MatchString(g.Str("key")) || !gameUUIDRE.MatchString(g.Str("uuid")) {
			return nil, storeErr("BAD_REGISTRY", "registry: a game without a valid key and uuid")
		}
		if seen[g.Str("key")] {
			return nil, storeErr("BAD_REGISTRY", "registry: game %s twice", g.Str("key"))
		}
		seen[g.Str("key")] = true
	}
	return reg, nil
}

func (s *LeagueStore) saveRegistry(text string) error {
	f, sealF := filepath.Join(s.regDir, "registry.json"), filepath.Join(s.regDir, "registry.sha256")
	have := sha256Hex([]byte(text))
	if err := writeDurable(sealF+".new", []byte(have+"  registry.json\n")); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", f, os.Getpid())
	if err := writeDurable(tmp, []byte(text)); err != nil {
		return err
	}
	if err := os.Rename(tmp, f); err != nil {
		return err
	}
	if err := os.Rename(sealF+".new", sealF); err != nil {
		return err
	}
	fsyncDir(s.regDir)
	s.hasRegistry, s.registryText, s.registrySha = true, text, have
	return nil
}

func (s *LeagueStore) ledger(key, uuid string) (*GameLedger, error) {
	if led, ok := s.ledgers[key]; ok {
		if led.uuid != uuid {
			return nil, storeErr("CONFLICT", "game %s is %s, not %s", key, led.uuid, uuid)
		}
		return led, nil
	}
	short := uuid
	if len(short) > 8 {
		short = short[:8]
	}
	led, err := openGameLedger(filepath.Join(s.ledDir, key+"-"+short+".jsonl"), key, uuid, false)
	if err != nil {
		return nil, err
	}
	s.ledgers[key] = led
	return led, nil
}

func (s *LeagueStore) gameCount() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.ledgers) }

// snapshot is the registry text and each game's pairs, in registry order: (index, blob).
func (s *LeagueStore) snapshot() (Obj, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	games := []any{}
	var blob []byte
	if s.hasRegistry {
		reg, _ := parseJSON(s.registryText)
		for _, g := range registryGames(reg) {
			led, err := s.ledger(g.Str("key"), g.Str("uuid"))
			if err != nil {
				return nil, nil, err
			}
			games = append(games, Obj{{"key", led.key}, {"uuid", led.uuid}, {"pairs", len(led.pairs)}})
			for _, p := range led.pairs {
				blob = append(blob, p...)
			}
		}
	}
	idx := Obj{{"registry", nil}, {"registrySha", nil}, {"games", games}}
	if s.hasRegistry {
		idx = Obj{{"registry", s.registryText}, {"registrySha", s.registrySha}, {"games", games}}
	}
	return idx, blob, nil
}

// commit records what the renderer changed: the new registry text (if any) and new ledger pairs. base is the
// registry seal the renderer last saw; a commit made from an older view is refused (409) and the renderer reloads.
// Each ledger batch must start where its ledger ends.
func (s *LeagueStore) commit(registry *string, base any, batches []Obj) (Obj, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	baseStr, _ := base.(string)
	if (base != nil && !isString(base)) || baseStr != s.registrySha || (baseStr == "" && s.hasRegistry) {
		return nil, storeErr("CONFLICT", "the league changed since this window loaded it (another window?); reload")
	}
	var reg any
	if registry != nil {
		r, err := checkRegistry(*registry)
		if err != nil {
			return nil, err
		}
		reg = r
	} else if s.hasRegistry {
		reg, _ = parseJSON(s.registryText)
	}
	games := map[string]string{}
	for _, g := range registryGames(reg) {
		games[g.Str("key")] = g.Str("uuid")
	}
	if s.hasRegistry {
		old, _ := parseJSON(s.registryText)
		for _, g := range registryGames(old) {
			if u, ok := games[g.Str("key")]; !ok || u != g.Str("uuid") {
				return nil, storeErr("CONFLICT", "the new registry drops or changes game %s; games are never removed", g.Str("key"))
			}
		}
	}
	type step struct {
		led   *GameLedger
		blobs [][]byte
	}
	var plan []step
	for _, b := range batches {
		keyV, _ := b.Get("game")
		key, isStr := keyV.(string)
		uuid := b.Str("uuid")
		if u, ok := games[key]; !isStr || !ok || u != uuid || !isString(func() any { x, _ := b.Get("uuid"); return x }()) {
			k := fmt.Sprint(keyV)
			if keyV == nil {
				k = "None"
			}
			if len(k) > 24 {
				k = k[:24]
			}
			return nil, storeErr("BAD_REQUEST", "ledger batch for unknown game %s", k)
		}
		dataV, has := b.Get("data")
		data := ""
		if has {
			ds, ok := dataV.(string)
			if !ok {
				return nil, storeErr("BAD_REQUEST", "%s: the entries are not base64", key)
			}
			data = ds
		}
		raw, err := base64.StdEncoding.Strict().DecodeString(data)
		if err != nil || strings.ContainsAny(data, "\r\n") {
			return nil, storeErr("BAD_REQUEST", "%s: the entries are not base64", key)
		}
		if len(raw)%pairLen != 0 {
			return nil, storeErr("BAD_REQUEST", "%s: entries come in 128-byte pairs (a frame and its meta line)", key)
		}
		led, err := s.ledger(key, uuid)
		if err != nil {
			return nil, err
		}
		startV, _ := b.Get("start")
		if st, ok := numberInt(startV); !ok || st != int64(len(led.pairs)) {
			return nil, storeErr("CONFLICT", "%s: this batch starts at %s; the ledger holds %d", key, pyRepr(startV), len(led.pairs))
		}
		var blobs [][]byte
		for i := 0; i < len(raw); i += pairLen {
			blobs = append(blobs, raw[i:i+pairLen])
		}
		if len(led.pairs)+len(blobs) > maxPairsPerGame {
			return nil, storeErr("TOO_LARGE", "%s: more entries than a game may hold", key)
		}
		for i, blob := range blobs {
			if err := checkPair(blob[:frameLen], blob[frameLen:], led.gameHash, fmt.Sprintf("%s entry %d", key, len(led.pairs)+i)); err != nil {
				return nil, err
			}
		}
		plan = append(plan, step{led, blobs})
	}
	if registry != nil && (!s.hasRegistry || *registry != s.registryText) {
		if err := s.saveRegistry(*registry); err != nil {
			return nil, err
		}
	}
	added := 0
	touched := []any{}
	for _, st := range plan {
		if len(st.blobs) > 0 {
			if err := st.led.appendPairs(st.blobs); err != nil {
				return nil, err
			}
			added += len(st.blobs)
			touched = append(touched, st.led.key)
		}
	}
	if registry != nil || added > 0 {
		if err := s.events.add("commit", Obj{{"registry", registry != nil}, {"pairs", added}, {"games", touched}}); err != nil {
			return nil, err
		}
	}
	counts := Obj{}
	for _, st := range plan {
		counts = counts.Set(st.led.key, len(st.led.pairs))
	}
	var sha any
	if s.hasRegistry {
		sha = s.registrySha
	}
	return Obj{{"registrySha", sha}, {"counts", counts}}, nil
}

func isString(v any) bool { _, ok := v.(string); return ok }

// pyRepr is how the earlier host named a value in a message (None, numbers, quoted text).
func pyRepr(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case string:
		return x
	case json.Number:
		return numberText(x)
	case bool:
		if x {
			return "True"
		}
		return "False"
	}
	return fmt.Sprint(v)
}

// verify re-reads everything from disk, as a fresh start would, and repairs nothing.
func (s *LeagueStore) verify() Obj {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events.mu.Lock()
	defer s.events.mu.Unlock()
	return verifyFolder(s.root)
}

// verifyFolder checks a data folder without opening it for use: the registry seal, every game's chain and seals,
// and the event ledger. Nothing is written, so it is safe on a copy, a backup, or a folder no host has open.
func verifyFolder(root string) Obj {
	regDir, ledDir := filepath.Join(root, "league", "registry"), filepath.Join(root, "league", "ledger")
	report := Obj{{"ok", true}, {"registry", nil}, {"games", []any{}}, {"events", nil}}
	has, text, sha, err := loadRegistry(regDir, true)
	if err != nil {
		return report.Set("ok", false).Set("registry", Obj{{"ok", false}, {"error", err.Error()}})
	}
	var games []Obj
	if has {
		reg, _ := parseJSON(text)
		games = registryGames(reg)
	}
	var regSha any
	if has {
		regSha = sha
	}
	report = report.Set("registry", Obj{{"ok", true}, {"sha256", regSha}, {"games", len(games)}})
	list := []any{}
	ok := true
	for _, g := range games {
		key, uuid := g.Str("key"), g.Str("uuid")
		led, err := openGameLedger(filepath.Join(ledDir, key+"-"+uuid[:8]+".jsonl"), key, uuid, true)
		if err != nil {
			ok = false
			list = append(list, Obj{{"key", key}, {"ok", false}, {"error", err.Error()}})
			continue
		}
		list = append(list, Obj{{"key", key}, {"ok", true}, {"pairs", len(led.pairs)}, {"tip", led.tip}})
	}
	report = report.Set("games", list)
	ev, err := openEventLedger(filepath.Join(root, "events.jsonl"), true)
	if err != nil {
		ok = false
		report = report.Set("events", Obj{{"ok", false}, {"error", err.Error()}})
	} else {
		report = report.Set("events", Obj{{"ok", true}, {"events", ev.seq}})
	}
	return report.Set("ok", ok)
}
