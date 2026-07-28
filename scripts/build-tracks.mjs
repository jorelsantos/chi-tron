#!/usr/bin/env node
// One-time (re-runnable) track builder: CTA static GTFS → public/data/tracks.json
// Per L line: the longest shape (= full-line run, skips short-turn variants),
// deduped, with cumulative distances in meters.
//
// U8: also emits public/data/stations.json — one node per physical station
// (GTFS platforms deduped by parent_station), joined to real City of Chicago
// ridership data for a normalized brightness weight (R11).

import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GTFS_URL = 'https://www.transitchicago.com/downloads/sch_data/google_transit.zip';
const L_ROUTES = ['Red', 'Blue', 'Brn', 'G', 'Org', 'P', 'Pink', 'Y'];
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/data/tracks.json');
const STATIONS_OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/data/stations.json');

// City of Chicago data portal — "CTA - Ridership - 'L' Station Entries -
// Daily Totals" (dataset 5neh-572f). `station_id` in this dataset uses the
// same map_id numbering CTA's own GTFS feed uses for `parent_station`
// (verified 2026-07-28 by cross-referencing every parent_station id against
// this dataset and against the companion "List of 'L' Stops" dataset
// 8pix-ypme, whose `map_id` column matches `station_id` 1:1) — so it joins
// directly with no crosswalk table needed. All 143 stations in the current
// feed matched with zero misses in verification.
const RIDERSHIP_API = 'https://data.cityofchicago.org/resource/5neh-572f.json';
// Average over a trailing ~500-day window so a few months of reporting lag
// (observed: latest row is ~2 months behind "today") still leaves a full
// year plus of data to average, smoothing out day-of-week/seasonal noise
// without reaching back to pre-pandemic ridership patterns.
const RIDERSHIP_WINDOW_DAYS = 500;
// Bounded weight range for station brightness (R11). Floor is not zero so a
// station with no ridership match (join failure, closed/renamed station)
// still renders as a dim ember rather than vanishing or rendering NaN.
const WEIGHT_FLOOR = 0.12;
const WEIGHT_CEIL = 1.0;
// Fallback-only: rough bbox around the Loop elevated loop, used solely if
// the ridership fetch/parse fails outright (network hiccup at build time).
// Not used when the real join succeeds.
const LOOP_BBOX = { minLat: 41.8755, maxLat: 41.8865, minLon: -87.6365, maxLon: -87.6225 };

const M_PER_DEG_LAT = 111320;
const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

function parseCsv(text) {
  // GTFS csv is simple enough: no embedded newlines in the files we use.
  const lines = text.split('\n').filter((l) => l.trim());
  const headers = lines[0].replace(/^﻿/, '').split(',').map((h) => h.trim().replace(/"/g, ''));
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim().replace(/"/g, ''));
    return Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
  });
}

const work = mkdtempSync(join(tmpdir(), 'cta-gtfs-'));
const zip = join(work, 'gtfs.zip');
console.log('Downloading CTA GTFS…');
execSync(`curl -sL -o "${zip}" "${GTFS_URL}"`, { stdio: 'inherit' });
execSync(`unzip -o -q "${zip}" trips.txt shapes.txt stops.txt stop_times.txt -d "${work}"`);

console.log('Parsing trips…');
const trips = parseCsv(readFileSync(join(work, 'trips.txt'), 'utf8'));
const shapesByRoute = new Map(); // route_id → Set(shape_id)
for (const t of trips) {
  if (!L_ROUTES.includes(t.route_id) || !t.shape_id) continue;
  if (!shapesByRoute.has(t.route_id)) shapesByRoute.set(t.route_id, new Set());
  shapesByRoute.get(t.route_id).add(t.shape_id);
}

console.log('Parsing shapes…');
const shapePoints = new Map(); // shape_id → [{seq, lat, lon}]
for (const row of parseCsv(readFileSync(join(work, 'shapes.txt'), 'utf8'))) {
  const id = row.shape_id;
  if (!id) continue;
  if (!shapePoints.has(id)) shapePoints.set(id, []);
  shapePoints.get(id).push({
    seq: parseInt(row.shape_pt_sequence, 10),
    lat: parseFloat(row.shape_pt_lat),
    lon: parseFloat(row.shape_pt_lon),
  });
}

const out = {};
for (const route of L_ROUTES) {
  const candidates = [...(shapesByRoute.get(route) ?? [])]
    .map((id) => ({ id, pts: shapePoints.get(id) ?? [] }))
    .filter((s) => s.pts.length > 1);
  if (!candidates.length) {
    console.error(`WARNING: no shapes found for route ${route}`);
    continue;
  }
  const longest = candidates.reduce((a, b) => (b.pts.length > a.pts.length ? b : a));
  const pts = longest.pts.sort((a, b) => a.seq - b.seq);

  const coords = [];
  const cumDist = [];
  let dist = 0;
  for (const p of pts) {
    const cur = [Number(p.lon.toFixed(6)), Number(p.lat.toFixed(6))];
    if (coords.length) {
      const prev = coords[coords.length - 1];
      const dx = (cur[0] - prev[0]) * mPerDegLon(cur[1]);
      const dy = (cur[1] - prev[1]) * M_PER_DEG_LAT;
      const step = Math.hypot(dx, dy);
      if (step < 1) continue; // dedupe near-identical points
      dist += step;
    }
    coords.push(cur);
    cumDist.push(Math.round(dist));
  }
  out[route] = { coords, cumDist };
  console.log(`  ${route}: shape ${longest.id}, ${coords.length} pts, ${(dist / 1000).toFixed(1)} km`);
}

writeFileSync(OUT, JSON.stringify(out));
console.log(`Wrote ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(0)} KB)`);
if (!existsSync(OUT)) process.exit(1);

// ---------------------------------------------------------------------------
// Stations (U8 / R11)
// ---------------------------------------------------------------------------

console.log('Parsing stops…');
const stops = parseCsv(readFileSync(join(work, 'stops.txt'), 'utf8'));
const stopById = new Map(stops.map((s) => [s.stop_id, s]));

// trip_id → route_id, restricted to L routes (trips.txt already parsed above).
const tripToRoute = new Map();
for (const t of trips) {
  if (L_ROUTES.includes(t.route_id) && t.trip_id) tripToRoute.set(t.trip_id, t.route_id);
}

// stop_times.txt is ~350MB / ~5.8M rows — too big for the generic quote-aware
// parseCsv (one object allocation per row). Targeted column scan instead:
// only trip_id and stop_id are needed to learn which platform stops each L
// route actually serves.
console.log('Scanning stop_times for L-route platform stops (this is the big file)…');
const routeStopIds = new Map(); // route_id → Set(platform stop_id)
{
  const text = readFileSync(join(work, 'stop_times.txt'), 'utf8');
  const firstNl = text.indexOf('\n');
  const header = text.slice(0, firstNl).split(',');
  const tripIdx = header.indexOf('trip_id');
  const stopIdx = header.indexOf('stop_id');
  let pos = firstNl + 1;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    const line = text.slice(pos, end);
    pos = end + 1;
    if (!line) continue;
    const cells = line.split(',');
    const route = tripToRoute.get(cells[tripIdx]);
    if (!route) continue;
    if (!routeStopIds.has(route)) routeStopIds.set(route, new Set());
    routeStopIds.get(route).add(cells[stopIdx]);
  }
}

// Dedupe platforms into one node per physical station (GTFS parent_station).
// A station serving multiple lines (e.g. Belmont: Brn/P/Red) collects all of
// them so it can render once, colored/prioritized by L_ROUTES order.
const stations = new Map(); // parent_station id → { id, name, coords, lines: Set }
for (const route of L_ROUTES) {
  for (const platformId of routeStopIds.get(route) ?? []) {
    const platform = stopById.get(platformId);
    const parentId = platform?.parent_station;
    const parent = parentId && stopById.get(parentId);
    if (!parent) continue; // no station-level record → can't place a node
    const lat = parseFloat(parent.stop_lat);
    const lon = parseFloat(parent.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!stations.has(parentId)) {
      stations.set(parentId, {
        id: parentId,
        name: parent.stop_name,
        coords: [Number(lon.toFixed(6)), Number(lat.toFixed(6))],
        lines: new Set(),
      });
    }
    stations.get(parentId).lines.add(route);
  }
}
console.log(`  found ${stations.size} physical stations across ${L_ROUTES.length} lines`);

// Ridership join. See RIDERSHIP_API comment above for the verified join key.
// On any failure (network, schema drift, empty response) fall back to a
// coarse Loop-vs-outlying proxy rather than failing the whole build —
// stations.json must still ship with every station present.
let ridershipByStationId = null;
try {
  const cutoff = new Date(Date.now() - RIDERSHIP_WINDOW_DAYS * 86400000)
    .toISOString()
    .slice(0, 10) + 'T00:00:00';
  // Built with URLSearchParams (not shelled through curl) specifically
  // because Socrata's SoQL params are named `$select`/`$where`/`$group` —
  // a `$word` token in a double-quoted shell string is variable expansion,
  // which silently emptied every param and produced a malformed query the
  // first time this was wired through `execSync(curl ...)`. Node's native
  // `fetch` sidesteps shell quoting entirely.
  const params = new URLSearchParams({
    '$select': 'station_id,avg(rides)',
    '$where': `date >= '${cutoff}'`,
    '$group': 'station_id',
    '$limit': '1000',
  });
  const url = `${RIDERSHIP_API}?${params}`;
  console.log('Fetching CTA station ridership (data.cityofchicago.org)…');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('empty ridership response');
  ridershipByStationId = new Map(
    rows
      .map((r) => [r.station_id, parseFloat(r.avg_rides)])
      .filter(([, v]) => Number.isFinite(v))
  );
  console.log(`  matched ${ridershipByStationId.size} stations with ridership rows`);
} catch (err) {
  console.warn(`WARNING: ridership fetch/parse failed (${err.message}); falling back to a Loop-vs-outlying proxy weight. Real per-station ridership will not be reflected.`);
}

const inLoopBbox = ([lon, lat]) =>
  lat >= LOOP_BBOX.minLat && lat <= LOOP_BBOX.maxLat &&
  lon >= LOOP_BBOX.minLon && lon <= LOOP_BBOX.maxLon;

let matched = 0;
let unmatched = 0;
const rideValues = ridershipByStationId ? [...ridershipByStationId.values()] : [];
const minRide = rideValues.length ? Math.min(...rideValues) : 0;
const maxRide = rideValues.length ? Math.max(...rideValues) : 1;

const stationsOut = {};
for (const [id, s] of stations) {
  let weight;
  let rides = null;
  if (ridershipByStationId) {
    rides = ridershipByStationId.get(id) ?? null;
    if (rides == null) {
      weight = WEIGHT_FLOOR; // no ridership row for this station → floor, never NaN/dropped
      unmatched++;
    } else {
      const span = maxRide - minRide;
      const norm = span > 0 ? (rides - minRide) / span : 1;
      weight = WEIGHT_FLOOR + norm * (WEIGHT_CEIL - WEIGHT_FLOOR);
      matched++;
    }
  } else {
    // Fallback proxy (only reached if the API fetch above failed outright):
    // Loop stations blaze, everything else is a uniform ember. Documented
    // in the WARNING above and here so this never looks like real data.
    weight = inLoopBbox(s.coords) ? WEIGHT_CEIL : WEIGHT_FLOOR + 0.25 * (WEIGHT_CEIL - WEIGHT_FLOOR);
  }
  stationsOut[id] = {
    id,
    name: s.name,
    coords: s.coords,
    lines: L_ROUTES.filter((r) => s.lines.has(r)), // stable order for color priority
    weight: Number(weight.toFixed(4)),
    rides,
  };
}
if (ridershipByStationId) {
  console.log(`  ${matched} stations weighted from ridership, ${unmatched} fell back to the floor weight`);
}

writeFileSync(STATIONS_OUT, JSON.stringify(stationsOut));
console.log(`Wrote ${STATIONS_OUT} (${(readFileSync(STATIONS_OUT).length / 1024).toFixed(0)} KB)`);
if (!existsSync(STATIONS_OUT)) process.exit(1);
