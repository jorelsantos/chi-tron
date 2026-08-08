// Pulse Run session state machine.

import { PlayerBolt } from './player.js';
import { gradeForElapsed, shareString, formatTime } from './scoring.js';
import { bakeChallengeDists } from './stations-index.js';
import { getChallenge } from './challenges.js';

export const GOAL_RADIUS_M = 40;
export const COUNTDOWN_S = 3;
export const FINISH_FREEZE_MS = 400;

/**
 * @typedef {'idle'|'countdown'|'running'|'finished'|'failed'} RunPhase
 */

export class RunSession {
  /**
   * @param {Record<string, {coords: number[][], cumDist: number[]}>} tracksData
   */
  constructor(tracksData) {
    this.tracksData = tracksData;
    /** @type {RunPhase} */
    this.phase = 'idle';
    this.challenge = null;
    this.baked = null;
    this.player = null;
    this.countdownLeft = 0;
    this.elapsedS = 0;
    this.runStartedAt = 0;
    this.grade = null;
    this.share = null;
    this.finishFreezeUntil = 0;
    this._lastTick = 0;
  }

  get active() {
    return this.phase !== 'idle';
  }

  /**
   * @param {string} challengeId
   * @param {Record<string, object>} stations
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  start(challengeId, stations) {
    const card = getChallenge(challengeId);
    if (!card) return { ok: false, error: 'unknown challenge' };
    const baked = bakeChallengeDists(card, this.tracksData, stations);
    if (!baked) return { ok: false, error: 'could not bake start/goal on line' };

    this.challenge = card;
    this.baked = baked;
    this.player = new PlayerBolt(this.tracksData, {
      line: card.line,
      startDist: baked.startDist,
      goalDist: baked.goalDist,
      dir: baked.dir,
    });
    this.phase = 'countdown';
    this.countdownLeft = COUNTDOWN_S;
    this.elapsedS = 0;
    this.grade = null;
    this.share = null;
    this.finishFreezeUntil = 0;
    this._lastTick = performance.now() / 1000;
    return { ok: true };
  }

  retry() {
    if (!this.challenge || !this.baked || !this.player) return;
    this.player.reset();
    this.phase = 'countdown';
    this.countdownLeft = COUNTDOWN_S;
    this.elapsedS = 0;
    this.grade = null;
    this.share = null;
    this.finishFreezeUntil = 0;
    this._lastTick = performance.now() / 1000;
  }

  exit() {
    this.phase = 'idle';
    this.challenge = null;
    this.baked = null;
    this.player = null;
    this.countdownLeft = 0;
    this.elapsedS = 0;
    this.grade = null;
    this.share = null;
    this.finishFreezeUntil = 0;
  }

  setBoosting(on) {
    this.player?.setBoosting(on);
  }

  reverse() {
    if (this.phase !== 'running') return;
    this.player?.reverse();
  }

  /**
   * Advance session + player. Call once per animation frame while active.
   * @returns {{
   *   phase: RunPhase,
   *   player: object|null,
   *   countdownLeft: number,
   *   elapsedS: number,
   *   grade: string|null,
   *   share: string|null,
   *   challenge: object|null,
   * }}
   */
  tick() {
    if (this.phase === 'idle' || !this.player) {
      return this.#snapshot();
    }

    const t = performance.now() / 1000;
    const dt = Math.min(0.1, Math.max(0, t - this._lastTick));
    this._lastTick = t;

    if (this.phase === 'countdown') {
      this.countdownLeft = Math.max(0, this.countdownLeft - dt);
      // Player stays frozen at start; still tick trail lightly
      this.player.frozen = true;
      this.player.tick();
      if (this.countdownLeft <= 0) {
        this.phase = 'running';
        this.player.frozen = false;
        this.player.reset();
        this.runStartedAt = t;
        this.elapsedS = 0;
      }
      return this.#snapshot();
    }

    if (this.phase === 'running') {
      this.player.tick();
      this.elapsedS = t - this.runStartedAt;
      const limit = this.challenge.timeLimitS ?? this.challenge.parTimeS * 1.5;
      if (this.elapsedS >= limit) {
        this.phase = 'failed';
        this.player.freeze();
        return this.#snapshot();
      }
      if (Math.abs(this.player.dist - this.baked.goalDist) < GOAL_RADIUS_M) {
        this.phase = 'finished';
        this.player.freeze();
        this.grade = gradeForElapsed(this.elapsedS, this.challenge.parTimeS);
        this.share = shareString({
          line: this.challenge.line,
          elapsedS: this.elapsedS,
          grade: this.grade,
        });
        this.finishFreezeUntil = performance.now() + FINISH_FREEZE_MS;
      }
      return this.#snapshot();
    }

    // finished | failed — keep trail frozen, still tick for camera
    this.player.tick();
    return this.#snapshot();
  }

  #snapshot() {
    return {
      phase: this.phase,
      player: this.player ? this.player.asVehicle() : null,
      playerBolt: this.player,
      countdownLeft: this.countdownLeft,
      elapsedS: this.elapsedS,
      grade: this.grade,
      share: this.share,
      challenge: this.challenge,
      baked: this.baked,
      finishFreezeUntil: this.finishFreezeUntil,
      formatElapsed: formatTime(this.elapsedS),
    };
  }
}
