import { describe, expect, it } from 'vitest';
import { outputRectOfCore, planSourceTiles, splitRect, type Rect } from '../src/tiling';

const area = (rects: Rect[]): number => rects.reduce((sum, r) => sum + r.w * r.h, 0);

describe('source tiling', () => {
  it('keeps an image that fits in one texture whole', () => {
    expect(planSourceTiles(2048, 1365, 8192)).toEqual([
      { texture: { x: 0, y: 0, w: 2048, h: 1365 }, core: { x: 0, y: 0, w: 2048, h: 1365 } },
    ]);
  });

  it('splits an 8256x5504 frame for a 4096 texture limit into overlapping textures with partitioning cores', () => {
    const tiles = planSourceTiles(8256, 5504, 4096);
    expect(tiles.length).toBe(3 * 2);
    for (const t of tiles) {
      expect(t.texture.w).toBeLessThanOrEqual(4096);
      expect(t.texture.h).toBeLessThanOrEqual(4096);
      // The texture contains the core plus whatever border the image allows.
      expect(t.texture.x).toBeLessThanOrEqual(Math.max(0, t.core.x - 1));
      expect(t.texture.x + t.texture.w).toBeGreaterThanOrEqual(
        Math.min(8256, t.core.x + t.core.w + 1),
      );
    }
    expect(area(tiles.map((t) => t.core))).toBe(8256 * 5504);
  });
});

describe('output tiling', () => {
  it('maps cores onto a partition of the output at any scale', () => {
    const source = { width: 8256, height: 5504 };
    for (const out of [
      source,
      { width: 2048, height: 1365 },
      { width: 10000, height: 7000 },
      { width: 7, height: 5 },
    ]) {
      const tiles = planSourceTiles(source.width, source.height, 4096);
      const rects = tiles.map((t) => outputRectOfCore(t.core, source, out));
      expect(area(rects)).toBe(out.width * out.height);
      expect(Math.max(...rects.map((r) => r.x + r.w))).toBe(out.width);
      expect(Math.max(...rects.map((r) => r.y + r.h))).toBe(out.height);
    }
  });

  it('splits a rectangle into bounded pieces without overlap', () => {
    const pieces = splitRect({ x: 10, y: 20, w: 9000, h: 4100 }, 4096);
    expect(pieces).toHaveLength(3 * 2);
    expect(area(pieces)).toBe(9000 * 4100);
    expect(pieces[0]).toEqual({ x: 10, y: 20, w: 4096, h: 4096 });
    expect(pieces.at(-1)).toEqual({ x: 10 + 8192, y: 20 + 4096, w: 9000 - 8192, h: 4100 - 4096 });
  });
});
