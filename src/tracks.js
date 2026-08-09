// Pure geometry: snap-to-polyline and distance-along-track math.
// All work happens in a local equirectangular meter projection around Chicago,
// accurate to well under a meter at city scale.

const ORIGIN_LAT = 41.85;
export const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

export function toMeters([lon, lat]) {
  return [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT];
}

// Per-point (not fixed-origin) meters-per-degree-longitude — for callers
// projecting geometry that spans enough latitude that the single-origin
// approximation above would drift (build scripts covering a whole bbox,
// or runtime code offsetting a point by its own local heading). Simplify
// pass: this exact formula was independently copy-pasted into cars.js,
// layers.js's offsetPoint, build-roads.mjs and build-patterns.mjs — one
// export here instead of five inline literals of 111320.
export function mPerDegLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

// Compass bearing (degrees, clockwise from north) from point a to point b —
// standard flat-earth approximation, accurate well under a degree at the
// short (tens-of-meters) distances this is used over. Simplify pass: was
// defined byte-for-byte identically in both buses.js and cars.js.
export function bearingDeg([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * rad);
  const dLat = lat2 - lat1;
  let deg = Math.atan2(dLon, dLat) / rad;
  if (deg < 0) deg += 360;
  return deg;
}

// Generic distance-along-a-polyline -> [lon, lat] interpolation: binary
// search for the bracketing pair of samples via `distAt(i)`, then lerp
// their coordinates via `pointAt(i)`. Simplify pass: this exact
// binary-search-then-lerp shape was written three times independently
// (this file's own pointAtDist below, buses.js's interpolatePattern over
// pdist, cars.js's interpAlong over a cumulative-meters array) — one
// generic implementation via accessors instead.
export function interpAtDist(dist, totalDist, distAt, pointAt, count) {
  const d = Math.max(0, Math.min(dist, totalDist));
  let lo = 0;
  let hi = count - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (distAt(mid) <= d) lo = mid;
    else hi = mid;
  }
  const segLen = distAt(hi) - distAt(lo);
  const t = segLen > 0 ? (d - distAt(lo)) / segLen : 0;
  const [lonA, latA] = pointAt(lo);
  const [lonB, latB] = pointAt(hi);
  return [lonA + t * (lonB - lonA), latA + t * (latB - latA)];
}

// Precompute per-line segment geometry once so snapping is a cheap linear scan.
export function prepareLine(line) {
  const pts = line.coords.map(toMeters);
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    segs.push({ ax, ay, dx, dy, len, cumDist: line.cumDist[i] });
  }
  return { ...line, segs, totalDist: line.cumDist[line.cumDist.length - 1] };
}

// Nearest point on the line's polyline → distance along track (meters).
export function snapToLine(prepared, lonLat) {
  const [px, py] = toMeters(lonLat);
  let best = { dist: 0, offTrack: Infinity };
  for (const s of prepared.segs) {
    if (s.len === 0) continue;
    let t = ((px - s.ax) * s.dx + (py - s.ay) * s.dy) / (s.len * s.len);
    t = Math.max(0, Math.min(1, t));
    const qx = s.ax + t * s.dx;
    const qy = s.ay + t * s.dy;
    const off = Math.hypot(px - qx, py - qy);
    if (off < best.offTrack) {
      best = { dist: s.cumDist + t * s.len, offTrack: off };
    }
  }
  return best;
}

// Distance along track (meters) → [lon, lat]. Binary search over cumDist.
export function pointAtDist(prepared, dist) {
  const { coords, cumDist } = prepared;
  return interpAtDist(dist, prepared.totalDist, (i) => cumDist[i], (i) => coords[i], cumDist.length);
}
