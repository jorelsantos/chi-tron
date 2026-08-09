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
// Includes MVP tracker routes 8 (Halsted) + 62 (Archer) plus marquee set.
export const MARQUEE_ROUTES = [
  '8', '62',
  '22', '4', '9', '20', '49', '151', '6', '3', '66',
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

const patterns = {}; // pid -> { pid, rt, rtdir, points: [...], totalDist }
const routes = {}; // rt -> [pid, ...]
// CTA-style: one ordered stop list per travel direction (not a merged soup).
// When multiple patterns share an rtdir (short-turn vs full), keep the longest.
const routeDirections = {}; // rt -> [{ rtdir, pid, stops: [{stpid,name,pdist,lat,lon}] }]
// Flat unique stpids (unordered for browse — use routeDirections). Kept for
// callers that only need stpid membership / map labels.
const routeStops = {}; // rt -> [{ stpid, name, pdist, lat, lon }]

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
  const stopMap = new Map(); // stpid -> stop (first-seen; not browse order)
  /** @type {Map<string, { rtdir: string, pid: string, stops: object[] }>} */
  const byDir = new Map();
  for (const ptr of ptrs) {
    const pid = String(ptr.pid);
    const rtdir = String(ptr.rtdir || '').trim() || 'Unknown';
    const rawPts = Array.isArray(ptr.pt) ? ptr.pt : [];
    const points = [];
    const patternStops = [];
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
      const pt = {
        lat: Number(lat.toFixed(6)),
        lon: Number(lon.toFixed(6)),
        pdist: Math.round(dist),
      };
      // Preserve stop markers for route→stop lists / getpredictions stpid.
      if (p.stpid != null && String(p.stpid)) {
        pt.stpid = String(p.stpid);
        pt.name = String(p.stpnm || p.stpNm || '').trim();
        const stop = {
          stpid: pt.stpid,
          name: pt.name || `Stop ${pt.stpid}`,
          pdist: pt.pdist,
          lat: pt.lat,
          lon: pt.lon,
        };
        patternStops.push(stop);
        if (!stopMap.has(pt.stpid)) stopMap.set(pt.stpid, stop);
      }
      points.push(pt);
    }
    if (points.length < 2) continue; // degenerate pattern, not usable for interpolation
    patterns[pid] = {
      pid,
      rt,
      rtdir,
      points,
      totalDist: points[points.length - 1].pdist,
    };
    pids.push(pid);

    const prev = byDir.get(rtdir);
    if (!prev || patternStops.length > prev.stops.length) {
      byDir.set(rtdir, { rtdir, pid, stops: patternStops });
    }
  }
  if (pids.length) {
    routes[rt] = pids;
    const dirs = [...byDir.values()].sort((a, b) => a.rtdir.localeCompare(b.rtdir));
    if (dirs.length) routeDirections[rt] = dirs;
    // Flat membership list (not directional order).
    if (stopMap.size) routeStops[rt] = [...stopMap.values()];
  }
  console.log(
    `  ${rt}: ${pids.length} pattern(s), ${stopMap.size} stop(s), ` +
      `${byDir.size} direction(s) [${[...byDir.keys()].join(', ')}]`
  );
}

const routeCount = Object.keys(routes).length;
if (routeCount === 0) {
  console.error('ERROR: no routes yielded a usable pattern — refusing to write an empty patterns.json');
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify({ patterns, routes, routeDirections, routeStops }));
console.log(
  `Wrote ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(0)} KB, ` +
    `${Object.keys(patterns).length} patterns across ${routeCount}/${MARQUEE_ROUTES.length} routes)`
);
if (!existsSync(OUT)) process.exit(1);
