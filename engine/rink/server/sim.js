'use strict';
/**
 * Synthetic game simulator. It types games the way an operator does — real command lines (LINE, T/GO/STOP/
 * NEXT/END, tri-token events, assists) through the same lexer → 64-byte frame → actor path as the terminal — on
 * a synthetic wall clock, so every downstream number (box scores, stints, xG, RAPM, GSAx, the 109 HK001
 * inputs) is produced by the production code. Players carry a hidden "true" offence/defence effect
 * (xGF/60 and xGA/60 prevented), which lets tests check that RAPM recovers the direction of the truth.
 * Everything here is fictional demonstration data.
 */
const XG = require('../shared/xg');
const hash = require('../shared/hash');
const OT = require('./overtime');

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const NS = 1000000000n;
/** deterministic per-player hidden effects, from the player's uuid */
function talent(pid) {
  const h = hash.sha256(`RINKVT-SIM-TALENT:${pid}`); const u = (i) => ((h[i] << 8) | h[i + 1]) / 65536;
  const n = (a, b) => Math.sqrt(-2 * Math.log(Math.max(1e-9, u(a)))) * Math.cos(2 * Math.PI * u(b));
  return { off: 0.45 * n(0, 2), def: 0.40 * n(4, 6), finish: 1 + 0.15 * n(8, 10), save: 0.012 * n(12, 14) };
}

/**
 * @param {object} o
 * @param {object} o.game       registry game
 * @param {object} o.registry
 * @param {(line:string, onsetNs:bigint)=>object} o.type   types one line; returns { results: [...] }
 * @param {()=>object} o.state  current actor state (to respect the penalty box)
 * @param {number} o.seed
 * @param {bigint} [o.startNs]
 */
function simulateGame({ game, registry, type, state, seed = 1, startNs = 1767225600n * NS, shifts = true, detail = true }) {
  const r = rng(seed ^ game.idHash);
  const H = game.home, A = game.away;
  const ros = { [H]: registry.roster(H), [A]: registry.roster(A) };
  const T = new Map(); for (const t of [H, A]) for (const p of ros[t]) T.set(p.pid, talent(p.pid));
  const byPos = (t, pos) => ros[t].filter((p) => p.pos === pos);
  const lines = {}; const pairs = {}; const goalie = {};
  for (const t of [H, A]) {
    const C = byPos(t, 'C'), L = byPos(t, 'LW'), R = byPos(t, 'RW'), D = byPos(t, 'D');
    lines[t] = [0, 1, 2, 3].map((i) => [C[i % C.length], L[i % L.length], R[i % R.length]].filter(Boolean));
    pairs[t] = [0, 1, 2].map((i) => [D[(2 * i) % D.length], D[(2 * i + 1) % D.length]].filter(Boolean));
    goalie[t] = registry.player(game.starters[t]) || byPos(t, 'G')[0];
  }
  const rules = OT.block(game);                         // the game's overtime rules (its league's, or the built-in ones)
  let wall = startNs; let runFromWall = null, runFromEl = 0, periodLen = 1200, period = 1, elInPeriod = 0;
  const log = { lines: 0, rejected: [], goals: { [H]: 0, [A]: 0 } };
  const out = (line, onset) => {
    const res = type(line, onset !== undefined ? onset : wall);
    log.lines++;
    for (const x of res.results || []) if (x.status === 'REJECTED') log.rejected.push(`${line} → ${x.error}`);
    return res;
  };
  const say = (line, gap = 1.2) => { out(line); wall += BigInt(Math.round(gap * 1e9)); };
  // onset that latches exactly at in-period elapsed e while the clock runs
  const onsetAt = (e) => runFromWall + BigInt(Math.round((e - runFromEl) * 1e9));
  const go = () => { out(game.start === 'frame' && !state().started ? 'START' : 'GO'); runFromWall = wall + 600000000n; runFromEl = elInPeriod; wall = runFromWall + 200000000n; };
  const stopAt = (e) => { out('WHISTLE', onsetAt(e) - 600000000n); elInPeriod = e; wall = onsetAt(e) + BigInt(Math.round((12 + 25 * r()) * 1e9)); runFromWall = null; };
  const at = (e, line) => { if (runFromWall === null) { out(line, wall); wall += 1000000000n; } else out(line, onsetAt(e)); };
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const s0 = () => state();
  const free = (t, list) => { const s = s0(); return list.filter((p) => p && !s.box.has(p.pid)); };
  let li = { [H]: 0, [A]: 0 }, pi = { [H]: 0, [A]: 0 };
  const onIce = { [H]: [], [A]: [] };
  const situation = () => { const s = s0(); const n = (t) => s.penalties.filter((p) => p.team === t && p.active && !p.done && p.strength).length; return { [H]: n(H), [A]: n(A) }; };
  function change(t, e, extraAttacker = false) {
    const pen = situation();
    const fwd = lines[t][li[t] % 4], d = pairs[t][pi[t] % 3];
    li[t]++; if (r() < 0.6) pi[t]++;
    let skaters = [...free(t, fwd), ...free(t, d)];
    const pool = free(t, [...lines[t].flat(), ...pairs[t].flat()]).filter((p) => !skaters.includes(p));
    const want = (OT.overtimeSkaters(rules, period) || 5) - Math.min(2, pen[t]) + (extraAttacker ? 1 : 0);   // overtime may be played 3 or 4 a side
    while (skaters.length < want && pool.length) skaters.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
    skaters = skaters.slice(0, Math.max(1, want));
    onIce[t] = skaters;
    if (shifts) at(e, `LINE ${t} ${skaters.map((p) => p.code).join(' ')}`);
  }
  function faceoff(e, zoneFor) {
    const t = r() < 0.5 ? H : A; const c = onIce[t].find((p) => p.pos === 'C') || onIce[t][0]; if (!c) return;
    const z = zoneFor ? (zoneFor === t ? 'O' : 'D') : 'N';
    at(e, `${t} ${c.code} ${r() < 0.5 ? 'FOW' : 'FOL'}/${z}`);
  }
  function location() {        // mean spec-model xG ≈ 0.07 per unblocked attempt
    const u = r();
    if (u < 0.45) return [45 + r() * 17, (r() < 0.5 ? -1 : 1) * (4 + r() * 32), 'S'];   // point
    if (u < 0.80) return [60 + r() * 16, (r() < 0.5 ? -1 : 1) * (14 + r() * 22), 'W']; // circles / perimeter
    if (u < 0.97) return [68 + r() * 12, (r() - 0.5) * 20, 'P'];                        // slot
    return [80 + r() * 7, (r() - 0.5) * 10, r() < 0.5 ? 'T' : 'B'];                     // net front
  }
  const rate = (t) => {           // attempts per second for team t from the on-ice hidden effects
    const o = t === H ? A : H; const pen = situation();
    let x = 0; for (const p of onIce[t]) x += T.get(p.pid).off; for (const p of onIce[o]) x -= T.get(p.pid).def;
    const pp = pen[o] > pen[t] ? 1.9 : pen[t] > pen[o] ? 0.45 : 1;
    return (60 / 3600) * Math.exp(x / 2.2) * pp * (t === H ? 1.03 : 1);
  };
  let lastAtt = null;
  function attempt(t, e) {
    const o = t === H ? A : H; const shooter = pick(onIce[t].length ? onIce[t] : free(t, lines[t][0]));
    if (!shooter) return;
    let [x, y, type] = location();
    const reb = lastAtt && lastAtt.team === t && e - lastAtt.e <= 2.5 && r() < 0.7;
    if (reb) { x = 80 + r() * 7; y = (r() - 0.5) * 10; }
    x = Math.round(x * 10) / 10; y = Math.round(y * 10) / 10;
    const u = r();
    if (u < 0.24 && !reb) {                                         // blocked by a defender
      const bl = pick(onIce[o].filter((p) => p.pos === 'D').length ? onIce[o].filter((p) => p.pos === 'D') : onIce[o]); if (!bl) return;
      at(e, `${o} ${bl.code} B/${x},${y}`); lastAtt = null; return;
    }
    const str = `${onIce[t].length}v${onIce[o].length}`;
    const m = XG.xg({ x, y, shotType: { W: 'WRIST', S: 'SLAP', P: 'SNAP', T: 'TIP', B: 'BACKHAND' }[type], rebound: !!reb, rush: false, royal: false, strength: str });
    const gk = goalie[o] && s0().goalie[o] ? T.get(goalie[o].pid).save : 0;
    // P(goal | unblocked) = 0.9 × xG on average (synthetic goaltending slightly better than the uncalibrated spec model)
    const miss = r() < 0.27;
    const pGoal = Math.max(0.002, Math.min(0.85, (0.9 * m.xg / 0.73) * T.get(shooter.pid).finish - gk));
    if (!miss && r() < pGoal) {
      at(e, `${t} ${shooter.code} G/${type}/${x},${y}`); log.goals[t]++;
      if (!s0().result) stopAt(e + 0.3);                     // an overtime goal ends the game by itself
      else { wall = onsetAt(e) + 2000000000n; runFromWall = null; }
      const mates = onIce[t].filter((p) => p !== shooter);
      if (mates.length && r() < 0.9) {
        const a1 = pick(mates); say(`${t} ${a1.code} A`, 1.5);
        const rest = mates.filter((p) => p !== a1); if (rest.length && r() < 0.7) say(`${t} ${pick(rest).code} A`, 1.5);
      }
      lastAtt = null; return 'goal';
    }
    at(e, `${t} ${shooter.code} ${miss ? 'M' : 'S'}/${type}/${x},${y}`);
    lastAtt = { team: t, e };
    if (!miss && r() < 0.32) { stopAt(e + 0.5); return 'frozen'; }   // goalie covers
    return null;
  }
  function minor(t, e) {
    const p = pick(onIce[t]); if (!p) return;
    at(e, `${t} ${p.code} P2/${pick(['TRP', 'HOK', 'SLH', 'INT', 'HLD', 'RGH', 'CC'])}`);
    stopAt(e + 0.4);
  }
  function micro(t, e) {         // non-shot detail events
    const p = pick(onIce[t]); if (!p) return;
    const u = r();
    if (u < 0.28) at(e, `${t} ${p.code} ZE/${pick(['C', 'C', 'D', 'F'])}`);
    else if (u < 0.48) at(e, `${t} ${p.code} ZX/${pick(['C', 'D', 'D', 'F'])}`);
    else if (u < 0.66) at(e, `${t} ${p.code} H`);
    else if (u < 0.76) at(e, `${t} ${p.code} TK`);
    else if (u < 0.86) at(e, `${t} ${p.code} GV`);
    else if (u < 0.94) at(e, `${t} ${p.code} FC`);
    else at(e, `${t} ${p.code} OMR`);
  }
  // ------------------------------------------------------------------ the game
  const playPeriod = (p, len) => {
    period = p; periodLen = len; elInPeriod = 0;
    say(`T ${Math.floor(len / 60)}:${String(len % 60).padStart(2, '0')} ${p <= 3 ? 'P' + p : p === 4 ? 'OT' : 'OT' + (p - 3)}`);
    change(H, 0); change(A, 0); faceoff(0, null); go();
    let e = 0, nextChange = { [H]: 35 + r() * 20, [A]: 35 + r() * 20 };
    for (;;) {
      e += 1;
      if (e >= len) break;
      const late = p === 3 && len - e < 110 && !onIce.pulled;
      const diff = s0().teams[H].score - s0().teams[A].score;
      if (late && Math.abs(diff) >= 1 && Math.abs(diff) <= 2 && r() < 0.05) {     // pull the goalie
        const t = diff < 0 ? H : A; onIce.pulled = t; at(e, `${t} ${goalie[t].code} OUT`); change(t, e, true);
      }
      for (const t of [H, A]) if (e >= nextChange[t]) { change(t, e, onIce.pulled === t); nextChange[t] = e + 38 + r() * 18; }
      let stop = null;
      for (const t of [H, A]) {
        if (stop) break;
        if (r() < rate(t)) stop = attempt(t, e) || null;
        else if (detail && r() < 0.020) micro(t, e);
        else if (r() < 0.00048 * (p === 4 ? 0 : 1) && onIce[t].length >= 4) { minor(t, e); stop = 'penalty'; }
      }
      if (stop === 'goal' && s0().result) return 'decided';               // sudden death: an overtime goal ends the game
      if (stop) {
        // the clock is stopped: goalie back in if no longer needed, change lines, face off, restart
        e = elInPeriod;
        // the whistle came at the buzzer: nothing to restart. The engine's clock decides. The seconds here are
        // floating point and can add up to a hair under the period (1199.7 + 0.3 has come out as 1199.9999999999998)
        // when the clock, which counts tenths, already shows 0:00; a face-off and GO typed then would be refused.
        if (e >= len || s0().clock.remainingDs <= 0) break;
        if (onIce.pulled) { const t = onIce.pulled, d = (s0().teams[t].score - s0().teams[t === H ? A : H].score); if (d >= 0 || d < -2) { at(e, `${t} ${goalie[t].code} IN`); onIce.pulled = null; } }
        for (const t of [H, A]) { change(t, e, onIce.pulled === t); nextChange[t] = e + 38 + r() * 18; }
        faceoff(e, stop === 'goal' ? null : stop === 'frozen' ? (s0().events.slice(-1)[0] || {}).team : null);
        go();
      } else if (r() < 0.0055 && e < len - 1) { stopAt(e); for (const t of [H, A]) change(t, e, onIce.pulled === t); faceoff(e, pick([H, A, null])); go(); }
    }
    if (runFromWall !== null) { wall = onsetAt(len) + 5000000000n; runFromWall = null; }
    if (onIce.pulled) { const t = onIce.pulled; onIce.pulled = null; at(len, `${t} ${goalie[t].code} IN`); }
    return 'played';
  };
  for (const p of [1, 2, 3]) { playPeriod(p, 1200); if (p < 3) { wall += 1000n * NS; say('NEXT'); } }
  wall += 60n * NS;
  const tied = () => s0().teams[H].score === s0().teams[A].score;
  if (!tied() || OT.tieStandsAfter(rules, 3)) { say('NEXT'); }        // decided in regulation, or a tie stands: NEXT at the P3 buzzer finalises
  else {
    say('NEXT'); onIce.pulled = null;                                // into overtime, or (no overtime) straight to the shootout
    if (!rules.repeat) {
      const res = rules.ot ? playPeriod(4, rules.ot) : 'played';
      if (res !== 'decided' && !rules.so) { wall += 60n * NS; say('NEXT'); }   // the overtime ends level and a tie stands
      else if (res !== 'decided') {
        if (rules.ot) { wall += 120n * NS; say('NEXT'); }           // into the shootout
        const shooters = { [H]: lines[H].flat().slice(0, 6), [A]: lines[A].flat().slice(0, 6) };
        let k = 0; const so = { [H]: 0, [A]: 0 };
        while (k < 20 && !s0().result) {
          for (const t of [H, A]) {
            if (s0().result) break;
            const sh = shooters[t][k % shooters[t].length]; const sc = r() < 0.33;
            say(`${t} ${sh.code} ${sc ? 'G' : 'S'}/W/80,0`, 20); if (sc) so[t]++;
          }
          k++;
        }
        if (!s0().result) say('END');
      }
    } else {
      for (let ot = 4; ot < 12 && !s0().result; ot++) { const res = playPeriod(ot, rules.ot); if (res === 'decided') break; say('NEXT'); }
    }
  }
  const s = s0();
  return { lines: log.lines, rejected: log.rejected, result: s.result, score: { [H]: s.teams[H].score, [A]: s.teams[A].score }, events: s.events.length, stints: s.stints.length, endNs: wall };
}

/** A round-robin schedule over the registry's teams. */
function schedule(teams, rounds = 2) {
  const out = [];
  for (let r = 0; r < rounds; r++) for (let i = 0; i < teams.length; i++) for (let j = 0; j < teams.length; j++) if (i !== j && ((r % 2 === 0) === (i < j))) out.push([teams[i], teams[j]]);
  return out;
}
module.exports = { simulateGame, schedule, talent, rng };
