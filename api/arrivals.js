// Production proxy: CTA Train Tracker arrivals (ttarrivals).
// Path must stay /api/arrivals (never /api/tt*) to avoid prefix collisions.

import { guardRequest } from './_guard.js';

export default async function handler(req, res) {
  if (!guardRequest(req, res)) return;
  const key = process.env.CTA_KEY;
  if (!key) {
    res.status(500).json({ error: 'CTA_KEY not configured' });
    return;
  }
  try {
    const incoming = new URL(req.url || '/api/arrivals', 'http://localhost');
    const target = new URL('https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx');
    incoming.searchParams.forEach((v, k) => {
      if (k !== 'key') target.searchParams.set(k, v);
    });
    target.searchParams.set('key', key);
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
