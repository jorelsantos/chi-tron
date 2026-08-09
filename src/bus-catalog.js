// Bus route catalog — factory pattern mirrors LINE_DEFS for trains.
// Browse uses all live routes; map vehicles use mapLive only (budget/clutter).

/** Fallback marquee if bus-routes.json missing mapLive. Keep in sync with bake. */
export const MARQUEE_ROUTES = [
  '8', '62',
  '22', '4', '9', '20', '49', '151', '6', '3', '66',
  '77', '79', '80', '82', '146', '147', '152', '55', '63', 'X9',
];

/**
 * @typedef {{ rt: string, name: string, color?: string, live?: boolean, mapLive?: boolean }} BusRouteDef
 */

/** @type {BusRouteDef[]} */
export const BUS_ROUTE_DEFS = [
  { rt: '8', name: 'Halsted', live: true, mapLive: true },
  { rt: '62', name: 'Archer', live: true, mapLive: true },
];

/**
 * Normalize baked bus-routes.json (or legacy tiny defs).
 * @param {object|null|undefined} data
 * @returns {BusRouteDef[]}
 */
export function normalizeBusCatalog(data) {
  const raw = Array.isArray(data?.routes) ? data.routes : null;
  if (raw?.length) {
    const mapLiveSet = new Set(
      (Array.isArray(data.mapLive) ? data.mapLive : MARQUEE_ROUTES).map(String),
    );
    return raw.map((r) => {
      const rt = String(r.rt);
      return {
        rt,
        name: String(r.name || rt),
        color: r.color ? String(r.color) : '',
        live: r.live !== false,
        mapLive: r.mapLive === true || mapLiveSet.has(rt),
      };
    });
  }
  // Legacy fallback: hardcoded MVP defs
  return BUS_ROUTE_DEFS.map((r) => ({ ...r, mapLive: r.mapLive !== false }));
}

/** @param {BusRouteDef[]} [catalog] */
export function liveBusRoutes(catalog) {
  const list = catalog?.length ? catalog : BUS_ROUTE_DEFS;
  return list.filter((r) => r.live !== false);
}

/** @param {BusRouteDef[]} [catalog] */
export function liveBusRouteIds(catalog) {
  return liveBusRoutes(catalog).map((r) => r.rt);
}

/** @param {BusRouteDef[]} [catalog] */
export function mapLiveBusRoutes(catalog) {
  const list = catalog?.length ? catalog : BUS_ROUTE_DEFS;
  return list.filter((r) => r.mapLive && r.live !== false);
}

/** @param {BusRouteDef[]} [catalog] */
export function mapLiveBusRouteIds(catalog) {
  const ids = mapLiveBusRoutes(catalog).map((r) => r.rt);
  return ids.length ? ids : [...MARQUEE_ROUTES];
}

/** @param {BusRouteDef[]} catalog @param {string} rt */
export function busRouteDef(catalogOrRt, maybeRt) {
  // Support busRouteDef(rt) legacy and busRouteDef(catalog, rt)
  if (maybeRt === undefined) {
    const rt = String(catalogOrRt);
    return BUS_ROUTE_DEFS.find((r) => r.rt === rt) || null;
  }
  const catalog = Array.isArray(catalogOrRt) ? catalogOrRt : [];
  const rt = String(maybeRt);
  return catalog.find((r) => r.rt === rt) || null;
}

/** Natural CTA route id sort. */
export function sortBusRoutes(routes) {
  return [...routes].sort((a, b) => {
    const ra = String(a.rt);
    const rb = String(b.rt);
    const na = Number(ra);
    const nb = Number(rb);
    const aNum = Number.isFinite(na) && String(na) === ra;
    const bNum = Number.isFinite(nb) && String(nb) === rb;
    if (aNum && bNum) return na - nb;
    if (aNum) return -1;
    if (bNum) return 1;
    return ra.localeCompare(rb, undefined, { numeric: true });
  });
}

/**
 * Filter bus routes by number or name substring.
 * @param {BusRouteDef[]} routes
 * @param {string} q
 */
export function searchBusRoutes(routes, q) {
  const needle = String(q || '').trim().toLowerCase();
  const sorted = sortBusRoutes(routes.filter((r) => r.live !== false));
  if (!needle) return sorted;
  return sorted.filter(
    (r) =>
      String(r.rt).toLowerCase().includes(needle)
      || String(r.name || '').toLowerCase().includes(needle),
  );
}

/**
 * Map-layer slice: patterns + routes for mapLive only.
 * Tracker slice: keep ALL routeDirections / routeStops for browse boards.
 * @param {{ patterns?: object, routes?: object, routeDirections?: object, routeStops?: object }} data
 * @param {string[]} [mapLiveIds]
 */
export function filterPatternsToRoutes(data, mapLiveIds = mapLiveBusRouteIds()) {
  const want = new Set(mapLiveIds.map(String));
  const routes = {};
  const patterns = {};
  for (const rt of want) {
    const pids = data?.routes?.[rt];
    if (!pids?.length) continue;
    routes[rt] = pids;
    for (const pid of pids) {
      if (data.patterns?.[pid]) patterns[pid] = data.patterns[pid];
    }
  }
  // Full tracker data — not filtered to mapLive
  const routeDirections = data?.routeDirections && typeof data.routeDirections === 'object'
    ? data.routeDirections
    : {};
  const routeStops = data?.routeStops && typeof data.routeStops === 'object'
    ? data.routeStops
    : {};
  return { patterns, routes, routeDirections, routeStops };
}

/**
 * CTA-style travel directions for a route.
 * @param {{ routeDirections?: Record<string, { rtdir: string, pid?: string|null, stops: object[] }[]> }} patternsData
 * @param {string} rt
 */
export function directionsForRoute(patternsData, rt) {
  const list = patternsData?.routeDirections?.[String(rt)];
  return Array.isArray(list) ? list : [];
}

/**
 * Ordered stops for one direction. Empty without rtdir when directions exist.
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
    return [];
  }
  const list = patternsData?.routeStops?.[String(rt)];
  return Array.isArray(list) ? list : [];
}

/** Routes that have baked directions (board-ready). */
export function routesWithDirections(patternsData, catalog) {
  const dirs = patternsData?.routeDirections || {};
  return liveBusRoutes(catalog).filter((r) => Array.isArray(dirs[r.rt]) && dirs[r.rt].length > 0);
}
