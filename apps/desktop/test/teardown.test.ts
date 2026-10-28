// @vitest-environment node
import { asPhotoId } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { FaceService } from '../src/jobs/backend/faces';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { runTeardown } from '../src/jobs/backend/teardown';
import { faceJpeg, hasFaceFixtures } from './helpers/fixtures';
import { asSourceId, type Photo } from '@ee/contracts';
import { join } from 'node:path';
import { repoRoot } from './helpers/fixtures';

describe('runTeardown', () => {
  it('runs every step in order even when earlier ones fail, then reports all failures', async () => {
    const ran: string[] = [];
    const result = runTeardown([
      { name: 'queue', run: () => (ran.push('queue'), Promise.reject(new Error('stuck'))) },
      { name: 'exiftool', run: () => void ran.push('exiftool') },
      {
        name: 'index',
        run: () => {
          ran.push('index');
          throw new Error('locked');
        },
      },
      { name: 'seen', run: async () => void ran.push('seen') },
    ]);
    await expect(result).rejects.toThrowError(/queue: stuck; index: locked/);
    expect(ran).toEqual(['queue', 'exiftool', 'index', 'seen']);
  });

  it('resolves when all steps succeed', async () => {
    await expect(runTeardown([{ name: 'a', run: () => {} }])).resolves.toBeUndefined();
  });
});

describe('FaceService.dispose', () => {
  it('refuses new detections afterwards', async () => {
    const photos = new PhotoLibrary(new PhotoIndex(':memory:'), () => {});
    const faces = new FaceService(photos, undefined);
    // Without a model a detection fails for that reason...
    await expect(faces.detect({ photoId: asPhotoId('x') })).rejects.toMatchObject({
      code: 'not_found',
    });
    await faces.dispose();
    // ...and after dispose it fails because of the shutdown.
    await expect(faces.detect({ photoId: asPhotoId('x') })).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it.skipIf(!hasFaceFixtures())('waits for a running detection before resolving', async () => {
    const photos = new PhotoLibrary(new PhotoIndex(':memory:'), () => {});
    const id = asPhotoId('face');
    photos.add({
      id,
      path: faceJpeg,
      sidecarPath: faceJpeg,
      fileName: 'apollo.jpg',
      sourceId: asSourceId('s'),
      status: {
        ingest: 'done',
        edited: false,
        metadataDiffersFromTemplate: false,
        export: 'none',
        upload: 'none',
      },
      versions: [],
    } satisfies Photo);
    const model = join(repoRoot, 'fixtures', 'models', 'face_detection_yunet_2026may.onnx');
    const faces = new FaceService(photos, model);

    let settled = false;
    const detection = faces.detect({ photoId: id }).then((result) => ((settled = true), result));
    await faces.dispose();
    // dispose only resolved after the detection did.
    expect(settled).toBe(true);
    expect((await detection).length).toBeGreaterThan(0);
  });
});
