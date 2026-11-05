// @vitest-environment node
import { asPhotoId, asSourceId, type IptcFields, type Photo } from '@ee/contracts';
import { ExifToolService, readIptc } from '@ee/metadata';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PhotoDeleter } from '../src/jobs/backend/photo-deleter';
import { MetadataService } from '../src/jobs/backend/metadata-service';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { SearchIndex } from '../src/jobs/backend/search-index';
import { SettingsStore } from '../src/jobs/backend/settings-store';
import { defaultSettings } from '../src/shared/settings';

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-search-'));
  dirs.push(dir);
  return dir;
};

const photoFor = (path: string, number: number): Photo => ({
  id: asPhotoId(`photo-${number}`),
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

describe('SearchIndex with real ExifTool and sidecars', () => {
  let exiftool: ExifToolService;
  const open: { index: PhotoIndex; search: SearchIndex }[] = [];

  beforeAll(() => {
    exiftool = new ExifToolService();
  });
  afterAll(async () => {
    await exiftool.close();
  });
  afterEach(async () => {
    for (const { index, search } of open.splice(0)) {
      await search.close();
      index.close();
    }
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const create = (file: string, reads: string[] = []) => {
    const index = new PhotoIndex(file);
    const search = new SearchIndex(
      index,
      async (photo) => {
        reads.push(photo.fileName);
        return readIptc(photo.path, exiftool);
      },
      (photoId, task) => library.withLock(photoId, task),
    );
    open.push({ index, search });
    const library: PhotoLibrary = new PhotoLibrary(index, () => {}, search);
    return { index, search, library, reads };
  };

  const addPhoto = async (
    dir: string,
    library: PhotoLibrary,
    metadata: MetadataService,
    number: number,
    fields: IptcFields,
    name = `frame_${number}.NEF`,
  ): Promise<Photo> => {
    const path = join(dir, name);
    // The sidecar strategy follows the extension, so JPEG bytes stand in for a raw.
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#468' } })
      .jpeg()
      .toFile(path);
    const photo = photoFor(path, number);
    library.add(photo);
    await metadata.write({ photoId: photo.id, fields });
    return photo;
  };

  it('finds Swedish captions and keywords across the library, from the sidecars', async () => {
    const dir = await tempDir();
    const { library, search } = create(':memory:');
    const metadata = new MetadataService(
      library,
      exiftool,
      new SettingsStore(undefined, defaultSettings(dir)),
    );
    const first = await addPhoto(dir, library, metadata, 1, {
      caption: 'Målvakten Åkerlund räddar en straff',
      keywords: ['allsvenskan', 'Örgryte'],
    });
    const second = await addPhoto(dir, library, metadata, 2, { caption: 'Hörnor', keywords: [] });
    await search.idle();

    expect(search.search('åkerlund').photoIds).toEqual([first.id]);
    expect(search.search('ÅKERLUND').photoIds).toEqual([first.id]);
    expect(search.search('akerlund').photoIds).toEqual([]);
    expect(search.search('örgryte').photoIds).toEqual([first.id]);
    expect(search.search('hörnor').photoIds).toEqual([second.id]);
    expect(search.search('frame_2').photoIds).toEqual([second.id]);
    expect(search.search('allsvenskan målvakt').photoIds).toEqual([first.id]);
    expect(search.search('').photoIds).toEqual([first.id, second.id]);
    expect(search.search('åkerlund').pending).toBe(0);
  });

  it('picks up a caption changed later, and forgets a removed photo', async () => {
    const dir = await tempDir();
    const { library, search } = create(':memory:');
    const metadata = new MetadataService(
      library,
      exiftool,
      new SettingsStore(undefined, defaultSettings(dir)),
    );
    const photo = await addPhoto(dir, library, metadata, 1, { caption: 'Före' });
    await search.idle();
    expect(search.search('före').photoIds).toEqual([photo.id]);

    await metadata.write({ photoId: photo.id, fields: { caption: 'Efter', keywords: ['mål'] } });
    // Between the write and the re-read the old text still matches, but the caller is told.
    expect(search.search('före').pending).toBe(1);
    await search.idle();
    expect(search.search('före').pending).toBe(0);
    expect(search.search('före').photoIds).toEqual([]);
    expect(search.search('efter').photoIds).toEqual([photo.id]);
    expect(search.search('mål').photoIds).toEqual([photo.id]);

    library.remove(photo.id);
    expect(search.search('efter').photoIds).toEqual([]);
  });

  it('reports photos it has not read yet as pending, and matches them by name meanwhile', async () => {
    const dir = await tempDir();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const index = new PhotoIndex(':memory:');
    const search = new SearchIndex(
      index,
      async () => {
        await gate;
        return { caption: 'Sent läsning' };
      },
      (photoId, task) => library.withLock(photoId, task),
    );
    open.push({ index, search });
    const library: PhotoLibrary = new PhotoLibrary(index, () => {}, search);
    library.add(photoFor(join(dir, 'slow_1.NEF'), 1));

    expect(search.search('slow_1')).toEqual({ photoIds: [asPhotoId('photo-1')], pending: 1 });
    expect(search.search('läsning')).toEqual({ photoIds: [], pending: 1 });
    release?.();
    await search.idle();
    expect(search.search('läsning')).toEqual({ photoIds: [asPhotoId('photo-1')], pending: 0 });
  });

  it('keeps the text across a restart and reads only photos that have none', async () => {
    const dir = await tempDir();
    const file = join(dir, 'index.sqlite');
    const first = create(file);
    const metadata = new MetadataService(
      first.library,
      exiftool,
      new SettingsStore(undefined, defaultSettings(dir)),
    );
    await addPhoto(dir, first.library, metadata, 1, { caption: 'Blågult jubel' });
    await first.search.idle();
    expect(first.reads.length).toBeGreaterThan(0);
    await first.search.close();
    first.index.close();
    open.length = 0;

    const second = create(file);
    second.search.start();
    await second.search.idle();
    expect(second.reads).toEqual([]);
    expect(second.search.search('blågult').photoIds).toEqual([asPhotoId('photo-1')]);
  });

  it('builds its text for an index made before search existed', async () => {
    const dir = await tempDir();
    const file = join(dir, 'index.sqlite');
    const first = create(file);
    const metadata = new MetadataService(
      first.library,
      exiftool,
      new SettingsStore(undefined, defaultSettings(dir)),
    );
    await addPhoto(dir, first.library, metadata, 1, { caption: 'Gammal rubrik' });
    await first.search.idle();
    // As an older app left it: the column is there but nothing was ever read.
    const { DatabaseSync } = await import('node:sqlite');
    first.index.close();
    open.length = 0;
    const db = new DatabaseSync(file);
    db.exec('UPDATE photos SET search_text = NULL');
    db.close();

    const second = create(file);
    expect(second.search.search('gammal')).toEqual({ photoIds: [], pending: 1 });
    second.search.start();
    await second.search.idle();
    expect(second.search.search('gammal')).toEqual({
      photoIds: [asPhotoId('photo-1')],
      pending: 0,
    });
  });

  /** A search index whose reads and a deleter's trash calls share one log, with gates to hold them. */
  const withDeleter = (dir: string, concurrency = 2) => {
    const events: string[] = [];
    const warnings: string[] = [];
    const gates = new Map<string, Promise<void>>();
    const index = new PhotoIndex(':memory:');
    const search = new SearchIndex(
      index,
      async (photo) => {
        events.push(`read ${photo.fileName}`);
        await gates.get(`read ${photo.fileName}`);
        events.push(`read done ${photo.fileName}`);
        return { caption: 'text' };
      },
      (photoId, task) => library.withLock(photoId, task),
      (message) => warnings.push(message),
      concurrency,
    );
    open.push({ index, search });
    const library: PhotoLibrary = new PhotoLibrary(index, () => {}, search);
    const deleter = new PhotoDeleter({
      photos: library,
      settings: { listSources: () => [] },
      trash: async (path) => {
        events.push(`trash ${basename(path)}`);
        await gates.get(`trash ${basename(path)}`);
        await rename(path, join(dir, `trashed-${basename(path)}`));
      },
      onRemoved: async () => {},
      warn: () => {},
    });
    const gate = (name: string): (() => void) => {
      let release = (): void => undefined;
      gates.set(name, new Promise<void>((resolve) => (release = resolve)));
      return release;
    };
    const add = async (number: number, name: string): Promise<Photo> => {
      const path = join(dir, name);
      await writeFile(path, 'x');
      const photo = photoFor(path, number);
      library.add(photo);
      return photo;
    };
    return { events, warnings, gate, add, deleter, search, library };
  };

  it('holds a delete back while the photo is being read, then deletes it', async () => {
    const dir = await tempDir();
    const { events, gate, add, deleter, search } = withDeleter(dir);
    const releaseRead = gate('read a.jpg');
    const photo = await add(1, 'a.jpg');
    await vi.waitFor(() => expect(events).toEqual(['read a.jpg']));

    const deleting = deleter.delete({ photoIds: [photo.id] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The read has the photo's lock; the file must not be moved while it is open.
    expect(events).toEqual(['read a.jpg']);

    releaseRead();
    expect(await deleting).toEqual({ deleted: [photo.id], failed: [] });
    expect(events).toEqual(['read a.jpg', 'read done a.jpg', 'trash a.jpg']);
    await search.idle();
  });

  it('does not read, or log, a photo that was deleted while it waited in the queue', async () => {
    const dir = await tempDir();
    // One read at a time: b.jpg waits in the queue behind a.jpg, then for the lock behind the delete.
    const { events, warnings, gate, add, deleter, search } = withDeleter(dir, 1);
    const releaseA = gate('read a.jpg');
    const releaseTrash = gate('trash b.jpg');
    await add(1, 'a.jpg');
    const b = await add(2, 'b.jpg');
    await vi.waitFor(() => expect(events).toEqual(['read a.jpg']));

    const deleting = deleter.delete({ photoIds: [b.id] });
    await vi.waitFor(() => expect(events).toContain('trash b.jpg'));
    releaseA();
    // b.jpg is dequeued now and waits for the lock the delete holds.
    await vi.waitFor(() => expect(events).toContain('read done a.jpg'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseTrash();
    expect(await deleting).toEqual({ deleted: [b.id], failed: [] });
    await search.idle();

    expect(events).not.toContain('read b.jpg');
    expect(warnings).toEqual([]);
    expect(search.search('b.jpg').photoIds).toEqual([]);
  });

  it('answers a query over thousands of photos quickly', () => {
    const index = new PhotoIndex(':memory:');
    const search = new SearchIndex(
      index,
      async () => ({}),
      (photoId, task) => library.withLock(photoId, task),
    );
    open.push({ index, search });
    const library: PhotoLibrary = new PhotoLibrary(index, () => {}, search);
    for (let number = 1; number <= 5000; number += 1) {
      library.add(photoFor(`/photos/IMG_${number}.NEF`, number));
    }
    const started = performance.now();
    const result = search.search('img_4999');
    expect(performance.now() - started).toBeLessThan(100);
    expect(result.photoIds).toHaveLength(1);
  });
});
