/**
 * RINK-VT text formatting shared by the SPIRAL terminal (Node worker) and the web dashboard (browser).
 * ANSI is optional: pass { color: false } for plain text. Width-aware tables and wrapped paragraphs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RinkFmt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SGR = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[38;5;44m', ice: '\x1b[38;5;252m', grey: '\x1b[38;5;245m', amber: '\x1b[38;5;214m', red: '\x1b[38;5;203m', green: '\x1b[38;5;114m', teal: '\x1b[38;5;37m', orange: '\x1b[38;5;209m', violet: '\x1b[38;5;141m' };
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const width = (s) => [...strip(s)].length;
  function paint(color) { return (k, s) => (color && SGR[k] ? SGR[k] + s + SGR.reset : String(s)); }
  function pad(s, n, right) { const w = width(s); if (w >= n) return s; return right ? ' '.repeat(n - w) + s : s + ' '.repeat(n - w); }
  function cut(s, n) { if (width(s) <= n) return s; const plain = strip(s); return [...plain].slice(0, Math.max(0, n - 1)).join('') + '…'; }
  function num(x, opts) {
    const o = opts || {};
    if (x === null || x === undefined) return '—';
    if (typeof x === 'string') return x;
    if (typeof x === 'boolean') return x ? 'true' : 'false';
    if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : (x > 0 ? '+Inf' : '-Inf');
    if (o.fixed !== undefined) return x.toFixed(o.fixed);
    if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x);
    const p = o.sig || 12; const s = Number(x.toPrecision(p));
    return String(s);
  }
  /** rows: array of arrays (cells may contain ANSI); cols: [{ h, align:'r'|'l', max }] */
  function table(cols, rows, opts) {
    const o = Object.assign({ color: true, width: 120, gap: 2 }, opts || {}); const c = paint(o.color);
    const w = cols.map((col, i) => Math.min(col.max || 60, Math.max(width(col.h), ...rows.map((r) => width(r[i] === undefined ? '' : r[i])))));
    // shrink the widest flexible column to fit the terminal
    let total = w.reduce((a, b) => a + b, 0) + o.gap * (w.length - 1);
    while (total > o.width) { let k = -1; for (let i = 0; i < w.length; i++) if (!cols[i].fixed && (k < 0 || w[i] > w[k])) k = i; if (k < 0 || w[k] <= 6) break; w[k]--; total--; }
    const g = ' '.repeat(o.gap);
    const line = (cells, head) => cells.map((v, i) => { let s = cut(v === undefined ? '' : String(v), w[i]); s = pad(s, w[i], cols[i].align === 'r'); return head ? c('grey', s) : s; }).join(g).replace(/\s+$/, '');
    const out = [line(cols.map((x) => x.h), true), c('grey', w.map((n) => '─'.repeat(n)).join(g))];
    for (const r of rows) out.push(line(r, false));
    return out.join('\n');
  }
  function wrap(text, n, indent) {
    const ind = indent || ''; const words = String(text).split(/\s+/).filter(Boolean); const lines = []; let cur = '';
    for (const wd of words) { if (cur && width(cur) + 1 + width(wd) > n - ind.length) { lines.push(ind + cur); cur = wd; } else cur = cur ? cur + ' ' + wd : wd; }
    if (cur) lines.push(ind + cur);
    return lines.join('\n');
  }
  function kv(pairs, opts) {
    const o = Object.assign({ color: true, keyWidth: 12, width: 100 }, opts || {}); const c = paint(o.color);
    return pairs.filter(Boolean).map(([k, v]) => {
      const lines = String(v).split('\n');
      return c('grey', pad(k, o.keyWidth)) + ' ' + lines[0] + (lines.length > 1 ? '\n' + lines.slice(1).map((l) => ' '.repeat(o.keyWidth + 1) + l).join('\n') : '');
    }).join('\n');
  }
  /* ---- text that comes from a file or from another person, on its way to a terminal ----
     A terminal acts on ESC and on the C1 controls (U+009B is CSI: "erase the screen", "move the cursor"), and a
     bidirectional override reorders what the operator reads. None of these is ever data in a case name, a mode, a
     field name or an error message, so they never reach the screen: C0, DEL, C1, the line and paragraph
     separators, the bidirectional embeddings/overrides/isolates and the byte-order mark. */
  const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
  const UNSAFE_KEEP_NL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
  const UNSAFE_IN_JSON = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
  const LONE = /\p{Cs}/gu;                         // half a surrogate pair: the HK001 adapter carries a byte that is not UTF-8 so
  const REPLACEMENT = String.fromCharCode(0xfffd);
  const text = (s) => (s === undefined || s === null ? '' : String(s));
  /** one line of foreign text: each such character becomes a space */
  const plain = (s) => text(s).replace(UNSAFE, ' ').replace(LONE, REPLACEMENT);
  /** the same for a message that may have several lines (line feeds stay) */
  const plainLines = (s) => text(s).replace(/\r\n?/g, '\n').replace(UNSAFE_KEEP_NL, ' ').replace(LONE, REPLACEMENT);
  /** a JSON document for the screen: the same document (it parses to the same value), with those characters written
      as \uXXXX escapes. In JSON text they can only occur inside strings; the encoders already escape C0. */
  const screenJSON = (s) => text(s).replace(UNSAFE_IN_JSON, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  return { SGR, strip, width, paint, pad, cut, num, table, wrap, kv, plain, plainLines, screenJSON };
});
