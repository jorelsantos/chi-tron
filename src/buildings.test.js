// Data-shape tests for public/data/buildings.json (OSM shapes × City heights).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { CHICAGOLAND_BOUNDS, CHICAGOLAND_MIN_ZOOM } from './style.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATH = join(ROOT, 'public/data/buildings.json');

// Downtown bake bbox from scripts/build-buildings.mjs
const BBOX = { south: 41.85, west: -87.67, north: 41.93, east: -87.59 };
// Willis Tower approximate location
const WILLIS = { lon: -87.6359, lat: 41.8789 };

describe('buildings.json (OSM × City heights)', () => {
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
      expect(h).toBeGreaterThanOrEqual(12);
      expect(h).toBeLessThanOrEqual(550);
    }
  });

  it('keeps all coordinates inside the downtown bake bbox', () => {
    for (const f of fc.features) {
      const ring = f.geometry?.coordinates?.[0];
      expect(ring?.length).toBeGreaterThanOrEqual(4);
      for (const [lon, lat] of ring) {
        expect(lat).toBeGreaterThanOrEqual(BBOX.south - 0.02);
        expect(lat).toBeLessThanOrEqual(BBOX.north + 0.02);
        expect(lon).toBeGreaterThanOrEqual(BBOX.west - 0.02);
        expect(lon).toBeLessThanOrEqual(BBOX.east + 0.02);
      }
    }
  });

  it('includes at least one tall tower (stories-derived height)', () => {
    const maxH = Math.max(...fc.features.map((f) => f.properties.h));
    expect(maxH).toBeGreaterThan(100); // > ~30 stories
  });

  it('has Willis-scale height near Willis Tower', () => {
    // Features whose centroid is within ~250m of Willis
    const near = fc.features.filter((f) => {
      const ring = f.geometry?.coordinates?.[0];
      if (!ring?.length) return false;
      let sx = 0;
      let sy = 0;
      let n = ring.length;
      if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n -= 1;
      for (let i = 0; i < n; i++) {
        sx += ring[i][0];
        sy += ring[i][1];
      }
      const cx = sx / n;
      const cy = sy / n;
      return Math.hypot(cx - WILLIS.lon, cy - WILLIS.lat) < 0.003;
    });
    expect(near.length).toBeGreaterThan(0);
    const maxNear = Math.max(...near.map((f) => f.properties.h));
    // ~108 stories × 3.2m ≈ 345m; allow join miss / partial multipolygon
    expect(maxNear).toBeGreaterThan(150);
  });

  it('uses realistic footprints (more vertices than a box)', () => {
    // Median ring should not be pure 5-point boxes (city-only lego)
    const lens = fc.features.map((f) => f.geometry?.coordinates?.[0]?.length ?? 0);
    lens.sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)];
    expect(median).toBeGreaterThan(5);
  });
});

describe('Chicagoland camera stop (Phase C)', () => {
  it('exports a valid Chicagoland maxBounds rectangle', () => {
    const [[w, s], [e, n]] = CHICAGOLAND_BOUNDS;
    expect(w).toBeLessThan(e);
    expect(s).toBeLessThan(n);
    // Metro envelope — not full Illinois
    expect(w).toBeGreaterThan(-89);
    expect(w).toBeLessThan(-88);
    expect(e).toBeGreaterThan(-88);
    expect(e).toBeLessThan(-87);
    expect(s).toBeGreaterThan(41);
    expect(n).toBeLessThan(43);
    // Must not stretch to southern Illinois
    expect(s).toBeGreaterThan(40.5);
  });

  it('sets min zoom to metro scale (~8–9)', () => {
    expect(CHICAGOLAND_MIN_ZOOM).toBeGreaterThanOrEqual(8);
    expect(CHICAGOLAND_MIN_ZOOM).toBeLessThanOrEqual(9);
  });
});
