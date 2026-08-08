// Pure catalog helpers: ordered Orange stations + search (no DOM).

/**
 * Orange stations ordered Midway → Loop by distance along Org rail.
 * Prefers railDist from snapStationsToRails; falls back to name order.
 *
 * @param {Record<string, object>|object[]} stations
 * @returns {object[]}
 */
export function orgStationsOrdered(stations) {
  const list = Array.isArray(stations) ? stations : Object.values(stations || {});
  const org = list
    .filter((s) => s?.lines?.includes('Org'))
    .map((s) => ({
      ...s,
      id: s.id,
      name: s.name || s.id,
    }));

  org.sort((a, b) => {
    const da = Number.isFinite(a.railDist) ? a.railDist : Infinity;
    const db = Number.isFinite(b.railDist) ? b.railDist : Infinity;
    if (da !== db) return da - db;
    return String(a.name).localeCompare(String(b.name));
  });
  return org;
}

/**
 * Case-insensitive station search. Prefers name prefix, then substring.
 * @param {object[]} stationList ordered list
 * @param {string} query
 * @param {number} [limit]
 */
export function searchStations(stationList, query, limit = 12) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const s of stationList || []) {
    const name = String(s.name || '').toLowerCase();
    const id = String(s.id || '');
    let score = 0;
    if (name.startsWith(q)) score = 100 - name.length;
    else if (name.includes(q)) score = 50 - name.indexOf(q);
    else if (id.includes(q)) score = 10;
    else continue;
    scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.s);
}

/** Train lines for browse UI (MVP: only Org is live). */
export const BROWSE_LINES = [
  { key: 'Org', name: 'Orange Line', live: true, color: [255, 105, 28] },
  { key: 'Red', name: 'Red Line', live: false, color: [255, 45, 72] },
  { key: 'Blue', name: 'Blue Line', live: false, color: [0, 196, 255] },
  { key: 'Brn', name: 'Brown Line', live: false, color: [210, 118, 48] },
  { key: 'G', name: 'Green Line', live: false, color: [20, 230, 95] },
  { key: 'P', name: 'Purple Line', live: false, color: [155, 78, 255] },
  { key: 'Pink', name: 'Pink Line', live: false, color: [255, 90, 185] },
  { key: 'Y', name: 'Yellow Line', live: false, color: [255, 200, 70] },
];
