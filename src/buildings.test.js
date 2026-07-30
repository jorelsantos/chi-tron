// Data-shape tests for public/data/buildings.json (Phase B real skyline).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { ILLINOIS_BOUNDS, ILLINOIS_MIN_ZOOM } from './style.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATH = join(ROOT, 'public/data/buildings.json');

// Downtown bake bbox from scripts/build-buildings.mjs
const BBOX = { north: 41.91, west: -87.655, south: 41.86, east: -87.605 };

describe('buildings.json (Phase B)', () => {
  let fc;

  beforeAll(() => {
    if (!existsSync(PATH)) {
      throw new Error('public/data/buildings.json missing — run npm run buildings');
    }
    fc = JSON.parse(readFileSync(PATH, 'utf8'));
  });

  it('is a FeatureCollection with a meaningful feature count', () => {
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features.length).toBeGreaterThan(1000);
  });

  it('keeps heights finite, floored, and capped', () => {
    for (const f of fc.features) {
      const h = f.properties?.h;
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(8);
      expect(h).toBeLessThanOrEqual(550);
    }
  });

  it('keeps all coordinates inside the downtown bake bbox', () => {
    for (const f of fc.features) {
      const ring = f.geometry?.coordinates?.[0];
      expect(ring?.length).toBeGreaterThanOrEqual(4);
      for (const [lon, lat] of ring) {
        expect(lat).toBeGreaterThanOrEqual(BBOX.south - 0.01);
        expect(lat).toBeLessThanOrEqual(BBOX.north + 0.01);
        expect(lon).toBeGreaterThanOrEqual(BBOX.west - 0.01);
        expect(lon).toBeLessThanOrEqual(BBOX.east + 0.01);
      }
    }
  });

  it('includes at least one tall tower (stories-derived height)', () => {
    const maxH = Math.max(...fc.features.map((f) => f.properties.h));
    expect(maxH).toBeGreaterThan(100); // > ~30 stories
  });
});

describe('Illinois camera stop (Phase C)', () => {
  it('exports a valid Illinois maxBounds rectangle', () => {
    const [[w, s], [e, n]] = ILLINOIS_BOUNDS;
    expect(w).toBeLessThan(e);
    expect(s).toBeLessThan(n);
    // Rough Illinois envelope
    expect(w).toBeLessThan(-87);
    expect(e).toBeGreaterThan(-91);
    expect(s).toBeLessThan(38);
    expect(n).toBeGreaterThan(42);
  });

  it('sets min zoom above national / multi-state scale', () => {
    expect(ILLINOIS_MIN_ZOOM).toBeGreaterThanOrEqual(5.5);
    expect(ILLINOIS_MIN_ZOOM).toBeLessThan(10);
  });
});
