'use strict';
/**
 * Overtime rules: how a game is decided when regulation ends tied — set per league (rink overtime).
 *
 * A rule set has two blocks: `reg` for regular-season and preseason games, `po` for playoff and championship games.
 *   ot       the overtime period's length in seconds: 0 (no overtime) or 60–1200
 *   skaters  skaters a side in overtime: 3, 4 or 5 (each penalty gives the other side one more, up to 5)
 *   so       shootout rounds after the overtime: 0 (no shootout), or 1–10, then sudden death
 * Periods: P1–P3 are regulation (20:00); period 4 is the overtime; period 5 is the shootout when there is one. A
 * regular block without a shootout lets a tie stand once its overtime (if any) ends. A playoff block without a
 * shootout repeats sudden-death overtime periods of its length until a goal, up to period 12 (OT1 … OT9).
 *
 * A league's rules are copied into each game created for its teams (game.ot, from the home team's league), so a game
 * is always decided by the rules it was created under, whatever the league changes later. A game without them — in
 * no league with rules, or created by an earlier build — keeps the built-in rules exactly: a regular-season game the
 * "standard" preset, any other game 20:00 5-on-5 sudden-death periods.
 */
const { MAX_PERIOD } = require('../shared/hcl');
const PLAYOFF_STAGES = new Set(['PLAYOFF', 'CHAMPIONSHIP']);
const SUDDEN_DEATH = { ot: 1200, skaters: 5, so: 0 };

const PRESETS = {
  standard: { reg: { ot: 300, skaters: 3, so: 3 }, po: SUDDEN_DEATH,
    text: 'regular season: 5:00 3-on-3 overtime, then a shootout of 3 rounds · playoffs: 20:00 5-on-5 sudden-death periods' },
  'four-on-four': { reg: { ot: 300, skaters: 4, so: 3 }, po: SUDDEN_DEATH,
    text: 'regular season: 5:00 4-on-4 overtime, then a shootout of 3 rounds · playoffs: 20:00 5-on-5 sudden-death periods' },
  international: { reg: { ot: 300, skaters: 3, so: 5 }, po: { ot: 600, skaters: 3, so: 5 },
    text: 'regular season: 5:00 3-on-3 overtime, then a shootout of 5 rounds · playoffs: 10:00 3-on-3 overtime, then a shootout of 5 rounds' },
  'overtime-then-tie': { reg: { ot: 300, skaters: 3, so: 0 }, po: SUDDEN_DEATH,
    text: 'regular season: 5:00 3-on-3 overtime, and a tie stands · playoffs: 20:00 5-on-5 sudden-death periods' },
  'shootout-only': { reg: { ot: 0, skaters: 3, so: 3 }, po: SUDDEN_DEATH,
    text: 'regular season: no overtime, a shootout of 3 rounds · playoffs: 20:00 5-on-5 sudden-death periods' },
  ties: { reg: { ot: 0, skaters: 3, so: 0 }, po: SUDDEN_DEATH,
    text: 'regular season: no overtime, and a tie stands · playoffs: 20:00 5-on-5 sudden-death periods' },
};

function fail(msg) { throw Object.assign(new Error(msg), { code: 'BAD_REQUEST' }); }

function checkBlock(b, which) {
  if (!b || typeof b !== 'object') fail(`overtime rules: the ${which} block is missing`);
  const ot = b.ot, sk = b.skaters, so = b.so;
  if (!Number.isInteger(ot) || !(ot === 0 || (ot >= 60 && ot <= 1200))) fail(`overtime rules: ${which} overtime is 0 (none) or 1:00 to 20:00`);
  if (![3, 4, 5].includes(sk)) fail(`overtime rules: ${which} overtime is played 3, 4 or 5 skaters a side`);
  if (!Number.isInteger(so) || so < 0 || so > 10) fail(`overtime rules: ${which} shootout rounds are 0 (none) to 10`);
  if (which === 'playoff' && ot === 0) fail('overtime rules: a playoff game needs an overtime (1:00 to 20:00) to be decided');
  return { ot, skaters: sk, so };
}

/** A validated rule set {reg, po} (plain numbers; anything else is refused). */
function normalize(r) {
  if (!r || typeof r !== 'object') fail('overtime rules must be an object with reg and po');
  return { reg: checkBlock(r.reg, 'regular-season'), po: checkBlock(r.po, 'playoff') };
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function seconds(v, key) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(v) || /^(\d{1,4})$/.exec(v);
  if (!m) fail(`${key}= takes a time such as 5:00 (or seconds)`);
  return m[2] !== undefined ? Number(m[1]) * 60 + Number(m[2]) : Number(m[1]);
}
const KEYS = { ot: ['reg', 'ot'], skaters: ['reg', 'skaters'], shootout: ['reg', 'so'], 'playoff-ot': ['po', 'ot'], 'playoff-skaters': ['po', 'skaters'], 'playoff-shootout': ['po', 'so'] };

/** Rules from a preset name and/or key=value settings, applied over `base`. */
function apply(base, words) {
  let r = JSON.parse(JSON.stringify(normalize(base || PRESETS.standard)));
  for (const w of words || []) {
    const word = String(w);
    if (Object.prototype.hasOwnProperty.call(PRESETS, word.toLowerCase())) { const p = PRESETS[word.toLowerCase()]; r = { reg: Object.assign({}, p.reg), po: Object.assign({}, p.po) }; continue; }
    const m = /^([a-z-]+)=(\S+)$/i.exec(word);
    if (!m || !KEYS[m[1].toLowerCase()]) fail(`overtime: ${word.slice(0, 30)} is neither a preset (${Object.keys(PRESETS).join(', ')}) nor a setting (${Object.keys(KEYS).map((k) => k + '=').join(' ')})`);
    const [blk, field] = KEYS[m[1].toLowerCase()];
    r[blk][field] = field === 'ot' ? seconds(m[2], m[1]) : (/^\d{1,2}$/.test(m[2]) ? Number(m[2]) : fail(`${m[1]}= takes a whole number`));
  }
  return normalize(r);
}

function describeBlock(b, playoff) {
  const ot = b.ot ? `${mmss(b.ot)} ${b.skaters}-on-${b.skaters} ${playoff && !b.so ? 'sudden-death periods' : 'overtime'}` : 'no overtime';
  const end = b.so ? `then a shootout of ${b.so} round${b.so === 1 ? '' : 's'}` : playoff ? '' : 'and a tie stands';
  return [ot, end].filter(Boolean).join(', ');
}
function describe(r) {
  const n = normalize(r);
  const name = Object.keys(PRESETS).find((k) => JSON.stringify({ reg: PRESETS[k].reg, po: PRESETS[k].po }) === JSON.stringify(n));
  return `regular season: ${describeBlock(n.reg, false)} · playoffs: ${describeBlock(n.po, true)}${name ? `  (preset ${name})` : ''}`;
}

/* ---- the rules a game is decided by ---- */
const LEGACY_REG = Object.freeze({ ot: 300, skaters: 3, so: 3, repeat: false, cls: 'reg' });
const LEGACY_PO = Object.freeze({ ot: 1200, skaters: 5, so: 0, repeat: true, cls: 'po' });
const memo = new WeakMap();
/** The block that decides this game (a game object; a stage string gives the built-in rules of that stage). */
function block(game) {
  if (typeof game === 'string') return game === 'REGULAR' ? LEGACY_REG : LEGACY_PO;
  if (!game || typeof game !== 'object') return LEGACY_PO;
  if (game.cls) return game;                          // already a block
  let b = memo.get(game);
  if (b) return b;
  if (!game.ot) b = game.stage === 'REGULAR' ? LEGACY_REG : LEGACY_PO;
  else {
    const r = normalize(game.ot); const cls = PLAYOFF_STAGES.has(game.stage) ? 'po' : 'reg';
    b = Object.freeze(Object.assign({}, r[cls], { cls, repeat: cls === 'po' && r[cls].so === 0 }));
  }
  memo.set(game, b);
  return b;
}
const isShootout = (b, p) => b.so > 0 && p === 5;
const periodLength = (b, p) => (p <= 3 ? 1200 : p === 4 ? b.ot : isShootout(b, p) ? 0 : b.repeat ? b.ot : 0);
const maxPeriod = (b) => (b.so > 0 ? 5 : b.repeat ? MAX_PERIOD : b.ot > 0 ? 4 : 3);
/** a period this game can be in: no period 4 when there is no overtime */
const validPeriod = (b, p) => Number.isInteger(p) && p >= 1 && p <= maxPeriod(b) && !(p === 4 && b.ot === 0);
const periodText = (b, p) => (p <= 3 ? 'P' + p : isShootout(b, p) ? 'SO' : b.repeat || p > 4 ? 'OT' + (p - 3) : 'OT');
/** the period NEXT moves to: straight from P3 to the shootout when there is no overtime */
const nextPeriod = (b, p) => (p === 3 && b.ot === 0 && b.so > 0 ? 5 : p + 1);
/** a tie stands when this period ends level: no shootout, no further overtime */
const tieStandsAfter = (b, p) => !b.repeat && b.so === 0 && p >= (b.ot > 0 ? 4 : 3);
/** skaters a side in overtime when fewer than five (0 = the ordinary count) */
const overtimeSkaters = (b, p) => (p >= 4 && !isShootout(b, p) && b.skaters < 5 ? b.skaters : 0);
/**
 * Skaters a side in a short-handed overtime (K a side, K < 5): a penalty takes a skater from the penalized side down
 * to three, then gives the other side one more, up to five; counted on the net penalties (`mine`, `theirs` active).
 * K = 3 is the 3-on-3 rule exactly (4 on 3, then 5 on 3); K = 4 gives 4 on 3, then 5 on 3.
 */
function shortSkaters(K, mine, theirs) {
  const net = mine - theirs;
  if (net > 0) return Math.max(3, K - net);
  return Math.min(5, K + Math.max(0, -net - (K - 3)));
}
/** One line for the scoreboard and the game list: what decides this game if regulation ends tied. */
function summary(b) {
  if (b.repeat) return `${mmss(b.ot)} ${b.skaters}-on-${b.skaters} sudden-death periods`;
  const ot = b.ot ? `${mmss(b.ot)} ${b.skaters}-on-${b.skaters} OT` : 'no OT';
  return `${ot}, ${b.so ? `shootout ${b.so}` : 'tie stands'}`;
}

module.exports = { PRESETS, KEYS, normalize, apply, describe, block, isShootout, periodLength, maxPeriod, validPeriod, periodText, nextPeriod, tieStandsAfter, overtimeSkaters, shortSkaters, summary, mmss };
