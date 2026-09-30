const RANK = {
  lost: 0,
  disabled: 0,
  hold: 1,
  mock: 2,
  boot: 3,
  live: 4,
};

const LABEL = {
  0: 'OFF',
  1: 'HOLD',
  2: 'SIM',
  3: 'BOOT',
  4: 'LIVE',
};

export function feedBadge(trainState, busState) {
  const trainRank = RANK[trainState] ?? 3;
  const busRank = RANK[busState] ?? 3;
  const worst = Math.min(trainRank, busRank);
  return LABEL[worst];
}
