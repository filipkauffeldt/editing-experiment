import { describe, expect, it } from 'vitest';
import { countMask, magicWand, rasterizeShapes } from '../src/index';

function solid(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function paint(
  rgba: Uint8Array,
  width: number,
  x: number,
  y: number,
  rgb: [number, number, number],
): void {
  const index = (y * width + x) * 4;
  rgba[index] = rgb[0];
  rgba[index + 1] = rgb[1];
  rgba[index + 2] = rgb[2];
  rgba[index + 3] = 255;
}

describe('magicWand', () => {
  it('fills the connected same-colour region only', () => {
    const width = 40;
    const height = 30;
    const rgba = solid(width, height, [200, 30, 30]);
    for (let y = 0; y < height; y++) {
      for (let x = 20; x < width; x++) paint(rgba, width, x, y, [30, 30, 200]);
    }
    const result = magicWand(rgba, width, height, { x: 5, y: 5 }, { tolerance: 0 });
    expect(countMask(result.mask)).toBe(20 * 30);
    expect(result.mask[5 * width + 5]).toBe(1);
    expect(result.mask[5 * width + 25]).toBe(0);
    expect(result.shapes.length).toBeGreaterThan(0);

    const vector = rasterizeShapes(result.shapes, width, height);
    let overlap = 0;
    for (let i = 0; i < vector.length; i++) if (vector[i] && result.mask[i]) overlap++;
    expect(overlap / countMask(result.mask)).toBeGreaterThan(0.95);
  });

  it('does not cross a barrier into a disconnected region', () => {
    const width = 20;
    const height = 10;
    const rgba = solid(width, height, [30, 30, 200]);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < 5; x++) paint(rgba, width, x, y, [200, 30, 30]);
      for (let x = 10; x < 15; x++) paint(rgba, width, x, y, [200, 30, 30]);
    }
    const result = magicWand(rgba, width, height, { x: 0, y: 0 }, { tolerance: 0 });
    expect(countMask(result.mask)).toBe(50);
    expect(result.mask[5 * width + 5]).toBe(0);
    expect(result.mask[5 * width + 12]).toBe(0);
  });

  it('widens with colour tolerance', () => {
    const width = 10;
    const height = 10;
    const rgba = solid(width, height, [100, 100, 100]);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < 5; x++) paint(rgba, width, x, y, [105, 105, 105]);
      for (let x = 5; x < 10; x++) paint(rgba, width, x, y, [150, 150, 150]);
    }
    const tight = magicWand(rgba, width, height, { x: 0, y: 0 }, { tolerance: 0 });
    const loose = magicWand(rgba, width, height, { x: 0, y: 0 }, { tolerance: 30 });
    expect(countMask(tight.mask)).toBe(50);
    expect(countMask(loose.mask)).toBe(100);
  });

  it('returns a simplified outline', () => {
    const width = 200;
    const height = 200;
    const rgba = solid(width, height, [20, 20, 20]);
    for (let y = 50; y < 150; y++) {
      for (let x = 50; x < 150; x++) paint(rgba, width, x, y, [220, 220, 220]);
    }
    const result = magicWand(rgba, width, height, { x: 100, y: 100 }, { tolerance: 0 });
    expect(result.shapes).toHaveLength(1);
    const shape = result.shapes[0]!;
    expect(shape.type).toBe('polygon');
    if (shape.type === 'polygon') {
      expect(shape.points.length).toBeGreaterThanOrEqual(4);
      expect(shape.points.length).toBeLessThan(20);
    }
  });

  it('rejects out-of-bounds seeds and invalid buffers', () => {
    const rgba = solid(4, 4, [0, 0, 0]);
    expect(() => magicWand(rgba, 4, 4, { x: 4, y: 0 })).toThrow(RangeError);
    expect(() => magicWand(rgba, 4, 4, { x: 0, y: 0 }, { tolerance: -1 })).toThrow(RangeError);
    expect(() => magicWand(new Uint8Array(4), 4, 4, { x: 0, y: 0 })).toThrow(RangeError);
  });
});
