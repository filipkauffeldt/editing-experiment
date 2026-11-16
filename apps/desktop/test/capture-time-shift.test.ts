// @vitest-environment node
import {
  asPhotoId,
  asPresetId,
  asSourceId,
  type IngestConfig,
  type IpcHandlers,
  type Photo,
} from '@ee/contracts';
import { JobEventEmitter, type UploadQueue } from '@ee/export';
import {
  ExifToolService,
  readCaptureTime,
  readIptc,
  shiftCaptureTime as shiftOnDisk,
  shiftCaptureTimeValue,
  sidecarPathFor,
  toIsoDate,
} from '@ee/metadata';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackend, type Backend } from '../src/jobs/backend/backend';
import { ExportService } from '../src/jobs/backend/export-service';
import { ExportedFileStore } from '../src/jobs/backend/exported-files';
import { userDataLayout } from '../src/jobs/backend/layout';
import { MetadataService } from '../src/jobs/backend/metadata-service';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { SettingsStore } from '../src/jobs/backend/settings-store';
import { initialFilter } from '../src/renderer/filters';
import { selectVisiblePhotos, type AppState } from '../src/renderer/store';
import { defaultExportPreset, defaultSettings } from '../src/shared/settings';
import { fixtureNefs, sampleNefs } from './helpers/fixtures';

const rendered = { width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4).fill(180) };
const sha256 = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

const DATE_TAGS =
  /^(ExifIFD|IFD0|XMP-[a-z]+|IPTC|Composite):(DateTimeOriginal|CreateDate|ModifyDate|MetadataDate|DateCreated|TimeCreated|SubSec\w+|OffsetTime\w*|DigitalCreationDate)$/;

const dateTags = (tags: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags)
      .filter(([key]) => DATE_TAGS.test(key))
      .map(([key, value]) => [key, String(value)]),
  );

async function makeJpeg(path: string, tags: Record<string, string>): Promise<void> {
  await sharp({ create: { width: 24, height: 16, channels: 3, background: '#357' } })
    .jpeg()
    .toFile(path);
  await exiftool.write(path, tags);
}

/** What a camera writes: a clock face, its fraction of a second and the clock's UTC offset. */
const CAMERA_TAGS = {
  'EXIF:DateTimeOriginal': '2026:10:03 18:13:16',
  'EXIF:CreateDate': '2026:10:03 18:13:16',
  'EXIF:SubSecTimeOriginal': '31',
  'EXIF:SubSecTimeDigitized': '31',
  'EXIF:OffsetTimeOriginal': '+02:00',
  'EXIF:OffsetTimeDigitized': '+02:00',
  'XMP-exif:DateTimeOriginal': '2026-10-03T18:13:16.310+02:00',
  'XMP-xmp:CreateDate': '2026-10-03T18:13:16.310+02:00',
  'XMP-photoshop:DateCreated': '2026-10-03T18:13:16.310+02:00',
  'IPTC:DateCreated': '20261003',
  'IPTC:TimeCreated': '18:13:16+02:00',
};

const exiftool = new ExifToolService();
const roots: string[] = [];

afterAll(() => exiftool.close());

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function addPhoto(
  library: PhotoLibrary,
  path: string,
  options: { fileName?: string; captureTime?: string; sidecarPath?: string } = {},
): Photo {
  const fileName = options.fileName ?? path.split(/[\\/]/).pop() ?? path;
  const photo: Photo = {
    id: asPhotoId(`${fileName}-${Math.random().toString(36).slice(2)}`),
    path,
    sidecarPath: options.sidecarPath ?? path,
    fileName,
    ...(options.captureTime === undefined ? {} : { captureTime: options.captureTime }),
    sourceId: asSourceId('test'),
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

const visible = (photos: Photo[]): string[] =>
  selectVisiblePhotos({
    photos,
    filter: initialFilter(),
    sort: 'capture-time',
  } as AppState).map((photo) => photo.fileName);

describe('shifting the capture time', () => {
  let root: string;
  let library: PhotoLibrary;
  let metadata: MetadataService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-shift-'));
    roots.push(root);
    library = new PhotoLibrary(new PhotoIndex(':memory:'), () => {});
    metadata = new MetadataService(
      library,
      exiftool,
      new SettingsStore(undefined, defaultSettings(root)),
    );
  });

  it('moves the index, sidecar and caption variables together and never writes the raw', async () => {
    const source = sampleNefs()[0] ?? fixtureNefs()[0];
    if (source === undefined) return;
    const raw = join(root, 'shift.NEF');
    await copyFile(source, raw);
    const beforeHash = await sha256(raw);
    const captureTime = await readCaptureTime(raw, exiftool);
    expect(captureTime).toBeDefined();
    const photo = addPhoto(library, raw, {
      fileName: 'shift.NEF',
      captureTime,
      sidecarPath: sidecarPathFor(raw),
    });
    const updates: Photo[] = [];
    library = new PhotoLibrary(new PhotoIndex(':memory:'), (channel, payload) => {
      if (channel === 'photos:updated') updates.push(payload as Photo);
    });
    metadata = new MetadataService(
      library,
      exiftool,
      new SettingsStore(undefined, defaultSettings(root)),
    );
    library.add(photo);

    const result = await metadata.shiftCaptureTime({ photoIds: [photo.id], offsetSeconds: -133 });

    expect(result.failed).toEqual([]);
    expect(result.noCaptureTime).toEqual([]);
    expect(result.updated).toHaveLength(1);
    const shifted = result.updated[0]!;
    expect(shifted.photo.captureTime).toBe(shiftCaptureTimeValue(captureTime!, -133));
    expect(library.get(photo.id).captureTime).toBe(shifted.photo.captureTime);
    expect(updates.map((update) => update.captureTime)).toEqual([shifted.photo.captureTime]);
    expect(await sha256(raw)).toBe(beforeHash);

    const sidecar = await exiftool.read(sidecarPathFor(raw));
    expect(toIsoDate(sidecar['XMP-exif:DateTimeOriginal'])).toBe(shifted.photo.captureTime);
    expect(toIsoDate(sidecar['XMP-xmp:CreateDate'])).toBe(shifted.photo.captureTime);
    expect(toIsoDate(sidecar['XMP-photoshop:DateCreated'])).toBe(shifted.dateCreated);
    expect(await readCaptureTime(raw, exiftool)).toBe(shifted.photo.captureTime);
    const caption = await metadata.expandCaption({
      photoId: photo.id,
      text: '{date} {time}',
    });
    expect(caption.text).toBe(
      `${shifted.photo.captureTime!.slice(0, 10)} ${shifted.photo.captureTime!.slice(11, 19)}`,
    );
    const back = await metadata.shiftCaptureTime({ photoIds: [photo.id], offsetSeconds: 133 });
    expect(back.updated[0]!.photo.captureTime).toBe(captureTime);
  });

  it('updates the sort order at once and keeps a photo without a time last', async () => {
    const times = ['2026-10-03T18:10:00', '2026-10-03T18:11:00', '2026-10-03T18:12:00'];
    const photos = await Promise.all(
      times.map(async (time, index) => {
        const path = join(root, `sort-${index}.jpg`);
        const clock = time.replace('T', ' ').replaceAll('-', ':');
        await makeJpeg(path, {
          'EXIF:DateTimeOriginal': clock,
          'EXIF:CreateDate': clock,
        });
        return addPhoto(library, path, { captureTime: time, fileName: `sort-${index}.jpg` });
      }),
    );
    const noTime = addPhoto(library, join(root, 'no-time.jpg'), { fileName: 'no-time.jpg' });
    expect(visible(library.list())).toEqual([
      'sort-0.jpg',
      'sort-1.jpg',
      'sort-2.jpg',
      'no-time.jpg',
    ]);

    await metadata.shiftCaptureTime({ photoIds: [photos[0]!.id], offsetSeconds: 300 });

    expect(library.get(photos[0]!.id).captureTime).toBe(shiftCaptureTimeValue(times[0]!, 300));
    expect(visible(library.list())).toEqual([
      'sort-1.jpg',
      'sort-2.jpg',
      'sort-0.jpg',
      'no-time.jpg',
    ]);
    expect(library.get(noTime.id).captureTime).toBeUndefined();
  });

  it('reports photos with no capture time and a failed photo, and still writes the rest', async () => {
    const good = join(root, 'good.jpg');
    await makeJpeg(good, CAMERA_TAGS);
    const goodPhoto = addPhoto(library, good, {
      fileName: 'good.jpg',
      captureTime: '2026-10-03T18:13:16',
    });
    const noTime = join(root, 'no-time.jpg');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#333' } })
      .jpeg()
      .toFile(noTime);
    const noTimePhoto = addPhoto(library, noTime, { fileName: 'no-time.jpg' });
    const missing = addPhoto(library, join(root, 'missing.jpg'), {
      fileName: 'missing.jpg',
      captureTime: '2026-10-03T18:13:16',
    });

    const result = await metadata.shiftCaptureTime({
      photoIds: [goodPhoto.id, noTimePhoto.id, missing.id],
      offsetSeconds: 60,
    });

    expect(result.updated.map((entry) => entry.photo.id)).toEqual([goodPhoto.id]);
    expect(result.noCaptureTime).toEqual([noTimePhoto.id]);
    expect(result.failed.map((entry) => entry.photoId)).toEqual([missing.id]);
    expect(result.failed[0]!.message).toContain('missing.jpg');
    expect(library.get(goodPhoto.id).captureTime).toBe('2026-10-03T18:14:16');
    expect(library.get(noTimePhoto.id).captureTime).toBeUndefined();
    expect(await readIptc(good, exiftool)).toMatchObject({
      dateCreated: '2026-10-03T18:14:16.310+02:00',
    });
  });
});

describe('exporting a shifted raw', () => {
  let root: string;
  let library: PhotoLibrary;
  let exporter: ExportService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-shift-export-'));
    roots.push(root);
    library = new PhotoLibrary(new PhotoIndex(':memory:'), () => {});
    exporter = new ExportService({
      photos: library,
      settings: new SettingsStore(undefined, defaultSettings(root)),
      exiftool,
      queue: { events: new JobEventEmitter() } as unknown as UploadQueue,
      exportedFiles: new ExportedFileStore(join(root, 'exported-files.json')),
      onEvent: () => {},
      warn: () => {},
    });
  });

  it('carries the shifted time with the original sub-seconds and offset', async () => {
    const source = sampleNefs()[0] ?? fixtureNefs()[0];
    if (source === undefined) return;
    const raw = join(root, 'camera.NEF');
    await copyFile(source, raw);
    const original = await exiftool.read(raw);
    const captureTime = await readCaptureTime(raw, exiftool);
    expect(captureTime).toBeDefined();
    const shift = await shiftOnDisk(raw, 133, { service: exiftool });
    expect(shift).toBeDefined();
    const photo = addPhoto(library, raw, {
      fileName: 'camera.NEF',
      captureTime: shift!.after,
      sidecarPath: sidecarPathFor(raw),
    });
    const preset = {
      ...defaultExportPreset(),
      id: asPresetId('shift'),
      name: 'Shift',
      folderTemplate: join(root, 'exports'),
      fileNaming: 'rename' as const,
      fileNameTemplate: '{filenamebase}',
      metadata: 'all' as const,
      sendTo: [],
    };
    const target = await exporter.previewTarget({
      photoId: photo.id,
      preset: { ...preset, fileNameTemplate: '{datesort}_{timesort}' },
    });
    expect(target.fileName).toBe(
      `${shift!.after.slice(0, 10).replaceAll('-', '')}_${shift!.after.slice(11, 19).replaceAll(':', '')}.jpg`,
    );

    const out = await exporter.exportOne({ photoId: photo.id, preset, rendered });

    const tags = await exiftool.read(out.path);
    expect(toIsoDate(tags['ExifIFD:DateTimeOriginal'])).toBe(shift!.after);
    expect(toIsoDate(tags['ExifIFD:CreateDate'])).toBe(shift!.after);
    expect(tags['XMP-exif:DateTimeOriginal']).toBeUndefined();
    expect(tags['XMP-xmp:CreateDate']).toBeUndefined();
    expect(toIsoDate(tags['XMP-photoshop:DateCreated'])).toBe(shift!.dateCreated);
    expect(tags['ExifIFD:SubSecTimeOriginal']).toBe(original['ExifIFD:SubSecTimeOriginal']);
    expect(tags['ExifIFD:SubSecTimeDigitized']).toBe(original['ExifIFD:SubSecTimeDigitized']);
    expect(tags['ExifIFD:OffsetTimeOriginal']).toBe(original['ExifIFD:OffsetTimeOriginal']);
    expect(tags['ExifIFD:OffsetTimeDigitized']).toBe(original['ExifIFD:OffsetTimeDigitized']);
    const offset = tags['ExifIFD:OffsetTimeOriginal'];
    expect((await stat(out.path)).mtimeMs).toBe(
      Date.parse(`${shift!.after}${typeof offset === 'string' ? offset : ''}`),
    );
  });

  it('leaves an unshifted export with the date tags it had before', async () => {
    const source = sampleNefs()[0] ?? fixtureNefs()[0];
    if (source === undefined) return;
    const raw = join(root, 'plain.NEF');
    await copyFile(source, raw);
    const original = await exiftool.read(raw);
    const captureTime = await readCaptureTime(raw, exiftool);
    expect(captureTime).toBeDefined();
    const photo = addPhoto(library, raw, {
      fileName: 'plain.NEF',
      captureTime,
      sidecarPath: sidecarPathFor(raw),
    });
    const preset = {
      ...defaultExportPreset(),
      id: asPresetId('plain'),
      name: 'Plain',
      folderTemplate: join(root, 'exports'),
      fileNaming: 'rename' as const,
      fileNameTemplate: '{filenamebase}',
      metadata: 'all' as const,
      sendTo: [],
    };

    const out = await exporter.exportOne({ photoId: photo.id, preset, rendered });

    const copiedKeys = [
      'ExifIFD:DateTimeOriginal',
      'ExifIFD:CreateDate',
      'ExifIFD:SubSecTimeOriginal',
      'ExifIFD:SubSecTimeDigitized',
      'ExifIFD:OffsetTimeOriginal',
      'ExifIFD:OffsetTimeDigitized',
      'Composite:SubSecDateTimeOriginal',
      'Composite:SubSecCreateDate',
    ];
    const expected = Object.fromEntries(
      copiedKeys
        .filter((key) => original[key] !== undefined)
        .map((key) => [key, String(original[key])]),
    );
    expect(dateTags(await exiftool.read(out.path))).toEqual(expected);
  });
});

describe('a rebuilt index', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-shift-rebuild-'));
    roots.push(root);
  });

  const until = async <T>(
    what: string,
    probe: () => Promise<T | undefined | false> | T | undefined | false,
    timeoutMs = 60_000,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  it('reads the shifted time from the sidecar after the index is lost', async () => {
    const source = sampleNefs()[0] ?? fixtureNefs()[0];
    if (source === undefined) return;
    const sourceDir = join(root, 'source');
    const destination = join(root, 'destination');
    const userData = join(root, 'userdata');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(destination, { recursive: true });
    await copyFile(source, join(sourceDir, 'night.NEF'));

    const events: { channel: string; payload: unknown }[] = [];
    const emit = (channel: string, payload: unknown): void => {
      events.push({ channel, payload });
    };
    const start = async (
      userDataDir: string,
    ): Promise<{ backend: Backend; handlers: IpcHandlers }> => {
      const backend = await createBackend({
        userDataDir,
        appVersion: 'test',
        emit,
        getSecret: async () => ({}),
      });
      return { backend, handlers: backend.handlers as IpcHandlers };
    };

    let first: { backend: Backend; handlers: IpcHandlers } | undefined;
    let second: { backend: Backend; handlers: IpcHandlers } | undefined;
    try {
      first = await start(userData);
      const { ingest } = await first.handlers['settings:get']();
      await first.handlers['settings:set']({
        ingest: {
          ...ingest,
          destination: { path: destination },
          fileNaming: 'keep',
          renameTemplate: '{filenamebase}',
        },
      });
      const config: IngestConfig = {
        ...ingest,
        sources: [{ id: asSourceId('source'), name: 'source', kind: 'folder', path: sourceDir }],
        destination: { path: destination },
        fileNaming: 'keep',
        renameTemplate: '{filenamebase}',
      };
      await first.handlers['ingest:start']({ config });
      const ingested = await until('the raw to be ingested', async () => {
        const photos = await first!.handlers['photos:list']();
        return photos.length === 1 ? photos[0] : undefined;
      });
      expect(ingested.captureTime).toBeDefined();

      const shifted = await first.handlers['photos:shiftCaptureTime']({
        photoIds: [ingested.id],
        offsetSeconds: 133,
      });
      expect(shifted.updated).toHaveLength(1);
      const expected = shifted.updated[0]!.photo.captureTime;
      await first.backend.dispose();
      first = undefined;
      expect(await readCaptureTime(join(destination, 'night.NEF'), exiftool)).toBe(expected);

      // Lose the index but keep the settings and the files: the startup scan rebuilds it.
      const rebuiltUserData = join(root, 'userdata-rebuilt');
      await cp(userData, rebuiltUserData, { recursive: true });
      const layout = userDataLayout(rebuiltUserData);
      for (const file of [layout.indexDb, `${layout.indexDb}-wal`, `${layout.indexDb}-shm`]) {
        await rm(file, { force: true });
      }
      events.length = 0;
      second = await start(rebuiltUserData);
      const rebuilt = await until('the rebuilt index to list the photo', async () => {
        const photos = await second!.handlers['photos:list']();
        return photos.length === 1 ? photos[0] : undefined;
      });
      expect(rebuilt.captureTime).toBe(expected);
    } finally {
      await first?.backend.dispose();
      await second?.backend.dispose();
    }
  }, 120_000);
});
