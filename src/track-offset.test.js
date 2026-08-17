import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mPerDegLon, M_PER_DEG_LAT } from './tracks.js';
import {
  LOOP_BBOX,
  LOOP_CENTER,
  LOOP_SLOT_MID,
  LOOP_SPACING_M,
  offsetTForZoom,
  loopSlot,
  loopEase,
  offsetCoords,
  offsetLonLat,
  ribbonPaint,
} from './track-offset.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function distM(a, b) {
  const lat = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) * mPerDegLon(lat);
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

function towardCenter(pt) {
  return distM(pt, LOOP_CENTER);
}

describe('offsetTForZoom', () => {
  it('is 0 below 12.4, 1 at/above 13.2, and lerps between', () => {
    expect(offsetTForZoom(11)).toBe(0);
    expect(offsetTForZoom(12.4)).toBe(0);
    expect(offsetTForZoom(13.2)).toBe(1);
    expect(offsetTForZoom(14)).toBe(1);
    expect(offsetTForZoom(12.8)).toBeCloseTo(0.5, 5);
  });
});

describe('loopSlot', () => {
  it('stacks Pink inside Purple; subway lines sit on the mid slot', () => {
    expect(loopSlot('Pink')).toBeLessThan(loopSlot('Org'));
    expect(loopSlot('Org')).toBeLessThan(loopSlot('G'));
    expect(loopSlot('G')).toBeLessThan(loopSlot('Brn'));
    expect(loopSlot('Brn')).toBeLessThan(loopSlot('P'));
    expect(loopSlot('Red')).toBe(LOOP_SLOT_MID);
    expect(loopSlot('Blue')).toBe(LOOP_SLOT_MID);
    expect(loopSlot('Y')).toBe(LOOP_SLOT_MID);
    expect(loopSlot('Nope')).toBe(LOOP_SLOT_MID);
  });
});

describe('offsetCoords', () => {
  // North–south elevated on the east Loop (Wabash-ish). Outward is east.
  const eastRail = [
    [-87.6262, 41.878],
    [-87.6262, 41.882],
    [-87.6262, 41.886],
  ];

  it('leaves points outside the bbox unchanged', () => {
    const north = [
      [-87.63, 42.02],
      [-87.63, 42.03],
    ];
    const out = offsetCoords(north, 'Pink', 1);
    expect(out[0]).toEqual(north[0]);
    expect(out[1]).toEqual(north[1]);
  });

  it('does not move geometry when zoomT is 0', () => {
    const out = offsetCoords(eastRail, 'Pink', 0);
    expect(out).toEqual(eastRail);
  });

  it('does not move Red or Blue inside the Loop', () => {
    expect(distM(offsetCoords(eastRail, 'Blue', 1)[1], eastRail[1])).toBeLessThan(0.2);
    expect(distM(offsetCoords(eastRail, 'Red', 1)[1], eastRail[1])).toBeLessThan(0.2);
  });

  it('shifts Pink inward and Purple outward on the east rail', () => {
    const pink = offsetCoords(eastRail, 'Pink', 1);
    const purple = offsetCoords(eastRail, 'P', 1);
    const mid = eastRail[1];
    expect(pink[1][0]).toBeLessThan(mid[0]);
    expect(purple[1][0]).toBeGreaterThan(mid[0]);
    expect(towardCenter(pink[1])).toBeLessThan(towardCenter(mid));
    expect(towardCenter(purple[1])).toBeGreaterThan(towardCenter(mid));
    expect(distM(pink[1], purple[1])).toBeGreaterThan(LOOP_SPACING_M * 3);
    expect(distM(pink[1], purple[1])).toBeLessThan(LOOP_SPACING_M * 5);
  });

  it('offsetLonLat matches offsetCoords for a northbound Pink sample', () => {
    const mid = eastRail[1];
    const fromLine = offsetCoords(eastRail, 'Pink', 1)[1];
    const fromHead = offsetLonLat(mid, 'Pink', 1, 0);
    expect(distM(fromLine, fromHead)).toBeLessThan(0.3);
  });

  it('eases offset near the bbox edge', () => {
    const deepLon = (LOOP_BBOX.west + LOOP_BBOX.east) / 2;
    const deepLat = (LOOP_BBOX.south + LOOP_BBOX.north) / 2;
    const edgeLon = LOOP_BBOX.east - 0.0002;
    const deep = offsetCoords(
      [
        [deepLon, deepLat - 0.002],
        [deepLon, deepLat],
        [deepLon, deepLat + 0.002],
      ],
      'P',
      1,
    );
    const edge = offsetCoords(
      [
        [edgeLon, deepLat - 0.002],
        [edgeLon, deepLat],
        [edgeLon, deepLat + 0.002],
      ],
      'P',
      1,
    );
    expect(loopEase(deepLon, deepLat)).toBe(1);
    expect(loopEase(edgeLon, deepLat)).toBeLessThan(0.4);
    expect(distM(edge[1], [edgeLon, deepLat])).toBeLessThan(distM(deep[1], [deepLon, deepLat]));
  });
});

describe('ribbonPaint', () => {
  it('is steel at city zoom and brand-tinted at Loop zoom', () => {
    const city = ribbonPaint([255, 45, 72], 0);
    const loop = ribbonPaint([255, 45, 72], 1);
    expect(city.color[0]).toBeLessThan(loop.color[0]);
    expect(loop.filament[1]).toBeGreaterThan(loop.color[1]);
    expect(loop.filament[2]).toBeGreaterThan(loop.color[2]);
  });
});

describe('tracks.json Loop ribbons', () => {
  let tracks;

  beforeAll(() => {
    tracks = JSON.parse(readFileSync(join(ROOT, 'public/data/tracks.json'), 'utf8'));
  });

  it('moves a deep Loop Pink vertex tens of meters', () => {
    const idx = tracks.Pink.coords.findIndex(
      ([lon, lat]) => loopEase(lon, lat) === 1 && lon > -87.64 && lon < -87.62,
    );
    expect(idx).toBeGreaterThan(-1);
    const src = tracks.Pink.coords[idx];
    const out = offsetCoords(tracks.Pink.coords, 'Pink', 1)[idx];
    const d = distM(src, out);
    expect(d).toBeGreaterThan(12);
    expect(d).toBeLessThan(50);
    expect(typeof tracks.Pink.coords[0][0]).toBe('number');
  });
});
