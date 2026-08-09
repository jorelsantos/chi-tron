// Data-shape tests for public/data/roads.json (U10 / R5). U11's car
// simulation is what actually walks this graph at runtime — this file only
// guards the build script's invariants, mirroring stations.test.js's
// pattern of testing the committed build artifact directly rather than
// importing the (network-fetching, top-level-executing) build script.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROADS_PATH = join(ROOT, 'public/data/roads.json');
const MAX_BYTES = 1024 * 1024; // U10 step 5

let roads;
beforeAll(() => {
  roads = JSON.parse(readFileSync(ROADS_PATH, 'utf8'));
});

describe('roads.json shape', () => {
  it('has a bbox and non-empty nodes/edges', () => {
    expect(roads.bbox).toBeTruthy();
    expect(Object.keys(roads.nodes).length).toBeGreaterThan(0);
    expect(roads.edges.length).toBeGreaterThan(0);
  });

  it('stays under the 1 MB build budget', () => {
    expect(statSync(ROADS_PATH).size).toBeLessThan(MAX_BYTES);
  });

  it('every edge references two node ids that exist in the node table', () => {
    const ids = new Set(Object.keys(roads.nodes));
    for (const e of roads.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it('all coordinates fall inside the requested bbox', () => {
    const { minLat, maxLat, minLon, maxLon } = roads.bbox;
    const inBbox = ([lon, lat]) =>
      lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
    for (const node of Object.values(roads.nodes)) {
      expect(inBbox(node.coords)).toBe(true);
    }
    for (const e of roads.edges) {
      for (const c of e.coords) expect(inBbox(c)).toBe(true);
    }
  });

  it('no node lacks a legal outbound edge, after sink pruning', () => {
    const outbound = new Map();
    for (const id of Object.keys(roads.nodes)) outbound.set(id, 0);
    for (const e of roads.edges) {
      outbound.set(e.from, (outbound.get(e.from) ?? 0) + 1);
      if (!e.oneway) outbound.set(e.to, (outbound.get(e.to) ?? 0) + 1);
    }
    const sinks = [...outbound.entries()].filter(([, c]) => c === 0);
    expect(sinks).toEqual([]);
  });

  it('oneway edges expose exactly one traversal direction; two-way expose both', () => {
    // Traversal legality convention: from->to is always legal; to->from is
    // legal iff !oneway. Assert both edge shapes actually appear in the data
    // (regression guard against every edge accidentally landing on one side).
    const hasOneway = roads.edges.some((e) => e.oneway === true);
    const hasTwoWay = roads.edges.some((e) => e.oneway === false);
    expect(hasOneway).toBe(true);
    expect(hasTwoWay).toBe(true);
    for (const e of roads.edges) expect(typeof e.oneway).toBe('boolean');
  });

  it('consecutive nodes along a corridor have monotonically progressing phase offsets', () => {
    // KTD9: phase is a linear function of position along the node's
    // dominant axis — a coordinate hash would fail this; a linear bake
    // cannot, so this also guards the formula hasn't regressed to a hash.
    const nsNodes = Object.values(roads.nodes)
      .filter((n) => n.axis === 'ns')
      .sort((a, b) => a.coords[1] - b.coords[1]);
    for (let i = 1; i < nsNodes.length; i++) {
      expect(nsNodes[i].phase).toBeGreaterThanOrEqual(nsNodes[i - 1].phase);
    }

    const ewNodes = Object.values(roads.nodes)
      .filter((n) => n.axis === 'ew')
      .sort((a, b) => a.coords[0] - b.coords[0]);
    for (let i = 1; i < ewNodes.length; i++) {
      expect(ewNodes[i].phase).toBeGreaterThanOrEqual(ewNodes[i - 1].phase);
    }
  });

  it('every node phase is bounded 0..1', () => {
    for (const node of Object.values(roads.nodes)) {
      expect(node.phase).toBeGreaterThanOrEqual(0);
      expect(node.phase).toBeLessThanOrEqual(1);
    }
  });
});
