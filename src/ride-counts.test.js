import { describe, expect, it } from 'vitest';
import { ridesInView } from './ride-counts.js';

describe('ridesInView', () => {
  it('counts two trains, one bus, and three docks, and a missing bake is null', () => {
    const inBounds = (pos) =>
      pos[0] >= -87.7 && pos[0] <= -87.6 && pos[1] >= 41.84 && pos[1] <= 41.91;
    const trains = [
      { pos: [-87.65, 41.88], line: 'Red', state: 'moving' },
      { pos: [-87.64, 41.89], line: 'Blue', state: 'moving' },
    ];
    const buses = [{ pos: [-87.66, 41.87], state: 'moving' }];
    const docks = [
      { lon: -87.63, lat: 41.86 },
      { lon: -87.62, lat: 41.9 },
      { pos: [-87.61, 41.85] },
    ];
    const visibleLines = new Set(['Red', 'Blue']);
    const input = { trains, buses, docks, inBounds, visibleLines };

    expect(ridesInView({ ...input, bikeReady: true })).toEqual({ trains: 2, buses: 1, bikes: 3 });
    expect(ridesInView({ ...input, bikeReady: false })).toEqual({ trains: 2, buses: 1, bikes: null });

    expect(
      ridesInView({
        ...input,
        trains: [
          ...trains,
          { pos: [-87.9, 41.88], line: 'Red' },
          { pos: [-87.65, 41.88], line: 'Pink' },
        ],
        buses: [...buses, { pos: [-88.1, 41.88] }, { pos: [-87.65, 41.88], state: 'removed' }],
        docks: [...docks, { lon: -88.2, lat: 41.88 }],
        bikeReady: true,
      }),
    ).toEqual({ trains: 2, buses: 1, bikes: 3 });
  });
});
