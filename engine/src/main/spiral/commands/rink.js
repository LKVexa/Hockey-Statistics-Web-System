'use strict';
/**
 * SPIRAL — hockey statistics commands.
 *
 *   rink            the RINK Virtual Terminal mode (tri-token scoring with live ghost text) and league admin
 *   q              RINK queries from the shell (Q BOX, Q RAPM …)
 *   hk001 · case · corpus · tokens      the HK001 MSSL 2.3.0 laboratory on a per-session working case
 *   <563 computation codes>              every HK001 computation is its own command: OFF-001 … HK-SHA
 *   <109 input codes>                    every HK001 input is its own command: HKI-001 … HKI-109
 *
 * The RINK service lives on the gateway's event loop; this worker reaches it through ctx.host.rink
 * ({ call(op, args) → Promise, on(fn) → unsubscribe }). HK001 runs locally in the worker (pure JS, Go-exact).
 */
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..', '..', '..');
const lazy = (p) => { let m = null; return () => m || (m = require(path.join(ROOT, p))); };
const hcl = lazy('rink/shared/hcl'), wire = lazy('rink/shared/wire'), assistLib = lazy('rink/shared/assist'), fmt = lazy('rink/shared/fmt');
const R = lazy('rink/term/render'), labLib = lazy('rink/hk001/lab'), catalog = lazy('rink/hk001/catalog'), inputs = lazy('rink/hk001/inputs');
const adapter = lazy('rink/hk001/adapter'), engine = lazy('rink/hk001/engine'), corpus = lazy('rink/corpus/corpus.json');

const C = { red: '\x1b[38;5;203m', amber: '\x1b[38;5;214m', green: '\x1b[38;5;114m', cyan: '\x1b[38;5;44m', grey: '\x1b[38;5;245m', ice: '\x1b[38;5;252m', bold: '\x1b[1m', reset: '\x1b[0m' };
const paint = (k, s) => C[k] + s + C.reset;
/** text from the league or from a loaded file, for the terminal: never a control character (the bridge strips them from
 *  league data too; this is the last line). plainLines keeps line feeds; screenJSON is the same JSON with \uXXXX escapes. */
const plain = (s) => fmt().plain(s), plainLines = (s) => fmt().plainLines(s);
const jsonOut = (ctx, text) => ctx.stdout.write(ctx.stdout.isTTY === false ? text : fmt().screenJSON(text));   // a redirect or a pipe gets the exact bytes
/** A number an operator typed: plain decimal notation. Not '' (JavaScript reads that as 0), not 0x10, not Infinity. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const typedNumber = (s) => (typeof s === 'string' && DECIMAL.test(s) && Number.isFinite(Number(s)) ? Number(s) : NaN);
const typedCount = (s) => (typeof s === 'string' && /^\d{1,9}$/.test(s) ? Number(s) : NaN);
const fail = (ctx, cmd, msg, code = 1) => { ctx.stderr.write(`${C.red}${plain(cmd)}: ${plainLines(msg)}${C.reset}\n`); return code; };

/* ------------------------------------------------------------------ per-session state */
function st(ctx) {
  const s = ctx.session;
  if (!s.rink) s.rink = { game: null, info: null, sb: null, locale: 'en-CA', assist: null, hello: null, unsub: null, lab: null, lamport: 0, rosters: {}, teams: new Set(), me: null };
  return s.rink;
}
const lab = (ctx) => { const S = st(ctx); if (!S.lab) S.lab = new (labLib().Lab)(); return S.lab; };
function service(ctx) { const h = ctx.host && ctx.host.rink; if (!h) throw Object.assign(new Error('the RINK service is not available in this session (the principal needs a rink.query, rink.score or rink.admin capability, and the gateway needs VWS_RINK=1)'), { code: 'NORINK' }); return h; }
async function call(ctx, op, args = {}) { return service(ctx).call(op, args); }
async function hello(ctx) {
  const S = st(ctx);
  // a terminal's reply is at most 60 000 characters: the newest sixty games are enough to start from (rink games pages the rest)
  if (!S.hello) { S.hello = await call(ctx, 'hello', { games: 60 }); S.me = S.hello.sub; S.teams = new Set(typeof S.hello.codes === 'string' ? S.hello.codes.split(' ').filter(Boolean) : S.hello.teams.map((t) => t.code)); }
  return S.hello;
}
async function selectGame(ctx, key) {
  const S = st(ctx);
  const g = await call(ctx, 'game', { key });
  if (S.game && S.game !== g.game.key) { try { await call(ctx, 'unsubscribe', { game: S.game }); } catch { /* ignore */ } }
  S.game = g.game.key; S.info = g.game; S.sb = g.scoreboard;
  for (const t of [g.game.home, g.game.away]) if (!S.rosters[t]) S.rosters[t] = (await call(ctx, 'roster', { team: t })).players;
  S.assist = assistLib().create({ game: { home: g.game.home, away: g.game.away }, teams: [...S.teams], rosters: S.rosters, locale: S.locale });
  try { await call(ctx, 'subscribe', { game: S.game }); } catch { /* live updates are optional */ }
  return g;
}
const nowNs = () => wire().nowNs();

/* ------------------------------------------------------------------ the RINK mode */
const HELP = `${C.bold}RINK Virtual Terminal${C.reset} — one line, one fact.  ${C.grey}(type EXIT to return to the shell; shell commands still work here)${C.reset}

  ${C.cyan}TEAM_4 PLAYER_4 STAT[/mods]${C.reset}   FOCO SMIT G/2P · FOCO J91 S/78,-4/W · KELW BARK P2/TRP · FOCO HALA ZE/C · KELW WITC B
     stats  G S M B · A A1 A2 · FOW FOL (/O /D /N) · ZE ZX (/C /D /F) · H TK GV FC OMR · P2 P4 P5 P10 P20 PS · IN OUT
     shot   /1-9 zone · /W wrist /S slap /P snap /B backhand /T tip · /R rebound /U rush /X royal road · /x,y feet
  ${C.cyan}LINE TEAM P1 … P6${C.reset}          on-ice skaters (a goalie code sets the crease) — shift tracking for stints and RAPM
  ${C.cyan}T 20:00 P1 · START · GO · WHISTLE [mm:ss] · STOP · NEXT · END${C.reset}   scoreboard clock: START is the game's start frame (the opening faceoff; the clock never runs before it), GO restarts it after a stoppage, WHISTLE stops it at the whistle (WHISTLE 12:34 also sets it to the official clock's time; Esc in the workbench); events latch to the clock at your first keystroke (periods P1 P2 P3 OT SO; OT2 … in sudden-death playoffs)
  ${C.cyan}rink overtime [LEAGUE] [preset | ot=5:00 skaters=3 shootout=3 playoff-ot=20:00 …]${C.reset}   a league's overtime rules: presets standard four-on-four international overtime-then-tie shootout-only ties; each new game keeps a copy
  ${C.cyan}UNDO · DEL n · FIX n TEAM PLAYER STAT[/mods] · FIX n A1=19 A2=44 XY=78,-4${C.reset}   corrections (appended, never overwritten)
  ${C.cyan}Q target${C.reset}                   SCORE BOX EVENTS XG STINTS PEN PLAYER STANDINGS LEADERS RAPM GSAX GAR NHLE HEAT LEDGER AUDIT ROSTER CODES HK001
  ${C.cyan}GAME key · LOCALE fr-CA${C.reset}     switch game · French tokens (B=but, T=tir, MG/MP mise en jeu …)
  ${C.cyan}rink import FILE [--apply] · rink refs [TEAM]${C.reset}   a roster file (csv tsv xlsx md txt corpus xml edi) → leagues, teams, players and the
                                 four-letter reference of each (rink import formats) · rink leagues · rink teams [LEAGUE] · rink roster TEAM
  ${C.grey}Tab completes · → or End accepts the grey ghost text · amber = incomplete · red = cannot be valid${C.reset}`;

function promptOf(S) {
  if (!S.game || !S.sb) return `${C.cyan}rink${C.reset} ${C.grey}(no game — GAME <key> or rink new HOME AWAY)${C.reset} ${C.cyan}›${C.reset} `;
  const sb = S.sb; const ds = R().liveRemainingDs(sb, nowNs());
  const clk = `${Math.floor(ds / 600)}:${String(Math.floor(ds / 10) % 60).padStart(2, '0')}`;
  const state = sb.final ? paint('amber', 'FINAL') : `${sb.periodText} ${clk}${sb.running ? paint('green', '▶') : paint('grey', '⏸')}`;
  const pen = sb.final ? '' : (sb.penalties || []).length ? paint('amber', ` ${sb.strength}`) : paint('grey', ` ${sb.strength}`);
  return `${C.cyan}rink${C.reset} ${C.grey}${S.game}${C.reset} ${C.bold}${sb.home} ${sb.score[sb.home]}–${sb.score[sb.away]} ${sb.away}${C.reset} ${state}${pen} ${C.cyan}›${C.reset} `;
}
function makeMode(ctx) {
  const S = st(ctx), session = ctx.session, term = ctx.stdout, registry = ctx.registry;
  const notify = (text) => {
    if (session.mode !== mode) return;
    term.write('\r\x1b[2K' + text + '\n');
    const r = session.pending; if (r && !r.done) { r.prompt = promptOf(S); r._repaint(); }
  };
  if (S.unsub) S.unsub();
  try {
    S.unsub = service(ctx).on((ev) => {
      if (!ev || ev.game !== S.game) return;
      if (ev.scoreboard) S.sb = ev.scoreboard;
      // `own` marks this principal's lines; `operator` is present for scorers and admins, `line` is the server's text
      const theirs = ev.own === false || (ev.own === undefined && ev.operator && ev.operator !== S.me);
      if (ev.type === 'update' && theirs && ev.line) notify(`${C.grey}[${plain(ev.operator || 'scorer')}]${C.reset} ${plain(ev.line)}${ev.results && ev.results.some((r) => r.status === 'REJECTED') ? paint('red', '  rejected') : ''}`);
      else if (ev.type === 'update') { const r = session.pending; if (session.mode === mode && r && !r.done) { r.prompt = promptOf(S); r._repaint(); } }
    });
  } catch { S.unsub = null; }
  const mode = {
    name: 'rink',
    prompt: () => promptOf(S),
    complete(buf, cur) {
      if (!S.assist || cur !== buf.length) return null;
      const r = S.assist.complete(buf);
      if (r.line !== buf) return { replace: r.line, cursor: r.line.length, candidates: r.candidates };
      return r.candidates.length > 1 ? { candidates: r.candidates } : null;
    },
    decorate(buf) {
      if (!S.assist || !buf.trim()) return { text: buf, ghost: '' };
      const a = S.assist.analyze(buf);
      const col = a.state === 'error' ? C.red : a.state === 'incomplete' ? C.amber : '';
      const first = buf.trim().split(/\s+/)[0];
      const shellish = a.state === 'error' && registry.resolve(first) && !S.teams.has(first.toUpperCase());
      return { text: col && !shellish ? col + buf + C.reset : buf, ghost: a.ghost || '', hint: !shellish && a.state === 'error' && a.message ? '‹' + a.message + '›' : (a.ghost ? '' : (a.state === 'incomplete' && /\s$/.test(buf) && a.hint ? '‹' + a.hint + '›' : '')) };
    },
    async handle(line, io) {
      const ast = hcl().parseLine(line, { locale: S.locale });
      const first = line.trim().split(/\s+/)[0];
      try {
        switch (ast.kind) {
          case 'empty': return 0;
          case 'other': return false;
          case 'error': if (registry.resolve(first) && !S.teams.has(first.toUpperCase())) return false; io.write(`${C.red}${plainLines(ast.message)}${C.reset}\n`); return 1;
          case 'help': io.write(HELP + '\n'); return 0;
          case 'exit': leave(ctx, S); io.write(`${C.grey}left RINK mode${C.reset}\n`); return 0;
          case 'locale': S.locale = ast.locale; if (S.assist) S.assist.set({ locale: S.locale }); io.write(`${C.grey}locale ${S.locale}${C.reset}\n`); return 0;
          case 'game': { const g = await selectGame(ctx, ast.key); io.write(R().scoreLine(g.scoreboard) + '\n'); return 0; }
          case 'query': {
            const flags = Object.assign({}, ast.flags); for (const k of Object.keys(flags)) if (flags[k] === '') flags[k] = true;
            const d = await call(ctx, 'q', { target: ast.target, args: ast.args, flags, game: S.game });
            io.write(R().query(d, { width: io.cols, nowNs: nowNs() }) + '\n'); return 0;
          }
          default: {
            if (!S.game) { io.write(`${C.amber}no game selected: GAME <key>, or rink new HOME AWAY${C.reset}\n`); return 1; }
            const onset = io.onsetNs || nowNs(); const commit = nowNs();
            const frames = wire().compile(ast, { gameHash: S.info.idHash, lamport: S.lamport + 1, onsetNs: onset < commit ? onset : commit, commitNs: commit });
            S.lamport += frames.length;
            const res = await call(ctx, 'submit', { game: S.game, frames: frames.map((f) => Buffer.from(f).toString('base64')), line: line.trim() });
            S.sb = res.scoreboard;
            io.write(R().results(res) + '\n');
            const goal = res.results.some((r) => r.stat === 'G' && r.status === 'COMMITTED') || ast.kind === 'clock';
            if (goal) io.write(R().scoreLine(res.scoreboard, { nowNs: nowNs() }) + '\n');
            return res.results.some((r) => r.status === 'REJECTED') ? 1 : 0;
          }
        }
      } catch (e) { io.write(`${C.red}${e.code ? plain(e.code) + ': ' : ''}${plainLines(e.message)}${C.reset}\n`); return 1; }
    }
  };
  return mode;
}
function leave(ctx, S) {
  if (S.unsub) { S.unsub(); S.unsub = null; }
  if (S.game) call(ctx, 'unsubscribe', { game: S.game }).catch(() => {});
  ctx.session.mode = null;
}

/* ------------------------------------------------------------------ rink */
const rinkCmd = {
  name: 'rink',
  summary: 'hockey statistics virtual terminal: score games, query the league, administer rosters',
  usage: 'rink [GAME] | rink games | leagues | teams [LEAGUE] | roster TEAM | refs [LEAGUE|TEAM] | import PATH [--apply] | import formats | import examples [DIR] | new HOME AWAY [date] [stage] | overtime [LEAGUE] [preset|key=value…|clear] | addleague CODE "Name" ["Nom"] [ABBR] | addteam CODE "Name" ["Nom"] ["Arena"] [--league=CODE] [--city=…] | addplayer TEAM FIRST LAST JERSEY POS YYYY-MM-DD [L|R] [import] | sim [n] [seed] | ledger [verify] | note TEAM text | note del ID | notes [TEAM] | status | help',
  complete: () => ['games', 'leagues', 'teams', 'roster', 'refs', 'import', 'new', 'overtime', 'addleague', 'addteam', 'addplayer', 'sim', 'ledger', 'note', 'notes', 'status', 'help'],
  async run(ctx) {
    const S = st(ctx); const [sub, ...rest] = ctx.args; const w = ctx.cols || 100;
    try {
      if ((sub || '').toLowerCase() === 'status') S.hello = null;          // status always asks the service again
      const h = await hello(ctx);
      switch ((sub || '').toLowerCase()) {
        case '': case 'mode': {
          const key = rest[0] || S.game || h.current;
          if (key) await selectGame(ctx, key);
          ctx.setMode(makeMode(ctx));
          ctx.stdout.write(`${C.bold}RINK Virtual Terminal${C.reset} ${C.grey}· ${h.sub}@${h.tenant} · ${h.caps.join(', ')} · ledger ${h.store ? 'durable (' + h.store + ')' : h.durable ? 'durable (SSD-RAM)' : 'memory only'}${C.reset}\n`);
          if (S.sb) ctx.stdout.write(R().scoreLine(S.sb, { nowNs: nowNs() }) + '\n');
          else {
            const two = [...S.teams].slice(0, 2);
            ctx.stdout.write(`${C.amber}${two.length < 2 ? `no ${two.length ? 'second ' : ''}team yet — ${h.caps.includes('admin') ? 'rink import FILE reads a roster (rink import formats), or rink addteam CODE "Name"' : 'ask league staff to import the rosters'}`
              : `no game yet — ${h.caps.includes('score') ? `rink new ${two[0]} ${two[1]}` : 'ask a scorer to create one'}`}${C.reset}\n`);
          }
          ctx.stdout.write(`${C.grey}HELP for the language · EXIT to leave · Tab / → complete${C.reset}\n`);
          return 0;
        }
        case 'games': {
          const pg = (ctx.flags || {}).page; if (pg !== undefined && (pg === true || Number.isNaN(typedCount(pg)) || typedCount(pg) < 1)) return fail(ctx, 'rink', '--page is a whole number, as in rink games --page=2');
          const d = await call(ctx, 'games', { limit: 150, page: pg === undefined ? 1 : typedCount(pg) });
          ctx.stdout.write(fmt().table([{ h: 'game' }, { h: 'date' }, { h: 'stage' }, { h: 'home' }, { h: 'score', align: 'r' }, { h: 'away' }, { h: 'state' }, { h: 'events', align: 'r' }],
            d.games.map((g) => [paint(g.key === S.game ? 'green' : 'cyan', g.key), g.date, g.stage, g.home, `${g.score[g.home]}–${g.score[g.away]}`, g.away, g.damaged ? paint('red', 'QUARANTINED') : g.final ? 'FINAL ' + (g.final.decidedIn || '') : g.period, g.events]), { width: w }) + '\n');
          if (d.total > d.games.length) ctx.stdout.write(`${C.grey}${d.games.length ? `${d.page > 1 ? `page ${d.page}: ` : 'the newest '}${d.games.length} of ${d.total} games${d.page * 150 < d.total ? ` · rink games --page=${d.page + 1} shows the ones before` : ''}` : `no games on page ${d.page}: there are ${d.total}`}${C.reset}\n`);
          return 0;
        }
        case 'teams': {
          const d = await call(ctx, 'teams', { league: rest[0], page: typeof (ctx.flags || {}).page === 'string' ? ctx.flags.page : undefined });
          for (const t of d.teams) ctx.stdout.write(`${paint('cyan', t.code)}  ${t.league ? paint('grey', t.league) + '  ' : ''}${t.name_en}${t.name_fr !== t.name_en ? ' · ' + t.name_fr : ''}${t.arena ? ' · ' + t.arena : ''}\n`);
          const tl = R().pageLine(paint, 'teams', 100, d.page, d.teams.length, d.total); if (tl) ctx.stdout.write(tl + '\n');
          if (!d.total) ctx.stdout.write(`${C.grey}no team${d.league ? ' in ' + d.league : ''} yet — rink import FILE, or rink addteam${C.reset}\n`);
          return 0;
        }
        case 'leagues': { ctx.stdout.write(R().leagues(await call(ctx, 'leagues'), { width: w }) + '\n'); return 0; }
        case 'refs': { ctx.stdout.write(R().refs(await call(ctx, 'refs', { of: rest[0], page: typeof (ctx.flags || {}).page === 'string' ? ctx.flags.page : undefined }), { width: w }) + '\n'); return 0; }
        case 'addleague': {
          if (rest.length < 2) return fail(ctx, 'rink', 'usage: rink addleague CODE "English name" ["Nom français"] [ABBR]     (CODE is four letters; rink import designates one from the name)');
          const d = await call(ctx, 'addleague', { code: rest[0], name_en: rest[1], name_fr: rest[2], abbr: rest[3] });
          S.hello = null; ctx.stdout.write(`${paint('green', 'league')} ${d.league.code}  ${d.league.name_en}${d.league.abbr ? ' · ' + d.league.abbr : ''}\n`); return 0;
        }
        case 'overtime': {
          // rink overtime · rink overtime LEAGUE · rink overtime LEAGUE PRESET|key=value … · rink overtime LEAGUE clear
          const d = await call(ctx, 'overtime', { league: rest[0], words: rest.slice(1) });
          const presets = () => `${C.grey}presets  ${d.presets.map((p) => p.name).join(' · ')}   settings  ${d.settings.join(' ')}   clear (the built-in rules)${C.reset}\n` +
            d.presets.map((p) => `${C.grey}  ${p.name.padEnd(18)} ${p.text}${C.reset}\n`).join('');
          if (d.leagues) {
            for (const l of d.leagues) ctx.stdout.write(`${paint('cyan', l.code)}  ${l.rules ? l.text : C.grey + l.text + C.reset}\n`);
            if (!d.leagues.length) ctx.stdout.write(`${C.grey}no league yet — rink addleague CODE "Name", or rink import FILE; a game outside a league uses the ${d.builtIn}${C.reset}\n`);
            ctx.stdout.write(presets()); return 0;
          }
          ctx.stdout.write(`${paint(d.changed ? 'green' : 'cyan', d.changed ? 'overtime set' : 'overtime')} ${d.code}  ${d.text}\n`);
          if (d.changed) ctx.stdout.write(`${C.grey}games created from now on follow these rules · ${d.existing} existing game${d.existing === 1 ? ' keeps' : 's keep'} the rules ${d.existing === 1 ? 'it was' : 'they were'} created under${C.reset}\n`);
          else if (rest.length > 1) ctx.stdout.write(`${C.grey}unchanged: ${d.code} already plays these rules${C.reset}\n`);
          else ctx.stdout.write(presets());
          return 0;
        }
        case 'import': return await importRoster(ctx, rest, w);
        case 'roster': { const d = await call(ctx, 'q', { target: 'ROSTER', args: [rest[0] || ''] }); ctx.stdout.write(R().roster(d, { width: w }) + '\n'); return 0; }
        case 'new': {
          if (rest.length < 2) return fail(ctx, 'rink', 'usage: rink new HOME AWAY [YYYY-MM-DD] [REGULAR|PLAYOFF|PRESEASON|CHAMPIONSHIP]');
          const d = await call(ctx, 'newgame', { home: rest[0], away: rest[1], date: rest[2], stage: rest[3] });
          await selectGame(ctx, d.game.key);
          ctx.stdout.write(`${paint('green', 'created')} ${d.game.key}  ${d.game.home} vs ${d.game.away}  ${d.game.date} ${d.game.stage}  ${C.grey}uuid ${d.game.uuid}${C.reset}\n${C.grey}start with: T 20:00 P1 · LINE … · ${d.game.start === 'frame' ? 'START at the opening faceoff (the clock waits for it)' : 'FOCO SMIT FOW · GO'}${C.reset}\n`);
          if (S.sb && S.sb.overtime) ctx.stdout.write(`${C.grey}overtime: ${S.sb.overtime.text}${S.sb.overtime.league ? ` (${S.sb.overtime.league} rules)` : ' (built-in rules)'}${C.reset}\n`);
          return 0;
        }
        case 'addteam': {
          if (rest.length < 2) return fail(ctx, 'rink', 'usage: rink addteam CODE "English name" ["Nom français"] ["Arena"]');
          const tf = ctx.flags || {};
          const d = await call(ctx, 'addteam', { code: rest[0], name_en: rest[1], name_fr: rest[2], arena: rest[3], league: typeof tf.league === 'string' ? tf.league : undefined, city: typeof tf.city === 'string' ? tf.city : undefined });
          S.hello = null; ctx.stdout.write(`${paint('green', 'team')} ${d.team.code}  ${d.team.name_en} · ${d.team.name_fr}${d.team.arena ? ' · ' + d.team.arena : ''}\n`); return 0;
        }
        case 'addplayer': {
          if (rest.length < 6) return fail(ctx, 'rink', 'usage: rink addplayer TEAM FIRST LAST JERSEY C|LW|RW|D|G YYYY-MM-DD [L|R] [import]');
          const [team, first, last, jersey, pos, birth, ...more] = rest;
          const shoots = more.find((x) => /^[LR]$/i.test(x)); const imp = more.some((x) => /^import$/i.test(x));
          const d = await call(ctx, 'addplayer', { team, first, last, jersey: typedCount(jersey), pos: String(pos).toUpperCase(), birth, shoots: shoots ? shoots.toUpperCase() : 'L', import: imp });
          delete S.rosters[d.player.team]; if (S.info && (S.info.home === d.player.team || S.info.away === d.player.team)) { S.rosters[d.player.team] = (await call(ctx, 'roster', { team: d.player.team })).players; if (S.assist) S.assist.set({ rosters: S.rosters }); }
          ctx.stdout.write(`${paint('green', 'player')} ${d.player.team} ${paint('cyan', d.player.code)} #${d.player.jersey} ${d.player.name} ${d.player.pos} ${C.grey}born ${d.player.birth}${d.player.import ? ' · import' : ''} · id ${d.player.pid}${C.reset}\n`); return 0;
        }
        case 'sim': case 'simulate': {
          const games = rest[0] === undefined ? 4 : typedCount(rest[0]), seed = rest[1] === undefined ? Date.now() % 100000 : typedCount(rest[1]);
          if (Number.isNaN(games) || Number.isNaN(seed)) return fail(ctx, 'rink', 'usage: rink sim [GAMES] [SEED]   (whole numbers)');
          ctx.stdout.write(`${C.grey}typing synthetic games through the production command path…${C.reset}\n`);
          const d = await call(ctx, 'simulate', { games, seed });
          for (const g of d.simulated) ctx.stdout.write(`${paint('cyan', g.key)}  ${g.home} ${g.score[g.home]} – ${g.score[g.away]} ${g.away}  ${g.result || ''}  ${C.grey}${g.lines} lines${g.rejected ? ', ' + g.rejected + ' rejected' : ''}${C.reset}\n`);
          ctx.stdout.write(`${C.grey}${d.note}${C.reset}\n`); return 0;
        }
        case 'ledger': {
          const key = rest.find((x) => !x.startsWith('-') && x !== 'verify') || S.game;
          if (!key) return fail(ctx, 'rink', 'which game? rink ledger G1 [verify]');
          const d = await call(ctx, 'ledger', { game: key, action: rest.includes('verify') ? 'verify' : 'info' });
          ctx.stdout.write(R().ledger(d) + '\n'); return d.verify && (!d.verify.ok || !d.replay.equal) ? 1 : 0;
        }
        case 'note': {
          if (rest.length < 2) return fail(ctx, 'rink', 'usage: rink note TEAM text…   ·   rink note del ID');
          if (rest[0].toLowerCase() === 'del') { if (Number.isNaN(typedCount(rest[1]))) return fail(ctx, 'rink', 'usage: rink note del ID   (the number rink notes shows)'); const d = await call(ctx, 'delnote', { id: typedCount(rest[1]) }); ctx.stdout.write(`${paint('amber', 'deleted')} note ${d.deleted}\n`); return 0; }
          const d = await call(ctx, 'note', { team: rest[0], text: rest.slice(1).join(' ') }); ctx.stdout.write(`${paint('green', 'note ' + d.note.id)} ${d.note.team} ${C.grey}(visible to tenant ${d.note.tenant} and admins only)${C.reset}\n`); return 0; }
        case 'notes': { const d = await call(ctx, 'notes', { team: rest[0] }); for (const n of d.notes) ctx.stdout.write(`${C.grey}#${n.id} ${String(n.at).slice(0, 16)} ${plain(n.by)}@${plain(n.tenant)}${C.reset} ${paint('cyan', n.team)} ${plain(n.text)}\n`); if (!d.notes.length) ctx.stdout.write(`${C.grey}no notes visible to ${h.tenant}${C.reset}\n`); return 0; }
        case 'status': ctx.stdout.write(fmt().kv([['service', h.version], ['principal', `${h.sub}@${h.tenant}${h.club ? ' (club ' + h.club + ')' : ''}`], ['capabilities', h.caps.join(', ')], ['ledger', h.store ? 'durable: ' + h.store : h.durable ? 'durable: SSD-RAM files under VWS_RINK_DIR' : 'memory only (set VWS_RINK_DIR to persist)'], ['games', String(h.totalGames === undefined ? h.games.length : h.totalGames) + (h.limits ? ` of at most ${h.limits.maxGames}` : '') + (h.damaged && h.damaged.length ? paint('red', `  ·  quarantined: ${h.damaged.join(' ')}${h.damagedTotal > h.damaged.length ? ` … (${h.damagedTotal} in all)` : ''}`) : '')], ['registry', `${(h.leagues || []).length} league${(h.leagues || []).length === 1 ? '' : 's'} · ${h.totalTeams === undefined ? h.teams.length : h.totalTeams} teams  (rink refs lists every four-letter reference)`], ['limits', h.limits ? `${h.limits.maxFrames} frames per game · frames at most ${h.limits.maxSkewMs / 1000} s ahead of the server clock` : '—'], ['current', S.game || h.current || '—'], ['started', `${h.started.at} · replayed ${h.started.frames} frames from ${h.started.games} game ledger(s) in ${h.started.ms} ms`]], { keyWidth: 13 }) + '\n'); return 0;
        case 'help': ctx.stdout.write(HELP + '\n'); return 0;
        default: {
          if (/^G\d+$/i.test(sub) || h.games.some((g) => g.key === sub)) { ctx.args = ['mode', sub]; return rinkCmd.run(Object.assign(ctx, { args: ['mode', sub] })); }
          return fail(ctx, 'rink', `unknown subcommand ${sub}; rink help`);
        }
      }
    } catch (e) { return fail(ctx, 'rink', e.message); }
  }
};

/* ------------------------------------------------------------------ q (shell form of Q) */
const qCmd = {
  name: 'q', summary: 'RINK query: q box · q rapm --str=5v5 · q standings · q hk001 FOCO --season', usage: 'q TARGET [args] [--game=G1|--season] [--team=TEAM] [--str=5v5] [--min=20] [--n=25]',
  complete: () => assistLib().Q_TARGETS.map((t) => t.toLowerCase()),
  async run(ctx) {
    const S = st(ctx);
    if (!ctx.args.length) return fail(ctx, 'q', 'usage: ' + qCmd.usage);
    try {
      await hello(ctx);
      const flags = Object.assign({}, ctx.flags); for (const k of Object.keys(flags)) if (flags[k] === true) flags[k] = true;
      const d = await call(ctx, 'q', { target: ctx.args[0].toUpperCase(), args: ctx.args.slice(1), flags, game: flags.game || S.game || (S.hello && S.hello.current) });
      ctx.stdout.write(R().query(d, { width: ctx.cols || 100, nowNs: nowNs() }) + '\n'); return 0;
    } catch (e) { return fail(ctx, 'q', e.message); }
  }
};

/* ------------------------------------------------------------------ HK001 */
const BOUNDARY = 'HK001 is a deterministic synthetic hockey research laboratory. It does not provide validated forecasts, betting odds, wagering recommendations, roster authority, medical advice, officiating judgments, scouting authority, or employment decisions.';
const STAGES = { eq: 'EQ', master: 'ML', ml: 'ML', x8s: 'X8S', sp8: 'SP8', '8sphere': 'SP8' };
const hk001Cmd = {
  name: 'hk001', summary: 'HK001 MSSL 2.3.0 lab: equations, Master Law, X8S, 8Sphere, receipts, codes',
  usage: 'hk001 [about|demo|eq|master|x8s|sp8|codes|inputs|graph CODE [depth]|receipt [--json]|verify|formats|examples [dir]] [filter] [--all]',
  complete: () => ['about', 'demo', 'eq', 'master', 'x8s', 'sp8', 'codes', 'inputs', 'graph', 'receipt', 'verify', 'formats', 'examples'],
  async run(ctx) {
    const L = lab(ctx); const [sub, ...rest] = ctx.args; const w = ctx.cols || 120; const filter = rest.filter((x) => !x.startsWith('-')).join(' ');
    try {
      switch ((sub || '').toLowerCase()) {
        case '': ctx.stdout.write(L.renderSummary({ width: w }) + '\n'); return 0;
        case 'about': ctx.stdout.write(`${C.bold}HK001 MSSL 2.3.0 — 8Sphere Hockey Extrapolator${C.reset}\n${fmt().wrap('A Go-exact JavaScript port of the HK001 engine (109 hockey equations → 32 Master-Law models → 26 X8S extrapolations → 26 8Sphere models). Every computation has a code and is a terminal command (563 in all, including Master-Law, X8S and 8Sphere intermediates); every input has a code (HKI-001 … HKI-109) labelled with the RINK tokens that feed it. The demo receipt is byte-identical to the Go CLI (SHA-256 faa8e35a…).', w)}\n\n${C.amber}${fmt().wrap(BOUNDARY, w)}${C.reset}\n`); return 0;
        case 'demo': L.setBaseline(); ctx.stdout.write(L.renderSummary({ width: w }) + '\n'); return 0;
        case 'eq': case 'master': case 'ml': case 'x8s': case 'sp8': case '8sphere': {
          const stage = STAGES[sub.toLowerCase()];
          ctx.stdout.write(L.renderStage(stage, { filter, width: w }) + '\n');
          if (stage !== 'EQ' && ctx.flags.all) ctx.stdout.write('\n' + paint('grey', 'intermediates') + '\n' + L.renderStage(stage, { filter, intermediate: true, width: w }) + '\n');
          else if (stage !== 'EQ') ctx.stdout.write(paint('grey', `--all adds the ${catalog().CATALOG.filter((x) => x.stage === stage && !x.published).length} intermediate codes`) + '\n');
          return 0;
        }
        case 'codes': ctx.stdout.write(L.renderCodes({ filter, width: w }) + '\n'); return 0;
        case 'inputs': ctx.stdout.write(L.renderInputs({ filter, width: w }) + '\n'); return 0;
        case 'graph': { if (!rest[0]) return fail(ctx, 'hk001', 'usage: hk001 graph CODE [depth]'); const g = L.renderGraph(rest[0], { depth: Number(rest[1]) || 3 }); if (!g) return fail(ctx, 'hk001', `unknown code ${rest[0]}`); ctx.stdout.write(g + '\n'); return 0; }
        case 'receipt': { const rc = L.receipt(); if (rc.unserializable) return fail(ctx, 'hk001', `no receipt for this case: ${rc.unserializable.length} values are NaN (zero denominators), e.g. ${rc.unserializable.slice(0, 3).join(', ')}; the Go CLI exits with "json: unsupported value: NaN" on the same input`); jsonOut(ctx, (ctx.flags.json ? engine().goJSON(rc) : engine().prettyJSON(rc)) + '\n'); return 0; }
        case 'verify': { let bad = 0; for (const v of L.verify()) { if (!v.pass) bad++; ctx.stdout.write(`${v.pass ? paint('green', 'PASS') : paint('red', 'FAIL')}  ${v.name}  ${C.grey}${v.detail}${C.reset}\n`); } return bad ? 1 : 0; }
        case 'formats': ctx.stdout.write(`${adapter().SUPPORTED.join(' ')}\n${C.grey}parser ${adapter().PARSER_VERSION} · inert: no format can execute code · case load FILE [record]${C.reset}\n`); return 0;
        case 'examples': {
          const dir = ctx.resolve(rest[0] || 'hk001-examples'); const files = adapter().exampleFiles();
          try { ctx.vfs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
          for (const [n, text] of Object.entries(files)) ctx.vfs.writeFile(dir + '/' + n, text);
          ctx.stdout.write(`${Object.keys(files).length} example input files in ${plain(dir)}\n${C.grey}case load ${plain(dir)}/example_hockey.csv${C.reset}\n`); return 0;
        }
        default: { const card = L.renderCode(sub, { width: w }); if (card) { ctx.stdout.write(card + '\n'); return 0; } return fail(ctx, 'hk001', `unknown subcommand or code ${sub}`); }
      }
    } catch (e) { return fail(ctx, 'hk001', e.message); }
  }
};

/* ---------------------------------------------------------------- rink import: a roster file → leagues, teams, players */
const IMPORT_FORMATS = `Roster files: leagues, teams and players, and the four-letter reference each one gets.

  rink import PATH              preview: what the file holds and the references it would designate. Nothing changes.
  rink import PATH --apply      register it (all of it, or nothing when a record is in error; --skip-errors registers the rest)
        --show=TEAM | all      list that team's players, or everyone's (a file of up to 60 players lists them anyway)
        --league="Name"        the league of the teams that name none          --page=N   the next hundred
        --assign-jerseys       give players without a number a free one, from 99 down

PATH is a file of this terminal (cat, echo, rink import examples), a file uploaded from the browser, or, where the
gateway allows it (tools/start-local.js does), a file on its computer: rink import ~/Documents/roster.xlsx
On Windows write 'C:\\Users\\you\\roster.xlsx' in single quotes, or C:/Users/you/roster.xlsx.

Forms            .csv .tsv .xlsx .xlsm .md .txt .corpus .xml .edi
Columns (any order, English or French; a header row names them)
  league         league, ligue            league_code (four letters), league_abbr (WHL)
  team           team, club, équipe       team_code (four letters), city, arena, timezone
  player         player or name ("Smith, John" or "John Smith"), or last_name + first_name
                 jersey / number / no / #, pos (C LW RW D G; F is recorded as C), shoots (L R), born (YYYY-MM-DD), import
  A table of players may leave the team cell empty below the first row of a team. A sheet named after a team, with
  no team column, is that team's roster. Sheets or tables of leagues and of teams alone are read too.
.md              # League   ## Team [CODE]   then a pipe table, "City: …" lines or lines like  9 John Smith C
.txt .corpus     league = …   team = …   city = …   player = …   jersey = …   pos = …      (or the same table as .csv)
.xml             <league name=""><team name="" city=""><player jersey="" last="" first="" pos=""/></team></league>
.edi             LGE*name*code*abbr~  TEM*name*code*city*arena~  PLR*jersey*last*first*pos*shoots*born~

References       LEAGUE_4 and TEAM_4 are the file's own four letters when it gives them. Otherwise they come from the
                 name: one word gives its first four letters (EDMOnton), two give two each (FOrt COllins), three give
                 2+1+1 (WEstern Hockey League), more give initials. A team's letters come from its city, or from its
                 name without the last word. PLAYER_4 is the surname's first four letters (SMIT), then SMIR, SMI9 …
                 when a teammate has them. A reference that exists is never changed.
`;
/** Stage a file of this session with the service, a piece at a time (a bridge request is small). */
async function stageFile(ctx, name, bytes) {
  const PIECE = 30000;
  for (let o = 0; o < bytes.length; o += PIECE) {
    const a = { name, offset: o, total: bytes.length, data: Buffer.from(bytes.subarray(o, o + PIECE)).toString('base64') };
    for (let attempt = 0; ; attempt++) {
      try { await call(ctx, 'stage', a); break; }
      catch (e) { if ((e.code === 'RATE' || e.code === 'BUSY') && attempt < 40) { await new Promise((r) => setTimeout(r, 150)); continue; } throw e; }
    }
  }
}
async function importRoster(ctx, rest, w) {
  const S = st(ctx); const F = ctx.flags || {}; const first = (rest[0] || '').toLowerCase();
  if (!rest.length || first === 'help' || first === 'formats') { ctx.stdout.write(IMPORT_FORMATS); return rest.length ? 0 : 1; }
  if (first === 'examples') {
    const dir = ctx.resolve(rest[1] || 'rosters'); const files = require('../../../../rink/server/roster-file').examples();
    try { ctx.vfs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
    for (const [n, text] of Object.entries(files)) ctx.vfs.writeFile(dir + '/' + n, text);
    ctx.stdout.write(`${Object.keys(files).length} example rosters in ${plain(dir)} (the same small league in each form)\n${C.grey}rink import ${plain(dir)}/roster.csv${C.reset}\n`); return 0;
  }
  const KNOWN = ['apply', 'league', 'show', 'page', 'assign-jerseys', 'skip-errors'];
  for (const k of Object.keys(F)) if (!KNOWN.includes(k)) return fail(ctx, 'rink', `import does not take --${k} (it takes ${KNOWN.map((x) => '--' + x).join(' ')})`);
  for (const k of ['apply', 'assign-jerseys', 'skip-errors']) if (F[k] !== undefined && F[k] !== true) return fail(ctx, 'rink', `--${k} takes no value`);
  for (const k of ['league', 'show', 'page']) if (F[k] === true) return fail(ctx, 'rink', `--${k} needs a value, as in --${k}=${k === 'page' ? '2' : k === 'show' ? 'FOCO' : '"Western Hockey League"'}`);
  if (F.page !== undefined && Number.isNaN(typedCount(F.page))) return fail(ctx, 'rink', '--page is a whole number');
  if (rest.length > 1) return fail(ctx, 'rink', `one file at a time: ${rest[1]} was not expected (a path with spaces goes in quotes)`);
  let name = rest[0], staged = false;
  // a file of this terminal's own file system goes to the service first; any other path is the service's to find
  const vp = ctx.resolve(rest[0]);
  if (ctx.vfs.exists(vp)) {
    if (ctx.vfs.isDir(vp)) return fail(ctx, 'rink', `${rest[0]} is a folder: name a file in it (ls ${rest[0]})`);
    const bytes = Buffer.from(ctx.vfs.readFile(vp), 'utf8');
    if (!bytes.length) return fail(ctx, 'rink', `${rest[0]} is empty`);
    name = vp.split('/').pop(); await stageFile(ctx, name, bytes); staged = true;
  } else {
    // the shell has turned ~ into this terminal's own home; for a file that is not here, ~ is the home folder of
    // whoever runs the gateway, and only the service knows where that is
    const home = String((ctx.env && ctx.env.get('HOME')) || '/home/operator').replace(/\/+$/, '');
    if (home && (name === home || name.startsWith(home + '/'))) name = '~' + name.slice(home.length);
  }
  const d = await call(ctx, 'import', { path: name, staged, apply: F.apply === true, league: typeof F.league === 'string' ? F.league : undefined, show: typeof F.show === 'string' ? F.show : undefined,
    page: F.page === undefined ? undefined : typedCount(F.page), assignJerseys: F['assign-jerseys'] === true, skipErrors: F['skip-errors'] === true });
  ctx.stdout.write(R().importPlan(d, { width: w, path: staged ? rest[0] : name }) + '\n');
  if (d.applied) S.hello = null;
  return d.refused || (F.apply === true && !d.applied) ? 1 : 0;
}

/** Parse a code command's arguments: FIELD=number overrides and options (both --k=v and --k v). What it cannot
 *  place is reported, never ignored: a mistyped override must not show the unchanged case as if it had applied. */
const CODE_OPTIONS = { plate: 0, all: 0, json: 0, baseline: 0, season: 0, keep: 0, graph: 2, team: 1, game: 1, player: 1, file: 1, record: 1 };   // 0 switch · 1 value · 2 optional depth
function codeArgs(argv) {
  const o = { overrides: Object.create(null), flags: Object.create(null), rest: [], errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]); const next = argv[i + 1];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (!Object.prototype.hasOwnProperty.call(CODE_OPTIONS, k)) { o.errors.push(`unknown option --${k}`); continue; }
      const kind = CODE_OPTIONS[k];
      if (v !== undefined) { if (kind === 0) o.errors.push(`--${k} takes no value`); else if (v === '') o.errors.push(`--${k} needs a value`); else o.flags[k] = v; }
      else if (kind === 1) { if (next !== undefined && !String(next).startsWith('-') && !/=/.test(next)) o.flags[k] = argv[++i]; else o.errors.push(`--${k} needs a value`); }
      else if (kind === 2 && next !== undefined && /^\d+$/.test(next)) o.flags[k] = argv[++i];
      else o.flags[k] = true;
    } else if (a.indexOf('=') > 0) {
      const k = a.slice(0, a.indexOf('=')), v = a.slice(a.indexOf('=') + 1); const n = typedNumber(v);
      if (Number.isNaN(n)) o.errors.push(`${k}=${v}: an override is FIELD=number, as in G=250`); else o.overrides[k] = n;
    } else o.rest.push(a);
  }
  if (o.rest.length) o.errors.push(`unexpected argument ${o.rest[0]} (an override is FIELD=number, as in G=250)`);
  return o;
}
/** Build the case a code command evaluates: the session case, or one from --baseline/--team/--file, plus K=V. */
async function caseFor(ctx, a) {
  const L = lab(ctx); const f = a.flags;
  const needsTemp = f.baseline || f.team || f.file || Object.keys(a.overrides).length;
  if (!needsTemp) return { lab: L, temp: false };
  const T = new (labLib().Lab)();
  if (f.team) {
    await hello(ctx); const S = st(ctx);
    const payload = await call(ctx, 'hk001case', { team: String(f.team).toUpperCase(), season: !!f.season || !f.game, game: f.game || null, player: f.player || null });
    T.fromBridge(payload); void S;
  } else if (f.file) { const p = ctx.resolve(String(f.file)); T.fromFile(p, Buffer.from(ctx.vfs.readFile(p), 'utf8'), f.record); }
  else if (!f.baseline) T.setCase(labLib().cloneCase(L.case));
  for (const [k, v] of Object.entries(a.overrides)) T.set(k, v);
  if (f.keep) { L.setCase(T.case); return { lab: L, temp: false }; }
  return { lab: T, temp: true };
}
function codeCommand(m) {
  return {
    name: m.code, aka: [m.code.toLowerCase()], group: 'hk001', summary: `HK001 ${m.stage}${m.published ? '' : ' intermediate'} · ${m.label}`,
    usage: `${m.code} [--plate] [--all] [--graph[=depth]] [--json] [--baseline | --team TEAM [--season|--game=G1] [--player=CODE] | --file PATH [--record=N]] [FIELD=VALUE …] [--keep]`,
    async run(ctx) {
      try {
        const a = codeArgs(ctx.argv); if (a.errors.length) return fail(ctx, m.code, a.errors[0]);
        const { lab: L, temp } = await caseFor(ctx, a);
        if (a.flags.json) { jsonOut(ctx, JSON.stringify(L.value(m.code), (k, v) => (k === 'meta' ? undefined : v), 2) + '\n'); return 0; }
        if (a.flags.graph) { ctx.stdout.write(L.renderGraph(m.code, { depth: Number(a.flags.graph) || 3 }) + '\n'); return 0; }
        ctx.stdout.write(L.renderCode(m.code, { width: ctx.cols || 110, plate: !!a.flags.plate, all: !!a.flags.all }) + '\n');
        if (temp) ctx.stdout.write(`${C.grey}evaluated on a temporary case (${plain(L.case.name)}); --keep makes it the working case${C.reset}\n`);
        return 0;
      } catch (e) { return fail(ctx, m.code, e.message); }
    }
  };
}
function inputCommand(m) {
  return {
    name: m.code, aka: [m.code.toLowerCase()], group: 'hk001-input', summary: `HK001 input · ${m.field} · ${m.label}`, usage: `${m.code} [VALUE | -]   (no value: show; VALUE: set it on the working case; -: back to the baseline)`,
    async run(ctx) {
      const L = lab(ctx); const v = ctx.argv[0];
      try {
        if (v === '-' || v === '--unset') { L.unset(m.code); ctx.stdout.write(`${paint('amber', m.code)} ${m.field} restored: ${fmt().num(L.case.request.values[m.field] === undefined ? engine().BASELINE[m.field] : L.case.request.values[m.field])} (${L.case.prov[m.field] || 'baseline overlay'})\n`); return 0; }
        if (v !== undefined) { const n = typedNumber(v); if (Number.isNaN(n) || ctx.argv.length > 1) return fail(ctx, m.code, `usage: ${m.code} [NUMBER | -]   (one plain decimal number, as in ${m.code} 250)`); L.set(m.code, n); ctx.stdout.write(`${paint('amber', m.code)} ${m.field} = ${n}  ${C.grey}(${(catalogDependents(m.code)).length} computations read it; type one of them to see the effect)${C.reset}\n`); return 0; }
        ctx.stdout.write(L.renderInput(m.code, { width: ctx.cols || 110 }) + '\n'); return 0;
      } catch (e) { return fail(ctx, m.code, e.message); }
    }
  };
}
const catalogDependents = (code) => catalog().dependents.get(code) || [];

const caseCmd = {
  name: 'case', summary: 'HK001 working case: baseline, a team from the ledger, input files, K=V overrides',
  usage: 'case [baseline | team TEAM [--season|--game=G1] [--player=CODE] | load FILE [record] | set K=V … | unset K … | mode strict|overlay | cal KEY VALUE | save FILE | json | prov]',
  complete: () => ['baseline', 'team', 'load', 'set', 'unset', 'mode', 'cal', 'save', 'json', 'prov'],
  async run(ctx) {
    const L = lab(ctx); const [sub, ...rest] = ctx.args; const w = ctx.cols || 110;
    try {
      switch ((sub || '').toLowerCase()) {
        case '': {
          const c = L.case; const changed = Object.entries(c.prov).filter(([, p]) => p !== 'BASELINE');
          const rc = L.receipt();
          ctx.stdout.write(fmt().kv([['case', plain(c.name)], ['source', plain(c.source)], ['mode', plain(c.request.input_mode)], ['fields', `${Object.keys(c.request.values).length} set · ${changed.length} not from the baseline`], ['receipt', rc.unserializable ? `none (${rc.unserializable.length} NaN values from zero denominators)` : rc.canonical_sha256]], { keyWidth: 9 }) + '\n');
          for (const n of c.notes || []) ctx.stdout.write(`${C.amber}· ${plain(n)}${C.reset}\n`);
          return 0;
        }
        case 'baseline': L.setBaseline(); ctx.stdout.write(`${paint('green', 'baseline')} HK001 synthetic demo case\n`); return 0;
        case 'team': {
          if (!rest[0]) return fail(ctx, 'case', 'usage: case team TEAM [--season|--game=G1] [--player=CODE]');
          await hello(ctx);
          const payload = await call(ctx, 'hk001case', { team: rest[0].toUpperCase(), season: !!ctx.flags.season || !ctx.flags.game, game: ctx.flags.game || null, player: ctx.flags.player || null });
          L.fromBridge(payload);
          ctx.stdout.write(R().hk001case({ case: payload }, { width: w }).split('\n').slice(0, -1).join('\n') + '\n');
          ctx.stdout.write(`${C.grey}every computation code now evaluates this case: try TEAM-012, OFF-024, ML-OFF, X8S-C01, SP8-C01, hk001${C.reset}\n`);
          return 0;
        }
        case 'load': {
          if (!rest[0]) return fail(ctx, 'case', 'usage: case load FILE [record]');
          const p = ctx.resolve(rest[0]); const r = L.fromFile(p, Buffer.from(ctx.vfs.readFile(p), 'utf8'), rest[1]);
          ctx.stdout.write(`${paint('green', 'loaded')} ${plain(r.c.name)} ${C.grey}(${r.count} record(s); parser ${adapter().PARSER_VERSION})${C.reset}\n`); return 0;
        }
        case 'set': {
          const kv = rest.flatMap((x) => x.split(',')).filter(Boolean); if (!kv.length) return fail(ctx, 'case', 'usage: case set FIELD=VALUE … (FIELD or HKI code)');
          for (const x of kv) { const i = x.indexOf('='); const k = i > 0 ? x.slice(0, i) : '', n = i > 0 ? typedNumber(x.slice(i + 1)) : NaN; if (!k || Number.isNaN(n)) return fail(ctx, 'case', `bad assignment ${x} (FIELD=number, as in G=250)`); const inp = L.set(k, n); ctx.stdout.write(`${paint('amber', inp.code)} ${plain(inp.field)} = ${n}\n`); }
          return 0;
        }
        case 'unset': for (const k of rest) { const f = L.unset(k); const pv = L.case.prov[f]; ctx.stdout.write(pv ? `${plain(f)} restored (${plain(pv)})\n` : inputs().resolve(f) ? `${plain(f)} restored (baseline overlay)\n` : `${plain(f)} removed (not an HK001 input)\n`); } return 0;
        case 'mode': ctx.stdout.write(`input mode ${L.setMode(rest[0] || 'overlay')}\n`); return 0;
        case 'cal': { if (rest.length !== 2 || Number.isNaN(typedNumber(rest[1])) || !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(rest[0])) return fail(ctx, 'case', 'usage: case cal KEY VALUE   (a calibration name and a number)'); L.setCal(rest[0], typedNumber(rest[1])); ctx.stdout.write(`calibration ${rest[0]} = ${rest[1]}\n`); return 0; }
        case 'save': { if (!rest[0]) return fail(ctx, 'case', 'usage: case save FILE'); const p = ctx.resolve(rest[0]); ctx.vfs.writeFile(p, L.caseJSON()); ctx.stdout.write(`saved ${plain(p)}\n`); return 0; }
        case 'json': jsonOut(ctx, L.caseJSON()); return 0;
        case 'prov': {
          const c = L.case; const rows = inputs().INPUTS.map((m) => [paint('amber', m.code), m.field, fmt().num(c.request.values[m.field]), c.prov[m.field] || 'BASELINE']);
          ctx.stdout.write(fmt().table([{ h: 'code' }, { h: 'field' }, { h: 'value', align: 'r' }, { h: 'provenance' }], rows, { width: w }) + '\n'); return 0;
        }
        default: return fail(ctx, 'case', 'usage: ' + caseCmd.usage);
      }
    } catch (e) { return fail(ctx, 'case', e.message); }
  }
};

const corpusCmd = {
  name: 'corpus', summary: 'HK001 Mathematical Corpus: 84 plates, guide pages, glossary, search', usage: 'corpus [ID | search WORDS | glossary [term] | page N]',
  async run(ctx) {
    const K = corpus(); const [sub, ...rest] = ctx.args; const w = ctx.cols || 110; const F = fmt();
    if (!sub) { ctx.stdout.write(F.table([{ h: 'plate' }, { h: 'title', max: 44 }, { h: 'section', max: 30 }, { h: 'page', align: 'r' }], K.plates.map((p) => [paint('cyan', p.id), p.title, p.section, p.page]), { width: w }) + `\n${C.grey}${K.plates.length} plates · ${K.title} · corpus ID for a plate${C.reset}\n`); return 0; }
    if (sub === 'search') { const q = rest.join(' ').toLowerCase(); if (!q) return fail(ctx, 'corpus', 'usage: corpus search WORDS'); const hits = K.plates.filter((p) => JSON.stringify(p).toLowerCase().includes(q)); for (const p of hits) ctx.stdout.write(`${paint('cyan', p.id)}  ${p.title}  ${C.grey}p.${p.page}${C.reset}\n`); if (!hits.length) ctx.stdout.write(`${C.grey}no plate mentions "${plain(q)}"${C.reset}\n`); return 0; }
    if (sub === 'glossary' || sub === 'page') {
      const page = sub === 'glossary' ? 95 : Number(rest[0]); const g = K.guide.find((x) => x.page === page);
      if (!g) return fail(ctx, 'corpus', `guide pages: ${K.guide.map((x) => x.page).join(', ')}`);
      let text = g.text; if (sub === 'glossary' && rest.length) { const t = rest.join(' ').toUpperCase(); const i = text.indexOf(t); text = i >= 0 ? text.slice(i, i + 600) : `no glossary entry ${t}`; }
      ctx.stdout.write(F.wrap(text, w) + '\n'); return 0;
    }
    const id = sub.toUpperCase(); const p = K.plates.find((x) => x.id === id) || catalog().PLATES.get(id);
    if (!p) return fail(ctx, 'corpus', `no plate ${sub}; corpus lists them`);
    ctx.stdout.write(`${C.bold}${paint('cyan', p.id)}${C.reset}  ${C.bold}${p.title}${C.reset}  ${C.grey}${p.section} · p.${p.page} · ${p.category} · ${p.unit} · authority ${p.input_authority}${C.reset}\n${paint('amber', p.equation)}\n`);
    for (const k of ['explanation', 'discussion', 'purpose', 'implications', 'application', 'source_reconciliation']) if (p[k]) ctx.stdout.write(`\n${C.grey}${k.toUpperCase().replace('_', ' ')}${C.reset}\n${F.wrap(p[k], w, '  ')}\n`);
    return 0;
  }
};

const tokensCmd = {
  name: 'tokens', summary: 'RINK stat tokens and the HK001 input codes they feed', usage: 'tokens [TOKEN]',
  async run(ctx) {
    const H = hcl(); const I = inputs(); const want = (ctx.args[0] || '').toUpperCase();
    const rows = Object.entries(H.STATS).filter(([k]) => !want || k === want).map(([k, v]) => [paint('cyan', k), v.kind, v.label, I.INPUTS.filter((x) => x.tokens.includes(k)).map((x) => x.code).join(' ')]);
    ctx.stdout.write(fmt().table([{ h: 'token' }, { h: 'kind' }, { h: 'meaning', max: 50 }, { h: 'HK001 input codes', max: 70 }], rows, { width: ctx.cols || 140 }) + '\n'); return 0;
  }
};

/* the 563 computation codes and 109 input codes, each its own command (built on first require) */
function codePack() {
  const out = [];
  for (const m of catalog().CATALOG) out.push(codeCommand(m));
  for (const m of inputs().INPUTS) out.push(inputCommand(m));
  return out;
}
module.exports = [rinkCmd, qCmd, hk001Cmd, caseCmd, corpusCmd, tokensCmd, ...codePack()];
module.exports.internals = { makeMode, codeArgs, promptOf, HELP };
