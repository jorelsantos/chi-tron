# PART A — Plan

Full plan written to `/Users/jojo/.claude/plans/you-are-claude-opus-nested-pancake.md`. Summary of what it says:

**Decision: rebase, not rewrite.** `git merge-tree --write-tree main origin/feat/divvy` returns a tree with **no conflict**. PR #5 touched `_guard.js`, `tt.js`, `arrivals.js`, `handlers.test.js`; the branch overlaps only on `handlers.test.js`, in a different region.

**Feed contract, verified by curl today:**
- Discovery → `https://gbfs.lyft.com/gbfs/1.1/chi/en/…` for both feeds
- 2046 stations; 2045 `is_installed`; `ttl` 60; `capacity` non-zero on all
- **1.1 `station_status` does carry `num_ebikes_available`** — vendor extension, not GBFS 1.1 standard. This was the live risk; a 1.1 move could have zeroed every e-bike count. It does not.
- 2.3 also 200 on all three URLs

**Five patches on top of the rebase:**
1. Proxy resolves URLs from discovery (6 h cache, 5 min negative, `https:` + host allowlist, no interpolation), `s-maxage` 30 → 45, non-200 → `no-store`, stop forwarding client query params.
2. Zoom gate 12.5 → **13.5** — cold open is 12.6, so the branch drew bikes at near-city scale. Cap 120 → 400, with a `viewportBounds` filter *before* `capBuses`, so the cap stops cutting a circle out of a rectangle.
3. Bake-drift self-heal: >2 % unbaked status ids → one `station_information` fetch per session.
4. Dev proxy 2.3 → 1.1; delete the dead `capNearViewport` re-export.
5. Tests across `handlers.test.js`, `divvy.test.js`, `layers.test.js`.

# PART B — Self-check

17 claims audited. 16 FEASIBLE, 1 WRONG (the 12.5 gate — a real defect, corrected). 6 open RISKs, all accepted and named. 8 corrections applied to Part A.

The one thing a terminal cannot settle: whether 13.5/400 reads right in pixels. Headed-Chrome QA decides it — headless has no WebGL and MapLibre dies silently there.

**VERDICT: READY_TO_IMPLEMENT**
