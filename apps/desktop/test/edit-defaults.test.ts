// @vitest-environment node
import { asPhotoId, asSourceId, type Photo } from '@ee/contracts';
import { ExifToolService, sidecarPathFor } from '@ee/metadata';
import { copyFile, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { developVersionId, EditService } from '../src/jobs/backend/edit-service';
import { EditedPreviews } from '../src/jobs/backend/edited-previews';
import { PreviewCache } from '../src/jobs/backend/previews';
import { fixtureNefs } from './helpers/fixtures';

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );
const sha = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

/** `develop:getDefaults`: what a raw starts with, read from the file and never written back. */
describe('develop defaults of a photo (jobs side)', () => {
  const exiftool = new ExifToolService();
  let root: string;
  let edits: EditService;
  let photos: PhotoLibrary;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-edit-defaults-'));
    photos = new PhotoLibrary(new PhotoIndex(':memory:'), () => {});
    const cache = new PreviewCache(join(root, 'thumb'), join(root, 'preview'));
    edits = new EditService(photos, exiftool, new EditedPreviews(photos, cache));
  });
  afterAll(async () => {
    await exiftool.close();
    await rm(root, { recursive: true, force: true });
  });

  function addPhoto(id: string, path: string): ReturnType<typeof asPhotoId> {
    const photoId = asPhotoId(id);
    const photo: Photo = {
      id: photoId,
      path,
      sidecarPath: sidecarPathFor(path),
      fileName: basename(path),
      sourceId: asSourceId('s'),
      tagged: false,
      colorClass: 0,
      rating: 0,
      status: {
        ingest: 'done',
        edited: false,
        metadataDiffersFromTemplate: false,
        export: 'none',
        upload: 'none',
      },
      versions: [{ id: developVersionId(photoId), kind: 'develop', ops: {} }],
    };
    photos.add(photo);
    return photoId;
  }

  it('is empty for a JPEG', async () => {
    const jpeg = join(root, 'photo.jpg');
    await writeFile(jpeg, Buffer.from('not decoded here'));
    expect(await edits.getDefaults(addPhoto('jpeg', jpeg))).toEqual({});
  });

  it('is Lightroom’s raw sharpening and colour noise reduction for a raw without camera defaults', async () => {
    const raw = join(root, 'plain.NEF');
    await writeFile(raw, Buffer.from('not a real raw'));
    expect(await edits.getDefaults(addPhoto('plain', raw))).toMatchObject({
      Sharpness: 40,
      SharpenRadius: 1,
      SharpenDetail: 25,
      ColorNoiseReduction: 25,
    });
  });

  it('takes the camera’s crd: values from a real NEF, without writing anything', async () => {
    const [fixture] = fixtureNefs().filter((path) => basename(path).startsWith('z6ii'));
    if (!fixture) return;
    const nef = join(root, basename(fixture));
    await copyFile(fixture, nef);
    const before = await sha(nef);
    const id = addPhoto('nef', nef);
    expect(await edits.getDefaults(id)).toMatchObject({ Sharpness: 136, SharpenRadius: 2 });
    // The defaults are not edits: no sidecar, the NEF untouched, and the photo reads as unedited.
    expect(await sha(nef)).toBe(before);
    expect(await exists(sidecarPathFor(nef))).toBe(false);
    expect(await edits.getParams({ photoId: id })).toEqual({});
  });
});
