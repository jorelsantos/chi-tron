# CHI-TRON

A real-time map of the Chicago L as a Tron grid — live CTA trains rendered as
glowing light-cycles pulling neon trails over a dark 3D city. Blade Runner /
Cyberpunk Edgerunners aesthetic, Mini Tokyo 3D lineage.

**Unofficial fan project — not affiliated with the Chicago Transit Authority.**

## How it works

- **Live data:** CTA Train Tracker API (`ttpositions.aspx`), polled every 5s
  through a Vite dev proxy that injects the API key server-side (the key never
  reaches client code).
- **Motion:** each train is snapped to its line's real track geometry (from CTA
  static GTFS `shapes.txt`) and tweened between position reports — continuous
  glide, honest positions.
- **Rendering:** MapLibre GL (custom dark style on keyless OpenFreeMap vector
  tiles, 3D building extrusions) + deck.gl `TripsLayer` for the fading trails.

## Setup

```bash
npm install
node scripts/build-tracks.mjs   # one-time: downloads CTA GTFS → tracks.json
echo "CTA_KEY=your-key-here" > .env
npm run dev
```

Get a free API key at the [CTA developer center](https://www.transitchicago.com/developers/traintrackerapply/).

No key? `http://localhost:5173/?mock=1` runs synthetic trains on the real tracks.

## Stretch layers (not built)

Deploy (GitHub Pages + key-proxy worker), CTA buses, Metra, Divvy, O'Hare/Midway
air traffic, sound design.
