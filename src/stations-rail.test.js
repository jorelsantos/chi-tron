import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { snapStationsToRails, pickSnapLine, diamondRing } from './stations-rail.js';
import { prepareLine, snapToLine } from './tracks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('stations-rail', () => {
  let tracks;
  let stations;

  beforeAll(() => {
    tracks = JSON.parse(readFileSync(join(ROOT, 'public/data/tracks.json'), 'utf8'));
    stations = JSON.parse(readFileSync(join(ROOT, 'public/data/stations.json'), 'utf8'));
  });

  it('prefers Org when present', () => {
    expect(pickSnapLine(['Red', 'Org', 'Brn'])).toBe('Org');
  });

  it('snaps Org stations onto the Org polyline', () => {
    const snapped = snapStationsToRails(tracks, stations);
    const org = prepareLine(tracks.Org);
    const orgStations = Object.values(snapped).filter((s) => s.lines?.includes('Org'));
    expect(orgStations.length).toBeGreaterThan(10);
    for (const s of orgStations) {
      const re = snapToLine(org, s.coords);
      expect(re.offTrack).toBeLessThan(1.5); // on-rail after snap
      expect(s.gtfsCoords).toBeTruthy();
      expect(s.railLine).toBe('Org');
    }
  });

  it('diamondRing returns closed 5-point path', () => {
    const ring = diamondRing([-87.65, 41.85], 10);
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
  });
});
