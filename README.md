# CHI-TRON

**Live nav for Chicago transit** — neon map, real trains, you in the world.

Live **all eight L lines**: vehicle positions, single-line arrival boards
(CTA Train Tracker), multi-line orbs at transfer stops, blue-dot for walking.

**Unofficial fan project — not affiliated with the Chicago Transit Authority.**

## How it works

- **Map first:** full-bleed Grid-in-the-Fog stage; chrome floats on top.
- **Live trains:** CTA `ttpositions` for all lines in `LINE_DEFS` (`src/catalog.js`) — **one** multi-`rt` poll (~5s), not one poll per line.
- **Station board:** open a stop from a **line** list → arrivals for **that line only** (Orange → Roosevelt = Orange; Red → Roosevelt = Red). List orbs show which lines serve the stop.
- **Browse:** Bottom-right TRAIN / BUS / BIKE icons → Train Rides / Bus Routes / Bike Stations → board. Search is top-left.
- **You:** Locate under the kind stack; follow-me recenters; pan breaks follow (Maps law).
- **Buses (full tracker):** All ~126 CTA routes — Bus Routes → search route → **direction** → stops → predictions. Map vehicles only for **mapLive** marquee (~21 high-frequency routes) so poll budget and density stay sane.
- **Bikes:** Divvy GBFS list. Bikes green / empty red. Docks orange / empty red.
- **Bake:** `npm run patterns` → `patterns.json` (map polylines + all `routeDirections`) + `bus-routes.json` (catalog).

### Cold open

The map paints as soon as `tracks.json` lands. `stations.json` and the ~3.2 MB
bus bake (`patterns.json`) load after, so bus geometry never blocks first paint
— see `src/bus-data.js`. Vendor code is split into `maplibre` and `deck` chunks,
so a product change ships ~22 kB gzip instead of invalidating the whole bundle.

### Proxy protection

This repo is public and `api/` injects the CTA keys server-side, so the proxies
are guarded (`api/_guard.js`): same-origin only, per-IP rate limit, and a
per-instance daily budget under the CTA ceiling. The bus catch-all also takes an
exact-match method allowlist (`getvehicles`, `getpredictions`), which is what
stops `..` traversal out of `/bustime/api/v3/`.

The guard needs no configuration on Vercel — it authorizes the request's own
host, so preview deployments work automatically. Set `ALLOWED_ORIGINS`
(comma-separated) only when a different domain must reach the proxies.

The rate limit and daily budget live in instance memory, so they are per warm
serverless instance, not global. That bounds one instance's spend and makes
casual scraping expensive; move both counters to Vercel KV if you ever need an
exact distributed quota.

### Poll budget (approx)

| Feed | Cadence | Notes |
|---|---|---|
| Train positions | 5s | 1 request with all live `rt` codes |
| Bus vehicles | 15s | mapLive only (~21 rts, chunked 10/call) |
| Train / bus boards | 20s | Only while a sheet is open |
| Ceiling | 25k/day | Separate ledgers `cta-train` / `cta-bus` |

## Setup

```bash
npm install
# .env already needs:
# CTA_KEY=...          # Train Tracker (positions + arrivals)
# CTA_BUS_KEY=...      # Bus Tracker
npm run patterns       # rebuild bus catalog + directions (needs CTA_BUS_KEY)
npm run buildings      # optional downtown mass
npm run dev
```

Open http://localhost:5173/ — allow location when you want the blue dot.

## Controls

| Action | Effect |
|---|---|
| Tap station (from a line list) | Open that line’s arrival sheet |
| ◎ FAB | Enable GPS + recenter on me |
| Pan map | Breaks follow-me |
| Esc | Close sheet / release train follow |
| Tap train tip | Follow that run |

## Stack

MapLibre + deck.gl + OpenFreeMap · CTA Train Tracker · Vite key proxy (dev) · Vercel `api/` proxy (prod).

## Deploy (public URL)

```bash
# vercel env add CTA_KEY
vercel --prod
```

`api/tt.js` + `api/arrivals.js` + `api/bus/[...path].js` inject keys server-side. Never put keys in the client bundle.

## Stretch

Tracker-first shell · focus-route map poll · Divvy · PWA.

Pinned city feeds (after Divvy): ADS-B, Travel Midwest speeds + cams, weather/lake, Pulse (311 + Block Club). See `docs/briefs/city-feeds.md`.

3D research (not in main): Grok 4.6 is good at hero meshes and small worlds, not a city twin. See `docs/briefs/grok-46-3d.md`.

Evidence for both lives in `docs/research/`.
