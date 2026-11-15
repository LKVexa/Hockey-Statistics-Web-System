'use strict';
/**
 * HK001 input codes — HKI-001 … HKI-109.
 * Every input field the HK001 equations read gets a permanent code, a mnemonic (the field name HK001 itself
 * uses), a label, a unit, a scope and a family, plus the rule by which the RINK-VT ledger produces it
 * (`rink`): which terminal stat tokens are counted, or which declared derivation is applied.
 * Codes follow HK001's own field order (engine.go BaselineValues / docs/INPUT_FIELDS.md), so HKI-001 is GP.
 *
 * Derivation classes (provenance shown on every value):
 *   TOKEN      counted directly from tri-token events            (e.g. G, S, M, B, TK, GV, FOW/FOL, ZE, ZX, FC, OMR)
 *   STATE      read from the game-state actor (clock, stints, score, penalties)
 *   CLASS      a declared, location-based classification of attempts (RINKVT-DANGER-v1)
 *   INFER      a declared sequence rule with a fixed window (documented per field)
 *   RESULT     from final game states (wins, OT, one-goal games …)
 *   GOALIE     per-goalie-game aggregation (starts, quality starts …)
 *   PLAYER     the case's featured player
 *   OPPONENT   the opponents' own derived inputs (games-weighted)
 *   LEAGUE     pooled over every team in scope
 * Anything the ledger cannot observe is filled by HK001's own baseline overlay, pro-rated to the observed games
 * where it is a count, and the receipt lists it under defaulted_fields.
 */
const I = [];
const add = (field, label, unit, scope, family, cls, tokens, rink) => I.push({ field, label, unit, scope, family, cls, tokens, rink });

add('GP', 'Games played', 'games', 'team', 'STANDINGS', 'STATE', [], 'games in scope in which the team is home or away and at least one event was logged');
add('G', 'Goals for', 'goals', 'team', 'SCORING', 'TOKEN', ['G'], 'count of G by the team (shootout goals excluded)');
add('GA', 'Goals against', 'goals', 'team', 'SCORING', 'TOKEN', ['G'], 'count of G by the opponent (shootout goals excluded)');
add('A', 'Assists (team total)', 'assists', 'team', 'SCORING', 'TOKEN', ['A', 'A1', 'A2'], 'assists chained to the team\'s goals');
add('PTS', 'Scoring points (goals + assists)', 'points', 'team', 'SCORING', 'TOKEN', ['G', 'A', 'A1', 'A2'], 'G + A');
add('SOG', 'Shots on goal for', 'shots', 'team', 'SHOTS', 'TOKEN', ['S', 'G'], 'S + G by the team (shootout attempts excluded)');
add('SAT', 'Shot attempts for (all situations)', 'attempts', 'team', 'SHOTS', 'TOKEN', ['S', 'G', 'M', 'B'], 'S + G + M by the team + B logged by the opponent (blocked team attempts)');
add('USAT', 'Unblocked shot attempts for', 'attempts', 'team', 'SHOTS', 'TOKEN', ['S', 'G', 'M'], 'S + G + M by the team');
add('MISSED', 'Missed shot attempts', 'attempts', 'team', 'SHOTS', 'TOKEN', ['M'], 'M by the team');
add('BLOCKED_FOR', 'Team attempts blocked by the opponent', 'attempts', 'team', 'SHOTS', 'TOKEN', ['B'], 'B logged by the opponent');
add('HDCF', 'High-danger chances for', 'chances', 'team', 'CHANCES', 'CLASS', ['S', 'G', 'M'], 'unblocked team attempts with known location classed HIGH by RINKVT-DANGER-v1');
add('SCF', 'Scoring chances for', 'chances', 'team', 'CHANCES', 'CLASS', ['S', 'G', 'M'], 'unblocked team attempts with known location classed HIGH or MEDIUM');
add('PRIMARY_A', 'Primary assists', 'assists', 'team', 'SCORING', 'TOKEN', ['A', 'A1'], 'first assist bound to each team goal');
add('SECONDARY_A', 'Secondary assists', 'assists', 'team', 'SCORING', 'TOKEN', ['A', 'A2'], 'second assist bound to each team goal');
add('EV_G', 'Even-strength goals', 'goals', 'team', 'SCORING', 'STATE', ['G'], 'team goals scored with equal skaters (5v5, 4v4, 3v3)');
add('PPG', 'Power-play goals', 'goals', 'team', 'SPECIAL', 'STATE', ['G'], 'team goals scored with more skaters than the opponent (empty-net extra attacker excluded)');
add('SHG', 'Short-handed goals', 'goals', 'team', 'SPECIAL', 'STATE', ['G'], 'team goals scored with fewer skaters than the opponent');
add('ENG', 'Empty-net goals', 'goals', 'team', 'SCORING', 'STATE', ['G'], 'team goals scored while the opponent goalie was out of the crease');
add('REBOUNDS_FOR', 'Rebound attempts created', 'attempts', 'team', 'SHOTS', 'INFER', ['S', 'G', 'M'], 'team attempts within 3.0 s of a previous team S/M with no stoppage between (or flagged /R)');
add('RUSH_ATTEMPTS', 'Rush attempts', 'attempts', 'team', 'TRANSITION', 'INFER', ['S', 'G', 'M', 'ZE', 'TK'], 'team attempts flagged /U, or within 4.0 s of a team ZE/TK/ZX outside the offensive zone');
add('TAKEAWAYS', 'Takeaways', 'events', 'team', 'TRANSITION', 'TOKEN', ['TK'], 'TK by the team');
add('GIVEAWAYS', 'Giveaways', 'events', 'team', 'TRANSITION', 'TOKEN', ['GV'], 'GV by the team');
add('OZ_STARTS', 'Offensive-zone faceoff starts', 'faceoffs', 'team', 'FACEOFF', 'TOKEN', ['FOW', 'FOL'], 'faceoffs taken in the team\'s offensive zone (/O, or inferred from the stoppage)');
add('DZ_STARTS', 'Defensive-zone faceoff starts', 'faceoffs', 'team', 'FACEOFF', 'TOKEN', ['FOW', 'FOL'], 'faceoffs taken in the team\'s defensive zone (/D, or inferred from the stoppage)');
add('CF', 'Corsi for', 'attempts', 'team', 'POSSESSION', 'TOKEN', ['S', 'G', 'M', 'B'], 'equal to SAT (HK001 baseline convention CF = SAT)');
add('CA', 'Corsi against', 'attempts', 'team', 'POSSESSION', 'TOKEN', ['S', 'G', 'M', 'B'], 'opponent SAT');
add('FF', 'Fenwick for', 'attempts', 'team', 'POSSESSION', 'TOKEN', ['S', 'G', 'M'], 'equal to USAT');
add('FA', 'Fenwick against', 'attempts', 'team', 'POSSESSION', 'TOKEN', ['S', 'G', 'M'], 'opponent USAT');
add('SA', 'Shots on goal against', 'shots', 'team', 'SHOTS', 'TOKEN', ['S', 'G'], 'opponent SOG');
add('xGF', 'Expected goals for', 'xG', 'team', 'CHANCES', 'STATE', ['S', 'G', 'M'], 'sum of flurry-adjusted xG of team attempts (spec log-odds model)');
add('xGA', 'Expected goals against', 'xG', 'team', 'CHANCES', 'STATE', ['S', 'G', 'M'], 'opponent xGF');
add('HDCA', 'High-danger chances against', 'chances', 'team', 'CHANCES', 'CLASS', ['S', 'G', 'M'], 'opponent HDCF');
add('SCA', 'Scoring chances against', 'chances', 'team', 'CHANCES', 'CLASS', ['S', 'G', 'M'], 'opponent SCF');
add('SCORE_ADJ_CF', 'Score-adjusted Corsi for', 'attempts', 'team', 'POSSESSION', 'LEAGUE', ['S', 'G', 'M', 'B'], 'team attempts weighted by 0.5 / league Corsi share of the score state (shrunk to 0.5 with 50 pseudo-attempts)');
add('SCORE_ADJ_CA', 'Score-adjusted Corsi against', 'attempts', 'team', 'POSSESSION', 'LEAGUE', ['S', 'G', 'M', 'B'], 'opponent attempts weighted the same way');
add('CLOSE_CF', 'Close-state Corsi for', 'attempts', 'team', 'POSSESSION', 'STATE', ['S', 'G', 'M', 'B'], 'team attempts while within one goal in periods 1-2, or tied in period 3 and overtime');
add('CLOSE_CA', 'Close-state Corsi against', 'attempts', 'team', 'POSSESSION', 'STATE', ['S', 'G', 'M', 'B'], 'opponent attempts in the same states');
add('EV_TOI', 'Even-strength time on ice', 'minutes', 'team', 'TIME', 'STATE', ['IN', 'OUT', 'P2'], 'stint minutes with equal skaters');
add('TEAM_TOI', 'Team time on ice', 'minutes', 'team', 'TIME', 'STATE', [], 'game minutes elapsed on the clock');
add('LEAGUE_SOG_PER_GAME', 'League shots on goal per team-game', 'shots/game', 'league', 'LEAGUE', 'LEAGUE', ['S', 'G'], 'all teams\' SOG / team-games in scope (baseline 30.2 below 4 team-games)');
add('BLOCKS', 'Shots blocked by the team', 'blocks', 'team', 'SHOTS', 'TOKEN', ['B'], 'B by the team');
add('ODD_MAN_RUSH_FOR', 'Odd-man rushes for', 'rushes', 'team', 'TRANSITION', 'TOKEN', ['OMR'], 'OMR by the team');
add('ODD_MAN_RUSH_AGAINST', 'Odd-man rushes against', 'rushes', 'team', 'TRANSITION', 'TOKEN', ['OMR'], 'OMR by the opponent');
add('EXITS', 'Successful zone exits', 'exits', 'team', 'TRANSITION', 'TOKEN', ['ZX'], 'ZX, ZX/C and ZX/D by the team');
add('EXIT_ATTEMPTS', 'Zone exit attempts', 'exits', 'team', 'TRANSITION', 'TOKEN', ['ZX'], 'every ZX by the team, including ZX/F (failed)');
add('CONTROLLED_EXITS', 'Controlled zone exits', 'exits', 'team', 'TRANSITION', 'TOKEN', ['ZX'], 'ZX/C by the team');
add('PK_SA', 'Shots against while short-handed', 'shots', 'team', 'SPECIAL', 'STATE', ['S', 'G'], 'opponent SOG while the team has fewer skaters');
add('PK_MIN', 'Short-handed minutes', 'minutes', 'team', 'SPECIAL', 'STATE', ['P2', 'P4', 'P5'], 'stint minutes with fewer skaters');
add('REBOUNDS_AGAINST', 'Rebound attempts conceded', 'attempts', 'team', 'SHOTS', 'INFER', ['S', 'G', 'M'], 'opponent REBOUNDS_FOR');
add('SV', 'Saves', 'saves', 'goalie', 'GOALIE', 'GOALIE', ['S'], 'opponent S faced by the team\'s goalies');
add('SA_G', 'Shots against (goalies)', 'shots', 'goalie', 'GOALIE', 'GOALIE', ['S', 'G'], 'opponent SOG with a team goalie in the crease');
add('GA_G', 'Goals against (goalies)', 'goals', 'goalie', 'GOALIE', 'GOALIE', ['G'], 'opponent goals with a team goalie in the crease');
add('MIN_G', 'Goalie minutes', 'minutes', 'goalie', 'GOALIE', 'GOALIE', ['IN', 'OUT'], 'minutes with a team goalie in the crease');
add('LEAGUE_SV_PCT', 'League save percentage', 'ratio', 'league', 'LEAGUE', 'LEAGUE', ['S', 'G'], 'all saves / all goalie shots against in scope (baseline 0.905 below 200 shots)');
add('xGA_G', 'Expected goals against (goalies)', 'xG', 'goalie', 'GOALIE', 'GOALIE', ['S', 'G', 'M'], 'flurry-adjusted xG of opponent attempts with a team goalie in the crease');
add('HDSV', 'High-danger saves', 'saves', 'goalie', 'GOALIE', 'CLASS', ['S'], 'saves on HIGH shots');
add('HDSA', 'High-danger shots against', 'shots', 'goalie', 'GOALIE', 'CLASS', ['S', 'G'], 'HIGH shots on goal faced');
add('MDSV', 'Medium-danger saves', 'saves', 'goalie', 'GOALIE', 'CLASS', ['S'], 'saves on MEDIUM shots');
add('MDSA', 'Medium-danger shots against', 'shots', 'goalie', 'GOALIE', 'CLASS', ['S', 'G'], 'MEDIUM shots on goal faced');
add('LDSV', 'Low-danger saves', 'saves', 'goalie', 'GOALIE', 'CLASS', ['S'], 'saves on LOW shots');
add('LDSA', 'Low-danger shots against', 'shots', 'goalie', 'GOALIE', 'CLASS', ['S', 'G'], 'LOW shots on goal faced');
add('QS', 'Quality starts', 'starts', 'goalie', 'GOALIE', 'GOALIE', ['G', 'IN'], 'starts with save % >= league save %, or >= .885 on 20 shots or fewer');
add('GS', 'Goalie starts', 'starts', 'goalie', 'GOALIE', 'GOALIE', ['IN'], 'games with a team goalie in the crease at the first logged event');
add('RBS', 'Really bad starts', 'starts', 'goalie', 'GOALIE', 'GOALIE', ['G', 'IN'], 'starts with save % below .850');
add('REBOUNDS_ALLOWED_GOALIE', 'Rebounds allowed by the goalie', 'rebounds', 'goalie', 'GOALIE', 'INFER', ['S', 'G', 'M'], 'opponent rebound attempts whose previous attempt was saved (S)');
add('SO', 'Shutouts', 'games', 'goalie', 'GOALIE', 'GOALIE', ['G'], 'completed games in which the starting goalie allowed no goal');
add('CONTROLLED_ENTRIES', 'Controlled zone entries', 'entries', 'team', 'TRANSITION', 'TOKEN', ['ZE'], 'ZE/C by the team');
add('ENTRIES', 'Successful zone entries', 'entries', 'team', 'TRANSITION', 'TOKEN', ['ZE'], 'ZE, ZE/C and ZE/D by the team');
add('ENTRY_ATTEMPTS', 'Zone entry attempts', 'entries', 'team', 'TRANSITION', 'TOKEN', ['ZE'], 'every ZE by the team, including ZE/F (failed)');
add('RETAINED_ENTRIES', 'Controlled entries that kept possession', 'entries', 'team', 'TRANSITION', 'INFER', ['ZE', 'GV', 'TK'], 'ZE/C not followed within 5.0 s by a team GV or an opponent TK');
add('FORECHECK_ATTEMPTS', 'Forecheck attempts', 'events', 'team', 'TRANSITION', 'TOKEN', ['FC'], 'FC by the team');
add('TURNOVER_TRANSITIONS', 'Transitions ending in a turnover', 'events', 'team', 'TRANSITION', 'INFER', ['ZE', 'ZX', 'GV'], 'ZE/F + ZX/F + team GV within 5.0 s after a successful team ZE/ZX');
add('ENTRY_SHOTS', 'Entries leading to a shot attempt', 'entries', 'team', 'TRANSITION', 'INFER', ['ZE', 'S', 'G', 'M'], 'successful team ZE followed within 10.0 s by a team attempt');
add('POINTS', 'Standings points', 'points', 'team', 'STANDINGS', 'RESULT', [], '2 per win, 1 per overtime or shootout loss, 1 per tie');
add('W', 'Wins', 'games', 'team', 'STANDINGS', 'RESULT', [], 'completed games won');
add('RW', 'Regulation wins', 'games', 'team', 'STANDINGS', 'RESULT', [], 'wins decided in periods 1-3');
add('PP_OPP', 'Power-play opportunities', 'opportunities', 'team', 'SPECIAL', 'STATE', ['P2', 'P4', 'P5'], 'opponent penalties that gave the team more skaters');
add('PPGA', 'Power-play goals against', 'goals', 'team', 'SPECIAL', 'STATE', ['G'], 'opponent PPG');
add('PK_OPP', 'Times short-handed', 'opportunities', 'team', 'SPECIAL', 'STATE', ['P2', 'P4', 'P5'], 'team penalties that gave the opponent more skaters');
add('FO_WON', 'Faceoffs won', 'faceoffs', 'team', 'FACEOFF', 'TOKEN', ['FOW', 'FOL'], 'FOW by the team + FOL by the opponent (one per faceoff)');
add('FO_TAKEN', 'Faceoffs taken', 'faceoffs', 'team', 'FACEOFF', 'TOKEN', ['FOW', 'FOL'], 'faceoffs involving the team');
add('PEN_DRAWN', 'Penalties drawn', 'penalties', 'team', 'DISCIPLINE', 'TOKEN', ['P2', 'P4', 'P5', 'P10', 'P20'], 'penalties logged against the opponent');
add('PEN_TAKEN', 'Penalties taken', 'penalties', 'team', 'DISCIPLINE', 'TOKEN', ['P2', 'P4', 'P5', 'P10', 'P20'], 'penalties logged against the team');
add('HOME_G', 'Goals scored at home', 'goals', 'team', 'CONTEXT', 'STATE', ['G'], 'team goals in games where the team is home');
add('COMEBACK_WINS', 'Comeback wins', 'games', 'team', 'STANDINGS', 'RESULT', [], 'wins in which the team trailed at some point');
add('ONE_GOAL_WINS', 'One-goal wins', 'games', 'team', 'STANDINGS', 'RESULT', [], 'wins by exactly one goal (shootout wins count)');
add('FIRST_PERIOD_G', 'First-period goals', 'goals', 'team', 'CONTEXT', 'STATE', ['G'], 'team goals in period 1');
add('SECOND_PERIOD_G', 'Second-period goals', 'goals', 'team', 'CONTEXT', 'STATE', ['G'], 'team goals in period 2');
add('THIRD_PERIOD_G', 'Third-period goals', 'goals', 'team', 'CONTEXT', 'STATE', ['G'], 'team goals in period 3');
add('OT_WINS', 'Overtime wins', 'games', 'team', 'STANDINGS', 'RESULT', [], 'wins decided in overtime');
add('SO_WINS', 'Shootout wins', 'games', 'team', 'STANDINGS', 'RESULT', [], 'wins decided in the shootout');
add('OT_GAMES', 'Games ending in overtime', 'games', 'team', 'STANDINGS', 'RESULT', [], 'completed games decided in overtime');
add('SO_GAMES', 'Games ending in a shootout', 'games', 'team', 'STANDINGS', 'RESULT', [], 'completed games decided in a shootout');
add('ONE_GOAL_GAMES', 'One-goal games', 'games', 'team', 'STANDINGS', 'RESULT', [], 'completed games decided by one goal');
add('PLAYER_GP', 'Featured player: games played', 'games', 'player', 'PLAYER', 'PLAYER', ['IN', 'G', 'S'], 'games in which the featured player appears');
add('PLAYER_G', 'Featured player: goals', 'goals', 'player', 'PLAYER', 'PLAYER', ['G'], 'G by the featured player');
add('PLAYER_A', 'Featured player: assists', 'assists', 'player', 'PLAYER', 'PLAYER', ['A', 'A1', 'A2'], 'assists by the featured player');
add('PLAYER_PTS', 'Featured player: points', 'points', 'player', 'PLAYER', 'PLAYER', ['G', 'A'], 'goals + assists');
add('PLAYER_xG', 'Featured player: individual xG', 'xG', 'player', 'PLAYER', 'PLAYER', ['S', 'G', 'M'], 'flurry-adjusted xG of the player\'s attempts');
add('PLAYER_ONICE_GF', 'Featured player: on-ice goals for', 'goals', 'player', 'PLAYER', 'PLAYER', ['G', 'IN', 'OUT'], 'team goals while the player is on the ice (shift-tracked games)');
add('PLAYER_ONICE_GA', 'Featured player: on-ice goals against', 'goals', 'player', 'PLAYER', 'PLAYER', ['G', 'IN', 'OUT'], 'opponent goals while the player is on the ice');
add('PLAYER_TOI', 'Featured player: time on ice', 'minutes', 'player', 'PLAYER', 'PLAYER', ['IN', 'OUT', 'LINE'], 'stint minutes with the player on the ice');
add('PLAYER_SOG', 'Featured player: shots on goal', 'shots', 'player', 'PLAYER', 'PLAYER', ['S', 'G'], 'S + G by the player');
add('OPP_STRENGTH', 'Opponent strength composite', 'index', 'opponent', 'OPPONENT', 'OPPONENT', [], 'opponents\' TEAM-012 (HK001 team strength composite) on their own derived inputs, games-weighted');
add('OPP_GFPG', 'Opponent goals for per game', 'goals/game', 'opponent', 'OPPONENT', 'OPPONENT', ['G'], 'opponents\' G / GP, games-weighted');
add('OPP_GAPG', 'Opponent goals against per game', 'goals/game', 'opponent', 'OPPONENT', 'OPPONENT', ['G'], 'opponents\' GA / GP, games-weighted');
add('OPP_XGF_PCT', 'Opponent expected-goals share', 'ratio', 'opponent', 'OPPONENT', 'OPPONENT', ['S', 'G', 'M'], 'opponents\' xGF / (xGF + xGA)');
add('OPP_CF_PCT', 'Opponent Corsi share', 'ratio', 'opponent', 'OPPONENT', 'OPPONENT', ['S', 'G', 'M', 'B'], 'opponents\' CF / (CF + CA)');
add('OPP_SV_PCT', 'Opponent save percentage', 'ratio', 'opponent', 'OPPONENT', 'OPPONENT', ['S', 'G'], 'opponents\' SV / SA_G');

const INPUTS = I.map((x, i) => Object.freeze({ code: 'HKI-' + String(i + 1).padStart(3, '0'), ...x }));
const byField = new Map(INPUTS.map((x) => [x.field, x]));
const byCode = new Map(INPUTS.map((x) => [x.code, x]));
/** Count fields are pro-rated by games when defaulted; ratios, league constants and opponent profiles are not. */
const PRORATE = new Set(INPUTS.filter((x) => !['ratio', 'index', 'goals/game', 'shots/game'].includes(x.unit) && x.scope !== 'league' && x.scope !== 'opponent').map((x) => x.field));
function resolve(token) {
  if (!token) return null;
  const t = String(token).trim();
  if (byCode.has(t.toUpperCase())) return byCode.get(t.toUpperCase());
  if (byField.has(t)) return byField.get(t);
  for (const x of INPUTS) if (x.field.toUpperCase() === t.toUpperCase()) return x;
  return null;
}
module.exports = { INPUTS, byField, byCode, resolve, PRORATE };
