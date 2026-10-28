import type { MosaicOp, Rect } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { applyMosaic, blockSizeForShape, effectiveBlockSize } from '../src/index';

const rect = (x: number, y: number, w: number, h: number): Rect => ({ type: 'rect', x, y, w, h });
const op = (shapes: Rect[], blockSizeRel: number): MosaicOp => ({
  type: 'mosaic',
  shapes,
  blockSizeRel,
});

function gradient(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      rgba[index] = (x * 37 + y * 91) & 255;
      rgba[index + 1] = (x * 13 + y * 57 + 70) & 255;
      rgba[index + 2] = (x * 71 + y * 23 + 120) & 255;
      rgba[index + 3] = 255;
    }
  }
  return rgba;
}

function blockAverage(
  rgba: Uint8Array,
  width: number,
  height: number,
  blockX: number,
  blockY: number,
  blockSize: number,
  channel: number,
): number {
  let sum = 0;
  let count = 0;
  for (let y = blockY; y < Math.min(height, blockY + blockSize); y++) {
    for (let x = blockX; x < Math.min(width, blockX + blockSize); x++) {
      sum += rgba[(y * width + x) * 4 + channel]!;
      count++;
    }
  }
  return Math.round(sum / count);
}

describe('applyMosaic', () => {
  it('leaves pixels outside the selection untouched and uses whole-block averages', () => {
    const width = 64;
    const height = 64;
    const source = gradient(width, height);
    const selection = rect(9 / width, 9 / height, 14 / width, 14 / height);
    const result = applyMosaic(source, width, height, op([selection], 8 / width));

    const x0 = Math.ceil(selection.x * width - 0.5);
    const y0 = Math.ceil(selection.y * height - 0.5);
    const x1 = Math.ceil((selection.x + selection.w) * width - 0.5);
    const y1 = Math.ceil((selection.y + selection.h) * height - 0.5);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
        if (!inside) {
          expect(result[index], `outside pixel ${x},${y}`).toBe(source[index]);
          continue;
        }
        const blockX = Math.floor(x / 8) * 8;
        const blockY = Math.floor(y / 8) * 8;
        for (let channel = 0; channel < 4; channel++) {
          expect(result[index + channel], `pixel ${x},${y} channel ${channel}`).toBe(
            blockAverage(source, width, height, blockX, blockY, 8, channel),
          );
        }
      }
    }
  });

  it('aligns blocks to the image grid, not to the shape', () => {
    const width = 64;
    const height = 64;
    const source = gradient(width, height);
    const result = applyMosaic(
      source,
      width,
      height,
      op([rect(9 / width, 9 / height, 7 / width, 7 / height)], 8 / width),
    );
    const pixel = (x: number, y: number): number[] => {
      const index = (y * width + x) * 4;
      return [...result.slice(index, index + 4)];
    };
    expect(pixel(9, 9)).toEqual(pixel(15, 9));
    expect(pixel(9, 9)).not.toEqual(pixel(16, 9));
    expect(pixel(9, 9)).toEqual([
      blockAverage(source, width, height, 8, 8, 8, 0),
      blockAverage(source, width, height, 8, 8, 8, 1),
      blockAverage(source, width, height, 8, 8, 8, 2),
      255,
    ]);
  });

  it('enforces at most eight blocks across a shape', () => {
    const width = 1000;
    const height = 1000;
    const selection = rect(0.1, 0.1, 0.4, 0.4);
    const blockSize = effectiveBlockSize(op([selection], 0.001), width, height);
    expect(blockSize).toBe(50);
    expect(Math.ceil((selection.w * width) / blockSize)).toBeLessThanOrEqual(8);

    const source = gradient(width, height);
    const result = applyMosaic(source, width, height, op([selection], 0.001));
    const index = (x: number, y: number): number => (y * width + x) * 4;
    const expected = blockAverage(source, width, height, 100, 100, blockSize, 0);
    for (let y = 100; y < 150; y++) {
      for (let x = 100; x < 150; x++) {
        expect(result[index(x, y)]).toBe(expected);
      }
    }
    expect(result[index(99, 99)]).toBe(source[index(99, 99)]);
  });

  it('uses per-shape block sizes so a small face is not over-blocked', () => {
    const width = 1000;
    const height = 1000;
    const small = rect(0.1, 0.1, 0.02, 0.02);
    const large = rect(0.5, 0.5, 0.4, 0.4);
    expect(blockSizeForShape(small, 0.001, width, height)).toBe(8);
    expect(blockSizeForShape(large, 0.001, width, height)).toBe(50);

    const source = gradient(width, height);
    const result = applyMosaic(source, width, height, op([small, large], 0.001));
    const index = (x: number, y: number): number => (y * width + x) * 4;
    expect(result[index(100, 100)]).toBe(blockAverage(source, width, height, 96, 96, 8, 0));
    expect(result[index(500, 500)]).toBe(blockAverage(source, width, height, 500, 500, 50, 0));
  });

  it('unions overlapping shapes', () => {
    const width = 64;
    const height = 64;
    const source = gradient(width, height);
    const result = applyMosaic(
      source,
      width,
      height,
      op([rect(0.1, 0.1, 0.3, 0.3), rect(0.3, 0.1, 0.3, 0.3)], 8 / width),
    );
    expect(result[(20 * width + 10) * 4]).not.toBe(source[(20 * width + 10) * 4]);
    expect(result[(20 * width + 30) * 4]).not.toBe(source[(20 * width + 30) * 4]);
    expect(result[(20 * width + 45) * 4]).toBe(source[(20 * width + 45) * 4]);
  });

  it('can write in place', () => {
    const width = 32;
    const height = 32;
    const source = gradient(width, height);
    const before = source[0];
    const result = applyMosaic(source, width, height, op([rect(0, 0, 1, 1)], 8 / width), {
      inPlace: true,
    });
    expect(result).toBe(source);
    expect(result[0]).not.toBe(before);
  });

  it('rejects invalid input', () => {
    expect(() => applyMosaic(new Uint8Array(4), 0, 1, op([rect(0, 0, 1, 1)], 0.1))).toThrow(
      RangeError,
    );
    expect(() => applyMosaic(new Uint8Array(3), 1, 1, op([rect(0, 0, 1, 1)], 0.1))).toThrow(
      RangeError,
    );
    expect(() =>
      applyMosaic(new Uint8Array(4), 1, 1, { type: 'mosaic', shapes: [], blockSizeRel: 0 }),
    ).toThrow(RangeError);
  });

  it('mosaics a 45 MP image quickly', () => {
    const width = 8192;
    const height = 5504;
    const rgba = new Uint8Array(width * height * 4);
    const words = new Uint32Array(rgba.buffer);
    for (let i = 0; i < words.length; i++) {
      words[i] = (Math.imul(i, 2654435761) | 0xff000000) >>> 0;
    }
    const faces = [
      rect(0.2, 0.3, 0.04, 0.06),
      rect(0.6, 0.4, 0.04, 0.06),
      rect(0.8, 0.7, 0.04, 0.06),
    ];
    const started = performance.now();
    const result = applyMosaic(rgba, width, height, op(faces, 0.01));
    const elapsed = performance.now() - started;
    console.log(`45 MP mosaic (${width}x${height}, 3 faces): ${elapsed.toFixed(1)} ms`);
    expect(result).toHaveLength(rgba.length);
    // The whole workspace test suite runs this alongside other packages and
    // Electron e2e; CI machines are slower and contended. 1.5 s still catches a
    // complexity regression (this is a single pass over 45 MP).
    expect(elapsed).toBeLessThan(1500);
  }, 60_000);
});
