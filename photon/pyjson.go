// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// One strict JSON reader for every request and every stored document — no duplicate keys, no NaN or Infinity,
// bounded depth — and a writer that spells JSON exactly as the earlier (Python) Photon host did, so that every seal
// and hash chain it wrote (event ledger, device file, contracts) verifies byte for byte: compact separators, keys
// in document order or sorted, and either ASCII-only text (\uXXXX escapes, lower-case hex) or text as it stands.

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const maxJSONDepth = 64

// KV is one member of a JSON object; Obj keeps an object's members in document order.
type KV struct {
	K string
	V any
}

type Obj []KV

func (o Obj) Get(k string) (any, bool) {
	for _, kv := range o {
		if kv.K == k {
			return kv.V, true
		}
	}
	return nil, false
}

func (o Obj) Has(k string) bool { _, ok := o.Get(k); return ok }

func (o Obj) Str(k string) string {
	v, _ := o.Get(k)
	s, _ := v.(string)
	return s
}

func (o Obj) Keys() []string {
	out := make([]string, len(o))
	for i, kv := range o {
		out[i] = kv.K
	}
	return out
}

// Set replaces a member, or appends it.
func (o Obj) Set(k string, v any) Obj {
	for i := range o {
		if o[i].K == k {
			o[i].V = v
			return o
		}
	}
	return append(o, KV{k, v})
}

// ---- reading ------------------------------------------------------------------------------------------------

type jsonReader struct {
	s string
	i int
}

func (p *jsonReader) errorf(f string, a ...any) error {
	return fmt.Errorf("%s (character %d)", fmt.Sprintf(f, a...), p.i)
}

func (p *jsonReader) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *jsonReader) value(depth int) (any, error) {
	if depth > maxJSONDepth {
		return nil, fmt.Errorf("JSON nested too deeply")
	}
	if p.i >= len(p.s) {
		return nil, p.errorf("expecting a value")
	}
	switch c := p.s[p.i]; {
	case c == '{':
		return p.object(depth)
	case c == '[':
		return p.array(depth)
	case c == '"':
		return p.str()
	case c == 't':
		return p.word("true", true)
	case c == 'f':
		return p.word("false", false)
	case c == 'n':
		return p.word("null", nil)
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	case c == 'N' || c == 'I':
		return nil, p.errorf("NaN and Infinity are not JSON")
	}
	return nil, p.errorf("expecting a value")
}

func (p *jsonReader) word(w string, v any) (any, error) {
	if !strings.HasPrefix(p.s[p.i:], w) {
		return nil, p.errorf("expecting a value")
	}
	p.i += len(w)
	return v, nil
}

var jsonNumberRE = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?`)

func (p *jsonReader) number() (any, error) {
	m := jsonNumberRE.FindString(p.s[p.i:])
	if m == "" || m == "-" {
		return nil, p.errorf("expecting a value")
	}
	p.i += len(m)
	return json.Number(m), nil
}

func (p *jsonReader) str() (string, error) {
	p.i++ // the opening quote
	var b strings.Builder
	for {
		if p.i >= len(p.s) {
			return "", p.errorf("unterminated string")
		}
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return b.String(), nil
		case c < 0x20:
			return "", p.errorf("invalid control character in a string")
		case c == '\\':
			if p.i+1 >= len(p.s) {
				return "", p.errorf("unterminated string")
			}
			e := p.s[p.i+1]
			p.i += 2
			switch e {
			case '"', '\\', '/':
				b.WriteByte(e)
			case 'b':
				b.WriteByte('\b')
			case 'f':
				b.WriteByte('\f')
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			case 'u':
				r, ok := p.hex4()
				if !ok {
					return "", p.errorf("invalid \\u escape")
				}
				if utf16.IsSurrogate(r) && strings.HasPrefix(p.s[p.i:], `\u`) {
					save := p.i
					p.i += 2
					if r2, ok2 := p.hex4(); ok2 && utf16.DecodeRune(r, r2) != utf8.RuneError {
						r = utf16.DecodeRune(r, r2)
					} else {
						p.i = save
					}
				}
				b.WriteRune(r) // a lone surrogate becomes U+FFFD
			default:
				return "", p.errorf("invalid escape")
			}
		default:
			r, size := utf8.DecodeRuneInString(p.s[p.i:])
			b.WriteRune(r)
			p.i += size
		}
	}
}

func (p *jsonReader) hex4() (rune, bool) {
	if p.i+4 > len(p.s) {
		return 0, false
	}
	n, err := strconv.ParseUint(p.s[p.i:p.i+4], 16, 32)
	if err != nil {
		return 0, false
	}
	p.i += 4
	return rune(n), true
}

func (p *jsonReader) object(depth int) (any, error) {
	p.i++
	out := Obj{}
	seen := map[string]bool{}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == '}' {
		p.i++
		return out, nil
	}
	for {
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != '"' {
			return nil, p.errorf("expecting a property name in double quotes")
		}
		k, err := p.str()
		if err != nil {
			return nil, err
		}
		if seen[k] {
			key := k
			if len(key) > 40 {
				key = key[:40]
			}
			return nil, fmt.Errorf("duplicate key %q", key)
		}
		seen[k] = true
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != ':' {
			return nil, p.errorf("expecting ':'")
		}
		p.i++
		p.ws()
		v, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		out = append(out, KV{k, v})
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.i < len(p.s) && p.s[p.i] == '}' {
			p.i++
			return out, nil
		}
		return nil, p.errorf("expecting ',' or '}'")
	}
}

func (p *jsonReader) array(depth int) (any, error) {
	p.i++
	out := []any{}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == ']' {
		p.i++
		return out, nil
	}
	for {
		p.ws()
		v, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.i < len(p.s) && p.s[p.i] == ']' {
			p.i++
			return out, nil
		}
		return nil, p.errorf("expecting ',' or ']'")
	}
}

// parseJSON reads one whole document strictly: objects come back as Obj, numbers as json.Number.
func parseJSON(text string) (any, error) {
	if !utf8.ValidString(text) {
		return nil, fmt.Errorf("the document is not UTF-8")
	}
	p := &jsonReader{s: text}
	p.ws()
	v, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i != len(p.s) {
		return nil, p.errorf("extra data")
	}
	return v, nil
}

// rawDecode reads one value that starts exactly at pos, and returns where it ends (Python's raw_decode).
func rawDecode(text string, pos int) (any, int, error) {
	p := &jsonReader{s: text, i: pos}
	v, err := p.value(0)
	return v, p.i, err
}

// ---- numbers ------------------------------------------------------------------------------------------------

var intLiteralRE = regexp.MustCompile(`^-?[0-9]+$`)

func isIntNumber(n json.Number) bool { return intLiteralRE.MatchString(string(n)) }

func numberInt(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		if !isIntNumber(n) {
			return 0, false
		}
		i, err := strconv.ParseInt(string(n), 10, 64)
		return i, err == nil
	case int:
		return int64(n), true
	case int64:
		return n, true
	}
	return 0, false
}

// pyFloat spells a float as Python's repr does: the shortest digits that read back exactly, positional notation
// for exponents from -4 to 15 (always with a fractional part), scientific outside it.
func pyFloat(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		if math.Signbit(f) {
			return "-0.0"
		}
		return "0.0"
	}
	s := strconv.FormatFloat(f, 'e', -1, 64)
	neg := ""
	if s[0] == '-' {
		neg, s = "-", s[1:]
	}
	e := strings.IndexByte(s, 'e')
	digits := strings.Replace(s[:e], ".", "", 1)
	exp, _ := strconv.Atoi(s[e+1:])
	if exp < -4 || exp >= 16 {
		m := digits[:1]
		if len(digits) > 1 {
			m += "." + digits[1:]
		}
		sign := "+"
		if exp < 0 {
			sign, exp = "-", -exp
		}
		return fmt.Sprintf("%s%se%s%02d", neg, m, sign, exp)
	}
	if exp >= 0 {
		if len(digits) <= exp+1 {
			return neg + digits + strings.Repeat("0", exp+1-len(digits)) + ".0"
		}
		return neg + digits[:exp+1] + "." + digits[exp+1:]
	}
	return neg + "0." + strings.Repeat("0", -exp-1) + digits
}

func numberText(n json.Number) string {
	if isIntNumber(n) {
		if i, err := strconv.ParseInt(string(n), 10, 64); err == nil {
			return strconv.FormatInt(i, 10)
		}
		return string(n)
	}
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil {
		return string(n)
	}
	return pyFloat(f)
}

// ---- writing ------------------------------------------------------------------------------------------------

func pyString(s string, ascii bool) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			switch {
			case r < 0x20:
				fmt.Fprintf(&b, `\u%04x`, r)
			case ascii && r > 0x7e:
				if r > 0xffff {
					r1, r2 := utf16.EncodeRune(r)
					fmt.Fprintf(&b, `\u%04x\u%04x`, r1, r2)
				} else {
					fmt.Fprintf(&b, `\u%04x`, r)
				}
			default:
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

type pyEncoder struct {
	ascii, sortKeys bool
	indent          int // 0: compact (",", ":"); n: n spaces per level (",", ": ")
}

func (e pyEncoder) encode(b *strings.Builder, v any, level int) {
	nl := func(l int) {
		b.WriteByte('\n')
		b.WriteString(strings.Repeat(" ", e.indent*l))
	}
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		b.WriteString(pyString(x, e.ascii))
	case json.Number:
		b.WriteString(numberText(x))
	case int:
		b.WriteString(strconv.Itoa(x))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case uint32:
		b.WriteString(strconv.FormatUint(uint64(x), 10))
	case float64:
		b.WriteString(pyFloat(x))
	case []string:
		items := make([]any, len(x))
		for i, s := range x {
			items[i] = s
		}
		e.encode(b, items, level)
	case []any:
		if len(x) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if e.indent > 0 {
				nl(level + 1)
			}
			e.encode(b, item, level+1)
		}
		if e.indent > 0 {
			nl(level)
		}
		b.WriteByte(']')
	case []Obj:
		items := make([]any, len(x))
		for i, o := range x {
			items[i] = o
		}
		e.encode(b, items, level)
	case map[string]any:
		o := Obj{}
		for k, val := range x {
			o = append(o, KV{k, val})
		}
		sort.Slice(o, func(i, j int) bool { return o[i].K < o[j].K })
		e.encode(b, o, level)
	case Obj:
		if len(x) == 0 {
			b.WriteString("{}")
			return
		}
		members := x
		if e.sortKeys {
			members = append(Obj(nil), x...)
			sort.SliceStable(members, func(i, j int) bool { return members[i].K < members[j].K })
		}
		b.WriteByte('{')
		for i, kv := range members {
			if i > 0 {
				b.WriteByte(',')
			}
			if e.indent > 0 {
				nl(level + 1)
			}
			b.WriteString(pyString(kv.K, e.ascii))
			if e.indent > 0 {
				b.WriteString(": ")
			} else {
				b.WriteByte(':')
			}
			e.encode(b, kv.V, level+1)
		}
		if e.indent > 0 {
			nl(level)
		}
		b.WriteByte('}')
	default:
		panic(fmt.Sprintf("pyjson: cannot encode %T", v))
	}
}

// pyDumps is json.dumps(v, ensure_ascii=ascii, sort_keys=sortKeys, separators=(",", ":")).
func pyDumps(v any, ascii, sortKeys bool) string {
	var b strings.Builder
	pyEncoder{ascii: ascii, sortKeys: sortKeys}.encode(&b, v, 0)
	return b.String()
}

// pyDumpsIndent is json.dumps(v, indent=n, ensure_ascii=ascii, sort_keys=sortKeys).
func pyDumpsIndent(v any, n int, ascii, sortKeys bool) string {
	var b strings.Builder
	pyEncoder{ascii: ascii, sortKeys: sortKeys, indent: n}.encode(&b, v, 0)
	return b.String()
}

// jsonEqual compares two decoded values as Python compares them after json.loads: objects without regard to member
// order, numbers by kind (whole or not) and value.
func jsonEqual(a, b any) bool {
	switch x := a.(type) {
	case Obj:
		y, ok := b.(Obj)
		if !ok || len(x) != len(y) {
			return false
		}
		for _, kv := range x {
			w, ok := y.Get(kv.K)
			if !ok || !jsonEqual(kv.V, w) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !jsonEqual(x[i], y[i]) {
				return false
			}
		}
		return true
	case json.Number:
		y, ok := b.(json.Number)
		if !ok || isIntNumber(x) != isIntNumber(y) {
			return false
		}
		if isIntNumber(x) {
			return numberText(x) == numberText(y)
		}
		f1, _ := strconv.ParseFloat(string(x), 64)
		f2, _ := strconv.ParseFloat(string(y), 64)
		return f1 == f2
	default:
		return a == b
	}
}

// toPlain turns Go values used in facts ([]string, map[string]any, ints) into the decoded JSON shapes jsonEqual and
// the encoder share.
func toPlain(v any) any {
	text := pyDumps(v, false, false)
	out, err := parseJSON(text)
	if err != nil {
		panic(err)
	}
	return out
}
