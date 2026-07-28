// Ambient traffic simulation (U11, R5). Unlike trains.js/buses.js, cars have
// no live feed in either mode (High-Level Technical Design: "no live car
// feed exists") — CarEngine only ever walks the baked graph from
// scripts/build-roads.mjs, so there's a single tick path, not a live/mock
// split. What it shares with the other two engines is the render contract:
// tick() returns plain {id, pos, heading} objects src/layers.js treats the
// same way it treats trains and buses.

import { now } from './trains.js';

// KTD9 / the High-Level Technical Design's pseudo-code: "a global clock
// decides whether its north-south or east-west approach is green on a ~8s
// cycle." One clock, phase-shifted per node (baked into roads.json) so
// crossing a node's green window at different times produces a wave along a
// corridor rather than every light flipping in lockstep.
const CYCLE_S = 8;

// KTD8's degradation ladder lists "lower the car cap" first — this is the
// number that lever tunes. Budgeted against ~300; left with headroom below
// that so a first pass at the other feeds' costs (buses' trail, glow, etc.)
// doesn't already need touching this to hold the 30fps floor.
export const CAR_CAP = 220;

// Plausible downtown surface-street speed range (m/s) — ~13-27mph including
// the slowdown from cross traffic, well under the trains'/buses' pace.
const MOCK_SPEED_MIN_MPS = 6;
const MOCK_SPEED_MAX_MPS = 12;

// U11's explicit ask: a car frozen off-viewport must not thaw with a `dt`
// covering the whole freeze (a teleport through however many intersections
// it would imply). trains.js's #tickMock has the same unclamped-dt shape and
// gets the identical fix while this file is open (see trains.js's own
// comment on MAX_DT_S).
const MAX_DT_S = 1;

// Sample-ahead distance (meters) for deriving heading from a polyline —
// mirrors buses.js's HEADING_SAMPLE_FT, in meters instead of feet since
// roads.json's lengths are already in meters (unlike CTA's feet).
const HEADING_SAMPLE_M = 8;

// Preference weighting for "prefer straight-ahead and weight by road class"
// (U11's approach). Class weight biases toward staying on arterials, the way
// real ambient through-traffic would; the turn-angle bonus below is what
// actually encodes "prefer straight."
const CLASS_WEIGHT = { primary: 3, secondary: 2, tertiary: 1.3, residential: 1 };

// A pathological zero-length edge chain (shouldn't exist post sink-pruning,
// but "never crash on bad baked data" is this codebase's standing rule) gets
// a hop ceiling rather than an unbounded loop within one tick.
const MAX_HOPS_PER_TICK = 50;

const M_PER_DEG_LAT = 111320;
const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

function cumulativeMeters(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const [lonA, latA] = coords[i - 1];
    const [lonB, latB] = coords[i];
    const dx = (lonB - lonA) * mPerDegLon((latA + latB) / 2);
    const dy = (latB - latA) * M_PER_DEG_LAT;
    cum.push(cum[cum.length - 1] + Math.hypot(dx, dy));
  }
  return cum;
}

// Precomputes both traversal directions' geometry once per edge at load, so
// per-frame interpolation (potentially hundreds of cars, 60x/sec) is a
// binary search over a ready-made array rather than re-deriving it. Distance
// is recomputed from the edge's own coordinates rather than trusting the
// integer-rounded `length` roads.json stores, so interpolation never drifts
// against the array it's actually walking.
function prepareEdge(e) {
  const cum = cumulativeMeters(e.coords);
  const total = cum[cum.length - 1];
  return {
    from: e.from,
    to: e.to,
    length: total,
    cls: e.cls,
    axis: e.axis,
    oneway: e.oneway,
    fwd: { coords: e.coords, cum },
    bwd: { coords: [...e.coords].reverse(), cum: cum.map((c) => total - c).reverse() },
  };
}

// Distance-along-path (meters) -> [lon, lat]. Binary search over a
// cumulative-distance array, identical in shape to buses.js's
// interpolatePattern over pdist — same technique, different unit.
function interpAlong(coords, cum, dist) {
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(dist, total));
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const segLen = cum[hi] - cum[lo];
  const t = segLen > 0 ? (d - cum[lo]) / segLen : 0;
  return [
    coords[lo][0] + t * (coords[hi][0] - coords[lo][0]),
    coords[lo][1] + t * (coords[hi][1] - coords[lo][1]),
  ];
}

function bearingDeg([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * rad);
  const dLat = lat2 - lat1;
  let deg = Math.atan2(dLon, dLat) / rad;
  if (deg < 0) deg += 360;
  return deg;
}

function headingAtDist(coords, cum, dist) {
  const a = interpAlong(coords, cum, dist);
  const b = interpAlong(coords, cum, dist + HEADING_SAMPLE_M);
  if (a[0] === b[0] && a[1] === b[1]) return null;
  return bearingDeg(a, b);
}

/** Builds `nodeId -> [{edgeIdx, dir}]` — every direction of travel actually
 * legal to depart that node. `dir: 'fwd'` (edge.from -> edge.to) is always
 * present; `dir: 'bwd'` (edge.to -> edge.from) only when the edge isn't
 * oneway. This is the single place traversal legality is decided — a car
 * can never pick an illegal direction because this is the only list it ever
 * picks from. Pure and exported for direct testing. */
export function buildAdjacency(edges) {
  const adjacency = new Map();
  const push = (nodeId, entry) => {
    if (!adjacency.has(nodeId)) adjacency.set(nodeId, []);
    adjacency.get(nodeId).push(entry);
  };
  edges.forEach((e, edgeIdx) => {
    push(e.from, { edgeIdx, dir: 'fwd' });
    if (!e.oneway) push(e.to, { edgeIdx, dir: 'bwd' });
  });
  return adjacency;
}

/** KTD9's signal gate: is `axis` currently green at `node` at `tSeconds`?
 * Exactly one of 'ns'/'ew' is green at any node at any instant — the
 * opposite of whichever the node's own baked dominant axis + phase offset
 * says is in its green half of the ~8s cycle. Pure and exported for direct
 * testing (this is what "crossing approaches are never simultaneously
 * green" and the whole stop/go behavior reduce to). */
export function isGreen(node, axis, tSeconds) {
  const cyclePos = (((tSeconds / CYCLE_S + node.phase) % 1) + 1) % 1;
  const dominantIsGreen = cyclePos < 0.5;
  return axis === node.axis ? dominantIsGreen : !dominantIsGreen;
}

/** Picks the next directed edge to depart `arrivalNodeId` onto, given the
 * legal `candidates` from buildAdjacency(). Excludes an immediate U-turn
 * back onto the edge just arrived on unless it's the only legal option (a
 * real dead end — better to bounce than stall). Weighted random among the
 * rest: road class biases toward arterials, and a turn-angle bonus biases
 * toward continuing straight (U11's approach). `rng` defaults to
 * Math.random but is injectable so tests can force a specific pick. Pure
 * (given `rng`) and exported for direct testing. Returns null only when
 * `candidates` itself is empty (an isolated node — shouldn't occur after
 * roads.json's own sink pruning, but never assumed). */
export function pickNextEdge(candidates, edges, currentEdgeIdx, currentDir, incomingHeadingDeg, rng = Math.random) {
  if (!candidates.length) return null;
  const oppositeDir = currentDir === 'fwd' ? 'bwd' : 'fwd';
  let pool = candidates.filter((c) => !(c.edgeIdx === currentEdgeIdx && c.dir === oppositeDir));
  if (pool.length === 0) pool = candidates; // only a U-turn is legal — take it rather than stall

  const weights = pool.map((c) => {
    const edge = edges[c.edgeIdx];
    const path = c.dir === 'fwd' ? edge.fwd : edge.bwd;
    const outHeading = headingAtDist(path.coords, path.cum, 0) ?? incomingHeadingDeg ?? 0;
    const turn =
      incomingHeadingDeg == null ? 0 : Math.abs(((outHeading - incomingHeadingDeg + 540) % 360) - 180);
    const straightBonus = turn < 30 ? 2.5 : turn < 90 ? 1 : 0.4;
    return (CLASS_WEIGHT[edge.cls] ?? 1) * straightBonus;
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** Advances one car in place by `dt` seconds at time `nowSeconds`, crossing
 * as many intersections as `dt * car.speed` covers (each gated by
 * isGreen()), and writes `car.pos`/`car.heading`. Mutates and returns
 * `car`. Pure given `rng` (only consulted at a green multi-way choice) —
 * exported for direct testing of the signal-gate/edge-transition logic
 * without needing CarEngine's viewport/freeze bookkeeping around it. */
export function advanceCar(car, edges, adjacency, nodes, dt, nowSeconds, rng = Math.random) {
  let remaining = Math.max(0, car.speed * dt);
  let hops = 0;
  for (;;) {
    const edge = edges[car.edgeIdx];
    const distToEnd = edge.length - car.dist;
    if (remaining < distToEnd || ++hops > MAX_HOPS_PER_TICK) {
      car.dist = Math.min(edge.length, car.dist + remaining);
      break;
    }
    const arrivalNodeId = car.dir === 'fwd' ? edge.to : edge.from;
    const arrivalNode = nodes[arrivalNodeId];
    // No baked node (shouldn't happen — every edge endpoint is in the node
    // table by construction) reads as an always-green pass-through rather
    // than stranding the car.
    const green = arrivalNode ? isGreen(arrivalNode, edge.axis, nowSeconds) : true;
    if (!green) {
      car.dist = edge.length; // holds at the stop line until the phase flips
      break;
    }
    remaining -= distToEnd;
    const candidates = adjacency.get(arrivalNodeId) ?? [];
    const path = car.dir === 'fwd' ? edge.fwd : edge.bwd;
    const incomingHeading = headingAtDist(path.coords, path.cum, edge.length);
    const chosen = pickNextEdge(candidates, edges, car.edgeIdx, car.dir, incomingHeading, rng);
    if (!chosen) {
      car.dist = edge.length; // isolated node — hold rather than crash
      break;
    }
    car.edgeIdx = chosen.edgeIdx;
    car.dir = chosen.dir;
    car.dist = 0; // `remaining` (the carry-over) keeps consuming from here
  }

  const edge = edges[car.edgeIdx];
  const path = car.dir === 'fwd' ? edge.fwd : edge.bwd;
  car.pos = interpAlong(path.coords, path.cum, car.dist);
  car.heading = headingAtDist(path.coords, path.cum, car.dist) ?? car.heading ?? 0;
  return car;
}

export class CarEngine {
  /** @param {{nodes?: object, edges?: object[]}} roadsData the parsed
   * public/data/roads.json. An engine built from `{}` has zero edges and
   * seeds no cars — main.js's guarded fetch passes that on a missing/failed
   * roads.json so cars are simply absent rather than blocking boot. */
  constructor(roadsData = {}) {
    this.nodes = roadsData.nodes ?? {};
    this.edges = (roadsData.edges ?? []).map(prepareEdge);
    this.adjacency = buildAdjacency(this.edges);
    this.cars = new Map();
    this._nextId = 0;
  }

  /** Seeds up to CAR_CAP cars (regardless of what's requested — the cap is
   * enforced by the engine itself, not by trusting every caller to pass the
   * right number) at random positions/directions across the graph. */
  seed(count = CAR_CAP) {
    this.cars.clear();
    if (this.edges.length === 0) return;
    const n = Math.min(count, CAR_CAP);
    for (let i = 0; i < n; i++) {
      const edgeIdx = Math.floor(Math.random() * this.edges.length);
      const edge = this.edges[edgeIdx];
      const dir = edge.oneway || Math.random() < 0.5 ? 'fwd' : 'bwd';
      const id = `car-${this._nextId++}`;
      this.cars.set(id, {
        id,
        edgeIdx,
        dir,
        dist: Math.random() * edge.length,
        speed: MOCK_SPEED_MIN_MPS + Math.random() * (MOCK_SPEED_MAX_MPS - MOCK_SPEED_MIN_MPS),
        lastTick: null,
        frozen: false,
        pos: null,
        heading: 0,
      });
    }
  }

  /** Advances every car by one frame. `bounds`, when given, is anything
   * exposing `.contains([lon, lat])` (a MapLibre LngLatBounds satisfies
   * this — mirrors hud.js's own `cachedBounds.contains()` use) — a car
   * outside it is frozen: skipped entirely, not even its clock advanced, so
   * it can't accumulate a `dt` debt while off-viewport. A car without a
   * position yet (never ticked) is treated as in-view, the same convention
   * buses.js's capBuses() uses for "hasn't rendered yet" — it can't be
   * fairly culled before it has ever been placed. On the frame a frozen car
   * re-enters view, `lastTick` resets to `nowSeconds` and that frame moves
   * it by dt=0 — thawing advances at most the *next* frame's ordinary
   * step, never the whole freeze's worth of distance. */
  tick(nowSeconds, bounds) {
    for (const car of this.cars.values()) {
      const inView = !car.pos || !bounds || bounds.contains(car.pos);
      if (!inView) {
        car.frozen = true;
        continue; // skipped entirely — its clock doesn't run while off-viewport
      }
      if (car.frozen || car.lastTick == null) {
        // Reset the clock on the exact frame it re-enters view, rather than
        // computing dt against a stale lastTick from before the freeze —
        // that dt would cover the whole freeze and (even after the MAX_DT_S
        // clamp below) could still walk it through more of the graph than
        // one real frame ever would.
        car.frozen = false;
        car.lastTick = nowSeconds;
      }
      const dt = Math.min(Math.max(0, nowSeconds - car.lastTick), MAX_DT_S);
      car.lastTick = nowSeconds;
      advanceCar(car, this.edges, this.adjacency, this.nodes, dt, nowSeconds);
    }
    return [...this.cars.values()].filter((c) => c.pos);
  }
}
