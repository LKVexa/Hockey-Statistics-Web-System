'use strict';
/**
 * HK001 inert multi-format input adapter (port of internal/inputadapter/adapter.go, parser
 * "hk001.multi-format.inert.v1"). Twelve readable formats; numbers become equation fields,
 * `cal_*` keys become calibration, everything else is case metadata. Nothing is executed.
 *   .json .csv .tsv .xml .xaml .html .htm .edi .txt .md .corpus .dmk
 * Bounded: 8 MiB per file, 128 records per file.
 *
 * The Go adapter leans on the standard library, and what a file means is decided there: encoding/csv
 * (TrimLeadingSpace trims every Unicode space, tabs included), encoding/xml (strict: names, entities, characters,
 * the XML declaration), encoding/json, bufio.Scanner (64 KiB lines), html.UnescapeString, strconv.ParseFloat,
 * strings.ToLower / TrimSpace. Those rules are ported here, on the file's bytes where Go works on bytes, and
 * checked against the Go adapter itself by tools/rink/adapter-difftest.js (parsed values and error text).
 *
 * One thing cannot be the same, and is stated rather than hidden: Go ranges its maps in random order. When one file
 * names the same field twice in different ways ("case" and "id", or "values" and "Values"), Go's answer is any of
 * them; this port takes sorted order.
 *
 * Files that are not valid UTF-8 (a Latin-1 export, say) are read byte for byte by Go: such a byte stays in a field
 * name or a description, counts one byte, sorts as that byte, and is printed as the escape \ufffd in a receipt,
 * which is not the character U+FFFD. Text decoded here carries each such byte as the lone surrogate U+DC00 + byte
 * (U+DC80 to U+DCFF, which valid text can never contain); the engine prints it as Go does. JSON is the exception in
 * Go too: its decoder turns such bytes into real U+FFFD characters.
 */
const crypto = require('node:crypto');
const engine = require('./engine');
const TABLES = require('./go-tables.json');

const PARSER_VERSION = 'hk001.multi-format.inert.v1';
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_RECORDS = 128;
const SUPPORTED = ['.csv', '.corpus', '.xaml', '.xml', '.edi', '.tsv', '.md', '.txt', '.html', '.json', '.dmk', '.htm'];

const extOf = (name) => { const b = String(name).split(/[\\/]/).pop(); const i = b.lastIndexOf('.'); return i > 0 || (i === 0 && b.length > 1) ? goLower(b.slice(i)) : ''; };    // strings.ToLower(filepath.Ext(name))
const isSupported = (name) => SUPPORTED.includes(extOf(name));

/* ---------------- bytes and Go strings ---------------- */
const toBytes = (x) => (x instanceof Uint8Array ? x : new TextEncoder().encode(String(x)));
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });      // a byte-order mark is a character in Go
/** utf8.DecodeRune at v[i]: [code point, width]; an invalid byte is [-1, 1]. */
function decodeRune(v, i, end) {
  const c = v[i];
  if (c < 0x80) return [c, 1];
  if (c >= 0xc2 && c <= 0xdf) { if (i + 1 < end && (v[i + 1] & 0xc0) === 0x80) return [((c & 0x1f) << 6) | (v[i + 1] & 0x3f), 2]; return [-1, 1]; }
  if (c >= 0xe0 && c <= 0xef) {
    const lo = c === 0xe0 ? 0xa0 : 0x80, hi = c === 0xed ? 0x9f : 0xbf;
    if (i + 2 < end && v[i + 1] >= lo && v[i + 1] <= hi && (v[i + 2] & 0xc0) === 0x80) return [((c & 0x0f) << 12) | ((v[i + 1] & 0x3f) << 6) | (v[i + 2] & 0x3f), 3];
    return [-1, 1];
  }
  if (c >= 0xf0 && c <= 0xf4) {
    const lo = c === 0xf0 ? 0x90 : 0x80, hi = c === 0xf4 ? 0x8f : 0xbf;
    if (i + 3 < end && v[i + 1] >= lo && v[i + 1] <= hi && (v[i + 2] & 0xc0) === 0x80 && (v[i + 3] & 0xc0) === 0x80) return [((c & 0x07) << 18) | ((v[i + 1] & 0x3f) << 12) | ((v[i + 2] & 0x3f) << 6) | (v[i + 3] & 0x3f), 4];
    return [-1, 1];
  }
  return [-1, 1];
}
/** A joined string built from many pieces without keeping millions of small strings alive. */
class Builder {
  constructor() { this.done = []; this.part = []; }
  push(s) { this.part.push(s); if (this.part.length >= 4096) { this.done.push(this.part.join('')); this.part = []; } }
  toString() { if (this.part.length) { this.done.push(this.part.join('')); this.part = []; } return this.done.length === 1 ? this.done[0] : this.done.join(''); }
}
/** The Go string v[a:b] as text: valid UTF-8 decodes as usual; each other byte b is carried as U+DC00 + b. */
function goText(v, a = 0, b = v.length) {
  if (b - a <= 48) {                                           // short and usually ASCII: no decoder call
    let ascii = true; for (let i = a; i < b; i++) if (v[i] >= 0x80) { ascii = false; break; }
    if (ascii) return b === a ? '' : String.fromCharCode.apply(null, a === 0 && b === v.length ? v : v.subarray(a, b));
  }
  const view = a === 0 && b === v.length ? v : v.subarray(a, b);
  try { return UTF8_STRICT.decode(view); } catch { /* not valid UTF-8: decode as Go's rune loop does */ }
  const out = new Builder(); let run = a;
  for (let i = a; i < b;) {
    const r = decodeRune(v, i, b);
    if (r[0] >= 0) { i += r[1]; continue; }
    if (i > run) out.push(UTF8_STRICT.decode(v.subarray(run, i)));
    out.push(String.fromCharCode(0xdc00 + v[i])); i++; run = i;
  }
  if (b > run) out.push(UTF8_STRICT.decode(v.subarray(run, b)));
  return out.toString();
}
/** The same with every carried byte shown as U+FFFD: what Go's JSON decoder makes of it, and what Go prints in a message. */
const RAW_BYTE = /[\udc80-\udcff]/gu;                           // with the u flag: lone surrogates only, never half of a pair
const lossy = (s) => s.replace(RAW_BYTE, '\uFFFD');
const goTextLossy = (v, a, b) => lossy(goText(v, a, b));
/** Length in bytes of the Go string that s stands for. */
function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else if (c >= 0xdc80 && c <= 0xdcff) n += 1;               // a carried byte
    else n += 3;
  }
  return n;
}
/* strings.ToLower is Go's own table (Unicode 15.0, simple mappings): one code point at a time, no final-sigma rule,
   U+0130 becomes "i". A JavaScript engine's toLowerCase differs on all three counts and changes with its ICU. */
const LOWER = new Map();
for (const [a, b, d, stride] of TABLES.lower) for (let c = a; c <= b; c += stride || 1) LOWER.set(c, c + d);
function goLower(s) {
  let ascii = true, upper = false;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 0x80) { ascii = false; break; } if (c >= 65 && c <= 90) upper = true; }
  if (ascii) return upper ? s.toLowerCase() : s;
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0xdc80 && c <= 0xdcff) { out += '\uFFFD'; continue; }     // strings.Map writes U+FFFD for a byte that is not UTF-8
    const l = LOWER.get(c); out += l === undefined ? ch : String.fromCodePoint(l);
  }
  return out;
}

/* strconv.ParseFloat, as far as its result is finite (parseNumber refuses NaN and ±Inf anyway). readFloat is ported
   statement by statement — one pass, because a field may be megabytes long: an optional sign, "0x" for a hexadecimal
   mantissa (which then needs a "p" exponent), digits with at most one point, underscores where Go's literals allow
   them, and an exponent whose value stops growing at 10 000. Decimal values are the correctly rounded literal (as in
   Go and in V8); hexadecimal values go through atofHex, which rounds once, to even, subnormal results included. */
const isDigit = (c) => c >= 48 && c <= 57;
const isHex = (c) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
/** strconv's underscoreOK: an underscore only between digits, or between a base prefix and a digit */
function underscoreOK(s) {
  let saw = '^', i = 0; const n = s.length;
  if (n >= 1 && (s[0] === '-' || s[0] === '+')) i = 1;
  let hex = false;
  if (n - i >= 2 && s[i] === '0' && 'box'.includes(s[i + 1].toLowerCase())) { hex = s[i + 1].toLowerCase() === 'x'; i += 2; saw = '0'; }
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if (isDigit(c) || (hex && isHex(c))) { saw = '0'; continue; }
    if (c === 95) { if (saw !== '0') return false; saw = '_'; continue; }
    if (saw === '_') return false;
    saw = '!';
  }
  return saw !== '_';
}
const F64 = new Float64Array(1), U64 = new BigUint64Array(F64.buffer);
/** strconv.atofHex for float64: mantissa (64 bits, `trunc` when digits were dropped) times 2^exp, rounded once. */
function atofHex(mant, exp, neg, trunc) {
  exp += 52;
  while (mant !== 0n && (mant >> 54n) === 0n) { mant <<= 1n; exp--; }
  if (trunc) mant |= 1n;
  while ((mant >> 55n) !== 0n) { mant = (mant >> 1n) | (mant & 1n); exp++; }
  while (mant > 1n && exp < -1024) { mant = (mant >> 1n) | (mant & 1n); exp++; }     // denormalise: minExp - 2
  let round = mant & 3n; mant >>= 2n; round |= mant & 1n; exp += 2;                    // round to even on the two extra bits
  if (round === 3n) { mant++; if (mant === (1n << 53n)) { mant >>= 1n; exp++; } }
  if ((mant >> 52n) === 0n) exp = -1023;                                                // denormal or zero
  if (exp > 1023) return neg ? -Infinity : Infinity;                                    // Go: ±Inf with a range error
  U64[0] = (mant & ((1n << 52n) - 1n)) | (BigInt(exp + 1023) << 52n) | (neg ? 1n << 63n : 0n);
  return F64[0];
}
/* A decimal literal with more than 800 significant digits before its decimal point is the one place where Go is not
   the correctly rounded literal. Its slow path (strconv's decimal) keeps 800 digits and then takes the point to be
   after them, so 1 followed by a thousand zeros and "e-1000" is 1e-200 there, not 1. Go only gets there when its
   fast path, Eisel-Lemire, gives up, which it does for the neat values such a literal tends to have. Both are
   ported: eiselLemire64 state for state (its table is the top 128 bits of 10^e, computed here), and the slow path's
   arithmetic by handing V8 the digits Go kept. */
const M64 = (1n << 64n) - 1n;
const POW10 = new Map();
function pow10Top128(e) {
  let p = POW10.get(e); if (p !== undefined) return p;
  if (e >= 0) { const m = 10n ** BigInt(e); const bl = m.toString(2).length; p = bl > 128 ? m >> BigInt(bl - 128) : m << BigInt(128 - bl); }
  else { const d = 10n ** BigInt(-e); const q = (1n << BigInt(d.toString(2).length + 200)) / d; p = q >> BigInt(q.toString(2).length - 128); }
  POW10.set(e, p); return p;
}
/** strconv.eiselLemire64 for a non-zero mantissa: the float64 bits, or null where Go falls back to its slow path. */
function eiselLemire64(man, exp10) {
  if (exp10 < -348 || exp10 > 347) return null;
  const clz = 64 - man.toString(2).length;
  man = (man << BigInt(clz)) & M64;
  let retExp2 = (BigInt(((217706 * exp10) >> 16) + 64 + 1023) - BigInt(clz)) & M64;
  const p = pow10Top128(exp10);
  const x = man * (p >> 64n); let xHi = x >> 64n, xLo = x & M64;
  if ((xHi & 0x1ffn) === 0x1ffn && ((xLo + man) & M64) < man) {                       // wider approximation
    const y = man * (p & M64); const yHi = y >> 64n, yLo = y & M64;
    let mergedHi = xHi; const mergedLo = (xLo + yHi) & M64;
    if (mergedLo < xLo) mergedHi = (mergedHi + 1n) & M64;
    if ((mergedHi & 0x1ffn) === 0x1ffn && ((mergedLo + 1n) & M64) === 0n && ((yLo + man) & M64) < man) return null;
    xHi = mergedHi; xLo = mergedLo;
  }
  const msb = xHi >> 63n;
  let retMantissa = xHi >> (msb + 9n);
  retExp2 = (retExp2 - (1n ^ msb)) & M64;
  if (xLo === 0n && (xHi & 0x1ffn) === 0n && (retMantissa & 3n) === 1n) return null;    // half-way ambiguity
  retMantissa += retMantissa & 1n; retMantissa >>= 1n;
  if ((retMantissa >> 53n) > 0n) { retMantissa >>= 1n; retExp2 = (retExp2 + 1n) & M64; }
  if (((retExp2 - 1n) & M64) >= 0x7fen) return null;                                    // subnormal, or Inf
  return (retExp2 << 52n) | (retMantissa & 0x000fffffffffffffn);
}
/** The float64 Go's ParseFloat returns for s, ±Infinity where Go reports a range error, or null for a syntax error. */
function goParseFloat(s) {
  const n = s.length; let i = 0;
  if (n === 0) return null;
  let neg = false; let c = s.charCodeAt(0);
  if (c === 43) i++; else if (c === 45) { neg = true; i++; }
  let hex = false;
  if (i + 2 < n && s.charCodeAt(i) === 48 && (s.charCodeAt(i + 1) | 32) === 120) { hex = true; i += 2; }
  let sawdot = false, sawdigits = false, underscores = false, nd = 0, ndMant = 0, dp = 0, trunc = false;
  let mant = 0n; let first = -1, last = -1;                    // decimal: where the significant digits are
  let ndInt = -1;                                              // significant digits before the decimal point
  for (; i < n; i++) {
    c = s.charCodeAt(i);
    if (c === 95) { underscores = true; continue; }
    if (c === 46) { if (sawdot) break; sawdot = true; dp = nd; ndInt = nd; continue; }
    if (isDigit(c)) {
      sawdigits = true;
      if (c === 48 && nd === 0) { dp--; continue; }            // leading zeros
      nd++;
      if (hex) { if (ndMant < 16) { mant = mant * 16n + BigInt(c - 48); ndMant++; } else if (c !== 48) trunc = true; }
      else { if (first < 0) first = i; last = i; }
      continue;
    }
    if (hex) { const l = c | 32; if (l >= 97 && l <= 102) { sawdigits = true; nd++; if (ndMant < 16) { mant = mant * 16n + BigInt(l - 87); ndMant++; } else trunc = true; continue; } }
    break;
  }
  if (!sawdigits) return null;
  if (!sawdot) dp = nd;
  if (hex) { dp *= 4; ndMant *= 4; }
  if (i < n && (s.charCodeAt(i) | 32) === (hex ? 112 : 101)) {
    i++; if (i >= n) return null;
    let esign = 1; c = s.charCodeAt(i);
    if (c === 43) i++; else if (c === 45) { i++; esign = -1; }
    if (i >= n || !isDigit(s.charCodeAt(i))) return null;
    let e = 0;
    for (; i < n; i++) { c = s.charCodeAt(i); if (c === 95) { underscores = true; continue; } if (!isDigit(c)) break; if (e < 10000) e = e * 10 + (c - 48); }
    dp += e * esign;
  } else if (hex) return null;                                 // a hexadecimal mantissa must have an exponent
  if (underscores && !underscoreOK(s.slice(0, i))) return null;
  if (i !== n) return null;
  if (hex) return mant === 0n ? (neg ? -0 : 0) : atofHex(mant, dp - ndMant, neg, trunc);
  if (nd === 0) return neg ? -0 : 0;
  let digits = s.slice(first, last + 1);                       // the significant digits, in order
  if (digits.length !== nd) digits = digits.replace(/[._]/g, '');
  if (ndInt < 0) ndInt = nd;
  if (ndInt > 800) {                                           // see above: Go's fast path, or its slow path's 800 digits
    const m19 = BigInt(digits.slice(0, 19)); const more = /[1-9]/.test(digits.slice(19));
    const f = eiselLemire64(m19, dp - 19);
    if (f === null || (more && eiselLemire64(m19 + 1n, dp - 19) !== f)) {
      const v = Number('0.' + digits.slice(0, 800) + (/[1-9]/.test(digits.slice(800)) ? '1' : '') + 'e' + (dp - (ndInt - 800)));
      return neg ? -v : v;
    }
  }
  const v = Number('0.' + digits + 'e' + dp);                  // the correctly rounded literal, with Go's exponent
  return neg ? -v : v;
}
function trimSet(s, set) { let a = 0, b = s.length; while (a < b && set.includes(s[a])) a++; while (b > a && set.includes(s[b - 1])) b--; return s.slice(a, b); }
/* strings.TrimSpace trims Unicode White_Space. That is not JavaScript's \s: U+0085 is in, U+FEFF (the byte-order
   mark) is out — so a BOM in front of a key or a number stays part of it, exactly as in Go. */
const isGoSpace = (c) => (c >= 9 && c <= 13) || c === 32 || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
function trimSpace(s) { let a = 0, b = s.length; while (a < b && isGoSpace(s.charCodeAt(a))) a++; while (b > a && isGoSpace(s.charCodeAt(b - 1))) b--; return a === 0 && b === s.length ? s : s.slice(a, b); }
function parseNumber(s) {
  s = trimSpace(trimSet(String(s), '"\''));
  if (s === '') return [0, false];
  const x = goParseFloat(s);
  return x === null || !Number.isFinite(x) ? [0, false] : [x, true];
}

function metaApply(meta, r) {
  for (const k of Object.keys(meta).sort()) {
    const v = meta[k];
    switch (goLower(trimSpace(k))) {
      case 'case_id': case 'case': case 'id': r.case_id = trimSpace(v); break;
      case 'description': case 'desc': r.description = trimSpace(v); break;
      case 'product_id': r.product_id = trimSpace(v); break;
      case 'input_mode': case 'mode': r.input_mode = trimSpace(v); break;
      case 'synthetic_fixture': case 'synthetic': { const t = trimSpace(v); r.synthetic_fixture = (t.length === 4 && t.toLowerCase() === 'true') || t === '1'; break; }   // strings.EqualFold(t, "true")
      default: break;
    }
  }
}
/* Field names come from the file. Go's maps take any string; a plain JS object does not ("__proto__"), so every
   map keyed by file text has no prototype. */
const dict = () => Object.create(null);
function requestFromMaps(meta, values, cal) {
  const r = { schema: 'hk001.hockey_equation_input.mssl.v1', product_id: 'HK001', case_id: '', description: '', input_mode: 'overlay_baseline', synthetic_fixture: true, values: dict(), calibration: dict() };
  metaApply(meta, r);
  Object.assign(r.values, values); Object.assign(r.calibration, cal);
  Object.defineProperty(r, '_meta', { value: meta });          // not enumerable: the file's metadata keys, for the differential tool
  return r;
}
/** One "key, value" pair of the delimited, text and EDI formats. */
function putPair(key, value, meta, vals, cal) {
  const lk = goLower(key);
  if (lk.startsWith('cal_')) { const [n, ok] = parseNumber(value); if (ok) cal[lk.slice(4)] = n; return; }
  const [n, ok] = parseNumber(value);
  if (ok) vals[key] = n; else meta[key] = value;
}
/** A list of requests that keeps at most MAX_INPUT_RECORDS + 1 of them but knows how many there were: a file of a
    million rows is refused with its true count ("input contains 1000000 records") without building them. */
function recordList() { const out = []; out.total = 0; return out; }
function addRecord(out, build) { out.total++; if (out.length <= MAX_INPUT_RECORDS) out.push(build()); }

/* ---------------- JSON ---------------- */
function asNumber(v) {
  if (typeof v === 'number') return [v, true];
  if (typeof v === 'string') return parseNumber(v);
  return [0, false];
}
const wellFormed = typeof ''.toWellFormed === 'function' ? (s) => s.toWellFormed() : (s) => s.replace(/[\ud800-\udfff]/gu, '\uFFFD');     // with the u flag the class matches lone surrogates only
/* encoding/json's scanner (checkValid), state for state, on the file's bytes: the same documents are valid, the
   nesting limit is the same (10 000), and a syntax error has Go's words. Returns the error text, or null. */
const JS = { BeginValueOrEmpty: 0, BeginValue: 1, BeginStringOrEmpty: 2, BeginString: 3, EndValue: 4, EndTop: 5, InString: 6, InStringEsc: 7, EscU: 8, EscU1: 9, EscU12: 10, EscU123: 11,
  Neg: 12, S1: 13, S0: 14, Dot: 15, Dot0: 16, E: 17, ESign: 18, E0: 19, T: 20, Tr: 21, Tru: 22, F: 23, Fa: 24, Fal: 25, Fals: 26, N: 27, Nu: 28, Nul: 29, Error: 30 };
const JSON_LITERAL = { [JS.T]: ['r', JS.Tr, 'true'], [JS.Tr]: ['u', JS.Tru, 'true'], [JS.Tru]: ['e', JS.EndValue, 'true'], [JS.F]: ['a', JS.Fa, 'false'], [JS.Fa]: ['l', JS.Fal, 'false'], [JS.Fal]: ['s', JS.Fals, 'false'],
  [JS.Fals]: ['e', JS.EndValue, 'false'], [JS.N]: ['u', JS.Nu, 'null'], [JS.Nu]: ['l', JS.Nul, 'null'], [JS.Nul]: ['l', JS.EndValue, 'null'] };
/** quoteChar: the offending byte as Go prints it. */
function jsonQuoteByte(c) {
  if (c === 39) return "'\\''";
  if (c === 34) return "'\"'";
  const q = goQuote(c < 0x80 ? Uint8Array.of(c) : Uint8Array.of(0xc0 | (c >> 6), 0x80 | (c & 63)));     // string(c) is the rune U+00XX
  return "'" + q.slice(1, -1) + "'";
}
function jsonCheck(v) {
  const OBJECT_KEY = 0, OBJECT_VALUE = 1, ARRAY_VALUE = 2;
  const stack = []; let step = JS.BeginValue, endTop = false, err = null;
  const fail = (c, context) => { step = JS.Error; err = 'invalid character ' + jsonQuoteByte(c) + ' ' + context; return false; };
  const space = (c) => c === 32 || c === 9 || c === 13 || c === 10;
  const hexDigit = (c) => (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
  const push = (c, kind) => { stack.push(kind); return stack.length <= 10000 ? true : fail(c, 'exceeded max depth'); };
  const pop = () => { stack.pop(); if (stack.length === 0) { step = JS.EndTop; endTop = true; } else step = JS.EndValue; };
  // Each function is the Go state of the same name; false means scanError.
  const endTopState = (c) => { if (!space(c)) fail(c, 'after top-level value'); return true; };        // the error is reported on the next call
  const endValue = (c) => {
    const n = stack.length;
    if (n === 0) { step = JS.EndTop; endTop = true; return endTopState(c); }
    if (space(c)) { step = JS.EndValue; return true; }
    const ps = stack[n - 1];
    if (ps === OBJECT_KEY) { if (c === 58) { stack[n - 1] = OBJECT_VALUE; step = JS.BeginValue; return true; } return fail(c, 'after object key'); }
    if (ps === OBJECT_VALUE) { if (c === 44) { stack[n - 1] = OBJECT_KEY; step = JS.BeginString; return true; } if (c === 125) { pop(); return true; } return fail(c, 'after object key:value pair'); }
    if (c === 44) { step = JS.BeginValue; return true; }
    if (c === 93) { pop(); return true; }
    return fail(c, 'after array element');
  };
  const beginValue = (c) => {
    if (space(c)) return true;
    switch (c) {
      case 123: step = JS.BeginStringOrEmpty; return push(c, OBJECT_KEY);
      case 91: step = JS.BeginValueOrEmpty; return push(c, ARRAY_VALUE);
      case 34: step = JS.InString; return true;
      case 45: step = JS.Neg; return true;
      case 48: step = JS.S0; return true;
      case 116: step = JS.T; return true;
      case 102: step = JS.F; return true;
      case 110: step = JS.N; return true;
      default: if (c >= 49 && c <= 57) { step = JS.S1; return true; } return fail(c, 'looking for beginning of value');
    }
  };
  const beginString = (c) => { if (space(c)) return true; if (c === 34) { step = JS.InString; return true; } return fail(c, 'looking for beginning of object key string'); };
  const state0 = (c) => { if (c === 46) { step = JS.Dot; return true; } if (c === 101 || c === 69) { step = JS.E; return true; } return endValue(c); };
  const eSign = (c) => { if (c >= 48 && c <= 57) { step = JS.E0; return true; } return fail(c, 'in exponent of numeric literal'); };
  const run = (c) => {
    switch (step) {
      case JS.InString: if (c === 34) { step = JS.EndValue; return true; } if (c === 92) { step = JS.InStringEsc; return true; } if (c < 0x20) return fail(c, 'in string literal'); return true;
      case JS.BeginValueOrEmpty: if (space(c)) return true; if (c === 93) return endValue(c); return beginValue(c);
      case JS.BeginValue: return beginValue(c);
      case JS.BeginStringOrEmpty: if (space(c)) return true; if (c === 125) { stack[stack.length - 1] = OBJECT_VALUE; return endValue(c); } return beginString(c);
      case JS.BeginString: return beginString(c);
      case JS.EndValue: return endValue(c);
      case JS.EndTop: return endTopState(c);
      case JS.InStringEsc: if (c === 98 || c === 102 || c === 110 || c === 114 || c === 116 || c === 92 || c === 47 || c === 34) { step = JS.InString; return true; } if (c === 117) { step = JS.EscU; return true; } return fail(c, 'in string escape code');
      case JS.EscU: case JS.EscU1: case JS.EscU12: case JS.EscU123: if (hexDigit(c)) { step = step === JS.EscU123 ? JS.InString : step + 1; return true; } return fail(c, 'in \\u hexadecimal character escape');
      case JS.Neg: if (c === 48) { step = JS.S0; return true; } if (c >= 49 && c <= 57) { step = JS.S1; return true; } return fail(c, 'in numeric literal');
      case JS.S1: if (c >= 48 && c <= 57) return true; return state0(c);
      case JS.S0: return state0(c);
      case JS.Dot: if (c >= 48 && c <= 57) { step = JS.Dot0; return true; } return fail(c, 'after decimal point in numeric literal');
      case JS.Dot0: if (c >= 48 && c <= 57) return true; if (c === 101 || c === 69) { step = JS.E; return true; } return endValue(c);
      case JS.E: if (c === 43 || c === 45) { step = JS.ESign; return true; } return eSign(c);
      case JS.ESign: return eSign(c);
      case JS.E0: if (c >= 48 && c <= 57) return true; return endValue(c);
      case JS.Error: return false;
      default: { const [want, next, word] = JSON_LITERAL[step]; if (c === want.charCodeAt(0)) { step = next; return true; } return fail(c, `in literal ${word} (expecting '${want}')`); }
    }
  };
  for (let i = 0; i < v.length; i++) if (!run(v[i])) return err;
  if (err !== null) return err;                                // a byte after the top-level value, seen last
  if (endTop) return null;
  run(32);                                                     // eof: a space ends a number at the top level
  if (endTop) return null;
  return err === null ? 'unexpected end of JSON input' : err;
}
/** The first number literal of a valid document that does not fit a float64 (Go refuses the document; JSON.parse makes it Infinity). */
function jsonOverflowLiteral(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) { for (i++; i < text.length; i++) { const d = text.charCodeAt(i); if (d === 92) i++; else if (d === 34) break; } continue; }
    if (c === 45 || isDigit(c)) {
      let j = i + 1; while (j < text.length) { const d = text.charCodeAt(j); if (isDigit(d) || d === 46 || d === 101 || d === 69 || d === 43 || d === 45) j++; else break; }
      const lit = text.slice(i, j); if (!Number.isFinite(Number(lit))) return lit;
      i = j - 1;
    }
  }
  return '';
}
/** What Go's decoder leaves in a map[string]any: a lone surrogate escape is U+FFFD, in keys too. Iterative: a
    document may be nested thousands deep. */
function jsonClean(root) {
  const leaf = (v) => (typeof v === 'string' ? wellFormed(v) : v);
  if (root === null || typeof root !== 'object') return leaf(root);
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) { const x = o[i]; if (x !== null && typeof x === 'object') stack.push(x); else if (typeof x === 'string') o[i] = leaf(x); } continue; }
    let rekey = null;
    for (const k of Object.keys(o)) {
      const x = o[k];
      if (x !== null && typeof x === 'object') stack.push(x); else if (typeof x === 'string') o[k] = leaf(x);
      if (wellFormed(k) !== k) (rekey || (rekey = [])).push(k);
    }
    if (rekey) for (const k of rekey) { const x = o[k]; delete o[k]; o[wellFormed(k)] = x; }
  }
  return root;
}
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function parseJSON(u8) {
  const bad = jsonCheck(u8); if (bad !== null) throw new Error(bad);
  const text = goTextLossy(u8);                                 // inside a string Go's decoder writes U+FFFD for a byte that is not UTF-8
  const parsed = JSON.parse(text);
  // Go converts every number while it decodes, and one that does not fit fails the document. The parsed tree cannot
  // show that (a later duplicate key hides the value), so the text is read.
  const big = jsonOverflowLiteral(text); if (big) throw new Error(`json: cannot unmarshal number ${big} into Go value of type float64`);
  const raw = jsonClean(parsed);
  const items = Array.isArray(raw) ? raw : [raw];
  const out = recordList();
  for (const it of items) {
    if (!isObject(it)) throw new Error('JSON record must be object');
    addRecord(out, () => {
      const meta = dict(), vals = dict(), cal = dict();
      for (const k of Object.keys(it)) {
        const v = it[k]; const lk = goLower(k);
        if (lk === 'values' || lk === 'conventional_fields') { if (isObject(v)) for (const fk of Object.keys(v)) { const [n, ok] = asNumber(v[fk]); if (ok) vals[fk] = n; } continue; }
        if (lk === 'calibration') { if (isObject(v)) for (const fk of Object.keys(v)) { const [n, ok] = asNumber(v[fk]); if (ok) cal[fk] = n; } continue; }
        const [n, ok] = asNumber(v);
        if (ok) vals[k] = n; else if (typeof v === 'string') meta[k] = v; else if (typeof v === 'boolean') meta[k] = String(v);
      }
      return requestFromMaps(meta, vals, cal);
    });
  }
  return out;
}

/* ---------------- CSV / TSV: encoding/csv's readRecord (TrimLeadingSpace, FieldsPerRecord from the first record), on bytes ---------------- */
const CSV_BARE = 'bare " in non-quoted-field', CSV_QUOTE = 'extraneous or missing " in quoted-field', CSV_COUNT = 'wrong number of fields';
function csvError(startLine, line, col, msg) {
  if (msg === CSV_COUNT) return new Error(`record on line ${line}: ${msg}`);
  if (startLine !== line) return new Error(`record on line ${startLine}; parse error on line ${line}, column ${col}: ${msg}`);
  return new Error(`parse error on line ${line}, column ${col}: ${msg}`);
}
/** Width in bytes of the white-space rune at v[i] (unicode.IsSpace), or 0. */
function spaceWidth(v, i, end) {
  const c = v[i];
  if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) return 1;
  if (c < 0xc2 || i + 1 >= end) return 0;
  const d = v[i + 1];
  if (c === 0xc2) return d === 0x85 || d === 0xa0 ? 2 : 0;
  if (i + 2 >= end) return 0;
  const e = v[i + 2];
  if (c === 0xe1) return d === 0x9a && e === 0x80 ? 3 : 0;                                              // U+1680
  if (c === 0xe2) return (d === 0x80 && ((e >= 0x80 && e <= 0x8a) || e === 0xa8 || e === 0xa9 || e === 0xaf)) || (d === 0x81 && e === 0x9f) ? 3 : 0;   // U+2000–200A, 2028, 2029, 202F, 205F
  if (c === 0xe3) return d === 0x80 && e === 0x80 ? 3 : 0;                                              // U+3000
  return 0;
}
/** v.indexOf(byte) within [a, b): a typed array's indexOf has no end, and a line must not cost a scan of the file. */
function indexIn(v, byte, a, b) {
  if (b - a < 96) { for (let i = a; i < b; i++) if (v[i] === byte) return i; return -1; }
  const i = v.subarray(a, b).indexOf(byte);
  return i < 0 ? -1 : a + i;
}
/**
 * Calls onRecord(fields) for every record; fields are strings while onRecord keeps returning true, and only counted
 * (an array of the right length) after it returns false. Errors are Go's, with Go's line and column numbers.
 */
function csvRead(v, comma, onRecord) {
  const n = v.length; let off = 0, numLine = 0, fieldsPerRecord = 0, wantText = true;
  // The current line: content v[ls..le) and, when nl, a final "\n" (after Go's "\r\n" -> "\n" and its dropped "\r" before EOF).
  let ls = 0, le = 0, nl = false, eof = false;
  const readLine = () => {
    const at = v.indexOf(10, off);
    numLine++;
    if (off >= n) { ls = le = n; nl = false; eof = true; return; }
    eof = false; ls = off;
    if (at < 0) { le = n; nl = false; off = n; if (v[le - 1] === 13) le--; return; }
    le = at; nl = true; off = at + 1;
    if (le > ls && v[le - 1] === 13) le--;
  };
  const lineLen = () => (le - ls) + (nl ? 1 : 0);
  for (;;) {
    // next line, skipping empty ones
    for (;;) { readLine(); if (!eof && lineLen() === (nl ? 1 : 0)) continue; break; }
    if (eof) return;
    const recLine = numLine; let posLine = numLine, posCol = 1; let err = null;
    const fields = []; let nfields = 0;
    let pieces = null;                                         // the field being built, when it is more than one stretch of the file
    const lit = (s) => { if (wantText) pieces.push(s); };
    const span = (a, b) => { if (wantText && b > a) pieces.push(goText(v, a, b)); };
    const endField = () => { nfields++; if (wantText) fields.push(pieces.length === 1 ? pieces[0] : pieces.join('')); pieces = null; };
    parseField: for (;;) {
      {                                                        // TrimLeadingSpace
        let i = ls; for (;;) { if (i >= le) break; const w = spaceWidth(v, i, le); if (!w) break; i += w; }
        if (i >= le) { posCol += le - ls; ls = le; nl = false; } else { posCol += i - ls; ls = i; }
      }
      if (ls >= le || v[ls] !== 34) {                          // a non-quoted field
        const ci = indexIn(v, comma, ls, le); const hit = ci >= 0;
        const fe = hit ? ci : le;
        const q = indexIn(v, 34, ls, fe);
        if (q >= 0) { err = csvError(recLine, numLine, posCol + (q - ls), CSV_BARE); break parseField; }
        pieces = []; span(ls, fe); if (wantText && !pieces.length) pieces.push(''); endField();
        if (hit) { posCol += (ci - ls) + 1; ls = ci + 1; continue parseField; }
        break parseField;
      }
      // a quoted field
      pieces = []; ls++; posCol++;
      for (;;) {
        const qi = indexIn(v, 34, ls, le);
        if (qi >= 0) {
          span(ls, qi); posCol += (qi - ls) + 1; ls = qi + 1;
          if (ls < le && v[ls] === 34) { lit('"'); ls++; posCol++; continue; }                  // "" is a quote
          if (ls < le && v[ls] === comma) { ls++; posCol++; if (wantText && !pieces.length) pieces.push(''); endField(); continue parseField; }
          if (ls >= le) { if (wantText && !pieces.length) pieces.push(''); endField(); break parseField; }   // the quote ends the line
          err = csvError(recLine, numLine, posCol - 1, CSV_QUOTE); break parseField;
        } else if (lineLen() > 0) {                            // the field continues on the next line
          span(ls, le); if (nl) lit('\n');
          posCol += lineLen();
          readLine();
          if (lineLen() > 0) { posLine++; posCol = 1; }
        } else { err = csvError(recLine, posLine, posCol, CSV_QUOTE); break parseField; }      // end of file inside a quoted field
      }
    }
    if (err) throw err;
    if (fieldsPerRecord > 0) { if (nfields !== fieldsPerRecord) throw csvError(recLine, recLine, 1, CSV_COUNT); } else fieldsPerRecord = nfields;
    if (!wantText) fields.length = nfields;
    wantText = onRecord(fields) !== false && wantText;
  }
}
function parseDelimited(u8, comma) {
  let headers = null, records = 0; const out = recordList();
  csvRead(u8, comma, (row) => {
    records++;
    if (records === 1) { headers = row.map(trimSpace); return true; }
    addRecord(out, () => {
      const meta = dict(), vals = dict(), cal = dict();
      for (let i = 0; i < headers.length && i < row.length; i++) putPair(headers[i], trimSpace(row[i]), meta, vals, cal);
      return requestFromMaps(meta, vals, cal);
    });
    return out.length <= MAX_INPUT_RECORDS;                    // rows past the limit are checked and counted, not built
  });
  if (records < 2) throw new Error('delimited input requires header and one data row');
  return out;
}

/* ---------------- key=value text (.txt .md .corpus .dmk) ---------------- */
/** bufio.Scanner's buffer is 64 KiB: a line of 65 536 bytes or more is an error in Go, not a long value. */
function hasLongLine(u8) {
  let at = 0;
  for (;;) { const e = u8.indexOf(10, at); if ((e < 0 ? u8.length : e) - at >= 65536) return true; if (e < 0) return false; at = e + 1; }
}
function parseTextPairs(text, lineBytesChecked) {
  const meta = dict(), vals = dict(), cal = dict(); const n = text.length;
  for (let at = 0; at < n;) {
    let e = text.indexOf('\n', at); if (e < 0) e = n;
    const raw = text.slice(at, e); at = e + 1;
    if (!lineBytesChecked && raw.length >= 21846 && utf8Length(raw) >= 65536) throw new Error('bufio.Scanner: token too long');
    let line = trimSpace(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (line.startsWith('-')) line = line.slice(1);
    line = trimSpace(line);
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const sep = line.includes('=') ? '=' : ':';
    const cut = line.indexOf(sep); if (cut < 0) continue;
    putPair(trimSpace(trimSet(line.slice(0, cut), '`* ')), trimSpace(trimSet(line.slice(cut + 1), '`* ')), meta, vals, cal);
  }
  if (!Object.keys(vals).length) throw new Error('no numeric key/value pairs found');
  return [requestFromMaps(meta, vals, cal)];
}

/* ---------------- EDI (segments ~ or newline, element separator *) ---------------- */
function parseEDI(text) {
  if (text.indexOf('\r') >= 0) text = text.replace(/\r/g, '');
  const meta = dict(), vals = dict(), cal = dict(); const n = text.length;
  let tilde = -1, newline = -1;                                // the next of each, looked up again only once passed
  for (let at = 0; at < n;) {
    if (tilde < at) { tilde = text.indexOf('~', at); if (tilde < 0) tilde = n; }
    if (newline < at) { newline = text.indexOf('\n', at); if (newline < 0) newline = n; }
    const e = tilde < newline ? tilde : newline;
    const seg = trimSpace(text.slice(at, e)); at = e + 1;
    if (!seg) continue;
    const cut = seg.indexOf('*'); if (cut < 0) continue;
    putPair(trimSpace(seg.slice(0, cut)), trimSpace(seg.slice(cut + 1)), meta, vals, cal);
  }
  if (!Object.keys(vals).length) throw new Error('no EDI numeric segments found');
  return [requestFromMaps(meta, vals, cal)];
}

/* ---------------- XML / XAML: encoding/xml's strict Decoder and the part of Unmarshal the adapter's two structs use ---------------- */
/* Byte for byte as Go reads it: names are checked against the XML 1.0 tables, a name has at most one colon, text and
   attribute values allow the five predefined entities and numeric references only, every decoded character must be
   an XML character and valid UTF-8, "<?xml ?>" may declare version 1.0 and UTF-8 only, and the errors carry Go's
   line numbers. Nothing is kept for elements the adapter does not read, so depth and width cost no memory. */
const XML_EOF = { eof: true };                                  // io.EOF
const XML_START = 1, XML_END = 2, XML_CHAR = 3, XML_OTHER = 4;
const inRanges = (ranges, c) => {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const r = ranges[mid]; if (c < r[0]) hi = mid - 1; else if (c > r[1]) lo = mid + 1; else return r.length < 3 || (c - r[0]) % r[2] === 0; }
  return false;
};
const xmlNameByte = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 58 || c === 46 || c === 45;
/** isName: the first rune is in the "first" table, every other in "first" or "second"; invalid UTF-8 is not a name. */
function xmlIsName(a, n) {
  if (n === 0) return false;
  for (let i = 0; i < n;) {
    const r = decodeRune(a, i, n); if (r[0] < 0) return false;
    if (!inRanges(TABLES.xmlFirst, r[0]) && (i === 0 || !inRanges(TABLES.xmlSecond, r[0]))) return false;
    i += r[1];
  }
  return true;
}
/** strconv.Quote of a Go string given as bytes: an invalid byte is \xNN, a rune that is not printable is \uNNNN. */
function goQuote(v) {
  let o = '"';
  for (let i = 0; i < v.length;) {
    const r = decodeRune(v, i, v.length); const c = r[0];
    if (c < 0) { o += '\\x' + v[i].toString(16).padStart(2, '0'); i++; continue; }
    i += r[1];
    const ch = String.fromCodePoint(c);
    if (c === 34 || c === 92) o += '\\' + ch;
    else if ((c >= 0x20 && c < 0x7f) || (c >= 0x80 && /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u.test(ch))) o += ch;
    else if (c === 7) o += '\\a'; else if (c === 8) o += '\\b'; else if (c === 12) o += '\\f'; else if (c === 10) o += '\\n'; else if (c === 13) o += '\\r'; else if (c === 9) o += '\\t'; else if (c === 11) o += '\\v';
    else if (c < 0x20 || c === 0x7f) o += '\\x' + c.toString(16).padStart(2, '0');
    else o += c > 0xffff ? '\\U' + c.toString(16).padStart(8, '0') : '\\u' + c.toString(16).padStart(4, '0');
  }
  return o + '"';
}
const latin1 = (v, a, b) => { let s = ''; for (let i = a; i < b; i += 4096) s += String.fromCharCode.apply(null, v.subarray(i, Math.min(b, i + 4096))); return s; };
const fromLatin1 = (s) => { const v = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) v[i] = s.charCodeAt(i); return v; };
/** procInst: the value of param="..." inside an XML declaration ("somewhat lame and not exact", and ported as such).
    s is the declaration as a byte string (one character per byte). */
function xmlProcInst(param, s) {
  param += '='; const lenp = param.length; let i = 0, sep = '';
  while (i < s.length) {
    const sub = s.slice(i); const k = sub.indexOf(param);
    if (k < 0 || lenp + k >= sub.length) return '';
    i += lenp + k + 1;
    const c = sub[lenp + k]; if (c === "'" || c === '"') { sep = c; break; }
  }
  if (!sep) return '';
  const j = s.indexOf(sep, i);
  return j < 0 ? '' : s.slice(i, j);
}
class XmlDecoder {
  constructor(u8) {
    this.u8 = u8; this.off = 0; this.nextByte = -1; this.line = 1; this.err = null;
    this.buf = new Uint8Array(256); this.n = 0;               // d.buf
    this.stk = [];                                             // open elements: space, local, space, local, ...
    this.needClose = false; this.closeSpace = ''; this.closeLocal = '';
    this.wantText = false;                                     // decode character data (only inside <field>)
    this.names = new Map();
    this.space_ = ''; this.local_ = '';                        // result of nsname()
  }
  syntaxError(msg) { return new Error('XML syntax error on line ' + this.line + ': ' + msg); }
  put(b) { if (this.n === this.buf.length) { const g = new Uint8Array(this.buf.length * 2); g.set(this.buf); this.buf = g; } this.buf[this.n++] = b; }
  getc() {
    if (this.err !== null) return -1;
    let b;
    if (this.nextByte >= 0) { b = this.nextByte; this.nextByte = -1; }
    else { if (this.off >= this.u8.length) { this.err = XML_EOF; return -1; } b = this.u8[this.off++]; }
    if (b === 10) this.line++;
    return b;
  }
  mustgetc() { const b = this.getc(); if (b < 0 && this.err === XML_EOF) this.err = this.syntaxError('unexpected EOF'); return b; }
  ungetc(b) { if (b === 10) this.line--; this.nextByte = b; }
  space() { for (;;) { const b = this.getc(); if (b < 0) return; if (b !== 32 && b !== 13 && b !== 10 && b !== 9) { this.ungetc(b); return; } } }
  /** Appends a name to buf. False when there is none (err is set only at end of input). */
  readName() {
    let b = this.mustgetc(); if (b < 0) return false;
    if (b < 0x80 && !xmlNameByte(b)) { this.ungetc(b); return false; }
    this.put(b);
    for (;;) {
      b = this.mustgetc(); if (b < 0) return false;
      if (b < 0x80 && !xmlNameByte(b)) { this.ungetc(b); break; }
      this.put(b);
    }
    return true;
  }
  name() {
    this.n = 0;
    if (!this.readName()) return null;
    if (!xmlIsName(this.buf, this.n)) { this.err = this.syntaxError('invalid XML name: ' + goTextLossy(this.buf, 0, this.n)); return null; }
    const s = goText(this.buf, 0, this.n); const known = this.names.get(s);
    if (known !== undefined) return known;
    if (this.names.size < 4096) this.names.set(s, s);
    return s;
  }
  /** A name with at most one colon in the middle: sets space_ and local_. */
  nsname() {
    const s = this.name(); if (s === null) return false;
    const c = s.indexOf(':');
    if (c >= 0 && s.indexOf(':', c + 1) >= 0) return false;
    if (c <= 0 || c === s.length - 1) { this.space_ = ''; this.local_ = s; } else { this.space_ = s.slice(0, c); this.local_ = s.slice(c + 1); }
    return true;
  }
  /** Character data, an attribute value (quote >= 0) or a CDATA section, into buf. False on failure (err is set). */
  text(quote, cdata) {
    let b0 = 0, b1 = 0, trunc = 0; this.n = 0;
    for (;;) {
      let b = this.getc();
      if (b < 0) {
        if (cdata) { if (this.err === XML_EOF) this.err = this.syntaxError('unexpected EOF in CDATA section'); return false; }
        break;
      }
      if (quote < 0 && b0 === 93 && b1 === 93 && b === 62) {
        if (cdata) { trunc = 2; break; }
        this.err = this.syntaxError('unescaped ]]> not in CDATA section'); return false;
      }
      if (b === 60 && !cdata) {
        if (quote >= 0) { this.err = this.syntaxError('unescaped < inside quoted string'); return false; }
        this.ungetc(60); break;
      }
      if (quote >= 0 && b === quote) break;
      if (b === 38 && !cdata) {
        const before = this.n; this.put(38);
        let text = null;
        b = this.mustgetc(); if (b < 0) return false;
        if (b === 35) {                                        // &#...;
          this.put(b);
          b = this.mustgetc(); if (b < 0) return false;
          let base = 10;
          if (b === 120) { base = 16; this.put(b); b = this.mustgetc(); if (b < 0) return false; }
          const start = this.n;
          while (isDigit(b) || (base === 16 && ((b >= 97 && b <= 102) || (b >= 65 && b <= 70)))) { this.put(b); b = this.mustgetc(); if (b < 0) return false; }
          if (b !== 59) this.ungetc(b);
          else {
            let d0 = start; while (d0 < this.n - 1 && this.buf[d0] === 48) d0++;       // ParseUint ignores leading zeros
            const digits = this.n - d0; let s = ''; for (let i = d0; i < this.n; i++) s += String.fromCharCode(this.buf[i]);
            this.put(59);
            if (this.n - 1 > start && digits <= 8) {
              const v = parseInt(s, base);
              if (v <= 0x10ffff) text = v >= 0xd800 && v <= 0xdfff ? '\uFFFD' : String.fromCodePoint(v);
            }
          }
        } else {
          this.ungetc(b);
          if (!this.readName() && this.err !== null) return false;
          b = this.mustgetc(); if (b < 0) return false;
          if (b !== 59) this.ungetc(b);
          else {
            const a = before + 1, len = this.n - a; this.put(59);
            if (xmlIsName(this.buf.subarray(a, a + len), len)) {
              const nm = goText(this.buf, a, a + len);
              text = nm === 'lt' ? '<' : nm === 'gt' ? '>' : nm === 'amp' ? '&' : nm === 'apos' ? "'" : nm === 'quot' ? '"' : null;
            }
          }
        }
        if (text !== null) {
          this.n = before;
          const cp = text.codePointAt(0);
          if (cp < 0x80) this.put(cp); else if (cp < 0x800) { this.put(0xc0 | (cp >> 6)); this.put(0x80 | (cp & 63)); }
          else if (cp < 0x10000) { this.put(0xe0 | (cp >> 12)); this.put(0x80 | ((cp >> 6) & 63)); this.put(0x80 | (cp & 63)); }
          else { this.put(0xf0 | (cp >> 18)); this.put(0x80 | ((cp >> 12) & 63)); this.put(0x80 | ((cp >> 6) & 63)); this.put(0x80 | (cp & 63)); }
          b0 = 0; b1 = 0; continue;
        }
        let ent = goTextLossy(this.buf, before, this.n);
        if (this.buf[this.n - 1] !== 59) ent += ' (no semicolon)';
        this.err = this.syntaxError('invalid character entity ' + ent); return false;
      }
      if (b === 13) this.put(10); else if (b1 === 13 && b === 10) { /* \r\n: the \n was written for the \r */ } else this.put(b);
      b0 = b1; b1 = b;
    }
    this.n -= trunc;
    for (let i = 0; i < this.n;) {                             // every rune must be an XML character
      const c = this.buf[i];
      if (c >= 0x20 && c < 0x80) { i++; continue; }
      const r = decodeRune(this.buf, i, this.n);
      if (r[0] < 0) { this.err = this.syntaxError('invalid UTF-8'); return false; }
      const u = r[0];
      if (!(u === 9 || u === 10 || u === 13 || (u >= 0x20 && u <= 0xd7ff) || (u >= 0xe000 && u <= 0xfffd) || (u >= 0x10000 && u <= 0x10ffff))) {
        this.err = this.syntaxError('illegal character code U+' + u.toString(16).toUpperCase().padStart(4, '0')); return false;
      }
      i += r[1];
    }
    return true;
  }
  rawToken() {
    if (this.err !== null) return null;
    if (this.needClose) { this.needClose = false; return { k: XML_END, space: this.closeSpace, local: this.closeLocal }; }
    let b = this.getc(); if (b < 0) return null;
    if (b !== 60) {
      this.ungetc(b);
      if (!this.text(-1, false)) return null;
      return { k: XML_CHAR, text: this.wantText ? goText(this.buf, 0, this.n) : '' };
    }
    b = this.mustgetc(); if (b < 0) return null;
    if (b === 47) {                                            // </name>
      if (!this.nsname()) { if (this.err === null) this.err = this.syntaxError('expected element name after </'); return null; }
      const space = this.space_, local = this.local_;
      this.space();
      b = this.mustgetc(); if (b < 0) return null;
      if (b !== 62) { this.err = this.syntaxError('invalid characters between </' + local + ' and >'); return null; }
      return { k: XML_END, space, local };
    }
    if (b === 63) {                                            // <?target ...?>
      const target = this.name();
      if (target === null) { if (this.err === null) this.err = this.syntaxError('expected target name after <?'); return null; }
      this.space(); this.n = 0;
      for (let b0 = 0; ;) { b = this.mustgetc(); if (b < 0) return null; this.put(b); if (b0 === 63 && b === 62) break; b0 = b; }
      if (target === 'xml') {
        const content = latin1(this.buf, 0, this.n - 2);
        const ver = xmlProcInst('version', content);
        if (ver !== '' && ver !== '1.0') { this.err = new Error(`xml: unsupported version ${goQuote(fromLatin1(ver))}; only version 1.0 is supported`); return null; }
        const enc = xmlProcInst('encoding', content);
        if (enc !== '' && !/^utf-8$/i.test(enc)) { this.err = new Error(`xml: encoding ${goQuote(fromLatin1(enc))} declared but Decoder.CharsetReader is nil`); return null; }
      }
      return { k: XML_OTHER };
    }
    if (b === 33) {                                            // <!-- --> , <![CDATA[ ]]> or a directive
      b = this.mustgetc(); if (b < 0) return null;
      if (b === 45) {
        b = this.mustgetc(); if (b < 0) return null;
        if (b !== 45) { this.err = this.syntaxError('invalid sequence <!- not part of <!--'); return null; }
        for (let b0 = 0, b1 = 0; ;) {
          b = this.mustgetc(); if (b < 0) return null;
          if (b0 === 45 && b1 === 45) { if (b !== 62) { this.err = this.syntaxError('invalid sequence "--" not allowed in comments'); return null; } break; }
          b0 = b1; b1 = b;
        }
        return { k: XML_OTHER };
      }
      if (b === 91) {
        for (let i = 0; i < 6; i++) { b = this.mustgetc(); if (b < 0) return null; if (b !== 'CDATA['.charCodeAt(i)) { this.err = this.syntaxError('invalid <![ sequence'); return null; } }
        if (!this.text(-1, true)) return null;
        return { k: XML_CHAR, text: this.wantText ? goText(this.buf, 0, this.n) : '' };
      }
      // <!DOCTYPE ...>, <!ENTITY ...>: skipped; quoted angle brackets do not nest, comments inside are skipped
      let inquote = 0, depth = 0;
      for (;;) {
        b = this.mustgetc(); if (b < 0) return null;
        if (inquote === 0 && b === 62 && depth === 0) break;
        for (let again = true; again;) {
          again = false;
          if (b === inquote) inquote = 0;
          else if (inquote !== 0) { /* inside quotes */ }
          else if (b === 39 || b === 34) inquote = b;
          else if (b === 62) depth--;
          else if (b === 60) {
            let comment = true;
            for (let i = 0; i < 3; i++) { b = this.mustgetc(); if (b < 0) return null; if (b !== '!--'.charCodeAt(i)) { depth++; comment = false; again = true; break; } }
            if (comment) for (let b0 = 0, b1 = 0; ;) { b = this.mustgetc(); if (b < 0) return null; if (b0 === 45 && b1 === 45 && b === 62) break; b0 = b1; b1 = b; }
          }
        }
      }
      return { k: XML_OTHER };
    }
    // <name attr="value" ...> or <name ... />
    this.ungetc(b);
    if (!this.nsname()) { if (this.err === null) this.err = this.syntaxError('expected element name after <'); return null; }
    const space = this.space_, local = this.local_; const attrs = []; let empty = false;
    for (;;) {
      this.space();
      b = this.mustgetc(); if (b < 0) return null;
      if (b === 47) {
        empty = true;
        b = this.mustgetc(); if (b < 0) return null;
        if (b !== 62) { this.err = this.syntaxError('expected /> in element'); return null; }
        break;
      }
      if (b === 62) break;
      this.ungetc(b);
      if (!this.nsname()) { if (this.err === null) this.err = this.syntaxError('expected attribute name in element'); return null; }
      const an = this.local_;
      this.space();
      b = this.mustgetc(); if (b < 0) return null;
      if (b !== 61) { this.err = this.syntaxError('attribute name without = in element'); return null; }
      this.space();
      b = this.mustgetc(); if (b < 0) return null;
      if (b !== 34 && b !== 39) { this.err = this.syntaxError('unquoted or missing attribute value in element'); return null; }
      if (!this.text(b, false)) return null;
      attrs.push(an, goText(this.buf, 0, this.n));
    }
    if (empty) { this.needClose = true; this.closeSpace = space; this.closeLocal = local; }
    return { k: XML_START, space, local, attrs };
  }
  /** Token: start and end elements are matched (by prefix and local name, as written). */
  token() {
    const t = this.rawToken();
    if (t === null) { if (this.err === XML_EOF && this.stk.length) this.err = this.syntaxError('unexpected EOF'); return null; }
    if (t.k === XML_START) this.stk.push(t.space, t.local);
    else if (t.k === XML_END) {
      if (!this.stk.length) { this.err = this.syntaxError('unexpected end element </' + t.local + '>'); return null; }
      const local = this.stk.pop(), space = this.stk.pop();
      if (local !== t.local) { this.err = this.syntaxError('element <' + local + '> closed by </' + t.local + '>'); return null; }
      if (space !== t.space) { this.err = this.syntaxError('element <' + local + '> in space ' + space + ' closed by </' + t.local + '> in space ' + (t.space === '' ? '""' : t.space)); return null; }
    }
    return t;
  }
}
/**
 * xml.Unmarshal into docXML { case_id, description, input_mode attributes; Fields `xml:"field"`; Calibration
 * `xml:"calibration>field"` } with fieldXML { name, value attributes; character data }, read as a stream: each
 * field is handed to onField(isCalibration, name, value, text) when its end tag is read.
 */
function xmlUnmarshal(u8, onField) {
  const d = new XmlDecoder(u8);
  const next = () => { const t = d.token(); if (t === null) throw (d.err === XML_EOF ? new Error('EOF') : d.err); return t; };
  const skip = () => { for (let depth = 0; ;) { const t = next(); if (t.k === XML_START) depth++; else if (t.k === XML_END) { if (depth === 0) return; depth--; } } };
  const field = (start, isCal) => {
    let name = '', value = '', text = '';
    for (let i = 0; i < start.attrs.length; i += 2) { if (start.attrs[i] === 'name') name = start.attrs[i + 1]; else if (start.attrs[i] === 'value') value = start.attrs[i + 1]; }
    for (;;) {
      d.wantText = true; const t = next(); d.wantText = false;
      if (t.k === XML_START) skip(); else if (t.k === XML_END) break; else if (t.k === XML_CHAR) text += t.text;
    }
    onField(isCal, name, value, text);
  };
  let root; for (;;) { root = next(); if (root.k === XML_START) break; }
  const doc = { case_id: '', description: '', input_mode: '' };
  for (let i = 0; i < root.attrs.length; i += 2) { const k = root.attrs[i]; if (k === 'case_id' || k === 'description' || k === 'input_mode') doc[k] = root.attrs[i + 1]; }
  for (;;) {
    const t = next();
    if (t.k === XML_END) break;
    if (t.k !== XML_START) continue;
    if (t.local === 'field') field(t, false);
    else if (t.local === 'calibration') {
      for (;;) { const u = next(); if (u.k === XML_END) break; if (u.k !== XML_START) continue; if (u.local === 'field') field(u, true); else skip(); }
    } else skip();
  }
  return doc;
}
function parseXML(u8) {
  const vals = dict(), cal = dict();
  const d = xmlUnmarshal(u8, (isCal, name, value, text) => {
    const [x, ok] = parseNumber(trimSpace(value) === '' ? text : value);
    if (ok) (isCal ? cal : vals)[name] = x;
  });
  if (!Object.keys(vals).length) throw new Error('no XML field elements found');
  return [requestFromMaps({ case_id: d.case_id, description: d.description, input_mode: d.input_mode }, vals, cal)];
}

/* ---------------- HTML (data-field/data-key + data-value attributes; else visible text as key/value pairs) ---------------- */
/* html.UnescapeString, ported statement by statement: the full HTML5 named-reference table (the keys with and
   without the trailing ';' are separate entries, as in Go), the Windows-1252 replacements for &#128;–&#159;,
   U+FFFD for NUL, surrogates and out-of-range values, and the legacy prefix match for names without a semicolon. */
const HTML5 = require('./html5-entities.json');
const hasEnt = (k) => Object.prototype.hasOwnProperty.call(HTML5, k);
const WIN1252 = [0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178];
const isAlnum = (c) => isDigit(c) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
/** s[i] is '&'. Returns [replacement text, index after what was consumed]. */
function unescapeEntity(s, i) {
  const n = s.length; let j = i + 1;
  if (n - i <= 1) return ['&', i + 1];
  if (s.charCodeAt(j) === 35) {                                   // '#'
    if (n - i <= 3) return ['&', i + 1];
    j++; let c = s.charCodeAt(j); let hex = false; if (c === 120 || c === 88) { hex = true; j++; }
    let x = 0;                                                    // a Go rune: int32 arithmetic, wrap-around included
    while (j < n) {
      c = s.charCodeAt(j); j++;
      if (hex) {
        if (isDigit(c)) { x = (Math.imul(16, x) + c - 48) | 0; continue; }
        if (c >= 97 && c <= 102) { x = (Math.imul(16, x) + c - 97 + 10) | 0; continue; }
        if (c >= 65 && c <= 70) { x = (Math.imul(16, x) + c - 65 + 10) | 0; continue; }
      } else if (isDigit(c)) { x = (Math.imul(10, x) + c - 48) | 0; continue; }
      if (c !== 59) j--;
      break;
    }
    if (j - i <= 3) return ['&', i + 1];                          // no digits
    if (x >= 0x80 && x <= 0x9f) x = WIN1252[x - 0x80]; else if (x <= 0 || (x >= 0xd800 && x <= 0xdfff) || x > 0x10ffff) x = 0xfffd;
    return [String.fromCodePoint(x), j];
  }
  while (j < n) { const c = s.charCodeAt(j); j++; if (isAlnum(c)) continue; if (c !== 59) j--; break; }
  const name = s.slice(i + 1, j);
  if (name.length) {
    if (hasEnt(name)) return [HTML5[name], j];
    let maxLen = name.length - 1; if (maxLen > 6) maxLen = 6;     // longestEntityWithoutSemicolon
    for (let k = maxLen; k > 1; k--) { const sub = name.slice(0, k); if (hasEnt(sub) && HTML5[sub].length === 1) return [HTML5[sub], i + k + 1]; }
  }
  return [s.slice(i, j), j];
}
function htmlUnescape(s) {
  let i = s.indexOf('&'); if (i < 0) return s;
  let out = null, from = 0;                                    // s[from..i) is text not yet copied
  while (i >= 0) {
    const [t, next] = unescapeEntity(s, i);
    if (t.length !== next - i || !s.startsWith(t, i)) { if (!out) out = new Builder(); out.push(s.slice(from, i)); out.push(t); from = next; }
    i = s.indexOf('&', next);
  }
  if (!out) return s;
  out.push(s.slice(from));
  return out.toString();
}
/*
 * Go's two HTML patterns are
 *   (?i)data-(?:field|key)\s*=\s*["']([^"']+)["'][^>]*data-value\s*=\s*["']([^"']+)["']
 *   (?i)data-meta\s*=\s*["']([^"']+)["'][^>]*data-value\s*=\s*["']([^"']+)["']
 * RE2 never backtracks. A backtracking engine takes quadratic time on a file of names with no value (seconds at
 * 128 KiB, hours at the 8 MiB input bound), so the pattern is cut at its only ambiguous point, `[^>]*`:
 *   - the head (`data-field = "name"`) and the tail (`data-value = "value"`) each match in one way only;
 *   - the greedy `[^>]*` selects the LAST valid tail whose literal lies before the next '>' after the head. That is
 *     a property of the stretch between two '>' characters, so it is computed once per stretch.
 * The result is the leftmost-first match list of the original pattern (checked against it on random input and
 * against the Go CLI). RE2's \s is [\t\n\f\r ] and its (?i) is Unicode simple folding (the `u` flag: K matches k).
 */
const HTML_S = '[\\t\\n\\f\\r ]*';
const HTML_TAIL = new RegExp(`data-value${HTML_S}=${HTML_S}["']([^"']+)["']`, 'iuy');
const HTML_TAIL_LEN = 'data-value'.length;
function htmlPairs(text, headWords, each) {
  const head = new RegExp(`data-(?:${headWords})${HTML_S}=${HTML_S}["']([^"']+)["']`, 'giu');
  let cands = null;                                   // index of every "data-value", ascending (built on first need)
  const lastTail = new Map();                         // index of a '>' (or the text length) -> last valid tail before it
  let gt = -1;                                        // the next '>' at or after the latest head's end; heads only move forward
  const tailAfter = (h) => {
    if (gt < h) { gt = text.indexOf('>', h); if (gt < 0) gt = text.length; }
    let t = lastTail.get(gt);
    if (t === undefined) {
      if (!cands) { cands = []; const lit = /data-value/giu; let m; while ((m = lit.exec(text))) cands.push(m.index); }
      const start = text.lastIndexOf('>', gt - 1) + 1;
      let lo = 0, hi = cands.length;                  // candidates whose literal ends at or before the '>'
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cands[mid] + HTML_TAIL_LEN <= gt) lo = mid + 1; else hi = mid; }
      t = null;
      for (let k = lo - 1; k >= 0 && cands[k] >= start; k--) {
        HTML_TAIL.lastIndex = cands[k]; const r = HTML_TAIL.exec(text);
        if (r) { t = { at: cands[k], value: r[1], end: HTML_TAIL.lastIndex }; break; }
      }
      lastTail.set(gt, t);
    }
    return t && t.at >= h ? t : null;
  };
  for (let pos = 0; ;) {
    head.lastIndex = pos; const m = head.exec(text); if (!m) break;
    const t = tailAfter(head.lastIndex);
    if (t) { each(m[1], t.value); pos = t.end; } else pos = m.index + 1;
  }
}
/** regexp `<[^>]+>` replaced by "\n", in one pass. */
function htmlStripTags(text) {
  const out = new Builder(); let pos = 0, from = 0;
  for (;;) {
    const i = text.indexOf('<', from); if (i < 0) break;
    const j = text.indexOf('>', i + 1); if (j < 0) break;      // no '>' ahead: nothing further can match
    if (j === i + 1) { from = j; continue; }                   // "<>" is not a tag: the '<' stays, the search goes on
    out.push(text.slice(pos, i)); out.push('\n'); pos = from = j + 1;
  }
  if (pos === 0) return text;
  out.push(text.slice(pos));
  return out.toString();
}
function parseHTML(u8) {
  const text = htmlUnescape(goText(u8));
  const vals = dict(), meta = dict();
  htmlPairs(text, 'field|key', (k, v) => { const [x, ok] = parseNumber(v); if (ok) vals[k] = x; });
  htmlPairs(text, 'meta', (k, v) => { meta[k] = v; });
  if (!Object.keys(vals).length) return parseTextPairs(htmlStripTags(text), false);
  return [requestFromMaps(meta, vals, {})];
}

/** Parse one input file (name decides the format). Returns requests with HK001 provenance attached. */
function loadBytes(name, bytes) {
  const ext = extOf(name);
  if (!SUPPORTED.includes(ext)) throw new Error('unsupported input extension');
  const u8 = toBytes(bytes);
  if (u8.length > MAX_INPUT_BYTES) throw new Error(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  const sha = crypto.createHash('sha256').update(u8).digest('hex');
  let reqs;
  try {
    switch (ext) {
      case '.json': reqs = parseJSON(u8); break;
      case '.csv': reqs = parseDelimited(u8, 0x2c); break;
      case '.tsv': reqs = parseDelimited(u8, 0x09); break;
      case '.xml': case '.xaml': reqs = parseXML(u8); break;
      case '.html': case '.htm': reqs = parseHTML(u8); break;
      case '.edi': reqs = parseEDI(goText(u8)); break;
      default:
        if (hasLongLine(u8)) throw new Error('bufio.Scanner: token too long');
        reqs = parseTextPairs(goText(u8), true);
    }
  } catch (e) { throw new Error(`parse ${ext}: ${e.message}`); }
  const count = reqs.total === undefined ? reqs.length : reqs.total;
  if (!count) throw new Error('input produced no records');
  if (count > MAX_INPUT_RECORDS) throw new Error(`input contains ${count} records; maximum is ${MAX_INPUT_RECORDS}`);
  const base = String(name).split(/[\\/]/).pop();
  const list = Array.from(reqs);
  list.forEach((r, i) => { r._prov = { source_name: base, source_format: ext, source_sha256: sha, parser_profile: PARSER_VERSION, record_index: i + 1, record_count: list.length, defaulted_fields: null }; });
  return list;
}

/* ---------------- example inputs in every format (WriteExamples) ---------------- */
/** strconv.FormatFloat(x, 'g', -1, 64) */
function goFormatG(x) {
  if (Object.is(x, -0)) return '-0';
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : (x > 0 ? '+Inf' : '-Inf');
  if (x === 0) return '0';
  const s = x.toExponential();                       // shortest round-trip digits in exponent form
  const [mant, e] = s.split('e'); const exp = Number(e);
  if (exp < -4 || exp >= 21) return mant + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  // Go uses %e when exp >= eprec where eprec = 21 when digits <= decimal point, else max(digits, 6)? -> shortest: eprec=6, then
  // "if eprec > digs.nd && digs.nd >= digs.dp { eprec = digs.nd }" happens before shortest override; shortest forces 6, but
  // %e is chosen only if exp >= 21 when the number is an integer-valued shortest form (Go special-cases via eprec = 21).
  const digits = mant.replace('-', '').replace('.', '').length;
  const eprec = (digits <= exp + 1) ? 21 : 6;
  if (exp >= eprec) return mant + 'e+' + String(exp).padStart(2, '0');
  return String(x);
}
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const htmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;');
function csvField(s, comma) { return /["\r\n]/.test(s) || s.includes(comma) || (s !== '' && (s[0] === ' ' || s[0] === '\t')) ? '"' + s.replace(/"/g, '""') + '"' : s; }

/** Returns { filename: content } for the twelve example files Go's WriteExamples writes. */
function exampleFiles(r) {
  r = r || Object.assign(engine.defaultRequest(), { case_id: 'example_hockey_balanced_season', description: 'Readable synthetic baseline supplied in every supported format.' });
  const keys = Object.keys(r.values).sort();
  const files = {};
  const vals = {}; for (const k of keys) vals[k] = r.values[k];
  const obj = { case_id: r.case_id, description: r.description, input_mode: 'strict_complete', product_id: r.product_id, schema: r.schema, synthetic_fixture: true, values: vals };
  const ind = (v, d) => { const p = '  '.repeat(d); if (v && typeof v === 'object') { const ks = Object.keys(v); return '{\n' + ks.map((k) => p + '  ' + engine.goJSON(k) + ': ' + ind(v[k], d + 1)).join(',\n') + '\n' + p + '}'; } return engine.goJSON(v); };
  files['example_hockey.json'] = ind(obj, 0) + '\n';
  for (const [name, comma] of [['example_hockey.csv', ','], ['example_hockey.tsv', '\t']]) {
    const header = ['product_id', 'case_id', 'description', 'input_mode', 'synthetic_fixture', ...keys];
    const row = ['HK001', r.case_id, r.description, 'strict_complete', 'true', ...keys.map((k) => goFormatG(r.values[k]))];
    files[name] = header.map((h) => csvField(h, comma)).join(comma) + '\n' + row.map((h) => csvField(h, comma)).join(comma) + '\n';
  }
  let pairs = `product_id=HK001\ncase_id=${r.case_id}\ndescription=${r.description}\ninput_mode=strict_complete\nsynthetic_fixture=true\n`;
  for (const k of keys) pairs += `${k}=${goFormatG(r.values[k])}\n`;
  for (const n of ['example_hockey.txt', 'example_hockey.md', 'example_hockey.corpus', 'example_hockey.dmk']) files[n] = pairs;
  let edi = `product_id*HK001~case_id*${r.case_id}~description*${r.description}~input_mode*strict_complete~synthetic_fixture*true~`;
  for (const k of keys) edi += `${k}*${goFormatG(r.values[k])}~`;
  files['example_hockey.edi'] = edi + '\n';
  let x = `<?xml version="1.0" encoding="UTF-8"?>\n<hockey-equation-input case_id="${xmlEscape(r.case_id)}" description="${xmlEscape(r.description)}" input_mode="strict_complete">\n`;
  for (const k of keys) x += `  <field name="${xmlEscape(k)}" value="${goFormatG(r.values[k])}"/>\n`;
  x += '</hockey-equation-input>\n';
  files['example_hockey.xml'] = x; files['example_hockey.xaml'] = x;
  let h = `<!doctype html><html><head><meta charset="utf-8"><title>HK001 input</title></head><body><section data-meta="case_id" data-value="${htmlEscape(r.case_id)}"></section><section data-meta="description" data-value="${htmlEscape(r.description)}"></section><section data-meta="input_mode" data-value="strict_complete"></section>\n`;
  for (const k of keys) h += `<div data-field="${htmlEscape(k)}" data-value="${goFormatG(r.values[k])}"></div>\n`;
  h += '</body></html>\n';
  files['example_hockey.html'] = h; files['example_hockey.htm'] = h;
  return files;
}

module.exports = { PARSER_VERSION, SUPPORTED, MAX_INPUT_BYTES, MAX_INPUT_RECORDS, isSupported, extOf, loadBytes, parseNumber, exampleFiles, goFormatG,
  // exposed for the equivalence tests and the differential tool
  _html: { pairs: htmlPairs, stripTags: htmlStripTags, unescape: htmlUnescape }, _trimSpace: trimSpace, _goLower: goLower, _goText: goText, _lossy: lossy };
