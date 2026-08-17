import { describe, it, expect } from 'vitest';
import { bikeStatusMeta, bikeCountTone, dockCountTone } from './bike-status.js';

describe('bikeStatusMeta', () => {
  it('colors stocked bikes green and free docks orange', () => {
    const parts = bikeStatusMeta({ classic: 5, ebikes: 2, docks: 3, renting: true });
    expect(parts).toEqual([
      { text: '7 BIKES', tone: 'ok' },
      { text: '·', tone: 'dim' },
      { text: '3 DOCKS', tone: 'dock' },
    ]);
  });

  it('colors empty bikes and empty docks red', () => {
    const parts = bikeStatusMeta({ classic: 0, ebikes: 0, docks: 0 });
    expect(parts[0]).toEqual({ text: '0 BIKES', tone: 'bad' });
    expect(parts[2]).toEqual({ text: '0 DOCKS', tone: 'bad' });
  });

  it('shows only NOT RENTING in red when renting is false', () => {
    expect(bikeStatusMeta({ classic: 4, docks: 2, renting: false })).toEqual([
      { text: 'NOT RENTING', tone: 'bad' },
    ]);
  });
});

describe('count tones', () => {
  it('maps bike and dock counts', () => {
    expect(bikeCountTone(1)).toBe('ok');
    expect(bikeCountTone(0)).toBe('bad');
    expect(dockCountTone(2)).toBe('dock');
    expect(dockCountTone(0)).toBe('bad');
  });
});
