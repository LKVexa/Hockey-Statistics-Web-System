'use strict';
/**
 * Line driver: the same path a terminal takes — parse with the shared HCL lexer, compile to 64-byte frames,
 * hand the frames to the game's actor. Used by the simulator, the tests and the gateway's in-process sessions.
 */
const hcl = require('../shared/hcl');
const wire = require('../shared/wire');

class Driver {
  constructor({ operator = 'operator', locale = 'en-CA', source = 'driver' } = {}) { this.operator = operator; this.locale = locale; this.source = source; this.lamport = 0; this.clockNs = null; }
  /** Use a synthetic wall clock (ns) instead of real time, e.g. for simulations: driver.at(ns). */
  at(ns) { this.clockNs = BigInt(ns); return this; }
  tick(ms) { if (this.clockNs !== null) this.clockNs += BigInt(Math.round(ms * 1e6)); return this; }
  frames(line, game) {
    const ast = hcl.parseLine(line, { locale: this.locale });
    if (!['event', 'undo', 'del', 'fix', 'line', 'clock'].includes(ast.kind)) return { ast, frames: [] };
    const onset = this.clockNs !== null ? this.clockNs : wire.nowNs();
    const commit = this.clockNs !== null ? this.clockNs + 600000000n : wire.nowNs();
    if (this.clockNs !== null) this.clockNs = commit + 100000000n;     // typing takes ~0.6 s, then the next line starts
    const frames = wire.compile(ast, { gameHash: game.idHash, lamport: this.lamport + 1, onsetNs: onset, commitNs: commit });
    this.lamport += frames.length;
    return { ast, frames };
  }
  /** Parse + frame + apply. Returns { ast, results: [...] }. */
  run(actor, line) {
    const { ast, frames } = this.frames(line, actor.game);
    if (ast.kind === 'error') return { ast, results: [{ status: 'REJECTED', error: ast.message }] };
    const results = actor.applyGroup(frames, { operator: this.operator, source: this.source });
    return { ast, frames, results };
  }
}
module.exports = { Driver };
