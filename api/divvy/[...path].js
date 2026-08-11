// Production proxy: Divvy / Lyft GBFS (station_status + station_information).
//
// Keyless public feed — metered:false so it does not draw down the budget
// that protects the two keyed CTA feeds. Catch-all directory form so nested
// paths match on Vercel (a flat api/divvy.js only mounts /api/divvy).

import { guardRequest, isRouteParam } from '../_guard.js';

// Upstream host is resolved at request time from the path segment only.
// The two allowlisted files live under the same Lyft GBFS tree the bake
// script discovers; the proxy hardcodes the versioned base so the client
// never needs discovery mid-poll. Discovery is bake-time only.
const UPSTREAM = 'https://gbfs.lyft.com/gbfs/2.3/chi/en';

/**
 * Exact-match allowlist. The segment is interpolated into the upstream URL,
 * so traversal must be unrepresentable rather than sanitized.
 */
export const DIVVY_ENDPOINTS = new Set([
  'station_status.json',
  'station_information.json',
]);

/** @param {string} endpoint @returns {boolean} */
export function isAllowedDivvyEndpoint(endpoint) {
  return DIVVY_ENDPOINTS.has(String(endpoint || '').toLowerCase());
}

export default async function handler(req, res) {
  if (!guardRequest(req, res, { metered: false })) return;
  try {
    const incoming = new URL(req.url || '/api/divvy', 'http://localhost');
    let sub = '';
    const qPath = req.query?.path;
    if (qPath != null) {
      sub = Array.isArray(qPath) ? qPath.join('/') : String(qPath);
    } else {
      // Also accept Vercel's `...path` key if path was stripped already.
      const dots = req.query?.['...path'];
      if (dots != null) {
        sub = Array.isArray(dots) ? dots.join('/') : String(dots);
      } else {
        sub = incoming.pathname.replace(/^\/api\/divvy\/?/, '');
      }
    }
    if (!isAllowedDivvyEndpoint(sub)) {
      res.status(400).json({ error: 'unsupported divvy endpoint' });
      return;
    }
    const target = new URL(`${UPSTREAM}/${sub.toLowerCase()}`);
    incoming.searchParams.forEach((v, k) => {
      if (isRouteParam(k)) return;
      target.searchParams.set(k, v);
    });
    const upstream = await fetch(target.toString());
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader(
      'content-type',
      upstream.headers.get('content-type') || 'application/json',
    );
    // Discovery ttl is 60s; s-maxage=30 collapses viewers without going
    // stale past half a poll window.
    res.setHeader('cache-control', 'public, max-age=0, s-maxage=30');
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: err?.message || 'upstream failed' });
  }
}
