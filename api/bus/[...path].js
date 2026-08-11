// Production proxy: CTA Bus Tracker v3 (getvehicles, getpredictions, …).
// Catch-all so /api/bus/getvehicles and /api/bus/getpredictions both hit this
// function (api/bus.js alone only mounts /api/bus on Vercel).

import { guardRequest, isAllowedBusMethod, isRouteParam } from '../_guard.js';

export default async function handler(req, res) {
  if (!guardRequest(req, res)) return;
  const key = process.env.CTA_BUS_KEY;
  if (!key) {
    res.status(500).json({ error: 'CTA_BUS_KEY not configured' });
    return;
  }
  try {
    const incoming = new URL(req.url || '/api/bus', 'http://localhost');
    // Vercel dynamic route: /api/bus/[...path] → query.path = string | string[]
    // Fallback: parse pathname when the platform preserves the full URL.
    let sub = '';
    const qPath = req.query?.path;
    if (qPath != null) {
      sub = Array.isArray(qPath) ? qPath.join('/') : String(qPath);
    } else {
      sub = incoming.pathname.replace(/^\/api\/bus\/?/, '') || '';
    }
    if (!sub || sub === 'undefined') {
      res.status(400).json({ error: 'missing bus API method (e.g. getvehicles)' });
      return;
    }
    // Exact-match allowlist, not sanitizing: `sub` is interpolated into the
    // upstream path below, so anything outside the two methods the client
    // actually calls — including `..` traversal out of /bustime/api/v3/ —
    // must never reach the URL constructor.
    if (!isAllowedBusMethod(sub)) {
      res.status(400).json({ error: 'unsupported bus API method' });
      return;
    }
    const target = new URL(`https://www.ctabustracker.com/bustime/api/v3/${sub.toLowerCase()}`);
    incoming.searchParams.forEach((v, k) => {
      if (k === 'key' || isRouteParam(k)) return;
      target.searchParams.set(k, v);
    });
    target.searchParams.set('key', key);
    if (!target.searchParams.has('format')) target.searchParams.set('format', 'json');
    const upstream = await fetch(target.toString());
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: err?.message || 'upstream failed' });
  }
}
