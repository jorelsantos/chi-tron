#!/usr/bin/env node
// Bake Loop buildings: OSM footprints (good shapes) × City of Chicago stories (good heights).
//
// Sources (free):
// - OSM buildings via Overpass `out geom` (lz4.overpass-api.de)
// - City of Chicago Building Footprints syp8-uezg (stories + the_geom)
//
// Height priority: city stories → OSM height → OSM building:levels → floor.
// Emits public/data/buildings.json for MapLibre fill-extrusion.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/data/buildings.json');
const CITY_DATASET = 'syp8-uezg';
// Rotate mirrors on failure (primary first).
const OVERPASS_MIRRORS = [
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const STORY_M = 3.2;
const FLOOR_HEIGHT_M = 8;
const MAX_HEIGHT_M = 550;
const MAX_BYTES = 8 * 1024 * 1024;
// Drop pure floor-height sheds — OFM covers low mass outside/under.
const MIN_KEEP_H = 12;

// Loop + near-downtown (larger than prior city-only bake — OSM shapes compress better)
const BBOX = { south: 41.85, west: -87.67, north: 41.93, east: -87.59 };
// Tile Overpass queries to stay under timeouts (~0.02° ≈ 2 km)
const TILE = 0.025;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pointInRing(lon, lat, ring) {
  // Ray cast; ring is [[lon,lat],...]
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function centroidOfRing(ring) {
  // Average of vertices except closing duplicate
  let n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n -= 1;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return [sx / n, sy / n];
}

function simplifyRing(ring, step = 1) {
  // 4-decimal coords (~11m) — enough for skyline silhouettes, smaller JSON
  const q = (v) => Math.round(v * 1e4) / 1e4;
  if (ring.length <= 12 || step <= 1) {
    return ring.map(([lon, lat]) => [q(lon), q(lat)]);
  }
  const out = [];
  for (let i = 0; i < ring.length - 1; i += step) {
    out.push([q(ring[i][0]), q(ring[i][1])]);
  }
  const last = ring[ring.length - 1];
  out.push([q(last[0]), q(last[1])]);
  if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) {
    out.push([...out[0]]);
  }
  return out;
}

// --- City stories index (grid for fast point-in-polygon) ---

function gridKey(lon, lat, cell = 0.002) {
  return `${Math.floor(lon / cell)}_${Math.floor(lat / cell)}`;
}

async function fetchCityPolygons() {
  const where = encodeURIComponent(
    `within_box(the_geom,${BBOX.north},${BBOX.west},${BBOX.south},${BBOX.east})`
  );
  const url =
    `https://data.cityofchicago.org/resource/${CITY_DATASET}.json` +
    `?$where=${where}&$select=the_geom,stories,no_stories&$limit=50000`;
  console.log('Fetching City of Chicago footprints…');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`City SODA HTTP ${res.status}`);
  const rows = await res.json();
  const polys = [];
  const grid = new Map();
  for (const row of rows) {
    const g = row.the_geom;
    if (!g || g.type !== 'MultiPolygon') continue;
    const stories = Number(row.stories ?? row.no_stories);
    if (!Number.isFinite(stories) || stories <= 0) continue;
    const exterior = g.coordinates[0][0];
    if (!exterior || exterior.length < 4) continue;
    const poly = { ring: exterior, stories, h: Math.min(MAX_HEIGHT_M, stories * STORY_M) };
    polys.push(poly);
    const [cx, cy] = centroidOfRing(exterior);
    const k = gridKey(cx, cy);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(poly);
    // also index by a few neighbor cells of the ring bbox for robustness
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of exterior) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    for (let x = minX; x <= maxX; x += 0.002) {
      for (let y = minY; y <= maxY; y += 0.002) {
        const kk = gridKey(x, y);
        if (!grid.has(kk)) grid.set(kk, []);
        const arr = grid.get(kk);
        if (arr[arr.length - 1] !== poly) arr.push(poly);
      }
    }
  }
  console.log(`  city polys with stories: ${polys.length}`);
  return { polys, grid };
}

function cityHeightAt(lon, lat, index) {
  const candidates = new Set();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const k = `${Math.floor(lon / 0.002) + dx}_${Math.floor(lat / 0.002) + dy}`;
      for (const p of index.grid.get(k) ?? []) candidates.add(p);
    }
  }
  for (const p of candidates) {
    if (pointInRing(lon, lat, p.ring)) return p.h;
  }
  return null;
}

// --- OSM via Overpass out geom ---

function tilesForBbox() {
  const tiles = [];
  for (let s = BBOX.south; s < BBOX.north; s += TILE) {
    for (let w = BBOX.west; w < BBOX.east; w += TILE) {
      tiles.push({
        south: s,
        west: w,
        north: Math.min(s + TILE, BBOX.north),
        east: Math.min(w + TILE, BBOX.east),
      });
    }
  }
  return tiles;
}

async function fetchOsmTile(tile, attempt = 0) {
  const { south, west, north, east } = tile;
  // Round coords so floating dust doesn't break queries.
  const s = +south.toFixed(5);
  const w = +west.toFixed(5);
  const n = +north.toFixed(5);
  const e = +east.toFixed(5);
  const query = `[out:json][timeout:90];
(
  way["building"](${s},${w},${n},${e});
  relation["building"](${s},${w},${n},${e});
);
out geom;`;
  const url = OVERPASS_MIRRORS[attempt % OVERPASS_MIRRORS.length];
  try {
    // Overpass returns 406 without a User-Agent (Node fetch default is empty).
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'chi-tron-buildings/0.1 (local offline bake; contact: local)',
        Accept: 'application/json',
      },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) {
      if (attempt < 8) {
        await sleep(2000 * (attempt + 1));
        return fetchOsmTile(tile, attempt + 1);
      }
      throw new Error(`Overpass HTTP ${res.status} tile ${s},${w}`);
    }
    return res.json();
  } catch (err) {
    if (attempt < 8) {
      await sleep(2000 * (attempt + 1));
      return fetchOsmTile(tile, attempt + 1);
    }
    throw err;
  }
}

function ringFromGeom(geometry) {
  if (!geometry?.length) return null;
  const ring = geometry.map((p) => [p.lon, p.lat]);
  if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
    ring.push([...ring[0]]);
  }
  return ring.length >= 4 ? ring : null;
}

function heightFromOsmTags(tags, cityH) {
  if (cityH != null) return Math.min(MAX_HEIGHT_M, Math.max(FLOOR_HEIGHT_M, cityH));
  if (tags?.height) {
    const m = parseFloat(String(tags.height).replace(/m$/i, ''));
    if (Number.isFinite(m) && m > 0) return Math.min(MAX_HEIGHT_M, Math.max(FLOOR_HEIGHT_M, m));
  }
  const levels = Number(tags?.['building:levels']);
  if (Number.isFinite(levels) && levels > 0) {
    return Math.min(MAX_HEIGHT_M, Math.max(FLOOR_HEIGHT_M, levels * STORY_M));
  }
  return FLOOR_HEIGHT_M;
}

function featureFromWay(el, cityIndex) {
  const ring = ringFromGeom(el.geometry);
  if (!ring) return null;
  // skip tiny sheds
  const [cx, cy] = centroidOfRing(ring);
  if (cx < BBOX.west || cx > BBOX.east || cy < BBOX.south || cy > BBOX.north) return null;
  const cityH = cityHeightAt(cx, cy, cityIndex);
  const h = heightFromOsmTags(el.tags, cityH);
  if (h < MIN_KEEP_H) return null;
  const step = ring.length > 60 ? 3 : ring.length > 30 ? 2 : 1;
  const simplified = simplifyRing(ring, step);
  return {
    type: 'Feature',
    properties: {
      h: Math.round(h * 10) / 10,
      src: cityH != null ? 'city' : el.tags?.height ? 'osm-h' : el.tags?.['building:levels'] ? 'osm-l' : 'floor',
    },
    geometry: { type: 'Polygon', coordinates: [simplified] },
  };
}

function featuresFromRelation(el, cityIndex) {
  // outer members with geometry
  const outers = (el.members || []).filter((m) => m.role === 'outer' && m.geometry);
  if (!outers.length) return [];
  const feats = [];
  for (const m of outers) {
    const ring = ringFromGeom(m.geometry);
    if (!ring) continue;
    const [cx, cy] = centroidOfRing(ring);
    const cityH = cityHeightAt(cx, cy, cityIndex);
    const h = heightFromOsmTags(el.tags, cityH);
    if (h < MIN_KEEP_H) continue;
    const step = ring.length > 60 ? 3 : ring.length > 30 ? 2 : 1;
    const simplified = simplifyRing(ring, step);
    feats.push({
      type: 'Feature',
      properties: {
        h: Math.round(h * 10) / 10,
        src: cityH != null ? 'city' : el.tags?.height ? 'osm-h' : el.tags?.['building:levels'] ? 'osm-l' : 'floor',
      },
      geometry: { type: 'Polygon', coordinates: [simplified] },
    });
  }
  return feats;
}

async function main() {
  const cityIndex = await fetchCityPolygons();
  const tiles = tilesForBbox();
  console.log(`Fetching OSM buildings over ${tiles.length} tiles via Overpass…`);
  const features = [];
  let joined = 0;
  let osmOnly = 0;
  const seen = new Set();

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    process.stdout.write(`  tile ${i + 1}/${tiles.length}… `);
    try {
      const data = await fetchOsmTile(tile);
      let n = 0;
      for (const el of data.elements || []) {
        if (el.type === 'way' && el.tags?.building && el.geometry) {
          const id = `w${el.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const f = featureFromWay(el, cityIndex);
          if (!f) continue;
          if (f.properties.src === 'city') joined++;
          else osmOnly++;
          features.push(f);
          n++;
        } else if (el.type === 'relation' && el.tags?.building) {
          const id = `r${el.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          for (const f of featuresFromRelation(el, cityIndex)) {
            if (f.properties.src === 'city') joined++;
            else osmOnly++;
            features.push(f);
            n++;
          }
        }
      }
      console.log(`+${n} (total ${features.length})`);
    } catch (err) {
      console.log(`FAIL ${err.message}`);
    }
    await sleep(1200); // be kind to Overpass
  }

  if (features.length < 500) {
    console.error(`FAIL: only ${features.length} features — Overpass incomplete`);
    process.exit(1);
  }

  // Prefer tall + city-joined if still over budget.
  features.sort((a, b) => {
    const sa = (a.properties.src === 'city' ? 1e6 : 0) + a.properties.h;
    const sb = (b.properties.src === 'city' ? 1e6 : 0) + b.properties.h;
    return sb - sa;
  });

  let kept = features;
  // Strip src after stats (runtime only needs h)
  const strip = (arr) =>
    arr.map((f) => ({
      type: 'Feature',
      properties: { h: f.properties.h },
      geometry: f.geometry,
    }));

  let outFeatures = strip(kept);
  let json = JSON.stringify({ type: 'FeatureCollection', features: outFeatures });
  while (json.length > MAX_BYTES && kept.length > 2000) {
    kept = kept.slice(0, Math.floor(kept.length * 0.85));
    outFeatures = strip(kept);
    json = JSON.stringify({ type: 'FeatureCollection', features: outFeatures });
    console.log(`  trim → ${kept.length} features (${json.length} bytes)`);
  }
  if (json.length > MAX_BYTES) {
    console.error(`FAIL: ${json.length} bytes > ${MAX_BYTES} after trim`);
    process.exit(1);
  }

  writeFileSync(OUT, json);
  const heights = outFeatures.map((f) => f.properties.h);
  const maxH = Math.max(...heights, 0);
  const keptJoined = kept.filter((f) => f.properties.src === 'city').length;
  const cityPct = kept.length ? ((keptJoined / kept.length) * 100).toFixed(1) : 0;
  console.log(
    `Wrote ${OUT}\n  features=${outFeatures.length} cityJoin=${keptJoined}/${joined} osm/floor=${osmOnly} city%=${cityPct}\n  bytes=${json.length} maxH=${maxH}m`
  );
  if (maxH < 200) {
    console.warn('WARN: maxH < 200m — tall towers may be missing from Overpass coverage');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
