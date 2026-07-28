// U11 (R5) — coverage for the pure logic in cars.js: the signal gate
// (isGreen), edge-transition legality (buildAdjacency), the graph-walk
// (advanceCar), and CarEngine's cap/viewport-freeze bookkeeping. No DOM, no
// real network — matches trains.test.js/buses.test.js's plain-Node style.
// Built test-first per the plan's execution note for this unit.

import { describe, it, expect } from 'vitest';
import { CarEngine, CAR_CAP, buildAdjacency, isGreen, pickNextEdge, advanceCar } from './cars.js';

// A straight 3-node north-south corridor, ~111m per hop (1/1000th of a
// degree of latitude), both edges two-way. Real-shaped enough for the
// distance/heading math without needing actual Chicago geometry.
const NODE_A = { coords: [-87.65, 41.88], axis: 'ns', phase: 0 };
const NODE_B = { coords: [-87.65, 41.881], axis: 'ns', phase: 0 };
const NODE_C = { coords: [-87.65, 41.882], axis: 'ns', phase: 0 };
const NODES = { A: NODE_A, B: NODE_B, C: NODE_C };
const RAW_EDGES = [
  { from: 'A', to: 'B', coords: [NODE_A.coords, NODE_B.coords], length: 111, cls: 'secondary', axis: 'ns', oneway: false },
  { from: 'B', to: 'C', coords: [NODE_B.coords, NODE_C.coords], length: 111, cls: 'secondary', axis: 'ns', oneway: false },
];

// advanceCar/pickNextEdge take prepared edges (fwd/bwd cumulative-distance
// arrays) — build them the same way CarEngine's constructor does, without
// pulling CarEngine itself into these lower-level tests.
function prepared(raw) {
  return new CarEngine({ nodes: {}, edges: raw }).edges;
}

describe('isGreen', () => {
  it('is green for the node axis at cycle position 0, red at cycle position 0.5', () => {
    expect(isGreen(NODE_A, 'ns', 0)).toBe(true);
    expect(isGreen(NODE_A, 'ns', 4)).toBe(false); // half of the 8s cycle
  });

  it('never has both axes green at once, at any point in the cycle', () => {
    for (let t = 0; t < 8; t += 0.37) {
      expect(isGreen(NODE_A, 'ns', t)).toBe(!isGreen(NODE_A, 'ew', t));
    }
    const ewNode = { ...NODE_A, axis: 'ew' };
    for (let t = 0; t < 8; t += 0.53) {
      expect(isGreen(ewNode, 'ns', t)).toBe(!isGreen(ewNode, 'ew', t));
    }
  });
});

describe('buildAdjacency', () => {
  it('exposes both directions for a two-way edge', () => {
    const edges = [{ from: 'A', to: 'B', oneway: false }];
    const adj = buildAdjacency(edges);
    expect(adj.get('A')).toEqual([{ edgeIdx: 0, dir: 'fwd' }]);
    expect(adj.get('B')).toEqual([{ edgeIdx: 0, dir: 'bwd' }]);
  });

  it('exposes exactly one direction for a oneway edge — never the reverse', () => {
    const edges = [{ from: 'A', to: 'B', oneway: true }];
    const adj = buildAdjacency(edges);
    expect(adj.get('A')).toEqual([{ edgeIdx: 0, dir: 'fwd' }]);
    expect(adj.get('B') ?? []).toEqual([]); // no bwd entry — B has no legal way back onto this edge
  });
});

describe('advanceCar', () => {
  it('crosses its node onto a new edge when the approach is green', () => {
    const edges = prepared(RAW_EDGES);
    const adjacency = buildAdjacency(edges);
    const car = { edgeIdx: 0, dir: 'fwd', dist: edges[0].length - 5, speed: 10, heading: 0 };
    // nowSeconds 0 -> cycle position 0 -> NODE_B's own axis (ns) is green.
    advanceCar(car, edges, adjacency, NODES, /* dt */ 1, /* nowSeconds */ 0, () => 0);
    expect(car.edgeIdx).toBe(1);
    expect(car.dir).toBe('fwd');
  });

  it('carries over leftover distance after the transition rather than discarding it', () => {
    const edges = prepared(RAW_EDGES);
    const adjacency = buildAdjacency(edges);
    const car = { edgeIdx: 0, dir: 'fwd', dist: edges[0].length - 5, speed: 10, heading: 0 };
    advanceCar(car, edges, adjacency, NODES, 1, 0, () => 0); // 10m of travel, 5m to the node, 5m left over
    expect(car.dist).toBeCloseTo(5, 5);
  });

  it('stops before the node on a red approach and resumes once the phase flips', () => {
    const edges = prepared(RAW_EDGES);
    const adjacency = buildAdjacency(edges);
    const car = { edgeIdx: 0, dir: 'fwd', dist: edges[0].length - 5, speed: 10, heading: 0 };
    // nowSeconds 4 -> cycle position 0.5 -> NODE_B's axis is red.
    advanceCar(car, edges, adjacency, NODES, 1, 4, () => 0);
    expect(car.edgeIdx).toBe(0);
    expect(car.dist).toBeCloseTo(edges[0].length, 5); // held at the stop line, not past it

    // A full cycle later (nowSeconds 8 -> cycle position 0 again) the same
    // approach is green, and the same small dt is now enough to cross.
    advanceCar(car, edges, adjacency, NODES, 1, 8, () => 0);
    expect(car.edgeIdx).toBe(1);
  });

  it('never selects a oneway edge against its direction', () => {
    const onewayEdges = [
      { from: 'A', to: 'B', coords: [NODE_A.coords, NODE_B.coords], length: 111, cls: 'secondary', axis: 'ns', oneway: true },
      { from: 'B', to: 'C', coords: [NODE_B.coords, NODE_C.coords], length: 111, cls: 'secondary', axis: 'ns', oneway: false },
    ];
    const edges = prepared(onewayEdges);
    const adjacency = buildAdjacency(edges);
    const car = { edgeIdx: 0, dir: 'fwd', dist: edges[0].length - 5, speed: 10, heading: 0 };
    for (let i = 0; i < 5; i++) {
      advanceCar(car, edges, adjacency, NODES, 1, 0, () => Math.random());
      // The oneway edge (index 0) only ever has a legal 'fwd' direction —
      // buildAdjacency never offers 'bwd' on it, so no rng draw could land there.
      if (car.edgeIdx === 0) expect(car.dir).toBe('fwd');
    }
  });
});

describe('pickNextEdge', () => {
  it('excludes an immediate U-turn when another legal option exists', () => {
    const edges = prepared(RAW_EDGES);
    const candidates = [
      { edgeIdx: 0, dir: 'bwd' }, // the reverse of the edge just arrived on
      { edgeIdx: 1, dir: 'fwd' },
    ];
    const chosen = pickNextEdge(candidates, edges, 0, 'fwd', 0, () => 0);
    expect(chosen).toEqual({ edgeIdx: 1, dir: 'fwd' });
  });

  it('takes the U-turn at a real dead end rather than returning null', () => {
    const edges = prepared(RAW_EDGES);
    const candidates = [{ edgeIdx: 0, dir: 'bwd' }];
    const chosen = pickNextEdge(candidates, edges, 0, 'fwd', 0, () => 0);
    expect(chosen).toEqual({ edgeIdx: 0, dir: 'bwd' });
  });

  it('returns null for a genuinely empty candidate list', () => {
    expect(pickNextEdge([], [], 0, 'fwd', 0)).toBeNull();
  });
});

describe('CarEngine', () => {
  const roadsData = { nodes: NODES, edges: RAW_EDGES };

  it('seeds at most CAR_CAP cars no matter how many are requested', () => {
    const engine = new CarEngine(roadsData);
    engine.seed(CAR_CAP * 10);
    expect(engine.cars.size).toBe(CAR_CAP);
    engine.seed(CAR_CAP * 10); // re-seeding doesn't accumulate past the cap either
    expect(engine.cars.size).toBe(CAR_CAP);
  });

  it('skips cars outside the viewport entirely — position never changes while frozen', () => {
    const engine = new CarEngine(roadsData);
    engine.seed(1);
    const inView = { contains: () => true };
    engine.tick(0, inView); // establish an initial position
    const [car] = engine.cars.values();
    const posAtFreeze = car.pos;

    const outOfView = { contains: () => false };
    engine.tick(100, outOfView);
    engine.tick(500, outOfView);
    expect(car.pos).toEqual(posAtFreeze);
  });

  it('thaws a long-frozen car by resetting its clock, not by teleporting through the graph', () => {
    const engine = new CarEngine(roadsData);
    engine.seed(1);
    const inView = { contains: () => true };
    const outOfView = { contains: () => false };

    engine.tick(0, inView);
    const [car] = engine.cars.values();
    const edgeAtFreeze = car.edgeIdx;
    const distAtFreeze = car.dist;

    engine.tick(1000, outOfView); // frozen for a long stretch

    // The exact frame it re-enters view: dt is reset to 0, so nothing moves
    // yet, even though "real" elapsed time since distAtFreeze was set is huge.
    engine.tick(1000.02, inView);
    expect(car.edgeIdx).toBe(edgeAtFreeze);
    expect(car.dist).toBeCloseTo(distAtFreeze, 5);

    // The following ordinary frame advances normally (small dt, small step).
    engine.tick(1000.12, inView);
    const moved = car.edgeIdx !== edgeAtFreeze || Math.abs(car.dist - distAtFreeze) > 0;
    expect(moved).toBe(true);
  });
});
