'use strict';
/**
 * SSD-RAM frame ledger — the Plume SSD-RAM-XPU storage design (page cache + double-buffered cacheline write log
 * + out-of-place slots + 64-byte SHA-256 records) applied to the 64-byte RINK wire frame: one frame is exactly one
 * cacheline, 64 frames fill one 4 KiB page. One file per game.
 *
 *   header      page 0: magic "RINKVT-SSDRAM/1", geometry, game uuid, created, CRC32C
 *   segment s   1 record page + 64 data slots = 32 logical pages × 2 slots (out-of-place: generation g of a
 *               page lives in slot g mod 2; its record lives in record slot g mod 2 of the pair)
 *   record      64 bytes: magic "CPR1", page, generation, lines, SHA-256(page), frames-at-commit, CRC32C
 *
 * Write path: append() puts the frame in the active half of a double-buffered cacheline log (two-level index
 * page → line → log slot). When the active half fills, the halves swap and the frozen half is compacted: every
 * page with logged lines is written once, to its other slot, then fsynced, then its records are written and
 * fsynced — one page at a time, in page order, so the records that reach the medium are always a prefix (a later
 * page is never committed before an earlier one). A crash at any point leaves the previous generation's record
 * pointing at the previous, intact slot.
 * flush() compacts both halves (group commit). Read path: active log → frozen log → page cache (clock eviction) →
 * disk, and every page read from disk is checked against its record's digest (as Plume checks every frame).
 * Memory mode (no file) keeps the same structures with a Map standing in for the medium.
 * root() is content-addressed: SHA-256("RINKVT-SSDRAM-ROOT/1\0" ‖ u64 frames ‖ SHA-256(page_0) ‖ …), so it does not
 * depend on how often pages were rewritten, and memory and file ledgers holding the same frames agree.
 *
 * Opening reports what it had to do in `recovery`: torn records (an interrupted commit: nothing acknowledged was
 * lost) and fallbacks (a committed generation whose data no longer matches its record: the page was read from
 * the previous generation and `lostLines` acknowledged lines are gone). The service logs both.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { crc32c } = require('../shared/wire');

const PAGE = 4096, LINE = 64, LINES = PAGE / LINE, SEG_PAGES = 32, SEG_BYTES = PAGE * (1 + 2 * SEG_PAGES);
const MAGIC = Buffer.from('RINKVT-SSDRAM/1\0', 'latin1');         // 16 bytes
const REC_MAGIC = 0x31525043;                                    // "CPR1" little-endian
const ROOT_PREFIX = Buffer.from('RINKVT-SSDRAM-ROOT/1\0', 'latin1');
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const ZERO_PAGE_DIGEST = sha(Buffer.alloc(PAGE));

function recOff(L) { const s = Math.floor(L / SEG_PAGES), k = L % SEG_PAGES; return PAGE + s * SEG_BYTES + k * 2 * LINE; }
function slotOff(L, gen) { const s = Math.floor(L / SEG_PAGES), k = L % SEG_PAGES; return PAGE + s * SEG_BYTES + PAGE + (2 * k + (gen & 1)) * PAGE; }

class FrameLedger {
  /**
   * @param {object} o
   * @param {string|null} o.file       ledger file (null = memory mode)
   * @param {string} [o.uuid]          game uuid recorded in the header
   * @param {number} [o.cachePages=16] page-cache slots
   * @param {number} [o.logLines=64]   cachelines per log half
   */
  constructor({ file = null, uuid = '00000000-0000-0000-0000-000000000000', cachePages = 16, logLines = 64, expectUuid = false } = {}) {
    // entries are appended in pairs (frame + meta line); an even log half keeps a pair inside one group commit
    if (!Number.isInteger(logLines) || logLines < 2 || logLines % 2 !== 0 || logLines > 65536) throw new Error('logLines must be an even number from 2 to 65536');
    if (!Number.isInteger(cachePages) || cachePages < 1 || cachePages > 65536) throw new Error('cachePages must be 1 to 65536');
    if (typeof uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) throw new Error('the ledger uuid must be a lower-case UUID');
    this.file = file; this.uuid = uuid; this.cachePages = cachePages; this.logLines = logLines; this.expectUuid = !!expectUuid;
    this.recovery = { tornRecords: 0, fallbacks: [] };
    this.fd = null; this.mem = file ? null : new Map();
    this.pages = [];                       // per logical page: { gen, lines, digest }
    this.count = 0;                        // frames
    this.stats = { appends: 0, logHits: 0, cacheHits: 0, misses: 0, pagesRead: 0, pagesWritten: 0, recordsWritten: 0, compactions: 0, fsyncs: 0, verified: 0, verifyErrors: 0, recovered: 0, compactMs: 0 };
    this.cache = { buf: Buffer.alloc(cachePages * PAGE), key: new Int32Array(cachePages).fill(-1), ref: new Uint8Array(cachePages), map: new Map(), hand: 0 };
    this.act = this._mkLog(); this.frz = this._mkLog();
    if (file) this._open();
  }
  _mkLog() { return { data: Buffer.alloc(this.logLines * LINE), n: 0, idx: new Map() }; }

  /* ---------------------------------------------------------------- medium */
  _read(off, len) {
    if (this.mem) { const b = this.mem.get(off); return b ? Buffer.from(b) : Buffer.alloc(len); }
    const b = Buffer.alloc(len); let got = 0;
    while (got < len) { const n = fs.readSync(this.fd, b, got, len - got, off + got); if (!n) break; got += n; }
    return b;
  }
  _write(off, buf) {
    if (this.mem) { this.mem.set(off, Buffer.from(buf)); return; }
    let put = 0; while (put < buf.length) { const n = fs.writeSync(this.fd, buf, put, buf.length - put, off + put); if (!n) throw new Error(`ledger ${this.file}: the disk accepted no bytes at ${off + put}`); put += n; }
  }
  _sync() { if (this.fd !== null) { fs.fdatasyncSync(this.fd); this.stats.fsyncs++; } }

  _header() {
    const h = Buffer.alloc(PAGE); MAGIC.copy(h, 0);
    h.writeUInt32LE(1, 16); h.writeUInt32LE(PAGE, 20); h.writeUInt32LE(LINE, 24); h.writeUInt32LE(SEG_PAGES, 28);
    Buffer.from(this.uuid.replace(/-/g, ''), 'hex').copy(h, 32);
    h.writeBigUInt64LE(BigInt(Date.now()) * 1000000n, 48);
    h.writeUInt32LE(crc32c(h, 60), 60);
    return h;
  }
  _open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const fresh = !fs.existsSync(this.file) || fs.statSync(this.file).size < PAGE;
    this.fd = fs.openSync(this.file, fresh ? 'w+' : 'r+', 0o600);
    if (fresh) {
      this._write(0, this._header()); this._sync();
      // make the new file's directory entry durable too (a directory cannot be opened on Windows: best effort)
      let d; try { d = fs.openSync(path.dirname(this.file), 'r'); fs.fsyncSync(d); } catch { /* best effort */ } finally { if (d !== undefined) try { fs.closeSync(d); } catch { /* noop */ } }
      return;
    }
    const h = this._read(0, PAGE);
    if (!h.subarray(0, 16).equals(MAGIC)) throw new Error(`${this.file} is not a RINK-VT SSD-RAM ledger`);
    if (h.readUInt32LE(60) !== crc32c(h, 60)) throw new Error(`${this.file}: header checksum mismatch`);
    if (h.readUInt32LE(20) !== PAGE || h.readUInt32LE(24) !== LINE || h.readUInt32LE(28) !== SEG_PAGES) throw new Error(`${this.file}: unsupported geometry`);
    const headerUuid = [h.subarray(32, 36), h.subarray(36, 38), h.subarray(38, 40), h.subarray(40, 42), h.subarray(42, 48)].map((b) => b.toString('hex')).join('-');
    if (this.expectUuid && headerUuid !== this.uuid) throw new Error(`${this.file} belongs to ${headerUuid}, not ${this.uuid} (a ledger file was renamed or copied over another game's)`);
    this.uuid = headerUuid;
    // Scan every record pair in the file. For each page take the newest generation whose data matches its record
    // (a torn record fails its CRC, a torn or damaged data slot fails its digest; both fall back to the previous
    // generation, which an out-of-place write never touches). The ledger is the contiguous run of pages; a short
    // page followed by later committed pages means frames in the middle are gone, and opening refuses.
    const size = fs.fstatSync(this.fd).size; const found = [];
    for (let L = 0; recOff(L) + 2 * LINE <= size; L++) {
      const pair = this._read(recOff(L), 2 * LINE);
      const raw = [0, 1].map((i) => pair.subarray(i * LINE, i * LINE + LINE));
      const cands = raw.map((r) => this._parseRec(r, L)).filter(Boolean).sort((a, b) => b.gen - a.gen);
      const torn = raw.filter((r) => !this._parseRec(r, L) && r.some((b) => b !== 0)).length;
      if (!cands.length) {
        // no valid record for this page: the ledger ends here — unless a LATER page is committed, which would mean a
        // damaged page in the middle (refuse rather than silently dropping frames)
        if (torn) {
          for (let M = L + 1; recOff(M) + 2 * LINE <= size; M++) { const pr = this._read(recOff(M), 2 * LINE); if ([0, 1].some((i) => this._parseRec(pr.subarray(i * LINE, i * LINE + LINE), M))) throw new Error(`${this.file}: page ${L} has no valid record but page ${M} is committed; refusing to open (restore from a backup)`); }
          this.stats.recovered++; this.recovery.tornRecords += torn;
        }
        break;
      }
      let chosen = null;
      for (const c of cands) {
        const pg = this._read(slotOff(L, c.gen), PAGE);
        if (sha(pg).equals(c.digest)) { chosen = c; break; }
        this.stats.verifyErrors++;
      }
      if (!chosen) throw new Error(`${this.file}: page ${L} has no generation whose data matches its record (restore this game's ledger from a backup)`);
      if (chosen !== cands[0] || torn) this.stats.recovered++;
      if (torn) this.recovery.tornRecords += torn;
      // a COMMITTED generation that fails its digest is damage, not a crash: say how much was lost
      if (chosen !== cands[0]) this.recovery.fallbacks.push({ page: L, fromGeneration: cands[0].gen, toGeneration: chosen.gen, lostLines: Math.max(0, cands[0].lines - chosen.lines) });
      found.push(chosen);
    }
    let L = 0;
    for (; L < found.length; L++) {
      const c = found[L]; this.pages[L] = { gen: c.gen, lines: c.lines, digest: c.digest }; this.count = L * LINES + c.lines;
      if (c.lines < LINES) break;
    }
    if (L < found.length - 1) {
      const lost = found.slice(L + 1).reduce((a, c) => a + c.lines, 0) + (LINES - found[L].lines);
      throw new Error(`${this.file}: page ${L} fell back to a generation holding ${found[L].lines} of ${LINES} frames while ${found.length - L - 1} later page(s) are committed — about ${lost} frames would be lost; refusing to open (restore from a backup)`);
    }
  }
  _parseRec(r, L) {
    if (r.readUInt32LE(0) !== REC_MAGIC || r.readUInt32LE(60) !== crc32c(r, 60) || r.readUInt32LE(4) !== L) return null;
    return { gen: r.readUInt32LE(8), lines: r.readUInt32LE(12), digest: Buffer.from(r.subarray(16, 48)), frames: Number(r.readBigUInt64LE(48)) };
  }
  _rec(L, gen, lines, digest, frames) {
    const r = Buffer.alloc(LINE);
    r.writeUInt32LE(REC_MAGIC, 0); r.writeUInt32LE(L, 4); r.writeUInt32LE(gen, 8); r.writeUInt32LE(lines, 12); digest.copy(r, 16);
    r.writeBigUInt64LE(BigInt(frames), 48); r.writeUInt32LE(crc32c(r, 60), 60);
    return r;
  }

  /* ---------------------------------------------------------------- cache + log */
  _logFind(Lg, L, off) { const l2 = Lg.idx.get(L); return l2 === undefined ? undefined : l2.get(off); }
  _cacheFill(L) {
    const c = this.cache;
    while (c.ref[c.hand]) { c.ref[c.hand] = 0; c.hand = (c.hand + 1) % this.cachePages; }
    const slot = c.hand; c.hand = (c.hand + 1) % this.cachePages;
    if (c.key[slot] >= 0) c.map.delete(c.key[slot]);
    const dst = c.buf.subarray(slot * PAGE, slot * PAGE + PAGE);
    const meta = this.pages[L];
    if (meta) {
      const pg = this._read(slotOff(L, meta.gen), PAGE); this.stats.pagesRead++;
      this.stats.verified++;
      if (!sha(pg).equals(meta.digest)) { this.stats.verifyErrors++; throw new Error(`ledger page ${L} (generation ${meta.gen}) does not match its record`); }
      pg.copy(dst);
    } else dst.fill(0);
    for (const Lg of [this.frz, this.act]) { const l2 = Lg.idx.get(L); if (l2) for (const [off, ls] of l2) Lg.data.copy(dst, off * LINE, ls * LINE, ls * LINE + LINE); }
    c.key[slot] = L; c.ref[slot] = 1; c.map.set(L, slot);
    return slot;
  }
  _compact(Lg) {
    if (!Lg.n) return;
    const t0 = process.hrtime.bigint(); const writes = [];
    for (const [L, l2] of Lg.idx) {
      const slot = this.cache.map.get(L); let pg;
      if (slot !== undefined) pg = Buffer.from(this.cache.buf.subarray(slot * PAGE, slot * PAGE + PAGE));
      else {
        const meta = this.pages[L]; pg = meta ? this._read(slotOff(L, meta.gen), PAGE) : Buffer.alloc(PAGE);
        if (meta) { this.stats.pagesRead++; if (!sha(pg).equals(meta.digest)) throw new Error(`ledger page ${L} does not match its record`); }
        for (const [off, ls] of l2) Lg.data.copy(pg, off * LINE, ls * LINE, ls * LINE + LINE);
      }
      const prev = this.pages[L]; const gen = prev ? prev.gen + 1 : 1;
      // frames are never all-zero (UUIDv7 + CRC32C), so the page's used lines are its non-zero prefix
      let lines = 0; for (let i = LINES - 1; i >= 0; i--) { if (pg.subarray(i * LINE, i * LINE + LINE).some((b) => b !== 0)) { lines = i + 1; break; } }
      lines = Math.max(lines, prev ? prev.lines : 0);
      writes.push({ L, gen, pg, lines, digest: sha(pg) });
    }
    writes.sort((a, b) => a.L - b.L);
    for (const w of writes) { this._write(slotOff(w.L, w.gen), w.pg); this.stats.pagesWritten++; }
    this._sync();                                                       // data before records
    // Records in page order, each made durable before the next is written: whatever subset of this commit
    // survives a power cut is a prefix, so a page is never committed while an earlier page fell back.
    for (let i = 0; i < writes.length; i++) {
      const w = writes[i];
      const frames = Math.min(this.count, w.L * LINES + w.lines);
      this._write(recOff(w.L) + (w.gen & 1) * LINE, this._rec(w.L, w.gen, w.lines, w.digest, frames)); this.stats.recordsWritten++;
      this.pages[w.L] = { gen: w.gen, lines: w.lines, digest: w.digest };
      this._sync();
    }
    Lg.idx.clear(); Lg.n = 0; this.stats.compactions++;
    this.stats.compactMs += Number(process.hrtime.bigint() - t0) / 1e6;
  }

  /* ---------------------------------------------------------------- API */
  get length() { return this.count; }
  /** Append one 64-byte frame; returns its index. Durable after flush(). */
  append(frame) {
    if (!frame || frame.length !== LINE) throw new Error('a ledger entry is exactly one 64-byte frame');
    const n = this.count, L = Math.floor(n / LINES), off = n % LINES;
    if (this.act.n === this.logLines) { this._compact(this.frz); const t = this.frz; this.frz = this.act; this.act = t; }
    const ls = this.act.n++; let l2 = this.act.idx.get(L); if (!l2) this.act.idx.set(L, l2 = new Map()); l2.set(off, ls);
    Buffer.from(frame.buffer, frame.byteOffset, LINE).copy(this.act.data, ls * LINE);
    const slot = this.cache.map.get(L); if (slot !== undefined) Buffer.from(frame.buffer, frame.byteOffset, LINE).copy(this.cache.buf, slot * PAGE + off * LINE);
    this.count++; this.stats.appends++;
    return n;
  }
  /** Read frame n (a fresh 64-byte Uint8Array). */
  get(n) {
    if (!(n >= 0 && n < this.count)) throw new RangeError(`frame ${n} is outside the ledger (0..${this.count - 1})`);
    const L = Math.floor(n / LINES), off = n % LINES; let ls;
    if ((ls = this._logFind(this.act, L, off)) !== undefined) { this.stats.logHits++; return new Uint8Array(this.act.data.subarray(ls * LINE, ls * LINE + LINE)); }
    if ((ls = this._logFind(this.frz, L, off)) !== undefined) { this.stats.logHits++; return new Uint8Array(this.frz.data.subarray(ls * LINE, ls * LINE + LINE)); }
    let slot = this.cache.map.get(L);
    if (slot !== undefined) { this.stats.cacheHits++; this.cache.ref[slot] = 1; } else { this.stats.misses++; slot = this._cacheFill(L); }
    return new Uint8Array(this.cache.buf.subarray(slot * PAGE + off * LINE, slot * PAGE + off * LINE + LINE));
  }
  *frames(from = 0) { for (let n = from; n < this.count; n++) yield this.get(n); }
  /** Group commit: drain both halves of the log and make them durable. */
  flush() { this._compact(this.frz); this._compact(this.act); }
  pending() { return this.act.n + this.frz.n; }
  /** Re-read every committed page from the medium and check it against its record. */
  verify() {
    this.flush();
    const bad = [];
    for (let L = 0; L < this.pages.length; L++) {
      const m = this.pages[L]; const pg = this._read(slotOff(L, m.gen), PAGE); this.stats.verified++;
      if (!sha(pg).equals(m.digest)) { bad.push(L); this.stats.verifyErrors++; }
    }
    return { ok: bad.length === 0, pages: this.pages.length, frames: this.count, bad, root: this.root() };
  }
  /** Content-addressed root digest over all frames (pending lines included). */
  root() {
    const P = Math.ceil(this.count / LINES); const parts = [ROOT_PREFIX, Buffer.alloc(8)];
    parts[1].writeBigUInt64LE(BigInt(this.count));
    for (let L = 0; L < P; L++) {
      const pg = Buffer.alloc(PAGE);
      for (let off = 0; off < LINES && L * LINES + off < this.count; off++) Buffer.from(this.get(L * LINES + off)).copy(pg, off * LINE);
      parts.push(sha(pg));
    }
    return sha(Buffer.concat(parts)).toString('hex');
  }
  bytesOnMedium() { if (this.mem) { let n = 0; for (const b of this.mem.values()) n += b.length; return n; } return fs.fstatSync(this.fd).size; }
  /** `file` is the file NAME only: the host path never leaves the service. */
  info() { return { file: this.file ? path.basename(this.file) : null, memory: !!this.mem, uuid: this.uuid, frames: this.count, pages: this.pages.length, pending: this.pending(), cachePages: this.cachePages, logLines: this.logLines, bytes: this.bytesOnMedium(), stats: Object.assign({}, this.stats), recovery: { tornRecords: this.recovery.tornRecords, fallbacks: this.recovery.fallbacks.slice() } }; }
  close() { if (this.fd !== null) { this.flush(); fs.closeSync(this.fd); this.fd = null; } }
}
module.exports = { FrameLedger, PAGE, LINE, LINES, SEG_PAGES, SEG_BYTES, MAGIC, recOff, slotOff, ZERO_PAGE_DIGEST };
