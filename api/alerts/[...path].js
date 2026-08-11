// Production proxy: CTA Customer Alerts API (Route Status + Detailed Alerts).
//
// This function was missing entirely. vite.config.js proxies /api/alerts in
// dev, so line status and accessibility flags worked locally and 404'd on the
// live site — silently, because src/alerts.js treats a failed poll as a
// warning and leaves every line reading 'normal'. Found by loading production
// in a browser and reading the console, which nothing had done before.
//
// Catch-all, not a flat api/alerts.js: src/alerts.js calls nested paths
// (/api/alerts/routes.aspx), and a flat file only mounts /api/alerts on
// Vercel. This is the same trap the bus proxy already hit once.
//
// Unlike tt.js and bus/[...path].js there is no key to inject — both alert
// endpoints are keyless per CTA's developer docs. The guard still runs, minus
// the daily budget. See the metered flag in api/_guard.js.

import { guardRequest, isRouteParam } from '../_guard.js';

const UPSTREAM = 'https://lapi.transitchicago.com/api/1.0';

/**
 * The two endpoints src/alerts.js calls. Exact-match, same reasoning as the
 * bus method allowlist: the segment is interpolated into the upstream URL, so
 * traversal must be unrepresentable rather than sanitized.
 */
export const ALERT_ENDPOINTS = new Set(['routes.aspx', 'alerts.aspx']);

/** @param {string} endpoint @returns {boolean} */
export function isAllowedAlertEndpoint(endpoint) {
  return ALERT_ENDPOINTS.has(String(endpoint || '').toLowerCase());
}

export default async function handler(req, res) {
  if (!guardRequest(req, res, { metered: false })) return;
  try {
    const incoming = new URL(req.url || '/api/alerts', 'http://localhost');
    // Vercel dynamic route: query.path = string | string[]. Fall back to the
    // pathname when the platform preserves the full URL.
    let sub = '';
    const qPath = req.query?.path;
    if (qPath != null) {
      sub = Array.isArray(qPath) ? qPath.join('/') : String(qPath);
    } else {
      sub = incoming.pathname.replace(/^\/api\/alerts\/?/, '');
    }
    if (!isAllowedAlertEndpoint(sub)) {
      res.status(400).json({ error: 'unsupported alerts endpoint' });
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
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    // Alerts change on the order of minutes, not seconds. A short shared cache
    // collapses every viewer's 2-minute poll into one upstream request per
    // window, which is what lets this endpoint stay unmetered.
    res.setHeader('cache-control', 'public, max-age=0, s-maxage=60');
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: err?.message || 'upstream failed' });
  }
}
