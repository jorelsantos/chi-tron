# Claude review of main (chi-tron)

- Date: 2026-08-13T21:19Z
- Account: jorsanto@umich.edu (OAuth; ANTHROPIC_API_KEY unset for this run)
- Model: claude-opus-5
- Range: HEAD~15..main

Diff came through empty, so I reviewed the working tree at `e823cab` directly: read all four API handlers, the poller, the client call sites, then ran tests, lint, and build.

VERDICT: PASS_WITH_NITS

## Blockers (must fix before next feature)
- `api/tt.js:24` — sets `cache-control: no-store`, but every viewer requests the identical URL `/api/tt?rt=<all 8 lines>&outputType=JSON`. Nothing collapses concurrent viewers, so CTA spend scales linearly with traffic. At a 5s poll one viewer costs 720 requests/hour; CTA's 100k/day cap is gone after ~139 viewer-hours. A public link on social can reach that in a day, and the key dies for everyone. Fix is the pattern already in this repo at `api/alerts/[...path].js:60`: `s-maxage=5, stale-while-revalidate=10`. That pins upstream cost at ~17,280/day no matter how many viewers. Tradeoff to accept knowingly: an edge-cached response skips the function, so the origin guard no longer gates that URL. You trade "only our page reads public train positions" for a hard cap on key spend. Worth it.
- `api/_guard.js:239` — `DAILY_BUDGET = 20_000` is per warm instance, as the comment says. Under real load Vercel runs several instances, so the deployment's true ceiling is 20k × instances and can pass CTA's 100k. The comment is honest, but the number is sized as if it were global. Either move the counter to Vercel KV, or fix the caching above and treat this as defense in depth only.

## Nits (optional)
- `api/alerts/[...path].js:39` and `api/bus/[...path].js:20` — both read `req.query?.path`. Vercel supplies `...path` with the dots, which `c345ce1` established. So the primary branch never fires in production and the pathname fallback silently carries every request. The test at `api/handlers.test.js` named "resolves the endpoint from the ...path query key" does not test that: `browserReq` sets no `path`, so it too resolves via the pathname. This is the same class of bug `c345ce1` fixed. Read `req.query?.['...path'] ?? req.query?.path`, or drop the branch and rely on the pathname.
- `index.html:5` — `user-scalable=no, maximum-scale=1.0` disables pinch zoom site-wide. The map already owns gestures via `touch-action: none` on its own canvas (lines 89, 93), so the meta tag only costs you zoom on the text sheet. WCAG 1.4.4.
- `api/arrivals.js:17` and `api/tt.js:18` forward every query parameter except `key`. Harmless with CTA, but an allowlist would match the discipline of `BUS_METHODS` and `ALERT_ENDPOINTS`.

## Security / secrets / quota
- No secrets in tracked files. `git log --all` over `.env*` returns nothing, and a scan for 32-hex and key-assignment patterns across tracked content is clean. Local `.env` / `.env.local` are untracked and covered by `.env*`.
- Path traversal is properly closed. `BUS_METHODS` and `ALERT_ENDPOINTS` are exact-match sets, checked before the segment reaches the `URL` constructor. Sanitizing would have been weaker; this makes traversal unrepresentable.
- Guard layering is correct. `sec-fetch-site` first is the right call — it is a forbidden header name and survives referrer stripping.
- Rate limiter bounds its own memory (`_guard.js:127`), so an IP scan cannot grow the map without limit.
- Quota is the one weak axis. See both blockers.

## What looks solid
- 223 tests pass, ESLint clean, production build clean. Verified all three locally, not taken on report.
- The `_guard.js` header comment states its own limitation instead of overselling it. Rare and genuinely useful.
- `poller.js` handles the hard cases: single-flight, abort on stop, per-attempt timeout, ledger increment inside `try` so a throwing `setItem` cannot wedge the feed.
- `requestsPerCall: chunkRoutes(routeIds).length` in `buses.js:295` counts real outbound requests, not attempts. Easy thing to get wrong.
- `c345ce1`'s message names the bad test and explains why it passed while production failed. That is the right instinct.
- Vendor chunk split keeps ~1.5 MB of deck/maplibre cached across deploys.

## Top 3 follow-ups ranked
1. Add `s-maxage` to `/api/tt` and `/api/arrivals`. One line each, and it removes the only failure mode that takes the whole site down.
2. Fix the `...path` read in both catch-alls, and rename or rewrite the test that claims to cover it. The bug already shipped twice.
3. Move the rate limiter and budget to Vercel KV, once caching lands and you can see real traffic shape.
