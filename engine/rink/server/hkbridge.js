'use strict';
/**
 * HK001 bridge: the ledger → the 109 labelled HK001 inputs (HKI-001 … HKI-109) for one team over a scope, with
 * per-field provenance, so every HK001 computation code can run on real terminal data.
 *
 *   LEDGER     counted directly from committed tokens
 *   DERIVED    from game state, inference (rebounds, rushes, retained entries) or location classes
 *   RESULT     from completed games
 *   LEAGUE     pooled over every game in the scope (league save %, shots per game, score-state Corsi shares)
 *   OPPONENT   the opponents' own derived inputs, games-weighted (TEAM-012 runs HK001 on each opponent)
 *   PRORATED   the token family was never logged in the scope: baseline × GP / 82 (HK001's own convention)
 *   BASELINE   left at the HK001 baseline (stated in the notes)
 * Nothing is invented: a field is PRORATED or BASELINE only when the ledger cannot say anything about it.
 */
const engine = require('../hk001/engine');
const inputs = require('../hk001/inputs');
const { teamGameCached: teamGame, seenTokens, playerGame } = require('./derive');

const BASE = engine.baselineValues ? engine.baselineValues() : engine.BASELINE;
const SUM_FIELDS = inputs.INPUTS.filter((x) => !['player', 'opponent', 'league'].includes(x.scope)).map((x) => x.field);
/** token families each field needs to have been logged at least once (otherwise it is PRORATED) */
const NEEDS = {
  TAKEAWAYS: ['TK'], GIVEAWAYS: ['GV'], OZ_STARTS: ['FOW|FOL'], DZ_STARTS: ['FOW|FOL'], FO_WON: ['FOW|FOL'], FO_TAKEN: ['FOW|FOL'],
  BLOCKS: ['B'], BLOCKED_FOR: ['B'], ODD_MAN_RUSH_FOR: ['OMR'], ODD_MAN_RUSH_AGAINST: ['OMR'],
  EXITS: ['ZX'], EXIT_ATTEMPTS: ['ZX'], CONTROLLED_EXITS: ['ZX/C'], CONTROLLED_ENTRIES: ['ZE/C'], ENTRIES: ['ZE'], ENTRY_ATTEMPTS: ['ZE'], RETAINED_ENTRIES: ['ZE/C'],
  FORECHECK_ATTEMPTS: ['FC'], TURNOVER_TRANSITIONS: ['ZE|ZX'], ENTRY_SHOTS: ['ZE'],
  HDCF: ['LOC'], SCF: ['LOC'], HDCA: ['LOC'], SCA: ['LOC'],
  SV: ['GOALIE'], SA_G: ['GOALIE'], GA_G: ['GOALIE'], MIN_G: ['GOALIE'], xGA_G: ['GOALIE'], HDSV: ['GOALIE', 'LOC'], HDSA: ['GOALIE', 'LOC'], MDSV: ['GOALIE', 'LOC'], MDSA: ['GOALIE', 'LOC'], LDSV: ['GOALIE', 'LOC'], LDSA: ['GOALIE', 'LOC'],
  QS: ['GOALIE'], GS: ['GOALIE'], RBS: ['GOALIE'], SO: ['GOALIE'], REBOUNDS_ALLOWED_GOALIE: ['GOALIE']
};
const CLASS_OF = new Map(inputs.INPUTS.map((x) => [x.field, x.cls]));
const provFor = (field) => { const c = CLASS_OF.get(field); return c === 'TOKEN' ? 'LEDGER' : c === 'RESULT' ? 'RESULT' : c === 'GOALIE' ? 'LEDGER' : 'DERIVED'; };
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * @param {object} o
 * @param {Array<{game, s}>} o.pool       every game in the scope (actor state s), league pool
 * @param {string} o.team                 TEAM_4
 * @param {string} [o.player]             featured player's pid (default: the team's points leader in scope)
 * @param {(pid)=>object} o.player        registry lookup for names
 * @param {boolean} [o.opponents=true]    run HK001 on each opponent for OPP_STRENGTH
 */
/** What the whole scope says about the league: computed once per case and shared with the opponent sub-cases. */
function leaguePool(pool) {
  const seen = new Set(); let lgSOG = 0, lgTeamGames = 0, lgSV = 0, lgSA = 0; const sa = {};
  for (const { game, s } of pool) {
    for (const t of seenTokens(s)) seen.add(t);
    for (const T of [game.home, game.away]) {
      const f = teamGame(game, s, T); if (!f.GP) continue; lgTeamGames++; lgSOG += f.SOG; lgSV += f.SV; lgSA += f.SA_G;
      for (const a of f._scoreAtt) if (a.team === T) { const d = Math.max(-2, Math.min(2, a.d)); sa[d] = (sa[d] || 0) + 1; }
    }
  }
  return { seen, lgSOG, lgTeamGames, lgSV, lgSA, sa };
}
function buildCase({ pool, team, featured = null, lookup = () => null, opponents = true, scopeLabel = 'scope', league = null }) {
  const mine = pool.filter(({ game }) => game.home === team || game.away === team);
  const facts = mine.map(({ game, s }) => ({ game, s, f: teamGame(game, s, team) })).filter((x) => x.f.GP > 0);
  const GP = facts.length;
  const LG = league || leaguePool(pool);
  const { seen, lgSOG, lgTeamGames, lgSV, lgSA, sa } = LG;
  const has = (need) => need.every((n) => n.split('|').some((t) => seen.has(t)));
  const values = {}, prov = {}, notes = [];
  // ---- league pool
  const leagueSOG = lgTeamGames >= 4 ? lgSOG / lgTeamGames : BASE.LEAGUE_SOG_PER_GAME;
  const leagueSV = lgSA >= 200 ? lgSV / lgSA : BASE.LEAGUE_SV_PCT;
  values.LEAGUE_SOG_PER_GAME = r4(leagueSOG); prov.LEAGUE_SOG_PER_GAME = lgTeamGames >= 4 ? 'LEAGUE' : 'BASELINE';
  values.LEAGUE_SV_PCT = r4(leagueSV); prov.LEAGUE_SV_PCT = lgSA >= 200 ? 'LEAGUE' : 'BASELINE';
  if (lgTeamGames < 4) notes.push(`league shots per game: ${lgTeamGames} team-games in ${scopeLabel} (< 4), HK001 baseline ${BASE.LEAGUE_SOG_PER_GAME} used`);
  if (lgSA < 200) notes.push(`league save %: ${lgSA} goalie shots in ${scopeLabel} (< 200), HK001 baseline ${BASE.LEAGUE_SV_PCT} used`);
  const share = (d) => ((sa[d] || 0) + 25) / ((sa[d] || 0) + (sa[-d] || 0) + 50);
  // ---- team sums
  const sum = {}; for (const k of SUM_FIELDS) sum[k] = 0;
  let scoreAdjCF = 0, scoreAdjCA = 0;
  for (const { f } of facts) {
    for (const k of SUM_FIELDS) if (typeof f[k] === 'number') sum[k] += f[k];
    for (const a of f._scoreAtt) { const d = Math.max(-2, Math.min(2, a.d)); const w = 0.5 / share(d); if (a.team === team) scoreAdjCF += w; else scoreAdjCA += w; }
    if (f._starter) { const svp = f._starter.sa ? (f._starter.sa - f._starter.ga) / f._starter.sa : 1; if (svp >= leagueSV || (f._starter.sa <= 20 && svp >= 0.885)) sum.QS++; if (svp < 0.85) sum.RBS++; }
  }
  sum.GP = GP; sum.PTS = sum.G + sum.A; sum.CF = sum.SAT; sum.FF = sum.USAT;
  sum.SCORE_ADJ_CF = scoreAdjCF; sum.SCORE_ADJ_CA = scoreAdjCA;
  for (const x of inputs.INPUTS) {
    if (!SUM_FIELDS.includes(x.field) || x.field in values) continue;
    const need = NEEDS[x.field];
    if (GP && need && !has(need)) { values[x.field] = r4(BASE[x.field] * GP / BASE.GP); prov[x.field] = 'PRORATED'; continue; }
    values[x.field] = r4(sum[x.field] || 0); prov[x.field] = ['SCORE_ADJ_CF', 'SCORE_ADJ_CA'].includes(x.field) ? 'LEAGUE' : provFor(x.field);
  }
  const prorated = Object.entries(prov).filter(([, p]) => p === 'PRORATED').map(([k]) => k);
  if (prorated.length) notes.push(`never logged in ${scopeLabel}, pro-rated from the HK001 baseline by ${GP}/${BASE.GP} games: ${prorated.join(', ')}`);
  // ---- featured player
  const pts = new Map();
  for (const { s } of facts) for (const [pid, b] of s.players) if (b.team === team && b.pos !== 'G') pts.set(pid, (pts.get(pid) || 0) + b.g + b.a1 + b.a2 + b.ixg / 100);
  const pid = featured || [...pts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)[0] || null;
  const pl = { gp: 0, g: 0, a: 0, pts: 0, ixg: 0, onGF: 0, onGA: 0, toi: 0, sog: 0, tracked: 0 };
  if (pid) for (const { s } of facts) { const p = playerGame(s, pid); if (p) { for (const k of ['gp', 'g', 'a', 'pts', 'ixg', 'onGF', 'onGA', 'toi', 'sog']) pl[k] += p[k]; if (p.shiftTracked) pl.tracked++; } }
  const PL = { PLAYER_GP: pl.gp, PLAYER_G: pl.g, PLAYER_A: pl.a, PLAYER_PTS: pl.pts, PLAYER_xG: r4(pl.ixg), PLAYER_ONICE_GF: pl.onGF, PLAYER_ONICE_GA: pl.onGA, PLAYER_TOI: r4(pl.toi), PLAYER_SOG: pl.sog };
  for (const [k, v] of Object.entries(PL)) { values[k] = v; prov[k] = pid ? 'LEDGER' : 'BASELINE'; }
  if (pid && !pl.tracked) for (const k of ['PLAYER_ONICE_GF', 'PLAYER_ONICE_GA', 'PLAYER_TOI']) { values[k] = r4(BASE[k] * pl.gp / BASE.PLAYER_GP); prov[k] = 'PRORATED'; }
  const fp = pid ? lookup(pid) : null;
  if (!pid) for (const k of Object.keys(PL)) values[k] = BASE[k];
  // ---- opponent profile (games-weighted)
  const oppGames = new Map(); for (const { f } of facts) oppGames.set(f._opp, (oppGames.get(f._opp) || 0) + 1);
  const oppRows = [];
  if (opponents && oppGames.size) {
    for (const [O, n] of oppGames) {
      const sub = buildCase({ pool, team: O, lookup, opponents: false, scopeLabel, league: LG });
      const v = sub.request.values;
      const t12 = engine.evaluateConventionalByID('TEAM-012', Object.assign({}, BASE, v));      // HK001's team-strength composite on the opponent's own inputs
      const strength = Number.isFinite(t12) ? t12 : null;
      oppRows.push({ team: O, games: n, gp: v.GP, strength, gfpg: v.GP ? v.G / v.GP : null, gapg: v.GP ? v.GA / v.GP : null, xgfPct: v.xGF + v.xGA > 0 ? v.xGF / (v.xGF + v.xGA) : null, cfPct: v.CF + v.CA > 0 ? v.CF / (v.CF + v.CA) : null, svPct: v.SA_G > 0 ? v.SV / v.SA_G : null });
    }
    const wavg = (k, base) => { let n = 0, s = 0; for (const r of oppRows) if (r[k] !== null && Number.isFinite(r[k])) { n += r.games; s += r.games * r[k]; } return n ? r4(s / n) : base; };
    const map = { OPP_STRENGTH: 'strength', OPP_GFPG: 'gfpg', OPP_GAPG: 'gapg', OPP_XGF_PCT: 'xgfPct', OPP_CF_PCT: 'cfPct', OPP_SV_PCT: 'svPct' };
    for (const [field, k] of Object.entries(map)) { const v = wavg(k, null); values[field] = v === null ? BASE[field] : v; prov[field] = v === null ? 'BASELINE' : 'OPPONENT'; }
  } else for (const field of ['OPP_STRENGTH', 'OPP_GFPG', 'OPP_GAPG', 'OPP_XGF_PCT', 'OPP_CF_PCT', 'OPP_SV_PCT']) { values[field] = BASE[field]; prov[field] = 'BASELINE'; }
  if (!GP) notes.push(`${team} has no games with logged events in ${scopeLabel}; every input is the HK001 baseline`);
  for (const x of inputs.INPUTS) if (!(x.field in values)) { values[x.field] = BASE[x.field]; prov[x.field] = 'BASELINE'; }
  const request = { case_id: `RINK-${team}-${scopeLabel.replace(/[^A-Za-z0-9]+/g, '-')}`.slice(0, 64), description: `${team} over ${scopeLabel} (${GP} games) from the RINK-VT ledger`, input_mode: 'overlay_baseline', synthetic_fixture: false, values, calibration: {} };
  return { name: `${team} · ${scopeLabel}`, source: 'rink', request, prov, notes, team, gp: GP, featured: pid ? { pid, code: fp && fp.code, name: fp && fp.name } : null, opponents: oppRows };
}
module.exports = { buildCase, leaguePool, NEEDS };
