// Line config factory + station catalog helpers (no DOM).

/**
 * Single source of truth for L lines.
 * `live` gates map positions, browse list, and search union.
 * Flip `live` per line to gate map, browse, and search.
 */
export const LINE_DEFS = [
  { key: 'Red', rt: 'red', name: 'Red Line', live: true, color: [255, 45, 72] },
  { key: 'Blue', rt: 'blue', name: 'Blue Line', live: true, color: [0, 196, 255] },
  // Vivid CTA-ish brown (not copper/orange — distinct from Org [255,105,28])
  { key: 'Brn', rt: 'brn', name: 'Brown Line', live: true, color: [155, 82, 32] },
  { key: 'G', rt: 'g', name: 'Green Line', live: true, color: [20, 230, 95] },
  { key: 'Org', rt: 'org', name: 'Orange Line', live: true, color: [255, 105, 28] },
  { key: 'P', rt: 'p', name: 'Purple Line', live: true, color: [155, 78, 255] },
  { key: 'Pink', rt: 'pink', name: 'Pink Line', live: true, color: [255, 90, 185] },
  { key: 'Y', rt: 'y', name: 'Yellow Line', live: true, color: [255, 200, 70] },
];

/** Browse UI list — only live lines shown (hide non-live until flipped). */
export function browseLinesLive() {
  return LINE_DEFS.filter((l) => l.live);
}

/** @deprecated use browseLinesLive — kept name for call sites */
export const BROWSE_LINES = LINE_DEFS;

export function liveLineKeys() {
  return LINE_DEFS.filter((l) => l.live).map((l) => l.key);
}

/** CTA ttpositions `rt` codes for live lines (comma-joined by TrainEngine). */
export function liveRouteCodes() {
  return LINE_DEFS.filter((l) => l.live).map((l) => l.rt);
}

export function lineDefByKey(key) {
  return LINE_DEFS.find((l) => l.key === key) || null;
}

export function lineDefByRt(rt) {
  const code = String(rt || '').toLowerCase();
  return LINE_DEFS.find((l) => l.rt === code) || null;
}

export function lineColor(key) {
  return lineDefByKey(key)?.color || [180, 180, 200];
}

/**
 * Stations on a line ordered along the rail (railDist from snap).
 * Falls back to name order when railDist missing.
 *
 * @param {Record<string, object>|object[]} stations
 * @param {string} lineKey e.g. 'Org' | 'Red'
 * @returns {object[]}
 */
export function stationsOrdered(stations, lineKey) {
  const list = Array.isArray(stations) ? stations : Object.values(stations || {});
  const key = String(lineKey || '');
  const onLine = list
    .filter((s) => s?.lines?.includes(key))
    .map((s) => ({
      ...s,
      id: s.id,
      name: s.name || s.id,
    }));

  onLine.sort((a, b) => {
    const da = Number.isFinite(a.railDist) ? a.railDist : Infinity;
    const db = Number.isFinite(b.railDist) ? b.railDist : Infinity;
    if (da !== db) return da - db;
    return String(a.name).localeCompare(String(b.name));
  });
  return onLine;
}

/** @deprecated prefer stationsOrdered(stations, 'Org') */
export function orgStationsOrdered(stations) {
  return stationsOrdered(stations, 'Org');
}

/**
 * Union of stations on any live line (for search / nearest).
 * @param {Record<string, object>|object[]} stations
 */
export function liveStationsUnion(stations) {
  const list = Array.isArray(stations) ? stations : Object.values(stations || {});
  const live = new Set(liveLineKeys());
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s?.id || seen.has(s.id)) continue;
    const lines = s.lines || [];
    if (!lines.some((k) => live.has(k))) continue;
    seen.add(s.id);
    out.push(s);
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
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

/** Clean station title for board header. */
export function cleanStationName(name) {
  return String(name || '')
    .replace(/\s*\((Orange|Red|Blue|Brown|Green|Purple|Pink|Yellow)\)\s*/gi, '')
    .trim();
}
