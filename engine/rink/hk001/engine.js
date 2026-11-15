'use strict';
/**
 * HK001 MSSL 2.3.0 — 8Sphere Hockey Extrapolator, ported to JavaScript.
 * ---------------------------------------------------------------------------
 * Source of truth: runtime/host_source/internal/engine/{engine.go, equations_generated.go,
 * extrapolator.go, parlay.go} of HK001_MSSL_2.3.0_8SPHERE_HOCKEY_EXTRAPOLATOR. Every formula, constant,
 * clamp, threshold and evaluation order below is transcribed from those files; the Go numerics are
 * reproduced bit-for-bit through ./gomath.js and the receipt is serialised exactly as Go's encoding/json
 * would, so canonical_sha256 matches the Go build (demo: faa8e35a…, tests/rink/hk001.test.js).
 *
 * Chain: 109 hockey equations -> 32 Master-Law models -> 26 first-stage extrapolations (X8S)
 *        -> 26 8Sphere joint analytical extrapolations (SP8) -> receipt.
 * Product boundary (unchanged): deterministic synthetic hockey research. "Parlay" denotes a joint
 * multi-anchor analytical conjunction; no wagering, forecast, roster, medical or scouting authority.
 */
const crypto = require('node:crypto');
const { goExp, goLog, goPow, goCos, goRound, goFixed } = require('./gomath');

const VERSION = '2.3.0-MSSL-8SPHERE-HOCKEY-EXTRAPOLATOR';
const RUNTIME_ID = 'HK001-MSSL-2.3.0-WIN64-8SPHERE-HOCKEY-1';
const PI = Math.PI;
const NaNv = NaN;
/* Optional trace of every intermediate computation, keyed by its RINK-VT computation code (see catalog.js).
   Recording never changes a computed value; the receipt and its hash are identical with or without it. */
let TR = null;
const rec = (k, v) => { if (TR) TR[k] = v; };
const ENT = { OFFENSE: 'OFF', POSSESSION: 'POS', TRANSITION: 'TRN', DEFENSE: 'DEF', GOALTENDING: 'GOL', SPECIAL_TEAMS: 'SPT', TEAM: 'TEAM', OPPONENT: 'OPP' };

/* ------------------------------------------------------------------ helpers (engine.go) */
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
function safeDiv(a, b) { if (!finite(a) || !finite(b) || Math.abs(b) < 1e-12) return NaNv; return a / b; }
const chooseNumber = (c, a, b) => (c ? a : b);
function clamp(x, lo, hi) { if (x < lo) return lo; if (x > hi) return hi; return x; }
function normalize(x, center, scale) { if (scale <= 1e-12) return 0; return clamp((x - center) / scale, -1, 1); }
function sigmoid(x) { if (x >= 0) { const z = goExp(-x); return 1 / (1 + z); } const z = goExp(x); return z / (1 + z); }
function cubeRootNonnegative(x) { if (x <= 0) return 0; return goPow(x, 1.0 / 3.0); }
function roundN(x, n) { if (!finite(x)) return x; const p = Math.pow(10, n); return goRound(x * p) / p; }   // math.Pow10(12) == 1e12 exactly
const gmax = (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : (a > b ? a : b));                        // math.Max (no ±0 issues here)

/* ------------------------------------------------------------------ inputs */
const BASELINE = Object.freeze({
  GP: 82.0, G: 268.0, GA: 232.0, A: 450.0, PTS: 718.0, SOG: 2480.0, SAT: 4550.0, USAT: 3700.0, MISSED: 870.0, BLOCKED_FOR: 1200.0,
  HDCF: 920.0, SCF: 2050.0, PRIMARY_A: 270.0, SECONDARY_A: 180.0, EV_G: 188.0, PPG: 58.0, SHG: 8.0, ENG: 14.0, REBOUNDS_FOR: 510.0,
  RUSH_ATTEMPTS: 420.0, TAKEAWAYS: 610.0, GIVEAWAYS: 680.0, OZ_STARTS: 4200.0, DZ_STARTS: 3900.0, CF: 4550.0, CA: 4300.0, FF: 3700.0,
  FA: 3500.0, SA: 2420.0, xGF: 270.0, xGA: 245.0, HDCA: 830.0, SCA: 1900.0, SCORE_ADJ_CF: 4620.0, SCORE_ADJ_CA: 4250.0, CLOSE_CF: 2100.0,
  CLOSE_CA: 1980.0, EV_TOI: 4050.0, TEAM_TOI: 4920.0, LEAGUE_SOG_PER_GAME: 30.2, BLOCKS: 1350.0, ODD_MAN_RUSH_FOR: 330.0,
  ODD_MAN_RUSH_AGAINST: 290.0, EXITS: 1750.0, EXIT_ATTEMPTS: 1900.0, CONTROLLED_EXITS: 1080.0, PK_SA: 390.0, PK_MIN: 430.0,
  REBOUNDS_AGAINST: 485.0, SV: 2188.0, SA_G: 2420.0, GA_G: 232.0, MIN_G: 4920.0, LEAGUE_SV_PCT: 0.905, xGA_G: 245.0, HDSV: 760.0,
  HDSA: 830.0, MDSV: 760.0, MDSA: 820.0, LDSV: 668.0, LDSA: 700.0, QS: 48.0, GS: 70.0, RBS: 7.0, REBOUNDS_ALLOWED_GOALIE: 430.0, SO: 7.0,
  CONTROLLED_ENTRIES: 1120.0, ENTRIES: 1850.0, ENTRY_ATTEMPTS: 2000.0, RETAINED_ENTRIES: 760.0, FORECHECK_ATTEMPTS: 780.0,
  TURNOVER_TRANSITIONS: 350.0, ENTRY_SHOTS: 980.0, POINTS: 98.0, W: 43.0, RW: 38.0, PP_OPP: 260.0, PPGA: 45.0, PK_OPP: 250.0,
  FO_WON: 2448.0, FO_TAKEN: 4800.0, PEN_DRAWN: 325.0, PEN_TAKEN: 310.0, HOME_G: 140.0, COMEBACK_WINS: 14.0, ONE_GOAL_WINS: 21.0,
  FIRST_PERIOD_G: 85.0, SECOND_PERIOD_G: 95.0, THIRD_PERIOD_G: 88.0, OT_WINS: 9.0, SO_WINS: 5.0, OT_GAMES: 14.0, SO_GAMES: 8.0,
  ONE_GOAL_GAMES: 36.0, PLAYER_GP: 78.0, PLAYER_G: 38.0, PLAYER_A: 52.0, PLAYER_PTS: 90.0, PLAYER_xG: 34.0, PLAYER_ONICE_GF: 82.0,
  PLAYER_ONICE_GA: 61.0, PLAYER_TOI: 1560.0, PLAYER_SOG: 290.0, OPP_STRENGTH: 55.0, OPP_GFPG: 3.1, OPP_GAPG: 2.95, OPP_XGF_PCT: 0.515,
  OPP_CF_PCT: 0.51, OPP_SV_PCT: 0.908
});
const baselineValues = () => Object.assign({}, BASELINE);

function defaultRequest() {
  return { schema: 'hk001.hockey_equation_input.mssl.v1', product_id: 'HK001', case_id: 'HK001-DEMO', description: 'Synthetic balanced hockey season and matchup demonstration.',
    input_mode: 'strict_complete', synthetic_fixture: true, values: baselineValues(), calibration: {},
    _prov: { source_name: '', source_format: '', source_sha256: '', parser_profile: '', record_index: 0, record_count: 0, defaulted_fields: null } };
}
const get = (v, k) => (Object.prototype.hasOwnProperty.call(v, k) ? v[k] : NaNv);

/** strings.EqualFold(s, t) for an ASCII t. Unicode simple folding also folds U+017F (long s) to s and U+212A (Kelvin) to k. */
function equalFold(s, t) {
  const a = Array.from(String(s)); if (a.length !== t.length) return false;
  for (let i = 0; i < t.length; i++) {
    let c = a[i].codePointAt(0); if (c === 0x17f) c = 115; else if (c === 0x212a) c = 107; else if (c >= 65 && c <= 90) c += 32;
    const w = t.charCodeAt(i); if (c !== (w >= 65 && w <= 90 ? w + 32 : w)) return false;
  }
  return true;
}
function applyBaselineOverlay(r) {
  r = Object.assign({}, r);
  if (!r.schema) r.schema = 'hk001.hockey_equation_input.mssl.v1';
  if (!r.product_id) r.product_id = 'HK001';
  if (!r.case_id) r.case_id = 'HK001-UNNAMED';
  if (!r.description) r.description = 'Operator-supplied hockey equation record.';
  if (!r.input_mode) r.input_mode = 'overlay_baseline';
  // field names are data (Go: map[string]float64): no prototype, so a field called "__proto__" is just a field
  r.values = Object.assign(Object.create(null), r.values || {});
  r.calibration = Object.assign(Object.create(null), r.calibration || {});
  r._prov = Object.assign({ source_name: '', source_format: '', source_sha256: '', parser_profile: '', record_index: 0, record_count: 0, defaulted_fields: null }, r._prov || {});
  if (equalFold(r.input_mode, 'strict_complete')) return r;
  const defaulted = [];
  for (const [k, x] of Object.entries(BASELINE)) if (!Object.prototype.hasOwnProperty.call(r.values, k)) { r.values[k] = x; defaulted.push(k); }
  defaulted.sort();
  r._prov.defaulted_fields = defaulted.length ? defaulted : null;
  return r;
}

function validate(r) {
  const rs = []; const v = r.values;
  if (r.product_id !== 'HK001') rs.push('PRODUCT_ID_MISMATCH');
  for (const k of Object.keys(v).sort()) if (!finite(v[k])) rs.push('NONFINITE_' + k);   // Go ranges a map (random order); sorted here
  for (const k of ['GP', 'G', 'SOG', 'SAT', 'SA', 'GA', 'SV', 'SA_G', 'GA_G', 'MIN_G', 'CF', 'CA', 'xGF', 'xGA', 'PP_OPP', 'PK_OPP', 'FO_TAKEN', 'EV_TOI']) if (!finite(get(v, k))) rs.push('MISSING_' + k);
  const g = (k) => get(v, k);
  if (g('GP') <= 0 || g('SOG') <= 0 || g('SAT') <= 0 || g('SA') <= 0 || g('SA_G') <= 0 || g('MIN_G') <= 0 || g('EV_TOI') <= 0) rs.push('NONPOSITIVE_EXPOSURE');
  if (g('G') > g('SOG') || g('SOG') > g('SAT') || g('GA') > g('SA') || g('GA_G') > g('SA_G') || g('SV') + g('GA_G') > g('SA_G') + 1e-9) rs.push('SHOT_GOAL_RELATION_INVALID');
  if (g('HDCF') > g('SCF') || g('HDCA') > g('SCA') || g('CONTROLLED_ENTRIES') > g('ENTRIES') || g('ENTRIES') > g('ENTRY_ATTEMPTS') || g('CONTROLLED_EXITS') > g('EXITS') || g('EXITS') > g('EXIT_ATTEMPTS')) rs.push('EVENT_RELATION_INVALID');
  if (g('PPG') > g('PP_OPP') || g('PPGA') > g('PK_OPP') || g('FO_WON') > g('FO_TAKEN')) rs.push('SPECIAL_TEAM_RELATION_INVALID');
  return rs;
}

/* ------------------------------------------------------------------ 109 conventional equations (equations_generated.go) */
const N = NaNv;
const SPECS = [
  ['OFF-001', 'Offense', 'Goals per Game', 'G/GP', 'EXECUTABLE_OPEN', 0, 10], ['OFF-002', 'Offense', 'Assists per Game', 'A/GP', 'EXECUTABLE_OPEN', 0, 20],
  ['OFF-003', 'Offense', 'Points per Game', 'PTS/GP', 'EXECUTABLE_OPEN', 0, 30], ['OFF-004', 'Offense', 'Shooting Percentage', 'G/SOG', 'EXECUTABLE_OPEN', 0, 1],
  ['OFF-005', 'Offense', 'Shots on Goal per Game', 'SOG/GP', 'EXECUTABLE_OPEN', 0, 100], ['OFF-006', 'Offense', 'Shot Attempts per Game', 'SAT/GP', 'EXECUTABLE_OPEN', 0, 150],
  ['OFF-007', 'Offense', 'Unblocked Attempts per Game', 'USAT/GP', 'EXECUTABLE_OPEN', 0, 150], ['OFF-008', 'Offense', 'Missed-Attempt Rate', 'MISSED/SAT', 'EXECUTABLE_OPEN', 0, 1],
  ['OFF-009', 'Offense', 'Opponent-Block Share', 'BLOCKED_FOR/SAT', 'EXECUTABLE_OPEN', 0, 1], ['OFF-010', 'Offense', 'High-Danger Chance Share of Scoring Chances', 'HDCF/SCF', 'EXECUTABLE_OPEN', 0, 1],
  ['OFF-011', 'Offense', 'Goal Conversion per Scoring Chance', 'G/SCF', 'EXECUTABLE_OPEN', 0, 1], ['OFF-012', 'Offense', 'Goal Conversion per High-Danger Chance', 'G/HDCF', 'EXECUTABLE_OPEN', 0, 1],
  ['OFF-013', 'Offense', 'Primary Assist Share', 'PRIMARY_A/A', 'EXECUTABLE_OPEN', 0, 1], ['OFF-014', 'Offense', 'Secondary Assist Share', 'SECONDARY_A/A', 'EXECUTABLE_OPEN', 0, 1],
  ['OFF-015', 'Offense', 'Even-Strength Goal Share', 'EV_G/G', 'EXECUTABLE_OPEN', 0, 1], ['OFF-016', 'Offense', 'Power-Play Goal Share', 'PPG/G', 'EXECUTABLE_OPEN', 0, 1],
  ['OFF-017', 'Offense', 'Short-Handed Goal Share', 'SHG/G', 'EXECUTABLE_OPEN', 0, 1], ['OFF-018', 'Offense', 'Empty-Net Goal Share', 'ENG/G', 'EXECUTABLE_OPEN', 0, 1],
  ['OFF-019', 'Offense', 'Rebound Creation Rate', 'REBOUNDS_FOR/SOG', 'EXECUTABLE_OPEN', 0, 1], ['OFF-020', 'Offense', 'Rush Attempt Share', 'RUSH_ATTEMPTS/SAT', 'EXECUTABLE_OPEN', 0, 1],
  ['OFF-021', 'Offense', 'Takeaway-to-Giveaway Ratio', 'TAKEAWAYS/GIVEAWAYS', 'EXECUTABLE_OPEN', 0, 10], ['OFF-022', 'Offense', 'Offensive-Zone Start Share', 'OZ_STARTS/(OZ_STARTS+DZ_STARTS)', 'EXECUTABLE_OPEN', 0, 1],
  ['OFF-023', 'Offense', 'Shot Creation Efficiency', 'SOG/SAT', 'EXECUTABLE_OPEN', 0, 1], ['OFF-024', 'Offense', 'Expected-Goal Finishing Ratio', 'G/xGF', 'EXECUTABLE_SIMPLIFIED', 0, 5],
  ['OFF-025', 'Offense', 'Goals Above Expected', 'G-xGF', 'EXECUTABLE_SIMPLIFIED', N, N],
  ['POS-001', 'Possession', 'Corsi For Percentage', 'CF/(CF+CA)', 'EXECUTABLE_OPEN', 0, 1], ['POS-002', 'Possession', 'Fenwick For Percentage', 'FF/(FF+FA)', 'EXECUTABLE_OPEN', 0, 1],
  ['POS-003', 'Possession', 'Shots For Percentage', 'SOG/(SOG+SA)', 'EXECUTABLE_OPEN', 0, 1], ['POS-004', 'Possession', 'Expected Goals For Percentage', 'xGF/(xGF+xGA)', 'EXECUTABLE_SIMPLIFIED', 0, 1],
  ['POS-005', 'Possession', 'High-Danger Chances For Percentage', 'HDCF/(HDCF+HDCA)', 'EXECUTABLE_OPEN', 0, 1], ['POS-006', 'Possession', 'Scoring Chances For Percentage', 'SCF/(SCF+SCA)', 'EXECUTABLE_OPEN', 0, 1],
  ['POS-007', 'Possession', 'Score-Adjusted Corsi Percentage', 'SCORE_ADJ_CF/(SCORE_ADJ_CF+SCORE_ADJ_CA)', 'EXECUTABLE_SIMPLIFIED', 0, 1], ['POS-008', 'Possession', 'Close-State Corsi Percentage', 'CLOSE_CF/(CLOSE_CF+CLOSE_CA)', 'EXECUTABLE_OPEN', 0, 1],
  ['POS-009', 'Possession', 'Corsi Differential per Game', '(CF-CA)/GP', 'EXECUTABLE_OPEN', N, N], ['POS-010', 'Possession', 'Corsi For per 60', '60*CF/EV_TOI', 'EXECUTABLE_OPEN', 0, 200],
  ['POS-011', 'Possession', 'Fenwick For per 60', '60*FF/EV_TOI', 'EXECUTABLE_OPEN', 0, 200], ['POS-012', 'Possession', 'Expected Goals For per 60', '60*xGF/EV_TOI', 'EXECUTABLE_SIMPLIFIED', 0, 20],
  ['DEF-001', 'Defense', 'Goals Against per Game', 'GA/GP', 'EXECUTABLE_OPEN', 0, 10], ['DEF-002', 'Defense', 'Shots Against per Game', 'SA/GP', 'EXECUTABLE_OPEN', 0, 100],
  ['DEF-003', 'Defense', 'Shot Suppression versus League', 'LEAGUE_SOG_PER_GAME-SA/GP', 'EXECUTABLE_OPEN', N, N], ['DEF-004', 'Defense', 'Expected Goals Against per Game', 'xGA/GP', 'EXECUTABLE_SIMPLIFIED', 0, 10],
  ['DEF-005', 'Defense', 'Goals Against Above Expected', 'GA-xGA', 'EXECUTABLE_SIMPLIFIED', N, N], ['DEF-006', 'Defense', 'Corsi Against per 60', '60*CA/EV_TOI', 'EXECUTABLE_OPEN', 0, 200],
  ['DEF-007', 'Defense', 'Fenwick Against per 60', '60*FA/EV_TOI', 'EXECUTABLE_OPEN', 0, 200], ['DEF-008', 'Defense', 'Scoring Chances Against per 60', '60*SCA/EV_TOI', 'EXECUTABLE_OPEN', 0, 100],
  ['DEF-009', 'Defense', 'High-Danger Chances Against per 60', '60*HDCA/EV_TOI', 'EXECUTABLE_OPEN', 0, 100], ['DEF-010', 'Defense', 'Shot-Block Engagement Rate', 'BLOCKS/(CA+BLOCKS)', 'EXECUTABLE_OPEN', 0, 1],
  ['DEF-011', 'Defense', 'Takeaways per 60', '60*TAKEAWAYS/TEAM_TOI', 'EXECUTABLE_OPEN', 0, 100], ['DEF-012', 'Defense', 'Puck-Security Control', '1-GIVEAWAYS/(GIVEAWAYS+TAKEAWAYS)', 'EXECUTABLE_OPEN', 0, 1],
  ['DEF-013', 'Defense', 'Odd-Man Rush Differential per Game', '(ODD_MAN_RUSH_FOR-ODD_MAN_RUSH_AGAINST)/GP', 'EXECUTABLE_OPEN', N, N], ['DEF-014', 'Defense', 'Defensive-Zone Exit Success', 'EXITS/EXIT_ATTEMPTS', 'EXECUTABLE_OPEN', 0, 1],
  ['DEF-015', 'Defense', 'Controlled Exit Share', 'CONTROLLED_EXITS/EXITS', 'EXECUTABLE_OPEN', 0, 1], ['DEF-016', 'Defense', 'Penalty-Kill Shots Against per 60', '60*PK_SA/PK_MIN', 'EXECUTABLE_OPEN', 0, 200],
  ['DEF-017', 'Defense', 'Rebound Exposure Rate', 'REBOUNDS_AGAINST/SA', 'EXECUTABLE_OPEN', 0, 1], ['DEF-018', 'Defense', 'Defensive Efficiency Composite', '100*w(suppression, possession, danger, blocks, exits)', 'EXECUTABLE_OPEN_PROXY', 0, 100],
  ['GOL-001', 'Goaltending', 'Save Percentage', 'SV/SA_G', 'EXECUTABLE_OPEN', 0, 1], ['GOL-002', 'Goaltending', 'Goals Against Average', '60*GA_G/MIN_G', 'EXECUTABLE_OPEN', 0, 20],
  ['GOL-003', 'Goaltending', 'Goals Saved Above Average', 'SV-SA_G*LEAGUE_SV_PCT', 'EXECUTABLE_OPEN', N, N], ['GOL-004', 'Goaltending', 'Expected Save Percentage', '1-xGA_G/SA_G', 'EXECUTABLE_SIMPLIFIED', 0, 1],
  ['GOL-005', 'Goaltending', 'Goals Saved Above Expected', 'xGA_G-GA_G', 'EXECUTABLE_SIMPLIFIED', N, N], ['GOL-006', 'Goaltending', 'High-Danger Save Percentage', 'HDSV/HDSA', 'EXECUTABLE_OPEN', 0, 1],
  ['GOL-007', 'Goaltending', 'Medium-Danger Save Percentage', 'MDSV/MDSA', 'EXECUTABLE_OPEN', 0, 1], ['GOL-008', 'Goaltending', 'Low-Danger Save Percentage', 'LDSV/LDSA', 'EXECUTABLE_OPEN', 0, 1],
  ['GOL-009', 'Goaltending', 'Quality-Start Percentage', 'QS/GS', 'EXECUTABLE_OPEN', 0, 1], ['GOL-010', 'Goaltending', 'Really-Bad-Start Rate', 'RBS/GS', 'EXECUTABLE_OPEN', 0, 1],
  ['GOL-011', 'Goaltending', 'Saves per 60', '60*SV/MIN_G', 'EXECUTABLE_OPEN', 0, 100], ['GOL-012', 'Goaltending', 'Rebound Control Rate', '1-REBOUNDS_ALLOWED_GOALIE/SA_G', 'EXECUTABLE_OPEN', 0, 1],
  ['GOL-013', 'Goaltending', 'Shutout Rate', 'SO/GS', 'EXECUTABLE_OPEN', 0, 1], ['GOL-014', 'Goaltending', 'Workload per Start', 'SA_G/GS', 'EXECUTABLE_OPEN', 0, 100],
  ['GOL-015', 'Goaltending', 'Goaltending Stability Index', '100*w(SV%,HDSV%,QS%,RBS%,workload)', 'EXECUTABLE_OPEN_PROXY', 0, 100],
  ['TRN-001', 'Transition', 'Controlled Entry Share', 'CONTROLLED_ENTRIES/ENTRIES', 'EXECUTABLE_OPEN', 0, 1], ['TRN-002', 'Transition', 'Entry Success Rate', 'ENTRIES/ENTRY_ATTEMPTS', 'EXECUTABLE_OPEN', 0, 1],
  ['TRN-003', 'Transition', 'Controlled Exit Share', 'CONTROLLED_EXITS/EXITS', 'EXECUTABLE_OPEN', 0, 1], ['TRN-004', 'Transition', 'Exit Success Rate', 'EXITS/EXIT_ATTEMPTS', 'EXECUTABLE_OPEN', 0, 1],
  ['TRN-005', 'Transition', 'Entry Retention Rate', 'RETAINED_ENTRIES/CONTROLLED_ENTRIES', 'EXECUTABLE_OPEN', 0, 1], ['TRN-006', 'Transition', 'Rush-versus-Forecheck Share', 'RUSH_ATTEMPTS/(RUSH_ATTEMPTS+FORECHECK_ATTEMPTS)', 'EXECUTABLE_OPEN', 0, 1],
  ['TRN-007', 'Transition', 'Odd-Man Rush Differential', '(ODD_MAN_RUSH_FOR-ODD_MAN_RUSH_AGAINST)/GP', 'EXECUTABLE_OPEN', N, N], ['TRN-008', 'Transition', 'Neutral-Zone Control Index', '(CONTROLLED_ENTRIES+CONTROLLED_EXITS)/(ENTRIES+EXITS)', 'EXECUTABLE_OPEN', 0, 1],
  ['TRN-009', 'Transition', 'Turnover Transition Rate', 'TURNOVER_TRANSITIONS/(ENTRIES+EXITS)', 'EXECUTABLE_OPEN', 0, 1], ['TRN-010', 'Transition', 'Entry-to-Shot Conversion', 'ENTRY_SHOTS/ENTRIES', 'EXECUTABLE_OPEN', 0, 1],
  ['TRN-011', 'Transition', 'Exit-to-Entry Continuity', 'ENTRIES/EXITS', 'EXECUTABLE_OPEN', 0, 2], ['TRN-012', 'Transition', 'Transition Efficiency Composite', '100*w(entry, exit, retention, control, turnover)', 'EXECUTABLE_OPEN_PROXY', 0, 100],
  ['TEAM-001', 'Team', 'Points Percentage', 'POINTS/(2*GP)', 'EXECUTABLE_OPEN', 0, 1], ['TEAM-002', 'Team', 'Win Percentage', 'W/GP', 'EXECUTABLE_OPEN', 0, 1],
  ['TEAM-003', 'Team', 'Regulation Win Percentage', 'RW/GP', 'EXECUTABLE_OPEN', 0, 1], ['TEAM-004', 'Team', 'Goal Differential per Game', '(G-GA)/GP', 'EXECUTABLE_OPEN', N, N],
  ['TEAM-005', 'Team', 'Pythagorean Win Percentage', 'G^2/(G^2+GA^2)', 'EXECUTABLE_OPEN', 0, 1], ['TEAM-006', 'Team', 'PDO', '1000*(G/SOG+SV/SA)', 'EXECUTABLE_OPEN', 500, 1500],
  ['TEAM-007', 'Team', 'Special-Teams Index', '100*(PPG/PP_OPP + 1-PPGA/PK_OPP)', 'EXECUTABLE_OPEN', 0, 200], ['TEAM-008', 'Team', 'Faceoff Win Percentage', 'FO_WON/FO_TAKEN', 'EXECUTABLE_OPEN', 0, 1],
  ['TEAM-009', 'Team', 'Penalty Differential per Game', '(PEN_DRAWN-PEN_TAKEN)/GP', 'EXECUTABLE_OPEN', N, N], ['TEAM-010', 'Team', 'Home Goal Share', 'HOME_G/G', 'EXECUTABLE_OPEN', 0, 1],
  ['TEAM-011', 'Team', 'Close-Game Conversion', '(COMEBACK_WINS+ONE_GOAL_WINS)/(2*W)', 'EXECUTABLE_OPEN', 0, 1], ['TEAM-012', 'Team', 'Team Strength Composite', '100*w(points,xGF,goal share,special teams,goalie)', 'EXECUTABLE_OPEN_PROXY', 0, 100],
  ['CTX-001', 'Game Context', 'First-Period Goal Share', 'FIRST_PERIOD_G/G', 'EXECUTABLE_OPEN', 0, 1], ['CTX-002', 'Game Context', 'Second-Period Goal Share', 'SECOND_PERIOD_G/G', 'EXECUTABLE_OPEN', 0, 1],
  ['CTX-003', 'Game Context', 'Third-Period Goal Share', 'THIRD_PERIOD_G/G', 'EXECUTABLE_OPEN', 0, 1], ['CTX-004', 'Game Context', 'Extra-Time Win Rate', '(OT_WINS+SO_WINS)/(OT_GAMES+SO_GAMES)', 'EXECUTABLE_OPEN', 0, 1],
  ['CTX-005', 'Game Context', 'One-Goal Game Win Rate', 'ONE_GOAL_WINS/ONE_GOAL_GAMES', 'EXECUTABLE_OPEN', 0, 1],
  ['VAL-001', 'Player Value', 'Player Goals per Game', 'PLAYER_G/PLAYER_GP', 'EXECUTABLE_OPEN', 0, 3], ['VAL-002', 'Player Value', 'Player Points per Game', 'PLAYER_PTS/PLAYER_GP', 'EXECUTABLE_OPEN', 0, 5],
  ['VAL-003', 'Player Value', 'Player Goals Above Expected', 'PLAYER_G-PLAYER_xG', 'EXECUTABLE_SIMPLIFIED', N, N], ['VAL-004', 'Player Value', 'On-Ice Goal Differential per 60', '60*(PLAYER_ONICE_GF-PLAYER_ONICE_GA)/PLAYER_TOI', 'EXECUTABLE_OPEN', N, N],
  ['VAL-005', 'Player Value', 'Player Impact Composite', '100*w(points,goals,on-ice differential,shot rate)', 'EXECUTABLE_OPEN_PROXY', 0, 100],
  ['ADV-001', 'Advanced', 'Open Hockey Impact Plus', '100 + weighted standardized team signals', 'EXECUTABLE_OPEN_PROXY', 0, 250], ['ADV-002', 'Advanced', 'Opponent-Adjusted Team Strength', 'TEAM_STRENGTH * opponent adjustment', 'EXECUTABLE_OPEN_PROXY', 0, 200],
  ['ADV-003', 'Advanced', 'Possession Quality Index', '100*(.40*xGF%+.30*HDCF%+.30*CF%)', 'EXECUTABLE_OPEN_PROXY', 0, 100], ['ADV-004', 'Advanced', 'Goaltending Dependence Index', '50 + save-performance leverage', 'EXECUTABLE_OPEN_PROXY', 0, 100],
  ['ADV-005', 'Advanced', 'Special-Teams Leverage Index', '100*(PP%+PK%-1)', 'EXECUTABLE_OPEN_PROXY', -100, 100]
].map(([id, category, name, formula, status, lower, upper]) => Object.freeze({ id, category, name, formula, status, lower, upper }));

function evaluateConventionalByID(id, v) {
  const g = (k) => get(v, k);
  const d = (a, b) => safeDiv(g(a), g(b));
  const m = (x) => evaluateConventionalByID(x, v);
  switch (id) {
    case 'OFF-001': return d('G', 'GP'); case 'OFF-002': return d('A', 'GP'); case 'OFF-003': return d('PTS', 'GP'); case 'OFF-004': return d('G', 'SOG');
    case 'OFF-005': return d('SOG', 'GP'); case 'OFF-006': return d('SAT', 'GP'); case 'OFF-007': return d('USAT', 'GP'); case 'OFF-008': return d('MISSED', 'SAT');
    case 'OFF-009': return d('BLOCKED_FOR', 'SAT'); case 'OFF-010': return d('HDCF', 'SCF'); case 'OFF-011': return d('G', 'SCF'); case 'OFF-012': return d('G', 'HDCF');
    case 'OFF-013': return d('PRIMARY_A', 'A'); case 'OFF-014': return d('SECONDARY_A', 'A'); case 'OFF-015': return d('EV_G', 'G'); case 'OFF-016': return d('PPG', 'G');
    case 'OFF-017': return d('SHG', 'G'); case 'OFF-018': return d('ENG', 'G'); case 'OFF-019': return d('REBOUNDS_FOR', 'SOG'); case 'OFF-020': return d('RUSH_ATTEMPTS', 'SAT');
    case 'OFF-021': return d('TAKEAWAYS', 'GIVEAWAYS'); case 'OFF-022': return safeDiv(g('OZ_STARTS'), g('OZ_STARTS') + g('DZ_STARTS')); case 'OFF-023': return d('SOG', 'SAT');
    case 'OFF-024': return d('G', 'xGF'); case 'OFF-025': return g('G') - g('xGF');
    case 'POS-001': return safeDiv(g('CF'), g('CF') + g('CA')); case 'POS-002': return safeDiv(g('FF'), g('FF') + g('FA')); case 'POS-003': return safeDiv(g('SOG'), g('SOG') + g('SA'));
    case 'POS-004': return safeDiv(g('xGF'), g('xGF') + g('xGA')); case 'POS-005': return safeDiv(g('HDCF'), g('HDCF') + g('HDCA')); case 'POS-006': return safeDiv(g('SCF'), g('SCF') + g('SCA'));
    case 'POS-007': return safeDiv(g('SCORE_ADJ_CF'), g('SCORE_ADJ_CF') + g('SCORE_ADJ_CA')); case 'POS-008': return safeDiv(g('CLOSE_CF'), g('CLOSE_CF') + g('CLOSE_CA'));
    case 'POS-009': return safeDiv(g('CF') - g('CA'), g('GP')); case 'POS-010': return 60 * d('CF', 'EV_TOI'); case 'POS-011': return 60 * d('FF', 'EV_TOI'); case 'POS-012': return 60 * d('xGF', 'EV_TOI');
    case 'DEF-001': return d('GA', 'GP'); case 'DEF-002': return d('SA', 'GP'); case 'DEF-003': return g('LEAGUE_SOG_PER_GAME') - d('SA', 'GP'); case 'DEF-004': return d('xGA', 'GP');
    case 'DEF-005': return g('GA') - g('xGA'); case 'DEF-006': return 60 * d('CA', 'EV_TOI'); case 'DEF-007': return 60 * d('FA', 'EV_TOI'); case 'DEF-008': return 60 * d('SCA', 'EV_TOI');
    case 'DEF-009': return 60 * d('HDCA', 'EV_TOI'); case 'DEF-010': return safeDiv(g('BLOCKS'), g('CA') + g('BLOCKS')); case 'DEF-011': return 60 * d('TAKEAWAYS', 'TEAM_TOI');
    case 'DEF-012': return 1 - safeDiv(g('GIVEAWAYS'), g('GIVEAWAYS') + g('TAKEAWAYS')); case 'DEF-013': return safeDiv(g('ODD_MAN_RUSH_FOR') - g('ODD_MAN_RUSH_AGAINST'), g('GP'));
    case 'DEF-014': return d('EXITS', 'EXIT_ATTEMPTS'); case 'DEF-015': return d('CONTROLLED_EXITS', 'EXITS'); case 'DEF-016': return 60 * d('PK_SA', 'PK_MIN'); case 'DEF-017': return d('REBOUNDS_AGAINST', 'SA');
    case 'DEF-018': return 100 * (0.30 * clamp(1 - d('GA', 'GP') / 6, 0, 1) + 0.25 * m('POS-001') + 0.20 * clamp(1 - d('HDCA', 'GP') / 20, 0, 1) + 0.15 * m('DEF-010') + 0.10 * m('DEF-014'));
    case 'GOL-001': return d('SV', 'SA_G'); case 'GOL-002': return 60 * d('GA_G', 'MIN_G'); case 'GOL-003': return g('SV') - g('SA_G') * g('LEAGUE_SV_PCT'); case 'GOL-004': return 1 - d('xGA_G', 'SA_G');
    case 'GOL-005': return g('xGA_G') - g('GA_G'); case 'GOL-006': return d('HDSV', 'HDSA'); case 'GOL-007': return d('MDSV', 'MDSA'); case 'GOL-008': return d('LDSV', 'LDSA');
    case 'GOL-009': return d('QS', 'GS'); case 'GOL-010': return d('RBS', 'GS'); case 'GOL-011': return 60 * d('SV', 'MIN_G'); case 'GOL-012': return 1 - d('REBOUNDS_ALLOWED_GOALIE', 'SA_G');
    case 'GOL-013': return d('SO', 'GS'); case 'GOL-014': return d('SA_G', 'GS');
    case 'GOL-015': return 100 * (0.35 * m('GOL-001') + 0.25 * m('GOL-006') + 0.20 * m('GOL-009') + 0.10 * (1 - m('GOL-010')) + 0.10 * clamp(d('GS', 'GP'), 0, 1));
    case 'TRN-001': return d('CONTROLLED_ENTRIES', 'ENTRIES'); case 'TRN-002': return d('ENTRIES', 'ENTRY_ATTEMPTS'); case 'TRN-003': return d('CONTROLLED_EXITS', 'EXITS');
    case 'TRN-004': return d('EXITS', 'EXIT_ATTEMPTS'); case 'TRN-005': return d('RETAINED_ENTRIES', 'CONTROLLED_ENTRIES');
    case 'TRN-006': return safeDiv(g('RUSH_ATTEMPTS'), g('RUSH_ATTEMPTS') + g('FORECHECK_ATTEMPTS')); case 'TRN-007': return safeDiv(g('ODD_MAN_RUSH_FOR') - g('ODD_MAN_RUSH_AGAINST'), g('GP'));
    case 'TRN-008': return safeDiv(g('CONTROLLED_ENTRIES') + g('CONTROLLED_EXITS'), g('ENTRIES') + g('EXITS')); case 'TRN-009': return safeDiv(g('TURNOVER_TRANSITIONS'), g('ENTRIES') + g('EXITS'));
    case 'TRN-010': return d('ENTRY_SHOTS', 'ENTRIES'); case 'TRN-011': return d('ENTRIES', 'EXITS');
    case 'TRN-012': return 100 * (0.22 * m('TRN-001') + 0.18 * m('TRN-002') + 0.20 * m('TRN-003') + 0.15 * m('TRN-004') + 0.15 * m('TRN-005') + 0.10 * (1 - m('TRN-009')));
    case 'TEAM-001': return safeDiv(g('POINTS'), 2 * g('GP')); case 'TEAM-002': return d('W', 'GP'); case 'TEAM-003': return d('RW', 'GP'); case 'TEAM-004': return safeDiv(g('G') - g('GA'), g('GP'));
    case 'TEAM-005': return safeDiv(g('G') * g('G'), g('G') * g('G') + g('GA') * g('GA')); case 'TEAM-006': return 1000 * (m('OFF-004') + safeDiv(g('SV'), g('SA')));
    case 'TEAM-007': return 100 * (d('PPG', 'PP_OPP') + 1 - d('PPGA', 'PK_OPP')); case 'TEAM-008': return d('FO_WON', 'FO_TAKEN'); case 'TEAM-009': return safeDiv(g('PEN_DRAWN') - g('PEN_TAKEN'), g('GP'));
    case 'TEAM-010': return d('HOME_G', 'G'); case 'TEAM-011': return safeDiv(g('COMEBACK_WINS') + g('ONE_GOAL_WINS'), 2 * g('W'));
    case 'TEAM-012': return 100 * (0.28 * m('TEAM-001') + 0.22 * m('POS-004') + 0.18 * safeDiv(g('G'), g('G') + g('GA')) + 0.16 * clamp(m('TEAM-007') / 110, 0, 1) + 0.16 * clamp(m('GOL-015') / 100, 0, 1));
    case 'CTX-001': return d('FIRST_PERIOD_G', 'G'); case 'CTX-002': return d('SECOND_PERIOD_G', 'G'); case 'CTX-003': return d('THIRD_PERIOD_G', 'G');
    case 'CTX-004': return safeDiv(g('OT_WINS') + g('SO_WINS'), g('OT_GAMES') + g('SO_GAMES')); case 'CTX-005': return d('ONE_GOAL_WINS', 'ONE_GOAL_GAMES');
    case 'VAL-001': return d('PLAYER_G', 'PLAYER_GP'); case 'VAL-002': return d('PLAYER_PTS', 'PLAYER_GP'); case 'VAL-003': return g('PLAYER_G') - g('PLAYER_xG');
    case 'VAL-004': return 60 * safeDiv(g('PLAYER_ONICE_GF') - g('PLAYER_ONICE_GA'), g('PLAYER_TOI'));
    case 'VAL-005': return 100 * (0.35 * clamp(m('VAL-002') / 1.5, 0, 1) + 0.25 * clamp(m('VAL-001') / 0.7, 0, 1) + 0.20 * clamp((m('VAL-004') + 2) / 4, 0, 1) + 0.20 * clamp(60 * d('PLAYER_SOG', 'PLAYER_TOI') / 15, 0, 1));
    case 'ADV-001': return 100 + 18 * (m('TEAM-001') - 0.5) + 16 * (m('POS-004') - 0.5) + 12 * (m('POS-001') - 0.5) + 0.18 * (m('GOL-015') - 70) + 0.12 * (m('TRN-012') - 70);
    case 'ADV-002': return m('TEAM-012') * (1 + 0.35 * (g('OPP_STRENGTH') - 50) / 50);
    case 'ADV-003': return 100 * (0.40 * m('POS-004') + 0.30 * m('POS-005') + 0.30 * m('POS-001'));
    case 'ADV-004': return clamp(50 + 700 * (m('GOL-001') - g('LEAGUE_SV_PCT')) + 0.35 * (m('GOL-015') - 70) - 0.25 * m('DEF-003'), 0, 100);
    case 'ADV-005': return 100 * (d('PPG', 'PP_OPP') + (1 - d('PPGA', 'PK_OPP')) - 1);
    default: return NaNv;
  }
}

function evaluateConventional(values) {
  const out = []; const s = { total: SPECS.length, pass: 0, qualified: 0, fail: 0, blocked: 0 };
  for (const q of SPECS) {
    const r = { equation_id: q.id, category: q.category, name: q.name, formula: q.formula, formula_status: q.status, lab_disposition: '', value: null, reason_codes: null };
    const x = evaluateConventionalByID(q.id, values);
    if (!finite(x)) { r.lab_disposition = 'FAIL'; r.reason_codes = ['UNRESOLVED_DOMAIN_OR_ZERO_DENOMINATOR']; s.fail++; out.push(r); continue; }
    r.value = roundN(x, 12);
    let ok = true;
    if (finite(q.lower) && x < q.lower - 1e-9) ok = false;
    if (finite(q.upper) && x > q.upper + 1e-9) ok = false;
    if (!ok) { r.lab_disposition = 'FAIL'; r.reason_codes = ['VALUE_OUTSIDE_DECLARED_BOUNDS']; s.fail++; }
    else if (q.status === 'EXECUTABLE_OPEN') { r.lab_disposition = 'PASS'; r.reason_codes = ['FORMULA_EXECUTED_DETERMINISTICALLY']; s.pass++; }
    else { r.lab_disposition = 'QUALIFIED'; r.reason_codes = ['TRANSPARENT_HOCKEY_PROXY_REQUIRES_CONTEXT_CALIBRATION']; s.qualified++; }
    out.push(r);
  }
  return [out, s];
}

/* ------------------------------------------------------------------ Master Law (8S Penteract–S³) */
function defaultCalibration() {
  return { ID: 'HK001-MASTER-HOCKEY-SYNTH-v1', Epsilon: 1e-9, EpsilonInd: 0.015, EpsilonGain: 0.005, LatticeStep: 0.1, LatticeBound: 1, Period: 1, SigmaC: 0.95, SigmaJ: 0.80,
    K2: 0.35, K3: 0.15, Beta: 0.8, AlphaE: 0.7, AlphaU: 0.5, AlphaX: 0.6, AlphaZeta: 1, J2: 0.4, J3: 0.2, RMax: 10, RadiusAlpha: 0.2, OmegaTarget: 1, SigmaOmega: 0.4,
    Metric: { G1: 1, G2: 1.2, G3: 1, G4: 0.8, G5: 1.1 } };
}
function calibrationFor(r) {
  const c = defaultCalibration(); const m = r.calibration || {};
  const set = (k, obj, key) => { if (Object.prototype.hasOwnProperty.call(m, k) && finite(m[k])) obj[key] = m[k]; };
  set('epsilon', c, 'Epsilon'); set('epsilon_ind', c, 'EpsilonInd'); set('epsilon_gain', c, 'EpsilonGain'); set('lattice_step', c, 'LatticeStep'); set('lattice_bound', c, 'LatticeBound');
  set('sigma_c', c, 'SigmaC'); set('sigma_j', c, 'SigmaJ'); set('beta', c, 'Beta'); set('alpha_e', c, 'AlphaE'); set('alpha_u', c, 'AlphaU'); set('alpha_x', c, 'AlphaX');
  set('alpha_zeta', c, 'AlphaZeta'); set('j2', c, 'J2'); set('j3', c, 'J3'); set('r_max', c, 'RMax'); set('radius_alpha', c, 'RadiusAlpha'); set('omega_target', c, 'OmegaTarget');
  set('sigma_omega', c, 'SigmaOmega'); set('g1', c.Metric, 'G1'); set('g2', c.Metric, 'G2'); set('g3', c.Metric, 'G3'); set('g4', c.Metric, 'G4'); set('g5', c.Metric, 'G5');
  return c;
}
const calibrationValid = (c) => c.Epsilon > 0 && c.LatticeStep > 0 && c.LatticeBound > 0 && c.SigmaC > 0 && c.SigmaJ > 0 && c.SigmaOmega > 0 && c.RMax > 0;
const v5 = (a, b, c, d, e) => [a, b, c, d, e];
const norm2 = (v) => v[0] * v[0] + v[1] * v[1] + v[2] * v[2] + v[3] * v[3] + v[4] * v[4];
function metricDist2(a, b, g) {
  const d1 = a[0] - b[0], d2 = a[1] - b[1], d3 = a[2] - b[2], d4 = a[3] - b[3], d5 = a[4] - b[4];
  return g.G1 * d1 * d1 + g.G2 * d2 * d2 + g.G3 * d3 * d3 + g.G4 * d4 * d4 + g.G5 * d5 * d5;
}
const etaInd = (v, c) => v[4] * v[4] / (norm2(v) + c.Epsilon);
const quantize = (x, c) => c.LatticeStep * clamp(goRound(clamp(x, -1, 1) / c.LatticeStep), -c.LatticeBound, c.LatticeBound);
const quantizeV = (v, c) => v.map((x) => quantize(x, c));
function makeEntity(id, craw, evidence, phase, kappa, c) {
  const q = quantizeV(craw, c);
  let mean = 0; for (const x of q) mean += x; mean /= 5;
  let variance = 0; for (const x of q) variance += (x - mean) * (x - mean); variance /= 5;
  const dist = Math.sqrt(metricDist2(q, [0, 0, 0, 0, 0], c.Metric)) / 3;
  const E = clamp((q[0] + q[1] + q[2] + q[3] + q[4] + 5) / 10, 0, 1);
  const u = clamp(1 - Math.sqrt(variance) / 1.5, 0, 1);
  const X = clamp(Math.abs(q[0] - q[1]) / 2, 0, 1);
  const ent = { ID: id, C: q, Evidence: evidence, Phase: phase, Omega: 1, D: dist, E, U: u, X, Zeta: 0, Kappa: clamp(kappa, 0, 1), Chi: X * 0.2, Xi: 0 };
  if (TR) { const k = 'ML-' + ENT[id] + '-'; for (let i = 0; i < 5; i++) { rec(k + 'C' + (i + 1), craw[i]); rec(k + 'Q' + (i + 1), q[i]); rec(k + 'V' + (i + 1), evidence[i]); }
    rec(k + 'PH', phase); rec(k + 'KAP', ent.Kappa); rec(k + 'D', dist); rec(k + 'EN', E); rec(k + 'U', u); rec(k + 'X', X); rec(k + 'CHI', ent.Chi); }
  return ent;
}
const weight = (a, b, role, c) => goExp(-(metricDist2(a.C, b.C, c.Metric) / (2 * c.SigmaC * c.SigmaC) + role * role / (2 * c.SigmaJ * c.SigmaJ)));
const coherence = (a, b) => (1 + goCos(b.Phase - a.Phase)) / 2;
function boundaryProduct(v) { let p = 1; for (const x of v) p *= clamp(1 - Math.abs(x) / 1.25, 0, 1); return p; }
function evaluateEntity(e, pair, triad, c) {
  const h = c.Beta * (c.LatticeBound + 0.5 - e.D) + c.AlphaE * e.E + c.AlphaU * e.U - c.AlphaX * e.X - c.AlphaZeta * e.Zeta + c.J2 * pair + c.J3 * triad;
  const p = sigmoid(h);
  const B = boundaryProduct(e.C);
  const tempo = goExp(-((e.Omega - c.OmegaTarget) * (e.Omega - c.OmegaTarget)) / (2 * c.SigmaOmega * c.SigmaOmega));
  const ready = clamp(p * e.Kappa * (1 - e.Chi) * (1 - e.Xi) * tempo, 0, 1);
  const radius = c.RMax * goPow(B, c.RadiusAlpha) * cubeRootNonnegative(ready);
  const out = { Entity: e, Eta: etaInd(e.Evidence, c), H: h, P: p, Boundary: B, Readiness: ready, Radius: radius };
  if (TR) { const k = 'ML-' + ENT[e.ID] + '-'; rec(k + 'PAIR', pair); rec(k + 'TRIAD', triad); rec(k + 'H', h); rec(k + 'P', p); rec(k + 'B5', B); rec(k + 'TEMPO', tempo); rec(k + 'S', ready); rec(k + 'R', radius); rec(k + 'ETA', out.Eta); }
  return out;
}
const pairScore = (a, b, w) => 100 * Math.sqrt(a.Readiness * b.Readiness) * w * coherence(a.Entity, b.Entity);
const triadScore = (a, b, d, wab, wac, wbc) => 100 * cubeRootNonnegative(a.Readiness * b.Readiness * d.Readiness) * ((wab + wac + wbc) / 3) * ((coherence(a.Entity, b.Entity) + coherence(a.Entity, d.Entity) + coherence(b.Entity, d.Entity)) / 3);
const direct = (v, a, b) => safeDiv(get(v, a), get(v, b));

function evaluateMaster(r, mandatory) {
  const c = calibrationFor(r);
  const sum = { total: 32, pass: 0, qualified: 0, fail: 0, blocked: 0 };
  if (!calibrationValid(c)) { sum.fail = 32; return [null, sum, { calibration_id: c.ID, numerical_scope: '', eta_ind: 0, delta_8s: 0, matchup_class: '', admission: 'DENY_CALIBRATION', mandatory_gate_pass: false, epsilon_ind: c.EpsilonInd, epsilon_gain: c.EpsilonGain }]; }
  const v = r.values; const g = (k) => get(v, k);
  const m = (id) => evaluateConventionalByID(id, v);
  const gp = clamp(g('GP') / 82, 0, 1);
  const OFF = makeEntity('OFFENSE', v5(normalize(m('OFF-001'), 3.0, 1.5), normalize(m('OFF-004'), 0.10, 0.05), normalize(m('POS-004'), 0.50, 0.16), normalize(m('OFF-010'), 0.45, 0.25), normalize(m('OFF-024'), 1, 0.45)), v5(gp, clamp(g('SOG') / 3000, 0, 1), clamp(g('SCF') / 2500, 0, 1), clamp(g('HDCF') / 1200, 0, 1), clamp(g('xGF') / 350, 0, 1)), 2 * PI * clamp(m('OFF-004'), 0, 1), gp, c);
  const POS = makeEntity('POSSESSION', v5(normalize(m('POS-001'), 0.5, 0.15), normalize(m('POS-002'), 0.5, 0.15), normalize(m('POS-005'), 0.5, 0.18), normalize(m('POS-007'), 0.5, 0.15), normalize(m('POS-009'), 0, 15)), v5(gp, clamp(g('CF') / 5000, 0, 1), clamp(g('FF') / 4200, 0, 1), clamp(g('CLOSE_CF') / 2500, 0, 1), clamp(g('SCORE_ADJ_CF') / 5000, 0, 1)), 2 * PI * clamp(m('POS-001'), 0, 1), gp, c);
  const TRN = makeEntity('TRANSITION', v5(normalize(m('TRN-001'), 0.55, 0.30), normalize(m('TRN-003'), 0.55, 0.30), normalize(m('TRN-005'), 0.65, 0.25), normalize(m('TRN-008'), 0.60, 0.25), normalize(m('TRN-012'), 70, 25)), v5(gp, clamp(g('ENTRIES') / 2200, 0, 1), clamp(g('EXITS') / 2200, 0, 1), clamp(g('ENTRY_SHOTS') / 1200, 0, 1), clamp(g('CONTROLLED_ENTRIES') / 1500, 0, 1)), 2 * PI * clamp(m('TRN-008'), 0, 1), gp, c);
  const DEF = makeEntity('DEFENSE', v5(normalize(3.0 - m('DEF-001'), 0, 1.5), normalize(28 - m('DEF-008'), 0, 15), normalize(12 - m('DEF-009'), 0, 8), normalize(m('DEF-010'), 0.22, 0.18), normalize(m('DEF-018'), 70, 25)), v5(gp, clamp(g('SA') / 3000, 0, 1), clamp(g('SCA') / 2500, 0, 1), clamp(g('HDCA') / 1200, 0, 1), clamp(g('BLOCKS') / 1800, 0, 1)), 2 * PI * clamp(1 - m('DEF-001') / 6, 0, 1), gp, c);
  const GOL = makeEntity('GOALTENDING', v5(normalize(m('GOL-001'), 0.905, 0.05), normalize(2.9 - m('GOL-002'), 0, 1.5), normalize(m('GOL-006'), 0.88, 0.10), normalize(m('GOL-009'), 0.55, 0.30), normalize(m('GOL-015'), 75, 25)), v5(gp, clamp(g('SA_G') / 3000, 0, 1), clamp(g('HDSA') / 1100, 0, 1), clamp(g('GS') / 82, 0, 1), clamp(g('MIN_G') / 5000, 0, 1)), 2 * PI * clamp(m('GOL-001'), 0, 1), clamp(g('GS') / 70, 0, 1), c);
  const SPT = makeEntity('SPECIAL_TEAMS', v5(normalize(direct(v, 'PPG', 'PP_OPP'), 0.20, 0.15), normalize(1 - direct(v, 'PPGA', 'PK_OPP'), 0.80, 0.15), normalize(m('TEAM-007'), 100, 30), normalize(m('TEAM-009'), 0, 0.5), normalize(m('TEAM-008'), 0.5, 0.12)), v5(gp, clamp(g('PP_OPP') / 350, 0, 1), clamp(g('PK_OPP') / 350, 0, 1), clamp(g('FO_TAKEN') / 6000, 0, 1), clamp((g('PP_OPP') + g('PK_OPP')) / 700, 0, 1)), 2 * PI * clamp(m('TEAM-007') / 200, 0, 1), gp, c);
  const TEAM = makeEntity('TEAM', v5(normalize(m('TEAM-001'), 0.5, 0.25), normalize(m('TEAM-002'), 0.5, 0.25), normalize(m('TEAM-004'), 0, 2), normalize(m('TEAM-005'), 0.5, 0.25), normalize(m('TEAM-012'), 55, 30)), v5(gp, clamp(g('POINTS') / 130, 0, 1), clamp(g('G') / 350, 0, 1), clamp(g('GA') / 350, 0, 1), clamp(g('W') / 60, 0, 1)), 2 * PI * clamp(m('TEAM-001'), 0, 1), gp, c);
  const OPP = makeEntity('OPPONENT', v5(normalize(g('OPP_GFPG'), 3, 0.9), normalize(3 - g('OPP_GAPG'), 0, 0.9), normalize(g('OPP_XGF_PCT'), 0.5, 0.15), normalize(g('OPP_CF_PCT'), 0.5, 0.15), normalize(g('OPP_SV_PCT'), 0.905, 0.04)), v5(gp, 0.85, 0.85, 0.80, 0.90), 2 * PI * clamp(g('OPP_XGF_PCT'), 0, 1), 0.9, c);
  const wOP = weight(OFF, POS, 0.2, c), wOT = weight(OFF, TRN, 0.25, c), wPT = weight(POS, TRN, 0.2, c), wPD = weight(POS, DEF, 0.25, c), wDG = weight(DEF, GOL, 0.2, c);
  const wGT = weight(GOL, TEAM, 0.3, c), wTS = weight(TEAM, SPT, 0.2, c), wTO = weight(TEAM, OPP, 0.45, c), wOD = weight(OFF, DEF, 0.3, c);
  const OFF1 = evaluateEntity(OFF, wOP + wOT, wOP * wOT, c), POS1 = evaluateEntity(POS, wOP + wPD, wOP * wPD, c), TRN1 = evaluateEntity(TRN, wOT + wPT, wOT * wPT, c);
  const DEF1 = evaluateEntity(DEF, wPD + wDG, wPD * wDG, c), GOL1 = evaluateEntity(GOL, wDG + wGT, wDG * wGT, c), SPT1 = evaluateEntity(SPT, wTS, wTS * wTS, c);
  const TEAM1 = evaluateEntity(TEAM, wGT + wTS + wTO, wGT * wTS, c), OPP1 = evaluateEntity(OPP, wTO, wTO * wTO, c);
  if (TR) {
    const wTT = weight(TRN, TEAM, 0.3, c);
    for (const [k, w] of [['OP', wOP], ['OT', wOT], ['PT', wPT], ['PD', wPD], ['DG', wDG], ['GT', wGT], ['TS', wTS], ['TO', wTO], ['OD', wOD], ['TT', wTT]]) rec('ML-W-' + k, w);
    for (const [k, a, b] of [['OP', OFF, POS], ['OT', OFF, TRN], ['PT', POS, TRN], ['PD', POS, DEF], ['PG', POS, GOL], ['DG', DEF, GOL], ['TT', TRN, TEAM], ['GT', GOL, TEAM], ['TS', TEAM, SPT], ['OD', OFF, DEF]]) rec('ML-RHO-' + k, coherence(a, b));
  }
  const op = pairScore(OFF1, POS1, wOP), ot = pairScore(OFF1, TRN1, wOT), oTri = triadScore(OFF1, POS1, TRN1, wOP, wOT, wPT);
  const pd = pairScore(POS1, DEF1, wPD), dg = pairScore(DEF1, GOL1, wDG), dTri = triadScore(POS1, DEF1, GOL1, wPD, wDG, wOD);
  const tt = pairScore(TRN1, TEAM1, weight(TRN, TEAM, 0.3, c)), gt = pairScore(GOL1, TEAM1, wGT), ts = pairScore(TEAM1, SPT1, wTS), offPrev = pairScore(OFF1, DEF1, wOD);
  const TC = TEAM1.Entity.C, OC = OPP1.Entity.C;
  const g5 = Math.sqrt(metricDist2(TC, OC, c.Metric)) - (TEAM1.Radius + OPP1.Radius) / 20;
  const dr = (TEAM1.Radius - OPP1.Radius) / 10;
  rec('ML-G-DR', dr);
  const g8 = Math.sqrt(metricDist2(TC, OC, c.Metric) + dr * dr);
  const g3 = Math.sqrt((TC[0] - OC[0]) * (TC[0] - OC[0]) + (TC[1] - OC[1]) * (TC[1] - OC[1]) + (TC[2] - OC[2]) * (TC[2] - OC[2])) - (TEAM1.Radius + OPP1.Radius) / 20;
  const gj = normalize(m('TEAM-012') - g('OPP_STRENGTH'), 0, 30);
  let matchClass = 'MIXED_BOUNDARY', matchCode = 1;
  if (g5 < 0 && g3 < 0) { matchClass = 'OVERLAP_ADVANTAGE'; matchCode = 3; }
  else if (g5 <= 0.35 && gj >= -0.15) { matchClass = 'CONTESTED_COMPATIBLE'; matchCode = 2; }
  else if (g8 > 1.35 || gj < -0.65) { matchClass = 'SEPARATED'; matchCode = 0; }
  const oe = (OFF1.Eta + POS1.Eta + TRN1.Eta) / 3;
  const de = (DEF1.Eta + GOL1.Eta) / 2;
  const baseOff = clamp(0.35 * m('TEAM-001') + 0.35 * m('POS-004') + 0.30 * clamp(m('TEAM-012') / 100, 0, 1), 0, 1);
  const basePrev = clamp(0.45 * m('GOL-001') + 0.30 * (1 - clamp(m('DEF-001') / 6, 0, 1)) + 0.25 * clamp(m('DEF-018') / 100, 0, 1), 0, 1);
  const offHybrid = clamp(0.35 * (OFF1.Readiness + POS1.Readiness + TRN1.Readiness) / 3 + 0.25 * oTri / 100 + 0.20 * oe + 0.20 * (OFF1.P + POS1.P + TRN1.P) / 3, 0, 1);
  const prevHybrid = clamp(0.40 * (DEF1.Readiness + GOL1.Readiness) / 2 + 0.25 * dTri / 100 + 0.20 * de + 0.15 * (DEF1.P + GOL1.P) / 2, 0, 1);
  const offDelta = 0.5 * (offHybrid - baseOff);
  const prevDelta = 0.5 * (prevHybrid - basePrev);
  const gain = (offDelta + prevDelta + offPrev / 100) / 3;
  const etaAll = (oe + de + SPT1.Eta + TEAM1.Eta + OPP1.Eta) / 5;
  if (TR) { rec('ML-V-BASEOFF', baseOff); rec('ML-V-BASEPREV', basePrev); rec('ML-V-OFFHYB', offHybrid); rec('ML-V-PREVHYB', prevHybrid); rec('ML-V-OFFDELTA', offDelta); rec('ML-V-PREVDELTA', prevDelta); rec('ML-V-ETAALL', etaAll); }
  let admission = 'ADMIT_8S';
  if (!mandatory) admission = 'DENY_MANDATORY_GATE'; else if (etaAll < c.EpsilonInd) admission = 'DENY_INDEPENDENCE'; else if (gain < c.EpsilonGain) admission = 'DENY_GAIN';
  const Q = 'QUALIFIED', S = 'SYNTHETIC_MASTER_CALIBRATION';
  const row = (model_id, category, name, value) => ({ model_id, category, name, value, lab_disposition: Q, evidence_class: S });
  const rows = [
    row('OFF8S-001', 'Offense 8S', 'Offense-Possession Coupling', op), row('OFF8S-002', 'Offense 8S', 'Offense-Transition Transfer', ot), row('OFF8S-003', 'Offense 8S', 'Offensive Triadic Synergy', oTri),
    row('OFF8S-004', 'Offense 8S', 'Offensive Opportunity Radius', (OFF1.Radius + POS1.Radius + TRN1.Radius) / 3), row('OFF8S-005', 'Offense 8S', 'Offensive Independent Evidence', oe),
    row('OFF8S-006', 'Offense 8S', 'Offensive Admission Probability', (OFF1.P + POS1.P + TRN1.P) / 3),
    row('DEF8S-001', 'Prevention 8S', 'Possession-Defense Coupling', pd), row('DEF8S-002', 'Prevention 8S', 'Defense-Goaltending Transfer', dg), row('DEF8S-003', 'Prevention 8S', 'Prevention Triadic Synergy', dTri),
    row('DEF8S-004', 'Prevention 8S', 'Prevention Sustainability Radius', (POS1.Radius + DEF1.Radius + GOL1.Radius) / 3), row('DEF8S-005', 'Prevention 8S', 'Prevention Independent Evidence', de),
    row('DEF8S-006', 'Prevention 8S', 'Prevention Admission Probability', (DEF1.P + GOL1.P) / 2),
    row('TRN8S-001', 'Transition 8S', 'Transition-Offense Coupling', ot), row('TRN8S-002', 'Transition 8S', 'Transition-Team Coupling', tt), row('TRN8S-003', 'Transition 8S', 'Transition Opportunity Radius', TRN1.Radius),
    row('GOL8S-001', 'Goaltending 8S', 'Goaltending-Defense Mesh', dg), row('GOL8S-002', 'Goaltending 8S', 'Goaltending-Team Balance', gt), row('GOL8S-003', 'Goaltending 8S', 'Goaltending Shell', GOL1.Radius),
    row('TEAM8S-001', 'Team 8S', 'Offense-Prevention Coupling', offPrev), row('TEAM8S-002', 'Team 8S', 'Team-Special-Teams Coupling', ts), row('TEAM8S-003', 'Team 8S', 'Team Creation Radius', OFF1.Radius),
    row('TEAM8S-004', 'Team 8S', 'Team Prevention Radius', (DEF1.Radius + GOL1.Radius) / 2),
    row('TEAM8S-005', 'Team 8S', 'Team Coupled Win Probability', clamp(0.45 * m('TEAM-001') + 0.20 * TEAM1.P + 0.15 * OFF1.P + 0.15 * DEF1.P + 0.05 * SPT1.P, 0, 1)),
    row('MATCH8S-001', 'Matchup 8S', 'Team-Opponent Five-Dimensional Gap', g5), row('MATCH8S-002', 'Matchup 8S', 'Team-Opponent Eight-Dimensional Gap', g8), row('MATCH8S-003', 'Matchup 8S', 'Projected Three-Dimensional Gap', g3),
    row('MATCH8S-004', 'Matchup 8S', 'Judgment Gap', gj), row('MATCH8S-005', 'Matchup 8S', 'Matchup Classification Code', matchCode),
    row('VAL8S-001', 'Value 8S', 'Coupled Offensive Value', 100 * (baseOff + offDelta)), row('VAL8S-002', 'Value 8S', 'Coupled Prevention Value', 100 * (basePrev + prevDelta)),
    row('VAL8S-003', 'Value 8S', 'Team Improvement Delta', gain), row('ADM8S-001', 'Admission 8S', 'Master Admission Code', chooseNumber(admission === 'ADMIT_8S', 1, 0))
  ];
  sum.qualified = rows.length;
  for (const x of rows) x.value = roundN(x.value, 12);
  return [rows, sum, { calibration_id: c.ID, numerical_scope: 'SYNTHETIC_HOCKEY_RESEARCH_CALIBRATION', eta_ind: roundN(etaAll, 12), delta_8s: roundN(gain, 12), matchup_class: matchClass, admission, mandatory_gate_pass: mandatory, epsilon_ind: c.EpsilonInd, epsilon_gain: c.EpsilonGain }];
}

/* ------------------------------------------------------------------ Extrapolation 1 (X8S, extrapolator.go) */
const meanF = (x) => { if (!x.length) return 0; let s = 0; for (const v of x) s += v; return s / x.length; };
const rmsF = (x) => { if (!x.length) return 0; let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); };
const geoF = (x) => { if (!x.length) return 0; let s = 0; for (const v of x) s += goLog(gmax(v, 1e-12)); return goExp(s / x.length); };
const stdF = (x) => { const m = meanF(x); let s = 0; for (const v of x) s += (v - m) * (v - m); if (!x.length) return 0; return Math.sqrt(s / x.length); };
const MASTER_IDS = ['OFF8S-001', 'OFF8S-002', 'OFF8S-003', 'OFF8S-004', 'OFF8S-005', 'OFF8S-006', 'DEF8S-001', 'DEF8S-002', 'DEF8S-003', 'DEF8S-004', 'DEF8S-005', 'DEF8S-006', 'TRN8S-001', 'TRN8S-002', 'TRN8S-003', 'GOL8S-001', 'GOL8S-002', 'GOL8S-003', 'TEAM8S-001', 'TEAM8S-002', 'TEAM8S-003', 'TEAM8S-004', 'TEAM8S-005', 'MATCH8S-001', 'MATCH8S-002', 'MATCH8S-003', 'MATCH8S-004', 'MATCH8S-005', 'VAL8S-001', 'VAL8S-002', 'VAL8S-003', 'ADM8S-001'];

function evaluateExtrapolator(coupled, master) {
  const total = 26;
  const vals = {}; for (const x of coupled || []) if (finite(x.value)) vals[x.model_id] = x.value;
  for (const id of MASTER_IDS) if (!(id in vals)) return [null, { total, pass: 0, qualified: 0, fail: total, blocked: 0 }, { calibration_id: 'HK001-X8S-HOCKEY-v1', input_authority: 'MASTER_LAW_OUTPUT_ONLY', source_model_count: Object.keys(vals).length, anchor_count: 8, composite_count: 18, anchor_centroid: 0, five_dimensional_norm: 0, eight_dimensional_volume: 0, extrapolated_win_probability: 0, decision_confidence: 0, decision_class: 'UNRESOLVED', admission: 'DENY_INCOMPLETE_MASTER_VECTOR' }];
  const n100 = (x) => clamp(x / 100, 0, 1), ne = (x) => clamp(x, 0, 1), radius = (x) => clamp(x / 10, 0, 1);
  const gapOverlap = clamp(1 - gmax(vals['MATCH8S-001'], 0) / 1.5, 0, 1);
  const gainSupport = clamp(0.5 + 10 * master.delta_8s, 0, 1);
  const admit = chooseNumber(master.admission === 'ADMIT_8S', 1, 0);
  const score = (v) => 100 * (0.70 * meanF(v) + 0.30 * rmsF(v));
  const makeR = (id, cat, name, value, unit, formula, av, src) => { const o = { model_id: id, category: cat, name, value: roundN(value, 12), unit, lab_disposition: 'QUALIFIED', evidence_class: 'MASTER_LAW_OUTPUT_ONLY', formula }; if (av && av.length) o.anchor_vector = av; o.source_models = src; return o; };
  const offV = [n100(vals['OFF8S-001']), n100(vals['OFF8S-002']), n100(vals['OFF8S-003']), radius(vals['OFF8S-004']), ne(vals['OFF8S-005']), ne(vals['OFF8S-006']), n100(vals['TEAM8S-001']), n100(vals['VAL8S-001'])];
  const prevV = [n100(vals['DEF8S-001']), n100(vals['DEF8S-002']), n100(vals['DEF8S-003']), radius(vals['DEF8S-004']), ne(vals['DEF8S-005']), ne(vals['DEF8S-006']), n100(vals['GOL8S-001']), n100(vals['VAL8S-002'])];
  const trnV = [n100(vals['TRN8S-001']), n100(vals['TRN8S-002']), radius(vals['TRN8S-003']), ne(vals['OFF8S-005']), ne(vals['OFF8S-006']), gapOverlap, gainSupport, admit];
  const golV = [n100(vals['GOL8S-001']), n100(vals['GOL8S-002']), radius(vals['GOL8S-003']), ne(vals['DEF8S-005']), ne(vals['DEF8S-006']), n100(vals['TEAM8S-004']), gapOverlap, admit];
  const teamV = [n100(vals['TEAM8S-001']), n100(vals['TEAM8S-002']), radius(vals['TEAM8S-003']), radius(vals['TEAM8S-004']), ne(vals['TEAM8S-005']), gainSupport, gapOverlap, admit];
  const matchV = [gapOverlap, clamp(1 - vals['MATCH8S-002'] / 1.5, 0, 1), clamp(1 - gmax(vals['MATCH8S-003'], 0) / 1.5, 0, 1), clamp((vals['MATCH8S-004'] + 1) / 2, 0, 1), clamp(vals['MATCH8S-005'] / 3, 0, 1), ne(vals['OFF8S-006']), ne(vals['DEF8S-006']), admit];
  const evV = [ne(vals['OFF8S-005']), ne(vals['DEF8S-005']), ne(master.eta_ind), ne(vals['OFF8S-006']), ne(vals['DEF8S-006']), gainSupport, gapOverlap, admit];
  const admV = [admit, ne(vals['OFF8S-006']), ne(vals['DEF8S-006']), ne(master.eta_ind), gainSupport, gapOverlap, ne(vals['TEAM8S-005']), clamp(vals['MATCH8S-005'] / 3, 0, 1)];
  const off = score(offV), prev = score(prevV), trn = score(trnV), gol = score(golV), team = score(teamV), match = score(matchV), evidence = score(evV), admission = score(admV);
  if (TR) { rec('X8S-T-GAP', gapOverlap); rec('X8S-T-GAIN', gainSupport); rec('X8S-T-ADMIT', admit);
    [offV, prevV, trnV, golV, teamV, matchV, evV, admV].forEach((vec, a) => vec.forEach((x, i) => rec(`X8S-A0${a + 1}-V${i + 1}`, x))); }
  const anchors = [off, prev, trn, gol, team, match, evidence, admission];
  const F = '100*(.70*mean+.30*rms)';
  const rows = [makeR('X8S-A01', 'Anchor 8S', 'Offensive Penteract Anchor', off, 'index_points', F, offV, ['OFF8S-*']), makeR('X8S-A02', 'Anchor 8S', 'Prevention Penteract Anchor', prev, 'index_points', F, prevV, ['DEF8S-*']),
    makeR('X8S-A03', 'Anchor 8S', 'Transition Integration Anchor', trn, 'index_points', F, trnV, ['TRN8S-*']), makeR('X8S-A04', 'Anchor 8S', 'Goaltending Mesh Anchor', gol, 'index_points', F, golV, ['GOL8S-*']),
    makeR('X8S-A05', 'Anchor 8S', 'Team Equilibrium Anchor', team, 'index_points', F, teamV, ['TEAM8S-*']), makeR('X8S-A06', 'Anchor 8S', 'Matchup Geometry Anchor', match, 'index_points', F, matchV, ['MATCH8S-*']),
    makeR('X8S-A07', 'Anchor 8S', 'Independent Evidence Anchor', evidence, 'index_points', F, evV, ['OFF8S-005', 'DEF8S-005']), makeR('X8S-A08', 'Anchor 8S', 'Admission Integrity Anchor', admission, 'index_points', F, admV, ['ADM8S-001'])];
  const centroid = meanF(anchors);
  const five = 100 * rmsF([off / 100, prev / 100, gol / 100, team / 100, match / 100]);
  const volume = 100 * geoF([off / 100, prev / 100, trn / 100, gol / 100, team / 100, match / 100, evidence / 100, admission / 100]);
  const equil = 100 - Math.abs(off - prev);
  const disp = stdF(anchors);
  const resilience = 100 * (0.25 * prev / 100 + 0.20 * gol / 100 + 0.20 * team / 100 + 0.20 * evidence / 100 + 0.15 * (1 - disp / 100));
  const opportunity = 100 * (0.30 * (radius(vals['OFF8S-004']) + radius(vals['DEF8S-004']) + radius(vals['TRN8S-003']) + radius(vals['GOL8S-003'])) / 4 + 0.30 * gainSupport + 0.20 * ne(vals['TEAM8S-005']) + 0.20 * admit);
  const boundary = 100 * (0.45 * gapOverlap + 0.25 * clamp(1 - vals['MATCH8S-002'] / 1.5, 0, 1) + 0.15 * evidence / 100 + 0.15 * admit);
  const latent = 100 * (0.30 * (1 - centroid / 100) + 0.30 * gainSupport + 0.20 * gapOverlap + 0.20 * (radius(vals['OFF8S-004']) + radius(vals['DEF8S-004'])) / 2);
  const win = clamp(0.45 * vals['TEAM8S-005'] + 0.15 * team / 100 + 0.12 * centroid / 100 + 0.10 * match / 100 + 0.08 * evidence / 100 + 0.10 * gainSupport, 0, 1);
  const offAdv = clamp(sigmoid((off - prev) / 12 + 1.25 * (gapOverlap - 0.5) + 0.5 * (vals['VAL8S-001'] - vals['VAL8S-002']) / 20), 0, 1);
  const contain = clamp(sigmoid((prev - off) / 12 + 1.25 * ((1 - gapOverlap) - 0.5) + 0.5 * (vals['VAL8S-002'] - vals['VAL8S-001']) / 20), 0, 1);
  const improve = 100 * clamp(0.55 * sigmoid(10 * (master.delta_8s - master.epsilon_gain)) + 0.25 * centroid / 100 + 0.20 * team / 100, 0, 1);
  const confidence = 100 * (0.30 * admission / 100 + 0.25 * evidence / 100 + 0.20 * boundary / 100 + 0.15 * (1 - disp / 100) + 0.10 * admit);
  const dominance = clamp(50 + 0.35 * (off - prev) + 0.25 * (team - 50) + 0.20 * (match - 50) + 0.20 * (gol - 50), 0, 100);
  let cls = 'DENIED', code = 0, extAdm = 'DENY_MASTER_ADMISSION';
  if (admit >= 0.5) {
    extAdm = 'ADMIT_X8S';
    if (win >= 0.70 && confidence >= 75 && master.delta_8s > master.epsilon_gain) { cls = 'COUPLED_EXPANSION'; code = 4; }
    else if (win >= 0.62 && match >= 65) { cls = 'ADVANTAGE_STABLE'; code = 3; }
    else if (confidence >= 60) { cls = 'CONTESTED_ADMISSIBLE'; code = 2; }
    else { cls = 'MARGINAL_ADMISSION'; code = 1; }
    if (evidence < 50 || confidence < 55) extAdm = 'DENY_EXTRAPOLATION_CONFIDENCE';
  }
  const fin = chooseNumber(extAdm === 'ADMIT_X8S', 1, 0);
  const src = ['X8S-A01', 'X8S-A02', 'X8S-A03', 'X8S-A04', 'X8S-A05', 'X8S-A06', 'X8S-A07', 'X8S-A08'];
  rows.push(makeR('X8S-C01', 'Composite 8S', 'Five-Dimensional System Norm', five, 'index_points', '100*rms(offense,prevention,goalie,team,matchup)', null, src),
    makeR('X8S-C02', 'Composite 8S', 'Eight-Dimensional Coupled Volume', volume, 'index_points', '100*geometric_mean(A01..A08)', null, src),
    makeR('X8S-C03', 'Composite 8S', 'Anchor Centroid', centroid, 'index_points', 'mean(A01..A08)', anchors, src),
    makeR('X8S-C04', 'Composite 8S', 'Offense-Prevention Equilibrium', equil, 'index_points', '100-abs(A01-A02)', null, src),
    makeR('X8S-C05', 'Composite 8S', 'Coupled Resilience Index', resilience, 'index_points', 'weighted(prevention,goalie,team,evidence,dispersion)', null, src),
    makeR('X8S-C06', 'Composite 8S', 'Opportunity Expansion Index', opportunity, 'index_points', 'weighted(radii,Delta_8S,team,admission)', null, src),
    makeR('X8S-C07', 'Composite 8S', 'Boundary Stability Index', boundary, 'index_points', 'weighted(gaps,evidence,admission)', null, src),
    makeR('X8S-C08', 'Composite 8S', 'Independent Evidence Density', evidence, 'index_points', 'A07', null, src),
    makeR('X8S-C09', 'Composite 8S', 'Anchor Dispersion', disp, 'index_points', 'population_stddev(A01..A08)', anchors, src),
    makeR('X8S-C10', 'Composite 8S', 'Latent Upside Index', latent, 'index_points', 'weighted(unoccupied_space,Delta,gap,radius)', null, src),
    makeR('X8S-C11', 'Projection 8S', 'Coupled Team Win Extrapolation', win, 'probability', 'weighted(team_win,A05,centroid,A06,A07,Delta)', null, src),
    makeR('X8S-C12', 'Projection 8S', 'Offensive Advantage Extrapolation', offAdv, 'probability', 'sigmoid(anchor_difference+gap+value_difference)', null, src),
    makeR('X8S-C13', 'Projection 8S', 'Defensive Containment Extrapolation', contain, 'probability', 'sigmoid(reverse_anchor_difference+separation)', null, src),
    makeR('X8S-C14', 'Projection 8S', 'Team Improvement Extrapolation', improve, 'index_points', 'weighted(sigmoid(Delta-epsilon),centroid,team)', null, src),
    makeR('X8S-C15', 'Decision 8S', 'Multi-Anchor Decision Confidence', confidence, 'index_points', 'weighted(admission,evidence,boundary,dispersion)', null, src),
    makeR('X8S-C16', 'Decision 8S', 'Coupled Dominance Axis', dominance, 'index_points', '50+weighted(offense-prevention,team,matchup,goalie)', null, src),
    makeR('X8S-C17', 'Decision 8S', 'Composite Classification Code', code, 'code', '0 denied;1 marginal;2 contested;3 stable;4 expansion', null, src),
    makeR('X8S-C18', 'Decision 8S', 'Master-Output Admission Code', fin, 'code', '1 iff master and confidence floors pass', null, src));
  return [rows, { total, pass: 0, qualified: rows.length, fail: 0, blocked: 0 }, { calibration_id: 'HK001-X8S-HOCKEY-v1', input_authority: 'MASTER_LAW_OUTPUT_ONLY', source_model_count: MASTER_IDS.length, anchor_count: 8, composite_count: 18,
    anchor_centroid: roundN(centroid, 12), five_dimensional_norm: roundN(five, 12), eight_dimensional_volume: roundN(volume, 12), extrapolated_win_probability: roundN(win, 12), decision_confidence: roundN(confidence, 12), decision_class: cls, admission: extAdm }];
}

/* ------------------------------------------------------------------ Extrapolation 2 (SP8, parlay.go) */
const X8S_IDS = ['X8S-A01', 'X8S-A02', 'X8S-A03', 'X8S-A04', 'X8S-A05', 'X8S-A06', 'X8S-A07', 'X8S-A08', 'X8S-C01', 'X8S-C02', 'X8S-C03', 'X8S-C04', 'X8S-C05', 'X8S-C06', 'X8S-C07', 'X8S-C08', 'X8S-C09', 'X8S-C10', 'X8S-C11', 'X8S-C12', 'X8S-C13', 'X8S-C14', 'X8S-C15', 'X8S-C16', 'X8S-C17', 'X8S-C18'];
function evaluateSphereParlay(extrapolated, source) {
  const legCount = 8, compositeCount = 18, total = 26;
  const values = {}; for (const row of extrapolated || []) if (finite(row.value)) values[row.model_id] = row.value;
  for (const id of X8S_IDS) if (!(id in values)) return [null, { total, pass: 0, qualified: 0, fail: total, blocked: 0 }, { calibration_id: 'HK001-8SPHERE-PARLAY-v1', input_authority: 'EXTRAPOLATION_OUTPUT_ONLY', source_model_count: Object.keys(values).length, leg_count: legCount, composite_count: compositeCount,
    raw_independence_probability: 0, sphere_geometric_core: 0, sphere_coherence: 0, dependence_coefficient: 0, adjusted_parlay_probability: 0, effective_leg_count: 0, joint_stability: 0, decision_confidence: 0, decision_class: 'UNRESOLVED_EXTRAPOLATION_VECTOR', admission: 'DENY_INCOMPLETE_EXTRAPOLATION_VECTOR' }];
  const makeResult = (id, category, name, value, unit, formula, ...sources) => ({ model_id: id, category, name, value: roundN(value, 12), unit, lab_disposition: 'QUALIFIED', evidence_class: 'PROPRIETARY_8SPHERE_PARLAY_RESEARCH_MODEL', formula, source_models: sources.length ? sources.slice() : null });
  const legIDs = X8S_IDS.slice(0, 8);
  const legNames = ['Offensive Penteract Leg', 'Prevention Penteract Leg', 'Transition Integration Leg', 'Goaltending Mesh Leg', 'Team Equilibrium Leg', 'Matchup Geometry Leg', 'Independent Evidence Leg', 'Admission Integrity Leg'];
  const legs = []; const rows = [];
  legIDs.forEach((id, i) => { legs[i] = clamp(values[id] / 100, 0.001, 0.999); rows.push(makeResult('SP8-L0' + String.fromCharCode(49 + i), '8Sphere Leg', legNames[i], legs[i], 'probability', 'clamp(source_anchor/100,0.001,0.999)', id)); });
  let raw = 1.0, weakest = 1.0;
  for (const p of legs) { raw *= p; if (p < weakest) weakest = p; }
  const geometricCore = goPow(raw, 1 / legCount);
  const dispersionStability = clamp(1 - values['X8S-C09'] / 25, 0, 1);
  const sphereVector = [clamp((values['X8S-C01'] + values['X8S-C02']) / 200, 0, 1), clamp((values['X8S-C03'] + values['X8S-C04']) / 200, 0, 1), clamp(values['X8S-C05'] / 100, 0, 1),
    clamp((values['X8S-C06'] + values['X8S-C10']) / 200, 0, 1), clamp(values['X8S-C07'] / 100, 0, 1), clamp(values['X8S-C08'] / 100, 0, 1), clamp(values['X8S-A08'] / 100, 0, 1), clamp(0.5 * (values['X8S-C15'] / 100 + dispersionStability), 0, 1)];
  const sphereMean = meanF(sphereVector), sphereRadius = rmsF(sphereVector);
  if (TR) { sphereVector.forEach((x, i) => rec('SP8-S' + (i + 1), x)); rec('SP8-T-DSTAB', dispersionStability); }
  const sphereCoherence = clamp(0.60 * sphereMean + 0.40 * sphereRadius, 0, 1);
  const dependence = clamp(0.90 * sphereCoherence, 0, 0.95);
  const dependenceJoint = goExp((1 - dependence) * goLog(gmax(raw, 1e-12)) + dependence * goLog(gmax(weakest, 1e-12)));
  const classificationSupport = clamp(values['X8S-C17'] / 4, 0, 1);
  const projectionVector = [clamp(values['X8S-C11'], 0.001, 0.999), clamp(values['X8S-C12'], 0.001, 0.999), clamp(1 - values['X8S-C13'], 0.001, 0.999), clamp(values['X8S-C14'] / 100, 0.001, 0.999),
    clamp(values['X8S-C16'] / 100, 0.001, 0.999), clamp(classificationSupport, 0.001, 0.999), clamp(values['X8S-C15'] / 100, 0.001, 0.999)];
  const projectionSupport = geoF(projectionVector);
  if (TR) { projectionVector.forEach((x, i) => rec('SP8-P' + (i + 1), x)); rec('SP8-T-CLS', classificationSupport); }
  const supportMultiplier = clamp(0.80 + 0.25 * projectionSupport, 0.75, 1.05);
  const weakestDrag = clamp(1 - weakest, 0, 1);
  const dispersionHaircut = clamp(1 - 0.35 * (values['X8S-C09'] / 100) - 0.25 * weakestDrag, 0.70, 1);
  const adjusted = clamp(Math.min(weakest, dependenceJoint * supportMultiplier * dispersionHaircut), 0, 1);
  let effectiveLegs = legCount;
  if (geometricCore > 0 && geometricCore < 1 && adjusted > 0) effectiveLegs = goLog(adjusted) / goLog(geometricCore);
  const jointStability = 100 * (0.20 * weakest + 0.15 * dispersionStability + 0.15 * clamp(values['X8S-C07'] / 100, 0, 1) + 0.15 * clamp(values['X8S-C05'] / 100, 0, 1) + 0.10 * clamp(values['X8S-A08'] / 100, 0, 1) + 0.10 * clamp(values['X8S-C15'] / 100, 0, 1) + 0.10 * clamp(values['X8S-C03'] / 100, 0, 1) + 0.05 * clamp(values['X8S-C01'] / 100, 0, 1));
  const decisionConfidence = 100 * (0.25 * clamp(values['X8S-C15'] / 100, 0, 1) + 0.15 * clamp(values['X8S-C08'] / 100, 0, 1) + 0.15 * clamp(values['X8S-A08'] / 100, 0, 1) + 0.15 * clamp(values['X8S-C07'] / 100, 0, 1) + 0.10 * sphereCoherence + 0.10 * clamp(jointStability / 100, 0, 1) + 0.10 * classificationSupport);
  let admission = 'DENY_SOURCE_EXTRAPOLATION', decisionClass = 'DENIED', classCode = 0;
  if (source.admission === 'ADMIT_X8S' && values['X8S-C18'] >= 0.5) {
    admission = 'ADMIT_8SPHERE';
    if (adjusted >= 0.34 && jointStability >= 75 && decisionConfidence >= 80) { decisionClass = 'SPHERE_CONVERGENCE'; classCode = 4; }
    else if (adjusted >= 0.25 && decisionConfidence >= 70) { decisionClass = 'COUPLED_PARLAY_STABLE'; classCode = 3; }
    else if (adjusted >= 0.15) { decisionClass = 'CONTESTED_MULTI_LEG'; classCode = 2; }
    else { decisionClass = 'FRAGILE_ADMISSIBLE'; classCode = 1; }
    if (adjusted < 0.10 || decisionConfidence < 60) admission = 'DENY_8SPHERE_CONFIDENCE';
  }
  const admissionCode = chooseNumber(admission === 'ADMIT_8SPHERE', 1, 0);
  rows.push(
    makeResult('SP8-C01', '8Sphere Composite', 'Raw Eight-Leg Independence Product', raw, 'probability', 'product(L01..L08)', ...legIDs),
    makeResult('SP8-C02', '8Sphere Composite', 'Spherical Geometric Core', geometricCore, 'probability', 'product(L01..L08)^(1/8)', ...legIDs),
    makeResult('SP8-C03', '8Sphere Geometry', 'Sphere Coupling Mean', sphereMean, 'coefficient', 'mean(S8 adjustment vector)', 'X8S-C01', 'X8S-C02', 'X8S-C03', 'X8S-C04', 'X8S-C05', 'X8S-C06', 'X8S-C07', 'X8S-C08', 'X8S-C09', 'X8S-C10', 'X8S-C15', 'X8S-A08'),
    makeResult('SP8-C04', '8Sphere Geometry', 'Sphere RMS Radius', sphereRadius, 'coefficient', 'rms(S8 adjustment vector)', 'SP8-C03'),
    makeResult('SP8-C05', '8Sphere Geometry', 'Sphere Coherence', sphereCoherence, 'coefficient', '0.60*sphere_mean+0.40*sphere_rms_radius', 'SP8-C03', 'SP8-C04'),
    makeResult('SP8-C06', '8Sphere Dependence', 'Positive Dependence Coefficient', dependence, 'coefficient', 'clamp(0.90*sphere_coherence,0,0.95)', 'SP8-C05'),
    makeResult('SP8-C07', '8Sphere Bound', 'Comonotonic Upper Bound', weakest, 'probability', 'min(L01..L08)', ...legIDs),
    makeResult('SP8-C08', '8Sphere Dependence', 'Dependence-Adjusted Joint Probability', dependenceJoint, 'probability', 'exp((1-rho)*ln(P_ind)+rho*ln(P_upper))', 'SP8-C01', 'SP8-C06', 'SP8-C07'),
    makeResult('SP8-C09', '8Sphere Support', 'Projection Support Geometric Mean', projectionSupport, 'coefficient', 'geometric_mean(C11,C12,1-C13,C14,C16,C17,C15)', 'X8S-C11', 'X8S-C12', 'X8S-C13', 'X8S-C14', 'X8S-C15', 'X8S-C16', 'X8S-C17'),
    makeResult('SP8-C10', '8Sphere Support', 'Projection Support Multiplier', supportMultiplier, 'multiplier', 'clamp(0.80+0.25*projection_support,0.75,1.05)', 'SP8-C09'),
    makeResult('SP8-C11', '8Sphere Risk', 'Weakest-Anchor Drag', weakestDrag, 'coefficient', '1-min(L01..L08)', 'SP8-C07'),
    makeResult('SP8-C12', '8Sphere Risk', 'Dispersion and Weak-Leg Haircut', dispersionHaircut, 'multiplier', 'clamp(1-0.35*(dispersion/100)-0.25*weakest_drag,0.70,1)', 'X8S-C09', 'SP8-C11'),
    makeResult('SP8-C13', '8Sphere Projection', '8Sphere Adjusted Parlay Probability', adjusted, 'probability', 'min(P_upper,P_dependence*support_multiplier*risk_haircut)', 'SP8-C07', 'SP8-C08', 'SP8-C10', 'SP8-C12'),
    makeResult('SP8-C14', '8Sphere Projection', 'Effective Coupled Leg Count', effectiveLegs, 'legs', 'ln(P_adjusted)/ln(geometric_core)', 'SP8-C02', 'SP8-C13'),
    makeResult('SP8-C15', '8Sphere Decision', 'Joint Stability Index', jointStability, 'index_points', 'weighted(weakest,dispersion,boundary,resilience,admission,confidence,centroid,norm)', 'SP8-C07', 'X8S-C09', 'X8S-C07', 'X8S-C05', 'X8S-A08', 'X8S-C15', 'X8S-C03', 'X8S-C01'),
    makeResult('SP8-C16', '8Sphere Decision', '8Sphere Decision Confidence', decisionConfidence, 'index_points', 'weighted(source_confidence,evidence,admission,boundary,coherence,stability,class)', 'X8S-C15', 'X8S-C08', 'X8S-A08', 'X8S-C07', 'SP8-C05', 'SP8-C15', 'X8S-C17'),
    makeResult('SP8-C17', '8Sphere Decision', '8Sphere Classification Code', classCode, 'code', '0 denied; 1 fragile; 2 contested; 3 stable; 4 sphere convergence', 'SP8-C13', 'SP8-C15', 'SP8-C16'),
    makeResult('SP8-C18', '8Sphere Decision', '8Sphere Parlay Admission Code', admissionCode, 'code', '1 iff X8S admitted and adjusted probability/confidence floors pass', 'X8S-C18', 'SP8-C13', 'SP8-C16'));
  return [rows, { total, pass: 0, qualified: rows.length, fail: 0, blocked: 0 }, { calibration_id: 'HK001-8SPHERE-PARLAY-v1', input_authority: 'EXTRAPOLATION_OUTPUT_ONLY', source_model_count: X8S_IDS.length, leg_count: legCount, composite_count: compositeCount,
    raw_independence_probability: roundN(raw, 12), sphere_geometric_core: roundN(geometricCore, 12), sphere_coherence: roundN(sphereCoherence, 12), dependence_coefficient: roundN(dependence, 12), adjusted_parlay_probability: roundN(adjusted, 12),
    effective_leg_count: roundN(effectiveLegs, 12), joint_stability: roundN(jointStability, 12), decision_confidence: roundN(decisionConfidence, 12), decision_class: decisionClass, admission }];
}

/* ------------------------------------------------------------------ Go encoding/json (canonical receipt bytes) */
/* json.Marshal's string encoding (Go 1.22 and later, HTML-safe): \b \f \n \r \t, \u00XX for the other control
   characters and for < > &, \u2028 and \u2029, and the six characters \ufffd for a byte that is not UTF-8. The input
   adapter carries such a byte as a lone surrogate U+DC80..U+DCFF; the character U+FFFD itself is written as it is. */
function goString(s) {
  let o = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '"') o += '\\"'; else if (ch === '\\') o += '\\\\';
    else if (c === 0x0a) o += '\\n'; else if (c === 0x0d) o += '\\r'; else if (c === 0x09) o += '\\t'; else if (c === 0x08) o += '\\b'; else if (c === 0x0c) o += '\\f';
    else if (c < 0x20 || ch === '<' || ch === '>' || ch === '&' || c === 0x2028 || c === 0x2029) o += '\\u' + c.toString(16).padStart(4, '0');
    else if (c >= 0xd800 && c <= 0xdfff) o += '\\ufffd';
    else o += ch;
  }
  return o + '"';
}
function goNumber(x) {
  if (!Number.isFinite(x)) throw new Error('json: unsupported value: ' + (Number.isNaN(x) ? 'NaN' : x > 0 ? '+Inf' : '-Inf'));     // UnsupportedValueError, with FormatFloat's spelling
  if (Object.is(x, -0)) return '-0';
  return String(x);           // Go: "Convert as if by ES6 number to string conversion" (cutoffs 1e-6 / 1e21)
}
/* A Go map is marshalled with its keys sorted bytewise. A JavaScript object cannot hold that order: it lists a key
   that looks like an array index ("9", "10") before every other key, whatever was inserted first, and a field may
   be called "10". So a map is marked (goMap) and its keys are sorted when it is written, not when it is built. */
const GO_MAP = Symbol('go map');
const keysOf = (v) => (v[GO_MAP] ? Object.keys(v).sort(byUtf8) : Object.keys(v));
/** Serialise like json.Marshal: objects keep their (Go struct) key order; plain maps must be passed through goMap(). */
function goJSON(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return goNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return goString(v);
  if (Array.isArray(v)) return '[' + v.map(goJSON).join(',') + ']';
  return '{' + keysOf(v).map((k) => goString(k) + ':' + goJSON(v[k])).join(',') + '}';
}
/** Go marshals map[string]T with keys sorted bytewise; a plain object built in sorted order serialises identically. */
/* bytewise UTF-8 order = code-point order; it differs from UTF-16 order only between an astral character and U+E000..U+FFFF.
   A key that carries a byte which is not UTF-8 (a lone surrogate U+DC80..U+DCFF, see the adapter) sorts by that byte. */
const CARRIED = /[\udc80-\udcff]/u;
function goBytes(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0xdc80 && c <= 0xdcff) out.push(c - 0xdc00);
    else if (c < 0x80) out.push(c); else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function byUtf8(a, b) {
  if (CARRIED.test(a) || CARRIED.test(b)) {
    const x = goBytes(a), y = goBytes(b); const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  }
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a.charCodeAt(i), y = b.charCodeAt(i); if (x === y) continue; const sx = x >= 0xd800 && x <= 0xdfff, sy = y >= 0xd800 && y <= 0xdfff; return sx === sy ? x - y : sx ? 1 : -1; }
  return a.length - b.length;
}
const goMap = (m) => { const o = Object.create(null); for (const k of Object.keys(m).sort(byUtf8)) o[k] = m[k]; Object.defineProperty(o, GO_MAP, { value: true }); return o; };

function requestJSONView(r) {
  const o = { schema: r.schema, product_id: r.product_id, case_id: r.case_id, description: r.description, input_mode: r.input_mode, synthetic_fixture: !!r.synthetic_fixture, values: goMap(r.values) };
  if (r.calibration && Object.keys(r.calibration).length) o.calibration = goMap(r.calibration);
  return o;
}
function provenance(r) {
  const p = r._prov || {};
  const o = { source_name: p.source_name || '', source_format: p.source_format || '', source_sha256: p.source_sha256 || '', parser_profile: p.parser_profile || '', record_index: p.record_index | 0, record_count: p.record_count | 0, input_mode: r.input_mode };
  if (p.defaulted_fields && p.defaulted_fields.length) o.defaulted_fields = p.defaulted_fields;
  return o;
}

/* ------------------------------------------------------------------ Analyze */
function analyze(request, opts = {}) {
  TR = opts.trace ? {} : null;
  try { return analyzeInner(request, opts); } finally { TR = null; }
}
function analyzeInner(request, opts) {
  const r = applyBaselineOverlay(request);
  const reasons = validate(r);
  const mandatory = reasons.length === 0;
  const [conv, cs] = evaluateConventional(r.values);
  const [coupled, ms, master] = evaluateMaster(r, mandatory && cs.fail === 0);
  const [ext, es, exts] = evaluateExtrapolator(coupled, master);
  const [par, ps, pars] = evaluateSphereParlay(ext, exts);
  let disp = 'PASS';
  if (!mandatory || cs.fail > 0 || ms.fail > 0 || es.fail > 0 || ps.fail > 0) disp = 'FAIL';
  else if (r.synthetic_fixture || cs.qualified > 0 || ms.qualified > 0 || es.qualified > 0 || ps.qualified > 0) disp = 'QUALIFIED';
  let summary = `${disp}. Hockey suite: ${cs.pass} PASS, ${cs.qualified} QUALIFIED, ${cs.fail} FAIL. Master Law: ${master.admission}; eta_ind ${goFixed(master.eta_ind, 6)} versus ${goFixed(master.epsilon_ind, 6)}; Delta_8S ${goFixed(master.delta_8s, 6)} versus ${goFixed(master.epsilon_gain, 6)}; matchup ${master.matchup_class}. Extrapolator: ${es.total} models; team-win probability ${goFixed(exts.extrapolated_win_probability, 4)}; class ${exts.decision_class}; admission ${exts.admission}. 8Sphere: adjusted joint ${goFixed(pars.adjusted_parlay_probability, 4)}; class ${pars.decision_class}; admission ${pars.admission}.`;
  if (reasons.length) summary += ' Mandatory input reasons: ' + reasons.join(', ') + '.';
  const receipt = {
    schema: 'hk001.hockey_equation_lab_receipt.mssl.v1', runtime_id: RUNTIME_ID, version: VERSION, input_provenance: provenance(r), request: requestJSONView(r),
    conventional_summary: cs, coupled_summary: ms, extrapolation_summary: exts, sphere_parlay_summary: pars,
    conventional_equations: conv, master_law_models: coupled, master_law_extrapolations: ext, sphere_parlay_extrapolations: par,
    master_law_summary: master, overall_disposition: disp, professor_summary: summary,
    product_boundary: 'Hockey equation research and synthetic Master Coupled Mechanics analysis only. No validated forecast, wagering, roster, medical, scouting, officiating, or employment decision authority.',
    canonical_sha256: ''
  };
  // Go's encoding/json refuses NaN/±Inf, so the Go CLI exits with "json: unsupported value: NaN" when a model value
  // is non-finite (e.g. a zero denominator in a small sample). The port does the same by default; with allowNaN the
  // receipt is returned WITHOUT a canonical hash and the non-finite paths are listed in receipt.unserializable.
  let canonical = null;
  try { canonical = goJSON(receipt); }
  catch (e) { if (!opts.allowNaN || !/unsupported value/.test(e.message)) throw e; }
  if (canonical !== null) receipt.canonical_sha256 = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  else Object.defineProperty(receipt, 'unserializable', { value: nonFinitePaths(receipt), enumerable: false });
  Object.defineProperty(receipt, 'reasons', { value: reasons, enumerable: false });
  if (opts.trace) Object.defineProperty(receipt, 'trace', { value: TR, enumerable: false });
  Object.defineProperty(receipt, 'normalizedRequest', { value: r, enumerable: false });
  return receipt;
}
function nonFinitePaths(o, p = '$', out = []) {
  if (typeof o === 'number') { if (!Number.isFinite(o)) out.push(p); }
  else if (o && typeof o === 'object') for (const k of Object.keys(o)) nonFinitePaths(o[k], Array.isArray(o) ? `${p}[${k}]` : `${p}.${k}`, out);
  return out;
}
/** Pretty JSON exactly like Go's json.MarshalIndent(v, "", "  ") for the receipt shape. */
function prettyJSON(receipt) {
  const ind = (n) => '  '.repeat(n);
  const enc = (v, d) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return goNumber(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return goString(v);
    if (Array.isArray(v)) return v.length ? '[\n' + v.map((x) => ind(d + 1) + enc(x, d + 1)).join(',\n') + '\n' + ind(d) + ']' : '[]';
    const entries = keysOf(v).map((k) => [k, v[k]]);
    return entries.length ? '{\n' + entries.map(([k, x]) => ind(d + 1) + goString(k) + ': ' + enc(x, d + 1)).join(',\n') + '\n' + ind(d) + '}' : '{}';
  };
  return enc(receipt, 0);
}

const equationInventory = () => SPECS.map((s) => ({ ...s }));
module.exports = { VERSION, RUNTIME_ID, BASELINE, baselineValues, defaultRequest, applyBaselineOverlay, validate, analyze, evaluateConventionalByID, equationInventory, goJSON, prettyJSON, MASTER_IDS, X8S_IDS };
