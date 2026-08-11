# Brief: Divvy bike tracker

**Status:** not started
**Shape:** mirrors the bus tracker — bake the static layer, poll the live one
**Branch:** cut off `main`

---

## Why this is the easiest of the three modes

Divvy publishes GBFS, the open bikeshare standard, operated by Lyft. Verified
2026-08-11 against the live feeds:

- **No API key.** No signup, no quota, no secret to protect.
- **577 stations** in `station_information.json`.
- Station fields: `station_id`, `name`, `short_name`, `lat`, `lon`, `capacity`.
- Status fields: `num_bikes_available`, `num_ebikes_available`,
  `num_docks_available`, `num_bikes_disabled`, `num_docks_disabled`,
  `is_installed`, `is_renting`, `is_returning`, `last_reported`.
- Discovery doc `ttl` is 60, so the data refreshes about once a minute.

Compared to buses this drops three whole problems: no route patterns, no
direction resolution, no 10-route chunking. Stations are fixed points. One
request covers all 577.

**Feeds**

```
discovery   https://gbfs.divvybikes.com/gbfs/gbfs.json
stations    https://gbfs.lyft.com/gbfs/2.3/chi/en/station_information.json
status      https://gbfs.lyft.com/gbfs/2.3/chi/en/station_status.json
```

Read the discovery doc in the bake rather than hardcoding the two URLs. Lyft
has moved the version prefix before.

## Architecture

Follow the existing split exactly.

**1. Bake — `scripts/build-divvy.mjs`, `npm run divvy`**

- Resolve feed URLs from the discovery document.
- Write `public/data/divvy-stations.json`: `station_id`, `name`, `lat`, `lon`,
  `capacity`.
- Round coordinates to 6 decimals, as `build-tracks.mjs` does.
- Expect roughly 60 KB. Small enough to load at boot, unlike `patterns.json`.

**2. Proxy — `api/divvy/[...path].js`**

- Keyless upstream, so pass `metered: false` to `guardRequest`, like the
  alerts proxy.
- Allowlist exactly `station_status.json` and `station_information.json`.
- Use `isRouteParam()` from `api/_guard.js` to strip Vercel's `...path`. Do
  not re-derive this; it has already bitten twice.
- Set `s-maxage=30`. One upstream request then serves every viewer.
- Add a matching dev proxy entry in `vite.config.js`.

**3. Engine — `src/divvy.js`**

- Much thinner than `BusEngine`. Stations do not move, so there is no
  interpolation, no tween, no trail.
- Ingest status, join to the baked stations by `station_id`, expose a list.
- Poll with the existing `Poller`: `intervalMs: 60000`, `storageKey: null`,
  `ceiling: Infinity`. Keyless feeds opt out of the ledger by design.
- Treat `station_id` as a string. The values are 19-digit numbers and will
  lose precision as JavaScript numbers.
- Drop stations where `is_installed` is 0.

**4. Map layer — `src/layers.js`**

- `ScatterplotLayer`. Radius from `capacity`, fill from availability ratio.
- **Clutter is the real risk.** 577 dots at city zoom is noise. Gate on zoom,
  and reuse the `capBuses()` viewport-distance cap already in `src/buses.js`.
- Add a `bikes` flag to `display` and a DISPLAY toggle in `src/hud.js`.

**5. Browse — `src/browse.js`**

- Third kind: `'bike'`. The tab bar becomes Train | Bus | Bike.
- **The hierarchy is shallower.** Bikes have no direction step, so it is a
  flat searchable station list, not route → direction → stops. Do not force
  it into the bus shape.
- Search by station name, reusing `searchStations()` if its shape fits.

**6. Board — `src/board.js`**

- A bike station board shows four numbers: classic bikes, e-bikes, docks free,
  capacity.
- Show `NOT RENTING` when `is_renting` is 0, and `NOT ACCEPTING RETURNS` when
  `is_returning` is 0. A full dock is the rider's actual problem.
- Reuse `beginOpen()` and the empty/loading/error ladder.

## Constraints

1. Do not regress cold open. The station bake is small, but load it beside
   `stations.json`, not before the map.
2. Keep the one-surface rule. Opening a bike board closes browse.
3. `station_id` stays a string everywhere.
4. No new dependency.

## Definition of done

- `npm run lint`, `npm test`, `npm run build` pass.
- Tests for the bake normalizer, the status join, the proxy allowlist, and the
  availability formatting, matching how `bus-catalog.test.js` covers buses.
- Verified in **headed** Chrome. Headless has no WebGL and the app dies
  silently there.
- Checked in production after deploy. The alerts proxy shipped broken because
  nobody did this.

## Open question for the build

Does GBFS send permissive CORS headers? If it does, the browser could fetch it
directly. Use the proxy anyway — the shared `s-maxage` cache is worth more
than the saved hop, and it keeps every outbound feed on one pattern.
