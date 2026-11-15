'use strict';
/**
 * RINK-VT registry: leagues (LEAGUE_4), franchises (TEAM_4), athletes (PLAYER_4 per roster), games and club-private notes.
 * Tier-1 master data in the spec's taxonomy. Stored as one JSON document sealed with a SHA-256
 * (registry.json + registry.sha256, `sha256sum -c` compatible); memory-only when no directory is given.
 *
 * Commit protocol (a crash at any point leaves a registry that opens): write registry.sha256.new (the seal of the
 * NEW text) → write registry.json.<pid>.tmp → fsync both → rename the text over registry.json → rename the seal
 * over registry.sha256 → fsync the directory. load() accepts the text if it matches registry.sha256; if it matches
 * registry.sha256.new instead, the crash fell between the two renames and load() finishes the commit.
 * Everything a client can put here is validated: text fields are plain single-line strings without control
 * characters (they are printed in terminals), dates are real calendar dates, codes cannot be command words.
 * Identity (spec §4): player_uuid = UUIDv5(DNS, "<ns>:player:<SURNAME>:<GIVEN>:<birth>"), stable across trades;
 * game_uuid = UUIDv5(DNS, "<ns>:game:<season>:<key>:<home>:<away>:<date>"); game_id_hash = first 4 bytes of
 * game_uuid (wire frame). <ns> is RINK in a league this build creates. A league keeps the prefix its ids were made
 * with ("ns" in registry.json), so the same person is recognised in a league brought over from an earlier build.
 */
const fs = require('node:fs');
const path = require('node:path');
const hash = require('../shared/hash');
const codes = require('../shared/codes');
const OT = require('./overtime');

const POS = new Set(['C', 'LW', 'RW', 'D', 'G']);
const STAGES = new Set(['PRESEASON', 'REGULAR', 'PLAYOFF', 'CHAMPIONSHIP']);
const SCHEMA = 'rinkvt.registry.v1';
const NS = 'RINK';
const LIMITS = { games: 10000, leagues: 64, teams: 1000, playersPerTeam: 80, notesPerTenant: 1000, noteChars: 2000 };

const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;   // C0, C1, line separators, bidi overrides, BOM
/** Free text that will be printed in a terminal: a string, one line, no control characters, bounded. */
function cleanText(v, max, what, { required = false, multiline = false } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw new Error(`${what} is required`); return ''; }
  if (typeof v !== 'string') throw new Error(`${what} must be text`);
  let t = (multiline ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ') : v.replace(CTRL, ' ')).trim();
  if (!multiline) t = t.replace(/\s+/g, ' ');
  if (!t) { if (required) throw new Error(`${what} is required`); return ''; }
  if ([...t].length > max) throw new Error(`${what} is longer than ${max} characters`);
  return t;
}
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
function personName(v, what) {
  const t = cleanText(v, 40, what, { required: true });
  if (!NAME_RE.test(t)) throw new Error(`${what} may contain letters, spaces, apostrophes, periods and hyphens`);
  return t;
}
/** YYYY-MM-DD that is a real calendar date within [min, max] years. */
function isoDate(v, what, minYear = 1990, maxYear = 2100) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${what} must be YYYY-MM-DD`);
  const t = Date.parse(v + 'T00:00:00Z'); const y = Number(v.slice(0, 4));
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v || y < minYear || y > maxYear) throw new Error(`${what} is not a calendar date between ${minYear} and ${maxYear}`);
  return v;
}
function fsyncPath(p) { let fd; try { fd = fs.openSync(p, 'r'); fs.fsyncSync(fd); } catch { /* directories cannot be opened on Windows; the renames are still atomic */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* noop */ } } }
function writeDurable(file, text) { const fd = fs.openSync(file, 'w', 0o600); try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

class Registry {
  constructor({ dir = null, quotas = { overage: 3, imports: 2 } } = {}) {
    this.dir = dir; this._quotas = quotas;
    this.data = { schema: SCHEMA, leagues: [], teams: [], players: [], games: [], notes: [], seq: { game: 0, note: 0 } };
    this.limits = Object.assign({}, LIMITS);
    this.revision = 0;                       // bumps on every change (cache key for league-wide queries)
    this._index();
    if (dir) this.load();
  }
  _index() {
    this.leaguesBy = new Map(this.data.leagues.map((l) => [l.code, l]));
    this.teamsBy = new Map(this.data.teams.map((t) => [t.code, t]));
    this.playersBy = new Map(this.data.players.map((p) => [p.pid, p]));
    this.gamesBy = new Map(this.data.games.map((g) => [g.key, g]));
    this.gamesByHash = new Map(this.data.games.map((g) => [g.idHash, g]));
    this.rosters = new Map();
    for (const p of this.data.players) { if (!this.rosters.has(p.team)) this.rosters.set(p.team, []); this.rosters.get(p.team).push(p); }
  }
  file() { return this.dir ? path.join(this.dir, 'registry.json') : null; }
  /** The prefix of the names that ids are derived from: this league's own ("ns" in registry.json), else this build's. */
  get ns() { return this.data.ns || NS; }
  /** The name a person's id is derived from. The same name and birth date give the same id, whatever the team. */
  personName(last, first, birth) { return `${this.ns}:player:${codes.ascii(last)}:${codes.ascii(first)}:${birth || '?'}`; }
  playerId(last, first, birth) { return hash.uuidv5(this.personName(last, first, birth)); }
  load() {
    const f = this.file(); if (!f || !fs.existsSync(f)) return false;
    const text = fs.readFileSync(f, 'utf8'); const have = hash.sha256hex(text);
    const sealF = path.join(this.dir, 'registry.sha256'), nextF = sealF + '.new';
    const seal = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split(/\s+/)[0] : null);
    if (fs.existsSync(sealF) && seal(sealF) !== have) {
      // a crash between "rename the text" and "rename the seal" leaves the new text with the old seal: finish it
      if (seal(nextF) === have) { fs.renameSync(nextF, sealF); fsyncPath(this.dir); this.recovered = 'finished an interrupted registry commit'; }
      else throw new Error('registry.json does not match registry.sha256 (edited or damaged); refusing to start');
    } else if (fs.existsSync(nextF)) { try { fs.rmSync(nextF, { force: true }); } catch { /* a stale intent file is harmless */ } }
    let data; try { data = JSON.parse(text); } catch (e) { throw new Error(`registry.json is not valid JSON (${e.message})`); }
    this.adopt(data); return true;
  }
  /** Take a league whose registry.json was parsed elsewhere (a store that keeps it, checks it and seals it). */
  adopt(data) {
    if (!data || typeof data !== 'object' || data.schema !== SCHEMA) {
      // the registry of an earlier build names its own schema: that league is brought over, not opened in place
      const earlier = data && typeof data === 'object' && typeof data.schema === 'string' && /^[a-z]{2,16}\.registry\.v\d+$/.test(data.schema);
      throw Object.assign(new Error(`registry.json has schema ${String(data && data.schema).replace(CTRL, '').slice(0, 64)}; this build reads ${SCHEMA}`), earlier ? { code: 'EARLIER' } : {});
    }
    if (data.ns !== undefined && (typeof data.ns !== 'string' || !/^[A-Z][A-Z0-9]{1,15}$/.test(data.ns))) throw new Error('registry.json: "ns" must be a short upper-case word');
    for (const k of ['teams', 'players', 'games', 'notes']) if (!Array.isArray(data[k])) throw new Error(`registry.json: "${k}" must be a list`);
    if (data.leagues === undefined) data.leagues = [];                 // a registry written before 2.3 has no leagues
    if (!Array.isArray(data.leagues)) throw new Error('registry.json: "leagues" must be a list');
    // overtime rules (2.5.0-lkvexa.3): a league's, and the copy each game keeps, must be rules this build can play
    for (const l of data.leagues) if (l && l.overtime !== undefined) { try { OT.normalize(l.overtime); } catch (e) { throw new Error(`registry.json: league ${String(l.code).replace(CTRL, '').slice(0, 8)}: ${e.message}`); } }
    for (const g of data.games) if (g && g.ot !== undefined) { try { OT.normalize(g.ot); } catch (e) { throw new Error(`registry.json: game ${String(g.key).replace(CTRL, '').slice(0, 24)}: ${e.message}`); } }
    if (!data.seq || typeof data.seq !== 'object') data.seq = {};
    data.seq.game = Math.max(Number(data.seq.game) || 0, data.games.length); data.seq.note = Math.max(Number(data.seq.note) || 0, ...data.notes.map((n) => Number(n.id) || 0), 0);
    this.data = data; this._index(); return this;
  }
  save() {
    this.revision++;
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const text = JSON.stringify(this.data, null, 1) + '\n';
    const tmp = this.file() + '.' + process.pid + '.tmp'; const sealF = path.join(this.dir, 'registry.sha256');
    writeDurable(sealF + '.new', hash.sha256hex(text) + '  registry.json\n');
    writeDurable(tmp, text);
    fs.renameSync(tmp, this.file());
    fs.renameSync(sealF + '.new', sealF);
    fsyncPath(this.dir);
  }
  quotas() { return this._quotas; }
  /* ---------- several changes, one commit ----------
     transaction(fn) runs fn(this): every add and update inside it changes memory only, and one save follows. If fn
     throws, or the save fails, or { rollback: true } asks for a rehearsal, the registry is exactly as it was: the
     new records are dropped and the changed fields put back, on the same objects (games and actors hold them).
     Outside a transaction a change is its own commit. */
  transaction(fn, { rollback = false } = {}) {
    if (this._tx) throw new Error('a registry transaction is already open');
    const mark = { leagues: this.data.leagues.length, teams: this.data.teams.length, players: this.data.players.length };
    const undo = this._tx = []; let out, failed = null;
    try { out = fn(this); } catch (e) { failed = e; }
    this._tx = null;
    const back = () => { for (let i = undo.length - 1; i >= 0; i--) undo[i](); this.data.leagues.length = mark.leagues; this.data.teams.length = mark.teams; this.data.players.length = mark.players; this._index(); };
    if (failed) { back(); throw failed; }
    if (rollback) { back(); return out; }
    try { this.save(); } catch (e) { back(); throw e; }
    return out;
  }
  _commit() { if (!this._tx) this.save(); }
  /** remember a field before it changes inside a transaction */
  _was(o, k) { if (this._tx) { const had = Object.prototype.hasOwnProperty.call(o, k), old = o[k]; this._tx.push(() => { if (had) o[k] = old; else delete o[k]; }); } }
  /* ---------- leagues (LEAGUE_4) ---------- */
  /** League and team codes are one namespace of four-letter words: `KELW` is one thing wherever it is typed. */
  _orgCode(c0, what) {
    const code = typeof c0 === 'string' ? c0.toUpperCase() : ''; codes.teamKey(code);
    if (codes.RESERVED_TEAMS.includes(code)) throw new Error(`${code} is a word of the command language and cannot be a ${what} code`);
    if (this.teamsBy.has(code)) throw new Error(what === 'team' ? `team ${code} already exists` : `${code} is already a team`);
    if (this.leaguesBy.has(code)) throw new Error(what === 'league' ? `league ${code} already exists` : `${code} is already a league`);
    return code;
  }
  _abbr(v) {
    const a = cleanText(v, 12, 'the abbreviation'); if (!a) return '';
    if (!/^[A-Za-z0-9]{1,12}$/.test(a)) throw new Error('the abbreviation is letters and digits, as in WHL');
    return a.toUpperCase();
  }
  addLeague(o) {
    const { code: c0, name_en, name_fr, abbr } = o && typeof o === 'object' ? o : {};
    const code = this._orgCode(c0, 'league');
    if (this.data.leagues.length >= this.limits.leagues) throw new Error(`the registry holds at most ${this.limits.leagues} leagues`);
    const en = cleanText(name_en, 60, 'the English name') || code;
    const l = { code, name_en: en, name_fr: cleanText(name_fr, 60, 'the French name') || en, abbr: this._abbr(abbr) };
    this.data.leagues.push(l); this.leaguesBy.set(code, l); this._commit(); return l;
  }
  /** Change the fields that are given and differ; returns their names. The code is permanent. */
  updateLeague(code, o) {
    const l = this.league(code); if (!l) throw new Error('unknown league');
    const next = { name_en: cleanText(o.name_en, 60, 'the English name'), name_fr: cleanText(o.name_fr, 60, 'the French name'), abbr: this._abbr(o.abbr) };
    const changed = Object.keys(next).filter((k) => next[k] && next[k] !== l[k]);
    for (const k of changed) { this._was(l, k); l[k] = next[k]; }
    if (changed.length) this._commit();
    return changed;
  }
  league(code) { return typeof code === 'string' ? this.leaguesBy.get(code.toUpperCase()) || null : null; }
  /**
   * Set a league's overtime rules (a rule set, overtime.js), or clear them (null): its games then use the built-in
   * rules. Only games created afterwards follow the change; each game keeps the rules it was created under.
   * Returns whether anything changed.
   */
  setOvertime(code, rules) {
    const l = this.league(code); if (!l) throw new Error('unknown league');
    const next = rules === null ? undefined : OT.normalize(rules);
    if (JSON.stringify(next) === JSON.stringify(l.overtime)) return false;
    this._was(l, 'overtime');
    if (next === undefined) delete l.overtime; else l.overtime = next;
    this._commit(); return true;
  }
  /** The league whose overtime rules decide a game between these teams: the home team's, else the away team's. */
  overtimeLeague(home, away) {
    const ht = this.teamsBy.get(home), at = this.teamsBy.get(away);
    const code = ht && ht.league ? ht.league : at && at.league ? at.league : null;
    return code ? this.leaguesBy.get(code) || null : null;
  }
  leagues() { return this.data.leagues.slice(); }
  /* ---------- teams ---------- */
  _teamFields(o) {
    const tz = cleanText(o.timezone, 40, 'the time zone');
    if (tz && !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) throw new Error('the time zone must be an IANA name such as America/Toronto');
    let league = '';
    if (o.league !== undefined && o.league !== null && o.league !== '') { const l = this.league(o.league); if (!l) throw new Error('unknown league'); league = l.code; }
    return { name_en: cleanText(o.name_en, 60, 'the English name'), name_fr: cleanText(o.name_fr, 60, 'the French name'), arena: cleanText(o.arena, 60, 'the arena'), city: cleanText(o.city, 60, 'the city'), timezone: tz, league };
  }
  addTeam(o) {
    o = o && typeof o === 'object' ? o : {};
    const code = this._orgCode(o.code, 'team');
    if (this.data.teams.length >= this.limits.teams) throw new Error(`the registry holds at most ${this.limits.teams} teams`);
    const f = this._teamFields(o); const en = f.name_en || code;
    const t = { code, key: codes.teamKey(code), name_en: en, name_fr: f.name_fr || en, arena: f.arena, timezone: f.timezone || 'America/Toronto' };
    if (f.city) t.city = f.city;
    if (f.league) t.league = f.league;
    this.data.teams.push(t); this.teamsBy.set(code, t); this._commit(); return t;
  }
  /** Change the fields that are given and differ; returns their names. The code is permanent. */
  updateTeam(code, o) {
    const t = this.team(code); if (!t) throw new Error('unknown team');
    const f = this._teamFields(o && typeof o === 'object' ? o : {});
    const changed = Object.keys(f).filter((k) => f[k] && f[k] !== (t[k] || ''));
    for (const k of changed) { this._was(t, k); t[k] = f[k]; }
    if (changed.length) this._commit();
    return changed;
  }
  team(code) { return typeof code === 'string' ? this.teamsBy.get(code.toUpperCase()) || null : null; }
  teams() { return this.data.teams.slice(); }
  /* ---------- players ---------- */
  _jersey(jersey) {
    if (typeof jersey !== 'number' && !(typeof jersey === 'string' && /^\d{1,2}$/.test(jersey))) throw new Error('jersey must be 1..99');
    jersey = Number(jersey); if (!Number.isInteger(jersey) || jersey < 1 || jersey > 99) throw new Error('jersey must be 1..99');
    return jersey;
  }
  /** `scoped`: when the person's identity (name and birth date) is already registered with another team and no
   *  birth date is known, the identity is taken per team instead of refusing: two clubs may each have a John Smith. */
  addPlayer(team, o, { scoped = false } = {}) {
    let { first, last, jersey, pos, shoots, birth, import: imp, code } = o && typeof o === 'object' ? o : {};
    team = typeof team === 'string' ? team.toUpperCase() : ''; if (!this.teamsBy.has(team)) throw new Error('unknown team');
    if (typeof pos !== 'string' || !POS.has(pos)) throw new Error('position must be C, LW, RW, D or G');
    jersey = this._jersey(jersey);
    first = personName(first, 'the first name'); last = personName(last, 'the last name');
    if (!codes.ascii(last)) throw new Error('the last name needs at least one letter A-Z after accents are removed (it becomes the PLAYER_4 code)');
    if (shoots === undefined || shoots === null || shoots === '') shoots = 'L';
    if (shoots !== 'L' && shoots !== 'R') throw new Error('shoots must be L or R');
    if (birth === undefined || birth === null || birth === '') birth = null; else isoDate(birth, 'the birth date', 1950, new Date().getUTCFullYear());
    const roster = this.rosters.get(team) || [];
    if (roster.length >= this.limits.playersPerTeam) throw new Error(`${team} already has ${roster.length} players`);
    if (roster.some((p) => p.jersey === jersey)) throw new Error(`${team} #${jersey} is taken`);
    const taken = new Set(roster.map((p) => p.code));
    if (code !== undefined && code !== null && code !== '') { code = typeof code === 'string' ? code.toUpperCase() : ''; if (!/^[A-Z][A-Z0-9]{3}$/.test(code) || /^J\d/.test(code) || taken.has(code)) throw new Error(`that code is invalid or taken on ${team}`); }
    else code = codes.assignPlayerCode(last, first, jersey, taken);
    const who = this.personName(last, first, birth);
    let pid = hash.uuidv5(who);
    if (this.playersBy.has(pid) && scoped && !birth && this.playersBy.get(pid).team !== team) pid = hash.uuidv5(`${who}@${team}`);
    if (this.playersBy.has(pid)) throw new Error(`${first} ${last} (${birth || 'no birth date'}) is already registered`);
    const p = { pid, team, code, jersey, first, last, name: `${first} ${last}`, pos, shoots, birth, import: imp === true };
    this.data.players.push(p); this.playersBy.set(pid, p);
    if (!this.rosters.has(team)) this.rosters.set(team, []);
    this.rosters.get(team).push(p);
    this._commit(); return p;
  }
  /** Change jersey, position, hand, import flag, and a birth date that was unknown. Identity and code are permanent. */
  updatePlayer(pid, o) {
    const p = this.player(pid); if (!p) throw new Error('unknown player');
    o = o && typeof o === 'object' ? o : {}; const changed = [];
    if (o.jersey !== undefined && o.jersey !== null && o.jersey !== '') {
      const j = this._jersey(o.jersey);
      if (j !== p.jersey) { if ((this.rosters.get(p.team) || []).some((x) => x !== p && x.jersey === j)) throw new Error(`${p.team} #${j} is taken`); this._was(p, 'jersey'); p.jersey = j; changed.push('jersey'); }
    }
    if (o.pos !== undefined && o.pos !== null && o.pos !== '' && o.pos !== p.pos) { if (typeof o.pos !== 'string' || !POS.has(o.pos)) throw new Error('position must be C, LW, RW, D or G'); this._was(p, 'pos'); p.pos = o.pos; changed.push('pos'); }
    if (o.shoots !== undefined && o.shoots !== null && o.shoots !== '' && o.shoots !== p.shoots) { if (o.shoots !== 'L' && o.shoots !== 'R') throw new Error('shoots must be L or R'); this._was(p, 'shoots'); p.shoots = o.shoots; changed.push('shoots'); }
    if (o.birth && !p.birth) { this._was(p, 'birth'); p.birth = isoDate(o.birth, 'the birth date', 1950, new Date().getUTCFullYear()); changed.push('birth'); }
    if (typeof o.import === 'boolean' && o.import !== p.import) { this._was(p, 'import'); p.import = o.import; changed.push('import'); }
    if (changed.length) this._commit();
    return changed;
  }
  /** Several jersey changes on one team, made together, so that two players may trade numbers: [[pid, jersey], …].
   *  All or none: the numbers of the team are unique afterwards or nothing is changed. Returns the pids that changed. */
  renumber(team, pairs) {
    team = typeof team === 'string' ? team.toUpperCase() : ''; const roster = this.rosters.get(team); if (!roster) throw new Error('unknown team');
    const next = new Map();
    for (const [pid, j] of Array.isArray(pairs) ? pairs : []) { const p = this.player(pid); if (!p || p.team !== team) throw new Error('unknown player'); next.set(p, this._jersey(j)); }
    const worn = new Map();
    for (const p of roster) { const j = next.has(p) ? next.get(p) : p.jersey; if (worn.has(j)) throw new Error(`${team} #${j} would be worn by ${worn.get(j).name} and ${p.name}`); worn.set(j, p); }
    const changed = [];
    for (const [p, j] of next) if (j !== p.jersey) { this._was(p, 'jersey'); p.jersey = j; changed.push(p.pid); }
    if (changed.length) this._commit();
    return changed;
  }
  player(pid) { return this.playersBy.get(pid) || null; }
  roster(team) { return (typeof team === 'string' && this.rosters.get(team.toUpperCase()) || []).slice().sort((a, b) => a.jersey - b.jersey); }
  /** TEAM_4 + PLAYER_4 / J91 / 0091 / 91 -> player (O(1) on the code index, spec §3 ROSTER RESOLVE). */
  resolvePlayer(team, token) {
    if (typeof team !== 'string' || (typeof token !== 'string' && typeof token !== 'number')) return null;
    const r = this.rosters.get(team.toUpperCase()); if (!r) return null;
    const t = String(token).toUpperCase();
    const byCode = r.find((p) => p.code === t); if (byCode) return byCode;
    const pt = codes.parsePlayerToken(t);
    if (pt && pt.jersey !== undefined) return r.find((p) => p.jersey === pt.jersey) || null;
    return null;
  }
  ageDays(p, onDate) { if (!p.birth) return null; return Math.floor((Date.parse(onDate) - Date.parse(p.birth)) / 86400000); }
  /* ---------- games ---------- */
  newGame(o) {
    let { home, away, date, stage, starters, key, start } = o && typeof o === 'object' ? o : {};
    home = typeof home === 'string' ? home.toUpperCase() : ''; away = typeof away === 'string' ? away.toUpperCase() : '';
    if (!this.teamsBy.has(home) || !this.teamsBy.has(away) || home === away) throw new Error('a game needs two different registered teams');
    stage = stage === undefined || stage === null || stage === '' ? 'REGULAR' : typeof stage === 'string' ? stage.toUpperCase() : ''; if (!STAGES.has(stage)) throw new Error('stage must be PRESEASON, REGULAR, PLAYOFF or CHAMPIONSHIP');
    date = date === undefined || date === null || date === '' ? new Date().toISOString().slice(0, 10) : isoDate(date, 'the game date', 2000, 2100);
    if (starters === undefined || starters === null) starters = {}; else if (typeof starters !== 'object' || Array.isArray(starters)) throw new Error('starters must map a team to its goalie');
    if (this.data.games.length >= this.limits.games) throw new Error(`the league holds at most ${this.limits.games} games (VWS_RINK_MAX_GAMES)`);
    const season = Number(date.slice(5, 7)) >= 7 ? Number(date.slice(0, 4)) + 1 : Number(date.slice(0, 4));   // season_end_year
    if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(key))) throw new Error('a game key is 1-24 letters, digits, - or _');
    this.data.seq.game++;
    key = key || `G${this.data.seq.game}`;
    if (this.gamesBy.has(key)) throw new Error(`game ${key} exists`);
    const uuid = hash.uuidv5(`${this.ns}:game:${season}:${key}:${home}:${away}:${date}`);
    const idHash = parseInt(uuid.replace(/-/g, '').slice(0, 8), 16) >>> 0;
    if (this.gamesByHash.has(idHash)) throw new Error('game hash collision; choose another key');
    const st = {};
    for (const t of [home, away]) {
      const want = Object.prototype.hasOwnProperty.call(starters, t) ? starters[t] : null;
      const g = want ? this.resolvePlayer(t, want) : this.roster(t).find((p) => p.pos === 'G');
      if (want && (!g || g.pos !== 'G')) throw new Error(`${t}: the named starter is not a goalie on that roster`);
      if (g) st[t] = g.pid;
    }
    const game = { key, uuid, idHash, home, away, date, stage, season, starters: st, createdAt: new Date().toISOString() };
    if (start === 'frame') game.start = 'frame';           // the clock runs only after the game's start frame (START)
    // the league's overtime rules, copied: the game is decided by the rules it was created under, whatever the
    // league changes later (a game without them keeps the built-in rules)
    const lg = this.overtimeLeague(home, away);
    if (lg && lg.overtime) game.ot = Object.assign({ league: lg.code }, JSON.parse(JSON.stringify(OT.normalize(lg.overtime))));
    this.data.games.push(game); this._index(); this.save(); return game;
  }
  game(key) { return typeof key === 'string' ? this.gamesBy.get(key) || null : null; }
  gameByHash(h) { return this.gamesByHash.get(h >>> 0) || null; }
  games() { return this.data.games.slice(); }
  /* ---------- club-private notes (row-level security, spec §7) ---------- */
  addNote({ team, pid, text, tenant, by }) {
    team = typeof team === 'string' ? team.toUpperCase() : ''; if (!this.teamsBy.has(team)) throw new Error('a note needs a registered team');
    if (pid !== undefined && pid !== null && pid !== '') { if (typeof pid !== 'string' || !this.playersBy.has(pid)) throw new Error('the note names a player that is not registered'); } else pid = null;
    const body = cleanText(text, this.limits.noteChars, 'the note', { required: true, multiline: true });
    if (this.data.notes.filter((n) => n.tenant === tenant).length >= this.limits.notesPerTenant) throw new Error(`this tenant already has ${this.limits.notesPerTenant} notes; delete some first (rink note del <id>)`);
    this.data.seq.note++;
    const n = { id: this.data.seq.note, team, pid, text: body, tenant, by, at: new Date().toISOString() };
    this.data.notes.push(n); this.save(); return n;
  }
  /** Delete a note. Only its own tenant (or an admin) can see it, so only they can delete it. */
  deleteNote(principal, id) {
    const visible = this.notesFor(principal); const n = visible.find((x) => x.id === Number(id));
    if (!n) throw new Error(`no note ${String(id).slice(0, 12)} visible to you`);
    this.data.notes.splice(this.data.notes.indexOf(n), 1); this.save(); return n;
  }
  notesFor(principal) {
    const admin = principal.capabilities && principal.capabilities.has && principal.capabilities.has('rink.admin');
    return this.data.notes.filter((n) => admin || n.tenant === principal.tenant);
  }
}
module.exports = { Registry, cleanText, isoDate, LIMITS, SCHEMA, NS };
