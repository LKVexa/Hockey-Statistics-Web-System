'use strict';
/**
 * gomath — bit-exact JavaScript ports of the Go (amd64) math routines the HK001 engine calls.
 * -----------------------------------------------------------------------------------------
 * HK001 2.3.0 is a Go program built for GOAMD64=v1. On amd64:
 *   math.Exp   -> archExp, assembly (src/math/exp_amd64.s, SLEEF-derived). Two code paths chosen at run
 *                 time: an FMA path when the CPU has AVX+FMA, an SSE2 path otherwise. Both are ported.
 *   math.Log   -> archLog, assembly (src/math/log_amd64.s), SSE2 only. Ported.
 *   math.Pow   -> pure Go (src/math/pow.go): Exp(yf*Log(x)) times repeated squaring. Ported.
 *   math.Cos   -> pure Go (src/math/sin.go, Cephes). Ported.
 *   math.Round -> exact; ported from its reference definition.
 *   math.Sqrt  -> correctly rounded in both languages (IEEE 754), so Math.sqrt is used.
 * Go does not fuse multiply-add in compiled GOAMD64=v1 code, so every other expression is evaluated
 * operation by operation exactly as JavaScript does. The FMA instructions of the Exp fast path are
 * emulated exactly with BigInt arithmetic (one rounding, ties to even).
 *
 * Verified against 18 000 vectors produced by the Go toolchain on both Exp paths (tests/rink/gomath.test.js).
 * The Go sources are BSD-licensed (Copyright The Go Authors); constants and operation order are theirs. The licence
 * and the notices of the sources Go builds on are in rink/hk001/NOTICE.md.
 */

const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);
const bits = (x) => { F64[0] = x; return U64[0]; };
const fromBits = (b) => { U64[0] = BigInt.asUintN(64, b); return F64[0]; };

/* ---------- exact fused multiply-add: round(a*b + c) once, ties to even ---------- */
function decompose(x) {
  // x = sign * m * 2^e with m a non-negative BigInt
  const b = bits(x);
  const neg = (b >> 63n) === 1n;
  const ex = Number((b >> 52n) & 0x7ffn);
  let m = b & 0xfffffffffffffn;
  let e;
  if (ex === 0) e = -1074; else { m |= 0x10000000000000n; e = ex - 1075; }
  return { neg, m, e };
}
/** Round the exact value s * 2^e (s BigInt, may be negative) to the nearest float64, ties to even. */
function roundToDouble(s, e) {
  if (s === 0n) return 0;
  const neg = s < 0n; let m = neg ? -s : s;
  let len = m.toString(2).length;
  // unbiased exponent of the leading bit: len - 1 + e ; normal range keeps 53 bits, subnormal keeps fewer
  let keep = 53;
  const lead = len - 1 + e;
  if (lead < -1022) keep = 53 - (-1022 - lead);           // subnormal: fewer significant bits
  if (keep < 0) return neg ? -0 : 0;
  let shift = len - keep;
  if (shift > 0) {
    const sh = BigInt(shift);
    const q = m >> sh; const r = m - (q << sh); const half = 1n << (sh - 1n);
    let qq = q;
    if (r > half || (r === half && (q & 1n) === 1n)) qq = q + 1n;
    m = qq; e += shift;
    if (m.toString(2).length > keep && keep === 53) { m >>= 1n; e += 1; }
  }
  // value = m * 2^e exactly representable now
  let v = Number(m);
  // scale by 2^e in safe steps
  while (e > 0) { const k = Math.min(e, 1000); v *= Math.pow(2, k); e -= k; }
  while (e < 0) { const k = Math.min(-e, 1000); v *= Math.pow(2, -k); e += k; if (v === 0) break; }
  return neg ? -v : v;
}
function fma(a, b, c) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return a * b + c;
  const A = decompose(a), B = decompose(b), C = decompose(c);
  let pm = A.m * B.m; const pe = A.e + B.e; if (A.neg !== B.neg) pm = -pm;
  let cm = C.neg ? -C.m : C.m; const ce = C.e;
  if (pm === 0n && cm === 0n) return a * b + c;           // signed-zero rules
  const e = Math.min(pe, ce);
  const s = (pm << BigInt(pe - e)) + (cm << BigInt(ce - e));
  if (s === 0n) return 0;                                 // exact cancellation -> +0 (round to nearest)
  return roundToDouble(s, e);
}

/* ---------- math.Exp (archExp, exp_amd64.s) ---------- */
const LOG2E = 1.4426950408889634073599246810018920;
const LN2U = 0.69314718055966295651160180568695068359375;
const LN2L = 0.28235290563031577122588448175013436025525412068e-12;
const OVERFLOW = 7.09782712893384e+02;
const EC = [0.5, 1.0, 2.0, 1.6666666666666666667e-1, 4.1666666666666666667e-2, 8.3333333333333333333e-3,
  1.3888888888888888889e-3, 1.9841269841269841270e-4, 2.4801587301587301587e-5];
// CVTSD2SL: round to nearest, ties to even (default MXCSR), result in int32
function cvtsd2sl(x) {
  if (!(x > -2147483649 && x < 2147483648)) return -2147483648;   // "integer indefinite"
  let r = Math.round(x);
  if (Math.abs(x - Math.trunc(x)) === 0.5) r = 2 * Math.round(x / 2);
  return r | 0;
}
let useFMA = true;
function setExpPath(p) { useFMA = p !== 'sse2'; }
function expPath() { return useFMA ? 'fma' : 'sse2'; }

function goExp(x) {
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x === -Infinity) return 0;
  if (x > OVERFLOW) return Infinity;
  let bx = cvtsd2sl(LOG2E * x);
  const k = bx;
  let x0 = x, x1;
  if (useFMA) {
    x0 = fma(-k, LN2U, x0);
    x0 = fma(-k, LN2L, x0);
    x0 = x0 * 0.0625;
    x1 = EC[8];
    x1 = fma(x0, x1, EC[7]); x1 = fma(x0, x1, EC[6]); x1 = fma(x0, x1, EC[5]); x1 = fma(x0, x1, EC[4]);
    x1 = fma(x0, x1, EC[3]); x1 = fma(x0, x1, EC[0]); x1 = fma(x0, x1, EC[1]);
    x0 = x0 * x1;
    x1 = x0 + 2.0; x0 = x0 * x1;
    x1 = x0 + 2.0; x0 = x0 * x1;
    x1 = x0 + 2.0; x0 = x0 * x1;
    x1 = x0 + 2.0; x0 = fma(x1, x0, 1.0);
  } else {
    x0 = x0 - k * LN2U;
    x0 = x0 - k * LN2L;
    x0 = x0 * 0.0625;
    x1 = EC[8] * x0;
    x1 = (x1 + EC[7]) * x0; x1 = (x1 + EC[6]) * x0; x1 = (x1 + EC[5]) * x0; x1 = (x1 + EC[4]) * x0;
    x1 = (x1 + EC[3]) * x0; x1 = (x1 + EC[0]) * x0; x1 = x1 + EC[1];
    x0 = x0 * x1;
    for (let i = 0; i < 4; i++) { x1 = 2.0 + x0; x0 = x0 * x1; }
    x0 = x0 + 1.0;
  }
  // ldexp tail of the assembly
  bx += 0x3ff;
  if (bx <= 0) {
    if (bx < -52) return 0;
    bx += 0x3fe;
    x0 = x0 * fromBits(BigInt(bx) << 52n);
    bx = 1;
  } else if (bx >= 0x7ff) return Infinity;
  return x0 * fromBits(BigInt(bx) << 52n);
}

/* ---------- math.Log (archLog, log_amd64.s) ---------- */
const HSqrt2 = 7.07106781186547524401e-01, Ln2Hi = 6.93147180369123816490e-01, Ln2Lo = 1.90821492927058770002e-10;
const L1 = 6.666666666666735130e-01, L2 = 3.999999999940941908e-01, L3 = 2.857142874366239149e-01, L4 = 2.222219843214978396e-01,
  L5 = 1.818357216161805012e-01, L6 = 1.531383769920937332e-01, L7 = 1.479819860511658591e-01;
function goLog(x) {
  const b = bits(x);
  if ((b & 0x7fffffffffffffffn) === 0n) return -Infinity;
  if ((b >> 63n) === 1n) return NaN;
  if (b >= 0x7ff0000000000000n) return x;                  // +Inf or NaN
  // f1, ki := Frexp(x) — the assembly reads the raw exponent field (subnormals are not renormalised)
  let f1 = fromBits((b & 0x000fffffffffffffn) | 0x3fe0000000000000n);
  let k = Number((b >> 52n) & 0x7ffn) - 0x3fe;
  if (f1 < HSqrt2) { k -= 1; f1 *= 2; }
  const f = f1 - 1;
  const s = f / (2 + f);
  const s2 = s * s;
  const s4 = s2 * s2;
  const t1 = s2 * (L1 + s4 * (L3 + s4 * (L5 + s4 * L7)));
  const t2 = s4 * (L2 + s4 * (L4 + s4 * L6));
  const R = t1 + t2;
  const hfsq = 0.5 * f * f;
  return k * Ln2Hi - ((hfsq - (s * (hfsq + R) + k * Ln2Lo)) - f);
}

/* ---------- Frexp / Ldexp / Modf (pure Go, exact) ---------- */
function goFrexp(f) {
  if (f === 0 || !Number.isFinite(f)) return [f, 0];
  let e0 = 0;
  if (Math.abs(f) < 2.2250738585072014e-308) { f *= 4503599627370496; e0 = -52; }   // normalize
  const b = bits(f);
  const exp = e0 + Number((b >> 52n) & 0x7ffn) - 1023 + 1;
  const fr = fromBits((b & ~(0x7ffn << 52n)) | (1022n << 52n));
  return [fr, exp];
}
function goLdexp(frac, exp) {
  if (frac === 0 || !Number.isFinite(frac)) return frac;
  let e0 = 0;
  if (Math.abs(frac) < 2.2250738585072014e-308) { frac *= 4503599627370496; e0 = -52; }
  exp += e0;
  const b = bits(frac);
  exp += Number((b >> 52n) & 0x7ffn) - 1023;
  if (exp < -1075) return frac < 0 || Object.is(frac, -0) ? -0 : 0;
  if (exp > 1023) return frac < 0 ? -Infinity : Infinity;
  let m = 1;
  if (exp < -1022) { exp += 53; m = 1.0 / 9007199254740992; }
  const x = (b & ~(0x7ffn << 52n)) | (BigInt(exp + 1023) << 52n);
  return m * fromBits(x);
}
function goModf(f) {
  if (f < 1) {
    if (f < 0) { const [i, fr] = goModf(-f); return [-i, -fr]; }
    if (f === 0) return [f, f];
    return [0, f];
  }
  const i = Math.trunc(f);
  return [i, f - i];
}

/* ---------- math.Pow (pow.go) ---------- */
function isOddInt(x) {
  if (Math.abs(x) >= 9007199254740992) return false;
  const [xi, xf] = goModf(x);
  return xf === 0 && (BigInt.asIntN(64, BigInt(xi)) & 1n) === 1n;
}
function goPow(x, y) {
  if (y === 0 || x === 1) return 1;
  if (y === 1) return x;
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x === 0) {
    if (y < 0) return (Object.is(x, -0) && isOddInt(y)) ? -Infinity : Infinity;
    if (y > 0) return (Object.is(x, -0) && isOddInt(y)) ? x : 0;
  }
  if (!Number.isFinite(y)) {
    if (x === -1) return 1;
    if ((Math.abs(x) < 1) === (y === Infinity)) return 0;
    return Infinity;
  }
  if (!Number.isFinite(x)) {
    if (x === -Infinity) return goPow(1 / x, -y);
    if (y < 0) return 0; if (y > 0) return Infinity;
  }
  if (y === 0.5) return Math.sqrt(x);
  if (y === -0.5) return 1 / Math.sqrt(x);
  let [yi, yf] = goModf(Math.abs(y));
  if (yf !== 0 && x < 0) return NaN;
  if (yi >= 9223372036854775808) {
    if (x === -1) return 1;
    if ((Math.abs(x) < 1) === (y > 0)) return 0;
    return Infinity;
  }
  let a1 = 1.0, ae = 0;
  if (yf !== 0) {
    if (yf > 0.5) { yf--; yi++; }
    a1 = goExp(yf * goLog(x));
  }
  let [x1, xe] = goFrexp(x);
  for (let i = BigInt(yi); i !== 0n; i >>= 1n) {
    if (xe < -4096 || 4096 < xe) { ae += xe; break; }
    if ((i & 1n) === 1n) { a1 *= x1; ae += xe; }
    x1 *= x1;
    xe <<= 1;
    if (x1 < 0.5) { x1 += x1; xe--; }
  }
  if (y < 0) { a1 = 1 / a1; ae = -ae; }
  return goLdexp(a1, ae);
}

/* ---------- math.Cos (sin.go) ---------- */
const PI4A = 7.85398125648498535156e-1, PI4B = 3.77489470793079817668e-8, PI4C = 2.69515142907905952645e-15;
const FOUR_OVER_PI = fromBits(0x3ff45f306dc9c883n);       // float64(4/π) as Go folds the constant
const SIN = [1.58962301576546568060e-10, -2.50507477628578072866e-8, 2.75573136213857245213e-6, -1.98412698295895385996e-4, 8.33333333332211858878e-3, -1.66666666666666307295e-1];
const COS = [-1.13585365213876817300e-11, 2.08757008419747316778e-9, -2.75573141792967388112e-7, 2.48015872888517045348e-5, -1.38888888888730564116e-3, 4.16666666666665929218e-2];
function goCos(x) {
  if (!Number.isFinite(x)) return NaN;
  let sign = false;
  x = Math.abs(x);
  if (x >= 536870912) return Math.cos(x);                 // trigReduce path: never reached by HK001 (phases < 2π)
  let j = Math.floor(x * FOUR_OVER_PI);
  let y = j;
  if (j & 1) { j++; y++; }
  j &= 7;
  const z = ((x - y * PI4A) - y * PI4B) - y * PI4C;
  if (j > 3) { j -= 4; sign = !sign; }
  if (j > 1) sign = !sign;
  const zz = z * z;
  if (j === 1 || j === 2) y = z + z * zz * ((((((SIN[0] * zz) + SIN[1]) * zz + SIN[2]) * zz + SIN[3]) * zz + SIN[4]) * zz + SIN[5]);
  else y = 1.0 - 0.5 * zz + zz * zz * ((((((COS[0] * zz) + COS[1]) * zz + COS[2]) * zz + COS[3]) * zz + COS[4]) * zz + COS[5]);
  return sign ? -y : y;
}

/* ---------- math.Round (exact) ---------- */
function goRound(x) {
  if (!Number.isFinite(x)) return x;
  const t = Math.trunc(x);
  if (Math.abs(x - t) >= 0.5) return t + (x < 0 || Object.is(x, -0) ? -1 : 1);
  return t;
}

/* ---------- fmt: %.Nf exactly as Go's strconv (round half to even on the exact binary value) ---------- */
function goFixed(x, prec) {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? '+Inf' : '-Inf';
  const neg = x < 0 || Object.is(x, -0);
  const { m, e } = decompose(Math.abs(x));
  // exact value = m * 2^e ; scaled = value * 10^prec
  const P = 10n ** BigInt(prec);
  let num, den;
  if (e >= 0) { num = m * P * (1n << BigInt(e)); den = 1n; } else { num = m * P; den = 1n << BigInt(-e); }
  let q = num / den; const r = num - q * den;
  if (r * 2n > den || (r * 2n === den && (q & 1n) === 1n)) q += 1n;
  let s = q.toString();
  if (prec > 0) { s = s.padStart(prec + 1, '0'); s = s.slice(0, s.length - prec) + '.' + s.slice(s.length - prec); }
  return (neg ? '-' : '') + s;
}

module.exports = { goExp, goLog, goPow, goCos, goRound, goFrexp, goLdexp, goModf, goFixed, fma, setExpPath, expPath, bits, fromBits };
