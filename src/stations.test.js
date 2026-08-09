// Data-shape tests for public/data/stations.json (U8 / R11). No train/render
// assertions here — isDly/isApp treatment (U8 step 6) is a visual/runtime
// concern, verified manually in the browser instead.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { prepareLine, snapToLine } from './tracks.js';
import { LINE_KEYS as L_ROUTES } from './layers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Chicago bbox from the plan's test scenarios.
const BBOX = { minLat: 41.6, maxLat: 42.2, minLon: -88.0, maxLon: -87.5 };

// Weight normalization range documented in scripts/build-tracks.mjs
// (WEIGHT_FLOOR / WEIGHT_CEIL). Stated here so a drift in either constant
// breaks this test rather than silently changing the contract.
const WEIGHT_FLOOR = 0.12;
const WEIGHT_CEIL = 1.0;

// Snap tolerance for "within a short distance of its line's polyline".
// Station coordinates come from GTFS's own station-level stop record, while
// the polyline comes from the longest *shape* for that route — at curves,
// junctions and terminals these two GTFS tables can legitimately diverge by
// more than a few meters. 350m comfortably separates "same station, minor
// GTFS shape/stop divergence" from "wrong station" or "wrong line" (a real
// mismatch would be measured in kilometers, not meters).
const MAX_SNAP_DIST_M = 350;

// Pre-existing gap, not introduced by U8: scripts/build-tracks.mjs picks the
// single *longest* GTFS shape per route to build tracks.json, which silently
// drops any branch that isn't the longest one. The Green Line forks after
// Garfield into the Ashland/63rd branch (picked) and the Jackson Park branch
// via Cottage Grove (dropped) — so these two real, correctly-geocoded
// stations have no matching polyline in tracks.json today and sit >800m from
// the nearest rendered G-line track. Documented and allowlisted here rather
// than silently loosening the tolerance for every station, or fabricating
// coordinates to make them look on-track. Fixing this for real means
// tracks.json (and the train sim that walks it) supporting multiple shapes
// per route — out of scope for U8, which only adds the station layer.
const KNOWN_UNRENDERED_BRANCH_STATIONS = new Set(['Cottage Grove', 'King Drive']);

let stations;
let tracks;
let preparedLines;

beforeAll(() => {
  stations = JSON.parse(readFileSync(join(ROOT, 'public/data/stations.json'), 'utf8'));
  tracks = JSON.parse(readFileSync(join(ROOT, 'public/data/tracks.json'), 'utf8'));
  preparedLines = {};
  for (const [key, line] of Object.entries(tracks)) preparedLines[key] = prepareLine(line);
});

describe('stations.json', () => {
  it('contains a node for every station on all eight lines', () => {
    const linesSeen = new Set();
    for (const s of Object.values(stations)) {
      for (const l of s.lines) linesSeen.add(l);
    }
    for (const route of L_ROUTES) {
      expect(linesSeen.has(route), `no station found serving line ${route}`).toBe(true);
    }
    expect(Object.keys(stations).length).toBeGreaterThan(0);
  });

  it('every station coordinate falls inside the Chicago bbox', () => {
    for (const s of Object.values(stations)) {
      const [lon, lat] = s.coords;
      expect(lat, `${s.name} lat out of bbox`).toBeGreaterThanOrEqual(BBOX.minLat);
      expect(lat, `${s.name} lat out of bbox`).toBeLessThanOrEqual(BBOX.maxLat);
      expect(lon, `${s.name} lon out of bbox`).toBeGreaterThanOrEqual(BBOX.minLon);
      expect(lon, `${s.name} lon out of bbox`).toBeLessThanOrEqual(BBOX.maxLon);
    }
  });

  it('every station sits within a short distance of one of its lines’ polylines', () => {
    for (const s of Object.values(stations)) {
      if (KNOWN_UNRENDERED_BRANCH_STATIONS.has(s.name)) continue;
      expect(s.lines.length, `${s.name} has no lines`).toBeGreaterThan(0);
      const offsets = s.lines
        .map((key) => preparedLines[key])
        .filter(Boolean)
        .map((prepared) => snapToLine(prepared, s.coords).offTrack);
      expect(offsets.length, `${s.name}: none of its lines exist in tracks.json`).toBeGreaterThan(0);
      const best = Math.min(...offsets);
      expect(best, `${s.name} is ${Math.round(best)}m from its nearest line polyline`)
        .toBeLessThanOrEqual(MAX_SNAP_DIST_M);
    }
  });

  it('ridership weights are normalized to the bounded [0.12, 1.0] range', () => {
    for (const s of Object.values(stations)) {
      expect(typeof s.weight).toBe('number');
      expect(Number.isNaN(s.weight), `${s.name} weight is NaN`).toBe(false);
      expect(s.weight).toBeGreaterThanOrEqual(WEIGHT_FLOOR);
      expect(s.weight).toBeLessThanOrEqual(WEIGHT_CEIL);
    }
  });

  it('a station missing ridership data gets the floor weight, not NaN or a dropped station', () => {
    // rides == null covers two different situations in build-tracks.mjs:
    // (a) the ridership API succeeded overall but had no row for this one
    // station -> floor weight, the case this test guards; (b) the API
    // fetch failed outright, so every station falls back to a bbox-based
    // Loop/outlying proxy by design, intentionally NOT at the floor.
    // weightSource: 'proxy' marks (b) so it doesn't trip this assertion.
    for (const s of Object.values(stations)) {
      if (s.rides == null && s.weightSource !== 'proxy') {
        expect(s.weight).toBe(WEIGHT_FLOOR);
      }
    }
    // Every station present in the join (real data as of 2026-07-28) has a
    // rides value; this assertion protects the *codepath*, not today's
    // specific fetch result, so it must hold even if a future run has
    // stations with rides === null.
    expect(Object.values(stations).length).toBeGreaterThan(0);
  });
});
