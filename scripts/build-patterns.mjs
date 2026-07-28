#!/usr/bin/env node
// One-time (re-runnable) bus pattern builder: CTA Bus Tracker getpatterns →
// public/data/patterns.json. Build-time only — U9's live poller never calls
// getpatterns at runtime; every pattern polyline a bus can be interpolated
// against is baked here, exactly like scripts/build-tracks.mjs bakes L-line
// polylines from GTFS ahead of time.
//
// CTA quirk (verified live 2026-07-28 against rt=22): the raw getpatterns
// response's per-point `pdist` is only populated at "S" (stop) points —
// intermediate "W" waypoint points report pdist 0.0 regardless of their
// real position along the pattern (out of 244 points on one direction of
// route 22, only 74 carried a nonzero pdist, and the raw sequence was
// non-monotonic at 73 of them). So the raw field can't be used to index the
// polyline directly. This script ignores it entirely and recomputes its own
// cumulative distance-along-polyline from consecutive lat/lon points
// (mirroring build-tracks.mjs's projection), in FEET — the same unit
// getvehicles' live `pdist` reports — so src/buses.js's runtime
// interpolation never needs a unit conversion, only direct indexing.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { M_PER_DEG_LAT, mPerDegLon } from '../src/tracks.js';

const BASE = 'https://www.ctabustracker.com/bustime/api/v3';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/data/patterns.json');

const KEY = process.env.CTA_BUS_KEY;
if (!KEY) {
  console.error(
    'CTA_BUS_KEY is not set. Run via `npm run patterns` (which loads .env), ' +
      'or `node --env-file=.env scripts/build-patterns.mjs`.'
  );
  process.exit(1);
}

// ~20 high-frequency CTA bus routes — the marquee set src/buses.js's
// MARQUEE_ROUTES constant mirrors at runtime (mock mode walks exactly these
// routes' baked patterns; live mode polls exactly these routes' vehicles).
// Picked for frequency/name recognition, not exhaustiveness: 22 Clark, 4
// Cottage Grove, 8 Halsted, 9 Ashland, 20 Madison, 49 Western, 151 Sheridan,
// 6 Jackson Park Express, 3 King Drive, 66 Chicago, 77 Belmont, 79 79th, 80
// Irving Park, 82 Kimball-Homan, 146 Inner Drive/Michigan Express, 147 Outer
// Drive Express, 152 Addison, 55 Garfield, 63 63rd, X9 Ashland Express.
export const MARQUEE_ROUTES = [
  '22', '4', '8', '9', '20', '49', '151', '6', '3', '66',
  '77', '79', '80', '82', '146', '147', '152', '55', '63', 'X9',
];

const FT_PER_M = 3.28084;

async function fetchPatterns(rt) {
  const url = `${BASE}/getpatterns?key=${KEY}&rt=${encodeURIComponent(rt)}&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const err = data?.['bustime-response']?.error;
  if (err) throw new Error(err[0]?.msg ?? 'unknown API error');
  const ptrs = data?.['bustime-response']?.ptr;
  return Array.isArray(ptrs) ? ptrs : [];
}

const patterns = {}; // pid -> { pid, rt, points: [{lat,lon,pdist}], totalDist }
const routes = {}; // rt -> [pid, ...]

console.log(`Fetching bus patterns for ${MARQUEE_ROUTES.length} marquee routes…`);
for (const rt of MARQUEE_ROUTES) {
  let ptrs;
  try {
    ptrs = await fetchPatterns(rt);
  } catch (err) {
    console.error(`  WARNING: route ${rt} failed (${err.message}), skipping`);
    continue;
  }

  const pids = [];
  for (const ptr of ptrs) {
    const pid = String(ptr.pid);
    const rawPts = Array.isArray(ptr.pt) ? ptr.pt : [];
    const points = [];
    let dist = 0;
    for (const p of rawPts) {
      const lat = Number(p.lat);
      const lon = Number(p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (points.length) {
        const prev = points[points.length - 1];
        const dx = (lon - prev.lon) * mPerDegLon(lat);
        const dy = (lat - prev.lat) * M_PER_DEG_LAT;
        const stepM = Math.hypot(dx, dy);
        if (stepM < 1) continue; // dedupe near-identical points, mirrors build-tracks.mjs
        dist += stepM * FT_PER_M;
      }
      points.push({ lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), pdist: Math.round(dist) });
    }
    if (points.length < 2) continue; // degenerate pattern, not usable for interpolation
    patterns[pid] = { pid, rt, points, totalDist: points[points.length - 1].pdist };
    pids.push(pid);
  }
  if (pids.length) routes[rt] = pids;
  console.log(`  ${rt}: ${pids.length} pattern(s)`);
}

const routeCount = Object.keys(routes).length;
if (routeCount === 0) {
  console.error('ERROR: no routes yielded a usable pattern — refusing to write an empty patterns.json');
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify({ patterns, routes }));
console.log(
  `Wrote ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(0)} KB, ` +
    `${Object.keys(patterns).length} patterns across ${routeCount}/${MARQUEE_ROUTES.length} routes)`
);
if (!existsSync(OUT)) process.exit(1);
