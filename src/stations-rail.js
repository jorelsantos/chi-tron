// Snap station markers onto track polylines so the 3D world reads as one system.
// GTFS stop centroids often sit 5–40 m off shape geometry.

import { prepareLine, snapToLine, pointAtDist } from './tracks.js';

/**
 * Prefer a visible line the station serves; MVP prefers Org.
 * @param {string[]} stationLines
 * @param {Set<string>|string[]} preferredOrder
 */
export function pickSnapLine(stationLines, preferredOrder = ['Org', 'Red', 'Blue', 'Brn', 'G', 'P', 'Pink', 'Y']) {
  const set = new Set(stationLines || []);
  for (const k of preferredOrder) {
    if (set.has(k)) return k;
  }
  return stationLines?.[0] ?? null;
}

/**
 * @param {Record<string, {coords: number[][], cumDist: number[]}>} tracksData
 * @param {Record<string, {id: string, name: string, coords: number[], lines: string[]}>} stations
 * @param {string[]} [preferredOrder]
 * @returns {Record<string, object>} stations with coords snapped to rail; gtfsCoords preserved
 */
export function snapStationsToRails(tracksData, stations, preferredOrder) {
  const prepared = {};
  for (const [key, line] of Object.entries(tracksData || {})) {
    prepared[key] = prepareLine(line);
  }

  const out = {};
  for (const [id, s] of Object.entries(stations || {})) {
    const lineKey = pickSnapLine(s.lines, preferredOrder);
    const prep = lineKey ? prepared[lineKey] : null;
    if (!prep || !s.coords) {
      out[id] = { ...s, id: s.id || id, gtfsCoords: s.coords, coords: s.coords };
      continue;
    }
    const snap = snapToLine(prep, s.coords);
    const onRail = pointAtDist(prep, snap.dist);
    out[id] = {
      ...s,
      id: s.id || id,
      gtfsCoords: s.coords,
      coords: onRail,
      railLine: lineKey,
      railDist: snap.dist,
      railOffM: snap.offTrack,
    };
  }
  return out;
}

/**
 * Build a closed diamond ring (lon/lat) around a center, size in meters.
 * @param {[number, number]} center
 * @param {number} halfM half diagonal in meters
 */
export function diamondRing(center, halfM = 12) {
  const [lon, lat] = center;
  const dLat = halfM / 111320;
  const dLon = halfM / (111320 * Math.cos((lat * Math.PI) / 180));
  return [
    [lon, lat + dLat],
    [lon + dLon, lat],
    [lon, lat - dLat],
    [lon - dLon, lat],
    [lon, lat + dLat],
  ];
}
