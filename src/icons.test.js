import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

describe('chrome icons', () => {
  it('gives search and locate an outline svg', () => {
    expect(html).toMatch(/id="fab-search"[\s\S]*?<svg class="fab-icon"/);
    expect(html).toMatch(/id="fab-locate"[\s\S]*?<svg class="fab-icon"/);
    expect(html).not.toContain('id="fab-lines"');
    expect(html).not.toContain('id="btn-live-overview"');
  });

  it('gives each HUD kind an outline icon, not a word tab', () => {
    expect(html).toMatch(/id="browse-kind-train"[\s\S]*?<svg class="kind-icon"/);
    expect(html).toMatch(/id="browse-kind-bus"[\s\S]*?<svg class="kind-icon"/);
    expect(html).toMatch(/id="browse-kind-bike"[\s\S]*?<svg class="kind-icon"/);
    const kindBlock = html.slice(html.indexOf('id="browse-kind"'), html.indexOf('id="fab-locate"'));
    expect(kindBlock).not.toContain('Train Rides');
    expect(kindBlock).not.toContain('Bus Routes');
    expect(kindBlock).not.toContain('Bike Stations');
    expect(kindBlock).toContain('aria-label="TRAIN"');
    expect(kindBlock).toContain('aria-label="BUS"');
    expect(kindBlock).toContain('aria-label="BIKE"');
  });

  it('uses SVG close and back, not emoji', () => {
    expect(html).toMatch(/id="browse-close"[\s\S]*?<svg class="icon"/);
    expect(html).toMatch(/id="sheet-close"[\s\S]*?<svg class="icon"/);
    expect(html).toMatch(/id="browse-back"[\s\S]*?<svg class="icon"/);
    expect(html).toMatch(/id="sheet-back"[\s\S]*?<svg class="icon"/);
    const closeBlock = html.slice(html.indexOf('id="browse-close"'), html.indexOf('id="browse-close"') + 280);
    expect(closeBlock).not.toContain('✕');
    const backBlock = html.slice(html.indexOf('id="browse-back"'), html.indexOf('id="browse-back"') + 280);
    expect(backBlock).not.toContain('←');
  });
});
