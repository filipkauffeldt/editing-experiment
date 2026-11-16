// @vitest-environment node
import {
  IpcError,
  asSourceId,
  asVersionId,
  type FolderImportInfo,
  type IpcHandlers,
  type Photo,
  type PhotoVersion,
} from '@ee/contracts';
import {
  ExifToolService,
  readEditParams,
  readIptc,
  writeEditParams,
  writeIptc,
  writePhotoLabels,
  writeRetouchVersions,
} from '@ee/metadata';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createBackend, type Backend } from '../src/jobs/backend/backend';
import { copyInto, fixtureNefs } from './helpers/fixtures';

const nefs = fixtureNefs();
const dirs: string[] = [];
const originalCardRoots = process.env.EE_CARD_ROOTS;

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-open-folder-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
  if (originalCardRoots === undefined) delete process.env.EE_CARD_ROOTS;
  else process.env.EE_CARD_ROOTS = originalCardRoots;
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

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

class FakeTrash {
  readonly calls: string[] = [];
  private count = 0;
  constructor(readonly directory: string) {}

  readonly trash = async (path: string): Promise<void> => {
    this.calls.push(path);
    await mkdir(this.directory, { recursive: true });
    await rename(path, join(this.directory, `${++this.count}-${path.split(/[\\/]/).pop()}`));
  };
}

interface Harness {
  root: string;
  source: string;
  destination: string;
  media: string;
  userData: string;
  backend: Backend;
  handlers: IpcHandlers;
  events: { channel: string; payload: unknown }[];
}

async function start(
  root: string,
  options: { userData?: string; trashItem?: (path: string) => Promise<void> } = {},
): Promise<Harness> {
  const source = join(root, 'source');
  const destination = join(root, 'ingest');
  const media = join(root, 'media');
  const userData = options.userData ?? join(root, 'userdata');
  for (const dir of [source, destination, media]) await mkdir(dir, { recursive: true });
  // Never scan the real machine for cards in a test.
  process.env.EE_CARD_ROOTS = media;
  const events: Harness['events'] = [];
  const backend = await createBackend({
    userDataDir: userData,
    appVersion: 'test',
    homeDir: root,
    emit: (channel, payload) => events.push({ channel, payload }),
    getSecret: async () => ({}),
    ...(options.trashItem === undefined ? {} : { trashItem: options.trashItem }),
  });
  const handlers = backend.handlers as IpcHandlers;
  const { ingest } = await handlers['settings:get']();
  await handlers['settings:set']({
    ingest: { ...ingest, destination: { path: destination } },
  });
  await backend.reconciled;
  return { root, source, destination, media, userData, backend, handlers, events };
}

async function waitForFolder(
  events: Harness['events'],
  jobId: string,
  timeoutMs = 90_000,
): Promise<FolderImportInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = [...events]
      .reverse()
      .find(
        (event) =>
          event.channel === 'jobs:event' &&
          (event.payload as { type?: string }).type === 'library.state' &&
          (event.payload as { jobId?: string }).jobId === jobId &&
          (event.payload as { state?: string }).state !== 'running',
      );
    if (found) return found.payload as FolderImportInfo;
    if (Date.now() > deadline) throw new Error(`timed out waiting for folder job ${jobId}`);
    await sleep(50);
  }
}

async function addFolder(harness: Harness, path: string): Promise<FolderImportInfo> {
  const info = await harness.handlers['photos:addFolder']({ path });
  return waitForFolder(harness.events, info.jobId);
}

async function rescanFolder(harness: Harness, path: string): Promise<FolderImportInfo> {
  const info = await harness.handlers['photos:rescanFolder']({ path });
  return waitForFolder(harness.events, info.jobId);
}

const photos = (harness: Harness): Promise<Photo[]> => harness.handlers['photos:list']();

const byName = (list: Photo[], name: string): Photo => {
  const photo = list.find((candidate) => candidate.fileName === name);
  if (!photo) throw new Error(`no photo ${name}`);
  return photo;
};

const messageOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
    throw new Error('the call should have been refused');
  } catch (error) {
    if (error instanceof IpcError) return error.message;
    throw error;
  }
};

describe.skipIf(nefs.length === 0)(
  'opening an existing folder in place (real backend, real folders)',
  { timeout: 120_000 },
  () => {
    it('indexes raws, sidecars and JPEGs where they are, reads their metadata, and writes nothing', async () => {
      const root = await tempDir();
      const harness = await start(root);
      const exiftool = new ExifToolService();
      const library = join(root, 'library');
      const sub = join(library, 'day 2');
      await mkdir(sub, { recursive: true });
      const raw = join(library, 'game_1.NEF');
      const rawNoEdits = join(sub, 'game_2.NEF');
      const photoJpeg = join(library, 'game_3.jpg');
      copyInto(nefs[0]!, raw);
      copyInto(nefs[1] ?? nefs[0]!, rawNoEdits);
      await jpeg(photoJpeg);

      // Existing metadata is what the app must read, not replace.
      await writeIptc(
        raw,
        { caption: 'Mål av Andersson', keywords: ['fotboll', 'AIK'] },
        {
          service: exiftool,
        },
      );
      await writePhotoLabels(
        raw,
        { tagged: true, colorClass: 3, rating: 4 },
        { service: exiftool },
      );
      await writeEditParams(raw, { Exposure2012: 0.55, Contrast2012: 12 }, { service: exiftool });
      const retouch: PhotoVersion = {
        id: asVersionId('existing-retouch'),
        kind: 'retouch',
        ops: [
          {
            type: 'mosaic',
            shapes: [{ type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
            blockSizeRel: 0.02,
          },
        ],
      };
      await writeRetouchVersions(raw, [retouch], { service: exiftool });
      await writeIptc(photoJpeg, { caption: 'JPEG-bild' }, { service: exiftool });
      await writeEditParams(photoJpeg, { Exposure2012: -0.2 }, { service: exiftool });
      await writePhotoLabels(
        photoJpeg,
        { tagged: false, colorClass: 5, rating: 2 },
        { service: exiftool },
      );

      const before = await snapshot(library);
      const settingsBefore = await readFile(join(harness.userData, 'machine.json'), 'utf8');

      const info = await addFolder(harness, library);
      expect(info).toMatchObject({
        mode: 'add',
        state: 'finished',
        filesTotal: 3,
        filesDone: 3,
        filesImported: 3,
        filesSkipped: 0,
      });

      const list = await photos(harness);
      expect(list.map((photo) => photo.fileName).sort()).toEqual([
        'game_1.NEF',
        'game_2.NEF',
        'game_3.jpg',
      ]);
      for (const photo of list) {
        expect(photo.inPlace).toBe(true);
        expect(photo.path.startsWith(library)).toBe(true);
      }

      const edited = byName(list, 'game_1.NEF');
      expect(edited.path).toBe(raw);
      expect(edited.sidecarPath).toBe(join(library, 'game_1.xmp'));
      expect(edited.status.edited).toBe(true);
      expect(edited.previewStale).toBe(true);
      expect(edited.tagged).toBe(true);
      expect(edited.colorClass).toBe(3);
      expect(edited.rating).toBe(4);
      expect(edited.versions.find((version) => version.kind === 'develop')?.ops).toMatchObject({
        Exposure2012: 0.55,
        Contrast2012: 12,
      });
      expect(edited.versions.find((version) => version.kind === 'retouch')).toEqual(retouch);
      expect(await readEditParams(raw, exiftool)).toMatchObject({ Exposure2012: 0.55 });
      expect(await readIptc(raw, exiftool)).toMatchObject({
        caption: 'Mål av Andersson',
        keywords: ['fotboll', 'AIK'],
      });

      const plain = byName(list, 'game_2.NEF');
      expect(plain.status.edited).toBe(false);
      expect(plain.previewStale).toBeUndefined();
      expect(plain.captureTime).toBeDefined();
      expect(plain.camera?.model).toBeDefined();

      const embedded = byName(list, 'game_3.jpg');
      expect(embedded.status.edited).toBe(true);
      expect(embedded.previewStale).toBe(true);
      expect(embedded.colorClass).toBe(5);
      expect(embedded.rating).toBe(2);
      expect(embedded.versions.find((version) => version.kind === 'develop')?.ops).toMatchObject({
        Exposure2012: -0.2,
      });
      expect(await readIptc(photoJpeg, exiftool)).toMatchObject({ caption: 'JPEG-bild' });

      // In place: not one byte, not one modified time changed in the folder, and the raw that had
      // no sidecar still has none.
      expect(Object.keys(await snapshot(library)).sort()).toEqual(Object.keys(before).sort());
      expect(await snapshot(library)).toEqual(before);
      expect(await exists(join(sub, 'game_2.xmp'))).toBe(false);
      expect(await harness.handlers['photos:listAddedFolders']()).toEqual([library]);
      // The roots live in the index, not in settings.json or machine.json.
      expect(await readFile(join(harness.userData, 'machine.json'), 'utf8')).toBe(settingsBefore);
      expect(await readFile(join(harness.userData, 'machine.json'), 'utf8')).not.toContain(library);

      // A rescan of the same folder writes nothing either.
      const rescan = await rescanFolder(harness, library);
      expect(rescan).toMatchObject({ state: 'finished', filesTotal: 0, filesImported: 0 });
      expect(await snapshot(library)).toEqual(before);
      expect(await exists(join(sub, 'game_2.xmp'))).toBe(false);

      // Add the same folder again: every path is already in the Library.
      const again = await addFolder(harness, library);
      expect(again).toMatchObject({ state: 'finished', filesTotal: 0, filesImported: 0 });
      expect(await photos(harness)).toHaveLength(3);
      expect(await snapshot(library)).toEqual(before);
      await harness.backend.dispose();
    });

    it('announces photos:added in file-name order while reading several files at once', async () => {
      const root = await tempDir();
      const harness = await start(root);
      const library = join(root, 'library');
      await mkdir(library, { recursive: true });
      for (const name of ['delta.jpg', 'alpha.jpg', 'echo.jpg', 'bravo.jpg', 'charlie.jpg']) {
        await jpeg(join(library, name));
      }
      const info = await addFolder(harness, library);
      expect(info.filesImported).toBe(5);
      const added = harness.events
        .filter((event) => event.channel === 'photos:added')
        .map((event) => (event.payload as Photo).fileName);
      expect(added).toEqual(['alpha.jpg', 'bravo.jpg', 'charlie.jpg', 'delta.jpg', 'echo.jpg']);
      await harness.backend.dispose();
    });

    it('skips export folders inside an added folder', async () => {
      const root = await tempDir();
      const library = join(root, 'library');
      const exportFolder = join(library, 'export');
      const markerFolder = join(library, 'delivered');
      const userData = join(root, 'export-userdata');
      await mkdir(exportFolder, { recursive: true });
      await mkdir(markerFolder, { recursive: true });
      await mkdir(userData, { recursive: true });
      await jpeg(join(exportFolder, 'from-export.jpg'));
      await jpeg(join(markerFolder, 'from-marker.jpg'));
      await writeFile(join(markerFolder, '.ee-export'), '');
      await jpeg(join(library, 'real.jpg'));
      await jpeg(join(library, 'exported-before.jpg'));
      await writeFile(
        join(userData, 'exported-files.json'),
        JSON.stringify({ version: 1, files: [join(library, 'exported-before.jpg')] }),
      );
      const harness = await start(root, { userData });

      const info = await addFolder(harness, library);
      expect(info).toMatchObject({ state: 'finished', filesImported: 1 });
      expect((await photos(harness)).map((photo) => photo.fileName)).toEqual(['real.jpg']);
      await harness.backend.dispose();
    });

    it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
      'skips a file it cannot read and counts it, without failing the rest',
      async () => {
        const root = await tempDir();
        const harness = await start(root);
        const library = join(root, 'library');
        await mkdir(library, { recursive: true });
        await jpeg(join(library, 'readable.jpg'));
        const unreadable = join(library, 'unreadable.jpg');
        await jpeg(unreadable);
        await chmod(unreadable, 0o000);
        try {
          const info = await addFolder(harness, library);
          expect(info).toMatchObject({
            state: 'finished',
            filesTotal: 2,
            filesDone: 2,
            filesImported: 1,
            filesSkipped: 1,
          });
          expect((await photos(harness)).map((photo) => photo.fileName)).toEqual(['readable.jpg']);
        } finally {
          await chmod(unreadable, 0o644);
        }
        await harness.backend.dispose();
      },
    );

    it('adds a parent of an added folder without duplicating photos', async () => {
      const root = await tempDir();
      const harness = await start(root);
      const parent = join(root, 'games');
      const child = join(parent, 'day 1');
      const sibling = join(parent, 'day 2');
      await mkdir(child, { recursive: true });
      await mkdir(sibling, { recursive: true });
      await jpeg(join(child, 'one.jpg'));
      await jpeg(join(sibling, 'two.jpg'));

      const first = await addFolder(harness, child);
      expect(first.filesImported).toBe(1);
      const parentInfo = await addFolder(harness, parent);
      expect(parentInfo.filesImported).toBe(1);
      expect((await photos(harness)).map((photo) => photo.fileName).sort()).toEqual([
        'one.jpg',
        'two.jpg',
      ]);
      expect(await harness.handlers['photos:listAddedFolders']()).toEqual([child, parent]);

      // Rescanning the child finds nothing new; the parent still owns a new file.
      await jpeg(join(child, 'three.jpg'));
      const rescan = await rescanFolder(harness, child);
      expect(rescan).toMatchObject({ mode: 'rescan', filesImported: 1 });
      expect(await photos(harness)).toHaveLength(3);

      // Removing the parent removes the child's photos too and forgets both roots.
      const before = await snapshot(parent);
      const result = await harness.handlers['photos:removeFolder']({ path: parent });
      expect(result.failed).toEqual([]);
      expect(result.deleted).toHaveLength(3);
      expect(await photos(harness)).toEqual([]);
      expect(await harness.handlers['photos:listAddedFolders']()).toEqual([]);
      expect(await snapshot(parent)).toEqual(before);
      await harness.backend.dispose();
    });

    it('removes an exact subfolder from the Library but a root with its whole tree', async () => {
      const root = await tempDir();
      const harness = await start(root);
      const base = join(root, 'base');
      const sub = join(base, 'sub');
      await mkdir(sub, { recursive: true });
      await jpeg(join(base, 'top.jpg'));
      await jpeg(join(sub, 'deep.jpg'));
      await addFolder(harness, base);
      expect(await photos(harness)).toHaveLength(2);

      // `sub` is not an added root: only its own photos go, the root above it stays.
      const before = await snapshot(base);
      const exact = await harness.handlers['photos:removeFolder']({ path: sub });
      expect(exact.deleted).toHaveLength(1);
      expect((await photos(harness)).map((photo) => photo.fileName)).toEqual(['top.jpg']);
      expect(await harness.handlers['photos:listAddedFolders']()).toEqual([base]);
      expect(await snapshot(base)).toEqual(before);

      // The root takes the rest.
      const whole = await harness.handlers['photos:removeFolder']({ path: base });
      expect(whole.deleted).toHaveLength(1);
      expect(await photos(harness)).toEqual([]);
      expect(await harness.handlers['photos:listAddedFolders']()).toEqual([]);
      expect(await snapshot(base)).toEqual(before);
      await harness.backend.dispose();
    });

    it('refuses a second run on the same root until the first is stopped', async () => {
      const root = await tempDir();
      const harness = await start(root);
      const library = join(root, 'library');
      await mkdir(library, { recursive: true });
      for (let index = 0; index < 40; index += 1) {
        await jpeg(join(library, `frame_${String(index).padStart(2, '0')}.jpg`));
      }

      const first = await harness.handlers['photos:addFolder']({ path: library });
      expect(await messageOf(harness.handlers['photos:addFolder']({ path: library }))).toMatch(
        /already being added.*Stop that run first/,
      );
      expect(await messageOf(harness.handlers['photos:rescanFolder']({ path: library }))).toMatch(
        /already being added.*Stop that run first/,
      );
      await harness.handlers['photos:stopFolderImport']({ jobId: first.jobId });
      expect((await waitForFolder(harness.events, first.jobId)).state).toBe('stopped');

      const rescan = await harness.handlers['photos:rescanFolder']({ path: library });
      expect(await messageOf(harness.handlers['photos:rescanFolder']({ path: library }))).toMatch(
        /already being rescanned.*Stop that run first/,
      );
      await harness.handlers['photos:stopFolderImport']({ jobId: rescan.jobId });
      expect((await waitForFolder(harness.events, rescan.jobId)).state).toBe('stopped');
      await harness.backend.dispose();
    });

    it('can be stopped midway and started again without duplicates', async () => {
      const root = await tempDir();
      const harness = await start(root);
      const library = join(root, 'library');
      await mkdir(library, { recursive: true });
      for (let index = 0; index < 30; index += 1) {
        await jpeg(join(library, `frame_${index}.jpg`), '#468');
      }

      const first = await harness.handlers['photos:addFolder']({ path: library });
      await harness.handlers['photos:stopFolderImport']({ jobId: first.jobId });
      const stopped = await waitForFolder(harness.events, first.jobId);
      expect(stopped.state).toBe('stopped');
      expect(stopped.filesDone).toBeLessThan(30);

      const second = await addFolder(harness, library);
      expect(second.state).toBe('finished');
      expect(second.filesImported).toBe(30 - stopped.filesImported);
      const list = await photos(harness);
      expect(list).toHaveLength(30);
      expect(new Set(list.map((photo) => photo.path)).size).toBe(30);
      await harness.backend.dispose();
    });

    it('rescans only new files, and says a missing folder is not available', async () => {
      const root = await tempDir();
      const harness = await start(root);
      const library = join(root, 'library');
      const sub = join(library, 'sub');
      await mkdir(sub, { recursive: true });
      await jpeg(join(library, 'one.jpg'));
      await addFolder(harness, library);
      const before = await photos(harness);

      await jpeg(join(sub, 'two.jpg'));
      const rescan = await rescanFolder(harness, library);
      expect(rescan).toMatchObject({ mode: 'rescan', filesTotal: 1, filesImported: 1 });
      const after = await photos(harness);
      expect(after).toHaveLength(2);
      expect(byName(after, 'one.jpg').id).toBe(byName(before, 'one.jpg').id);
      // Files that disappeared are not detected.
      await rm(join(library, 'one.jpg'));
      const quiet = await rescanFolder(harness, library);
      expect(quiet.filesImported).toBe(0);
      expect(await photos(harness)).toHaveLength(2);

      await rename(library, join(root, 'library-away'));
      const eventsBefore = harness.events.length;
      const message = await messageOf(harness.handlers['photos:rescanFolder']({ path: library }));
      expect(message).toContain('not available');
      expect(harness.events.length).toBe(eventsBefore);
      expect(await photos(harness)).toHaveLength(2);
      expect(await harness.handlers['photos:listAddedFolders']()).toEqual([library]);
      await harness.backend.dispose();
    });

    it('does not rescan an added folder by itself at startup', async () => {
      const root = await tempDir();
      const harness = await start(root);
      const added = join(harness.destination, 'existing');
      await mkdir(added, { recursive: true });
      await jpeg(join(added, 'one.jpg'));
      await addFolder(harness, added);
      await jpeg(join(added, 'two.jpg'));

      const userData = harness.userData;
      await harness.backend.dispose();
      const restarted = await start(root, { userData });
      expect((await photos(restarted)).map((photo) => photo.fileName)).toEqual(['one.jpg']);

      // The user asks, and the new file appears.
      const info = await rescanFolder(restarted, added);
      expect(info.filesImported).toBe(1);
      expect((await photos(restarted)).map((photo) => photo.fileName).sort()).toEqual([
        'one.jpg',
        'two.jpg',
      ]);
      await restarted.backend.dispose();
    });

    it('removes a folder from the Library, forgets it, and does not bring its files back on restart', async () => {
      const root = await tempDir();
      const harness = await start(root);
      const added = join(harness.destination, 'existing');
      await mkdir(added, { recursive: true });
      await jpeg(join(added, 'one.jpg'));
      await jpeg(join(added, 'two.jpg'));
      const before = await snapshot(added);
      await addFolder(harness, added);
      expect(await photos(harness)).toHaveLength(2);

      const result = await harness.handlers['photos:removeFolder']({ path: added });
      expect(result.failed).toEqual([]);
      expect(result.deleted).toHaveLength(2);
      expect(await photos(harness)).toEqual([]);
      expect(await harness.handlers['photos:listAddedFolders']()).toEqual([]);
      expect(await snapshot(added)).toEqual(before);

      const userData = harness.userData;
      await harness.backend.dispose();
      const restarted = await start(root, { userData });
      expect(await photos(restarted)).toEqual([]);
      expect(await restarted.handlers['photos:listAddedFolders']()).toEqual([]);
      expect(await snapshot(added)).toEqual(before);
      await restarted.backend.dispose();
    });

    it('refuses sources, folders around a source, symlinks into one, cards, the cache and userData', async () => {
      const root = await tempDir();
      const harness = await start(root);
      const folderSource = join(root, 'source');
      await harness.handlers['sources:save']({
        source: {
          id: asSourceId('source'),
          name: 'Game folder',
          kind: 'folder',
          path: folderSource,
        },
      });
      const inside = join(folderSource, 'inner');
      const parent = join(root, 'parent');
      const parentSource = join(parent, 'source');
      await mkdir(inside, { recursive: true });
      await mkdir(parentSource, { recursive: true });
      await harness.handlers['sources:save']({
        source: {
          id: asSourceId('source-2'),
          name: 'Nested folder',
          kind: 'folder',
          path: parentSource,
        },
      });
      const link = join(root, 'link');
      await symlink(folderSource, link);
      const card = join(harness.media, 'card');
      await mkdir(join(card, 'DCIM', '100NCZ'), { recursive: true });

      expect(await messageOf(harness.handlers['photos:addFolder']({ path: inside }))).toMatch(
        /inside the folder source "Game folder".*Ingest view/s,
      );
      expect(await messageOf(harness.handlers['photos:addFolder']({ path: parent }))).toMatch(
        /contains the folder source "Nested folder".*Ingest view/s,
      );
      expect(await messageOf(harness.handlers['photos:addFolder']({ path: link }))).toMatch(
        /inside the folder source "Game folder"/,
      );
      expect(
        await messageOf(harness.handlers['photos:addFolder']({ path: join(card, 'DCIM') })),
      ).toMatch(/memory card.*Ingest view/s);
      expect(await messageOf(harness.handlers['photos:addFolder']({ path: card }))).toMatch(
        /memory card/,
      );
      await mkdir(harness.backend.layout.cacheDir, { recursive: true });
      expect(
        await messageOf(
          harness.handlers['photos:addFolder']({ path: harness.backend.layout.cacheDir }),
        ),
      ).toMatch(/data or cache folder/);
      expect(
        await messageOf(
          harness.handlers['photos:addFolder']({ path: harness.backend.layout.root }),
        ),
      ).toMatch(/data or cache folder/);
      expect(await harness.handlers['photos:listAddedFolders']()).toEqual([]);
      expect(await photos(harness)).toEqual([]);
      await harness.backend.dispose();
    });

    it('deletes an in-place photo to the trash, sidecar first', async () => {
      const root = await tempDir();
      const trash = new FakeTrash(join(root, 'trash'));
      const harness = await start(root, { trashItem: trash.trash });

      const library = join(root, 'library');
      await mkdir(library, { recursive: true });
      const raw = join(library, 'to-trash.NEF');
      copyInto(nefs[0]!, raw);
      const exiftool = new ExifToolService();
      await writeIptc(raw, { caption: 'Fotboll' }, { service: exiftool });
      await addFolder(harness, library);
      const [photo] = await photos(harness);
      expect(photo?.inPlace).toBe(true);

      const result = await harness.handlers['photos:delete']({ photoIds: [photo!.id] });
      expect(result).toMatchObject({ deleted: [photo!.id], failed: [] });
      expect(trash.calls).toEqual([join(library, 'to-trash.xmp'), raw]);
      expect(await photos(harness)).toEqual([]);
      await harness.backend.dispose();
    });

    it('opens an index database made before added folders existed', async () => {
      const root = await tempDir();
      const userData = join(root, 'old-userdata');
      await mkdir(userData, { recursive: true });
      // The schema as it was before this feature: no added_folders, no source_path/search_text.
      const db = new DatabaseSync(join(userData, 'index.sqlite'));
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
      `);
      db.close();

      const harness = await start(root, { userData });
      expect(await harness.handlers['photos:listAddedFolders']()).toEqual([]);
      const library = join(root, 'library');
      await mkdir(library, { recursive: true });
      await jpeg(join(library, 'photo.jpg'));
      const info = await addFolder(harness, library);
      expect(info.filesImported).toBe(1);
      expect(await harness.handlers['photos:listAddedFolders']()).toEqual([library]);
      await harness.backend.dispose();
    });
  },
);
