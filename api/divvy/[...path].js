// Production proxy: Divvy / Lyft GBFS (station_status + station_information).
//
// Keyless public feed — metered:false so it does not draw down the budget
// that protects the two keyed CTA feeds. Catch-all directory form so nested
// paths match on Vercel (a flat api/divvy.js only mounts /api/divvy).
//
// Upstream URLs come from the GBFS discovery document, not a hardcoded
// version prefix (Lyft has already moved 2.3 → 1.1). Fallback is used only
// when discovery fails or returns a non-allowlisted host.

import { guardRequest, isRouteParam, DIVVY_STATUS_CACHE } from '../_guard.js';

export const DISCOVERY_URL = 'https://gbfs.divvybikes.com/gbfs/gbfs.json';
export const FALLBACK_BASE = 'https://gbfs.lyft.com/gbfs/1.1/chi/en';
export const UPSTREAM_HOSTS = new Set(['gbfs.lyft.com', 'gbfs.divvybikes.com']);
export const DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000;
export const DISCOVERY_NEG_TTL_MS = 5 * 60 * 1000;

/** Client path → GBFS discovery feed name. */
export const DIVVY_FEEDS = new Map([
  ['station_status.json', 'station_status'],
  ['station_information.json', 'station_information'],
]);

/** @param {string} endpoint @returns {boolean} */
export function isAllowedDivvyEndpoint(endpoint) {
  return DIVVY_FEEDS.has(String(endpoint || '').toLowerCase());
}

/** @deprecated alias — keep tests that import the old name working */
export const DIVVY_ENDPOINTS = new Set(DIVVY_FEEDS.keys());

/**
 * @param {string} url
 * @returns {string|null} cleaned https URL on an allowlisted host
 */
export function sanitizeDiscoveredUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:') return null;
    if (!UPSTREAM_HOSTS.has(u.hostname.toLowerCase())) return null;
    u.search = '';
    u.hash = '';
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Resolve a client endpoint to an upstream GBFS URL.
 * @param {string} endpoint e.g. station_status.json
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, cache?: { urls?: Record<string,string>, until?: number } }} [opts]
 */
export async function resolveFeedUrl(endpoint, { fetchImpl = fetch, now = Date.now, cache } = {}) {
  const key = String(endpoint || '').toLowerCase();
  const feedName = DIVVY_FEEDS.get(key);
  if (!feedName) return null;
  const store = cache || resolveFeedUrl._cache || (resolveFeedUrl._cache = { urls: {}, until: 0 });
  const t = now();
  if (store.until > t && store.urls[key]) return store.urls[key];

  const fallback = `${FALLBACK_BASE}/${key}`;
  try {
    const res = await fetchImpl(DISCOVERY_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
    const disc = await res.json();
    const feeds = disc?.data?.en?.feeds;
    if (!Array.isArray(feeds)) throw new Error('discovery missing feeds');
    const hit = feeds.find((f) => f?.name === feedName && f?.url);
    const clean = hit ? sanitizeDiscoveredUrl(hit.url) : null;
    if (!clean) throw new Error('discovered url rejected');
    store.urls[key] = clean;
    store.until = t + DISCOVERY_TTL_MS;
    return clean;
  } catch {
    store.urls[key] = fallback;
    store.until = t + DISCOVERY_NEG_TTL_MS;
    return fallback;
  }
}

function endpointFromReq(req, incoming) {
  const qPath = req.query?.path;
  if (qPath != null) return Array.isArray(qPath) ? qPath.join('/') : String(qPath);
  const dots = req.query?.['...path'];
  if (dots != null) return Array.isArray(dots) ? dots.join('/') : String(dots);
  return incoming.pathname.replace(/^\/api\/divvy\/?/, '');
}

export default async function handler(req, res) {
  if (!guardRequest(req, res, { metered: false })) return;
  try {
    const incoming = new URL(req.url || '/api/divvy', 'http://localhost');
    const sub = String(endpointFromReq(req, incoming) || '').toLowerCase();
    if (!isAllowedDivvyEndpoint(sub)) {
      res.status(400).json({ error: 'unsupported divvy endpoint' });
      return;
    }
    const target = await resolveFeedUrl(sub);
    if (!target) {
      res.status(400).json({ error: 'unsupported divvy endpoint' });
      return;
    }
    // GBFS accepts no query params — do not forward client search (or Vercel
    // ...path). The URL is the discovered one, never interpolated.
    void isRouteParam;
    const upstream = await fetch(target);
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader(
      'content-type',
      upstream.headers.get('content-type') || 'application/json',
    );
    res.setHeader(
      'cache-control',
      upstream.status >= 200 && upstream.status < 300 ? DIVVY_STATUS_CACHE : 'no-store',
    );
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: err?.message || 'upstream failed' });
  }
}
