#!/usr/bin/env node
// Build downtown Chicago building extrusions from City of Chicago open data.
// Source: Building Footprints dataset syp8-uezg (stories + the_geom MultiPolygon).
// https://data.cityofchicago.org/Buildings/Building-Footprints/syp8-uezg
//
// Emits compact public/data/buildings.json for MapLibre fill-extrusion.
// Height_m = stories * STORY_M; missing stories → FLOOR_HEIGHT_M.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/data/buildings.json');
const DATASET = 'syp8-uezg';
const STORY_M = 3.2;
const FLOOR_HEIGHT_M = 8;
const MAX_HEIGHT_M = 550; // Willis-scale cap against bad rows
const MAX_BYTES = 4 * 1024 * 1024; // 4 MB hard ceiling
const PAGE = 50000;

// Loop core bbox sized for LOOP_PRESET framing (lat N, lon W, lat S, lon E).
// Kept tight so simplified GeoJSON stays under MAX_BYTES.
const BBOX = { north: 41.91, west: -87.655, south: 41.86, east: -87.605 };

function simplifyRing(ring, step = 3) {
  if (ring.length <= 5) return ring;
  const out = [];
  for (let i = 0; i < ring.length - 1; i += step) {
    const [lon, lat] = ring[i];
    out.push([Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4]);
  }
  const last = ring[ring.length - 1];
  out.push([Math.round(last[0] * 1e4) / 1e4, Math.round(last[1] * 1e4) / 1e4]);
  // close ring
  if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) {
    out.push(out[0]);
  }
  return out;
}

function heightFromRow(row) {
  const stories = Number(row.stories ?? row.no_stories);
  if (Number.isFinite(stories) && stories > 0) {
    return Math.min(MAX_HEIGHT_M, Math.max(FLOOR_HEIGHT_M, stories * STORY_M));
  }
  return FLOOR_HEIGHT_M;
}

function toFeature(row) {
  const g = row.the_geom;
  if (!g || g.type !== 'MultiPolygon' || !g.coordinates?.[0]?.[0]) return null;
  const exterior = g.coordinates[0][0];
  if (exterior.length < 4) return null;
  const ring = simplifyRing(exterior, 2);
  if (ring.length < 4) return null;
  return {
    type: 'Feature',
    properties: { h: Math.round(heightFromRow(row) * 10) / 10 },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

async function fetchPage(offset) {
  const where = encodeURIComponent(
    `within_box(the_geom,${BBOX.north},${BBOX.west},${BBOX.south},${BBOX.east})`
  );
  const url =
    `https://data.cityofchicago.org/resource/${DATASET}.json` +
    `?$where=${where}&$select=the_geom,stories,no_stories&$limit=${PAGE}&$offset=${offset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SODA HTTP ${res.status}: ${url}`);
  return res.json();
}

console.log('Fetching Chicago Building Footprints (downtown bbox)…');
const features = [];
let offset = 0;
for (;;) {
  const rows = await fetchPage(offset);
  if (!rows.length) break;
  for (const row of rows) {
    const f = toFeature(row);
    if (f) features.push(f);
  }
  console.log(`  offset ${offset}: +${rows.length} rows → ${features.length} features`);
  if (rows.length < PAGE) break;
  offset += PAGE;
}

const fc = { type: 'FeatureCollection', features };
const json = JSON.stringify(fc);
if (json.length > MAX_BYTES) {
  console.error(`FAIL: buildings.json ${json.length} bytes > ${MAX_BYTES} ceiling — shrink bbox`);
  process.exit(1);
}

writeFileSync(OUT, json);
const heights = features.map((f) => f.properties.h);
const maxH = Math.max(...heights);
const meanH = heights.reduce((a, b) => a + b, 0) / heights.length;
console.log(
  `Wrote ${OUT}\n  features=${features.length} bytes=${json.length} maxH=${maxH.toFixed(0)}m meanH=${meanH.toFixed(1)}m`
);
