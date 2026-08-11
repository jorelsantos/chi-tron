import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBusData, EMPTY_PATTERNS } from './bus-data.js';

const BUS_ROUTES = {
  routes: [
    { rt: '8', name: 'Halsted' },
    { rt: '62', name: 'Archer' },
    { rt: '999', name: 'Browse Only' },
  ],
  mapLive: ['8', '62'],
};

const PATTERNS = {
  routes: { 8: ['p8'], 62: ['p62'] },
  patterns: {
    p8: { pt: [{ lat: 41.8, lon: -87.6, pdist: 0 }, { lat: 41.9, lon: -87.6, pdist: 100 }] },
    p62: { pt: [{ lat: 41.8, lon: -87.7, pdist: 0 }, { lat: 41.8, lon: -87.6, pdist: 100 }] },
  },
  // Browse data covers routes beyond the mapLive marquee, on purpose.
  routeDirections: {
    8: [{ rtdir: 'Northbound', stops: [{ stpid: '1', name: 'A' }] }],
    62: [{ rtdir: 'Eastbound', stops: [{ stpid: '2', name: 'B' }] }],
    999: [{ rtdir: 'Westbound', stops: [{ stpid: '3', name: 'C' }] }],
  },
};

/** Minimal fetch double keyed by path. */
function fakeFetch(map) {
  return vi.fn(async (path) => {
    if (!(path in map)) return { ok: false, status: 404, json: async () => ({}) };
    const entry = map[path];
    if (entry instanceof Error) throw entry;
    return { ok: true, status: 200, json: async () => entry };
  });
}

const HAPPY = {
  '/data/bus-routes.json': BUS_ROUTES,
  '/data/patterns.json': PATTERNS,
};

let warn;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('createBusData', () => {
  it('starts idle and fetches nothing until asked', () => {
    const fetchImpl = fakeFetch(HAPPY);
    const bus = createBusData({ fetchImpl });
    expect(bus.status).toBe('idle');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exposes safe empty values before loading, so callers never guard', () => {
    const bus = createBusData({ fetchImpl: fakeFetch(HAPPY) });
    expect(bus.patterns).toEqual(EMPTY_PATTERNS);
    expect(bus.boardRoutes).toEqual([]);
    expect(bus.catalog).toEqual({});
    expect(bus.feedReady).toBe(false);
    expect(bus.mapReady).toBe(false);
  });

  it('becomes ready and populates catalog, patterns and board routes', async () => {
    const bus = createBusData({ fetchImpl: fakeFetch(HAPPY) });
    await bus.ensureLoaded();
    expect(bus.status).toBe('ready');
    expect(bus.catalog).toHaveLength(3);
    expect(bus.feedReady).toBe(true);
    expect(bus.mapReady).toBe(true);
  });

  it('filters map patterns to the mapLive marquee only', async () => {
    const bus = createBusData({ fetchImpl: fakeFetch(HAPPY) });
    await bus.ensureLoaded();
    expect(Object.keys(bus.patterns.routes).sort()).toEqual(['62', '8']);
  });

  it('keeps browse directions for routes outside the marquee', async () => {
    // The whole point of the hybrid bake: 999 has no map polyline but must
    // still be browsable. A filter that dropped it would silently shrink the
    // tracker from ~126 routes to ~21.
    const bus = createBusData({ fetchImpl: fakeFetch(HAPPY) });
    await bus.ensureLoaded();
    expect(bus.patterns.routeDirections['999']).toBeDefined();
    expect(bus.boardRoutes.map((r) => r.rt)).toContain('999');
  });

  it('loads both files in one parallel pass', async () => {
    const fetchImpl = fakeFetch(HAPPY);
    const bus = createBusData({ fetchImpl });
    await bus.ensureLoaded();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((c) => c[0]).sort()).toEqual([
      '/data/bus-routes.json',
      '/data/patterns.json',
    ]);
  });

  it('dedupes concurrent callers onto one in-flight load', async () => {
    const fetchImpl = fakeFetch(HAPPY);
    const bus = createBusData({ fetchImpl });
    // The map's idle handler and a user tapping Bus race routinely.
    const [a, b] = await Promise.all([bus.ensureLoaded(), bus.ensureLoaded()]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 2 files, not 4
  });

  it('does not refetch after it is already ready', async () => {
    const fetchImpl = fakeFetch(HAPPY);
    const bus = createBusData({ fetchImpl });
    await bus.ensureLoaded();
    await bus.ensureLoaded();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports every transition through onChange', async () => {
    const seen = [];
    const bus = createBusData({
      fetchImpl: fakeFetch(HAPPY),
      onChange: (d) => seen.push(d.status),
    });
    await bus.ensureLoaded();
    expect(seen).toEqual(['loading', 'ready']);
  });

  it('fails soft when patterns.json is missing — trains must keep working', async () => {
    const bus = createBusData({
      fetchImpl: fakeFetch({ '/data/bus-routes.json': BUS_ROUTES }),
    });
    await bus.ensureLoaded();
    expect(bus.status).toBe('failed');
    expect(bus.feedReady).toBe(false);
    expect(bus.mapReady).toBe(false);
    expect(bus.patterns.routes).toEqual({});
  });

  it('fails soft when the network throws outright', async () => {
    const bus = createBusData({
      fetchImpl: fakeFetch({
        '/data/bus-routes.json': new Error('offline'),
        '/data/patterns.json': new Error('offline'),
      }),
    });
    await expect(bus.ensureLoaded()).resolves.toBeDefined();
    expect(bus.status).toBe('failed');
  });

  it('still browses when only the map polylines are missing', async () => {
    // Directions present, per-pattern geometry absent: boards work, map does not.
    const bus = createBusData({
      fetchImpl: fakeFetch({
        '/data/bus-routes.json': BUS_ROUTES,
        '/data/patterns.json': { routeDirections: PATTERNS.routeDirections },
      }),
    });
    await bus.ensureLoaded();
    expect(bus.status).toBe('ready');
    expect(bus.feedReady).toBe(true);
    expect(bus.mapReady).toBe(false);
  });
});
