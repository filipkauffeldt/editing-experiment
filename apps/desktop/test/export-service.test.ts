// @vitest-environment node
import {
  asDestinationId,
  asPhotoId,
  asSourceId,
  asUploadId,
  type Destination,
  type Photo,
  type PhotoId,
  type UploadItem,
} from '@ee/contracts';
import { JobEventEmitter, type UploadQueue } from '@ee/export';
import { ExifToolService } from '@ee/metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExportService } from '../src/jobs/backend/export-service';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { SettingsStore } from '../src/jobs/backend/settings-store';
import { defaultSettings } from '../src/shared/settings';

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

describe('ExportService bookkeeping', () => {
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
  const action = {
    exportPreset: { quality: 80, metadata: 'iptc' as const },
    destinations: [destination.id],
  };

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
      exportsDir: join(root, 'exports'),
      onEvent: () => {},
    });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  async function addPhoto(name: string): Promise<Photo> {
    const path = join(root, `${name}.jpg`);
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#357' } })
      .jpeg()
      .toFile(path);
    const photo: Photo = {
      id: asPhotoId(name),
      path,
      sidecarPath: path,
      fileName: `${name}.jpg`,
      sourceId: asSourceId('s'),
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
      const { uploads } = await service.export({ photoId: photo.id, rendered, action });
      // The IPTC read is only needed until the queue has expanded the remote path.
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
    const { uploads } = await service.export({ photoId: photo.id, rendered, action });
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
      service.export({
        photoId: photo.id,
        rendered,
        action: { ...action, exportPreset: { quality: 500, metadata: 'iptc' } },
      }),
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

    const exporting = service.export({ photoId: photo.id, rendered, action });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Not started: the export is queued behind the edit.
    expect(library.get(photo.id).status.export).toBe('none');
    expect(queue.items).toHaveLength(0);

    release();
    await editing;
    const { uploads } = await exporting;
    expect(uploads).toHaveLength(1);
    expect(library.get(photo.id).status.export).toBe('done');
  });
});
