// Production proxy: CTA Train Tracker positions (ttpositions).
// Mirrors vite.config.js /api/tt — key stays in host env (CTA_KEY).

import { guardRequest, TRAIN_POSITIONS_CACHE } from './_guard.js';

export default async function handler(req, res) {
  // Public repo + key-injecting proxy: reject anything that is not our own
  // page, over budget, or over the per-IP rate. See api/_guard.js.
  if (!guardRequest(req, res)) return;
  const key = process.env.CTA_KEY;
  if (!key) {
    res.status(500).json({ error: 'CTA_KEY not configured' });
    return;
  }
  try {
    const incoming = new URL(req.url || '/api/tt', 'http://localhost');
    const target = new URL('https://lapi.transitchicago.com/api/1.0/ttpositions.aspx');
    incoming.searchParams.forEach((v, k) => {
      if (k !== 'key') target.searchParams.set(k, v);
    });
    target.searchParams.set('key', key);
    const upstream = await fetch(target.toString());
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    // Collapse every viewer's identical 5s poll into one upstream call per
    // window. Edge cache skips this function (and the origin guard) for the
    // TTL — that is the deliberate trade for a hard cap on CTA key spend.
    // Errors stay uncached so a brief CTA blip does not freeze for 5s.
    res.setHeader(
      'cache-control',
      upstream.status >= 200 && upstream.status < 300 ? TRAIN_POSITIONS_CACHE : 'no-store',
    );
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: err?.message || 'upstream failed' });
  }
}
