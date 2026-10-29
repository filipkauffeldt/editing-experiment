// @vitest-environment node
import {
  LINEAR_IMAGE_HEADER,
  appUrl,
  asPhotoId,
  asSourceId,
  type LinearImageHeader,
} from '@ee/contracts';
import { ExifToolService, readLensShot } from '@ee/metadata';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppResources } from '../src/jobs/backend/app-resources';
import { developVersionId } from '../src/jobs/backend/edit-service';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { PreviewCache } from '../src/jobs/backend/previews';
import { fixtureNefs } from './helpers/fixtures';

const nef = fixtureNefs().find((file) => file.endsWith('z6ii_CZP_0299.NEF'));

describe.skipIf(nef === undefined)('lens data in the linear image header', () => {
  const exiftool = new ExifToolService();
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-lens-header-'));
  });
  afterAll(async () => {
    await exiftool.close();
    await rm(root, { recursive: true, force: true });
  });

  async function serve(withLens: boolean): Promise<LinearImageHeader> {
    const id = asPhotoId('p1');
    const dir = await mkdtemp(join(root, 'case-'));
    await mkdir(join(dir, 'cache'));
    const path = join(dir, 'shot.NEF');
    await copyFile(nef!, path);
    const photos = new PhotoLibrary(new PhotoIndex(':memory:'), () => {});
    photos.add({
      id,
      path,
      sidecarPath: path,
      fileName: 'shot.NEF',
      width: 6048,
      height: 4024,
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
    const apps = new AppResources({
      photos,
      previews: new PreviewCache(join(dir, 'cache', 'thumb'), join(dir, 'cache', 'preview')),
      linearDir: join(dir, 'cache', 'linear'),
      ...(withLens ? { lensShot: (p, frame) => readLensShot(p, frame, exiftool) } : {}),
      // The decoder is not under test; the header is what a 2560 px decode of this NEF reports.
      decode: async () => ({
        header: {
          width: 2560,
          height: 1705,
          sourceWidth: 6048,
          sourceHeight: 4024,
          sampleType: 'f16',
          asShotMultipliers: { r: 1, g: 1, b: 1 },
          cameraToSrgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          xyzToCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        },
        data: Buffer.alloc(16),
      }),
    });
    await apps.init();
    const response = await apps.resolve(appUrl.linear(id, 2560));
    expect(response.status).toBe(200);
    return JSON.parse(response.headers?.[LINEAR_IMAGE_HEADER] ?? '{}') as LinearImageHeader;
  }

  it('carries the lens and the camera’s own correction of a raw', async () => {
    const header = await serve(true);
    expect(header.lens?.lensModel).toBe('NIKKOR Z 24-200mm f/4-6.3 VR');
    expect(header.lens?.focalLength).toBe(70);
    expect(header.lens?.builtin?.required).toBe(true);
    expect(header.lens?.builtin?.distortion?.length).toBe(5);
  });

  it('serves a header without lens data when none is wired', async () => {
    expect((await serve(false)).lens).toBeUndefined();
  });
});
