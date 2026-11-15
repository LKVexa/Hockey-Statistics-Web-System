'use strict';
/**
 * RINK-VT econometric models (spec §5.2–5.4) over the actors' stints and box lines.
 *
 * RAPM  The spec's Module B design, exactly: two observations per stint (home offence vs away defence, away
 *       offence vs home defence), y = 3600·Σx̃G / w, weights w = stint seconds, one offence and one defence column
 *       per skater, context columns [is_home, zone_off, zone_def, is_pp_expiry, score_lead, score_trail], y centred
 *       by its weighted mean, Λ = diag(λ_off I, λ_def I, 0) and θ̂ = (MᵀWM + Λ)⁻¹ (MᵀW y + Λ θ0).
 *       Solved matrix-free with Jacobi-preconditioned conjugate gradients; differential-tested against the spec's
 *       Python (scipy spsolve) in tests/rink. Two deliberate differences, both no-ops where the spec's solve is
 *       defined: context columns that never occur are dropped (spsolve is singular on an all-zero unpenalised
 *       column), and stints without both lineups are skipped.
 *       Priors (spec §5.2): θ0 = δ · prior-season RAPM with δ_off = 0.60, δ_def = 0.70. priorsOff/priorsDef take
 *       last season's published values (xGF/60 above average, xGA/60 prevented); defence is negated into
 *       coefficient space exactly as the output is negated out of it.
 * GSAx  raw Σ(x̃G − Y) over unblocked shots faced; Empirical Bayes (n/(n+κ))·raw + (κ/(n+κ))·n·μ_prior, κ = 1200.
 * GAR   EVO + EVD + PPO + SHD + Finishing + Penalties − Replacement; WAR = GAR / 6.1 goals per win (spec §5.4);
 *       age adjustment GAR − Σ α_m B_m(age) with a natural cubic spline over [5475, 9125] days.
 * NHLe  points per game × 82 × T_{L→NHL} × f(age days): T is the harmonic mean of the declared transition chains
 *       (each chain the product of its league-to-league factors) and f is a natural cubic interpolating spline
 *       through declared age multipliers.
 * Every constant not fixed by the spec is a declared, named assumption in CALIBRATION and is printed with results.
 */
const CALIBRATION = Object.freeze({
  id: 'RINKVT-SYNTH-v1',
  lambdaOff: 2500, lambdaDef: 3000,                 // spec Module B defaults
  priorDecayOff: 0.60, priorDecayDef: 0.70,         // spec §5.2
  gsaxKappa: 1200,                                  // spec §5.3
  gsaxPrior: -0.003,                                // declared: replacement-level μ_prior (goals saved per unblocked shot)
  goalsPerWin: 6.1,                                 // spec §5.4
  penaltyGoalCost: 0.15,                            // declared: goals conceded per minor taken
  replacementPer60: 0.10,                           // declared: replacement level, goals/60 below average
  ageDomainDays: [5475, 9125],                      // spec: ages 15–24 in days
  ageKnotsYears: [15.5, 17, 18.5, 20, 22],          // declared: regression-spline knots (years)
  nhleChains: [                                     // declared placeholders, NOT fitted values
    { via: 'CHL→NHL', factors: [0.30] },
    { via: 'CHL→AHL→NHL', factors: [0.48, 0.61] }
  ],
  nhleAgeMultipliers: [[15, 1.42], [16, 1.30], [17, 1.18], [18, 1.08], [19, 1.00], [20, 0.94], [21, 0.90], [24, 0.85]]  // declared
});
const CTX = ['is_home', 'zone_off', 'zone_def', 'is_pp_expiry', 'score_lead', 'score_trail'];

/* ------------------------------------------------------------------ RAPM */
/** Build the spec's design (sparse rows) from stints. opts.filter(stint) selects stints, opts.order fixes the column order. */
function design(stints, opts = {}) {
  const filter = opts.filter || (() => true);
  const players = new Map();
  const use = stints.filter((s) => s.endEl - s.startEl > 0 && s.homeSkaters.length && s.awaySkaters.length && filter(s));
  if (opts.order) for (const p of opts.order) if (!players.has(p)) players.set(p, players.size);
  for (const s of use) for (const p of [...s.homeSkaters, ...s.awaySkaters]) if (!players.has(p)) players.set(p, players.size);
  const N = players.size; const rows = [];
  for (const s of use) {
    const w = s.endEl - s.startEl;
    const ctxH = [0];
    if (s.zoneStart === 'OFF') ctxH.push(1); else if (s.zoneStart === 'DEF') ctxH.push(2);
    if (s.ppExpiry) ctxH.push(3);
    if (s.homeScoreDiff > 0) ctxH.push(4); else if (s.homeScoreDiff < 0) ctxH.push(5);
    rows.push({ w, y: (s.home.xgf / w) * 3600, off: s.homeSkaters.map((p) => players.get(p)), def: s.awaySkaters.map((p) => N + players.get(p)), ctx: ctxH });
    const ctxA = [];
    if (s.zoneStart === 'DEF') ctxA.push(1); else if (s.zoneStart === 'OFF') ctxA.push(2);
    if (s.ppExpiry) ctxA.push(3);
    if (s.homeScoreDiff < 0) ctxA.push(4); else if (s.homeScoreDiff > 0) ctxA.push(5);
    rows.push({ w, y: (s.away.xgf / w) * 3600, off: s.awaySkaters.map((p) => players.get(p)), def: s.homeSkaters.map((p) => N + players.get(p)), ctx: ctxA });
  }
  const ctxUsed = CTX.map((_, k) => rows.some((r) => r.ctx.includes(k)));
  const ctxIndex = []; let c = 2 * N; CTX.forEach((_, k) => { ctxIndex[k] = ctxUsed[k] ? c++ : -1; });
  const cols = rows.map((r) => [...r.off, ...r.def, ...r.ctx.map((k) => ctxIndex[k])]);
  return { players: [...players.keys()], N, P: c, rows, cols, ctxNames: CTX.filter((_, k) => ctxUsed[k]), stints: use.length };
}

/**
 * The design of design() as compressed sparse rows, built straight from the stints (no row objects): ptr[i]..
 * ptr[i+1] index the columns of observation i, in design()'s column order. tests/rink checks it against design().
 */
function designCSR(stints, opts = {}) {
  const filter = opts.filter || (() => true);
  const use = []; for (const s of stints) if (s.endEl - s.startEl > 0 && s.homeSkaters.length && s.awaySkaters.length && filter(s)) use.push(s);
  const players = new Map();
  if (opts.order) for (const p of opts.order) if (!players.has(p)) players.set(p, players.size);
  let nnz = 0, zone = false, ppx = false, score = false;
  for (const s of use) {
    for (const p of s.homeSkaters) if (!players.has(p)) players.set(p, players.size);
    for (const p of s.awaySkaters) if (!players.has(p)) players.set(p, players.size);
    nnz += 2 * (s.homeSkaters.length + s.awaySkaters.length) + 1;
    if (s.zoneStart === 'OFF' || s.zoneStart === 'DEF') { zone = true; nnz += 2; }
    if (s.ppExpiry) { ppx = true; nnz += 2; }
    if (s.homeScoreDiff !== 0) { score = true; nnz += 2; }
  }
  const N = players.size, R = 2 * use.length;
  const used = [R > 0, zone, zone, ppx, score, score]; const ci = []; let c = 2 * N; for (let k = 0; k < CTX.length; k++) ci[k] = used[k] ? c++ : -1;
  const ptr = new Int32Array(R + 1), idx = new Int32Array(nnz), w = new Float64Array(R), y = new Float64Array(R), toi = new Float64Array(N);
  let n = 0, i = 0;
  for (const s of use) {
    const dur = s.endEl - s.startEl; const h = s.homeSkaters, a = s.awaySkaters;
    // home offence vs away defence
    w[i] = dur; y[i] = (s.home.xgf / dur) * 3600;
    for (const p of h) { const j = players.get(p); idx[n++] = j; toi[j] += dur; }
    for (const p of a) { const j = players.get(p); idx[n++] = N + j; toi[j] += dur; }
    idx[n++] = ci[0];
    if (s.zoneStart === 'OFF') idx[n++] = ci[1]; else if (s.zoneStart === 'DEF') idx[n++] = ci[2];
    if (s.ppExpiry) idx[n++] = ci[3];
    if (s.homeScoreDiff > 0) idx[n++] = ci[4]; else if (s.homeScoreDiff < 0) idx[n++] = ci[5];
    ptr[++i] = n;
    // away offence vs home defence
    w[i] = dur; y[i] = (s.away.xgf / dur) * 3600;
    for (const p of a) idx[n++] = players.get(p);
    for (const p of h) idx[n++] = N + players.get(p);
    if (s.zoneStart === 'DEF') idx[n++] = ci[1]; else if (s.zoneStart === 'OFF') idx[n++] = ci[2];
    if (s.ppExpiry) idx[n++] = ci[3];
    if (s.homeScoreDiff < 0) idx[n++] = ci[4]; else if (s.homeScoreDiff > 0) idx[n++] = ci[5];
    ptr[++i] = n;
  }
  return { players: [...players.keys()], N, P: c, R, ptr, idx, w, y, toi, ctxNames: CTX.filter((_, k) => used[k]), stints: use.length };
}
/** Assemble the normal equations' ingredients (CSR design, right-hand side, Jacobi diagonal). */
function rapmProblem(stints, opts = {}) {
  const cal = Object.assign({}, CALIBRATION, opts.calibration || {});
  const D = designCSR(stints, opts);
  const { N, P, R, ptr, idx, w, y, toi } = D;
  const base = { calibration: cal.id, lambdaOff: cal.lambdaOff, lambdaDef: cal.lambdaDef, scope: opts.scope || null };
  if (!N || !R) return { empty: Object.assign(base, { players: [], N: 0, stints: 0, observations: 0, note: 'no stints with both lineups on the ice (are shifts being tracked with L / IN / OUT?)' }) };
  let sw = 0, swy = 0; for (let i = 0; i < R; i++) { sw += w[i]; swy += w[i] * y[i]; }
  const ybar = sw > 0 ? swy / sw : 0;
  const lam = new Float64Array(P); for (let i = 0; i < N; i++) { lam[i] = cal.lambdaOff; lam[N + i] = cal.lambdaDef; }
  const theta0 = new Float64Array(P); const at = new Map(D.players.map((p, k) => [p, k]));
  if (opts.priorsOff) for (const [pid, v] of Object.entries(opts.priorsOff)) if (at.has(pid)) theta0[at.get(pid)] = cal.priorDecayOff * v;
  if (opts.priorsDef) for (const [pid, v] of Object.entries(opts.priorsDef)) if (at.has(pid)) theta0[N + at.get(pid)] = -cal.priorDecayDef * v;
  if (opts.theta0Off) for (const [pid, v] of Object.entries(opts.theta0Off)) if (at.has(pid)) theta0[at.get(pid)] = v;      // raw θ0 (tests)
  if (opts.theta0Def) for (const [pid, v] of Object.entries(opts.theta0Def)) if (at.has(pid)) theta0[N + at.get(pid)] = v;
  const b = new Float64Array(P), diag = new Float64Array(P);
  for (let i = 0; i < R; i++) { const t = w[i] * (y[i] - ybar); for (let k = ptr[i]; k < ptr[i + 1]; k++) { b[idx[k]] += t; diag[idx[k]] += w[i]; } }
  for (let j = 0; j < P; j++) { b[j] += lam[j] * theta0[j]; diag[j] = (diag[j] + lam[j]) || 1; }
  return { base, D, N, P, R, ptr, idx, w, lam, b, diag, toi, ybar, maxIt: opts.maxIterations || 20 * P + 200 };
}
/** Jacobi-preconditioned conjugate gradients on (MᵀWM + Λ)θ = b. Yields every `every` iterations; returns the fit. */
function* rapmSteps(pb, every = 8) {
  const { base, D, N, P, R, ptr, idx, w, lam, b, diag, toi, ybar, maxIt } = pb;
  const Av = (v, out) => {
    out.fill(0);
    for (let i = 0; i < R; i++) { const a = ptr[i], e = ptr[i + 1]; let s = 0; for (let k = a; k < e; k++) s += v[idx[k]]; s *= w[i]; for (let k = a; k < e; k++) out[idx[k]] += s; }
    for (let j = 0; j < P; j++) out[j] += lam[j] * v[j];
    return out;
  };
  const norm = (a) => { let t = 0; for (let j = 0; j < a.length; j++) t += a[j] * a[j]; return Math.sqrt(t); };
  const x = new Float64Array(P), r = Float64Array.from(b), z = new Float64Array(P), Ap = new Float64Array(P);
  for (let j = 0; j < P; j++) z[j] = r[j] / diag[j];
  const p = Float64Array.from(z); let rz = 0; for (let j = 0; j < P; j++) rz += r[j] * z[j];
  const bn = norm(b) || 1; let it = 0, res = norm(r) / bn;
  while (res > 1e-13 && it < maxIt) {
    Av(p, Ap); let pAp = 0; for (let j = 0; j < P; j++) pAp += p[j] * Ap[j];
    if (!(pAp > 0)) break;
    const a = rz / pAp; for (let j = 0; j < P; j++) { x[j] += a * p[j]; r[j] -= a * Ap[j]; }
    it++; res = norm(r) / bn; if (res <= 1e-13) break;
    for (let j = 0; j < P; j++) z[j] = r[j] / diag[j];
    let rz2 = 0; for (let j = 0; j < P; j++) rz2 += r[j] * z[j];
    const beta = rz2 / rz; rz = rz2; for (let j = 0; j < P; j++) p[j] = z[j] + beta * p[j];
    if (it % every === 0) yield it;
  }
  const out = D.players.map((pid, k) => ({ pid, off: x[k], def: -x[N + k], net: x[k] - x[N + k], toi: toi[k] }));
  const ctx = {}; D.ctxNames.forEach((nm, k) => { ctx[nm] = x[2 * N + k]; });
  return Object.assign(base, { players: out, N, P, stints: D.stints, observations: R, ybar, context: ctx, iterations: it, residual: res });
}
function rapm(stints, opts = {}) {
  const pb = rapmProblem(stints, opts); if (pb.empty) return pb.empty;
  const g = rapmSteps(pb, 1 << 30); let r; do { r = g.next(); } while (!r.done);
  return r.value;
}
/**
 * The same fit without holding the event loop: the solver hands control back every `sliceMs` of work, so
 * terminal sessions and the feed keep moving while a season is fitted. Same arithmetic, same result as rapm().
 */
async function rapmAsync(stints, opts = {}, sliceMs = 10) {
  const pb = rapmProblem(stints, opts); if (pb.empty) return pb.empty;
  const g = rapmSteps(pb, 4); let t = Date.now();
  for (;;) {
    const r = g.next(); if (r.done) return r.value;
    if (Date.now() - t >= sliceMs) { await new Promise((res) => setImmediate(res)); t = Date.now(); }
  }
}

/* ------------------------------------------------------------------ GSAx */
function gsaxEB(raw, n, cal = CALIBRATION) { const k = cal.gsaxKappa; return n + k > 0 ? (n / (n + k)) * raw + (k / (n + k)) * n * cal.gsaxPrior : 0; }

/* ------------------------------------------------------------------ splines */
/** Natural cubic spline regression basis (truncated-power form, ESL §5.2.1; spans the natural B-spline space). */
function nsBasis(x, knots) {
  const K = knots.length;
  const d = (k) => (Math.max(0, x - knots[k]) ** 3 - Math.max(0, x - knots[K - 1]) ** 3) / (knots[K - 1] - knots[k]);
  const out = [1, x]; for (let k = 0; k < K - 2; k++) out.push(d(k) - d(K - 2));
  return out;
}
function solveDense(A, b) {
  const m = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < m; c++) {
    let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c]; if (Math.abs(d) < 1e-300) continue;
    for (let r = 0; r < m; r++) if (r !== c) { const f = M[r][c] / d; if (f) for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-300 ? 0 : r[m] / r[i]));
}
/** Weighted least squares of y on the spline basis with a tiny ridge for stability. points: [{x, y, w}]. */
function fitSpline(points, knots, ridge = 1e-11) {
  const m = knots.length; const A = Array.from({ length: m }, () => new Array(m).fill(0)); const bb = new Array(m).fill(0);
  for (const { x, y, w } of points) { const B = nsBasis(x, knots); for (let i = 0; i < m; i++) { bb[i] += w * B[i] * y; for (let j = 0; j < m; j++) A[i][j] += w * B[i] * B[j]; } }
  for (let i = 0; i < m; i++) A[i][i] += ridge * (A[i][i] || 1);
  return solveDense(A, bb);
}
const evalSpline = (alpha, x, knots) => nsBasis(x, knots).reduce((s, b, i) => s + alpha[i] * b, 0);
/** Natural cubic interpolating spline through (xs, ys); linear extrapolation outside. */
function naturalCubic(xs, ys) {
  const n = xs.length; const h = []; for (let i = 0; i < n - 1; i++) h.push(xs[i + 1] - xs[i]);
  const M = new Array(n).fill(0);
  if (n > 2) {
    const a = [], b = [], c = [], d = [];
    for (let i = 1; i < n - 1; i++) { a.push(h[i - 1]); b.push(2 * (h[i - 1] + h[i])); c.push(h[i]); d.push(6 * ((ys[i + 1] - ys[i]) / h[i] - (ys[i] - ys[i - 1]) / h[i - 1])); }
    for (let i = 1; i < b.length; i++) { const w = a[i] / b[i - 1]; b[i] -= w * c[i - 1]; d[i] -= w * d[i - 1]; }
    const sol = new Array(b.length); sol[b.length - 1] = d[b.length - 1] / b[b.length - 1];
    for (let i = b.length - 2; i >= 0; i--) sol[i] = (d[i] - c[i] * sol[i + 1]) / b[i];
    for (let i = 0; i < sol.length; i++) M[i + 1] = sol[i];
  }
  const slope = (i, atLeft) => { const hi = h[i]; return (ys[i + 1] - ys[i]) / hi + (atLeft ? -hi * (2 * M[i] + M[i + 1]) / 6 : hi * (M[i] + 2 * M[i + 1]) / 6); };
  return (x) => {
    if (x <= xs[0]) return ys[0] + slope(0, true) * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + slope(n - 2, false) * (x - xs[n - 1]);
    let i = 0; while (x > xs[i + 1]) i++;
    const t = h[i], A = (xs[i + 1] - x) / t, B = (x - xs[i]) / t;
    return A * ys[i] + B * ys[i + 1] + ((A ** 3 - A) * M[i] + (B ** 3 - B) * M[i + 1]) * t * t / 6;
  };
}
const clampAge = (days, cal) => Math.min(cal.ageDomainDays[1], Math.max(cal.ageDomainDays[0], days));

/* ------------------------------------------------------------------ GAR / WAR */
/**
 * box: Map pid -> box line (toiEV/toiPP/toiSH seconds, g, ixg, penTaken); rapmEV and rapmST from rapm();
 * ages: Map pid -> age in days at the scope's last game.
 */
function gar({ box, rapmEV, rapmST, ages, calibration }) {
  const cal = Object.assign({}, CALIBRATION, calibration || {});
  const ev = new Map((rapmEV && rapmEV.players || []).map((p) => [p.pid, p]));
  const st = new Map((rapmST && rapmST.players || []).map((p) => [p.pid, p]));
  const rows = [];
  for (const [pid, b] of box) {
    if (b.pos === 'G') continue;
    const hrs = (b.toiEV + b.toiPP + b.toiSH) / 3600;
    const e = ev.get(pid) || { off: 0, def: 0 }, s = st.get(pid) || { off: 0, def: 0 };
    const EVO = e.off * (b.toiEV / 3600), EVD = e.def * (b.toiEV / 3600);
    const PPO = s.off * (b.toiPP / 3600), SHD = s.def * (b.toiSH / 3600);
    const finishing = b.g - b.ixg;
    const penalties = -b.penTaken * cal.penaltyGoalCost;
    const replacement = -cal.replacementPer60 * hrs;          // a replacement player's goals relative to average over the same ice time
    const garv = EVO + EVD + PPO + SHD + finishing + penalties - replacement;
    rows.push({ pid, code: b.code, name: b.name, team: b.team, pos: b.pos, gp: b.gp, toiMin: hrs * 60, EVO, EVD, PPO, SHD, finishing, penalties, replacement, gar: garv, war: garv / cal.goalsPerWin, ageDays: ages ? ages.get(pid) ?? null : null });
  }
  const knots = cal.ageKnotsYears;
  const pts = rows.filter((r) => r.ageDays != null && r.toiMin > 1).map((r) => ({ x: clampAge(r.ageDays, cal) / 365.25, y: r.gar / (r.toiMin / 60), w: r.toiMin }));
  const distinct = new Set(pts.map((p) => Math.floor(p.x))).size;
  const alpha = pts.length >= 3 * knots.length && distinct >= 3 ? fitSpline(pts, knots) : null;
  for (const r of rows) {
    const f = alpha && r.ageDays != null ? evalSpline(alpha, clampAge(r.ageDays, cal) / 365.25, knots) * (r.toiMin / 60) : 0;
    r.ageExpected = f; r.garAgeAdj = r.gar - f; r.warAgeAdj = r.garAgeAdj / cal.goalsPerWin;
  }
  rows.sort((a, b) => b.gar - a.gar);
  return { rows, alpha, knots, ageCurve: alpha ? 'fitted' : `neutral (needs ≥ ${3 * knots.length} skaters with birth dates across ≥ 3 ages)`, calibration: cal.id, goalsPerWin: cal.goalsPerWin };
}

/* ------------------------------------------------------------------ NHLe */
function nhleFactor(cal = CALIBRATION) {
  const chains = cal.nhleChains.map((c) => ({ via: c.via, factor: c.factors.reduce((a, f) => a * f, 1) }));
  const T = chains.length / chains.reduce((a, c) => a + 1 / c.factor, 0);
  return { T, chains };
}
function nhle({ box, ages, calibration }) {
  const cal = Object.assign({}, CALIBRATION, calibration || {});
  const { T, chains } = nhleFactor(cal);
  const f = naturalCubic(cal.nhleAgeMultipliers.map((k) => k[0]), cal.nhleAgeMultipliers.map((k) => k[1]));
  const rows = [];
  for (const [pid, b] of box) {
    if (b.pos === 'G' || !b.gp) continue;
    const pts = b.g + b.a1 + b.a2, ppg = pts / b.gp;
    const ageDays = ages ? ages.get(pid) ?? null : null;
    const ageFactor = ageDays != null ? f(clampAge(ageDays, cal) / 365.25) : 1;
    rows.push({ pid, code: b.code, name: b.name, team: b.team, pos: b.pos, gp: b.gp, pts, ppg, ageDays, ageFactor, nhle82: ppg * 82 * T * ageFactor });
  }
  rows.sort((a, b) => b.nhle82 - a.nhle82);
  return { rows, T, chains, calibration: cal.id, note: 'translation factors and age multipliers are declared placeholders, not fitted values' };
}

/* ------------------------------------------------------------------ aggregation */
const SUMS = ['g', 'a1', 'a2', 'sog', 'miss', 'blk', 'attBlocked', 'hits', 'tk', 'gv', 'fow', 'fol', 'pim', 'pm', 'ixg', 'ze', 'zx', 'fc', 'omr', 'toi', 'toiEV', 'toiPP', 'toiSH', 'ppg', 'shg', 'gwg', 'onGF', 'onGA', 'penTaken',
  'sa', 'ga', 'sv', 'fenFaced', 'xgaFaced', 'gsax', 'hdsa', 'hdsv', 'mdsa', 'mdsv', 'ldsa', 'ldsv'];
/** Merge per-game box lines (iterables of Map pid -> line) into season lines; gp counts games appeared in. */
function mergeBoxes(boxes) {
  const out = new Map();
  for (const box of boxes) for (const [pid, b] of box) {
    let m = out.get(pid);
    if (!m) { m = Object.assign({}, b, { gp: 0 }); for (const k of SUMS) m[k] = 0; out.set(pid, m); }
    m.team = b.team; m.gp += 1; for (const k of SUMS) m[k] += b[k] || 0;
  }
  return out;
}
module.exports = { CALIBRATION, CTX, design, designCSR, rapm, rapmAsync, rapmProblem, rapmSteps, gsaxEB, gar, nhle, nhleFactor, nsBasis, fitSpline, evalSpline, naturalCubic, mergeBoxes, SUMS };
