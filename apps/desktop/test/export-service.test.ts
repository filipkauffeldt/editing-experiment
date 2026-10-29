// @vitest-environment node
import {
  asDestinationId,
  asPhotoId,
  asPresetId,
  asSourceId,
  asUploadId,
  type Destination,
  type ExportPreset,
  type Photo,
  type PhotoId,
  type UploadItem,
} from '@ee/contracts';
import { JobEventEmitter, type UploadQueue } from '@ee/export';
import { ExifToolService, readIptc } from '@ee/metadata';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExportService } from '../src/jobs/backend/export-service';
import { ExportedFileStore } from '../src/jobs/backend/exported-files';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { SettingsStore } from '../src/jobs/backend/settings-store';
import { defaultExportPreset, defaultSettings } from '../src/shared/settings';

/** Just enough of the queue: items appear queued and the test moves them along. */
class FakeQueue {
  readonly events = new JobEventEmitter();
  items: UploadItem[] = [];
  private next = 1;

  async enqueue(photoId: PhotoId, localPath: string, destinations: Destination[]) {
    const created = destinations.map((destination): UploadItem => ({
      id: asUploadId(`u${this.next++}`),
      photoId,
      destinationId: destination.id,
      localPath,
      remotePath: `/${photoId}.jpg`,
      state: 'queued',
      bytesSent: 0,
      bytesTotal: 1,
      attempts: 0,
    }));
    this.items.push(...created);
    for (const item of created) this.setState(item.id, 'queued');
    return created;
  }

  list(): UploadItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  setState(id: string, state: UploadItem['state']): void {
    const item = this.items.find((candidate) => candidate.id === id)!;
    item.state = state;
    this.events.emit({
      type: 'upload.state',
      at: Date.now(),
      uploadId: item.id,
      photoId: item.photoId,
      destinationId: item.destinationId,
      state,
    });
  }
}

describe('ExportService', () => {
  let root: string;
  let exiftool: ExifToolService;
  let library: PhotoLibrary;
  let queue: FakeQueue;
  let service: ExportService;
  const destination: Destination = {
    id: asDestinationId('desk'),
    name: 'Desk',
    kind: 'folder',
    path: '/unused',
    remotePathTemplate: '{fileName}',
  };
  const rendered = { width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4).fill(180) };
  const preset = (overrides: Partial<ExportPreset> = {}): ExportPreset => ({
    ...defaultExportPreset(),
    id: asPresetId('test'),
    name: 'Test',
    folderTemplate: join(root, 'exports'),
    fileNameTemplate: '{filenamebase}',
    metadata: 'iptc',
    sendTo: [destination.id],
    ...overrides,
  });

  beforeAll(() => {
    exiftool = new ExifToolService();
  });
  afterAll(() => exiftool.close());

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-export-svc-'));
    library = new PhotoLibrary(new PhotoIndex(':memory:'), () => {});
    const settings = new SettingsStore(undefined, defaultSettings(root));
    settings.saveDestination(destination);
    queue = new FakeQueue();
    service = new ExportService({
      photos: library,
      settings,
      exiftool,
      queue: queue as unknown as UploadQueue,
      exportedFiles: new ExportedFileStore(join(root, 'exported-files.json')),
      onEvent: () => {},
    });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  async function addPhoto(name: string, metadata = true): Promise<Photo> {
    const path = join(root, `${name}.jpg`);
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#357' } })
      .jpeg()
      .toFile(path);
    if (metadata) {
      await exiftool.write(path, {
        Make: 'Nikon',
        Model: 'Z 9',
        Copyright: '© Sportfotografen',
        Credit: 'Sportfotografen',
        Headline: 'Cup final',
        GPSLatitude: '59.3293',
        GPSLatitudeRef: 'N',
        GPSLongitude: '18.0686',
        GPSLongitudeRef: 'E',
      });
    }
    const photo: Photo = {
      id: asPhotoId(name),
      path,
      sidecarPath: path,
      fileName: `${name}.jpg`,
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
      versions: [],
    };
    library.add(photo);
    return photo;
  }

  it('forgets per-photo state once the uploads are delivered', async () => {
    for (const name of ['a', 'b', 'c']) {
      const photo = await addPhoto(name);
      const exported = await service.exportOne({
        photoId: photo.id,
        preset: preset(),
        rendered,
      });
      // The IPTC read is only needed until the queue has expanded the remote path.
      expect(service.trackedCounts().fields).toBe(1);
      const uploads = await service.enqueue(photo.id, exported.path, [destination.id]);
      expect(service.trackedCounts().fields).toBe(0);
      expect(service.trackedCounts().batches).toBe(1);
      expect(library.get(photo.id).status.upload).toBe('queued');

      queue.setState(uploads[0]!.id, 'done');
      expect(library.get(photo.id).status.upload).toBe('done');
      expect(service.trackedCounts()).toEqual({ fields: 0, batches: 0 });
    }
  });

  it('keeps a batch with a failed upload so a retry still counts, and drops it when delivered', async () => {
    const photo = await addPhoto('f');
    const exported = await service.exportOne({ photoId: photo.id, preset: preset(), rendered });
    const uploads = await service.enqueue(photo.id, exported.path, [destination.id]);
    queue.setState(uploads[0]!.id, 'failed');
    expect(library.get(photo.id).status.upload).toBe('failed');
    expect(service.trackedCounts().batches).toBe(1);

    queue.setState(uploads[0]!.id, 'done');
    expect(library.get(photo.id).status.upload).toBe('done');
    expect(service.trackedCounts().batches).toBe(0);
  });

  it('leaves nothing behind when the encode fails', async () => {
    const photo = await addPhoto('bad');
    await expect(
      service.exportOne({ photoId: photo.id, preset: preset({ quality: 500 }), rendered }),
    ).rejects.toThrow();
    expect(service.trackedCounts()).toEqual({ fields: 0, batches: 0 });
    expect(library.get(photo.id).status.export).toBe('failed');
  });

  it('waits for an edit in progress on the photo before reading its metadata', async () => {
    const photo = await addPhoto('locked');
    let release: () => void = () => {};
    const editing = library.withLock(
      photo.id,
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const exporting = service.exportOne({ photoId: photo.id, preset: preset(), rendered });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Not started: the export is queued behind the edit.
    expect(library.get(photo.id).status.export).toBe('none');
    expect(queue.items).toHaveLength(0);

    release();
    await editing;
    const exported = await exporting;
    expect(exported.path.endsWith('locked.jpg')).toBe(true);
    expect(library.get(photo.id).status.export).toBe('done');
  });

  it('never writes over the ingested JPEG original, even with overwrite', async () => {
    const photo = await addPhoto('original');
    const before = await readFile(photo.path);

    await expect(
      service.exportOne({
        photoId: photo.id,
        preset: preset({
          folderTemplate: dirname(photo.path),
          fileNameTemplate: '{filenamebase}',
          ifExists: 'overwrite',
          metadata: 'none',
          sendTo: [],
        }),
        rendered,
      }),
    ).rejects.toThrow(/ingested photo or sidecar/);
    expect(await readFile(photo.path)).toEqual(before);

    const suffixed = await service.exportOne({
      photoId: photo.id,
      preset: preset({
        folderTemplate: dirname(photo.path),
        fileNameTemplate: '{filenamebase}',
        ifExists: 'suffix',
        metadata: 'none',
        sendTo: [],
      }),
      rendered,
    });
    expect(basename(suffixed.path)).toBe('original-1.jpg');
    expect(await readFile(photo.path)).toEqual(before);
  });

  it('protects a raw sidecar as well as the raw file', async () => {
    const rawPath = join(root, 'raw.NEF');
    const sidecarPath = join(root, 'raw.xmp');
    await writeFile(rawPath, 'raw bytes');
    await writeFile(sidecarPath, 'sidecar bytes');
    const photo: Photo = {
      id: asPhotoId('raw'),
      path: rawPath,
      sidecarPath,
      fileName: 'raw.NEF',
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
      versions: [],
    };
    library.add(photo);

    await expect(
      service.exportOne({
        photoId: photo.id,
        preset: preset({
          folderTemplate: dirname(rawPath),
          fileNameTemplate: '{filenamebase}.xmp',
          ifExists: 'overwrite',
          metadata: 'none',
          sendTo: [],
        }),
        rendered,
      }),
    ).rejects.toThrow(/ingested photo or sidecar/);
    expect(await readFile(sidecarPath, 'utf8')).toBe('sidecar bytes');
    expect(await readFile(rawPath, 'utf8')).toBe('raw bytes');
  });

  it('overwrites only a file this app exported earlier', async () => {
    const photo = await addPhoto('own');
    const presetWithOverwrite = preset({
      folderTemplate: join(root, 'own-exports'),
      fileNameTemplate: '{filenamebase}',
      ifExists: 'overwrite',
      metadata: 'none',
      sendTo: [],
    });
    const first = await service.exportOne({
      photoId: photo.id,
      preset: presetWithOverwrite,
      rendered,
    });
    const second = await service.exportOne({
      photoId: photo.id,
      preset: presetWithOverwrite,
      rendered,
    });
    expect(second.path).toBe(first.path);
    expect(second.path.endsWith('own.jpg')).toBe(true);
  });

  it('writes all, IPTC-only, copyright-only and no metadata, with GPS stripped on request', async () => {
    const cases = [
      { name: 'all', metadata: 'all' as const, stripGps: false },
      { name: 'all-no-gps', metadata: 'all' as const, stripGps: true },
      { name: 'iptc', metadata: 'iptc' as const, stripGps: false },
      { name: 'copyright', metadata: 'copyright' as const, stripGps: false },
      { name: 'none', metadata: 'none' as const, stripGps: false },
    ];
    const outputs = new Map<string, string>();
    for (const testCase of cases) {
      const photo = await addPhoto(testCase.name);
      const exported = await service.exportOne({
        photoId: photo.id,
        preset: preset({
          metadata: testCase.metadata,
          stripGps: testCase.stripGps,
          sendTo: [],
        }),
        rendered,
      });
      outputs.set(testCase.name, exported.path);
    }

    const tags = async (name: string): Promise<Record<string, unknown>> =>
      exiftool.read(outputs.get(name)!);

    const all = await tags('all');
    expect(all['IFD0:Make']).toBe('Nikon');
    expect(all['GPS:GPSLatitude']).toBeDefined();
    expect(all['XMP-photoshop:Credit']).toBe('Sportfotografen');
    expect((await readIptc(outputs.get('all')!, exiftool)).headline).toBe('Cup final');

    const noGps = await tags('all-no-gps');
    expect(noGps['IFD0:Make']).toBe('Nikon');
    expect(noGps['GPS:GPSLatitude']).toBeUndefined();

    const iptc = await tags('iptc');
    expect(iptc['IFD0:Make']).toBeUndefined();
    expect(iptc['GPS:GPSLatitude']).toBeUndefined();

    const copyright = await readIptc(outputs.get('copyright')!, exiftool);
    expect(copyright.copyright).toBe('© Sportfotografen');
    expect(copyright.credit).toBeUndefined();
    expect(copyright.headline).toBeUndefined();

    const iptcFields = await readIptc(outputs.get('iptc')!, exiftool);
    expect(iptcFields).toMatchObject({
      credit: 'Sportfotografen',
      headline: 'Cup final',
      copyright: '© Sportfotografen',
    });

    const none = await tags('none');
    expect(none['IFD0:Make']).toBeUndefined();
    expect(none['XMP-photoshop:Credit']).toBeUndefined();
    expect(none['XMP-photoshop:Headline']).toBeUndefined();
    const noneFields = await readIptc(outputs.get('none')!, exiftool);
    expect(noneFields).toEqual({});

    // The files themselves are real JPEGs.
    expect((await sharp(await readFile(outputs.get('all')!)).metadata()).format).toBe('jpeg');
  });
});
