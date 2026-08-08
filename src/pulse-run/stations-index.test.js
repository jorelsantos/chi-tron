import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { CHALLENGES } from './challenges.js';
import {
  getStation,
  stationOnLine,
  bakeChallengeDists,
  snapCandidates,
} from './stations-index.js';
import { prepareLine } from '../tracks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('Pulse Run challenges (U1)', () => {
  let tracks;
  let stations;

  beforeAll(() => {
    tracks = JSON.parse(readFileSync(join(ROOT, 'public/data/tracks.json'), 'utf8'));
    stations = JSON.parse(readFileSync(join(ROOT, 'public/data/stations.json'), 'utf8'));
  });

  it('ships at least 3 challenge cards', () => {
    expect(CHALLENGES.length).toBeGreaterThanOrEqual(3);
  });

  for (const card of CHALLENGES) {
    it(`${card.id}: stations exist and include line ${card.line}`, () => {
      const start = getStation(stations, card.startId);
      const goal = getStation(stations, card.goalId);
      expect(start, `start ${card.startId}`).toBeTruthy();
      expect(goal, `goal ${card.goalId}`).toBeTruthy();
      expect(stationOnLine(start, card.line)).toBe(true);
      expect(stationOnLine(goal, card.line)).toBe(true);
    });

    it(`${card.id}: bakes finite startDist/goalDist on the wire`, () => {
      const baked = bakeChallengeDists(card, tracks, stations);
      expect(baked, 'bake result').toBeTruthy();
      expect(Number.isFinite(baked.startDist)).toBe(true);
      expect(Number.isFinite(baked.goalDist)).toBe(true);
      expect(baked.startDist).not.toBe(baked.goalDist);
      expect(baked.lengthM).toBeGreaterThan(100);
      expect(Math.abs(baked.dir)).toBe(1);

      const prep = prepareLine(tracks[card.line]);
      const sc = snapCandidates(prep, stations[card.startId].coords);
      const gc = snapCandidates(prep, stations[card.goalId].coords);
      expect(sc[0].off).toBeLessThanOrEqual(350);
      expect(gc[0].off).toBeLessThanOrEqual(350);
    });
  }

  it('does not use Blue Belmont for red-north-short', () => {
    const card = CHALLENGES.find((c) => c.id === 'red-north-short');
    expect(card.startId).toBe('41320');
    expect(card.startId).not.toBe('40060');
  });
});
