import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  orgStationsOrdered,
  stationsOrdered,
  searchStations,
  liveRouteCodes,
  browseLinesLive,
  liveStationsUnion,
} from './catalog.js';
import { snapStationsToRails } from './stations-rail.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('catalog', () => {
  let snapped;

  beforeAll(() => {
    const tracks = JSON.parse(readFileSync(join(ROOT, 'public/data/tracks.json'), 'utf8'));
    const raw = JSON.parse(readFileSync(join(ROOT, 'public/data/stations.json'), 'utf8'));
    snapped = snapStationsToRails(tracks, raw);
  });

  it('orders Orange stations Midway-first along the rail', () => {
    const ordered = orgStationsOrdered(snapped);
    expect(ordered.length).toBeGreaterThan(10);
    expect(ordered[0].name.toLowerCase()).toContain('midway');
    const names = ordered.map((s) => s.name);
    const hal = names.findIndex((n) => /halsted/i.test(n));
    const ash = names.findIndex((n) => /ashland/i.test(n));
    expect(hal).toBeGreaterThan(-1);
    expect(ash).toBeGreaterThan(-1);
    expect(ash).toBeLessThan(hal);
  });

  it('orders Red stations along the rail', () => {
    const ordered = stationsOrdered(snapped, 'Red');
    expect(ordered.length).toBeGreaterThan(20);
    expect(ordered.some((s) => /howard/i.test(s.name))).toBe(true);
    expect(ordered.some((s) => /95th|dan ryan/i.test(s.name))).toBe(true);
  });

  it('live routes include all 8 L codes', () => {
    const codes = liveRouteCodes();
    expect(codes).toHaveLength(8);
    for (const rt of ['red', 'blue', 'brn', 'g', 'org', 'p', 'pink', 'y']) {
      expect(codes).toContain(rt);
    }
  });

  it('browseLinesLive returns all eight lines when all live', () => {
    const live = browseLinesLive();
    expect(live).toHaveLength(8);
    expect(live.every((l) => l.live)).toBe(true);
  });

  it('stationsOrdered has stops for every line key', () => {
    for (const key of ['Red', 'Blue', 'Brn', 'G', 'Org', 'P', 'Pink', 'Y']) {
      const n = stationsOrdered(snapped, key).length;
      expect(n, `stations for ${key}`).toBeGreaterThan(0);
    }
  });

  it('liveStationsUnion includes multi-line system stops', () => {
    const u = liveStationsUnion(snapped);
    expect(u.some((s) => s.lines?.includes('Red'))).toBe(true);
    expect(u.some((s) => s.lines?.includes('Blue'))).toBe(true);
    expect(u.some((s) => s.lines?.includes('Org'))).toBe(true);
  });

  it('searchStations finds Halsted by prefix', () => {
    const ordered = orgStationsOrdered(snapped);
    const hits = searchStations(ordered, 'hal');
    expect(hits.some((s) => /halsted/i.test(s.name))).toBe(true);
  });

  it('searchStations returns empty for blank query', () => {
    expect(searchStations(orgStationsOrdered(snapped), '  ')).toEqual([]);
  });
});
