# Brief: design token pass (`index.html` CSS)

**Owner:** Grok
**Auditor:** Claude (cold read of the diff, no context on decisions)
**Branch:** cut a fresh branch off `feat/ux-tracker`
**Status:** not started

---

## Why

The app currently reads as three visual languages on one screen: soft glass
sheets, thin terminal chrome (`2D` / `3D` / `LIVE`, the wordmark), and circular
FABs — plus decorative corner brackets that fight the rounded rectangles they
sit on.

The cause is not taste. It is accumulation. `index.html` defines 36 CSS custom
properties and then ignores them in most rules, so values were re-picked per
feature across sessions. This is the same failure `boot()` had at 1,185 lines:
no shared vocabulary, so every new piece invented its own.

The fix is structural, not aesthetic. Build the vocabulary, then delete the
one-offs. The look barely changes; the drift becomes impossible.

## Current inventory (measured, not estimated)

Counts are occurrences in `index.html`.

**`border-radius` — 10 distinct values, 21 uses**

| px | uses | | px | uses |
|---|---|---|---|---|
| 3 | 1 | | 10 | 3 |
| 4 | 2 | | 12 | 2 |
| 5 | 2 | | 14 | 3 |
| 6 | 1 | | 16 | 1 |
| 8 | 2 | | 999 | 4 |

**`backdrop-filter: blur()` — 6 distinct values, 12 uses**
1px, 8px, 12px, 16px, 18px, 26px (2 uses each)

**White surface alphas `rgba(255,255,255,α)` — 18 distinct values, 47 uses**
0.02, 0.03, 0.04, 0.06, 0.08, 0.1, 0.12, 0.14, 0.15, 0.18, 0.2, 0.25, 0.28,
0.3, 0.32, 0.35, 0.4, 0.45

Note that tokens for several of these already exist and are simply unused.
`--glass-radius-sm: 14px` is declared at line 24. Line 88 then hardcodes
`border-radius: 14px` — the same value and the same intent, with no link
between them. That single pair is the whole problem in miniature.

## Target

Collapse to these counts. Exact mappings are yours to propose.

| Axis | From | To |
|---|---|---|
| radius | 10 | 5 (`pill`, `lg`, `md`, `sm`, `xs`) |
| blur | 6 | 3 (plus documented exceptions) |
| surface alpha | 18 | 5-step ladder |

Reuse the existing `--glass-*` names where they already fit. Do not invent a
parallel naming scheme alongside them.

`blur(1px)` is probably a hairline or texture effect, not a glass surface. Do
not fold it in without checking what it does. Flag it instead.

## Constraints

1. **No behavior change.** Do not edit JS except where a class name you rename
   forces it.
2. **Do not restructure the arrival board's type hierarchy.** The large minute
   count, secondary destination, tertiary clock, and the `TO MIDWAY · 6 trains`
   section header are correct. Leave them alone.
3. **List every collapse.** Any value that changes (for example 10px and 12px
   both becoming 8px) goes in a table in the commit body: old value, new token,
   affected selectors. A pure `14px` → `var(--r-md)` swap renders identically
   and needs no entry.
4. **Do not touch** `dist/`, `public/data/`, or anything under `api/`.

## Definition of done

- `npm run lint`, `npm test`, `npm run build` all pass.
- Before/after screenshots at three states: cold open, browse → Train lines,
  and Orange Line → Western board.
- **Screenshots require headed Chrome.** Headless has no WebGL, so MapLibre
  throws inside `boot()` and the whole app fails silently with zero console
  errors. Use `browse disconnect` then `browse --headed goto
  http://localhost:5173/`, and wait ~10s before probing.
- Commit body carries the collapse table.

## Explicitly NOT in this pass

These are real problems, but they need design judgment, and mixing them into a
mechanical pass makes the diff unreviewable. Separate branch, separate decision.

- The board sheet clips a row in half at its bottom edge. `TO LOOP · 2 trains`
  is followed by a `Loop 2:44 PM 8` row sliced through the middle. The sheet
  height does not align to row boundaries. **This is the most visible flaw in
  the app.**
- Every train line row shows a `LIVE` label and a chevron. All 8 rows, always.
  A label that never varies is decoration. See `src/browse.js:152`.
- The heading "Train lines" sits directly above a TRAIN/BUS tab pair that
  already says TRAIN.
- The OpenFreeMap attribution bar is brighter than the app's own chrome.
- Corner brackets versus rounded rectangles: pick one, apply everywhere.

## Audit

Claude reviews the diff cold, checking:
- every remaining hardcoded radius, blur, and white alpha, with a reason
- each collapse decision in the table against the screenshots
- that no JS behavior moved
- that lint, tests, and build genuinely pass
