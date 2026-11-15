/**
 * Input assistance for RINK lines — the same rules for the SPIRAL `rink` mode (ghost text, colour, Tab) and the
 * browser command bar: what may come next, whether the line so far is complete, incomplete or wrong, and why.
 *
 *   const a = RinkAssist.create({ game: { home, away }, rosters: { FOCO: [{ code, jersey, name, pos }] }, teams: ['FOCO', …] });
 *   a.analyze('FOCO SM')  → { state: 'incomplete', ghost: 'IT', candidates: ['SMIT'], hint: 'PLAYER_4', message }
 *   a.complete('FOCO SM') → { line: 'FOCO SMIT ', candidates: ['SMIT'] }
 * state: 'empty' | 'ok' (ready to send) | 'incomplete' (a prefix of something valid) | 'error' (cannot become valid)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hcl'));
  else root.RinkAssist = factory(root.RinkHcl);
})(typeof self !== 'undefined' ? self : this, function (hcl) {
  'use strict';
  const KEYWORDS = ['LINE', 'UNDO', 'DEL', 'FIX', 'T', 'START', 'GO', 'STOP', 'NEXT', 'END', 'Q', 'GAME', 'LOCALE', 'HELP', 'EXIT'];
  const Q_TARGETS = ['SCORE', 'BOX', 'EVENTS', 'XG', 'STINTS', 'PEN', 'PLAYER', 'STANDINGS', 'LEADERS', 'RAPM', 'GSAX', 'GAR', 'WAR', 'NHLE', 'HEAT', 'LEDGER', 'AUDIT', 'ROSTER', 'CODES', 'HK001'];
  const STATS = Object.keys(hcl.STATS);
  const MODS = {
    shot: ['W', 'S', 'P', 'B', 'T', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'R', 'U', 'X'],
    faceoff: ['O', 'D', 'N'], transition: ['C', 'D', 'F'], penalty: Object.keys(hcl.INFRACTIONS)
  };
  const prefix = (list, p) => list.filter((x) => x.startsWith(p));
  const common = (list) => { if (!list.length) return ''; let c = list[0]; for (const s of list) while (!s.startsWith(c)) c = c.slice(0, -1); return c; };

  function create(ctx = {}) {
    const state = { game: ctx.game || null, rosters: ctx.rosters || {}, teams: (ctx.teams || []).map((t) => String(t).toUpperCase()), locale: ctx.locale || 'en-CA' };
    const teamsFirst = () => { const g = state.game; const t = g ? [g.home, g.away] : []; return [...t, ...state.teams.filter((x) => !t.includes(x))]; };
    const roster = (team) => state.rosters[team] || [];
    const playerOk = (team, tok) => { const r = roster(team); if (!r.length) return true; const t = tok.toUpperCase(); return r.some((p) => p.code === t || ('J' + p.jersey) === t || String(p.jersey) === t || String(p.jersey).padStart(4, '0') === t); };

    function analyze(line) {
      const raw = String(line || ''); const text = raw.replace(/^\s+/, '');
      if (!text) return { state: 'empty', ghost: '', candidates: teamsFirst().concat(KEYWORDS), hint: 'TEAM_4 or a command', message: '' };
      const parts = text.trim().split(/\s+/); const endsSpace = /\s$/.test(raw);
      const idx = endsSpace ? parts.length : parts.length - 1;         // index of the token being typed
      const cur = endsSpace ? '' : parts[parts.length - 1].toUpperCase();
      const w0 = parts[0].toUpperCase();
      const full = hcl.parseLine(text, { locale: state.locale });
      const out = (st, cands, hint, message, ast) => {
        const c = prefix(cands, cur.startsWith('--') ? cur.toLowerCase() : cur); const g = c.length ? common(c).slice(cur.length) : '';   // flags are lower case
        return { state: st, ghost: g, candidates: c, hint: c.length || endsSpace || st !== 'incomplete' ? hint : hint, message: message || '', ast: ast || full };
      };
      // the first word decides the line's grammar
      const inGame = (t) => (state.game ? [state.game.home, state.game.away].includes(t) : teamsFirst().includes(t));
      const notRink = { state: 'error', ghost: '', candidates: [], hint: '', message: `${parts[0]}: not a team or RINK command (shell commands still work)`, ast: full };
      if (idx === 0 && !teamsFirst().some((t) => t.startsWith(cur)) && !KEYWORDS.some((k) => k.startsWith(cur))) return full.kind === 'other' || full.kind === 'error' ? notRink : { state: 'ok', ghost: '', candidates: [], hint: '', message: '', ast: full };
      if (idx > 0 && !teamsFirst().includes(w0) && !KEYWORDS.includes(w0)) return notRink;
      if (w0 === 'Q') {
        if (idx === 1) return out(Q_TARGETS.includes(cur) ? 'ok' : 'incomplete', Q_TARGETS, 'TARGET');
        if (full.kind === 'query' && !Q_TARGETS.includes(full.target)) return out('error', [], '', `unknown query ${full.target}`);
        if (full.kind === 'query' && ['PLAYER', 'ROSTER', 'HK001'].includes(full.target) && idx === 2) return out('incomplete', teamsFirst(), 'TEAM_4');
        if (full.kind === 'query' && full.target === 'PLAYER' && idx === 3) return out('incomplete', roster(parts[2].toUpperCase()).map((p) => p.code), 'PLAYER_4');
        // flags: only the ones this query takes; one it does not take is an error before it is sent
        const takes = (hcl.Q_TAKES[(parts[1] || '').toUpperCase()] || [[], 0])[0];
        if (full.kind === 'query') for (const k of Object.keys(full.flags)) if (!takes.includes(k) && !(idx === parts.length - 1 && cur.startsWith('--') && !cur.includes('=') && takes.some((f) => f.startsWith(k)))) return out('error', [], '', `${full.target} does not take --${k}${takes.length ? ` (it takes ${takes.map((f) => '--' + f).join(' ')})` : ''}`);
        return out(full.kind === 'query' ? 'ok' : 'incomplete', takes.map((f) => (hcl.Q_SWITCHES.includes(f) ? '--' + f : f === 'str' ? '--str=5v5' : `--${f}=`)), '');
      }
      if (['UNDO', 'START', 'GO', 'STOP', 'NEXT', 'END', 'HELP', 'EXIT'].includes(w0) && idx === 0) return out(full.kind === 'error' ? 'incomplete' : 'ok', KEYWORDS, '');
      if (w0 === 'LINE') {
        if (idx === 1) return out('incomplete', teamsFirst(), 'TEAM_4');
        const team = (parts[1] || '').toUpperCase();
        if (!inGame(team)) return out('error', [], '', `${team}: not a team in this game`);
        for (let k = 2; k < parts.length - (endsSpace ? 0 : 1); k++) if (!playerOk(team, parts[k])) return out('error', [], '', `${parts[k]}: not on the ${team} roster`);
        return out(parts.length >= 3 && full.kind === 'line' ? 'ok' : 'incomplete', roster(team).map((p) => p.code).filter((c) => !parts.slice(2).map((x) => x.toUpperCase()).includes(c)), 'PLAYER_4');
      }
      if (['DEL', 'FIX', 'T', 'GAME', 'LOCALE'].includes(w0)) {
        if (full.kind !== 'error') return out('ok', [], '');
        if (idx === 1) return out('incomplete', w0 === 'T' ? ['20:00', '5:00'] : w0 === 'LOCALE' ? ['en-CA', 'fr-CA'] : [], w0 === 'T' ? 'mm:ss' : w0 === 'GAME' ? '<key>' : '<seq>', full.message);
        return { state: 'incomplete', ghost: '', candidates: [], hint: '', message: full.message, ast: full };
      }
      // tri-token TEAM PLAYER STAT[/mods]
      const team = w0;
      if (idx === 0) return out('incomplete', teamsFirst().concat(KEYWORDS), 'TEAM_4');
      if (!inGame(team)) return out('error', [], '', state.game ? `${team} is not playing in this game (${state.game.home} vs ${state.game.away})` : `${team}: unknown team`);
      if (idx === 1) return out('incomplete', roster(team).map((p) => p.code), 'PLAYER_4');
      if (!playerOk(team, parts[1])) return out('error', [], '', `${parts[1].toUpperCase()}: no such code or jersey on ${team}`);
      if (idx === 2) {
        const [st, ...mods] = cur.split('/');
        if (!mods.length) {
          const stats = STATS.concat(state.locale === 'fr-CA' ? Object.keys(hcl.FR) : []);
          const c = prefix(stats, st);
          if (!c.length) return out('error', [], '', `unknown STAT_TOKEN ${st}`);
          return { state: full.kind === 'event' ? 'ok' : 'incomplete', ghost: c.length ? common(c).slice(st.length) : '', candidates: c, hint: 'STAT', message: full.kind === 'error' ? '' : '', ast: full };
        }
        const canon = state.locale === 'fr-CA' && hcl.FR[st] ? hcl.FR[st] : st;
        const kind = hcl.STATS[canon] ? hcl.STATS[canon].kind : null;
        const last = mods[mods.length - 1];
        const list = MODS[kind] || [];
        if (full.kind === 'error') {
          const c = prefix(list, last);
          const typing = last === '' || (c.length && !(c.length === 1 && c[0] === last));
          return { state: typing ? 'incomplete' : 'error', ghost: c.length ? common(c).slice(last.length) : '', candidates: c.length ? c : list, hint: 'modifier', message: typing ? '' : full.message, ast: full };
        }
        return { state: 'ok', ghost: '', candidates: prefix(list, last), hint: '', message: '', ast: full };
      }
      return { state: full.kind === 'event' ? 'ok' : 'error', ghost: '', candidates: [], hint: '', message: full.kind === 'error' ? full.message : full.kind === 'event' ? '' : 'a tri-token line has three parts', ast: full };
    }
    function complete(line) {
      const a = analyze(line); if (!a.candidates.length) return { line, candidates: [] };
      const raw = String(line || ''); const endsSpace = /\s$/.test(raw);
      const parts = raw.replace(/^\s+/, '').split(/\s+/); const curFull = endsSpace ? '' : parts[parts.length - 1];
      const slash = curFull.lastIndexOf('/'); const head = slash >= 0 ? curFull.slice(0, slash + 1) : '';
      const typed = slash >= 0 ? curFull.slice(slash + 1) : curFull; const cur = typed.startsWith('--') ? typed.toLowerCase() : typed.toUpperCase();   // flags are lower case
      const c = a.candidates.filter((x) => x.startsWith(cur)); if (!c.length) return { line, candidates: a.candidates };
      const pick = c.length === 1 ? c[0] : common(c);
      const before = endsSpace ? raw : raw.slice(0, raw.length - curFull.length);
      return { line: before + head + pick + (c.length === 1 && slash < 0 && !pick.endsWith('=') ? ' ' : ''), candidates: c };
    }
    return { analyze, complete, set(o) { Object.assign(state, o); return this; }, state };
  }
  return { create, KEYWORDS, Q_TARGETS, MODS };
});
