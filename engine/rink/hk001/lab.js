'use strict';
/**
 * HK001 lab for the terminal: one working case per session, evaluated through the exact HK001 port with a
 * full trace, and rendered for any of the 563 computation codes and 109 input codes.
 *
 *   const lab = new Lab();            lab.case            the working case (an HK001 request + provenance)
 *   lab.receipt()                     receipt + trace for the working case (cached until the case changes)
 *   lab.value(code)                   { value, kind, disposition, … } for a computation or input code
 *   lab.renderCode(code, opts)        the terminal card for a code
 */
const crypto = require('node:crypto');
const engine = require('./engine');
const adapter = require('./adapter');
const inputs = require('./inputs');
const catalog = require('./catalog');
const gomath = require('./gomath');
const fmt = require('../shared/fmt');

const GO_DEMO_SHA = 'faa8e35ac4dbbca744825760a6b05473d0cf6c8505c94e57baeee463cad9aab1';   // HK001-MSSL-CLI demo, release/VALIDATION_REPORT.json
const STAGE_NAME = { EQ: 'hockey equation', ML: 'Master Law', X8S: 'Extrapolation 1 (X8S)', SP8: 'Extrapolation 2 (8Sphere)', SUM: 'receipt' };
const DISP_COLOR = { PASS: 'green', QUALIFIED: 'cyan', FAIL: 'red' };

/* Field names are data (Go: map[string]float64). A case's maps therefore have no prototype: a field an operator or a
   file calls "constructor", "toString" or "__proto__" is a field like any other, and a name that was never set is
   simply absent. */
const bare = (o) => Object.assign(Object.create(null), o || {});
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function sealCase(c) {
  c.request.values = bare(c.request.values); c.request.calibration = bare(c.request.calibration);
  c.prov = bare(c.prov); c.replaced = bare(c.replaced); c.notes = c.notes || [];
  return c;
}
function baselineCase() {
  const r = engine.defaultRequest();
  return sealCase({ name: 'HK001 baseline (synthetic demo)', source: 'baseline', request: r, prov: Object.fromEntries(Object.keys(r.values).map((k) => [k, 'BASELINE'])), notes: [] });
}
function cloneCase(c) { return sealCase({ name: c.name, source: c.source, request: JSON.parse(JSON.stringify(c.request)), prov: bare(c.prov), notes: (c.notes || []).slice(), replaced: JSON.parse(JSON.stringify(c.replaced || {})) }); }

class Lab {
  constructor() { this.case = baselineCase(); this._cache = null; this.rev = 0; }
  _touch() { this.rev++; this._cache = null; }
  /* -------- working case -------- */
  setBaseline() { this.case = baselineCase(); this._touch(); return this.case; }
  setCase(c) { this.case = sealCase(c); this._touch(); return c; }
  /** From the RINK bridge payload { name, request, prov, notes } */
  fromBridge(payload) {
    const r = Object.assign(engine.defaultRequest(), { case_id: payload.request.case_id, description: payload.request.description, input_mode: payload.request.input_mode || 'overlay_baseline', synthetic_fixture: !!payload.request.synthetic_fixture, values: payload.request.values, calibration: payload.request.calibration || {} });
    return this.setCase({ name: payload.name, source: payload.source || 'rink', request: r, prov: payload.prov || {}, notes: payload.notes || [] });
  }
  fromFile(name, bytes, index) {
    const reqs = adapter.loadBytes(name, bytes);
    // the record is the one that was asked for, or the load is refused: never a neighbour, silently
    const n = index === undefined || index === null || index === '' ? 1 : (typeof index === 'number' ? index : (/^\d{1,9}$/.test(String(index)) ? Number(index) : NaN));
    if (!Number.isInteger(n) || n < 1 || n > reqs.length) throw new Error(`record ${index === true ? '(no number given)' : String(index).slice(0, 24)}: ${reqs.length === 1 ? 'the file has one record' : `the file has records 1 to ${reqs.length}`}`);
    const i = n - 1;
    const r = reqs[i];
    const prov = Object.create(null); for (const k of Object.keys(r.values)) prov[k] = 'FILE';
    return { c: this.setCase({ name: `${name} record ${i + 1}/${reqs.length}`, source: 'file:' + name, request: r, prov, notes: [] }), count: reqs.length };
  }
  set(field, value) {
    const inp = inputs.resolve(field);
    const key = inp ? inp.field : field;
    if (!Number.isFinite(value)) throw new Error(`${field}: value must be a finite number`);
    // remember what the operator replaced, so unset() restores the case's own value (baseline, ledger or file)
    if (!(key in this.case.replaced)) this.case.replaced[key] = { present: key in this.case.request.values, value: this.case.request.values[key], prov: this.case.prov[key] };
    this.case.request.values[key] = value; this.case.prov[key] = 'OPERATOR'; this._touch();
    return inp || { field: key, code: '(unlisted)', label: 'field not read by HK001' };
  }
  unset(field) {
    const inp = inputs.resolve(field); const key = inp ? inp.field : field; const r = this.case.replaced && this.case.replaced[key];
    if (r) { if (r.present) { this.case.request.values[key] = r.value; this.case.prov[key] = r.prov; } else { delete this.case.request.values[key]; delete this.case.prov[key]; } delete this.case.replaced[key]; }
    else if (this.case.request.input_mode === 'strict_complete' && own(engine.BASELINE, key)) { this.case.request.values[key] = engine.BASELINE[key]; this.case.prov[key] = 'BASELINE'; }
    else { delete this.case.request.values[key]; delete this.case.prov[key]; }
    this._touch(); return key;
  }
  setMode(m) { const v = /^s/i.test(m) ? 'strict_complete' : 'overlay_baseline'; this.case.request.input_mode = v; this._touch(); return v; }
  setCal(k, v) { this.case.request.calibration[k] = v; this._touch(); }
  /* -------- evaluation -------- */
  receipt(c) {
    // allowNaN: a case with zero denominators (e.g. one game in progress) still evaluates every code; it just has no
    // canonical receipt, exactly as the Go CLI cannot serialise it (see engine.analyze).
    if (c) return engine.analyze(cloneCase(c).request, { trace: true, allowNaN: true });
    if (!this._cache) this._cache = engine.analyze(cloneCase(this.case).request, { trace: true, allowNaN: true });
    return this._cache;
  }
  value(code, rc) {
    rc = rc || this.receipt();
    const inp = inputs.byCode.get(String(code).toUpperCase()) || inputs.byField.get(code);
    if (inp) {
      const v = rc.normalizedRequest.values[inp.field];
      const defaulted = (rc.normalizedRequest._prov.defaulted_fields || []).includes(inp.field);
      return { kind: 'input', code: inp.code, value: v === undefined ? null : v, prov: defaulted ? 'BASELINE_OVERLAY' : (this.case.prov[inp.field] || 'CASE'), meta: inp };
    }
    const m = catalog.resolve(code); if (!m) return null;
    const base = { kind: 'computation', code: m.code, meta: m };
    if (m.stage === 'EQ') { const row = rc.conventional_equations.find((x) => x.equation_id === m.code); return Object.assign(base, { value: row.value, disposition: row.lab_disposition, reasons: row.reason_codes }); }
    if (m.published) {
      const list = m.stage === 'ML' ? rc.master_law_models : m.stage === 'X8S' ? rc.master_law_extrapolations : rc.sphere_parlay_extrapolations;
      const row = (list || []).find((x) => x.model_id === m.code);
      return Object.assign(base, row ? { value: row.value, disposition: row.lab_disposition, evidence: row.evidence_class, unit: row.unit } : { value: null, disposition: 'NOT_COMPUTED', reasons: [m.stage === 'ML' ? rc.master_law_summary.admission : m.stage === 'X8S' ? rc.extrapolation_summary.admission : rc.sphere_parlay_summary.admission] });
    }
    if (m.stage === 'SUM') return Object.assign(base, this._summary(m.code, rc));
    const t = rc.trace || {};
    return Object.assign(base, m.code in t ? { value: t[m.code], disposition: 'TRACED' } : { value: null, disposition: 'NOT_COMPUTED', reasons: [rc.master_law_summary.admission] });
  }
  _summary(code, rc) {
    const ms = rc.master_law_summary, xs = rc.extrapolation_summary, ps = rc.sphere_parlay_summary, cs = rc.conventional_summary;
    switch (code) {
      case 'HK-GATE': return { value: rc.reasons.length ? 'FAIL' : 'PASS', reasons: rc.reasons.length ? rc.reasons : ['ALL_MANDATORY_RELATIONS_HOLD'] };
      case 'HK-CONV': return { value: `${cs.pass} PASS / ${cs.qualified} QUALIFIED / ${cs.fail} FAIL` };
      case 'HK-ETA': return { value: ms.eta_ind, reasons: [`ε_ind ${ms.epsilon_ind}`, ms.eta_ind >= ms.epsilon_ind ? 'MEETS_FLOOR' : 'BELOW_FLOOR'] };
      case 'HK-D8S': return { value: ms.delta_8s, reasons: [`ε_gain ${ms.epsilon_gain}`, ms.delta_8s >= ms.epsilon_gain ? 'MEETS_FLOOR' : 'BELOW_FLOOR'] };
      case 'HK-MATCH': return { value: ms.matchup_class };
      case 'HK-ML': return { value: ms.admission };
      case 'HK-X8S': return { value: `${xs.admission} · ${xs.decision_class}` };
      case 'HK-SP8': return { value: `${ps.admission} · ${ps.decision_class}` };
      case 'HK-DISP': return { value: rc.overall_disposition };
      case 'HK-SHA': return rc.unserializable ? { value: null, disposition: 'NO_RECEIPT', reasons: [`${rc.unserializable.length} non-finite values (zero denominators); Go's encoding/json cannot serialise NaN, so HK001 issues no receipt for this case`] } : { value: rc.canonical_sha256 };
      default: return { value: null };
    }
  }
  /* -------- rendering -------- */
  renderCode(code, o = {}) {
    const color = o.color !== false; const c = fmt.paint(color); const W = o.width || 100;
    const rc = o.receipt || this.receipt();
    const v = this.value(code, rc);
    if (!v) return null;
    if (v.kind === 'input') return this.renderInput(v.code, o);
    const m = v.meta; const out = [];
    const disp = v.disposition || '';
    out.push(`${c('bold', c('cyan', m.code))}  ${c('ice', m.label)}  ${c('grey', '· ' + STAGE_NAME[m.stage] + (m.family ? ' · ' + m.family : '') + (m.published ? '' : ' · intermediate'))}`);
    const rows = [];
    if (m.symbol) rows.push(['symbol', m.symbol]);
    rows.push(['formula', fmt.wrap(m.formula, W - 14).trimStart()]);
    if (m.catalogFormula && m.catalogFormula !== m.formula) rows.push(['catalog', m.catalogFormula]);
    const val = typeof v.value === 'number' ? fmt.num(v.value) : (v.value === null ? '—' : String(v.value));
    rows.push(['value', c('bold', val) + (m.unit || v.unit ? c('grey', '  ' + (m.unit || v.unit)) : '')]);
    if (m.bounds && (Number.isFinite(m.bounds[0]) || Number.isFinite(m.bounds[1]))) rows.push(['bounds', `[${Number.isFinite(m.bounds[0]) ? m.bounds[0] : '-∞'}, ${Number.isFinite(m.bounds[1]) ? m.bounds[1] : '+∞'}]`]);
    if (disp) rows.push(['disposition', c(DISP_COLOR[disp] || 'grey', disp) + (v.reasons ? c('grey', '  ' + v.reasons.join(', ')) : '') + (v.evidence ? c('grey', '  ' + v.evidence) : '') + (m.status ? c('grey', '  ' + m.status) : '')]);
    rows.push(['case', `${fmt.plain(this.case.name)}  ${c('grey', fmt.plain(rc.input_provenance.input_mode))}`]);
    out.push(fmt.kv(rows, { color, keyWidth: 12 }));
    if (m.deps.length) {
      const depRows = m.deps.slice(0, o.all ? 999 : 24).map((d) => {
        const dv = this.value(d, rc); const dm = dv ? dv.meta : null;
        const label = dv && dv.kind === 'input' ? `${dm.field} · ${dm.label}` : (dm ? dm.label : '');
        const dval = dv ? (typeof dv.value === 'number' ? fmt.num(dv.value) : String(dv.value)) : '—';
        return [c(dv && dv.kind === 'input' ? 'amber' : 'teal', d), label, dval, dv && dv.kind === 'input' ? c('grey', dv.prov) : c('grey', dv && dv.disposition || '')];
      });
      out.push('', c('grey', `reads ${m.deps.length} code${m.deps.length > 1 ? 's' : ''}`) + (m.deps.length > depRows.length ? c('grey', ` (first ${depRows.length}; --all for every one)`) : ''));
      out.push(fmt.table([{ h: 'code' }, { h: 'what', max: 52 }, { h: 'value', align: 'r', max: 22 }, { h: 'source' }], depRows, { color, width: W }));
    }
    const users = catalog.dependents.get(m.code) || [];
    if (users.length) out.push('', c('grey', 'used by  ') + users.slice(0, 16).join(' ') + (users.length > 16 ? c('grey', ` … +${users.length - 16}`) : ''));
    const plate = catalog.PLATES.get(m.plate || m.code);
    if (plate) {
      out.push('', c('grey', `corpus plate · page ${plate.page} · ${plate.section}`), c('orange', plate.equation));
      out.push(fmt.wrap(o.plate ? plate.explanation : plate.explanation.split('. ').slice(0, 2).join('. ') + '.', W, '  '));
      if (o.plate) for (const k of ['discussion', 'purpose', 'implications', 'application']) out.push('', c('grey', k.toUpperCase()), fmt.wrap(plate[k], W, '  '));
      else out.push(c('grey', `  full plate: corpus ${plate.id}`));
    }
    return out.join('\n');
  }
  renderInput(code, o = {}) {
    const color = o.color !== false; const c = fmt.paint(color); const W = o.width || 100;
    const rc = o.receipt || this.receipt();
    const v = this.value(code, rc); if (!v || v.kind !== 'input') return null;
    const m = v.meta;
    const out = [`${c('bold', c('amber', m.code))}  ${c('ice', m.label)}  ${c('grey', '· input · ' + m.family + ' · ' + m.scope)}`];
    out.push(fmt.kv([
      ['mnemonic', m.field], ['value', c('bold', fmt.num(v.value)) + c('grey', '  ' + m.unit)], ['source', v.prov],
      ['baseline', fmt.num(engine.BASELINE[m.field]) + c('grey', '  (HK001 synthetic baseline, 82-game season)')],
      ['terminal', (m.tokens.length ? m.tokens.map((t) => c('cyan', t)).join(' ') + c('grey', '  ·  ') : '') + m.rink],
      ['derivation', m.cls], ['case', fmt.plain(this.case.name)]
    ], { color, keyWidth: 12 }));
    const users = catalog.dependents.get(m.code) || [];
    if (users.length) out.push('', c('grey', `read by ${users.length} computation${users.length > 1 ? 's' : ''}  `) + users.slice(0, 24).join(' ') + (users.length > 24 ? c('grey', ` … +${users.length - 24}`) : ''));
    out.push('', c('grey', `set it:  ${m.code} <value>    or    case set ${m.field}=<value>`));
    void W;
    return out.join('\n');
  }
  renderSummary(o = {}) {
    const color = o.color !== false; const c = fmt.paint(color); const W = o.width || 100;
    const rc = o.receipt || this.receipt();
    const ms = rc.master_law_summary, xs = rc.extrapolation_summary, ps = rc.sphere_parlay_summary, cs = rc.conventional_summary;
    const dc = DISP_COLOR[rc.overall_disposition] || 'grey';
    const defaulted = (rc.normalizedRequest._prov.defaulted_fields || []).length;
    const lines = [
      `${c('bold', 'HK001 MSSL 2.3.0')}  ${c('grey', '8Sphere Hockey Extrapolator · JS port, Go-exact')}  ${c(dc, c('bold', rc.overall_disposition))}`,
      fmt.kv([
        ['case', `${fmt.plain(this.case.name)}  ${c('grey', fmt.plain(rc.input_provenance.input_mode) + (defaulted ? ` · ${defaulted} field(s) from the baseline overlay` : ''))}`],
        ['gate', rc.reasons.length ? c('red', 'FAIL ' + rc.reasons.join(', ')) : c('green', 'PASS')],
        ['equations', `${c('green', cs.pass + ' PASS')}  ${c('cyan', cs.qualified + ' QUALIFIED')}  ${cs.fail ? c('red', cs.fail + ' FAIL') : '0 FAIL'}  ${c('grey', 'of 109  · hk001 eq')}`],
        ['Master Law', `${c(ms.admission === 'ADMIT_8S' ? 'green' : 'red', ms.admission)}  η_ind ${fmt.num(ms.eta_ind)} ${c('grey', 'vs ' + ms.epsilon_ind)}  Δ8S ${fmt.num(ms.delta_8s)} ${c('grey', 'vs ' + ms.epsilon_gain)}  matchup ${ms.matchup_class}`],
        ['X8S', `${c(xs.admission === 'ADMIT_X8S' ? 'green' : 'red', xs.admission)}  ${xs.decision_class}  win ${fmt.num(xs.extrapolated_win_probability, { fixed: 4 })}  confidence ${fmt.num(xs.decision_confidence, { fixed: 2 })}`],
        ['8Sphere', `${c(ps.admission === 'ADMIT_8SPHERE' ? 'green' : 'red', ps.admission)}  ${ps.decision_class}  adjusted joint ${fmt.num(ps.adjusted_parlay_probability, { fixed: 4 })}  stability ${fmt.num(ps.joint_stability, { fixed: 2 })}`],
        ['receipt', rc.unserializable ? c('amber', `none — ${rc.unserializable.length} values are NaN from zero denominators; the Go CLI refuses such a case ("json: unsupported value: NaN"). Every code still evaluates; NaN codes show why.`) : c('grey', rc.canonical_sha256)]
      ], { color, keyWidth: 12 }),
      '', fmt.wrap(rc.professor_summary, W, '  '),
      c('grey', fmt.wrap(rc.product_boundary, W, '  '))
    ];
    return lines.join('\n');
  }
  renderStage(stage, o = {}) {
    const color = o.color !== false; const c = fmt.paint(color);
    const rc = o.receipt || this.receipt();
    const filt = (o.filter || '').toLowerCase();
    let codes = catalog.CATALOG.filter((x) => x.stage === stage && (o.intermediate ? !x.published : x.published));
    if (filt) codes = codes.filter((x) => x.family.toLowerCase().includes(filt) || x.code.toLowerCase().startsWith(filt) || x.label.toLowerCase().includes(filt));
    const rows = codes.map((m) => { const v = this.value(m.code, rc); return [c('cyan', m.code), m.label, typeof v.value === 'number' ? fmt.num(v.value) : String(v.value), c(DISP_COLOR[v.disposition] || 'grey', v.disposition || ''), c('grey', m.family)]; });
    return fmt.table([{ h: 'code' }, { h: 'computation', max: 46 }, { h: 'value', align: 'r', max: 20 }, { h: 'disposition' }, { h: 'family', max: 26 }], rows, { color, width: o.width || 120 }) + '\n' + c('grey', `${rows.length} code(s) · type a code for its card`);
  }
  renderInputs(o = {}) {
    const color = o.color !== false; const c = fmt.paint(color);
    const rc = o.receipt || this.receipt(); const filt = (o.filter || '').toLowerCase();
    const rows = inputs.INPUTS.filter((m) => !filt || m.family.toLowerCase().includes(filt) || m.field.toLowerCase().includes(filt) || m.label.toLowerCase().includes(filt) || m.code.toLowerCase() === filt)
      .map((m) => { const v = this.value(m.code, rc); return [c('amber', m.code), m.field, m.label, fmt.num(v.value), c('grey', m.unit), c(v.prov === 'BASELINE_OVERLAY' || v.prov === 'BASELINE' ? 'grey' : 'green', v.prov), c('cyan', m.tokens.join(' '))]; });
    return fmt.table([{ h: 'code' }, { h: 'field' }, { h: 'label', max: 40 }, { h: 'value', align: 'r' }, { h: 'unit' }, { h: 'source' }, { h: 'tokens', max: 22 }], rows, { color, width: o.width || 140 });
  }
  renderCodes(o = {}) {
    const color = o.color !== false; const c = fmt.paint(color); const q = (o.filter || '').toLowerCase();
    const all = [...inputs.INPUTS.map((m) => ({ code: m.code, stage: 'INPUT', label: `${m.field} · ${m.label}`, family: m.family })), ...catalog.CATALOG.map((m) => ({ code: m.code, stage: m.stage + (m.published ? '' : '·i'), label: m.label, family: m.family }))];
    const rows = all.filter((x) => !q || x.code.toLowerCase().includes(q) || x.label.toLowerCase().includes(q) || x.family.toLowerCase().includes(q) || x.stage.toLowerCase().startsWith(q))
      .map((x) => [c(x.stage === 'INPUT' ? 'amber' : 'cyan', x.code), c('grey', x.stage), x.label, c('grey', x.family)]);
    return fmt.table([{ h: 'code' }, { h: 'stage' }, { h: 'label', max: 56 }, { h: 'family', max: 28 }], rows, { color, width: o.width || 140 }) + '\n' + c('grey', `${rows.length} of ${all.length} codes (${inputs.INPUTS.length} input codes, ${catalog.CATALOG.length} computation codes)`);
  }
  renderGraph(code, o = {}) {
    const color = o.color !== false; const c = fmt.paint(color); const depth = o.depth || 3;
    const rc = o.receipt || this.receipt(); const seen = new Set(); const lines = [];
    const walk = (cd, pre, last, d) => {
      const v = this.value(cd, rc); if (!v) return;
      const label = v.kind === 'input' ? v.meta.field : v.meta.label;
      const val = typeof v.value === 'number' ? fmt.num(v.value) : String(v.value);
      lines.push(`${pre}${d ? (last ? '└─ ' : '├─ ') : ''}${c(v.kind === 'input' ? 'amber' : 'cyan', cd)} ${c('grey', label)} = ${val}`);
      if (v.kind === 'input' || d >= depth) return;
      if (seen.has(cd)) { if (v.meta.deps.length) lines[lines.length - 1] += c('grey', '  (expanded above)'); return; }
      seen.add(cd);
      const deps = v.meta.deps; deps.forEach((x, i) => walk(x, pre + (d ? (last ? '   ' : '│  ') : ''), i === deps.length - 1, d + 1));
    };
    walk(String(code).toUpperCase(), '', true, 0);
    return lines.join('\n');
  }
  caseJSON() {
    const r = this.case.request;
    return JSON.stringify({ schema: r.schema, product_id: r.product_id, case_id: r.case_id, description: r.description, input_mode: r.input_mode, synthetic_fixture: r.synthetic_fixture, values: r.values, calibration: r.calibration || {} }, null, 2) + '\n';
  }
  verify() {
    const demo = engine.analyze(engine.defaultRequest());
    const again = engine.analyze(engine.defaultRequest());
    // a case with zero denominators has no canonical receipt (NaN): compare the traced values instead
    const a = this.receipt(); const b = engine.analyze(cloneCase(this.case).request, { allowNaN: true });
    const noReceipt = !!a.unserializable;
    const same = noReceipt ? JSON.stringify(a.conventional_equations.map((x) => String(x.value))) === JSON.stringify(b.conventional_equations.map((x) => String(x.value))) : a.canonical_sha256 === b.canonical_sha256;
    const trace = engine.analyze(engine.defaultRequest(), { trace: true }).trace;
    const inter = catalog.CATALOG.filter((x) => !x.published && x.stage !== 'SUM');
    return [
      { name: 'demo receipt equals the Go reference', pass: demo.canonical_sha256 === GO_DEMO_SHA, detail: demo.canonical_sha256 },
      { name: 'deterministic replay (demo)', pass: demo.canonical_sha256 === again.canonical_sha256, detail: again.canonical_sha256 },
      { name: 'deterministic replay (working case)', pass: same, detail: noReceipt ? `no canonical receipt (${a.unserializable.length} NaN values); the 109 equation values agree` : b.canonical_sha256 },
      { name: 'trace leaves the receipt unchanged', pass: same, detail: 'trace on vs off' },
      { name: 'every intermediate code is computed', pass: inter.every((x) => x.code in trace), detail: `${inter.length} intermediate codes` },
      { name: 'catalog: 109 + 84 published codes', pass: catalog.CATALOG.filter((x) => x.published).length === 193, detail: `${catalog.CATALOG.length} computation codes, ${inputs.INPUTS.length} input codes` },
      { name: 'Go Exp emulation path', pass: true, detail: gomath.expPath() }
    ];
  }
}
const caseHash = (c) => crypto.createHash('sha256').update(JSON.stringify(c.request)).digest('hex').slice(0, 12);
module.exports = { Lab, baselineCase, cloneCase, caseHash, GO_DEMO_SHA, STAGE_NAME };
