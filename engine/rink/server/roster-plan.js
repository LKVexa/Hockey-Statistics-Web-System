'use strict';
/**
 * From a roster file's model (roster-file.js) to the registry: which leagues, teams and players are new, which are
 * already there, what changes, and the four-letter reference each one has or gets.
 *
 *   LEAGUE_4  the file's own four letters when it gives them; else from the league's name (codes.mnemonicCandidates)
 *   TEAM_4    the file's own; else from the city, or from the club's name without its last word (the nickname)
 *   PLAYER_4  the file's own; else the roster rule: SMIT, then SMIR, SMI9 … within the team (codes.playerCandidates)
 *
 * Designation is deterministic: the same file against the same registry gives the same references, in file order.
 * A reference that exists is never changed. plan() does the work on the registry itself, inside a transaction the
 * caller either commits (apply) or rolls back (preview), so the preview is the apply, not a second implementation.
 *
 * What is the same league, team or player: the code when the file gives one; else the name, compared without
 * accents, case and punctuation (a league also by its abbreviation; a team first within its league, and a team
 * that this file has already named under another league is another team); a player within the team by surname and
 * given name, and by jersey or birth date when two share a name.
 *
 * Order does not decide what is possible. Codes the file gives are set aside before any is designated, so a
 * designated code never takes one the file gives further down. A player listed more than once on a team is one
 * player: what one listing leaves out another may give. Jersey changes on a team are made together, so two players
 * may trade numbers, and a new player may take a number that another gives up in the same file.
 * A record in error imports nothing of itself.
 */
const codes = require('../shared/codes');
const { normName } = require('./roster-file');

const ISSUES = 400;
const FORWARD = new Set(['C', 'LW', 'RW']);
function plan(reg, model, opts = {}) {
  const out = { format: model.format, leagues: [], teams: [], players: [], errors: [], warnings: [], notes: model.notes.slice(),
    counts: { rows: model.counts.rows, leagues: { new: 0, updated: 0, unchanged: 0 }, teams: { new: 0, updated: 0, unchanged: 0 }, players: { new: 0, updated: 0, unchanged: 0 }, errors: model.counts.errors, warnings: model.counts.warnings } };
  out.errors.push(...model.errors.slice(0, ISSUES)); out.warnings.push(...model.warnings.slice(0, ISSUES));
  // `ord`: where in the file the thing stands, so that the issues of the reading and of the plan are listed together in the file's order
  const err = (where, text, ord) => { out.counts.errors++; if (out.errors.length < ISSUES) out.errors.push({ where, text, ord }); };
  const warn = (where, text, ord) => { out.counts.warnings++; if (out.warnings.length < ISSUES) out.warnings.push({ where, text, ord }); };
  const note = (text) => { if (out.notes.length < 40 && !out.notes.includes(text)) out.notes.push(text); };
  // `taken`: codes that exist (and words that may not be codes). `busy`: those, and every code the file itself gives,
  // so that a code designated for one league or team is never one the file gives to another further down.
  const taken = new Set([...codes.RESERVED_TEAMS, ...reg.leagues().map((l) => l.code), ...reg.teams().map((t) => t.code)]);
  const busy = new Set(taken); for (const l of model.leagues) if (l.code) busy.add(l.code); for (const t of model.teams) if (t.code) busy.add(t.code);
  const tally = (kind, action) => { out.counts[kind][action]++; };
  const retally = (kind, rec, action) => { if (rec.action !== action) { out.counts[kind][rec.action]--; out.counts[kind][action]++; rec.action = action; } };
  const merge = (kind, rec, changed) => { for (const k of changed) if (!rec.changed.includes(k)) rec.changed.push(k); if (rec.action === 'unchanged' && rec.changed.length) retally(kind, rec, 'updated'); };
  const short = (s, n = 60) => String(s).slice(0, n);

  /* ---- leagues ---- */
  const leagueRec = new Map();                                     // LEAGUE_4 → its line of the plan: a league named twice is one league
  const findLeague = (l) => {
    if (l.code && reg.league(l.code)) return { l: reg.league(l.code), by: 'code' };
    const nk = normName(l.name); const all = reg.leagues();
    const byName = nk && all.find((x) => normName(x.name_en) === nk || normName(x.name_fr) === nk); if (byName) return { l: byName, by: 'name' };
    const ab = l.abbr || (nk.length <= 12 ? nk : ''); const byAbbr = ab && all.find((x) => x.abbr && x.abbr === ab); if (byAbbr) return { l: byAbbr, by: 'abbr' };
    return null;
  };
  const doLeague = (l, where) => { const ord = l.ord;
    const hit = findLeague(l); const fileCode = !!l.code;
    if (hit) {
      const rename = hit.by === 'code' && normName(l.name) && normName(l.name) !== normName(hit.l.name_en) && normName(l.name) !== hit.l.code && normName(l.name) !== hit.l.abbr;
      let changed = []; try { changed = reg.updateLeague(hit.l.code, { name_en: rename ? l.name : '', name_fr: l.name_fr, abbr: l.abbr }); } catch (e) { err(where, `league ${short(l.name)}: ${e.message}`, ord); }
      const seen = leagueRec.get(hit.l.code);
      if (seen) { if (seen.action !== 'new') merge('leagues', seen, changed); seen.name = hit.l.name_en; seen.abbr = hit.l.abbr; seen.given = seen.given || fileCode; return seen.code; }
      const rec = { code: hit.l.code, name: hit.l.name_en, abbr: hit.l.abbr, action: changed.length ? 'updated' : 'unchanged', changed, given: fileCode };
      out.leagues.push(rec); leagueRec.set(rec.code, rec); tally('leagues', rec.action); return rec.code;
    }
    let code = l.code;
    try {
      if (code) { if (taken.has(code)) throw new Error(codes.RESERVED_TEAMS.includes(code) ? `${code} is a word of the command language and cannot be a code` : `${code} is already ${reg.team(code) ? 'a team' : 'in use'}`); }
      else { if (!codes.nameWords(l.name).length) throw new Error('the name has no letters A-Z to make a code from; give a four-letter code'); code = codes.assignMnemonic(l.name, busy); }
      const made = reg.addLeague({ code, name_en: l.name, name_fr: l.name_fr, abbr: l.abbr });
      taken.add(code); busy.add(code);
      const rec = { code, name: made.name_en, abbr: made.abbr, action: 'new', changed: [], given: fileCode };
      out.leagues.push(rec); leagueRec.set(code, rec); tally('leagues', 'new'); return code;
    } catch (e) { err(where, `league ${short(l.name)}: ${e.message}`, ord); return null; }
  };
  const leagueCode = model.leagues.map((l) => doLeague(l, l.where));
  // --league: the league of the teams that name none; looked up (or made) when the first such team comes
  let fallback; const wanted = typeof opts.league === 'string' ? opts.league.trim() : '';
  const fallbackLeague = () => {
    if (fallback === undefined) { const asCode = /^[A-Za-z]{4}$/.test(wanted) && reg.league(wanted) ? wanted.toUpperCase() : ''; fallback = wanted ? doLeague({ name: wanted, code: asCode, abbr: '', name_fr: '' }, '--league') : null; }
    return fallback;
  };

  /* ---- teams ---- */
  const TZ = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;
  const teamByCode = new Map();                                    // TEAM_4 → its line of the plan: a team named twice (by name, by code) is one team
  const byName = new Map();                                        // a name as it is compared → the teams that have it (English or French)
  const indexTeam = (x) => { for (const k of new Set([normName(x.name_en), normName(x.name_fr)])) if (k) { const l = byName.get(k); if (!l) byName.set(k, [x]); else if (!l.includes(x)) l.push(x); } };
  for (const x of reg.teams()) indexTeam(x);
  const teamRec = model.teams.map((t) => {
    const where = t.where; const ord = t.ord; const league = t.league >= 0 ? leagueCode[t.league] : fallbackLeague();
    if ((t.league >= 0 || wanted) && !league) { err(where, `team ${short(t.name)}: its league was not imported`, ord); return null; }
    let existing = t.code ? reg.team(t.code) : null; let by = existing ? 'code' : '';
    if (!existing) {
      // the team of that name in the same league; else the one team of that name that this file has not named already
      // (the same name under another league in one file is another club; in a later file it is the club, moved)
      const nk = normName(t.name); const same = (nk && byName.get(nk)) || [];
      const inLeague = same.filter((x) => league && x.league === league);
      const pick = inLeague.length ? inLeague : same.filter((x) => !teamByCode.has(x.code));
      if (pick.length > 1) { err(where, `team ${short(t.name)}: ${pick.length} teams have that name (${pick.map((x) => x.code).join(', ')}); give its code`, ord); return null; }
      if (pick.length === 1) { existing = pick[0]; by = 'name'; }
    }
    let tz = t.timezone; if (tz && !TZ.test(tz)) { warn(where, `team ${short(t.name)}: time zone "${short(tz, 30)}" is not an IANA name such as America/Toronto; left out`, ord); tz = ''; }
    const rec = { code: null, name: t.name, league: league || '', city: t.city, action: '', changed: [], given: !!t.code, n: { new: 0, updated: 0, unchanged: 0, errors: 0 } };
    if (existing) {
      const seen = teamByCode.get(existing.code);
      let to = league || '';
      if (seen && to && existing.league && existing.league !== to) { warn(where, `team ${existing.code} is listed under two leagues; ${existing.league} is kept`, ord); to = ''; }
      const rename = by === 'code' && normName(t.name) && normName(t.name) !== normName(existing.name_en) && normName(t.name) !== existing.code;
      let changed = [];
      try { changed = reg.updateTeam(existing.code, { name_en: rename ? t.name : '', name_fr: t.name_fr, arena: t.arena, city: t.city, timezone: tz, league: to }); }
      catch (e) { err(where, `team ${existing.code}: ${e.message}`, ord); }
      if (changed.includes('name_en') || changed.includes('name_fr')) indexTeam(existing);
      if (seen) { if (seen.action !== 'new') merge('teams', seen, changed); seen.name = existing.name_en; seen.league = existing.league || ''; seen.city = existing.city || ''; seen.given = seen.given || !!t.code; return seen; }
      rec.changed = changed; rec.code = existing.code; rec.name = existing.name_en; rec.league = existing.league || ''; rec.city = existing.city || ''; rec.action = changed.length ? 'updated' : 'unchanged';
    } else {
      try {
        let code = t.code;
        if (code) { if (taken.has(code)) throw new Error(codes.RESERVED_TEAMS.includes(code) ? `${code} is a word of the command language and cannot be a team code` : `${code} is already a league`); }
        else {
          // the municipal identity: the city when the file gives one, else the club's name without its nickname
          const w = codes.nameWords(t.name); const base = t.city && codes.nameWords(t.city).length ? t.city : w.length > 1 ? w.slice(0, -1).join(' ') : t.name;
          const spare = t.city && codes.nameWords(t.city).length ? t.name : w.length > 1 ? w[w.length - 1] : '';
          if (!codes.nameWords(base).length) throw new Error('the name has no letters A-Z to make a code from; give a four-letter code');
          code = codes.assignMnemonic(base, busy, spare);
        }
        const made = reg.addTeam({ code, name_en: t.name, name_fr: t.name_fr, arena: t.arena, city: t.city, timezone: tz, league: league || '' });
        taken.add(code); busy.add(code); indexTeam(made); rec.code = code; rec.name = made.name_en; rec.action = 'new';
      } catch (e) { err(where, `team ${short(t.name)}: ${e.message}`, ord); return null; }
    }
    out.teams.push(rec); teamByCode.set(rec.code, rec); tally('teams', rec.action); return rec;
  });

  if (wanted && fallback === undefined) note('--league was not used: every team of the file names its league');

  /* ---- players ---- */
  // 1. one record a player: the listings of one player on one team are put together (first value of each field)
  const rows = []; const groups = new Map(); let again = 0;
  for (const p of model.players) {
    const t = teamRec[p.team]; const who = `${p.first} ${p.last}`;
    if (!t) { err(p.where, `${short(who)}: its team was not imported`, p.ord); continue; }
    const key = `${t.code}|${normName(p.last)}|${normName(p.first)}`; const g = groups.get(key) || []; if (!g.length) groups.set(key, g);
    const fits = g.filter((r) => !(p.birth && r.p.birth && p.birth !== r.p.birth) && !(p.code && r.p.code && p.code !== r.p.code));
    if (fits.length !== 1) { const r = { p: Object.assign({}, p), t, who, existing: null, changed: [], dead: false, blocked: null }; g.push(r); rows.push(r); continue; }
    const q = fits[0].p; const differs = []; again++;
    if (p.jersey !== null) { if (q.jersey === null) q.jersey = p.jersey; else if (q.jersey !== p.jersey) differs.push(`number ${p.jersey}`); }
    if (p.pos) { if (!q.pos || (q.posNote && !p.posNote && FORWARD.has(p.pos))) { q.pos = p.pos; q.posNote = p.posNote; } else if (q.pos !== p.pos && !(p.posNote && FORWARD.has(q.pos))) differs.push(`position ${p.pos}`); }
    if (p.shoots) { if (!q.shoots) q.shoots = p.shoots; else if (q.shoots !== p.shoots) differs.push(`hand ${p.shoots}`); }
    if (p.birth && !q.birth) q.birth = p.birth;
    if (p.code && !q.code) q.code = p.code;
    if (p.importSaid) { if (!q.importSaid) { q.import = p.import; q.importSaid = true; } else if (q.import !== p.import) differs.push('import flag'); }
    if (differs.length) warn(p.where, `${t.code} ${short(who)}: listed again with another ${differs.join(', ')}; the first listing is kept`, p.ord);
  }
  if (again) note(`${again} listing${again > 1 ? 's repeat' : ' repeats'} a player already listed on the team: taken as one player`);
  const fail = (r, text) => { r.dead = true; r.t.n.errors++; err(r.p.where, `${r.t.code} ${short(r.who)}: ${text}`, r.p.ord); };
  // numbers and codes the file gives on a team are not handed out to anyone else on it
  const givenJ = new Map(), givenC = new Map();
  for (const r of rows) {
    if (r.p.jersey !== null) { if (!givenJ.has(r.t.code)) givenJ.set(r.t.code, new Set()); givenJ.get(r.t.code).add(r.p.jersey); }
    if (r.p.code) { if (!givenC.has(r.t.code)) givenC.set(r.t.code, new Set()); givenC.get(r.t.code).add(r.p.code); }
  }
  // 2. who is already on the team
  const claimed = new Map();                                       // pid → the record that is this player
  const match = (r, roster) => {
    const p = r.p; const nl = normName(p.last), nf = normName(p.first);
    if (p.code) { const c = roster.find((x) => x.code === p.code); if (c) return normName(c.last) === nl && normName(c.first) === nf ? { hit: c } : { error: `code ${p.code} is ${c.name}'s` }; }
    const same = roster.filter((x) => normName(x.last) === nl && normName(x.first) === nf && !(p.birth && x.birth && p.birth !== x.birth));
    if (same.length <= 1) return { hit: same[0] || null };
    const one = same.filter((x) => (p.birth && x.birth === p.birth) || (p.jersey !== null && x.jersey === p.jersey));
    return one.length === 1 ? { hit: one[0] } : { error: 'several players of that name are on the team; give a birth date or a code' };
  };
  const before = new Map(); const rosterOf = (code) => { if (!before.has(code)) before.set(code, reg.roster(code)); return before.get(code); };
  for (const r of rows) {
    if (r.t.action === 'new') continue;
    const m = match(r, rosterOf(r.t.code).filter((x) => !claimed.has(x.pid)));
    if (m.error) { fail(r, m.error); continue; }
    if (m.hit) { r.existing = m.hit; claimed.set(m.hit.pid, r); }
  }
  // 3. the new numbers of a team, together: a number is free when the one who wears it moves in the same file
  const movers = new Map();
  for (const r of rows) if (r.existing && !r.dead && r.p.jersey !== null && r.p.jersey !== r.existing.jersey) { if (!movers.has(r.t.code)) movers.set(r.t.code, []); movers.get(r.t.code).push(r); }
  for (const [team, list] of movers) {
    const roster = reg.roster(team); let ok = list;
    for (;;) {                                                      // one who cannot move keeps a number, which may stop another: until nothing changes
      const moving = new Set(ok.map((r) => r.existing)); const worn = new Map();
      for (const x of roster) if (!moving.has(x)) worn.set(x.jersey, x);
      const keep = [];
      for (const r of ok) { const h = worn.get(r.p.jersey); if (h) r.blocked = h; else { worn.set(r.p.jersey, r.existing); keep.push(r); } }
      if (keep.length === ok.length) break;
      ok = keep;
    }
    try { reg.renumber(team, ok.map((r) => [r.existing.pid, r.p.jersey])); for (const r of ok) { r.blocked = null; r.changed.push('jersey'); } }
    catch (e) { for (const r of ok) fail(r, e.message); }
    for (const r of list) if (r.blocked && !r.dead) fail(r, `#${r.p.jersey} is worn by ${r.blocked.name}`);
  }
  // 4. the other fields of those who are there; then those who are new, in the order of the file
  const defaults = { pos: 0, forward: 0, hand: 0, jersey: 0 };
  for (const r of rows) {
    if (r.dead) continue;
    const p = r.p, t = r.t;
    if (r.existing) {
      const x = r.existing;
      try {
        const more = reg.updatePlayer(x.pid, { pos: p.pos && !(p.posNote && FORWARD.has(x.pos)) ? p.pos : undefined, shoots: p.shoots || undefined, birth: p.birth || undefined, import: p.importSaid ? p.import : undefined });
        r.changed.push(...more);
        const action = r.changed.length ? 'updated' : 'unchanged'; t.n[action]++; tally('players', action);
        out.players.push({ team: t.code, code: x.code, jersey: x.jersey, name: x.name, pos: x.pos, action, changed: r.changed });
      } catch (e) { fail(r, e.message); }
      continue;
    }
    const roster = reg.roster(t.code);
    if (t.action !== 'new' || roster.length) { const m = match(r, roster.filter((x) => !claimed.has(x.pid))); if (m.error) { fail(r, m.error); continue; } }
    let jersey = p.jersey;
    if (jersey === null) {
      if (!opts.assignJerseys) { fail(r, 'no jersey number (add a number column, or run again with --assign-jerseys to give free numbers from 99 down)'); continue; }
      const used = new Set(roster.map((x) => x.jersey)); const kept = givenJ.get(t.code);
      for (let j = 99; j >= 1; j--) if (!used.has(j) && !(kept && kept.has(j))) { jersey = j; break; }
      if (jersey === null) { fail(r, 'no jersey number is free'); continue; }
    } else { const h = roster.find((x) => x.jersey === jersey); if (h) { fail(r, `#${jersey} is worn by ${h.name}`); continue; } }
    const twin = reg.player(reg.playerId(p.last, p.first, p.birth));
    if (twin && twin.team !== t.code && p.birth) { fail(r, `already registered with ${twin.team} (the same name and birth date): a transfer is not an import`); continue; }
    try {
      let code = p.code;
      if (!code) { const avoid = new Set(roster.map((x) => x.code)); const kept = givenC.get(t.code); if (kept) for (const c of kept) avoid.add(c); code = codes.assignPlayerCode(p.last, p.first, jersey, avoid); }
      const made = reg.addPlayer(t.code, { first: p.first, last: p.last, jersey, pos: p.pos || 'C', shoots: p.shoots || undefined, birth: p.birth || null, import: p.import === true, code }, { scoped: true });
      claimed.set(made.pid, r);
      if (twin && twin.team !== t.code) warn(p.where, `${t.code} ${short(r.who)}: ${twin.team} has a player of the same name and neither has a birth date; taken as two people`, p.ord);
      if (p.jersey === null) defaults.jersey++;
      if (!p.pos) defaults.pos++; else if (p.posNote) defaults.forward++;
      if (!p.shoots) defaults.hand++;
      t.n.new++; tally('players', 'new');
      out.players.push({ team: t.code, code: made.code, jersey: made.jersey, name: made.name, pos: made.pos, action: 'new', changed: [], given: !!p.code });
    } catch (e) { fail(r, e.message); }
  }
  if (defaults.pos) note(`${defaults.pos} player${defaults.pos > 1 ? 's have' : ' has'} no position: recorded as C`);
  if (defaults.forward) note(`${defaults.forward} forward${defaults.forward > 1 ? 's' : ''} without a line (F, W): recorded as C`);
  if (defaults.hand) note(`${defaults.hand} player${defaults.hand > 1 ? 's have' : ' has'} no shooting hand: recorded as L`);
  if (defaults.jersey) note(`${defaults.jersey} player${defaults.jersey > 1 ? 's' : ''} without a number got a free one, from 99 down`);
  // as the file has them (what has no place in the file, such as --league, comes last); the sort is stable
  const inFileOrder = (a, b) => (a.ord === undefined ? Infinity : a.ord) - (b.ord === undefined ? Infinity : b.ord);
  out.errors.sort(inFileOrder); out.warnings.sort(inFileOrder);
  out.errors = out.errors.map((e) => ({ where: e.where, text: e.text })); out.warnings = out.warnings.map((e) => ({ where: e.where, text: e.text }));
  return out;
}
module.exports = { plan };
