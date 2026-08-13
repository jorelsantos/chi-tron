#!/usr/bin/env node
// Bake Divvy station_information into public/data/divvy-stations.json.
//
// Resolves feed URLs from the GBFS discovery document at bake time so a
// Lyft version-prefix move does not break the script. No API key.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCOVERY = 'https://gbfs.divvybikes.com/gbfs/gbfs.json';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/data/divvy-stations.json');

/**
 * @param {unknown} raw
 * @returns {{id: string, name: string, lat: number, lon: number, capacity: number}[]}
 */
export function normalizeStations(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.data?.stations)
      ? raw.data.stations
      : Array.isArray(raw?.stations)
        ? raw.stations
        : [];
  const out = [];
  for (const s of list) {
    if (!s) continue;
    const name = s.name != null ? String(s.name).trim() : '';
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // station_id is a 19-digit string — never coerce to Number (precision loss).
    const id = s.station_id != null ? String(s.station_id) : s.id != null ? String(s.id) : '';
    if (!id) continue;
    const capacity = Number.isFinite(Number(s.capacity)) ? Number(s.capacity) : 0;
    out.push({
      id,
      name,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      capacity,
    });
  }
  return out;
}

/**
 * @param {{en?: {feeds?: {name: string, url: string}[]}}} data
 * @param {string} name
 */
function feedUrl(data, name) {
  const feeds = data?.en?.feeds;
  if (!Array.isArray(feeds)) return null;
  const hit = feeds.find((f) => f?.name === name && f?.url);
  return hit ? String(hit.url) : null;
}

async function main() {
  console.log('Fetching GBFS discovery…');
  const discRes = await fetch(DISCOVERY);
  if (!discRes.ok) throw new Error(`discovery HTTP ${discRes.status}`);
  const disc = await discRes.json();
  const infoUrl = feedUrl(disc?.data, 'station_information');
  if (!infoUrl) throw new Error('station_information feed missing from discovery');

  console.log(`Fetching station_information…\n  ${infoUrl}`);
  const infoRes = await fetch(infoUrl);
  if (!infoRes.ok) throw new Error(`station_information HTTP ${infoRes.status}`);
  const info = await infoRes.json();
  const stations = normalizeStations(info);
  if (stations.length === 0) {
    console.error('No stations after normalize — refusing empty bake');
    process.exit(1);
  }

  const payload = {
    stations,
    bakedAt: new Date().toISOString(),
  };
  writeFileSync(OUT, JSON.stringify(payload));
  console.log(`Wrote ${stations.length} stations → ${OUT}`);
}

// Only run when invoked as a script (tests import normalizeStations).
const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
