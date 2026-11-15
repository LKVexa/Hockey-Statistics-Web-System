/**
 * Synchronous SHA-256 / SHA-1 / UUIDv5 for code that must run identically in Node and in a browser page.
 * Node uses node:crypto; a browser uses the compact pure-JS implementations below (FIPS 180-4).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RinkHash = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  let nodeCrypto = null;
  try { if (typeof process !== 'undefined' && process.versions && process.versions.node) nodeCrypto = require('node:crypto'); } catch (_) { nodeCrypto = null; }
  const enc = (s) => (typeof s === 'string' ? new TextEncoder().encode(s) : s instanceof Uint8Array ? s : new Uint8Array(s));
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function pad(m, len64) { const l = m.length; const n = ((l + 9 + 63) >> 6) << 6; const b = new Uint8Array(n); b.set(m); b[l] = 0x80; const dv = new DataView(b.buffer); const bits = l * 8; dv.setUint32(n - 4, bits >>> 0); dv.setUint32(n - 8, Math.floor(bits / 4294967296)); void len64; return b; }
  function sha256js(data) {
    const b = pad(enc(data)); const dv = new DataView(b.buffer); const w = new Uint32Array(64);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    for (let o = 0; o < b.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + 4 * i);
      for (let i = 16; i < 64; i++) { const a = w[i - 15], c = w[i - 2]; const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3); const s1 = ((c >>> 17) | (c << 15)) ^ ((c >>> 19) | (c << 13)) ^ (c >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0; }
      let a = h0, bb = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)); const ch = (e & f) ^ (~e & g); const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)); const mj = (a & bb) ^ (a & c) ^ (bb & c); const t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + bb) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    const out = new Uint8Array(32); const o = new DataView(out.buffer); [h0, h1, h2, h3, h4, h5, h6, h7].forEach((x, i) => o.setUint32(4 * i, x)); return out;
  }
  function sha1js(data) {
    const b = pad(enc(data)); const dv = new DataView(b.buffer); const w = new Uint32Array(80);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476, e0 = 0xc3d2e1f0;
    for (let o = 0; o < b.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + 4 * i);
      for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
      let a = a0, bb = b0, c = c0, d = d0, e = e0;
      for (let i = 0; i < 80; i++) {
        let f, k; if (i < 20) { f = (bb & c) | (~bb & d); k = 0x5a827999; } else if (i < 40) { f = bb ^ c ^ d; k = 0x6ed9eba1; } else if (i < 60) { f = (bb & c) | (bb & d) | (c & d); k = 0x8f1bbcdc; } else { f = bb ^ c ^ d; k = 0xca62c1d6; }
        const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0; e = d; d = c; c = (bb << 30) | (bb >>> 2); bb = a; a = t;
      }
      a0 = (a0 + a) >>> 0; b0 = (b0 + bb) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0; e0 = (e0 + e) >>> 0;
    }
    const out = new Uint8Array(20); const o = new DataView(out.buffer); [a0, b0, c0, d0, e0].forEach((x, i) => o.setUint32(4 * i, x)); return out;
  }
  const sha256 = (data) => (nodeCrypto ? new Uint8Array(nodeCrypto.createHash('sha256').update(enc(data)).digest()) : sha256js(data));
  const sha1 = (data) => (nodeCrypto ? new Uint8Array(nodeCrypto.createHash('sha1').update(enc(data)).digest()) : sha1js(data));
  const sha256hex = (data) => hex(sha256(data));
  const DNS_NS = new Uint8Array([0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]);
  /** RFC 4122 UUIDv5 (spec §4: UUIDv5(DNS_NAMESPACE, name)) */
  function uuidv5(name, ns) {
    const n = enc(name); const m = new Uint8Array(16 + n.length); m.set(ns || DNS_NS); m.set(n, 16);
    const h = sha1(m).slice(0, 16); h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
    const x = hex(h); return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }
  return { sha256, sha1, sha256hex, sha256js, sha1js, uuidv5, hex, DNS_NS };
});
