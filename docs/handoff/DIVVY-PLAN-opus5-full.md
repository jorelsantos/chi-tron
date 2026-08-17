# Divvy — third mode for chi-tron

## Context

chi-tron ships two live modes: Train and Bus. Divvy adds a third mode — bike **stations**,
not free-floating vehicles. The feed is Lyft GBFS, keyless and public.

Work already exists on `origin/feat/divvy` (one commit, `45d848f`). That branch is behind
`main` by PR #5 (`bcc4ab4` quota cache) and it hardcodes a GBFS version prefix that the
discovery document no longer points at. This plan rebases that branch and patches the gaps.

Live check on 2026-08-13 corrects the old brief in `docs/briefs/divvy-tracker.md`:
the brief said 577 stations on `gbfs/2.3`. The truth today is **2046 stations** and
discovery returns **`gbfs/1.1`** URLs.

---

# PART A — Plan

## Goal

Land Divvy as a third exclusive mode — map dots, browse tab, station board — with no new
npm dependency, no change to `api/tt.js`, `api/arrivals.js`, or the train engine, and no
CTA budget draw.

## Decision: rebase vs rewrite

**Rebase `feat/divvy` onto `main`, then patch.**

Reasons:
- The branch is one commit behind `main`. `git merge-tree --write-tree main origin/feat/divvy`
  produces a tree with **no conflict**. PR #5 touched `api/_guard.js`, `api/tt.js`,
  `api/arrivals.js`, `api/handlers.test.js`; the branch touches none of those except
  `api/handlers.test.js`, and the two edits sit in different regions.
- The branch's data model is correct on the two things that are easy to get wrong:
  `station_id` stays a string, and `classic = num_bikes_available - num_ebikes_available`.
  Both are verified against the live payload below.
- The defects are localized: one hardcoded URL in the proxy, one in the Vite dev proxy, and
  a zoom/cap pair tuned for a 577-station guess.

A rewrite would re-derive ~1050 lines to fix ~40.

## Feed contract (verified 2026-08-13)

Discovery: `https://gbfs.divvybikes.com/gbfs/gbfs.json` → `data.en.feeds[]`, each
`{name, url}`.

| Feed | URL from discovery today |
|---|---|
| `station_information` | `https://gbfs.lyft.com/gbfs/1.1/chi/en/station_information.json` |
| `station_status` | `https://gbfs.lyft.com/gbfs/1.1/chi/en/station_status.json` |

Measured facts:

- `station_information` **1.1 and 2.3 both return 200** and both carry `station_id`, `name`,
  `short_name`, `lon`, `lat`, `capacity`. 2.3 drops the legacy extras.
- `station_status` **1.1 and 2.3 both return 200**. **Both carry `num_ebikes_available`.**
  2.3 adds `vehicle_types_available[]`; 1.1 does not. The classic split therefore works on
  either version.
- Station count: **2046** on all four documents.
- `is_installed === 1` on **2045** of 2046. Filtering uninstalled stations removes one dot.
- `is_renting === 1` on 2038.
- `ttl` is **60** on every document.
- `capacity` is non-zero on all 2046 stations.
- Bounding box of stations: lat 41.649 → 42.065, lon −87.844 → −87.528.
- `station_id` is a 19-digit numeric string, e.g. `"2232759736070696510"`. Never coerce it
  to `Number`.
- No station in the live snapshot reports `num_ebikes_available > num_bikes_available`.
  Keep the `Math.max(0, …)` clamp anyway; the feed is not contractually bound.

Rule that follows: **the bake resolves URLs from discovery, and the proxy resolves them too.**
No file may hold a permanent version prefix, only a fallback.

## Architecture / data flow

```
bake (manual, npm run divvy)
  discovery → station_information URL → public/data/divvy-stations.json  (244 KB, 2046 rows)

runtime
  map idle ─▶ ensureBikeData() ─▶ fetch /data/divvy-stations.json ─▶ DivvyEngine.loadStations
                                                                        │
  Poller(60s) ─▶ GET /api/divvy/station_status.json ────────────────────┤
                    │ (Vercel fn: guard metered:false, discovery-resolved upstream, edge cache)
                    ▼
                 joinStatus(stations, status) → DivvyLive[]
                    ├─▶ layers.js  ScatterplotLayer 'divvy-stations'  (zoom gate + bounds + cap)
                    ├─▶ browse.js  flat station list
                    └─▶ board.js   4-stat panel
```

Static info is baked. Only status is polled. One status request covers every station.

## Files

**New (already on the branch — keep):**
- `scripts/build-divvy.mjs` — discovery-based bake.
- `public/data/divvy-stations.json` — 244 KB, 2046 rows.
- `api/divvy/[...path].js` — proxy. **Needs the discovery patch.**
- `src/divvy.js`, `src/divvy.test.js` — engine, normalize, join.
- `docs/ux-tracker/divvy/*.png` — screenshots. Re-shoot at the end.

**Changed (already on the branch — keep):**
- `index.html` — third tab, `.bike-stat*` / `.bike-flag` CSS, `.mode-bike-list`.
- `src/browse.js`, `src/board.js`, `src/hud.js`, `src/main.js`, `src/layers.js`,
  `package.json` (`"divvy"` script), `vite.config.js`.

**Changed by this plan:**
- `api/divvy/[...path].js` — replace the hardcoded `UPSTREAM` with discovery resolution.
- `api/_guard.js` — add one exported cache constant, next to `TRAIN_*_CACHE`.
- `api/handlers.test.js` — extend the divvy describe block.
- `src/layers.js` — retune the zoom gate and cap; add bounds filtering.
- `src/main.js` — pass `viewportBounds` into `buildLayers`.
- `vite.config.js` — dev proxy prefix `2.3` → `1.1`, with a comment.
- `src/divvy.js` + `src/divvy.test.js` — bake-drift self-heal.

## UI / nav

- **Tab:** `Train | Bus | Bike` in `#browse-kind`. Already built.
- **Browse:** Bike is one level deep — a flat, searchable, A–Z station list. No direction
  step. Row meta reads `N BIKES · M DOCKS`, or `NOT RENTING`.
- **Board:** four stats — Classic, E-bikes, Docks free, Capacity. Red flags above the grid
  for `NOT RENTING`, `DOCKS FULL`, `NOT ACCEPTING RETURNS`. `last_reported` drives the
  updated stamp.
- **Map:** `ScatterplotLayer` id `divvy-stations`. Radius scales with `capacity`. Fill
  brightness scales with `(classic + ebikes) / capacity`. Colour `[40, 220, 160]` — lime/teal,
  which sits in the hue gap between CTA Green (`[20,230,95]`) and Blue (`[0,196,255]`).
- **HUD:** a `Bikes` display toggle, default off until the bake lands.
- **Exclusivity:** `openBikeStation` calls `arrivals.close()` and `busArrivals.close()`.
  `close()` clears `openBikeStationData`. Browse clears `mode-bike-list` on close. All
  present on the branch — verify, do not rebuild.

## Poll / cache / guard

| Knob | Value | Reason |
|---|---|---|
| Client poll | 60 s | GBFS `ttl` is 60. |
| Poller ledger | `storageKey: null`, `ceiling: Infinity` | Keyless feed; must not touch the CTA ledger. |
| `guardRequest` | `{ metered: false }` | Same as alerts. Keeps `DAILY_BUDGET` (8000) for the two keyed CTA feeds. |
| Edge cache, 200 | `public, max-age=0, s-maxage=45, stale-while-revalidate=30` | Collapses N viewers to ≤1 origin fetch per 45 s (≤1920/day) while staying inside the 60 s `ttl`. |
| Edge cache, non-200 | `no-store` | An upstream 5xx must not be pinned at the edge for 45 s. |
| Discovery cache (server) | 6 h in module memory, 5 min on failure | One extra upstream request per warm instance per 6 h. |
| Upstream query params | **forward none** | GBFS accepts no query parameters. Dropping them removes a whole class of injection. |

Guard layers 1 and 2 still apply: `isSameOrigin` and the per-IP rate limit. Divvy does not
become a general-purpose relay.

**Proxy shape** (`api/divvy/[...path].js`):

```js
const DISCOVERY_URL = 'https://gbfs.divvybikes.com/gbfs/gbfs.json';
const FALLBACK_BASE = 'https://gbfs.lyft.com/gbfs/1.1/chi/en';
const UPSTREAM_HOSTS = new Set(['gbfs.lyft.com', 'gbfs.divvybikes.com']);

// endpoint the client may request  →  GBFS feed name in discovery
export const DIVVY_FEEDS = new Map([
  ['station_status.json', 'station_status'],
  ['station_information.json', 'station_information'],
]);

export function isAllowedDivvyEndpoint(e) {
  return DIVVY_FEEDS.has(String(e || '').toLowerCase());
}

// Exported with injectable fetch/clock so tests drive it without network.
export async function resolveFeedUrl(endpoint, { fetchImpl, now, cache } = {}) { … }
```

`resolveFeedUrl` rules:
1. Reject an endpoint outside `DIVVY_FEEDS` before any network call.
2. Serve from the module cache when it is younger than 6 h.
3. Otherwise fetch discovery with `AbortSignal.timeout(5000)`, read `data.en.feeds[]`, and
   build `name → url`.
4. Reject a discovered URL whose protocol is not `https:` or whose host is not in
   `UPSTREAM_HOSTS`. This is the SSRF stop: discovery is third-party input.
5. Strip any query string and credentials off the discovered URL.
6. On any failure, return `` `${FALLBACK_BASE}/${endpoint}` `` and cache that for 5 min so a
   discovery outage does not add one fetch per request.

The endpoint string is **never interpolated into a URL** on the success path. The URL comes
from discovery. Traversal stops being representable rather than being sanitized.

## Bake-drift self-heal

The bake is static; Divvy adds stations. `joinStatus` silently drops any status row with no
baked station, so new stations would be invisible until someone runs `npm run divvy`.

Fix, bounded to one extra request per session:
- After the first successful status poll, compute
  `missing = statusIds.filter(id => !bakedIds.has(id)).length`.
- If `missing / statusIds.length > 0.02`, fetch `/api/divvy/station_information.json` **once**,
  run `normalizeStations` on it, call `loadStations`, and re-join. Set a `didSelfHeal` flag so
  this never repeats within a session.
- Log one `console.warn` naming the drift percentage, so the signal to re-bake is visible.

## Zoom gate + viewport cap

The branch used `BIKE_MIN_ZOOM = 12.5`, `BIKE_CAP = 120`. That is wrong for 2046 stations.
Cold open is `AERIAL_2D.zoom = 12.6` (`src/style.js`), so bikes would appear immediately at a
zoom where roughly the whole city is on screen — and 120 nearest-to-centre dots would render
as a downtown blob, implying Divvy stops at the Loop.

Retune, and add a bounds pass:

```js
const BIKE_MIN_ZOOM = 13.5;   // above cold-open 12.6 and CITY_PRESET 11.2; below CAR_MIN_ZOOM 14
const BIKE_CAP = 400;         // legibility ceiling, not a GPU limit
const BIKE_BOUNDS_PAD = 0.02; // degrees, so dots exist just past the edge when panning
```

Order of operations inside `buildLayers`:
1. `display.bikes && zoom >= BIKE_MIN_ZOOM`, else `[]` — the existing "off = empty data" rule.
2. Filter to `viewportBounds` padded by `BIKE_BOUNDS_PAD`.
3. `capBuses(list, viewportCenter, BIKE_CAP)` as the hard ceiling.

Step 2 is the new part and it matters: `capBuses` (`src/buses.js:136`) ranks by squared
distance from centre, so a bare cap cuts a **circle** out of a **rectangular** viewport and
empties the corners first. Filtering to bounds before capping means the cap only ever bites
in the densest downtown frames, where a cut is invisible.

`main.js` must pass the bounds. Next to the existing `viewportCenter`:

```js
const b = map.getBounds();
// … buildLayers(…, { viewportBounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], … })
```

Default `viewportBounds` to `null` in `buildLayers`, and skip step 2 when it is null, so every
existing `layers.test.js` call site keeps working unchanged.

Also delete the dead line in `src/layers.js`:
`export { capBuses as capNearViewport } from './buses.js';` — nothing imports it, and the file
calls `capBuses` directly.

## Tests

All tests stub `fetch`. CI runs `npm run lint`, `npm test`, `npm run build` with no secrets.

**`api/handlers.test.js`** — extend the existing `divvy proxy handler` block:
- `resolveFeedUrl` returns the discovery URL for `station_status.json`.
- A second call inside the TTL makes **no** second discovery fetch.
- Discovery that rejects → the `1.1` fallback URL, and the handler still answers 200.
- Discovery returning a URL on `evil.example.com` → fallback used, `evil` never fetched.
- Discovery returning a `http://` URL → fallback used.
- An endpoint outside the allowlist → 400 and `fetch` never called.
- `?...path=` and stray client params are not forwarded upstream.
- A 200 response carries `s-maxage=45`; a 502 carries `no-store`.
- Missing `referer` → 403 (already on the branch — keep).
- The daily budget is untouched after a divvy request (`metered: false`).

**`src/divvy.test.js`** — keep all 8 existing tests, add:
- `joinStatus` on a real 1.1-shaped row **and** a 2.3-shaped row (with
  `vehicle_types_available`) produces the same classic/ebike split.
- Self-heal fires once when >2 % of status ids are unbaked, and never twice.
- Self-heal does not fire at 0 % drift.

**`src/layers.test.js`**:
- `zoom: 13.4` → `divvy-stations` layer has zero rows.
- `zoom: 13.6` with `display.bikes = true` → rows present.
- A station outside `viewportBounds` is excluded.
- 500 in-bounds stations → exactly 400 rows.
- `viewportBounds: null` → bounds filtering is skipped, cap still applies.

**`scripts/build-divvy.mjs`** — `normalizeStations` is already exported and covered. Add one
test that a discovery document missing `station_information` throws rather than writing an
empty bake.

## Phases (Grok executes)

**Phase 0 — rebase.** No behaviour change.
```
git fetch origin
git checkout -B feat/divvy origin/feat/divvy
git rebase origin/main
npm ci && npm run lint && npm test && npm run build
```
Expect a clean rebase. If `api/handlers.test.js` does conflict, keep **both** describe blocks
and both import lines. Stop and report if anything else conflicts.

**Phase 1 — proxy discovery.** Rewrite `api/divvy/[...path].js` per the shape above. Add
`DIVVY_STATUS_CACHE` to `api/_guard.js` beside `TRAIN_ARRIVALS_CACHE`. Fix the `vite.config.js`
dev rewrite from `/gbfs/2.3/chi/en` to `/gbfs/1.1/chi/en`, with a comment that production
resolves the prefix from discovery and dev does not. Write the proxy tests. Commit.

**Phase 2 — zoom + cap.** Retune the constants, add bounds filtering, pass `viewportBounds`
from `main.js`, delete the dead re-export, write the layer tests. Commit.

**Phase 3 — bake drift.** Add the self-heal path in `src/divvy.js` plus its tests. Re-run
`npm run divvy` so the committed bake matches today's 2046 stations. Commit.

**Phase 4 — verification.** See below. Re-shoot the three screenshots in
`docs/ux-tracker/divvy/`. Update `docs/briefs/divvy-tracker.md` with the corrected feed facts
(2046 stations, `gbfs/1.1` discovery) so the stale brief stops misleading. Commit.

**Phase 5 — PR** against `main`. Title: `feat(divvy): third mode — bike stations from GBFS`.

## Verification

Run in order. Do not report done before all five pass.

1. `npm run lint && npm test && npm run build` — clean.
2. `npm run divvy` — prints `Wrote 2046 stations`. `git diff --stat` on the JSON shows a
   changed file, not an emptied one.
3. `npx vercel dev` (or `npm run dev`), then
   `curl -s -H 'Referer: http://localhost:5173/' localhost:3000/api/divvy/station_status.json | head -c 200`
   → GBFS JSON. Then `curl -s localhost:3000/api/divvy/free_bike_status.json` → 400.
   Then `curl -s localhost:3000/api/divvy/station_status.json` with no `Referer` and no
   `Sec-Fetch-Site` → 403.
4. **Browser QA in headed Chrome, not headless.** Headless has no WebGL, so MapLibre dies
   silently and a working build looks broken. Check, at zoom ≥ 13.5: dots render across the
   whole visible frame, not only downtown; a dot click opens the bike board; the board's four
   stats are numbers, not `—`; the Bike tab lists stations A–Z; search narrows it; opening a
   train or bus board closes the bike board.
5. Zoom out to `CITY_PRESET` (11.2) and confirm every bike dot disappears.

## Risks / traps

- **The version prefix moves again.** Discovery already moved 2.3 → 1.1 since the brief. The
  proxy cache TTL is 6 h, so a live move self-corrects within 6 h without a deploy. The
  fallback only matters when discovery itself is down.
- **`num_bikes_available` includes e-bikes.** Reversing the subtraction is the single easiest
  correctness bug here. It is already right on the branch. Do not "simplify" it.
- **`station_id` precision.** `Number("2232759736070696510")` loses digits and silently breaks
  the join. Keep every id a string, on both sides.
- **`last_reported` units.** GBFS gives unix **seconds**. The branch's board multiplies by 1000
  when the value is below `1e12`. Keep that guard.
- **Caching an error at the edge.** Without the non-200 `no-store` branch, one upstream 502
  gets served to every viewer for 45 s.
- **TDZ in `main.js`.** `ensureBikeData` closes over `display`, which is declared after it.
  This is safe only because the function first runs on `map.once('idle')`. Do not move the
  call earlier in `boot()`.
- **Cold open must not await the bake.** `DivvyEngine` is constructed empty and hydrated later,
  matching `bus-data.js`. Keep it that way; the JSON is 244 KB.
- **Dev/prod drift.** The Vite proxy stays hardcoded. If dev 404s but production works, the
  dev prefix is stale — check discovery first.

## Definition of done

- [ ] `feat/divvy` rebased on `main`; `git log origin/main..feat/divvy` shows no missing PR #5.
- [ ] No new entry in `package.json` `dependencies`.
- [ ] `git diff main --stat` touches neither `api/tt.js`, `api/arrivals.js`, nor `src/trains.js`.
- [ ] No GBFS version prefix appears in `api/divvy/[...path].js` except as `FALLBACK_BASE`.
- [ ] Divvy requests pass `metered: false`; `DAILY_BUDGET` is unchanged at 8000.
- [ ] Status responses carry `s-maxage=45`; error responses carry `no-store`.
- [ ] Bikes are hidden below zoom 13.5 and never exceed 400 drawn dots.
- [ ] `npm run lint`, `npm test`, `npm run build` all pass in CI.
- [ ] Headed-Chrome QA passes all six checks in Verification step 4.
- [ ] Three refreshed screenshots in `docs/ux-tracker/divvy/`.
- [ ] `docs/briefs/divvy-tracker.md` states 2046 stations and `gbfs/1.1` discovery.

---

# PART B — Self-check

## Claims vs evidence

| # | Claim in Part A | Evidence | Verdict |
|---|---|---|---|
| 1 | Discovery returns `gbfs/1.1` URLs for both feeds | `curl` of `gbfs.divvybikes.com/gbfs/gbfs.json`, this session | FEASIBLE |
| 2 | 2046 stations, not 577 | All four documents report 2046 | FEASIBLE |
| 3 | `ttl` is 60 | Read off all four documents | FEASIBLE |
| 4 | 2.3 and 1.1 both return 200 | `curl -o /dev/null -w %{http_code}` → 200, 200, 200 | FEASIBLE |
| 5 | **1.1 `station_status` carries `num_ebikes_available`** | Key list confirmed on the 1.1 payload | FEASIBLE — this was the real risk. GBFS 1.1 has no standard e-bike field, so a version move to 1.1 could have silently zeroed every e-bike count. Lyft ships it as a vendor extension. Verified, not assumed. |
| 6 | `station_id` is a 19-digit string | Sample `"2232759736070696510"` | FEASIBLE |
| 7 | 2045 of 2046 are `is_installed` | Counted | FEASIBLE |
| 8 | Rebase is clean | `git merge-tree --write-tree main origin/feat/divvy` returned a tree hash and no conflict block | FEASIBLE |
| 9 | PR #5 files do not overlap the branch except `api/handlers.test.js` | `git show --name-only` on `bcc4ab4` and `c345ce1` | FEASIBLE |
| 10 | `capBuses(list, center, cap)` exists and ranks by distance from centre | `src/buses.js:136` | FEASIBLE |
| 11 | Cold open is zoom 12.6 | `AERIAL_2D` in `src/style.js:9` | FEASIBLE |
| 12 | Branch gate 12.5 shows bikes at cold open | 12.6 ≥ 12.5 | **WRONG in the branch** — corrected to 13.5 |
| 13 | Baked JSON is 244 KB | `git cat-file -s` → 244036 | FEASIBLE |
| 14 | `metered: false` keeps Divvy off the CTA budget | `guardRequest` in `api/_guard.js` | FEASIBLE |
| 15 | Branch proxy hardcodes `gbfs/2.3` | Read from the branch | FEASIBLE — this is the gap being fixed |
| 16 | `capacity` is never 0 | Counted: 0 zero-capacity stations | FEASIBLE — but the `Math.max(1, …)` divisor guard stays; one bad row must not produce `Infinity` |
| 17 | Cap of 400 is a legibility ceiling, not a GPU limit | deck.gl draws 2046 `ScatterplotLayer` points without strain | FEASIBLE — stated honestly rather than sold as a performance fix |

## Risks (not defects)

| # | Item | Verdict |
|---|---|---|
| R1 | Discovery adds one upstream fetch per warm instance per 6 h | RISK — accepted. `metered: false`, so no CTA budget impact. The 5-minute negative cache bounds a discovery outage. |
| R2 | `s-maxage=45` serves data up to 45 s old against a 60 s `ttl` | RISK — accepted. Bike counts are not second-critical, and it halves origin load versus the branch's 30. |
| R3 | The 2 % self-heal threshold is a guess | RISK — it is a heuristic, stated as one. The `console.warn` is the real signal; the auto-fetch is a courtesy. |
| R4 | Zoom 13.5 and cap 400 are estimates from arithmetic, not from pixels | RISK — must be confirmed in headed-Chrome QA (step 4). If downtown still reads as cut off, raise the cap before lowering the gate. |
| R5 | Vite dev proxy stays hardcoded at 1.1 | RISK — accepted. Dev-only, and the trap is documented. |
| R6 | Screenshots on the branch were shot at the old gate and cap | RISK — they are now stale by definition. Phase 4 re-shoots them. |

## Corrections applied to Part A

1. **Zoom gate 12.5 → 13.5.** The branch value is below cold-open zoom 12.6, so bikes drew
   immediately at near-city scale. This was a real defect, not a preference.
2. **Cap 120 → 400, plus a bounds filter before the cap.** 120 nearest-to-centre out of 2045
   renders as a downtown-only blob. Bounds-then-cap removes the circular cut.
3. **`s-maxage` 30 → 45**, and non-200 responses forced to `no-store`. The branch would pin an
   upstream error at the edge.
4. **Upstream query forwarding removed.** The branch forwarded client params to GBFS, which
   accepts none.
5. **Endpoint no longer interpolated into a URL.** The allowlist becomes a name → feed-name map
   and the URL comes from discovery, with an `https:` + host check on the third-party input.
6. **Bake-drift self-heal added.** The branch had no path from a stale bake back to a correct
   station set.
7. **Dead re-export deleted** (`capNearViewport` in `src/layers.js`).
8. **Rebase claim upgraded from "prefer" to "verified clean"** by `merge-tree`.

## What I did not change, and why

- The classic/e-bike split, string ids, `is_installed` filter, empty-construct engine, and the
  exclusive-surface wiring are all correct on the branch. Rewriting them would add risk and
  no value.

## VERDICT

**READY_TO_IMPLEMENT**

Phase 0 is verified clean. Phases 1–3 are bounded, tested, and touch no forbidden file. The
one item that cannot be settled from a terminal is R4 — the exact gate and cap in pixels — and
Verification step 4 in headed Chrome is where that gets decided.
