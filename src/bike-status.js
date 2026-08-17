/**
 * Browse + board tone for a Divvy station.
 * @param {{ classic?: number, ebikes?: number, docks?: number, renting?: boolean }} st
 * @returns {{ text: string, tone: 'ok'|'bad'|'dock'|'dim' }[]}
 */
export function bikeStatusMeta(st) {
  if (st?.renting === false) return [{ text: 'NOT RENTING', tone: 'bad' }];
  const bikes = (st?.classic || 0) + (st?.ebikes || 0);
  const docks = Number.isFinite(st?.docks) ? st.docks : 0;
  return [
    { text: `${bikes} BIKES`, tone: bikes > 0 ? 'ok' : 'bad' },
    { text: '·', tone: 'dim' },
    { text: `${docks} DOCKS`, tone: docks > 0 ? 'dock' : 'bad' },
  ];
}

export function bikeCountTone(n) {
  return Number(n) > 0 ? 'ok' : 'bad';
}

export function dockCountTone(n) {
  return Number(n) > 0 ? 'dock' : 'bad';
}
