#!/usr/bin/env node
// Bus network bake: marquee full patterns (map vehicles) + all-route
// directions/stops (tracker boards). Writes:
//   public/data/patterns.json  — polylines for mapLive + routeDirections for all
//   public/data/bus-routes.json — catalog { rt, name, live, mapLive }
//
// CTA getpatterns pdist is unusable on waypoints — recompute feet along
// polyline for mapLive routes only (see historical comment in git).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { M_PER_DEG_LAT, mPerDegLon } from '../src/tracks.js';

const BASE = 'https://www.ctabustracker.com/bustime/api/v3';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATTERNS = join(ROOT, 'public/data/patterns.json');
const OUT_CATALOG = join(ROOT, 'public/data/bus-routes.json');

const KEY = process.env.CTA_BUS_KEY;
if (!KEY) {
  console.error(
    'CTA_BUS_KEY is not set. Run via `npm run patterns` (loads .env), ' +
      'or `node --env-file=.env scripts/build-patterns.mjs`.',
  );
  process.exit(1);
}

// High-frequency routes that get full polylines + map vehicle poll.
// Must stay in sync with mapLive defaults in bus-routes bake output.
export const MARQUEE_ROUTES = [
  '8', '62',
  '22', '4', '9', '20', '49', '151', '6', '3', '66',
  '77', '79', '80', '82', '146', '147', '152', '55', '63', 'X9',
];

const MARQUEE_SET = new Set(MARQUEE_ROUTES.map(String));
const FT_PER_M = 3.28084;
const DELAY_MS = 80; // gentle CTA pacing across ~126 routes

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function bustime(path, params = {}) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set('key', KEY);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const err = data?.['bustime-response']?.error;
  if (Array.isArray(err) && err.length) {
    // Some endpoints put soft errors alongside empty data
    const msg = err[0]?.msg ?? 'API error';
    if (!data?.['bustime-response']?.ptr && !data?.['bustime-response']?.stops
      && !data?.['bustime-response']?.routes && !data?.['bustime-response']?.directions) {
      throw new Error(msg);
    }
  }
  return data?.['bustime-response'] ?? {};
}

function asList(maybe) {
  if (Array.isArray(maybe)) return maybe;
  return maybe ? [maybe] : [];
}

/** Natural-ish CTA route sort: pure numbers by value, then alpha (X4, N5). */
export function sortRouteIds(ids) {
  return [...ids].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aNum = Number.isFinite(na) && String(na) === String(a);
    const bNum = Number.isFinite(nb) && String(nb) === String(b);
    if (aNum && bNum) return na - nb;
    if (aNum) return -1;
    if (bNum) return 1;
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  });
}

async function fetchAllRoutes() {
  const body = await bustime('getroutes');
  return asList(body.routes).map((r) => ({
    rt: String(r.rt),
    name: String(r.rtnm || r.rt || '').trim() || String(r.rt),
    color: String(r.rtclr || '').trim(),
  }));
}

/**
 * getpatterns for a route. mapLive=true stores full polylines for vehicle
 * interpolation; false stores only ordered stops (CTA getstops is name-sorted
 * and unusable for route sequence).
 * @param {{ mapLive?: boolean }} opts
 */
async function bakePatternsForRoute(rt, patterns, routes, routeDirections, routeStops, opts = {}) {
  const mapLive = opts.mapLive !== false;
  const body = await bustime('getpatterns', { rt });
  const ptrs = asList(body.ptr);
  const pids = [];
  const stopMap = new Map();
  const byDir = new Map();

  for (const ptr of ptrs) {
    const pid = String(ptr.pid);
    const rtdir = String(ptr.rtdir || '').trim() || 'Unknown';
    const rawPts = asList(ptr.pt);
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
        if (stepM < 1) continue;
        dist += stepM * FT_PER_M;
      }
      const pt = {
        lat: Number(lat.toFixed(6)),
        lon: Number(lon.toFixed(6)),
        pdist: Math.round(dist),
      };
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
      // Always track geometry for cumulative pdist; only persist polylines for mapLive.
      points.push(pt);
    }
    if (mapLive) {
      if (points.length < 2) continue;
      patterns[pid] = {
        pid,
        rt,
        rtdir,
        points,
        totalDist: points[points.length - 1].pdist,
      };
      pids.push(pid);
    }
    if (!patternStops.length) continue;
    const prev = byDir.get(rtdir);
    if (!prev || patternStops.length > prev.stops.length) {
      byDir.set(rtdir, { rtdir, pid: mapLive ? pid : null, stops: patternStops });
    }
  }

  if (!byDir.size) return { ok: false, pids: 0, stops: 0, dirs: 0 };
  if (mapLive && pids.length) routes[rt] = pids;
  const dirs = [...byDir.values()].sort((a, b) => a.rtdir.localeCompare(b.rtdir));
  routeDirections[rt] = dirs;
  if (stopMap.size) routeStops[rt] = [...stopMap.values()];
  return { ok: true, pids: pids.length, stops: stopMap.size, dirs: byDir.size };
}

// --- main ---
const patterns = {};
const routes = {};
const routeDirections = {};
const routeStops = {};

console.log('Fetching CTA getroutes…');
let allRoutes;
try {
  allRoutes = await fetchAllRoutes();
} catch (err) {
  console.error('FATAL: getroutes failed:', err.message);
  process.exit(1);
}
console.log(`  ${allRoutes.length} routes`);

const catalog = allRoutes.map((r) => ({
  rt: r.rt,
  name: r.name,
  color: r.color,
  live: false, // flipped true when directions bake succeeds
  mapLive: MARQUEE_SET.has(r.rt),
}));
const byRt = new Map(catalog.map((r) => [r.rt, r]));

// 1) Full patterns for marquee (mapLive)
console.log(`\nBaking full patterns for ${MARQUEE_ROUTES.length} mapLive routes…`);
for (const rt of MARQUEE_ROUTES) {
  await sleep(DELAY_MS);
  try {
    const result = await bakePatternsForRoute(
      rt, patterns, routes, routeDirections, routeStops, { mapLive: true },
    );
    if (result.ok) {
      if (byRt.has(rt)) byRt.get(rt).live = true;
      console.log(`  ${rt}: ${result.pids} pattern(s), ${result.stops} stop(s), ${result.dirs} dir(s)`);
    } else {
      console.warn(`  WARNING: ${rt} patterns empty`);
    }
  } catch (err) {
    console.warn(`  WARNING: ${rt} patterns failed (${err.message})`);
  }
}

// 2) Pattern stop order for every other route (tracker only — no polylines).
// Do NOT use getstops: CTA returns alphabetical names, not route sequence.
const rest = sortRouteIds(allRoutes.map((r) => r.rt).filter((rt) => !routeDirections[rt]));
console.log(`\nBaking ordered stops (getpatterns, no map polylines) for ${rest.length} routes…`);
let restOk = 0;
for (const rt of rest) {
  await sleep(DELAY_MS);
  try {
    const result = await bakePatternsForRoute(
      rt, patterns, routes, routeDirections, routeStops, { mapLive: false },
    );
    if (result.ok) {
      if (byRt.has(rt)) byRt.get(rt).live = true;
      restOk += 1;
      if (restOk <= 8 || restOk % 20 === 0) {
        console.log(`  ${rt}: ${result.dirs} dir(s), ${result.stops} stop(s)`);
      }
    } else {
      console.warn(`  WARNING: ${rt} no stops`);
    }
  } catch (err) {
    console.warn(`  WARNING: ${rt} stops failed (${err.message})`);
  }
}
console.log(`  tracker bake ok: ${restOk}/${rest.length}`);

const mapRouteCount = Object.keys(routes).length;
const dirRouteCount = Object.keys(routeDirections).length;
if (mapRouteCount === 0) {
  console.error('ERROR: no mapLive patterns — refusing empty patterns.json');
  process.exit(1);
}

const catalogOut = {
  generatedAt: new Date().toISOString(),
  mapLive: MARQUEE_ROUTES.filter((rt) => routes[rt]),
  routes: sortRouteIds([...byRt.keys()]).map((rt) => byRt.get(rt)),
};

writeFileSync(OUT_PATTERNS, JSON.stringify({ patterns, routes, routeDirections, routeStops }));
writeFileSync(OUT_CATALOG, JSON.stringify(catalogOut));

console.log(
  `\nWrote ${OUT_PATTERNS} (${(readFileSync(OUT_PATTERNS).length / 1024).toFixed(0)} KB, ` +
    `${Object.keys(patterns).length} patterns, ${mapRouteCount} mapLive, ${dirRouteCount} with directions)`,
);
console.log(
  `Wrote ${OUT_CATALOG} (${catalogOut.routes.filter((r) => r.live).length} live / ${catalogOut.routes.length} total)`,
);
if (!existsSync(OUT_PATTERNS) || !existsSync(OUT_CATALOG)) process.exit(1);
