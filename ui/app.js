/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 RUSSELL PHILIP SMITHSON
 *
 * The workbench in the renderer. The engine (EngineRequire) runs here, in memory, as it does in the reference
 * edition's bench; the difference is where the league lives. The Photon host keeps it: at start this window loads the
 * registry and every game's ledger from the host and replays them, and after every command that changed anything it
 * sends the host what changed, and waits until the host has it on disk before the command's result is shown. If the
 * host refuses or cannot be reached, the window throws away what it had not recorded by loading the league again.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const meta = (n) => (document.querySelector(`meta[name="rinkvt-${n}"]`) || {}).content || '';
  const TOKEN = meta('token'), LOCAL = meta('local'), CLIENT = meta('client');
  const R = EngineRequire;
  const wire = R('rink/shared/wire.js');
  const { RinkService } = R('rink/server/service.js'); const { inProcessRink } = R('rink/server/inproc.js');
  const { parseFlags } = R('src/main/spiral/registry.js'); const pack = R('src/main/spiral/commands/rink.js');
  // the operator at this computer: every line it types records this computer's static loopback address
  const ME = { sub: 'operator', tenant: 'local', capabilities: new Set(['rink.admin']), local: LOCAL };

  /* ---------------- the Photon host ---------------- */
  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: Object.assign({ 'X-VEC1-Token': TOKEN }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    if (!r.ok) { let d = ''; try { const j = await r.json(); d = j.detail || j.error; } catch { d = r.statusText; } throw Object.assign(new Error(`the Photon host answered ${r.status}: ${d}`), { status: r.status }); }
    return path.startsWith('/api/ledgers') ? new Uint8Array(await r.arrayBuffer()) : r.json();
  }
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); };
  const state = (text, st) => { const e = $('h-state'); e.textContent = text; e.dataset.state = st; };

  let svc = null, client = null, saved = null, edition = null;
  /** build the service from what the host keeps */
  async function load() {
    const lg = await api('GET', '/api/league');
    const blob = await api('GET', '/api/ledgers?sha=' + encodeURIComponent(lg.registrySha || ''));
    const pre = new Map(); let off = 0;
    for (const g of lg.games) {
      const list = [];
      for (let i = 0; i < g.pairs; i++) { list.push(blob.slice(off, off + 64), blob.slice(off + 64, off + 128)); off += 128; }
      pre.set(g.key, list);
    }
    if (off !== blob.length) throw new Error('the ledgers the host sent do not match its index');
    const STORE = 'Photon host · sealed registry and hash-chained ledgers on this computer';
    const s = new RinkService(lg.registry ? { seed: false, registryData: JSON.parse(lg.registry), preload: (game) => pre.get(game.key) || [], store: STORE, startRule: 'frame' } : { seed: true, store: STORE, startRule: 'frame' });
    s.init();
    svc = s; client = inProcessRink(svc, ME);
    saved = { sha: lg.registrySha || null, revision: lg.registry ? svc.registry.revision : -1, entries: new Map(lg.games.map((g) => [g.key, g.pairs * 2])) };
    for (const g of svc.registry.games()) { try { svc.ctx(g.key); } catch { /* a quarantined game says so when used */ } }
    if (!lg.registry) await persist();                           // first start: the seeded clubs become the league
    showLeague();
  }
  /** send the host what changed since the last commit; resolves when it is on the host's disk */
  async function persist() {
    const batches = []; let registry = null;
    if (svc.registry.revision !== saved.revision) registry = JSON.stringify(svc.registry.data, null, 1) + '\n';
    for (const [key, c] of svc.games) {
      const have = saved.entries.get(key) || 0, n = c.ledger.length;
      if (n <= have) continue;
      if (have % 2 || n % 2) throw new Error(`${key}: a ledger entry without its meta line`);
      const bytes = new Uint8Array((n - have) * 64); for (let i = have; i < n; i++) bytes.set(c.ledger.get(i), (i - have) * 64);
      batches.push({ game: key, uuid: c.game.uuid, start: have / 2, n, data: bytes });
    }
    if (registry === null && !batches.length) return;
    state('recording…', 'busy');
    // one commit carries the registry and at most ~12 MB of entries; a long simulation takes several
    let first = true;
    while (first || batches.length) {
      const body = { base: saved.sha, ledgers: [] }; if (first && registry !== null) body.registry = registry;
      let size = 0; const sent = [];
      while (batches.length && (size === 0 || size + batches[0].data.length < 9e6)) { const b = batches.shift(); size += b.data.length; sent.push(b); body.ledgers.push({ game: b.game, uuid: b.uuid, start: b.start, data: b64(b.data) }); }
      const r = await api('POST', '/api/commit', body);
      saved.sha = r.registrySha; if (body.registry) saved.revision = svc.registry.revision;
      for (const b of sent) saved.entries.set(b.game, b.n);
      first = false;
    }
    state(`recorded ${new Date().toLocaleTimeString()}`, 'ok'); showLeague();
  }
  /** every command that may change the league goes through here */
  async function durably(fn) {
    let result, err = null;
    try { result = await fn(); } catch (e) { err = e; }
    try { await persist(); }
    catch (e) {
      state('NOT RECORDED', 'error');
      write(`\x1b[38;5;203mNOT RECORDED: ${e.message}. The window loads the league again from the Photon host, so it shows only what was recorded.\x1b[0m\n`);
      try { await load(); session.mode = null; renderPrompt(); } catch (e2) { write(`\x1b[38;5;203mthe league could not be loaded again: ${e2.message}. Reload the window.\x1b[0m\n`); }
      throw Object.assign(new Error('not recorded'), { quiet: true });
    }
    if (err) throw err;
    return result;
  }
  const showLeague = () => { const g = svc.registry.games().length, t = svc.registry.teams().length; $('h-league').textContent = `${t} teams · ${g} game${g === 1 ? '' : 's'}`; };

  /* ---------------- the terminal (the reference edition's commands, as in its bench) ---------------- */
  let lastFrames = null, lastLine = '';
  const host = { rink: { call(op, args) { if (op === 'submit') { lastFrames = args.frames; lastLine = args.line; } return durably(() => client.call(op, args)); }, on: (f) => client.on(f) } };
  const cmds = new Map(); for (const d of pack) { cmds.set(d.name, d); for (const a of d.aka || []) cmds.set(a, d); }
  const session = { mode: null, pending: null };
  const files = new Map();
  const vfs = { readFile(p) { if (!files.has(p)) throw new Error(`${p}: no such file`); return files.get(p); }, writeFile(p, t) { files.set(p, String(t)); }, mkdir() {}, readdir(d) { return [...files.keys()].filter((k) => k.startsWith(d + '/')).map((k) => k.slice(d.length + 1).split('/')[0]); },
    isDir(p) { return !files.has(p) && [...files.keys()].some((k) => k.startsWith(p + '/')); }, exists(p) { return files.has(p) || this.isDir(p); } };
  const out = $('out');
  function ansi(text, cls) {
    const frag = document.createDocumentFragment(); let st = { c: null, b: false, d: false };
    const re = /\x1b\[([0-9;]*)m/g; let last = 0, m;
    const push = (s) => { if (!s) return; const sp = document.createElement('span'); const k = [cls || '']; if (st.c) k.push('c' + st.c); if (st.b) k.push('b'); if (st.d) k.push('d'); sp.className = k.join(' ').trim(); sp.textContent = s; frag.append(sp); };
    while ((m = re.exec(text))) {
      push(text.slice(last, m.index)); last = re.lastIndex;
      const p = m[1].split(';').map(Number);
      for (let i = 0; i < p.length; i++) { const v = p[i]; if (v === 0 || m[1] === '') st = { c: null, b: false, d: false }; else if (v === 1) st.b = true; else if (v === 2) st.d = true; else if (v === 22) { st.b = false; st.d = false; } else if (v === 38 && p[i + 1] === 5) { st.c = p[i + 2]; i += 2; } else if (v === 39) st.c = null; }
    }
    push(text.slice(last)); return frag;
  }
  const write = (s) => { const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 40; out.append(ansi(String(s).replace(/\r/g, ''))); if (out.childNodes.length > 4000) for (let i = 0; i < 400; i++) out.firstChild.remove(); if (atEnd) out.scrollTop = out.scrollHeight; };
  const cols = () => Math.max(60, Math.min(160, Math.floor(out.clientWidth / 7.6)));
  const stdout = { write, isTTY: true }, stderr = { write, isTTY: true };
  function promptText() { return session.mode ? session.mode.prompt() : '\x1b[38;5;44mrink-vt\x1b[0m \x1b[38;5;44m›\x1b[0m '; }
  function renderPrompt() { const p = $('prompt'); p.textContent = ''; p.append(ansi(promptText())); }
  function ctxFor(argv, onsetNs) {
    const d = cmds.get(argv[0]); const { flags, args } = parseFlags(argv.slice(1), (d && d.parse) || {});
    return { argv: argv.slice(1), args, flags, stdout, stderr, session, host, cols: cols(), rows: 40, vfs, resolve: (p) => (p.startsWith('/') ? p : '/home/operator/' + p),
      registry: { resolve: (n) => cmds.get(n) || null, names: () => [...cmds.keys()] }, setMode: (m) => { session.mode = m || null; }, onsetNs };
  }
  const tokenize = (line) => (line.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
  async function store(arg) {
    if (arg === 'verify') {
      const r = await api('GET', '/api/verify');
      write(`${r.ok ? '\x1b[38;5;114mOK\x1b[0m' : '\x1b[38;5;203mDAMAGED\x1b[0m'}  registry ${r.registry.ok ? 'sealed ' + String(r.registry.sha256).slice(0, 16) + '…' : r.registry.error}  ·  event ledger ${r.events.ok ? r.events.events + ' events, chain intact' : r.events.error}\n`);
      for (const g of r.games) write(`  ${g.key.padEnd(6)} ${g.ok ? `${String(g.pairs).padStart(6)} entries · chain intact · tip ${g.tip.slice(0, 16)}…` : '\x1b[38;5;203m' + g.error + '\x1b[0m'}\n`);
      return;
    }
    edition = await api('GET', '/api/edition');
    write(`\x1b[1m${edition.product} ${edition.version}\x1b[0m  ${edition.edition}  (engine ${edition.engine})\n  runtime   ${edition.runtime}\n  loopback  ${edition.local} · static for this laptop (${edition.client}) · pool ${edition.pool}${edition.bound !== edition.local ? ` · listening on ${edition.bound}` : ''}\n`
      + (edition.pinned && edition.pinned !== edition.local ? `  pinned    ${edition.pinned}: this laptop's address; in this league another laptop holds it, so here it is ${edition.local}\n` : '')
      + (edition.fleet ? `  fleet     ${edition.fleet}: ${edition.fleet_state}\n` : '  fleet     none: unique in each league\u2019s lease table; enrol the laptops in one fleet register for one address everywhere\n')
      + `  league    ${edition.data} · ${svc.registry.games().length} games · ${edition.events} host events\n`);
  }
  async function exec(line, onsetNs) {
    write(promptText() + '\x1b[38;5;252m' + line + '\x1b[0m\n');
    const t = line.trim(); if (!t) return;
    if (t === 'clear') { out.textContent = ''; return; }
    if (t === 'help') { write(HELP + '\n'); return; }
    try {
      if (/^store(\s|$)/.test(t)) { await store(t.split(/\s+/)[1]); return; }
      if (session.mode && session.mode.handle) { const rc = await session.mode.handle(t, { write, onsetNs, session, cols: cols(), rows: 40 }); if (rc !== false) return; }
      const argv = tokenize(t); if (!cmds.has(argv[0]) && cmds.has(argv[0].toLowerCase())) argv[0] = argv[0].toLowerCase();   // Q BOX is q box outside RINK mode too
      const d = cmds.get(argv[0]);
      if (!d) { write(`\x1b[38;5;203m${argv[0]}: not a workbench command — try help\x1b[0m\n`); return; }
      await d.run(ctxFor(argv, onsetNs));
    } catch (e) { if (!e.quiet) write(`\x1b[38;5;203m${e.message}\x1b[0m\n`); }
    finally { renderPrompt(); refresh(); }
  }
  const HELP = '\x1b[1mWorkbench commands\x1b[0m  (the same implementations as the reference edition\'s terminal)\n' +
    '  \x1b[38;5;44mrink [G#] · rink games · rink new HOME AWAY · rink sim 4 · EXIT\x1b[0m   RINK mode and league admin\n' +
    '  \x1b[38;5;44mTEAM PLAYER STAT[/mods]\x1b[0m  score in RINK mode (HELP inside rink mode lists the whole language)\n' +
    '  \x1b[38;5;44mq box · q audit · q rapm --min=5 · q standings · q hk001 FOCO --season\x1b[0m   queries\n' +
    '  \x1b[38;5;44mrink import examples · rink import rosters/roster.csv [--apply] · rink refs [TEAM]\x1b[0m   roster files → four-letter references\n' +
    '  \x1b[38;5;44mhk001 · OFF-001 · HKI-002 300 · case team FOCO --season · corpus OFF8S-001 · tokens G\x1b[0m   the HK001 lab\n' +
    '  \x1b[38;5;44mstore · store verify\x1b[0m   the Photon host: where the league is, and a check of every seal and chain\n' +
    '  \x1b[38;5;245mTab completes · → accepts ghost text · ↑↓ history · clear\x1b[0m';

  /* ---------------- input: ghost text, colour, history, completion ---------------- */
  const cmd = $('cmd'), ghost = $('ghost'), row = document.querySelector('.inrow'), hint = $('hint');
  const hist = []; let hi = 0; let onset = null;
  function assist() { const S = session.rink; return session.mode && S && S.assist ? S.assist : null; }
  function analyze() {
    const v = cmd.value; const a = assist(); let st = 'empty', g = '', msg = '';
    const first = v.trim().split(/\s+/)[0] || '';
    if (v.trim() && a && !(cmds.has(first) && !a.state.teams.includes(first.toUpperCase()))) { const r = a.analyze(v); st = r.state; g = r.ghost || ''; msg = r.state === 'error' ? r.message : r.state === 'incomplete' ? (r.hint ? 'next: ' + r.hint : '') + (r.candidates && r.candidates.length ? '  ' + r.candidates.slice(0, 8).join(' ') : '') : r.hint || ''; }
    else if (v.trim()) { const c = [...cmds.keys(), 'store', 'help', 'clear'].filter((k) => k.startsWith(first)); st = cmds.has(first) || ['help', 'clear', 'store'].includes(first) ? 'ok' : c.length ? 'incomplete' : 'error'; if (!/\s/.test(v) && c.length === 1) g = c[0].slice(first.length); msg = st === 'error' ? `${first}: not a command` : ''; }
    else msg = session.mode ? 'TEAM PLAYER STAT · Q BOX · LINE … · T 20:00 P1 · START · GO · UNDO · EXIT · help' : 'rink · rink games · q standings · hk001 · OFF-001 · store · help';
    row.dataset.state = st; ghost.textContent = ''; const pad = document.createElement('span'); pad.textContent = v; const gi = document.createElement('i'); gi.textContent = g; ghost.append(pad, gi); hint.textContent = msg;
    return g;
  }
  cmd.addEventListener('input', () => { if (cmd.value && onset === null) onset = wire.nowNs(); if (!cmd.value) onset = null; analyze(); });
  cmd.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const line = cmd.value; const on = onset; cmd.value = ''; onset = null; analyze(); if (line.trim()) { hist.push(line); hi = hist.length; } await exec(line, on); analyze(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (hi > 0) { cmd.value = hist[--hi]; analyze(); } }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (hi < hist.length) { hi++; cmd.value = hist[hi] || ''; analyze(); } }
    else if (e.key === 'Tab') { e.preventDefault(); const a = assist(); const first = cmd.value.trim().split(/\s+/)[0] || ''; if (a && !cmds.has(first)) { cmd.value = a.complete(cmd.value).line; } else { const g = analyze(); if (g) cmd.value += g + ' '; } analyze(); }
    else if ((e.key === 'ArrowRight' || e.key === 'End') && cmd.selectionStart === cmd.value.length) { const g = analyze(); if (g) { e.preventDefault(); cmd.value += g; analyze(); } }
  });
  for (const b of document.querySelectorAll('#chips button:not([data-pick])')) b.addEventListener('click', async () => { const line = b.textContent; hist.push(line); hi = hist.length; await exec(line, wire.nowNs()); cmd.focus(); analyze(); });
  const picker = $('file');
  $('pick').addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => {
    const f = picker.files && picker.files[0]; picker.value = ''; if (!f) return;
    const name = f.name.replace(/['"\\]/g, '_');
    try { svc.importer.stageBytes(ME, name, new Uint8Array(await f.arrayBuffer())); }
    catch (e) { write(`\x1b[38;5;203m${name}: ${e.message}\x1b[0m\n`); return; }
    const line = `rink import ${/\s/.test(name) ? `'${name}'` : name}`; hist.push(line); hi = hist.length; await exec(line, wire.nowNs()); cmd.focus(); analyze();
  });
  $('h-verify').addEventListener('click', () => exec('store verify', null));
  $('h-stop').addEventListener('click', async () => {
    try { await persist(); await api('POST', '/api/shutdown', {}); } catch (e) { write(`\x1b[38;5;203m${e.message}\x1b[0m\n`); return; }
    state('host stopped · the league is on disk · close this window', 'error'); cmd.disabled = true;
  });

  /* ---------------- the game panel ---------------- */
  const rink = RinkMap.create($('rink'), { onPick: ({ x, y }) => { const S = session.rink; const team = (cmd.value.trim().split(/\s+/)[0] || '').toUpperCase(); const away = S && S.info && team === S.info.away; cmd.value = cmd.value.replace(/\/-?\d+(\.\d)?,-?\d+(\.\d)?$/, '') + `/${(away ? -x : x).toFixed(1)},${(away ? -y : y).toFixed(1)}`; cmd.focus(); analyze(); } });
  let tab = 'frame';
  for (const id of ['frame', 'box', 'events', 'league']) $('t-' + id).addEventListener('click', () => { tab = id; for (const k of ['frame', 'box', 'events', 'league']) $('t-' + k).setAttribute('aria-selected', String(k === tab)); renderPane(); });
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  function table(heads, rows) { const t = el('table'); const tr = el('tr'); for (const h of heads) tr.append(el('th', h.r ? 'r' : '', h.h)); const th = el('thead'); th.append(tr); t.append(th); const tb = el('tbody'); for (const r of rows) { const row2 = el('tr'); r.forEach((v, i) => row2.append(el('td', heads[i] && heads[i].r ? 'r' : '', v === null || v === undefined ? '' : String(v)))); tb.append(row2); } t.append(tb); return t; }
  const f3 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(3));
  const mmss = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.round(s || 0) % 60).padStart(2, '0')}`;
  const FIELDS = [['uuid', 0, 16, 'UUIDv7'], ['onset', 16, 24, 'keystroke onset ns'], ['commit', 24, 32, 'Enter ns'], ['game', 32, 36, 'game hash'], ['lamport', 36, 40, 'Lamport'], ['team', 40, 44, 'TEAM'], ['player', 44, 48, 'PLAYER'], ['stat', 48, 52, 'STAT'], ['mod', 52, 56, 'MOD'], ['xy', 56, 60, 'x, y'], ['crc', 60, 64, 'CRC32C']];
  function renderPane() {
    const pane = $('pane'); pane.textContent = ''; if (!svc) return; const S = session.rink; const key = S && S.game;
    if (tab === 'frame') {
      if (!lastFrames) { pane.append(el('p', 'fdesc', 'Score a line to see its 64-byte frame.')); return; }
      pane.append(el('div', 'fdesc', `${lastLine}  →  ${lastFrames.length} frame${lastFrames.length > 1 ? 's' : ''} (big-endian; CRC32C over bytes 0–59)`));
      for (const fb of lastFrames.slice(0, 4)) {
        const u = Uint8Array.from(atob(fb), (c) => c.charCodeAt(0)); const d = wire.decode(u);
        pane.append(el('div', 'fdesc', wire.describe(d) + (d.crcOk ? '  ✓ CRC' : '  ✗ CRC')));
        const g = el('div', 'hex');
        for (let i = 0; i < 64; i++) { const f = FIELDS.find((x) => i >= x[1] && i < x[2]); const s = el('span', 'f-' + f[0], u[i].toString(16).padStart(2, '0')); s.title = f[3]; g.append(s); }
        pane.append(g);
      }
      const k = el('div', 'keys'); for (const f of FIELDS) { const s = el('span', 'f-' + f[0]); s.append(el('b', null, f[3])); k.append(s); } pane.append(k);
      return;
    }
    if (tab === 'league' || !key) {
      const d = svc.handle(ME, 'q', { target: 'STANDINGS' });
      pane.append(table([{ h: 'team' }, { h: 'GP', r: 1 }, { h: 'W', r: 1 }, { h: 'L', r: 1 }, { h: 'OTL', r: 1 }, { h: 'PTS', r: 1 }, { h: 'GF', r: 1 }, { h: 'GA', r: 1 }, { h: 'xGF', r: 1 }, { h: 'xGA', r: 1 }], d.standings.map((r) => [r.team, r.gp, r.w, r.l, r.otl, r.pts, r.gf, r.ga, f3(r.xgf), f3(r.xga)])));
      return;
    }
    if (tab === 'box') {
      const d = svc.handle(ME, 'q', { target: 'BOX', game: key });
      for (const [team, t] of Object.entries(d.teams)) {
        pane.append(el('h4', null, `${team}  SOG ${t.totals.SOG} · xGF ${f3(t.totals.xGF)} · CF ${t.totals.CF} · HDCF ${t.totals.HDCF}`));
        pane.append(table([{ h: '#', r: 1 }, { h: 'code' }, { h: 'player' }, { h: 'G', r: 1 }, { h: 'A', r: 1 }, { h: 'P', r: 1 }, { h: 'SOG', r: 1 }, { h: 'ixG', r: 1 }, { h: 'TOI', r: 1 }], t.skaters.filter((r) => r.toi || r.pts || r.sog).map((r) => [r.jersey, r.code, r.name, r.g, r.a, r.pts, r.sog, f3(r.ixg), mmss(r.toi)])));
      }
    } else if (tab === 'events') {
      const d = svc.handle(ME, 'q', { target: 'EVENTS', args: ['40'], game: key });
      pane.append(table([{ h: '#', r: 1 }, { h: 'clock' }, { h: 'event' }, { h: 'xG', r: 1 }, { h: 'str' }], d.events.slice().reverse().map((e) => [e.seq, `${e.period} ${e.clock}`, e.text + (e.assists.length ? '  A ' + e.assists.join(',') : ''), e.xgF ? f3(e.xgF) : '', e.strength])));
    }
  }
  let heatKey = null, heatVersion = -1;
  function renderScore() {
    const S = session.rink; const box = $('score'); box.textContent = ''; if (!svc || !S || !S.game) { $('gametag').textContent = 'no game'; return; }
    const sb = svc.ctx(S.game).actor.scoreboard(); S.sb = sb; $('gametag').textContent = `${S.game} // ${sb.final ? 'final' : 'live'}`;
    const el0 = Number((wire.nowNs() - BigInt(sb.refNs)) / 100000000n); const ds = sb.running ? Math.max(0, sb.remainingDs - el0) : sb.remainingDs;
    const clk = `${Math.floor(ds / 600)}:${String(Math.floor(ds / 10) % 60).padStart(2, '0')}`;
    box.append(el('span', null, sb.home), el('span', 'g', String(sb.score[sb.home])), el('span', 's', '–'), el('span', 'g', String(sb.score[sb.away])), el('span', null, sb.away),
      el('span', 's' + (sb.running ? ' run' : ''), sb.final ? 'FINAL' : `${sb.periodText} ${clk} ${sb.running ? '▶' : '⏸'}  ${sb.strength}${sb.started ? '' : '  · not started: START at the opening faceoff'}`));
    for (const p of sb.penalties) box.append(el('span', 'pen', `${p.team} ${p.code || ''} ${p.infraction || p.kind}`));
  }
  function refresh() {
    renderScore();
    const S = session.rink; if (!svc || !S || !S.game) { rink.set({ shots: [], heat: null }); renderPane(); return; }
    const c = svc.ctx(S.game); const evs = c.actor.state.events.filter((e) => ['S', 'G', 'M'].includes(e.stat) && e.situation !== 'SO');
    const upd = { shots: evs, home: c.game.home };
    if (heatKey !== S.game || heatVersion !== c.actor.state.version) { heatKey = S.game; heatVersion = c.actor.state.version; upd.heat = svc.handle(ME, 'q', { target: 'HEAT', flags: { packed: true, lanes: '0,4' }, game: S.game }).packed; }
    rink.set(upd); renderPane();
  }
  setInterval(() => { const S = session.rink; if (S && S.sb && S.sb.running) { renderScore(); renderPrompt(); } }, 500);

  /* ---------------- start ---------------- */
  async function boot() {
    $('h-local').textContent = LOCAL; $('h-client').textContent = CLIENT;
    write('\x1b[38;5;245mloading the league from the Photon host…\x1b[0m\n');
    await load();
    edition = await api('GET', '/api/edition');
    out.textContent = '';
    write(`\x1b[1mRINK-VT ${edition.version}\x1b[0m · ${edition.edition}\n\x1b[38;5;245m${edition.runtime} · loopback \x1b[0m\x1b[38;5;44m${LOCAL}\x1b[0m\x1b[38;5;245m, static for this laptop (${CLIENT}) · league on this computer: ${svc.registry.teams().length} teams, ${svc.registry.games().length} game${svc.registry.games().length === 1 ? '' : 's'}\x1b[0m\n`);
    for (const n of edition.notes || []) write(`\x1b[38;5;245mnote: ${n}\x1b[0m\n`);
    if (edition.conflict) write(`\x1b[38;5;214mWARNING: ${edition.conflict}\x1b[0m\n`);
    if (edition.recovered && edition.recovered.length) write(`\x1b[38;5;214mthe host dropped an unfinished last line of ${edition.recovered.join(', ')} (cut off by a stop; it had not been acknowledged)\x1b[0m\n`);
    const live = svc.registry.games().slice().reverse().find((g) => { try { return !svc.ctx(g.key).actor.state.result; } catch { return false; } });
    if (live) await cmds.get('rink').run(ctxFor(['rink', live.key], null));
    else write('\x1b[38;5;245mNo game in progress. \x1b[0m\x1b[38;5;44mrink new FOCO KELW\x1b[0m\x1b[38;5;245m starts one; \x1b[0m\x1b[38;5;44mrink sim 4\x1b[0m\x1b[38;5;245m types four synthetic games; \x1b[0m\x1b[38;5;44mhelp\x1b[0m\x1b[38;5;245m lists the rest.\x1b[0m\n');
    state('league loaded', 'ok'); renderPrompt(); refresh(); analyze(); cmd.focus({ preventScroll: true });
  }
  boot().catch((e) => { state('could not load the league', 'error'); write(`\x1b[38;5;203m${e.message}\x1b[0m\n`); });
})();
