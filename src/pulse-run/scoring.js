// Pulse Run grading + share string.

import { LINE_EMOJI } from './challenges.js';

/**
 * @param {number} elapsedS
 * @param {number} parTimeS
 * @returns {'S'|'A'|'B'|'C'}
 */
export function gradeForElapsed(elapsedS, parTimeS) {
  if (!(parTimeS > 0) || !(elapsedS >= 0)) return 'C';
  const r = elapsedS / parTimeS;
  if (r <= 0.85) return 'S';
  if (r <= 1.0) return 'A';
  if (r <= 1.25) return 'B';
  return 'C';
}

/**
 * @param {number} seconds
 */
export function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  const whole = Math.floor(rem);
  const tenths = Math.floor((rem - whole) * 10);
  if (m > 0) {
    return `${m}:${String(whole).padStart(2, '0')}.${tenths}`;
  }
  return `${whole}.${tenths}s`;
}

/**
 * @param {{ line: string, elapsedS: number, grade: string }} opts
 */
export function shareString({ line, elapsedS, grade }) {
  const emoji = LINE_EMOJI[line] ?? '⚡';
  const t = formatTime(elapsedS).replace(/s$/, '');
  // Prefer m:ss style for share when >= 60s
  let clock;
  if (elapsedS >= 60) {
    const m = Math.floor(elapsedS / 60);
    const sec = Math.floor(elapsedS % 60);
    clock = `${m}:${String(sec).padStart(2, '0')}`;
  } else {
    clock = `${Math.floor(elapsedS)}.${Math.floor((elapsedS % 1) * 10)}`;
  }
  return `CHI-TRON · PULSE RUN · ${emoji} · ${clock} · ${grade}`;
}
