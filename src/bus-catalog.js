// Bus route catalog — factory pattern mirrors LINE_DEFS for trains.
// MVP: live routes 8 (Halsted) + 62 (Archer) only.

export const BUS_ROUTE_DEFS = [
  { rt: '8', name: 'Halsted', live: true },
  { rt: '62', name: 'Archer', live: true },
];

export function liveBusRoutes() {
  return BUS_ROUTE_DEFS.filter((r) => r.live);
}

export function liveBusRouteIds() {
  return liveBusRoutes().map((r) => r.rt);
}

export function busRouteDef(rt) {
  return BUS_ROUTE_DEFS.find((r) => r.rt === String(rt)) || null;
}

/**
 * Filter baked patterns.json to only live MVP routes (map density + poll cost).
 * @param {{ patterns?: object, routes?: object, routeDirections?: object, routeStops?: object }} data
 * @param {string[]} [routeIds]
 */
export function filterPatternsToRoutes(data, routeIds = liveBusRouteIds()) {
  const want = new Set(routeIds.map(String));
  const routes = {};
  const patterns = {};
  const routeDirections = {};
  const routeStops = {};
  for (const rt of want) {
    const pids = data?.routes?.[rt];
    if (!pids?.length) continue;
    routes[rt] = pids;
    for (const pid of pids) {
      if (data.patterns?.[pid]) patterns[pid] = data.patterns[pid];
    }
    if (data.routeDirections?.[rt]) routeDirections[rt] = data.routeDirections[rt];
    if (data.routeStops?.[rt]) routeStops[rt] = data.routeStops[rt];
  }
  return { patterns, routes, routeDirections, routeStops };
}

/**
 * CTA-style travel directions for a route (Northbound / Southbound / …).
 * @param {{ routeDirections?: Record<string, { rtdir: string, pid?: string, stops: object[] }[]> }} patternsData
 * @param {string} rt
 * @returns {{ rtdir: string, pid?: string, stops: object[] }[]}
 */
export function directionsForRoute(patternsData, rt) {
  const list = patternsData?.routeDirections?.[String(rt)];
  return Array.isArray(list) ? list : [];
}

/**
 * Ordered stops for one direction of a route (CTA app order along that pattern).
 * Falls back to flat routeStops only when no directions are baked.
 * @param {{ routeDirections?: object, routeStops?: Record<string, object[]> }} patternsData
 * @param {string} rt
 * @param {string} [rtdir]
 */
export function stopsForRoute(patternsData, rt, rtdir) {
  const dirs = directionsForRoute(patternsData, rt);
  if (dirs.length) {
    if (rtdir) {
      const hit = dirs.find((d) => d.rtdir === rtdir);
      return Array.isArray(hit?.stops) ? hit.stops : [];
    }
    // No direction picked — do not dump a mixed list; caller should use directions.
    return [];
  }
  const list = patternsData?.routeStops?.[String(rt)];
  return Array.isArray(list) ? list : [];
}
