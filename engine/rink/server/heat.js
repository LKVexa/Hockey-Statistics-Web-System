'use strict';
/**
 * Shot heat maps by kernel density on the Plume XPU (LCUF-A/0.3, xpu.wasm), with a pure-JS kernel that gives the
 * identical integers when the XPU component is absent.
 *
 * The full rink (200 × 85 ft) is a 120 × 51 lattice (1⅔ ft cells) placed inside the XPU's 128 × 128 frame with
 * zero borders, so the toroidal neighbourhood of `nsum` never wraps from one end board to the other. The eight
 * lanes of the frame carry eight maps at once: home and away × {unblocked attempts, goals, HIGH-danger
 * attempts, shots on goal}. Home attacks right; the away team's normalised coordinates are mirrored.
 *
 * Program rinkvt.kde.box: x ← x + nsum(x) per step, i.e. one 3×3 box filter per step. k steps give the separable
 * kernel box^k (k = 4: 9×9 cells ≈ 15 ft, weights 1-4-10-16-19-16-10-4-1 per axis, total 9^k). All arithmetic is
 * exact in Z/2^20 — the guard picks the largest k ≤ requested whose worst case cannot wrap
 * (max weight × busiest window < 2^20), and reports it.
 */
const fs = require('node:fs');
const path = require('node:path');

const COLS = 120, ROWS = 51, X0 = 4, Y0 = 38, W = 128, H = 128, LANES = 8, WORDS = LANES * W * H, M = 1 << 20;
const FT_X = 200 / COLS, FT_Y = 85 / ROWS;
const LANE_NAMES = ['home attempts', 'home goals', 'home high-danger', 'home shots on goal', 'away attempts', 'away goals', 'away high-danger', 'away shots on goal'];
const SOURCE = `LCUF-A/0.3
module rinkvt.kde.box
ring p=2 n=20
frame lanes=8 height=128 width=128
phase | id | op   | inputs | output | arg
init  | i1 | copy | in     | x      | -
step  | s1 | nsum | x      | s      | -
step  | s2 | add  | x,s    | y      | -
step  | s3 | copy | y      | x      | -
final | f1 | copy | x      | out    | -
end
`;
// The program as lcufa.compile() assembles it (row = op, out, in0, in1, c; slots in=0 x=1 s=2 y=3 out=4);
// tests/rink compare this against the vendored compiler.
const CODE = Uint32Array.from([1, 1, 0, 0, 0, 4, 2, 1, 0, 0, 8, 3, 1, 2, 0, 1, 1, 3, 0, 0, 1, 4, 1, 0, 0]);
const PROG = { p: 2, n: 20, ninit: 1, nstep: 3, nfinal: 1, outSlot: 4 };

/* 1-D box^k weights and the centre (maximum) weight of the 2-D kernel */
function boxWeights(k) { let w = [1]; for (let i = 0; i < k; i++) { const n = new Array(w.length + 2).fill(0); w.forEach((v, j) => { n[j] += v; n[j + 1] += v; n[j + 2] += v; }); w = n; } return w; }
const centreWeight = (k) => { const w = boxWeights(k); return w[(w.length - 1) / 2] ** 2; };

let xpu = null, xpuError = null;
function loadXpu(dir = path.join(__dirname, '..', '..', 'vendor', 'xpu')) {
  if (xpu || xpuError) return xpu;
  try {
    const bytes = fs.readFileSync(path.join(dir, 'xpu.wasm'));
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    xpu = { ex: inst.exports, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') };
  } catch (e) { xpuError = e.message; }
  return xpu;
}

function cellOf(x, y) {
  const c = Math.min(COLS - 1, Math.max(0, Math.floor((x + 100) / FT_X)));
  const r = Math.min(ROWS - 1, Math.max(0, Math.floor((42.5 - y) / FT_Y)));     // row 0 = top boards (y = +42.5)
  return [c, r];
}
/** Build the 8-lane input frame from events (normalised attacking-right coordinates). */
function frameFrom(events, home) {
  const f = new Uint32Array(WORDS); const counts = new Array(LANES).fill(0);
  const put = (lane, x, y) => { const [c, r] = cellOf(x, y); const i = ((Y0 + r) * W + (X0 + c)) * LANES + lane; f[i] = (f[i] + 1) % M; counts[lane]++; };
  for (const e of events) {
    if (!['S', 'G', 'M'].includes(e.stat) || e.situation === 'SO' || e.x === null || e.coordSource === 'prior') continue;
    const away = e.team !== home, base = away ? 4 : 0;
    const x = away ? -e.x : e.x, y = away ? -e.y : e.y;
    put(base, x, y);
    if (e.stat === 'G') put(base + 1, x, y);
    if (e.danger === 'HIGH') put(base + 2, x, y);
    if (e.stat !== 'M') put(base + 3, x, y);
  }
  return { frame: f, counts };
}
/** Busiest (2k+1)² window per lane: the wrap guard's worst case. */
function busiestWindow(frame, k) {
  const best = new Array(LANES).fill(0), r = k;
  for (let lane = 0; lane < LANES; lane++) {
    // 2-D prefix sums over the rink block
    const P = new Float64Array((ROWS + 1) * (COLS + 1));
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) P[(y + 1) * (COLS + 1) + x + 1] = frame[((Y0 + y) * W + X0 + x) * LANES + lane] + P[y * (COLS + 1) + x + 1] + P[(y + 1) * (COLS + 1) + x] - P[y * (COLS + 1) + x];
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(ROWS, y + r + 1), x0 = Math.max(0, x - r), x1 = Math.min(COLS, x + r + 1);
      const s = P[y1 * (COLS + 1) + x1] - P[y0 * (COLS + 1) + x1] - P[y1 * (COLS + 1) + x0] + P[y0 * (COLS + 1) + x0];
      if (s > best[lane]) best[lane] = s;
    }
  }
  return best;
}
/** Exact integer reference: k box passes with the same toroidal 128×128 neighbourhood and mod 2^20 as the XPU. */
function jsKernel(frame, k) {
  let x = Uint32Array.from(frame); const y = new Uint32Array(WORDS);
  for (let s = 0; s < k; s++) {
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const base = (r * W + c) * LANES;
      for (let lane = 0; lane < LANES; lane++) {
        let sum = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) sum += x[((((r + dr + H) % H) * W) + ((c + dc + W) % W)) * LANES + lane];
        y[base + lane] = sum % M;                       // x + nsum(x) = the full 3×3 sum
      }
    }
    x.set(y);
  }
  return x;
}
function xpuKernel(frame, k) {
  const X = loadXpu(); if (!X) return null;
  const ex = X.ex, mem = () => ex.memory.buffer;
  if (!ex.configure(PROG.p, PROG.n, 8, 12)) throw new Error('the XPU refused ring Z/2^20');
  new Uint32Array(mem(), ex.prog_ptr(), CODE.length).set(CODE);
  if (!ex.load_program(PROG.ninit, PROG.nstep, PROG.nfinal)) throw new Error('the XPU refused the KDE program');
  new Uint32Array(mem(), ex.slot_ptr(0), WORDS).set(frame);
  if (!ex.run(k, 0, 1)) throw new Error('the XPU refused the run');
  return Uint32Array.from(new Uint32Array(mem(), ex.slot_ptr(PROG.outSlot), WORDS));
}

/**
 * events: effective actor events (one game or many); home: the team drawn attacking right.
 * opts: { steps = 4, engine = 'auto'|'xpu'|'js' }
 */
function heat(events, home, opts = {}) {
  const want = Math.max(1, Math.min(6, opts.steps || 4));
  const { frame, counts } = frameFrom(events, home);
  let k = want;
  for (; k > 1; k--) { const busy = Math.max(...busiestWindow(frame, k)); if (centreWeight(k) * busy < M) break; }
  const t0 = process.hrtime.bigint();
  let engine = opts.engine || 'auto', out = null;
  if (engine !== 'js') { out = xpuKernel(frame, k); if (out) engine = 'xpu'; else if (engine === 'xpu') throw new Error(`XPU component unavailable: ${xpuError || 'vendor/xpu/xpu.wasm missing'}`); }
  if (!out) { out = jsKernel(frame, k); engine = 'js'; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const lanes = [];
  for (let lane = 0; lane < LANES; lane++) {
    const v = new Uint32Array(COLS * ROWS); let max = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const val = out[((Y0 + r) * W + X0 + c) * LANES + lane]; v[r * COLS + c] = val; if (val > max) max = val; }
    lanes.push({ name: LANE_NAMES[lane], events: counts[lane], max, values: v });
  }
  return { cols: COLS, rows: ROWS, ftPerCell: [FT_X, FT_Y], steps: k, requestedSteps: want, mass: 9 ** k, bandwidthFt: (2 * k + 1) * FT_X, engine, ms,
    xpu: xpu ? { wasmSha256: xpu.sha256 } : { unavailable: xpuError || 'not loaded' }, program: 'rinkvt.kde.box (LCUF-A/0.3, ring Z/2^20)', lanes };
}
/** Pack chosen lanes for the browser: u8 per cell, normalised by each lane's max. */
function pack(h, laneIdx = [0, 4]) {
  return { cols: h.cols, rows: h.rows, steps: h.steps, engine: h.engine, bandwidthFt: h.bandwidthFt, lanes: laneIdx.map((i) => { const l = h.lanes[i]; const u = new Uint8Array(l.values.length); if (l.max) for (let j = 0; j < u.length; j++) u[j] = Math.round((l.values[j] / l.max) * 255); return { name: l.name, events: l.events, max: l.max, b64: Buffer.from(u).toString('base64') }; }) };
}
module.exports = { heat, pack, frameFrom, jsKernel, xpuKernel, loadXpu, busiestWindow, boxWeights, centreWeight, SOURCE, CODE, PROG, COLS, ROWS, X0, Y0, LANE_NAMES, cellOf };
