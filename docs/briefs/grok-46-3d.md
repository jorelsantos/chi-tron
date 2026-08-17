# Brief: Grok 4.6 3D + cityscape models

**Status:** research only — do not implement in Chi-Tron this pass
**Pinned:** 2026-08-13
**Origin:** [Min Choi thread](https://x.com/minchoi/status/2087926969333698743) + city-model scan
**Stack stay:** MapLibre + deck.gl. No Three.js rewrite.

4.6 is better at **self-contained 3D toys** (one mesh, one small world, shaders + HUD).
It is not a replacement for a live geospatial city.

---

## What the thread actually shows

Ten examples. Four matter for 3D. The rest is cost, 2D Office sim, wedding site, sketch-to-web.

| # | Demo | Engine | What it proves | Chi-Tron use |
|---|---|---|---|---|
| 1 | Unity cozy game (Chong-U) | Unity CLI + Meshy + Imagine | Agent can drive Unity without a human in the editor | Off-product. Cozy low-poly, not us |
| 3 | River crossing, 5 eras (Techartist) | Browser 3D | One site, era slider, HUD vitals, playable camera | Closest *product* analog. Still a diorama, not GIS |
| 5 | Airbus H145 (Harshith) | Three.js, Grok Build | 4.6 High vs 4.5 High: real fuselage vs toy box | Hero mesh quality jumped |
| 8 | Queen Anne's Revenge | Three.js | 4.6 vs GPT-5.6 Terra: better stern, gold, inspect tabs | Studio object + chrome |
| 9 | Canyon racer (Dirty Tesla) | One prompt, 22 min | Shaders, minimap, time, bloom, speed HUD | HUD + atmosphere craft |
| — | Spaceship (DrstaOne) | Procedural Three.js | Hard-surface + bloom + ~1M stars | Lighting/bloom taste |
| 2 | Snowboard | From scratch | Playable 3D game loop | Not a city |

**Benchmark context (Design Arena, 2026-08-13):** Grok 4.6 is 4th in 3D Design, Elo 1370. +11 ranks / +60 Elo vs 4.5. 62.6% faster. Ahead of Fable 5. Behind Kimi K3, Opus 3, Qwen 3.8 Max. Cost demos: ~$0.38 vs Opus ~$2 for a factory scene.

**Honest limit:** these are authored worlds or single objects. None are a live city on real footprints.

---

## What 4.6 is good at (for us)

1. **Hero objects** — one vehicle or one landmark, orbit, spec card.
2. **Small dioramas** — one river, one plaza, era or weather slider.
3. **First-pass visual language** — HUD, bloom, fog, time of day in one shot.
4. **Long agent loops** — stay on a Unity/Three.js file for 20+ min.

## What 4.6 is bad at (for us)

1. Real Chicago geometry at city scale.
2. Keeping CTA live trains on real rails while also being a game engine.
3. Photoreal mesh that still reads as neon (real photos kill Tron).
4. One-prompt "make the Loop" that stays accurate.

---

## Cityscape 3D model landscape

LOD = how much roof/facade detail. Chi-Tron today is **LOD1 boxes**.

| Source | LOD | Real Chicago? | Cost | Fit |
|---|---|---|---|---|
| **What we have** — `scripts/build-buildings.mjs` OSM × City `syp8-uezg` → `buildings.json` fill-extrusion | LOD1 | Yes, Loop bbox | Free | Keep. This is the stage |
| OpenFreeMap / MapLibre extrude | LOD1 | Partial heights | Free | Already the fallback |
| NYC SIM style — Three.js boxes + fake windows on real footprints | LOD1+skin | Yes if we bake | Free | Tempting. Fights our renderer |
| OSM Buildings / streets.gl / F4map | LOD1 windows | OSM only | Free | Window shader, not a new engine |
| Google Photorealistic 3D Tiles | Mesh | Yes | Paid key + ToS | Too real. Kills neon |
| deck.gl `Tile3DLayer` + Google/Cesium | Mesh | Yes | Paid | Same problem |
| Official Chicago CityGML LOD2 | — | **No citywide free LOD2** | — | Footprints + stories only |
| Microsoft / Google AI footprints | LOD0–1 | Yes | Varies | Heights already covered by city stories |
| mrdoob TSL city generator | Procedural | No | Free | Vibe sandbox, fake plan |
| Jason Sturges noir Three.js city | Procedural | No | Free | Mood reference |
| Grok Imagine cyberpunk clips | Video | No | Imagine | Texture/mood only |

Germany has public LOD2 tiles (basemap.de). Chicago does not.

---

## How to try 3D without touching Chi-Tron main

Sandbox repo or `playground/` only. Do not import Three.js into `src/`.

**Worth a weekend (in order):**

1. **Hero L-car / 2200-series** — 4.6 High, Three.js studio, orbit, spec card. Later optional `ScenegraphLayer` on follow-cam. Fails closed if ugly.
2. **Willis + Hancock + Tribune** — three GLBs, dark mass, cyan crown. Drop on baked footprints later. If they fight the extrusion style, keep them off-map as inspect cards.
3. **Night window shader** — stay on MapLibre. Custom layer or fill-extrusion pattern. Fake windows, not photoreal.
4. **Lakefront diorama** — Techartist-style: one pier, weather slider, no GIS. Proves 4.6 world-building. Does not ship in the tracker.

**Do not:**

- Replace MapLibre with Three.js
- Load Google 3D Tiles under neon
- Prompt "Chicago digital twin" as one scene
- Merge a playground into `main` because it looks cool

---

## Chi-Tron 3D that is already in scope

Neon-city plan already deferred real footprints (we now bake them) and vertical L profile.

Better 3D *inside* the current engine:

- Exaggeration + crown already in `style.js` (`HEIGHT_EXAGGERATION`, `buildings-3d-crown`)
- LOOP pitch 58
- Weather as fog/water (pinned in `docs/briefs/city-feeds.md`)
- Follow-cam on trains

That is 3D work. It is not a new renderer.

---

## Links

- Thread: https://x.com/minchoi/status/2087926969333698743
- H145 4.6 vs 4.5: https://x.com/HarshithLucky3/status/2087590866848526447
- River eras: https://x.com/techartist_/status/2087584847212798139
- Canyon world: https://x.com/DirtyTesLa/status/2087702615148646573
- Design Arena 3D Elo: https://x.com/DesignArena/status/2088001659331043808
- Noir procedural city: https://x.com/jasonsturges/status/2075456969167528273
- mrdoob TSL city PR: https://github.com/mrdoob/three.js/pull/33817
- City footprints we already bake: `syp8-uezg` + OSM in `scripts/build-buildings.mjs`
