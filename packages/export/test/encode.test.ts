import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ExifTool } from 'exiftool-vendored';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoEmbeddedPreviews, encodeJpeg } from '../src/index';
import { testImage } from './helpers/images';
import { testPreset } from './helpers/presets';

const preset = (quality: number, maxEdge?: number) =>
  testPreset({
    quality,
    ...(maxEdge === undefined ? {} : { resize: { mode: 'longEdge' as const, pixels: maxEdge } }),
  });

describe('encodeJpeg', () => {
  let dir: string;
  let exiftool: ExifTool;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ee-encode-'));
    exiftool = new ExifTool();
  });

  afterAll(async () => {
    await exiftool.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('downscales to maxEdge keeping the aspect ratio', async () => {
    const encoded = await encodeJpeg(testImage(1600, 1200), preset(90, 800));
    expect(encoded.width).toBe(800);
    expect(encoded.height).toBe(600);

    const metadata = await sharp(encoded.data).metadata();
    expect(metadata.width).toBe(800);
    expect(metadata.height).toBe(600);
    expect(metadata.format).toBe('jpeg');
    expect(metadata.isProgressive).toBe(false);
  });

  it('never upscales', async () => {
    const encoded = await encodeJpeg(testImage(60, 40), preset(80, 100));
    expect(encoded.width).toBe(60);
    expect(encoded.height).toBe(40);
  });

  it('resizes by short edge and by megapixels', async () => {
    const short = await encodeJpeg(
      testImage(1600, 1200),
      testPreset({ quality: 90, resize: { mode: 'shortEdge', pixels: 600 } }),
    );
    expect(short.width).toBe(800);
    expect(short.height).toBe(600);

    const megapixels = await encodeJpeg(
      testImage(1600, 1200),
      testPreset({ quality: 90, resize: { mode: 'megapixels', megapixels: 0.48 } }),
    );
    expect(megapixels.width).toBe(800);
    expect(megapixels.height).toBe(600);

    const small = await encodeJpeg(
      testImage(60, 40),
      testPreset({ quality: 90, resize: { mode: 'shortEdge', pixels: 100 } }),
    );
    expect(small.width).toBe(60);
    expect(small.height).toBe(40);
  });

  it('does not resize a render that is already the output size', async () => {
    for (const resize of [
      { mode: 'longEdge' as const, pixels: 800 },
      { mode: 'shortEdge' as const, pixels: 600 },
      { mode: 'megapixels' as const, megapixels: 0.48 },
    ]) {
      const encoded = await encodeJpeg(testImage(800, 600), testPreset({ quality: 90, resize }));
      expect([encoded.width, encoded.height]).toEqual([800, 600]);
    }
  });

  it('rejects invalid resize values', async () => {
    await expect(
      encodeJpeg(
        testImage(100, 80),
        testPreset({ quality: 90, resize: { mode: 'megapixels', megapixels: 0 } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_preset' });
    await expect(
      encodeJpeg(
        testImage(100, 80),
        testPreset({ quality: 90, resize: { mode: 'longEdge', pixels: 0 } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_preset' });
  });

  it('uses 4:4:4 at high quality, 4:2:0 below, and embeds sRGB', async () => {
    const high = await encodeJpeg(testImage(320, 240), preset(95));
    const low = await encodeJpeg(testImage(320, 240), preset(80));
    const highPath = path.join(dir, 'high.jpg');
    const lowPath = path.join(dir, 'low.jpg');
    await writeFile(highPath, high.data);
    await writeFile(lowPath, low.data);

    const highTags = await exiftool.read(highPath);
    const lowTags = await exiftool.read(lowPath);
    expect(String(highTags.YCbCrSubSampling)).toContain('4:4:4');
    expect(String(lowTags.YCbCrSubSampling)).toContain('4:2:0');
    expect(String(highTags.ProfileDescription ?? highTags.ICCProfileName)).toContain('sRGB');
  });

  it('writes no thumbnail or other preview, at any quality or size', async () => {
    for (const [quality, maxEdge] of [
      [95, undefined],
      [80, 400],
    ] as const) {
      const encoded = await encodeJpeg(testImage(800, 600), preset(quality, maxEdge));
      const file = path.join(dir, `clean-${quality}.jpg`);
      await writeFile(file, encoded.data);
      await assertNoEmbeddedPreviews(file);
    }
  });

  it('higher quality produces a larger file', async () => {
    const high = await encodeJpeg(testImage(512, 384), preset(95));
    const low = await encodeJpeg(testImage(512, 384), preset(50));
    expect(high.data.byteLength).toBeGreaterThan(low.data.byteLength);
  });

  it('rejects malformed input and presets', async () => {
    await expect(
      encodeJpeg({ width: 4, height: 4, rgba: new Uint8Array(3) }, preset(90)),
    ).rejects.toMatchObject({ code: 'invalid_image' });
    await expect(encodeJpeg(testImage(4, 4), preset(0))).rejects.toMatchObject({
      code: 'invalid_preset',
    });
  });
});
