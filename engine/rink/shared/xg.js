/**
 * Spatiotemporal expected goals (spec §5.1) and the RINK-VT danger classes.
 * Canonical rink: 200 × 85 ft, centre ice (0,0), the acting team attacks the goal line at x = +89, posts at (89, ±3).
 *
 *   d = √(dx² + y²), dx = max(0.5, 89 − x)          θ = atan2(|y|, dx)
 *   φ = arccos((d_L² + d_R² − 36) / (2 d_L d_R))     apparent open-net angle between the posts
 *   logit = −1.35 − .048 d − .022 θ° + .031 φ° + .85·rebound + .55·rush + 1.10·royal-road
 *           + .35·[TIP|SNAP] − .25·[SLAP] + .28·[shooter strength ∈ {5v4, 5v3, 4v3}]
 *   xG = σ(logit), rounded to 4 dp as in the spec's reference engine
 *   flurry:  x̃G_1 = xG_1,  x̃G_k = xG_k · Π_{j<k} (1 − xG_j)  for attempts ≤ 3.0 s apart without a stoppage
 * Danger classes (RINKVT-DANGER-v1, declared): HIGH = inner slot (69 ≤ x ≤ 89, |y| ≤ 9) or rebound or royal road;
 * MEDIUM = otherwise d ≤ 35 ft and θ ≤ 45°; LOW = everything else with a known location; null when the location is
 * only the default prior and no flag says otherwise.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RinkXg = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const GOAL_X = 89, POST = 3;
  const DEG = 180 / Math.PI;
  /* Zone-macro centroids (spec ZONE_CENTROID_PRIORS) and the default location when nothing else is known. */
  const ZONES = { 1: [80, 0], 2: [69, 0], 3: [72, -18], 4: [72, 18], 5: [56, -24], 6: [56, 24], 7: [38, -28], 8: [38, 0], 9: [38, 28] };
  const ZONE_NAMES = { 1: 'low slot / crease', 2: 'high slot', 3: 'left circle', 4: 'right circle', 5: 'left high flank', 6: 'right high flank', 7: 'left point', 8: 'centre point', 9: 'right point' };
  const PRIOR = [71, 0];
  const SHOT_NAMES = { W: 'WRIST', S: 'SLAP', P: 'SNAP', B: 'BACKHAND', T: 'TIP' };
  const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 10000) / 10000;
  function geometry(x, y) {
    const dx = Math.max(0.5, GOAL_X - x);
    const dist = Math.sqrt(dx * dx + y * y);
    const angle = Math.atan2(Math.abs(y), dx) * DEG;
    const dl = Math.sqrt(dx * dx + (y + POST) ** 2), dr = Math.sqrt(dx * dx + (y - POST) ** 2);
    const cosPhi = Math.max(-1, Math.min(1, (dl * dl + dr * dr - 36) / Math.max(1e-6, 2 * dl * dr)));
    return { dist, angle, phi: Math.acos(cosPhi) * DEG };
  }
  function xg({ x, y, shotType, rebound, rush, royal, strength }) {
    const g = geometry(x, y);
    const st = shotType || 'WRIST';
    const logit = -1.35 - 0.048 * g.dist - 0.022 * g.angle + 0.031 * g.phi + (rebound ? 0.85 : 0) + (rush ? 0.55 : 0) + (royal ? 1.10 : 0)
      + (st === 'TIP' || st === 'SNAP' ? 0.35 : 0) + (st === 'SLAP' ? -0.25 : 0) + (['5v4', '5v3', '4v3'].includes(strength) ? 0.28 : 0);
    return { dist: r2(g.dist), angle: r2(g.angle), phi: r2(g.phi), logit, xg: r4(1 / (1 + Math.exp(-logit))) };
  }
  function danger({ x, y, coordSource, rebound, royal }) {
    if (rebound || royal) return 'HIGH';
    if (!coordSource || coordSource === 'prior') return null;
    if (x >= 69 && x <= GOAL_X && Math.abs(y) <= 9) return 'HIGH';
    const g = geometry(x, y);
    if (g.dist <= 35 && g.angle <= 45) return 'MEDIUM';
    return 'LOW';
  }
  /** Shot-map location of an attempt toward the net at +89 → which half of the full rink drawing (home attacks right). */
  const toRink = (x, y, homeAttacking) => (homeAttacking ? { x, y } : { x: -x, y: -y });
  return { GOAL_X, ZONES, ZONE_NAMES, PRIOR, SHOT_NAMES, geometry, xg, danger, toRink };
});
