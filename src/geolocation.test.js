import { describe, it, expect } from 'vitest';
import { distM, walkMinutes, nearestStation } from './geolocation.js';

describe('geolocation helpers', () => {
  it('distM is ~0 at same point', () => {
    expect(distM([-87.65, 41.85], [-87.65, 41.85])).toBeLessThan(1);
  });

  it('distM Halsted to Ashland is a few km', () => {
    // rough coords from stations.json
    const d = distM([-87.648088, 41.84678], [-87.665317, 41.839234]);
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(5000);
  });

  it('walkMinutes floors to at least 1', () => {
    expect(walkMinutes(10)).toBe(1);
    expect(walkMinutes(240)).toBe(3);
  });

  it('nearestStation picks closest', () => {
    const list = [
      { id: 'a', name: 'A', coords: [-87.65, 41.85] },
      { id: 'b', name: 'B', coords: [-87.66, 41.86] },
    ];
    const n = nearestStation([-87.6501, 41.8501], list);
    expect(n.station.id).toBe('a');
  });
});
