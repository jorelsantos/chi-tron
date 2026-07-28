#!/usr/bin/env node
// One-time (re-runnable) track builder: CTA static GTFS → public/data/tracks.json
// Per L line: the longest shape (= full-line run, skips short-turn variants),
// deduped, with cumulative distances in meters.

import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GTFS_URL = 'https://www.transitchicago.com/downloads/sch_data/google_transit.zip';
const L_ROUTES = ['Red', 'Blue', 'Brn', 'G', 'Org', 'P', 'Pink', 'Y'];
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/data/tracks.json');

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
execSync(`unzip -o -q "${zip}" trips.txt shapes.txt -d "${work}"`);

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
