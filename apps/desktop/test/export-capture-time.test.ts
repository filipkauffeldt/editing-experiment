// @vitest-environment node
import {
  asPhotoId,
  asPresetId,
  asSourceId,
  type ExportMetadataMode,
  type ExportPreset,
  type Photo,
} from '@ee/contracts';
import { JobEventEmitter, type UploadQueue } from '@ee/export';
import { ExifToolService, toIsoDate, writeIptc } from '@ee/metadata';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExportService } from '../src/jobs/backend/export-service';
import { ExportedFileStore } from '../src/jobs/backend/exported-files';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { SettingsStore } from '../src/jobs/backend/settings-store';
import { defaultExportPreset, defaultSettings } from '../src/shared/settings';
import { fixtureNefs, sampleNefs } from './helpers/fixtures';

/** What a camera writes: a clock face, its fraction of a second and the clock's UTC offset. */
const CAMERA_TIME = {
  DateTimeOriginal: '2025:03:08 19:45:12',
  CreateDate: '2025:03:08 19:45:12',
  SubSecTimeOriginal: '47',
  SubSecTimeDigitized: '47',
  OffsetTimeOriginal: '+01:00',
  OffsetTimeDigitized: '+01:00',
};
/** The index's captureTime for a raw: LibRaw reads the clock face and no zone. */
const INDEXED_CAPTURE_TIME = '2025-03-08T19:45:12';

const rendered = { width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4).fill(180) };

describe('export keeps the camera time', () => {
  let root: string;
  let exiftool: ExifToolService;
  let library: PhotoLibrary;
  let service: ExportService;

  const preset = (metadata: ExportMetadataMode, overrides: Partial<ExportPreset> = {}) =>
    ({
      ...defaultExportPreset(),
      id: asPresetId('test'),
      name: 'Test',
      folderTemplate: join(root, 'exports'),
      fileNaming: 'rename',
      fileNameTemplate: '{filenamebase}',
      metadata,
      sendTo: [],
      ...overrides,
    }) satisfies ExportPreset;

  beforeAll(() => {
    exiftool = new ExifToolService();
  });
  afterAll(() => exiftool.close());

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-export-time-'));
    library = new PhotoLibrary(new PhotoIndex(':memory:'), () => {});
    service = new ExportService({
      photos: library,
      settings: new SettingsStore(undefined, defaultSettings(root)),
      exiftool,
      queue: { events: new JobEventEmitter() } as unknown as UploadQueue,
      exportedFiles: new ExportedFileStore(join(root, 'exported-files.json')),
      onEvent: () => {},
    });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  async function addPhoto(
    path: string,
    name: string,
    captureTime: string | undefined,
    sidecarPath = path,
  ): Promise<Photo> {
    const photo: Photo = {
      id: asPhotoId(name),
      path,
      sidecarPath,
      fileName: `${name}.jpg`,
      sourceId: asSourceId('s'),
      ...(captureTime === undefined ? {} : { captureTime }),
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
      versions: [],
    };
    library.add(photo);
    return photo;
  }

  /** A JPEG whose EXIF is known, standing in for a raw (the same tags live in a NEF's EXIF). */
  async function cameraJpeg(name: string, tags: Record<string, string> = CAMERA_TIME) {
    const path = join(root, `${name}.jpg`);
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#357' } })
      .jpeg()
      .toFile(path);
    await exiftool.write(path, { Make: 'Nikon', Model: 'Z 9', ...tags });
    return path;
  }

  /** The date tags of a file, as ExifTool prints them with -G1. */
  async function dateTags(path: string): Promise<Record<string, string>> {
    const tags = await exiftool.read(path);
    const wanted =
      /^(ExifIFD|IFD0|XMP-[a-z]+|IPTC|Composite):(DateTimeOriginal|CreateDate|ModifyDate|MetadataDate|DateCreated|TimeCreated|SubSec\w+|OffsetTime\w*|DigitalCreationDate)$/;
    return Object.fromEntries(
      Object.entries(tags)
        .filter(([key]) => wanted.test(key))
        .map(([key, value]) => [key, String(value)]),
    );
  }

  describe('the embedded date', () => {
    it('copies the dates, sub-seconds and zone, and writes no ModifyDate or XMP date', async () => {
      const source = await cameraJpeg('burst');
      await writeIptc(
        source,
        { headline: 'Cup final', credit: 'Sportfotografen' },
        { service: exiftool },
      );
      const photo = await addPhoto(source, 'burst', INDEXED_CAPTURE_TIME);

      const out = await service.exportOne({ photoId: photo.id, preset: preset('all'), rendered });

      const tags = await dateTags(out.path);
      expect(tags['ExifIFD:DateTimeOriginal']).toBe('2025-03-08T19:45:12');
      expect(tags['ExifIFD:CreateDate']).toBe('2025-03-08T19:45:12');
      expect(tags['ExifIFD:SubSecTimeOriginal']).toBe('47');
      expect(tags['ExifIFD:SubSecTimeDigitized']).toBe('47');
      expect(tags['ExifIFD:OffsetTimeOriginal']).toBe('+01:00');
      expect(tags['ExifIFD:OffsetTimeDigitized']).toBe('+01:00');
      expect(tags['Composite:SubSecDateTimeOriginal']).toBe('2025-03-08T19:45:12.470+01:00');
      // The IPTC creation date is the capture date too (it comes from the original), and nothing
      // names the export time as a modification or metadata date.
      expect(tags['XMP-photoshop:DateCreated']).toBe('2025-03-08T19:45:12');
      expect(Object.keys(tags).filter((key) => /ModifyDate|MetadataDate/.test(key))).toEqual([]);
    });

    it('keeps a leading zero in the sub-seconds, which 07 and 7 would otherwise swap', async () => {
      const source = await cameraJpeg('zero', {
        ...CAMERA_TIME,
        SubSecTimeOriginal: '07',
        SubSecTimeDigitized: '07',
      });
      const photo = await addPhoto(source, 'zero', INDEXED_CAPTURE_TIME);

      const out = await service.exportOne({ photoId: photo.id, preset: preset('all'), rendered });

      expect((await dateTags(out.path))['Composite:SubSecDateTimeOriginal']).toBe(
        '2025-03-08T19:45:12.070+01:00',
      );
    });

    it('is the same for a cropped render and for either edit version', async () => {
      const source = await cameraJpeg('versions');
      const photo = await addPhoto(source, 'versions', INDEXED_CAPTURE_TIME);
      const baseline = await dateTags(
        (await service.exportOne({ photoId: photo.id, preset: preset('all'), rendered })).path,
      );

      const cropped = { width: 6, height: 4, rgba: new Uint8Array(6 * 4 * 4).fill(90) };
      for (const version of ['develop', 'top'] as const) {
        const out = await service.exportOne({
          photoId: photo.id,
          preset: preset('all', { version, fileNameTemplate: `{filenamebase}-${version}` }),
          rendered: cropped,
        });
        expect(await dateTags(out.path)).toEqual(baseline);
      }
    });

    it('writes no EXIF date on the modes that document no camera EXIF', async () => {
      const source = await cameraJpeg('lean');
      const photo = await addPhoto(source, 'lean', INDEXED_CAPTURE_TIME);

      for (const mode of ['iptc', 'copyright', 'none'] as const) {
        const out = await service.exportOne({
          photoId: photo.id,
          preset: preset(mode, { fileNameTemplate: `lean-${mode}` }),
          rendered,
        });
        const tags = await dateTags(out.path);
        expect(Object.keys(tags).filter((key) => /^(ExifIFD|IFD0):/.test(key))).toEqual([]);
        expect(Object.keys(tags).filter((key) => /ModifyDate|MetadataDate/.test(key))).toEqual([]);
        // `iptc` still says when the picture was made, from the original; the other two say nothing.
        expect(tags['XMP-photoshop:DateCreated']).toBe(
          mode === 'iptc' ? '2025-03-08T19:45:12' : undefined,
        );
      }
    });

    it('fails the export when the dates cannot be copied, and leaves no file', async () => {
      // A raw path with no file: reading its (absent) sidecar is fine, copying from it is not.
      const photo = await addPhoto(join(root, 'gone.NEF'), 'gone', INDEXED_CAPTURE_TIME);

      await expect(
        service.exportOne({ photoId: photo.id, preset: preset('all'), rendered }),
      ).rejects.toThrow();
      expect(library.get(photo.id).status.export).toBe('failed');
      await expect(stat(join(root, 'exports', 'gone.jpg'))).rejects.toThrow();
    });

    it('survives an overwrite of an earlier export', async () => {
      const source = await cameraJpeg('again');
      const photo = await addPhoto(source, 'again', INDEXED_CAPTURE_TIME);
      const overwrite = preset('all', { ifExists: 'overwrite' });
      await service.exportOne({ photoId: photo.id, preset: overwrite, rendered });

      const out = await service.exportOne({ photoId: photo.id, preset: overwrite, rendered });

      expect(out.path).toBe(join(root, 'exports', 'again.jpg'));
      expect((await dateTags(out.path))['ExifIFD:DateTimeOriginal']).toBe('2025-03-08T19:45:12');
    });
  });

  describe('a real camera raw', () => {
    const nef = sampleNefs()[0] ?? fixtureNefs()[0];

    it.skipIf(nef === undefined)(
      'exports the raw’s own capture date, sub-seconds and zone',
      async () => {
        // A copy: the sample folder is never written to, not even with a sidecar.
        const raw = join(root, 'camera.NEF');
        await copyFile(nef!, raw);
        const original = await exiftool.read(raw);
        const captureTime = toIsoDate(original['ExifIFD:DateTimeOriginal']);
        const photo = await addPhoto(raw, 'camera', captureTime, join(root, 'camera.xmp'));

        const out = await service.exportOne({ photoId: photo.id, preset: preset('all'), rendered });

        const exported = await dateTags(out.path);
        const camera = await dateTags(raw);
        for (const tag of [
          'ExifIFD:DateTimeOriginal',
          'ExifIFD:CreateDate',
          'ExifIFD:SubSecTimeOriginal',
          'ExifIFD:SubSecTimeDigitized',
          'ExifIFD:OffsetTimeOriginal',
          'ExifIFD:OffsetTimeDigitized',
          'Composite:SubSecDateTimeOriginal',
        ]) {
          expect(exported[tag], tag).toBeDefined();
          expect(exported[tag], tag).toBe(camera[tag]);
        }
        expect(exported['IFD0:ModifyDate']).toBeUndefined();
      },
      60_000,
    );
  });
});
