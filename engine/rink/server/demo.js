'use strict';
/**
 * Synthetic demonstration data: four fictional clubs and invented rosters (no real athletes). The clubs reuse
 * the spec's example TEAM_4 codes and the spec's example surnames (Smithson, Halaburda, Gould, Vahnhänen,
 * Witczak, Barkley …) so every example in the specification types and resolves exactly as written.
 */
const CLUBS = [
  { code: 'FOCO', name_en: 'FOCO Demo Club', name_fr: 'Club démo FOCO', arena: 'Demo Arena North' },
  { code: 'KELW', name_en: 'KELW Demo Club', name_fr: 'Club démo KELW', arena: 'Demo Arena West' },
  { code: 'RIMO', name_en: 'RIMO Demo Club', name_fr: 'Club démo RIMO', arena: 'Demo Arena East' },
  { code: 'SASK', name_en: 'SASK Demo Club', name_fr: 'Club démo SASK', arena: 'Demo Arena Prairie' }
];
const FIRST = ['Declan', 'Liam', 'Noah', 'Ethan', 'Owen', 'Lucas', 'Mason', 'Logan', 'Carter', 'Nathan', 'Jacob', 'Samuel', 'Felix', 'Mathis', 'Olivier', 'Theo', 'Gabriel', 'Isaac', 'Wyatt', 'Hunter', 'Eli', 'Colton', 'Brody', 'Tristan', 'Rafael', 'Anton', 'Mikko', 'Jonas', 'Aksel', 'Viktor'];
const LAST = ['Ashdown', 'Bellerose', 'Caskey', 'Dumontier', 'Eckhart', 'Fairbrook', 'Gauvreau', 'Holloway', 'Ingersoll', 'Jardine', 'Kowalchuk', 'Lachapelle', 'Marchetti', 'Northcott', 'Ostrander', 'Pelletier', 'Quennell', 'Rasmussen', 'Saunderson', 'Thibodeau', 'Underhill', 'Vasquez', 'Whitcombe', 'Yarrow', 'Zielinski', 'Abernathy', 'Brightwell', 'Corriveau', 'Delisle', 'Emberly', 'Fenwick', 'Gallant', 'Hartigan', 'Isfeld', 'Juneau', 'Kirkland', 'Lindqvist', 'Moreau', 'Nyberg', 'Oakes', 'Prowse', 'Quigley', 'Rourke', 'Sigurdson', 'Tremblay', 'Ulrich', 'Vandermeer', 'Wallin', 'Yates', 'Zubrick', 'Archambault', 'Bourque', 'Castonguay', 'Desrosiers', 'Ellery', 'Fournier', 'Garneau', 'Hebert', 'Iverson', 'Jessup', 'Kerrigan', 'Lafleche', 'Mercier', 'Normandeau', 'Ouellette', 'Paquin', 'Racicot', 'Savard', 'Turgeon', 'Vachon'];
/* spec examples: FOCO SMIT / HALA / GOUL / VAHN, KELW WITC / BARK, RIMO CROS */
const SPEC = {
  FOCO: [['Declan', 'Smithson', 91, 'C'], ['Mason', 'Halaburda', 17, 'LW'], ['Logan', 'Gould', 22, 'RW'], ['Aksel', 'Vahnhänen', 4, 'D', true], ['Owen', 'Moreau', 8, 'D']],
  KELW: [['Jonas', 'Witczak', 19, 'D', true], ['Carter', 'Barkley', 7, 'C'], ['Hunter', 'Delisle', 44, 'D']],
  RIMO: [['Theo', 'Crosson', 87, 'C']],
  SASK: []
};
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/** Populate a Registry with the four clubs (20 skaters + 2 goalies each). Deterministic. */
function seedRegistry(reg, seasonEndYear = 2027) {
  const r = rng(20260921); let li = 0;
  for (const c of CLUBS) {
    if (reg.team(c.code)) continue;
    reg.addTeam(c);
    const used = new Set(); let overage = 0;
    const add = (first, last, jersey, pos, imp) => {
      let age = 16 + Math.floor(r() * 5);                           // 16..20 in the season's first year
      if (age === 20 && overage >= 3) age = 19;                     // the overage quota (3) holds for the whole roster
      if (age === 20) overage++;
      const y = seasonEndYear - 1 - age, m = 1 + Math.floor(r() * 12), d = 1 + Math.floor(r() * 28);
      used.add(jersey);
      return reg.addPlayer(c.code, { first, last, jersey, pos, shoots: r() < 0.62 ? 'L' : 'R', birth: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, import: !!imp });
    };
    for (const [f, l, j, p, imp] of SPEC[c.code]) add(f, l, j, p, imp);
    const want = { C: 4, LW: 4, RW: 4, D: 7, G: 2 };
    for (const p of reg.roster(c.code)) want[p.pos]--;
    for (const pos of ['C', 'LW', 'RW', 'D', 'G']) {
      while (want[pos]-- > 0) {
        let j; do { j = pos === 'G' ? [1, 30, 31, 35, 33, 29][Math.floor(r() * 6)] : 2 + Math.floor(r() * 96); } while (used.has(j));
        let last; do { last = LAST[li++ % LAST.length]; } while (reg.roster(c.code).some((p) => p.last === last));   // one surname per club
        add(FIRST[Math.floor(r() * FIRST.length)], last, j, pos, false);
      }
    }
  }
  return reg;
}
module.exports = { CLUBS, seedRegistry, rng };
