// @vitest-environment node
import { IpcError, asPhotoId, asSourceId, type IpcHandlers, type Photo } from '@ee/contracts';
import { ensureXmpFile } from '@ee/metadata';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend, type Backend } from '../src/jobs/backend/backend';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { copyInto, fixtureNefs, sampleNefs } from './helpers/fixtures';

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-remove-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const jpeg = (path: string, colour = '#468'): Promise<unknown> =>
  sharp({ create: { width: 80, height: 60, channels: 3, background: colour } })
    .jpeg()
    .toFile(path);

/** Every file below `dir` with its bytes and mtime: the proof that nothing was written. */
async function snapshot(dir: string): Promise<Record<string, { bytes: string; mtimeMs: number }>> {
  const result: Record<string, { bytes: string; mtimeMs: number }> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        result[path.slice(dir.length)] = {
          bytes: (await readFile(path)).toString('base64'),
          mtimeMs: (await stat(path)).mtimeMs,
        };
      }
    }
  };
  await walk(dir);
  return result;
}

/** A trash that records calls: removing from the Library must never ask for it. */
const trashCalls: string[] = [];
const trashItem = async (path: string): Promise<void> => {
  trashCalls.push(path);
  throw new Error('the trash must not be used here');
};

interface Harness {
  root: string;
  source: string;
  destination: string;
  backup: string;
  userData: string;
  backend: Backend;
  handlers: IpcHandlers;
  events: { channel: string; payload: unknown }[];
}

async function start(
  root: string,
  trash: (path: string) => Promise<void> = trashItem,
  destinationName = 'ingest',
): Promise<Harness> {
  const source = join(root, 'card');
  const destination = join(root, destinationName);
  const backup = join(root, 'backup');
  const userData = join(root, 'userdata');
  for (const dir of [source, destination, backup]) await mkdir(dir, { recursive: true });
  const events: Harness['events'] = [];
  const backend = await createBackend({
    userDataDir: userData,
    appVersion: 'test',
    homeDir: root,
    emit: (channel, payload) => events.push({ channel, payload }),
    getSecret: async () => ({}),
    trashItem: trash,
  });
  const handlers = backend.handlers as IpcHandlers;
  const { ingest } = await handlers['settings:get']();
  await handlers['settings:set']({
    ingest: { ...ingest, destination: { path: destination }, backupDestination: { path: backup } },
  });
  await backend.reconciled;
  return { root, source, destination, backup, userData, backend, handlers, events };
}

/** Ingest the card folder (keeping names) and wait until `expected` photos are indexed. */
async function ingestCard(
  harness: Harness,
  expected: number,
  incremental = true,
): Promise<Photo[]> {
  const { ingest } = await harness.handlers['settings:get']();
  await harness.handlers['ingest:start']({
    config: {
      ...ingest,
      sources: [
        { id: asSourceId('card'), name: 'card', kind: 'folder', path: harness.source, incremental },
      ],
      fileNaming: 'keep',
      renameTemplate: '{filenamebase}',
    },
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const photos = await harness.handlers['photos:list']();
    const runs = await harness.handlers['ingest:status']();
    const settled = runs.every((run) => run.state === 'finished' || run.state === 'failed');
    if (photos.length >= expected && settled) {
      // The search index reads captions in the background. On Windows a file it still has open
      // cannot be renamed or removed (EPERM), so settle it before a test touches the folder.
      await harness.backend.searchIdle();
      return photos;
    }
    if (Date.now() > deadline) throw new Error(`timed out; ${photos.length}/${expected}`);
    await sleep(50);
  }
}

const byName = (photos: Photo[], name: string): Photo => {
  const photo = photos.find((candidate) => candidate.fileName === name);
  if (!photo) throw new Error(`no photo ${name}`);
  return photo;
};

const names = async (harness: Harness): Promise<string[]> =>
  (await harness.handlers['photos:list']()).map((photo) => photo.fileName);

describe(
  'removing photos from the Library (real backend, real folders)',
  { timeout: 120_000 },
  () => {
    it('drops the entry and its data and leaves every file, byte and mtime, as it was', async () => {
      const root = await tempDir();
      const harness = await start(root);
      try {
        for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) await jpeg(join(harness.source, name));
        const photos = await ingestCard(harness, 3);
        const victim = byName(photos, 'b.jpg');
        // A sidecar of the photo, as a raw's would be, and an old mtime to notice a touch.
        const sidecar = join(harness.destination, 'b.xmp');
        await writeFile(sidecar, '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
        const longAgo = new Date('2020-01-02T03:04:05Z');
        await utimes(victim.path, longAgo, longAgo);
        await utimes(sidecar, longAgo, longAgo);
        const thumb = join(harness.backend.layout.thumbDir, `${victim.id}.jpg`);
        expect(await stat(thumb).then(() => true)).toBe(true);
        const before = {
          destination: await snapshot(harness.destination),
          backup: await snapshot(harness.backup),
          source: await snapshot(harness.source),
        };

        const result = await harness.handlers['photos:removeFromLibrary']({
          photoIds: [victim.id],
        });

        expect(result).toEqual({ deleted: [victim.id], failed: [] });
        expect(await names(harness)).toEqual(['a.jpg', 'c.jpg']);
        await expect(harness.handlers['photos:get']({ photoId: victim.id })).rejects.toMatchObject({
          code: 'not_found',
        });
        expect(harness.events).toContainEqual({
          channel: 'photos:removed',
          payload: { photoId: victim.id },
        });
        // The app's own cached data for it is gone ...
        await expect(stat(thumb)).rejects.toMatchObject({ code: 'ENOENT' });
        // ... and no file the user owns changed: not the photo, not the sidecar, not the others.
        expect(await snapshot(harness.destination)).toEqual(before.destination);
        expect(await snapshot(harness.backup)).toEqual(before.backup);
        expect(await snapshot(harness.source)).toEqual(before.source);
        expect(trashCalls).toEqual([]);
      } finally {
        await harness.backend.dispose();
      }
    });

    it('stays removed after a restart while its file is still on disk', async () => {
      const root = await tempDir();
      const first = await start(root);
      try {
        for (const name of ['a.jpg', 'b.jpg']) await jpeg(join(first.source, name));
        const photos = await ingestCard(first, 2);
        await first.handlers['photos:removeFromLibrary']({
          photoIds: [byName(photos, 'a.jpg').id],
        });
      } finally {
        await first.backend.dispose();
      }

      // "Restart": a new backend on the same user data runs the reconcile over the destination.
      const second = await start(root);
      try {
        expect(await second.backend.reconcile()).toBe(0);
        expect(await names(second)).toEqual(['b.jpg']);
        expect(await readdir(second.destination)).toEqual(['a.jpg', 'b.jpg']);
      } finally {
        await second.backend.dispose();
      }
    });

    it('leaves Delete… alone: it remembers no path, so a new file at a deleted path is indexed', async () => {
      const root = await tempDir();
      const trashDir = join(root, 'trash');
      const moveToTrash = async (path: string): Promise<void> => {
        await mkdir(trashDir, { recursive: true });
        await rename(path, join(trashDir, 'trashed.jpg'));
      };
      const first = await start(root, moveToTrash);
      let path: string;
      try {
        await jpeg(join(first.source, 'a.jpg'));
        const [photo] = await ingestCard(first, 1);
        path = photo!.path;
        expect(await first.handlers['photos:delete']({ photoIds: [photo!.id] })).toEqual({
          deleted: [photo!.id],
          failed: [],
        });
      } finally {
        await first.backend.dispose();
      }
      const index = new PhotoIndex(first.backend.layout.indexDb);
      try {
        expect(index.excludedPaths().size).toBe(0);
      } finally {
        index.close();
      }
      // Something puts a new file at the same path; the startup scan finds it as before.
      await jpeg(path, '#c40');

      const second = await start(root, moveToTrash);
      try {
        expect(await second.backend.reconcile()).toBe(0);
        expect(await names(second)).toEqual(['a.jpg']);
      } finally {
        await second.backend.dispose();
      }
    });

    it('indexes a later ingest to the same path, and keeps indexing it after a restart', async () => {
      const root = await tempDir();
      const first = await start(root);
      let path: string;
      try {
        await jpeg(join(first.source, 'a.jpg'), '#468');
        const [photo] = await ingestCard(first, 1);
        path = photo!.path;
        // Deleted outside the app, then removed from the Library.
        await rm(path);
        // The backup copy is gone too, or ingest would see the name as taken.
        await rm(join(first.backup, 'a.jpg'));
        await first.handlers['photos:removeFromLibrary']({ photoIds: [photo!.id] });
        expect(await names(first)).toEqual([]);

        // A different shot with the same name arrives (incremental off: the card is read again).
        await jpeg(join(first.source, 'a.jpg'), '#c40');
        await ingestCard(first, 1, false);
        const photos = await first.handlers['photos:list']();
        expect(photos.map((p) => p.path)).toEqual([path]);
        expect(photos[0]!.id).not.toBe(photo!.id);
      } finally {
        await first.backend.dispose();
      }
      // The path is not hidden any more.
      const index = new PhotoIndex(first.backend.layout.indexDb);
      try {
        expect(index.excludedPaths().has(path)).toBe(false);
      } finally {
        index.close();
      }

      const second = await start(root);
      try {
        expect(await second.backend.reconcile()).toBe(0);
        expect(await names(second)).toEqual(['a.jpg']);
      } finally {
        await second.backend.dispose();
      }
    });

    it('removes an entry whose file is already missing, without an error', async () => {
      const root = await tempDir();
      const harness = await start(root);
      try {
        await jpeg(join(harness.source, 'a.jpg'));
        await jpeg(join(harness.source, 'b.jpg'));
        const photos = await ingestCard(harness, 2);
        const gone = byName(photos, 'a.jpg');
        await rm(gone.path);
        harness.events.length = 0;

        const result = await harness.handlers['photos:removeFromLibrary']({ photoIds: [gone.id] });

        expect(result).toEqual({ deleted: [gone.id], failed: [] });
        expect(await names(harness)).toEqual(['b.jpg']);
        expect(harness.events.filter((e) => e.channel === 'jobs:event')).toEqual([]);
        // A repeated request, or an id the index never had, is not an error either.
        expect(
          await harness.handlers['photos:removeFromLibrary']({
            photoIds: [gone.id, asPhotoId('never-existed')],
          }),
        ).toEqual({ deleted: [gone.id, asPhotoId('never-existed')], failed: [] });
        expect(trashCalls).toEqual([]);
      } finally {
        await harness.backend.dispose();
      }
    });

    it('works with the destination drive unplugged', async () => {
      const root = await tempDir();
      const harness = await start(root);
      try {
        for (const name of ['a.jpg', 'b.jpg']) await jpeg(join(harness.source, name));
        const photos = await ingestCard(harness, 2);
        // "Unplug": the whole folder disappears from where the app expects it.
        await rename(harness.destination, join(root, 'unplugged'));

        const result = await harness.handlers['photos:removeFromLibrary']({
          photoIds: photos.map((photo) => photo.id),
        });

        expect(result).toEqual({ deleted: photos.map((photo) => photo.id), failed: [] });
        expect(await names(harness)).toEqual([]);
        expect(trashCalls).toEqual([]);
        // Plugged in again: the files are untouched and, being removed, are not brought back.
        await rename(join(root, 'unplugged'), harness.destination);
        expect(await readdir(harness.destination)).toEqual(['a.jpg', 'b.jpg']);
      } finally {
        await harness.backend.dispose();
      }
      const second = await start(root);
      try {
        expect(await second.backend.reconcile()).toBe(0);
        expect(await names(second)).toEqual([]);
      } finally {
        await second.backend.dispose();
      }
    });

    it('does not let a save, label or preview that was queued behind it write anything', async () => {
      const root = await tempDir();
      const harness = await start(root);
      try {
        await jpeg(join(harness.source, 'a.jpg'));
        const [photo] = await ingestCard(harness, 1);
        const before = await snapshot(harness.destination);
        const rgba = (size: number) => ({
          width: size,
          height: size,
          rgba: new Uint8Array(size * size * 4),
        });

        // Issued without waiting, so they queue behind the removal on the photo's lock.
        const removing = harness.handlers['photos:removeFromLibrary']({ photoIds: [photo!.id] });
        const saves = [
          harness.handlers['develop:setParams']({
            photoId: photo!.id,
            params: { Exposure2012: 1 },
          }),
          harness.handlers['photos:setLabels']({ photoIds: [photo!.id], rating: 4 }),
          harness.handlers['metadata:write']({ photoId: photo!.id, fields: { caption: 'late' } }),
          harness.handlers['retouch:set']({ photoId: photo!.id, ops: [] }),
          harness.handlers['photos:setEditedPreview']({
            photoId: photo!.id,
            revision: 5,
            retouchOps: [],
            params: { Exposure2012: 1 },
            thumb: rgba(4),
            preview: rgba(8),
          }),
        ];
        const outcomes = await Promise.allSettled(saves);
        expect((await removing).deleted).toEqual([photo!.id]);

        for (const outcome of outcomes) {
          expect(outcome.status).toBe('rejected');
          expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(IpcError);
          expect((outcome as PromiseRejectedResult).reason.code).toBe('not_found');
        }
        expect(await names(harness)).toEqual([]);
        expect(await snapshot(harness.destination)).toEqual(before);
        const cached = [
          ...(await readdir(harness.backend.layout.thumbDir).catch(() => [])),
          ...(await readdir(harness.backend.layout.previewDir).catch(() => [])),
        ];
        expect(cached.filter((name) => name.startsWith(photo!.id))).toEqual([]);
      } finally {
        await harness.backend.dispose();
      }
    });

    it('rejects anything but a list of ids', async () => {
      const root = await tempDir();
      const harness = await start(root);
      try {
        await expect(
          harness.handlers['photos:removeFromLibrary']({ photoIds: '/etc/passwd' } as never),
        ).rejects.toMatchObject({ code: 'invalid_argument' });
        await expect(
          harness.handlers['photos:removeFromLibrary']({ photoIds: [{ path: '/x' }] } as never),
        ).rejects.toMatchObject({ code: 'invalid_argument' });
      } finally {
        await harness.backend.dispose();
      }
    });

    it('opens an index made before the removed-paths table existed', async () => {
      const root = await tempDir();
      const file = join(root, 'old.sqlite');
      const { DatabaseSync } = await import('node:sqlite');
      const old = new DatabaseSync(file);
      old.exec(`CREATE TABLE photos (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL, path TEXT NOT NULL, template_path TEXT, source_path TEXT,
      json TEXT NOT NULL);`);
      const photo = { id: 'old', path: '/x/a.jpg', fileName: 'a.jpg', sourceId: 'card' };
      old
        .prepare('INSERT INTO photos (id, source_id, path, json) VALUES (?, ?, ?, ?)')
        .run('old', 'card', '/x/a.jpg', JSON.stringify(photo));
      old.close();

      const index = new PhotoIndex(file);
      try {
        expect(index.get(asPhotoId('old'))).toMatchObject({ photo: { fileName: 'a.jpg' } });
        expect(index.excludedPaths().size).toBe(0);
        expect(index.removeAndExclude(asPhotoId('old'))).toBe(true);
        expect([...index.excludedPaths()]).toEqual(['/x/a.jpg']);
      } finally {
        index.close();
      }
      // And the remembered path survives closing and opening the file again.
      const again = new PhotoIndex(file);
      try {
        expect([...again.excludedPaths()]).toEqual(['/x/a.jpg']);
      } finally {
        again.close();
      }
    });
  },
);

const nef = fixtureNefs()[0] ?? sampleNefs()[0];

describe.skipIf(!nef)('removing a raw from the Library', { timeout: 180_000 }, () => {
  it('leaves the raw and its XMP sidecar untouched and writes nothing', async () => {
    const root = await tempDir();
    const harness = await start(root);
    try {
      copyInto(nef!, join(harness.source, 'raw1.NEF'));
      await ensureXmpFile(join(harness.source, 'raw1.xmp'));
      const [photo] = await ingestCard(harness, 1);
      await harness.handlers['photos:setLabels']({ photoIds: [photo!.id], rating: 3 });
      expect(await readdir(harness.destination)).toEqual(['raw1.NEF', 'raw1.xmp']);
      const sidecarTime = new Date('2021-05-06T07:08:09Z');
      await utimes(photo!.sidecarPath, sidecarTime, sidecarTime);
      await utimes(photo!.path, sidecarTime, sidecarTime);
      const before = await snapshot(harness.destination);
      const backupBefore = await snapshot(harness.backup);

      const result = await harness.handlers['photos:removeFromLibrary']({ photoIds: [photo!.id] });

      expect(result.deleted).toEqual([photo!.id]);
      expect(await snapshot(harness.destination)).toEqual(before);
      expect(await snapshot(harness.backup)).toEqual(backupBefore);
      expect(trashCalls).toEqual([]);
    } finally {
      await harness.backend.dispose();
    }
    const second = await start(root);
    try {
      expect(await second.backend.reconcile()).toBe(0);
      expect(await names(second)).toEqual([]);
    } finally {
      await second.backend.dispose();
    }
  });
});
