// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// rinkvt-photon handguide: build the RINK-VT Technical Handguide (docs/handguide/RINK-VT_Handguide.pdf) from its
// sources, with an installed Edge, Chrome or Chromium and nothing else.
//
// The chapters are HTML fragments in docs/handguide/chapters/. The build numbers their headings, tables and figures,
// resolves cross-references ({{ref:key}}), generates the appendices from the engine itself (the command pack, the
// stat tokens, the query flags, the HK001 inputs and computation codes, read by running the engine bundle in the
// browser), from the test files and from the contract files, and lays the whole out as one document. The browser
// prints it until the page numbers settle, each pass with the numbers the pass before found; the running headers,
// footers and page numbers are printed as a second document and drawn over each page as an artifact, and the page
// labels, bookmarks and document information are added by pdf.go.

import (
	"encoding/json"
	"flag"
	"fmt"
	"html"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	hgDocID     = "RVT-HG-001"
	hgRevision  = "1.3"
	hgTitle     = "RINK-VT Workbench — Technical Handguide"
	hgReference = "2.5.0-rinkvt.1"
	hgAuthor    = "RUSSELL PHILIP SMITHSON"
)

var hgIssued = time.Date(2026, time.November, 15, 12, 0, 0, 0, time.UTC)

type hgPart struct {
	num, title string
	chapters   []string
}

var hgParts = []hgPart{
	{"I", "Orientation", []string{"01-scope", "02-overview", "03-getting-started"}},
	{"II", "Operation", []string{"04-host", "05-workbench", "06-language", "07-rosters", "08-recording", "09-loopback", "10-backup"}},
	{"III", "Technical reference", []string{"11-architecture", "12-formats", "13-api", "14-engine", "15-security"}},
	{"IV", "Assurance", []string{"16-verification", "17-tests", "18-contracts", "19-limits"}},
	{"V", "The reference edition", []string{"20-reference"}},
}

var hgAppendices = [][2]string{{"A", "gen:commands"}, {"B", "gen:tokens"}, {"C", "gen:queries"}, {"D", "gen:inputs"}, {"E", "gen:codes"},
	{"F", "gen:contracts"}, {"G", "21-glossary"}, {"H", "22-licence"}}

var hgFront = []string{"00-control"}

var hgPartIntro = map[string]string{
	"I":   "What the workbench is, who this guide is for, and how to start it.",
	"II":  "How to run the Photon host and the workbench, score games, keep rosters, and keep the league safe.",
	"III": "The architecture, the formats on disk and on the wire, the host's API, the engine's rules and models, and the security model.",
	"IV":  "How a release is verified, what its tests cover, what its contracts state, and where its limits lie.",
	"V":   "The HERMIT gateway on Node.js: the multi-user edition the engine comes from.",
}

func esc(s string) string { return html.EscapeString(s) }

// txt is a value of the engine's data as text.
func txt(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case json.Number:
		return numberText(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	}
	return fmt.Sprint(v)
}

// pyTitle is Python's str.title: each run of letters starts upper case and goes on lower case.
func pyTitle(s string) string {
	var b strings.Builder
	prev := false
	for _, r := range s {
		if unicode.IsLetter(r) {
			if prev {
				b.WriteRune(unicode.ToLower(r))
			} else {
				b.WriteRune(unicode.ToUpper(r))
			}
			prev = true
		} else {
			b.WriteRune(r)
			prev = false
		}
	}
	return b.String()
}

func roman(n int) string {
	vals := []int{1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1}
	syms := []string{"m", "cm", "d", "cd", "c", "xc", "l", "xl", "x", "ix", "v", "iv", "i"}
	var b strings.Builder
	for i, v := range vals {
		for n >= v {
			b.WriteString(syms[i])
			n -= v
		}
	}
	return b.String()
}

// ---- generated material --------------------------------------------------------------------------------------

const hgExtract = `(() => {
  const R = EngineRequire;
  const cat = R('rink/hk001/catalog.js'), inp = R('rink/hk001/inputs.js'), pack = R('src/main/spiral/commands/rink.js');
  const H = R('rink/shared/hcl.js'), Q = R('rink/server/query.js'), codes = R('rink/shared/codes.js');
  const isCode = (n) => /^(HKI-\d{3}|[A-Z0-9]+(-[A-Z0-9]+)+)$/.test(n);
  const take = (t) => H.Q_TAKES[t] || H.Q_TAKES[t === 'WAR' ? 'GAR' : t] || [[], 0];
  return {
    catalog: cat.CATALOG.map((c) => ({ code: c.code, stage: c.stage, family: c.family || '', label: c.label || '', published: !!c.published })),
    stats: cat.stats ? Object.entries(cat.stats()) : [],
    inputs: inp.INPUTS.map((i) => ({ code: i.code, field: i.field, label: i.label, unit: i.unit, scope: i.scope, cls: i.cls, tokens: [...i.tokens] })),
    commands: pack.filter((d) => !isCode(d.name)).map((d) => ({ name: d.name, aka: [...(d.aka || [])], summary: d.summary || '', usage: d.usage || '' })),
    codeCommands: pack.filter((d) => isCode(d.name)).length,
    tokens: Object.entries(H.STATS).map(([k, v]) => ({ token: k, kind: v.kind, label: v.label, inputs: inp.INPUTS.filter((x) => x.tokens.includes(k)).map((x) => x.code) })),
    shotTypes: Object.entries(H.SHOT_TYPES), flags: Object.entries(H.FLAGS), infractions: Object.entries(H.INFRACTIONS), aliases: Object.entries(H.FR),
    periods: Object.entries(H.PERIODS), maxPeriod: H.MAX_PERIOD,
    queries: Q.TARGETS.map((t) => ({ target: t, flags: [...(take(t)[0] || [])], nargs: take(t)[1] || 0 })),
    reserved: [...(codes.RESERVED_TEAMS || [])],
  };
})()`

type hgEngine struct {
	Catalog []struct {
		Code, Stage, Family, Label string
		Published                  bool
	}
	Stats  [][2]any
	Inputs []struct {
		Code, Field, Label, Unit, Scope, Cls string
		Tokens                               []string
	}
	Commands []struct {
		Name    string
		Aka     []string
		Summary string
		Usage   string
	}
	CodeCommands int
	Tokens       []struct {
		Token, Kind, Label string
		Inputs             []string
	}
	ShotTypes, Flags, Infractions, Aliases, Periods [][2]any
	MaxPeriod                                       any
	Queries                                         []struct {
		Target string
		Flags  []string
		Nargs  int
	}
	Reserved []string
}

func hgExtractEngine(b *HeadlessBrowser, root string) (*hgEngine, error) {
	js, err := engineJS(root)
	if err != nil {
		return nil, err
	}
	p, err := b.NewPage(0, 0)
	if err != nil {
		return nil, err
	}
	defer p.Close()
	if _, err := p.Eval(js + "\n;true"); err != nil {
		return nil, fmt.Errorf("the engine did not load: %v", err)
	}
	v, err := p.Eval(hgExtract)
	if err != nil {
		return nil, fmt.Errorf("the engine's tables could not be read: %v", err)
	}
	var e hgEngine
	if err := json.Unmarshal([]byte(pyDumps(v, false, false)), &e); err != nil {
		return nil, err
	}
	if len(e.Catalog) == 0 || len(e.Inputs) == 0 || len(e.Commands) == 0 {
		return nil, fmt.Errorf("the engine's tables came back empty")
	}
	return &e, nil
}

type hgTest struct{ file, fileDoc, name, what string }

var hgTestFuncRE = regexp.MustCompile(`^func (Test\w+)\(t \*testing\.T\)`)

func firstSentence(s string) string {
	if i := strings.Index(s, ". "); i >= 0 {
		return s[:i+1]
	}
	return s
}

// hgSplitName reads a test's name as words: TestStoreStaleBaseRefused is "Stale base refused" (the first word names
// the file's subject, which the inventory shows already).
func hgSplitName(name string) string {
	s := strings.TrimPrefix(name, "Test")
	var words []string
	special := []string{"IPv6", "Python", "Node"}
	for len(s) > 0 {
		found := false
		for _, w := range special {
			if strings.HasPrefix(s, w) {
				words, s, found = append(words, w), s[len(w):], true
				break
			}
		}
		if found {
			continue
		}
		rs := []rune(s)
		j := 1
		switch {
		case unicode.IsDigit(rs[0]):
			for j < len(rs) && unicode.IsDigit(rs[j]) {
				j++
			}
		case unicode.IsUpper(rs[0]) && len(rs) > 1 && unicode.IsUpper(rs[1]):
			for j < len(rs) && unicode.IsUpper(rs[j]) && !(j+1 < len(rs) && unicode.IsLower(rs[j+1])) {
				j++
			}
		default:
			for j < len(rs) && unicode.IsLower(rs[j]) {
				j++
			}
		}
		words, s = append(words, string(rs[:j])), string(rs[j:])
	}
	if len(words) > 1 {
		words = words[1:]
	}
	for i, w := range words {
		keep := w == "IPv6" || w == "Python" || w == "Node" || (len(w) > 1 && strings.ToUpper(w) == w)
		if !keep {
			w = strings.ToLower(w)
		}
		if i == 0 {
			rs := []rune(w)
			rs[0] = unicode.ToUpper(rs[0])
			w = string(rs)
		}
		words[i] = w
	}
	return strings.Join(words, " ")
}

func hgTestInventory(root string) ([]hgTest, error) {
	files, err := filepath.Glob(filepath.Join(root, "photon", "*_test.go"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	var out []hgTest
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		lines := strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
		doc := ""
		for i, l := range lines {
			if strings.HasPrefix(l, "package ") {
				j := i + 1
				for j < len(lines) && strings.TrimSpace(lines[j]) == "" {
					j++
				}
				var parts []string
				for j < len(lines) && strings.HasPrefix(lines[j], "//") {
					parts = append(parts, strings.TrimSpace(strings.TrimPrefix(lines[j], "//")))
					j++
				}
				doc = firstSentence(strings.Join(parts, " "))
				break
			}
		}
		for i, l := range lines {
			m := hgTestFuncRE.FindStringSubmatch(l)
			if m == nil {
				continue
			}
			var c []string
			for j := i - 1; j >= 0 && strings.HasPrefix(lines[j], "//"); j-- {
				c = append([]string{strings.TrimSpace(strings.TrimPrefix(lines[j], "//"))}, c...)
			}
			what := strings.TrimSpace(strings.TrimPrefix(strings.Join(c, " "), m[1]))
			what = strings.TrimSpace(strings.TrimPrefix(what, ":"))
			if what == "" {
				what = hgSplitName(m[1])
			} else {
				rs := []rune(what)
				rs[0] = unicode.ToUpper(rs[0])
				what = string(rs)
			}
			out = append(out, hgTest{file: filepath.Base(f), fileDoc: doc, name: m[1], what: what})
		}
	}
	return out, nil
}

type hgRecord struct {
	file, module, rules, kappa, text string
	state                            Obj
}

func hgContractFiles(root string) ([]hgRecord, [][2]string, error) {
	dir := filepath.Join(root, "contracts", "mssl")
	names, err := filepath.Glob(filepath.Join(dir, "*.mssl"))
	if err != nil {
		return nil, nil, err
	}
	sort.Strings(names)
	var recs []hgRecord
	for _, n := range names {
		b, err := os.ReadFile(n)
		if err != nil {
			return nil, nil, err
		}
		v, err := validateMSSL(string(b))
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %v", filepath.Base(n), err)
		}
		r := hgRecord{file: filepath.Base(n), module: v.Str("λ"), kappa: v.Str("κ"), text: string(b)}
		d, _ := v.Get("δ")
		r.rules = txt(d)
		if eta, ok := v.Get("η"); ok {
			if eo, ok := eta.(Obj); ok {
				if st, ok := eo.Get("state"); ok {
					r.state, _ = st.(Obj)
				}
			}
		}
		recs = append(recs, r)
	}
	var ja [][2]string
	for _, f := range jaFiles {
		b, err := os.ReadFile(filepath.Join(root, "contracts", "ja", f))
		if err != nil {
			return nil, nil, err
		}
		ja = append(ja, [2]string{f, string(b)})
	}
	return recs, ja, nil
}

func hgTable(rows [][]string, head []string, cls, key, caption string, widths []string) string {
	var b strings.Builder
	b.WriteString(`<table class="` + cls + `"`)
	if key != "" {
		b.WriteString(` key="` + key + `"`)
	}
	if caption != "" {
		b.WriteString(` caption="` + esc(caption) + `"`)
	}
	b.WriteString("><colgroup>")
	for _, w := range widths {
		b.WriteString(`<col style="width:` + w + `">`)
	}
	b.WriteString("</colgroup><thead><tr>")
	for _, h := range head {
		b.WriteString("<th>" + h + "</th>")
	}
	b.WriteString("</tr></thead><tbody>")
	for _, r := range rows {
		b.WriteString("<tr>")
		for _, c := range r {
			b.WriteString("<td>" + c + "</td>")
		}
		b.WriteString("</tr>")
	}
	b.WriteString("</tbody></table>")
	return b.String()
}

func codeList(items []string) string {
	var parts []string
	for _, s := range items {
		parts = append(parts, "<code>"+esc(s)+"</code>")
	}
	return strings.Join(parts, " ")
}

func hgGenCommands(d *hgEngine) string {
	var rows [][]string
	for _, c := range d.Commands {
		name := "<code>" + esc(c.Name) + "</code>"
		if len(c.Aka) > 0 {
			var a []string
			for _, x := range c.Aka {
				a = append(a, esc(x))
			}
			name += "<br><span class=dim>also " + strings.Join(a, ", ") + "</span>"
		}
		rows = append(rows, []string{name, esc(c.Summary), "<code class=wrap>" + esc(c.Usage) + "</code>"})
	}
	return "<h1>Command reference</h1>" +
		"<p>The commands of the workbench, as the engine itself declares them (name, summary and usage line, read from " +
		"<code>src/main/spiral/commands/rink.js</code> when this guide was built). Inside RINK mode, a line that is not a line of " +
		"the scorer's language runs as one of these commands. Every HK001 computation code and input code is a command of its own " +
		fmt.Sprintf("as well: %d of them, listed in Appendices D and E. The workbench adds <code>store</code>, ", d.CodeCommands) +
		"<code>store verify</code>, <code>help</code> and <code>clear</code> ({{ref:store-commands}}).</p>" +
		hgTable(rows, []string{"Command", "Summary", "Usage"}, "t", "tbl-commands", "Commands of the engine's command pack", []string{"14%", "30%", "56%"})
}

func hgGenTokens(d *hgEngine) string {
	var rows, st, inf, al, pr [][]string
	for _, t := range d.Tokens {
		fed := codeList(t.Inputs)
		if fed == "" {
			fed = "—"
		}
		rows = append(rows, []string{"<code>" + esc(t.Token) + "</code>", esc(t.Kind), esc(t.Label), fed})
	}
	for _, kv := range d.ShotTypes {
		st = append(st, []string{"<code>/" + esc(txt(kv[0])) + "</code>", esc(pyTitle(txt(kv[1])))})
	}
	for _, kv := range d.Flags {
		st = append(st, []string{"<code>/" + esc(txt(kv[0])) + "</code>", esc(txt(kv[1]))})
	}
	for _, kv := range d.Infractions {
		inf = append(inf, []string{"<code>/" + esc(txt(kv[0])) + "</code>", esc(txt(kv[1]))})
	}
	for _, kv := range d.Aliases {
		al = append(al, []string{"<code>" + esc(txt(kv[0])) + "</code>", "<code>" + esc(txt(kv[1])) + "</code>"})
	}
	per := map[int][]string{}
	for _, kv := range d.Periods {
		n, _ := strconv.Atoi(txt(kv[1]))
		per[n] = append(per[n], txt(kv[0]))
	}
	var nums []int
	for n := range per {
		nums = append(nums, n)
	}
	sort.Ints(nums)
	for _, n := range nums {
		ks := per[n]
		sort.Slice(ks, func(i, j int) bool {
			if len(ks[i]) != len(ks[j]) {
				return len(ks[i]) < len(ks[j])
			}
			return ks[i] < ks[j]
		})
		pr = append(pr, []string{strconv.Itoa(n), codeList(ks)})
	}
	half := (len(inf) + 1) / 2
	var infRows [][]string
	for i := 0; i < half; i++ {
		r := []string{inf[i][0], inf[i][1], "", ""}
		if half+i < len(inf) {
			r[2], r[3] = inf[half+i][0], inf[half+i][1]
		}
		infRows = append(infRows, r)
	}
	var reserved []string
	for _, w := range d.Reserved {
		reserved = append(reserved, "<code>"+esc(w)+"</code>")
	}
	return "<h1>Stat tokens and modifiers</h1>" +
		"<p>The tables in this appendix are generated from the lexer tables of <code>rink/shared/hcl.js</code> and the input table of " +
		"<code>rink/hk001/inputs.js</code>. The last column of the first table lists the HK001 input codes that count the token.</p>" +
		hgTable(rows, []string{"Token", "Kind", "Meaning", "HK001 inputs fed"}, "t", "tbl-tokens", "Stat tokens", []string{"9%", "11%", "40%", "40%"}) +
		"<h2>Shot types and flags</h2>" +
		hgTable(st, []string{"Modifier", "Meaning"}, "t", "tbl-shot-mods", "Shot-type and flag modifiers", []string{"20%", "80%"}) +
		"<h2>Penalty infractions</h2>" +
		hgTable(infRows, []string{"Code", "Infraction", "Code", "Infraction"}, "t", "tbl-infractions", "Infraction codes taken by penalty tokens", []string{"12%", "38%", "12%", "38%"}) +
		"<h2>Period names</h2>" +
		hgTable(pr, []string{"Period", "Accepted names"}, "t", "tbl-periods", fmt.Sprintf("Period names (at most %s periods)", txt(d.MaxPeriod)), []string{"12%", "88%"}) +
		"<h2>French aliases (fr-CA)</h2><p>With <code>LOCALE fr-CA</code>, these aliases compile to the canonical token before a frame is made.</p>" +
		hgTable(al, []string{"Alias", "Canonical token"}, "t", "tbl-aliases", "fr-CA aliases", []string{"30%", "70%"}) +
		"<h2>Reserved words</h2><p>These four-letter words of the language can never be team codes: " + strings.Join(reserved, ", ") + ".</p>"
}

var hgFlagText = map[string]string{"game": "<code>--game=G#</code>", "season": "<code>--season</code>", "team": "<code>--team=TEAM</code>",
	"n": "<code>--n=N</code>", "str": "<code>--str=ALL|EV|PP|ST|5v5…</code>", "min": "<code>--min=N</code>", "steps": "<code>--steps=K</code>",
	"engine": "<code>--engine=js|xpu|auto</code>", "lanes": "<code>--lanes=…</code>", "packed": "<code>--packed</code>"}

func hgGenQueries(d *hgEngine) string {
	var rows [][]string
	for _, q := range d.Queries {
		var fl []string
		for _, f := range q.Flags {
			if t, ok := hgFlagText[f]; ok {
				fl = append(fl, t)
			} else {
				fl = append(fl, "<code>--"+esc(f)+"</code>")
			}
		}
		flags := strings.Join(fl, ", ")
		if flags == "" {
			flags = "—"
		}
		rows = append(rows, []string{"<code>Q " + esc(q.Target) + "</code>", flags, strconv.Itoa(q.Nargs)})
	}
	return "<h1>Query targets and flags</h1>" +
		"<p>Generated from <code>Q_TAKES</code> in <code>rink/shared/hcl.js</code> and <code>TARGETS</code> in " +
		"<code>rink/server/query.js</code>. Each query accepts only its own flags and refuses any other, so a mistyped filter " +
		"never returns an unfiltered answer. <code>WAR</code> is <code>GAR</code> expressed in wins. The third column is the number " +
		"of positional arguments the target takes (for example <code>Q PLAYER TEAM CODE</code>).</p>" +
		hgTable(rows, []string{"Target", "Flags it accepts", "Arguments"}, "t", "tbl-query-flags", "Query targets", []string{"18%", "70%", "12%"})
}

func hgGenInputs(d *hgEngine) string {
	var rows [][]string
	for _, i := range d.Inputs {
		tok := codeList(i.Tokens)
		if tok == "" {
			tok = "—"
		}
		rows = append(rows, []string{"<code>" + esc(i.Code) + "</code>", "<code>" + esc(i.Field) + "</code>", esc(i.Label), esc(i.Unit), esc(i.Scope), esc(i.Cls), tok})
	}
	return "<h1>HK001 input codes</h1>" +
		fmt.Sprintf("<p>The %d inputs HK001 reads, each with its permanent code, the field name HK001 uses, its unit, scope and ", len(d.Inputs)) +
		"derivation class, and the stat tokens counted for it (generated from <code>rink/hk001/inputs.js</code>). Derivation classes: " +
		"TOKEN (counted tokens), STATE (the game-state actor), CLASS (location-based classes, RINKVT-DANGER-v1), INFER (declared " +
		"sequence rules), RESULT (final game states), GOALIE (per-goalie games), PLAYER (the case's featured player), OPPONENT " +
		"(the opponents' own inputs), LEAGUE (pooled over every team in scope). The full derivation rule of each input is shown by " +
		"its command, for example <code>HKI-002</code>.</p>" +
		hgTable(rows, []string{"Code", "Field", "Label", "Unit", "Scope", "Class", "Tokens"}, "t dense", "tbl-inputs", "HK001 input codes",
			[]string{"8%", "13%", "33%", "11%", "8%", "10%", "17%"})
}

var hgStage = map[string]string{"EQ": "Equation", "ML": "Master Law", "X8S": "X8S", "SP8": "8Sphere", "SUM": "Receipt"}

func stageName(s string) string {
	if n, ok := hgStage[s]; ok {
		return n
	}
	return s
}

func hgGenCodes(d *hgEngine) string {
	stats := append([][2]any(nil), d.Stats...)
	sort.Slice(stats, func(i, j int) bool { return txt(stats[i][0]) < txt(stats[j][0]) })
	var summary, rows [][]string
	for _, kv := range stats {
		k := strings.SplitN(txt(kv[0]), ":", 2)
		kind := ""
		if len(k) > 1 {
			kind = k[1]
		}
		summary = append(summary, []string{stageName(k[0]), kind, txt(kv[1])})
	}
	for _, c := range d.Catalog {
		pub := ""
		if c.Published {
			pub = "●"
		}
		rows = append(rows, []string{"<code>" + esc(c.Code) + "</code>", stageName(c.Stage), esc(c.Family), esc(c.Label), pub})
	}
	return "<h1>HK001 computation codes</h1>" +
		fmt.Sprintf("<p>Every node of the HK001 2.3.0 computation graph has a code, and every code is a command: %d in all ", len(d.Catalog)) +
		"(generated from <code>rink/hk001/catalog.js</code>). A code prints its formula, its labelled inputs with values and provenance, " +
		"its value, bounds and disposition, its dependents, and the plate of the Mathematical Corpus that states it. The dot marks the " +
		"published models; the rest are the traced intermediates the published models are computed from.</p>" +
		hgTable(summary, []string{"Stage", "Kind", "Codes"}, "t", "tbl-code-summary", "Computation codes by stage", []string{"40%", "40%", "20%"}) +
		hgTable(rows, []string{"Code", "Stage", "Family", "Label", "Pub."}, "t dense", "tbl-codes", "HK001 computation codes",
			[]string{"16%", "11%", "20%", "47%", "6%"})
}

// factText is one fact of a record as the guide shows it: text as it stands, a list as its items, anything else as JSON.
func factText(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []any:
		var parts []string
		for _, e := range x {
			parts = append(parts, factText(e))
		}
		return strings.Join(parts, ", ")
	case json.Number:
		return numberText(x)
	}
	return pyDumps(v, false, false)
}

func hgGenContracts(recs []hgRecord, ja [][2]string) string {
	var rows [][]string
	var q, suite *hgRecord
	for i, r := range recs {
		rows = append(rows, []string{"<code>" + esc(r.file) + "</code>", "<code>" + esc(r.module) + "</code>", esc(r.rules), "<code class=wrap>" + esc(r.kappa) + "</code>"})
		if strings.HasPrefix(r.file, "90_") {
			q = &recs[i]
		}
		if strings.HasPrefix(r.file, "00_") {
			suite = &recs[i]
		}
	}
	out := "<h1>Contract listings</h1>" +
		"<p>The MSSL records and JA21 sources of the release, as they stand in <code>contracts/</code> when this guide was built. The seal " +
		"κ of each record is the SHA-256 of its text from <code>α≡</code> up to the comma before <code>κ≡</code>; any change to a record " +
		"changes its seal, and <code>rinkvt-photon contracts check</code> refuses it.</p>" +
		hgTable(rows, []string{"Record", "Module (λ)", "Rules (δ)", "Seal (κ)"}, "t", "tbl-records", "MSSL records of the release", []string{"25%", "28%", "9%", "38%"})
	if q != nil {
		var qrows [][]string
		for _, kv := range q.state {
			qrows = append(qrows, []string{"<code>" + esc(kv.K) + "</code>", esc(factText(kv.V))})
		}
		out += "<h2>The qualification record</h2><p>The facts of <code>90_qualification.mssl</code> (its η.state), written by " +
			"<code>rinkvt-photon contracts qualify</code> from the test run that qualified this release.</p>" +
			hgTable(qrows, []string{"Fact", "Value"}, "t", "tbl-qualification", "Qualification of the release", []string{"18%", "82%"})
	}
	if suite != nil {
		out += "<h2>The suite identity record</h2><p>The record <code>00_suite_identity.mssl</code> in full.</p><pre class=mssl>" + esc(suite.text) + "</pre>"
	}
	for _, j := range ja {
		out += "<h2>" + esc(j[0]) + "</h2><pre class=ja>" + esc(j[1]) + "</pre>"
	}
	return out
}

func hgGenTestsTable(tests []hgTest) string {
	var rows [][]string
	last := ""
	for _, t := range tests {
		file := ""
		if t.file != last {
			file = "<code>photon/" + esc(t.file) + "</code><br><span class=dim>" + esc(t.fileDoc) + "</span>"
		}
		rows = append(rows, []string{file, esc(t.what) + "<br><code class=dim>" + esc(t.name) + "</code>"})
		last = t.file
	}
	return hgTable(rows, []string{"File", "Test"}, "t dense", "tbl-test-inventory", "The edition's tests", []string{"36%", "64%"})
}

// ---- composition ---------------------------------------------------------------------------------------------

type hgTOC struct {
	level                int
	num, title, id, kind string
}
type hgItem struct{ num, caption, id string }
type hgChapter struct{ label, title, id, kind string }

type hgDoc struct {
	toc             []hgTOC
	tables, figures []hgItem
	keys            map[string][2]string
	chapters        []hgChapter
}

var (
	hgOpenRE   = regexp.MustCompile(`<h([123])(?: key="([^"]+)")?>|<table class="([^"]*)"(?: key="([^"]+)")?(?: caption="([^"]*)")?>|<figure(?: key="([^"]+)")?(?: caption="([^"]*)")?>`)
	hgFigureRE = regexp.MustCompile(`(?s)<figure id="([^"]+)" data-caption="([^"]*)">(.*?)</figure>`)
	hgRefRE    = regexp.MustCompile(`\{\{ref:([a-z0-9-]+)\}\}`)
	hgLeftRE   = regexp.MustCompile(`\{\{[a-z_:]+\}\}`)
	hgTagRE    = regexp.MustCompile(`<[^>]+>`)
)

func group(s string, m []int, g int) string {
	if m[2*g] < 0 {
		return ""
	}
	return s[m[2*g]:m[2*g+1]]
}

// number numbers the headings, tables and figures of one chapter or appendix.
func (d *hgDoc) number(frag, label, kind string) (string, error) {
	sec := [2]int{}
	tcount, fcount := 0, 0
	var out strings.Builder
	pos := 0
	for {
		m := hgOpenRE.FindStringSubmatchIndex(frag[pos:])
		if m == nil {
			break
		}
		for i := range m {
			if m[i] >= 0 {
				m[i] += pos
			}
		}
		out.WriteString(frag[pos:m[0]])
		pos = m[1]
		switch {
		case m[2] >= 0:
			lvl := group(frag, m, 1)
			key := group(frag, m, 2)
			end := strings.Index(frag[pos:], "</h"+lvl+">")
			if end < 0 {
				return "", fmt.Errorf("an <h%s> without its end", lvl)
			}
			title := strings.TrimSpace(frag[pos : pos+end])
			pos += end + len("</h"+lvl+">")
			if lvl == "1" {
				hid := kind + "-" + label
				d.chapters = append(d.chapters, hgChapter{label, title, hid, kind})
				d.toc = append(d.toc, hgTOC{1, label, title, hid, kind})
				word := "Chapter"
				cls := "chapter"
				if kind != "ch" {
					word, cls = "Appendix", "chapter appendix"
				}
				out.WriteString(`<h1 class="` + cls + `" id="` + hid + `"><span class="cnum">` + word + " " + label + `</span><span class="ctitle">` + title + `</span></h1>`)
				if key != "" {
					d.keys[key] = [2]string{word + " " + label, hid}
				}
				continue
			}
			var num string
			if lvl == "2" {
				sec = [2]int{sec[0] + 1, 0}
				num = fmt.Sprintf("%s.%d", label, sec[0])
			} else {
				sec[1]++
				num = fmt.Sprintf("%s.%d.%d", label, sec[0], sec[1])
			}
			hid := "sec-" + strings.ReplaceAll(num, ".", "-")
			if lvl == "2" {
				d.toc = append(d.toc, hgTOC{2, num, title, hid, kind})
			}
			if key != "" {
				d.keys[key] = [2]string{"§" + num, hid}
			}
			out.WriteString("<h" + lvl + ` id="` + hid + `"><span class="snum">` + num + "</span>" + title + "</h" + lvl + ">")
		case m[6] >= 0:
			cls, key, cpt := group(frag, m, 3), group(frag, m, 4), group(frag, m, 5)
			if cpt != "" {
				tcount++
				num := fmt.Sprintf("%s-%d", label, tcount)
				tid := "tbl-" + num
				d.tables = append(d.tables, hgItem{num, html.UnescapeString(cpt), tid})
				if key != "" {
					d.keys[key] = [2]string{"Table " + num, tid}
				}
				out.WriteString(`<table class="` + cls + `" id="` + tid + `"><caption><span class="tlabel">Table ` + num + "</span>" + cpt + "</caption>")
			} else {
				out.WriteString(`<table class="` + cls + `">`)
			}
		default:
			key, cpt := group(frag, m, 6), group(frag, m, 7)
			fcount++
			num := fmt.Sprintf("%s-%d", label, fcount)
			fid := "fig-" + num
			d.figures = append(d.figures, hgItem{num, html.UnescapeString(cpt), fid})
			if key != "" {
				d.keys[key] = [2]string{"Figure " + num, fid}
			}
			out.WriteString(`<figure id="` + fid + `" data-caption="Figure ` + num + ". " + cpt + `">`)
		}
	}
	out.WriteString(frag[pos:])
	text := hgFigureRE.ReplaceAllStringFunc(out.String(), func(s string) string {
		sm := hgFigureRE.FindStringSubmatch(s)
		cpt := strings.Replace(strings.Replace(sm[2], "Figure ", "<span class=tlabel>Figure ", 1), ". ", "</span>", 1)
		return `<figure id="` + sm[1] + `">` + sm[3] + "<figcaption>" + cpt + "</figcaption></figure>"
	})
	return text, nil
}

func hgPageOf(pages map[string]string, id string) string {
	if p, ok := pages[id]; ok {
		return p
	}
	return "000"
}

func (d *hgDoc) tocHTML(pages map[string]string) string {
	var b strings.Builder
	b.WriteString(`<ol class="toc">`)
	for _, fm := range [][2]string{{"control", "Document control"}, {"notices", "Notices"}, {"conventions", "Conventions"}, {"lists", "Figures and tables"}} {
		b.WriteString(`<li class="tfm"><a href="#` + fm[0] + `"><span class="tt">` + fm[1] + `</span><span class="tp">` + hgPageOf(pages, fm[0]) + `</span></a></li>`)
	}
	for _, t := range d.toc {
		pg := hgPageOf(pages, t.id)
		switch t.level {
		case 0:
			b.WriteString(`<li class="tpart"><a href="#` + t.id + `"><span class="tt">Part ` + t.num + " · " + t.title + `</span><span class="tp">` + pg + `</span></a></li>`)
		case 1:
			lab := t.num
			if t.kind != "ch" {
				lab = "Appendix " + t.num
			}
			b.WriteString(`<li class="tch"><a href="#` + t.id + `"><span class="tn">` + lab + `</span><span class="tt">` + t.title + `</span><span class="tp">` + pg + `</span></a></li>`)
		default:
			b.WriteString(`<li class="tsec"><a href="#` + t.id + `"><span class="tn">` + t.num + `</span><span class="tt">` + t.title + `</span><span class="tp">` + pg + `</span></a></li>`)
		}
	}
	b.WriteString("</ol>")
	return b.String()
}

func (d *hgDoc) lotHTML(pages map[string]string) string {
	item := func(it hgItem) string {
		return `<li><a href="#` + it.id + `"><span class="tn">` + it.num + `</span><span class="tt">` + esc(it.caption) + `</span><span class="tp">` + hgPageOf(pages, it.id) + `</span></a></li>`
	}
	var t, f strings.Builder
	for _, it := range d.tables {
		t.WriteString(item(it))
	}
	for _, it := range d.figures {
		f.WriteString(item(it))
	}
	return `<h2 class="fm" id="lof">Figures</h2><ol class="lot">` + f.String() + `</ol><h2 class="fm" id="lot">Tables</h2><ol class="lot">` + t.String() + `</ol>`
}

type hgGen struct {
	frags      map[string]string
	testsTable string
	vars       [][2]string
}

func hgRead(root string, parts ...string) (string, error) {
	b, err := os.ReadFile(filepath.Join(append([]string{root, "docs", "handguide"}, parts...)...))
	return strings.ReplaceAll(string(b), "\r\n", "\n"), err
}

func hgCompose(root string, gen *hgGen, pages map[string]string) (string, *hgDoc, error) {
	d := &hgDoc{keys: map[string][2]string{}}
	var body strings.Builder
	n := 0
	for _, p := range hgParts {
		pid := "part-" + p.num
		d.toc = append(d.toc, hgTOC{0, p.num, p.title, pid, "part"})
		body.WriteString(`<section class="partpage" id="` + pid + `"><div class="pnum">Part ` + p.num + `</div><div class="ptitle">` + p.title + `</div><div class="pintro">` + hgPartIntro[p.num] + `</div></section>`)
		for _, ch := range p.chapters {
			n++
			frag, err := hgRead(root, "chapters", ch+".html")
			if err != nil {
				return "", nil, err
			}
			frag = strings.ReplaceAll(frag, "{{tests_table}}", gen.testsTable)
			text, err := d.number(frag, strconv.Itoa(n), "ch")
			if err != nil {
				return "", nil, fmt.Errorf("%s: %v", ch, err)
			}
			body.WriteString(`<section class="chap">` + text + `</section>`)
		}
	}
	for _, a := range hgAppendices {
		frag, ok := gen.frags[a[1]]
		if !ok {
			var err error
			if frag, err = hgRead(root, "chapters", a[1]+".html"); err != nil {
				return "", nil, err
			}
		}
		text, err := d.number(frag, a[0], "ap")
		if err != nil {
			return "", nil, fmt.Errorf("appendix %s: %v", a[0], err)
		}
		body.WriteString(`<section class="chap app">` + text + `</section>`)
	}
	var front strings.Builder
	for _, f := range hgFront {
		frag, err := hgRead(root, "chapters", f+".html")
		if err != nil {
			return "", nil, err
		}
		front.WriteString(frag)
	}
	var refErr error
	ref := func(s string) string {
		k := hgRefRE.FindStringSubmatch(s)[1]
		v, ok := d.keys[k]
		if !ok {
			if refErr == nil {
				refErr = fmt.Errorf("unknown reference {{ref:%s}}", k)
			}
			return s
		}
		return `<a class="xref" href="#` + v[1] + `">` + v[0] + `</a>`
	}
	text := hgRefRE.ReplaceAllStringFunc(body.String(), ref)
	fm := hgRefRE.ReplaceAllStringFunc(front.String(), ref)
	if refErr != nil {
		return "", nil, refErr
	}
	cover, err := hgRead(root, "chapters", "cover.html")
	if err != nil {
		return "", nil, err
	}
	for _, kv := range gen.vars {
		text = strings.ReplaceAll(text, "{{"+kv[0]+"}}", kv[1])
		fm = strings.ReplaceAll(fm, "{{"+kv[0]+"}}", kv[1])
		cover = strings.ReplaceAll(cover, "{{"+kv[0]+"}}", kv[1])
	}
	if left := hgLeftRE.FindAllString(text+fm+cover, -1); len(left) > 0 {
		seen := map[string]bool{}
		var u []string
		for _, l := range left {
			if !seen[l] && len(u) < 8 {
				seen[l] = true
				u = append(u, l)
			}
		}
		sort.Strings(u)
		return "", nil, fmt.Errorf("unresolved placeholders %v", u)
	}
	css, err := hgRead(root, "handguide.css")
	if err != nil {
		return "", nil, err
	}
	page := `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>` + esc(hgTitle) + `</title><style>` + css + `</style></head><body>` +
		cover + `<section class="front">` + fm + `<section class="fmblock" id="contents"><h1 class="fmh">Contents</h1>` + d.tocHTML(pages) + `</section>` +
		`<section class="fmblock" id="lists"><h1 class="fmh">Figures and tables</h1>` + d.lotHTML(pages) + `</section></section>` +
		`<main>` + text + `</main></body></html>`
	return page, d, nil
}

// ---- printing ------------------------------------------------------------------------------------------------

func hgPrint(b *HeadlessBrowser, dir, name, page string, tagged bool) ([]byte, error) {
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(page), 0o600); err != nil {
		return nil, err
	}
	p, err := b.NewPage(0, 0)
	if err != nil {
		return nil, err
	}
	defer p.Close()
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	if !strings.HasPrefix(u.Path, "/") {
		u.Path = "/" + u.Path // a Windows path: file:///C:/...
	}
	if err := p.Navigate(u.String()); err != nil {
		return nil, err
	}
	if _, err := p.Eval("document.fonts.ready.then(() => true)"); err != nil {
		return nil, err
	}
	return p.PrintPDF(Obj{{"paperWidth", 8.5}, {"paperHeight", 11}, {"marginTop", 0}, {"marginBottom", 0}, {"marginLeft", 0}, {"marginRight", 0},
		{"printBackground", true}, {"preferCSSPageSize", true}, {"generateTaggedPDF", tagged}, {"generateDocumentOutline", false}})
}

// hgChrome is one overlay page per document page: the running header, its rule and the footer.
func hgChrome(nPages, firstBody int, doc *hgDoc, dests map[string]int, totalBody int) string {
	type start struct {
		page int
		ch   hgChapter
	}
	var starts []start
	for _, c := range doc.chapters {
		if p, ok := dests[c.id]; ok {
			starts = append(starts, start{p, c})
		}
	}
	sort.SliceStable(starts, func(i, j int) bool { return starts[i].page < starts[j].page })
	parts := map[int]bool{}
	for _, p := range hgParts {
		if pg, ok := dests["part-"+p.num]; ok {
			parts[pg] = true
		}
	}
	css := `@page { size: Letter; margin: 0 } * { margin: 0; padding: 0 } body { font-family: Carlito, 'DejaVu Sans', FreeSans, sans-serif; color: #2d3a55 }
    .pg { width: 8.5in; height: 11in; position: relative; break-after: page; overflow: hidden }
    .hd { position: absolute; top: 0.48in; left: 0.95in; right: 0.95in; display: flex; justify-content: space-between; font-size: 7.6pt; letter-spacing: .02em;
          border-bottom: 0.6pt solid #b7c0cf; padding-bottom: 3.5pt }
    .hd b { font-weight: 600; color: #1d2b4f }
    .ft { position: absolute; bottom: 0.42in; left: 0.95in; right: 0.95in; display: flex; justify-content: space-between; font-size: 7.4pt; color: #56627a;
          border-top: 0.6pt solid #b7c0cf; padding-top: 3.5pt }
    .ft .cls { letter-spacing: .14em; font-weight: 600; color: #1d2b4f } .ft .pn { font-weight: 600; color: #1d2b4f }`
	issued := hgIssued.Format("2 January 2006")
	var b strings.Builder
	for p := 0; p < nPages; p++ {
		if p == 0 {
			b.WriteString(`<div class="pg"></div>`)
			continue
		}
		var right, pn string
		if p < firstBody {
			right, pn = "Front matter", "Page "+roman(p+1)
		} else {
			pn = fmt.Sprintf("Page %d of %d", p-firstBody+1, totalBody)
			var cur *hgChapter
			for i := range starts {
				if starts[i].page <= p {
					cur = &starts[i].ch
				}
			}
			if cur != nil {
				if cur.kind == "ch" {
					right = "Chapter " + cur.label + " · " + cur.title
				} else {
					right = "Appendix " + cur.label + " · " + cur.title
				}
			}
			if parts[p] {
				right = ""
			}
		}
		hd := ""
		if right != "" {
			hd = `<div class="hd"><span><b>RINK-VT Workbench</b> · Technical Handguide</span><span>` + esc(html.UnescapeString(hgTagRE.ReplaceAllString(right, ""))) + `</span></div>`
		}
		ft := `<div class="ft"><span>` + hgDocID + ` · Revision ` + hgRevision + ` · ` + issued + `</span><span class="cls">UNRESTRICTED · PUBLIC</span><span class="pn">` + pn + `</span></div>`
		b.WriteString(`<div class="pg">` + hd + ft + `</div>`)
	}
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>` + css + `</style></head><body>` + b.String() + `</body></html>`
}

type hgOutline struct {
	title string
	dest  any
	open  bool
	kids  []*hgOutline
}

func (o *hgOutline) visible() int {
	n := 0
	for _, k := range o.kids {
		n++
		if k.open {
			n += k.visible()
		}
	}
	return n
}

func plainTitle(s string) string { return html.UnescapeString(hgTagRE.ReplaceAllString(s, "")) }

// hgFinish draws the overlay over every page but the cover, and adds the page labels, the bookmarks and the
// document information.
func hgFinish(content, overlay []byte, doc *hgDoc, dests map[string]int, firstBody int) ([]byte, int, error) {
	cf, err := readPDF(content)
	if err != nil {
		return nil, 0, err
	}
	of, err := readPDF(overlay)
	if err != nil {
		return nil, 0, err
	}
	objs := map[int]any{}
	maxNum := 0
	for num := range cf.offsets {
		v, err := cf.object(num)
		if err != nil {
			return nil, 0, err
		}
		objs[num] = v
		if num > maxNum {
			maxNum = num
		}
	}
	add := func(v any) pdfRef {
		maxNum++
		objs[maxNum] = v
		return pdfRef{maxNum, 0}
	}
	imported := map[int]pdfRef{}
	var imp func(v any) any
	imp = func(v any) any {
		switch x := v.(type) {
		case pdfRef:
			if r, ok := imported[x.num]; ok {
				return r
			}
			maxNum++
			r := pdfRef{maxNum, 0}
			imported[x.num] = r
			o, err := of.object(x.num)
			if err != nil {
				o = pdfKeyword("null")
			}
			objs[r.num] = imp(o)
			return r
		case pdfDict:
			out := make(pdfDict, len(x))
			for i, kv := range x {
				out[i] = pdfKV{kv.k, imp(kv.v)}
			}
			return out
		case pdfArray:
			out := make(pdfArray, len(x))
			for i, e := range x {
				out[i] = imp(e)
			}
			return out
		case *pdfStream:
			return &pdfStream{dict: imp(x.dict).(pdfDict), data: x.data}
		}
		return v
	}
	inherited := func(f *pdfFile, page pdfDict, key string) any {
		d := page
		for depth := 0; d != nil && depth < 32; depth++ {
			if v := d.get(key); v != nil {
				return v
			}
			d, _ = f.resolve(d.get("Parent")).(pdfDict)
		}
		return nil
	}
	pages, overPages := cf.pages(), of.pages()
	if len(overPages) < len(pages) {
		return nil, 0, fmt.Errorf("the overlay has %d pages for %d", len(overPages), len(pages))
	}
	open := add(flateStream(pdfDict{}, []byte("q\n")))
	for i := 1; i < len(pages); i++ {
		op, _ := of.resolve(overPages[i]).(pdfDict)
		var data []byte
		contents := of.resolve(op.get("Contents"))
		var list pdfArray
		if a, ok := contents.(pdfArray); ok {
			list = a
		} else if contents != nil {
			list = pdfArray{op.get("Contents")}
		}
		for _, c := range list {
			s, ok := of.resolve(c).(*pdfStream)
			if !ok {
				continue
			}
			raw, err := streamData(s)
			if err != nil {
				return nil, 0, err
			}
			data = append(append(data, raw...), '\n')
		}
		bbox := inherited(of, op, "MediaBox")
		if bbox == nil {
			bbox = pdfArray{0, 0, 612, 792}
		}
		res := imp(of.resolve(inherited(of, op, "Resources")))
		if res == nil {
			res = pdfDict{}
		}
		form := add(flateStream(pdfDict{{"Type", pdfName("XObject")}, {"Subtype", pdfName("Form")}, {"FormType", 1}, {"BBox", imp(bbox)}, {"Resources", res}}, data))
		closing := add(flateStream(pdfDict{}, []byte("\nQ\nq /Artifact BMC /RVTov Do EMC Q\n")))

		pd, _ := objs[pages[i].num].(pdfDict)
		pd = append(pdfDict(nil), pd...)
		pres, _ := cf.resolve(inherited(cf, pd, "Resources")).(pdfDict)
		pres = append(pdfDict(nil), pres...)
		xo, _ := cf.resolve(pres.get("XObject")).(pdfDict)
		xo = append(append(pdfDict(nil), xo...), pdfKV{"RVTov", form})
		pres = pres.set("XObject", xo)
		pd = pd.set("Resources", pres)
		newContents := pdfArray{open}
		switch c := pd.get("Contents").(type) {
		case pdfArray:
			newContents = append(newContents, c...)
		case pdfRef:
			if a, ok := cf.resolve(c).(pdfArray); ok {
				newContents = append(newContents, a...)
			} else {
				newContents = append(newContents, c)
			}
		}
		newContents = append(newContents, closing)
		pd = pd.set("Contents", newContents)
		objs[pages[i].num] = pd
	}

	n := len(pages)
	rootRef, _ := cf.trailer.get("Root").(pdfRef)
	root := append(pdfDict(nil), cf.root()...)
	root = root.set("PageLabels", pdfDict{{"Nums", pdfArray{0, pdfDict{{"S", pdfName("r")}, {"St", 1}}, firstBody, pdfDict{{"S", pdfName("D")}, {"St", 1}}}}})

	// bookmarks: the front matter, the parts with their chapters and sections, the appendices with theirs
	dest := func(id string) any { return pdfName(id) }
	top := &hgOutline{open: true}
	top.kids = append(top.kids, &hgOutline{title: "Cover", dest: pdfArray{pages[0], pdfName("Fit")}})
	for _, fm := range [][2]string{{"control", "Document control"}, {"notices", "Notices"}, {"conventions", "Conventions"}, {"contents", "Contents"}, {"lists", "Figures and tables"}} {
		if _, ok := dests[fm[0]]; ok {
			top.kids = append(top.kids, &hgOutline{title: fm[1], dest: dest(fm[0])})
		}
	}
	var part, chap, apps *hgOutline
	for _, t := range doc.toc {
		if _, ok := dests[t.id]; !ok {
			continue
		}
		title := plainTitle(t.title)
		switch {
		case t.level == 0:
			part = &hgOutline{title: "Part " + t.num + " · " + title, dest: dest(t.id), open: true}
			top.kids = append(top.kids, part)
		case t.level == 1 && t.kind == "ap":
			if apps == nil {
				apps = &hgOutline{title: "Appendices", dest: dest(t.id), open: true}
				top.kids = append(top.kids, apps)
			}
			chap = &hgOutline{title: "Appendix " + t.num + " · " + title, dest: dest(t.id)}
			apps.kids = append(apps.kids, chap)
		case t.level == 1:
			chap = &hgOutline{title: t.num + " " + title, dest: dest(t.id)}
			if part != nil {
				part.kids = append(part.kids, chap)
			} else {
				top.kids = append(top.kids, chap)
			}
		default:
			if chap != nil {
				chap.kids = append(chap.kids, &hgOutline{title: t.num + " " + title, dest: dest(t.id)})
			}
		}
	}
	outlineRef := add(nil)
	var write func(o *hgOutline, parent pdfRef) (first, last pdfRef)
	write = func(o *hgOutline, parent pdfRef) (pdfRef, pdfRef) {
		refs := make([]pdfRef, len(o.kids))
		for i := range o.kids {
			refs[i] = add(nil)
		}
		for i, k := range o.kids {
			d := pdfDict{{"Title", pdfText(k.title)}, {"Parent", parent}, {"Dest", k.dest}}
			if i > 0 {
				d = append(d, pdfKV{"Prev", refs[i-1]})
			}
			if i+1 < len(refs) {
				d = append(d, pdfKV{"Next", refs[i+1]})
			}
			if len(k.kids) > 0 {
				f, l := write(k, refs[i])
				c := k.visible()
				if !k.open {
					c = -c
				}
				d = append(d, pdfKV{"First", f}, pdfKV{"Last", l}, pdfKV{"Count", c})
			}
			objs[refs[i].num] = d
		}
		return refs[0], refs[len(refs)-1]
	}
	first, last := write(top, outlineRef)
	objs[outlineRef.num] = pdfDict{{"Type", pdfName("Outlines")}, {"First", first}, {"Last", last}, {"Count", top.visible()}}
	root = root.set("Outlines", outlineRef).set("PageMode", pdfName("UseOutlines")).set("ViewerPreferences", pdfDict{{"DisplayDocTitle", pdfKeyword("true")}})
	objs[rootRef.num] = root

	when := pdfString("D:" + hgIssued.Format("20060102150405") + "Z")
	info := pdfDict{
		{"Title", pdfText(hgTitle)},
		{"Author", pdfText(hgAuthor)},
		{"Subject", pdfText(fmt.Sprintf("Operating, technical and assurance manual for RINK-VT %s (LK/Vexa edition, Photon-hosted) and %s (reference edition)", VERSION, hgReference))},
		{"Keywords", pdfText("RINK-VT, LK/Vexa, Photon, MSSL, JA21, hockey statistics, HERMIT, loopback leases, ledger, HK001")},
		{"Creator", pdfText("rinkvt-photon handguide (Chromium)")},
		{"Producer", pdfText("rinkvt-photon " + VERSION)},
		{"CreationDate", when},
		{"ModDate", when},
	}
	infoRef, ok := cf.trailer.get("Info").(pdfRef)
	if ok {
		objs[infoRef.num] = info
	} else {
		infoRef = add(info)
	}
	return writePDF(objs, rootRef, infoRef), n, nil
}

// ---- the command ---------------------------------------------------------------------------------------------

func hgGather(b *HeadlessBrowser, root string) (*hgGen, error) {
	eng, err := hgExtractEngine(b, root)
	if err != nil {
		return nil, err
	}
	tests, err := hgTestInventory(root)
	if err != nil {
		return nil, err
	}
	recs, ja, err := hgContractFiles(root)
	if err != nil {
		return nil, err
	}
	files := map[string]bool{}
	for _, t := range tests {
		files[t.file] = true
	}
	var q Obj
	for _, r := range recs {
		if strings.HasPrefix(r.file, "90_") {
			q = r.state
		}
	}
	fact := func(k, def string) string {
		if v, ok := q.Get(k); ok {
			return esc(factText(v))
		}
		return esc(def)
	}
	gen := &hgGen{
		frags: map[string]string{
			"gen:commands": hgGenCommands(eng), "gen:tokens": hgGenTokens(eng), "gen:queries": hgGenQueries(eng),
			"gen:inputs": hgGenInputs(eng), "gen:codes": hgGenCodes(eng), "gen:contracts": hgGenContracts(recs, ja),
		},
		testsTable: hgGenTestsTable(tests),
		vars: [][2]string{
			{"version", VERSION}, {"engine", ENGINE}, {"reference", hgReference}, {"doc_id", hgDocID}, {"revision", hgRevision},
			{"issued", hgIssued.Format("2 January 2006")}, {"n_codes", strconv.Itoa(len(eng.Catalog))}, {"n_inputs", strconv.Itoa(len(eng.Inputs))},
			{"n_tokens", strconv.Itoa(len(eng.Tokens))}, {"n_tests", strconv.Itoa(len(tests))}, {"n_test_modules", strconv.Itoa(len(files))},
			{"n_records", strconv.Itoa(len(recs))}, {"n_ja", strconv.Itoa(len(ja))}, {"n_commands", strconv.Itoa(len(eng.Commands))},
			{"n_code_commands", strconv.Itoa(eng.CodeCommands)},
			{"q_result", fact("result", "not yet qualified")}, {"q_checks", fact("checks", "—")}, {"q_passed", fact("passed", "—")},
			{"q_skipped", fact("skipped", "—")}, {"q_platform", fact("platform", "—")}, {"q_scope", fact("scope_limit", "—")},
			{"q_run_at", fact("run_at", "—")}, {"chromium", esc(browserName(b.Version))},
			{"go_version", "Go " + strings.TrimPrefix(runtime.Version(), "go")},
		},
	}
	return gen, nil
}

type hgResult struct {
	pages, frontMatter, body, tables, figures, passes int
}

// buildHandguide prints the guide with the browser b, to out (and the composed page to htmlOut, when given).
func buildHandguide(b *HeadlessBrowser, root, out, htmlOut string) (hgResult, error) {
	var r hgResult
	work, err := os.MkdirTemp("", "rinkvt-handguide-")
	if err != nil {
		return r, err
	}
	defer os.RemoveAll(work)
	gen, err := hgGather(b, root)
	if err != nil {
		return r, err
	}
	var pages map[string]string
	var page string
	var doc *hgDoc
	var pdf []byte
	var dests map[string]int
	nPages, firstBody := 0, 0
	settled := false
	for r.passes < 4 && !settled {
		r.passes++
		if page, doc, err = hgCompose(root, gen, pages); err != nil {
			return r, err
		}
		if pdf, err = hgPrint(b, work, "handguide.html", page, true); err != nil {
			return r, err
		}
		f, err := readPDF(pdf)
		if err != nil {
			return r, err
		}
		dests, nPages = f.destinations(), len(f.pages())
		fb, ok := dests["part-I"]
		if !ok {
			return r, fmt.Errorf("the printed guide has no destination for Part I")
		}
		firstBody = fb
		labels := map[string]string{}
		for id, pg := range dests {
			if pg >= firstBody {
				labels[id] = strconv.Itoa(pg - firstBody + 1)
			} else {
				labels[id] = roman(pg + 1)
			}
		}
		settled = pages != nil && len(labels) == len(pages)
		if settled {
			for k, v := range labels {
				if pages[k] != v {
					settled = false
					break
				}
			}
		}
		pages = labels
	}
	if !settled {
		return r, fmt.Errorf("the page numbers did not settle")
	}
	if htmlOut != "" {
		if err := os.WriteFile(htmlOut, []byte(page), 0o644); err != nil {
			return r, err
		}
	}
	totalBody := nPages - firstBody
	overlay, err := hgPrint(b, work, "chrome.html", hgChrome(nPages, firstBody, doc, dests, totalBody), false)
	if err != nil {
		return r, err
	}
	final, count, err := hgFinish(pdf, overlay, doc, dests, firstBody)
	if err != nil {
		return r, err
	}
	if err := writeDurable(out, final); err != nil {
		return r, err
	}
	r.pages, r.frontMatter, r.body, r.tables, r.figures = count, firstBody, totalBody, len(doc.tables), len(doc.figures)
	return r, nil
}

func cmdHandguide(args []string) int {
	root := releaseRoot()
	fs := flag.NewFlagSet("handguide", flag.ContinueOnError)
	out := fs.String("out", filepath.Join(root, "docs", "handguide", "RINK-VT_Handguide.pdf"), "the PDF to write")
	htmlOut := fs.String("html", "", "also write the composed HTML (for review)")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	fail := func(err error) int {
		fmt.Fprintln(os.Stderr, "handguide:", err)
		return exitFail
	}
	exe := os.Getenv("RINKVT_BROWSER")
	if exe == "" {
		exe = findTestBrowser()
	}
	if exe == "" {
		return fail(fmt.Errorf("no Edge, Chrome or Chromium was found; set RINKVT_BROWSER to one"))
	}
	b, err := startHeadless(exe)
	if err != nil {
		return fail(err)
	}
	defer b.Close()
	r, err := buildHandguide(b, root, *out, *htmlOut)
	if err != nil {
		return fail(err)
	}
	rel, err := filepath.Rel(root, *out)
	if err != nil {
		rel = *out
	}
	fmt.Printf("%s: %d pages (%d front matter, %d body) · %d tables · %d figures · %d passes · %s\n", filepath.ToSlash(rel), r.pages, r.frontMatter, r.body,
		r.tables, r.figures, r.passes, browserName(b.Version))
	return exitOK
}

// browserName is the browser's own product string as a name: "Chrome/153.0.1" is "Chrome 153.0.1".
func browserName(product string) string {
	product = strings.Replace(product, "HeadlessChrome/", "Chrome/", 1)
	product = strings.Replace(product, "Edg/", "Microsoft Edge/", 1)
	return strings.Replace(product, "/", " ", 1)
}
