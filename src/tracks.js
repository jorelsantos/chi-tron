// Pure geometry: snap-to-polyline and distance-along-track math.
// All work happens in a local equirectangular meter projection around Chicago,
// accurate to well under a meter at city scale.

const ORIGIN_LAT = 41.85;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

export function toMeters([lon, lat]) {
  return [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT];
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
  const d = Math.max(0, Math.min(dist, prepared.totalDist));
  let lo = 0;
  let hi = cumDist.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= d) lo = mid;
    else hi = mid;
  }
  const segLen = cumDist[hi] - cumDist[lo];
  const t = segLen > 0 ? (d - cumDist[lo]) / segLen : 0;
  return [
    coords[lo][0] + t * (coords[hi][0] - coords[lo][0]),
    coords[lo][1] + t * (coords[hi][1] - coords[lo][1]),
  ];
}
