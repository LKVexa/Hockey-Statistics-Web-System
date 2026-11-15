// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// A small PDF reader and writer, standard library only, for what the handguide build does to Chromium's output:
// find the page each named destination lands on, draw the running header and footer over every page (as a Form
// XObject marked as an artifact, so the tagged structure stays as Chromium wrote it), and add page labels,
// bookmarks and the document information. It reads classic cross-reference tables, which is what Chromium writes.

import (
	"bytes"
	"compress/zlib"
	"fmt"
	"io"
	"sort"
	"strconv"
	"unicode/utf16"
)

type pdfName string
type pdfRef struct{ num, gen int }
type pdfString []byte
type pdfNum string
type pdfKeyword string // true, false, null

type pdfKV struct {
	k string
	v any
}
type pdfDict []pdfKV
type pdfArray []any
type pdfStream struct {
	dict pdfDict
	data []byte
}

func (d pdfDict) get(k string) any {
	for _, kv := range d {
		if kv.k == k {
			return kv.v
		}
	}
	return nil
}

func (d pdfDict) set(k string, v any) pdfDict {
	for i := range d {
		if d[i].k == k {
			d[i].v = v
			return d
		}
	}
	return append(d, pdfKV{k, v})
}

// ---- reading ------------------------------------------------------------------------------------------------

type pdfFile struct {
	b       []byte
	offsets map[int]int
	trailer pdfDict
	cache   map[int]any
}

type pdfLexer struct {
	b []byte
	i int
}

func isPDFSpace(c byte) bool {
	return c == 0 || c == '\t' || c == '\n' || c == '\f' || c == '\r' || c == ' '
}

func isPDFDelim(c byte) bool {
	return c == '(' || c == ')' || c == '<' || c == '>' || c == '[' || c == ']' || c == '{' || c == '}' || c == '/' || c == '%'
}

func (l *pdfLexer) ws() {
	for l.i < len(l.b) {
		c := l.b[l.i]
		if isPDFSpace(c) {
			l.i++
		} else if c == '%' {
			for l.i < len(l.b) && l.b[l.i] != '\n' && l.b[l.i] != '\r' {
				l.i++
			}
		} else {
			return
		}
	}
}

func (l *pdfLexer) token() string {
	l.ws()
	s := l.i
	for l.i < len(l.b) && !isPDFSpace(l.b[l.i]) && !isPDFDelim(l.b[l.i]) {
		l.i++
	}
	return string(l.b[s:l.i])
}

func (l *pdfLexer) value() (any, error) {
	l.ws()
	if l.i >= len(l.b) {
		return nil, fmt.Errorf("pdf: unexpected end")
	}
	switch c := l.b[l.i]; {
	case c == '/':
		l.i++
		s := l.i
		for l.i < len(l.b) && !isPDFSpace(l.b[l.i]) && !isPDFDelim(l.b[l.i]) {
			l.i++
		}
		raw := l.b[s:l.i]
		var name []byte
		for j := 0; j < len(raw); j++ {
			if raw[j] == '#' && j+2 < len(raw) {
				if n, err := strconv.ParseUint(string(raw[j+1:j+3]), 16, 8); err == nil {
					name = append(name, byte(n))
					j += 2
					continue
				}
			}
			name = append(name, raw[j])
		}
		return pdfName(name), nil
	case c == '(':
		return l.literal()
	case c == '<' && l.i+1 < len(l.b) && l.b[l.i+1] == '<':
		l.i += 2
		d := pdfDict{}
		for {
			l.ws()
			if l.i+1 < len(l.b) && l.b[l.i] == '>' && l.b[l.i+1] == '>' {
				l.i += 2
				return d, nil
			}
			k, err := l.value()
			if err != nil {
				return nil, err
			}
			kn, ok := k.(pdfName)
			if !ok {
				return nil, fmt.Errorf("pdf: a dictionary key that is not a name")
			}
			v, err := l.value()
			if err != nil {
				return nil, err
			}
			d = append(d, pdfKV{string(kn), v})
		}
	case c == '<':
		l.i++
		var hexd []byte
		for l.i < len(l.b) && l.b[l.i] != '>' {
			if !isPDFSpace(l.b[l.i]) {
				hexd = append(hexd, l.b[l.i])
			}
			l.i++
		}
		l.i++
		if len(hexd)%2 == 1 {
			hexd = append(hexd, '0')
		}
		out := make([]byte, len(hexd)/2)
		for j := range out {
			n, err := strconv.ParseUint(string(hexd[2*j:2*j+2]), 16, 8)
			if err != nil {
				return nil, fmt.Errorf("pdf: a hex string that is not hexadecimal")
			}
			out[j] = byte(n)
		}
		return pdfString(out), nil
	case c == '[':
		l.i++
		a := pdfArray{}
		for {
			l.ws()
			if l.i < len(l.b) && l.b[l.i] == ']' {
				l.i++
				return a, nil
			}
			v, err := l.value()
			if err != nil {
				return nil, err
			}
			a = append(a, v)
		}
	}
	tok := l.token()
	switch tok {
	case "true", "false", "null":
		return pdfKeyword(tok), nil
	case "":
		return nil, fmt.Errorf("pdf: unexpected byte %q at %d", l.b[l.i], l.i)
	}
	if _, err := strconv.ParseFloat(tok, 64); err != nil {
		return nil, fmt.Errorf("pdf: unexpected token %q", tok)
	}
	if n, err := strconv.Atoi(tok); err == nil && n >= 0 { // perhaps "n g R"
		save := l.i
		g := l.token()
		if gn, err := strconv.Atoi(g); err == nil && gn >= 0 {
			if l.token() == "R" {
				return pdfRef{n, gn}, nil
			}
		}
		l.i = save
	}
	return pdfNum(tok), nil
}

func (l *pdfLexer) literal() (pdfString, error) {
	l.i++
	var out []byte
	depth := 1
	for l.i < len(l.b) {
		c := l.b[l.i]
		l.i++
		switch c {
		case '(':
			depth++
			out = append(out, c)
		case ')':
			depth--
			if depth == 0 {
				return pdfString(out), nil
			}
			out = append(out, c)
		case '\\':
			if l.i >= len(l.b) {
				break
			}
			e := l.b[l.i]
			l.i++
			switch e {
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case '\r':
				if l.i < len(l.b) && l.b[l.i] == '\n' {
					l.i++
				}
			case '\n':
			default:
				if e >= '0' && e <= '7' {
					n := int(e - '0')
					for k := 0; k < 2 && l.i < len(l.b) && l.b[l.i] >= '0' && l.b[l.i] <= '7'; k++ {
						n = n*8 + int(l.b[l.i]-'0')
						l.i++
					}
					out = append(out, byte(n))
				} else {
					out = append(out, e)
				}
			}
		default:
			out = append(out, c)
		}
	}
	return nil, fmt.Errorf("pdf: an unterminated string")
}

func readPDF(b []byte) (*pdfFile, error) {
	f := &pdfFile{b: b, offsets: map[int]int{}, cache: map[int]any{}}
	at := bytes.LastIndex(b, []byte("startxref"))
	if at < 0 {
		return nil, fmt.Errorf("pdf: no startxref")
	}
	l := &pdfLexer{b: b, i: at + len("startxref")}
	off, err := strconv.Atoi(l.token())
	if err != nil {
		return nil, fmt.Errorf("pdf: a bad startxref")
	}
	for seen := 0; off > 0 && seen < 32; seen++ {
		l = &pdfLexer{b: b, i: off}
		if l.token() != "xref" {
			return nil, fmt.Errorf("pdf: no classic cross-reference table at %d", off)
		}
		for {
			save := l.i
			t := l.token()
			if t == "trailer" {
				break
			}
			start, err1 := strconv.Atoi(t)
			count, err2 := strconv.Atoi(l.token())
			if err1 != nil || err2 != nil {
				l.i = save
				return nil, fmt.Errorf("pdf: a bad cross-reference subsection")
			}
			for k := 0; k < count; k++ {
				o, _ := strconv.Atoi(l.token())
				l.token() // generation
				kind := l.token()
				if _, have := f.offsets[start+k]; !have && kind == "n" {
					f.offsets[start+k] = o
				}
			}
		}
		tv, err := l.value()
		if err != nil {
			return nil, err
		}
		td, _ := tv.(pdfDict)
		if f.trailer == nil {
			f.trailer = td
		}
		prev, _ := td.get("Prev").(pdfNum)
		off, _ = strconv.Atoi(string(prev))
	}
	return f, nil
}

func (f *pdfFile) object(num int) (any, error) {
	if v, ok := f.cache[num]; ok {
		return v, nil
	}
	off, ok := f.offsets[num]
	if !ok {
		return pdfKeyword("null"), nil
	}
	l := &pdfLexer{b: f.b, i: off}
	l.token()
	l.token()
	if l.token() != "obj" {
		return nil, fmt.Errorf("pdf: object %d is not where the table says", num)
	}
	v, err := l.value()
	if err != nil {
		return nil, err
	}
	l.ws()
	if d, isDict := v.(pdfDict); isDict && bytes.HasPrefix(f.b[l.i:], []byte("stream")) {
		l.i += len("stream")
		if l.i < len(f.b) && f.b[l.i] == '\r' {
			l.i++
		}
		if l.i < len(f.b) && f.b[l.i] == '\n' {
			l.i++
		}
		n := 0
		switch lv := d.get("Length").(type) {
		case pdfNum:
			n, _ = strconv.Atoi(string(lv))
		case pdfRef:
			x, err := f.object(lv.num)
			if err != nil {
				return nil, err
			}
			nn, _ := x.(pdfNum)
			n, _ = strconv.Atoi(string(nn))
		}
		if l.i+n > len(f.b) {
			return nil, fmt.Errorf("pdf: object %d: a stream longer than the file", num)
		}
		v = &pdfStream{dict: d, data: append([]byte(nil), f.b[l.i:l.i+n]...)}
	}
	f.cache[num] = v
	return v, nil
}

func (f *pdfFile) resolve(v any) any {
	for {
		r, ok := v.(pdfRef)
		if !ok {
			return v
		}
		x, err := f.object(r.num)
		if err != nil {
			return nil
		}
		v = x
	}
}

func (f *pdfFile) root() pdfDict {
	d, _ := f.resolve(f.trailer.get("Root")).(pdfDict)
	return d
}

// pages are the page objects in document order.
func (f *pdfFile) pages() []pdfRef {
	var out []pdfRef
	var walk func(v any, depth int)
	walk = func(v any, depth int) {
		if depth > 64 {
			return
		}
		ref, isRef := v.(pdfRef)
		d, _ := f.resolve(v).(pdfDict)
		if d == nil {
			return
		}
		if n, _ := d.get("Type").(pdfName); n == "Page" && isRef {
			out = append(out, ref)
			return
		}
		kids, _ := f.resolve(d.get("Kids")).(pdfArray)
		for _, k := range kids {
			walk(k, depth+1)
		}
	}
	walk(f.root().get("Pages"), 0)
	return out
}

// destinations maps every named destination (the catalog's /Dests, or the /Names /Dests tree) to its page index.
func (f *pdfFile) destinations() map[string]int {
	index := map[int]int{}
	for i, p := range f.pages() {
		index[p.num] = i
	}
	out := map[string]int{}
	add := func(name string, d any) {
		d = f.resolve(d)
		if dd, ok := d.(pdfDict); ok {
			d = f.resolve(dd.get("D"))
		}
		if a, ok := d.(pdfArray); ok && len(a) > 0 {
			if r, ok := a[0].(pdfRef); ok {
				if i, ok := index[r.num]; ok {
					out[name] = i
				}
			}
		}
	}
	if dests, ok := f.resolve(f.root().get("Dests")).(pdfDict); ok {
		for _, kv := range dests {
			add(kv.k, kv.v)
		}
	}
	var tree func(v any, depth int)
	tree = func(v any, depth int) {
		d, _ := f.resolve(v).(pdfDict)
		if d == nil || depth > 32 {
			return
		}
		if names, ok := f.resolve(d.get("Names")).(pdfArray); ok {
			for i := 0; i+1 < len(names); i += 2 {
				if s, ok := f.resolve(names[i]).(pdfString); ok {
					add(string(s), names[i+1])
				}
			}
		}
		if kids, ok := f.resolve(d.get("Kids")).(pdfArray); ok {
			for _, k := range kids {
				tree(k, depth+1)
			}
		}
	}
	if names, ok := f.resolve(f.root().get("Names")).(pdfDict); ok {
		tree(names.get("Dests"), 0)
	}
	return out
}

// streamData is a stream's data, decoded when it is Flate-compressed (without predictors).
func streamData(s *pdfStream) ([]byte, error) {
	switch flt := s.dict.get("Filter").(type) {
	case nil:
		return s.data, nil
	case pdfName:
		if flt != "FlateDecode" {
			return nil, fmt.Errorf("pdf: a %s stream", flt)
		}
	case pdfArray:
		if len(flt) != 1 || flt[0] != pdfName("FlateDecode") {
			return nil, fmt.Errorf("pdf: a stream with several filters")
		}
	}
	r, err := zlib.NewReader(bytes.NewReader(s.data))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(r)
}

func flateStream(dict pdfDict, data []byte) *pdfStream {
	var buf bytes.Buffer
	w, _ := zlib.NewWriterLevel(&buf, zlib.BestCompression)
	w.Write(data)
	w.Close()
	return &pdfStream{dict: dict.set("Filter", pdfName("FlateDecode")), data: buf.Bytes()}
}

// pdfText is a text string: ASCII as it stands, anything else as UTF-16BE with its byte order mark.
func pdfText(s string) pdfString {
	ascii := true
	for _, r := range s {
		if r > 0x7e || r < 0x20 {
			ascii = false
			break
		}
	}
	if ascii {
		return pdfString(s)
	}
	out := []byte{0xfe, 0xff}
	for _, u := range utf16.Encode([]rune(s)) {
		out = append(out, byte(u>>8), byte(u))
	}
	return pdfString(out)
}

// ---- writing ------------------------------------------------------------------------------------------------

func writePDFValue(w *bytes.Buffer, v any) {
	switch x := v.(type) {
	case pdfName:
		w.WriteByte('/')
		for _, c := range []byte(x) {
			if c < 0x21 || c > 0x7e || isPDFDelim(c) || c == '#' {
				fmt.Fprintf(w, "#%02X", c)
			} else {
				w.WriteByte(c)
			}
		}
	case pdfRef:
		fmt.Fprintf(w, "%d %d R", x.num, x.gen)
	case pdfString:
		w.WriteByte('<')
		fmt.Fprintf(w, "%X", []byte(x))
		w.WriteByte('>')
	case pdfNum:
		w.WriteString(string(x))
	case pdfKeyword:
		w.WriteString(string(x))
	case int:
		w.WriteString(strconv.Itoa(x))
	case pdfArray:
		w.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				w.WriteByte(' ')
			}
			writePDFValue(w, e)
		}
		w.WriteByte(']')
	case pdfDict:
		w.WriteString("<<")
		for i, kv := range x {
			if i > 0 {
				w.WriteByte(' ')
			}
			writePDFValue(w, pdfName(kv.k))
			w.WriteByte(' ')
			writePDFValue(w, kv.v)
		}
		w.WriteString(">>")
	case *pdfStream:
		writePDFValue(w, x.dict.set("Length", len(x.data)))
		w.WriteString("\nstream\n")
		w.Write(x.data)
		w.WriteString("\nendstream")
	case nil:
		w.WriteString("null")
	default:
		panic(fmt.Sprintf("pdf: cannot write %T", v))
	}
}

// writePDF writes a whole document from its objects (numbered from 1), its catalog and its information.
func writePDF(objs map[int]any, root, info pdfRef) []byte {
	var w bytes.Buffer
	w.WriteString("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
	nums := make([]int, 0, len(objs))
	maxNum := 0
	for n := range objs {
		nums = append(nums, n)
		if n > maxNum {
			maxNum = n
		}
	}
	sort.Ints(nums)
	offsets := map[int]int{}
	for _, n := range nums {
		offsets[n] = w.Len()
		fmt.Fprintf(&w, "%d 0 obj\n", n)
		writePDFValue(&w, objs[n])
		w.WriteString("\nendobj\n")
	}
	xref := w.Len()
	fmt.Fprintf(&w, "xref\n0 %d\n0000000000 65535 f\r\n", maxNum+1)
	for n := 1; n <= maxNum; n++ {
		if o, ok := offsets[n]; ok {
			fmt.Fprintf(&w, "%010d 00000 n\r\n", o)
		} else {
			w.WriteString("0000000000 65535 f\r\n")
		}
	}
	w.WriteString("trailer\n")
	writePDFValue(&w, pdfDict{{"Size", maxNum + 1}, {"Root", root}, {"Info", info}})
	fmt.Fprintf(&w, "\nstartxref\n%d\n%%%%EOF\n", xref)
	return w.Bytes()
}
