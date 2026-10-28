import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { decodeJpeg } from '../src/index';

/**
 * Smooth asymmetric RGBA test image: red grows to the right, green downwards,
 * blue is high only in the top-left quarter. 4:4:4 q100 keeps JPEG error low.
 */
function pattern(width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[i] = Math.round((x * 255) / (width - 1));
      out[i + 1] = Math.round((y * 255) / (height - 1));
      out[i + 2] = x < width / 2 && y < height / 2 ? 230 : 20;
      out[i + 3] = 255;
    }
  }
  return out;
}

async function jpegWithOrientation(
  width: number,
  height: number,
  orientation: number,
): Promise<Buffer> {
  return sharp(pattern(width, height), { raw: { width, height, channels: 4 } })
    .withMetadata({ orientation })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

function meanAbsError(a: Uint8Array, b: Uint8Array): number {
  expect(a.length).toBe(b.length);
  let total = 0;
  for (let i = 0; i < a.length; i += 4) {
    total +=
      Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
  }
  return total / ((a.length / 4) * 3);
}

describe('decodeJpeg', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'applies EXIF orientation %i like sharp does',
    async (orientation) => {
      const jpeg = await jpegWithOrientation(96, 64, orientation);
      const ours = await decodeJpeg(jpeg);
      const reference = await sharp(jpeg)
        .rotate()
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      expect({ width: ours.width, height: ours.height }).toEqual({
        width: reference.info.width,
        height: reference.info.height,
      });
      expect(ours.rgba.length).toBe(ours.width * ours.height * 4);
      // Two independent IDCTs differ by a level or two, never more.
      expect(meanAbsError(ours.rgba, reference.data)).toBeLessThan(1.5);
    },
  );

  it('can skip orientation', async () => {
    const jpeg = await jpegWithOrientation(96, 64, 6);
    const upright = await decodeJpeg(jpeg);
    const stored = await decodeJpeg(jpeg, { skipOrientation: true });
    expect([upright.width, upright.height]).toEqual([64, 96]);
    expect([stored.width, stored.height]).toEqual([96, 64]);
  });

  it('decodes grayscale JPEGs to opaque RGBA', async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 120, g: 120, b: 120 } },
    })
      .greyscale()
      .jpeg()
      .toBuffer();
    const image = await decodeJpeg(jpeg);
    expect(image.rgba.length).toBe(8 * 8 * 4);
    expect(image.rgba[3]).toBe(255);
    expect(image.rgba[0]).toBe(image.rgba[1]);
  });

  it('rejects data that is not a JPEG', async () => {
    await expect(decodeJpeg(Buffer.from('definitely not a jpeg'))).rejects.toThrow(
      /decoding failed/,
    );
  });
});
