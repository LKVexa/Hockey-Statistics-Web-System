'use strict';
/**
 * Roster files: the leagues, teams and players in a file a person keeps, read into one model.
 *
 *   .csv .tsv      a table with a header row: one row per player, or per team, or per league
 *   .xlsx .xlsm    an Excel workbook: every sheet is such a table; a sheet named after a team is that team's roster
 *   .md            headings for leagues and teams, with pipe tables, "key: value" lines or player lines beneath
 *   .txt .corpus   "key = value" lines (HK001's text family), an outline, or a table
 *   .xml           <league><team><player/></team></league> in any nesting, rows of records, or Excel 2003 XML
 *   .edi           LGE*…~ TEM*…~ PLR*…~ segments, or key*value~ pairs as HK001's EDI has them
 *
 * `rink import formats` prints the columns and layouts; examples() below is the same small league in each form.
 *
 * A file is data, never a program. Nothing in it is evaluated: a formula cell contributes the value Excel saved
 * with it, XML entities are the five built-in ones and numeric references, a DOCTYPE is skipped, a workbook's
 * other parts (macros, links, images) are not opened. Everything is bounded (bytes in, bytes inflated, rows,
 * cells, nesting) and every reader takes time proportional to its input. What cannot be read is reported with
 * its place (line 12, Sheet "Teams" row 4), never guessed.
 *
 * Output of read(): { format, leagues, teams, players, errors, warnings, notes, counts }. Entities carry what the
 * file says, nothing more: codes are designated by the plan (roster-plan.js) against the registry.
 */
const codes = require('../shared/codes');

const EXT = ['.csv', '.tsv', '.md', '.txt', '.corpus', '.xlsx', '.xlsm', '.xml', '.edi'];
const LIMITS = { bytes: 4 * 1024 * 1024, inflated: 48 * 1024 * 1024, rows: 60000, cells: 1500000, cols: 200, cell: 300, sheets: 64, depth: 64, leagues: 64, teams: 1000, players: 80000, issues: 400 };
const U = String.fromCharCode;
const BOM = U(0xfeff), NBSP = U(0xa0);

const extOf = (name) => { const b = String(name === undefined || name === null ? '' : name).split(/[\\/]/).pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i).toLowerCase() : ''; };
const isSupported = (name) => EXT.includes(extOf(name));

/* ------------------------------------------------------------------ text */
/** The file's text: UTF-8 (with or without a BOM), UTF-16 with a BOM (Excel's "Unicode text"), or, when the bytes
 *  are not UTF-8, Windows-1252 (Excel's CSV on Windows). */
function decodeText(u8, notes) {
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  const body = u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf ? u8.subarray(3) : u8;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { if (notes) notes.push('the file is not UTF-8: read as Windows-1252'); return new TextDecoder('windows-1252').decode(body); }
}
const squeeze = (s) => String(s === undefined || s === null ? '' : s).split(NBSP).join(' ').replace(/\s+/g, ' ').trim();
/** header and key names: lower case, no accents, letters and digits only ("Prénom" → prenom, "Jersey #" → jersey) */
const normKey = (s) => String(s === undefined || s === null ? '' : s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9#]/g, '');
/** names for matching: upper-case ASCII letters and digits ("Val-d'Or Foreurs" → VALDORFOREURS) */
const normName = (s) => String(s === undefined || s === null ? '' : s).normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ------------------------------------------------------------------ fields */
const FIELDS = {
  league: ['league', 'ligue', 'leaguename', 'competition', 'circuit', 'leagues', 'ligues', 'nomdelaligue'],
  league_code: ['leaguecode', 'league4', 'lg', 'codeligue', 'liguecode'],
  league_abbr: ['leagueabbr', 'leagueabbreviation', 'leagueshort', 'abreviationligue'],
  league_fr: ['leaguefr', 'liguefr', 'leaguenamefr'],
  team: ['team', 'teamname', 'club', 'clubname', 'equipe', 'franchise', 'squad', 'clubnameen', 'teamnameen', 'teams', 'clubs', 'equipes', 'nomdelequipe'],
  team_code: ['teamcode', 'team4', 'clubcode', 'codeequipe', 'equipecode', 'teamabbr', 'teamabbreviation'],
  team_fr: ['teamfr', 'clubnamefr', 'teamnamefr', 'equipefr'],
  city: ['city', 'ville', 'location', 'town', 'municipality', 'municipalite', 'homecity', 'hometown'],
  arena: ['arena', 'venue', 'rink', 'arenaname', 'arene', 'amphitheatre', 'stadium', 'building', 'homearena', 'homerink'],
  timezone: ['timezone', 'tz', 'fuseau', 'fuseauhoraire'],
  player: ['player', 'playername', 'joueur', 'fullname', 'athlete', 'skater', 'nomcomplet', 'players', 'playersname', 'joueurs', 'nomdujoueur'],
  last: ['last', 'lastname', 'surname', 'familyname', 'nomdefamille', 'lname'],
  first: ['first', 'firstname', 'given', 'givenname', 'prenom', 'fname', 'forename'],
  jersey: ['jersey', 'number', 'no', 'num', 'numero', 'jerseynumber', 'sweater', 'uniform', 'jerseyno', '#', 'jersey#', 'no#'],
  pos: ['pos', 'position', 'poste', 'positions'],
  shoots: ['shoots', 'catches', 'shootscatches', 'sc', 'sh', 'hand', 'handedness', 'shot', 'stick', 'lance', 'tire', 'lateralite'],
  birth: ['birth', 'born', 'dob', 'birthdate', 'dateofbirth', 'birthday', 'naissance', 'datedenaissance', 'ddn'],
  import: ['import', 'isimport', 'imp', 'importe'],
  player_code: ['playercode', 'player4', 'codejoueur'],
  type: ['type', 'record', 'recordtype', 'kind', 'entity', 'rec'],
  code: ['code', 'abbr', 'abbreviation', 'short', 'abreviation'],
  name: ['name', 'nom'],
  name_fr: ['namefr', 'nomfr']
};
const FIELD_OF = new Map(); for (const [f, list] of Object.entries(FIELDS)) for (const k of list) FIELD_OF.set(normKey(k), f);
/** the field a header or a key names: "Jersey #", "Shoots (L/R)", "Date of birth [YYYY-MM-DD]", "N°" are read as people write them */
function fieldOf(raw) {
  const t = squeeze(raw); if (!t || t.length > 60) return null;
  if (/^n\s*[°º]\.?$/i.test(t)) return 'jersey';
  const k = normKey(t.replace(/\s*[([][^()[\]]*[)\]]\s*$/, '')); if (!k) return null;
  return FIELD_OF.get(k) || (k.length > 1 && FIELD_OF.get(k.split('#').join(''))) || null;
}
const PLAYERISH = ['player', 'last', 'first', 'jersey', 'pos', 'shoots', 'birth', 'player_code', 'import'];
const TEAMISH = ['team', 'team_code', 'team_fr', 'city', 'arena', 'timezone'];
const LEAGUEISH = ['league', 'league_code', 'league_abbr', 'league_fr'];
const KIND_WORDS = { league: 'league', ligue: 'league', leagues: 'league', ligues: 'league', l: 'league', lge: 'league', team: 'team', club: 'team', equipe: 'team', teams: 'team', clubs: 'team', equipes: 'team', franchise: 'team', t: 'team', tem: 'team',
  player: 'player', joueur: 'player', players: 'player', joueurs: 'player', roster: 'player', rosters: 'player', skater: 'player', goalie: 'player', goaltender: 'player', gardien: 'player', athlete: 'player', p: 'player', plr: 'player', alignement: 'player' };
/** what "name", "code", "abbr" and "name_fr" mean depends on what the row or the table is about */
function inKind(kind, f) {
  if (kind === 'player') return f === 'name' ? 'player' : f === 'code' ? 'player_code' : f === 'name_fr' ? null : f;
  if (kind === 'team') return f === 'name' ? 'team' : f === 'code' ? 'team_code' : f === 'name_fr' ? 'team_fr' : f;
  if (kind === 'league') return f === 'name' ? 'league' : f === 'code' ? 'league_code' : f === 'name_fr' ? 'league_fr' : f;
  return f;
}

/* ------------------------------------------------------------------ values */
const POSITIONS = { c: 'C', centre: 'C', center: 'C', ce: 'C', lw: 'LW', leftwing: 'LW', ag: 'LW', ailiergauche: 'LW', rw: 'RW', rightwing: 'RW', ad: 'RW', ailierdroit: 'RW',
  d: 'D', def: 'D', defence: 'D', defense: 'D', defenceman: 'D', defenseman: 'D', defenseur: 'D', ld: 'D', rd: 'D', dg: 'D', dd: 'D',
  g: 'G', gk: 'G', goalie: 'G', goaltender: 'G', gardien: 'G', gardiendebut: 'G', goal: 'G', netminder: 'G' };
const FORWARDS = new Set(['f', 'fw', 'fwd', 'forward', 'w', 'wing', 'winger', 'a', 'av', 'avant', 'attaquant', 'ailier']);
/** → { pos } · { pos: 'C', note } for a forward of no stated line · null when the cell says nothing usable */
function readPos(v) {
  const first = squeeze(v).split(/[\/,;&]| or /i)[0]; const k = normKey(first);
  if (!k) return null;
  if (POSITIONS[k]) return { pos: POSITIONS[k] };
  if (FORWARDS.has(k)) return { pos: 'C', note: 'forward' };
  return null;
}
function readHand(v) { const k = normKey(v); if (!k) return ''; if (['l', 'left', 'g', 'gauche', 'gaucher'].includes(k)) return 'L'; if (['r', 'right', 'd', 'droite', 'droitier', 'droit'].includes(k)) return 'R'; return ''; }
function readJersey(v) {
  const t = squeeze(v).replace(/^(#|no\.?|n°|nº)\s*/i, ''); if (!t) return null;
  const m = /^(\d{1,2})(?:\.0+)?$/.exec(t); if (!m) return NaN;
  const n = Number(m[1]); return n >= 1 && n <= 99 ? n : NaN;
}
const MONTHS = { jan: 1, january: 1, janvier: 1, janv: 1, feb: 2, february: 2, fevrier: 2, fev: 2, mar: 3, march: 3, mars: 3, apr: 4, april: 4, avril: 4, avr: 4, may: 5, mai: 5, jun: 6, june: 6, juin: 6, jul: 7, july: 7, juillet: 7, juil: 7,
  aug: 8, august: 8, aout: 8, sep: 9, sept: 9, september: 9, septembre: 9, oct: 10, october: 10, octobre: 10, nov: 11, november: 11, novembre: 11, dec: 12, december: 12, decembre: 12 };
const iso = (y, m, d) => { const t = Date.UTC(y, m - 1, d); const dt = new Date(t); return y >= 1900 && y <= 2100 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : ''; };
/** A birth date as YYYY-MM-DD, or '' with a reason. 03/04/2006 is not guessed: it could be March or April. */
function readBirth(v, { serial = false, date1904 = false } = {}) {
  const t = squeeze(v); if (!t) return { date: '' };
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(t);
  if (m) { const d = iso(+m[1], +m[2], +m[3]); return d ? { date: d } : { date: '', why: `${t} is not a calendar date` }; }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (a > 12 && b <= 12) { const d = iso(y, b, a); return d ? { date: d } : { date: '', why: `${t} is not a calendar date` }; }
    if (b > 12 && a <= 12) { const d = iso(y, a, b); return d ? { date: d } : { date: '', why: `${t} is not a calendar date` }; }
    if (a === b) { const d = iso(y, a, b); if (d) return { date: d }; }
    return { date: '', why: `${t} could be day/month or month/day; write it as YYYY-MM-DD` };
  }
  m = /^(\d{1,2})(?:er|st|nd|rd|th)?\s+([\p{L}.]+)\s+(\d{4})$/u.exec(t) || null;
  if (m && MONTHS[normKey(m[2])]) { const d = iso(+m[3], MONTHS[normKey(m[2])], +m[1]); if (d) return { date: d }; }
  m = /^([\p{L}.]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/u.exec(t) || null;
  if (m && MONTHS[normKey(m[1])]) { const d = iso(+m[3], MONTHS[normKey(m[1])], +m[2]); if (d) return { date: d }; }
  if (serial && /^\d{4,5}(\.\d+)?$/.test(t)) {          // a date cell of a workbook: days since 1899-12-30 (or 1904-01-01)
    const n = Math.floor(Number(t)) + (date1904 ? 1462 : 0);
    if (n >= 10000 && n <= 73050) { const dt = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return { date: iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()) }; }
  }
  return { date: '', why: `${t.slice(0, 24)} is not a date this reader knows; write it as YYYY-MM-DD` };
}
const readFlag = (v) => ['1', 'y', 'yes', 'true', 'x', 'oui', 'o', 'vrai', 'import', 'imp'].includes(normKey(v));
/** an import cell that says no in so many words (an empty one says nothing) */
const saysNo = (v) => ['0', 'n', 'no', 'false', 'non', 'faux', 'domestic'].includes(normKey(v));
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'st', 'ste', 'saint', 'sainte', 'mac', 'ter', 'ten', 'dos', 'das', 'el', 'al', 'bin', 'ibn']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
/** "Smith, John" or "John Smith" → { last, first }; "Jan van der Berg" keeps the particles with the surname */
function splitName(full) {
  const t = squeeze(full); if (!t) return { last: '', first: '' };
  const c = t.indexOf(',');
  if (c >= 0) return { last: squeeze(t.slice(0, c)), first: squeeze(t.slice(c + 1).replace(/,.*$/, '')) };
  const w = t.split(' '); while (w.length > 1 && SUFFIXES.has(normKey(w[w.length - 1]))) w.pop();
  if (w.length === 1) return { last: w[0], first: '' };
  let i = w.length - 1; while (i > 1 && PARTICLES.has(normKey(w[i - 1]))) i--;
  return { last: w.slice(i).join(' '), first: w.slice(0, i).join(' ') };
}
/** The surname and the given name of a record: from their own columns, from one name column, or from a name
 *  column beside one of the two ("Nom" + "Prénom": the name column is then the other part, however many words). */
function nameParts(f) {
  const full = squeeze(f.player), gl = squeeze(f.last), gf = squeeze(f.first);
  if (gl && gf) return { last: gl, first: gf };
  const sp = splitName(full);
  if (!gl && !gf) return sp;
  if (!full) return { last: gl, first: gf };
  if (full.indexOf(',') >= 0) return { last: gl || sp.last, first: gf || sp.first };
  const words = full.split(' '); const part = gl || gf; const k = part.split(' ').length; const np = normName(part);
  let rest = full;
  if (words.length > k && normName(words.slice(0, k).join('')) === np) rest = words.slice(k).join(' ');            // the whole name again: "John Smith" beside "John"
  else if (words.length > k && normName(words.slice(-k).join('')) === np) rest = words.slice(0, -k).join(' ');
  else if (normName(full) === np) rest = '';
  return gl ? { last: gl, first: rest } : { last: rest, first: gf };
}
/** "Fort Collins Comets [FOCO]" or "Western Hockey League (WHL)" → the name and what stands in the brackets */
function splitTag(v) {
  const t = squeeze(v); const m = /^(.*?)[\s]*[[(]\s*([A-Za-z]{2,8})\s*[\])]$/.exec(t);
  return m && squeeze(m[1]) ? { name: squeeze(m[1]), tag: m[2].toUpperCase() } : { name: t, tag: '' };
}
const is4 = (c) => /^[A-Z]{4}$/.test(c);

/* ------------------------------------------------------------------ the model builder */
class Builder {
  constructor(format, limits) {
    this.limits = limits;
    this.m = { format, leagues: [], teams: [], players: [], errors: [], warnings: [], notes: [], counts: { rows: 0, errors: 0, warnings: 0, ignored: 0 } };
    this.L = new Map(); this.T = new Map(); this.league = -1; this.team = -1; this.open = null; this.unknown = new Map();
    this.seq = 0;                                  // the order things were read in: `ord` on every entity and issue, so a reply can list issues as the file has them
  }
  err(where, text) { this.m.counts.errors++; if (this.m.errors.length < this.limits.issues) this.m.errors.push({ where, text, ord: ++this.seq }); }
  warn(where, text) { this.m.counts.warnings++; if (this.m.warnings.length < this.limits.issues) this.m.warnings.push({ where, text, ord: ++this.seq }); }
  note(text) { if (this.m.notes.length < 40 && !this.m.notes.includes(text)) this.m.notes.push(text); }
  unknownKey(k) { const n = squeeze(k).slice(0, 40); if (n) this.unknown.set(n, (this.unknown.get(n) || 0) + 1); }
  /* ---- entities: the same league or team named on many rows is one entity ---- */
  ensureLeague(f, where) {
    const t = splitTag(f.name); let code = squeeze(f.code).toUpperCase(), abbr = squeeze(f.abbr).toUpperCase();
    if (!code && t.tag) code = t.tag;
    if (code && !is4(code)) { if (!abbr) abbr = code; code = ''; }                      // "WHL" is an abbreviation, not a LEAGUE_4
    if (!code && is4(t.name)) code = t.name;
    abbr = abbr.replace(/[^A-Z0-9]/g, '').slice(0, 12);
    const name = t.name.slice(0, 120); const nk = normName(name);
    if (!code && !nk) { if (abbr) return this.ensureLeague({ name: abbr, abbr }, where); return -1; }
    // a league cell that reads WHL or LHJMQ is the league's abbreviation: it names the league that has it, wherever its full name stands
    if (!abbr && !code && /^[A-Z0-9]{2,8}$/.test(t.name) && /[A-Z]/.test(t.name)) abbr = t.name;
    let i = (code && this.L.has('c:' + code)) ? this.L.get('c:' + code) : (nk && this.L.has('n:' + nk)) ? this.L.get('n:' + nk) : (abbr && this.L.has('a:' + abbr)) ? this.L.get('a:' + abbr) : -1;
    if (i < 0) {
      if (this.m.leagues.length >= this.limits.leagues) { this.err(where, `more than ${this.limits.leagues} leagues`); return -1; }
      i = this.m.leagues.push({ name: name || code, code: '', abbr: '', name_fr: '', where, ord: ++this.seq }) - 1;
    }
    const l = this.m.leagues[i];
    if (code) { if (l.code && l.code !== code) this.warn(where, `league ${l.name}: code ${code} differs from ${l.code} given earlier; ${l.code} is kept`); else l.code = code; this.L.set('c:' + code, i); }
    if (nk) { if (!l.name || normName(l.name) === normName(l.code) || (l.abbr && normName(l.name) === normName(l.abbr))) l.name = name; this.L.set('n:' + nk, i); }
    if (abbr) { if (!l.abbr) l.abbr = abbr; if (!this.L.has('a:' + abbr)) this.L.set('a:' + abbr, i); }
    if (squeeze(f.name_fr) && !l.name_fr) l.name_fr = squeeze(f.name_fr).slice(0, 120);
    return i;
  }
  ensureTeam(f, league, where) {
    const t = splitTag(f.name); let code = squeeze(f.code).toUpperCase(); let hint = '';
    if (!code && t.tag) code = t.tag;
    if (code && !is4(code)) { hint = code; code = ''; this.note('a team code that is not four letters is not a TEAM_4: one is designated from the name'); }
    if (!code && is4(t.name)) code = t.name;                                           // a team cell that reads FOCO is the code
    const name = t.name.slice(0, 120); const nk = normName(name);
    if (!code && !nk) return -1;
    let i = -1;
    if (code && this.T.has('c:' + code)) i = this.T.get('c:' + code);
    else if (nk && this.T.has(`n:${league}:${nk}`)) i = this.T.get(`n:${league}:${nk}`);
    else if (nk && league < 0 && this.T.has('any:' + nk)) i = this.T.get('any:' + nk);   // no league on this row: the team of that name seen before
    else if (nk && league >= 0 && this.T.has(`n:-1:${nk}`)) { i = this.T.get(`n:-1:${nk}`); }
    if (i < 0) {
      if (this.m.teams.length >= this.limits.teams) { this.err(where, `more than ${this.limits.teams} teams`); return -1; }
      i = this.m.teams.push({ name: name || code, code: '', name_fr: '', city: '', arena: '', timezone: '', league, where, ord: ++this.seq }) - 1;
    }
    const x = this.m.teams[i];
    if (code) { if (x.code && x.code !== code) this.warn(where, `team ${x.name}: code ${code} differs from ${x.code} given earlier; ${x.code} is kept`); else x.code = code; this.T.set('c:' + code, i); }
    if (nk) { if (normName(x.name) === normName(x.code) || !x.name) x.name = name; this.T.set(`n:${league}:${nk}`, i); if (!this.T.has('any:' + nk)) this.T.set('any:' + nk, i); }
    if (league >= 0) { if (x.league < 0) x.league = league; else if (x.league !== league) this.warn(where, `team ${x.name} is listed under two leagues; the first is kept`); }
    for (const k of ['name_fr', 'city', 'arena', 'timezone']) { const v = squeeze(f[k]).slice(0, 120); if (v && !x[k]) x[k] = v; }
    if (hint && !x.hint) x.hint = hint;
    return i;
  }
  addPlayer(f, team, where, opt = {}) {
    const { last, first } = nameParts(f);
    if (!last && !first) return;
    if (this.m.players.length >= this.limits.players) { this.err(where, `more than ${this.limits.players} players`); return; }
    if (team < 0) { this.err(where, `${squeeze(`${first} ${last}`).slice(0, 60)}: no team (a team column, a team heading, or a sheet named after the team is needed)`); return; }
    if (!last || !first) { this.err(where, `${(last || first).slice(0, 60)}: a given name and a surname are both needed`); return; }
    const p = { team, last: last.slice(0, 60), first: first.slice(0, 60), jersey: null, pos: '', posNote: '', shoots: '', birth: '', import: false, importSaid: false, code: '', where, ord: ++this.seq };
    const who = `${p.first} ${p.last}`;
    const j = readJersey(f.jersey); if (Number.isNaN(j)) this.err(where, `${who}: jersey "${squeeze(f.jersey).slice(0, 12)}" is not a number from 1 to 99`); else p.jersey = j;
    if (squeeze(f.pos)) { const r = readPos(f.pos); if (r) { p.pos = r.pos; p.posNote = r.note || ''; } else this.warn(where, `${who}: position "${squeeze(f.pos).slice(0, 16)}" is not known (C, LW, RW, D, G, F)`); }
    p.shoots = readHand(f.shoots);
    if (squeeze(f.birth)) {
      const b = readBirth(f.birth, opt); const y = b.date ? Number(b.date.slice(0, 4)) : 0; const now = new Date().getUTCFullYear();
      if (!b.date) this.warn(where, `${who}: birth date left out: ${b.why}`);
      else if (y < 1950 || y > now) this.warn(where, `${who}: birth date left out: ${b.date} is not between 1950 and ${now}`);
      else p.birth = b.date;
    }
    p.import = readFlag(f.import); p.importSaid = p.import || saysNo(f.import);
    const c = squeeze(f.player_code).toUpperCase();
    if (c) { if (/^[A-Z][A-Z0-9]{3}$/.test(c) && !/^J\d/.test(c)) p.code = c; else this.warn(where, `${who}: code "${c.slice(0, 8)}" is not a PLAYER_4 (a letter, then three letters or digits); one is designated`); }
    if (Number.isNaN(j)) return;
    this.m.players.push(p);
  }
  /** One flat record: any of a league, a team and a player, with the context standing in for what it leaves out. */
  row(f, where, opt = {}) {
    const has = (k) => squeeze(f[k]) !== '';
    let li = this.league, ti = this.team;
    if (has('league') || has('league_code') || has('league_abbr')) { li = this.ensureLeague({ name: f.league, code: f.league_code, abbr: f.league_abbr, name_fr: f.league_fr }, where); ti = -1; }
    if (has('team') || has('team_code')) ti = this.ensureTeam({ name: f.team, code: f.team_code, name_fr: f.team_fr, city: f.city, arena: f.arena, timezone: f.timezone }, li, where);
    else if (ti >= 0 && (has('city') || has('arena') || has('timezone') || has('team_fr'))) this.ensureTeam({ name: this.m.teams[ti].name, code: this.m.teams[ti].code, name_fr: f.team_fr, city: f.city, arena: f.arena, timezone: f.timezone }, this.m.teams[ti].league, where);
    if (has('player') || has('last') || has('first')) this.addPlayer(f, ti, where, opt);
    else if (!(has('league') || has('league_code') || has('league_abbr') || has('team') || has('team_code')) && (has('jersey') || has('pos'))) this.err(where, 'a jersey or a position without a player name');
    return { league: li, team: ti };
  }
  /* ---- a table: header row, then rows ---- */
  table({ title = '', rows, whereOf, opt = {}, hint = null }) {
    const label = squeeze(title) ? `"${squeeze(title).slice(0, 40)}": ` : '';
    let h = -1;
    for (let i = 0; i < rows.length && i < 30; i++) { const known = rows[i].filter((c) => fieldOf(c)).length; if (known >= 2 || (known === 1 && rows[i].filter((c) => squeeze(c)).length <= 2)) { h = i; break; } }
    if (h < 0) { if (rows.some((r) => r.some((c) => squeeze(c)))) this.err(whereOf(0), `${label}no header row was found: the first row names the columns (team, player, jersey, pos …; rink import formats lists them)`); return; }
    const cols = rows[h].map((c) => fieldOf(c)); const have = new Set(cols.filter(Boolean));
    rows[h].forEach((c, i) => { if (!cols[i] && squeeze(c)) this.unknownKey(c); });
    let kind = PLAYERISH.some((k) => have.has(k)) ? 'player' : TEAMISH.some((k) => have.has(k)) ? 'team' : LEAGUEISH.some((k) => have.has(k)) ? 'league' : (hint || KIND_WORDS[normKey(title)] || null);
    // "team, city, arena, import": nothing names a player, so the rows are teams
    if (kind === 'player' && !['player', 'last', 'first', 'name', 'jersey'].some((k) => have.has(k)) && TEAMISH.some((k) => have.has(k))) kind = 'team';
    const typeCol = cols.indexOf('type');
    if (!kind && typeCol < 0) { this.err(whereOf(h), `${label}the columns do not say whether the rows are leagues, teams or players`); return; }
    // a sheet or a section named after a team holds that team's players
    let ctxTeam = this.team; const ctxLeague = this.league;
    const generic = /^(sheet|feuil|feuille|table|tabelle|blad|hoja|players?|joueurs?|rosters?|alignements?|teams?|clubs?|equipes?|leagues?|ligues?|data|export|import|untitled)\d*$/;
    if (kind === 'player' && !have.has('team') && !have.has('team_code') && ctxTeam < 0 && squeeze(title) && !generic.test(normKey(title))) {
      ctxTeam = this.ensureTeam({ name: title }, ctxLeague, whereOf(h)); this.note(`"${squeeze(title).slice(0, 40)}" has no team column: its name is taken as the team`);
    }
    let lastTeam = null, lastLeague = null, empty = 0, headers = 0;
    const headKey = rows[h].map(normKey).join('|');
    for (let r = h + 1; r < rows.length; r++) {
      const cells = rows[r]; if (!cells.some((c) => squeeze(c))) { if (++empty > 2000) break; continue; }
      empty = 0;
      if (cells.length === rows[h].length && cells.map(normKey).join('|') === headKey) { headers++; continue; }   // the header again (files put end to end)
      this.m.counts.rows++;
      const rk = typeCol >= 0 ? (KIND_WORDS[normKey(cells[typeCol])] || kind) : kind;
      if (!rk) { this.err(whereOf(r), `type "${squeeze(cells[typeCol]).slice(0, 16)}" is not league, team or player`); continue; }
      const f = {};
      for (let c = 0; c < cols.length; c++) { if (!cols[c] || cols[c] === 'type') continue; const k = inKind(rk, cols[c]); if (!k) continue; const v = squeeze(cells[c]).slice(0, this.limits.cell); if (v && f[k] === undefined) f[k] = v; }
      // merged cells and "same as above": a player row with no team (or league) of its own repeats the one above
      const team = {}; for (const k of ['team', 'team_code']) if (f[k]) team[k] = f[k];
      const league = {}; for (const k of LEAGUEISH) if (f[k]) league[k] = f[k];
      if (Object.keys(league).length) { lastLeague = league; if (!Object.keys(team).length) lastTeam = null; } else if (lastLeague && (f.player || f.last || f.first || Object.keys(team).length)) Object.assign(f, lastLeague);
      if (Object.keys(team).length) lastTeam = team; else if (lastTeam && (f.player || f.last || f.first)) Object.assign(f, lastTeam);
      const saveL = this.league, saveT = this.team; this.league = ctxLeague; this.team = ctxTeam;
      this.row(f, whereOf(r), opt);
      this.league = saveL; this.team = saveT;
    }
    if (headers) { this.m.counts.ignored += headers; this.note(`${label}the header row is repeated ${headers} time${headers > 1 ? 's' : ''} further down: skipped`); }
  }
  /* ---- a stream of key and value (text, corpus, EDI pairs, "key: value" lines) ---- */
  closePlayer() { if (this.open) { const o = this.open; this.open = null; this.addPlayer(o.f, this.team, o.where, o.opt); } }
  kv(key, value, where, opt = {}) {
    let f = fieldOf(key); const v = squeeze(value).slice(0, this.limits.cell);
    if (!f) { this.unknownKey(key); this.m.counts.ignored++; return; }
    if (f === 'type') return;
    if (f === 'name') f = this.open && !this.open.f.player && !this.open.f.last ? 'player' : this.team >= 0 || this.league < 0 ? 'player' : 'team';
    if (f === 'code' || f === 'name_fr') f = this.open ? (f === 'code' ? 'player_code' : null) : this.team >= 0 ? (f === 'code' ? 'team_code' : 'team_fr') : (f === 'code' ? 'league_code' : 'league_fr');
    if (!f || !v) return;
    if (f === 'league') { this.closePlayer(); this.team = -1; this.league = this.ensureLeague({ name: v }, where); this.m.counts.rows++; return; }
    if (LEAGUEISH.includes(f)) { this.closePlayer(); const cur = this.league >= 0 ? this.m.leagues[this.league] : null; this.league = this.ensureLeague({ name: cur ? cur.name : '', code: f === 'league_code' ? v : (cur ? cur.code : ''), abbr: f === 'league_abbr' ? v : '', name_fr: f === 'league_fr' ? v : '' }, where); return; }
    if (f === 'team') { this.closePlayer(); this.team = this.ensureTeam({ name: v }, this.league, where); this.m.counts.rows++; return; }
    if (TEAMISH.includes(f)) {
      if (this.open && f !== 'team_code') this.closePlayer();
      if (this.team < 0) { if (f === 'team_code') { this.team = this.ensureTeam({ code: v }, this.league, where); return; } this.err(where, `${squeeze(key).slice(0, 20)} without a team before it`); return; }
      const x = this.m.teams[this.team]; this.closePlayer();
      this.ensureTeam({ name: x.name, code: f === 'team_code' ? v : x.code, [f === 'team_fr' ? 'name_fr' : f]: v }, x.league, where); return;
    }
    // player fields: "player" always starts a player; a surname or a given name starts one when the open one has it
    if (f === 'player' || ((f === 'last' || f === 'first') && (!this.open || this.open.f[f] !== undefined || (this.open.f.player !== undefined)))) { this.closePlayer(); this.open = { f: {}, where, opt }; this.m.counts.rows++; }
    if (!this.open) { this.err(where, `${squeeze(key).slice(0, 20)} without a player before it`); return; }
    if (this.open.f[f] === undefined) this.open.f[f] = v;
  }
  /** "9 John Smith C", "#9 Smith, John (LW) L 2006-02-03", "- 31 Roy Patrick G" */
  playerLine(text, where, opt = {}) {
    let t = squeeze(text).replace(/^[-*+]\s+/, ''); if (!t) return false;
    const f = {}; let m = /^#?(\d{1,2})[.):]?\s+(.*)$/.exec(t);
    if (m) { f.jersey = m[1]; t = m[2]; }
    let w = t.split(' ');
    const dm = /^\(?(\d{4}-\d{1,2}-\d{1,2})\)?$/.exec(w[w.length - 1] || ''); if (dm && w.length > 1) { f.birth = dm[1]; w.pop(); }
    const strip = (x) => String(x || '').replace(/^[([]|[)\],]$/g, '');
    if (w.length > 2 && /^[LRlr]$/.test(strip(w[w.length - 1])) && readPos(strip(w[w.length - 2]))) { f.shoots = strip(w.pop()); }
    if (w.length > 1 && readPos(strip(w[w.length - 1])) && normKey(strip(w[w.length - 1])).length <= 10) { f.pos = strip(w.pop()); }
    if (!f.jersey && w.length > 1) { const jm = /^#?(\d{1,2})$/.exec(w[w.length - 1]); if (jm) { f.jersey = jm[1]; w.pop(); } }
    if (!f.jersey && !f.pos) return false;
    f.player = w.join(' ').replace(/,$/, ''); if (!/\p{L}/u.test(f.player)) return false;
    this.closePlayer(); this.m.counts.rows++; this.addPlayer(f, this.team, where, opt); return true;
  }
  /** an entity of a known kind with its own fields (an XML element, an EDI segment); returns its index */
  entity(kind, rawFields, where, opt = {}) {
    const f = {}; for (const [k, v] of Object.entries(rawFields)) { const c = fieldOf(k); if (!c) { this.unknownKey(k); continue; } const x = inKind(kind, c); if (x && x !== 'type' && squeeze(v) && f[x] === undefined) f[x] = squeeze(v).slice(0, this.limits.cell); }
    this.closePlayer(); this.m.counts.rows++;
    if (kind === 'league') { const i = this.ensureLeague({ name: f.league, code: f.league_code, abbr: f.league_abbr, name_fr: f.league_fr }, where); if (i < 0) this.err(where, 'a league without a name'); return i; }
    if (kind === 'team') {
      let li = this.league; if (f.league || f.league_code || f.league_abbr) li = this.ensureLeague({ name: f.league, code: f.league_code, abbr: f.league_abbr }, where);
      const i = this.ensureTeam({ name: f.team, code: f.team_code, name_fr: f.team_fr, city: f.city, arena: f.arena, timezone: f.timezone }, li, where); if (i < 0) this.err(where, 'a team without a name'); return i;
    }
    const at = this.row(f, where, opt); return at.team;
  }
  done() {
    this.closePlayer();
    const u = [...this.unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k);
    if (u.length) this.note(`not used: ${u.join(', ')}`);
    return this.m;
  }
}
/* ================================================================== readers ================================================================== */
const bad = (message) => Object.assign(new Error(message), { code: 'BAD_FILE' });

/* ------------------------------------------------------------------ delimited text (RFC 4180, tolerant) */
/** Rows of cells. A quoted field may hold the delimiter, line breaks and "" for a quote. `lines[i]` is the line a row starts on. */
function delimited(text, delim, limits) {
  const rows = [], lines = []; const n = text.length; let i = 0, line = 1, cells = 0;
  let row = [], startLine = 1;
  const endRow = () => { if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(startLine); if (rows.length > limits.rows) throw bad(`more than ${limits.rows} rows`); } row = []; };
  while (i <= n) {
    let v;
    if (text[i] === '"') {
      let j = i + 1; const parts = [];
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) { parts.push(text.slice(j)); j = n; break; }
        parts.push(text.slice(j, q));
        if (text[q + 1] === '"') { parts.push('"'); j = q + 2; continue; }
        j = q + 1; break;
      }
      v = parts.join(''); for (let k = v.indexOf('\n'); k >= 0; k = v.indexOf('\n', k + 1)) line++;
      // anything between the closing quote and the next delimiter is kept as written
      let e = j; while (e < n && text[e] !== delim && text[e] !== '\n' && text[e] !== '\r') e++;
      if (e > j) v += text.slice(j, e);
      i = e;
    } else {
      let e = i; while (e < n && text[e] !== delim && text[e] !== '\n' && text[e] !== '\r') e++;
      v = text.slice(i, e); i = e;
    }
    if (row.length < limits.cols) row.push(v.length > 2000 ? v.slice(0, 2000) : v);
    if (++cells > limits.cells) throw bad(`more than ${limits.cells} cells`);
    if (i >= n) { endRow(); break; }
    if (text[i] === delim) { i++; if (i >= n) { row.push(''); endRow(); break; } continue; }
    if (text[i] === '\r' && text[i + 1] === '\n') i++;
    i++; line++; endRow(); startLine = line;
  }
  return { rows, lines };
}
/** the delimiter of a table in text: the candidate that splits the header line into the most cells that name columns */
function sniff(text, candidates) {
  let i = 0; while (i < text.length && /\s/.test(text[i])) i++;
  const e = text.indexOf('\n', i); const head = text.slice(i, e < 0 ? Math.min(text.length, i + 4000) : Math.min(e, i + 4000));
  let best = null, score = 0, width = 0;
  for (const d of candidates) { const cells = head.split(d); const known = cells.filter((c) => fieldOf(c.replace(/^\s*"|"\s*$/g, ''))).length; if (known > score || (known === score && known > 0 && cells.length > width)) { best = d; score = known; width = cells.length; } }
  return { delim: best, known: score, cells: width };
}
function readTable(text, ext, B, limits) {
  let body = text; let forced = null;
  const sm = /^sep=(.)\r?\n/.exec(body); if (sm) { forced = sm[1]; body = body.slice(sm[0].length); }       // Excel's own hint
  const s = sniff(body, ext === '.tsv' ? ['\t', ',', ';', '|'] : [',', ';', '\t', '|']);
  const delim = forced || (s.known >= 1 ? s.delim : (ext === '.tsv' ? '\t' : ','));
  if (!forced && ext === '.tsv' && delim !== '\t') B.note('the .tsv file is not separated by tabs: read by its own separator');
  if (!forced && ext === '.csv' && delim !== ',') B.note(`the .csv file is separated by ${delim === '\t' ? 'tabs' : `"${delim}"`}`);
  const { rows, lines } = delimited(body, delim, limits); const off = sm ? 1 : 0;
  B.table({ rows, whereOf: (i) => `line ${(lines[i] || 1) + off}` });
}

/* ------------------------------------------------------------------ XML scanner (tolerant, inert, linear) */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] !== '#') return ENT[e];
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : U(0xfffd);
  });
}
const localName = (n) => { const i = n.indexOf(':'); return (i >= 0 ? n.slice(i + 1) : n).toLowerCase(); };
/** Calls h.open(local, attrs, at), h.text(str), h.close(local). No entity is expanded beyond the five built-in ones
 *  and numeric references; comments, processing instructions and a DOCTYPE (with its internal subset) are skipped. */
function xmlScan(s, h, maxDepth) {
  const n = s.length; let i = 0, depth = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { h.text(unescapeXml(s.slice(i))); break; }
    if (lt > i) h.text(unescapeXml(s.slice(i, lt)));
    const c1 = s.charCodeAt(lt + 1);
    if (c1 === 33 /* ! */) {
      if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
      if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt + 9); h.text(s.slice(lt + 9, e < 0 ? n : e)); i = e < 0 ? n : e + 3; continue; }
      let j = lt + 2, sq = 0; for (; j < n; j++) { const c = s.charCodeAt(j); if (c === 91) sq++; else if (c === 93) sq--; else if (c === 62 && sq <= 0) break; }
      i = j + 1; continue;
    }
    if (c1 === 63 /* ? */) { const e = s.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    // the end of the tag: the first > outside a quoted attribute value
    let j = lt + 1; let gt = -1;
    while (j < n) { const c = s.charCodeAt(j); if (c === 62) { gt = j; break; } if (c === 34 || c === 39) { const q = s.indexOf(c === 34 ? '"' : "'", j + 1); if (q < 0) { j = n; break; } j = q + 1; } else j++; }
    if (gt < 0) break;                                              // an unfinished tag ends the document
    if (c1 === 47 /* / */) { h.close(localName(s.slice(lt + 2, gt).trim())); depth--; i = gt + 1; continue; }
    const selfClose = s.charCodeAt(gt - 1) === 47; const end = selfClose ? gt - 1 : gt;
    let k = lt + 1; while (k < end && !/[\s/]/.test(s[k])) k++;
    const name = s.slice(lt + 1, k); const attrs = {};
    while (k < end) {
      while (k < end && /\s/.test(s[k])) k++;
      let a = k; while (k < end && s[k] !== '=' && !/\s/.test(s[k])) k++;
      const an = s.slice(a, k); if (!an) break;
      while (k < end && /\s/.test(s[k])) k++;
      if (s[k] !== '=') { attrs[an] = ''; continue; }
      k++; while (k < end && /\s/.test(s[k])) k++;
      const q = s[k]; let v;
      if (q === '"' || q === "'") { const e = s.indexOf(q, k + 1); v = s.slice(k + 1, e < 0 || e > end ? end : e); k = (e < 0 || e > end ? end : e) + 1; }
      else { a = k; while (k < end && !/\s/.test(s[k])) k++; v = s.slice(a, k); }
      if (attrs[an] === undefined) attrs[an] = unescapeXml(v);
    }
    if (!name) { i = gt + 1; continue; }
    if (!selfClose && ++depth > maxDepth) throw bad(`XML nested deeper than ${maxDepth} elements`);
    h.open(localName(name), attrs, lt);
    if (selfClose) h.close(localName(name));
    i = gt + 1;
  }
}

/* ------------------------------------------------------------------ ZIP and DEFLATE (for .xlsx) */
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function huffman(lengths, n) {
  const count = new Uint16Array(16), symbol = new Uint16Array(n), offs = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0; let left = 1;
  for (let len = 1; len < 16; len++) { left <<= 1; left -= count[len]; if (left < 0) throw bad('the compressed data is damaged (code lengths)'); }
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
  for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  return { count, symbol };
}
let FIXED = null;
/** RFC 1951 inflate in plain JavaScript: used where node:zlib is not there (the browser bench). At most maxOut bytes. */
function inflateRawJs(src, maxOut) {
  let pos = 0, buf = 0, cnt = 0; let out = new Uint8Array(Math.min(maxOut, Math.max(4096, src.length * 3))); let op = 0;
  const bits = (need) => { while (cnt < need) { if (pos >= src.length) throw bad('the compressed data ends early'); buf |= src[pos++] << cnt; cnt += 8; } const v = buf & ((1 << need) - 1); buf >>>= need; cnt -= need; return v; };
  const decode = (h) => { let code = 0, first = 0, index = 0; for (let len = 1; len <= 15; len++) { code |= bits(1); const c = h.count[len]; if (code - c < first) return h.symbol[index + (code - first)]; index += c; first += c; first <<= 1; code <<= 1; } throw bad('the compressed data is damaged (code)'); };
  const room = (k) => { if (op + k <= out.length) return; if (op + k > maxOut) throw bad(`the file inflates to more than ${maxOut} bytes`); const next = new Uint8Array(Math.min(maxOut, Math.max(out.length * 2, op + k))); next.set(out.subarray(0, op)); out = next; };
  for (let last = 0; !last;) {
    last = bits(1); const type = bits(2);
    if (type === 0) {
      buf = 0; cnt = 0; if (pos + 4 > src.length) throw bad('the compressed data ends early');
      const len = src[pos] | (src[pos + 1] << 8), nlen = src[pos + 2] | (src[pos + 3] << 8); pos += 4;
      if ((len ^ 0xffff) !== nlen || pos + len > src.length) throw bad('the compressed data is damaged (stored block)');
      room(len); out.set(src.subarray(pos, pos + len), op); op += len; pos += len; continue;
    }
    let lc, dc;
    if (type === 1) {
      if (!FIXED) { const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288); FIXED = { lc: huffman(l, 288), dc: huffman(new Uint8Array(30).fill(5), 30) }; }
      lc = FIXED.lc; dc = FIXED.dc;
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4; if (nlen > 286 || ndist > 30) throw bad('the compressed data is damaged (table sizes)');
      const cl = new Uint8Array(19); for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
      const ch = huffman(cl, 19); const lens = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decode(ch);
        if (sym < 16) { lens[i++] = sym; continue; }
        let prev = 0, rep; if (sym === 16) { if (!i) throw bad('the compressed data is damaged (repeat)'); prev = lens[i - 1]; rep = 3 + bits(2); } else if (sym === 17) rep = 3 + bits(3); else rep = 11 + bits(7);
        if (i + rep > nlen + ndist) throw bad('the compressed data is damaged (repeat)');
        while (rep--) lens[i++] = prev;
      }
      if (!lens[256]) throw bad('the compressed data is damaged (no end code)');
      lc = huffman(lens.subarray(0, nlen), nlen); dc = huffman(lens.subarray(nlen), ndist);
    } else throw bad('the compressed data is damaged (block type)');
    for (;;) {
      let sym = decode(lc);
      if (sym < 256) { room(1); out[op++] = sym; continue; }
      if (sym === 256) break;
      sym -= 257; if (sym >= 29) throw bad('the compressed data is damaged (length)');
      const len = LBASE[sym] + bits(LEXT[sym]); const ds = decode(dc); if (ds >= 30) throw bad('the compressed data is damaged (distance)');
      const dist = DBASE[ds] + bits(DEXT[ds]); if (dist > op) throw bad('the compressed data is damaged (distance too far)');
      room(len); for (let k = 0; k < len; k++, op++) out[op] = out[op - dist];
    }
  }
  return out.subarray(0, op);
}
let zlib = null; try { zlib = require('node:zlib'); } catch { zlib = null; }
function inflateRaw(src, maxOut) {
  if (zlib && typeof zlib.inflateRawSync === 'function') {
    try { const o = zlib.inflateRawSync(src, { maxOutputLength: maxOut }); return new Uint8Array(o.buffer, o.byteOffset, o.length); }
    catch (e) { throw bad(e && e.code === 'ERR_BUFFER_TOO_LARGE' ? `the file inflates to more than ${maxOut} bytes` : 'the compressed data is damaged'); }
  }
  return inflateRawJs(src, maxOut);
}
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
/** The archive's directory, and get(name) → the bytes of one member. Only what is asked for is inflated, and the
 *  total inflated is bounded: an archive that claims little and inflates to much is refused, not expanded. */
function zipOpen(b, limits) {
  if (b.length < 22 || u32(b, 0) !== 0x04034b50) throw bad('not a ZIP archive, so not an .xlsx workbook (an old .xls file must be saved as .xlsx)');
  let e = -1; for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (u32(b, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw bad('the ZIP archive has no directory (the file is cut short)');
  const total = u16(b, e + 10), cdSize = u32(b, e + 12), cdOff = u32(b, e + 16);
  if (total === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw bad('a ZIP64 archive is larger than a roster needs to be');
  if (cdOff + cdSize > b.length || total > 5000) throw bad('the ZIP directory is damaged');
  const entries = new Map(); let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw bad('the ZIP directory is damaged');
    const flags = u16(b, p + 8), method = u16(b, p + 10), csize = u32(b, p + 20), usize = u32(b, p + 24), nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32), off = u32(b, p + 42);
    let name = ''; for (let k = 0; k < nl && k < 512; k++) name += U(b[p + 46 + k]);
    entries.set(name.toLowerCase().replace(/\\/g, '/'), { flags, method, csize, usize, off });
    p += 46 + nl + xl + cl;
  }
  let inflated = 0;
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name.toLowerCase()),
    get(name) {
      const en = entries.get(name.toLowerCase()); if (!en) return null;
      if (en.flags & 1) throw bad('the workbook is password-protected');
      if (en.off + 30 > b.length || u32(b, en.off) !== 0x04034b50) throw bad('the ZIP archive is damaged');
      const start = en.off + 30 + u16(b, en.off + 26) + u16(b, en.off + 28);
      if (start + en.csize > b.length) throw bad('the ZIP archive is cut short');
      const raw = b.subarray(start, start + en.csize); const left = limits.inflated - inflated;
      let out;
      if (en.method === 0) { if (raw.length > left) throw bad(`the workbook holds more than ${limits.inflated} bytes`); out = raw; }
      else if (en.method === 8) out = inflateRaw(raw, Math.max(0, left));
      else throw bad('the workbook uses a compression this reader does not have');
      inflated += out.length; return out;
    }
  };
}

/* ------------------------------------------------------------------ Excel (.xlsx, .xlsm) */
const colIndex = (ref) => { let c = 0; for (let i = 0; i < ref.length; i++) { const k = ref.charCodeAt(i) & 0xdf; if (k < 65 || k > 90) break; c = c * 26 + (k - 64); } return c - 1; };
function readXlsx(u8, B, limits) {
  const zip = zipOpen(u8, limits); const utf8 = (b) => new TextDecoder('utf-8').decode(b);
  const wbBytes = zip.get('xl/workbook.xml'); if (!wbBytes) throw bad('the archive is not an Excel workbook (no xl/workbook.xml)');
  const sheets = []; let date1904 = false;
  xmlScan(utf8(wbBytes), { open(n, a) { if (n === 'sheet') { let rid = ''; for (const k of Object.keys(a)) if (k.indexOf(':') > 0 && localName(k) === 'id') rid = a[k]; sheets.push({ name: a.name || `Sheet${sheets.length + 1}`, rid, state: a.state || '' }); } else if (n === 'workbookpr' && (a.date1904 === '1' || a.date1904 === 'true')) date1904 = true; }, text() {}, close() {} }, limits.depth);
  const rels = new Map(); let sharedPath = 'xl/sharedstrings.xml';
  const relBytes = zip.get('xl/_rels/workbook.xml.rels');
  if (relBytes) xmlScan(utf8(relBytes), { open(n, a) { if (n !== 'relationship' || !a.Target) return; const t = a.Target.replace(/\\/g, '/'); const pth = t[0] === '/' ? t.slice(1) : 'xl/' + t; if (/sharedStrings$/i.test(a.Type || '')) sharedPath = pth; if (a.Id) rels.set(a.Id, { path: pth, type: a.Type || '' }); }, text() {}, close() {} }, limits.depth);
  const shared = []; const ssBytes = zip.get(sharedPath);
  if (ssBytes) { let cur = null, inT = false, skip = 0; xmlScan(utf8(ssBytes), { open(n) { if (n === 'si') cur = ''; else if (n === 'rph') skip++; else if (n === 't') inT = true; }, text(t) { if (inT && !skip && cur !== null && cur.length < 4000) cur += t; }, close(n) { if (n === 't') inT = false; else if (n === 'rph') skip--; else if (n === 'si') { shared.push(cur || ''); cur = null; if (shared.length > limits.cells) throw bad('the workbook has too many strings'); } } }, limits.depth); }
  if (!sheets.length) throw bad('the workbook has no sheets');
  if (sheets.length > limits.sheets) throw bad(`the workbook has more than ${limits.sheets} sheets`);
  let cells = 0, used = 0;
  sheets.forEach((sh, si) => {
    const rel = rels.get(sh.rid); const pth = rel ? rel.path : `xl/worksheets/sheet${si + 1}.xml`;
    if (rel && !/worksheet$/i.test(rel.type)) return;                              // a chart sheet has no table
    if (sh.state === 'hidden' || sh.state === 'veryHidden') { B.note(`sheet "${squeeze(sh.name).slice(0, 40)}" is hidden: not read`); return; }
    const bytes = zip.get(pth); if (!bytes) return;
    const rows = [], nums = []; let row = null, cell = null, inV = false, inData = false, auto = 0;
    xmlScan(utf8(bytes), {
      open(n, a) {
        if (n === 'sheetdata') inData = true;
        else if (!inData) return;
        else if (n === 'row') { row = []; auto = Number(a.r) > 0 ? Number(a.r) : auto + 1; if (rows.length >= limits.rows) throw bad(`sheet "${squeeze(sh.name).slice(0, 40)}" has more than ${limits.rows} rows`); }
        else if (n === 'c' && row) { cell = { col: a.r ? colIndex(a.r) : row.length, t: a.t || 'n', v: '' }; if (++cells > limits.cells) throw bad(`the workbook has more than ${limits.cells} cells`); }
        else if ((n === 'v' || n === 't') && cell) inV = true;
      },
      text(t) { if (inV && cell.v.length < 4000) cell.v += t; },
      close(n) {
        if (n === 'v' || n === 't') inV = false;
        else if (n === 'c' && cell && row) {
          let v = cell.v;
          if (cell.t === 's') v = shared[Number(v)] || ''; else if (cell.t === 'b') v = v === '1' ? 'TRUE' : 'FALSE'; else if (cell.t === 'e') v = '';
          else if (cell.t === 'n' && /^-?\d+\.0+$/.test(v)) v = v.replace(/\.0+$/, '');
          if (cell.col >= 0 && cell.col < limits.cols) { while (row.length < cell.col) row.push(''); row[cell.col] = v; }
          cell = null;
        } else if (n === 'row' && row) { rows.push(row); nums.push(auto); row = null; }
        else if (n === 'sheetdata') inData = false;
      }
    }, limits.depth);
    if (!rows.some((r) => r.some((c) => squeeze(c)))) return;
    used++;
    B.table({ title: sh.name, rows, whereOf: (i) => `sheet "${squeeze(sh.name).slice(0, 40)}" row ${nums[i] || i + 1}`, opt: { serial: true, date1904 }, hint: KIND_WORDS[normKey(sh.name)] || null });
  });
  if (!used) throw bad('the workbook has no sheet with data');
}

/* ------------------------------------------------------------------ XML rosters */
const XML_KIND = { league: 'league', ligue: 'league', team: 'team', club: 'team', equipe: 'team', franchise: 'team', player: 'player', joueur: 'player', skater: 'player', goalie: 'player', goaltender: 'player', gardien: 'player', athlete: 'player' };
const XML_ROW = new Set(['row', 'record', 'item', 'entry', 'rec', 'line', 'ligne']);
const RANK = { league: 3, team: 2, player: 1, row: 0 };
function readXml(text, B, limits) {
  // the line of a position, for messages (positions only grow, so the count is linear over the document)
  let lp = 0, ln = 1; const lineAt = (at) => { for (let k = text.indexOf('\n', lp); k >= 0 && k < at; k = text.indexOf('\n', k + 1)) { ln++; lp = k + 1; } return ln; };
  const root = { kind: 'root', fields: {}, kids: [] }; const stack = [{ rec: root, name: '', text: '', children: 0, attrs: 0, at: 0 }];
  let records = 0; let sheet = null;                                             // Excel 2003 XML: Workbook / Worksheet / Table / Row / Cell / Data
  const nearest = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].rec) return stack[i].rec; return root; };
  xmlScan(text, {
    open(n, a, at) {
      const top = stack[stack.length - 1]; top.children++;
      if (sheet || (stack.length === 1 && n === 'workbook')) {
        if (!sheet) sheet = { tables: [], cur: null, row: null, cell: false, col: 0 };
        if (n === 'worksheet') { let name = ''; for (const k of Object.keys(a)) if (localName(k) === 'name') name = a[k]; sheet.cur = { name, rows: [], lines: [] }; sheet.tables.push(sheet.cur); }
        else if (n === 'row' && sheet.cur) { sheet.row = []; sheet.col = 0; let idx = 0; for (const k of Object.keys(a)) if (localName(k) === 'index') idx = Number(a[k]); while (idx > 0 && sheet.cur.rows.length < idx - 1 && sheet.cur.rows.length < limits.rows) { sheet.cur.rows.push([]); sheet.cur.lines.push(lineAt(at)); } sheet.cur.lines.push(lineAt(at)); if (sheet.cur.rows.length >= limits.rows) throw bad(`more than ${limits.rows} rows`); }
        else if (n === 'cell' && sheet.row) { for (const k of Object.keys(a)) if (localName(k) === 'index' && Number(a[k]) > 0) sheet.col = Number(a[k]) - 1; while (sheet.row.length < sheet.col && sheet.row.length < limits.cols) sheet.row.push(''); }
        else if (n === 'data' && sheet.row) { sheet.cell = true; if (sheet.row.length <= sheet.col && sheet.col < limits.cols) sheet.row[sheet.col] = ''; }
        stack.push({ rec: null, name: n, text: '', children: 0, attrs: 0, at }); return;
      }
      const kind = XML_KIND[n] || (XML_ROW.has(n) ? 'row' : null); const keys = Object.keys(a).filter((k) => !/^xmlns(:|$)/.test(k) && k.indexOf(':') < 0);
      const f = { rec: null, name: n, text: '', children: 0, attrs: keys.length, at, kind };
      if (kind) { if (++records > limits.players + limits.teams + limits.leagues + 1000) throw bad('the document holds more records than a roster can'); f.rec = { kind, fields: {}, kids: [], at }; for (const k of keys) f.rec.fields[k] = a[k]; }
      else if (keys.length && top.rec === null && stack.length > 1) { /* a wrapper's own attributes say nothing */ }
      else if (keys.length) f.leafAttrs = Object.fromEntries(keys.map((k) => [k, a[k]]));
      stack.push(f);
    },
    text(t) { const top = stack[stack.length - 1]; if (sheet) { if (sheet.cell && sheet.row && sheet.col < limits.cols && (sheet.row[sheet.col] || '').length < 2000) sheet.row[sheet.col] = (sheet.row[sheet.col] || '') + t; return; } if (top.text.length < 2000) top.text += t; },
    close(n) {
      if (stack.length <= 1) return;
      if (sheet) { const f = stack.pop(); if (f.name === 'data') sheet.cell = false; else if (f.name === 'cell') sheet.col++; else if (f.name === 'row' && sheet.row && sheet.cur) { sheet.cur.rows.push(sheet.row); sheet.row = null; } else if (f.name === 'worksheet') sheet.cur = null; return; }
      const f = stack.pop(); void n; const parent = nearest(); const txt = squeeze(f.text);
      if (f.rec) {
        // <team>Kelowna</team> inside a player is that player's team; <player>John Smith</player> inside a team is a player
        const leaf = f.children === 0 && f.attrs === 0;
        if (leaf && txt && parent !== root && RANK[f.kind] >= RANK[parent.kind]) { if (parent.fields[f.name] === undefined) parent.fields[f.name] = txt; return; }
        if (leaf && !txt) return;
        if (txt && f.rec.fields.name === undefined && f.children === 0) f.rec.fields.name = txt;
        parent.kids.push(f.rec); return;
      }
      if (f.children === 0 && txt && parent !== root) { if (parent.fields[f.name] === undefined) parent.fields[f.name] = txt; }
      else if (f.children === 0 && f.leafAttrs && parent !== root) for (const [k, v] of Object.entries(f.leafAttrs)) if (parent.fields[`${f.name}${k}`] === undefined && parent.fields[k] === undefined) parent.fields[k === 'value' || k === 'val' ? f.name : k] = v;
    }
  }, limits.depth);
  if (sheet) { for (const tb of sheet.tables) if (tb.rows.some((r) => r.some((c) => squeeze(c)))) B.table({ title: tb.name, rows: tb.rows, whereOf: (i) => `sheet "${squeeze(tb.name).slice(0, 40)}" line ${tb.lines[i] || 1}`, opt: { serial: false }, hint: KIND_WORDS[normKey(tb.name)] || null }); return; }
  const emit = (rec) => {
    const where = `line ${lineAt(rec.at)}`; const saveL = B.league, saveT = B.team;
    let kind = rec.kind;
    if (kind === 'row') { const have = new Set(Object.keys(rec.fields).map(fieldOf).filter(Boolean)); const tv = Object.entries(rec.fields).find(([k]) => fieldOf(k) === 'type'); kind = (tv && KIND_WORDS[normKey(tv[1])]) || (PLAYERISH.some((k) => have.has(k)) || (have.has('name') && (have.has('team') || B.team >= 0)) ? 'player' : TEAMISH.some((k) => have.has(k)) ? 'team' : LEAGUEISH.some((k) => have.has(k)) ? 'league' : have.has('name') ? (B.league >= 0 ? 'team' : 'league') : null); if (!kind) { B.err(where, 'a record with no field this reader knows'); return; } }
    const i = B.entity(kind, rec.fields, where);
    if (kind === 'league') { B.league = i; B.team = -1; } else if (kind === 'team') B.team = i;
    for (const k of rec.kids) emit(k);
    B.league = saveL; B.team = saveT;
  };
  for (const k of root.kids) emit(k);
  if (!root.kids.length) B.err('line 1', 'no <league>, <team>, <player> or <row> element was found');
}

/* ------------------------------------------------------------------ Markdown */
/** the cells of a pipe-table row: a | divides, unless a backslash stands before it (no lookbehind: older browsers) */
function splitPipes(s) { const out = []; let cur = ''; for (let i = 0; i < s.length; i++) { const c = s[i]; if (c === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; } else if (c === '|') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; }
/** a cell or a line without its markdown: escapes undone, emphasis marks dropped (an underscore inside a word, as in team_code, is not one) */
const mdPlain = (s) => squeeze(String(s).replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1').replace(/\*+|`+/g, '').replace(/(^|[^\p{L}\p{N}])_+/gu, '$1').replace(/_+($|[^\p{L}\p{N}])/gu, '$1'));
const HEAD_KIND = /^(league|ligue|team|club|equipe|franchise)\s*[:\-]\s*(.+)$/i;
function readMarkdown(text, B, limits) {
  const lines = text.split(/\r\n?|\n/); if (lines.length > limits.rows * 4) throw bad('too many lines');
  // which heading level is a league and which a team: said by a prefix ("## Team: …"), or the two shallowest levels in use
  const levels = new Set(); let prefixed = false;
  for (const l of lines) { const m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(l); if (m) { levels.add(m[1].length); if (HEAD_KIND.test(normPrefix(mdPlain(m[2])))) prefixed = true; } }
  const order = [...levels].sort((a, b) => a - b); const leagueLevel = order.length >= 2 ? order[0] : -1, teamLevel = order.length >= 2 ? order[1] : order[0];
  let tbl = null; let title = '';
  const flush = () => { if (tbl) { const t = tbl; tbl = null; B.closePlayer(); B.table({ title, rows: t.rows, whereOf: (i) => `line ${t.lines[i]}` }); } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]; const l = raw.trim();
    const hm = /^(#{1,6})\s+(.*?)\s*#*$/.exec(l);
    if (hm) {
      flush(); const textH = mdPlain(hm[2]); const pm = HEAD_KIND.exec(normPrefix(textH)); let kind = null, name = textH;
      if (pm) { kind = KIND_WORDS[normKey(pm[1])]; name = squeeze(textH.slice(textH.search(/[:\-]/) + 1)); }
      else if (!prefixed) kind = hm[1].length === leagueLevel ? 'league' : hm[1].length === teamLevel ? 'team' : null;
      B.closePlayer(); title = name;
      if (kind === 'league') { B.league = B.ensureLeague({ name }, `line ${i + 1}`); B.team = -1; B.m.counts.rows++; }
      else if (kind === 'team') { B.team = B.ensureTeam({ name }, B.league, `line ${i + 1}`); B.m.counts.rows++; }
      continue;
    }
    if (l.indexOf('|') >= 0 && (l[0] === '|' || /\S\s*\|\s*\S/.test(l))) {
      if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l)) continue;                      // the rule under the header
      const cells = splitPipes(l.replace(/^\|/, '').replace(/\|$/, '')).map(mdPlain);
      if (!tbl) tbl = { rows: [], lines: [] };
      if (tbl.rows.length >= limits.rows) throw bad(`more than ${limits.rows} rows`);
      tbl.rows.push(cells.slice(0, limits.cols)); tbl.lines.push(i + 1); continue;
    }
    flush();
    if (!l || /^(-{3,}|\*{3,}|_{3,}|={3,})$/.test(l)) continue;
    const km = /^(?:[-*+]\s+)?([^:=|]{1,40}?)\s*[:=]\s*(.+)$/.exec(mdPlain(l));
    if (km && fieldOf(km[1])) { B.kv(km[1], km[2], `line ${i + 1}`); continue; }
    if (B.playerLine(mdPlain(l), `line ${i + 1}`)) continue;
    if (km && /^\p{L}[\p{L}\p{N}_ .-]*$/u.test(km[1].trim()) && km[1].trim().split(' ').length <= 3) B.unknownKey(km[1]);   // "Coach: …" is a key with no use here; a sentence with a colon in it is prose
    B.m.counts.ignored++;
  }
  flush();
}
function normPrefix(s) { return String(s).normalize('NFD').replace(/\p{M}/gu, ''); }

/* ------------------------------------------------------------------ text and corpus */
function readText(text, B, limits) {
  const s = sniff(text, ['\t', '|', ';', ',']);
  if (s.known >= 2) { const { rows, lines } = delimited(text, s.delim, limits); B.table({ rows: rows.map((r) => r.map((c) => c.trim())), whereOf: (i) => `line ${lines[i] || 1}` }); return; }
  const lines = text.split(/\r\n?|\n/); if (lines.length > limits.rows * 4) throw bad('too many lines');
  let missed = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim(); const where = `line ${i + 1}`;
    if (!l || l.startsWith('//') || /^#(\s|$)/.test(l) || /^[-=*_]{3,}$/.test(l)) continue;
    const km = /^([^=:]{1,40}?)\s*[=:]\s*(.*)$/.exec(l);
    if (km && fieldOf(km[1])) { B.kv(km[1], km[2], where); continue; }
    const wm = /^(\p{L}+)\s+(.+)$/u.exec(l);
    if (wm && ['league', 'team'].includes(KIND_WORDS[normKey(wm[1])]) && ['league', 'ligue', 'team', 'club', 'equipe', 'franchise'].includes(normKey(wm[1]))) { B.kv(wm[1], wm[2], where); continue; }
    if (B.playerLine(l, where)) continue;
    if (km && /^\p{L}[\p{L}\p{N}_ .-]*$/u.test(km[1].trim())) { B.unknownKey(km[1]); B.m.counts.ignored++; continue; }   // a key this reader has no use for (HK001's own files begin with product_id= …)
    B.m.counts.ignored++; if (++missed <= 5) B.warn(where, `not understood: "${squeeze(l).slice(0, 50)}"`);
  }
}

/* ------------------------------------------------------------------ EDI */
const EDI_KIND = { lge: 'league', lea: 'league', lg: 'league', league: null, tem: 'team', tm: 'team', tea: 'team', clb: 'team', plr: 'player', pl: 'player', ply: 'player' };
const EDI_POS = { league: ['name', 'code', 'abbr', 'name_fr'], team: ['name', 'code', 'city', 'arena', 'timezone', 'name_fr'], player: ['jersey', 'last', 'first', 'pos', 'shoots', 'birth', 'import', 'code'] };
function readEdi(text, B, limits) {
  // elements are separated by the character after "ISA" when the file has that envelope, else by * (or | when there
  // is no *); segments end with ~ or with the line
  let es = '*'; const st = '~'; const t0 = text.replace(/^\s+/, '');
  if (/^ISA[^A-Za-z0-9\s]/i.test(t0)) es = t0[3]; else if (t0.indexOf('*') < 0 && t0.indexOf('|') >= 0) es = '|';
  const segs = []; let line = 1, start = 0;
  for (let i = 0; i <= t0.length; i++) {
    const c = t0[i];
    if (i === t0.length || c === st || c === '\n' || c === '\r') { const sg = t0.slice(start, i).trim(); if (sg) { segs.push([sg, line]); if (segs.length > limits.rows * 4) throw bad('too many segments'); } start = i + 1; if (c === '\n') line++; }
  }
  for (const [sg, ln] of segs) {
    const els = sg.split(es); const tag = normKey(els[0]); const where = `segment ${squeeze(els[0]).slice(0, 12)} on line ${ln}`;
    const kind = EDI_KIND[tag];
    if (kind) {
      const f = {}; const names = EDI_POS[kind]; let pos = 0;
      for (let j = 1; j < els.length; j++) { const kv = /^([\p{L}_# ]{1,24})=(.*)$/u.exec(els[j]); if (kv && fieldOf(kv[1])) f[kv[1]] = kv[2]; else { if (pos < names.length && squeeze(els[j])) f[names[pos]] = els[j]; pos++; } }
      const i = B.entity(kind, f, where);
      if (kind === 'league') { B.league = i; B.team = -1; } else if (kind === 'team') B.team = i;
      continue;
    }
    if (fieldOf(els[0]) && els.length > 1) { B.kv(els[0], els.slice(1).join(es), where); continue; }
    B.m.counts.ignored++;                                             // an envelope segment (ISA, GS, ST …) or one this reader has no use for
  }
}

/* ------------------------------------------------------------------ read */
/** name: the file's name (its extension says the form). bytes: Uint8Array or Buffer. → the model. Throws { code: 'BAD_FILE' }. */
function read(name, bytes, opts = {}) {
  const limits = Object.assign({}, LIMITS, opts.limits || {}); const ext = extOf(name);
  if (!EXT.includes(ext)) throw bad(ext === '.xls' ? 'an old .xls workbook cannot be read: save it as .xlsx (or as CSV)' : `${ext ? `"${ext}" files are` : 'a file without an extension is'} not read; the forms are ${EXT.join(' ')}`);
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!u8.length) throw bad('the file is empty');
  if (u8.length > limits.bytes) throw bad(`the file is ${u8.length} bytes; the limit is ${limits.bytes}`);
  const B = new Builder(ext === '.xlsm' ? 'xlsx' : ext.slice(1), limits);
  const zipped = u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;
  if (ext === '.xlsx' || ext === '.xlsm') readXlsx(u8, B, limits);
  else {
    if (zipped) throw bad(`the file is a ZIP archive (an Excel workbook?), not ${ext} text: name it .xlsx`);
    if (u8.length > 7 && u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) throw bad('the file is an old .xls workbook: save it as .xlsx (or as CSV)');
    const text = decodeText(u8, B.m.notes).split(BOM).join('');
    if (text.indexOf('\u0000') >= 0) throw bad('the file is not text');
    if (ext === '.csv' || ext === '.tsv') readTable(text, ext, B, limits);
    else if (ext === '.xml') readXml(text, B, limits);
    else if (ext === '.md') readMarkdown(text, B, limits);
    else if (ext === '.edi') readEdi(text, B, limits);
    else readText(text, B, limits);
  }
  const m = B.done();
  if (!m.leagues.length && !m.teams.length && !m.players.length && !m.counts.errors) B.err('', 'nothing in the file names a league, a team or a player (rink import formats shows what is read)');
  return m;
}

module.exports = { EXT, LIMITS, FIELDS, read, extOf, isSupported, decodeText, squeeze, normKey, normName, fieldOf, readPos, readHand, readJersey, readBirth, readFlag, splitName, splitTag, Builder, delimited, xmlScan, zipOpen, inflateRawJs, inflateRaw };

/* ------------------------------------------------------------------ writing a workbook, and the examples */
let CRC = null;
function crc32(b) { if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } } let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** A small .xlsx (stored, not compressed) from [{ name, rows: [[cell, …], …] }]: for the examples and the tests.
 *  A number is a number cell, anything else an inline string. Excel, LibreOffice and openpyxl open it. */
function writeXlsx(sheets) {
  const enc = new TextEncoder(); const files = [];
  const colName = (i) => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = U(65 + ((i - 1) % 26)) + s; return s; };
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  files.push(['[Content_Types].xml', `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`]);
  files.push(['_rels/.rels', `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`]);
  files.push(['xl/workbook.xml', `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(String(s.name).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`]);
  files.push(['xl/_rels/workbook.xml.rels', `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`]);
  sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, `${head}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => (c === '' || c === null || c === undefined ? '' : typeof c === 'number' && Number.isFinite(c) ? `<c r="${colName(ci)}${ri + 1}"><v>${c}</v></c>` : `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c)}</t></is></c>`)).join('')}</row>`).join('')}</sheetData></worksheet>`]));
  const parts = []; const dir = []; let off = 0;
  const le = (n, bytes) => { const a = []; for (let k = 0; k < bytes; k++) a.push((n >>> (8 * k)) & 255); return a; };
  for (const [name, text] of files) {
    const nb = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const local = Uint8Array.from([0x50, 0x4b, 3, 4, 20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0, ...le(crc, 4), ...le(data.length, 4), ...le(data.length, 4), ...le(nb.length, 2), 0, 0]);
    parts.push(local, nb, data);
    dir.push(Uint8Array.from([0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0, ...le(crc, 4), ...le(data.length, 4), ...le(data.length, 4), ...le(nb.length, 2), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(off, 4)]), nb);
    off += local.length + nb.length + data.length;
  }
  const dsize = dir.reduce((a, b) => a + b.length, 0);
  const end = Uint8Array.from([0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...le(files.length, 2), ...le(files.length, 2), ...le(dsize, 4), ...le(off, 4), 0, 0]);
  const all = [...parts, ...dir, end]; const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0; for (const x of all) { out.set(x, p); p += x.length; }
  return out;
}
/* The same small league, as each form writes it. Kelowna brings its own code; the others get theirs from the plan. */
/* The example league: invented clubs and people, chosen to show the rules. A two-word city (MEdicine HAt), a code
   the file gives (REGI), accents and an apostrophe (VAl-d'OR); two Smiths (SMIT, then SMIR), a short surname that
   borrows from the given name (ROYP), a surname with particles (VAND), an apostrophe (OREI), accents (COTE), a
   hyphen (TREM). None of its codes is one of the demonstration league's (FOCO, KELW, RIMO, SASK). */
const EX = {
  leagues: [['Prairie Junior League', 'PJL'], ["Ligue de l'Est", 'LDE']],
  teams: [['Prairie Junior League', 'Medicine Hat Comets', '', 'Medicine Hat', 'Comets Arena'], ['Prairie Junior League', 'Regina Rockets', 'REGI', 'Regina', 'Rockets Centre'], ["Ligue de l'Est", "Val-d'Or Bor\u00e9als", '', "Val-d'Or", 'Ar\u00e9na des Bor\u00e9als']],
  players: [['Medicine Hat Comets', 9, 'Smith', 'John', 'C', 'L', '2006-02-03'], ['Medicine Hat Comets', 19, 'Smith', 'Ryan', 'LW', 'R', '2007-11-21'], ['Medicine Hat Comets', 4, 'van der Berg', 'Jan', 'D', 'L', '2005-07-09'], ['Medicine Hat Comets', 31, 'Roy', 'Philippe', 'G', 'L', '2006-10-05'],
    ['Regina Rockets', 91, 'Halaburda', 'Tomas', 'RW', 'R', '2006-04-17'], ['Regina Rockets', 27, "O'Reilly", 'Sean', 'D', 'R', '2007-01-30'], ['Regina Rockets', 1, 'Witczak', 'Adam', 'G', 'L', '2005-12-12'],
    ["Val-d'Or Bor\u00e9als", 12, 'C\u00f4t\u00e9', '\u00c9mile', 'C', 'L', '2006-06-06'], ["Val-d'Or Bor\u00e9als", 77, 'Tremblay-Gagnon', 'Pierre-Luc', 'D', 'R', '2007-03-28']]
};
function examples() {
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const league = (n) => EX.leagues.find((l) => l[0] === n); const team = (n) => EX.teams.find((t) => t[1] === n);
  const flat = EX.players.map((p) => { const t = team(p[0]); const l = league(t[0]); return [l[0], l[1], t[1], t[2], t[3], t[4], p[1], p[2], p[3], p[4], p[5], p[6]]; });
  const header = ['league', 'league_abbr', 'team', 'team_code', 'city', 'arena', 'jersey', 'last_name', 'first_name', 'pos', 'shoots', 'born'];
  const out = {};
  out['roster.csv'] = [header, ...flat].map((r) => r.map(q).join(',')).join('\n') + '\n';
  out['roster.tsv'] = [header, ...flat].map((r) => r.join('\t')).join('\n') + '\n';
  let md = '', txt = '', xml = '<?xml version="1.0" encoding="UTF-8"?>\n<roster>\n', edi = '';
  for (const l of EX.leagues) {
    md += `# ${l[0]} (${l[1]})\n\n`; txt += `league = ${l[0]}\nleague_abbr = ${l[1]}\n\n`; xml += `  <league name="${xmlEsc(l[0])}" abbr="${l[1]}">\n`; edi += `LGE*${l[0]}**${l[1]}~\n`;
    for (const t of EX.teams.filter((x) => x[0] === l[0])) {
      md += `## ${t[1]}${t[2] ? ` [${t[2]}]` : ''}\n\nCity: ${t[3]}\nArena: ${t[4]}\n\n| # | Player | Pos | Shoots | Born |\n|---|---|---|---|---|\n`;
      txt += `team = ${t[1]}\n${t[2] ? `team_code = ${t[2]}\n` : ''}city = ${t[3]}\narena = ${t[4]}\n`;
      xml += `    <team name="${xmlEsc(t[1])}"${t[2] ? ` code="${t[2]}"` : ''} city="${xmlEsc(t[3])}" arena="${xmlEsc(t[4])}">\n`; edi += `TEM*${t[1]}*${t[2]}*${t[3]}*${t[4]}~\n`;
      for (const p of EX.players.filter((x) => x[0] === t[1])) {
        md += `| ${p[1]} | ${p[2]}, ${p[3]} | ${p[4]} | ${p[5]} | ${p[6]} |\n`; txt += `player = ${p[2]}, ${p[3]}\njersey = ${p[1]}\npos = ${p[4]}\nshoots = ${p[5]}\nborn = ${p[6]}\n`;
        xml += `      <player jersey="${p[1]}" last="${xmlEsc(p[2])}" first="${xmlEsc(p[3])}" pos="${p[4]}" shoots="${p[5]}" born="${p[6]}"/>\n`; edi += `PLR*${p[1]}*${p[2]}*${p[3]}*${p[4]}*${p[5]}*${p[6]}~\n`;
      }
      md += '\n'; txt += '\n'; xml += '    </team>\n';
    }
    xml += '  </league>\n';
  }
  out['roster.md'] = md; out['roster.txt'] = txt; out['roster.corpus'] = txt; out['roster.xml'] = xml + '</roster>\n'; out['roster.edi'] = edi;
  return out;
}
/** the same league as a workbook: a sheet of leagues, a sheet of teams, and one sheet of players per team */
function exampleXlsx() {
  const sheets = [{ name: 'Leagues', rows: [['league', 'abbr'], ...EX.leagues] }, { name: 'Teams', rows: [['league', 'team', 'code', 'city', 'arena'], ...EX.teams] }];
  for (const t of EX.teams) sheets.push({ name: t[1], rows: [['No', 'Last name', 'First name', 'Pos', 'Shoots', 'Born'], ...EX.players.filter((p) => p[0] === t[1]).map((p) => p.slice(1))] });
  return writeXlsx(sheets);
}
module.exports.writeXlsx = writeXlsx; module.exports.examples = examples; module.exports.exampleXlsx = exampleXlsx; module.exports.crc32 = crc32;
