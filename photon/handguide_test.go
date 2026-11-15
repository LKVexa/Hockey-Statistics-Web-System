// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// The handguide command: its PDF reader and writer, the numbering and cross-references of the chapters, and the
// guide printed whole by a Chromium-family browser.

import (
	"bytes"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestHandguidePDFLexerReadsEveryForm(t *testing.T) {
	l := &pdfLexer{b: []byte(`<< /K (a\)b\\c\101 (nested)) /H <48 49> /N [1 2 0 R /x#20y -3.5 true null] /D << /E 7 >> >>`)}
	v, err := l.value()
	fatalIf(t, err != nil, "%v", err)
	d, _ := v.(pdfDict)
	fatalIf(t, string(d.get("K").(pdfString)) != `a)b\cA (nested)`, "a literal string: %q", d.get("K"))
	fatalIf(t, string(d.get("H").(pdfString)) != "HI", "a hex string: %q", d.get("H"))
	a, _ := d.get("N").(pdfArray)
	fatalIf(t, len(a) != 6 || a[0] != pdfNum("1") || a[1] != (pdfRef{2, 0}) || a[2] != pdfName("x y") || a[3] != pdfNum("-3.5") ||
		a[4] != pdfKeyword("true") || a[5] != pdfKeyword("null"), "an array: %#v", a)
	inner, _ := d.get("D").(pdfDict)
	fatalIf(t, inner.get("E") != pdfNum("7"), "a nested dictionary: %#v", inner)
}

func TestHandguidePDFWrittenAndReadBack(t *testing.T) {
	objs := map[int]any{
		1: pdfDict{{"Type", pdfName("Catalog")}, {"Pages", pdfRef{2, 0}}, {"Dests", pdfRef{5, 0}}},
		2: pdfDict{{"Type", pdfName("Pages")}, {"Kids", pdfArray{pdfRef{3, 0}, pdfRef{4, 0}}}, {"Count", 2}},
		3: pdfDict{{"Type", pdfName("Page")}, {"Parent", pdfRef{2, 0}}, {"MediaBox", pdfArray{0, 0, 612, 792}}, {"Contents", pdfRef{6, 0}}},
		4: pdfDict{{"Type", pdfName("Page")}, {"Parent", pdfRef{2, 0}}, {"MediaBox", pdfArray{0, 0, 612, 792}}, {"Contents", pdfRef{7, 0}}},
		5: pdfDict{{"part-I", pdfArray{pdfRef{4, 0}, pdfName("XYZ"), 0, 792, 0}}},
		6: flateStream(pdfDict{}, []byte("BT ET")),
		7: &pdfStream{dict: pdfDict{}, data: []byte("q Q")},
		8: pdfDict{{"Title", pdfText("Zoë · RINK-VT")}, {"Subject", pdfText("plain")}},
	}
	raw := writePDF(objs, pdfRef{1, 0}, pdfRef{8, 0})
	fatalIf(t, !bytes.HasPrefix(raw, []byte("%PDF-1.4\n")) || !bytes.HasSuffix(raw, []byte("%%EOF\n")), "the file's frame")
	f, err := readPDF(raw)
	fatalIf(t, err != nil, "%v", err)
	pages := f.pages()
	fatalIf(t, len(pages) != 2 || pages[0].num != 3 || pages[1].num != 4, "pages: %v", pages)
	fatalIf(t, f.destinations()["part-I"] != 1, "destinations: %v", f.destinations())
	s6, _ := f.resolve(pdfRef{6, 0}).(*pdfStream)
	data, err := streamData(s6)
	fatalIf(t, err != nil || string(data) != "BT ET", "a Flate stream: %q %v", data, err)
	s7, _ := f.resolve(pdfRef{7, 0}).(*pdfStream)
	fatalIf(t, string(s7.data) != "q Q", "a plain stream: %q", s7.data)
	info, _ := f.resolve(f.trailer.get("Info")).(pdfDict)
	title, _ := info.get("Title").(pdfString)
	fatalIf(t, !bytes.HasPrefix(title, []byte{0xfe, 0xff}) || !bytes.Equal(title, pdfText("Zoë · RINK-VT")), "a text string: % x", title)
	fatalIf(t, string(info.get("Subject").(pdfString)) != "plain", "an ASCII text string")
}

func TestHandguideNumbersHeadingsTablesFiguresAndKeys(t *testing.T) {
	d := &hgDoc{keys: map[string][2]string{}}
	frag := `<h1 key="x">The title</h1><p>text</p><h2 key="s">A section</h2>` +
		`<table class="t" key="tb" caption="Cap &amp; more"><tr><td>1</td></tr></table><table class="t"><tr><td>2</td></tr></table>` +
		`<h3>A subsection</h3><figure key="f" caption="A figure"><svg></svg></figure><h2>Another</h2>`
	out, err := d.number(frag, "3", "ch")
	fatalIf(t, err != nil, "%v", err)
	for _, want := range []string{`<h1 class="chapter" id="ch-3"><span class="cnum">Chapter 3</span><span class="ctitle">The title</span></h1>`,
		`<h2 id="sec-3-1"><span class="snum">3.1</span>A section</h2>`, `<table class="t" id="tbl-3-1"><caption><span class="tlabel">Table 3-1</span>Cap &amp; more</caption>`,
		`<table class="t"><tr><td>2</td></tr></table>`, `<h3 id="sec-3-1-1"><span class="snum">3.1.1</span>A subsection</h3>`,
		`<figure id="fig-3-1"><svg></svg><figcaption><span class=tlabel>Figure 3-1</span>A figure</figcaption></figure>`,
		`<h2 id="sec-3-2"><span class="snum">3.2</span>Another</h2>`} {
		fatalIf(t, !strings.Contains(out, want), "missing %s in %s", want, out)
	}
	fatalIf(t, d.keys["x"] != [2]string{"Chapter 3", "ch-3"} || d.keys["s"] != [2]string{"§3.1", "sec-3-1"} ||
		d.keys["tb"] != [2]string{"Table 3-1", "tbl-3-1"} || d.keys["f"] != [2]string{"Figure 3-1", "fig-3-1"}, "keys: %v", d.keys)
	fatalIf(t, len(d.tables) != 1 || d.tables[0].caption != "Cap & more" || len(d.figures) != 1 || len(d.toc) != 3, "lists: %v %v %v", d.tables, d.figures, d.toc)
	_, err = (&hgDoc{keys: map[string][2]string{}}).number(`<h2>no end`, "1", "ch")
	fatalIf(t, err == nil, "a heading without its end was accepted")
}

func TestHandguideTestNamesReadAsWords(t *testing.T) {
	for name, want := range map[string]string{
		"TestStoreStaleBaseRefused":                        "Stale base refused",
		"TestLoopbackIPv6PrefixKeys":                       "IPv6 prefix keys",
		"TestContractsJAStructure":                         "JA structure",
		"TestLoopbackNewTablesAreFormat2AndHoldDeviceKeys": "New tables are format 2 and hold device keys",
		"TestServerDeepNestingIsABadRequest":               "Deep nesting is a bad request",
		"TestReleaseNoPythonAndNoNodeAnywhere":             "No Python and no Node anywhere",
	} {
		fatalIf(t, hgSplitName(name) != want, "%s read as %q, not %q", name, hgSplitName(name), want)
	}
	for n, want := range map[int]string{1: "i", 4: "iv", 9: "ix", 12: "xii", 40: "xl", 1994: "mcmxciv"} {
		fatalIf(t, roman(n) != want, "roman(%d) = %q", n, roman(n))
	}
	fatalIf(t, pyTitle("wrist shot") != "Wrist Shot" || pyTitle("SLAP") != "Slap", "title case")
}

func TestHandguideInventoryFindsEveryTest(t *testing.T) {
	tests, err := hgTestInventory(repoRoot(t))
	fatalIf(t, err != nil || len(tests) < 70, "inventory: %d %v", len(tests), err)
	seen := map[string]bool{}
	for _, x := range tests {
		fatalIf(t, x.what == "" || x.fileDoc == "" || seen[x.name], "an inventory entry: %+v", x)
		seen[x.name] = true
	}
	fatalIf(t, !seen["TestHandguideInventoryFindsEveryTest"] || seen["TestMain"], "the inventory's own test, or TestMain")
}

func TestBrowserHandguidePrints(t *testing.T) {
	b := browserFor(t)
	dir := t.TempDir()
	out, page := filepath.Join(dir, "guide.pdf"), filepath.Join(dir, "guide.html")
	r, err := buildHandguide(b, repoRoot(t), out, page)
	fatalIf(t, err != nil, "handguide: %v", err)
	f, err := readPDF(mustRead(t, out))
	fatalIf(t, err != nil, "the guide does not read back: %v", err)
	pages := f.pages()
	fatalIf(t, len(pages) != r.pages || r.pages < 100 || r.frontMatter < 5 || r.passes > 4, "the guide: %+v, %d pages read", r, len(pages))
	dests := f.destinations()
	for _, id := range []string{"part-I", "part-V", "ch-1", "ch-17", "ap-A", "ap-H", "control"} {
		_, ok := dests[id]
		fatalIf(t, !ok, "no destination %s", id)
	}
	fatalIf(t, dests["part-I"] != r.frontMatter, "Part I is not where the body begins")
	root := f.root()
	labels, _ := f.resolve(root.get("PageLabels")).(pdfDict)
	nums, _ := f.resolve(labels.get("Nums")).(pdfArray)
	fatalIf(t, len(nums) != 4 || nums[2] != pdfNum(strconv.Itoa(r.frontMatter)), "page labels: %#v", nums)
	outline, _ := f.resolve(root.get("Outlines")).(pdfDict)
	first, _ := f.resolve(outline.get("First")).(pdfDict)
	fatalIf(t, string(first.get("Title").(pdfString)) != "Cover" || root.get("PageMode") != pdfName("UseOutlines"), "the bookmarks")
	info, _ := f.resolve(f.trailer.get("Info")).(pdfDict)
	fatalIf(t, !bytes.Equal(info.get("Title").(pdfString), pdfText(hgTitle)), "the document information")
	for i, p := range pages {
		pd, _ := f.resolve(p).(pdfDict)
		res, _ := f.resolve(pd.get("Resources")).(pdfDict)
		xo, _ := f.resolve(res.get("XObject")).(pdfDict)
		fatalIf(t, (xo.get("RVTov") != nil) != (i > 0), "page %d: the running header and footer", i+1)
	}
	html := string(mustRead(t, page))
	fatalIf(t, strings.Contains(html, "{{") || strings.Contains(html, "000</span>"), "the composed guide has an unresolved placeholder or page number")
	fatalIf(t, !strings.Contains(html, "TestBrowserHandguidePrints"), "the test inventory does not list this test")
}
