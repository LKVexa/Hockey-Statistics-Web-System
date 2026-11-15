'use strict';
/**
 * The Q engine (spec §3 "Q" queries): structured results over one game or a scope of games. Rendering is the
 * caller's job (SPIRAL tables in the terminal, HTML in the dashboard), so both show the same numbers.
 *
 *   Q SCORE · Q BOX · Q EVENTS [n] · Q XG · Q STINTS · Q PEN · Q PLAYER <TEAM> <PLAYER>
 *   Q STANDINGS · Q LEADERS · Q RAPM [--str=5v5|EV|PP|ALL] [--min=minutes] · Q GSAX · Q GAR · Q WAR · Q NHLE
 *   Q HEAT [--team=] · Q LEDGER · Q AUDIT [n] · Q ROSTER <TEAM> · Q CODES
 * Scope flags: --game=<key> (default: the current game) · --season (every game) · --team=<TEAM_4>
 *
 * Arguments and flags come from clients, and from people who mistype. What a query cannot place is refused and
 * named, never ignored or replaced by a default: `Q RAPM --str=PK` must not answer with the 5v5 table. Each query
 * lists the flags it takes (TAKES); a count is a whole number, clamped to its range; a team is a registered team.
 * League-wide answers are cached until the league changes (service.epoch), and the two model fits
 * (RAPM, GAR) run in slices so they never hold the gateway's event loop: run() returns a promise for those.
 * Who typed a line (operator ids, the audit trail) is shown to scorers and admins only.
 */
const models = require('./models');
const heat = require('./heat');
const XG = require('../shared/xg');
const hcl = require('../shared/hcl');
const { teamGameCached: teamGame, shotSums } = require('./derive');
const { clockText, periodText } = require('./actor');

const r3 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
/** a client's own word echoed back in an error message: printable ASCII only, bounded */
const safe = (v, n = 24) => String(v).replace(/[^\x20-\x7e]/g, '').slice(0, n);
/** a count: absent → the default; a whole number → clamped to [lo, hi]; anything else is refused */
function count(name, v, def, lo, hi) {
  if (v === undefined || v === null) return def;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d{1,9}$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n)) throw new Error(`${name}: ${v === true ? 'a number is missing' : safe(v) + ' is not a whole number'}`);
  return Math.max(lo, Math.min(hi, n));
}
/** a switch: absent or false → false; true, 1, "1", "true" → true */
function onOff(name, v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '0' || v === 'false') return false;
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  throw new Error(`${name} is a switch: ${safe(v)} was not expected`);
}
/** flags are scalars: a word, a finite number or a switch */
function cleanFlags(flags) {
  const out = Object.create(null);
  if (flags === undefined || flags === null) return out;
  if (typeof flags !== 'object' || Array.isArray(flags)) throw new Error('flags: an object of name and value pairs was expected');
  const keys = Object.keys(flags); if (keys.length > 24) throw new Error('too many flags');
  for (const k of keys) {
    const v = flags[k];
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(k)) throw new Error(`--${safe(k)}: not a flag name`);
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 64)) out[k] = v;
    else throw new Error(`--${k}: a flag is a word, a number or a switch`);
  }
  return out;
}
function cleanArgs(args) {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args) || args.length > 8) throw new Error('args: a short list of words was expected');
  return args.map((a) => { if (typeof a === 'string' && a.length <= 64) return a; if (typeof a === 'number' && Number.isFinite(a)) return String(a); throw new Error('args: a short list of words was expected'); });
}
const CACHED = new Set(['STANDINGS', 'LEADERS', 'RAPM', 'GSAX', 'GAR', 'NHLE']);       // always league-wide
const SEASON_CACHED = new Set(['BOX', 'XG', 'HEAT', 'HK001']);                          // cached with --season
const TARGETS = ['SCORE', 'BOX', 'EVENTS', 'XG', 'STINTS', 'PEN', 'PLAYER', 'STANDINGS', 'LEADERS', 'RAPM', 'GSAX', 'GAR', 'WAR', 'NHLE', 'HEAT', 'LEDGER', 'AUDIT', 'ROSTER', 'CODES', 'HK001'];
const TAKES = hcl.Q_TAKES;                // what each query takes: its flags and its number of arguments (rink/shared/hcl.js)
const STRENGTH = /^(ALL|EV|PP|ST|[3-6]v[3-6])$/i;

function playerRow(b, reg) {
  const p = reg.player(b.pid) || {};
  return { pid: b.pid, team: b.team, code: b.code, jersey: p.jersey, name: b.name, pos: b.pos, gp: b.gp, g: b.g, a: b.a1 + b.a2, a1: b.a1, a2: b.a2, pts: b.g + b.a1 + b.a2, pm: b.pm,
    sog: b.sog, miss: b.miss, ixg: r3(b.ixg), blk: b.blk, hits: b.hits, tk: b.tk, gv: b.gv, fow: b.fow, fol: b.fol, pim: b.pim, ppg: b.ppg, shg: b.shg,
    toi: Math.round(b.toi), toiEV: Math.round(b.toiEV), toiPP: Math.round(b.toiPP), toiSH: Math.round(b.toiSH), ze: b.ze, zx: b.zx, fc: b.fc, omr: b.omr, onGF: b.onGF, onGA: b.onGA };
}
function goalieRow(b, reg, cal) {
  const p = reg.player(b.pid) || {};
  const n = b.fenFaced; const raw = b.gsax;
  return { pid: b.pid, team: b.team, code: b.code, jersey: p.jersey, name: b.name, gp: b.gp, sa: b.sa, ga: b.ga, sv: b.sv, svPct: b.sa ? r3(b.sv / b.sa) : null, unblocked: n, xga: r3(b.xgaFaced),
    gsaxRaw: r3(raw), gsaxEB: r3(models.gsaxEB(raw, n, cal)), hd: [b.hdsv, b.hdsa], md: [b.mdsv, b.mdsa], ld: [b.ldsv, b.ldsa], toi: Math.round(b.toi) };
}

class QueryEngine {
  /** @param {{registry, ctx:(key)=>{game, actor, ledger}, games:()=>Array}} svc */
  constructor(svc) { this.svc = svc; this.reg = svc.registry; this.cache = new Map(); this.cacheEpoch = -1; this.stats = { hits: 0, misses: 0 }; }
  scope({ game, season, team }) {
    if (season) return this.svc.allGames().filter((g) => !team || g.game.home === team || g.game.away === team);
    if (!game) throw new Error('no game selected: use GAME <key>, --game=<key> or --season');
    const c = this.svc.ctx(game); if (!c) throw new Error(`no game ${safe(game)}`);
    return [c];
  }
  /** --team on one game is one of its two teams; over the season it is a team that has played */
  teamIn(pool, team, season) {
    if (team && !pool.some((c) => c.game.home === team || c.game.away === team)) throw new Error(season || !pool.length ? `${team} has no game yet` : `${team} is not in game ${safe(pool[0].game.key)}`);
  }
  /**
   * @param {string} target  one of TARGETS (WAR = GAR)
   * @param {string[]} args  positional arguments
   * @param {object} flags   --key=value flags
   * @param {string|null} cur the caller's current game
   * @param {{score?:boolean}} [caps] what the caller may see (operator ids and the audit trail need `score`)
   * @returns the result, or a promise of it for RAPM and GAR
   */
  run(target, args = [], flags = {}, cur = null, caps = { score: true }) {
    target = typeof target === 'string' ? target.toUpperCase() : '';
    if (target === 'WAR') target = 'GAR';
    if (!TARGETS.includes(target)) throw new Error(`unknown query ${safe(target, 16)}; try ${TARGETS.join(', ')}`);
    flags = cleanFlags(flags); args = cleanArgs(args);
    const [takes, arity] = TAKES[target];
    for (const k of Object.keys(flags)) if (!takes.includes(k)) throw new Error(`${target} does not take --${k}${takes.length ? ` (it takes ${takes.map((f) => '--' + f).join(' ')})` : ''}`);
    if (args.length > arity) throw new Error(arity ? `${target} takes at most ${arity} argument${arity > 1 ? 's' : ''}` : `${target} takes no argument: ${safe(args[0])}${takes.includes('team') && this.reg.team(String(args[0]).toUpperCase()) ? ` (a team is --team=${String(args[0]).toUpperCase()})` : ''}`);
    const season = onOff('--season', flags.season);
    if (flags.game !== undefined && (typeof flags.game !== 'string' || !flags.game)) throw new Error('--game needs a game key, as in --game=G1');
    const game = flags.game !== undefined ? flags.game : (season ? null : typeof cur === 'string' ? cur : null);
    let team = null;
    if (flags.team !== undefined) {
      team = typeof flags.team === 'string' ? flags.team.toUpperCase() : '';
      if (!this.reg.team(team)) throw new Error(team ? `no team ${safe(team, 8)}` : '--team needs a team code, as in --team=FOCO');
    }
    const head = { target, scope: season ? 'season' : game };
    const compute = () => this['q' + target]({ args, flags, game, team, season, caps: caps || {} });
    const done = (r) => Object.assign({}, head, r);
    if (!(CACHED.has(target) || (season && SEASON_CACHED.has(target)))) return done(compute());
    // league-wide answers are shared until the league changes; a fit in flight is shared too
    if (this.cacheEpoch !== this.svc.epoch) { this.cache.clear(); this.cacheEpoch = this.svc.epoch; }
    const key = JSON.stringify([target, args, Object.keys(flags).sort().map((k) => [k, flags[k]]), season ? null : game]);
    let hit = this.cache.get(key);
    if (hit === undefined) {
      this.stats.misses++;
      if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value);
      hit = compute(); this.cache.set(key, hit);
      if (hit && typeof hit.then === 'function') hit.catch(() => { if (this.cache.get(key) === hit) this.cache.delete(key); });
    } else this.stats.hits++;
    return hit && typeof hit.then === 'function' ? hit.then(done) : done(hit);
  }
  /* ---------------------------------------------------------------- one game */
  qSCORE({ game }) { const c = this.scope({ game }); return { scoreboard: c[0].actor.scoreboard() }; }
  qBOX({ game, season, team }) {
    const pool = this.scope({ game, season, team });
    const box = models.mergeBoxes(pool.map((c) => c.actor.state.players));
    const cal = models.CALIBRATION;
    this.teamIn(pool, team, season);
    const teams = (season ? [...new Set(pool.flatMap((c) => [c.game.home, c.game.away]))] : [pool[0].game.home, pool[0].game.away]).filter((t) => !team || t === team);
    const out = {};
    for (const t of teams) {
      const ps = [...box.values()].filter((b) => b.team === t);
      const totals = { G: 0, SOG: 0, xGF: 0, CF: 0, FF: 0, HDCF: 0, PPG: 0, PP_OPP: 0, FOW: 0, FO: 0, PIM: 0, HITS: 0, BLK: 0, GP: 0 };
      for (const c of pool) { if (c.game.home !== t && c.game.away !== t) continue; const f = teamGame(c.game, c.actor.state, t); totals.GP += f.GP; totals.G += f.G; totals.SOG += f.SOG; totals.xGF += f.xGF; totals.CF += f.SAT; totals.FF += f.USAT; totals.HDCF += f.HDCF; totals.PPG += f.PPG; totals.PP_OPP += f.PP_OPP; totals.FOW += f.FO_WON; totals.FO += f.FO_TAKEN; }
      for (const b of ps) { totals.PIM += b.pim; totals.HITS += b.hits; totals.BLK += b.blk; }
      totals.xGF = r3(totals.xGF);
      out[t] = { skaters: ps.filter((b) => b.pos !== 'G').map((b) => playerRow(b, this.reg)).sort((a, b) => b.pts - a.pts || b.g - a.g || b.ixg - a.ixg || a.jersey - b.jersey),
        goalies: ps.filter((b) => b.pos === 'G' && (b.sa || b.toi)).map((b) => goalieRow(b, this.reg, cal)), totals };
    }
    return { teams: out, games: pool.length, scoreboard: season ? null : pool[0].actor.scoreboard() };
  }
  qEVENTS({ game, args, flags, caps }) {
    const c = this.scope({ game })[0]; const n = args[0] !== undefined ? count('EVENTS', args[0], 25, 1, 500) : count('--n', flags.n, 25, 1, 500);
    const evs = c.actor.state.events.slice(-n).map((e) => ({ seq: e.seq, rev: e.rev, period: periodText(e.period, c.game), clock: clockText(e.clockDs), elapsed: e.elapsed, team: e.team, code: e.code, name: e.name, stat: e.stat, mod: e.mod,
      x: e.x, y: e.y, coordSource: e.coordSource, xg: e.xg || null, xgF: e.xgF || null, danger: e.danger, rebound: e.rebound, rush: e.rush, strength: e.strength, situation: e.situation, assists: e.assists.filter(Boolean).map((pid) => (this.reg.player(pid) || {}).code), operator: caps.score ? e.operator : undefined, text: e.text, auto: e.auto ? `${e.opp} ${e.auto.code} ${e.auto.stat}` : null, penalty: e.penalty || null }));
    return { events: evs, total: c.actor.state.events.length, notes: c.actor.state.notes.slice(-10) };
  }
  qXG({ game, season, team }) {
    const pool = this.scope({ game, season, team }); const teams = {}; this.teamIn(pool, team, season);
    for (const c of pool) for (const t of [c.game.home, c.game.away]) {
      if (team && t !== team) continue;
      const f = teamGame(c.game, c.actor.state, t); const x = teams[t] || (teams[t] = { xGF: 0, xGA: 0, G: 0, GA: 0, HDCF: 0, HDCA: 0, SCF: 0, SCA: 0, unblocked: 0, rawXG: 0, flurryDiscount: 0, GP: 0 });
      x.GP += f.GP; x.xGF += f.xGF; x.xGA += f.xGA; x.G += f.G; x.GA += f.GA; x.HDCF += f.HDCF; x.HDCA += f.HDCA; x.SCF += f.SCF; x.SCA += f.SCA;
      const ss = shotSums(c.actor.state)[t]; if (ss) { x.unblocked += ss.unblocked; x.rawXG += ss.rawXG; x.flurryDiscount += ss.flurryDiscount; }
    }
    for (const x of Object.values(teams)) { for (const k of ['xGF', 'xGA', 'rawXG', 'flurryDiscount']) x[k] = r3(x[k]); x.xgfPct = x.xGF + x.xGA > 0 ? r3(x.xGF / (x.xGF + x.xGA)) : null; x.gax = r3(x.G - x.xGF); }
    const shots = season ? [] : pool[0].actor.state.events.filter((e) => ['S', 'G', 'M'].includes(e.stat) && e.situation !== 'SO').slice(-40).map((e) => ({ seq: e.seq, team: e.team, code: e.code, stat: e.stat, x: e.x, y: e.y, src: e.coordSource, shot: e.shotType, xg: e.xg, xgF: e.xgF, danger: e.danger, rebound: e.rebound, rush: e.rush, dist: e.dist, angle: e.angle }));
    return { teams, shots, model: 'spec log-odds xG with flurry discounting (rink/shared/xg.js)' };
  }
  qSTINTS({ game, flags }) {
    const c = this.scope({ game })[0]; const n = count('--n', flags.n, 20, 1, 400);
    const code = (pid) => (this.reg.player(pid) || {}).code || '?';
    const list = c.actor.liveStints().slice(-n).map((t) => ({ id: t.id, period: periodText(t.period, c.game), start: t.startEl, end: t.endEl, dur: Math.round((t.endEl - t.startEl) * 10) / 10, strength: t.strength, zone: t.zoneStart, ppExpiry: t.ppExpiry, scoreDiff: t.homeScoreDiff,
      home: t.homeSkaters.map(code), away: t.awaySkaters.map(code), homeCF: t.home.cf, awayCF: t.away.cf, homeXGF: r3(t.home.xgf), awayXGF: r3(t.away.xgf), live: !!t.live }));
    return { stints: list, total: c.actor.state.stints.length, home: c.game.home, away: c.game.away };
  }
  qPEN({ game }) {
    const c = this.scope({ game })[0]; const s = c.actor.state; const code = (pid) => (this.reg.player(pid) || {}).code;
    return { penalties: s.penalties.map((p) => ({ id: p.id, team: p.team, code: code(p.pid), kind: p.kind, infraction: p.infraction, start: p.startEl, end: Number.isFinite(p.endEl) ? p.endEl : null, active: p.active && !p.done, queued: p.queued, how: p.how || null })), scoreboard: c.actor.scoreboard() };
  }
  qPLAYER({ args, game, season }) {
    const [t, tok] = args; if (!t || !tok) throw new Error('usage: Q PLAYER <TEAM_4> <PLAYER_4|J##|##>');
    const p = this.reg.resolvePlayer(t.toUpperCase(), tok); if (!p) throw new Error(`${safe(t, 4)} ${safe(tok, 6)}: no such player`);
    const pool = this.scope({ game, season: season || !game, team: p.team });
    const box = models.mergeBoxes(pool.map((c) => c.actor.state.players)); const b = box.get(p.pid);
    const events = []; for (const c of pool) for (const e of c.actor.state.events) if (e.pid === p.pid || e.assists.includes(p.pid)) events.push({ game: c.game.key, seq: e.seq, period: periodText(e.period, c.game), clock: clockText(e.clockDs), text: e.text, xg: e.xgF || null, assist: e.pid !== p.pid });
    return { player: Object.assign({}, p, { ageDays: this.reg.ageDays(p, new Date().toISOString().slice(0, 10)) }), line: b ? (p.pos === 'G' ? goalieRow(b, this.reg, models.CALIBRATION) : playerRow(b, this.reg)) : null, events: events.slice(-30), games: pool.length };
  }
  /* ---------------------------------------------------------------- scope */
  qSTANDINGS() {
    const rows = new Map(); const row = (t) => rows.get(t) || rows.set(t, { team: t, gp: 0, w: 0, l: 0, otl: 0, t: 0, pts: 0, gf: 0, ga: 0, rw: 0, xgf: 0, xga: 0, live: 0 }).get(t);
    for (const t of this.reg.teams()) row(t.code);
    for (const c of this.svc.allGames()) {
      const s = c.actor.state; if (!s.events.length) continue;
      for (const t of [c.game.home, c.game.away]) {
        const f = teamGame(c.game, s, t), x = row(t);
        x.gf += f.G; x.ga += f.GA; x.xgf += f.xGF; x.xga += f.xGA;
        if (!s.result) { x.live++; continue; }
        x.gp++; x.pts += f.POINTS; if (f.W) x.w++; else if (s.result.decidedIn === 'TIE') x.t++; else if (f.POINTS === 1) x.otl++; else x.l++; x.rw += f.RW;
      }
    }
    const list = [...rows.values()].map((x) => Object.assign(x, { diff: x.gf - x.ga, xgf: r3(x.xgf), xga: r3(x.xga), ptsPct: x.gp ? r3(x.pts / (2 * x.gp)) : null }));
    list.sort((a, b) => b.pts - a.pts || b.rw - a.rw || b.diff - a.diff || a.team.localeCompare(b.team));
    return { standings: list, rule: '2 points per win, 1 per overtime or shootout loss, 1 per tie; level teams are separated by regulation wins, then goal differential' };
  }
  qLEADERS({ flags }) {
    const pool = this.svc.allGames(); const box = models.mergeBoxes(pool.map((c) => c.actor.state.players));
    const sk = [...box.values()].filter((b) => b.pos !== 'G').map((b) => playerRow(b, this.reg));
    const n = count('--n', flags.n, 10, 1, 100);
    const top = (k) => sk.slice().sort((a, b) => b[k] - a[k] || b.pts - a.pts).slice(0, n).map((r) => ({ team: r.team, code: r.code, name: r.name, gp: r.gp, value: r[k] }));
    return { points: top('pts'), goals: top('g'), assists: top('a'), ixg: top('ixg'), games: pool.length };
  }
  async qRAPM({ flags, team }) {
    const pool = this.svc.allGames(); const stints = pool.flatMap((c) => c.actor.liveStints());
    if (flags.str !== undefined && !(typeof flags.str === 'string' && STRENGTH.test(flags.str))) throw new Error(`--str=${safe(flags.str, 12)}: a strength is ALL, EV, PP, ST or skaters such as 5v5 and 5v4`);
    const str = (flags.str || '5v5').toUpperCase();
    const filter = str === 'ALL' ? () => true : str === 'EV' ? (s) => s.homeSit === 'EV' : str === 'PP' || str === 'ST' ? (s) => s.homeSit !== 'EV' : (s) => s.strength === str.toLowerCase();
    const res = await models.rapmAsync(stints, { filter, scope: `${pool.length} games, ${str}` });
    const min = count('--min', flags.min, 20, 0, 100000) * 60;
    const rows = res.players.filter((p) => p.toi >= min).map((p) => { const pl = this.reg.player(p.pid) || {}; return { pid: p.pid, team: pl.team, code: pl.code, name: pl.name, pos: pl.pos, toiMin: Math.round(p.toi / 60), off: r3(p.off), def: r3(p.def), net: r3(p.net) }; })
      .filter((r) => !team || r.team === team).sort((a, b) => b.net - a.net);
    return { rows, strength: str, minMinutes: min / 60, model: { stints: res.stints, observations: res.observations, N: res.N, P: res.P, ybar: r3(res.ybar), context: Object.fromEntries(Object.entries(res.context || {}).map(([k, v]) => [k, r3(v)])), iterations: res.iterations, residual: res.residual, lambdaOff: res.lambdaOff, lambdaDef: res.lambdaDef, calibration: res.calibration, note: res.note || null } };
  }
  qGSAX({ team }) {
    const pool = this.svc.allGames(); const box = models.mergeBoxes(pool.map((c) => c.actor.state.players));
    const rows = [...box.values()].filter((b) => b.pos === 'G' && b.fenFaced && (!team || b.team === team)).map((b) => goalieRow(b, this.reg, models.CALIBRATION)).sort((a, b) => b.gsaxEB - a.gsaxEB);
    return { rows, kappa: models.CALIBRATION.gsaxKappa, muPrior: models.CALIBRATION.gsaxPrior, formula: 'EB = n/(n+κ)·Σ(x̃G−Y) + κ/(n+κ)·n·μ_prior over unblocked shots faced' };
  }
  async qGAR({ team, flags }) {
    const pool = this.svc.allGames(); const stints = pool.flatMap((c) => c.actor.liveStints());
    const box = models.mergeBoxes(pool.map((c) => c.actor.state.players));
    const rapmEV = await models.rapmAsync(stints, { filter: (s) => s.homeSit === 'EV' });
    const rapmST = await models.rapmAsync(stints, { filter: (s) => s.homeSit !== 'EV' });
    const today = pool.length ? pool.map((c) => c.game.date).sort().slice(-1)[0] : new Date().toISOString().slice(0, 10);
    const ages = new Map([...box.keys()].map((pid) => { const p = this.reg.player(pid); return [pid, p ? this.reg.ageDays(p, today) : null]; }));
    const g = models.gar({ box, rapmEV, rapmST, ages });
    const n = count('--n', flags.n, 25, 1, 500);
    const rows = g.rows.filter((r) => !team || r.team === team).slice(0, n).map((r) => Object.assign({}, r, Object.fromEntries(['EVO', 'EVD', 'PPO', 'SHD', 'finishing', 'penalties', 'replacement', 'gar', 'war', 'garAgeAdj', 'warAgeAdj', 'ageExpected', 'toiMin'].map((k) => [k, r3(r[k])]))));
    return { rows, ageCurve: g.ageCurve, goalsPerWin: g.goalsPerWin, calibration: g.calibration, knots: g.knots, declared: { penaltyGoalCost: models.CALIBRATION.penaltyGoalCost, replacementPer60: models.CALIBRATION.replacementPer60 } };
  }
  qNHLE({ team, flags }) {
    const pool = this.svc.allGames(); const box = models.mergeBoxes(pool.map((c) => c.actor.state.players));
    const today = pool.length ? pool.map((c) => c.game.date).sort().slice(-1)[0] : new Date().toISOString().slice(0, 10);
    const ages = new Map([...box.keys()].map((pid) => { const p = this.reg.player(pid); return [pid, p ? this.reg.ageDays(p, today) : null]; }));
    const res = models.nhle({ box, ages });
    return { rows: res.rows.filter((r) => !team || r.team === team).slice(0, count('--n', flags.n, 20, 1, 500)).map((r) => Object.assign({}, r, { ppg: r3(r.ppg), ageFactor: r3(r.ageFactor), nhle82: r3(r.nhle82), ageYears: r.ageDays ? r3(r.ageDays / 365.25) : null })), T: r3(res.T), chains: res.chains.map((c) => ({ via: c.via, factor: r3(c.factor) })), note: res.note };
  }
  qHEAT({ game, season, team, flags }) {
    const pool = this.scope({ game, season, team }); this.teamIn(pool, team, season);
    const home = team || (pool[0] && pool[0].game.home);
    const evs = []; for (const c of pool) for (const e of c.actor.state.events) if (!team || e.team === team || e.opp === team) evs.push(season && team ? Object.assign({}, e, { team: e.team === team ? home : '~' }) : e);
    if (flags.engine !== undefined && !['js', 'xpu', 'auto'].includes(flags.engine)) throw new Error(`--engine=${safe(flags.engine, 12)}: js, xpu or auto`);
    if (flags.lanes !== undefined && !(typeof flags.lanes === 'string' && /^[0-7](,[0-7]){0,7}$/.test(flags.lanes))) throw new Error('--lanes is a list of lane numbers 0 to 7, as in --lanes=0,4');
    const packed = onOff('--packed', flags.packed);
    const h = heat.heat(evs, home, { steps: count('--steps', flags.steps, 4, 1, 6), engine: flags.engine === 'js' || flags.engine === 'xpu' ? flags.engine : 'auto' });
    // terminal view: 60 × 17 blocks (2 × 3 cells) of home + away attempts (away is mirrored, so each team's
    // offensive zone is its own end), shaded 0–9; goals marked
    const AC = 60, AR = 17, sum = new Float64Array(AC * AR);
    for (let r = 0; r < h.rows; r++) for (let c = 0; c < h.cols; c++) sum[Math.floor(r / 3) * AC + Math.floor(c / 2)] += h.lanes[0].values[r * h.cols + c] + h.lanes[4].values[r * h.cols + c];
    let mx = 0; for (const v of sum) if (v > mx) mx = v;
    const shade = ' .:-=+*#%@'; const rowsTxt = [];
    for (let r = 0; r < AR; r++) { let s = ''; for (let c = 0; c < AC; c++) s += shade[mx ? Math.min(9, Math.round((sum[r * AC + c] / mx) * 9)) : 0]; rowsTxt.push(s); }
    const goals = []; for (const e of evs) if (e.stat === 'G' && e.situation !== 'SO' && e.x !== null && e.coordSource !== 'prior') { const away = e.team !== home; const [c, r] = heat.cellOf(away ? -e.x : e.x, away ? -e.y : e.y); goals.push([Math.floor(c / 2), Math.floor(r / 3), away ? 1 : 0]); }
    const lanes = flags.lanes !== undefined ? flags.lanes.split(',').map(Number) : [0, 4];
    return { home, away: pool[0] ? (pool[0].game.home === home ? pool[0].game.away : pool[0].game.home) : null, engine: h.engine, steps: h.steps, bandwidthFt: r3(h.bandwidthFt), ms: r3(h.ms), program: h.program, xpu: h.xpu,
      lanes: h.lanes.map((l) => ({ name: l.name, events: l.events, max: l.max })), ascii: { cols: AC, rows: AR, map: rowsTxt, goals }, packed: packed ? heat.pack(h, lanes) : null };
  }
  qLEDGER({ game }) { const c = this.scope({ game })[0]; return { ledger: c.ledger ? c.ledger.info() : null, root: c.ledger ? c.ledger.root() : null, actorLedger: c.actor.ledger.length, stateDigest: c.actor.stateDigest() }; }
  qAUDIT({ game, args, caps }) {
    if (!caps.score) throw Object.assign(new Error('the audit trail names operators: it needs the rink.score capability'), { code: 'FORBIDDEN' });
    const c = this.scope({ game })[0]; return { audit: c.actor.auditView(count('AUDIT', args[0], 20, 1, 200)), total: c.actor.audit.length };
  }
  qROSTER({ args, team }) {
    const t = String(args[0] || team || '').toUpperCase(); if (!this.reg.team(t)) throw new Error('usage: Q ROSTER <TEAM_4>');
    const today = new Date().toISOString().slice(0, 10);
    return { team: this.reg.team(t), players: this.reg.roster(t).map((p) => ({ code: p.code, jersey: p.jersey, name: p.name, pos: p.pos, shoots: p.shoots, birth: p.birth, ageDays: this.reg.ageDays(p, today), import: p.import, pid: p.pid })) };
  }
  qCODES() {
    return { stats: Object.entries(hcl.STATS).map(([k, v]) => ({ token: k, kind: v.kind, label: v.label, inputs: v.inputs })), shotTypes: hcl.SHOT_TYPES, flags: hcl.FLAGS, infractions: hcl.INFRACTIONS, french: hcl.FR, zones: XG.ZONE_NAMES };
  }
  qHK001({ team, args, game, season }) {
    const t = String(args[0] || team || '').toUpperCase(); if (!this.reg.team(t)) throw new Error('usage: Q HK001 <TEAM_4> [--game=<key>|--season]');
    return { case: this.svc.hk001Case({ team: t, game: season ? null : game, season: season || !game }) };
  }
}
module.exports = { QueryEngine, TARGETS };
