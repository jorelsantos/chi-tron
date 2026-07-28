// U9 (R4, R9) — coverage for the pure logic in buses.js: the pdist -> lon/lat
// interpolation (built test-first per the plan's execution note), the
// no-service/unknown-pattern edge cases CTA's getvehicles can hand back, the
// 10-route call split (KTD5), mock mode, and the render-count cap (KTD8).
// No DOM, no real network — matches trains.test.js/poller.test.js's plain-
// Node style.

import { describe, it, expect } from 'vitest';
import {
  BusEngine,
  MARQUEE_ROUTES,
  chunkRoutes,
  extractVehicles,
  isAuthError,
  interpolatePattern,
  capBuses,
} from './buses.js';

// A short 3-point pattern: (0,0) at pdist 0 -> (0,100) at pdist 100 (using
// lon/lat as plain numbers here; interpolatePattern doesn't care that these
// aren't real Chicago coordinates) -> (0,300) at pdist 300.
const PATTERN = {
  pid: 'p1',
  rt: '22',
  points: [
    { lat: 0, lon: 0, pdist: 0 },
    { lat: 100, lon: 0, pdist: 100 },
    { lat: 300, lon: 0, pdist: 300 },
  ],
  totalDist: 300,
};

describe('interpolatePattern', () => {
  it('returns the first point at pdist 0', () => {
    expect(interpolatePattern(PATTERN, 0)).toEqual([0, 0]);
  });

  it('returns the last point at the pattern max pdist', () => {
    expect(interpolatePattern(PATTERN, 300)).toEqual([0, 300]);
  });

  it('linearly interpolates a pdist midway between two points', () => {
    const [lon, lat] = interpolatePattern(PATTERN, 50); // halfway from (0,0) to (0,100)
    expect(lon).toBeCloseTo(0);
    expect(lat).toBeCloseTo(50);
  });

  it('clamps a pdist beyond the pattern length to the final point rather than extrapolating', () => {
    expect(interpolatePattern(PATTERN, 10000)).toEqual([0, 300]);
  });

  it('clamps a negative pdist to the first point', () => {
    expect(interpolatePattern(PATTERN, -50)).toEqual([0, 0]);
  });
});

function makePatternsData() {
  return {
    patterns: {
      p1: PATTERN,
      p2: {
        pid: 'p2',
        rt: '9',
        points: [
          { lat: 10, lon: 10, pdist: 0 },
          { lat: 20, lon: 10, pdist: 500 },
        ],
        totalDist: 500,
      },
    },
    routes: { '22': ['p1'], '9': ['p2'] },
  };
}

describe('BusEngine.ingest — unknown pattern', () => {
  it('skips a vehicle whose pid has no matching entry in the loaded patterns, without throwing', () => {
    const engine = new BusEngine(makePatternsData());
    expect(() =>
      engine.ingest([{ vid: '1', rt: '99', pid: 'no-such-pid', pdist: '10' }])
    ).not.toThrow();
    expect(engine.buses.size).toBe(0);
  });
});

describe('BusEngine.ingest — no-service responses leave prior state intact', () => {
  it('an empty/missing vehicle array does not clear existing buses', () => {
    const engine = new BusEngine(makePatternsData());
    engine.ingest([{ vid: '1', rt: '22', pid: 'p1', pdist: '50' }]);
    expect(engine.buses.size).toBe(1);

    engine.ingest(extractVehicles({ 'bustime-response': {} })); // missing vehicle field
    expect(engine.buses.size).toBe(1);
    expect(engine.buses.get('bus-1').targetDist).toBe(50);

    engine.ingest(extractVehicles({ 'bustime-response': { vehicle: [] } })); // empty array
    expect(engine.buses.size).toBe(1);
  });

  it("CTA's no-service error-object shape extracts to an empty vehicle list, not a crash", () => {
    const noService = { 'bustime-response': { error: [{ msg: 'No data found for parameter' }] } };
    expect(extractVehicles(noService)).toEqual([]);
    expect(isAuthError(noService)).toBe(false); // a benign no-service error, not an auth failure
  });

  it('detects an auth-key error distinctly from a benign no-service error', () => {
    const authErr = { 'bustime-response': { error: [{ msg: 'Invalid API access key supplied' }] } };
    expect(isAuthError(authErr)).toBe(true);
  });
});

describe('chunkRoutes', () => {
  it('splits the marquee route list into calls of at most 10 routes each', () => {
    const chunks = chunkRoutes(MARQUEE_ROUTES);
    expect(MARQUEE_ROUTES.length).toBe(20);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
    expect(chunks.flat()).toEqual(MARQUEE_ROUTES);
  });

  it('handles a list not evenly divisible by the chunk size', () => {
    const chunks = chunkRoutes(['a', 'b', 'c'], 2);
    expect(chunks).toEqual([['a', 'b'], ['c']]);
  });
});

describe('BusEngine.seedMock', () => {
  it('yields buses on multiple routes with zero network calls', () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error('seedMock must never call fetch');
    };
    try {
      const engine = new BusEngine(makePatternsData());
      engine.seedMock(2);
      const buses = engine.tick();
      const routesSeen = new Set(buses.map((b) => b.rt));
      expect(buses.length).toBeGreaterThan(0);
      expect(routesSeen.size).toBeGreaterThanOrEqual(2);
      for (const b of buses) expect(b.pos).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('capBuses', () => {
  it('never returns more than the configured cap', () => {
    const center = [0, 0];
    const buses = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, pos: [i, 0] }));
    const capped = capBuses(buses, center, 4);
    expect(capped.length).toBe(4);
  });

  it('drops the buses furthest from the viewport center first', () => {
    const center = [0, 0];
    const buses = [
      { id: 'near', pos: [1, 0] },
      { id: 'mid', pos: [5, 0] },
      { id: 'far', pos: [100, 0] },
    ];
    const capped = capBuses(buses, center, 2);
    expect(capped.map((b) => b.id).sort()).toEqual(['mid', 'near']);
  });

  it('returns the input unchanged (same buses, no truncation) when already under the cap', () => {
    const buses = [{ id: 'a', pos: [0, 0] }];
    expect(capBuses(buses, [0, 0], 5)).toEqual(buses);
  });
});

describe('BusEngine.clear (U16)', () => {
  it('drops every bus regardless of mock/live origin', () => {
    const engine = new BusEngine({
      patterns: { p1: { pid: 'p1', rt: '22', points: [{ lat: 0, lon: 0, pdist: 0 }, { lat: 1, lon: 0, pdist: 100 }] } },
      routes: { 22: ['p1'] },
    });
    engine.seedMock(1);
    expect(engine.buses.size).toBeGreaterThan(0);
    engine.clear();
    expect(engine.buses.size).toBe(0);
  });
});
