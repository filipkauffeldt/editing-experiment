// @vitest-environment node
import type { RgbaImage } from '@ee/core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { turnPixels, turnRgba } from '../src/jobs/backend/image-ops';

/** 6x4 RGBA image whose pixels all differ, so every turn shows. */
function asymmetricImage(): RgbaImage {
  const width = 6;
  const height = 4;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      rgba[at] = x * 40;
      rgba[at + 1] = y * 60;
      rgba[at + 2] = (x * 7 + y * 31) % 256;
      rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba };
}

describe('turnRgba', () => {
  it.each([
    [1, 90],
    [2, 180],
    [3, 270],
  ])('turns %i quarter turns clockwise like a viewer does (%i°)', async (turns, degrees) => {
    const plain = asymmetricImage();
    const expected = await sharp(plain.rgba, {
      raw: { width: plain.width, height: plain.height, channels: 4 },
    })
      .rotate(degrees)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const actual = turnRgba(plain, turns);
    expect([actual.width, actual.height]).toEqual([expected.info.width, expected.info.height]);
    expect(Buffer.from(actual.rgba).equals(expected.data)).toBe(true);
  });

  it('counts a left turn as three right turns and leaves a whole turn alone', () => {
    const plain = asymmetricImage();
    expect(turnRgba(plain, -1).rgba.equals(turnRgba(plain, 3).rgba)).toBe(true);
    expect(turnRgba(plain, 4)).toBe(plain);
    expect(turnRgba(plain, undefined)).toBe(plain);
  });
});

describe('turnPixels', () => {
  it('moves wider pixels as whole units, as for half-float and float images', () => {
    // 3x2 pixels of 8 and 16 bytes, each filled with its own index.
    for (const bytesPerPixel of [8, 16]) {
      const pixels = Buffer.alloc(3 * 2 * bytesPerPixel);
      for (let i = 0; i < 6; i++) pixels.fill(i + 1, i * bytesPerPixel, (i + 1) * bytesPerPixel);
      const right = turnPixels(pixels, 3, 2, bytesPerPixel, 1);
      expect([right.width, right.height]).toEqual([2, 3]);
      // a b c / d e f turned right is d a / e b / f c.
      const order = Array.from({ length: 6 }, (_, i) => right.data[i * bytesPerPixel]);
      expect(order).toEqual([4, 1, 5, 2, 6, 3]);
      // Every byte of a pixel moved with it.
      for (let i = 0; i < 6; i++) {
        const unit = right.data.subarray(i * bytesPerPixel, (i + 1) * bytesPerPixel);
        expect(new Set(unit).size).toBe(1);
      }
      const back = turnPixels(right.data, 2, 3, bytesPerPixel, -1);
      expect(back.data.equals(pixels)).toBe(true);
    }
  });

  it('reads a buffer that does not start on a 4-byte boundary', () => {
    const plain = asymmetricImage();
    const backing = Buffer.alloc(plain.rgba.length + 1);
    plain.rgba.copy(backing, 1);
    const shifted = turnPixels(backing.subarray(1), plain.width, plain.height, 4, 1);
    expect(shifted.data.equals(turnPixels(plain.rgba, plain.width, plain.height, 4, 1).data)).toBe(
      true,
    );
  });
});
