'use strict';
/**
 * RINK-VT Game State Actor (spec §3 "Central Server Actor Serialization", §5 models).
 * ---------------------------------------------------------------------------------
 * One actor per game, single-threaded by construction (it lives on the gateway's event loop). The actor is
 * EVENT-SOURCED: its state is a pure fold of the accepted 64-byte frames in ledger order, so
 *   - a new event is applied incrementally (fast path),
 *   - a correction (UNDO, DEL, FIX patches) is appended as its own frame and the state is re-folded,
 *   - a restart replays the SSD-RAM ledger and reaches the identical state (stateDigest()).
 * The Implicit Context Resolution Engine (ICRE) runs inside the fold: clock latching at keystroke onset
 * (piecewise scoreboard history), roster resolution (code, J+jersey, jersey), on-ice context, coordinate
 * resolution (explicit > zone macro > prior), causal chaining (assists to the open goal, automatic FOL/FOW
 * for the opposing centre), penalties with stacking/expiry/PP-goal release, stint slicing, xG with flurry
 * discounting, goalie attribution, plus/minus.
 * Declared rules (documented in docs/RINK-VT.md): rebound ≤ 3.0 s, rush ≤ 4.0 s after a transition event,
 * assist window 15 s of operator time (held open until the next primary event), PP-expiry flag 15 s.
 * REGULAR games play a 5-minute overtime and then a shootout; every other stage plays 20-minute sudden-death
 * overtime periods.
 *
 * Trust boundary: a frame is client-supplied bytes. The actor accepts only what the lexer could have produced
 * (wire.decode is strict; STAT and MODIFIER are checked against the HCL grammar; clock, period, coordinates and
 * assist slots are range-checked), a correction that would leave its event invalid is refused, and a frame whose
 * keystroke time is older than what the game has already seen never rewinds the stint timeline.
 */
const wire = require('../shared/wire');
const hcl = require('../shared/hcl');
const XG = require('../shared/xg');
const hash = require('../shared/hash');

const P_LEN = 1200;                                  // regulation period, seconds
const REB_S = 3.0, RUSH_S = 4.0, ASSIST_NS = 15n * 1000000000n, PPX_S = 15;
const DS_NS = 100000000n;                            // one decisecond in ns (10 Hz scoreboard)

const periodLength = (stage, p) => (p >= 5 && stage === 'REGULAR' ? 0 : p === 4 && stage === 'REGULAR' ? 300 : P_LEN);
const maxPeriod = (stage) => (stage === 'REGULAR' ? 5 : hcl.MAX_PERIOD);
const DEFAULT_MAX_FRAMES = 20000;                    // accepted frames per game (a real game is 1 000 – 2 000)
const CORRECTIONS = new Set(['UND', 'DEL', 'FXP', 'FXS', 'FXC', 'FXA']);
/* "5v4" and friends: one shared string per manpower pair (skaters() stays within 0..7) */
const STRENGTH = Array.from({ length: 9 }, (_, a) => Array.from({ length: 9 }, (__, b) => `${a}v${b}`));
/** a rejection that changed nothing in the fold state (no re-fold needed) */
const pure = (error) => ({ status: 'REJECTED', error, pure: true });
function elapsedOf(stage, period, remainingDs) {
  let e = 0; for (let p = 1; p < period; p++) e += periodLength(stage, p);
  return Math.round((e + (periodLength(stage, period) - remainingDs / 10)) * 10) / 10;
}
const clockText = (ds) => `${Math.floor(ds / 600)}:${String(Math.floor(ds / 10) % 60).padStart(2, '0')}${ds % 10 ? '.' + (ds % 10) : ''}`;
const periodText = (p, stage) => (p <= 3 ? 'P' + p : p === 4 && stage === 'REGULAR' ? 'OT' : p === 5 && stage === 'REGULAR' ? 'SO' : 'OT' + (p - 3));

function freshState(game) {
  const H = game.home, A = game.away;
  const team = () => ({ score: 0, soGoals: 0, trailed: false, led: false });
  return {
    game, version: 0,
    clock: { period: 1, remainingDs: P_LEN * 10, running: false, refNs: 0n, final: false },
    started: null,                                    // the start frame: { atNs, period, remainingDs }; null before the game starts
    clockHistory: [],                                 // [{ atNs, period, remainingDs, running }]
    teams: { [H]: team(), [A]: team() },
    onIce: { [H]: new Set(), [A]: new Set() }, goalie: { [H]: game.starters && game.starters[H] || null, [A]: game.starters && game.starters[A] || null },
    goalieKnown: { [H]: !!(game.starters && game.starters[H]), [A]: !!(game.starters && game.starters[A]) },
    shiftTracked: { [H]: false, [A]: false }, appeared: { [H]: new Set(), [A]: new Set() },
    penalties: [], box: new Set(), ejected: new Set(), penSeq: 0,
    events: [], bySeq: new Map(), seq: 0,
    stints: [], active: null, lastPenaltyExpiryEl: -1e9,
    players: new Map(), goalieGames: new Map(),
    causal: { openGoal: null, flurry: null, lastAttempt: null, recent: [] },
    pendingZone: 'NEU', stoppage: true, lastEl: 0, lastNs: 0n,   // furthest game time (s) and wall time (ns) seen
    entries: [], result: null, notes: []
  };
}

/** One audit row. It points at the decoded frame instead of copying its text, so a replayed game costs little. */
class AuditEntry {
  constructor(f, meta, status, error, ledgerIndex) { this.at = Date.now(); this.f = f || null; this.operator = meta.operator || 'operator'; this.source = meta.source || 'terminal'; this.local = meta.local || null; this.status = status; this.error = error || null; this.ledgerIndex = ledgerIndex === undefined ? null : ledgerIndex; }
  get uuid() { return this.f ? this.f.uuid : null; }
  get lamport() { return this.f ? this.f.lamport : null; }
  get text() { return this.f ? wire.describe(this.f) : '(undecodable)'; }
  get onsetNs() { return this.f ? this.f.onsetNs.toString() : null; }
  get commitNs() { return this.f ? this.f.commitNs.toString() : null; }
  toJSON() { return { at: this.at, uuid: this.uuid, lamport: this.lamport, operator: this.operator, source: this.source, local: this.local, text: this.text, status: this.status, error: this.error, ledgerIndex: this.ledgerIndex, onsetNs: this.onsetNs, commitNs: this.commitNs }; }
}

class GameActor {
  /**
   * @param {object} game     { key, uuid, idHash, home, away, date, stage, season, starters }
   * @param {object} registry { resolvePlayer(team, token) -> player | null, player(pid) }
   * @param {object} [opts]   { maxFrames = 20000 } accepted frames per game; replay is never refused
   */
  constructor(game, registry, opts = {}) {
    this.game = game; this.registry = registry;
    this.maxFrames = opts.maxFrames > 0 ? opts.maxFrames : DEFAULT_MAX_FRAMES;
    this.ledger = [];               // accepted entries: { bytes, f, meta, retracted, index, status, seq }
    this.uuids = new Map();         // command uuid -> accepted ledger entry (idempotency)
    this.audit = [];                // every frame, accepted or rejected (AuditEntry)
    this.nextSeq = 1;               // event numbers are permanent: a retracted event keeps its number (gaps are visible)
    this.version = 0;               // increases with every change of the state and never goes back (cache key)
    this.s = freshState(game);
  }
  _bump() { this.version++; this.s.version = this.version; }

  /* ------------------------------------------------------------------ public API */
  /** Apply one 64-byte frame. meta: { operator, source, receivedNs }. Returns { status, ... }. */
  apply(bytes, meta = {}) {
    let f;
    try { f = wire.decode(bytes); } catch (e) { return this._audit(null, meta, { status: 'REJECTED', error: e.message }); }
    if (!f.crcOk) return this._audit(null, meta, { status: 'REJECTED', error: 'CRC32C mismatch: frame damaged in transit' });
    if (f.bad) return this._audit(f, meta, { status: 'REJECTED', error: `malformed frame: ${f.bad}` });
    if (f.version !== 7) return this._audit(f, meta, { status: 'REJECTED', error: 'command id must be a UUIDv7' });
    if (f.gameHash !== this.game.idHash) return this._audit(f, meta, { status: 'REJECTED', error: `frame belongs to game #${f.gameHash.toString(16)}, not ${this.game.key}` });
    const dup = this.uuids.get(f.uuid);
    if (dup) return this._duplicate(dup);
    if (this.ledger.length >= this.maxFrames && meta.source !== 'replay') return this._audit(f, meta, { status: 'REJECTED', error: `the ledger of ${this.game.key} is full (${this.maxFrames} frames)` });
    const entry = { bytes: Uint8Array.from(bytes), f, meta: { operator: meta.operator || 'operator', source: meta.source || 'terminal', receivedNs: meta.receivedNs || wire.nowNs(), local: meta.local || null }, retracted: false, index: this.ledger.length };
    let res;
    if (f.kind === 'system' && CORRECTIONS.has(f.op)) res = this._correction(entry);
    else {
      res = this._step(this.s, entry, false);
      if (res.status === 'REJECTED') { if (!res.pure) { this._refold(); this._bump(); } }
      else { this.ledger.push(entry); this._bump(); if (res.event_seq) { entry.seq = res.event_seq; this.nextSeq = res.event_seq + 1; } }
    }
    if (res.pure) res = { status: res.status, error: res.error };
    this._audit(f, meta, res, entry);
    if (res.status !== 'REJECTED') { entry.status = res.status; this.uuids.set(f.uuid, entry); }
    return res;
  }
  /** A frame that was already applied: say so, with enough of the original outcome to show the operator. */
  _duplicate(entry) {
    const out = { status: 'DUPLICATE', original: entry.status, text: wire.describe(entry.f) };
    if (entry.seq !== undefined) { out.event_seq = entry.seq; const ev = this.s.bySeq.get(entry.seq); if (ev) out.latched_clock = `${periodText(ev.period, this.game.stage)} ${clockText(ev.clockDs)}`; }
    return out;
  }
  /**
   * Apply the frames of ONE command line atomically (a LINE of five skaters is two frames, a FIX with several
   * keys is one frame per key): if any frame is rejected, the frames of the group that were already accepted are
   * rolled back and every frame reports the rejection. Single frames go straight to apply().
   */
  applyGroup(frames, meta = {}) {
    if (frames.length <= 1) return frames.map((b) => this.apply(b, meta));
    const mark = this.ledger.length, nextSeq = this.nextSeq, results = [];
    for (const b of frames) { const r = this.apply(b, meta); results.push(r); if (r.status === 'REJECTED') break; }
    const bad = results.find((r) => r.status === 'REJECTED');
    if (!bad) return results;
    const undone = this.ledger.splice(mark);
    for (const e of undone) { this.uuids.delete(e.f.uuid); this.audit.push(new AuditEntry(e.f, e.meta, 'ROLLED_BACK', bad.error, null)); }
    this.nextSeq = nextSeq;
    if (undone.length) { this._refold(); this._bump(); }
    return frames.map((_, i) => ({ status: 'REJECTED', error: results[i] && results[i].status === 'REJECTED' ? bad.error : `not applied (the line was rejected: ${bad.error})` }));
  }
  /** Replay accepted frames (ledger recovery) through the same path as live application, so every derived
   *  reference (event numbers, correction targets, latched clocks) is rebuilt exactly as it was. */
  replay(list) {
    const out = { applied: 0, rejected: [] };
    for (const { bytes, meta } of list) {
      const r = this.apply(bytes, Object.assign({ source: 'replay' }, meta || {}));
      if (r.status === 'REJECTED') out.rejected.push(r.error); else out.applied++;
    }
    return out;
  }
  get state() { return this.s; }
  /** Deterministic digest of the derived state (equal after replay). */
  stateDigest() {
    const s = this.s;
    const ev = s.events.map((e) => [e.seq, e.rev, e.void || '', e.team, e.pid, e.stat, e.mod, e.x, e.y, e.period, e.clockDs, e.xg, e.xgF, e.assists.join('|'), e.strength]);
    const st = s.stints.map((t) => [t.period, t.startEl, t.endEl, t.strength, t.zoneStart, t.homeSkaters.join('|'), t.awaySkaters.join('|'), t.home.cf, t.away.cf, Math.round(t.home.xgf * 1e6), Math.round(t.away.xgf * 1e6)]);
    return hash.sha256hex(JSON.stringify({ ev, st, score: [s.teams[this.game.home].score, s.teams[this.game.away].score], clock: [s.clock.period, s.clock.remainingDs, s.clock.final] }));
  }

  /* ------------------------------------------------------------------ corrections: append + refold */
  _correction(entry) {
    const f = entry.f;
    let target = null;
    if (f.op === 'UND') {
      for (let i = this.ledger.length - 1; i >= 0; i--) { const e = this.ledger[i]; if (!e.retracted && e.f.kind === 'event' && e.meta.operator === entry.meta.operator) { target = e; break; } }
      if (!target) return { status: 'REJECTED', error: 'nothing of yours to undo in this game' };
      entry.targetIndex = target.index;
    } else {
      const ev = this.s.bySeq.get(f.seq);
      if (!ev) return { status: 'REJECTED', error: `event #${f.seq} does not exist in ${this.game.key}` };
      entry.targetIndex = ev.ledgerIndex;
      if (f.op === 'FXP' && f.team && f.team !== this.game.home && f.team !== this.game.away) return { status: 'REJECTED', error: `${f.team} is not playing in ${this.game.key}` };
      if (f.op === 'FXS' && f.stat && ['A', 'A1', 'A2', 'IN', 'OUT'].includes(f.stat)) return { status: 'REJECTED', error: 'FIX can change an event into another event, not into an assist or shift; use DEL and re-enter' };
      if (f.op === 'FXS' && f.stat && !Object.prototype.hasOwnProperty.call(hcl.STATS, f.stat)) return { status: 'REJECTED', error: `unknown STAT_TOKEN "${f.stat}"` };
      if (f.op === 'FXA') {
        if (ev.stat !== 'G' || ev.pos === 'G') return { status: 'REJECTED', error: `#${f.seq} is not a goal; assists can only be set on goals` };
        if (f.player) {
          const p = this.registry.resolvePlayer(ev.team, f.player);
          if (!p) return { status: 'REJECTED', error: `${ev.team} ${f.player}: no player with that code or jersey on the ${ev.team} roster` };
          if (p.pid === ev.pid) return { status: 'REJECTED', error: `${p.code} scored goal #${f.seq} and cannot assist it` };
          if (ev.assists[f.slot === 1 ? 1 : 0] === p.pid) return { status: 'REJECTED', error: `${p.code} already has the other assist on #${f.seq}` };
        }
      }
    }
    this.ledger.push(entry);
    const rejected = this._refold();
    // A patch must leave its event valid. If the patched event no longer applies (unknown player, a modifier the
    // new stat does not take, …) the patch is taken back and refused, instead of silently voiding the event.
    if (f.op !== 'UND' && f.op !== 'DEL' && rejected.has(entry.targetIndex)) {
      this.ledger.pop(); this._refold();
      return { status: 'REJECTED', error: `FIX #${f.seq} refused: ${rejected.get(entry.targetIndex)}` };
    }
    this._bump();
    const tgt = this.ledger[entry.targetIndex];
    const ev = this.s.events.find((x) => x.ledgerIndex === entry.targetIndex);
    if (f.op === 'UND') return { status: 'UNDONE', undone: wire.describe(tgt.f), seq: tgt.seq !== undefined ? tgt.seq : null };
    if (f.op === 'DEL') return { status: 'UNDONE', seq: f.seq, deleted: wire.describe(tgt.f) };
    return { status: 'PATCHED', seq: f.seq, revision: ev ? ev.rev : null, now: ev ? ev.text : null, void: ev ? ev.void : null };
  }
  /** Effective entries after corrections: retractions removed, patches applied (each patch bumps the revision). */
  _effective() {
    const patches = new Map(); const retracted = new Set();
    for (const e of this.ledger) {
      if (e.f.kind !== 'system') continue;
      if (e.f.op === 'UND' || e.f.op === 'DEL') retracted.add(e.targetIndex);
      else if (e.f.op && e.f.op.startsWith('FX')) { if (!patches.has(e.targetIndex)) patches.set(e.targetIndex, []); patches.get(e.targetIndex).push(e.f); }
    }
    const out = [];
    for (const e of this.ledger) {
      e.retracted = retracted.has(e.index);
      if (e.f.kind === 'system' && CORRECTIONS.has(e.f.op)) continue;
      if (e.retracted) continue;
      let f = e.f; const ps = patches.get(e.index) || []; let assistOverride = null;
      if (ps.length) {
        f = Object.assign({}, f);
        for (const p of ps) {
          if (p.op === 'FXP') { if (p.team) f.team = p.team; if (p.player) f.player = p.player; }
          else if (p.op === 'FXS') { if (p.stat) f.stat = p.stat; if (!p.keepMod) f.mod = p.mod || ''; }
          else if (p.op === 'FXC') { f.x = p.x; f.y = p.y; }
          else if (p.op === 'FXA') { assistOverride = assistOverride || {}; assistOverride[p.slot] = p.player || ''; }
        }
      }
      out.push({ entry: e, f, rev: 1 + ps.length, assistOverride });
    }
    return out;
  }
  /** Re-fold the whole ledger. Returns Map(ledger index → reason) of the entries that no longer apply. */
  _refold() {
    const s = freshState(this.game);
    const overrides = []; const rejected = new Map();
    for (const x of this._effective()) {
      const r = this._step(s, x.entry, true, x.f, x.rev);
      if (r.status === 'REJECTED') { rejected.set(x.entry.index, r.error); if (s.notes.length < 200) s.notes.push(`ledger #${x.entry.index} (${wire.describe(x.f)}) no longer applies: ${r.error}`); }
      else if (x.assistOverride) overrides.push([x.entry.index, x.assistOverride]);
    }
    // FIX A1=/A2= patches act on the finished goal record, after its own assist frames have bound
    for (const [li, o] of overrides) { const ev = s.events.find((e) => e.ledgerIndex === li); if (ev && ev.stat === 'G') this._applyAssistOverride(s, ev, o); }
    s.version = this.version;
    this.s = s;
    return rejected;
  }

  /* ------------------------------------------------------------------ the fold step */
  _step(s, entry, refolding, fOverride, rev, assistOverride) {
    const f = fOverride || entry.f; let r;
    if (f.kind === 'system') {
      if (f.op === 'CLK') r = this._clock(s, f, entry);
      else if (f.op === 'LIN' || f.op === 'LIA') r = this._line(s, f, entry);
      else return pure('unknown system opcode');
    } else r = this._event(s, f, entry, rev || 1, assistOverride, refolding);
    // the newest wall-clock moment the game knows: keystroke onsets of what was accepted, commit times of clock commands
    if (r.status !== 'REJECTED') { const t = f.kind === 'system' && f.op === 'CLK' ? entry.f.commitNs : entry.f.onsetNs; if (t > s.lastNs) s.lastNs = t; }
    return r;
  }

  /* ---------- scoreboard clock: a piecewise history so every onset can be latched exactly ---------- */
  _clockAt(s, ns) {
    const h = s.clockHistory; let seg = null;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].atNs <= ns) { seg = h[i]; break; }
    if (!seg) seg = h[0] || { atNs: 0n, period: 1, remainingDs: P_LEN * 10, running: false };
    let rem = seg.remainingDs;
    if (seg.running) rem = Math.max(0, seg.remainingDs - Number((ns - seg.atNs) / DS_NS));
    return { period: seg.period, remainingDs: rem };
  }
  _clock(s, f, entry) {
    // A clock command that arrives late (an offline terminal catching up) takes effect at the newest moment the
    // game already knows — the latest clock command or accepted keystroke — never before it. So the clock history
    // stays ordered, and a late STOP cannot rewind the scoreboard under events that were scored meanwhile.
    const h = s.clockHistory; const last = h.length ? h[h.length - 1] : null;
    let at = entry.f.commitNs; if (at < s.lastNs) at = s.lastNs; if (last && at < last.atNs) at = last.atNs;
    const now = this._clockAt(s, at); const c = s.clock; const stage = this.game.stage;
    if (!['set', 'start', 'go', 'stop', 'next', 'end'].includes(f.action)) return pure('unknown clock action');
    if (s.result && f.action !== 'set') return pure('the game is final');
    let period = now.period, rem = now.remainingDs, running = last ? last.running : false;
    if (f.action === 'set') {
      if (f.remainingDs === null || f.remainingDs === undefined) return pure('T needs a clock time');
      if (f.period && f.period > maxPeriod(stage)) return pure(stage === 'REGULAR' ? 'a regular-season game ends with the shootout (SO); there is no later period' : `no period ${f.period}`);
    }
    if (f.action === 'next' && !this._decidedAtPeriodEnd(s, period) && period + 1 > maxPeriod(stage)) return pure(stage === 'REGULAR' ? 'the shootout decides the game; type the attempts, or END' : 'no further overtime period; use END');
    if (f.action === 'end' || (f.action === 'next' && this._decidedAtPeriodEnd(s, period))) {
      this._advance(s, elapsedOf(stage, period, f.action === 'end' ? rem : 0));
      this._closeStint(s, elapsedOf(stage, period, f.action === 'end' ? rem : 0));
      h.push({ atNs: at, period, remainingDs: f.action === 'end' ? rem : 0, running: false });
      Object.assign(c, { period, remainingDs: f.action === 'end' ? rem : 0, running: false, refNs: at });
      this._finalize(s, period <= 3 ? 'REG' : stage === 'REGULAR' && period === 5 ? 'SO' : 'OT');
      return { status: 'APPLIED', clock: 'FINAL', result: s.result };
    }
    // The start frame (START) is the opening faceoff: the clock never runs before it. In a game created under the
    // start-frame rule (game.start === 'frame') GO is refused until START; in a game of an earlier build the first GO
    // starts the game, as it always did, so its ledger replays unchanged.
    if (f.action === 'start') {
      if (s.started) return pure(`the game started at ${periodText(s.started.period, stage)} ${clockText(s.started.remainingDs)}; GO restarts the clock after a stoppage`);
      if (rem <= 0) return pure('the period clock is at 0:00; use T mm:ss first');
      running = true;
    } else if (f.action === 'go' && !s.started && this.game.start === 'frame') return pure('the game has not started: type START at the opening faceoff');
    if (f.action === 'go') { if (rem <= 0) return pure('the period clock is at 0:00; use NEXT or T mm:ss'); running = true; }
    else if (f.action === 'stop') { running = false; s.stoppage = true; }
    else if (f.action === 'set') { rem = f.remainingDs; if (f.period) period = f.period; if (rem > periodLength(stage, period) * 10) rem = periodLength(stage, period) * 10; }
    else if (f.action === 'next') { period = period + 1; rem = periodLength(stage, period) * 10; running = false; }
    const changedPeriod = period !== c.period;
    const el = elapsedOf(stage, period, rem);
    if (changedPeriod) {
      this._advance(s, elapsedOf(stage, c.period, Math.min(c.remainingDs, now.remainingDs)));
      if (period === 5 && stage === 'REGULAR') this._closeStint(s, s.lastEl);
      s.pendingZone = 'NEU'; s.stoppage = true; s.causal.flurry = null;
    }
    // T moved the clock back (a scoreboard correction, or NEXT typed too early): the stint in progress ends where
    // play had reached and a new one starts at the corrected time, so the corrected interval is counted once more
    // only if it is actually played again.
    const back = f.action === 'set' && el < s.lastEl;
    if (back) { this._advance(s, elapsedOf(stage, c.period, Math.min(c.remainingDs, now.remainingDs))); this._closeStint(s, s.lastEl); s.lastEl = el; }
    else if (changedPeriod) this._advance(s, el);     // the earlier period is over: penalties run to its end, and nothing typed late may land before this point
    h.push({ atNs: at, period, remainingDs: rem, running });
    Object.assign(c, { period, remainingDs: rem, running, refNs: at });
    if (!s.started && (f.action === 'start' || f.action === 'go')) s.started = { atNs: at, period, remainingDs: rem };
    if ((changedPeriod && !(period === 5 && stage === 'REGULAR')) || (back && !(stage === 'REGULAR' && period >= 5))) this._rotate(s, el, changedPeriod ? 'NEU' : 'OTF');
    return { status: 'APPLIED', clock: `${periodText(period, stage)} ${clockText(rem)}${running ? ' ▶' : ' ⏸'}${f.action === 'start' ? ' · game started' : ''}` };
  }
  _decidedAtPeriodEnd(s, period) { const H = this.game.home, A = this.game.away; return period >= 3 && period !== 5 && s.teams[H].score !== s.teams[A].score; }
  _checkFinal(s) {
    if (s.result) return;
    const H = this.game.home, A = this.game.away, c = s.clock, reg = this.game.stage === 'REGULAR';
    if (c.period >= 4 && (!reg || c.period === 4) && s.teams[H].score !== s.teams[A].score) return this._finalize(s, 'OT');   // sudden death
    if (reg && c.period >= 5 && s.soRoundsComplete && s.teams[H].soGoals !== s.teams[A].soGoals) return this._finalize(s, 'SO');
    return undefined;
  }
  _finalize(s, decided) {
    const H = this.game.home, A = this.game.away, h = s.teams[H].score, a = s.teams[A].score;
    let winner = h > a ? H : a > h ? A : null;
    if (decided === 'SO' && h === a) winner = s.teams[H].soGoals > s.teams[A].soGoals ? H : s.teams[A].soGoals > s.teams[H].soGoals ? A : null;
    if (!winner) { s.result = { winner: null, loser: null, decidedIn: 'TIE', final: [h, a], comeback: false, margin: 0 }; s.clock.final = true; return; }
    const loser = winner === H ? A : H;
    s.result = { winner, loser, decidedIn: decided, final: [h + (decided === 'SO' && winner === H ? 1 : 0), a + (decided === 'SO' && winner === A ? 1 : 0)], comeback: s.teams[winner].trailed, margin: decided === 'SO' ? 1 : Math.abs(h - a) };
    s.clock.final = true;
  }

  /* ---------- time advance: penalties expire, players return, stints rotate exactly at expiry ---------- */
  _advance(s, el) {
    for (;;) {
      const due = s.penalties.filter((p) => p.active && !p.done && p.endEl <= el).sort((x, y) => x.endEl - y.endEl)[0];
      if (!due) break;
      this._expire(s, due, due.endEl, 'expired');
    }
    if (el > s.lastEl) s.lastEl = el;
  }
  _expire(s, p, atEl, how) {
    p.done = true; p.active = false; p.ended = atEl; p.how = how;
    if (p.segments && p.segIndex === 0 && how !== 'goal') { /* double minor: second half starts */ }
    if (p.next) { const n = p.next; n.active = true; n.startEl = atEl; n.endEl = atEl + n.dur; }
    const stillServing = s.penalties.some((q) => q.pid === p.pid && !q.done && q !== p && (q.active || q.queued));
    if (!stillServing && !p.ejected) {
      s.box.delete(p.pid);
      if (s.shiftTracked[p.team] && !p.misconduct) s.onIce[p.team].add(p.pid);
    }
    this._startQueued(s, p.team, atEl);
    s.lastPenaltyExpiryEl = atEl;
    this._rotate(s, atEl, 'OTF');
  }
  _startQueued(s, team, atEl) {
    const active = s.penalties.filter((q) => q.team === team && q.active && !q.done && q.strength).length;
    if (active >= 2) return;
    const q = s.penalties.find((x) => x.team === team && x.queued && !x.done);
    if (q) { q.queued = false; q.active = true; q.startEl = atEl; q.endEl = atEl + q.dur; }
  }
  activePenalties(s, team) { return s.penalties.filter((p) => p.team === team && p.active && !p.done && p.strength).length; }
  skaters(s, team) {
    const opp = team === this.game.home ? this.game.away : this.game.home;
    const otReg = this.game.stage === 'REGULAR' && s.clock.period === 4;
    const mine = this.activePenalties(s, team), theirs = this.activePenalties(s, opp);
    let n;
    // a tracked team never has fewer than three skaters: an unfinished lineup falls back to the penalty count
    if (s.shiftTracked[team] && s.onIce[team].size >= 3) n = s.onIce[team].size;
    else if (otReg) n = Math.min(5, 3 + Math.max(0, theirs - mine));
    else n = Math.max(3, 5 - Math.min(2, mine));
    if (!(s.shiftTracked[team] && s.onIce[team].size >= 3) && !s.goalie[team] && s.goalieKnown[team]) n += 1;   // goalie pulled: extra attacker
    return n;
  }
  strength(s, team) { const opp = team === this.game.home ? this.game.away : this.game.home; return STRENGTH[this.skaters(s, team)][this.skaters(s, opp)]; }
  situation(s, team) {
    const opp = team === this.game.home ? this.game.away : this.game.home;
    const d = this.activePenalties(s, opp) - this.activePenalties(s, team);
    return d > 0 ? 'PP' : d < 0 ? 'SH' : 'EV';
  }

  /* ---------- stints (home perspective) ---------- */
  _closeStint(s, el) {
    const t = s.active; if (!t) return;
    // never before the stint began, and never before play the game has already seen (a late frame must not
    // cut time out of the stint timeline)
    t.endEl = Math.max(t.startEl, el, s.lastEl);
    if (t.endEl > t.startEl) {
      s.stints.push(t);
      const dur = t.endEl - t.startEl;
      for (const [team, list] of [[this.game.home, t.homeSkaters], [this.game.away, t.awaySkaters]]) {
        const sit = team === this.game.home ? t.homeSit : t.awaySit;
        for (const pid of list) { const b = this._box(s, pid, team); b.toi += dur; b['toi' + sit] += dur; }
        const g = team === this.game.home ? t.homeGoalie : t.awayGoalie; if (g) { const b = this._box(s, g, team); b.toi += dur; }
      }
    }
    s.active = null;
  }
  _rotate(s, el, zone) {
    if (el < s.lastEl) el = s.lastEl;                 // a frame latched in the past rotates lines now, not then
    else s.lastEl = el;
    this._closeStint(s, el);
    if (s.result || (this.game.stage === 'REGULAR' && s.clock.period >= 5)) return;
    const H = this.game.home, A = this.game.away;
    s.active = { id: s.stints.length + 1, period: s.clock.period, startEl: el, endEl: el, strength: this.strength(s, H), homeSit: this.situation(s, H), awaySit: this.situation(s, A),
      homeScoreDiff: s.teams[H].score - s.teams[A].score, zoneStart: zone, ppExpiry: el - s.lastPenaltyExpiryEl <= PPX_S,
      homeSkaters: [...s.onIce[H]].sort(), awaySkaters: [...s.onIce[A]].sort(), homeGoalie: s.goalie[H], awayGoalie: s.goalie[A],
      home: { cf: 0, ff: 0, sf: 0, gf: 0, xgf: 0 }, away: { cf: 0, ff: 0, sf: 0, gf: 0, xgf: 0 } };
  }
  _stintSide(s, team) { if (!s.active) return null; return team === this.game.home ? s.active.home : s.active.away; }

  _box(s, pid, team) {
    let b = s.players.get(pid);
    if (!b) {
      const p = this.registry.player(pid) || {};
      b = { pid, team, code: p.code, name: p.name, pos: p.pos, jersey: p.jersey, gp: 1, g: 0, a1: 0, a2: 0, sog: 0, miss: 0, blk: 0, attBlocked: 0, hits: 0, tk: 0, gv: 0, fow: 0, fol: 0, pim: 0, pm: 0, ixg: 0, ze: 0, zx: 0, fc: 0, omr: 0,
        toi: 0, toiEV: 0, toiPP: 0, toiSH: 0, ppg: 0, shg: 0, gwg: 0, onGF: 0, onGA: 0, penTaken: 0,
        // goalie lines
        sa: 0, ga: 0, sv: 0, fenFaced: 0, xgaFaced: 0, gsax: 0, hdsa: 0, hdsv: 0, mdsa: 0, mdsv: 0, ldsa: 0, ldsv: 0 };
      s.players.set(pid, b);
    }
    return b;
  }

  /* ---------- LINE ---------- */
  _line(s, f, entry) {
    const team = f.team;
    if (team !== this.game.home && team !== this.game.away) return pure(`${team} is not playing in ${this.game.key}`);
    if (s.result) return pure(`${this.game.key} is final (${s.result.decidedIn})`);
    const ps = [];
    for (const tok of f.players) { const p = this.registry.resolvePlayer(team, tok); if (!p) return pure(`${team} ${tok}: no such player`); if (s.ejected.has(p.pid)) return pure(`${team} ${p.code} was ejected from this game`); if (s.box.has(p.pid)) return pure(`${team} ${p.code} is serving a penalty`); ps.push(p); }
    const q = this._quota(s, team, ps); if (q) return pure(q);
    const el = this._latchEl(s, entry.f.onsetNs).el; this._advance(s, el);
    if (f.op === 'LIN') s.onIce[team] = new Set();
    for (const p of ps) { if (p.pos === 'G') { s.goalie[team] = p.pid; s.goalieKnown[team] = true; } else s.onIce[team].add(p.pid); s.appeared[team].add(p.pid); this._box(s, p.pid, team); }
    if (s.onIce[team].size > 6) return { status: 'REJECTED', error: `${team} would have ${s.onIce[team].size} skaters on the ice` };
    s.shiftTracked[team] = true;
    this._rotate(s, el, 'OTF');
    return { status: 'APPLIED', line: `${team} ${[...s.onIce[team]].map((pid) => (this.registry.player(pid) || {}).code).join('-')}`, strength: this.strength(s, this.game.home) };
  }
  _quota(s, team, ps) {
    const q = this.registry.quotas ? this.registry.quotas() : null; if (!q) return null;
    const seasonStart = (this.game.season || 2027) - 1;
    const all = new Map([...s.appeared[team]].map((pid) => [pid, this.registry.player(pid)])); for (const p of ps) all.set(p.pid, p);
    const list = [...all.values()].filter(Boolean);
    const over = list.filter((p) => p.birth && seasonStart - Number(String(p.birth).slice(0, 4)) >= 20);   // 20 by Dec 31 of the season's first year
    if (q.overage && over.length > q.overage) return `quota: ${team} would dress ${over.length} overage (20-year-old) players; the limit is ${q.overage}`;
    const imp = list.filter((p) => p.import);
    if (q.imports && imp.length > q.imports) return `quota: ${team} would dress ${imp.length} import players; the limit is ${q.imports}`;
    return null;
  }

  /* ---------- the ICRE for tri-token events ---------- */
  _latchEl(s, onsetNs) { const c = this._clockAt(s, onsetNs); return { period: c.period, remainingDs: c.remainingDs, el: elapsedOf(this.game.stage, c.period, c.remainingDs) }; }
  _event(s, f, entry, rev, assistOverride, refolding) {
    const g = this.game, team = f.team;
    if (team !== g.home && team !== g.away) return pure(`${team} is not playing in ${g.key} (${g.home} vs ${g.away})`);
    const opp = team === g.home ? g.away : g.home;
    const stat = f.stat;
    const why = hcl.checkMod(stat, f.mod || '');
    if (why) return pure(why);
    const p = this.registry.resolvePlayer(team, f.player);
    if (!p) return pure(`${team} ${f.player}: no player with that code or jersey on the ${team} roster`);
    if (s.result && stat !== 'A' && stat !== 'A1' && stat !== 'A2') return pure(`${g.key} is final (${s.result.decidedIn})`);
    if (s.ejected.has(p.pid) && stat !== 'A' && stat !== 'A1' && stat !== 'A2') return pure(`${team} ${p.code} was ejected from this game`);
    const latch = this._latchEl(s, entry.f.onsetNs);
    const so = g.stage === 'REGULAR' && latch.period === 5;
    // goalie crease set (spec shift_tok "G")
    if (stat === 'G' && p.pos === 'G') return this._shift(s, team, p, 'IN', latch.el, entry);
    if (stat === 'IN' || stat === 'OUT') return this._shift(s, team, p, stat, latch.el, entry);
    if (stat === 'A' || stat === 'A1' || stat === 'A2') return this._assist(s, team, p, stat, entry);
    if (!so) this._advance(s, latch.el);
    if (s.box.has(p.pid) && !['P2', 'P4', 'P5', 'P10', 'P20'].includes(stat)) return { status: 'REJECTED', error: `${team} ${p.code} is in the penalty box` };
    s.appeared[team].add(p.pid);
    const ev = { seq: entry.seq !== undefined ? entry.seq : this.nextSeq, ledgerIndex: entry.index, rev, uuid: entry.f.uuid, operator: entry.meta.operator, team, opp, pid: p.pid, code: p.code, name: p.name, pos: p.pos, stat, mod: f.mod || '',
      period: latch.period, clockDs: latch.remainingDs, elapsed: latch.el, onsetNs: entry.f.onsetNs.toString(), commitNs: entry.f.commitNs.toString(),
      x: null, y: null, coordSource: null, shotType: null, rebound: false, rush: false, royal: false, emptyNet: false, strength: this.strength(s, team), situation: this.situation(s, team),
      xg: 0, xgF: 0, danger: null, goalie: null, assists: [], auto: null, void: null, text: '' };
    // coordinates: explicit > zone macro > prior (shots only)
    const mod = ev.mod; const spot = (mod.match(/[1-9]/) || [])[0];
    if (f.x !== null && f.x !== undefined) { ev.x = f.x; ev.y = f.y; ev.coordSource = 'explicit'; }
    else if (spot) { [ev.x, ev.y] = XG.ZONES[spot]; ev.coordSource = 'zone'; }
    const b = this._box(s, p.pid, team);
    const kind = { G: 'shot', S: 'shot', M: 'shot', B: 'block' }[stat];
    const flags = new Set(mod.replace(/[1-9]/g, '').split(''));
    if (so && kind === 'shot') {
      ev.situation = 'SO';
      if (stat === 'G') { s.teams[team].soGoals++; }
      s.soAttempts = s.soAttempts || { [g.home]: 0, [g.away]: 0 }; s.soAttempts[team]++;
      const ah = s.soAttempts[g.home], aa = s.soAttempts[g.away], sh = s.teams[g.home].soGoals, sa = s.teams[g.away].soGoals;
      if ((ah >= 3 && aa >= 3 && ah === aa && sh !== sa) || (ah <= 3 && aa <= 3 && (sh > sa + (3 - aa) || sa > sh + (3 - ah)))) { s.soRoundsComplete = true; this._checkFinal(s); }
      ev.text = this._text(ev); this._push(s, ev);
      return { status: 'COMMITTED', event_seq: ev.seq, shootout: `${g.home} ${s.teams[g.home].soGoals} – ${g.away} ${s.teams[g.away].soGoals}` };
    }
    if (kind === 'shot') {
      if (!ev.coordSource) { [ev.x, ev.y] = XG.PRIOR; ev.coordSource = 'prior'; }
      ev.shotType = XG.SHOT_NAMES[[...flags].find((c) => XG.SHOT_NAMES[c] && c !== 'R')] || 'WRIST';
      for (const c of 'WSPBT') flags.delete(c);
      ev.royal = flags.has('X');
      const la = s.causal.lastAttempt;
      ev.rebound = flags.has('R') || !!(la && la.team === team && !s.stoppage && la.stat !== 'G' && ev.elapsed - la.elapsed <= REB_S && ev.elapsed >= la.elapsed);
      ev.rush = flags.has('U') || s.causal.recent.some((r) => ev.elapsed - r.elapsed <= RUSH_S && ev.elapsed >= r.elapsed && ((r.team === team && ['ZE', 'ZX', 'TK', 'OMR'].includes(r.stat)) || (r.team === opp && r.stat === 'GV')));
      ev.goalie = s.goalie[opp]; ev.emptyNet = !ev.goalie && s.goalieKnown[opp];
      const m = XG.xg({ x: ev.x, y: ev.y, shotType: ev.shotType, rebound: ev.rebound, rush: ev.rush, royal: ev.royal, strength: ev.strength });
      ev.xg = m.xg; ev.dist = m.dist; ev.angle = m.angle; ev.phi = m.phi;
      const fl = s.causal.flurry;
      if (fl && fl.team === team && !s.stoppage && ev.elapsed - fl.lastEl <= REB_S && ev.elapsed >= fl.lastEl) { ev.xgF = Math.round(ev.xg * fl.survival * 10000) / 10000; fl.survival *= (1 - ev.xg); fl.lastEl = ev.elapsed; fl.n++; ev.flurryIndex = fl.n; }
      else { ev.xgF = ev.xg; s.causal.flurry = { team, survival: 1 - ev.xg, lastEl: ev.elapsed, n: 1 }; ev.flurryIndex = 1; }
      ev.danger = XG.danger({ x: ev.x, y: ev.y, coordSource: ev.coordSource, rebound: ev.rebound, royal: ev.royal });
      b.ixg += ev.xgF;
      if (stat !== 'M') b.sog++; else b.miss++;
      const side = this._stintSide(s, team); if (side) { side.cf++; side.ff++; side.xgf += ev.xgF; if (stat !== 'M') side.sf++; }
      // goalie lines (unblocked attempts faced, spec §5.3)
      if (ev.goalie) {
        const gb = this._box(s, ev.goalie, opp);
        gb.fenFaced++; gb.xgaFaced += ev.xgF; gb.gsax += ev.xgF - (stat === 'G' ? 1 : 0);
        if (stat !== 'M') { gb.sa++; if (stat === 'G') gb.ga++; else gb.sv++; const d = (ev.danger || 'N').toLowerCase()[0]; if (d === 'h' || d === 'm' || d === 'l') { gb[d + 'dsa']++; if (stat !== 'G') gb[d + 'dsv']++; } }
      }
      s.causal.lastAttempt = { team, stat, elapsed: ev.elapsed };
      s.stoppage = false;
      if (stat === 'G') this._goal(s, ev, team, opp, b, latch.el);
    } else if (kind === 'block') {
      b.blk++;
      if (ev.coordSource) ev.coordSource += '-attempt';
      const side = this._stintSide(s, opp); if (side) side.cf++;
      s.causal.lastAttempt = { team: opp, stat: 'B', elapsed: ev.elapsed };
      s.causal.flurry = null;
    } else if (stat === 'FOW' || stat === 'FOL') {
      const winTeam = stat === 'FOW' ? team : opp;
      let z = (mod.match(/[ODN]/) || [])[0];
      if (!z && ev.coordSource) z = ev.x > 25 ? 'O' : ev.x < -25 ? 'D' : 'N';
      if (!z) z = s.pendingZone === 'NEU' ? 'N' : s.pendingZone === team ? 'D' : s.pendingZone === opp ? 'O' : 'N';
      ev.zone = z;
      if (stat === 'FOW') b.fow++; else b.fol++;
      // causal inference: the opposing centre gets the complementary result
      const oc = [...s.onIce[opp]].map((pid) => this.registry.player(pid)).find((q) => q && q.pos === 'C');
      if (oc) { const ob = this._box(s, oc.pid, opp); if (stat === 'FOW') ob.fol++; else ob.fow++; ev.auto = { pid: oc.pid, code: oc.code, stat: stat === 'FOW' ? 'FOL' : 'FOW' }; }
      ev.faceoffWinner = winTeam;
      const homeZone = (team === g.home) ? z : (z === 'O' ? 'D' : z === 'D' ? 'O' : 'N');
      this._rotate(s, latch.el, homeZone === 'O' ? 'OFF' : homeZone === 'D' ? 'DEF' : 'NEU');
      s.stoppage = false; s.causal.flurry = null;
    } else if (/^P(2|4|5|10|20)$/.test(stat)) {
      this._penalty(s, ev, team, opp, p, b, latch.el);
    } else {
      if (stat === 'H') b.hits++; else if (stat === 'TK') b.tk++; else if (stat === 'GV') b.gv++; else if (stat === 'ZE') b.ze++; else if (stat === 'ZX') b.zx++; else if (stat === 'FC') b.fc++; else if (stat === 'OMR') b.omr++;
      if (stat === 'ZE' || stat === 'ZX') ev.entry = (mod.match(/[CDF]/) || [])[0] || null;
      if (stat === 'TK' || stat === 'GV') s.causal.flurry = null;
    }
    s.causal.recent.push({ team, stat, elapsed: ev.elapsed, seq: ev.seq, entry: ev.entry }); if (s.causal.recent.length > 8) s.causal.recent.shift();
    if (stat !== 'G') s.causal.openGoal = s.causal.openGoal && s.causal.openGoal.assistsAllowed ? Object.assign(s.causal.openGoal, { closedByEvent: true }) : null;
    ev.text = this._text(ev);
    this._push(s, ev);
    const res = { status: 'COMMITTED', event_seq: ev.seq, latched_clock: `${periodText(ev.period, g.stage)} ${clockText(ev.clockDs)}`, team, player: p.name, code: p.code, stat, score: `${g.home} ${s.teams[g.home].score} – ${g.away} ${s.teams[g.away].score}`, strength: ev.strength };
    if (kind === 'shot') Object.assign(res, { coords: [ev.x, ev.y], coord_source: ev.coordSource, xg: ev.xg, flurry_adj_xg: ev.xgF, danger: ev.danger, rebound: ev.rebound, rush: ev.rush });
    if (ev.auto) res.auto = `${opp} ${ev.auto.code} ${ev.auto.stat}`;
    if (ev.penalty) res.penalty = ev.penalty;
    return res;
  }
  _push(s, ev) { s.events.push(ev); s.bySeq.set(ev.seq, ev); }
  _text(ev) { return `${ev.team} ${ev.code} ${ev.stat}${ev.mod ? '/' + ev.mod : ''}${ev.coordSource === 'explicit' ? `/${ev.x},${ev.y}` : ''}`; }
  _goal(s, ev, team, opp, b, el) {
    const g = this.game; b.g++;
    if (ev.situation === 'PP') b.ppg++; else if (ev.situation === 'SH') b.shg++;
    s.teams[team].score++;
    const ts = s.teams[team], os = s.teams[opp];
    if (ts.score > os.score) ts.led = true; if (os.score > ts.score) os.trailed = true;
    if (ts.score < os.score) ts.trailed = true;
    const side = this._stintSide(s, team); if (side) side.gf++;
    // plus/minus: not awarded for power-play goals (EV and SH goals count; empty-net goals count)
    const onFor = [...s.onIce[team]], onAg = [...s.onIce[opp]];
    for (const pid of onFor) { const x = this._box(s, pid, team); x.onGF++; if (ev.situation !== 'PP') x.pm++; }
    for (const pid of onAg) { const x = this._box(s, pid, opp); x.onGA++; if (ev.situation !== 'PP') x.pm--; }
    // a power-play goal ends the earliest-expiring releasable minor of the short-handed team
    if (ev.situation === 'PP') {
      const pen = s.penalties.filter((p) => p.team === opp && p.active && !p.done && p.releasable).sort((a, c) => a.endEl - c.endEl)[0];
      if (pen) { ev.releasedPenalty = pen.id; this._expire(s, pen, el, 'goal'); }
    }
    s.causal.openGoal = { seq: ev.seq, team, commitNs: BigInt(ev.commitNs), assists: 0, assistsAllowed: true, closedByEvent: false };
    s.stoppage = true; s.causal.flurry = null; s.pendingZone = 'NEU';
    this._rotate(s, el, 'NEU');
    if (g.stage === 'REGULAR' ? s.clock.period === 4 : s.clock.period >= 4) this._checkFinal(s);
  }
  _penalty(s, ev, team, opp, p, b, el) {
    const minutes = Number(ev.stat.slice(1));
    b.pim += minutes; b.penTaken++;
    const infr = (ev.mod.match(/[A-Z]{2,4}/) || [])[0] || null;
    const base = { team, pid: p.pid, infraction: infr, startEl: el };
    const mk = (dur, o) => Object.assign({ id: ++s.penSeq, dur, done: false, active: false, queued: false }, base, o);
    const list = [];
    if (minutes === 2) list.push(mk(120, { strength: true, releasable: true, kind: 'minor' }));
    else if (minutes === 4) { const a = mk(120, { strength: true, releasable: true, kind: 'double-minor' }); const c = mk(120, { strength: true, releasable: true, kind: 'double-minor', second: true }); a.next = c; list.push(a, c); }
    else if (minutes === 5) list.push(mk(300, { strength: true, releasable: false, kind: 'major' }));
    else if (minutes === 10) list.push(mk(600, { strength: false, releasable: false, kind: 'misconduct', misconduct: true }));
    else list.push(mk(0, { strength: false, releasable: false, kind: 'game-misconduct', ejected: true, misconduct: true }));
    for (const x of list) {
      s.penalties.push(x);
      if (x.second) continue;                                    // starts when the first half ends
      if (!x.strength) { x.active = true; x.endEl = x.ejected ? Infinity : el + x.dur; continue; }
      if (this.activePenalties(s, team) >= 2) x.queued = true; else { x.active = true; x.endEl = el + x.dur; }
    }
    for (const x of list) if (x.ejected) { x.active = false; x.done = true; }
    s.box.add(p.pid); if (list.some((x) => x.ejected)) s.ejected.add(p.pid);   // fold state, never the registry's player record
    if (s.onIce[team].has(p.pid)) s.onIce[team].delete(p.pid);
    ev.penalty = `${minutes} min${infr ? ' ' + infr : ''}${list[0].queued ? ' (queued: two already serving)' : ''}`;
    s.stoppage = true; s.causal.flurry = null; s.pendingZone = list[0].strength ? team : s.pendingZone;
    if (list[0].strength) this._rotate(s, el, team === this.game.home ? 'DEF' : 'OFF');
  }
  _shift(s, team, p, what, el, entry) {
    if (what === 'IN' && s.ejected.has(p.pid)) return pure(`${team} ${p.code} was ejected from this game`);
    this._advance(s, el);
    if (p.pos === 'G') {
      if (what === 'IN') { s.goalie[team] = p.pid; } else if (s.goalie[team] === p.pid) s.goalie[team] = null;
      s.goalieKnown[team] = true;
    } else {
      if (what === 'IN') {
        if (s.box.has(p.pid)) return { status: 'REJECTED', error: `${team} ${p.code} is serving a penalty` };
        const q = this._quota(s, team, [p]); if (q) return { status: 'REJECTED', error: q };
        if (s.onIce[team].size >= 6) return { status: 'REJECTED', error: `${team} already has ${s.onIce[team].size} skaters on the ice` };
        s.onIce[team].add(p.pid);
      } else s.onIce[team].delete(p.pid);
      s.shiftTracked[team] = true;
    }
    s.appeared[team].add(p.pid); this._box(s, p.pid, team);
    this._rotate(s, el, 'OTF');
    void entry;
    return { status: 'SHIFT_UPDATED', team, player: p.name, code: p.code, action: what, on_ice: s.onIce[team].size, goalie: s.goalie[team] ? (this.registry.player(s.goalie[team]) || {}).code : null, strength: this.strength(s, this.game.home) };
  }
  _assist(s, team, p, stat, entry) {
    const og = s.causal.openGoal;
    if (!og) return pure('no open goal to bind this assist to');
    const ev = s.bySeq.get(og.seq);
    if (!ev || ev.void) return pure('the open goal is no longer valid');
    if (og.team !== team) return pure(`the open goal (#${og.seq}) belongs to ${og.team}`);
    const withinWindow = entry.f.onsetNs - og.commitNs <= ASSIST_NS || !og.closedByEvent;
    if (!withinWindow) return pure(`assist window closed for goal #${og.seq}; use FIX ${og.seq} A1=<player>`);
    if (p.pid === ev.pid) return pure(`${p.code} scored goal #${og.seq} and cannot assist it`);
    if (ev.assists.includes(p.pid)) return pure(`${p.code} already has an assist on #${og.seq}`);
    let slot = stat === 'A1' ? 0 : stat === 'A2' ? 1 : ev.assists.length;
    if (slot > 1 || ev.assists[slot]) return pure(`goal #${og.seq} already has ${slot === 0 ? 'a primary' : 'two'} assist${slot === 0 ? '' : 's'}`);
    if (slot === 1 && !ev.assists[0]) slot = 1;
    ev.assists[slot] = p.pid; ev.rev++;
    const b = this._box(s, p.pid, team); if (slot === 0) b.a1++; else b.a2++;
    s.appeared[team].add(p.pid);
    og.assists++; if (og.assists >= 2) s.causal.openGoal = null;
    ev.text = this._text(ev);
    return { status: 'CAUSALLY_CHAINED', chained_to_event_seq: ev.seq, assist_slot: slot === 0 ? 'PRIMARY_ASSIST' : 'SECONDARY_ASSIST', player: p.name, code: p.code, new_revision: ev.rev };
  }
  _applyAssistOverride(s, ev, o) {
    for (const slot of [1, 2]) {
      if (!(slot in o)) continue;
      const prev = ev.assists[slot - 1]; if (prev) { const b = s.players.get(prev); if (b) b[slot === 1 ? 'a1' : 'a2']--; }
      ev.assists[slot - 1] = undefined;
      if (o[slot]) { const p = this.registry.resolvePlayer(ev.team, o[slot]); if (p) { ev.assists[slot - 1] = p.pid; const b = this._box(s, p.pid, ev.team); b[slot === 1 ? 'a1' : 'a2']++; } }
    }
    while (ev.assists.length && ev.assists[ev.assists.length - 1] === undefined) ev.assists.pop();
    ev.rev++; ev.text = this._text(ev);
  }

  /* ------------------------------------------------------------------ audit */
  _audit(f, meta, res, entry) {
    this.audit.push(new AuditEntry(f, meta, res.status, res.error, entry && res.status !== 'REJECTED' ? entry.index : null));
    if (this.audit.length > 24000) this.audit.splice(0, this.audit.length - 20000);
    return res;
  }
  /** The last n audit rows as plain objects (what Q AUDIT shows). */
  auditView(n = 20) { return this.audit.slice(-Math.max(1, Math.min(500, Math.floor(n) || 20))).map((a) => a.toJSON()); }

  /* ------------------------------------------------------------------ views */
  /** Close the open stint at the current clock (for live TOI and RAPM over a game in progress). */
  liveStints() {
    const s = this.s; const out = s.stints.slice();
    if (s.active) { const now = this._latchEl(s, wire.nowNs()).el; if (now > s.active.startEl) out.push(Object.assign({}, s.active, { endEl: now, live: true })); }
    return out;
  }
  scoreboard() {
    const s = this.s, g = this.game, c = s.clock, H = g.home, A = g.away;
    const pens = s.penalties.filter((p) => p.active && !p.done && p.strength).map((p) => ({ id: p.id, team: p.team, code: (this.registry.player(p.pid) || {}).code, kind: p.kind, infraction: p.infraction, endEl: p.endEl, startEl: p.startEl }));
    return { key: g.key, home: H, away: A, score: { [H]: s.teams[H].score, [A]: s.teams[A].score }, shootout: { [H]: s.teams[H].soGoals, [A]: s.teams[A].soGoals },
      period: c.period, periodText: periodText(c.period, g.stage), remainingDs: c.remainingDs, running: c.running, refNs: c.refNs.toString(), periodLength: periodLength(g.stage, c.period),
      started: !!this.s.started, startRule: g.start === 'frame' ? 'frame' : null,
      strength: this.strength(s, H), situation: { [H]: this.situation(s, H), [A]: this.situation(s, A) }, penalties: pens, final: s.result, events: s.events.length, ledger: this.ledger.length, version: this.version,
      goalies: { [H]: s.goalie[H] ? (this.registry.player(s.goalie[H]) || {}).code : null, [A]: s.goalie[A] ? (this.registry.player(s.goalie[A]) || {}).code : null },
      onIce: { [H]: [...s.onIce[H]].map((pid) => (this.registry.player(pid) || {}).code), [A]: [...s.onIce[A]].map((pid) => (this.registry.player(pid) || {}).code) } };
  }
}

module.exports = { GameActor, AuditEntry, elapsedOf, clockText, periodText, periodLength, maxPeriod, DEFAULT_MAX_FRAMES };
