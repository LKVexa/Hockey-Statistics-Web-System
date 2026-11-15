'use strict';
/**
 * Terminal rendering of RINK-VT results (ANSI, width-aware). Pure functions over the service's JSON, so the
 * SPIRAL commands, tests and any other text client print the same tables.
 */
const fmt = require('../shared/fmt');

const STATUS_COLOR = { COMMITTED: 'green', CAUSALLY_CHAINED: 'green', SHIFT_UPDATED: 'teal', APPLIED: 'teal', UNDONE: 'amber', PATCHED: 'amber', DUPLICATE: 'grey', REJECTED: 'red' };
const f3 = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v));
const f1 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(1));
const sgn = (v, d = 3) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(d));
const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const clockOf = (ds) => `${Math.floor(ds / 600)}:${String(Math.floor(ds / 10) % 60).padStart(2, '0')}`;

/** Live clock from a scoreboard (refNs + remaining at ref, running flag). */
function liveRemainingDs(sb, nowNs) {
  if (!sb || !sb.running) return sb ? sb.remainingDs : 0;
  const el = Number((BigInt(nowNs) - BigInt(sb.refNs)) / 100000000n);
  return Math.max(0, sb.remainingDs - el);
}
function scoreLine(sb, o = {}) {
  const c = fmt.paint(o.color !== false); if (!sb) return c('grey', 'no game selected');
  const H = sb.home, A = sb.away; const ds = o.nowNs ? liveRemainingDs(sb, o.nowNs) : sb.remainingDs;
  const pen = (sb.penalties || []).map((p) => `${p.team} ${p.code || '?'} ${p.infraction || p.kind}`).join(', ');
  if (sb.final) return `${c('bold', H)} ${c('bold', String(sb.score[H]))} ${c('grey', '–')} ${c('bold', String(sb.score[A]))} ${c('bold', A)}  ${c('amber', 'FINAL' + (sb.final.decidedIn && sb.final.decidedIn !== 'REG' ? '/' + sb.final.decidedIn : ''))}`;
  return `${c('bold', H)} ${c('bold', String(sb.score[H]))} ${c('grey', '–')} ${c('bold', String(sb.score[A]))} ${c('bold', A)}  ${c('cyan', sb.periodText)} ${clockOf(ds)} ${sb.running ? c('green', '▶') : c('grey', '⏸')}  ${c('grey', sb.strength)}${pen ? c('amber', '  PEN ' + pen) : ''}`;
}
/** One line per frame result of a submitted command line. */
function results(res, o = {}) {
  const c = fmt.paint(o.color !== false); const out = [];
  for (const r of res.results || []) {
    const col = STATUS_COLOR[r.status] || 'grey';
    let detail = '';
    if (r.status === 'REJECTED') detail = r.error;
    else if (r.status === 'COMMITTED') {
      detail = `#${r.event_seq} ${r.latched_clock}  ${r.team} ${r.code} ${r.stat}`;
      if (r.xg !== undefined) detail += `  xG ${r.xg}${r.flurry_adj_xg !== r.xg ? c('grey', ` → ${r.flurry_adj_xg} flurry`) : ''}  ${c('grey', (r.danger || '') + (r.rebound ? ' rebound' : '') + (r.rush ? ' rush' : '') + ' ' + (r.coord_source || ''))}`;
      if (r.auto) detail += c('grey', `  auto: ${r.auto}`);
      if (r.penalty) detail += c('amber', `  ${r.penalty}`);
      if (r.shootout) detail += c('grey', `  shootout ${r.shootout}`);
      if (r.stat === 'G') detail += `  ${c('bold', r.score)}`;
    } else if (r.status === 'CAUSALLY_CHAINED') detail = `${r.assist_slot.replace('_', ' ').toLowerCase()} ${r.code} → goal #${r.chained_to_event_seq} (rev ${r.new_revision})`;
    else if (r.status === 'SHIFT_UPDATED') detail = `${r.team} ${r.code} ${r.action}  on ice ${r.on_ice}${r.goalie ? '  goalie ' + r.goalie : ''}  ${r.strength}`;
    else if (r.status === 'APPLIED') detail = r.clock ? `clock ${r.clock}${r.result ? '  ' + JSON.stringify(r.result.final) + ' ' + (r.result.winner || 'tie') + ' ' + r.result.decidedIn : ''}` : r.line ? `line ${r.line}  ${r.strength}` : '';
    else if (r.status === 'UNDONE') detail = `${r.undone || r.deleted || ''}${r.seq ? ` (#${r.seq})` : ''}`;
    else if (r.status === 'PATCHED') detail = `#${r.seq} rev ${r.revision}: ${r.now || ''}`;
    else if (r.status === 'DUPLICATE') detail = `already applied (${r.original})${r.event_seq ? ` as #${r.event_seq}${r.latched_clock ? ' ' + r.latched_clock : ''}` : ''}`;
    out.push(`${c(col, r.status.padEnd(16))} ${detail}`);
  }
  return out.join('\n');
}

function table(cols, rows, o) { return fmt.table(cols, rows, { color: o.color !== false, width: o.width || 120 }); }

function box(d, o = {}) {
  const c = fmt.paint(o.color !== false); const out = [];
  if (d.scoreboard) out.push(scoreLine(d.scoreboard, o), '');
  for (const [team, t] of Object.entries(d.teams)) {
    const tt = t.totals;
    out.push(`${c('bold', c('cyan', team))}  ${c('grey', `G ${tt.G} · SOG ${tt.SOG} · xGF ${f3(tt.xGF)} · CF ${tt.CF} · FF ${tt.FF} · HDCF ${tt.HDCF} · PP ${tt.PPG}/${tt.PP_OPP} · FO ${tt.FOW}/${tt.FO} · PIM ${tt.PIM} · hits ${tt.HITS} · blocks ${tt.BLK}${d.games > 1 ? ` · ${tt.GP} GP` : ''}`)}`);
    out.push(table([{ h: '#', align: 'r' }, { h: 'code' }, { h: 'player', max: 22 }, { h: 'pos' }, { h: 'G', align: 'r' }, { h: 'A', align: 'r' }, { h: 'P', align: 'r' }, { h: '+/-', align: 'r' }, { h: 'SOG', align: 'r' }, { h: 'ixG', align: 'r' }, { h: 'BLK', align: 'r' }, { h: 'HIT', align: 'r' }, { h: 'TK', align: 'r' }, { h: 'GV', align: 'r' }, { h: 'FO', align: 'r' }, { h: 'PIM', align: 'r' }, { h: 'TOI', align: 'r' }],
      t.skaters.filter((r) => r.toi || r.pts || r.sog || r.pim || r.blk || r.hits || r.fow + r.fol).map((r) => [r.jersey, c('cyan', r.code), r.name, r.pos, r.g, r.a, c('bold', String(r.pts)), r.pm, r.sog, f3(r.ixg), r.blk, r.hits, r.tk, r.gv, r.fow + r.fol ? `${r.fow}-${r.fol}` : '', r.pim, mmss(r.toi)]), o));
    if (t.goalies.length) out.push(table([{ h: '#', align: 'r' }, { h: 'goalie' }, { h: 'name', max: 22 }, { h: 'SA', align: 'r' }, { h: 'GA', align: 'r' }, { h: 'SV%', align: 'r' }, { h: 'xGA', align: 'r' }, { h: 'GSAx', align: 'r' }, { h: 'GSAx-EB', align: 'r' }, { h: 'HD', align: 'r' }, { h: 'TOI', align: 'r' }],
      t.goalies.map((g) => [g.jersey, c('cyan', g.code), g.name, g.sa, g.ga, g.svPct === null ? '—' : g.svPct.toFixed(3).replace(/^0/, ''), f3(g.xga), sgn(g.gsaxRaw), sgn(g.gsaxEB), `${g.hd[0]}/${g.hd[1]}`, mmss(g.toi)]), o));
    out.push('');
  }
  return out.join('\n');
}
function events(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  const rows = d.events.map((e) => [e.seq + (e.rev > 1 ? c('amber', 'ʳ' + e.rev) : ''), `${e.period} ${e.clock}`, c('cyan', e.team), e.code, c('bold', e.stat) + (e.mod ? c('grey', '/' + e.mod) : ''), e.x !== null && e.x !== undefined ? `${f1(e.x)},${f1(e.y)}${e.coordSource === 'explicit' ? '' : c('grey', ' ' + (e.coordSource || '')[0])}` : '',
    e.xg ? f3(e.xg) + (e.xgF !== e.xg ? c('grey', '→' + f3(e.xgF)) : '') : '', e.danger ? e.danger[0] : '', [e.rebound ? 'reb' : '', e.rush ? 'rush' : ''].filter(Boolean).join(' '), e.strength + (e.situation !== 'EV' ? ' ' + e.situation : ''),
    (e.assists && e.assists.length ? 'A ' + e.assists.join(',') : '') + (e.auto ? c('grey', ' auto ' + e.auto) : '') + (e.penalty ? c('amber', ' ' + e.penalty) : '')]);
  const t = table([{ h: '#', align: 'r' }, { h: 'clock' }, { h: 'team' }, { h: 'code' }, { h: 'stat' }, { h: 'x,y' }, { h: 'xG', align: 'r' }, { h: 'D' }, { h: 'ctx' }, { h: 'str' }, { h: 'chain', max: 40 }], rows, o);
  return t + '\n' + c('grey', `${d.events.length} of ${d.total} events`) + (d.notes && d.notes.length ? '\n' + c('amber', d.notes.join('\n')) : '');
}
function xg(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  const rows = Object.entries(d.teams).map(([t, x]) => [c('cyan', t), x.GP, x.G, f3(x.xGF), sgn(x.gax, 2), x.GA, f3(x.xGA), x.xgfPct === null ? '—' : (100 * x.xgfPct).toFixed(1) + '%', x.HDCF, x.HDCA, x.SCF, x.SCA, x.unblocked, f3(x.flurryDiscount)]);
  let s = table([{ h: 'team' }, { h: 'GP', align: 'r' }, { h: 'G', align: 'r' }, { h: 'xGF', align: 'r' }, { h: 'G−xG', align: 'r' }, { h: 'GA', align: 'r' }, { h: 'xGA', align: 'r' }, { h: 'xGF%', align: 'r' }, { h: 'HDCF', align: 'r' }, { h: 'HDCA', align: 'r' }, { h: 'SCF', align: 'r' }, { h: 'SCA', align: 'r' }, { h: 'unblocked', align: 'r' }, { h: 'flurry −xG', align: 'r' }], rows, o);
  if (d.shots && d.shots.length) s += '\n\n' + table([{ h: '#', align: 'r' }, { h: 'team' }, { h: 'code' }, { h: 'stat' }, { h: 'x,y' }, { h: 'src' }, { h: 'shot' }, { h: 'd ft', align: 'r' }, { h: 'θ°', align: 'r' }, { h: 'xG', align: 'r' }, { h: 'flurry', align: 'r' }, { h: 'class' }],
    d.shots.slice(-15).map((e) => [e.seq, c('cyan', e.team), e.code, e.stat, `${f1(e.x)},${f1(e.y)}`, e.src, e.shot, f1(e.dist), f1(e.angle), f3(e.xg), f3(e.xgF), (e.danger || '—') + (e.rebound ? ' R' : '') + (e.rush ? ' U' : '')]), o);
  return s + '\n' + c('grey', d.model);
}
function stints(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  return table([{ h: 'id', align: 'r' }, { h: 'per' }, { h: 'start', align: 'r' }, { h: 'dur', align: 'r' }, { h: 'str' }, { h: 'zone' }, { h: d.home + ' on ice', max: 34 }, { h: d.away + ' on ice', max: 34 }, { h: 'CF', align: 'r' }, { h: 'xGF', align: 'r' }],
    d.stints.map((t) => [t.id, t.period, mmss(t.start), f1(t.dur) + (t.live ? c('green', '…') : ''), t.strength, t.zone, t.home.join(' '), t.away.join(' '), `${t.homeCF}-${t.awayCF}`, `${f3(t.homeXGF)}-${f3(t.awayXGF)}`]), o) + '\n' + c('grey', `${d.stints.length} of ${d.total} stints (home perspective; zone = faceoff zone that started the stint, OTF = on the fly)`);
}
function pen(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  return scoreLine(d.scoreboard, o) + '\n\n' + table([{ h: 'id', align: 'r' }, { h: 'team' }, { h: 'code' }, { h: 'kind' }, { h: 'infraction' }, { h: 'start', align: 'r' }, { h: 'end', align: 'r' }, { h: 'state' }],
    d.penalties.map((p) => [p.id, c('cyan', p.team), p.code, p.kind, p.infraction || '', mmss(p.start), p.end === null ? '—' : mmss(p.end), p.active ? c('amber', 'serving') : p.queued ? c('grey', 'queued') : c('grey', p.how || 'done')]), o);
}
function player(d, o = {}) {
  const c = fmt.paint(o.color !== false); const p = d.player, l = d.line || {};
  const head = `${c('bold', p.name)}  ${c('cyan', p.team + ' ' + p.code)} #${p.jersey} ${p.pos}  ${c('grey', `shoots ${p.shoots} · born ${p.birth || '?'} · age ${p.ageDays ? (p.ageDays / 365.25).toFixed(2) : '?'} · ${p.import ? 'import · ' : ''}${d.games} game(s) in scope`)}`;
  const line = p.pos === 'G' ? `SA ${l.sa}  GA ${l.ga}  SV% ${l.svPct}  xGA ${f3(l.xga)}  GSAx ${sgn(l.gsaxRaw)}  EB ${sgn(l.gsaxEB)}` : `GP ${l.gp || 0}  G ${l.g || 0}  A ${l.a || 0}  P ${l.pts || 0}  +/- ${l.pm || 0}  SOG ${l.sog || 0}  ixG ${f3(l.ixg)}  TOI ${mmss(l.toi)} (EV ${mmss(l.toiEV)} PP ${mmss(l.toiPP)} SH ${mmss(l.toiSH)})  on-ice ${l.onGF || 0}-${l.onGA || 0}`;
  return [head, line, '', table([{ h: 'game' }, { h: '#', align: 'r' }, { h: 'clock' }, { h: 'event', max: 50 }, { h: 'xG', align: 'r' }], d.events.map((e) => [e.game, e.seq, `${e.period} ${e.clock}`, e.text + (e.assist ? c('grey', ' (assist)') : ''), e.xg ? f3(e.xg) : '']), o)].join('\n');
}
function standings(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  return table([{ h: 'team' }, { h: 'GP', align: 'r' }, { h: 'W', align: 'r' }, { h: 'L', align: 'r' }, { h: 'OTL', align: 'r' }, { h: 'PTS', align: 'r' }, { h: 'P%', align: 'r' }, { h: 'RW', align: 'r' }, { h: 'GF', align: 'r' }, { h: 'GA', align: 'r' }, { h: 'DIFF', align: 'r' }, { h: 'xGF', align: 'r' }, { h: 'xGA', align: 'r' }, { h: 'live', align: 'r' }],
    d.standings.map((r) => [c('cyan', r.team), r.gp, r.w, r.l, r.otl, c('bold', String(r.pts)), r.ptsPct === null ? '—' : r.ptsPct.toFixed(3), r.rw, r.gf, r.ga, sgn(r.diff, 0), f1(r.xgf), f1(r.xga), r.live || '']), o) + '\n' + c('grey', d.rule);
}
function leaders(d, o = {}) {
  const c = fmt.paint(o.color !== false); const col = (title, list, dec) => [c('bold', title), ...list.map((r, i) => `${String(i + 1).padStart(2)}. ${c('cyan', r.team + ' ' + r.code)} ${fmt.cut(r.name, 18).padEnd(18)} ${dec ? Number(r.value).toFixed(2) : r.value}`)];
  const a = col('points', d.points), b = col('goals', d.goals), e = col('ixG', d.ixg, true);
  const rows = []; for (let i = 0; i < Math.max(a.length, b.length, e.length); i++) rows.push([a[i] || '', b[i] || '', e[i] || '']);
  return rows.map((r) => r.map((x) => fmt.pad(x, 38)).join('  ')).join('\n') + '\n' + c('grey', `${d.games} games`);
}
function rapm(d, o = {}) {
  const c = fmt.paint(o.color !== false); const m = d.model;
  if (!d.rows.length) return c('amber', m.note || `no skater has ${d.minMinutes} minutes at ${d.strength} yet (Q RAPM --min=5 lowers the floor)`);
  const t = table([{ h: '#', align: 'r' }, { h: 'team' }, { h: 'code' }, { h: 'player', max: 22 }, { h: 'pos' }, { h: 'TOI', align: 'r' }, { h: 'OFF xGF/60', align: 'r' }, { h: 'DEF xGA/60 prev.', align: 'r' }, { h: 'NET', align: 'r' }],
    d.rows.slice(0, o.n || 30).map((r, i) => [i + 1, c('cyan', r.team), r.code, r.name, r.pos, r.toiMin, sgn(r.off), sgn(r.def), c('bold', sgn(r.net))]), o);
  return t + '\n' + c('grey', `${d.strength} · ${m.stints} stints · ${m.observations} observations · ${m.N} skaters · λ_off ${m.lambdaOff} λ_def ${m.lambdaDef} · ȳ ${m.ybar} xG/60 · PCG ${m.iterations} it, residual ${Number(m.residual).toExponential(1)} · ${m.calibration}`) +
    '\n' + c('grey', 'context: ' + Object.entries(m.context).map(([k, v]) => `${k} ${sgn(v)}`).join(' · '));
}
function gsax(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  return table([{ h: 'team' }, { h: 'goalie' }, { h: 'name', max: 22 }, { h: 'GP', align: 'r' }, { h: 'unblocked', align: 'r' }, { h: 'SA', align: 'r' }, { h: 'GA', align: 'r' }, { h: 'SV%', align: 'r' }, { h: 'xGA', align: 'r' }, { h: 'GSAx raw', align: 'r' }, { h: 'GSAx EB', align: 'r' }, { h: 'HD', align: 'r' }, { h: 'MD', align: 'r' }, { h: 'LD', align: 'r' }],
    d.rows.map((g) => [c('cyan', g.team), g.code, g.name, g.gp, g.unblocked, g.sa, g.ga, g.svPct === null ? '—' : g.svPct.toFixed(3), f3(g.xga), sgn(g.gsaxRaw), c('bold', sgn(g.gsaxEB)), `${g.hd[0]}/${g.hd[1]}`, `${g.md[0]}/${g.md[1]}`, `${g.ld[0]}/${g.ld[1]}`]), o) + '\n' + c('grey', `${d.formula} · κ ${d.kappa} · μ_prior ${d.muPrior} (declared)`);
}
function gar(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  return table([{ h: '#', align: 'r' }, { h: 'team' }, { h: 'code' }, { h: 'player', max: 20 }, { h: 'age', align: 'r' }, { h: 'TOI', align: 'r' }, { h: 'EVO', align: 'r' }, { h: 'EVD', align: 'r' }, { h: 'PPO', align: 'r' }, { h: 'SHD', align: 'r' }, { h: 'FIN', align: 'r' }, { h: 'PEN', align: 'r' }, { h: '−REPL', align: 'r' }, { h: 'GAR', align: 'r' }, { h: 'WAR', align: 'r' }, { h: 'GAR age-adj', align: 'r' }],
    d.rows.map((r, i) => [i + 1, c('cyan', r.team), r.code, r.name, r.ageDays ? (r.ageDays / 365.25).toFixed(1) : '—', Math.round(r.toiMin), sgn(r.EVO, 2), sgn(r.EVD, 2), sgn(r.PPO, 2), sgn(r.SHD, 2), sgn(r.finishing, 2), sgn(r.penalties, 2), sgn(-r.replacement, 2), c('bold', sgn(r.gar, 2)), sgn(r.war, 2), sgn(r.garAgeAdj, 2)]), o) +
    '\n' + c('grey', `GAR = EVO + EVD + PPO + SHD + Finishing + Penalties − Replacement · WAR = GAR / ${d.goalsPerWin} · age curve ${d.ageCurve} (natural cubic spline, knots ${d.knots.join('/')} y) · declared: penalty ${d.declared.penaltyGoalCost} goals, replacement ${d.declared.replacementPer60} goals/60 · ${d.calibration}`);
}
function nhle(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  return table([{ h: '#', align: 'r' }, { h: 'team' }, { h: 'code' }, { h: 'player', max: 22 }, { h: 'pos' }, { h: 'age', align: 'r' }, { h: 'GP', align: 'r' }, { h: 'PTS', align: 'r' }, { h: 'P/GP', align: 'r' }, { h: 'age ×', align: 'r' }, { h: 'NHLe /82', align: 'r' }],
    d.rows.map((r, i) => [i + 1, c('cyan', r.team), r.code, r.name, r.pos, r.ageYears ? r.ageYears.toFixed(1) : '—', r.gp, r.pts, r.ppg.toFixed(2), r.ageFactor.toFixed(2), c('bold', r.nhle82.toFixed(1))]), o) +
    '\n' + c('amber', `T(L→NHL) ${d.T} = harmonic mean of ${d.chains.map((x) => `${x.via} ${x.factor}`).join(', ')} — ${d.note}`);
}
function heat(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  const a = d.ascii; const top = '┌' + '─'.repeat(a.cols) + '┐', bot = '└' + '─'.repeat(a.cols) + '┘';
  const rows = a.map.map((r) => r.split(''));
  for (const [x, y, away] of a.goals) if (rows[y] && rows[y][x] !== undefined) rows[y][x] = away ? '◆' : '●';
  const mid = Math.floor(a.cols / 2);
  const lines = rows.map((r) => { const s = r.map((ch, i) => (ch === '●' ? c('amber', ch) : ch === '◆' ? c('violet', ch) : i === mid && ch === ' ' ? c('red', '┆') : ch)).join(''); return '│' + s + '│'; });
  const lane = (i) => d.lanes[i] ? `${d.lanes[i].name} ${d.lanes[i].events}` : '';
  return [c('grey', `${d.away || 'away'} attacks ←`) + ' '.repeat(Math.max(1, a.cols - 28)) + c('grey', `→ ${d.home} attacks`), top, ...lines, bot,
    c('grey', `KDE ${d.program} · ${d.engine === 'xpu' ? 'Plume XPU (xpu.wasm)' : 'JS kernel'} · box^${d.steps} ≈ ${d.bandwidthFt} ft · ${d.ms} ms · ${lane(0)} · ${lane(4)} · ● ${d.home} goal  ◆ ${d.away || 'opp.'} goal`)].join('\n');
}
function ledger(d, o = {}) {
  const c = fmt.paint(o.color !== false); const L = d.ledger || d.info || {}; const s = L.stats || {};
  const rows = [['file', L.memory ? c('amber', 'memory only (no VWS_RINK_DIR)') : L.file], ['entries', `${(L.frames || 0) / 2} frames (${L.frames} cachelines, ${L.pages} pages, ${L.pending || 0} pending)`], ['root', d.root], ['state digest', d.stateDigest],
    ['medium', `${L.bytes} bytes · cache ${L.cachePages} pages · log ${L.logLines} lines × 2`], ['io', `appends ${s.appends} · log hits ${s.logHits} · cache hits ${s.cacheHits} · misses ${s.misses} · pages read ${s.pagesRead} · written ${s.pagesWritten} · records ${s.recordsWritten} · fsyncs ${s.fsyncs} · verified ${s.verified} · errors ${s.verifyErrors}`]];
  const rec = L.recovery;
  if (rec && (rec.tornRecords || (rec.fallbacks || []).length)) rows.push(['recovery', (rec.fallbacks || []).length ? c('red', `${rec.fallbacks.length} page(s) fell back to an older generation: ${rec.fallbacks.reduce((a, f) => a + f.lostLines, 0)} acknowledged lines are missing`) : c('amber', `${rec.tornRecords} torn record(s) from an interrupted commit were discarded (nothing acknowledged was lost)`)]);
  if (d.verify) rows.push(['verify', (d.verify.ok ? c('green', 'OK') : c('red', 'FAILED pages ' + d.verify.bad.join(','))) + ` · ${d.verify.pages} pages re-read from the medium`], ['replay', (d.replay.equal ? c('green', 'EQUAL') : c('red', 'DIFFERENT')) + ` · ${d.replay.applied} frames replayed into a fresh actor · digest ${String(d.replay.digest).slice(0, 16)}…`]);
  return fmt.kv(rows, { color: o.color !== false, keyWidth: 13 });
}
function audit(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  // from: the static loopback address of the client the line came from (2.5; none for lines recorded before, or in process)
  return table([{ h: 'time' }, { h: 'operator' }, { h: 'src' }, { h: 'from' }, { h: 'lamport', align: 'r' }, { h: 'frame', max: 40 }, { h: 'status' }, { h: 'error', max: 50 }],
    d.audit.map((a) => [new Date(a.at).toISOString().slice(11, 19), a.operator, a.source, a.local || '—', a.lamport, a.text, c(STATUS_COLOR[a.status] || 'grey', a.status), a.error || '']), o) + '\n' + c('grey', `${d.audit.length} of ${d.total} audit entries`);
}
function roster(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  return `${c('bold', d.team.code)}  ${d.team.name_en} · ${d.team.name_fr} · ${d.team.arena}\n` + table([{ h: '#', align: 'r' }, { h: 'code' }, { h: 'name', max: 26 }, { h: 'pos' }, { h: 'sh' }, { h: 'born' }, { h: 'age', align: 'r' }, { h: 'imp' }],
    d.players.map((p) => [p.jersey, c('cyan', p.code), p.name, p.pos, p.shoots, p.birth || '', p.ageDays ? (p.ageDays / 365.25).toFixed(1) : '', p.import ? 'import' : '']), o);
}
function codesTable(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  return table([{ h: 'token' }, { h: 'kind' }, { h: 'meaning', max: 52 }, { h: 'HK001 inputs it feeds', max: 46 }], d.stats.map((s) => [c('cyan', s.token), s.kind, s.label, s.inputs.join(' ')]), o) +
    '\n' + c('grey', `shot types ${Object.entries(d.shotTypes).map(([k, v]) => k + '=' + v).join(' ')} · flags ${Object.entries(d.flags).map(([k, v]) => k + '=' + v).join(' ')} · zones 1-9 · fr-CA ${Object.entries(d.french).map(([k, v]) => k + '→' + v).join(' ')}`);
}
function hk001case(d, o = {}) {
  const c = fmt.paint(o.color !== false); const k = d.case; const n = {};
  for (const p of Object.values(k.prov)) n[p] = (n[p] || 0) + 1;
  return [`${c('bold', k.name)}  ${c('grey', `${k.gp} games · featured ${k.featured ? k.featured.code + ' ' + k.featured.name : '—'}`)}`, c('grey', 'provenance  ') + Object.entries(n).map(([p, x]) => `${p} ${x}`).join(' · '), ...(k.notes || []).map((x) => c('amber', '· ' + x)), c('grey', 'load it for every HK001 code:  case team ' + k.team + (k.scope ? ' ' + k.scope : ''))].join('\n');
}
function query(d, o = {}) {
  switch (d.target) {
    case 'SCORE': return scoreLine(d.scoreboard, o);
    case 'BOX': return box(d, o);
    case 'EVENTS': return events(d, o);
    case 'XG': return xg(d, o);
    case 'STINTS': return stints(d, o);
    case 'PEN': return pen(d, o);
    case 'PLAYER': return player(d, o);
    case 'STANDINGS': return standings(d, o);
    case 'LEADERS': return leaders(d, o);
    case 'RAPM': return rapm(d, o);
    case 'GSAX': return gsax(d, o);
    case 'GAR': return gar(d, o);
    case 'NHLE': return nhle(d, o);
    case 'HEAT': return heat(d, o);
    case 'LEDGER': return ledger(d, o);
    case 'AUDIT': return audit(d, o);
    case 'ROSTER': return roster(d, o);
    case 'CODES': return codesTable(d, o);
    case 'HK001': return hk001case(d, o);
    default: return JSON.stringify(d, null, 2);
  }
}
/* ---------------------------------------------------------------- roster import and four-letter references */
const plainText = (s) => fmt.plain(s);
const tallyLine = (n) => `${n.new} new · ${n.updated} updated · ${n.unchanged} unchanged`;
const ACTION_COLOR = { new: 'green', updated: 'amber', unchanged: 'grey' };
/** what happened to one league, team or player: "designated" says the reference is this system's, "from the file" that it was given */
function status(c, r) {
  if (r.action === 'new') return c('green', r.given ? 'new · code from the file' : 'new · designated');
  if (r.action === 'updated') return c('amber', `updated (${(r.changed || []).map((k) => String(k).replace('name_en', 'name').replace('name_fr', 'French name')).join(', ')})`);
  return c('grey', 'unchanged');
}
/** "teams 101 to 200 of 676 · --page=3 shows the next"; null when everything is on show */
function pageLine(c, what, per, page, shown, total, next = true) {
  if (total <= shown && page === 1) return null;
  if (!shown) return c('grey', `no ${what} on page ${page}: there are ${total}`);
  const at = (page - 1) * per;
  return c('grey', `${what} ${at + 1} to ${at + shown} of ${total}${next && at + shown < total ? ` · --page=${page + 1} shows the next` : ''}`);
}
function importPlan(d, o = {}) {
  const c = fmt.paint(o.color !== false); const w = o.width || 100; const out = []; const n = d.counts;
  const from = d.file.origin === 'host' ? 'read from the import folder' : d.file.origin === 'upload' ? 'uploaded from the browser' : 'a file of this terminal';
  out.push(`${c('cyan', plainText(d.file.name))}  ${c('grey', `${d.file.format} · ${d.file.bytes} bytes · ${from} · ${n.rows} record${n.rows === 1 ? '' : 's'}`)}`);
  out.push(d.applied ? c('green', 'APPLIED') + c('grey', ' — the registry now holds what follows')
    : d.refused ? c('red', `NOT APPLIED: ${n.errors} record${n.errors === 1 ? '' : 's'} cannot be imported`) + c('grey', ' — nothing has been changed')
      : c('amber', 'PREVIEW') + c('grey', ' — nothing has been changed'));
  out.push(fmt.kv([['leagues', tallyLine(n.leagues)], ['teams', tallyLine(n.teams)], ['players', tallyLine(n.players)]], { color: o.color }));
  if (d.leagues.length) out.push('', c('cyan', 'LEAGUE_4'), fmt.table([{ h: 'code' }, { h: 'league' }, { h: 'abbr' }, { h: '' }], d.leagues.map((l) => [c(ACTION_COLOR[l.action], l.code), plainText(l.name), plainText(l.abbr || ''), status(c, l)]), { width: w }));
  if (d.teamsTotal) {
    out.push('', c('cyan', 'TEAM_4'));
    if (d.teams.length) out.push(fmt.table([{ h: 'code' }, { h: 'team' }, { h: 'league' }, { h: 'city' }, { h: 'players', align: 'r' }, { h: '' }],
      d.teams.map((t) => [c(ACTION_COLOR[t.action], t.code), plainText(t.name), t.league || c('grey', '—'), plainText(t.city || ''), `${t.n.new + t.n.updated + t.n.unchanged}${t.n.errors ? c('red', ` +${t.n.errors} in error`) : ''}`, status(c, t)]), { width: w }));
    const tl = d.cut ? null : pageLine(c, 'teams', 100, d.players ? 1 : d.page, d.teams.length, d.teamsTotal, !d.players); if (tl) out.push(tl + (d.players && d.teamsTotal > d.teams.length ? c('grey', ' · without --show, --page pages the teams') : ''));
  }
  if (d.players) {
    const all = d.show === 'all';
    out.push('', c('cyan', all ? 'PLAYER_4' : `PLAYER_4 on ${d.show}`), fmt.table([...(all ? [{ h: 'team' }] : []), { h: 'code' }, { h: '#', align: 'r' }, { h: 'player' }, { h: 'pos' }, { h: '' }],
      d.players.map((p) => [...(all ? [p.team] : []), c(ACTION_COLOR[p.action], p.code), p.jersey, plainText(p.name), p.pos, status(c, p)]), { width: w }));
    const pl = d.cut ? null : pageLine(c, 'players', 100, d.page, d.players.length, d.playersTotal); if (pl) out.push(pl);
  }
  if (d.cut) out.push(c('amber', 'the names in this file are so long that one reply cannot hold a full page: --show=TEAM lists one team at a time'));
  for (const t of d.notes || []) out.push(c('grey', `· ${plainText(t)}`));
  const issues = (list, total, color, word) => { if (!total) return; out.push('', c(color, `${total} ${word}${total === 1 ? '' : 's'}`)); for (const e of list) out.push(`  ${c(color, plainText(e.where || 'file'))}  ${plainText(e.text)}`); if (total > list.length) out.push(c('grey', `  … and ${total - list.length} more`)); };
  issues(d.warnings || [], n.warnings, 'amber', 'warning'); issues(d.errors || [], n.errors, 'red', 'error');
  const p = plainText(o.path || d.file.name); const q = /\s/.test(p) ? `'${p}'` : p;
  out.push('');
  const ok = n.leagues.new + n.leagues.updated + n.teams.new + n.teams.updated + n.players.new + n.players.updated;
  const listed = d.players || !(n.players.new + n.players.updated + n.players.unchanged) ? '' : `rink import ${q} --show=${d.teams[0] ? d.teams[0].code : 'TEAM'} lists a team's players (--show=all, everyone) · `;
  if (d.applied) out.push(c('grey', `rink refs lists every reference · rink roster ${d.teams[0] ? d.teams[0].code : 'TEAM'} · rink new ${d.teams.length > 1 ? `${d.teams[0].code} ${d.teams[1].code}` : 'HOME AWAY'} starts a game`));
  else if (n.errors) out.push(c('grey', `${listed}correct the file and run it again, or rink import ${q} --apply --skip-errors registers what is not in error`));
  else if (!ok) out.push(c('grey', `${listed}everything in the file is registered already: there is nothing to apply`));
  else out.push(c('grey', `${listed}rink import ${q} --apply registers this`));
  return out.join('\n');
}
function leagues(d, o = {}) {
  const c = fmt.paint(o.color !== false);
  if (!d.leagues.length) return c('grey', `no league yet${d.unassigned ? ` (${d.unassigned} team${d.unassigned === 1 ? '' : 's'} without one)` : ''} — rink import FILE, or rink addleague CODE "Name"`);
  return fmt.table([{ h: 'LEAGUE_4' }, { h: 'league' }, { h: 'ligue' }, { h: 'abbr' }, { h: 'teams', align: 'r' }], d.leagues.map((l) => [c('cyan', l.code), plainText(l.name_en), l.name_fr === l.name_en ? '' : plainText(l.name_fr), plainText(l.abbr || ''), l.teams]), { width: o.width || 100 })
    + (d.unassigned ? '\n' + c('grey', `${d.unassigned} team${d.unassigned === 1 ? '' : 's'} in no league`) : '');
}
function refs(d, o = {}) {
  const c = fmt.paint(o.color !== false); const w = o.width || 100; const out = [];
  if (d.players) {
    out.push(`${c('cyan', d.team.code)}  ${plainText(d.team.name)}${d.team.league ? c('grey', ` · ${d.team.league}`) : ''}`);
    out.push(d.players.length ? fmt.table([{ h: 'PLAYER_4' }, { h: '#', align: 'r' }, { h: 'player' }, { h: 'pos' }, { h: 'typed as' }], d.players.map((p) => [c('cyan', p.code), p.jersey, plainText(p.name), p.pos, c('grey', `${d.team.code} ${p.code} …  or  ${d.team.code} J${p.jersey} …`)]), { width: w }) : c('grey', 'no players yet'));
    return out.join('\n');
  }
  if (d.league) out.push(`${c('cyan', d.league.code)}  ${plainText(d.league.name)}${d.league.abbr ? c('grey', ` · ${plainText(d.league.abbr)}`) : ''}`);
  else if (d.leagues && d.leagues.length) out.push(fmt.table([{ h: 'LEAGUE_4' }, { h: 'league' }, { h: 'abbr' }], d.leagues.map((l) => [c('cyan', l.code), plainText(l.name), plainText(l.abbr || '')]), { width: w }), '');
  out.push(d.teams.length ? fmt.table([{ h: 'TEAM_4' }, { h: 'team' }, { h: 'league' }, { h: 'city' }, { h: 'players', align: 'r' }], d.teams.map((t) => [c('cyan', t.code), plainText(t.name), t.league || c('grey', '—'), plainText(t.city || ''), t.players]), { width: w }) : c('grey', 'no teams yet'));
  const tl = pageLine(c, 'teams', 100, d.page, d.teams.length, d.total); if (tl) out.push(tl);
  out.push(c('grey', 'rink refs TEAM_4 lists a team\'s players · rink refs LEAGUE_4 a league\'s teams'));
  return out.join('\n');
}
module.exports = { query, results, scoreLine, liveRemainingDs, box, events, xg, stints, standings, rapm, gsax, gar, nhle, heat, ledger, audit, roster, codesTable, hk001case, importPlan, leagues, refs, pageLine, STATUS_COLOR };
