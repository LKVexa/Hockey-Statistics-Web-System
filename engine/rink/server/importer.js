'use strict';
/**
 * Roster import for the RINK service: where a file comes from, and the preview or the commit of what it holds.
 *
 * A file is named by a path, and one of three things answers to it:
 *   - a file of the terminal's own file system: the terminal sends it in pieces just before it asks for the import
 *     and says so (`staged`); that copy is used for that one request and then dropped (origin "terminal");
 *   - a file the person picked in the browser (POST /api/rink-upload): it waits under its name, and a bare name
 *     (no folder in it) finds it (origin "upload");
 *   - a file under a folder the operator of the gateway named (VWS_RINK_IMPORT_DIR; tools/start-local.js names the
 *     home folder of whoever runs it). The path is resolved, symbolic links included, and must stay inside one of
 *     those folders (origin "host"). Without such a folder the service reads no path of its host at all.
 * Which one answered is in every reply, so a file of the same name in two places is never taken silently.
 *
 * Staged files live in memory, bounded per principal and in total; an upload is dropped after twenty minutes or
 * once imported. Import needs rink.admin, as adding a team or a player by hand does.
 */
const roster = require('./roster-file');
const { plan } = require('./roster-plan');
let fs = null, path = null, os = null;
try { fs = require('node:fs'); path = require('node:path'); os = require('node:os'); } catch { /* the browser bench has no host file system */ }

const TTL_MS = 20 * 60 * 1000, PER_PRINCIPAL = 4, TOTAL_BYTES = 64 * 1024 * 1024, TEAMS_PAGE = 100, PLAYERS_PAGE = 100, SMALL_FILE = 60, REPLY_CHARS = 48000;
const fail = (code, message) => Object.assign(new Error(message), { code });
/** Is `pth` below the folder `root`? On the paths as given (`P` is node:path, or path.win32 / path.posix in tests). */
const under = (P, root, pth) => { const rel = P.relative(root, pth); return rel !== '' && rel !== '..' && !rel.startsWith('..' + P.sep) && !P.isAbsolute(rel); };
const baseName = (p) => String(p).split(/[\\/]/).pop();
const cleanName = (n) => { const b = baseName(n).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim(); if (!b || b.length > 120 || b === '.' || b === '..') throw fail('BAD_REQUEST', 'a file name is needed'); return b; };

class RosterImporter {
  constructor({ registry, dirs = [], maxBytes = roster.LIMITS.bytes, log = null }) {
    this.registry = registry; this.maxBytes = maxBytes; this.log = log || { info() {}, warn() {} };
    this.staged = new Map(); this.stagedBytes = 0; this.last = null;
    this.dirs = []; this.roots = [];                               // dirs: the real paths (shown); roots: each as it was named and as it resolves
    for (const d of dirs) {
      if (!fs || !d) continue;
      try {
        const given = path.resolve(String(d)); const real = fs.realpathSync(given);
        if (!fs.statSync(real).isDirectory()) { this.log.warn('rink.import_dir', { dir: String(d), reason: 'not a folder' }); continue; }
        if (!this.dirs.includes(real)) { this.dirs.push(real); this.roots.push({ given, real }); }
      } catch (e) { this.log.warn('rink.import_dir', { dir: String(d), reason: e.code || e.message }); }
    }
  }
  key(p) { return `${p && p.tenant}\u0000${p && p.sub}`; }
  _forget(e) { this.stagedBytes -= e.bytes.length; if (this.last && this.last.entry === e) this.last = null; }
  _purge() { const now = Date.now(); for (const [k, m] of this.staged) { for (const [n, e] of m) if (now - e.at > TTL_MS) { this._forget(e); m.delete(n); } if (!m.size) this.staged.delete(k); } }
  /** an upload and a terminal's copy of one name are two files: neither replaces the other */
  _slot(via, name) { return `${via === 'terminal' ? 't' : 'u'}:${String(name).toLowerCase()}`; }
  _drop(p, name, via = 'upload') { const m = this.staged.get(this.key(p)); const k = this._slot(via, name); const e = m && m.get(k); if (e) { this._forget(e); m.delete(k); if (!m.size) this.staged.delete(this.key(p)); } }
  /** at most PER_PRINCIPAL files wait for one principal: the oldest makes room */
  _room(p, m) {
    while (m.size >= PER_PRINCIPAL) { const oldest = [...m.values()].sort((a, b) => a.at - b.at)[0]; this._drop(p, oldest.name, oldest.via); m = this.staged.get(this.key(p)); if (!m) break; }
    if (!m) { m = new Map(); this.staged.set(this.key(p), m); }
    return m;
  }
  /** Stage a whole file (the upload endpoint, the bench). */
  stageBytes(p, name, bytes) {
    name = cleanName(name); this._purge();
    if (!roster.isSupported(name)) throw fail('BAD_REQUEST', `${roster.extOf(name) || 'a file without an extension'} is not read; the forms are ${roster.EXT.join(' ')}`);
    if (!bytes || !bytes.length) throw fail('BAD_REQUEST', 'the file is empty');
    if (bytes.length > this.maxBytes) throw fail('BAD_REQUEST', `the file is ${bytes.length} bytes; the limit is ${this.maxBytes}`);
    this._drop(p, name);
    let m = this.staged.get(this.key(p)); if (!m) { m = new Map(); this.staged.set(this.key(p), m); }
    m = this._room(p, m);
    if (this.stagedBytes + bytes.length > TOTAL_BYTES) throw fail('BUSY', 'too many files are waiting to be imported; try again in a few minutes');
    const u8 = Uint8Array.from(bytes); m.set(this._slot('upload', name), { name, bytes: u8, at: Date.now(), total: u8.length, via: 'upload' }); this.stagedBytes += u8.length;
    return { name, bytes: u8.length, complete: true };
  }
  /** Stage a file in pieces (the terminal: a bridge request is small). offset 0 starts the file; each piece follows the last. */
  stage(p, a) {
    const name = cleanName(typeof a.name === 'string' ? a.name : ''); this._purge();
    const total = Number(a.total), offset = Number(a.offset);
    if (!Number.isInteger(total) || total < 1 || total > this.maxBytes) throw fail('BAD_REQUEST', `the file is ${Number.isInteger(total) ? total : '?'} bytes; the limit is ${this.maxBytes}`);
    if (typeof a.data !== 'string' || a.data.length > 80000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw fail('BAD_REQUEST', 'a piece of the file, in base64, is needed');
    const piece = Buffer.from(a.data, 'base64');
    if (!Number.isInteger(offset) || offset < 0 || offset + piece.length > total || !piece.length) throw fail('BAD_REQUEST', 'the piece does not fit the file');
    if (!roster.isSupported(name)) throw fail('BAD_REQUEST', `${roster.extOf(name) || 'a file without an extension'} is not read; the forms are ${roster.EXT.join(' ')}`);
    let m = this.staged.get(this.key(p));
    if (offset === 0) {
      this._drop(p, name, 'terminal'); m = this.staged.get(this.key(p)); if (!m) { m = new Map(); this.staged.set(this.key(p), m); }
      m = this._room(p, m);
      if (this.stagedBytes + total > TOTAL_BYTES) throw fail('BUSY', 'too many files are waiting to be imported; try again in a few minutes');
      m.set(this._slot('terminal', name), { name, bytes: new Uint8Array(total), at: Date.now(), total, have: 0, via: 'terminal' }); this.stagedBytes += total;
    }
    const e = m && m.get(this._slot('terminal', name));
    if (!e || e.have === undefined || e.total !== total || e.have !== offset) throw fail('BAD_REQUEST', 'the pieces are out of order; start again from the first');
    e.bytes.set(piece, offset); e.have += piece.length; e.at = Date.now();
    if (e.have === total) delete e.have;
    return { name, bytes: e.have === undefined ? total : e.have, complete: e.have === undefined };
  }
  /** the uploads of this principal that wait to be imported */
  list(p) { this._purge(); const m = this.staged.get(this.key(p)); return m ? [...m.values()].filter((e) => e.have === undefined && e.via === 'upload').map((e) => ({ name: e.name, bytes: e.total })) : []; }
  /** The bytes a path names. `staged`: the terminal has just sent the file; nothing else may answer for it. */
  source(p, raw, { staged = false } = {}) {
    const asked = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() : '';
    if (!asked || asked.length > 600) throw fail('BAD_REQUEST', 'a file path is needed');
    this._purge();
    const m = this.staged.get(this.key(p));
    if (staged) {
      const e = m && m.get(this._slot('terminal', baseName(asked)));
      if (!e || e.have !== undefined) throw fail('BAD_REQUEST', `${baseName(asked).slice(0, 80)} did not arrive whole; run the command again`);
      return { name: e.name, bytes: e.bytes, origin: 'terminal', entry: e };
    }
    const bare = !/[\\/]/.test(asked) && !asked.startsWith('~'); const up = bare && m ? m.get(this._slot('upload', asked)) : null;
    if (up) return { name: up.name, bytes: up.bytes, origin: 'upload', entry: up };
    if (!roster.isSupported(asked)) throw fail('BAD_REQUEST', `${roster.extOf(asked) || 'a file without an extension'} is not read; the forms are ${roster.EXT.join(' ')}`);
    if (!this.dirs.length) throw fail('NOT_FOUND', `no file ${baseName(asked).slice(0, 80)} has been uploaded by this account, and this service reads no folder of its host (VWS_RINK_IMPORT_DIR is not set)`);
    let want = asked;
    if (/^~(?=$|[\\/])/.test(want)) want = path.join(os.homedir(), want.slice(1));
    // inside a folder means below it: decided on the path as written before the file system is asked anything (a path
    // outside is refused whether or not it exists), and again on what the path resolves to (a link may lead out)
    const outside = () => fail('FORBIDDEN', `${baseName(asked).slice(0, 80)} is outside the folder${this.dirs.length > 1 ? 's' : ''} this service imports from (${this.dirs.join(', ')})`);
    const tries = (path.isAbsolute(want) ? [path.resolve(want)] : this.roots.map((r) => path.resolve(r.real, want))).filter((c) => this.roots.some((r) => under(path, r.real, c) || under(path, r.given, c)));
    if (!tries.length) throw outside();
    for (const cand of tries) {
      let real; try { real = fs.realpathSync(cand); } catch { continue; }
      if (!this.roots.some((r) => under(path, r.real, real))) throw outside();
      let fd; try {
        // asked before it is opened: opening a pipe that nobody writes to would wait for ever, on the gateway's own loop
        if (!fs.statSync(real).isFile()) throw fail('BAD_REQUEST', `${baseName(asked).slice(0, 80)} is not a file`);
        fd = fs.openSync(real, 'r'); const st = fs.fstatSync(fd);
        if (!st.isFile()) throw fail('BAD_REQUEST', `${baseName(asked).slice(0, 80)} is not a file`);
        if (st.size > this.maxBytes) throw fail('BAD_REQUEST', `the file is ${st.size} bytes; the limit is ${this.maxBytes}`);
        const buf = Buffer.alloc(st.size); let got = 0; while (got < st.size) { const n = fs.readSync(fd, buf, got, st.size - got, got); if (!n) break; got += n; }
        return { name: path.basename(real), bytes: new Uint8Array(buf.buffer, buf.byteOffset, got), origin: 'host', entry: null };
      } catch (err) { if (err.code && !/^E[A-Z]+$/.test(err.code)) throw err; throw fail('NOT_FOUND', `${baseName(asked).slice(0, 80)} cannot be read (${err.code || 'error'})`); }
      finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
    }
    throw fail('NOT_FOUND', `no file ${asked.slice(0, 120)} under ${this.dirs.join(', ')}${/^[A-Za-z]:[^\\/]/.test(asked) ? ' (on Windows, put the path in single quotes or write it with forward slashes)' : ''}`);
  }
  /** Preview (the default) or apply. → a view of the plan small enough for one reply. */
  run(p, a) {
    const src = this.source(p, a.path, { staged: a.staged === true });
    try { return this._run(p, a, src); }
    finally { if (src.origin === 'terminal') this._drop(p, src.name, 'terminal'); }    // the terminal's copy answers one request
  }
  _run(p, a, src) {
    // what the file holds is kept for the upload that was read last, so that Apply does not read it again; one
    // model at a time, however many files wait (a model can be several times the size of its file)
    let model = src.origin === 'upload' && this.last && this.last.entry === src.entry ? this.last.model : null;
    if (!model) {
      try { model = roster.read(src.name, src.bytes, { limits: { bytes: this.maxBytes } }); } catch (e) { if (e.code === 'BAD_FILE') throw fail('BAD_REQUEST', `${src.name}: ${e.message}`); throw e; }
      if (src.origin === 'upload') this.last = { entry: src.entry, model };
    }
    const opts = { league: typeof a.league === 'string' ? a.league.slice(0, 80) : '', assignJerseys: a.assignJerseys === true, skipErrors: a.skipErrors === true };
    const file = { name: src.name, bytes: src.bytes.length, origin: src.origin };
    const reg = this.registry(); const STOP = {}; let out = null, n = null;
    // the reply is made inside the transaction: what cannot be shown (a team the file does not have) stops the commit too
    const work = (commit) => {
      const x = plan(reg, model, opts); const refused = commit && x.counts.errors > 0 && !opts.skipErrors;
      out = this.view(x, a, Object.assign({ applied: commit && !refused, refused }, file)); n = x.counts;
      if (refused) throw STOP;
    };
    if (a.apply === true) {
      try { reg.transaction(() => work(true)); } catch (e) { if (e !== STOP) throw e; }
      if (out.applied) { if (src.origin === 'upload') this._drop(p, src.name, 'upload'); this.log.info('rink.import', { by: String(p && p.sub).slice(0, 64), file: src.name.slice(0, 80), origin: src.origin, leagues: n.leagues.new, teams: n.teams.new, players: n.players.new, updated: n.players.updated, errors: n.errors }); }
    } else reg.transaction(() => work(false), { rollback: true });
    return out;
  }
  /** What one reply shows: the leagues, a page of the teams, and the players of a small file, of one team (`show`:
   *  its code or its name) or of all (`show: 'all'`), a page at a time. */
  view(pl, a, file) {
    const page = Math.max(1, Math.min(1000, Number.isInteger(a.page) ? a.page : Number(a.page) > 0 ? Math.floor(Number(a.page)) : 1));
    const show = typeof a.show === 'string' ? a.show.trim().slice(0, 60) : '';
    let list = null, shown = '';
    if (show && show.toLowerCase() !== 'all') {
      const t = pl.teams.find((x) => x.code === show.toUpperCase()) || pl.teams.find((x) => roster.normName(x.name) === roster.normName(show));
      if (!t) throw fail('NOT_FOUND', `the file has no team ${show.slice(0, 40)}${pl.teams.length ? ` (it has ${pl.teams.slice(0, 12).map((x) => x.code).join(' ')}${pl.teams.length > 12 ? ' …' : ''})` : ''}`);
      list = pl.players.filter((x) => x.team === t.code); shown = t.code;
    } else if (show || (pl.players.length && pl.players.length <= SMALL_FILE)) { list = pl.players; shown = 'all'; }
    const tp = list ? 1 : page;
    const out = { file: { name: file.name, bytes: file.bytes, origin: file.origin, format: pl.format }, applied: file.applied, refused: file.refused, counts: pl.counts,
      leagues: pl.leagues.slice(), teams: pl.teams.slice((tp - 1) * TEAMS_PAGE, tp * TEAMS_PAGE), teamsTotal: pl.teams.length, page,
      notes: pl.notes.slice(0, 20), errors: pl.errors.slice(0, 25), warnings: pl.warnings.slice(0, 15) };
    if (list) { out.show = shown; out.players = list.slice((page - 1) * PLAYERS_PAGE, page * PLAYERS_PAGE); out.playersTotal = list.length; }
    // One reply to a terminal is at most 60 000 characters. A page of ordinary names is a third of that; a file of
    // names as long as names may be is shown in less, and says so, rather than failing after it has been applied.
    const fits = () => JSON.stringify(out).length <= REPLY_CHARS;
    if (!fits()) { out.cut = true; out.errors = out.errors.slice(0, 8); out.warnings = out.warnings.slice(0, 4); out.notes = out.notes.slice(0, 8); }
    while (!fits()) {
      const longest = [out.players || [], out.teams, out.leagues].sort((x, y) => y.length - x.length)[0];
      if (longest.length <= 1) break;
      longest.length = Math.ceil(longest.length / 2);
    }
    return out;
  }
}
module.exports = { RosterImporter, under };
