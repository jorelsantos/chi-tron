// Station helpers for Pulse Run: lookup, line membership, out-and-back snaps.

import { prepareLine, pointAtDist, toMeters } from '../tracks.js';

const SNAP_OFF_M = 350;
const CLUSTER_M = 100;
const SAMPLE_STEP_M = 15;
const NEAR_SAMPLE_M = 80;

/**
 * @param {Record<string, {id: string, name: string, coords: number[], lines: string[]}>} stations
 */
export function getStation(stations, id) {
  return stations?.[id] ?? null;
}

export function stationOnLine(station, line) {
  return !!station?.lines?.includes(line);
}

/**
 * All plausible along-track distances for a lon/lat on a prepared line
 * (out-and-back polylines can hit the same station twice).
 * @param {ReturnType<typeof prepareLine>} prepared
 * @param {[number, number]} lonLat
 */
export function snapCandidates(prepared, lonLat) {
  const [px, py] = toMeters(lonLat);
  const candidates = [];

  for (const s of prepared.segs) {
    if (s.len === 0) continue;
    let t = ((px - s.ax) * s.dx + (py - s.ay) * s.dy) / (s.len * s.len);
    t = Math.max(0, Math.min(1, t));
    const qx = s.ax + t * s.dx;
    const qy = s.ay + t * s.dy;
    const off = Math.hypot(px - qx, py - qy);
    if (off <= SNAP_OFF_M) {
      candidates.push({ dist: s.cumDist + t * s.len, off });
    }
  }

  for (let d = 0; d < prepared.totalDist; d += SAMPLE_STEP_M) {
    const [lon, lat] = pointAtDist(prepared, d);
    const [x, y] = toMeters([lon, lat]);
    const off = Math.hypot(x - px, y - py);
    if (off < NEAR_SAMPLE_M) candidates.push({ dist: d, off });
  }

  candidates.sort((a, b) => a.off - b.off);
  const uniq = [];
  for (const c of candidates) {
    if (!uniq.some((u) => Math.abs(u.dist - c.dist) < CLUSTER_M)) {
      uniq.push({ dist: c.dist, off: c.off });
    }
  }
  return uniq.sort((a, b) => a.off - b.off);
}

/**
 * Pick start/goal dist pair: best snaps first, then shortest path.
 * @returns {{ startDist: number, goalDist: number, dir: number, lengthM: number } | null}
 */
export function pickMinPathPair(startCandidates, goalCandidates) {
  let best = null;
  const starts = startCandidates.slice(0, 4);
  const goals = goalCandidates.slice(0, 4);
  for (const a of starts) {
    for (const b of goals) {
      const delta = b.dist - a.dist;
      if (Math.abs(delta) < 80) continue;
      const score = Math.abs(delta) + a.off * 3 + b.off * 3;
      if (!best || score < best.score) {
        best = {
          startDist: a.dist,
          goalDist: b.dist,
          dir: Math.sign(delta) || 1,
          lengthM: Math.abs(delta),
          score,
        };
      }
    }
  }
  if (!best) return null;
  return {
    startDist: best.startDist,
    goalDist: best.goalDist,
    dir: best.dir,
    lengthM: best.lengthM,
  };
}

/**
 * Bake startDist/goalDist for a challenge card against live tracks + stations.
 * @param {object} card
 * @param {Record<string, {coords: number[][], cumDist: number[]}>} tracksData
 * @param {Record<string, object>} stations
 */
export function bakeChallengeDists(card, tracksData, stations) {
  const lineData = tracksData[card.line];
  if (!lineData) return null;
  const start = getStation(stations, card.startId);
  const goal = getStation(stations, card.goalId);
  if (!start || !goal) return null;
  if (!stationOnLine(start, card.line) || !stationOnLine(goal, card.line)) return null;

  const prepared = prepareLine(lineData);
  const starts = snapCandidates(prepared, start.coords);
  const goals = snapCandidates(prepared, goal.coords);
  if (!starts.length || !goals.length) return null;

  return pickMinPathPair(starts, goals);
}
