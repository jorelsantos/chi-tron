# CHI-TRON

Chicago L as a Tron grid — tip-only neon energy on real track geometry over a
**cold steel + cyan haze** 3D city (**Grid in the Fog**). Aesthetic simulation
by default; LIVE feeds optional later.

**Unofficial fan project — not affiliated with the Chicago Transit Authority.**

## How it works

- **Motion:** tip-only pulses race CTA GTFS track polylines (deck.gl `TripsLayer`).
- **Stage:** MapLibre + OpenFreeMap (keyless), cold steel palette; downtown mass from
  **OSM footprints × City of Chicago stories** (honest heights, realistic shapes).
- **Camera:** hard stop at **Chicagoland / Cook metro** (`maxBounds` + min zoom).
- **LIVE (dormant UI):** CTA Train/Bus Tracker via Vite proxy; keys stay server-side.

## Setup

```bash
npm install
npm run tracks      # CTA GTFS → public/data/tracks.json
npm run buildings  # OSM shapes × City stories → public/data/buildings.json
npm run roads      # optional ambient cars
npm run patterns   # optional bus patterns (needs CTA_BUS_KEY)
echo "CTA_KEY=your-key-here" > .env   # only for LIVE later
npm run dev
```

Default boot is aesthetic sim (no train API). Camera cannot leave Chicagoland.

## Stretch

Deploy (Pages + key proxy), LIVE re-enable, rain/windows, full-city buildings bake,
sound.
