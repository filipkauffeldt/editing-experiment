// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Photo, PhotoId } from '@ee/contracts';
import { PhotoIndex } from '../src/jobs/backend/photo-index';

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
