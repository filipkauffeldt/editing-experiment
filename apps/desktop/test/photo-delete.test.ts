// @vitest-environment node
import {
  IpcError,
  asPhotoId,
  asSourceId,
  type IpcHandlers,
  type Photo,
  type PhotoId,
  type SourceConfig,
} from '@ee/contracts';
import { ensureXmpFile } from '@ee/metadata';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend, type Backend } from '../src/jobs/backend/backend';
import { PhotoDeleter } from '../src/jobs/backend/photo-deleter';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { copyInto, fixtureNefs } from './helpers/fixtures';

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  // realpath-stable (the temp dir may itself be a symlink on macOS).
  const dir = await mkdtemp(join(tmpdir(), 'ee-delete-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const jpeg = (path: string, colour = '#468'): Promise<unknown> =>
  sharp({ create: { width: 80, height: 60, channels: 3, background: colour } })
    .jpeg()
    .toFile(path);

/**
 * A stand-in for the system trash that really moves the file (into a folder of the test), so
 * "gone from the destination" is a fact on disk. `failOn` makes chosen paths fail like a
 * volume without a trash would.
 */
class FakeTrash {
  readonly calls: string[] = [];
  failOn: (path: string) => boolean = () => false;
  /**
   * What a failing call throws. The default has a code that is not a lock, so the deleter treats
   * it as final and tests of a permanent failure see exactly one call per file.
   */
  failure: () => Error = () =>
    Object.assign(new Error('the volume has no trash'), { code: 'ENOSPC' });
  private count = 0;

  constructor(readonly directory: string) {}

  readonly trash = async (path: string): Promise<void> => {
    this.calls.push(path);
    if (this.failOn(path)) throw this.failure();
    await mkdir(this.directory, { recursive: true });
    await rename(path, join(this.directory, `${++this.count}-${basename(path)}`));
  };

  async trashed(): Promise<string[]> {
    return (await exists(this.directory)) ? (await readdir(this.directory)).sort() : [];
  }
}

interface Harness {
  root: string;
  source: string;
  destination: string;
  backup: string;
  userData: string;
  trash: FakeTrash;
  backend: Backend;
  handlers: IpcHandlers;
  events: { channel: string; payload: unknown }[];
}

async function start(root: string, trash: FakeTrash, destinationName = 'ingest'): Promise<Harness> {
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
    trashItem: trash.trash,
  });
  const handlers = backend.handlers as IpcHandlers;
  const { ingest } = await handlers['settings:get']();
  await handlers['settings:set']({
    ingest: { ...ingest, destination: { path: destination }, backupDestination: { path: backup } },
  });
  await backend.reconciled;
  return { root, source, destination, backup, userData, trash, backend, handlers, events };
}

/** Copy the files of the card folder with the app's ingest (keeping names), waiting for it to finish. */
async function ingestCard(harness: Harness, expected: number): Promise<Photo[]> {
  const { ingest } = await harness.handlers['settings:get']();
  const sources: SourceConfig[] = [
    { id: asSourceId('card'), name: 'card', kind: 'folder', path: harness.source },
  ];
  await harness.handlers['ingest:start']({
    config: { ...ingest, sources, fileNaming: 'keep', renameTemplate: '{filenamebase}' },
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const photos = await harness.handlers['photos:list']();
    const runs = await harness.handlers['ingest:status']();
    const settled = runs.every((run) => run.state === 'finished' || run.state === 'failed');
    if (photos.length >= expected && settled) return photos;
    if (Date.now() > deadline) throw new Error(`timed out; ${photos.length}/${expected}`);
    await sleep(50);
  }
}

const byName = (photos: Photo[], name: string): Photo => {
  const photo = photos.find((candidate) => candidate.fileName === name);
  if (!photo) throw new Error(`no photo ${name}`);
  return photo;
};

describe('deleting photos (real backend, real folders)', { timeout: 120_000 }, () => {
  it('moves the file to the trash, drops the entry and its data, and leaves backup and source alone', async () => {
    const root = await tempDir();
    const harness = await start(root, new FakeTrash(join(root, 'trash')));
    try {
      for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) await jpeg(join(harness.source, name));
      const photos = await ingestCard(harness, 3);
      const victim = byName(photos, 'b.jpg');
      const thumb = join(harness.backend.layout.thumbDir, `${victim.id}.jpg`);
      const preview = join(harness.backend.layout.previewDir, `${victim.id}.jpg`);
      expect(await exists(thumb)).toBe(true);
      const sourceBefore = await readFile(join(harness.source, 'b.jpg'));
      const backupBefore = await readFile(join(harness.backup, 'b.jpg'));

      const result = await harness.handlers['photos:delete']({ photoIds: [victim.id] });

      expect(result).toEqual({ deleted: [victim.id], failed: [] });
      // In the (fake) trash, not in the destination; the trash was asked once for this file only.
      expect(await exists(victim.path)).toBe(false);
      expect(await harness.trash.trashed()).toEqual([expect.stringMatching(/-b\.jpg$/)]);
      expect(harness.trash.calls).toEqual([victim.path]);
      // The entry and the data kept for it are gone.
      await expect(harness.handlers['photos:get']({ photoId: victim.id })).rejects.toMatchObject({
        code: 'not_found',
      });
      expect((await harness.handlers['photos:list']()).map((p) => p.fileName)).toEqual([
        'a.jpg',
        'c.jpg',
      ]);
      expect(await exists(thumb)).toBe(false);
      expect(await exists(preview)).toBe(false);
      expect(harness.events).toContainEqual({
        channel: 'photos:removed',
        payload: { photoId: victim.id },
      });
      // The backup copy and the card are exactly as they were; the other photos are intact.
      expect(await readFile(join(harness.backup, 'b.jpg'))).toEqual(backupBefore);
      expect(await readFile(join(harness.source, 'b.jpg'))).toEqual(sourceBefore);
      expect(await exists(byName(photos, 'a.jpg').path)).toBe(true);
      expect(await exists(byName(photos, 'c.jpg').path)).toBe(true);
      expect(await readdir(harness.source)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    } finally {
      await harness.backend.dispose();
    }
  });

  it('is not indexed again by the startup reconcile, nor ingested again from the same card', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const first = await start(root, trash);
    let victim: Photo;
    try {
      for (const name of ['a.jpg', 'b.jpg']) await jpeg(join(first.source, name));
      victim = byName(await ingestCard(first, 2), 'a.jpg');
      await first.handlers['photos:delete']({ photoIds: [victim.id] });
    } finally {
      await first.backend.dispose();
    }

    // "Restart": a new backend on the same user data runs reconcile over the destination.
    const second = await start(root, trash);
    try {
      expect(await second.backend.reconcile()).toBe(0);
      expect((await second.handlers['photos:list']()).map((p) => p.fileName)).toEqual(['b.jpg']);
      expect(await readdir(second.destination)).toEqual(['b.jpg']);

      // Known behaviour: the seen store is keyed on the card's file, so ingesting the card
      // again does not bring the deleted photo back.
      await ingestCard(second, 1);
      await sleep(300);
      expect((await second.handlers['photos:list']()).map((p) => p.fileName)).toEqual(['b.jpg']);
      expect(await exists(victim.path)).toBe(false);
    } finally {
      await second.backend.dispose();
    }
  });

  it('keeps the file and the entry when the trash fails, and names the photo', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const harness = await start(root, trash);
    try {
      await jpeg(join(harness.source, 'a.jpg'));
      const [photo] = await ingestCard(harness, 1);
      trash.failOn = () => true;

      const result = await harness.handlers['photos:delete']({ photoIds: [photo!.id] });

      expect(result.deleted).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({ photoId: photo!.id });
      expect(result.failed[0]!.message).toContain('a.jpg');
      expect(result.failed[0]!.message).toContain('the volume has no trash');
      // Nothing was deleted anywhere: no permanent-delete fallback.
      expect(await exists(photo!.path)).toBe(true);
      expect(await harness.handlers['photos:get']({ photoId: photo!.id })).toMatchObject({
        id: photo!.id,
      });
      expect(await exists(join(harness.backend.layout.thumbDir, `${photo!.id}.jpg`))).toBe(true);
      expect(harness.events.some((e) => e.channel === 'photos:removed')).toBe(false);

      // Once the trash works again the same photo can be deleted.
      trash.failOn = () => false;
      expect(await harness.handlers['photos:delete']({ photoIds: [photo!.id] })).toEqual({
        deleted: [photo!.id],
        failed: [],
      });
    } finally {
      await harness.backend.dispose();
    }
  });

  it('reports each photo of a batch: the ones that failed stay, the others go', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const harness = await start(root, trash);
    try {
      for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) await jpeg(join(harness.source, name));
      const photos = await ingestCard(harness, 3);
      const [a, b, c] = ['a.jpg', 'b.jpg', 'c.jpg'].map((name) => byName(photos, name));
      trash.failOn = (path) => basename(path) === 'b.jpg';

      const result = await harness.handlers['photos:delete']({
        photoIds: [a!.id, b!.id, c!.id, a!.id],
      });

      expect(result.deleted).toEqual([a!.id, c!.id]);
      expect(result.failed.map((f) => f.photoId)).toEqual([b!.id]);
      expect(result.failed[0]!.message).toContain('b.jpg');
      expect((await harness.handlers['photos:list']()).map((p) => p.fileName)).toEqual(['b.jpg']);
      expect(await exists(b!.path)).toBe(true);
      expect(await exists(a!.path)).toBe(false);
      expect(await exists(c!.path)).toBe(false);
    } finally {
      await harness.backend.dispose();
    }
  });

  it('just drops the entry of a file that is already gone from disk, without asking the trash', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const harness = await start(root, trash);
    try {
      await jpeg(join(harness.source, 'a.jpg'));
      const [photo] = await ingestCard(harness, 1);
      await rm(photo!.path);

      const result = await harness.handlers['photos:delete']({ photoIds: [photo!.id] });

      expect(result).toEqual({ deleted: [photo!.id], failed: [] });
      expect(trash.calls).toEqual([]);
      expect(await harness.handlers['photos:list']()).toEqual([]);
      // Deleting an id the index no longer knows is not an error either (a repeated request).
      expect(await harness.handlers['photos:delete']({ photoIds: [photo!.id] })).toEqual({
        deleted: [photo!.id],
        failed: [],
      });
    } finally {
      await harness.backend.dispose();
    }
  });

  it('refuses a photo whose copy is inside a configured folder or card source', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const harness = await start(root, trash);
    try {
      await jpeg(join(harness.source, 'a.jpg'));
      await jpeg(join(harness.source, 'b.jpg'));
      const [a, b] = ['a.jpg', 'b.jpg'].map((name) => name);
      const photos = await ingestCard(harness, 2);
      // A folder source that covers the destination, and a card mounted over it.
      await harness.handlers['sources:save']({
        source: { id: asSourceId('wide'), name: 'wide', kind: 'folder', path: harness.root },
      });
      const first = await harness.handlers['photos:delete']({
        photoIds: [byName(photos, a!).id],
      });
      expect(first.deleted).toEqual([]);
      expect(first.failed[0]!.message).toMatch(/inside a card or folder source/);

      await harness.handlers['sources:remove']({ sourceId: asSourceId('wide') });
      await harness.handlers['sources:save']({
        source: {
          id: asSourceId('card2'),
          name: 'card2',
          kind: 'card',
          mountPath: harness.destination,
        },
      });
      const second = await harness.handlers['photos:delete']({
        photoIds: [byName(photos, b!).id],
      });
      expect(second.deleted).toEqual([]);
      expect(second.failed[0]!.message).toMatch(/inside a card or folder source/);

      expect(trash.calls).toEqual([]);
      expect(await exists(byName(photos, a!).path)).toBe(true);
      expect(await exists(byName(photos, b!).path)).toBe(true);
      expect(await harness.handlers['photos:list']()).toHaveLength(2);
    } finally {
      await harness.backend.dispose();
    }
  });

  it('deletes a photo ingested into an earlier destination after the setting changed', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const harness = await start(root, trash, 'job-a');
    try {
      await jpeg(join(harness.source, 'a.jpg'));
      const [photo] = await ingestCard(harness, 1);
      // The next job: another destination.
      const { ingest } = await harness.handlers['settings:get']();
      await harness.handlers['settings:set']({
        ingest: { ...ingest, destination: { path: join(root, 'job-b') } },
      });

      expect(await harness.handlers['photos:delete']({ photoIds: [photo!.id] })).toEqual({
        deleted: [photo!.id],
        failed: [],
      });
      expect(await exists(photo!.path)).toBe(false);
      expect(trash.calls).toEqual([photo!.path]);
    } finally {
      await harness.backend.dispose();
    }
  });

  it('deletes an indexed copy while the destination setting is empty', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const first = await start(root, trash);
    let photo: Photo;
    try {
      await jpeg(join(first.source, 'a.jpg'));
      [photo] = (await ingestCard(first, 1)) as [Photo];
    } finally {
      await first.backend.dispose();
    }
    // A settings file that names no destination (edited by hand; the API refuses to save one).
    const file = join(root, 'userdata', 'settings.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.ingest.destination = { path: '' };
    await writeFile(file, JSON.stringify(saved));

    const backend = await createBackend({
      userDataDir: join(root, 'userdata'),
      appVersion: 'test',
      homeDir: root,
      emit: () => {},
      getSecret: async () => ({}),
      trashItem: trash.trash,
    });
    try {
      const handlers = backend.handlers as IpcHandlers;
      expect((await handlers['settings:get']()).ingest.destination.path).toBe('');
      expect(await handlers['photos:delete']({ photoIds: [photo.id] })).toEqual({
        deleted: [photo.id],
        failed: [],
      });
      expect(await exists(photo.path)).toBe(false);
    } finally {
      await backend.dispose();
    }
  });

  it('records the file a photo was ingested from, and keeps it for a photo found by the scan', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const harness = await start(root, trash);
    try {
      await jpeg(join(harness.source, 'a.jpg'));
      await jpeg(join(harness.destination, 'found.jpg'));
      await ingestCard(harness, 1);
      expect(await harness.backend.reconcile()).toBe(1);
    } finally {
      await harness.backend.dispose();
    }
    const index = new PhotoIndex(join(root, 'userdata', 'index.sqlite'));
    try {
      const records = index.list().map((photo) => index.get(photo.id)!);
      const byName = Object.fromEntries(records.map((r) => [r.photo.fileName, r]));
      expect(byName['a.jpg']!.sourcePath).toBe(join(root, 'card', 'a.jpg'));
      expect(byName['found.jpg']!.photo.sourceId).toBe('recovered');
      expect(byName['found.jpg']!.sourcePath).toBeUndefined();
    } finally {
      index.close();
    }
  });

  it('opens an index made before the source column existed', async () => {
    const root = await tempDir();
    const file = join(root, 'old.sqlite');
    const { DatabaseSync } = await import('node:sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE photos (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL, path TEXT NOT NULL, template_path TEXT, json TEXT NOT NULL);`);
    const photo = { id: 'old', path: '/x/a.jpg', fileName: 'a.jpg', sourceId: 'card' };
    old
      .prepare('INSERT INTO photos (id, source_id, path, json) VALUES (?, ?, ?, ?)')
      .run('old', 'card', '/x/a.jpg', JSON.stringify(photo));
    old.close();

    const index = new PhotoIndex(file);
    try {
      expect(index.get(asPhotoId('old'))).toMatchObject({ photo: { fileName: 'a.jpg' } });
      expect(index.get(asPhotoId('old'))!.sourcePath).toBeUndefined();
      index.save(
        { ...index.get(asPhotoId('old'))!.photo, id: asPhotoId('new') },
        undefined,
        '/card/b.jpg',
      );
      expect(index.get(asPhotoId('new'))!.sourcePath).toBe('/card/b.jpg');
    } finally {
      index.close();
    }
  });

  it('does not let a save, label or preview that was queued behind the delete write anything', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const harness = await start(root, trash);
    try {
      await jpeg(join(harness.source, 'a.jpg'));
      const [photo] = await ingestCard(harness, 1);
      const rgba = (size: number) => ({
        width: size,
        height: size,
        rgba: new Uint8Array(size * size * 4),
      });

      // Issued without waiting, so they queue behind the delete on the photo's lock.
      const deleting = harness.handlers['photos:delete']({ photoIds: [photo!.id] });
      const saves = [
        harness.handlers['develop:setParams']({ photoId: photo!.id, params: { Exposure2012: 1 } }),
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
      expect((await deleting).deleted).toEqual([photo!.id]);

      for (const outcome of outcomes) {
        expect(outcome.status).toBe('rejected');
        expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(IpcError);
        expect((outcome as PromiseRejectedResult).reason.code).toBe('not_found');
      }
      // Nothing came back: no file at the old path, no entry, no edited previews.
      expect(await readdir(harness.destination)).toEqual([]);
      expect(await harness.handlers['photos:list']()).toEqual([]);
      const cached = [
        ...(await readdir(harness.backend.layout.thumbDir).catch(() => [])),
        ...(await readdir(harness.backend.layout.previewDir).catch(() => [])),
      ];
      expect(cached.filter((name) => name.startsWith(photo!.id))).toEqual([]);
    } finally {
      await harness.backend.dispose();
    }
  });

  it('lets an edit that was already saving finish before the file goes to the trash', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const harness = await start(root, trash);
    try {
      await jpeg(join(harness.source, 'a.jpg'));
      const [photo] = await ingestCard(harness, 1);

      const saving = harness.handlers['photos:setLabels']({ photoIds: [photo!.id], rating: 2 });
      const deleting = harness.handlers['photos:delete']({ photoIds: [photo!.id] });

      await expect(saving).resolves.toBeDefined();
      expect((await deleting).deleted).toEqual([photo!.id]);
      expect(await readdir(harness.destination)).toEqual([]);
    } finally {
      await harness.backend.dispose();
    }
  });
});

const nef = fixtureNefs()[0];

describe.skipIf(!nef)('deleting a raw with its XMP sidecar', { timeout: 180_000 }, () => {
  async function ingestRaw(harness: Harness): Promise<Photo> {
    copyInto(nef!, join(harness.source, 'raw1.NEF'));
    // A sidecar that came with the card, so the backup holds one too.
    await ensureXmpFile(join(harness.source, 'raw1.xmp'));
    const [photo] = await ingestCard(harness, 1);
    // An edit in the app writes the destination's sidecar.
    await harness.handlers['photos:setLabels']({ photoIds: [photo!.id], rating: 3 });
    expect(await exists(photo!.sidecarPath)).toBe(true);
    return photo!;
  }

  it('trashes both, leaves the backup copies and the card alone, and is not indexed again', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const first = await start(root, trash);
    let photo: Photo;
    try {
      photo = await ingestRaw(first);
      const sourceFiles = await readdir(first.source);
      const backupFiles = await readdir(first.backup);
      expect(backupFiles.sort()).toEqual(['raw1.NEF', 'raw1.xmp']);

      const result = await first.handlers['photos:delete']({ photoIds: [photo.id] });

      expect(result.deleted).toEqual([photo.id]);
      expect(await readdir(first.destination)).toEqual([]);
      expect((await trash.trashed()).map((name) => name.replace(/^\d+-/, '')).sort()).toEqual([
        'raw1.NEF',
        'raw1.xmp',
      ]);
      expect(trash.calls).toEqual([photo.sidecarPath, photo.path]);
      expect(await readdir(first.source)).toEqual(sourceFiles);
      expect((await readdir(first.backup)).sort()).toEqual(backupFiles);
    } finally {
      await first.backend.dispose();
    }

    const second = await start(root, trash);
    try {
      expect(await second.backend.reconcile()).toBe(0);
      expect(await second.handlers['photos:list']()).toEqual([]);
    } finally {
      await second.backend.dispose();
    }
  });

  it('deletes a raw and its sidecar after the destination setting changed, and it stays gone after a restart', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const first = await start(root, trash, 'job-a');
    let photo: Photo;
    try {
      photo = await ingestRaw(first);
      const { ingest } = await first.handlers['settings:get']();
      await first.handlers['settings:set']({
        ingest: { ...ingest, destination: { path: join(root, 'job-b') } },
      });

      const result = await first.handlers['photos:delete']({ photoIds: [photo.id] });

      expect(result.deleted).toEqual([photo.id]);
      expect(await readdir(join(root, 'job-a'))).toEqual([]);
      expect(trash.calls).toEqual([photo.sidecarPath, photo.path]);
    } finally {
      await first.backend.dispose();
    }

    // Back on the old destination, whose folder the startup scan reads: nothing is indexed.
    const second = await start(root, trash, 'job-a');
    try {
      expect(await second.backend.reconcile()).toBe(0);
      expect(await second.handlers['photos:list']()).toEqual([]);
    } finally {
      await second.backend.dispose();
    }
  });

  it('leaves everything in place when only the sidecar cannot be trashed, and nothing is re-indexed', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const first = await start(root, trash);
    let photo: Photo;
    try {
      photo = await ingestRaw(first);
      trash.failOn = (path) => path.endsWith('.xmp');

      const result = await first.handlers['photos:delete']({ photoIds: [photo.id] });

      expect(result.deleted).toEqual([]);
      expect(result.failed[0]!.message).toContain('raw1.NEF');
      // The sidecar goes first, so the raw was never touched either: a complete photo remains.
      expect(trash.calls).toEqual([photo.sidecarPath]);
      expect(await exists(photo.path)).toBe(true);
      expect(await exists(photo.sidecarPath)).toBe(true);
      expect(await first.backend.reconcile()).toBe(0);
      expect(await first.handlers['photos:list']()).toHaveLength(1);
    } finally {
      await first.backend.dispose();
    }
  });

  it('keeps the entry when the raw cannot be trashed after its sidecar was, and a retry finishes it', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const first = await start(root, trash);
    let photo: Photo;
    try {
      photo = await ingestRaw(first);
      trash.failOn = (path) => path.endsWith('.NEF');

      const result = await first.handlers['photos:delete']({ photoIds: [photo.id] });

      expect(result.deleted).toEqual([]);
      expect(result.failed[0]!.message).toMatch(/sidecar already was/);
      expect(await exists(photo.path)).toBe(true);
      expect(await exists(photo.sidecarPath)).toBe(false);
      expect(await first.backend.reconcile()).toBe(0);
      expect(await first.handlers['photos:list']()).toHaveLength(1);

      trash.failOn = () => false;
      expect(await first.handlers['photos:delete']({ photoIds: [photo.id] })).toEqual({
        deleted: [photo.id],
        failed: [],
      });
      expect(await readdir(first.destination)).toEqual([]);
    } finally {
      await first.backend.dispose();
    }

    const second = await start(root, trash);
    try {
      expect(await second.handlers['photos:list']()).toEqual([]);
    } finally {
      await second.backend.dispose();
    }
  });
});

describe('a sidecar left behind never brings a photo back', () => {
  it('is not an image for the reconcile, so it adds no entry', async () => {
    const root = await tempDir();
    const trash = new FakeTrash(join(root, 'trash'));
    const harness = await start(root, trash);
    try {
      await ensureXmpFile(join(harness.destination, 'orphan.xmp'));
      expect(await harness.backend.reconcile()).toBe(0);
      expect(await harness.handlers['photos:list']()).toEqual([]);
    } finally {
      await harness.backend.dispose();
    }
  });
});

describe('PhotoDeleter path safety (forged index entries)', () => {
  interface Setup {
    deleter: PhotoDeleter;
    library: PhotoLibrary;
    trash: FakeTrash;
    destination: string;
    sourceDir: string;
    root: string;
    removed: PhotoId[];
  }

  async function setup(retryDelaysMs: readonly number[] = [0, 0]): Promise<Setup> {
    const root = await tempDir();
    const destination = join(root, 'ingest');
    const sourceDir = join(root, 'card');
    await mkdir(destination, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    const library = new PhotoLibrary(new PhotoIndex(':memory:'), () => {});
    const trash = new FakeTrash(join(root, 'trash'));
    const removed: PhotoId[] = [];
    const sources: SourceConfig[] = [
      { id: asSourceId('card'), name: 'card', kind: 'folder', path: sourceDir },
    ];
    const deleter = new PhotoDeleter({
      photos: library,
      settings: { listSources: () => sources },
      trash: trash.trash,
      onRemoved: async (photoId) => {
        removed.push(photoId);
      },
      warn: () => {},
      retryDelaysMs,
    });
    return { deleter, library, trash, destination, sourceDir, root, removed };
  }

  const forge = (
    id: string,
    path: string,
    sidecarPath = path,
    sourceId = asSourceId('card'),
  ): Photo => ({
    id: asPhotoId(id),
    path,
    sidecarPath,
    fileName: basename(path),
    sourceId,
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
  });

  it('trashes an ingested copy', async () => {
    const s = await setup();
    const path = join(s.destination, 'sub', 'ok.jpg');
    await mkdir(join(s.destination, 'sub'));
    await writeFile(path, 'x');
    s.library.add(forge('ok', path));

    expect(await s.deleter.delete({ photoIds: [asPhotoId('ok')] })).toEqual({
      deleted: [asPhotoId('ok')],
      failed: [],
    });
    expect(await exists(path)).toBe(false);
    expect(s.removed).toEqual([asPhotoId('ok')]);
  });

  it.each([
    ['a file of the card', (s: Setup) => join(s.sourceDir, 'a.jpg'), /card or folder source/],
    [
      'a ".." path that leads into the card',
      (s: Setup) => join(s.destination, '..', 'card', 'a.jpg'),
      /card or folder source/,
    ],
    ['a folder', (s: Setup) => s.destination, /it is a folder/],
    ['a relative path', () => 'a.jpg', /not absolute/],
  ])('refuses %s and touches nothing', async (_name, pathFor, message) => {
    const s = await setup();
    const path = pathFor(s);
    await writeFile(join(s.sourceDir, 'a.jpg'), 'original');
    s.library.add(forge('bad', path));

    const result = await s.deleter.delete({ photoIds: [asPhotoId('bad')] });

    expect(result.deleted).toEqual([]);
    expect(result.failed[0]!.message).toMatch(message);
    expect(s.trash.calls).toEqual([]);
    expect(s.removed).toEqual([]);
    expect(s.library.get(asPhotoId('bad')).path).toBe(path);
    expect(await readFile(join(s.sourceDir, 'a.jpg'), 'utf8')).toBe('original');
  });

  it('trashes a copy in any folder that is not a source, whatever the destination setting is', async () => {
    const s = await setup();
    const path = join(s.root, 'older-job', 'a.jpg');
    await mkdir(join(s.root, 'older-job'));
    await writeFile(path, 'x');
    s.library.add(forge('older', path), undefined, join(s.sourceDir, 'a.jpg'));

    expect((await s.deleter.delete({ photoIds: [asPhotoId('older')] })).deleted).toEqual([
      asPhotoId('older'),
    ]);
    expect(await exists(path)).toBe(false);
  });

  it('refuses a photo whose path is the file it was ingested from, even when its source is no longer configured', async () => {
    const s = await setup();
    // A folder that is not a configured source (it was removed from the settings).
    const folder = join(s.root, 'old-card');
    await mkdir(folder);
    const path = join(folder, 'a.jpg');
    await writeFile(path, 'original');
    s.library.add(forge('orig', path, path, asSourceId('old-card')), undefined, path);

    const result = await s.deleter.delete({ photoIds: [asPhotoId('orig')] });

    expect(result.deleted).toEqual([]);
    expect(result.failed[0]!.message).toMatch(/original file it was ingested from/);
    expect(s.trash.calls).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe('original');
  });

  it('does not read a recovered photo as an original, though it names itself as its source', async () => {
    const s = await setup();
    const path = join(s.destination, 'found.jpg');
    await writeFile(path, 'x');
    s.library.add(forge('rec', path, path, asSourceId('recovered')), undefined, path);

    expect((await s.deleter.delete({ photoIds: [asPhotoId('rec')] })).deleted).toEqual([
      asPhotoId('rec'),
    ]);
  });

  it('refuses a symlinked folder that leads into the card', async () => {
    const s = await setup();
    await writeFile(join(s.sourceDir, 'a.jpg'), 'original');
    await symlink(s.sourceDir, join(s.destination, 'link'));
    s.library.add(forge('linked', join(s.destination, 'link', 'a.jpg')));

    const result = await s.deleter.delete({ photoIds: [asPhotoId('linked')] });

    expect(result.deleted).toEqual([]);
    expect(result.failed[0]!.message).toMatch(/card or folder source/);
    expect(s.trash.calls).toEqual([]);
    expect(await readFile(join(s.sourceDir, 'a.jpg'), 'utf8')).toBe('original');
  });

  it('refuses a sidecar that is not the photo itself or its sibling .xmp', async () => {
    const s = await setup();
    const path = join(s.destination, 'a.NEF');
    await writeFile(path, 'raw');
    await writeFile(join(s.sourceDir, 'a.xmp'), 'card sidecar');
    s.library.add(forge('odd', path, join(s.sourceDir, 'a.xmp')));

    const result = await s.deleter.delete({ photoIds: [asPhotoId('odd')] });

    expect(result.failed[0]!.message).toMatch(/sidecar is not next to it/);
    expect(s.trash.calls).toEqual([]);
    expect(await exists(path)).toBe(true);
    expect(await exists(join(s.sourceDir, 'a.xmp'))).toBe(true);
  });

  it('checks every file before the first one moves', async () => {
    const s = await setup();
    // The photo is fine but its recorded sidecar is a folder.
    const path = join(s.destination, 'a.NEF');
    await writeFile(path, 'raw');
    await mkdir(join(s.destination, 'a.xmp'));
    s.library.add(forge('dir', path, join(s.destination, 'a.xmp')));

    const result = await s.deleter.delete({ photoIds: [asPhotoId('dir')] });

    expect(result.failed[0]!.message).toMatch(/it is a folder/);
    expect(s.trash.calls).toEqual([]);
    expect(await exists(path)).toBe(true);
  });

  describe('a trash that fails for a lock is tried again', () => {
    const busy = (): Error =>
      Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });

    async function photoIn(s: Setup, name: string): Promise<Photo> {
      const path = join(s.destination, name);
      await writeFile(path, 'x');
      const photo = forge(name, path);
      s.library.add(photo);
      return photo;
    }

    it('succeeds when EBUSY goes away on a later attempt', async () => {
      const s = await setup();
      const photo = await photoIn(s, 'a.jpg');
      let failures = 2;
      s.trash.failure = busy;
      s.trash.failOn = () => failures-- > 0;

      expect(await s.deleter.delete({ photoIds: [photo.id] })).toEqual({
        deleted: [photo.id],
        failed: [],
      });
      expect(s.trash.calls).toEqual([photo.path, photo.path, photo.path]);
      expect(await exists(photo.path)).toBe(false);
      expect(s.removed).toEqual([photo.id]);
    });

    it.each(['EPERM', 'EACCES'])('treats %s as a lock too', async (code) => {
      const s = await setup();
      const photo = await photoIn(s, 'a.jpg');
      let failures = 1;
      s.trash.failure = () =>
        Object.assign(new Error(`${code}: operation not permitted`), { code });
      s.trash.failOn = () => failures-- > 0;

      expect((await s.deleter.delete({ photoIds: [photo.id] })).deleted).toEqual([photo.id]);
      expect(s.trash.calls).toHaveLength(2);
    });

    it("retries an error without a code, which is all Electron's shell.trashItem gives", async () => {
      const s = await setup();
      const photo = await photoIn(s, 'a.jpg');
      let failures = 1;
      s.trash.failure = () => new Error('Failed to perform delete operation');
      s.trash.failOn = () => failures-- > 0;

      expect((await s.deleter.delete({ photoIds: [photo.id] })).deleted).toEqual([photo.id]);
      expect(s.trash.calls).toHaveLength(2);
    });

    it('gives up after three attempts, reports the error and keeps the file and the entry', async () => {
      const s = await setup();
      const photo = await photoIn(s, 'a.jpg');
      s.trash.failure = busy;
      s.trash.failOn = () => true;

      const result = await s.deleter.delete({ photoIds: [photo.id] });

      expect(result.deleted).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.message).toContain('a.jpg could not be moved to the trash');
      expect(result.failed[0]!.message).toContain('EBUSY');
      expect(s.trash.calls).toHaveLength(3);
      // No permanent-delete fallback: the file and the entry are still there.
      expect(await exists(photo.path)).toBe(true);
      expect(s.library.get(photo.id).id).toBe(photo.id);
      expect(s.removed).toEqual([]);
    });

    it('does not retry an error that is not a lock', async () => {
      const s = await setup();
      const photo = await photoIn(s, 'a.jpg');
      s.trash.failOn = () => true; // the default failure: ENOSPC

      const result = await s.deleter.delete({ photoIds: [photo.id] });

      expect(result.failed).toHaveLength(1);
      expect(s.trash.calls).toHaveLength(1);
    });

    it('does not hold up another photo while one waits to retry', async () => {
      const s = await setup([150, 150]);
      const slow = await photoIn(s, 'slow.jpg');
      const quick = await photoIn(s, 'quick.jpg');
      s.trash.failure = busy;
      s.trash.failOn = (path) => basename(path) === 'slow.jpg';

      const order: string[] = [];
      const first = s.deleter.delete({ photoIds: [slow.id] }).then(() => order.push('slow'));
      const second = s.deleter.delete({ photoIds: [quick.id] }).then((r) => {
        order.push('quick');
        return r;
      });
      expect((await second).deleted).toEqual([quick.id]);
      await first;
      expect(order).toEqual(['quick', 'slow']);
    });
  });
});
