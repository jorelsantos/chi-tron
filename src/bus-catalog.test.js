import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  liveBusRouteIds,
  filterPatternsToRoutes,
  directionsForRoute,
  stopsForRoute,
  busRouteDef,
} from './bus-catalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('bus-catalog', () => {
  const patterns = JSON.parse(readFileSync(join(ROOT, 'public/data/patterns.json'), 'utf8'));

  it('MVP live routes are 8 and 62', () => {
    expect(liveBusRouteIds()).toEqual(['8', '62']);
  });

  it('filterPatternsToRoutes keeps only live routes', () => {
    const filtered = filterPatternsToRoutes(patterns);
    expect(Object.keys(filtered.routes).sort()).toEqual(['62', '8']);
    expect(Object.keys(filtered.patterns).length).toBeGreaterThan(0);
    expect(filtered.routeDirections?.['62']?.length).toBeGreaterThanOrEqual(2);
  });

  it('directionsForRoute is CTA-style Northbound/Southbound for 8 and 62', () => {
    const d8 = directionsForRoute(patterns, '8');
    const d62 = directionsForRoute(patterns, '62');
    expect(d8.map((d) => d.rtdir).sort()).toEqual(['Northbound', 'Southbound']);
    expect(d62.map((d) => d.rtdir).sort()).toEqual(['Northbound', 'Southbound']);
  });

  it('stopsForRoute is per-direction and linear (not mixed terminals)', () => {
    const nb = stopsForRoute(patterns, '62', 'Northbound');
    const sb = stopsForRoute(patterns, '62', 'Southbound');
    expect(nb.length).toBeGreaterThan(50);
    expect(sb.length).toBeGreaterThan(50);
    // Opposite curb / direction → different stpid at same name
    const throopNb = nb.find((s) => /Throop/i.test(s.name));
    const throopSb = sb.find((s) => /Throop/i.test(s.name));
    expect(throopNb?.stpid).toBeTruthy();
    expect(throopSb?.stpid).toBeTruthy();
    expect(throopNb.stpid).not.toBe(throopSb.stpid);
    // Directional order: SB starts Loop-side, ends Neva; NB is reverse-ish
    expect(sb[0].name).toMatch(/Marina|State|Wacker|Dearborn|Clark/i);
    expect(sb[sb.length - 1].name).toMatch(/Neva|Nottingham|Harlem/i);
    expect(nb[0].name).toMatch(/Neva|Nottingham|Harlem/i);
    // Without rtdir, do not dump mixed list when directions exist
    expect(stopsForRoute(patterns, '62')).toEqual([]);
  });

  it('busRouteDef resolves names', () => {
    expect(busRouteDef('8')?.name).toBe('Halsted');
    expect(busRouteDef('62')?.name).toBe('Archer');
  });
});
