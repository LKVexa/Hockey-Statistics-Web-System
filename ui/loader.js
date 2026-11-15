/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 RUSSELL PHILIP SMITHSON
 * The renderer's module loader: the engine's CommonJS modules in one page, with the few Node.js built-ins they name
 * (path, crypto, events, os, Buffer, process) provided by the page. fs is not one of them: the Photon host keeps the
 * league, and the page reaches it only through the host's API. Written into workbench.js by tools/bundle.py. */
(function (G) {
  'use strict';
  const D = Object.create(null), J = Object.create(null), cache = Object.create(null);
  /* ---------------- shims ---------------- */
  const P = {
    normalize(p) { const abs = p.startsWith('/'); const out = []; for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); } return (abs ? '/' : '') + out.join('/'); },
    join(...a) { return P.normalize(a.filter(Boolean).join('/')); }, resolve(...a) { return P.normalize('/' + a.join('/')); },
    dirname(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }, basename(p) { return p.slice(p.lastIndexOf('/') + 1); }, sep: '/'
  };
  class Buf extends Uint8Array {
    static alloc(n, fill) { const b = new Buf(n); if (fill) b.fill(fill); return b; }
    static isBuffer(x) { return x instanceof Buf; }
    static byteLength(x) { return typeof x === 'string' ? new TextEncoder().encode(x).length : x.length; }
    static concat(list) { const n = list.reduce((a, b) => a + b.length, 0); const o = new Buf(n); let k = 0; for (const b of list) { o.set(b, k); k += b.length; } return o; }
    static from(x, a, b) {
      if (typeof x === 'string') {
        if (a === 'base64') { const s = atob(x); const o = new Buf(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; }
        if (a === 'hex') { const o = new Buf(x.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(x.substr(i * 2, 2), 16); return o; }
        if (a === 'latin1' || a === 'binary') { const o = new Buf(x.length); for (let i = 0; i < x.length; i++) o[i] = x.charCodeAt(i) & 255; return o; }
        const e = new TextEncoder().encode(x); const o = new Buf(e.length); o.set(e); return o;
      }
      if (x instanceof ArrayBuffer) return new Buf(x, a || 0, b === undefined ? x.byteLength - (a || 0) : b);
      if (ArrayBuffer.isView(x)) { if (a === undefined && b === undefined) { const o = new Buf(x.length); o.set(x); return o; } return new Buf(x.buffer, a, b); }
      if (Array.isArray(x)) return new Buf(x);
      throw new TypeError('Buffer.from: unsupported input');
    }
    toString(enc, s = 0, e = this.length) {
      const v = this.subarray(s, e);
      if (enc === 'hex') return Array.from(v, (x) => x.toString(16).padStart(2, '0')).join('');
      if (enc === 'base64') { let t = ''; for (let i = 0; i < v.length; i += 32768) t += String.fromCharCode.apply(null, v.subarray(i, i + 32768)); return btoa(t); }
      if (enc === 'latin1' || enc === 'binary') { let t = ''; for (const c of v) t += String.fromCharCode(c); return t; }
      return new TextDecoder().decode(v);
    }
    subarray(s, e) { const v = Uint8Array.prototype.subarray.call(this, s, e); return new Buf(v.buffer, v.byteOffset, v.length); }
    slice(s, e) { return Buf.from(Uint8Array.prototype.slice.call(this, s, e)); }
    equals(o) { if (o.length !== this.length) return false; for (let i = 0; i < o.length; i++) if (o[i] !== this[i]) return false; return true; }
    copy(t, ts = 0, s = 0, e = this.length) { t.set(this.subarray(s, e), ts); return e - s; }
    write(str, off = 0, len, enc) { const b = Buf.from(str, enc || 'utf8'); const n = Math.min(b.length, len === undefined ? this.length - off : len); this.set(b.subarray(0, n), off); return n; }
    _dv() { return new DataView(this.buffer, this.byteOffset, this.length); }
    readUInt32LE(o) { return this._dv().getUint32(o, true); } readUInt32BE(o) { return this._dv().getUint32(o, false); }
    writeUInt32LE(v, o) { this._dv().setUint32(o, v >>> 0, true); return o + 4; } writeUInt32BE(v, o) { this._dv().setUint32(o, v >>> 0, false); return o + 4; }
    readUInt16BE(o) { return this._dv().getUint16(o, false); }
    readBigUInt64LE(o) { return this._dv().getBigUint64(o, true); } writeBigUInt64LE(v, o) { this._dv().setBigUint64(o, BigInt(v), true); return o + 8; }
  }
  const T0 = performance.now();
  const proc = { env: {}, pid: 1, versions: {}, platform: 'browser', hrtime: { bigint: () => BigInt(Math.round((performance.now() - T0) * 1e6)) } };
  class EventEmitter { constructor() { this._ev = new Map(); } on(n, f) { if (!this._ev.has(n)) this._ev.set(n, []); this._ev.get(n).push(f); return this; } off(n, f) { const l = this._ev.get(n); if (l) this._ev.set(n, l.filter((x) => x !== f)); return this; } once(n, f) { const g = (...a) => { this.off(n, g); f(...a); }; return this.on(n, g); } emit(n, ...a) { for (const f of (this._ev.get(n) || []).slice()) f(...a); return true; } setMaxListeners() { return this; } listenerCount(n) { return (this._ev.get(n) || []).length; } }
  const FS = { existsSync: () => false, readFileSync: (p) => { throw Object.assign(new Error('ENOENT: the renderer has no file system; the Photon host keeps the league (' + p + ')'), { code: 'ENOENT' }); }, writeFileSync() { throw new Error('the renderer has no file system; the Photon host keeps the league (browser bench'); }, mkdirSync() {}, renameSync() {}, statSync() { throw new Error('ENOENT'); } };
  let hashMod = null;
  const CRYPTO = {
    createHash(alg) {
      hashMod = hashMod || req('rink/shared/hash.js', '/');
      const parts = [];
      return { update(d, enc) { parts.push(typeof d === 'string' ? Buf.from(d, enc || 'utf8') : Buf.from(d)); return this; },
        digest(enc) { const all = Buf.concat(parts); const h = Buf.from(alg === 'sha1' ? hashMod.sha1js(all) : hashMod.sha256js(all)); return enc ? h.toString(enc) : h; } };
    },
    randomBytes(n) { const b = new Buf(n); crypto.getRandomValues(b); return b; }, webcrypto: G.crypto
  };
  const OS = { uptime: () => (performance.now() - T0) / 1000, tmpdir: () => '/tmp', platform: () => 'browser' };
  const BUILTIN = { 'node:fs': FS, 'node:path': P, 'node:crypto': CRYPTO, 'node:events': { EventEmitter }, 'node:os': OS, fs: FS, path: P, crypto: CRYPTO, events: { EventEmitter }, os: OS };
  function resolveId(spec, dir) {
    if (BUILTIN[spec]) return spec;
    let p = spec.startsWith('/') ? P.normalize(spec) : P.join(dir, spec);
    p = p.replace(/^\//, '');
    for (const c of [p, p + '.js', p + '.json']) if (D[c] || J[c]) return c;
    throw new Error('workbench loader: cannot resolve ' + spec + ' from ' + dir);
  }
  function req(spec, dir) {
    const id = resolveId(spec, dir);
    if (BUILTIN[id]) return BUILTIN[id];
    if (J[id]) return J[id];
    if (cache[id]) return cache[id].exports;
    const module = { exports: {} }; cache[id] = module;
    const d = '/' + P.dirname(id);
    D[id].call(module.exports, module, module.exports, (s) => req(s, d), d, '/' + id);
    return module.exports;
  }
  G.Buffer = G.Buffer || Buf; G.process = G.process || proc;
  G.setImmediate = G.setImmediate || ((f, ...a) => setTimeout(f, 0, ...a));
  G.EngineRequire = (id) => req(id, '/');
  /*MODULES*/
})(self);
