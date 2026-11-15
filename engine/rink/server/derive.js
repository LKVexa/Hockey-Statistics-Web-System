'use strict';
/**
 * Per-game, per-team facts derived from an actor's effective event fold — the one place where the 109 HK001
 * input definitions (rink/hk001/inputs.js, `rink` column) are turned into numbers. Both the HK001 bridge and the
 * Q engine read these, so a value shown by `Q` and the value HK001 receives are the same number.
 */
const { elapsedOf } = require('./actor');

const ATT = new Set(['S', 'G', 'M']);
const PEN = new Set(['P2', 'P4', 'P5', 'P10', 'P20']);
const RET_S = 5.0, ENTRY_SHOT_S = 10.0;

/** Running score before each event (team perspective helper). */
function withScore(events, home, away) {
  let h = 0, a = 0; const out = [];
  for (const e of events) {
    out.push({ e, h, a });
    if (e.stat === 'G' && e.situation !== 'SO') { if (e.team === home) h++; else if (e.team === away) a++; }
  }
  return out;
}
const scoreDiff = (row, team, home) => (team === home ? row.h - row.a : row.a - row.h);

function gameElapsed(game, s) { return elapsedOf(game, s.clock.period, s.clock.remainingDs); }

/**
 * Facts for team T in one game. Counts are plain numbers; `seen` records which token families occurred at all
 * (for either team) so the bridge can tell "zero" from "never tracked".
 */
function teamGame(game, s, T, opts = {}) {
  const home = game.home, away = game.away, O = T === home ? away : home, isHome = T === home;
  const evs = s.events.filter((e) => !e.void);
  const rows = withScore(evs, home, away);
  const f = {}; const z = (k) => { f[k] = 0; };
  ['G', 'GA', 'A', 'SOG', 'SAT', 'USAT', 'MISSED', 'BLOCKED_FOR', 'HDCF', 'SCF', 'PRIMARY_A', 'SECONDARY_A', 'EV_G', 'PPG', 'SHG', 'ENG', 'REBOUNDS_FOR', 'RUSH_ATTEMPTS',
    'TAKEAWAYS', 'GIVEAWAYS', 'OZ_STARTS', 'DZ_STARTS', 'CA', 'FA', 'SA', 'xGF', 'xGA', 'HDCA', 'SCA', 'CLOSE_CF', 'CLOSE_CA', 'EV_TOI', 'TEAM_TOI', 'BLOCKS',
    'ODD_MAN_RUSH_FOR', 'ODD_MAN_RUSH_AGAINST', 'EXITS', 'EXIT_ATTEMPTS', 'CONTROLLED_EXITS', 'PK_SA', 'PK_MIN', 'REBOUNDS_AGAINST', 'SV', 'SA_G', 'GA_G', 'MIN_G', 'xGA_G',
    'HDSV', 'HDSA', 'MDSV', 'MDSA', 'LDSV', 'LDSA', 'QS', 'GS', 'RBS', 'REBOUNDS_ALLOWED_GOALIE', 'SO', 'CONTROLLED_ENTRIES', 'ENTRIES', 'ENTRY_ATTEMPTS', 'RETAINED_ENTRIES',
    'FORECHECK_ATTEMPTS', 'TURNOVER_TRANSITIONS', 'ENTRY_SHOTS', 'POINTS', 'W', 'RW', 'PP_OPP', 'PPGA', 'PK_OPP', 'FO_WON', 'FO_TAKEN', 'PEN_DRAWN', 'PEN_TAKEN', 'HOME_G',
    'COMEBACK_WINS', 'ONE_GOAL_WINS', 'FIRST_PERIOD_G', 'SECOND_PERIOD_G', 'THIRD_PERIOD_G', 'OT_WINS', 'SO_WINS', 'OT_GAMES', 'SO_GAMES', 'ONE_GOAL_GAMES',
    'PP_MIN', 'GP'].forEach(z);
  const seen = new Set();
  const scoreAtt = [];                                   // [{team, d}] for score-adjusted Corsi (league pool)
  const lastAtt = { [T]: null, [O]: null };
  for (let i = 0; i < rows.length; i++) {
    const { e } = rows[i]; seen.add(e.stat); if (e.entry) seen.add(e.stat + '/' + e.entry);
    if (e.situation === 'SO') continue;
    const mine = e.team === T, d = scoreDiff(rows[i], e.team, home);
    const close = (e.period <= 2 && Math.abs(d) <= 1) || (e.period >= 3 && d === 0);
    if (ATT.has(e.stat)) {
      if (e.coordSource && e.coordSource !== 'prior') seen.add('LOC');
      if (e.goalie) seen.add('GOALIE');
      scoreAtt.push({ team: e.team, d });
      if (mine) {
        f.USAT++; f.SAT++; f.xGF += e.xgF; if (e.stat !== 'M') f.SOG++; else f.MISSED++;
        if (e.danger === 'HIGH') f.HDCF++; if (e.danger === 'HIGH' || e.danger === 'MEDIUM') f.SCF++;
        if (e.rebound) f.REBOUNDS_FOR++; if (e.rush) f.RUSH_ATTEMPTS++;
        if (close) f.CLOSE_CF++;
      } else {
        f.FA++; f.CA++; f.xGA += e.xgF; if (e.stat !== 'M') f.SA++;
        if (e.danger === 'HIGH') f.HDCA++; if (e.danger === 'HIGH' || e.danger === 'MEDIUM') f.SCA++;
        if (e.rebound) { f.REBOUNDS_AGAINST++; const prev = lastAtt[O]; if (prev && prev.stat === 'S') f.REBOUNDS_ALLOWED_GOALIE++; }
        if (close) f.CLOSE_CA++;
        if (e.situation === 'PP' && e.stat !== 'M') f.PK_SA++;
        if (e.goalie) {
          f.xGA_G += e.xgF;
          if (e.stat !== 'M') { f.SA_G++; if (e.stat === 'G') f.GA_G++; else f.SV++; const k = e.danger === 'HIGH' ? 'HD' : e.danger === 'MEDIUM' ? 'MD' : e.danger === 'LOW' ? 'LD' : null; if (k) { f[k + 'SA']++; if (e.stat !== 'G') f[k + 'SV']++; } }
        }
      }
      lastAtt[e.team] = e;
      if (e.stat === 'G') {
        if (mine) {
          f.G++; f.A += e.assists.filter(Boolean).length; if (e.assists[0]) f.PRIMARY_A++; if (e.assists[1]) f.SECONDARY_A++;
          if (e.situation === 'EV') f.EV_G++; else if (e.situation === 'PP') f.PPG++; else if (e.situation === 'SH') f.SHG++;
          if (e.emptyNet) f.ENG++; if (isHome) f.HOME_G++;
          if (e.period === 1) f.FIRST_PERIOD_G++; else if (e.period === 2) f.SECOND_PERIOD_G++; else if (e.period === 3) f.THIRD_PERIOD_G++;
        } else { f.GA++; if (e.situation === 'PP') f.PPGA++; }
      }
    } else if (e.stat === 'B') {
      // B is logged by the blocking team: it is an attempt by the other team
      scoreAtt.push({ team: e.opp, d: -d });
      if (mine) { f.BLOCKS++; f.CA++; if ((e.period <= 2 && Math.abs(d) <= 1) || (e.period >= 3 && d === 0)) f.CLOSE_CA++; }
      else { f.BLOCKED_FOR++; f.SAT++; if ((e.period <= 2 && Math.abs(d) <= 1) || (e.period >= 3 && d === 0)) f.CLOSE_CF++; }
    } else if (e.stat === 'FOW' || e.stat === 'FOL') {
      f.FO_TAKEN++;
      if ((e.stat === 'FOW' && mine) || (e.stat === 'FOL' && !mine)) f.FO_WON++;
      const zoneForT = mine ? e.zone : (e.zone === 'O' ? 'D' : e.zone === 'D' ? 'O' : 'N');
      if (zoneForT === 'O') f.OZ_STARTS++; else if (zoneForT === 'D') f.DZ_STARTS++;
    } else if (PEN.has(e.stat)) { if (mine) f.PEN_TAKEN++; else f.PEN_DRAWN++; }
    else if (mine) {
      if (e.stat === 'TK') f.TAKEAWAYS++; else if (e.stat === 'GV') f.GIVEAWAYS++; else if (e.stat === 'FC') f.FORECHECK_ATTEMPTS++;
      else if (e.stat === 'OMR') f.ODD_MAN_RUSH_FOR++;
      else if (e.stat === 'ZX') { f.EXIT_ATTEMPTS++; if (e.entry !== 'F') f.EXITS++; if (e.entry === 'C') f.CONTROLLED_EXITS++; if (e.entry === 'F') f.TURNOVER_TRANSITIONS++; }
      else if (e.stat === 'ZE') {
        f.ENTRY_ATTEMPTS++; if (e.entry !== 'F') f.ENTRIES++; if (e.entry === 'C') f.CONTROLLED_ENTRIES++; if (e.entry === 'F') f.TURNOVER_TRANSITIONS++;
        if (e.entry !== 'F') {
          let lost = false, shot = false;
          for (let j = i + 1; j < rows.length; j++) {
            const n = rows[j].e; if (n.period !== e.period) break; const dt = n.elapsed - e.elapsed; if (dt > ENTRY_SHOT_S) break;
            if (dt <= RET_S && ((n.team === T && n.stat === 'GV') || (n.team === O && n.stat === 'TK'))) lost = true;
            if (n.team === T && ATT.has(n.stat)) shot = true;
          }
          if (e.entry === 'C' && !lost) f.RETAINED_ENTRIES++;
          if (shot) f.ENTRY_SHOTS++;
        }
      }
    } else if (e.stat === 'OMR') f.ODD_MAN_RUSH_AGAINST++;
    // a team GV within 5 s after one of its own successful ZE/ZX is a turnover transition
    if (mine && e.stat === 'GV') {
      for (let j = i - 1; j >= 0; j--) { const p = rows[j].e; if (p.period !== e.period || e.elapsed - p.elapsed > RET_S) break; if (p.team === T && (p.stat === 'ZE' || p.stat === 'ZX') && p.entry !== 'F') { f.TURNOVER_TRANSITIONS++; break; } }
    }
  }
  // stints (home perspective): situation minutes, PP/PK opportunities, goalie minutes
  let prevSit = null;
  for (const t of s.stints) {
    const dur = t.endEl - t.startEl; const sit = isHome ? t.homeSit : t.awaySit;
    if (sit === 'EV') f.EV_TOI += dur / 60; else if (sit === 'SH') f.PK_MIN += dur / 60; else if (sit === 'PP') f.PP_MIN += dur / 60;
    if (sit !== prevSit) { if (sit === 'PP') f.PP_OPP++; else if (sit === 'SH') f.PK_OPP++; }
    prevSit = sit;
    if (isHome ? t.homeGoalie : t.awayGoalie) f.MIN_G += dur / 60;
  }
  f.TEAM_TOI = gameElapsed(game, s) / 60;
  f.GP = evs.length ? 1 : 0;
  // starting goalie line
  const starter = (game.starters || {})[T] || null;
  if (starter) {
    f.GS = 1;
    let sa = 0, ga = 0; for (const e of evs) if (e.team === O && ATT.has(e.stat) && e.stat !== 'M' && e.goalie === starter && e.situation !== 'SO') { sa++; if (e.stat === 'G') ga++; }
    f._starter = { pid: starter, sa, ga };
  }
  // result
  const r = s.result;
  if (r && r.decidedIn === 'TIE') f.POINTS = 1;            // a tie stands (the league's overtime rules, or END while level): a point each
  if (r && r.decidedIn !== 'TIE') {
    const won = r.winner === T;
    if (won) { f.W = 1; f.POINTS = 2; if (r.decidedIn === 'REG') f.RW = 1; if (r.decidedIn === 'OT') f.OT_WINS = 1; if (r.decidedIn === 'SO') f.SO_WINS = 1; if (r.comeback) f.COMEBACK_WINS = 1; if (r.margin === 1) f.ONE_GOAL_WINS = 1; }
    else if (r.decidedIn === 'OT' || r.decidedIn === 'SO') f.POINTS = 1;
    if (r.decidedIn === 'OT') f.OT_GAMES = 1; if (r.decidedIn === 'SO') f.SO_GAMES = 1; if (r.margin === 1) f.ONE_GOAL_GAMES = 1;
    if (starter && f._starter.ga === 0) f.SO = 1;
  }
  f._final = !!r; f._seen = seen; f._scoreAtt = scoreAtt; f._opp = O; f._home = isHome;
  return f;
}

/* Facts are a pure function of the actor state, and the actor bumps state.version on every change, so they are
   computed once per (state, version, team) and shared by Q, the standings and the HK001 bridge. Read-only. */
const MEMO = new WeakMap();
function memoOf(s) { let m = MEMO.get(s); if (!m || m.version !== s.version) { m = { version: s.version, facts: new Map(), seen: null, shots: null }; MEMO.set(s, m); } return m; }
function teamGameCached(game, s, T) { const m = memoOf(s); let f = m.facts.get(T); if (!f) { f = teamGame(game, s, T); m.facts.set(T, f); } return f; }
/** Which token families were logged at all in this game (the bridge's "zero" vs "never tracked"). */
function seenTokens(s) {
  const m = memoOf(s);
  if (!m.seen) { const seen = new Set(); for (const e of s.events) { seen.add(e.stat); if (e.entry) seen.add(e.stat + '/' + e.entry); if (e.coordSource && e.coordSource !== 'prior' && ATT.has(e.stat)) seen.add('LOC'); if (e.goalie) seen.add('GOALIE'); } m.seen = seen; }
  return m.seen;
}
/** Per-team sums over unblocked attempts that Q XG reports (raw xG and the flurry discount). */
function shotSums(s) {
  const m = memoOf(s);
  if (!m.shots) { const out = {}; for (const e of s.events) if (ATT.has(e.stat) && e.situation !== 'SO') { const x = out[e.team] || (out[e.team] = { unblocked: 0, rawXG: 0, flurryDiscount: 0 }); x.unblocked++; x.rawXG += e.xg; x.flurryDiscount += e.xg - e.xgF; } m.shots = out; }
  return m.shots;
}

/** Player facts from the actor's box line (one game). */
function playerGame(s, pid) {
  const b = s.players.get(pid); if (!b) return null;
  return { gp: 1, g: b.g, a: b.a1 + b.a2, pts: b.g + b.a1 + b.a2, ixg: b.ixg, onGF: b.onGF, onGA: b.onGA, toi: b.toi / 60, sog: b.sog, shiftTracked: s.shiftTracked[b.team] };
}
module.exports = { teamGame, teamGameCached, seenTokens, shotSums, playerGame, withScore, gameElapsed, ATT, PEN };
