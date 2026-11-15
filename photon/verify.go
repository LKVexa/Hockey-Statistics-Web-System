// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// rinkvt-photon verify (VERIFY_RINKVT): everything a laptop can check without installing anything.
//
//	[1] release     every file matches RELEASE_MANIFEST.json
//	[2] bundle      the renderer bundle is what engine/ and ui/ give
//	[3] contracts   the MSSL records and JA21 sources are valid, current, and state the implementation's values
//	[4] host        the host's own self-test, in a scratch folder: seals and chains, leases, the device key, and the
//	                HTTP guards and a commit round trip over a real loopback listener
//	[5] league      the data folder, read only (left to a running host's own store verify while one holds it)
//
// Nothing is written outside a scratch folder that is removed afterwards.

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// testFrame is a 64-byte frame as the engine seals it: game hash at 32..35, CRC-32C (big-endian) of 0..59 at 60..63.
func testFrame(gameUUID string, n int) []byte {
	b := make([]byte, 64)
	copy(b[0:16], []byte(fmt.Sprintf("frame-%010d", n)))
	binary.BigEndian.PutUint64(b[16:24], 1_700_000_000_000_000_000+uint64(n))
	binary.BigEndian.PutUint64(b[24:32], 1_700_000_000_000_000_005+uint64(n))
	h, _ := hexDecodeUUID(gameUUID)
	copy(b[32:36], h[:4])
	binary.BigEndian.PutUint32(b[36:40], uint32(n+1))
	copy(b[40:44], "FOCO")
	copy(b[44:48], "SMIT")
	copy(b[48:52], "S\x00\x00\x00")
	binary.BigEndian.PutUint32(b[60:64], crc32c(b[:60]))
	return b
}

// testMeta is a 64-byte meta line: magic CMT1 (little-endian) at 0..3, CRC-32C (little-endian) of 0..59 at 60..63.
func testMeta(n int) []byte {
	b := make([]byte, 64)
	binary.LittleEndian.PutUint32(b[0:4], metaMagic)
	binary.LittleEndian.PutUint64(b[4:12], uint64(n))
	copy(b[12:20], "operator")
	copy(b[52:56], []byte{127, 20, 66, 113})
	binary.LittleEndian.PutUint32(b[60:64], crc32c(b[:60]))
	return b
}

func testPairs(gameUUID string, n0, count int) []byte {
	var out []byte
	for i := 0; i < count; i++ {
		out = append(out, testFrame(gameUUID, n0+i)...)
		out = append(out, testMeta(n0+i)...)
	}
	return out
}

func hexDecodeUUID(u string) ([]byte, error) { return hex.DecodeString(strings.ReplaceAll(u, "-", "")) }

func testRegistry(games [][2]string) string {
	list := []any{}
	for _, g := range games {
		list = append(list, Obj{{"key", g[0]}, {"uuid", g[1]}})
	}
	return pyDumpsIndent(Obj{{"schema", registrySchema}, {"seq", len(games)}, {"leagues", []any{}}, {"teams", []any{}}, {"players", []any{}},
		{"games", list}, {"notes", []any{}}}, 1, true, false) + "\n"
}

type selfCheck struct {
	name string
	fn   func(dir string) error
}

func expect(cond bool, f string, a ...any) error {
	if cond {
		return nil
	}
	return fmt.Errorf(f, a...)
}

// hostSelfTest exercises the host's own parts in dir; it returns one line per check that failed.
func hostSelfTest(dir string) []string {
	const uuid = "6e49bb4c-fe72-5a8b-b7cd-d994a098368e"
	checks := []selfCheck{
		{"CRC-32C check value", func(string) error {
			return expect(crc32c([]byte("123456789")) == 0xE3069283, "crc32c(123456789) = %08x", crc32c([]byte("123456789")))
		}},
		{"device key", func(string) error {
			return expect(deriveDeviceKey("4c4c4544003910398053b4c04f584e33") == "device:786ccb4ad0fe713fbca602c54b373160", "the device key of the test vector changed")
		}},
		{"loopback leases", func(d string) error {
			t, err := newLeaseTable(filepath.Join(d, "leases"), defaultPool, 128, 65536, true)
			if err != nil {
				return err
			}
			a, _, _, _, err := t.lease("203.0.113.5", "")
			if err != nil || a != "127.20.66.113" {
				return fmt.Errorf("203.0.113.5 leased %s (%v), not 127.20.66.113", a, err)
			}
			dev := deriveDeviceKey("4c4c4544003910398053b4c04f584e33")
			first, _, _, _, err := t.lease(dev, "")
			if err != nil || first != "127.26.220.77" {
				return fmt.Errorf("the device vector leased %s (%v), not 127.26.220.77", first, err)
			}
			t2, err := newLeaseTable(filepath.Join(d, "leases"), defaultPool, 128, 65536, true)
			if err != nil {
				return err
			}
			again, _, fresh, _, err := t2.lease(dev, "")
			return expect(err == nil && again == first && !fresh, "a lease did not stay static across a reopen")
		}},
		{"device file", func(d string) error {
			dev, err := loadDevice(filepath.Join(d, "device.json"), func() string { return "4c4c4544003910398053b4c04f584e33" }, true)
			if err != nil {
				return err
			}
			if _, err := dev.pin("127.26.220.77", defaultPool, ""); err != nil {
				return err
			}
			back, err := loadDevice(filepath.Join(d, "device.json"), func() string { return "4c4c4544003910398053b4c04f584e33" }, false)
			return expect(err == nil && back != nil && back.address() == "127.26.220.77" && len(back.notes) == 0, "the sealed device file did not read back")
		}},
		{"league store", func(d string) error {
			root := filepath.Join(d, "league-a")
			s, err := openLeagueStore(root)
			if err != nil {
				return err
			}
			reg := testRegistry([][2]string{{"G1", uuid}})
			if _, err := s.commit(&reg, nil, nil); err != nil {
				return err
			}
			batch := Obj{{"game", "G1"}, {"uuid", uuid}, {"start", 0}, {"data", base64.StdEncoding.EncodeToString(testPairs(uuid, 0, 3))}}
			if _, err := s.commit(nil, s.registrySha, []Obj{batch}); err != nil {
				return err
			}
			again, err := openLeagueStore(root)
			if err != nil {
				return err
			}
			if len(again.ledgers["G1"].pairs) != 3 {
				return fmt.Errorf("the ledger did not reopen with its 3 pairs")
			}
			if ok, _ := verifyFolder(root).Get("ok"); ok != true {
				return fmt.Errorf("a sound league did not verify")
			}
			path := again.ledgers["G1"].path
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			lines := bytes.Split(raw, []byte("\n"))
			at := bytes.Index(lines[2], []byte(`"frame":"`)) + len(`"frame":"`)
			if lines[2][at] == '0' { // one hex digit of a stored frame changes; the line stays valid JSON
				lines[2][at] = '1'
			} else {
				lines[2][at] = '0'
			}
			if err := os.WriteFile(path, bytes.Join(lines, []byte("\n")), 0o600); err != nil {
				return err
			}
			ok, _ := verifyFolder(root).Get("ok")
			return expect(ok == false, "an edited ledger line was not refused")
		}},
		{"HTTP guards and a commit round trip", func(d string) error { return serverSelfTest(filepath.Join(d, "league-b"), uuid) }},
	}
	var failed []string
	for i, c := range checks {
		sub := filepath.Join(dir, fmt.Sprintf("check-%d", i))
		if err := os.MkdirAll(sub, 0o700); err != nil {
			return append(failed, err.Error())
		}
		if err := c.fn(sub); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v", c.name, err))
		}
	}
	return failed
}

func serverSelfTest(root, uuid string) error {
	s, err := openLeagueStore(root)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	uiDir := filepath.Join(root, "ui")
	os.MkdirAll(uiDir, 0o700)
	os.WriteFile(filepath.Join(uiDir, "workbench.html"), []byte("<p>__RINKVT_TOKEN__ __RINKVT_LOCAL__</p>"), 0o600)
	h := newPhotonHost(ln, s, "selftest-token", uiDir, Obj{{"local", "127.26.220.77"}, {"client", "device 786ccb4a"}})
	go h.serve()
	defer h.shutdown()
	host, port := h.address()
	base := fmt.Sprintf("http://%s:%d", host, port)
	client := &http.Client{Timeout: 10 * time.Second}
	do := func(method, path, hostHeader string, headers map[string]string, body string) (int, string) {
		req, _ := http.NewRequest(method, base+path, strings.NewReader(body))
		if hostHeader != "" {
			req.Host = hostHeader
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := client.Do(req)
		if err != nil {
			return 0, err.Error()
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	tok := map[string]string{tokenHeader: "selftest-token"}
	post := map[string]string{tokenHeader: "selftest-token", "Content-Type": "application/json"}
	if st, body := do("GET", "/api/health", "", nil, ""); st != 200 || !strings.Contains(body, VERSION) {
		return fmt.Errorf("/api/health answered %d", st)
	}
	if st, _ := do("GET", "/api/health", "evil.example:80", nil, ""); st != 421 {
		return fmt.Errorf("a foreign Host header was answered %d, not 421", st)
	}
	if st, _ := do("GET", "/api/league", "", nil, ""); st != 403 {
		return fmt.Errorf("a call without the token was answered %d, not 403", st)
	}
	if st, _ := do("POST", "/api/commit", "", map[string]string{tokenHeader: "selftest-token", "Content-Type": "text/plain"}, "{}"); st != 415 {
		return fmt.Errorf("a non-JSON commit was answered %d, not 415", st)
	}
	if st, _ := do("POST", "/api/commit", "", map[string]string{tokenHeader: "selftest-token", "Content-Type": "application/json", "Origin": "http://evil.example"}, "{}"); st != 403 {
		return fmt.Errorf("a cross-origin commit was answered %d, not 403", st)
	}
	if st, _ := do("POST", "/api/commit", "", post, `{"a":1,"a":2}`); st != 400 {
		return fmt.Errorf("duplicate keys were answered %d, not 400", st)
	}
	reg := testRegistry([][2]string{{"G1", uuid}})
	commit := pyDumps(Obj{{"registry", reg}, {"base", nil}, {"ledgers", []any{Obj{{"game", "G1"}, {"uuid", uuid}, {"start", 0},
		{"data", base64.StdEncoding.EncodeToString(testPairs(uuid, 0, 2))}}}}}, false, false)
	st, body := do("POST", "/api/commit", "", post, commit)
	if st != 200 {
		return fmt.Errorf("a commit was answered %d: %s", st, truncate(body, 200))
	}
	if st, _ := do("POST", "/api/commit", "", post, commit); st != 409 {
		return fmt.Errorf("a stale commit was answered %d, not 409", st)
	}
	st, league := do("GET", "/api/league", "", tok, "")
	if st != 200 || !strings.Contains(league, `"pairs":2`) {
		return fmt.Errorf("/api/league answered %d", st)
	}
	if st, page := do("GET", "/", "", nil, ""); st != 200 || !strings.Contains(page, "selftest-token 127.26.220.77") {
		return fmt.Errorf("the page was not served with its token and lease")
	}
	if st, _ := do("DELETE", "/api/league", "", tok, ""); st != 405 {
		return fmt.Errorf("DELETE was answered %d, not 405", st)
	}
	return nil
}

func cmdVerify(args []string) int {
	root := releaseRoot()
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	data := fs.String("data", filepath.Join(root, "runtime"), "the data folder to check (read only)")
	devFile := fs.String("device-file", "", "this laptop's device file")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	ok := true
	step := func(n int, what string, problems []string) {
		if len(problems) == 0 {
			fmt.Printf("[%d] %s: PASS\n", n, what)
			return
		}
		ok = false
		fmt.Printf("[%d] %s: FAIL\n", n, what)
		for _, p := range problems {
			fmt.Println("      " + p)
		}
	}
	fmt.Printf("%s %s · %s · %s\n", PRODUCT, VERSION, EDITION, runtimeText())
	release := verifyRelease(root, "all")
	var rp []string
	if r, _ := release.Get("ok"); r != true {
		for _, k := range []string{"error", "missing", "changed", "unlisted"} {
			if v, has := release.Get(k); has {
				if list, isList := v.([]any); !isList || len(list) > 0 {
					rp = append(rp, fmt.Sprintf("%s: %s", k, pyDumps(v, false, false)))
				}
			}
		}
	}
	files, _ := release.Get("files")
	step(1, fmt.Sprintf("release (%v files against %s)", files, manifestName), rp)
	stale, err := bundleStale(root)
	var bp []string
	if err != nil {
		bp = []string{err.Error()}
	} else if len(stale) > 0 {
		bp = []string{"stale: " + strings.Join(stale, ", ")}
	}
	step(2, "renderer bundle", bp)
	step(3, fmt.Sprintf("contracts (%d MSSL records, %d JA21 sources, constants cross-checked)", len(contractTable())+1, len(jaFiles)), checkContracts(root))
	scratch, err := os.MkdirTemp("", "rinkvt-selftest-")
	if err != nil {
		step(4, "host self-test", []string{err.Error()})
	} else {
		step(4, "host self-test (store, leases, device, HTTP guards)", hostSelfTest(scratch))
		os.RemoveAll(scratch)
	}
	var lp []string
	note := ""
	switch {
	case !exists(filepath.Join(*data, "league")):
		note = " (no league in " + *data + " yet)"
	default:
		if holder := (&InstanceLock{path: filepath.Join(*data, ".rinkvt.lock")}).holder(); holder != "" {
			note = " (skipped: " + holder + "; type store verify in its workbench)"
		} else {
			rep := verifyFolder(*data)
			if r, _ := rep.Get("ok"); r != true {
				lp = append(lp, pyDumps(rep, false, false))
			}
		}
	}
	step(5, "league"+note, lp)
	if dev, err := loadDevice(*devFile, machineIdentifier, false); err == nil && dev != nil {
		fmt.Printf("    this laptop: %s · pinned %s\n", dev.label(), func() string {
			if dev.address() == "" {
				return "nothing yet"
			}
			return dev.address()
		}())
	}
	if ok {
		fmt.Println("\nRINK-VT LK/Vexa edition: VERIFIED")
		return exitOK
	}
	fmt.Println("\nRINK-VT LK/Vexa edition: NOT VERIFIED")
	return exitFail
}
