// Loop ribbon geometry: schematic perpendicular offsets inside the elevated
// Loop bbox. Painted rails and (at draw time) elevated trains share this shift.

import { mPerDegLon, M_PER_DEG_LAT } from './tracks.js';

/** Elevated Loop + short approaches. */
export const LOOP_BBOX = {
  west: -87.645,
  south: 41.868,
  east: -87.615,
  north: 41.892,
};

/** State & Madison — outward radial reference. */
export const LOOP_CENTER = [-87.6278, 41.8819];

/** Elevated harp only: Pink (in) → Purple (out).
 *  Red / Blue / Yellow are subway or off-Loop — they stay on true geometry
 *  so live trains sit on their own rail. */
export const LOOP_SLOTS = {
  Pink: 0,
  Org: 1,
  G: 2,
  Brn: 3,
  P: 4,
  Red: 2,
  Blue: 2,
  Y: 2,
};

export const LOOP_SLOT_MID = 2;
export const LOOP_SPACING_M = 14;
export const LOOP_EASE_M = 120;
export const LOOP_OFFSET_FULL_Z = 13.2;
export const LOOP_OFFSET_NONE_Z = 12.4;

const STEEL_RGB = [42, 51, 66];
const WHITE_RGB = [255, 255, 255];

export function offsetTForZoom(z) {
  if (!(z > LOOP_OFFSET_NONE_Z)) return 0;
  if (z >= LOOP_OFFSET_FULL_Z) return 1;
  return (z - LOOP_OFFSET_NONE_Z) / (LOOP_OFFSET_FULL_Z - LOOP_OFFSET_NONE_Z);
}

export function loopSlot(lineKey) {
  return Object.hasOwn(LOOP_SLOTS, lineKey) ? LOOP_SLOTS[lineKey] : LOOP_SLOT_MID;
}

export function mixRgb(a, b, t) {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ];
}

/** Brand color fades to steel as offsets collapse. `brand` is an RGB triple. */
export function ribbonPaint(brand, zoomT) {
  const t = zoomT < 0 ? 0 : zoomT > 1 ? 1 : zoomT;
  const src = brand || [80, 80, 120];
  const color = mixRgb(STEEL_RGB, src, t);
  const filament = mixRgb(color, WHITE_RGB, 0.35 + 0.2 * t);
  return { color, filament };
}

function distM(a, b) {
  const lat = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) * mPerDegLon(lat);
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

function localMeters(from, to) {
  const lat = (from[1] + to[1]) / 2;
  return [(to[0] - from[0]) * mPerDegLon(lat), (to[1] - from[1]) * M_PER_DEG_LAT];
}

function shiftLonLat([lon, lat], eastM, northM) {
  return [lon + eastM / mPerDegLon(lat), lat + northM / M_PER_DEG_LAT];
}

/** 0 outside the bbox; 1 when more than LOOP_EASE_M inside every edge. */
export function loopEase(lon, lat) {
  const { west, south, east, north } = LOOP_BBOX;
  if (lon < west || lon > east || lat < south || lat > north) return 0;
  const dLon = Math.min(lon - west, east - lon) * mPerDegLon(lat);
  const dLat = Math.min(lat - south, north - lat) * M_PER_DEG_LAT;
  return Math.min(1, Math.min(dLon, dLat) / LOOP_EASE_M);
}

function tangentMeters(coords, i) {
  let prev = i;
  let next = i;
  while (prev > 0 && distM(coords[prev], coords[i]) < 0.5) prev -= 1;
  while (next < coords.length - 1 && distM(coords[next], coords[i]) < 0.5) next += 1;
  if (prev === next) return [0, 1];
  return localMeters(coords[prev], coords[next]);
}

/** Compass heading (0 = north) → east/north tangent. */
function headingTangent(headingDeg) {
  const rad = ((Number.isFinite(headingDeg) ? headingDeg : 0) * Math.PI) / 180;
  return [Math.sin(rad), Math.cos(rad)];
}

/**
 * Same world-stable Loop shift the painted rails use. Positive slot is
 * outward from LOOP_CENTER. `tx, ty` is any along-rail tangent in meters.
 */
export function shiftByTangent(pt, lineKey, zoomT, tx, ty) {
  const t = zoomT < 0 ? 0 : zoomT > 1 ? 1 : zoomT;
  const meters = (loopSlot(lineKey) - LOOP_SLOT_MID) * LOOP_SPACING_M * t;
  if (meters === 0) return [pt[0], pt[1]];
  const ease = loopEase(pt[0], pt[1]);
  if (ease === 0) return [pt[0], pt[1]];
  const len = Math.hypot(tx, ty) || 1;
  let px = -ty / len;
  let py = tx / len;
  const [rx, ry] = localMeters(LOOP_CENTER, pt);
  if (px * rx + py * ry < 0) {
    px = -px;
    py = -py;
  }
  const mag = meters * ease;
  return shiftLonLat(pt, px * mag, py * mag);
}

/** Draw-time train shift. Uses the vehicle heading as the rail tangent. */
export function offsetLonLat(pt, lineKey, zoomT, headingDeg) {
  if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return pt;
  const [tx, ty] = headingTangent(headingDeg);
  return shiftByTangent(pt, lineKey, zoomT, tx, ty);
}

/**
 * Offset a polyline perpendicular to itself. Sign is world-stable: positive
 * slot is outward from LOOP_CENTER, independent of digitize direction.
 */
export function offsetCoords(coords, lineKey, zoomT = 1) {
  if (!Array.isArray(coords) || coords.length === 0) return coords || [];
  const t = zoomT < 0 ? 0 : zoomT > 1 ? 1 : zoomT;
  if (t === 0) return coords.map((c) => [c[0], c[1]]);
  if ((loopSlot(lineKey) - LOOP_SLOT_MID) * t === 0 || coords.length === 1) {
    return coords.map((c) => [c[0], c[1]]);
  }
  return coords.map((pt, i) => {
    const [tx, ty] = tangentMeters(coords, i);
    return shiftByTangent(pt, lineKey, t, tx, ty);
  });
}

export function offsetTracks(tracks, zoomT = 1) {
  return Object.entries(tracks || {}).map(([key, line]) => ({
    key,
    coords: offsetCoords(line?.coords || [], key, zoomT),
  }));
}
