#!/usr/bin/env node
import { M_PER_DEG_LAT, mPerDegLon } from '../src/tracks.js';

// One-time (re-runnable) ambient-traffic road graph builder: OpenStreetMap
// (via the Overpass API) → public/data/roads.json. U11's car simulation
// walks this graph at runtime; nothing here runs live.
//
// Downtown-only bbox (U10 step 1), deliberately smaller than "the whole
// city" — it only needs to outlast the visible ground at LOOP_PRESET
// (src/style.js), the framing every car-simulation judgment in U11 is tuned
// against. At pitch 60 the far edge of the screen (roughly north, given
// LOOP_PRESET's bearing) shows ground far beyond any bbox this budget could
// afford; the existing atmospheric fog (U7's style.js `sky` block) is what
// actually hides that horizon, not data coverage — this bbox only has to
// clear the *legible*, unfogged foreground.
const BBOX = { minLat: 41.855, minLon: -87.648, maxLat: 41.905, maxLon: -87.605 };

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Exactly the plan's class list (U10 step 1) — no silent narrowing.
const HIGHWAY_CLASSES = 'primary|secondary|tertiary|residential';

const MAX_BYTES = 1024 * 1024; // U10 step 5 — 10x tracks.json's 95 KB.

// Signal-phase axis: which cardinal direction a corridor runs, used both to
// classify each edge's approach (U10 step 4) and to pick each node's
// dominant axis for KTD9's positional phase. Chicago's downtown grid is
// close enough to true north/south and east/west that a simple
// |dLat| vs |dLon| (in meters, not degrees — degrees-of-longitude shrink
// with latitude) split is the right level of complexity; a bearing-angle
// model would be solving a problem this street grid doesn't have.
function axisOf(lonA, latA, lonB, latB) {
  const dx = (lonB - lonA) * mPerDegLon((latA + latB) / 2);
  const dy = (latB - latA) * M_PER_DEG_LAT;
  return Math.abs(dy) >= Math.abs(dx) ? 'ns' : 'ew';
}

function pathLengthMeters(coords) {
  let dist = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lonA, latA] = coords[i - 1];
    const [lonB, latB] = coords[i];
    const dx = (lonB - lonA) * mPerDegLon((latA + latB) / 2);
    const dy = (latB - latA) * M_PER_DEG_LAT;
    dist += Math.hypot(dx, dy);
  }
  return dist;
}

const inBbox = (lat, lon) =>
  lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon;

async function fetchWays() {
  const bboxArg = `${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon}`;
  // out geom(bbox) is the plan's specified clipping mechanism, but Overpass's
  // clip has float-boundary slop at the box edge (verified live 2026-07-28:
  // a handful of points land ~5m outside the requested box despite the
  // geom(bbox) argument) — so every point is re-checked against BBOX below
  // regardless of what the API already clipped. Belt and suspenders is what
  // actually makes the "all coordinates inside bbox" invariant hold.
  const query =
    `[out:json][timeout:180];` +
    `(way["highway"~"^(${HIGHWAY_CLASSES})$"](${bboxArg});); ` +
    `out geom(${bboxArg});`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    // Overpass's front end 406s Node's default fetch headers (no Accept,
    // generic User-Agent) — curl's defaults pass fine, so match them
    // explicitly rather than guessing which header it objects to.
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: '*/*',
      'User-Agent': 'chi-tron-build/1.0 (personal project; build-roads.mjs)',
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();
  return (data.elements ?? []).filter((e) => e.type === 'way');
}

console.log(`Querying Overpass for downtown road graph (bbox ${JSON.stringify(BBOX)})…`);
const ways = await fetchWays();
console.log(`  ${ways.length} ways returned`);
if (ways.length === 0) {
  console.error('ERROR: Overpass returned no ways — refusing to write an empty roads.json');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Split each way into in-bbox runs, then find graph nodes (shared endpoints)
// ---------------------------------------------------------------------------

// Per-way, per-run node lists: [{ nodeId, lon, lat }, ...]. A way that exits
// and re-enters the bbox becomes multiple independent runs — the exit/entry
// points are not connected to each other, since nothing in reality connects
// two disjoint pieces of an OSM way just because the box clipped a gap in it.
const runs = [];
for (const way of ways) {
  const nodes = way.nodes ?? [];
  const geometry = way.geometry ?? [];
  let current = [];
  for (let i = 0; i < nodes.length; i++) {
    const g = geometry[i];
    if (g && inBbox(g.lat, g.lon)) {
      current.push({ nodeId: String(nodes[i]), lon: g.lon, lat: g.lat });
    } else if (current.length) {
      if (current.length > 1) runs.push({ tags: way.tags ?? {}, pts: current });
      current = [];
    }
  }
  if (current.length > 1) runs.push({ tags: way.tags ?? {}, pts: current });
}
console.log(`  ${runs.length} in-bbox way-runs`);

// A node id shared by 2+ runs is a real intersection. Every run's own
// endpoints are graph nodes too (U10 step 2) — including bbox-boundary cuts,
// which is exactly what makes them sinks for step 3 to prune.
const refCount = new Map();
for (const run of runs) {
  const seen = new Set(run.pts.map((p) => p.nodeId));
  for (const id of seen) refCount.set(id, (refCount.get(id) ?? 0) + 1);
}
const isGraphNode = (id, run) =>
  refCount.get(id) > 1 || run.pts[0].nodeId === id || run.pts[run.pts.length - 1].nodeId === id;

// Walk each run, splitting into edges at every graph node.
const nodeCoords = new Map(); // nodeId -> [lon, lat]
const edges = [];
for (const run of runs) {
  let segStart = 0;
  for (let i = 1; i < run.pts.length; i++) {
    const p = run.pts[i];
    if (!isGraphNode(p.nodeId, run) && i !== run.pts.length - 1) continue;
    const seg = run.pts.slice(segStart, i + 1);
    if (seg.length < 2) {
      segStart = i;
      continue;
    }
    const from = seg[0];
    const to = seg[seg.length - 1];
    const coords = seg.map((pt) => [pt.lon, pt.lat]);
    nodeCoords.set(from.nodeId, [from.lon, from.lat]);
    nodeCoords.set(to.nodeId, [to.lon, to.lat]);
    const onewayTag = String(run.tags.oneway ?? '').toLowerCase();
    edges.push({
      from: from.nodeId,
      to: to.nodeId,
      coords,
      length: Math.round(pathLengthMeters(coords)),
      cls: run.tags.highway,
      axis: axisOf(from.lon, from.lat, to.lon, to.lat),
      oneway: onewayTag === 'yes' || onewayTag === 'true' || onewayTag === '1',
    });
    segStart = i;
  }
}
console.log(`  ${nodeCoords.size} graph nodes, ${edges.length} edges before sink pruning`);

// ---------------------------------------------------------------------------
// Iteratively prune sinks (U10 step 3) — a node with no legal outbound edge,
// together with every edge that terminates there (its former inbound
// edges), since an edge into a dead end is equally useless to a car.
// ---------------------------------------------------------------------------

let liveEdges = edges;
let prunedSinkCount = 0;
for (;;) {
  const outbound = new Map();
  for (const id of nodeCoords.keys()) outbound.set(id, 0);
  for (const e of liveEdges) {
    outbound.set(e.from, (outbound.get(e.from) ?? 0) + 1);
    if (!e.oneway) outbound.set(e.to, (outbound.get(e.to) ?? 0) + 1);
  }
  const sinks = [...outbound.entries()].filter(([, c]) => c === 0).map(([id]) => id);
  if (sinks.length === 0) break;
  const sinkSet = new Set(sinks);
  for (const id of sinks) nodeCoords.delete(id);
  liveEdges = liveEdges.filter((e) => !sinkSet.has(e.from) && !sinkSet.has(e.to));
  prunedSinkCount += sinks.length;
}
console.log(
  `  pruned ${prunedSinkCount} sink nodes iteratively; ${nodeCoords.size} nodes, ${liveEdges.length} edges remain`
);

// ---------------------------------------------------------------------------
// Bake each node's positional signal phase (KTD9) along its dominant axis.
// ---------------------------------------------------------------------------

const nsIncident = new Map();
const ewIncident = new Map();
const bump = (map, id) => map.set(id, (map.get(id) ?? 0) + 1);
for (const e of liveEdges) {
  const map = e.axis === 'ns' ? nsIncident : ewIncident;
  bump(map, e.from);
  bump(map, e.to);
}

const latSpan = BBOX.maxLat - BBOX.minLat;
const lonSpan = BBOX.maxLon - BBOX.minLon;

const nodes = {};
for (const [id, [lon, lat]] of nodeCoords) {
  const ns = nsIncident.get(id) ?? 0;
  const ew = ewIncident.get(id) ?? 0;
  const axis = ns >= ew ? 'ns' : 'ew';
  // Linear function of position along the dominant axis (KTD9), normalized
  // to 0..1 across the bbox so consecutive intersections on one corridor
  // get progressive, monotonic offsets rather than an arbitrary hash.
  const phase = axis === 'ns' ? (lat - BBOX.minLat) / latSpan : (lon - BBOX.minLon) / lonSpan;
  // 6 decimals, matching coords' own precision: at 4 decimals, two nodes
  // sharing (near-)identical lat/lon rounded their phase in opposite
  // directions often enough to break strict monotonicity (verified live
  // 2026-07-28 — two same-latitude nodes landed at .4362/.4363 reversed).
  nodes[id] = { coords: [Number(lon.toFixed(6)), Number(lat.toFixed(6))], axis, phase: Number(phase.toFixed(6)) };
}

const edgesOut = liveEdges.map((e) => ({
  from: e.from,
  to: e.to,
  coords: e.coords.map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]),
  length: e.length,
  cls: e.cls,
  axis: e.axis,
  oneway: e.oneway,
}));

const out = { bbox: BBOX, nodes, edges: edgesOut };
const json = JSON.stringify(out);
const bytes = Buffer.byteLength(json);

console.log(`  output size: ${(bytes / 1024).toFixed(0)} KB (budget ${MAX_BYTES / 1024} KB)`);
if (bytes > MAX_BYTES) {
  console.error(
    `ERROR: roads.json is ${(bytes / 1024).toFixed(0)} KB, over the ${MAX_BYTES / 1024} KB budget — ` +
      'shrink BBOX or narrow HIGHWAY_CLASSES rather than shipping an oversized file.'
  );
  process.exit(1);
}

const { writeFileSync, existsSync, readFileSync } = await import('node:fs');
const { join, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/data/roads.json');

writeFileSync(OUT, json);
console.log(`Wrote ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(0)} KB)`);
if (!existsSync(OUT)) process.exit(1);
