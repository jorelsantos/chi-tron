// Snap station markers onto track polylines so the 3D world reads as one system.
// GTFS stop centroids often sit 5–40 m off shape geometry.

import { prepareLine, snapToLine, pointAtDist, bearingDeg } from './tracks.js';

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
function snapOnto(prep, coords) {
  const snap = snapToLine(prep, coords);
  const onRail = pointAtDist(prep, snap.dist);
  const ahead = pointAtDist(prep, snap.dist + 12);
  const behind = pointAtDist(prep, Math.max(0, snap.dist - 12));
  return {
    coords: onRail,
    heading: bearingDeg(behind, ahead),
    dist: snap.dist,
    offTrack: snap.offTrack,
  };
}

export function snapStationsToRails(tracksData, stations, preferredOrder) {
  const prepared = {};
  for (const [key, line] of Object.entries(tracksData || {})) {
    prepared[key] = prepareLine(line);
  }

  const out = {};
  for (const [id, s] of Object.entries(stations || {})) {
    const rails = {};
    for (const key of s.lines || []) {
      const prep = prepared[key];
      if (prep && s.coords) rails[key] = snapOnto(prep, s.coords);
    }
    const lineKey = pickSnapLine(s.lines, preferredOrder);
    const primary = (lineKey && rails[lineKey]) || Object.values(rails)[0] || null;
    out[id] = {
      ...s,
      id: s.id || id,
      gtfsCoords: s.coords,
      coords: primary?.coords || s.coords,
      railLine: lineKey,
      railDist: primary?.dist,
      railOffM: primary?.offTrack,
      railHeading: primary?.heading,
      rails,
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
