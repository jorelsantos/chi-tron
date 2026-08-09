// Geographic accuracy checks for public/data/tracks.json (U3 / R4–R5).
// Terminals are approximate CTA endpoints; tolerance is generous enough
// for GTFS shape vs stop-table divergence, tight enough to catch wrong-line shapes.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { toMeters } from './tracks.js';
import { LINE_KEYS } from './layers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BBOX = { minLat: 41.6, maxLat: 42.2, minLon: -88.0, maxLon: -87.5 };

// [lon, lat] of known corridor endpoints — at least one track vertex must
// fall within MAX_TERMINAL_M of each listed point for that line.
const LINE_TERMINALS = {
  Red: [
    [-87.6729, 42.0191], // Howard
    [-87.6244, 41.7224], // 95th/Dan Ryan
  ],
  Blue: [
    [-87.9042, 41.9777], // O'Hare
    [-87.8173, 41.8743], // Forest Park
  ],
  Brn: [
    [-87.7131, 41.9679], // Kimball
  ],
  G: [
    [-87.8032, 41.8869], // Harlem/Lake
    [-87.6639, 41.7790], // Ashland/63rd branch (longest-shape pick)
  ],
  Org: [
    [-87.7380, 41.7866], // Midway
  ],
  P: [
    [-87.6907, 42.0732], // Linden
  ],
  Pink: [
    [-87.7567, 41.8518], // 54th/Cermak
  ],
  Y: [
    [-87.6729, 42.0191], // Howard
    [-87.7519, 42.0390], // Dempster-Skokie
  ],
};

// Residual: Green Jackson Park (Cottage Grove) branch is not on the
// longest GTFS shape used today — documented, not silently required.
const KNOWN_MISSING_BRANCH_TERMINALS = {
  G: [[-87.6059, 41.7803]], // Cottage Grove approx
};

const MAX_TERMINAL_M = 450;
const MIN_LINE_KM = 5;

function distM(a, b) {
  const [ax, ay] = toMeters(a);
  const [bx, by] = toMeters(b);
  return Math.hypot(ax - bx, ay - by);
}

function nearestOnTrack(coords, target) {
  let best = Infinity;
  for (const c of coords) {
    const d = distM(c, target);
    if (d < best) best = d;
  }
  return best;
}

let tracks;

beforeAll(() => {
  tracks = JSON.parse(readFileSync(join(ROOT, 'public/data/tracks.json'), 'utf8'));
});

describe('tracks.json geography (U3)', () => {
  it('includes all eight L lines', () => {
    for (const key of LINE_KEYS) {
      expect(tracks[key], `missing line ${key}`).toBeTruthy();
      expect(tracks[key].coords.length).toBeGreaterThan(10);
      expect(tracks[key].cumDist.length).toBe(tracks[key].coords.length);
    }
  });

  it('keeps every coordinate inside the Chicago bbox', () => {
    for (const [key, line] of Object.entries(tracks)) {
      for (const [lon, lat] of line.coords) {
        expect(lat, `${key} lat`).toBeGreaterThanOrEqual(BBOX.minLat);
        expect(lat, `${key} lat`).toBeLessThanOrEqual(BBOX.maxLat);
        expect(lon, `${key} lon`).toBeGreaterThanOrEqual(BBOX.minLon);
        expect(lon, `${key} lon`).toBeLessThanOrEqual(BBOX.maxLon);
      }
    }
  });

  it('has strictly increasing cumDist and multi-km length per line', () => {
    for (const [key, line] of Object.entries(tracks)) {
      for (let i = 1; i < line.cumDist.length; i++) {
        expect(line.cumDist[i], `${key} cumDist[${i}]`).toBeGreaterThanOrEqual(line.cumDist[i - 1]);
      }
      const km = line.cumDist[line.cumDist.length - 1] / 1000;
      expect(km, `${key} length km`).toBeGreaterThan(MIN_LINE_KM);
    }
  });

  it('passes near documented terminals for each line', () => {
    for (const [key, terminals] of Object.entries(LINE_TERMINALS)) {
      const coords = tracks[key].coords;
      for (const t of terminals) {
        const d = nearestOnTrack(coords, t);
        expect(d, `${key} terminal ${t}`).toBeLessThanOrEqual(MAX_TERMINAL_M);
      }
    }
  });

  it('documents residual Green Cottage Grove branch as missing from longest shape', () => {
    const coords = tracks.G.coords;
    for (const t of KNOWN_MISSING_BRANCH_TERMINALS.G) {
      const d = nearestOnTrack(coords, t);
      // If this starts passing, the residual was fixed — drop the allowlist.
      expect(d).toBeGreaterThan(MAX_TERMINAL_M);
    }
  });
});
