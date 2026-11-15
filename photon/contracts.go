// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// The edition's contracts, in the LK/Vexa languages, written and checked by the host itself.
//
//	rinkvt-photon contracts write      write the static MSSL records (from contracts_table.go)
//	rinkvt-photon contracts qualify    run the test suite (go test), then write contracts/mssl/90_qualification.mssl
//	rinkvt-photon contracts check      validate every record and JA source, and cross-check the constants
//
// check validates every record against the single-document rules of the MSSL Writers Corpus validator
// (tools/VERIFY_MSSL.py, validate_source), implemented here; it checks the JA files as the JA Core suite's
// tools/validate_suite.py checks its scripts (source header, module, policy no_network, brace balance), plus the
// grammar's top-level forms, and cross-checks the constants the contracts state against the implementation. Nothing
// in a record is promoted beyond the evidence it names: a record says OPERATIONAL only with tests that ran, and the
// qualification names the platform they ran on.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var msslAlpha = Obj{{"format", "0.3"}, {"profile", "basic_mssl.executable.3"}, {"record", "MSSL.Document"}, {"source_language", "MSSL"}, {"source_version", "0.3"}}
var msslFields = []string{"α", "ι", "λ", "ℛ", "π", "δ", "τ", "μ", "ρ", "χ", "η", "ν", "κ"}

func msslC(v any) string { return pyDumps(v, false, false) }

// msslDocument writes one MSSL 0.3 record: a module rule, then one learn rule per fact.
func msslDocument(identity, module string, facts Obj) string {
	rules := Obj{{"0001", "module(" + msslC(module) + ")"}}
	memory, state := Obj{}, Obj{}
	for i, f := range facts {
		literal, isStr := f.V.(string)
		if !isStr {
			literal = msslC(f.V)
		}
		rules = append(rules, KV{fmt.Sprintf("%04d", i+2), "learn(" + msslC(f.K) + ",literal(" + msslC(literal) + "))"})
		memory = append(memory, KV{"learn." + f.K, f.V})
		state = append(state, KV{f.K, f.V})
	}
	body := strings.Join([]string{
		"α≡" + msslC(msslAlpha), "ι≡" + msslC(identity), "λ≡" + msslC(module), "ℛ≡" + msslC(rules), "π≡[]", fmt.Sprintf("δ≡%d", len(rules)), "τ≡0",
		"μ≡" + msslC(memory), `ρ≡{"assertions":[],"emissions":[],"prints":[]}`, "χ≡[]", "η≡" + msslC(Obj{{"events", []any{}}, {"state", state}}), "ν≡{}",
	}, ",\n") + "\n"
	return "MSSL{\n" + body + ",κ≡" + msslC("sha256:"+sha256Hex([]byte(body))) + "\n}⇒⊤\n"
}

func recordIdentity(module string) string {
	parts := strings.Split(module, ".")
	return fmt.Sprintf("mssl:rinkvt:lkvexa:%s:%s", parts[len(parts)-1], VERSION)
}

// validateMSSL applies the single-document predicates of the corpus validator (tools/VERIFY_MSSL.py validate_source).
func validateMSSL(text string) (Obj, error) {
	invalid := func(m string) (Obj, error) { return nil, fmt.Errorf("%s", m) }
	ws := func(p int) int {
		for p < len(text) {
			r, size := decodeRune(text, p)
			if !unicode.IsSpace(r) {
				break
			}
			p += size
		}
		return p
	}
	pos := ws(0)
	if !strings.HasPrefix(text[pos:], "MSSL{") {
		return invalid("invalid envelope prefix")
	}
	pos += len("MSSL{")
	v := Obj{}
	alphaAt, kappaAt := 0, 0
	for n, key := range msslFields {
		pos = ws(pos)
		if n > 0 {
			if pos >= len(text) || text[pos] != ',' {
				return invalid("missing comma before " + key)
			}
			if key == "κ" {
				kappaAt = pos
			}
			pos = ws(pos + 1)
		}
		if !strings.HasPrefix(text[pos:], key+"≡") {
			return invalid("expected field " + key)
		}
		if key == "α" {
			alphaAt = pos
		}
		pos = ws(pos + len(key) + len("≡"))
		val, end, err := rawDecode(text, pos)
		if err != nil {
			return invalid(fmt.Sprintf("field %s: %v", key, err))
		}
		v = append(v, KV{key, val})
		pos = end
	}
	pos = ws(pos)
	if !strings.HasPrefix(text[pos:], "}⇒⊤") || ws(pos+len("}⇒⊤")) != len(text) {
		return invalid("invalid terminal marker or trailing content")
	}
	get := func(k string) any { x, _ := v.Get(k); return x }
	alpha, ok := get("α").(Obj)
	if format := alpha.Str("format"); !ok || alpha.Str("record") != "MSSL.Document" || (format != "0.1" && format != "0.2" && format != "0.3") {
		return invalid("unobserved record/format")
	}
	rules, ok := get("ℛ").(Obj)
	if !ok {
		return invalid("nonconsecutive rule ids")
	}
	for i, kv := range rules {
		if kv.K != fmt.Sprintf("%04d", i+1) {
			return invalid("nonconsecutive rule ids")
		}
	}
	delta, dOK := numberInt(get("δ"))
	tau, tOK := numberInt(get("τ"))
	if !dOK || delta != int64(len(rules)) || !tOK || tau != 0 {
		return invalid("delta or tau")
	}
	rho, rOK := get("ρ").(Obj)
	_, piOK := get("π").([]any)
	_, chiOK := get("χ").([]any)
	_, nuOK := get("ν").(Obj)
	if !rOK || len(rho) != 3 || !rho.Has("assertions") || !rho.Has("emissions") || !rho.Has("prints") || !piOK || !chiOK || !nuOK {
		return invalid("structural fields")
	}
	learned := Obj{}
	var modules []string
	for _, kv := range rules {
		rule, _ := kv.V.(string)
		switch {
		case strings.HasPrefix(rule, "module(") && strings.HasSuffix(rule, ")"):
			arg, end, err := rawDecode(rule, len("module("))
			s, isStr := arg.(string)
			if err != nil || end != len(rule)-1 || !isStr {
				return invalid("module form")
			}
			modules = append(modules, s)
		case strings.HasPrefix(rule, "learn("):
			key, end, err := rawDecode(rule, len("learn("))
			if err != nil || !strings.HasPrefix(rule[end:], ",literal(") {
				return invalid("learn form")
			}
			lit, end2, err := rawDecode(rule, end+len(",literal("))
			k, kOK := key.(string)
			l, lOK := lit.(string)
			if err != nil || rule[end2:] != "))" || !kOK || !lOK || learned.Has(k) {
				return invalid("learn form or duplicate key")
			}
			learned = append(learned, KV{k, l})
		default:
			return invalid("unobserved operator")
		}
	}
	lambda, _ := get("λ").(string)
	if len(modules) != 1 || modules[0] != lambda {
		return invalid("module mismatch")
	}
	mu, muOK := get("μ").(Obj)
	eta, _ := get("η").(Obj)
	stateV, _ := eta.Get("state")
	state, sOK := stateV.(Obj)
	if !muOK || !sOK || len(mu) != len(learned) || len(state) != len(learned) {
		return invalid("memory/state mismatch")
	}
	for _, kv := range learned {
		m, has := mu.Get("learn." + kv.K)
		s, has2 := state.Get(kv.K)
		if !has || !has2 || !jsonEqual(m, s) {
			return invalid("memory/state mismatch")
		}
		lit := kv.V.(string)
		if sv, isStr := m.(string); isStr {
			if lit != sv {
				return invalid("string literal/memory mismatch " + kv.K)
			}
		} else {
			decoded, err := parseJSON(lit)
			if err != nil || !jsonEqual(decoded, m) {
				return invalid("typed literal/memory mismatch " + kv.K)
			}
		}
	}
	if kappa, _ := get("κ").(string); kappa != "sha256:"+sha256Hex([]byte(text[alphaAt:kappaAt])) {
		return invalid("kappa mismatch")
	}
	return v, nil
}

func decodeRune(s string, i int) (rune, int) { return utf8.DecodeRuneInString(s[i:]) }

// ---- JA -----------------------------------------------------------------------------------------------------

var jaTopRE = regexp.MustCompile(`^(use|import|policy|const|record|enum|variant|function|func|trait|impl|macro|package|let|var|assert|emit|match|return)\b`)
var jaModuleRE = regexp.MustCompile(`^module [A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$`)

// checkJA is what the JA Core suite's tools/validate_suite.py requires of every script, and the provisional grammar's
// top-level forms.
func checkJA(path string) []string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return []string{err.Error()}
	}
	text := strings.TrimRight(string(raw), " \t\r\n")
	lines := strings.Split(text, "\n")
	var problems []string
	if !strings.Contains(text, "ja source") || !strings.Contains(text, "module ") || !strings.Contains(text, "policy no_network") {
		problems = append(problems, "required source declarations (ja source, module, policy no_network)")
	}
	if strings.Count(text, "{") != strings.Count(text, "}") {
		problems = append(problems, "brace balance")
	}
	if strings.Count(text, "(") != strings.Count(text, ")") || strings.Count(text, "[") != strings.Count(text, "]") {
		problems = append(problems, "parenthesis or bracket balance")
	}
	if lines[0] != "ja source 0.3" {
		problems = append(problems, "line 1 must be the source header 'ja source 0.3'")
	}
	if len(lines) < 2 || !jaModuleRE.MatchString(lines[1]) {
		problems = append(problems, "line 2 must be 'module qualified.name'")
	}
	depth := 0
	for i := 2; i < len(lines); i++ {
		line, n := lines[i], i+1
		s := strings.TrimSpace(line)
		if s != "" && depth == 0 && !jaTopRE.MatchString(s) && !strings.HasPrefix(s, "}") {
			problems = append(problems, fmt.Sprintf("line %d: not a declaration or statement of the provisional grammar", n))
		}
		depth += strings.Count(line, "{") - strings.Count(line, "}")
		if depth < 0 {
			problems = append(problems, fmt.Sprintf("line %d: a closing brace without an opening one", n))
			depth = 0
		}
		if strings.Contains(line, "\t") {
			problems = append(problems, fmt.Sprintf("line %d: a tab (the suite's scripts indent with spaces)", n))
		}
	}
	return problems
}

var clockTableRE = regexp.MustCompile(`\{ set: 83, [^}]*\}\[ast\.action\]`)

// engineClockByte is the clock-action byte the engine's wire format writes for an action (rink/shared/wire.js).
func engineClockByte(root, action string) string {
	raw, _ := os.ReadFile(filepath.Join(root, "engine", "rink", "shared", "wire.js"))
	if m := clockTableRE.FindString(string(raw)); m != "" {
		if f := regexp.MustCompile(action + `: (\d+)`).FindStringSubmatch(m); f != nil {
			return f[1]
		}
	}
	return "(not in the engine)"
}

// engineOvertime is the engine's overtime presets and built-in rules (rink/server/overtime.js), as the JA contract
// states them.
func engineOvertime(root string) []string {
	raw, _ := os.ReadFile(filepath.Join(root, "engine", "rink", "server", "overtime.js"))
	js := string(raw)
	blk := `\{ ot: (\d+), skaters: (\d+), so: (\d+) \}`
	sudden := regexp.MustCompile(`const SUDDEN_DEATH = ` + blk + `;`).FindStringSubmatch(js)
	var out []string
	re := regexp.MustCompile(`(?m)^  '?([a-z-]+)'?: \{ reg: ` + blk + `, po: (SUDDEN_DEATH|` + blk + `),`)
	for _, m := range re.FindAllStringSubmatch(js, -1) {
		po := []string{m[6], m[7], m[8]}
		if m[5] == "SUDDEN_DEATH" && sudden != nil {
			po = sudden[1:4]
		}
		out = append(out, fmt.Sprintf("let %s: Rules = Rules { reg: Block { ot: %s, skaters: %s, so: %s }, po: Block { ot: %s, skaters: %s, so: %s } }",
			strings.ReplaceAll(m[1], "-", "_"), m[2], m[3], m[4], po[0], po[1], po[2]))
	}
	for _, c := range [][2]string{{"LEGACY_REG", "Stage.Regular"}, {"LEGACY_PO", "_"}} {
		m := regexp.MustCompile(c[0] + ` = Object\.freeze\(\{ ot: (\d+), skaters: (\d+), so: (\d+), repeat: (true|false)`).FindStringSubmatch(js)
		if m == nil {
			out = append(out, c[0]+" (not in the engine)")
			continue
		}
		out = append(out, fmt.Sprintf("%s => Decider { ot: %s, skaters: %s, so: %s, repeat: %s }", c[1], m[1], m[2], m[3], m[4]))
	}
	if len(out) < 8 {
		out = append(out, "(the engine's presets could not be read)")
	}
	return out
}

// crossChecks compares the constants the contracts state with the implementation that keeps them.
func crossChecks(root string) []string {
	ja := map[string]string{}
	for _, f := range jaFiles {
		b, _ := os.ReadFile(filepath.Join(root, "contracts", "ja", f))
		ja[f] = string(b)
	}
	pool, _ := newPool(defaultPool)
	t, _ := newLeaseTable("", defaultPool, 128, 65536, true)
	ipAddr, _, _, _, _ := t.lease("203.0.113.5", "")
	vector := "4c4c4544003910398053b4c04f584e33"
	want := [][2]string{
		{"rinkvt_frame.ja", fmt.Sprintf(`Crc32c.of(Bytes.text("123456789")) == %d`, crc32c([]byte("123456789")))},
		{"rinkvt_frame.ja", fmt.Sprintf("meta_magic: Count = %d", metaMagic)},
		{"rinkvt_frame.ja", "clock_start_byte: Count = " + engineClockByte(root, "start")},
		{"rinkvt_frame.ja", "clock_whistle_byte: Count = " + engineClockByte(root, "whistle")},
		{"rinkvt_loopback.ja", fmt.Sprintf(`base: "%s", prefix_length: %d, capacity: %d`, strings.Split(defaultPool, "/")[0], pool.length, pool.capacity)},
		{"rinkvt_loopback.ja", fmt.Sprintf(`first_address(canonical_key("203.0.113.5"), default_pool) == "%s"`, ipAddr)},
		{"rinkvt_loopback.ja", fmt.Sprintf(`device_key("%s") == "%s"`, vector, deriveDeviceKey(vector))},
		{"rinkvt_loopback.ja", fmt.Sprintf(`first_address(device_key("%s"), default_pool) == "%s"`, vector, pool.addressAt(slotOf(deriveDeviceKey(vector), pool.capacity)))},
		{"rinkvt_store.ja", fmt.Sprintf("max_registry_bytes: Count = %d", maxRegistry)},
		{"rinkvt_store.ja", fmt.Sprintf("max_pairs_per_game: Count = %d", maxPairsPerGame)},
		{"rinkvt_host.ja", fmt.Sprintf(`token_header: Text = "%s"`, tokenHeader)},
		{"rinkvt_host.ja", fmt.Sprintf("max_body_bytes: Count = %d", maxBody)},
	}
	for _, line := range engineOvertime(root) {
		want = append(want, [2]string{"rinkvt_overtime.ja", line})
	}
	var problems []string
	for _, w := range want {
		if !strings.Contains(ja[w[0]], w[1]) {
			problems = append(problems, fmt.Sprintf("%s: does not state %q (the implementation's value)", w[0], w[1]))
		}
	}
	return problems
}

// ---- the commands -------------------------------------------------------------------------------------------

func writeContracts(root string) error {
	dir := filepath.Join(root, "contracts", "mssl")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, r := range contractTable() {
		if err := os.WriteFile(filepath.Join(dir, r.file), []byte(msslDocument(recordIdentity(r.module), r.module, r.facts)), 0o644); err != nil {
			return err
		}
	}
	return nil
}

// checkContracts returns every problem with the contracts: records, qualification, JA sources and constants.
func checkContracts(root string) []string {
	dir := filepath.Join(root, "contracts", "mssl")
	expected := map[string]string{}
	for _, r := range contractTable() {
		expected[r.file] = msslDocument(recordIdentity(r.module), r.module, r.facts)
	}
	names := map[string]bool{qualificationFile: true}
	for n := range expected {
		names[n] = true
	}
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".mssl") {
				names[e.Name()] = true
			}
		}
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	var problems []string
	for _, name := range sorted {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			how := " (rinkvt-photon contracts write)"
			if name == qualificationFile {
				how = " (rinkvt-photon contracts qualify)"
			}
			problems = append(problems, "contracts/mssl/"+name+": missing"+how)
			continue
		}
		v, err := validateMSSL(string(raw))
		if err != nil {
			problems = append(problems, fmt.Sprintf("contracts/mssl/%s: %v", name, err))
			continue
		}
		if want, ok := expected[name]; ok && string(raw) != want {
			problems = append(problems, "contracts/mssl/"+name+": not what rinkvt-photon contracts write writes (stale; run it)")
		}
		if name == qualificationFile {
			eta, _ := v.Get("η")
			st, _ := eta.(Obj).Get("state")
			state, _ := st.(Obj)
			if !strings.HasPrefix(state.Str("target"), "RINK-VT "+VERSION+" ") {
				problems = append(problems, fmt.Sprintf("contracts/mssl/%s: qualifies %s, not %s (run qualify)", name, state.Str("target"), VERSION))
			}
			if state.Str("result") != "PASS" {
				problems = append(problems, fmt.Sprintf("contracts/mssl/%s: the last qualification was %s", name, state.Str("result")))
			}
		} else if _, ok := expected[name]; !ok {
			problems = append(problems, "contracts/mssl/"+name+": not a contract of this edition")
		}
	}
	for _, f := range jaFiles {
		path := filepath.Join(root, "contracts", "ja", f)
		if !exists(path) {
			problems = append(problems, "contracts/ja/"+f+": missing")
			continue
		}
		for _, p := range checkJA(path) {
			problems = append(problems, "contracts/ja/"+f+": "+p)
		}
	}
	return append(problems, crossChecks(root)...)
}

func cmdContracts(args []string) int {
	root := releaseRoot()
	if len(args) == 0 {
		fmt.Println("usage: rinkvt-photon contracts write | check | qualify")
		return exitUsage
	}
	switch args[0] {
	case "write":
		if err := writeContracts(root); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return exitFail
		}
		fmt.Printf("contracts/mssl: %d records written\n", len(contractTable()))
		return exitOK
	case "check":
		problems := checkContracts(root)
		for _, p := range problems {
			fmt.Println("FAIL " + p)
		}
		state := "PASS"
		if len(problems) > 0 {
			state = "FAIL"
		}
		fmt.Printf("%s · %d MSSL records · %d JA contracts · constants cross-checked\n", state, len(contractTable())+1, len(jaFiles))
		if len(problems) > 0 {
			return exitFail
		}
		return exitOK
	case "qualify":
		return qualify(root)
	}
	fmt.Println("usage: rinkvt-photon contracts write | check | qualify")
	return exitUsage
}

var (
	goTestResultRE = regexp.MustCompile(`(?m)^--- (PASS|FAIL|SKIP): (Test\w+)`)
	browserLineRE  = regexp.MustCompile(`(?m)^RINKVT-BROWSER (.+)$`)
	testFileRE     = regexp.MustCompile(`(?m)^func (Test\w+)\(`)
)

// qualify runs the test suite and records what it showed, no more.
func qualify(root string) int {
	cmd := exec.Command("go", "test", "-count=1", "-v", "./...")
	cmd.Dir = filepath.Join(root, "photon")
	cmd.Env = append(os.Environ(), "RINKVT_QUALIFY=1", "RINKVT_ROOT="+root)
	outB, runErr := cmd.CombinedOutput()
	out := string(outB)
	counts := map[string]int{}
	ran := map[string]bool{}
	for _, m := range goTestResultRE.FindAllStringSubmatch(out, -1) {
		counts[m[1]]++
		ran[m[2]] = true
	}
	total := counts["PASS"] + counts["FAIL"] + counts["SKIP"]
	ok := runErr == nil && total > 0 && counts["FAIL"] == 0
	// which test files ran: those that define a test that reported
	covered := []any{}
	files, _ := filepath.Glob(filepath.Join(root, "photon", "*_test.go"))
	sort.Strings(files)
	for _, f := range files {
		b, _ := os.ReadFile(f)
		for _, m := range testFileRE.FindAllStringSubmatch(string(b), -1) {
			if ran[m[1]] {
				covered = append(covered, "photon/"+filepath.Base(f))
				break
			}
		}
	}
	scope := []string{"the host, store, lease, device, release, contract and handguide tests of this edition"}
	if m := browserLineRE.FindStringSubmatch(out); m != nil && !strings.Contains(out, "--- SKIP: TestBrowser") {
		scope = append(scope, "the browser tests in "+strings.TrimSpace(m[1]))
	} else {
		scope = append(scope, "no browser tests (no Chromium-family browser was available)")
	}
	goVersion := runtime.Version()
	if v, err := exec.Command("go", "env", "GOVERSION").Output(); err == nil {
		goVersion = strings.TrimSpace(string(v))
	}
	result := "BLOCKED"
	if ok {
		result = "PASS"
	}
	facts := Obj{
		{"target", fmt.Sprintf("RINK-VT %s (engine %s)", VERSION, ENGINE)},
		{"result", result},
		{"checks", total},
		{"passed", counts["PASS"]},
		{"skipped", counts["SKIP"]},
		{"failed", counts["FAIL"]},
		{"covered", covered},
		{"evidence", []any{"go test -count=1 -v ./... (in photon/)"}},
		{"mssl_corpus_validator", "not part of this build: the MSSL Writers Corpus validator (tools/VERIFY_MSSL.py) is a Python program; rinkvt-photon applies the same single-document rules to every record"},
		{"platform", fmt.Sprintf("%s · %s/%s · %s", osDescription(), runtime.GOOS, runtime.GOARCH, goVersion)},
		{"run_at", time.Now().UTC().Format("2006-01-02T15:04:05Z")},
		{"scope_limit", strings.Join(scope, "; ") + "; on this platform only. Other operating systems, and the launchers START_RINKVT and VERIFY_RINKVT on them, are not qualified by this record"},
	}
	dir := filepath.Join(root, "contracts", "mssl")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitFail
	}
	if err := os.WriteFile(filepath.Join(dir, qualificationFile), []byte(msslDocument("mssl:rinkvt:lkvexa:qualification:"+VERSION, "rinkvt.lkvexa.qualification", facts)), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitFail
	}
	if !ok {
		tail := out
		if len(tail) > 3000 {
			tail = tail[len(tail)-3000:]
		}
		fmt.Println(tail)
	}
	fmt.Printf("qualification: %s · %d checks · %d passed · %d skipped · %d failed\n", result, total, counts["PASS"], counts["SKIP"], counts["FAIL"])
	if ok {
		return exitOK
	}
	return exitFail
}

// osDescription names the operating system the way its own release file does, where there is one.
func osDescription() string {
	if f, err := os.Open("/etc/os-release"); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if v, ok := strings.CutPrefix(sc.Text(), "PRETTY_NAME="); ok {
				return strings.Trim(v, `"`)
			}
		}
	}
	return runtime.GOOS
}

var _ = json.Number("")
