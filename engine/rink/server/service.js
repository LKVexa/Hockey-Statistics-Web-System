'use strict';
/**
 * RINK-VT service: the league's single source of truth, living on the gateway's event loop.
 *   registry (teams, rosters, games, notes) · one GameActor per game · one SSD-RAM ledger per game
 *   roles: rink.score (submit frames, lineups, clock, new games) · rink.query (Q, box, HK001 cases, heat)
 *          rink.admin (registry changes, simulation, ledger verify) — admin implies score implies query
 *   tenancy: a principal whose tenant is four letters is a CLUB tenant: it scores only that club's games (none at
 *            all while no such team is registered) and sees only its own notes; any other tenant is league
 *            staff. rink.admin sees every note.
 * Ledger entries are pairs of 64-byte lines: the frame exactly as received, then a meta line (operator,
 * source, received time, CRC32C), so a restart replays every UNDO against the right operator.
 *
 * Hardening (2.2): every argument a client sends is type-checked here before it reaches the registry or an
 * actor; the text other operators see for a line is derived from the accepted frames, never from the client;
 * frames stamped ahead of the server clock are refused; a damaged game ledger quarantines that game instead of
 * stopping the service; one process at a time owns a data directory; league-wide answers are cached per epoch.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Registry, cleanText, isoDate } = require('./registry');
const { seedRegistry } = require('./demo');
const { GameActor, AuditEntry } = require('./actor');
const { FrameLedger } = require('./ssdram');
const { QueryEngine } = require('./query');
const { buildCase } = require('./hkbridge');
const { simulateGame, schedule } = require('./sim');
const { Driver } = require('./driver');
const { RosterImporter } = require('./importer');
const wire = require('../shared/wire');
const codes = require('../shared/codes');
const OT = require('./overtime');

const VERSION = 'rink-vt/1.3';
const META_MAGIC = 0x31544d43;            // "CMT1"
const SOURCES = ['terminal', 'web', 'sim', 'replay', 'api', 'test'];
const LIST_MAX = 500;                     // games sent in one list (hello, games); `total` says how many exist
const PAGE = 100;                         // teams in one reply (teams, refs): a reply to a terminal is at most 60 000 characters

class RinkError extends Error { constructor(code, message) { super(message); this.code = code; } }
const deny = (cap) => { throw new RinkError('FORBIDDEN', `this needs the ${cap} capability`); };
/* ---- argument normalisers: a client may send any JSON value where a name or a number is expected ---- */
const str = (v, max = 64) => (typeof v === 'string' ? v.slice(0, max).replace(/[\u0000-\u001f\u007f-\u009f]/g, '') : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const upper = (v, max = 8) => str(v, max).toUpperCase();
const intArg = (v, def, lo, hi) => { const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d{1,9}$/.test(v) ? Number(v) : NaN; return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.trunc(n))) : def; };
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const bad = (message) => new RinkError('BAD_REQUEST', message);
/** registry validation errors are the caller's mistake, not a server fault */
const asRequest = (fn) => { try { return fn(); } catch (e) { if (e instanceof RinkError) throw e; if (e && ['NOT_FOUND', 'FORBIDDEN', 'BUSY'].includes(e.code)) throw new RinkError(e.code, e.message); throw bad(e.message); } };
/** a query's usage error (a plain Error) is the caller's mistake too — also when the answer is a promise */
const usage = (e) => { if (e && !e.code && e.constructor === Error) e.code = 'BAD_REQUEST'; throw e; };
const asQuery = (fn) => { let r; try { r = fn(); } catch (e) { usage(e); } return r && typeof r.then === 'function' ? r.catch(usage) : r; };

/** operator identity as stored in the 32-byte meta field (and used live, so replay matches exactly) */
function operatorId(sub) {
  const s = String(sub || 'operator').replace(/[^\x21-\x7e]/g, '_');
  return s.length <= 32 ? s : s.slice(0, 20) + '~' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 11);
}
/** a client's static loopback address (2.5), or null: only 127.x.y.z is ever recorded */
function loopbackOf(v) { return typeof v === 'string' && /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(v) && v.split('.').every((o) => Number(o) <= 255) ? v : null; }
/** meta line: magic · index · received (ns) · source · operator (32 bytes) · loopback address (4 bytes, 2.5; zero = not recorded) · 4 spare · CRC32C */
function metaLine(index, meta) {
  const b = Buffer.alloc(64); b.writeUInt32LE(META_MAGIC, 0); b.writeUInt32LE(index >>> 0, 4); b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(meta.receivedNs || wire.nowNs())), 8);
  b.write(String(SOURCES.indexOf(meta.source) >= 0 ? SOURCES.indexOf(meta.source) : 4), 16, 4, 'latin1');
  b.write(operatorId(meta.operator), 20, 32, 'latin1');
  const local = loopbackOf(meta.local); if (local) local.split('.').forEach((o, i) => { b[52 + i] = Number(o); });
  b.writeUInt32LE(wire.crc32c(b, 60), 60);
  return b;
}
function parseMeta(u8) {
  const b = Buffer.from(u8.buffer, u8.byteOffset, 64);
  if (b.readUInt32LE(0) !== META_MAGIC || b.readUInt32LE(60) !== wire.crc32c(b, 60)) return null;
  const src = Number(b.toString('latin1', 16, 20).replace(/\0+$/, ''));
  return { index: b.readUInt32LE(4), receivedNs: b.readBigUInt64LE(8), source: SOURCES[src] || 'api', operator: operatorId(b.toString('latin1', 20, 52).replace(/\0+$/, '')), local: b[52] === 127 ? `${b[52]}.${b[53]}.${b[54]}.${b[55]}` : null };
}

/* ---- one process per data directory ---- */
const bootMs = () => Date.now() - Math.round(os.uptime() * 1000);
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function takeLock(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'LOCK');
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    // held only by a live process of THIS boot: after a reboot (or a crash) the file is stale and is taken over
    if (Number.isInteger(cur.pid) && cur.pid !== process.pid && Math.abs((cur.boot || 0) - bootMs()) < 120000 && alive(cur.pid)) throw new RinkError('LOCKED', `the RINK data directory is in use by process ${cur.pid} (started ${cur.at}); two services writing the same ledgers would corrupt them. Stop that process, or delete the LOCK file there if it is gone.`);
  } catch (e) { if (e instanceof RinkError) throw e; /* no lock, or an unreadable one: take it */ }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, boot: bootMs(), at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return file;
}
function dropLock(file) { try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (cur.pid === process.pid) fs.rmSync(file, { force: true }); } catch { /* already gone */ } }

class RinkService extends EventEmitter {
  /**
   * @param {object} o
   * @param {string|null} o.dir            data directory (registry + ledgers); null = memory only (volatile)
   * @param {boolean} [o.seed=true]        seed the four demonstration clubs when the registry is empty
   * @param {number} [o.maxGames=1000]     games the league may hold (about 1 MiB of heap each)
   * @param {number} [o.maxFrames=20000]   accepted frames per game
   * @param {number} [o.maxSkewMs=5000]    how far ahead of the server clock a frame's commit time may be
   * @param {object} [o.registryData]      memory only: a league to start from (the parsed registry.json of a store)
   * @param {(game:object)=>Uint8Array[]} [o.preload]  memory only: the stored ledger entries of a game, replayed when it opens
   * @param {string} [o.startRule]         'frame': games created here are under the start-frame rule (GO refused until START)
   * @param {string} [o.store]             memory only: where the host that runs this service keeps the league durably;
   *                                       the service then reports its ledger as durable, in these words
   */
  constructor({ dir = null, seed = true, log = null, cachePages = 16, logLines = 64, maxGames = 1000, maxFrames = 20000, maxSkewMs = 5000, importDirs = [], importMaxBytes = 4 * 1024 * 1024, registryData = null, preload = null, store = null, startRule = null } = {}) {
    super();
    this.setMaxListeners(0);              // one listener per terminal session and feed; they are capped elsewhere
    this.dir = dir; this.seed = seed; this.log = log || { info() {}, warn() {}, error() {} };
    // A host that keeps the league itself (the LK/Vexa edition's Photon control plane) runs the service in memory and
    // hands it the league it stored: the registry here, each game's ledger entries when the game opens.
    if ((registryData || preload || store) && dir) throw new Error('registryData, preload and store are for a service in memory (no dir)');
    this.store = store ? String(store) : null;
    this.startRule = startRule === 'frame' ? 'frame' : null;   // games created here start only with START
    this.registryData = registryData; this.preload = typeof preload === 'function' ? preload : null;
    this.ledgerOpts = { cachePages, logLines };
    this.maxGames = maxGames; this.maxFrames = maxFrames; this.maxSkewNs = BigInt(Math.max(0, Math.round(maxSkewMs))) * 1000000n;
    this.games = new Map(); this.damaged = new Map();
    this.importer = new RosterImporter({ registry: () => this.registry, dirs: importDirs, maxBytes: importMaxBytes, log: this.log });
    this.registry = null; this.q = null; this.started = null;
    this.epoch = 0;                        // bumps whenever anything a league-wide query reads has changed
    this.closed = false; this.simulating = false; this.lockFile = null;
    this.counters = { lines: 0, frames: 0, skewRefused: 0 };
  }
  init() {
    const t0 = Date.now();
    if (this.dir) this.lockFile = takeLock(this.dir);
    try {
      this.registry = new Registry({ dir: this.dir ? path.join(this.dir, 'registry') : null });
      if (this.registryData) this.registry.adopt(this.registryData);
      this.registry.limits.games = this.maxGames;
      if (this.registry.recovered) this.log.warn('rink.registry_recovered', { what: this.registry.recovered });
      if (this.seed && !this.registry.teams().length) seedRegistry(this.registry);
      this.q = new QueryEngine(this);
      let frames = 0, rejected = 0;
      for (const g of this.registry.games()) {
        try { const c = this.ctx(g.key); frames += c.replayed.applied; rejected += c.replayed.rejected.length; }
        catch (e) { if (!this.damaged.has(g.key)) throw e; }
      }
      this.started = { at: new Date().toISOString(), games: this.registry.games().length, frames, rejected, damaged: [...this.damaged.keys()], ms: Date.now() - t0, durable: !!this.dir };
      this.log.info('rink.ready', this.started);
      return this.started;
    } catch (e) { if (this.lockFile) { dropLock(this.lockFile); this.lockFile = null; } throw e; }
  }
  ledgerFile(game) { return this.dir ? path.join(this.dir, 'ledger', `${game.key}-${game.uuid.slice(0, 8)}.ssd`) : null; }
  /**
   * The game's actor and ledger (opened and replayed on first use). A ledger that cannot be opened or replayed
   * QUARANTINES its game: the reason is kept, every use of that game answers with it, and the rest of the league
   * keeps running. Nothing is written to a quarantined ledger.
   */
  ctx(key) {
    if (typeof key !== 'string') return null;
    let c = this.games.get(key); if (c) return c;
    const game = this.registry.game(key); if (!game) return null;
    if (this.damaged.has(key)) throw new RinkError('LEDGER', `${key} is quarantined: ${this.damaged.get(key)}`);
    let ledger = null;
    try {
      ledger = new FrameLedger(Object.assign({ file: this.ledgerFile(game), uuid: game.uuid, expectUuid: true }, this.ledgerOpts));
      if (this.preload) for (const b of this.preload(game) || []) ledger.append(b);
      if (ledger.length % 2) throw new Error(`the ledger holds ${ledger.length} lines; entries are pairs (frame + meta line)`);
      const actor = new GameActor(game, this.registry, { maxFrames: this.maxFrames });
      const list = [];
      for (let i = 0; i + 1 < ledger.length; i += 2) {
        const meta = parseMeta(ledger.get(i + 1));
        if (!meta) throw new Error(`meta line ${i + 1} is damaged`);
        list.push({ bytes: ledger.get(i), meta: { operator: meta.operator, source: 'replay', receivedNs: meta.receivedNs, local: meta.local } });
      }
      const replayed = actor.replay(list);
      for (const e of actor.ledger) e.bytes = null;          // the SSD-RAM ledger holds the bytes; keep one copy
      const rec = ledger.recovery;
      if (rec.fallbacks.length) this.log.error('rink.ledger_fallback', { game: key, pages: rec.fallbacks.length, lostLines: rec.fallbacks.reduce((a, f) => a + f.lostLines, 0), note: 'a committed page failed its digest and an older generation was used; acknowledged frames are missing' });
      else if (rec.tornRecords) this.log.warn('rink.ledger_torn_commit', { game: key, records: rec.tornRecords, note: 'an interrupted commit was discarded; nothing acknowledged was lost' });
      if (replayed.rejected.length) this.log.warn('rink.replay_rejections', { game: key, count: replayed.rejected.length, first: replayed.rejected[0] });
      c = { game, actor, ledger, replayed, subscribers: 0 };
      this.games.set(key, c);
      return c;
    } catch (e) {
      if (ledger) { try { if (ledger.fd !== null) { fs.closeSync(ledger.fd); ledger.fd = null; } } catch { /* nothing to release */ } }
      const reason = String(e.message).replace(this.dir ? this.dir + path.sep : '\0', '').slice(0, 300);
      this.damaged.set(key, reason);
      this.log.error('rink.ledger_quarantined', { game: key, reason });
      throw new RinkError('LEDGER', `${key} is quarantined: ${reason}`);
    }
  }
  /** every usable game (quarantined games are left out of league-wide answers) */
  allGames() { const out = []; for (const g of this.registry.games()) { if (this.damaged.has(g.key)) continue; try { out.push(this.ctx(g.key)); } catch { /* quarantined just now */ } } return out; }
  /* ---------------------------------------------------------------- access */
  caps(p) {
    const c = p && p.capabilities && typeof p.capabilities.has === 'function' ? p.capabilities : new Set();
    const admin = c.has('rink.admin'), score = admin || c.has('rink.score'), query = score || c.has('rink.query');
    return { admin, score, query };
  }
  /** A four-letter tenant is a club tenant whether or not that team is registered yet (fail closed). */
  clubOf(p) { const t = p && typeof p.tenant === 'string' ? p.tenant.toUpperCase() : ''; return codes.TEAM_RE.test(t) ? t : null; }
  _scoreGuard(p, game) {
    if (!this.caps(p).score) deny('rink.score');
    const club = this.clubOf(p);
    if (club && game.home !== club && game.away !== club && !this.caps(p).admin) throw new RinkError('FORBIDDEN', `tenant ${club} scores only its own games (${game.key} is ${game.home} vs ${game.away})`);
  }
  /* ---------------------------------------------------------------- the write path */
  /**
   * Apply one command line's frames atomically; persist the accepted ones; notify subscribers.
   * @param {Array<Uint8Array|string>} frames  1-16 frames of 64 bytes (Uint8Array, or base64 text)
   * @returns {{results:Array, scoreboard:object, version:number}}
   */
  submit(p, key, frames, { source = 'terminal', flush = true } = {}) {
    if (this.closed) throw new RinkError('UNAVAILABLE', 'the RINK service is shutting down');
    const c = this.ctx(key); if (!c) throw new RinkError('NOT_FOUND', `no game ${str(key, 24)}`);
    this._scoreGuard(p, c.game);
    if (!Array.isArray(frames) || !frames.length || frames.length > 16) throw bad('a command line is 1 to 16 frames');
    const bytes = frames.map((f) => {
      const u = f instanceof Uint8Array ? f : typeof f === 'string' && f.length <= 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(f) ? Buffer.from(f, 'base64') : null;
      if (!u || u.length !== 64) throw bad('every frame is exactly 64 bytes');
      return Uint8Array.from(u);
    });
    if (!SOURCES.includes(source)) source = 'api';
    const meta = { operator: operatorId(p.sub), source, receivedNs: wire.nowNs(), local: loopbackOf(p.local) };
    // Clock sanity at the trust boundary. A frame latches the scoreboard at its keystroke time, so a commit time
    // ahead of the server clock would latch events into the future and hide every later clock command.
    if (source !== 'sim') {
      for (const b of bytes) {
        const dv = new DataView(b.buffer, b.byteOffset, 64); const onset = dv.getBigUint64(wire.OFFSETS.onset), commit = dv.getBigUint64(wire.OFFSETS.commit);
        let why = null;
        if (onset > commit) why = 'the keystroke time is after the commit time';
        else if (commit > meta.receivedNs + this.maxSkewNs) why = `the frame is stamped ${(Number(commit - meta.receivedNs) / 1e9).toFixed(1)} s ahead of the server clock (limit ${Number(this.maxSkewNs) / 1e9} s); set this computer's clock, or use the server time from the feed's hello`;
        if (why) {
          let f = null; try { f = wire.decode(b); if (f.bad || !f.crcOk) f = null; } catch { f = null; }
          this.counters.skewRefused++; c.actor.audit.push(new AuditEntry(f, meta, 'REJECTED', why)); throw new RinkError('CLOCK_SKEW', why);
        }
      }
    }
    const before = c.actor.ledger.length;
    const results = c.actor.applyGroup(bytes, meta);
    // persist exactly the entries the actor appended to its ledger (accepted, non-duplicate), in order
    const added = c.actor.ledger.slice(before);
    for (const e of added) { c.ledger.append(e.bytes); c.ledger.append(metaLine(e.index, e.meta)); e.bytes = null; }
    if (added.length && flush) c.ledger.flush();
    this.counters.lines++; this.counters.frames += bytes.length;
    if (added.length) this.epoch++;
    const scoreboard = c.actor.scoreboard();
    // what other operators see is what the server accepted, described from the frames (never the client's text)
    const line = added.length ? added.map((e) => wire.describe(e.f)).join(' · ').slice(0, 240) : null;
    if (added.length || results.some((r) => r.status === 'REJECTED')) this.emit('update', { game: key, version: c.actor.version, scoreboard, results, line, operator: meta.operator, source, last: c.actor.state.events.slice(-1)[0] ? c.actor.state.events.slice(-1)[0].text : null });
    return { results, scoreboard, version: c.actor.version, durable: !!this.dir && flush };
  }
  /**
   * A game update as one subscriber may see it. `own` says whether this principal typed the line. Who typed it
   * (the operator id) is for scorers and admins; read-only viewers get the event without the name.
   */
  updateFor(p, u) {
    return { type: 'update', game: u.game, version: u.version, scoreboard: u.scoreboard, line: u.line, own: u.operator === operatorId(p && p.sub), operator: this.caps(p).score ? u.operator : undefined, source: u.source, last: u.last,
      results: (u.results || []).map((r) => ({ status: r.status, error: r.error ? String(r.error).slice(0, 200) : undefined })) };
  }
  /* ---------------------------------------------------------------- ops (worker bridge and /ws/rink) */
  handle(p, op, args = {}) {
    const caps = this.caps(p); args = obj(args);
    const need = (k) => { if (!caps[k]) deny('rink.' + k); };
    switch (op) {
      case 'hello': {
        // Bounded whatever the registry holds: `codes` is every TEAM_4 (what the lexers need), `teams` the first
        // hundred with their names, `games` the newest args.games (a terminal asks for fewer than a dashboard).
        need('query'); const teams = this.registry.teams(); const dmg = [...this.damaged.keys()];
        return { version: VERSION, caps: Object.keys(caps).filter((k) => caps[k]), sub: p.sub, tenant: p.tenant, club: this.clubOf(p), durable: !!this.dir || !!this.store, store: this.store, started: this.started,
          codes: teams.map((t) => t.code).join(' '), teams: teams.slice(0, 100).map((t) => ({ code: t.code, name_en: t.name_en, name_fr: t.name_fr })), totalTeams: teams.length,
          leagues: this.registry.leagues().map((l) => ({ code: l.code, name_en: l.name_en, abbr: l.abbr })), games: this._gameList(intArg(args.games, LIST_MAX, 1, LIST_MAX)), totalGames: this.registry.games().length,
          current: this._defaultGame(p), damaged: dmg.slice(0, 40), damagedTotal: dmg.length, limits: { maxSkewMs: Number(this.maxSkewNs / 1000000n), maxFrames: this.maxFrames, maxGames: this.maxGames } };
      }
      case 'teams': { need('query'); const lg = upper(args.league); if (lg && !this.registry.league(lg)) throw new RinkError('NOT_FOUND', `no league ${lg}`); const all = this.registry.teams().filter((t) => !lg || t.league === lg); const page = intArg(args.page, 1, 1, 1000); return { teams: all.slice((page - 1) * PAGE, page * PAGE), total: all.length, page, league: lg || null }; }
      case 'leagues': { need('query'); const n = new Map(); for (const t of this.registry.teams()) if (t.league) n.set(t.league, (n.get(t.league) || 0) + 1); return { leagues: this.registry.leagues().map((l) => Object.assign({}, l, { teams: n.get(l.code) || 0 })), unassigned: this.registry.teams().filter((t) => !t.league).length }; }
      case 'addleague': { need('admin'); const l = asRequest(() => this.registry.addLeague(args)); this.epoch++; return { league: l }; }
      case 'overtime': {                      // a league's overtime rules: read them, or set or clear them (admin)
        const words = Array.isArray(args.words) ? args.words.slice(0, 16).map((w) => str(w, 40)).filter(Boolean) : [];
        const builtIn = 'built-in: regular season 5:00 3-on-3 overtime, then a shootout of 3 rounds · preseason, playoffs and championship 20:00 5-on-5 sudden-death periods';
        const presets = Object.keys(OT.PRESETS).map((name) => ({ name, text: OT.PRESETS[name].text }));
        const settings = Object.keys(OT.KEYS).map((k) => k + '=');
        const row = (l) => ({ code: l.code, name: l.name_en, rules: l.overtime || null, text: l.overtime ? OT.describe(l.overtime) : builtIn });
        const lg = upper(args.league);
        if (!lg) { need('query'); return { leagues: this.registry.leagues().map(row), builtIn, presets, settings }; }
        const l = this.registry.league(lg); if (!l) throw new RinkError('NOT_FOUND', `no league ${lg}`);
        let changed = false;
        if (words.length) {
          need('admin');
          const clear = words.length === 1 && /^(clear|built-in)$/i.test(words[0]);
          changed = asRequest(() => this.registry.setOvertime(l.code, clear ? null : OT.apply(l.overtime || OT.PRESETS.standard, words)));
          if (changed) this.epoch++;
        } else need('query');
        const existing = this.registry.games().filter((g) => { const o = this.registry.overtimeLeague(g.home, g.away); return !!o && o.code === l.code; }).length;
        return Object.assign(row(l), { changed, existing, builtIn, presets, settings });
      }
      case 'refs': {                        // every four-letter reference: leagues and their teams, or one team's players
        need('query'); const of = upper(args.of); const page = intArg(args.page, 1, 1, 1000);
        const teamRow = (t) => ({ code: t.code, name: t.name_en, league: t.league || '', city: t.city || '', players: this.registry.roster(t.code).length });
        if (!of) { const all = this.registry.teams(); return { leagues: this.registry.leagues().map((l) => ({ code: l.code, name: l.name_en, abbr: l.abbr })), teams: all.slice((page - 1) * PAGE, page * PAGE).map(teamRow), total: all.length, page }; }
        const lg = this.registry.league(of);
        if (lg) { const all = this.registry.teams().filter((t) => t.league === lg.code); return { league: { code: lg.code, name: lg.name_en, abbr: lg.abbr }, teams: all.slice((page - 1) * PAGE, page * PAGE).map(teamRow), total: all.length, page }; }
        const tm = this.registry.team(of); if (!tm) throw new RinkError('NOT_FOUND', `no league or team ${of}`);
        return { team: teamRow(tm), players: this.registry.roster(tm.code).map((x) => ({ code: x.code, jersey: x.jersey, name: x.name, pos: x.pos })) };
      }
      case 'stage': need('admin'); return asRequest(() => this.importer.stage(p, args));
      case 'staged': need('admin'); return { files: this.importer.list(p), folders: this.importer.dirs.length, maxBytes: this.importer.maxBytes, forms: require('./roster-file').EXT };
      case 'import': { need('admin'); const r = asRequest(() => this.importer.run(p, args)); if (r.applied) this.epoch++; return r; }
      case 'roster': need('query'); return asQuery(() => this.q.run('ROSTER', [upper(args.team)]));
      case 'games': { need('query'); const page = intArg(args.page, 1, 1, 100000); return { games: this._gameList(intArg(args.limit, LIST_MAX, 1, LIST_MAX), page), total: this.registry.games().length, page }; }
      case 'game': { need('query'); const c = this.ctx(str(args.key, 24)); if (!c) throw new RinkError('NOT_FOUND', `no game ${str(args.key, 24)}`); return { game: c.game, scoreboard: c.actor.scoreboard() }; }
      case 'newgame': {
        need('score');
        if (this.closed) throw new RinkError('UNAVAILABLE', 'the RINK service is shutting down');
        const club = this.clubOf(p); const home = upper(args.home), away = upper(args.away);
        if (club && home !== club && away !== club && !caps.admin) throw new RinkError('FORBIDDEN', `tenant ${club} can create only its own games`);
        const g = asRequest(() => this.registry.newGame({ home, away, date: args.date === undefined || args.date === null ? undefined : args.date, stage: args.stage === undefined || args.stage === null ? undefined : args.stage, starters: args.starters, start: this.startRule || undefined }));
        this.ctx(g.key); this.epoch++; this.emit('games', { games: this._gameList(), total: this.registry.games().length });
        return { game: g };
      }
      case 'submit': need('score'); return this.submit(p, str(args.game, 24), Array.isArray(args.frames) ? args.frames : [], { source: args.source === 'web' ? 'web' : 'terminal' });
      case 'q': need('query'); return asQuery(() => this.q.run(args.target, args.args, args.flags, typeof args.game === 'string' ? args.game : null, caps));
      case 'hk001case': need('query'); return this.hk001Case(args);
      case 'note': { need('query'); return { note: asRequest(() => this.registry.addNote({ team: upper(args.team), pid: args.pid, text: args.text, tenant: p.tenant, by: p.sub })) }; }
      case 'notes': { need('query'); const team = upper(args.team); return { notes: this.registry.notesFor(p).filter((n) => !team || n.team === team).slice(-50) }; }
      case 'delnote': { need('query'); return { deleted: asRequest(() => this.registry.deleteNote(p, intArg(args.id, -1, -1, 2147483647))).id }; }
      case 'addteam': { need('admin'); const t = asRequest(() => this.registry.addTeam(args)); this.epoch++; return { team: t }; }
      case 'addplayer': { need('admin'); const pl = asRequest(() => this.registry.addPlayer(upper(args.team), args)); this.epoch++; return { player: pl }; }
      case 'ledger': {
        need('query'); const key = str(args.game, 24); const c = this.ctx(key); if (!c) throw new RinkError('NOT_FOUND', `no game ${key}`);
        if (args.action === 'verify') { need('admin'); const v = c.ledger.verify(); const fresh = this.replayCheck(c); return { verify: v, replay: fresh, info: c.ledger.info(), root: v.root, stateDigest: c.actor.stateDigest() }; }
        return { info: c.ledger.info(), root: c.ledger.root(), entries: c.ledger.length / 2, stateDigest: c.actor.stateDigest() };
      }
      case 'simulate': need('admin'); return this.simulate(p, args);
      default: throw bad(`unknown operation ${str(op, 32)}`);
    }
  }
  /** the newest `n` games, oldest first; page 2 is the `n` before those */
  _gameList(n = LIST_MAX, page = 1) {
    const all = this.registry.games(); const out = []; const end = Math.max(0, all.length - (page - 1) * n);
    for (const g of all.slice(Math.max(0, end - n), end)) {
      if (this.damaged.has(g.key)) { out.push({ key: g.key, home: g.home, away: g.away, date: g.date, stage: g.stage, score: { [g.home]: 0, [g.away]: 0 }, period: '—', final: null, events: 0, damaged: true }); continue; }
      try { const sb = this.ctx(g.key).actor.scoreboard(); out.push({ key: g.key, home: g.home, away: g.away, date: g.date, stage: g.stage, score: sb.score, period: sb.periodText, final: sb.final, events: sb.events }); }
      catch { out.push({ key: g.key, home: g.home, away: g.away, date: g.date, stage: g.stage, score: { [g.home]: 0, [g.away]: 0 }, period: '—', final: null, events: 0, damaged: true }); }
    }
    return out;
  }
  _defaultGame(p) {
    const club = this.clubOf(p); const list = this.registry.games().filter((g) => !this.damaged.has(g.key) && (!club || g.home === club || g.away === club));
    for (let i = list.length - 1; i >= 0 && i >= list.length - LIST_MAX; i--) { const c = this.games.get(list[i].key); if (c && !c.actor.state.result) return list[i].key; }
    return (list[list.length - 1] || {}).key || null;
  }
  /** Fresh replay of the persisted ledger into a scratch actor: proves the ledger reproduces the live state. */
  replayCheck(c) {
    const a = new GameActor(c.game, this.registry, { maxFrames: this.maxFrames }); const list = [];
    for (let i = 0; i + 1 < c.ledger.length; i += 2) { const m = parseMeta(c.ledger.get(i + 1)); list.push({ bytes: c.ledger.get(i), meta: { local: m ? m.local : null, operator: m ? m.operator : '?', source: 'replay' } }); }
    const r = a.replay(list);
    return { applied: r.applied, rejected: r.rejected.length, digest: a.stateDigest(), live: c.actor.stateDigest(), equal: a.stateDigest() === c.actor.stateDigest() };
  }
  hk001Case(args) {
    const a = obj(args); const team = upper(a.team); const game = typeof a.game === 'string' && a.game ? a.game.slice(0, 24) : null; const season = a.season === true || a.season === 'true' || a.season === 1;
    if (!this.registry.team(team)) throw bad(`unknown team ${team}`);
    let pool;
    if (season || !game) pool = this.allGames(); else { const c = this.ctx(game); if (!c) throw new RinkError('NOT_FOUND', `no game ${game}`); pool = [c]; }
    pool = pool.map((c) => ({ game: c.game, s: c.actor.state }));
    let featured = null;
    if (a.player !== undefined && a.player !== null && a.player !== '') { const pl = this.registry.resolvePlayer(team, str(a.player, 8)); if (!pl) throw bad(`${team} ${str(a.player, 8)}: no such player`); featured = pl.pid; }
    const label = season || !game ? `season ${pool.length ? pool[0].game.season : ''} (${pool.length} games)` : `game ${game}`;
    return buildCase({ pool, team, featured, lookup: (pid) => this.registry.player(pid), scopeLabel: label });
  }
  /** Type n synthetic games through the production write path (persisted like any other game). Yields to the
   *  event loop between games, so terminal sessions stay responsive while a season is generated. */
  async simulate(p, args) {
    if (!this.caps(p).admin) deny('rink.admin');
    const a = obj(args);
    const n = intArg(a.games, 4, 1, 200); const seed = intArg(a.seed, 2026, 0, 2147483647);
    const stage = a.stage === undefined || a.stage === null ? 'REGULAR' : upper(a.stage, 16);
    const date = a.date === undefined || a.date === null || a.date === '' ? null : asRequest(() => isoDate(a.date, 'the start date', 2000, 2100));
    const teams = this.registry.teams().map((t) => t.code); if (teams.length < 2) throw bad('simulation needs two teams');
    if (this.simulating) throw new RinkError('BUSY', 'a simulation is already running');
    if (this.closed) throw new RinkError('UNAVAILABLE', 'the RINK service is shutting down');
    this.simulating = true;
    try {
      const sched = []; while (sched.length < n) sched.push(...schedule(teams, 2));
      const out = []; let start = BigInt(Date.now() - 86400000 * n) * 1000000n;
      const sim = Object.assign({}, p, { sub: 'simulator' });
      for (let i = 0; i < n && !this.closed; i++) {
        const [home, away] = sched[(this.registry.games().length + i) % sched.length];
        const d = date ? new Date(Date.parse(date + 'T00:00:00Z') + i * 86400000) : new Date(Date.now() - (n - i) * 86400000);
        const g = asRequest(() => this.registry.newGame({ home, away, date: d.toISOString().slice(0, 10), stage, start: this.startRule || undefined }));
        const c = this.ctx(g.key); const drv = new Driver({ operator: 'simulator', source: 'sim' });
        const r = simulateGame({ game: g, registry: this.registry, seed: (seed + i * 7919) >>> 0, startNs: start, state: () => c.actor.state,
          type: (line, onset) => { drv.at(onset); const { ast, frames } = drv.frames(line, g); if (!frames.length) return { ast, results: [] }; return this.submit(sim, g.key, frames, { source: 'sim', flush: false }); } });
        c.ledger.flush();
        await new Promise((res) => setImmediate(res));
        start = r.endNs + 3600n * 1000000000n;
        out.push({ key: g.key, home, away, score: r.score, result: r.result && r.result.decidedIn, lines: r.lines, rejected: r.rejected.length });
      }
      this.epoch++;
      this.emit('games', { games: this._gameList(), total: this.registry.games().length });
      return { simulated: out, note: 'synthetic games typed through the production command path (fictional data)' };
    } finally { this.simulating = false; }
  }
  /** Bounded, label-free numbers for the gateway's /live. */
  stats() {
    let frames = 0; for (const c of this.games.values()) frames += c.actor.ledger.length;
    return { games: this.registry ? this.registry.games().length : 0, loaded: this.games.size, quarantined: this.damaged.size, frames, epoch: this.epoch, lines: this.counters.lines, framesSubmitted: this.counters.frames, skewRefused: this.counters.skewRefused, queryCache: this.q ? Object.assign({ entries: this.q.cache.size }, this.q.stats) : null };
  }
  close() {
    this.closed = true;
    for (const c of this.games.values()) { try { c.ledger.close(); } catch (e) { this.log.warn('rink.ledger_close', { reason: e.message }); } }
    if (this.lockFile) { dropLock(this.lockFile); this.lockFile = null; }
  }
}
module.exports = { RinkService, RinkError, operatorId, metaLine, parseMeta, loopbackOf, VERSION, cleanText };
