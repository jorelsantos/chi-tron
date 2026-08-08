# CHI-TRON

**Live nav for Chicago transit** — neon map, real trains, you in the world.

MVP focuses on the **Orange Line**: live vehicle positions, station arrival boards
(CTA Train Tracker), and a Pokémon-Go / Maps-style blue-dot for walking.

**Unofficial fan project — not affiliated with the Chicago Transit Authority.**

## How it works

- **Map first:** full-bleed Grid-in-the-Fog stage; chrome floats on top.
- **Live Orange trains:** CTA Train Tracker `ttpositions` via Vite proxy (`CTA_KEY`).
- **Station board:** tap a station → bottom sheet with `ttarrivals` (minutes / DUE / dest / run).
- **You:** ◎ FAB enables geolocation; follow-me recenters; pan breaks follow (Maps law).
- **Alerts:** keyless CTA Customer Alerts still feed line status.

Buses, Divvy, and full 8-line live are phase 2.

## Setup

```bash
npm install
# .env already needs:
# CTA_KEY=...          # Train Tracker (positions + arrivals)
# CTA_BUS_KEY=...      # optional, phase 2
npm run buildings      # optional downtown mass
npm run dev
```

Open http://localhost:5173/ — allow location when you want the blue dot.

## Controls

| Action | Effect |
|---|---|
| Tap Orange station | Open arrival sheet |
| ◎ FAB | Enable GPS + recenter on me |
| Pan map | Breaks follow-me |
| Esc | Close sheet / release train follow |
| Tap train tip | Follow that run |

## Stack

MapLibre + deck.gl + OpenFreeMap · CTA Train Tracker · Vite key proxy (dev only).

## Stretch

All L lines · buses · Divvy GBFS · production key proxy · deploy.
