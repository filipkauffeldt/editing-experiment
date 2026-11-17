// @vitest-environment node
import {
  LINEAR_IMAGE_HEADER,
  appUrl,
  asPresetId,
  type FolderImportInfo,
  type IpcHandlers,
  type LinearImageHeader,
  type MosaicOp,
  type Photo,
  type Rect,
} from '@ee/contracts';
import { readRawInfo } from '@ee/core';
import {
  ExifToolService,
  orientationAfterTurns,
  readEditParams,
  writeXmpOrientation,
} from '@ee/metadata';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createBackend, type Backend } from '../src/jobs/backend/backend';
import { defaultExportPreset } from '../src/shared/settings';
import { fixtureNefs } from './helpers/fixtures';

const nefs = fixtureNefs();
const dirs: string[] = [];
const exiftool = new ExifToolService();
const originalCardRoots = process.env.EE_CARD_ROOTS;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
afterAll(async () => {
  await exiftool.close();
  if (originalCardRoots === undefined) delete process.env.EE_CARD_ROOTS;
  else process.env.EE_CARD_ROOTS = originalCardRoots;
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  root: string;
  library: string;
  backend: Backend;
  handlers: IpcHandlers;
  events: { channel: string; payload: unknown }[];
}

async function start(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ee-rotate-'));
  dirs.push(root);
  const library = join(root, 'library');
  const media = join(root, 'media');
  for (const dir of [library, media, join(root, 'ingest')]) await mkdir(dir, { recursive: true });
  // Never scan the real machine for cards in a test.
  process.env.EE_CARD_ROOTS = media;
  const events: Harness['events'] = [];
  const backend = await createBackend({
    userDataDir: join(root, 'userdata'),
    appVersion: 'test',
    homeDir: root,
    emit: (channel, payload) => events.push({ channel, payload }),
    getSecret: async () => ({}),
  });
  const handlers = backend.handlers as IpcHandlers;
  const { ingest } = await handlers['settings:get']();
  await handlers['settings:set']({
    ingest: { ...ingest, destination: { path: join(root, 'ingest') } },
  });
  await backend.reconciled;
  return { root, library, backend, handlers, events };
}

/** Adds the library folder in place and waits for the import to finish. */
async function addLibrary(harness: Harness): Promise<Photo[]> {
  const info = await harness.handlers['photos:addFolder']({ path: harness.library });
  const deadline = Date.now() + 90_000;
  for (;;) {
    const done = harness.events.find(
      (event) =>
        event.channel === 'jobs:event' &&
        (event.payload as { type?: string }).type === 'library.state' &&
        (event.payload as FolderImportInfo).jobId === info.jobId &&
        (event.payload as FolderImportInfo).state !== 'running',
    );
    if (done) return harness.handlers['photos:list']();
    if (Date.now() > deadline) throw new Error('timed out waiting for the folder import');
    await sleep(50);
  }
}

const QUADRANTS = {
  topLeft: [220, 30, 30],
  topRight: [30, 200, 30],
  bottomLeft: [30, 30, 220],
  bottomRight: [230, 220, 30],
} as const;
type Quadrant = keyof typeof QUADRANTS;

/** A 60x40 picture with a different colour in each quarter. */
async function quadrantJpeg(path: string, exifOrientation?: number): Promise<void> {
  const tile = (name: Quadrant) => ({
    input: {
      create: { width: 30, height: 20, channels: 3 as const, background: rgbOf(name) },
    },
    left: name.endsWith('Left') ? 0 : 30,
    top: name.startsWith('top') ? 0 : 20,
  });
  await sharp({ create: { width: 60, height: 40, channels: 3, background: '#000' } })
    .composite((Object.keys(QUADRANTS) as Quadrant[]).map(tile))
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toFile(path);
  if (exifOrientation !== undefined)
    await exiftool.write(path, { 'IFD0:Orientation#': exifOrientation });
}

const rgbOf = (name: Quadrant): { r: number; g: number; b: number } => {
  const [r, g, b] = QUADRANTS[name];
  return { r, g, b };
};

/** Which quarter of a picture a colour belongs to, by nearest colour. */
function nearestQuadrant(pixel: readonly number[]): Quadrant {
  let best: Quadrant = 'topLeft';
  let bestDistance = Infinity;
  for (const name of Object.keys(QUADRANTS) as Quadrant[]) {
    const [r, g, b] = QUADRANTS[name];
    const distance = (pixel[0]! - r) ** 2 + (pixel[1]! - g) ** 2 + (pixel[2]! - b) ** 2;
    if (distance < bestDistance) [best, bestDistance] = [name, distance];
  }
  return best;
}

/** The quarters of a JPEG file as drawn, read at the middle of each quarter. */
async function quartersOf(
  source: string | Buffer,
): Promise<Record<Quadrant, Quadrant> & { width: number; height: number }> {
  const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): Quadrant => {
    const i =
      (Math.floor(y * info.height) * info.width + Math.floor(x * info.width)) * info.channels;
    return nearestQuadrant([data[i]!, data[i + 1]!, data[i + 2]!]);
  };
  return {
    width: info.width,
    height: info.height,
    topLeft: at(0.25, 0.25),
    topRight: at(0.75, 0.25),
    bottomLeft: at(0.25, 0.75),
    bottomRight: at(0.75, 0.75),
  };
}

async function servedFile(harness: Harness, url: string): Promise<Buffer> {
  const response = await harness.backend.resolveAppRequest(url);
  if (response.status !== 200 || response.file === undefined) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return readFile(response.file);
}

async function linearOf(
  harness: Harness,
  photo: Photo,
  maxEdge?: number,
): Promise<{ header: LinearImageHeader; data: Buffer }> {
  const response = await harness.backend.resolveAppRequest(appUrl.linear(photo.id, maxEdge));
  if (response.status !== 200 || response.file === undefined) {
    throw new Error(`linear answered ${response.status}: ${response.body ?? ''}`);
  }
  return {
    header: JSON.parse(response.headers[LINEAR_IMAGE_HEADER]!) as LinearImageHeader,
    data: await readFile(response.file),
  };
}

const rect = (x: number, y: number, w: number, h: number): Rect => ({ type: 'rect', x, y, w, h });

describe('turning a JPEG in the Library', { timeout: 120_000 }, () => {
  it('writes the XMP orientation and shows the turned picture everywhere, then turns back', async () => {
    const harness = await start();
    const path = join(harness.library, 'shot.jpg');
    await quadrantJpeg(path);
    const pixelsBefore = await sharp(path).raw().toBuffer();
    const [photo] = await addLibrary(harness);
    expect(photo).toMatchObject({ width: 60, height: 40 });
    expect(photo?.rotation).toBeUndefined();

    const turned = await harness.handlers['photos:rotate']({ photoIds: [photo!.id], turns: 1 });

    expect(turned.failed).toEqual([]);
    const right = turned.updated[0]!;
    expect(right).toMatchObject({ rotation: 1, width: 40, height: 60 });
    // Where Lightroom keeps it: the XMP, as the orientation the picture now has. The camera's
    // EXIF tag is untouched, and so are the pixels.
    const tags = await exiftool.read(path);
    expect(tags['XMP-tiff:Orientation']).toBe(6);
    expect(tags['IFD0:Orientation']).toBeUndefined();
    expect((await sharp(path).raw().toBuffer()).equals(pixelsBefore)).toBe(true);

    // Thumbnail, preview and the decoded image all show it turned right: the left side is the top.
    const expected = {
      topLeft: 'bottomLeft',
      topRight: 'topLeft',
      bottomLeft: 'bottomRight',
      bottomRight: 'topRight',
    };
    for (const kind of ['thumb', 'preview'] as const) {
      const url =
        kind === 'thumb'
          ? appUrl.thumb(photo!.id, right.previewRevision)
          : appUrl.preview(photo!.id, right.previewRevision);
      expect(await quartersOf(await servedFile(harness, url)), kind).toMatchObject({
        width: 40,
        height: 60,
        ...expected,
      });
    }
    const linear = await linearOf(harness, right);
    expect(linear.header).toMatchObject({
      width: 40,
      height: 60,
      sourceWidth: 40,
      sourceHeight: 60,
    });
    const floats = new Float32Array(
      linear.data.buffer,
      linear.data.byteOffset,
      linear.data.byteLength / 4,
    );
    const redAt = (x: number, y: number): number => floats[(y * 40 + x) * 4]!;
    // The original's top left is red, and is now the top right.
    expect(redAt(30, 10)).toBeGreaterThan(0.5);
    expect(redAt(10, 10)).toBeLessThan(0.1);

    const back = await harness.handlers['photos:rotate']({ photoIds: [photo!.id], turns: -1 });
    expect(back.updated[0]).toMatchObject({ width: 60, height: 40 });
    expect(back.updated[0]?.rotation).toBeUndefined();
    expect((await exiftool.read(path))['XMP-tiff:Orientation']).toBeUndefined();
    expect(
      await quartersOf(
        await servedFile(harness, appUrl.preview(photo!.id, back.updated[0]?.previewRevision)),
      ),
    ).toMatchObject({
      width: 60,
      height: 40,
      topLeft: 'topLeft',
      bottomRight: 'bottomRight',
    });
    await harness.backend.dispose();
  });

  it('turns every photo of a selection and reports the one that fails', async () => {
    const harness = await start();
    await quadrantJpeg(join(harness.library, 'a.jpg'));
    await quadrantJpeg(join(harness.library, 'b.jpg'));
    const photos = await addLibrary(harness);
    const [a, b] = photos;

    const result = await harness.handlers['photos:rotate']({
      photoIds: [a!.id, b!.id, 'ghost' as Photo['id']],
      turns: 2,
    });

    expect(result.updated.map((photo) => photo.rotation)).toEqual([2, 2]);
    expect(result.updated.map((photo) => [photo.width, photo.height])).toEqual([
      [60, 40],
      [60, 40],
    ]);
    expect(result.failed.map((failure) => failure.photoId)).toEqual(['ghost']);
    expect(
      await quartersOf(
        await servedFile(harness, appUrl.preview(a!.id, result.updated[0]?.previewRevision)),
      ),
    ).toMatchObject({
      topLeft: 'bottomRight',
      bottomRight: 'topLeft',
    });
    await expect(
      harness.handlers['photos:rotate']({ photoIds: [a!.id], turns: 4 }),
    ).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    await harness.backend.dispose();
  });

  it('keeps a crop and the retouch areas on the same picture content', async () => {
    const harness = await start();
    const path = join(harness.library, 'shot.jpg');
    await quadrantJpeg(path);
    const [photo] = await addLibrary(harness);
    const id = photo!.id;
    // The crop is the top left quarter, the mosaic a small box in it.
    await harness.handlers['develop:setParams']({
      photoId: id,
      params: { Exposure2012: 0.5, crop: { left: 0, top: 0, right: 0.5, bottom: 0.5, angle: 0 } },
    });
    const op: MosaicOp = {
      type: 'mosaic',
      blockSizeRel: 0.05,
      shapes: [rect(0.1, 0.2, 0.3, 0.1)],
      areas: [
        { shape: rect(0.1, 0.2, 0.3, 0.1), face: { box: rect(0.15, 0.22, 0.2, 0.06), score: 0.9 } },
      ],
    };
    await harness.handlers['retouch:set']({ photoId: id, ops: [op] });

    const { updated } = await harness.handlers['photos:rotate']({ photoIds: [id], turns: 1 });

    const develop = updated[0]!.versions.find((version) => version.kind === 'develop');
    const crop = develop?.kind === 'develop' ? develop.ops.crop : undefined;
    // The top left quarter of the old picture is the top right quarter of the new one.
    expect(crop).toMatchObject({ left: 0.5, top: 0, right: 1, bottom: 0.5 });
    expect(crop?.angle).toBeCloseTo(0, 9);
    expect(develop?.kind === 'develop' ? develop.ops.Exposure2012 : undefined).toBe(0.5);
    expect(await harness.handlers['develop:getParams']({ photoId: id })).toMatchObject({ crop });
    const retouch = updated[0]!.versions.find((version) => version.kind === 'retouch');
    const ops = retouch?.kind === 'retouch' ? retouch.ops : [];
    const turnedBox = (ops[0] as MosaicOp).areas?.[0];
    expect(ops[0]?.shapes[0]).toMatchObject({ type: 'rect', x: 0.7, y: 0.1 });
    expect((ops[0]?.shapes[0] as Rect).w).toBeCloseTo(0.1, 9);
    expect((ops[0]?.shapes[0] as Rect).h).toBeCloseTo(0.3, 9);
    expect(turnedBox?.shape).toEqual(ops[0]?.shapes[0]);
    expect((turnedBox?.face?.box as Rect).x).toBeCloseTo(1 - 0.22 - 0.06, 9);
    expect((turnedBox?.face?.box as Rect).y).toBeCloseTo(0.15, 9);
    expect(await harness.handlers['retouch:get']({ photoId: id })).toEqual(ops);

    // And what the crop selects on the turned picture is still the red quarter.
    const linear = await linearOf(harness, updated[0]!);
    const floats = new Float32Array(
      linear.data.buffer,
      linear.data.byteOffset,
      linear.data.byteLength / 4,
    );
    const width = linear.header.width;
    const redShare = (x0: number, x1: number, y0: number, y1: number): number => {
      let red = 0;
      let count = 0;
      for (let y = Math.floor(y0 * linear.header.height); y < y1 * linear.header.height; y++) {
        for (let x = Math.floor(x0 * width); x < x1 * width; x++) {
          const i = (y * width + x) * 4;
          if (floats[i]! > 0.5 && floats[i + 1]! < 0.1) red++;
          count++;
        }
      }
      return red / count;
    };
    expect(redShare(crop!.left, crop!.right, crop!.top, crop!.bottom)).toBeGreaterThan(0.95);

    // Turning back gives the old numbers.
    const back = await harness.handlers['photos:rotate']({ photoIds: [id], turns: -1 });
    const backDevelop = back.updated[0]!.versions.find((version) => version.kind === 'develop');
    expect(backDevelop?.kind === 'develop' ? backDevelop.ops.crop : undefined).toMatchObject({
      left: 0,
      top: 0,
      right: 0.5,
      bottom: 0.5,
    });
    const backRetouch = back.updated[0]!.versions.find((version) => version.kind === 'retouch');
    const backShape =
      backRetouch?.kind === 'retouch' ? (backRetouch.ops[0]!.shapes[0] as Rect) : undefined;
    expect(backShape?.x).toBeCloseTo(0.1, 9);
    expect(backShape?.y).toBeCloseTo(0.2, 9);
    expect(backShape?.w).toBeCloseTo(0.3, 9);
    expect(backShape?.h).toBeCloseTo(0.1, 9);
    await harness.backend.dispose();
  });

  it('exports the turned picture upright, with no orientation tag to turn it again', async () => {
    const harness = await start();
    const path = join(harness.library, 'sideways.jpg');
    // The camera recorded the frame sideways: EXIF 6 says it shows turned right.
    await quadrantJpeg(path, 6);
    const [photo] = await addLibrary(harness);
    expect(photo).toMatchObject({ orientation: 6, width: 40, height: 60 });
    const turned = (await harness.handlers['photos:rotate']({ photoIds: [photo!.id], turns: 1 }))
      .updated[0]!;
    // On top of the camera's 6 a right turn is upside down: EXIF 3.
    expect(turned).toMatchObject({ rotation: 1, width: 60, height: 40 });
    expect((await exiftool.read(path))['XMP-tiff:Orientation']).toBe(3);

    // The renderer draws from the decoded image, which is what the export is made from.
    const linear = await linearOf(harness, turned);
    expect(linear.header).toMatchObject({ width: 60, height: 40 });
    const floats = new Float32Array(
      linear.data.buffer,
      linear.data.byteOffset,
      linear.data.byteLength / 4,
    );
    const rgba = new Uint8Array(60 * 40 * 4);
    const encode = (value: number): number =>
      Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055));
    for (let i = 0; i < 60 * 40; i++) {
      for (let channel = 0; channel < 3; channel++)
        rgba[i * 4 + channel] = encode(floats[i * 4 + channel]!);
      rgba[i * 4 + 3] = 255;
    }

    const exports = join(harness.root, 'exports');
    const preset = { ...defaultExportPreset(), id: asPresetId('test'), folderTemplate: exports };
    await harness.handlers['exportPresets:save']({ preset });
    const jobId = await harness.handlers['export:start']({
      photoIds: [photo!.id],
      presetId: preset.id,
    });
    const handled = new Set<string>();
    const deadline = Date.now() + 60_000;
    let exported: string | undefined;
    while (exported === undefined) {
      if (Date.now() > deadline) throw new Error('the export did not finish');
      for (const event of harness.events) {
        const payload = event.payload as {
          type?: string;
          jobId?: string;
          requestId?: string;
          opsKey?: string;
          state?: string;
          job?: { photos: { path?: string }[] };
        };
        if (payload.jobId !== jobId) continue;
        if (
          payload.type === 'export.render' &&
          payload.requestId &&
          !handled.has(payload.requestId)
        ) {
          handled.add(payload.requestId);
          await harness.handlers['export:render']({
            jobId,
            requestId: payload.requestId,
            rendered: { width: 60, height: 40, rgba },
            opsKey: payload.opsKey ?? '',
          });
        }
        if (payload.type === 'export.state' && payload.state === 'done')
          exported = payload.job?.photos[0]?.path;
      }
      await sleep(20);
    }

    expect(await readdir(exports)).toHaveLength(1);
    const tags = await exiftool.read(exported);
    // No tag at all, so no viewer turns it a second time.
    expect(tags['IFD0:Orientation']).toBeUndefined();
    expect(tags['XMP-tiff:Orientation']).toBeUndefined();
    const meta = await sharp(exported).metadata();
    expect(meta).toMatchObject({ width: 60, height: 40 });
    expect(meta.orientation).toBeUndefined();
    // What a viewer shows of the original with its camera tag and the turn applied (sideways,
    // then right again: upside down), against the file as exported: the same quarters.
    const reference = await sharp(path).rotate().rotate(90).jpeg().toBuffer();
    expect(await quartersOf(exported)).toEqual(await quartersOf(reference));
    expect(await quartersOf(exported)).toMatchObject({
      topLeft: 'bottomRight',
      bottomRight: 'topLeft',
    });
    await harness.backend.dispose();
  });
});

describe('a rotation made elsewhere', { timeout: 120_000 }, () => {
  it('is read from the XMP of a JPEG when the folder is added', async () => {
    const harness = await start();
    const path = join(harness.library, 'lightroom.jpg');
    // Lightroom rotated it right: the XMP says 6 and the camera said nothing.
    await quadrantJpeg(path);
    await writeXmpOrientation(path, 6, { service: exiftool });

    const [photo] = await addLibrary(harness);

    expect(photo).toMatchObject({ rotation: 1, width: 40, height: 60 });
    expect(
      await quartersOf(
        await servedFile(harness, appUrl.preview(photo!.id, photo!.previewRevision)),
      ),
    ).toMatchObject({ width: 40, height: 60, topLeft: 'bottomLeft', topRight: 'topLeft' });
    await harness.backend.dispose();
  });

  it('is the camera orientation when the XMP only repeats it', async () => {
    const harness = await start();
    const path = join(harness.library, 'same.jpg');
    await quadrantJpeg(path, 6);
    await writeXmpOrientation(path, 6, { service: exiftool });

    const [photo] = await addLibrary(harness);

    expect(photo?.rotation).toBeUndefined();
    expect(photo).toMatchObject({ orientation: 6, width: 40, height: 60 });
    await harness.backend.dispose();
  });
});

describe.skipIf(nefs.length === 0)('turning a raw', { timeout: 120_000 }, () => {
  it('writes the sidecar only, with the camera orientation turned, and shows it turned', async () => {
    const harness = await start();
    const raw = join(harness.library, 'game.NEF');
    await copyFile(nefs[0]!, raw);
    const sha = async (): Promise<string> =>
      (await import('node:crypto'))
        .createHash('sha256')
        .update(await readFile(raw))
        .digest('hex');
    const before = await sha();
    const [photo] = await addLibrary(harness);
    const camera = photo!.orientation ?? 1;
    const { width, height } = photo!;

    const result = await harness.handlers['photos:rotate']({ photoIds: [photo!.id], turns: 1 });

    const right = result.updated[0]!;
    expect(right).toMatchObject({ rotation: 1, width: height, height: width });
    expect(await sha()).toBe(before);
    const sidecar = join(harness.library, 'game.xmp');
    const written = (await exiftool.read(sidecar))['XMP-tiff:Orientation'];
    const expected = (await import('@ee/metadata')).orientationAfterTurns(camera, 1);
    expect(written).toBe(expected);
    expect(await readFile(sidecar, 'utf8')).toMatch(/tiff:Orientation(="\d"|>\d<)/);

    const linear = await linearOf(harness, right, 320);
    expect(linear.header.width / linear.header.height).toBeCloseTo(height! / width!, 1);
    expect(linear.header.sourceWidth).toBe(height);
    expect(linear.header.sourceHeight).toBe(width);
    const preview = await sharp(
      await servedFile(harness, appUrl.preview(photo!.id, right.previewRevision)),
    ).metadata();
    expect(preview.width! / preview.height!).toBeCloseTo(height! / width!, 1);

    const back = await harness.handlers['photos:rotate']({ photoIds: [photo!.id], turns: -1 });
    expect(back.updated[0]).toMatchObject({ width, height });
    expect(back.updated[0]?.rotation).toBeUndefined();
    expect((await exiftool.read(sidecar))['XMP-tiff:Orientation']).toBeUndefined();
    expect(await sha()).toBe(before);
    await harness.backend.dispose();
  });

  it('leaves the stored crop where Lightroom reads it', async () => {
    const harness = await start();
    const raw = join(harness.library, 'game.NEF');
    await copyFile(nefs[0]!, raw);
    const [photo] = await addLibrary(harness);
    await harness.handlers['develop:setParams']({
      photoId: photo!.id,
      params: { crop: { left: 0.1, top: 0.2, right: 0.6, bottom: 0.9, angle: 0 } },
    });
    const sidecar = join(harness.library, 'game.xmp');
    const stored = async (): Promise<unknown[]> => {
      const tags = await exiftool.read(sidecar);
      return ['Left', 'Top', 'Right', 'Bottom', 'Angle'].map((side) => tags[`XMP-crs:Crop${side}`]);
    };
    const before = await stored();

    const { updated } = await harness.handlers['photos:rotate']({
      photoIds: [photo!.id],
      turns: 1,
    });
    await harness.handlers['photos:rotate']({ photoIds: [photo!.id], turns: 2 });

    // The sensor's pixel space is the same whichever way it is turned.
    expect(await stored()).toEqual(before);
    const develop = updated[0]!.versions.find((version) => version.kind === 'develop');
    expect(develop?.kind === 'develop' ? develop.ops.crop : undefined).toBeDefined();
    const final = await readEditParams(raw, exiftool, undefined);
    expect(final.crop).toBeDefined();
    await harness.backend.dispose();
  });

  it('is read from the sidecar that came with the raw', async () => {
    const harness = await start();
    const raw = join(harness.library, 'game.NEF');
    await copyFile(nefs[0]!, raw);
    const info = await readRawInfo(raw);
    // Lightroom turned it left, on top of whatever the camera recorded.
    await writeXmpOrientation(raw, orientationAfterTurns(info.orientation, 3), {
      service: exiftool,
    });

    const [photo] = await addLibrary(harness);

    expect(photo).toMatchObject({
      orientation: info.orientation,
      rotation: 3,
      width: info.height,
      height: info.width,
    });
    await harness.backend.dispose();
  });
});
