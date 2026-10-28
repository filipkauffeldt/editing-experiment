import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ExifTool } from 'exiftool-vendored';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExportPreset } from '@ee/contracts';
import { encodeJpeg } from '../src/index';
import { testImage } from './helpers/images';

const preset = (quality: number, maxEdge?: number): ExportPreset => ({
  quality,
  metadata: 'all',
  ...(maxEdge === undefined ? {} : { maxEdge }),
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
