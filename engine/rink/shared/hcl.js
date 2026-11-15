/**
 * RINK-VT Hockey Command Language (HCL) — one lexer/parser for the browser command bar, the SPIRAL `rink` mode and the
 * gateway's ingestion check, so a line is validated identically everywhere (spec §3).
 *
 *   tri-token     TEAM_4 PLAYER_4 STAT[/mod[/mod…]]      FOCO SMIT G · FOCO J91 S/1W · KELW BARK P2/TRP · FOCO HALA ZE/C
 *   corrections   UNDO · DEL <seq> · FIX <seq> TEAM_4 PLAYER_4 STAT[/mods] · FIX #<seq> A1=19 A2=44 XY=78,-4 (HCL key=value form)
 *   lineup        LINE TEAM_4 P1 P2 … (up to 6)            replaces the team's on-ice skaters
 *   clock         T mm:ss [P1|P2|P3|OT|SO|OT2…OT9] · GO · STOP · NEXT · END (final) · CLOCK GO|STOP|NEXT|END|SET mm:ss [Pn]
 *   queries       Q <TARGET> [args] [--key=value]          Q BOX · Q XG · Q RAPM --str=5v5 · Q HK001 FOCO
 *   session       GAME <key> · LOCALE en-CA|fr-CA · HELP · EXIT
 * STAT tokens are the spec's (G S M B A A1 A2 ZE ZX H TK GV FOW FOL P2 P4 P5 P10 P20 PS IN OUT) plus two
 * declared extensions that HK001 inputs need: FC (forecheck attempt) and OMR (odd-man rush).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./codes'));
  else root.RinkHcl = factory(root.RinkCodes);
})(typeof self !== 'undefined' ? self : this, function (codes) {
  'use strict';
  const STATS = {
    G: { kind: 'shot', label: 'Goal (or goalie crease set when the player is a goalie)', inputs: ['G', 'SOG', 'SAT', 'USAT', 'xGF'] },
    S: { kind: 'shot', label: 'Shot on goal', inputs: ['SOG', 'SAT', 'USAT', 'xGF', 'SV'] },
    M: { kind: 'shot', label: 'Missed shot', inputs: ['MISSED', 'SAT', 'USAT', 'xGF'] },
    B: { kind: 'block', label: 'Blocked shot, logged for the blocking player', inputs: ['BLOCKS', 'BLOCKED_FOR', 'SAT'] },
    A: { kind: 'assist', label: 'Assist: binds to the team\'s open goal', inputs: ['A', 'PRIMARY_A', 'SECONDARY_A'] },
    A1: { kind: 'assist', label: 'Primary assist', inputs: ['A', 'PRIMARY_A'] },
    A2: { kind: 'assist', label: 'Secondary assist', inputs: ['A', 'SECONDARY_A'] },
    ZE: { kind: 'transition', label: 'Zone entry (/C controlled, /D dump, /F failed)', inputs: ['ENTRIES', 'ENTRY_ATTEMPTS', 'CONTROLLED_ENTRIES'] },
    ZX: { kind: 'transition', label: 'Zone exit (/C controlled, /D clear, /F failed)', inputs: ['EXITS', 'EXIT_ATTEMPTS', 'CONTROLLED_EXITS'] },
    H: { kind: 'physical', label: 'Hit / body check', inputs: [] },
    TK: { kind: 'physical', label: 'Takeaway', inputs: ['TAKEAWAYS'] },
    GV: { kind: 'physical', label: 'Giveaway', inputs: ['GIVEAWAYS'] },
    FOW: { kind: 'faceoff', label: 'Faceoff win (/O /D /N zone)', inputs: ['FO_WON', 'FO_TAKEN', 'OZ_STARTS', 'DZ_STARTS'] },
    FOL: { kind: 'faceoff', label: 'Faceoff loss (/O /D /N zone)', inputs: ['FO_TAKEN', 'OZ_STARTS', 'DZ_STARTS'] },
    P2: { kind: 'penalty', label: 'Minor penalty (2 min)', inputs: ['PEN_TAKEN', 'PK_OPP'] },
    P4: { kind: 'penalty', label: 'Double minor (2+2 min)', inputs: ['PEN_TAKEN', 'PK_OPP'] },
    P5: { kind: 'penalty', label: 'Major penalty (5 min)', inputs: ['PEN_TAKEN', 'PK_OPP'] },
    P10: { kind: 'penalty', label: 'Misconduct (10 min, no strength change)', inputs: ['PEN_TAKEN'] },
    P20: { kind: 'penalty', label: 'Game misconduct (no strength change)', inputs: ['PEN_TAKEN'] },
    PS: { kind: 'penalty', label: 'Penalty shot awarded to the player', inputs: [] },
    IN: { kind: 'shift', label: 'Shift on (goalie: into the crease)', inputs: ['EV_TOI', 'MIN_G'] },
    OUT: { kind: 'shift', label: 'Shift off (goalie: pulled)', inputs: ['EV_TOI', 'MIN_G'] },
    FC: { kind: 'transition', label: 'Forecheck attempt (RINK-VT extension)', inputs: ['FORECHECK_ATTEMPTS'] },
    OMR: { kind: 'transition', label: 'Odd-man rush (RINK-VT extension)', inputs: ['ODD_MAN_RUSH_FOR', 'ODD_MAN_RUSH_AGAINST'] }
  };
  const SHOT_TYPES = { W: 'WRIST', S: 'SLAP', P: 'SNAP', B: 'BACKHAND', T: 'TIP' };
  const FLAGS = { R: 'rebound', U: 'rush', X: 'royal road' };
  const INFRACTIONS = { TRP: 'Tripping', HOK: 'Hooking', SLH: 'Slashing', HI: 'High-sticking', HS: 'High-sticking', INT: 'Interference', BRD: 'Boarding', RGH: 'Roughing', TOO: 'Too many men', CC: 'Cross-checking',
    ELB: 'Elbowing', HLD: 'Holding', DLY: 'Delay of game', UNS: 'Unsportsmanlike conduct', CHG: 'Charging', KNE: 'Kneeing', FIG: 'Fighting', HTH: 'Head contact', EMB: 'Embellishment', SPR: 'Spearing', BUT: 'Butt-ending', CHK: 'Checking from behind' };
  /* bilingual aliases (spec §7): compiled to the canonical token before framing */
  const FR = { B: 'G', T: 'S', TR: 'M', TB: 'B', M: 'H', E: 'H', RV: 'GV', RC: 'TK', MG: 'FOW', MP: 'FOL', EZ: 'ZE', SZ: 'ZX', ENT: 'IN', SOR: 'OUT', EA: 'FC', SN: 'OMR', TP: 'PS' };
  /* period 4 is OT; period 5 is the shootout in the regular season and the second overtime (OT2) otherwise */
  const PERIODS = { P1: 1, P2: 2, P3: 3, OT: 4, OT1: 4, P4: 4, SO: 5, P5: 5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };
  for (let k = 2; k <= 9; k++) { PERIODS['OT' + k] = 3 + k; if (k > 2) { PERIODS['P' + (3 + k)] = 3 + k; PERIODS[String(3 + k)] = 3 + k; } }
  const MAX_PERIOD = 12;

  const err = (message, at) => ({ kind: 'error', message, at: at === undefined ? -1 : at });
  function parseClock(s) {
    const m = /^(\d{1,2}):(\d{2})(?:\.(\d))?$/.exec(String(s || ''));
    if (!m || Number(m[2]) > 59) return null;
    const ds = (Number(m[1]) * 60 + Number(m[2])) * 10 + (m[3] ? Number(m[3]) : 0);
    return ds > 12000 ? null : ds;                      // at most 20:00.0
  }
  const COORD = /^(-?\d{1,3}(?:\.\d)?),(-?\d{1,2}(?:\.\d)?)$/;
  function parseCoords(s) {
    const m = COORD.exec(s); if (!m) return null;
    const x = Number(m[1]), y = Number(m[2]);
    if (x < -100 || x > 100 || y < -42.5 || y > 42.5) return { error: `coordinates (${x}, ${y}) are off the 200 × 85 ft ice` };
    return { x, y };
  }
  /** Parse "/mod/mod…" for a stat; returns { mods, code (≤4 chars for the frame), coords } or { error } */
  function parseMods(stat, parts) {
    const kind = STATS[stat].kind; const mods = { flags: [] }; let coords = null;
    for (const p of parts) {
      if (!p) return { error: 'empty modifier' };
      const c = parseCoords(p);
      if (c) { if (c.error) return { error: c.error }; if (coords) return { error: 'two coordinate pairs' }; coords = c; continue; }
      const up = p.toUpperCase();
      if (kind === 'penalty') {
        if (stat === 'PS') return { error: 'PS takes no modifier' };
        if (!/^[A-Z]{2,4}$/.test(up)) return { error: `infraction must be 2-4 letters (TRP, HOK, SLH …), not ${p}` };
        if (mods.infraction) return { error: 'one infraction per penalty' };
        mods.infraction = up; continue;
      }
      if (kind === 'faceoff') {
        if (!/^[ODN]$/.test(up)) return { error: 'faceoff zone is /O (offensive), /D (defensive) or /N (neutral)' };
        if (mods.zone) return { error: 'one faceoff zone' };
        mods.zone = up; continue;
      }
      if (kind === 'transition' && (stat === 'ZE' || stat === 'ZX')) {
        if (!/^[CDF]$/.test(up)) return { error: `${stat} type is /C controlled, /D ${stat === 'ZE' ? 'dump-in' : 'clear'}, /F failed` };
        if (mods.entry) return { error: 'one entry/exit type' };
        mods.entry = up; continue;
      }
      if (kind === 'assist' || kind === 'shift' || stat === 'PS') return { error: `${stat} takes no modifier` };
      // shots, blocks, hits, takeaways, giveaways, forechecks, rushes: zone digit / shot type / flags
      for (const ch of up) {
        if (/[1-9]/.test(ch)) { if (mods.spot) return { error: 'one zone digit' }; mods.spot = ch; }
        else if (kind === 'shot' && SHOT_TYPES[ch]) { if (mods.shot) return { error: 'one shot type (W S P B T)' }; mods.shot = ch; }
        else if (kind === 'shot' && FLAGS[ch]) { if (!mods.flags.includes(ch)) mods.flags.push(ch); }
        else return { error: `unknown modifier "${ch}" for ${stat}` };
      }
    }
    const code = (mods.spot || '') + (mods.shot || '') + mods.flags.join('') + (mods.infraction || '') + (mods.zone || '') + (mods.entry || '');
    if (code.length > 4) return { error: `modifiers "${code}" exceed the 4-byte modifier field of the wire frame` };
    return { mods, code, coords };
  }
  /**
   * Server-side check of a frame's STAT and 4-byte MODIFIER fields: the same grammar the lexer applies, and the
   * modifier must be in the canonical order the compiler writes. Returns null when valid, else the reason.
   */
  function checkMod(stat, mod) {
    if (typeof stat !== 'string' || !Object.prototype.hasOwnProperty.call(STATS, stat)) return `unknown STAT_TOKEN "${String(stat).slice(0, 4)}"`;
    if (!mod) return null;
    const m = parseMods(stat, [mod]);
    if (m.error) return m.error;
    if (m.coords) return 'coordinates do not belong in the modifier field';
    if (m.code !== mod) return `modifier "${mod}" is not in canonical order (${m.code})`;
    return null;
  }
  function parseTri(team, player, statTok, locale, at) {
    team = team.toUpperCase();
    if (!codes.TEAM_RE.test(team)) return err(`TEAM_4 must be four letters, not "${team}"`, at);
    const pl = codes.parsePlayerToken(player);
    if (!pl) return err(`PLAYER_4 must be a 4-character code, J+jersey or a jersey number, not "${player}"`, at + 1);
    const [head, ...modParts] = statTok.split('/');
    let stat = head.toUpperCase(); const typed = stat;
    if (locale === 'fr-CA' && FR[stat]) stat = FR[stat];
    if (!Object.prototype.hasOwnProperty.call(STATS, stat)) return err(`unknown STAT_TOKEN "${head}"${locale === 'fr-CA' ? ' (fr-CA)' : ''}`, at + 2);
    const m = parseMods(stat, modParts);
    if (m.error) return err(m.error, at + 2);
    return { kind: 'event', team, player: pl.code || null, jersey: pl.jersey === undefined ? null : pl.jersey, playerToken: pl.raw, stat, typed, mods: m.mods, modCode: m.code, coords: m.coords };
  }
  /** Parse one terminal line. Never throws; errors come back as { kind:'error' }. */
  function parseLine(line, opts) {
    const o = opts || {}; const locale = o.locale || 'en-CA';
    const raw = String(line || '').trim();
    if (!raw) return { kind: 'empty' };
    if (raw.length > 200) return err('line longer than 200 characters');
    const t = raw.split(/\s+/); const U = t.map((x) => x.toUpperCase());
    switch (U[0]) {
      case 'UNDO': return t.length === 1 ? { kind: 'undo', raw } : err('UNDO takes no argument');
      case 'DEL': { const s = /^#?(\d{1,9})$/.exec(t[1] || ''); return s && t.length === 2 ? { kind: 'del', seq: Number(s[1]), raw } : err('usage: DEL <event seq>'); }
      case 'FIX': {
        const s = /^#?(\d{1,9})$/.exec(t[1] || ''); if (!s) return err('usage: FIX <seq> TEAM_4 PLAYER_4 STAT[/mods]  or  FIX #<seq> A1=19 XY=78,-4', 1);
        const seq = Number(s[1]);
        if (t.length === 5 && !t[2].includes('=')) { const e = parseTri(t[2], t[3], t[4], locale, 2); return e.kind === 'error' ? e : { kind: 'fix', seq, patch: { event: e }, raw }; }
        const patch = {};
        for (let i = 2; i < t.length; i++) {
          const kv = /^([A-Za-z0-9]+)=(.+)$/.exec(t[i]); if (!kv) return err(`FIX patch must be KEY=VALUE, not "${t[i]}"`, i);
          const k = kv[1].toUpperCase(), v = kv[2];
          if (k === 'A1' || k === 'A2') { const p = v === '-' ? { clear: true } : codes.parsePlayerToken(v); if (!p) return err(`bad player for ${k}`, i); patch[k.toLowerCase()] = p; }
          else if (k === 'XY') { const c = v === '-' ? { clear: true } : parseCoords(v); if (!c || c.error) return err((c && c.error) || 'XY=x,y', i); patch.xy = c; }
          else if (k === 'X' || k === 'Y') { if (!/^-?\d{1,3}(\.\d)?$/.test(v)) return err(`${k} must be feet with at most one decimal`, i); if (patch.xy && patch.xy.clear) return err('XY=- cannot be combined with X= or Y=', i); patch.xy = Object.assign(patch.xy || {}, { [k.toLowerCase()]: Number(v) }); }
          else if (k === 'P' || k === 'PLAYER') { const p = codes.parsePlayerToken(v); if (!p) return err('bad player', i); patch.player = p; }
          else if (k === 'T' || k === 'TEAM') { if (!codes.TEAM_RE.test(v.toUpperCase())) return err('bad team', i); patch.team = v.toUpperCase(); }
          else if (k === 'S' || k === 'STAT') { const [head, ...mp] = v.split('/'); let st = head.toUpperCase(); if (locale === 'fr-CA' && FR[st]) st = FR[st]; if (!Object.prototype.hasOwnProperty.call(STATS, st)) return err('bad stat', i); const m = parseMods(st, mp); if (m.error) return err(m.error, i); patch.stat = { stat: st, modCode: m.code, mods: m.mods, coords: m.coords }; }
          else if (k === 'M' || k === 'MOD') { if (!/^(-|[A-Za-z0-9]{1,4})$/.test(v)) return err('M= takes up to four letters or digits (the modifier field), or - to clear it', i); patch.modRaw = v.toUpperCase(); }
          else return err(`unknown FIX key ${k} (A1 A2 XY X Y P T S)`, i);
        }
        if (patch.xy && !patch.xy.clear) {
          if (!Number.isFinite(patch.xy.x) || !Number.isFinite(patch.xy.y)) return err('give both X= and Y= (or XY=x,y)');
          if (patch.xy.x < -100 || patch.xy.x > 100 || patch.xy.y < -42.5 || patch.xy.y > 42.5) return err(`coordinates (${patch.xy.x}, ${patch.xy.y}) are off the 200 × 85 ft ice`);
        }
        if (!Object.keys(patch).length) return err('FIX needs a replacement or KEY=VALUE patches');
        return { kind: 'fix', seq, patch, raw };
      }
      case 'LINE': {
        const team = (t[1] || '').toUpperCase();
        if (!codes.TEAM_RE.test(team)) return err('usage: LINE TEAM_4 P1 P2 … (up to 6 players)', 1);
        const players = t.slice(2).map((p) => codes.parsePlayerToken(p));
        if (!players.length || players.length > 6 || players.some((p) => !p)) return err('LINE takes 1 to 6 player codes', 2);
        return { kind: 'line', team, players, raw };
      }
      case 'T': {
        if (t.length > 3 || !t[1]) return err('usage: T mm:ss [P1|P2|P3|OT|SO]');
        const ds = parseClock(t[1]); if (ds === null) return err('clock must be mm:ss (00:00 to 20:00)', 1);
        let period = null; if (t[2]) { period = Object.prototype.hasOwnProperty.call(PERIODS, U[2]) ? PERIODS[U[2]] : 0; if (!period) return err('period must be P1, P2, P3, OT or SO (OT2 … OT9 in the playoffs)', 2); }
        return { kind: 'clock', action: 'set', remainingDs: ds, period, raw };
      }
      case 'GO': case 'STOP': case 'NEXT': case 'END': return t.length === 1 ? { kind: 'clock', action: U[0].toLowerCase(), raw } : err(`${U[0]} takes no argument`);
      case 'CLOCK': {
        const a = U[1];
        if (a === 'GO' || a === 'STOP' || a === 'NEXT' || a === 'END') return { kind: 'clock', action: a.toLowerCase(), raw };
        if (a === 'SET') { const ds = parseClock(t[2]); if (ds === null) return err('usage: CLOCK SET mm:ss [Pn]', 2); const period = t[3] && Object.prototype.hasOwnProperty.call(PERIODS, U[3]) ? PERIODS[U[3]] : null; if (t[3] && !period) return err('bad period', 3); return { kind: 'clock', action: 'set', remainingDs: ds, period, raw }; }
        return err('usage: CLOCK GO | STOP | NEXT | END | SET mm:ss [Pn]');
      }
      case 'Q': {
        if (!t[1]) return err('usage: Q <TARGET> [args] [--key=value]  (Q HELP lists targets)');
        const args = [], flags = {};
        for (const x of t.slice(2)) { const f = /^--([a-z][a-z0-9-]{0,23})(?:=(.*))?$/i.exec(x); if (f) flags[f[1].toLowerCase()] = f[2] === undefined ? true : f[2]; else args.push(x); }
        return { kind: 'query', target: U[1], args, flags, raw };
      }
      case 'GAME': return t[1] ? { kind: 'game', key: t[1], raw } : { kind: 'game', key: null, raw };
      case 'LOCALE': return /^(en|fr)-CA$/i.test(t[1] || '') ? { kind: 'locale', locale: t[1].slice(0, 2).toLowerCase() + '-CA', raw } : err('usage: LOCALE en-CA | fr-CA');
      case 'HELP': case '?': return { kind: 'help', topic: t[1] || null, raw };
      case 'EXIT': case 'QUIT': return { kind: 'exit', raw };
      default: break;
    }
    if (t.length === 3 && /^[A-Za-z]{4}$/.test(t[0])) { const e = parseTri(t[0], t[1], t[2], locale, 0); if (e.kind === 'event') e.raw = raw; return e; }
    if (/^[A-Za-z]{4}$/.test(t[0]) && t.length < 3) return err('tri-token needs TEAM_4 PLAYER_4 STAT_TOKEN', t.length);
    return { kind: 'other', raw };
  }
  /** Canonical text of an event (what the audit log and FIX display show). */
  function canonical(e) {
    if (!e || e.kind !== 'event') return '';
    let s = `${e.team} ${e.player || (e.jersey !== null && e.jersey !== undefined ? 'J' + e.jersey : '?')} ${e.stat}`;
    if (e.modCode) s += '/' + e.modCode;
    if (e.coords) s += '/' + e.coords.x + ',' + e.coords.y;
    return s;
  }
  /** Token-level completion hints for ghost text: what may follow what has been typed. */
  function nextHint(line) {
    const t = String(line || '').split(/\s+/);
    if (t.length === 1) return 'TEAM_4';
    if (t.length === 2) return 'PLAYER_4';
    if (t.length === 3) return 'STAT';
    return '';
  }
  /* What each Q query takes: its flags, and how many positional arguments. One table for the query engine (which
     refuses what is not here), the terminal's ghost text and the browser command bar. The league-wide queries
     accept --season (it is what they are) but not --game: `Q RAPM --game=G1` would otherwise show the league's
     table under one game's name. WAR is GAR. */
  const Q_SCOPE = ['game', 'season', 'team'], Q_LEAGUE = ['season'];
  const Q_TAKES = {
    SCORE: [['game'], 0], BOX: [Q_SCOPE, 0], EVENTS: [['game', 'n'], 1], XG: [Q_SCOPE, 0], STINTS: [['game', 'n'], 0], PEN: [['game'], 0], PLAYER: [['game', 'season'], 2],
    STANDINGS: [Q_LEAGUE, 0], LEADERS: [[...Q_LEAGUE, 'n'], 0], RAPM: [[...Q_LEAGUE, 'str', 'min', 'team'], 0], GSAX: [[...Q_LEAGUE, 'team'], 0], GAR: [[...Q_LEAGUE, 'team', 'n'], 0],
    NHLE: [[...Q_LEAGUE, 'team', 'n'], 0], HEAT: [[...Q_SCOPE, 'steps', 'engine', 'lanes', 'packed'], 0], LEDGER: [['game'], 0], AUDIT: [['game'], 1], ROSTER: [['team'], 1], CODES: [[], 0], HK001: [Q_SCOPE, 1]
  };
  Q_TAKES.WAR = Q_TAKES.GAR;
  const Q_SWITCHES = ['season', 'packed'];
  return { STATS, SHOT_TYPES, FLAGS, INFRACTIONS, FR, PERIODS, MAX_PERIOD, Q_TAKES, Q_SWITCHES, parseLine, parseClock, parseCoords, checkMod, canonical, nextHint };
});
