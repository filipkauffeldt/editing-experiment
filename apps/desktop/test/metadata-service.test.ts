// @vitest-environment node
import { asPhotoId, asSourceId, type IptcFields, type Photo } from '@ee/contracts';
import { ExifToolService, ensureXmpFile, readIptc, writeIptc } from '@ee/metadata';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MetadataService } from '../src/jobs/backend/metadata-service';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { SettingsStore } from '../src/jobs/backend/settings-store';
import { defaultSettings } from '../src/shared/settings';
import { copyMetadataFields } from '../src/renderer/metadata-fields';

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-metadata-service-'));
  dirs.push(dir);
  return dir;
};

const sha256 = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

const photoFor = (path: string, index: number): Photo => ({
  id: asPhotoId(`photo-${index}`),
  path,
  sidecarPath: path.replace(/\.NEF$/, '.xmp'),
  fileName: basename(path),
  sourceId: asSourceId('test-source'),
  status: {
    ingest: 'done',
    edited: false,
    metadataDiffersFromTemplate: false,
    export: 'none',
    upload: 'none',
  },
  tagged: false,
  colorClass: 0,
  rating: 0,
  versions: [],
});

describe('MetadataService paste and batch template', () => {
  let service: ExifToolService;
  let index: PhotoIndex | undefined;
  let library: PhotoLibrary;
  let metadata: MetadataService;

  beforeAll(() => {
    service = new ExifToolService();
  });

  afterAll(async () => {
    await service.close();
  });

  afterEach(async () => {
    index?.close();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const setup = async (count: number): Promise<Photo[]> => {
    const dir = await tempDir();
    index = new PhotoIndex(':memory:');
    library = new PhotoLibrary(index, () => {});
    metadata = new MetadataService(
      library,
      service,
      new SettingsStore(undefined, defaultSettings(dir)),
    );
    const photos: Photo[] = [];
    for (let number = 1; number <= count; number += 1) {
      const path = join(dir, `frame_${number}.NEF`);
      // The sidecar strategy is chosen by extension, so JPEG bytes stand in for a raw here.
      await sharp({ create: { width: 32, height: 24, channels: 3, background: '#468' } })
        .jpeg()
        .toFile(path);
      const photo = photoFor(path, number);
      library.add(photo);
      photos.push(photo);
    }
    return photos;
  };

  it('pastes only the copied fields into each raw sidecar and never writes the raw', async () => {
    const [source, firstTarget, secondTarget] = await setup(3);
    if (!source || !firstTarget || !secondTarget) throw new Error('missing photos');

    await metadata.write({
      photoId: source.id,
      fields: {
        headline: 'Copied headline',
        caption: 'Copied caption',
        keywords: ['pitch', 'final'],
        credit: 'Not copied',
      },
    });
    const initial: IptcFields = {
      headline: 'Old headline',
      caption: 'Old caption',
      city: 'Malmö',
      instructions: 'Keep me',
      dateCreated: '2024-05-06',
    };
    await metadata.write({ photoId: firstTarget.id, fields: initial });
    await metadata.write({ photoId: secondTarget.id, fields: initial });

    const sourceFields = await metadata.read(source.id);
    const copied = copyMetadataFields(sourceFields, ['headline', 'caption', 'keywords', 'city']);
    expect(copied).toEqual({
      headline: 'Copied headline',
      caption: 'Copied caption',
      keywords: ['pitch', 'final'],
      city: '',
    });

    const before = await Promise.all(
      [firstTarget.path, secondTarget.path].map((path) => sha256(path)),
    );
    const result = await metadata.writeFields({
      photoIds: [firstTarget.id, secondTarget.id],
      fields: copied,
    });
    expect(result).toEqual({ updated: [firstTarget.id, secondTarget.id], failed: [] });

    for (const target of [firstTarget, secondTarget]) {
      expect(await metadata.read(target.id)).toEqual({
        headline: 'Copied headline',
        caption: 'Copied caption',
        keywords: ['pitch', 'final'],
        instructions: 'Keep me',
        dateCreated: '2024-05-06',
      });
      expect(await readIptc(target.path, service)).toMatchObject({
        headline: 'Copied headline',
        keywords: ['pitch', 'final'],
      });
    }
    expect(
      await Promise.all([firstTarget.path, secondTarget.path].map((path) => sha256(path))),
    ).toEqual(before);
  });

  it('applies a chosen template to every selected photo', async () => {
    const [first, second, third] = await setup(3);
    if (!first || !second || !third) throw new Error('missing photos');
    const dir = await tempDir();
    const templatePath = join(dir, 'template.XMP');
    await ensureXmpFile(templatePath);
    await writeIptc(
      templatePath,
      { headline: 'Batch headline', city: 'Göteborg', keywords: ['batch'] },
      { service },
    );
    await metadata.write({
      photoId: third.id,
      fields: { instructions: 'Keep me', city: 'Malmö' },
    });

    const result = await metadata.applyTemplate({
      photoIds: [first.id, second.id, third.id],
      templatePath,
      mode: 'replace',
    });
    expect(result).toEqual({ updated: [first.id, second.id, third.id], failed: [] });

    for (const photoId of [first.id, second.id, third.id]) {
      expect(await metadata.read(photoId)).toMatchObject({
        headline: 'Batch headline',
        city: 'Göteborg',
        keywords: ['batch'],
      });
      expect(library.record(photoId).templatePath).toBe(templatePath);
      expect(library.get(photoId).status.metadataDiffersFromTemplate).toBe(false);
    }
    expect(await metadata.read(third.id)).toMatchObject({ instructions: 'Keep me' });
  });
});
