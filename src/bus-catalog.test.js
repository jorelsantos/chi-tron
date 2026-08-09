import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  liveBusRouteIds,
  mapLiveBusRouteIds,
  filterPatternsToRoutes,
  directionsForRoute,
  stopsForRoute,
  busRouteDef,
  normalizeBusCatalog,
  searchBusRoutes,
  sortBusRoutes,
  routesWithDirections,
  MARQUEE_ROUTES,
} from './bus-catalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const patterns = JSON.parse(readFileSync(join(ROOT, 'public/data/patterns.json'), 'utf8'));
const catalogPath = join(ROOT, 'public/data/bus-routes.json');
const catalogRaw = existsSync(catalogPath)
  ? JSON.parse(readFileSync(catalogPath, 'utf8'))
  : null;

describe('bus-catalog', () => {
  const catalog = normalizeBusCatalog(catalogRaw);

  it('normalizeBusCatalog yields live routes', () => {
    expect(catalog.length).toBeGreaterThanOrEqual(2);
    expect(liveBusRouteIds(catalog).length).toBeGreaterThanOrEqual(2);
  });

  it('mapLive is a bounded marquee subset (budget)', () => {
    const mapIds = mapLiveBusRouteIds(catalog);
    expect(mapIds.length).toBeGreaterThanOrEqual(2);
    expect(mapIds.length).toBeLessThanOrEqual(MARQUEE_ROUTES.length + 2);
    expect(mapIds).toContain('8');
    expect(mapIds).toContain('62');
    // Must not poll entire CTA network
    expect(mapIds.length).toBeLessThan(40);
  });

  it('filterPatternsToRoutes keeps all routeDirections but only mapLive polylines', () => {
    const mapIds = mapLiveBusRouteIds(catalog);
    const filtered = filterPatternsToRoutes(patterns, mapIds);
    expect(Object.keys(filtered.routes).every((rt) => mapIds.includes(rt))).toBe(true);
    expect(Object.keys(filtered.patterns).length).toBeGreaterThan(0);
    // Tracker data for non-map routes still present when baked
    const dirCount = Object.keys(filtered.routeDirections || {}).length;
    expect(dirCount).toBeGreaterThanOrEqual(mapIds.length);
  });

  it('8/62 directions still CTA-style with dual Throop stpids', () => {
    const d62 = directionsForRoute(patterns, '62');
    expect(d62.map((d) => d.rtdir).sort()).toEqual(['Northbound', 'Southbound']);
    const nb = stopsForRoute(patterns, '62', 'Northbound');
    const sb = stopsForRoute(patterns, '62', 'Southbound');
    const throopNb = nb.find((s) => /Throop/i.test(s.name));
    const throopSb = sb.find((s) => /Throop/i.test(s.name));
    expect(throopNb?.stpid).toBeTruthy();
    expect(throopSb?.stpid).toBeTruthy();
    expect(throopNb.stpid).not.toBe(throopSb.stpid);
  });

  it('searchBusRoutes matches number and name', () => {
    const routes = [
      { rt: '8', name: 'Halsted', live: true },
      { rt: '62', name: 'Archer', live: true },
      { rt: '22', name: 'Clark', live: true },
    ];
    expect(searchBusRoutes(routes, '62').map((r) => r.rt)).toEqual(['62']);
    expect(searchBusRoutes(routes, 'hal').map((r) => r.rt)).toEqual(['8']);
    expect(sortBusRoutes([{ rt: '22' }, { rt: '3' }, { rt: 'X9' }]).map((r) => r.rt)).toEqual([
      '3',
      '22',
      'X9',
    ]);
  });

  it('busRouteDef resolves from catalog', () => {
    expect(busRouteDef(catalog, '8')?.name).toMatch(/Halsted/i);
    expect(busRouteDef(catalog, '62')?.name).toMatch(/Archer/i);
  });

  it('full network bake: most routes have directions (when bus-routes.json present)', () => {
    if (!catalogRaw) return; // skip until first full bake
    const board = routesWithDirections(patterns, catalog);
    expect(board.length).toBeGreaterThan(50);
    expect(Object.keys(patterns.routeDirections || {}).length).toBeGreaterThan(50);
  });

  it('non-mapLive stop lists are along-route (not alphabetical)', () => {
    // Route 12 is mapLive? no — in marquee? MARQUEE has no 12. Pattern order.
    const dirs = directionsForRoute(patterns, '12');
    expect(dirs.length).toBeGreaterThanOrEqual(1);
    const stops = dirs[0].stops;
    expect(stops.length).toBeGreaterThan(10);
    // pdist should be non-decreasing along pattern sequence
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i].pdist).toBeGreaterThanOrEqual(stops[i - 1].pdist);
    }
    // Not pure A–Z by name (getstops bug)
    const names = stops.map((s) => s.name);
    const alpha = [...names].sort((a, b) => a.localeCompare(b));
    const sameAsAlpha = names.every((n, i) => n === alpha[i]);
    expect(sameAsAlpha).toBe(false);
  });
});
