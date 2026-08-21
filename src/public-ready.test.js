import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function pngSize(rel) {
  const buf = readFileSync(join(root, rel));
  expect(buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('public-ready chrome', () => {
  it('lets the sheet pinch-zoom (map already owns its own gestures)', () => {
    expect(html).toContain('width=device-width, initial-scale=1.0, viewport-fit=cover');
    expect(html).not.toContain('user-scalable=no');
    expect(html).not.toContain('maximum-scale=1.0');
  });

  it('declares share tags against the live host', () => {
    expect(html).toContain('property="og:image" content="https://chi-tron.vercel.app/og.png"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('name="description"');
    expect(html).toContain('name="theme-color" content="#05070c"');
  });

  it('points iOS and the manifest at PNG icons', () => {
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  });

  it('states GPS stays on-device', () => {
    expect(html).toContain('GPS STAYS ON THIS DEVICE · NO ACCOUNTS');
    expect(html).toContain('UNOFFICIAL FAN PROJECT — NOT AFFILIATED WITH CTA');
  });

  it('ships OG and home-screen PNGs at the sizes crawlers and iOS expect', () => {
    expect(pngSize('public/og.png')).toEqual({ width: 1200, height: 630 });
    expect(pngSize('public/apple-touch-icon.png')).toEqual({ width: 180, height: 180 });
    expect(pngSize('public/icon-192.png')).toEqual({ width: 192, height: 192 });
    expect(pngSize('public/icon-512.png')).toEqual({ width: 512, height: 512 });
  });

  it('ships a standalone manifest', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'));
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#05070c');
    expect(manifest.icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === '512x512')).toBe(true);
  });
});
