import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./main.js', import.meta.url)), 'utf8');

describe('map interaction wiring', () => {
  it('opens a picked transfer station on the tapped rail line', () => {
    expect(source).toContain(
      "board.openStation(info.object, { source: 'map', lineKey: info.object.railLine })",
    );
  });

  it('follows the same ribbon-aligned position that is rendered', () => {
    expect(source).toContain("import { alignTrainToRibbon } from './train-consist.js'");
    expect(source).toContain(
      'map.setCenter(alignTrainToRibbon(vehicle, map.getZoom()).pos)',
    );
  });
});
