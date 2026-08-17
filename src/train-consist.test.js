import { describe, it, expect } from 'vitest';
import { mPerDegLon, M_PER_DEG_LAT } from './tracks.js';
import { CONSIST, consistLayout, consistModel, gapMeters, pointAlongConsist, alignTrainToRibbon } from './train-consist.js';

function distM(a, b) {
  const lat = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) * mPerDegLon(lat);
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

const headingNorth = {
  id: 'Red-123',
  line: 'Red',
  destNm: 'Howard',
  rn: '123',
  pos: [-87.63, 41.88],
  heading: 0,
  trail: [{ lon: -87.63, lat: 41.88, t: 0 }],
};

describe('consistLayout', () => {
  it('keeps three cars and two gaps inside ~70 m', () => {
    const L = consistLayout(1);
    expect(L.leadFront - L.tailBack).toBeLessThan(80);
    expect(L.leadFront - L.leadBack).toBeCloseTo(CONSIST.leadM, 5);
    expect(L.midFront - L.midBack).toBeCloseTo(CONSIST.carM, 5);
    expect(L.leadBack - L.midFront).toBeCloseTo(CONSIST.gapM, 5);
  });
});

describe('consistModel', () => {
  it('returns three cars with string ids and a hot lead', () => {
    const m = consistModel(headingNorth, 10);
    expect(m.cars).toHaveLength(3);
    expect(m.couplers).toHaveLength(2);
    expect(m.cars.map((c) => c.role)).toEqual(['lead', 'mid', 'tail']);
    expect(m.cars.every((c) => typeof c.id === 'string')).toBe(true);
    expect(m.cars.every((c) => typeof c.carId === 'string')).toBe(true);
    expect(m.cars[0].hot).toBe(true);
    expect(m.cars[1].hot).toBe(false);
    expect(m.cars[2].hot).toBe(false);
    expect(m.cars[0].id).toBe('Red-123');
  });

  it('leaves a measurable gap between cars', () => {
    const m = consistModel(headingNorth, 10);
    const g1 = gapMeters(m.cars[0].path[1], m.cars[1].path[0]);
    const g2 = gapMeters(m.cars[1].path[1], m.cars[2].path[0]);
    expect(g1).toBeGreaterThan(2);
    expect(g2).toBeGreaterThan(2);
  });

  it('lays cars behind the head on a heading fallback', () => {
    const m = consistModel(headingNorth, 10);
    const head = headingNorth.pos;
    expect(m.cars[0].path[0][1]).toBeGreaterThan(head[1]);
    expect(m.cars[2].path[1][1]).toBeLessThan(head[1]);
  });

  it('bends the consist when the trail turns a corner', () => {
    const train = {
      id: 'Org-9',
      line: 'Org',
      pos: [-87.626, 41.882],
      heading: 0,
      trail: [
        { lon: -87.628, lat: 41.8817, t: 0 },
        { lon: -87.626, lat: 41.8817, t: 4 },
        { lon: -87.626, lat: 41.882, t: 8 },
      ],
    };
    const tail = pointAlongConsist(train, consistLayout().tailBack);
    expect(tail[0]).toBeLessThan(train.pos[0] - 0.00005);
    const m = consistModel(train, 8);
    expect(m.trail.path.length).toBeGreaterThanOrEqual(2);
    const last = m.trail.path[m.trail.path.length - 1];
    expect(distM(last, m.cars[2].path[1])).toBeLessThan(2);
  });

  it('shifts a Pink train onto the inward ribbon at Loop zoom', () => {
    const train = {
      id: 'Pink-1',
      line: 'Pink',
      pos: [-87.6262, 41.882],
      heading: 0,
      trail: [{ lon: -87.6262, lat: 41.882, t: 0 }],
    };
    const a = alignTrainToRibbon(train, 14);
    expect(a.pos[0]).toBeLessThan(train.pos[0]);
    expect(a.trail[0].lon).toBeLessThan(train.trail[0].lon);
    const red = alignTrainToRibbon({ ...train, id: 'Red-1', line: 'Red' }, 14);
    expect(red.pos[0]).toBeCloseTo(train.pos[0], 6);
    const city = alignTrainToRibbon(train, 11);
    expect(city.pos).toEqual(train.pos);
  });

  it('starts the render trail at the tail, not the nose', () => {
    const train = {
      ...headingNorth,
      trail: [
        { lon: -87.63, lat: 41.8792, t: 0 },
        { lon: -87.63, lat: 41.8796, t: 3 },
        { lon: -87.63, lat: 41.88, t: 6 },
      ],
    };
    const m = consistModel(train, 6);
    const last = m.trail.path[m.trail.path.length - 1];
    expect(distM(last, m.cars[2].path[1])).toBeLessThan(3);
    expect(last[1]).toBeLessThan(train.pos[1] - 0.0002);
  });
});
