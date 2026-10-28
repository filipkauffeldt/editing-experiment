// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { applyOrientation, makePreviewJpegs } from '../src/jobs/backend/image-ops';
import { PreviewCache } from '../src/jobs/backend/previews';
import { asPhotoId } from '@ee/contracts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 6x4 image whose corners and edges differ, so every flip and rotation shows. */
async function asymmetricImage(): Promise<Buffer> {
  const width = 6;
  const height = 4;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      rgb[at] = x * 40;
      rgb[at + 1] = y * 60;
      rgb[at + 2] = (x * 7 + y * 31) % 256;
    }
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

const pixels = (image: Sharp) => image.raw().toBuffer({ resolveWithObject: true });

describe('applyOrientation', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'matches the EXIF meaning of orientation %i',
    async (orientation) => {
      const plain = await asymmetricImage();
      // sharp's own auto-orient is the reference: tag the same pixels with the orientation.
      const tagged = await sharp(plain).withMetadata({ orientation }).png().toBuffer();
      const expected = await pixels(sharp(tagged).rotate());
      const actual = await pixels(applyOrientation(sharp(plain), orientation));
      expect(actual.info.width).toBe(expected.info.width);
      expect(actual.info.height).toBe(expected.info.height);
      expect(actual.data.equals(expected.data)).toBe(true);
    },
  );
});

describe('PreviewCache', () => {
  it('writes a bounded preview and thumbnail, oriented, without metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ee-prev-'));
    dirs.push(dir);
    const cache = new PreviewCache(join(dir, 'thumb'), join(dir, 'preview'));
    const id = asPhotoId('p1');
    // Landscape pixels flagged as "rotate 90": the cached files must be portrait.
    const jpeg = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: '#468' },
    })
      .jpeg()
      .toBuffer();

    await cache.generate(id, { jpeg, orientation: 6 });

    const preview = await sharp(await readFile(cache.pathFor('preview', id))).metadata();
    const thumb = await sharp(await readFile(cache.pathFor('thumb', id))).metadata();
    expect([preview.width, preview.height]).toEqual([1920, 2560]);
    expect([thumb.width, thumb.height]).toEqual([240, 320]);
    expect(preview.exif).toBeUndefined();
    expect(await cache.has('thumb', id)).toBe(true);
    expect(await cache.has('thumb', asPhotoId('other'))).toBe(false);
    expect((await stat(cache.pathFor('thumb', id))).size).toBeGreaterThan(0);
  });

  it('never upscales small images', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ee-prev-'));
    dirs.push(dir);
    const cache = new PreviewCache(join(dir, 't'), join(dir, 'p'));
    const file = join(dir, 'small.jpg');
    await sharp({ create: { width: 200, height: 100, channels: 3, background: '#fff' } })
      .jpeg()
      .toFile(file);
    await cache.generate(asPhotoId('s'), { file });
    const preview = await sharp(
      await readFile(cache.pathFor('preview', asPhotoId('s'))),
    ).metadata();
    expect([preview.width, preview.height]).toEqual([200, 100]);
  });
});

describe('makePreviewJpegs', () => {
  it('returns bounded, upright, metadata-free preview and thumbnail', async () => {
    const jpeg = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#468' },
    })
      .jpeg()
      .toBuffer();
    const { preview, thumb } = await makePreviewJpegs({ jpeg, orientation: 8 });
    const p = await sharp(preview).metadata();
    const t = await sharp(thumb).metadata();
    expect([p.width, p.height]).toEqual([1707, 2560]);
    expect([t.width, t.height]).toEqual([213, 320]);
    expect(p.exif).toBeUndefined();
    expect(t.exif).toBeUndefined();
  });
});
