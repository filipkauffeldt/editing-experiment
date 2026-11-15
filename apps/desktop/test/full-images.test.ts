// @vitest-environment node
import { asPhotoId, type PhotoId } from '@ee/contracts';
import { decodeJpeg, encodeJpeg, extractPreview } from '@ee/core';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FullImageCache, NoFullImageError } from '../src/jobs/backend/full-images';
import { fixtureNefs, sampleNefs } from './helpers/fixtures';

/** A left half of 200 and a right half of 40, so a turned image shows which way it was turned. */
async function halves(width: number, height: number): Promise<Buffer> {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const value = x < width / 2 ? 200 : 40;
      rgba[at] = value;
      rgba[at + 1] = value;
      rgba[at + 2] = value;
      rgba[at + 3] = 255;
    }
  }
  return encodeJpeg(rgba, width, height, { quality: 95, chroma: '444', iccSrgb: true });
}

/** The JPEG with an EXIF orientation tag, which is how a camera JPEG says it was shot turned. */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]);
  return Buffer.concat([jpeg.subarray(0, 2), header, body, jpeg.subarray(2)]);
}

async function redAt(file: string, fx: number, fy: number) {
  const decoded = await decodeJpeg(await readFile(file), { skipOrientation: true });
  const at = (Math.floor(decoded.height * fy) * decoded.width + Math.floor(decoded.width * fx)) * 4;
  return { width: decoded.width, height: decoded.height, red: decoded.rgba[at]! };
}

describe('FullImageCache', () => {
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-full-'));
    dir = join(root, 'cache', 'full');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const cache = (extra: Partial<ConstructorParameters<typeof FullImageCache>[0]> = {}) =>
    new FullImageCache({ dir, ...extra });
  const photo = (id: string, path: string, orientation?: number) => ({
    id: asPhotoId(id),
    path,
    ...(orientation === undefined ? {} : { orientation }),
  });

  it('keeps the embedded JPEG of an upright raw as it is, byte for byte', async () => {
    const embedded = await halves(120, 80);
    const raw = join(root, 'a.NEF');
    await writeFile(raw, 'not a real raw, the extractor is a seam here');
    const full = cache({
      extract: async () => ({ jpeg: embedded, width: 120, height: 80, orientation: 1 }),
    });
    await full.init();
    const entry = await full.ensure(photo('a', raw));
    expect(entry.file).toBe(join(dir, 'a.jpg'));
    expect((await readFile(entry.file)).equals(embedded)).toBe(true);
    expect(entry.bytes).toBe(embedded.length);
  });

  it('turns the embedded JPEG of a raw shot on its side', async () => {
    // Stored 120x80, shot with the camera turned (orientation 6, 90 degrees clockwise).
    const embedded = await halves(120, 80);
    const raw = join(root, 'a.NEF');
    await writeFile(raw, 'raw');
    const full = cache({
      extract: async () => ({ jpeg: embedded, width: 120, height: 80, orientation: 6 }),
    });
    const entry = await full.ensure(photo('a', raw));
    // Upright it is 80x120 and the stored left half (bright) is now the top.
    expect(await redAt(entry.file, 0.5, 0.25)).toMatchObject({ width: 80, height: 120 });
    expect((await redAt(entry.file, 0.5, 0.25)).red).toBeGreaterThan(180);
    expect((await redAt(entry.file, 0.5, 0.75)).red).toBeLessThan(60);
  });

  it('copies the file of an upright JPEG photo and turns one with an orientation', async () => {
    const jpeg = join(root, 'a.jpg');
    const stored = await halves(120, 80);
    await writeFile(jpeg, withOrientation(stored, 6));
    const full = cache();
    const plain = join(root, 'plain.jpg');
    await writeFile(plain, stored);
    const upright = await full.ensure(photo('a', plain, 1));
    expect((await readFile(upright.file)).equals(stored)).toBe(true);
    expect(upright.file).not.toBe(plain);

    const turned = await full.ensure(photo('b', jpeg, 6));
    expect(await redAt(turned.file, 0.5, 0.25)).toMatchObject({ width: 80, height: 120 });
    expect((await redAt(turned.file, 0.5, 0.25)).red).toBeGreaterThan(180);
  });

  it('has no image for a format with no JPEG to zoom into, and leaves nothing behind', async () => {
    const tiff = join(root, 'a.tif');
    await writeFile(tiff, 'tiff');
    const full = cache();
    await full.init();
    await expect(full.ensure(photo('a', tiff))).rejects.toBeInstanceOf(NoFullImageError);
    expect(await readdir(dir)).toEqual([]);
  });

  it('builds a photo once for concurrent requests', async () => {
    let extracted = 0;
    const embedded = await halves(40, 40);
    const raw = join(root, 'a.NEF');
    await writeFile(raw, 'raw');
    const full = cache({
      extract: async () => {
        extracted += 1;
        return { jpeg: embedded, width: 40, height: 40, orientation: 1 };
      },
    });
    const [one, two] = await Promise.all([
      full.ensure(photo('a', raw)),
      full.ensure(photo('a', raw)),
    ]);
    expect(one).toBe(two);
    await full.ensure(photo('a', raw));
    expect(extracted).toBe(1);
  });

  describe('bounds', () => {
    const files = async (count: number): Promise<string[]> => {
      const jpeg = await halves(60, 40);
      const paths: string[] = [];
      for (let i = 0; i < count; i++) {
        const path = join(root, `p${i}.jpg`);
        await writeFile(path, jpeg);
        paths.push(path);
      }
      return paths;
    };

    it('keeps at most maxEntries files, least recently used first', async () => {
      const [p0, p1, p2] = await files(3);
      const full = cache({ maxEntries: 2 });
      await full.init();
      await full.ensure(photo('p0', p0!));
      await full.ensure(photo('p1', p1!));
      // Looking at p0 again makes p1 the oldest.
      await full.ensure(photo('p0', p0!));
      await full.ensure(photo('p2', p2!));
      expect(full.cached()).toEqual(['p0', 'p2']);
      expect((await readdir(dir)).sort()).toEqual(['p0.jpg', 'p2.jpg']);
    });

    it('keeps at most maxBytes, and always the file just asked for', async () => {
      const [p0, p1] = await files(2);
      const size = (await readFile(p0!)).length;
      const full = cache({ maxBytes: Math.floor(size * 1.5) });
      await full.init();
      await full.ensure(photo('p0', p0!));
      await full.ensure(photo('p1', p1!));
      expect(full.cached()).toEqual(['p1']);
      // A single file over the limit is still served.
      const tiny = cache({ dir: join(root, 'tiny'), maxBytes: 1 });
      const entry = await tiny.ensure(photo('p0', p0!));
      expect((await readFile(entry.file)).length).toBe(size);
    });

    it('is emptied on init, so leftovers of a crashed run are not tracked', async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'old.jpg'), 'left behind');
      const full = cache();
      await full.init();
      expect(await readdir(dir)).toEqual([]);
    });
  });

  describe('forget', () => {
    it('removes the file of a deleted photo', async () => {
      const [path] = [join(root, 'a.jpg')];
      await writeFile(path, await halves(60, 40));
      const full = cache();
      const entry = await full.ensure(photo('a', path));
      await full.forget('a' as PhotoId);
      expect(full.cached()).toEqual([]);
      await expect(readFile(entry.file)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('discards a build that was still running', async () => {
      const embedded = await halves(40, 40);
      const raw = join(root, 'a.NEF');
      await writeFile(raw, 'raw');
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const full = cache({
        extract: async () => {
          await gate;
          return { jpeg: embedded, width: 40, height: 40, orientation: 1 };
        },
      });
      await full.init();
      const running = full.ensure(photo('a', raw));
      await full.forget('a' as PhotoId);
      release();
      await expect(running).rejects.toThrow('deleted');
      expect(await readdir(dir)).toEqual([]);
      expect(full.cached()).toEqual([]);
    });
  });

  const nefs = [...sampleNefs(), ...fixtureNefs()];
  it.skipIf(nefs.length === 0)('serves the camera full-size JPEG of a real raw', async () => {
    const raw = nefs[0]!;
    const full = cache();
    const entry = await full.ensure(photo('real', raw));
    const embedded = await extractPreview(raw);
    const decoded = await decodeJpeg(await readFile(entry.file), { skipOrientation: true });
    expect(Math.max(decoded.width, decoded.height)).toBeGreaterThan(2560);
    expect(decoded.width * decoded.height).toBe(embedded.width * embedded.height);
    // The file is a copy below the cache, and the raw is untouched.
    expect(entry.file.startsWith(dir)).toBe(true);
    const copy = join(root, 'copy.NEF');
    await copyFile(raw, copy);
    expect((await readFile(raw)).equals(await readFile(copy))).toBe(true);
  });
});
