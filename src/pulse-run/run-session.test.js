import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { RunSession, GOAL_RADIUS_M, COUNTDOWN_S } from './run-session.js';
import { gradeForElapsed, shareString } from './scoring.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('scoring', () => {
  it('grades bands against par', () => {
    expect(gradeForElapsed(30, 40)).toBe('S'); // 0.75
    expect(gradeForElapsed(40, 40)).toBe('A');
    expect(gradeForElapsed(50, 40)).toBe('B'); // 1.25
    expect(gradeForElapsed(60, 40)).toBe('C');
  });

  it('builds a share string', () => {
    const s = shareString({ line: 'Red', elapsedS: 47.2, grade: 'S' });
    expect(s).toContain('CHI-TRON');
    expect(s).toContain('PULSE RUN');
    expect(s).toContain('S');
    expect(s).toContain('🔴');
  });
});

describe('RunSession', () => {
  let tracks;
  let stations;

  beforeAll(() => {
    tracks = JSON.parse(readFileSync(join(ROOT, 'public/data/tracks.json'), 'utf8'));
    stations = JSON.parse(readFileSync(join(ROOT, 'public/data/stations.json'), 'utf8'));
  });

  it('starts countdown for a valid challenge', () => {
    const ses = new RunSession(tracks);
    const r = ses.start('red-north-short', stations);
    expect(r.ok).toBe(true);
    expect(ses.phase).toBe('countdown');
    expect(ses.player).toBeTruthy();
    expect(ses.active).toBe(true);
  });

  it('rejects unknown challenge', () => {
    const ses = new RunSession(tracks);
    expect(ses.start('nope', stations).ok).toBe(false);
  });

  it('transitions countdown → running after COUNTDOWN_S', () => {
    const ses = new RunSession(tracks);
    ses.start('red-north-short', stations);
    ses.countdownLeft = 0.01;
    ses._lastTick = performance.now() / 1000 - 0.05;
    ses.tick();
    expect(ses.phase).toBe('running');
  });

  it('finishes when along-track near goal', () => {
    const ses = new RunSession(tracks);
    ses.start('red-north-short', stations);
    ses.phase = 'running';
    ses.player.frozen = false;
    ses.runStartedAt = performance.now() / 1000;
    ses.player.dist = ses.baked.goalDist;
    ses._lastTick = performance.now() / 1000;
    const snap = ses.tick();
    expect(snap.phase).toBe('finished');
    expect(snap.grade).toMatch(/^[SABC]$/);
    expect(snap.share).toContain('PULSE RUN');
  });

  it('fails when time limit exceeded', () => {
    const ses = new RunSession(tracks);
    ses.start('red-north-short', stations);
    ses.phase = 'running';
    ses.player.frozen = false;
    ses.challenge.timeLimitS = 1;
    ses.runStartedAt = performance.now() / 1000 - 2;
    ses._lastTick = performance.now() / 1000;
    const snap = ses.tick();
    expect(snap.phase).toBe('failed');
  });

  it('retry returns to countdown', () => {
    const ses = new RunSession(tracks);
    ses.start('red-north-short', stations);
    ses.phase = 'failed';
    ses.retry();
    expect(ses.phase).toBe('countdown');
    expect(ses.countdownLeft).toBe(COUNTDOWN_S);
  });

  it('exit clears to idle', () => {
    const ses = new RunSession(tracks);
    ses.start('red-north-short', stations);
    ses.exit();
    expect(ses.phase).toBe('idle');
    expect(ses.active).toBe(false);
    expect(ses.player).toBeNull();
  });

  it('exports GOAL_RADIUS_M = 40', () => {
    expect(GOAL_RADIUS_M).toBe(40);
  });
});
