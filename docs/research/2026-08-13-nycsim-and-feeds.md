# Research: NYC SIM + Chicago live feeds

**Date:** 2026-08-13
**Branch at write:** `feat/train-consist`
**Brief:** `docs/briefs/city-feeds.md`
**Do not implement here.** Divvy is another session.

Studied [David Lietjauw / nycsim.com](https://www.nycsim.com/) from [this thread](https://x.com/davidfromkansas/status/2075691129899528254). Then verified Chicago equivalents.

---

## NYC SIM — what it is

Closed Vercel app. Three.js 0.166 from jsdelivr. Not open source.
Maker: David Lietjauw (`@davidfromkansas`). Built with Fable 5 + Claude.

**Product loop:** see counts → toggle a layer → click a thing → inspect → ask LLM → fly.

**Look:** day = pastel SimCity. Night = dark mass + warm windows (closer to us). HUD is municipal-blue, not Tron.

### Video (main 54s + night reel)

Frames extracted 2026-08-13 from the X amplify videos.

- 0–5s — Wide Manhattan. Weather chip, City Vitals, layer bar, news ticker, D-pad, “Ask David.”
- 10s — Street dive. Citi Bike dock labels. Layers: Air, Subways, Ferries, Buses, Citi Bikes, Traffic Cam, Birds.
- 16s — Waterfront cars as dots. Ferry.
- 22s — Click cam → real DOT CCTV (`6 Ave @ 49 St`, LIVE). Vitals: ~9.5k residents, 354 trains, 1,222 buses, 837 cams, 29 mph.
- 40–52s — Concierge answers Astor Place from live subway + bikes, then flies and pins. Click Sim = ACS 2023 PUMS card.
- Night 9:29pm — black sky, warm windows, orange waterfront. Only reel that belongs next to Chi-Tron.

Later posts: home-save, rain, 7-day rewind, day/night.

### Architecture (from live site)

Baked JSON: `streets.json` (4.5 MB), `buildings.json` (2.5 MB), 86k streets, 305k footprints.

One aggregator: `GET /api/live` → `{ now, feeds: { subway, buses, ferries, flights, citibike, traffic, trafficEvents, birds, weather, nyc311, airQuality, nwsalerts, headlines } }`.

Also: `/api/agent` (concierge), `/api/cams`, `/api/history`, Google sign-in via `/api/home`.

| Feed | Source (as used) | Live sample 2026-08-13 |
|---|---|---|
| Subway | MTA GTFS-RT | ~891 trips |
| Buses | MTA | ~3186 vehicles |
| Ferries | NYC Ferry | ~21 vessels |
| Citi Bike | GBFS | ~2468 docks |
| Traffic | 511 / DOT links | 61 segments, avg ~24 mph |
| Cams | 511 NY | 871 |
| 311 | NYC Open Data | 250 latest |
| Flights | `adsb.lol` | 113 (stale once, then live) |
| Weather | NWS | 31°C, source `nws` |
| Headlines | amNY | 20 |
| Birds | BirdCast | radar cells |
| Air quality | AirNow + NYCCAS | 14 stations |

Headless browse could not create WebGL (SwiftShader). Analysis used the X videos + the JSON APIs.

---

## Steal / leave

**Steal:** feed fusion. Click-to-inspect. Pulse crawl. Weather as atmosphere. Expressway heat. Highway CCTV cards. ADS-B ghosts.

**Leave:** Three.js rewrite. Census Sims. Thought bubbles. “Ask David.” Birds. Pastel massing. 7-day rewind. Equal layer chrome (we stay transit-first).

---

## Chicago sources — hit 2026-08-13

### Traffic — freeway yes, city streets no

- **Dead:** City SODA `n4j6-wkkf`. 1,257 rows. `_last_updt` = `2026-04-30`. `_traffic` = `-1`. City story 2026-08-06: Traffic Tracker series deprecated.
- **Dead for us:** `chicagotraffictracker.com` `/rest/event/alerts` → `[]`. `/rest/route/roads` is street names only.
- **Live:** Travel Midwest `GET /lmiga/chicagoQuickTraffic.json`. Age 7 min. Sample: inbound Kennedy O'Hare → Jane Byrne, **16 mph, 63 min**.
- **Live:** `POST /lmiga/travelTimeMap.json` → 164 corridor times.
- **Live:** `GET /lmiga/alerts.json` → 11 regional incidents.
- **Street heat later:** derive from CTA bus GPS we already poll. Do not wait for a new city SODA.

### ADS-B — live, no key

50 mi box on 41.88, −87.63:

| Source | Count | Notes |
|---|---|---|
| adsb.lol | 103 | NYC SIM source. Use this |
| adsb.fi | 97 | Adds type + owner |
| OpenSky | 56 | Thinner, rate-limits |
| airplanes.live | 403 | Skip |

### CCTV — highway stills only

- `POST /lmiga/cameraMap.json` → **1,877** cams, `remUrls` on `cctv.travelmidwest.com`, age ~1–2 min.
- Second POST was flaky (400 / hang). Cache the first hit. Proxy JPEGs. Never hotlink.
- City intersection / red-light / speed-cam **video is not public**. Locations exist. FOIA only.

### Other live

| Feed | URL / id | Status |
|---|---|---|
| 311 | SODA `v6vf-nfxy` | Live (open tickets, lat/lon, type) |
| Weather | NWS + Open-Meteo | Live, no key |
| NWS alerts | `api.weather.gov/alerts/active?area=IL` | Live |
| Lake buoy | NOAA `45174` txt | Live 21:10Z: wind 7 m/s, waves 0.3 m |
| Block Club RSS | `blockclubchicago.org/feed/` | Live |
| CWB RSS | | 403 |
| AirNow / PurpleAir / OpenAQ | | 401 / 403 |
| Metra GTFS-RT | `gtfspublic.metrarr.com` | Key required |
| Pace realtime | | No public dump |
| Crash table `85ca-t3if` | SODA | Historical. Skip |

Divvy GBFS is live. **Other session owns it.**

---

## Chi-Tron add order (pinned)

See `docs/briefs/city-feeds.md`.

1. `/api/adsb` — 15s — deck ticks
2. `/api/traffic` — 60–90s — freeway PathLayer heat
3. `/api/cams` + `/api/cams/:id` — icons + CCTV card
4. `/api/wx` — 10 min — `style.js` paints only
5. `/api/pulse` — 2 min — 311 + Block Club + existing CTA alerts

All keyless. `_guard.js` + edge cache. No CTA ledger.

---

## 3D (same day)

See `docs/research/2026-08-13-grok-46-3d.md` and `docs/briefs/grok-46-3d.md`.
Short: 4.6 is for hero meshes and dioramas. Not a city twin. Stay on MapLibre.
