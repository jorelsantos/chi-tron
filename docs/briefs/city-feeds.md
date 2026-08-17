# Brief: pinned city feeds

**Status:** pinned — do not start until Divvy lands
**Pinned:** 2026-08-13
**Origin:** NYC SIM study (`nycsim.com`) + live Chicago source checks
**Not this:** Divvy (other session). Three.js. Census Sims. Birds. City Traffic Tracker SODA.

Inspiration is feed fusion, not the SimCity look. Stage stays Blade Runner.
MapLibre + deck.gl. Same proxy + `Poller` + layer contract as trains/buses/Divvy.

Verified 2026-08-13. Re-hit the URL before coding if a date is stale.

---

## Build order

1. ADS-B
2. Travel Midwest speeds
3. Travel Midwest cams
4. Weather + lake buoy
5. 311 + Block Club Pulse

All keyless. All through `api/` + `_guard.js` + edge cache. None touch the CTA ledger.

| Proxy | Cadence | Cache | Renders as |
|---|---|---|---|
| `/api/adsb` | 15s | s-maxage=10 | deck ticks + dim trail |
| `/api/traffic` | 60–90s | s-maxage=60 | PathLayer freeway heat |
| `/api/cams` + `/api/cams/:id` | 60s / on click | 60s / 30–45s JPEG | expressway icons + CCTV card |
| `/api/wx` | 10 min | s-maxage=300 | `style.js` paints only |
| `/api/pulse` | 2 min | s-maxage=60 | bottom crawl |

HUD toggles when a layer exists: `Air`, `Traffic`, `Cams`. Pulse and weather have no toggle.

---

## 1. ADS-B

Live planes over ORD / MDW / the lake. No city contract.

**Source (pick one, proxy only):**
- `https://api.adsb.lol/v2/lat/41.88/lon/-87.63/dist/50` — ~100 craft. NYC SIM uses this.
- `https://opendata.adsb.fi/api/v2/lat/41.88/lon/-87.63/dist/50` — same plus type + owner.
- OpenSky works, thinner, rate-limits. Skip `airplanes.live` (403).

**Clip to** `CHICAGOLAND_BOUNDS` in `src/style.js`. Airborne only.

**Look:** ice-white ghosts. No labels until click. Click = `UAL2138 · B39M · 19,600 ft`.
Do not follow aircraft. Do not paint airport diagrams.

---

## 2. Travel Midwest speeds

Freeway pulse only. City street SODA is dead.

**Dead — do not use:**
- `data.cityofchicago.org` `n4j6-wkkf` — last row `2026-04-30`, `_traffic: -1`.
- City deprecated the Traffic Tracker series 2026-08-06.
- `chicagotraffictracker.com` `/rest/event/alerts` returned `[]`.

**Live:**
- `GET https://travelmidwest.com/lmiga/chicagoQuickTraffic.json`
- Hit 2026-08-13: age 7 min. Sample: inbound Kennedy O'Hare → Jane Byrne, 16 mph, 63 min.
- Also `POST /lmiga/travelTimeMap.json` — 164 corridor times (GeoJSON).

**Look:** bake 6–8 expressway polylines (`scripts/build-expressways.mjs`, same pattern as `roads.json`).
Heat: `>40` dim amber, `25–40` hot amber, `<25` red. CITY zoom. Under the L at LOOP.

Street arterial heat later = derive from CTA bus GPS we already poll. Not this pin.

Do not ship a travel-time table.

---

## 3. Travel Midwest cams

Highway CCTV stills. Not city red-light / speed-cam video (FOIA only).

**Live:** `POST https://travelmidwest.com/lmiga/cameraMap.json` → ~1,877 cams.
Each: `id`, lat/lon, `age` (~1–2 min), `remUrls[]` on `cctv.travelmidwest.com`.

**Chi-Tron:**
- `/api/cams` — Chicago bbox positions, no images.
- `/api/cams/:id` — one JPEG, never hotlink from the client.
- Icons on expressways only, zoom ≳ 12, cap ~25 in view.
- Click = glass card, timestamp, grain, `LIVE`. Esc closes. Does not steal train follow.

Do not autoplay feeds. Do not scrape video.

---

## 4. Weather + lake buoy

Change the stage. No weather chip.

**Sources (no key):**
- Open-Meteo or NWS — temp, precip, cloud, wind.
- NOAA buoy `45174` (Wilmette): `https://www.ndbc.noaa.gov/data/realtime2/45174.txt`
  - Hit 2026-08-13 21:10Z: wind 7 m/s, waves 0.3 m.

**Write into existing `COLD_STEEL` paints in `src/style.js`:**

| Condition | What moves |
|---|---|
| Clear | current palette |
| Cloud / rain | thicker fog, darker water, wet road sheen |
| Hard lake wind | water shifts teal |

Do not add an 84°F pill. Do not add day-mode pastel.

---

## 5. 311 + Block Club Pulse

One dispatch crawl. Not 250 map pins.

**Sources:**
- 311 SODA `https://data.cityofchicago.org/resource/v6vf-nfxy.json` — live (type, address, status, time).
- Block Club RSS `https://blockclubchicago.org/feed/` — live.
- CTA alerts already in `src/alerts.js` — merge in.

**Filter 311** to flood, lights out, water, noise, streets.

**Look:** mono strip under the map. `RED DELAY · Flood 18th/Halsted · Block Club headline`.
Optional at LOOP zoom: 5–8 dim embers near camera. Never citywide dots.

Do not add census pedestrians, thought bubbles, or a concierge avatar.

---

## Hard no

- Switch renderer to Three.js
- Copy NYC SIM chrome / “Ask David”
- City Traffic Tracker SODA
- Crash table `85ca-t3if`
- Pace realtime (no public dump)
- Metra GTFS-RT until a key exists
- AirNow / PurpleAir / OpenAQ (auth)
- Divvy (other session)
