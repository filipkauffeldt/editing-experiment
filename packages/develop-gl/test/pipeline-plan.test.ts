import { describe, expect, it } from 'vitest';
import { resolveNeighbourhood } from '../src/neighbourhood/params';
import { haloFor, planCores } from '../src/neighbourhood/pipeline';
import { TILE_ALIGN } from '../src/neighbourhood/tuning';

describe('tile planning for the neighbourhood passes', () => {
  it('needs no overlap without neighbourhood controls and a multiple of the pyramid grid with them', () => {
    expect(haloFor(resolveNeighbourhood({}))).toBe(0);
    for (const params of [
      { Texture: 10 },
      { Clarity2012: -30 },
      { Dehaze: 5 },
      { Sharpness: 40 },
      { LuminanceSmoothing: 20 },
      { ColorNoiseReduction: 20 },
      { Texture: 10, Sharpness: 40, LuminanceSmoothing: 20 },
    ]) {
      const halo = haloFor(resolveNeighbourhood(params));
      expect(halo).toBeGreaterThan(0);
      expect(halo % TILE_ALIGN).toBe(0);
    }
    // Noise reduction reaches farthest: its pyramid is five levels deep.
    expect(haloFor(resolveNeighbourhood({ LuminanceSmoothing: 20 }))).toBeGreaterThanOrEqual(128);
  });

  it('cores partition the output, start on the pyramid grid and leave room for the halo', () => {
    const out = { width: 1000, height: 700 };
    const halo = 96;
    const cores = planCores(out, 512, halo);
    let area = 0;
    for (const core of cores) {
      expect(core.x % TILE_ALIGN).toBe(0);
      expect(core.y % TILE_ALIGN).toBe(0);
      expect(core.w + 2 * halo).toBeLessThanOrEqual(512);
      expect(core.h + 2 * halo).toBeLessThanOrEqual(512);
      area += core.w * core.h;
    }
    expect(area).toBe(out.width * out.height);
  });

  it('a big enough limit gives one core', () => {
    expect(planCores({ width: 640, height: 480 }, 4096, 224)).toEqual([
      { x: 0, y: 0, w: 640, h: 480 },
    ]);
  });
});
