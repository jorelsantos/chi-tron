/**
 * Lazy owner of the bus bake (public/data/patterns.json, ~3.2 MB).
 *
 * Why this module exists: boot() used to `await` patterns.json before it
 * constructed the MapLibre map, so on a phone the entire app showed nothing
 * until several megabytes of bus geometry finished downloading — even though
 * nothing at cold open draws a bus. Trains, stations and the map itself have
 * no dependency on it at all.
 *
 * The bake is needed for exactly two things, both of which happen after the
 * first paint: mapLive vehicle polylines, and the browse route → direction →
 * stop lists. So it loads in the background once the map goes idle, and any
 * UI that needs it sooner calls `ensureLoaded()` and renders a loading state
 * until the returned promise settles.
 *
 * Failure is non-fatal by design, matching how a missing stations.json only
 * dims the ring layer: status becomes 'failed', the bus surfaces say so, and
 * trains keep running.
 */

import {
  normalizeBusCatalog,
  mapLiveBusRouteIds,
  filterPatternsToRoutes,
  routesWithDirections,
} from './bus-catalog.js';

/** @typedef {'idle'|'loading'|'ready'|'failed'} BusDataStatus */

export const EMPTY_PATTERNS = { patterns: {}, routes: {} };

/**
 * Fetch + parse JSON, resolving to `fallback` on any failure (network,
 * non-2xx, malformed body) rather than rejecting.
 * @param {string} path
 * @param {any} fallback
 * @param {typeof globalThis.fetch} fetchImpl
 * @param {string} label used in the console warning
 */
async function fetchJsonSoft(path, fallback, fetchImpl, label) {
  try {
    const res = await fetchImpl(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[chi-tron] ${label} failed — ${path}:`, err?.message || err);
    return fallback;
  }
}

/**
 * @param {object} [opts]
 * @param {typeof globalThis.fetch} [opts.fetchImpl] injectable for tests.
 * @param {(data: BusData) => void} [opts.onChange] fired on every status
 *   transition so open UI can re-render without polling.
 */
export function createBusData({ fetchImpl = globalThis.fetch, onChange = () => {} } = {}) {
  /** @type {BusDataStatus} */
  let status = 'idle';
  let catalog = {};
  let patterns = EMPTY_PATTERNS;
  let boardRoutes = [];
  /** @type {Promise<BusData>|null} */
  let inFlight = null;

  const api = {
    /** @returns {BusDataStatus} */
    get status() {
      return status;
    },
    /** Baked route catalog (bus-routes.json), normalized. */
    get catalog() {
      return catalog;
    },
    /** patterns.json filtered to the mapLive marquee. */
    get patterns() {
      return patterns;
    },
    /** Routes that have at least one baked direction — the browse list. */
    get boardRoutes() {
      return boardRoutes;
    },
    /** True when browse (route → direction → stops → predictions) can work. */
    get feedReady() {
      return boardRoutes.length > 0;
    },
    /** True when the map has polylines to place live vehicles on. */
    get mapReady() {
      return Object.keys(patterns.routes || {}).length > 0;
    },

    /**
     * Starts the load if it has not started, and always returns the same
     * promise for a given attempt. Safe to call from several places at once
     * — the map's idle handler and a user tapping Bus race routinely.
     * @returns {Promise<BusData>}
     */
    ensureLoaded() {
      if (inFlight) return inFlight;
      status = 'loading';
      onChange(api);
      inFlight = (async () => {
        // Both files are independent; one round trip each, in parallel.
        const [busRoutesRaw, patternsRaw] = await Promise.all([
          fetchJsonSoft('/data/bus-routes.json', {}, fetchImpl, 'bus-routes.json'),
          fetchJsonSoft('/data/patterns.json', {}, fetchImpl, 'patterns.json'),
        ]);
        catalog = normalizeBusCatalog(busRoutesRaw);
        // Map poll = mapLive marquee only; the full routeDirections set stays
        // in the raw bake for browse, which is why boardRoutes is derived
        // from the filtered patterns plus the unfiltered catalog.
        patterns = filterPatternsToRoutes(patternsRaw, mapLiveBusRouteIds(catalog));
        boardRoutes = routesWithDirections(patterns, catalog);
        status = boardRoutes.length ? 'ready' : 'failed';
        onChange(api);
        return api;
      })();
      return inFlight;
    },
  };

  return api;
}

/** @typedef {ReturnType<typeof createBusData>} BusData */
