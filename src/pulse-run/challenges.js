// Pulse Run challenge cards. Station IDs are source of truth; names are labels.
// startDist/goalDist are baked at runtime from tracks.json (out-and-back safe).

/** @typedef {{
 *   id: string,
 *   line: string,
 *   startId: string,
 *   goalId: string,
 *   startName: string,
 *   goalName: string,
 *   label: string,
 *   parTimeS: number,
 *   timeLimitS: number,
 * }} ChallengeCard */

/** v1 ship set — 3 cards (two Red + Blue). */
export const CHALLENGES = /** @type {ChallengeCard[]} */ ([
  {
    id: 'red-north-short',
    line: 'Red',
    startId: '41320',
    goalId: '41220',
    startName: 'Belmont',
    goalName: 'Fullerton',
    label: 'RED · NORTH SHORT',
    // ~1.6 km @ 45 m/s ≈ 36s cruise
    parTimeS: 40,
    timeLimitS: 60,
  },
  {
    id: 'red-south-loop',
    line: 'Red',
    startId: '41220',
    goalId: '41400',
    startName: 'Fullerton',
    goalName: 'Roosevelt',
    label: 'RED · SOUTH TO LOOP',
    // ~7.8 km @ 45 m/s ≈ 174s; boost shortens
    parTimeS: 160,
    timeLimitS: 240,
  },
  {
    id: 'blue-ohare-approach',
    line: 'Blue',
    startId: '40820',
    goalId: '41280',
    startName: 'Rosemont',
    goalName: 'Jefferson Park',
    label: 'BLUE · O\'HARE BRANCH',
    // ~8.6 km @ 45 m/s ≈ 190s
    parTimeS: 175,
    timeLimitS: 265,
  },
]);

export function getChallenge(id) {
  return CHALLENGES.find((c) => c.id === id) ?? null;
}

export const LINE_EMOJI = {
  Red: '🔴',
  Blue: '🔵',
  Brn: '🟤',
  G: '🟢',
  Org: '🟠',
  P: '🟣',
  Pink: '🩷',
  Y: '🟡',
};
