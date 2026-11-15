/**
 * RINK-VT namespace codes (spec §2): TEAM_4 franchise mnemonics and PLAYER_4 roster mnemonics.
 *   TEAM_4    four uppercase ASCII letters, packed big-endian into a uint32 key (c0<<24 | c1<<16 | c2<<8 | c3)
 *   PLAYER_4  first four letters of the normalised surname; short surnames are padded with the given name;
 *             a same-team collision takes 3 surname letters + the given-name initial, then 3 letters + the
 *             last jersey digit, then 2 letters + two jersey digits. Codes are permanent once assigned.
 *   Aliases   J + jersey (J91) or a zero-padded jersey (0091) resolve to the same player.
 *   LEAGUE_4  four uppercase letters for a league, from its name by the same rule as a TEAM_4 that is not given
 *             (mnemonicCandidates below). League and team codes share one namespace.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RinkCodes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TEAM_RE = /^[A-Z]{4}$/;
  const PLAYER_RE = /^[A-Z0-9]{3,4}$/;
  /* four-letter words of the command language: a franchise with one of these codes could never be scored */
  const RESERVED_TEAMS = ['LINE', 'UNDO', 'STOP', 'NEXT', 'GAME', 'HELP', 'EXIT', 'QUIT'];
  function ascii(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'SS').replace(/[Øø]/g, 'O').replace(/[Ææ]/g, 'AE').replace(/[Łł]/g, 'L')
      .toUpperCase().replace(/[^A-Z]/g, '');
  }
  function teamKey(code) {
    if (typeof code !== 'string' || !TEAM_RE.test(code)) throw new Error('team code must be four letters A-Z');
    return ((code.charCodeAt(0) << 24) | (code.charCodeAt(1) << 16) | (code.charCodeAt(2) << 8) | code.charCodeAt(3)) >>> 0;
  }
  function teamFromKey(k) { return String.fromCharCode((k >>> 24) & 255, (k >>> 16) & 255, (k >>> 8) & 255, k & 255); }
  /** Candidate PLAYER_4 codes in the order the spec's collision rules try them: each stage is made only when the one
   *  before it is used up (a roster rarely needs more than the first two). */
  const playerOk = (c) => PLAYER_RE.test(c) && c.length === 4 && !/^J\d/.test(c);   // J + digits is the jersey alias
  function playerStages(surname, given, jersey) {
    const s = ascii(surname), g = ascii(given), j = String(jersey === undefined || jersey === null ? '' : jersey).replace(/\D/g, '');
    return [
      () => {
        const out = [(s + g + 'XXXX').slice(0, 4)];                      // short surnames take letters of the given name (ROY + P -> ROYP)
        if (s.length >= 3) out.push(s.slice(0, 3) + (g[0] || 'X'));       // SMIT taken -> SMIR (Ryan)
        if (s.length >= 3 && j) out.push(s.slice(0, 3) + j.slice(-1));     // -> SMI9 (jersey 19)
        if (s.length >= 2 && j) out.push(s.slice(0, 2) + j.padStart(2, '0').slice(-2));
        return out;
      },
      () => { const out = []; for (let k = 0; k < 26; k++) out.push(s.slice(0, 3).padEnd(3, 'X') + String.fromCharCode(65 + k)); return out; },
      () => { const out = []; for (let a = 0; a < 26; a++) for (let b = 0; b < 26; b++) out.push(s.slice(0, 2).padEnd(2, 'X') + String.fromCharCode(65 + a, 65 + b)); return out; }
    ];
  }
  function playerCandidates(surname, given, jersey) {
    const out = []; for (const stage of playerStages(surname, given, jersey)) out.push(...stage());
    return [...new Set(out.filter(playerOk))];
  }
  function assignPlayerCode(surname, given, jersey, taken) {
    for (const stage of playerStages(surname, given, jersey)) for (const c of stage()) if (playerOk(c) && !taken.has(c)) return c;
    throw new Error('no free PLAYER_4 code for ' + surname);
  }
  /* ---- four-letter mnemonics for names: LEAGUE_4 and TEAM_4 (spec §2, "municipal identity") ----
     The words of a name give the letters. One word: its first four (EDMOnton, SASKatoon). Two words: two each
     (FOrt COllins). Three: 2 + 1 + 1 (WEstern Hockey League). Four or more: the initials of the first four
     (Quebec Maritimes Junior Hockey …). Little words (of, the, de, du, la, le, les, des, and, et, at, au, aux)
     do not count; accents, apostrophes and periods are dropped, hyphens separate words (VAl-d'OR, ROuyn-NOranda).
     A word that is too short hands its share to the others, then to `spare` (a club's nickname: SOO Greyhounds →
     SOOG), then X pads. When the first choice is taken the next ones are, in order: the other splits (3+1, 1+3;
     1+2+1, 1+1+2), the first three letters with each later letter of the name (KELO taken → KELW), with A..Z, the
     first two with AA..ZZ, and at last the first letter with AAA..ZZZ. The order is fixed, so the same names in the
     same order always get the same codes. */
  const SMALL_WORDS = new Set(['OF', 'THE', 'DE', 'DU', 'DES', 'LA', 'LE', 'LES', 'AND', 'ET', 'AT', 'AU', 'AUX']);
  function nameWords(name) {
    const all = String(name === undefined || name === null ? '' : name).split(/[\s\-‐-―/_,;:()[\]&+|]+/).map(ascii).filter(Boolean);
    const sig = all.filter((w) => !SMALL_WORDS.has(w));
    return sig.length ? sig : all;
  }
  const SPLITS = { 1: [[4]], 2: [[2, 2], [3, 1], [1, 3]], 3: [[2, 1, 1], [1, 2, 1], [1, 1, 2]], 4: [[1, 1, 1, 1]] };
  function takeLetters(words, quota, spare) {
    const used = quota.map((q, i) => Math.min(q, words[i].length)); let short = 4 - used.reduce((a, b) => a + b, 0);
    for (let i = 0; i < quota.length && short > 0; i++) { const more = Math.min(short, words[i].length - used[i]); used[i] += more; short -= more; }
    const s = quota.map((q, i) => words[i].slice(0, used[i])).join('');
    return (s + spare + 'XXXX').slice(0, 4);
  }
  /** Candidate four-letter mnemonics for a name, best first; `spare` is a second name to borrow letters from.
   *  Made in stages, each only when the one before is used up. */
  function mnemonicStages(name, spare) {
    const w = nameWords(name); if (!w.length) return [];
    const sp = nameWords(spare).join(''); const letters = w.join('') + sp;
    const first = SPLITS[Math.min(w.length, 4)].map((q) => takeLetters(w, q, sp)); const p = first[0];
    return [
      () => first,
      () => { const out = []; for (let i = 3; i < letters.length && i < 64; i++) out.push(p.slice(0, 3) + letters[i]); return out; },     // later letters of the name first (KELO taken: KELW)
      () => { const out = []; for (let k = 0; k < 26; k++) out.push(p.slice(0, 3) + String.fromCharCode(65 + k)); return out; },
      () => { const out = []; for (let a = 0; a < 26; a++) for (let b = 0; b < 26; b++) out.push(p.slice(0, 2) + String.fromCharCode(65 + a, 65 + b)); return out; },
      // a thousand clubs whose names begin alike ("Team 1" … "Team 1000") still each get a code
      () => { const out = []; for (let a = 0; a < 26; a++) for (let b = 0; b < 26; b++) for (let c = 0; c < 26; c++) out.push(p[0] + String.fromCharCode(65 + a, 65 + b, 65 + c)); return out; }
    ];
  }
  function mnemonicCandidates(name, spare) {
    const out = []; for (const stage of mnemonicStages(name, spare)) out.push(...stage());
    return [...new Set(out.filter((c) => TEAM_RE.test(c)))];
  }
  /** The first candidate that is free. `taken` is a Set of codes in use (and of words that may not be codes). */
  function assignMnemonic(name, taken, spare) {
    for (const stage of mnemonicStages(name, spare)) for (const c of stage()) if (TEAM_RE.test(c) && !taken.has(c)) return c;
    throw new Error('no free four-letter code for ' + String(name).slice(0, 40));
  }
  /** Normalise the operator's second token: SMIT, J91, 91, 0091 -> { code } or { jersey } */
  function parsePlayerToken(tok) {
    const t = String(tok || '').toUpperCase();
    if (/^J\d{1,2}$/.test(t)) return { jersey: Number(t.slice(1)), raw: t };
    if (/^\d{1,4}$/.test(t)) return { jersey: Number(t), raw: t };
    if (/^[A-Z][A-Z0-9]{2,3}$/.test(t)) return { code: t, raw: t };
    return null;
  }
  return { TEAM_RE, PLAYER_RE, RESERVED_TEAMS, ascii, teamKey, teamFromKey, playerCandidates, assignPlayerCode, parsePlayerToken, nameWords, mnemonicCandidates, assignMnemonic };
});
