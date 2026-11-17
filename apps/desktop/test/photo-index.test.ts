// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Photo, PhotoId } from '@ee/contracts';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import {
  filterCounts,
  filterPhotos,
  initialFilter,
  type FilterState,
} from '../src/renderer/filters';
import { queryFilter } from '../src/renderer/store';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const photo = (id: string, path: string, extra: Partial<Photo> = {}): Photo => ({
  id: id as PhotoId,
  path,
  sidecarPath: path.replace(/\.NEF$/, '.xmp'),
  fileName: path.slice(path.lastIndexOf('/') + 1),
  captureTime: '2026-05-01T12:00:00',
  camera: { make: 'NIKON CORPORATION', model: 'NIKON Z 9', serialNumber: '1' },
  sourceId: 'in-place' as Photo['sourceId'],
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
  ...extra,
});

const sleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('photo index queries', () => {
  it('answers a folder and a filter from an index instead of parsing every row', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ee-index-'));
    dirs.push(dir);
    const file = join(dir, 'index.sqlite');
    const index = new PhotoIndex(file);
    index.save(photo('a', '/photos/one/a.NEF', { tagged: true, rating: 5 }));
    index.save(
      photo('b', '/photos/one/b.NEF', { status: { ...photo('x', 'x').status, edited: true } }),
    );
    index.save(photo('c', '/photos/two/c.NEF', { camera: { model: 'NIKON Z 8' } }));
    expect(index.count()).toBe(3);
    expect(index.folders([])).toEqual([
      { path: '/photos/one', count: 2 },
      { path: '/photos/two', count: 1 },
    ]);
    expect(index.listFolder('/photos/one').map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(index.query({ folder: '/photos/one', limit: 10 }).total).toBe(2);
    expect(index.query({ filter: { tag: 'tagged' }, limit: 10 }).photos.map((p) => p.id)).toEqual([
      'a',
    ]);
    expect(index.query({ filter: { minRating: 4 }, limit: 10 }).photos).toHaveLength(1);
    expect(
      index.query({ filter: { statuses: ['edited'] }, limit: 10 }).photos.map((p) => p.id),
    ).toEqual(['b']);
    index.close();

    const db = new DatabaseSync(file);
    try {
      const plan = db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT json FROM photos WHERE folder = ? ORDER BY capture_time, file_name',
        )
        .all('/photos/one') as unknown as { detail: string }[];
      expect(plan.map((row) => row.detail).join('\n')).toContain('photos_folder');
      const indexes = db.prepare('PRAGMA index_list(photos)').all() as unknown as {
        name: string;
      }[];
      expect(indexes.map((row) => row.name)).toEqual(
        expect.arrayContaining(['photos_folder', 'photos_capture', 'photos_source', 'photos_path']),
      );
    } finally {
      db.close();
    }
  });

  it('counts the filter options and cameras for the scope in one grouped query', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ee-index-facets-'));
    dirs.push(dir);
    const index = new PhotoIndex(join(dir, 'index.sqlite'));
    const base = photo('a', '/photos/game/a.NEF', { tagged: true, rating: 5 });
    index.save(base);
    index.save(photo('b', '/photos/game/b.NEF', { rating: 3 }));
    index.save(
      photo('c', '/photos/game/c.NEF', {
        camera: { model: 'NIKON Z 8', serialNumber: '2' },
        status: { ...base.status, edited: true, upload: 'failed' },
      }),
    );
    index.save(photo('d', '/photos/other/d.NEF', { tagged: true }));

    const all = index.facets({ folder: '/photos/game' });
    expect(all.scopeTotal).toBe(3);
    expect(all.shown).toBe(3);
    expect(all.tag).toEqual({ all: 3, tagged: 1, untagged: 2 });
    expect(all.status['not-sent']).toBe(3);
    expect(all.status.failed).toBe(1);
    expect(all.status.edited).toBe(1);
    expect(all.cameras).toEqual([
      { key: 'NIKON Z 8|2', label: 'NIKON Z 8 · 2', count: 1 },
      { key: 'NIKON Z 9|1', label: 'NIKON Z 9 · 1', count: 2 },
    ]);

    const tagged = index.facets({ folder: '/photos/game', filter: { tag: 'tagged' } });
    expect(tagged.shown).toBe(1);
    expect(tagged.status['not-sent']).toBe(1);
    const rated = index.facets({ folder: '/photos/game', filter: { minRating: 4 } });
    expect(rated.scopeTotal).toBe(3);
    expect(rated.shown).toBe(1);
    expect(rated.tag).toEqual({ all: 1, tagged: 1, untagged: 0 });
    // A search result too large for one IN list still counts through the temporary table.
    const huge = new Set(Array.from({ length: 5_100 }, (_, n) => `missing-${n}` as PhotoId));
    expect(index.facets({ ids: huge })).toMatchObject({ shown: 0, scopeTotal: 4 });
    index.close();
  });

  it('returns a page position and starts at the newest photos when asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ee-index-page-'));
    dirs.push(dir);
    const index = new PhotoIndex(join(dir, 'index.sqlite'));
    for (let n = 0; n < 10; n += 1) {
      index.save(
        photo(`p${n}`, `/photos/game/p${n}.NEF`, {
          captureTime: `2026-05-01T12:00:0${n}`,
        }),
      );
    }
    const first = index.query({ folder: '/photos/game', limit: 3 });
    expect(first.offset).toBe(0);
    expect(first.photos.map((entry) => entry.fileName)).toEqual(['p0.NEF', 'p1.NEF', 'p2.NEF']);
    const anchored = index.query({ folder: '/photos/game', anchorId: 'p9' as PhotoId, limit: 3 });
    expect(anchored.offset).toBe(8);
    expect(anchored.photos.map((entry) => entry.fileName)).toEqual(['p8.NEF', 'p9.NEF']);
    const newest = index.query({ folder: '/photos/game', fromEnd: true, limit: 3 });
    expect(newest.offset).toBe(7);
    expect(newest.photos.at(-1)?.fileName).toBe('p9.NEF');
    index.close();
  });

  it('migrates an index made before the query columns existed without losing a photo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ee-index-old-'));
    dirs.push(dir);
    const file = join(dir, 'index.sqlite');
    const old = photo('old', '/photos/season/old.NEF', { tagged: true, rating: 3 });
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE photos (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        template_path TEXT,
        json TEXT NOT NULL
      );
      CREATE TABLE removed_paths (path TEXT PRIMARY KEY);
      CREATE TABLE added_folders (path TEXT PRIMARY KEY);
    `);
    db.prepare('INSERT INTO photos (id, source_id, path, json) VALUES (?, ?, ?, ?)').run(
      old.id,
      old.sourceId,
      old.path,
      JSON.stringify(old),
    );
    db.close();

    const index = new PhotoIndex(file);
    try {
      expect(index.get(old.id)?.photo).toEqual(old);
      expect(index.folders([])).toEqual([{ path: '/photos/season', count: 1 }]);
      expect(index.query({ filter: { tag: 'tagged' } }).photos.map((p) => p.id)).toEqual([old.id]);
    } finally {
      index.close();
    }

    const reopened = new DatabaseSync(file);
    try {
      expect(reopened.prepare('SELECT COUNT(*) AS count FROM photos').get()).toEqual({ count: 1 });
    } finally {
      reopened.close();
    }
  });

  it('removes a folder of ids in one transaction and remembers every path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ee-index-remove-'));
    dirs.push(dir);
    const index = new PhotoIndex(join(dir, 'index.sqlite'));
    const ids = ['a', 'b', 'c'].map((name) => name as PhotoId);
    for (const id of ids) index.save(photo(id, `/photos/game/${id}.NEF`));
    const removed = index.removeManyAndExclude(ids);
    expect(removed.sort()).toEqual(['a', 'b', 'c']);
    expect(index.count()).toBe(0);
    expect([...index.excludedPaths()].sort()).toEqual([
      '/photos/game/a.NEF',
      '/photos/game/b.NEF',
      '/photos/game/c.NEF',
    ]);
    // A second request for the same ids is not an error and changes nothing.
    expect(index.removeManyAndExclude(ids)).toEqual([]);
    expect([...index.excludedPaths()]).toHaveLength(3);
    index.close();
    await sleep();
  });
});

const withFilter = (patch: Partial<FilterState>): FilterState => ({ ...initialFilter(), ...patch });

const withStatus = (patch: Partial<Photo['status']>): Photo['status'] => ({
  ...photo('x', 'x').status,
  ...patch,
});

/**
 * The renderer filter and the index have to agree: the same photos in the same order, and the
 * same numbers next to the options. Each case runs both and compares.
 */
function expectSameAsRenderer(index: PhotoIndex, photos: Photo[], filter: FilterState): void {
  const expected = filterPhotos(photos, filter).map((entry) => entry.id);
  const page = index.query({ filter: queryFilter(filter), sort: 'filename', limit: 1000 });
  expect(page.photos.map((entry) => entry.id).sort()).toEqual([...expected].sort());
  expect(page.total).toBe(expected.length);

  const counts = filterCounts(photos, filter);
  const facets = index.facets({ filter: queryFilter(filter) });
  expect(facets.shown).toBe(counts.shown);
  expect(facets.tag).toEqual(counts.tag);
  expect(facets.status).toEqual(counts.status);
}

describe('the index and the renderer filter agree', () => {
  const photos: Photo[] = [
    photo('a', '/p/a.NEF', { rating: 5, colorClass: 1, tagged: true }),
    photo('b', '/p/b.NEF', { rating: 3, colorClass: 3, status: withStatus({ export: 'done' }) }),
    photo('c', '/p/c.NEF', {
      rating: 3,
      colorClass: 0,
      status: withStatus({ export: 'done', upload: 'done' }),
    }),
    photo('d', '/p/d.NEF', { rating: 0, colorClass: 5, status: withStatus({ export: 'failed' }) }),
    photo('e', '/p/e.NEF', { rating: 1, colorClass: 1, status: withStatus({ upload: 'failed' }) }),
    photo('f', '/p/f.NEF', {
      rating: 4,
      colorClass: 0,
      status: withStatus({ export: 'encoding' }),
    }),
    photo('g', '/p/g.NEF', { rating: 0, colorClass: 2, tagged: true }),
  ];
  const withIndex = async (run: (index: PhotoIndex) => void): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'ee-index-parity-'));
    dirs.push(dir);
    const index = new PhotoIndex(join(dir, 'index.sqlite'));
    try {
      for (const entry of photos) index.save(entry);
      run(index);
    } finally {
      index.close();
    }
  };

  it('the export statuses, alone and with the others', async () => {
    await withIndex((index) => {
      for (const filter of [
        withFilter({ statuses: ['exported'] }),
        withFilter({ statuses: ['not-exported'] }),
        withFilter({ statuses: ['not-exported', 'not-sent'] }),
        withFilter({ statuses: ['exported', 'not-exported'] }),
        withFilter({ minRating: 3, statuses: ['not-exported', 'not-sent'] }),
        withFilter({ tag: 'tagged', statuses: ['not-exported'] }),
      ]) {
        expectSameAsRenderer(index, photos, filter);
      }
      const facets = index.facets({ filter: { statuses: ['not-exported'] } });
      expect(facets.status.exported).toBe(0);
      expect(facets.status['not-exported']).toBe(5);
      expect(index.facets({}).status.exported).toBe(2);
    });
  });

  it('counts exported and not exported for an index saved before the export column existed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ee-index-export-old-'));
    dirs.push(dir);
    const file = join(dir, 'index.sqlite');
    const done = photo('done', '/p/done.NEF', { status: withStatus({ export: 'done' }) });
    const fresh = photo('fresh', '/p/fresh.NEF');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE photos (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        folder TEXT, file_name TEXT, capture_time TEXT, tagged INTEGER, rating INTEGER,
        color_class INTEGER, edited INTEGER, upload TEXT, metadata_differs INTEGER,
        camera_key TEXT, template_path TEXT, source_path TEXT, search_text TEXT,
        json TEXT NOT NULL
      );
    `);
    const insert = db.prepare(
      `INSERT INTO photos (id, source_id, path, folder, file_name, tagged, rating, color_class,
         edited, upload, metadata_differs, camera_key, json)
       VALUES (?, ?, ?, '/p', ?, 0, 0, 0, 0, 'none', 0, '', ?)`,
    );
    for (const entry of [done, fresh]) {
      insert.run(entry.id, entry.sourceId, entry.path, entry.fileName, JSON.stringify(entry));
    }
    db.close();
    const index = new PhotoIndex(file);
    try {
      expect(index.query({ filter: { statuses: ['exported'] } }).photos.map((p) => p.id)).toEqual([
        'done',
      ]);
      expect(
        index.query({ filter: { statuses: ['not-exported'] } }).photos.map((p) => p.id),
      ).toEqual(['fresh']);
    } finally {
      index.close();
    }
  });
});
