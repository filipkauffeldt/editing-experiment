// @vitest-environment node
import {
  asDestinationId,
  asPhotoId,
  asSourceId,
  asUploadId,
  type Destination,
  type ExportJob,
  type ExportPreset,
  type IpcHandlers,
  type JobEvent,
  type Photo,
  type PhotoId,
  type UploadItem,
} from '@ee/contracts';
import { JobEventEmitter, type UploadQueue } from '@ee/export';
import { EXPORT_MARKER_NAME } from '@ee/ingest';
import { ExifToolService, writeIptc } from '@ee/metadata';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBackend, type Backend } from '../src/jobs/backend/backend';
import { ExportQueue } from '../src/jobs/backend/export-queue';
import { ExportService } from '../src/jobs/backend/export-service';
import { ExportedFileStore } from '../src/jobs/backend/exported-files';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { SettingsStore } from '../src/jobs/backend/settings-store';
import { defaultExportPreset, defaultSettings } from '../src/shared/settings';

const rendered = { width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4).fill(180) };
const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-next-to-photo-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    // A read-only test folder must be writable again to be removed.
    await chmod(dir, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const jpeg = (path: string, background: string): Promise<unknown> =>
  mkdir(dirname(path), { recursive: true }).then(() =>
    sharp({ create: { width: 16, height: 16, channels: 3, background } })
      .jpeg()
      .toFile(path),
  );

function indexed(path: string, id = basename(path, '.jpg')): Photo {
  return {
    id: asPhotoId(`${id}-${Math.abs(hash(path))}`),
    path,
    sidecarPath: path,
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
    versions: [],
  };
}

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) | 0;
  return value;
}

/** Just enough of the upload queue to see which local file an upload is made from. */
class FakeQueue {
  readonly events = new JobEventEmitter();
  items: UploadItem[] = [];
  async enqueue(photoId: PhotoId, localPath: string, destinations: Destination[]) {
    const created = destinations.map((destination, index): UploadItem => ({
      id: asUploadId(`u${this.items.length + index}`),
      photoId,
      destinationId: destination.id,
      localPath,
      remotePath: `/${basename(localPath)}`,
      state: 'queued',
      bytesSent: 0,
      bytesTotal: 1,
      attempts: 0,
    }));
    this.items.push(...created);
    return created;
  }
  list(): UploadItem[] {
    return this.items;
  }
}

describe('export next to the photo', () => {
  let root: string;
  let exiftool: ExifToolService;
  let library: PhotoLibrary;
  let settings: SettingsStore;
  let queue: FakeQueue;
  let service: ExportService;
  let exportedFiles: ExportedFileStore;
  const desk: Destination = {
    id: asDestinationId('desk'),
    name: 'Desk',
    kind: 'folder',
    path: '/unused',
    remotePathTemplate: '{fileName}',
  };
  /** The default preset, with metadata off so the test does not depend on what the JPEG holds. */
  const preset = (overrides: Partial<ExportPreset> = {}): ExportPreset => ({
    ...defaultExportPreset(),
    metadata: 'none',
    ...overrides,
  });

  beforeAll(() => {
    exiftool = new ExifToolService();
  });
  afterAll(() => exiftool.close());

  beforeEach(async () => {
    root = await tempDir();
    library = new PhotoLibrary(new PhotoIndex(':memory:'), () => {});
    settings = new SettingsStore(undefined, defaultSettings(root));
    settings.saveDestination(desk);
    queue = new FakeQueue();
    exportedFiles = new ExportedFileStore(join(root, 'exported-files.json'));
    service = new ExportService({
      photos: library,
      settings,
      exiftool,
      queue: queue as unknown as UploadQueue,
      exportedFiles,
      onEvent: () => {},
    });
  });

  async function addPhoto(path: string, background = '#357'): Promise<Photo> {
    await jpeg(path, background);
    const photo = indexed(path);
    library.add(photo);
    return photo;
  }

  it('exports the default preset into <photo folder>/export', async () => {
    const folder = join(root, 'Photos', '20261104_GAIS-AIK');
    const photo = await addPhoto(join(folder, '_DSC1234.jpg'));
    const before = await readFile(photo.path);

    const result = await service.exportOne({ photoId: photo.id, preset: preset(), rendered });

    expect(result.path).toBe(join(folder, 'export', '_DSC1234.jpg'));
    expect((await stat(result.path)).size).toBeGreaterThan(0);
    expect(await readFile(photo.path)).toEqual(before);
    // The export folder holds the export and the marker, nothing else (no temp files).
    expect((await readdir(join(folder, 'export'))).sort()).toEqual([
      EXPORT_MARKER_NAME,
      '_DSC1234.jpg',
    ]);
    expect(library.get(photo.id).status.export).toBe('done');
  });

  it('sends each photo of a batch to the export folder next to it', async () => {
    const first = await addPhoto(join(root, 'Photos', '20261104_GAIS-AIK', 'a_001.jpg'));
    const second = await addPhoto(join(root, 'Photos', '20261105_AIK-DIF', 'b_001.jpg'));
    const third = await addPhoto(join(root, 'Photos', '20261105_AIK-DIF', 'b_002.jpg'));

    for (const photo of [first, second, third]) {
      await service.exportOne({ photoId: photo.id, preset: preset(), rendered });
    }

    const exported = async (folder: string): Promise<string[]> =>
      (await readdir(join(root, 'Photos', folder, 'export'))).filter((n) => !n.startsWith('.'));
    expect(await exported('20261104_GAIS-AIK')).toEqual(['a_001.jpg']);
    expect((await exported('20261105_AIK-DIF')).sort()).toEqual(['b_001.jpg', 'b_002.jpg']);
    expect(await exists(join(root, 'export'))).toBe(false);
  });

  it('keeps writing to the local export path that Export & send uploads from', async () => {
    const folder = join(root, 'Photos', '20261104_GAIS-AIK');
    const photo = await addPhoto(join(folder, 'a_001.jpg'));
    const result = await service.exportOne({ photoId: photo.id, preset: preset(), rendered });
    const [upload] = await service.enqueue(photo.id, result.path, [desk.id]);
    expect(upload?.localPath).toBe(join(folder, 'export', 'a_001.jpg'));
    expect((await stat(upload!.localPath)).isFile()).toBe(true);
  });

  describe('never over an original', () => {
    it('refuses to overwrite a JPEG original when exporting into its own folder', async () => {
      const photo = await addPhoto(join(root, 'Photos', 'game', 'a_001.jpg'));
      const before = await readFile(photo.path);
      await expect(
        service.exportOne({
          photoId: photo.id,
          preset: preset({ folderTemplate: '{photofolder}', ifExists: 'overwrite' }),
          rendered,
        }),
      ).rejects.toThrow(/ingested photo or sidecar/);
      expect(await readFile(photo.path)).toEqual(before);

      const suffixed = await service.exportOne({
        photoId: photo.id,
        preset: preset({ folderTemplate: '{photofolder}' }),
        rendered,
      });
      expect(basename(suffixed.path)).toBe('a_001-1.jpg');
      expect(await readFile(photo.path)).toEqual(before);
    });

    it('refuses to overwrite a photo that sits in the export folder itself', async () => {
      const folder = join(root, 'Photos', 'game');
      const photo = await addPhoto(join(folder, 'a_001.jpg'));
      // An ingested JPEG that has the same name the export would get, in the export folder.
      const squatter = await addPhoto(join(folder, 'export', 'a_001.jpg'), '#a33');
      const before = await readFile(squatter.path);

      await expect(
        service.exportOne({
          photoId: photo.id,
          preset: preset({ ifExists: 'overwrite' }),
          rendered,
        }),
      ).rejects.toThrow(/ingested photo or sidecar/);
      expect(await readFile(squatter.path)).toEqual(before);

      const suffixed = await service.exportOne({
        photoId: photo.id,
        preset: preset({ ifExists: 'suffix' }),
        rendered,
      });
      expect(basename(suffixed.path)).toBe('a_001-1.jpg');
      expect(await readFile(squatter.path)).toEqual(before);
      // The folder holds an ingested photo, so no marker may hide it from the startup scan.
      expect(await exists(join(folder, 'export', EXPORT_MARKER_NAME))).toBe(false);
    });

    it('does not write a marker into the photo folder itself', async () => {
      const folder = join(root, 'Photos', 'game');
      const photo = await addPhoto(join(folder, 'a_001.jpg'));
      await service.exportOne({
        photoId: photo.id,
        preset: preset({ folderTemplate: '{photofolder}' }),
        rendered,
      });
      expect(await exists(join(folder, EXPORT_MARKER_NAME))).toBe(false);
    });

    it('overwrites only its own earlier export', async () => {
      const folder = join(root, 'Photos', 'game');
      const photo = await addPhoto(join(folder, 'a_001.jpg'));
      const overwrite = preset({ ifExists: 'overwrite' });
      const first = await service.exportOne({ photoId: photo.id, preset: overwrite, rendered });
      const second = await service.exportOne({ photoId: photo.id, preset: overwrite, rendered });
      expect(second.path).toBe(first.path);

      // A file in the export folder the app did not write is not replaced.
      await writeFile(join(folder, 'export', 'other.jpg'), 'someone else');
      const named = preset({ ifExists: 'overwrite', fileNameTemplate: 'other' });
      await expect(
        service.exportOne({ photoId: photo.id, preset: named, rendered }),
      ).rejects.toThrow(/not exported by this app/);
      expect(await readFile(join(folder, 'export', 'other.jpg'), 'utf8')).toBe('someone else');
    });
  });

  describe('when the photo folder cannot be used', () => {
    it('names the folder when it is gone, and does not create it again', async () => {
      const folder = join(root, 'Photos', '20261104_GAIS-AIK');
      const photo = await addPhoto(join(folder, 'a_001.jpg'));
      await rm(folder, { recursive: true });

      await expect(
        service.exportOne({ photoId: photo.id, preset: preset(), rendered }),
      ).rejects.toThrow(
        new RegExp(`a_001\\.jpg.*${folder.replaceAll('\\', '\\\\')}.*not available`),
      );
      expect(await exists(folder)).toBe(false);
      expect(await exists(join(root, 'Photos'))).toBe(true);
      expect(library.get(photo.id).status.export).toBe('failed');
    });

    it('names the folder when the photo folder is not a folder any more', async () => {
      const folder = join(root, 'Photos', 'game');
      const photo = await addPhoto(join(folder, 'a_001.jpg'));
      await rm(folder, { recursive: true });
      await writeFile(folder, 'a file where the folder was');
      await expect(
        service.exportOne({ photoId: photo.id, preset: preset(), rendered }),
      ).rejects.toThrow(/not available/);
    });

    it.skipIf(!canChmod)('names the export folder when the photo folder is read-only', async () => {
      const folder = join(root, 'Photos', 'game');
      const photo = await addPhoto(join(folder, 'a_001.jpg'));
      await chmod(folder, 0o555);
      try {
        await expect(
          service.exportOne({ photoId: photo.id, preset: preset(), rendered }),
        ).rejects.toThrow(/not writable/);
        await expect(
          service.exportOne({ photoId: photo.id, preset: preset(), rendered }),
        ).rejects.toThrow(join(folder, 'export'));
      } finally {
        await chmod(folder, 0o755);
      }
      expect(await exists(join(folder, 'export'))).toBe(false);
    });

    it.skipIf(!canChmod)('names the export folder when it exists but is read-only', async () => {
      const folder = join(root, 'Photos', 'game');
      const photo = await addPhoto(join(folder, 'a_001.jpg'));
      await mkdir(join(folder, 'export'));
      await chmod(join(folder, 'export'), 0o555);
      try {
        await expect(
          service.exportOne({ photoId: photo.id, preset: preset(), rendered }),
        ).rejects.toThrow(/not writable/);
      } finally {
        await chmod(join(folder, 'export'), 0o755);
      }
      expect(await readdir(join(folder, 'export'))).toEqual([]);
    });
  });

  describe('metadata cannot steer the export out of the photo folder', () => {
    it.each(['../../../evil', '../../evil', 'x/../../../evil'])(
      'refuses a headline of %s',
      async (headline) => {
        const folder = join(root, 'Photos', 'game');
        const photo = await addPhoto(join(folder, 'a_001.jpg'));
        await writeIptc(photo.path, { headline }, { service: exiftool });

        await expect(
          service.exportOne({
            photoId: photo.id,
            preset: preset({ folderTemplate: '{photofolder}/export/{headline}' }),
            rendered,
          }),
        ).rejects.toThrow(/leaves the photo's folder/);

        expect(await exists(join(root, 'evil'))).toBe(false);
        expect(await exists(join(root, 'Photos', 'evil'))).toBe(false);
        expect(await exists(join(folder, 'export'))).toBe(false);
        expect(library.get(photo.id).status.export).not.toBe('done');
      },
    );

    it('still lets a headline name a folder below the photo folder', async () => {
      const folder = join(root, 'Photos', 'game');
      const photo = await addPhoto(join(folder, 'a_001.jpg'));
      await writeIptc(photo.path, { headline: 'Cup final' }, { service: exiftool });
      const result = await service.exportOne({
        photoId: photo.id,
        preset: preset({ folderTemplate: '{photofolder}/export/{headline}' }),
        rendered,
      });
      expect(result.path).toBe(join(folder, 'export', 'Cup final', 'a_001.jpg'));
    });
  });

  describe('through the export queue', () => {
    function queueFor(file: string): ExportQueue {
      const exportQueue: ExportQueue = new ExportQueue({
        file,
        getPreset: (id) => settings.getExportPreset(id),
        getOpsKey: () => '',
        exportPhoto: (args) => service.exportOne(args),
        enqueue: async () => undefined,
        emit: (event) => {
          if (event.type !== 'export.render') return;
          // The renderer answers on its own turn, as it does over IPC.
          queueMicrotask(() =>
            exportQueue.deliverRender({
              jobId: event.jobId,
              requestId: event.requestId,
              rendered,
              opsKey: event.opsKey,
            }),
          );
        },
      });
      return exportQueue;
    }

    const finished = async (
      exportQueue: ExportQueue,
      jobId: ExportJob['id'],
    ): Promise<ExportJob> => {
      for (let i = 0; i < 400; i++) {
        const job = exportQueue.list().find((candidate) => candidate.id === jobId);
        if (job && ['done', 'failed', 'cancelled'].includes(job.state)) return job;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('the export job did not finish');
    };

    it('fails one photo with a clear message and carries on with the next folder', async () => {
      const gone = await addPhoto(join(root, 'Photos', 'gone', 'a_001.jpg'));
      const here = await addPhoto(join(root, 'Photos', 'here', 'b_001.jpg'));
      await rm(join(root, 'Photos', 'gone'), { recursive: true });
      const exportQueue = queueFor(join(root, 'export-jobs.json'));

      const jobId = exportQueue.start({
        photoIds: [gone.id, here.id],
        presetId: settings.activeExportPreset()!.id,
      });
      const job = await finished(exportQueue, jobId);

      expect(job.state).toBe('failed');
      expect(job.photos[0]).toMatchObject({ photoId: gone.id, state: 'failed' });
      expect(job.photos[0]?.error).toContain(join(root, 'Photos', 'gone'));
      expect(job.photos[0]?.error).toMatch(/not available/);
      expect(job.photos[1]).toMatchObject({ photoId: here.id, state: 'done' });
      expect(job.photos[1]?.path).toBe(join(root, 'Photos', 'here', 'export', 'b_001.jpg'));
      expect(await exists(join(root, 'Photos', 'gone'))).toBe(false);
    });

    it('works out the folder when each photo is exported, so a restart and a changed preset are safe', async () => {
      const first = await addPhoto(join(root, 'Photos', 'game', 'a_001.jpg'));
      const second = await addPhoto(join(root, 'Photos', 'game', 'a_002.jpg'));
      const file = join(root, 'export-jobs.json');
      const active = settings.activeExportPreset()!;

      // The app quits while the first photo is being exported.
      const one = queueFor(file);
      const original = service.exportOne.bind(service);
      service.exportOne = async (args) => {
        const result = await original(args);
        one.close();
        return result;
      };
      const jobId = one.start({ photoIds: [first.id, second.id], presetId: active.id });
      await new Promise((resolve) => setTimeout(resolve, 100));
      service.exportOne = original;
      const gameFolder = join(root, 'Photos', 'game');
      expect(await exists(join(gameFolder, 'export', 'a_001.jpg'))).toBe(true);
      expect(await exists(join(gameFolder, 'export', 'a_002.jpg'))).toBe(false);

      // Meanwhile the user changes the folder template of the preset.
      settings.saveExportPreset({ ...active, folderTemplate: '{photofolder}/web' });

      // The job file holds photo ids and a preset id, not folders: after the restart the folder
      // is worked out again, from the preset as it is now and from where the photo is now.
      const two = queueFor(file);
      two.markRendererReady();
      const job = await finished(two, jobId);
      expect(job.state).toBe('done');
      expect(job.photos.map((photo) => photo.path)).toEqual([
        join(gameFolder, 'web', 'a_001.jpg'),
        join(gameFolder, 'web', 'a_002.jpg'),
      ]);
      // The export made before the restart stays where it was.
      expect(await exists(join(gameFolder, 'export', 'a_001.jpg'))).toBe(true);
    });
  });
});

describe('a restart does not turn exports into photos', () => {
  let root: string;
  let backend: Backend | undefined;
  let handlers: IpcHandlers;
  let events: { channel: string; payload: unknown }[];
  const destination = (): string => join(root, 'ingest');
  const userData = (): string => join(root, 'userdata');

  async function start(): Promise<void> {
    events = [];
    backend = await createBackend({
      userDataDir: userData(),
      appVersion: 'test',
      homeDir: root,
      emit: (channel, payload) => {
        events.push({ channel, payload });
        const event = payload as Partial<Extract<JobEvent, { type: 'export.render' }>>;
        if (channel !== 'jobs:event' || event.type !== 'export.render') return;
        const { jobId, requestId, opsKey } = event as Extract<JobEvent, { type: 'export.render' }>;
        setTimeout(() => {
          void handlers['export:render']({ jobId, requestId, rendered, opsKey });
        }, 0);
      },
      getSecret: async () => ({}),
    });
    handlers = backend.handlers as IpcHandlers;
    await backend.reconciled;
  }

  async function stop(): Promise<void> {
    await backend?.dispose();
    backend = undefined;
  }

  async function exportAll(): Promise<ExportJob> {
    const photos = await handlers['photos:list']();
    const preset = (await handlers['settings:get']()).exportPresets[0]!;
    const before = events.length;
    const jobId = await handlers['export:start']({
      photoIds: photos.map((photo) => photo.id),
      presetId: preset.id,
    });
    for (let i = 0; i < 1000; i++) {
      const done = events.slice(before).find((event) => {
        const payload = event.payload as { type?: string; jobId?: string; state?: string };
        return (
          payload.type === 'export.state' &&
          payload.jobId === jobId &&
          ['done', 'failed', 'cancelled'].includes(payload.state ?? '')
        );
      });
      if (done) return (done.payload as { job: ExportJob }).job;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the export did not finish');
  }

  const names = async (): Promise<string[]> =>
    (await handlers['photos:list']()).map((photo) => photo.fileName).sort();

  beforeEach(async () => {
    root = await tempDir();
    // First start only to point ingest at a destination, as the settings dialog does.
    await start();
    const { ingest } = await handlers['settings:get']();
    await handlers['settings:set']({ ingest: { ...ingest, destination: { path: destination() } } });
    await stop();
    // Two ingested photos in two folders, as a crash before indexing would leave them.
    await jpeg(join(destination(), '20261104_GAIS-AIK', 'a_001.jpg'), '#468');
    await jpeg(join(destination(), '20261105_AIK-DIF', 'b_001.jpg'), '#684');
    await start();
  });
  afterEach(stop);

  const exportFolders = [join('20261104_GAIS-AIK', 'export'), join('20261105_AIK-DIF', 'export')];

  async function exportAndCheck(): Promise<void> {
    expect(await names()).toEqual(['a_001.jpg', 'b_001.jpg']);
    expect((await handlers['settings:get']()).exportPresets[0]?.folderTemplate).toBe(
      '{photofolder}/export',
    );
    const job = await exportAll();
    expect(job.photos.map((photo) => photo.state)).toEqual(['done', 'done']);
    for (const [index, folder] of exportFolders.entries()) {
      const file = index === 0 ? 'a_001.jpg' : 'b_001.jpg';
      expect((await stat(join(destination(), folder, file))).isFile()).toBe(true);
      expect(await exists(join(destination(), folder, EXPORT_MARKER_NAME))).toBe(true);
    }
    // The originals were not touched, and the photo list did not grow.
    expect(await names()).toEqual(['a_001.jpg', 'b_001.jpg']);
  }

  it('does not import the exports on the next start', async () => {
    await exportAndCheck();
    await stop();
    await start();
    expect(await names()).toEqual(['a_001.jpg', 'b_001.jpg']);
    expect(await backend!.reconcile()).toBe(0);
  }, 60_000);

  it('does not import them after the index was deleted either', async () => {
    await exportAndCheck();
    await stop();
    for (const name of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) {
      await rm(join(userData(), name), { force: true });
    }
    await start();
    // Only the two originals are found again; the exports in <folder>/export are not.
    const photos = await handlers['photos:list']();
    expect(photos.map((photo) => photo.path).sort()).toEqual([
      join(destination(), '20261104_GAIS-AIK', 'a_001.jpg'),
      join(destination(), '20261105_AIK-DIF', 'b_001.jpg'),
    ]);
    expect(photos.every((photo) => photo.sourceId === 'recovered')).toBe(true);
  }, 60_000);

  it('does not import them when the index, the exported-files list and the settings are gone', async () => {
    await exportAndCheck();
    await stop();
    for (const name of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) {
      await rm(join(userData(), name), { force: true });
    }
    await rm(join(userData(), 'exported-files.json'), { force: true });
    await rm(join(userData(), 'settings.json'), { force: true });
    // Settings reset: the destination is back to the default, so point it at the photos again.
    await start();
    const { ingest } = await handlers['settings:get']();
    await handlers['settings:set']({ ingest: { ...ingest, destination: { path: destination() } } });
    await stop();
    await start();
    expect(await names()).toEqual(['a_001.jpg', 'b_001.jpg']);
  }, 60_000);

  it('does not import them when the marker is lost too, for the default folder name', async () => {
    await exportAndCheck();
    await stop();
    for (const name of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) {
      await rm(join(userData(), name), { force: true });
    }
    await rm(join(userData(), 'exported-files.json'), { force: true });
    for (const folder of exportFolders) {
      await rm(join(destination(), folder, EXPORT_MARKER_NAME));
    }
    await start();
    expect(await names()).toEqual(['a_001.jpg', 'b_001.jpg']);
  }, 60_000);

  it('does not import an export folder with another name while the exported-files list is there', async () => {
    const preset = (await handlers['settings:get']()).exportPresets[0]!;
    await handlers['exportPresets:save']({
      preset: { ...preset, folderTemplate: '{photofolder}/Web 2400' },
    });
    const job = await exportAll();
    expect(job.photos.map((photo) => photo.state)).toEqual(['done', 'done']);
    await stop();
    // The marker is gone but the list still names the files.
    await rm(join(destination(), '20261104_GAIS-AIK', 'Web 2400', EXPORT_MARKER_NAME));
    await rm(join(destination(), '20261105_AIK-DIF', 'Web 2400', EXPORT_MARKER_NAME));
    for (const name of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) {
      await rm(join(userData(), name), { force: true });
    }
    await start();
    expect(await names()).toEqual(['a_001.jpg', 'b_001.jpg']);
  }, 60_000);
});
