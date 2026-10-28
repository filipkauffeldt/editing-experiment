import type { Rect } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  countMask,
  maskBounds,
  rasterizePolygon,
  rasterizeRect,
  rasterizeShapes,
  unionMaskInto,
  unionMasks,
} from '../src/index';

const rect = (x: number, y: number, w: number, h: number): Rect => ({ type: 'rect', x, y, w, h });

describe('rect rasterisation', () => {
  it('fills the whole image for a full-frame rect', () => {
    const mask = rasterizeRect(rect(0, 0, 1, 1), 16, 8);
    expect(mask).toHaveLength(128);
    expect(countMask(mask)).toBe(128);
  });

  it('samples pixel centres, so normalised edges snap to pixel boundaries', () => {
    const mask = rasterizeRect(rect(0.1, 0.2, 0.1, 0.1), 100, 100);
    expect(maskBounds(mask, 100, 100)).toEqual({ x: 10, y: 20, w: 10, h: 10 });
    expect(countMask(mask)).toBe(100);
    expect(mask[20 * 100 + 10]).toBe(1);
    expect(mask[20 * 100 + 9]).toBe(0);
    expect(mask[19 * 100 + 10]).toBe(0);
  });

  it('handles fractional edges', () => {
    const mask = rasterizeRect(rect(0.0955, 0.0955, 0.01, 0.01), 100, 100);
    expect(maskBounds(mask, 100, 100)).toEqual({ x: 10, y: 10, w: 1, h: 1 });
  });
});

describe('polygon rasterisation', () => {
  it('fills a triangle at pixel centres', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ];
    const mask = rasterizePolygon(points, 10, 10);
    expect(mask[0]).toBe(1);
    expect(mask[5 * 10 + 2]).toBe(1);
    expect(mask[8 * 10 + 8]).toBe(0);
    expect(countMask(mask)).toBe(45);
  });

  it('honours a concave notch (even-odd fill)', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0.75, y: 1 },
      { x: 0.75, y: 0.25 },
      { x: 0.25, y: 0.25 },
      { x: 0.25, y: 1 },
      { x: 0, y: 1 },
    ];
    const mask = rasterizePolygon(points, 100, 100);
    expect(mask[50 * 100 + 50]).toBe(0);
    expect(mask[50 * 100 + 10]).toBe(1);
    expect(mask[50 * 100 + 90]).toBe(1);
  });
});

describe('mask union', () => {
  it('unions shapes and overlapping masks', () => {
    const mask = rasterizeShapes([rect(0, 0, 0.5, 1), rect(0.5, 0, 0.5, 1)], 10, 10);
    expect(countMask(mask)).toBe(100);

    const a = rasterizeRect(rect(0, 0, 0.5, 1), 10, 10);
    const b = rasterizeRect(rect(0, 0, 1, 0.5), 10, 10);
    expect(countMask(unionMasks([a, b]))).toBe(75);

    const target = rasterizeRect(rect(0, 0, 0.2, 1), 10, 10);
    unionMaskInto(target, b);
    expect(countMask(target)).toBe(60);
  });

  it('rejects mismatched mask lengths', () => {
    expect(() => unionMasks([new Uint8Array(4), new Uint8Array(5)])).toThrow(RangeError);
    expect(() => unionMaskInto(new Uint8Array(4), new Uint8Array(5))).toThrow(RangeError);
  });
});
