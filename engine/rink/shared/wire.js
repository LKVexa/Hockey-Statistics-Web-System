/**
 * RINK-VT 64-byte cache-line wire frame (spec §3). Every terminal command that changes game state travels as one
 * or more of these frames, from the browser command bar over /ws/rink or from a SPIRAL session through the
 * worker bridge, and is stored unchanged in the SSD-RAM ledger. All integers are big-endian (network order),
 * as hermit.vws.v2 data headers are.
 *
 *   0..15   command UUIDv7            16..23  keystroke_onset_ns (u64, Unix ns)   24..31  enter_commit_ns (u64)
 *   32..35  game_id_hash (u32)        36..39  lamport_seq (u32, per terminal)
 *   40..43  TEAM_4 ASCII  ·  44..47 PLAYER_4 ASCII  ·  48..51 STAT ASCII  ·  52..55 MODIFIER ASCII (≤4)
 *   56..57  override_x (int16, 0.1 ft, -32768 = auto)   58..59 override_y   60..63 CRC32C(bytes 0..59)
 * System frames put "!" + a 3-letter opcode in 40..43 and a 16-byte payload in 44..59:
 *   !UND undo · !DEL seq · !FXP seq team player · !FXS seq stat mod · !FXC seq x y · !FXA seq slot player
 *   !LIN team p1 p2 p3 (replace on-ice set) · !LIA team p1 p2 p3 (add) · !CLK action period remaining_ds
 *   (clock actions, byte 44: S set · B start, the game's start frame · G go · H stop · W whistle, which may carry the
 *   time on the official clock when it went · N next · E end)
 * decode() is strict: every text field must be canonical (A-Z, 0-9, NUL-padded, nothing after the first NUL) and
 * every number in range. A frame that is not gets `bad` (the reason) and placeholder text, so bytes chosen by a
 * client never reach a terminal, a log line or the audit trail; the game actor rejects it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RinkWire = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const FRAME = 64, AUTO = -32768;
  const O = { uuid: 0, onset: 16, commit: 24, game: 32, lamport: 36, team: 40, player: 44, stat: 48, mod: 52, x: 56, y: 58, crc: 60 };
  /* CRC32C (Castagnoli), reflected polynomial 0x82F63B78 */
  const T = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  function crc32c(u8, end) { let c = 0xffffffff; for (let i = 0; i < end; i++) c = T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  const rnd = (n) => { const b = new Uint8Array(n); (globalThis.crypto || require('node:crypto').webcrypto).getRandomValues(b); return b; };
  function uuidv7(ms) {
    const b = rnd(16); let t = BigInt(Math.floor(ms === undefined ? Date.now() : ms));
    for (let i = 5; i >= 0; i--) { b[i] = Number(t & 0xffn); t >>= 8n; }
    b[6] = 0x70 | (b[6] & 0x0f); b[8] = 0x80 | (b[8] & 0x3f);
    return b;
  }
  const hex = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');
  /* One flat 36-character string (a template of slices would be a rope of ~10 heap objects per frame). */
  const HEXC = '0123456789abcdef';
  function uuidStr(u8) {
    const c = new Array(36); let k = 0;
    for (let i = 0; i < 16; i++) { if (i === 4 || i === 6 || i === 8 || i === 10) c[k++] = 45; c[k++] = HEXC.charCodeAt(u8[i] >> 4); c[k++] = HEXC.charCodeAt(u8[i] & 15); }
    return String.fromCharCode.apply(null, c);
  }
  function nowNs() {
    const p = globalThis.performance;
    const ms = p && p.timeOrigin ? p.timeOrigin + p.now() : Date.now();
    return BigInt(Math.round(ms * 1000)) * 1000n;
  }
  function putAscii(u8, at, s, n) { for (let i = 0; i < n; i++) { const c = i < s.length ? s.charCodeAt(i) : 0; if (c !== 0 && (c < 33 || c > 126)) throw new Error('a frame field takes printable ASCII only'); u8[at + i] = c; } }
  const RE_TEAM = /^[A-Z]{4}$/, RE_CODE = /^[A-Z0-9]{1,4}$/, RE_OPT = /^[A-Z0-9]{0,4}$/, RE_OPT_TEAM = /^([A-Z]{4})?$/;
  const MAX_X = 1000, MAX_Y = 425, MAX_DS = 12000, MAX_PERIOD = 12;      // 0.1 ft, 0.1 ft, deciseconds, periods
  /** One NUL-padded text field. Anything but the canonical form marks the frame bad and yields '?'. */
  /* Codes repeat (a league has a few thousand): one shared string per distinct code instead of one per frame. */
  const INTERN = new Map();
  const intern = (s) => { const v = INTERN.get(s); if (v !== undefined) return v; if (INTERN.size < 8192) INTERN.set(s, s); return s; };
  function text(f, u8, at, n, re, name) {
    let s = '', ended = false, ok = true;
    for (let i = 0; i < n; i++) { const c = u8[at + i]; if (c === 0) { ended = true; continue; } if (ended || c < 33 || c > 126) { ok = false; break; } s += String.fromCharCode(c); }
    if (ok && re.test(s)) return intern(s);
    if (!f.bad) f.bad = `the ${name} field is not valid`;
    return '?';
  }
  function coords(f, x, y, name) {
    if (x === AUTO && y === AUTO) return [null, null];
    if (x === AUTO || y === AUTO || Math.abs(x) > MAX_X || Math.abs(y) > MAX_Y) { if (!f.bad) f.bad = `${name} coordinates are off the 200 × 85 ft ice`; return [null, null]; }
    return [x / 10, y / 10];
  }
  const dec10 = (v) => (v === null || v === undefined ? AUTO : Math.max(-32767, Math.min(32767, Math.round(v * 10))));
  function header(meta) {
    const u8 = new Uint8Array(FRAME); const dv = new DataView(u8.buffer);
    u8.set(meta.uuid || uuidv7(), O.uuid);
    dv.setBigUint64(O.onset, BigInt(meta.onsetNs === undefined ? nowNs() : meta.onsetNs));
    dv.setBigUint64(O.commit, BigInt(meta.commitNs === undefined ? nowNs() : meta.commitNs));
    dv.setUint32(O.game, (meta.gameHash || 0) >>> 0); dv.setUint32(O.lamport, (meta.lamport || 0) >>> 0);
    dv.setInt16(O.x, AUTO); dv.setInt16(O.y, AUTO);
    return { u8, dv };
  }
  function seal(u8) { new DataView(u8.buffer, u8.byteOffset, FRAME).setUint32(O.crc, crc32c(u8, O.crc)); return u8; }
  const playerField = (p) => (p.code ? p.code : 'J' + p.jersey);
  /** Frames for one parsed line (hcl.parseLine). meta: { gameHash, lamport (first seq), onsetNs, commitNs }. */
  function compile(ast, meta) {
    const frames = []; let lam = meta.lamport || 0;
    const mk = () => header(Object.assign({}, meta, { lamport: lam++, uuid: undefined }));
    const sys = (op, fill) => { const { u8, dv } = mk(); putAscii(u8, O.team, '!' + op, 4); fill(u8, dv); frames.push(seal(u8)); };
    switch (ast.kind) {
      case 'event': {
        const { u8, dv } = mk();
        putAscii(u8, O.team, ast.team, 4); putAscii(u8, O.player, playerField({ code: ast.player, jersey: ast.jersey }), 4); putAscii(u8, O.stat, ast.stat, 4); putAscii(u8, O.mod, ast.modCode || '', 4);
        if (ast.coords) { dv.setInt16(O.x, dec10(ast.coords.x)); dv.setInt16(O.y, dec10(ast.coords.y)); }
        frames.push(seal(u8)); break;
      }
      case 'undo': sys('UND', () => {}); break;
      case 'del': sys('DEL', (u8, dv) => dv.setUint32(44, ast.seq)); break;
      case 'fix': {
        const p = ast.patch;
        if (p.event) {
          const e = p.event;
          sys('FXP', (u8, dv) => { dv.setUint32(44, ast.seq); putAscii(u8, 48, e.team, 4); putAscii(u8, 52, playerField({ code: e.player, jersey: e.jersey }), 4); });
          sys('FXS', (u8, dv) => { dv.setUint32(44, ast.seq); putAscii(u8, 48, e.stat, 4); putAscii(u8, 52, e.modCode || '', 4); });
          if (e.coords) sys('FXC', (u8, dv) => { dv.setUint32(44, ast.seq); dv.setInt16(48, dec10(e.coords.x)); dv.setInt16(50, dec10(e.coords.y)); });
          else if (e.mods && e.mods.spot) sys('FXC', (u8, dv) => { dv.setUint32(44, ast.seq); dv.setInt16(48, AUTO); dv.setInt16(50, AUTO); });
          break;
        }
        if (p.team || p.player) sys('FXP', (u8, dv) => { dv.setUint32(44, ast.seq); putAscii(u8, 48, p.team || '', 4); putAscii(u8, 52, p.player ? playerField(p.player) : '', 4); });
        if (p.stat || p.modRaw !== undefined) sys('FXS', (u8, dv) => { dv.setUint32(44, ast.seq); putAscii(u8, 48, p.stat ? p.stat.stat : '', 4); if (p.stat) putAscii(u8, 52, p.stat.modCode || '', 4); else if (p.modRaw === '-') putAscii(u8, 52, '', 4); else putAscii(u8, 52, String(p.modRaw).toUpperCase().slice(0, 4), 4); if (!p.stat && p.modRaw === undefined) u8[52] = 0xff; });
        if (p.xy) sys('FXC', (u8, dv) => { dv.setUint32(44, ast.seq); dv.setInt16(48, p.xy.clear ? AUTO : dec10(p.xy.x)); dv.setInt16(50, p.xy.clear ? AUTO : dec10(p.xy.y)); });
        for (const slot of [1, 2]) { const a = p['a' + slot]; if (a) sys('FXA', (u8, dv) => { dv.setUint32(44, ast.seq); u8[48] = slot; putAscii(u8, 52, a.clear ? '' : playerField(a), 4); }); }
        break;
      }
      case 'line': {
        for (let i = 0; i < ast.players.length; i += 3) {
          const chunk = ast.players.slice(i, i + 3);
          // three 4-byte player slots at 48/52/56; unused slots are zeroed (56..59 would otherwise hold the x/y AUTO marker)
          sys(i === 0 ? 'LIN' : 'LIA', (u8) => { putAscii(u8, 44, ast.team, 4); for (let k = 0; k < 3; k++) putAscii(u8, 48 + 4 * k, chunk[k] ? playerField(chunk[k]) : '', 4); });
        }
        break;
      }
      case 'clock': sys('CLK', (u8, dv) => { u8[44] = { set: 83, start: 66, go: 71, stop: 72, whistle: 87, next: 78, end: 69 }[ast.action]; u8[45] = ast.period || 0; dv.setUint32(46, ast.remainingDs === null || ast.remainingDs === undefined ? 0xffffffff : ast.remainingDs); }); break;
      default: throw new Error(`${ast.kind} is not a state-changing command`);
    }
    return frames;
  }
  /** Decode and verify one frame (Uint8Array of exactly 64 bytes). Strict: see `bad` in the header comment. */
  function decode(u8) {
    if (!u8 || u8.length !== FRAME) throw new Error('a RINK frame is exactly 64 bytes');
    const dv = new DataView(u8.buffer, u8.byteOffset, FRAME);
    const crcOk = dv.getUint32(O.crc) === crc32c(u8, O.crc);
    const f = { uuid: uuidStr(u8.subarray(0, 16)), version: u8[6] >> 4, onsetNs: dv.getBigUint64(O.onset), commitNs: dv.getBigUint64(O.commit), gameHash: dv.getUint32(O.game), lamport: dv.getUint32(O.lamport), crcOk, bad: null };
    if (u8[O.team] === 0x21) {                                   // "!" + opcode
      f.kind = 'system'; f.op = text(f, u8, O.team + 1, 3, /^[A-Z]{3}$/, 'opcode');
      const seq = dv.getUint32(44);
      const needSeq = () => { f.seq = seq; if (seq < 1 && !f.bad) f.bad = 'event numbers start at 1'; };
      switch (f.op) {
        case 'UND': break;
        case 'DEL': needSeq(); break;
        case 'FXP': needSeq(); f.team = text(f, u8, 48, 4, RE_OPT_TEAM, 'team'); f.player = text(f, u8, 52, 4, RE_OPT, 'player'); if (!f.team && !f.player && !f.bad) f.bad = 'an empty FIX'; break;
        case 'FXS': needSeq(); f.stat = text(f, u8, 48, 4, RE_OPT, 'stat'); f.keepMod = u8[52] === 0xff;
          if (f.keepMod) { f.mod = null; if ((u8[53] | u8[54] | u8[55]) !== 0 && !f.bad) f.bad = 'the modifier field is not valid'; } else f.mod = text(f, u8, 52, 4, RE_OPT, 'modifier');
          break;
        case 'FXC': { needSeq(); [f.x, f.y] = coords(f, dv.getInt16(48), dv.getInt16(50), 'FIX'); break; }
        case 'FXA': needSeq(); f.slot = u8[48]; f.player = text(f, u8, 52, 4, RE_OPT, 'player'); if (f.slot !== 1 && f.slot !== 2 && !f.bad) f.bad = 'an assist slot is 1 or 2'; break;
        case 'LIN': case 'LIA': f.team = text(f, u8, 44, 4, RE_TEAM, 'team'); f.players = [0, 1, 2].map((k) => text(f, u8, 48 + 4 * k, 4, RE_OPT, 'player')).filter(Boolean); if (!f.players.length && !f.bad) f.bad = 'a LINE names at least one player'; break;
        case 'CLK': {
          f.action = { 83: 'set', 66: 'start', 71: 'go', 72: 'stop', 87: 'whistle', 78: 'next', 69: 'end' }[u8[44]] || '?'; f.period = u8[45] || null;
          const r = dv.getUint32(46); f.remainingDs = r === 0xffffffff ? null : r;
          if (!f.bad) {
            if (f.action === '?') f.bad = 'unknown clock action';
            else if (f.period !== null && f.period > MAX_PERIOD) f.bad = 'no such period';
            else if (f.remainingDs !== null && f.remainingDs > MAX_DS) f.bad = 'the clock goes from 20:00 to 0:00';
            else if (f.action === 'set' && f.remainingDs === null) f.bad = 'T needs a clock time';
            else if (f.action === 'whistle' && f.period !== null) f.bad = 'WHISTLE carries a time, never a period';
            else if (f.action !== 'set' && f.action !== 'whistle' && (f.period !== null || f.remainingDs !== null)) f.bad = 'only T carries a period, and only T and WHISTLE a time';
          }
          break;
        }
        default: f.op = '?'; if (!f.bad) f.bad = 'unknown system opcode';
      }
      return f;
    }
    f.kind = 'event'; f.team = text(f, u8, O.team, 4, RE_TEAM, 'team'); f.player = text(f, u8, O.player, 4, RE_CODE, 'player'); f.stat = text(f, u8, O.stat, 4, RE_CODE, 'stat'); f.mod = text(f, u8, O.mod, 4, RE_OPT, 'modifier');
    [f.x, f.y] = coords(f, dv.getInt16(O.x), dv.getInt16(O.y), 'event');
    return f;
  }
  /** Human-readable text of a decoded frame (audit log, ledger dump). */
  function describe(f) {
    if (f.bad) return '(malformed frame)';
    if (f.kind === 'event') return `${f.team} ${f.player} ${f.stat}${f.mod ? '/' + f.mod : ''}${f.x !== null ? `/${f.x},${f.y}` : ''}`;
    switch (f.op) {
      case 'UND': return 'UNDO'; case 'DEL': return `DEL ${f.seq}`;
      case 'FXP': return `FIX ${f.seq} ${f.team || '·'} ${f.player || '·'}`; case 'FXS': return `FIX ${f.seq} stat=${f.stat || '·'}${f.keepMod ? '' : ' mod=' + (f.mod || '∅')}`;
      case 'FXC': return `FIX ${f.seq} XY=${f.x === null ? 'auto' : f.x + ',' + f.y}`; case 'FXA': return `FIX ${f.seq} A${f.slot}=${f.player || '∅'}`;
      case 'LIN': return `LINE ${f.team} ${f.players.join(' ')}`; case 'LIA': return `LINE+ ${f.team} ${f.players.join(' ')}`;
      case 'CLK': return `CLOCK ${f.action.toUpperCase()}${f.period ? ' P' + f.period : ''}${f.remainingDs !== null ? ' ' + Math.floor(f.remainingDs / 600) + ':' + String(Math.floor(f.remainingDs / 10) % 60).padStart(2, '0') : ''}`;
      default: return f.op;
    }
  }
  return { FRAME, AUTO, OFFSETS: O, crc32c, uuidv7, uuidStr, hex, nowNs, compile, decode, describe };
});
