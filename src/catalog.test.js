import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { orgStationsOrdered, searchStations } from './catalog.js';
import { snapStationsToRails } from './stations-rail.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('catalog', () => {
  let ordered;

  beforeAll(() => {
    const tracks = JSON.parse(readFileSync(join(ROOT, 'public/data/tracks.json'), 'utf8'));
    const raw = JSON.parse(readFileSync(join(ROOT, 'public/data/stations.json'), 'utf8'));
    const snapped = snapStationsToRails(tracks, raw);
    ordered = orgStationsOrdered(snapped);
  });

  it('orders Orange stations Midway-first along the rail', () => {
    expect(ordered.length).toBeGreaterThan(10);
    expect(ordered[0].name.toLowerCase()).toContain('midway');
    const names = ordered.map((s) => s.name);
    const hal = names.findIndex((n) => /halsted/i.test(n));
    const ash = names.findIndex((n) => /ashland/i.test(n));
    expect(hal).toBeGreaterThan(-1);
    expect(ash).toBeGreaterThan(-1);
    // Ashland is Midway-side of Halsted on Org (smaller railDist from Midway)
    expect(ash).toBeLessThan(hal);
  });

  it('searchStations finds Halsted by prefix', () => {
    const hits = searchStations(ordered, 'hal');
    expect(hits.some((s) => /halsted/i.test(s.name))).toBe(true);
  });

  it('searchStations returns empty for blank query', () => {
    expect(searchStations(ordered, '  ')).toEqual([]);
  });
});
