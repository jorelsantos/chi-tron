# CHI-TRON — Lightcycle Consist + Loop Ribbons

**Status:** locked for implementation  
**Branch:** `feat/train-consist` off `main`  
**Scope:** L rails + train vehicles only. Buses / Divvy / cinema / Unity stay out.

## Locked choices

| Slot | Choice |
|------|--------|
| Loop overlap | **A1** — parallel offset ribbons in the Loop |
| Line graphic | **B1** — thin hot core + tight halo |
| Vehicle | **C1** — three-car consist, skinny, in succession |

---

## Design thesis

Tron is not a fat neon highlighter. It is a **white-hot filament** with a **thin colored bloom**. Blade Runner is **black air + isolated color**, not a muddled rainbow. Cyberpunk power is **hierarchy**: the corridor is steel; the *vehicle* is the event.

Today the Loop is eight glows on one path. The “train” is a rounded bolt (~72 m × 14 m). On a phone that is a **soft oval on a smeared tube**.

We make the **rail a precision instrument** and the **consist a short blade of light with joints**.

---

## World rules

1. **Color stays CTA.** We do not rehue Red/Blue/Brown. We change *structure*.
2. **Steel first, neon second.** Shared structure is cold. Identity lives on the ribbon core and the cars.
3. **Thin is powerful.** If it looks like a highlighter, it is too wide.
4. **The consist is the character.** Three cars, hairline couplers, white-hot lead nose. Not a worm. Not eight scale cars.
5. **City zoom is calm.** Offsets collapse. One spine. Color rides on trains only.

---

## A1 — Loop ribbons

### Feel

Downtown elevated: **ribbons of light laid side by side**, like the official CTA map, but as Tron tubes — not printed ink.

### How

- Detect the **shared Loop / inner-core corridor** (bbox around the elevated Loop + short approaches). Outside that bbox, each line stays on its true geometry (no offset).
- Inside the bbox, offset each line **perpendicular to local heading** by  
  `(slot - mid) * SPACING_M`.
- **Loop stack (south → north / inside → outside), stable:**  
  Pink → Orange → Green → Brown → Purple → Red  
  (Blue / Yellow barely share this corridor; they keep ~0 slot or a small unique offset if they clip the bbox.)
- **Spacing:** ~9–11 m at Loop zoom so six ribbons read as separate tubes, not one cable.
- **Ease:** 80–150 m lerp at bbox edges so lines don’t kink when they leave the Loop.
- **Zoom:**  
  - `z ≥ 13.2` — full offset  
  - `12.4–13.2` — offset lerp toward 0  
  - `z < 12.4` — **one shared steel spine** (underglow only; no per-line rainbow)

Trains **do not** ride the offset art. They stay on **true track geometry** so live positions stay honest. The ribbon is a **map legend in space**. The consist is the **truth of the vehicle**.

If a train looks “off the colored tube” by a few meters in the Loop, that is acceptable. Identity is the **car color + trail**, not snapping GPS to the schematic.

### Files

- `src/track-offset.js` (new) — bbox, slot table, perpendicular offset, edge ease. Unit tests.
- `src/map-stage.js` — feed offset coords into `l-tracks` (or a second source `l-tracks-loop` at high zoom). Prefer **one source, two geometries swapped/interpolated by zoom** to avoid double-draw.

---

## B1 — Thin hot core

### Feel

A **fiber of light**: almost-white core, a finger of brand color, almost no fog.

### Recipe (replace the current 5 / 2 / 0.7 px stack)

| Layer | Role | Direction |
|-------|------|-----------|
| `l-tracks-wide` | Atmosphere | Opacity ~0.06–0.08, blur ≤ 1, much narrower |
| `l-tracks-mid` | Brand tube | Opacity ~0.55, **no blur** or blur 0.4, thin |
| `l-tracks-core` | Filament | Near-white mix of line color (e.g. `mix(color, #fff, 0.55)`), opacity ~0.95, **hairline** |

Kill the 14 px / blur-3 “mud halo.” That is what makes the Loop look stale.

Alerts / stress still multiply opacity. A disrupted line **dims and cools**; it does not get fatter.

---

## C1 — Three-car consist

### Feel

Not a bus capsule. Not a lightcycle sausage.

A **short articulated blade**: three slivers of light, **gaps you can count**, moving as one animal. Lead car is the **pilot** (white-hot nose). Trailers are **line-color**. Couplers are **hairline sparks**, not chunky bars.

Think: Tron cycle that *unfolded into a consist*. Blade Runner: compact, wet, no cute windows.

### Scale (phone-first, Loop 2D)

| Piece | Length (along rail) | Width |
|-------|---------------------|--------|
| Lead | ~16 m | core ~3.5 m, halo ~7 m |
| Mid / tail | ~14 m each | same |
| Gap / coupler | ~4 m empty + 1 m spark | thinner than cars |
| **Total** | **~68 m** | skinny vs today’s 14 m halo |

`widthMinPixels` must drop (halo ~5–7 px, core ~2–3 px) or it still reads oval.

### Motion

- Same heading as `trainBoltPath` today (bearing from trail).
- Cars laid **behind** the head along that bearing (or along last trail samples if we want curve-following — **prefer trail samples** so the consist **bends** on Loop corners instead of a rigid stick).
- **Trail (`TripsLayer`)** only from the **tail car**. Slightly longer, thinner, additive. The consist is the body; the trail is residual charge on the wire.
- **Pick target:** lead + mid + tail as one hit (or invisible hull). Follow still tracks the CTA vehicle id.

### Implementation

- Replace `train-bolt-halo` / `train-bolt-core` with:
  - `train-cars-halo` / `train-cars-core` (PathLayer, 3 paths per train)
  - `train-couplers` (optional short PathLayer, dim white/line)
- Helper `consistPaths(train) → { cars: Path[], couplers: Path[] }` in `src/layers.js` or `src/train-consist.js`.
- Tests: 3 car paths; ids stay strings; gap > 0; lead uses hot core.

---

## What we will not do

- Unity / Three.js / cinematic camera package  
- Offsetting live train positions onto schematic rails  
- Recoloring Brown/Orange again  
- Eight real-scale cars  
- Touching bus capsules or Divvy dots  

---

## Phases

0. Branch `feat/train-consist`. Screenshot baseline: Loop 2D, one train close-up.  
1. `track-offset.js` + tests. Wire into map-stage. Phone: Loop shows **separate tubes**.  
2. Retune `l-tracks-*` to B1.  
3. Consist helper + swap bolt layers. Trail from tail.  
4. Tune minPixels / meters on a phone.  
5. Tests + headed/phone QA. PR.

## Done when

- Loop at 2D street/Loop zoom: **you can name lines without a legend**.  
- City zoom: **one spine**, not a rainbow rope.  
- A train is **visibly three cars** at Loop zoom, not an oval.  
- Tron read: **hot filament**, not highlighter.  
- `npm test` / lint / build green. No CTA API changes.

---

## Creative north star (one sentence)

**The city is a black grid. The Loop is a harp of light. Each train is three sparks chained together, hunting the rail.**
