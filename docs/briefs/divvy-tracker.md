# Brief: Divvy bike tracker

**Status:** ready to implement
**Owner:** Grok (multi-agent flow below)
**Auditor:** Claude, cold read of the diff
**Branch:** cut `feat/divvy` off `main`

Trains and buses are done. This is the third and final mode. It follows the
same shape as buses: bake the static layer, poll the live one.

---

## 1. The feed, verified

Checked against the live endpoints on 2026-08-11. Do not re-derive these.

Divvy publishes GBFS, the open bikeshare standard, operated by Lyft.
**There is no API key.** No signup, no quota, no secret.

```
discovery   https://gbfs.divvybikes.com/gbfs/gbfs.json
stations    https://gbfs.lyft.com/gbfs/2.3/chi/en/station_information.json
status      https://gbfs.lyft.com/gbfs/2.3/chi/en/station_status.json
```

Resolve both feed URLs from the discovery document at bake time. Do not
hardcode them — Lyft has moved the version prefix before. The discovery doc is
`data.en.feeds[]`, each entry `{name, url}`.

**`station_information.json` — 577 stations**

```json
{
  "station_id": "2232759736070696510",
  "name": "Damen Ave & Ogden Ave",
  "short_name": "CHI02349",
  "lon": -87.67662,
  "lat": 41.87317,
  "capacity": 15
}
```

**`station_status.json`**

```json
{
  "station_id": "1934290380966283526",
  "num_bikes_available": 8,
  "num_bikes_disabled": 1,
  "num_docks_available": 6,
  "num_docks_disabled": 0,
  "is_installed": 1,
  "is_renting": 1,
  "is_returning": 1,
  "last_reported": 1786479598,
  "num_ebikes_available": 2
}
```

`num_bikes_available` **includes** e-bikes. Classic bikes are
`num_bikes_available - num_ebikes_available`. Getting this backwards is the
easiest correctness bug in this whole feature.

Discovery `ttl` is 60, so poll no faster than every 60s.

## 2. Why this is smaller than buses

Three problems simply do not exist here:

- No route patterns. Stations are fixed points, so no polyline, no
  interpolation, no `pdist`, no trail.
- No direction resolution. A station has no Northbound.
- No request chunking. One request returns all 577 stations.

Do not copy `BusEngine` wholesale. Most of it is machinery this does not need.

## 3. Files and contracts

### `scripts/build-divvy.mjs` → `npm run divvy`

Writes `public/data/divvy-stations.json`:

```js
/** @typedef {{id: string, name: string, lat: number, lon: number, capacity: number}} DivvyStation */
/** @type {{stations: DivvyStation[], bakedAt: string}} */
```

- `id` is a **string**. The values are 19-digit numbers and lose precision as
  JavaScript numbers. This is not theoretical.
- Round `lat`/`lon` to 6 decimals, matching `scripts/build-tracks.mjs`.
- Drop entries missing `lat`, `lon`, or `name`.
- Expect roughly 60 KB.

### `api/divvy/[...path].js`

Mirror `api/alerts/[...path].js` exactly.

- `guardRequest(req, res, { metered: false })` — keyless upstream must not
  draw down the budget that protects the two keyed CTA feeds.
- Allowlist exactly `station_status.json` and `station_information.json`.
- Strip Vercel's route param with `isRouteParam()` from `api/_guard.js`.
  **Import it. Do not re-derive it.** This has already broken production once.
- `cache-control: public, max-age=0, s-maxage=30`.
- Add the matching dev entry to `vite.config.js` alongside `/api/alerts`.

### `src/divvy.js`

```js
/** @typedef {{
 *   id: string, name: string, lat: number, lon: number, capacity: number,
 *   classic: number, ebikes: number, docks: number,
 *   renting: boolean, returning: boolean, reportedAt: number
 * }} DivvyLive */

export function normalizeStations(raw): DivvyStation[]
export function joinStatus(stations: DivvyStation[], statusRaw): DivvyLive[]
export class DivvyEngine {
  constructor(stations: DivvyStation[])
  startLive(): void
  stop(): void
  tick(): DivvyLive[]
  onStatus: (state: 'live'|'lost'|'hold'|'mock') => void
}
```

- Poller config: `intervalMs: 60000`, `storageKey: null`, `ceiling: Infinity`.
  `src/poller.js` already supports keyless feeds; that is what the null
  storageKey is for.
- Skip stations with `is_installed === 0`.
- `tick()` returns the current list. There is nothing to advance between
  frames, so it is a getter, not a simulation step.

### `src/layers.js`

- `ScatterplotLayer`, radius from `capacity`, fill from
  `classic + ebikes` over `capacity`.
- Gate on zoom and reuse the viewport cap from `src/buses.js` (`capBuses`).
  **577 dots at city zoom is clutter.** Treat this as a requirement.
- Read `display.bikes`.

### `src/hud.js`

Add `{ key: 'bikes', label: 'Bikes' }` to `DISPLAY_TOGGLES` (line 39).

### `index.html`

Add a third tab at line 1293:

```html
<button type="button" id="browse-kind-bike" aria-pressed="false">Bike</button>
```

Update `#browse-kind`'s `aria-label` from "Train or bus" to "Train, bus or
bike". Check the CSS: the tab strip is currently sized for two children.

### `src/browse.js`

- Third `kind`: `'bike'`.
- **The hierarchy is shallower.** Bikes go straight to a flat, searchable
  station list. There is no direction step. Do not force the
  route → direction → stops shape onto it.
- `syncKindUi()` currently toggles two ids. Make it handle three.

### `src/board.js`

A bike board shows four numbers: **classic, e-bikes, docks free, capacity**.

- Show `NOT RENTING` when `renting` is false.
- Show `DOCKS FULL` when `docks` is 0, and `NOT ACCEPTING RETURNS` when
  `returning` is false. A full dock is the rider's real problem, and no other
  Chicago app surfaces it well.
- Reuse `beginOpen()` and the shared empty/loading/error ladder.

### `src/main.js`

Wire it like `busData`: construct empty, hydrate, then start the poll.

## 4. Constraints

1. **Do not regress cold open.** `main.js` must not `await` bike data before
   the map is constructed. Read `src/bus-data.js` first to see why.
2. **One surface at a time.** Opening a bike board closes browse.
3. `station_id` is a string everywhere. No exceptions.
4. No new npm dependency.
5. Do not touch `api/tt.js`, `api/arrivals.js`, or the train engine.

## 5. Agent flow

Grok's bundled roles live in `~/.grok/bundled/roles/`. Use these five. This
extends the Implementer → Checker → parallel QA pattern that already worked on
the bus expansion.

| Phase | Role | Does | Hands off |
|---|---|---|---|
| 0 | `explore` | Read `bus-data.js`, `buses.js`, `browse.js`, `board.js`, `poller.js`, `alerts/[...path].js`. Report the exact patterns to copy. | Notes only. No edits. |
| 1 | `implementer` | Bake script + proxy + `divvy.js`. Data layer only. | Working `npm run divvy` |
| 2 | `test-writer` | Tests for the normalizer, the status join, the classic-vs-ebike split, the proxy allowlist. | Green tests |
| 3 | `implementer` | UI: layer, hud toggle, third tab, browse, board, main wiring. | Working app |
| 4 | `reviewer` | Cold read of the full diff against this brief. Writes structured notes. | Review notes |
| 5 | `implementer` | Addresses the notes. | Clean diff |
| 6 | `explore` ×3, parallel | QA cohorts, below. | PASS/FAIL each |

**Gate between every phase:** `npm run lint && npm test && npm run build`.
A phase is not done until all three pass. Do not carry a red phase forward.

**Phase 6 QA cohorts, run in parallel:**

- **Cohort A — data truth.** Pick 5 stations. Compare the app's numbers
  against the raw `station_status.json`. Verify classic = available minus
  e-bikes. Verify a station with `is_renting: 0` shows `NOT RENTING`.
- **Cohort B — no regressions.** Every train and bus flow still works: line →
  stations → board, bus route → direction → stops → board, search, back
  restore, Escape, 2D/3D, follow.
- **Cohort C — map and performance.** Bike layer respects the zoom gate and
  the viewport cap. FPS holds. Cold open does not wait on bike data.

## 6. Definition of done

- `npm run lint`, `npm test`, `npm run build` all pass.
- New tests cover: bake normalization, status join, the classic/e-bike split,
  string `station_id` preservation, and the proxy allowlist.
- **Verified in headed Chrome.** Headless has no WebGL, so MapLibre throws
  inside `boot()` and the app fails silently with zero console errors. Use
  `browse disconnect`, then `browse --headed goto http://localhost:5173/`, and
  wait about 10 seconds before probing.
- Screenshots: bike layer at city zoom and at street zoom, plus a bike board.
- Commit body explains the classic-vs-ebike arithmetic.

## 7. Traps this repo has already hit

Read these before starting. Each one cost real time.

1. **Vercel catch-all param.** A `[...path].js` route appends the matched
   segment to the query string as `...path`, dots included, not `path`.
   Forwarding it upstream broke the alerts proxy in production. Use
   `isRouteParam()`.
2. **A flat `api/divvy.js` will not match nested paths.** It only mounts
   `/api/divvy`. Use the catch-all directory form.
3. **Headless Chromium has no WebGL.** The app dies silently and looks exactly
   like a code regression.
4. **Local tests are not production.** The alerts proxy passed every local
   test and failed on the first real request. Check production after deploy.
5. **Do not use CTA's `getstops` ordering as a precedent.** Unrelated to
   Divvy, but it is the standing example of trusting a feed's order blindly.
