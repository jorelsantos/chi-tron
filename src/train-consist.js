// Three-car consist: lead + mid + tail laid behind the head, bending on the
// trail when samples exist. Live position stays at the lead nose.

import { bearingDeg, mPerDegLon, M_PER_DEG_LAT } from './tracks.js';
import { offsetLonLat, offsetTForZoom } from './track-offset.js';

export const CONSIST = {
  noseAheadM: 5,
  leadM: 20,
  carM: 16,
  gapM: 6,
  couplerM: 1.2,
  haloWidthM: 9,
  coreWidthM: 4.5,
  couplerWidthM: 2.2,
};

export function consistLayout(scale = 1) {
  const s = scale > 0 ? scale : 1;
  const leadFront = CONSIST.noseAheadM * s;
  const leadBack = leadFront - CONSIST.leadM * s;
  const midFront = leadBack - CONSIST.gapM * s;
  const midBack = midFront - CONSIST.carM * s;
  const tailFront = midBack - CONSIST.gapM * s;
  const tailBack = tailFront - CONSIST.carM * s;
  return { leadFront, leadBack, midFront, midBack, tailFront, tailBack };
}

function offsetPoint([lon, lat], headingDeg, meters) {
  const rad = (headingDeg * Math.PI) / 180;
  return [lon + (Math.sin(rad) * meters) / mPerDegLon(lat), lat + (Math.cos(rad) * meters) / M_PER_DEG_LAT];
}

function distM(a, b) {
  const lat = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) * mPerDegLon(lat);
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

function fallbackHeading(train) {
  if (Number.isFinite(train.heading)) return train.heading;
  const trail = train.trail || [];
  if (trail.length >= 2) {
    const a = trail[trail.length - 2];
    const b = trail[trail.length - 1];
    return bearingDeg([a.lon, a.lat], [b.lon, b.lat]);
  }
  return 0;
}

/** Head first, then older trail samples. */
function backwardChain(train) {
  const head = train.pos;
  const chain = [head];
  const trail = train.trail || [];
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const p = [trail[i].lon, trail[i].lat];
    if (distM(chain[chain.length - 1], p) < 0.5) continue;
    chain.push(p);
  }
  return chain;
}

export function pointAlongConsist(train, distFromHead) {
  const heading = fallbackHeading(train);
  if (distFromHead >= 0) return offsetPoint(train.pos, heading, distFromHead);
  let remain = -distFromHead;
  const chain = backwardChain(train);
  for (let i = 0; i < chain.length - 1; i += 1) {
    const seg = distM(chain[i], chain[i + 1]);
    if (seg >= remain) {
      const u = seg > 0 ? remain / seg : 0;
      return [
        chain[i][0] + (chain[i + 1][0] - chain[i][0]) * u,
        chain[i][1] + (chain[i + 1][1] - chain[i][1]) * u,
      ];
    }
    remain -= seg;
  }
  return offsetPoint(chain[chain.length - 1], heading + 180, remain);
}

function trailBehind(train, tailRear, skipM, currentTime) {
  const chain = backwardChain(train);
  let walked = 0;
  let startIdx = chain.length - 1;
  for (let i = 0; i < chain.length - 1; i += 1) {
    walked += distM(chain[i], chain[i + 1]);
    if (walked >= skipM) {
      startIdx = i + 1;
      break;
    }
  }
  const newestFirst = [tailRear];
  for (let i = startIdx; i < chain.length; i += 1) {
    const p = chain[i];
    if (distM(newestFirst[newestFirst.length - 1], p) < 1) continue;
    newestFirst.push(p);
  }
  if (newestFirst.length < 2) {
    newestFirst.push(offsetPoint(tailRear, fallbackHeading(train) + 180, 36));
  }
  const path = newestFirst.slice().reverse();
  const trail = train.trail || [];
  const tHead = Number.isFinite(currentTime) ? currentTime : 0;
  const t0 = Number.isFinite(trail[0]?.t) ? trail[0].t : tHead - 8;
  const span = Math.max(0.1, tHead - t0);
  const times = path.map((_, i) => t0 + (span * i) / Math.max(1, path.length - 1));
  return { path, times };
}

function carRow(train, role, front, back, hot) {
  return {
    id: String(train.id),
    carId: `${train.id}:${role}`,
    role,
    hot,
    line: train.line,
    destNm: train.destNm,
    rn: train.rn,
    path: [pointAlongConsist(train, front), pointAlongConsist(train, back)],
  };
}

/**
 * @returns {{ cars: object[], couplers: object[], trail: { path: number[][], times: number[] } }}
 */
export function consistModel(train, currentTime = 0, scale = 1) {
  const L = consistLayout(scale);
  const cars = [
    carRow(train, 'lead', L.leadFront, L.leadBack, true),
    carRow(train, 'mid', L.midFront, L.midBack, false),
    carRow(train, 'tail', L.tailFront, L.tailBack, false),
  ];
  const spark = (i, a, b) => {
    const mid = (a + b) / 2;
    const half = CONSIST.couplerM / 2;
    return {
      id: `${train.id}:c${i}`,
      path: [pointAlongConsist(train, mid + half), pointAlongConsist(train, mid - half)],
    };
  };
  const couplers = [spark(0, L.leadBack, L.midFront), spark(1, L.midBack, L.tailFront)];
  const trail = trailBehind(train, cars[2].path[1], Math.abs(L.tailBack), currentTime);
  return { cars, couplers, trail };
}

export function gapMeters(frontPt, backPt) {
  return distM(frontPt, backPt);
}

/**
 * Shift a live train onto the same Loop ribbon as its painted rail.
 * Engine state stays on true geometry; this is draw-only.
 */
export function alignTrainToRibbon(train, zoom) {
  const zoomT = offsetTForZoom(zoom);
  if (!train?.pos || zoomT === 0) return train;
  const trail = train.trail || [];
  const alignedTrail = trail.map((p, i) => {
    let heading = train.heading;
    if (i > 0) heading = bearingDeg([trail[i - 1].lon, trail[i - 1].lat], [p.lon, p.lat]);
    else if (trail.length > 1) heading = bearingDeg([p.lon, p.lat], [trail[1].lon, trail[1].lat]);
    const q = offsetLonLat([p.lon, p.lat], train.line, zoomT, heading);
    return { ...p, lon: q[0], lat: q[1] };
  });
  const pos = offsetLonLat(train.pos, train.line, zoomT, fallbackHeading(train));
  return { ...train, pos, trail: alignedTrail };
}
