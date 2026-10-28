// @vitest-environment node
import {
  appUrl,
  asPhotoId,
  asSourceId,
  type EditParams,
  type EventChannel,
  type MosaicOp,
  type Photo,
  type RenderedImage,
} from '@ee/contracts';
import { decodeJpeg, encodeJpeg } from '@ee/core';
import { ExifToolService } from '@ee/metadata';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppResources } from '../src/jobs/backend/app-resources';
import { EditedPreviews } from '../src/jobs/backend/edited-previews';
import { developVersionId, EditService } from '../src/jobs/backend/edit-service';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { PreviewCache } from '../src/jobs/backend/previews';

const id = asPhotoId('p1');
const mosaic = (x: number): MosaicOp => ({
  type: 'mosaic',
  shapes: [{ type: 'rect', x, y: 0.1, w: 0.3, h: 0.3 }],
  blockSizeRel: 0.05,
});

/** A flat RGBA image; the colour tells which render a served file came from. */
function flat(width: number, height: number, value: number): RenderedImage {
  const rgba = new Uint8Array(width * height * 4).fill(value);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { width, height, rgba };
}

async function centreValue(file: string): Promise<{ width: number; height: number; red: number }> {
  const decoded = await decodeJpeg(await readFile(file));
  const at = ((decoded.height >> 1) * decoded.width + (decoded.width >> 1)) * 4;
  return { width: decoded.width, height: decoded.height, red: decoded.rgba[at]! };
}

describe('edited thumbnails and previews (jobs side)', () => {
  const exiftool = new ExifToolService();
  let root: string;
  let events: { channel: EventChannel; payload: unknown }[];
  let photos: PhotoLibrary;
  let cache: PreviewCache;
  let edited: EditedPreviews;
  let edits: EditService;
  let apps: AppResources;
  let originalThumb: Buffer;
  let originalPreview: Buffer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-edited-previews-'));
  });
  afterAll(async () => {
    await exiftool.close();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    events = [];
    const dir = await mkdtemp(join(root, 'case-'));
    await mkdir(join(dir, 'cache'));
    const path = join(dir, 'photo.jpg');
    const original = flat(48, 32, 200);
    await writeFile(
      path,
      await encodeJpeg(original.rgba, 48, 32, { quality: 90, chroma: '444', iccSrgb: true }),
    );
    photos = new PhotoLibrary(new PhotoIndex(':memory:'), (channel, payload) =>
      events.push({ channel, payload }),
    );
    cache = new PreviewCache(join(dir, 'cache', 'thumb'), join(dir, 'cache', 'preview'));
    await cache.generate(id, { file: path });
    originalThumb = await readFile(cache.pathFor('thumb', id));
    originalPreview = await readFile(cache.pathFor('preview', id));
    edited = new EditedPreviews(photos, cache);
    edits = new EditService(photos, exiftool, edited);
    apps = new AppResources({ photos, previews: cache, linearDir: join(dir, 'cache', 'linear') });
    photos.add({
      id,
      path,
      sidecarPath: path,
      fileName: 'photo.jpg',
      width: 48,
      height: 32,
      sourceId: asSourceId('s'),
      tagged: false,
      colorClass: 0,
      status: {
        ingest: 'done',
        edited: false,
        metadataDiffersFromTemplate: false,
        export: 'none',
        upload: 'none',
      },
      versions: [{ id: developVersionId(id), kind: 'develop', ops: {} }],
    });
    events = [];
  });

  const develop = (params: EditParams) =>
    edits.setParams({ photoId: id, versionId: developVersionId(id), params });
  const retouch = async (ops: MosaicOp[]) => {
    const version = await edits.createVersion({ photoId: id, kind: 'retouch' });
    await edits.setRetouch({ photoId: id, versionId: version.id, ops });
  };
  const send = (revision: number, red: number, retouchOps: MosaicOp[] = []) =>
    edited.set({
      photoId: id,
      revision,
      retouchOps,
      thumb: flat(16, 16, red),
      preview: flat(40, 40, red),
    });
  const served = async (kind: 'thumb' | 'preview') => {
    const response = await apps.resolve(
      kind === 'thumb' ? appUrl.thumb(id, 9) : appUrl.preview(id),
    );
    expect(response.status).toBe(200);
    return response;
  };
  const updates = (): Photo[] =>
    events.filter((e) => e.channel === 'photos:updated').map((e) => e.payload as Photo);

  it('marks edited photos stale until a render arrives', async () => {
    await develop({ Exposure2012: 0.5 });
    expect(photos.get(id)).toMatchObject({ previewStale: true });
    expect(photos.get(id).previewRevision).toBeUndefined();
  });

  it('stores the render beside the camera preview, bumps the revision and announces it', async () => {
    await develop({ Exposure2012: 0.5 });
    events = [];
    const photo = await send(10, 100);

    expect(photo.previewRevision).toBe(1);
    expect(photo.previewStale).toBe(false);
    expect(updates().map((p) => p.previewRevision)).toEqual([1]);

    const thumb = await served('thumb');
    const preview = await served('preview');
    expect(thumb.file).toBe(cache.editedPath('thumb', id));
    expect(await centreValue(thumb.file!)).toMatchObject({ width: 16, height: 16 });
    expect((await centreValue(preview.file!)).width).toBe(40);
    expect(Math.abs((await centreValue(preview.file!)).red - 100)).toBeLessThan(4);

    // The embedded previews are kept as they were, so reset can revert.
    expect((await readFile(cache.pathFor('thumb', id))).equals(originalThumb)).toBe(true);
    expect((await readFile(cache.pathFor('preview', id))).equals(originalPreview)).toBe(true);
  });

  it('ignores a render older than one already stored', async () => {
    await develop({ Exposure2012: 0.5 });
    await send(20, 100);
    const late = await send(19, 50);

    expect(late.previewRevision).toBe(1);
    expect(Math.abs((await centreValue(cache.editedPath('preview', id))).red - 100)).toBeLessThan(
      4,
    );
    // A newer one still lands.
    expect((await send(21, 150)).previewRevision).toBe(2);
  });

  it('refuses a render of a photo without edits', async () => {
    const photo = await send(1, 100);
    expect(photo.previewRevision).toBeUndefined();
    expect(await cache.has('thumb', id)).toBe(true);
    expect((await served('thumb')).file).toBe(cache.pathFor('thumb', id));
  });

  it('rejects images whose size does not match their pixels', async () => {
    await develop({ Exposure2012: 0.5 });
    await expect(
      edited.set({
        photoId: id,
        revision: 1,
        retouchOps: [],
        thumb: { width: 4, height: 4, rgba: new Uint8Array(3) },
        preview: flat(4, 4, 1),
      }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('reverts to the camera preview when all edits are removed, and drops a late render', async () => {
    await develop({ Exposure2012: 0.5 });
    await send(5, 100);
    events = [];

    const photo = await develop({}).then(() => photos.get(id));
    expect(photo.status.edited).toBe(false);
    expect(photo.previewStale).toBe(false);
    expect(photo.previewRevision).toBe(2);
    expect(updates().at(-1)?.previewRevision).toBe(2);
    expect((await served('thumb')).file).toBe(cache.pathFor('thumb', id));
    expect((await served('preview')).file).toBe(cache.pathFor('preview', id));
    expect(await cache.readEditedMeta(id)).toBeUndefined();

    // A render still in flight when the edits were removed must not bring them back.
    await send(6, 100);
    expect((await served('thumb')).file).toBe(cache.pathFor('thumb', id));
    expect(photos.get(id).previewRevision).toBe(2);
  });

  describe('privacy of retouched photos', () => {
    it('never serves the camera preview of a photo that has a retouch version', async () => {
      await retouch([mosaic(0.1)]);
      for (const kind of ['thumb', 'preview'] as const) {
        const response = await served(kind);
        expect(response.file).not.toBe(cache.pathFor(kind, id));
        expect(response.headers['cache-control']).toBe('no-store');
        expect(Math.abs((await centreValue(response.file!)).red - 128)).toBeLessThan(4);
      }
    });

    it('swaps a render made before the mosaic for the placeholder at once, and busts the cache', async () => {
      await develop({ Exposure2012: 0.5 });
      await send(1, 100);
      const before = photos.get(id).previewRevision;

      await retouch([mosaic(0.1)]);

      expect(photos.get(id).previewRevision).toBeGreaterThan(before!);
      for (const kind of ['thumb', 'preview'] as const) {
        const response = await served(kind);
        expect(response.file).not.toBe(cache.editedPath(kind, id));
        expect(response.file).not.toBe(cache.pathFor(kind, id));
      }
    });

    it('serves the render again once it includes the current mosaic, and not an older mosaic', async () => {
      await develop({ Exposure2012: 0.5 });
      await retouch([mosaic(0.1)]);

      // Drawn from other ops than the photo has now: refused.
      const refused = await send(2, 100, [mosaic(0.5)]);
      expect(refused.previewStale).toBe(true);
      expect((await served('thumb')).file).not.toBe(cache.editedPath('thumb', id));

      const accepted = await send(3, 100, [mosaic(0.1)]);
      expect(accepted.previewStale).toBe(false);
      expect((await served('thumb')).file).toBe(cache.editedPath('thumb', id));
      expect((await served('preview')).file).toBe(cache.editedPath('preview', id));

      // Moving the mosaic makes the old render unusable again.
      const version = photos.get(id).versions.find((v) => v.kind === 'retouch')!;
      await edits.setRetouch({ photoId: id, versionId: version.id, ops: [mosaic(0.4)] });
      expect((await served('thumb')).file).not.toBe(cache.editedPath('thumb', id));
    });
  });
});
