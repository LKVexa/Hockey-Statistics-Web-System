'use strict';
/**
 * HK001 computation codes — every node of the HK001 2.3.0 computation graph has a code.
 *   EQ   109 published hockey equations                 OFF-001 … ADV-005
 *   ML    32 published Master-Law models                OFF8S-001 … ADM8S-001
 *        + Master-Law intermediates                     ML-<ENT>-<TERM>, ML-W-*, ML-RHO-*, ML-G-DR, ML-V-*
 *   X8S   26 published first-stage extrapolations       X8S-A01 … X8S-C18
 *        + anchor-vector components and shared terms    X8S-A0k-Vi, X8S-T-*
 *   SP8   26 published 8Sphere models                   SP8-L01 … SP8-C18
 *        + sphere / projection vectors and terms        SP8-Si, SP8-Pi, SP8-T-*
 *   SUM  receipt-level results                          HK-*
 * Entity short names: OFF offense · POS possession · TRN transition · DEF defense · GOL goaltending ·
 * SPT special teams · TEAM team · OPP opponent. `symbol` is the notation the Mathematical Corpus uses.
 * `deps` lists the input codes (HKI-xxx, shown by mnemonic) and computation codes each node reads.
 */
const engine = require('./engine');
const inputs = require('./inputs');
const corpus = require('../corpus/corpus.json');

const PLATES = new Map(corpus.plates.map((p) => [p.id, p]));
const C = [];
const add = (o) => { C.push(Object.freeze(Object.assign({ symbol: '', unit: '', deps: [], published: false, plate: null }, o))); };
const F = (k) => inputs.byField.get(k).code;                 // field mnemonic -> input code
const fieldsIn = (formula) => [...new Set((formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).filter((t) => inputs.byField.has(t)))].map(F);

/* ---------------------------------------------------------------- EQ: 109 published equations */
const COMPOSITE = {
  'DEF-018': ['100*(.30*clamp(1-(GA/GP)/6,0,1) + .25*POS-001 + .20*clamp(1-(HDCA/GP)/20,0,1) + .15*DEF-010 + .10*DEF-014)', ['GA', 'GP', 'HDCA'], ['POS-001', 'DEF-010', 'DEF-014']],
  'GOL-015': ['100*(.35*GOL-001 + .25*GOL-006 + .20*GOL-009 + .10*(1-GOL-010) + .10*clamp(GS/GP,0,1))', ['GS', 'GP'], ['GOL-001', 'GOL-006', 'GOL-009', 'GOL-010']],
  'TRN-012': ['100*(.22*TRN-001 + .18*TRN-002 + .20*TRN-003 + .15*TRN-004 + .15*TRN-005 + .10*(1-TRN-009))', [], ['TRN-001', 'TRN-002', 'TRN-003', 'TRN-004', 'TRN-005', 'TRN-009']],
  'TEAM-006': ['1000*(OFF-004 + SV/SA)', ['SV', 'SA'], ['OFF-004']],
  'TEAM-012': ['100*(.28*TEAM-001 + .22*POS-004 + .18*G/(G+GA) + .16*clamp(TEAM-007/110,0,1) + .16*clamp(GOL-015/100,0,1))', ['G', 'GA'], ['TEAM-001', 'POS-004', 'TEAM-007', 'GOL-015']],
  'VAL-005': ['100*(.35*clamp(VAL-002/1.5,0,1) + .25*clamp(VAL-001/.7,0,1) + .20*clamp((VAL-004+2)/4,0,1) + .20*clamp(60*(PLAYER_SOG/PLAYER_TOI)/15,0,1))', ['PLAYER_SOG', 'PLAYER_TOI'], ['VAL-001', 'VAL-002', 'VAL-004']],
  'ADV-001': ['100 + 18*(TEAM-001-.5) + 16*(POS-004-.5) + 12*(POS-001-.5) + .18*(GOL-015-70) + .12*(TRN-012-70)', [], ['TEAM-001', 'POS-004', 'POS-001', 'GOL-015', 'TRN-012']],
  'ADV-002': ['TEAM-012*(1 + .35*(OPP_STRENGTH-50)/50)', ['OPP_STRENGTH'], ['TEAM-012']],
  'ADV-003': ['100*(.40*POS-004 + .30*POS-005 + .30*POS-001)', [], ['POS-004', 'POS-005', 'POS-001']],
  'ADV-004': ['clamp(50 + 700*(GOL-001-LEAGUE_SV_PCT) + .35*(GOL-015-70) - .25*DEF-003, 0, 100)', ['LEAGUE_SV_PCT'], ['GOL-001', 'GOL-015', 'DEF-003']],
  'ADV-005': ['100*(PPG/PP_OPP + (1-PPGA/PK_OPP) - 1)', ['PPG', 'PP_OPP', 'PPGA', 'PK_OPP'], []]
};
for (const s of engine.equationInventory()) {
  const comp = COMPOSITE[s.id];
  add({ code: s.id, stage: 'EQ', family: s.category, label: s.name, formula: comp ? comp[0] : s.formula, catalogFormula: s.formula, status: s.status,
    unit: '', bounds: [s.lower, s.upper], deps: comp ? [...comp[1].map(F), ...comp[2]] : fieldsIn(s.formula), published: true });
}

/* ---------------------------------------------------------------- ML intermediates */
const ENTS = {
  OFF: { name: 'Offense', phase: '2π·clamp(OFF-004,0,1)', phaseDeps: ['OFF-004'], kappa: 'gp = clamp(GP/82,0,1)', kappaDeps: [F('GP')],
    c: [['normalize(OFF-001, 3.0, 1.5)', 'scoring rate', ['OFF-001']], ['normalize(OFF-004, .10, .05)', 'shooting %', ['OFF-004']], ['normalize(POS-004, .50, .16)', 'xG share', ['POS-004']], ['normalize(OFF-010, .45, .25)', 'high-danger share', ['OFF-010']], ['normalize(OFF-024, 1, .45)', 'finishing ratio', ['OFF-024']]],
    v: [['gp', 'games exposure', ['GP']], ['clamp(SOG/3000,0,1)', 'shot exposure', ['SOG']], ['clamp(SCF/2500,0,1)', 'chance exposure', ['SCF']], ['clamp(HDCF/1200,0,1)', 'high-danger exposure', ['HDCF']], ['clamp(xGF/350,0,1)', 'xG exposure', ['xGF']]] },
  POS: { name: 'Possession', phase: '2π·clamp(POS-001,0,1)', phaseDeps: ['POS-001'], kappa: 'gp', kappaDeps: [F('GP')],
    c: [['normalize(POS-001, .5, .15)', 'Corsi share', ['POS-001']], ['normalize(POS-002, .5, .15)', 'Fenwick share', ['POS-002']], ['normalize(POS-005, .5, .18)', 'high-danger share', ['POS-005']], ['normalize(POS-007, .5, .15)', 'score-adjusted Corsi', ['POS-007']], ['normalize(POS-009, 0, 15)', 'Corsi differential', ['POS-009']]],
    v: [['gp', 'games exposure', ['GP']], ['clamp(CF/5000,0,1)', 'Corsi exposure', ['CF']], ['clamp(FF/4200,0,1)', 'Fenwick exposure', ['FF']], ['clamp(CLOSE_CF/2500,0,1)', 'close-state exposure', ['CLOSE_CF']], ['clamp(SCORE_ADJ_CF/5000,0,1)', 'score-adjusted exposure', ['SCORE_ADJ_CF']]] },
  TRN: { name: 'Transition', phase: '2π·clamp(TRN-008,0,1)', phaseDeps: ['TRN-008'], kappa: 'gp', kappaDeps: [F('GP')],
    c: [['normalize(TRN-001, .55, .30)', 'controlled entries', ['TRN-001']], ['normalize(TRN-003, .55, .30)', 'controlled exits', ['TRN-003']], ['normalize(TRN-005, .65, .25)', 'entry retention', ['TRN-005']], ['normalize(TRN-008, .60, .25)', 'neutral-zone control', ['TRN-008']], ['normalize(TRN-012, 70, 25)', 'transition composite', ['TRN-012']]],
    v: [['gp', 'games exposure', ['GP']], ['clamp(ENTRIES/2200,0,1)', 'entry exposure', ['ENTRIES']], ['clamp(EXITS/2200,0,1)', 'exit exposure', ['EXITS']], ['clamp(ENTRY_SHOTS/1200,0,1)', 'entry-shot exposure', ['ENTRY_SHOTS']], ['clamp(CONTROLLED_ENTRIES/1500,0,1)', 'controlled-entry exposure', ['CONTROLLED_ENTRIES']]] },
  DEF: { name: 'Defense', phase: '2π·clamp(1-DEF-001/6,0,1)', phaseDeps: ['DEF-001'], kappa: 'gp', kappaDeps: [F('GP')],
    c: [['normalize(3.0-DEF-001, 0, 1.5)', 'goals-against suppression', ['DEF-001']], ['normalize(28-DEF-008, 0, 15)', 'chance suppression', ['DEF-008']], ['normalize(12-DEF-009, 0, 8)', 'high-danger suppression', ['DEF-009']], ['normalize(DEF-010, .22, .18)', 'shot blocking', ['DEF-010']], ['normalize(DEF-018, 70, 25)', 'defensive composite', ['DEF-018']]],
    v: [['gp', 'games exposure', ['GP']], ['clamp(SA/3000,0,1)', 'shots-against exposure', ['SA']], ['clamp(SCA/2500,0,1)', 'chances-against exposure', ['SCA']], ['clamp(HDCA/1200,0,1)', 'high-danger-against exposure', ['HDCA']], ['clamp(BLOCKS/1800,0,1)', 'block exposure', ['BLOCKS']]] },
  GOL: { name: 'Goaltending', phase: '2π·clamp(GOL-001,0,1)', phaseDeps: ['GOL-001'], kappa: 'clamp(GS/70,0,1)', kappaDeps: [F('GS')],
    c: [['normalize(GOL-001, .905, .05)', 'save %', ['GOL-001']], ['normalize(2.9-GOL-002, 0, 1.5)', 'goals-against average', ['GOL-002']], ['normalize(GOL-006, .88, .10)', 'high-danger save %', ['GOL-006']], ['normalize(GOL-009, .55, .30)', 'quality starts', ['GOL-009']], ['normalize(GOL-015, 75, 25)', 'stability index', ['GOL-015']]],
    v: [['gp', 'games exposure', ['GP']], ['clamp(SA_G/3000,0,1)', 'goalie shot exposure', ['SA_G']], ['clamp(HDSA/1100,0,1)', 'high-danger exposure', ['HDSA']], ['clamp(GS/82,0,1)', 'start exposure', ['GS']], ['clamp(MIN_G/5000,0,1)', 'minutes exposure', ['MIN_G']]] },
  SPT: { name: 'Special teams', phase: '2π·clamp(TEAM-007/200,0,1)', phaseDeps: ['TEAM-007'], kappa: 'gp', kappaDeps: [F('GP')],
    c: [['normalize(PPG/PP_OPP, .20, .15)', 'power-play %', ['PPG', 'PP_OPP']], ['normalize(1-PPGA/PK_OPP, .80, .15)', 'penalty-kill %', ['PPGA', 'PK_OPP']], ['normalize(TEAM-007, 100, 30)', 'special-teams index', ['TEAM-007']], ['normalize(TEAM-009, 0, .5)', 'penalty differential', ['TEAM-009']], ['normalize(TEAM-008, .5, .12)', 'faceoff %', ['TEAM-008']]],
    v: [['gp', 'games exposure', ['GP']], ['clamp(PP_OPP/350,0,1)', 'power-play exposure', ['PP_OPP']], ['clamp(PK_OPP/350,0,1)', 'penalty-kill exposure', ['PK_OPP']], ['clamp(FO_TAKEN/6000,0,1)', 'faceoff exposure', ['FO_TAKEN']], ['clamp((PP_OPP+PK_OPP)/700,0,1)', 'special-teams exposure', ['PP_OPP', 'PK_OPP']]] },
  TEAM: { name: 'Team', phase: '2π·clamp(TEAM-001,0,1)', phaseDeps: ['TEAM-001'], kappa: 'gp', kappaDeps: [F('GP')],
    c: [['normalize(TEAM-001, .5, .25)', 'points %', ['TEAM-001']], ['normalize(TEAM-002, .5, .25)', 'win %', ['TEAM-002']], ['normalize(TEAM-004, 0, 2)', 'goal differential', ['TEAM-004']], ['normalize(TEAM-005, .5, .25)', 'Pythagorean %', ['TEAM-005']], ['normalize(TEAM-012, 55, 30)', 'strength composite', ['TEAM-012']]],
    v: [['gp', 'games exposure', ['GP']], ['clamp(POINTS/130,0,1)', 'points exposure', ['POINTS']], ['clamp(G/350,0,1)', 'goals-for exposure', ['G']], ['clamp(GA/350,0,1)', 'goals-against exposure', ['GA']], ['clamp(W/60,0,1)', 'wins exposure', ['W']]] },
  OPP: { name: 'Opponent', phase: '2π·clamp(OPP_XGF_PCT,0,1)', phaseDeps: [F('OPP_XGF_PCT')], kappa: '0.9 (fixed)', kappaDeps: [],
    c: [['normalize(OPP_GFPG, 3, .9)', 'opponent scoring', ['OPP_GFPG']], ['normalize(3-OPP_GAPG, 0, .9)', 'opponent prevention', ['OPP_GAPG']], ['normalize(OPP_XGF_PCT, .5, .15)', 'opponent xG share', ['OPP_XGF_PCT']], ['normalize(OPP_CF_PCT, .5, .15)', 'opponent Corsi share', ['OPP_CF_PCT']], ['normalize(OPP_SV_PCT, .905, .04)', 'opponent save %', ['OPP_SV_PCT']]],
    v: [['gp', 'games exposure', ['GP']], ['0.85 (fixed)', 'fixed evidence', []], ['0.85 (fixed)', 'fixed evidence', []], ['0.80 (fixed)', 'fixed evidence', []], ['0.90 (fixed)', 'fixed evidence', []]] }
};
const dep = (x) => (inputs.byField.has(x) ? F(x) : x);
const PAIRS = { OFF: [['OP', 'OT'], 'W_OP + W_OT', 'W_OP·W_OT'], POS: [['OP', 'PD'], 'W_OP + W_PD', 'W_OP·W_PD'], TRN: [['OT', 'PT'], 'W_OT + W_PT', 'W_OT·W_PT'], DEF: [['PD', 'DG'], 'W_PD + W_DG', 'W_PD·W_DG'],
  GOL: [['DG', 'GT'], 'W_DG + W_GT', 'W_DG·W_GT'], SPT: [['TS'], 'W_TS', 'W_TS²'], TEAM: [['GT', 'TS', 'TO'], 'W_GT + W_TS + W_TO', 'W_GT·W_TS'], OPP: [['TO'], 'W_TO', 'W_TO²'] };
for (const [e, d] of Object.entries(ENTS)) {
  const k = `ML-${e}-`, low = e.toLowerCase(), N = d.name;
  d.c.forEach(([f, l, ds], i) => add({ code: `${k}C${i + 1}`, stage: 'ML', family: `${N} state`, label: `${N} raw state ${i + 1}: ${l}`, symbol: `c̃_${e},${i + 1}`, formula: f, deps: ds.map(dep) }));
  d.c.forEach(([, l], i) => add({ code: `${k}Q${i + 1}`, stage: 'ML', family: `${N} state`, label: `${N} lattice state ${i + 1}: ${l}`, symbol: `c_${e},${i + 1}`, formula: `ℓ·clamp(round(clamp(${k}C${i + 1},-1,1)/ℓ), -M, M)  (ℓ=lattice_step .1, M=lattice_bound 1)`, deps: [`${k}C${i + 1}`] }));
  d.v.forEach(([f, l, ds], i) => add({ code: `${k}V${i + 1}`, stage: 'ML', family: `${N} evidence`, label: `${N} evidence ${i + 1}: ${l}`, symbol: `e_${e},${i + 1}`, formula: f, deps: ds.map(dep) }));
  const Q = [1, 2, 3, 4, 5].map((i) => `${k}Q${i}`);
  add({ code: `${k}PH`, stage: 'ML', family: `${N} dynamics`, label: `${N} phase angle`, symbol: `θ_${e}`, formula: d.phase, unit: 'radians', deps: d.phaseDeps.map(dep) });
  add({ code: `${k}KAP`, stage: 'ML', family: `${N} dynamics`, label: `${N} exposure gate κ`, symbol: `κ_${e}`, formula: d.kappa, deps: d.kappaDeps });
  add({ code: `${k}D`, stage: 'ML', family: `${N} dynamics`, label: `${N} metric distance from the origin`, symbol: `d_${e}`, formula: 'sqrt(Σ g_k·c_k²)/3  (G5 = diag(1, 1.2, 1, .8, 1.1))', deps: Q });
  add({ code: `${k}EN`, stage: 'ML', family: `${N} dynamics`, label: `${N} level E`, symbol: `E_${e}`, formula: 'clamp((Σ c_k + 5)/10, 0, 1)', deps: Q });
  add({ code: `${k}U`, stage: 'ML', family: `${N} dynamics`, label: `${N} uniformity u`, symbol: `u_${e}`, formula: 'clamp(1 - sqrt(var(c))/1.5, 0, 1)', deps: Q });
  add({ code: `${k}X`, stage: 'ML', family: `${N} dynamics`, label: `${N} imbalance X`, symbol: `X_${e}`, formula: 'clamp(|c_1 - c_2|/2, 0, 1)', deps: [Q[0], Q[1]] });
  add({ code: `${k}CHI`, stage: 'ML', family: `${N} dynamics`, label: `${N} friction χ`, symbol: `χ_${e}`, formula: '0.2·X', deps: [`${k}X`] });
  add({ code: `${k}PAIR`, stage: 'ML', family: `${N} dynamics`, label: `${N} pair coupling input`, symbol: `Σ_j W_${e},j`, formula: PAIRS[e][1], deps: PAIRS[e][0].map((p) => 'ML-W-' + p) });
  add({ code: `${k}TRIAD`, stage: 'ML', family: `${N} dynamics`, label: `${N} triad coupling input`, symbol: `Σ H_${e}`, formula: PAIRS[e][2], deps: PAIRS[e][0].map((p) => 'ML-W-' + p) });
  add({ code: `${k}H`, stage: 'ML', family: `${N} dynamics`, label: `${N} field h`, symbol: `h_${e}`, formula: 'β(M+½-d) + α_E·E + α_u·u - α_X·X - α_ζ·ζ + J2·pair + J3·triad  (β .8, α_E .7, α_u .5, α_X .6, α_ζ 1, J2 .4, J3 .2)', deps: [`${k}D`, `${k}EN`, `${k}U`, `${k}X`, `${k}PAIR`, `${k}TRIAD`] });
  add({ code: `${k}P`, stage: 'ML', family: `${N} dynamics`, label: `${N} admission probability p`, symbol: `p_${e}`, formula: 'σ(h) = 1/(1+e^-h)', unit: 'probability', deps: [`${k}H`] });
  add({ code: `${k}B5`, stage: 'ML', family: `${N} dynamics`, label: `${N} boundary product B5`, symbol: `B5(c_${e})`, formula: 'Π_k clamp(1 - |c_k|/1.25, 0, 1)', deps: Q });
  add({ code: `${k}TEMPO`, stage: 'ML', family: `${N} dynamics`, label: `${N} tempo factor`, symbol: `v(ω_${e})`, formula: 'exp(-(ω-ω*)²/(2σ_ω²))  (ω = ω* = 1 -> 1)', deps: [] });
  add({ code: `${k}S`, stage: 'ML', family: `${N} dynamics`, label: `${N} readiness s`, symbol: `s_${e}`, formula: 'clamp(p·κ·(1-χ)·(1-ξ)·v(ω), 0, 1)', deps: [`${k}P`, `${k}KAP`, `${k}CHI`, `${k}TEMPO`] });
  add({ code: `${k}R`, stage: 'ML', family: `${N} dynamics`, label: `${N} S³ radius r`, symbol: `r_${e}`, formula: 'r_max·B5^α·s^(1/3)  (r_max 10, α .2)', deps: [`${k}B5`, `${k}S`] });
  add({ code: `${k}ETA`, stage: 'ML', family: `${N} dynamics`, label: `${N} independent evidence η_ind`, symbol: `η_${e}`, formula: 'e_5² / (‖e‖² + ε)', deps: [1, 2, 3, 4, 5].map((i) => `${k}V${i}`) });
  void low;
}
const ROLE = { OP: ['OFF', 'POS', 0.2], OT: ['OFF', 'TRN', 0.25], PT: ['POS', 'TRN', 0.2], PD: ['POS', 'DEF', 0.25], DG: ['DEF', 'GOL', 0.2], GT: ['GOL', 'TEAM', 0.3], TS: ['TEAM', 'SPT', 0.2], TO: ['TEAM', 'OPP', 0.45], OD: ['OFF', 'DEF', 0.3], TT: ['TRN', 'TEAM', 0.3] };
for (const [k, [a, b, role]] of Object.entries(ROLE)) {
  add({ code: `ML-W-${k}`, stage: 'ML', family: 'Couplings', label: `${ENTS[a].name}–${ENTS[b].name} coupling weight`, symbol: `W_${k}`, formula: `exp(-(d_G(c_${a},c_${b})²/(2σ_c²) + ${role}²/(2σ_J²)))  (σ_c .95, σ_J .80)`, deps: [1, 2, 3, 4, 5].flatMap((i) => [`ML-${a}-Q${i}`, `ML-${b}-Q${i}`]) });
}
for (const [k, a, b] of [['OP', 'OFF', 'POS'], ['OT', 'OFF', 'TRN'], ['PT', 'POS', 'TRN'], ['PD', 'POS', 'DEF'], ['PG', 'POS', 'GOL'], ['DG', 'DEF', 'GOL'], ['TT', 'TRN', 'TEAM'], ['GT', 'GOL', 'TEAM'], ['TS', 'TEAM', 'SPT'], ['OD', 'OFF', 'DEF']]) {
  add({ code: `ML-RHO-${k}`, stage: 'ML', family: 'Couplings', label: `${ENTS[a].name}–${ENTS[b].name} phase coherence`, symbol: `ρ_${k}`, formula: `(1 + cos(θ_${b} - θ_${a}))/2`, deps: [`ML-${a}-PH`, `ML-${b}-PH`] });
}
add({ code: 'ML-G-DR', stage: 'ML', family: 'Matchup', label: 'Team–opponent radius difference', symbol: 'Δr', formula: '(r_TEAM - r_OPP)/10', deps: ['ML-TEAM-R', 'ML-OPP-R'] });
add({ code: 'ML-V-BASEOFF', stage: 'ML', family: 'Value', label: 'Baseline offensive value', symbol: 'base_off', formula: 'clamp(.35·TEAM-001 + .35·POS-004 + .30·clamp(TEAM-012/100,0,1), 0, 1)', deps: ['TEAM-001', 'POS-004', 'TEAM-012'] });
add({ code: 'ML-V-BASEPREV', stage: 'ML', family: 'Value', label: 'Baseline prevention value', symbol: 'base_prevention', formula: 'clamp(.45·GOL-001 + .30·(1-clamp(DEF-001/6,0,1)) + .25·clamp(DEF-018/100,0,1), 0, 1)', deps: ['GOL-001', 'DEF-001', 'DEF-018'] });
add({ code: 'ML-V-OFFHYB', stage: 'ML', family: 'Value', label: 'Coupled offensive hybrid', symbol: 'off_hybrid', formula: 'clamp(.35·mean(s_OFF,s_POS,s_TRN) + .25·OFF8S-003/100 + .20·OFF8S-005 + .20·mean(p_OFF,p_POS,p_TRN), 0, 1)', deps: ['ML-OFF-S', 'ML-POS-S', 'ML-TRN-S', 'OFF8S-003', 'OFF8S-005', 'ML-OFF-P', 'ML-POS-P', 'ML-TRN-P'] });
add({ code: 'ML-V-PREVHYB', stage: 'ML', family: 'Value', label: 'Coupled prevention hybrid', symbol: 'prevention_hybrid', formula: 'clamp(.40·mean(s_DEF,s_GOL) + .25·DEF8S-003/100 + .20·DEF8S-005 + .15·mean(p_DEF,p_GOL), 0, 1)', deps: ['ML-DEF-S', 'ML-GOL-S', 'DEF8S-003', 'DEF8S-005', 'ML-DEF-P', 'ML-GOL-P'] });
add({ code: 'ML-V-OFFDELTA', stage: 'ML', family: 'Value', label: 'Offensive coupling delta', symbol: 'off_delta', formula: '.5·(off_hybrid - base_off)', deps: ['ML-V-OFFHYB', 'ML-V-BASEOFF'] });
add({ code: 'ML-V-PREVDELTA', stage: 'ML', family: 'Value', label: 'Prevention coupling delta', symbol: 'prevention_delta', formula: '.5·(prevention_hybrid - base_prevention)', deps: ['ML-V-PREVHYB', 'ML-V-BASEPREV'] });
add({ code: 'ML-V-ETAALL', stage: 'ML', family: 'Value', label: 'Independent evidence η_ind (all entities)', symbol: 'η_ind', formula: '(OFF8S-005 + DEF8S-005 + η_SPT + η_TEAM + η_OPP)/5', deps: ['OFF8S-005', 'DEF8S-005', 'ML-SPT-ETA', 'ML-TEAM-ETA', 'ML-OPP-ETA'] });

/* ---------------------------------------------------------------- ML: 32 published models */
const ML_DEPS = {
  'OFF8S-001': ['ML-OFF-S', 'ML-POS-S', 'ML-W-OP', 'ML-RHO-OP'], 'OFF8S-002': ['ML-OFF-S', 'ML-TRN-S', 'ML-W-OT', 'ML-RHO-OT'],
  'OFF8S-003': ['ML-OFF-S', 'ML-POS-S', 'ML-TRN-S', 'ML-W-OP', 'ML-W-OT', 'ML-W-PT', 'ML-RHO-OP', 'ML-RHO-OT', 'ML-RHO-PT'],
  'OFF8S-004': ['ML-OFF-R', 'ML-POS-R', 'ML-TRN-R'], 'OFF8S-005': ['ML-OFF-ETA', 'ML-POS-ETA', 'ML-TRN-ETA'], 'OFF8S-006': ['ML-OFF-P', 'ML-POS-P', 'ML-TRN-P'],
  'DEF8S-001': ['ML-POS-S', 'ML-DEF-S', 'ML-W-PD', 'ML-RHO-PD'], 'DEF8S-002': ['ML-DEF-S', 'ML-GOL-S', 'ML-W-DG', 'ML-RHO-DG'],
  'DEF8S-003': ['ML-POS-S', 'ML-DEF-S', 'ML-GOL-S', 'ML-W-PD', 'ML-W-DG', 'ML-W-OD', 'ML-RHO-PD', 'ML-RHO-PG', 'ML-RHO-DG'],
  'DEF8S-004': ['ML-POS-R', 'ML-DEF-R', 'ML-GOL-R'], 'DEF8S-005': ['ML-DEF-ETA', 'ML-GOL-ETA'], 'DEF8S-006': ['ML-DEF-P', 'ML-GOL-P'],
  'TRN8S-001': ['ML-OFF-S', 'ML-TRN-S', 'ML-W-OT', 'ML-RHO-OT'], 'TRN8S-002': ['ML-TRN-S', 'ML-TEAM-S', 'ML-W-TT', 'ML-RHO-TT'], 'TRN8S-003': ['ML-TRN-R'],
  'GOL8S-001': ['ML-DEF-S', 'ML-GOL-S', 'ML-W-DG', 'ML-RHO-DG'], 'GOL8S-002': ['ML-GOL-S', 'ML-TEAM-S', 'ML-W-GT', 'ML-RHO-GT'], 'GOL8S-003': ['ML-GOL-R'],
  'TEAM8S-001': ['ML-OFF-S', 'ML-DEF-S', 'ML-W-OD', 'ML-RHO-OD'], 'TEAM8S-002': ['ML-TEAM-S', 'ML-SPT-S', 'ML-W-TS', 'ML-RHO-TS'], 'TEAM8S-003': ['ML-OFF-R'],
  'TEAM8S-004': ['ML-DEF-R', 'ML-GOL-R'], 'TEAM8S-005': ['TEAM-001', 'ML-TEAM-P', 'ML-OFF-P', 'ML-DEF-P', 'ML-SPT-P'],
  'MATCH8S-001': [...[1, 2, 3, 4, 5].flatMap((i) => [`ML-TEAM-Q${i}`, `ML-OPP-Q${i}`]), 'ML-TEAM-R', 'ML-OPP-R'],
  'MATCH8S-002': [...[1, 2, 3, 4, 5].flatMap((i) => [`ML-TEAM-Q${i}`, `ML-OPP-Q${i}`]), 'ML-G-DR'],
  'MATCH8S-003': [...[1, 2, 3].flatMap((i) => [`ML-TEAM-Q${i}`, `ML-OPP-Q${i}`]), 'ML-TEAM-R', 'ML-OPP-R'],
  'MATCH8S-004': ['TEAM-012', F('OPP_STRENGTH')], 'MATCH8S-005': ['MATCH8S-001', 'MATCH8S-002', 'MATCH8S-003', 'MATCH8S-004'],
  'VAL8S-001': ['ML-V-BASEOFF', 'ML-V-OFFDELTA'], 'VAL8S-002': ['ML-V-BASEPREV', 'ML-V-PREVDELTA'], 'VAL8S-003': ['ML-V-OFFDELTA', 'ML-V-PREVDELTA', 'TEAM8S-001'],
  'ADM8S-001': ['HK-GATE', 'ML-V-ETAALL', 'VAL8S-003']
};
/* ---------------------------------------------------------------- X8S */
const n100 = (c) => `clamp(${c}/100,0,1)`, rad = (c) => `clamp(${c}/10,0,1)`, ne = (c) => `clamp(${c},0,1)`;
const ANCH = {
  'X8S-A01': ['Offensive', [[n100('OFF8S-001'), 'OFF8S-001'], [n100('OFF8S-002'), 'OFF8S-002'], [n100('OFF8S-003'), 'OFF8S-003'], [rad('OFF8S-004'), 'OFF8S-004'], [ne('OFF8S-005'), 'OFF8S-005'], [ne('OFF8S-006'), 'OFF8S-006'], [n100('TEAM8S-001'), 'TEAM8S-001'], [n100('VAL8S-001'), 'VAL8S-001']]],
  'X8S-A02': ['Prevention', [[n100('DEF8S-001'), 'DEF8S-001'], [n100('DEF8S-002'), 'DEF8S-002'], [n100('DEF8S-003'), 'DEF8S-003'], [rad('DEF8S-004'), 'DEF8S-004'], [ne('DEF8S-005'), 'DEF8S-005'], [ne('DEF8S-006'), 'DEF8S-006'], [n100('GOL8S-001'), 'GOL8S-001'], [n100('VAL8S-002'), 'VAL8S-002']]],
  'X8S-A03': ['Transition', [[n100('TRN8S-001'), 'TRN8S-001'], [n100('TRN8S-002'), 'TRN8S-002'], [rad('TRN8S-003'), 'TRN8S-003'], [ne('OFF8S-005'), 'OFF8S-005'], [ne('OFF8S-006'), 'OFF8S-006'], ['gap_overlap', 'X8S-T-GAP'], ['gain_support', 'X8S-T-GAIN'], ['admit', 'X8S-T-ADMIT']]],
  'X8S-A04': ['Goaltending', [[n100('GOL8S-001'), 'GOL8S-001'], [n100('GOL8S-002'), 'GOL8S-002'], [rad('GOL8S-003'), 'GOL8S-003'], [ne('DEF8S-005'), 'DEF8S-005'], [ne('DEF8S-006'), 'DEF8S-006'], [n100('TEAM8S-004'), 'TEAM8S-004'], ['gap_overlap', 'X8S-T-GAP'], ['admit', 'X8S-T-ADMIT']]],
  'X8S-A05': ['Team', [[n100('TEAM8S-001'), 'TEAM8S-001'], [n100('TEAM8S-002'), 'TEAM8S-002'], [rad('TEAM8S-003'), 'TEAM8S-003'], [rad('TEAM8S-004'), 'TEAM8S-004'], [ne('TEAM8S-005'), 'TEAM8S-005'], ['gain_support', 'X8S-T-GAIN'], ['gap_overlap', 'X8S-T-GAP'], ['admit', 'X8S-T-ADMIT']]],
  'X8S-A06': ['Matchup', [['gap_overlap', 'X8S-T-GAP'], ['clamp(1-MATCH8S-002/1.5,0,1)', 'MATCH8S-002'], ['clamp(1-max(MATCH8S-003,0)/1.5,0,1)', 'MATCH8S-003'], ['clamp((MATCH8S-004+1)/2,0,1)', 'MATCH8S-004'], ['clamp(MATCH8S-005/3,0,1)', 'MATCH8S-005'], [ne('OFF8S-006'), 'OFF8S-006'], [ne('DEF8S-006'), 'DEF8S-006'], ['admit', 'X8S-T-ADMIT']]],
  'X8S-A07': ['Evidence', [[ne('OFF8S-005'), 'OFF8S-005'], [ne('DEF8S-005'), 'DEF8S-005'], ['clamp(η_ind,0,1)', 'HK-ETA'], [ne('OFF8S-006'), 'OFF8S-006'], [ne('DEF8S-006'), 'DEF8S-006'], ['gain_support', 'X8S-T-GAIN'], ['gap_overlap', 'X8S-T-GAP'], ['admit', 'X8S-T-ADMIT']]],
  'X8S-A08': ['Admission', [['admit', 'X8S-T-ADMIT'], [ne('OFF8S-006'), 'OFF8S-006'], [ne('DEF8S-006'), 'DEF8S-006'], ['clamp(η_ind,0,1)', 'HK-ETA'], ['gain_support', 'X8S-T-GAIN'], ['gap_overlap', 'X8S-T-GAP'], [ne('TEAM8S-005'), 'TEAM8S-005'], ['clamp(MATCH8S-005/3,0,1)', 'MATCH8S-005']]]
};
add({ code: 'X8S-T-GAP', stage: 'X8S', family: 'X8S terms', label: 'Five-dimensional gap overlap', symbol: 'gap_overlap', formula: 'clamp(1 - max(MATCH8S-001,0)/1.5, 0, 1)', deps: ['MATCH8S-001'] });
add({ code: 'X8S-T-GAIN', stage: 'X8S', family: 'X8S terms', label: 'Gain support', symbol: 'gain_support', formula: 'clamp(.5 + 10·Δ8S, 0, 1)', deps: ['HK-D8S'] });
add({ code: 'X8S-T-ADMIT', stage: 'X8S', family: 'X8S terms', label: 'Master admission indicator', symbol: 'admit', formula: '1 iff Master Law admission = ADMIT_8S', deps: ['ADM8S-001'] });
for (const [a, [nm, comps]] of Object.entries(ANCH)) comps.forEach(([f, d], i) => add({ code: `${a}-V${i + 1}`, stage: 'X8S', family: `${nm} anchor vector`, label: `${nm} anchor component ${i + 1}`, symbol: `v_${a.slice(-3)},${i + 1}`, formula: f, deps: [d] }));
const A = Object.keys(ANCH);
const X8S_DEPS = { 'X8S-C01': ['X8S-A01', 'X8S-A02', 'X8S-A04', 'X8S-A05', 'X8S-A06'], 'X8S-C02': A, 'X8S-C03': A, 'X8S-C04': ['X8S-A01', 'X8S-A02'], 'X8S-C05': ['X8S-A02', 'X8S-A04', 'X8S-A05', 'X8S-A07', 'X8S-C09'],
  'X8S-C06': ['OFF8S-004', 'DEF8S-004', 'TRN8S-003', 'GOL8S-003', 'X8S-T-GAIN', 'TEAM8S-005', 'X8S-T-ADMIT'], 'X8S-C07': ['X8S-T-GAP', 'MATCH8S-002', 'X8S-A07', 'X8S-T-ADMIT'], 'X8S-C08': ['X8S-A07'], 'X8S-C09': A,
  'X8S-C10': ['X8S-C03', 'X8S-T-GAIN', 'X8S-T-GAP', 'OFF8S-004', 'DEF8S-004'], 'X8S-C11': ['TEAM8S-005', 'X8S-A05', 'X8S-C03', 'X8S-A06', 'X8S-A07', 'X8S-T-GAIN'], 'X8S-C12': ['X8S-A01', 'X8S-A02', 'X8S-T-GAP', 'VAL8S-001', 'VAL8S-002'],
  'X8S-C13': ['X8S-A01', 'X8S-A02', 'X8S-T-GAP', 'VAL8S-001', 'VAL8S-002'], 'X8S-C14': ['HK-D8S', 'X8S-C03', 'X8S-A05'], 'X8S-C15': ['X8S-A08', 'X8S-A07', 'X8S-C07', 'X8S-C09', 'X8S-T-ADMIT'],
  'X8S-C16': ['X8S-A01', 'X8S-A02', 'X8S-A05', 'X8S-A06', 'X8S-A04'], 'X8S-C17': ['X8S-T-ADMIT', 'X8S-C11', 'X8S-C15', 'X8S-A06', 'HK-D8S'], 'X8S-C18': ['X8S-T-ADMIT', 'X8S-A07', 'X8S-C15'] };
for (const a of A) X8S_DEPS[a] = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `${a}-V${i}`);
/* ---------------------------------------------------------------- SP8 */
const SPHERE = [['clamp((X8S-C01+X8S-C02)/200,0,1)', ['X8S-C01', 'X8S-C02']], ['clamp((X8S-C03+X8S-C04)/200,0,1)', ['X8S-C03', 'X8S-C04']], ['clamp(X8S-C05/100,0,1)', ['X8S-C05']], ['clamp((X8S-C06+X8S-C10)/200,0,1)', ['X8S-C06', 'X8S-C10']],
  ['clamp(X8S-C07/100,0,1)', ['X8S-C07']], ['clamp(X8S-C08/100,0,1)', ['X8S-C08']], ['clamp(X8S-A08/100,0,1)', ['X8S-A08']], ['clamp(.5·(X8S-C15/100 + dispersion_stability),0,1)', ['X8S-C15', 'SP8-T-DSTAB']]];
const PROJ = [['clamp(X8S-C11,.001,.999)', 'X8S-C11'], ['clamp(X8S-C12,.001,.999)', 'X8S-C12'], ['clamp(1-X8S-C13,.001,.999)', 'X8S-C13'], ['clamp(X8S-C14/100,.001,.999)', 'X8S-C14'], ['clamp(X8S-C16/100,.001,.999)', 'X8S-C16'], ['clamp(classification_support,.001,.999)', 'SP8-T-CLS'], ['clamp(X8S-C15/100,.001,.999)', 'X8S-C15']];
add({ code: 'SP8-T-DSTAB', stage: 'SP8', family: 'SP8 terms', label: 'Dispersion stability', symbol: 'dispersion_stability', formula: 'clamp(1 - X8S-C09/25, 0, 1)', deps: ['X8S-C09'] });
add({ code: 'SP8-T-CLS', stage: 'SP8', family: 'SP8 terms', label: 'Classification support', symbol: 'classification_support', formula: 'clamp(X8S-C17/4, 0, 1)', deps: ['X8S-C17'] });
SPHERE.forEach(([f, d], i) => add({ code: `SP8-S${i + 1}`, stage: 'SP8', family: '8Sphere adjustment vector', label: `8Sphere adjustment component ${i + 1}`, symbol: `q_${i + 1}`, formula: f, deps: d }));
PROJ.forEach(([f, d], i) => add({ code: `SP8-P${i + 1}`, stage: 'SP8', family: 'Projection support vector', label: `Projection support component ${i + 1}`, symbol: `π_${i + 1}`, formula: f, deps: [d] }));
const L = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `SP8-L0${i}`);
const SP8_DEPS = { 'SP8-C01': L, 'SP8-C02': ['SP8-C01'], 'SP8-C03': SPHERE.map((_, i) => `SP8-S${i + 1}`), 'SP8-C04': SPHERE.map((_, i) => `SP8-S${i + 1}`), 'SP8-C05': ['SP8-C03', 'SP8-C04'], 'SP8-C06': ['SP8-C05'],
  'SP8-C07': L, 'SP8-C08': ['SP8-C01', 'SP8-C06', 'SP8-C07'], 'SP8-C09': PROJ.map((_, i) => `SP8-P${i + 1}`), 'SP8-C10': ['SP8-C09'], 'SP8-C11': ['SP8-C07'], 'SP8-C12': ['X8S-C09', 'SP8-C11'], 'SP8-C13': ['SP8-C07', 'SP8-C08', 'SP8-C10', 'SP8-C12'],
  'SP8-C14': ['SP8-C02', 'SP8-C13'], 'SP8-C15': ['SP8-C07', 'SP8-T-DSTAB', 'X8S-C07', 'X8S-C05', 'X8S-A08', 'X8S-C15', 'X8S-C03', 'X8S-C01'], 'SP8-C16': ['X8S-C15', 'X8S-C08', 'X8S-A08', 'X8S-C07', 'SP8-C05', 'SP8-C15', 'SP8-T-CLS'],
  'SP8-C17': ['HK-X8S', 'X8S-C18', 'SP8-C13', 'SP8-C15', 'SP8-C16'], 'SP8-C18': ['HK-X8S', 'X8S-C18', 'SP8-C13', 'SP8-C16'] };
L.forEach((l, i) => { SP8_DEPS[l] = [`X8S-A0${i + 1}`]; });

/* ---------------------------------------------------------------- published 84 (ML 32 + X8S 26 + SP8 26) from the corpus plates */
for (const p of corpus.plates) {
  const stage = p.id.startsWith('X8S') ? 'X8S' : p.id.startsWith('SP8') ? 'SP8' : 'ML';
  const deps = ML_DEPS[p.id] || X8S_DEPS[p.id] || SP8_DEPS[p.id] || [];
  add({ code: p.id, stage, family: p.category, label: p.title, symbol: (p.equation.split('=')[0] || '').trim().length < 24 && p.equation.includes('=') ? p.equation.split('=')[0].trim() : '', formula: p.equation, unit: p.unit, deps, published: true, plate: p.id });
}
/* ---------------------------------------------------------------- receipt-level results */
add({ code: 'HK-GATE', stage: 'SUM', family: 'Receipt', label: 'Mandatory input gate', formula: 'finite required fields, positive exposures, shot/goal, event and special-team relations (engine.go Validate)', deps: ['HKI-001', 'HKI-002', 'HKI-006', 'HKI-007', 'HKI-029'] });
add({ code: 'HK-CONV', stage: 'SUM', family: 'Receipt', label: 'Hockey suite summary (PASS / QUALIFIED / FAIL)', formula: 'counts over the 109 equations', deps: engine.equationInventory().map((s) => s.id) });
add({ code: 'HK-ETA', stage: 'SUM', family: 'Receipt', label: 'η_ind (rounded, master summary)', symbol: 'η_ind', formula: 'round12(ML-V-ETAALL) versus ε_ind = .015', deps: ['ML-V-ETAALL'] });
add({ code: 'HK-D8S', stage: 'SUM', family: 'Receipt', label: 'Δ8S gain (rounded, master summary)', symbol: 'Δ_8S', formula: 'round12(VAL8S-003) versus ε_gain = .005', deps: ['VAL8S-003'] });
add({ code: 'HK-MATCH', stage: 'SUM', family: 'Receipt', label: 'Matchup class', formula: 'OVERLAP_ADVANTAGE | CONTESTED_COMPATIBLE | MIXED_BOUNDARY | SEPARATED', deps: ['MATCH8S-005'] });
add({ code: 'HK-ML', stage: 'SUM', family: 'Receipt', label: 'Master Law admission', formula: 'Admit(8S) ⇔ gate ∧ η_ind ≥ ε_ind ∧ Δ8S ≥ ε_gain', deps: ['ADM8S-001', 'HK-ETA', 'HK-D8S', 'HK-GATE'] });
add({ code: 'HK-X8S', stage: 'SUM', family: 'Receipt', label: 'First-stage extrapolation admission and class', formula: 'ADMIT_X8S iff master admitted and A07 ≥ 50 and C15 ≥ 55', deps: ['X8S-C17', 'X8S-C18'] });
add({ code: 'HK-SP8', stage: 'SUM', family: 'Receipt', label: '8Sphere admission and class', formula: 'ADMIT_8SPHERE iff X8S admitted and C13 ≥ .10 and C16 ≥ 60', deps: ['SP8-C17', 'SP8-C18'] });
add({ code: 'HK-DISP', stage: 'SUM', family: 'Receipt', label: 'Overall disposition', formula: 'FAIL on any gate/stage failure, else QUALIFIED when synthetic or qualified rows exist, else PASS', deps: ['HK-GATE', 'HK-CONV', 'HK-ML', 'HK-X8S', 'HK-SP8'] });
add({ code: 'HK-SHA', stage: 'SUM', family: 'Receipt', label: 'Canonical receipt SHA-256', formula: 'SHA-256 of the Go-canonical receipt JSON with canonical_sha256 empty', deps: ['HK-DISP'] });

const CATALOG = C;
const byCode = new Map(C.map((x) => [x.code, x]));
/* reverse edges: who reads this code (computations and inputs alike) */
const dependents = new Map();
for (const x of C) for (const d of x.deps) { if (!dependents.has(d)) dependents.set(d, []); dependents.get(d).push(x.code); }
function resolve(token) { const t = String(token || '').trim().toUpperCase(); return byCode.get(t) || null; }
const stats = () => { const s = {}; for (const x of C) { const k = x.stage + (x.published ? ':published' : ':intermediate'); s[k] = (s[k] || 0) + 1; } return s; };
module.exports = { CATALOG, byCode, dependents, resolve, stats, PLATES, ENTS };
