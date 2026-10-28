// @vitest-environment node
import { asJobId, asPhotoId, asSourceId, type IpcHandlers, type Photo } from '@ee/contracts';
import type { IngestedFileInfo } from '@ee/ingest';
import { ExifToolService } from '@ee/metadata';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend } from '../src/jobs/backend/backend';
import { createOnFileIngested } from '../src/jobs/backend/ingest-pipeline';
import { PreviewCache } from '../src/jobs/backend/previews';
import { findUnindexed } from '../src/jobs/backend/reconcile';
import { copyInto, fixtureNefs } from './helpers/fixtures';

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ee-reconcile-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const jpeg = (path: string, colour: string): Promise<unknown> =>
  sharp({ create: { width: 300, height: 200, channels: 3, background: colour } })
    .jpeg()
    .toFile(path);

describe('ingest hook when the index write fails', () => {
  it('reports the file name and where the copy is, then fails the file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'frame_001.jpg');
    await jpeg(path, '#468');
    const exiftool = new ExifToolService();
    const reports: { scope: string; message: string }[] = [];
    try {
      const hook = createOnFileIngested(
        {
          photos: {
            hasPath: () => false,
            add: () => {
              throw new Error('database is locked');
            },
          } as never,
          previews: new PreviewCache(join(dir, 'thumb'), join(dir, 'preview')),
          metadata: {} as never,
          edits: {} as never,
          exiftool,
          report: (event) => reports.push(event),
        },
        {},
        'fillEmpty',
      );
      const info: IngestedFileInfo = {
        photoId: asPhotoId('p1'),
        jobId: asJobId('j1'),
        sourceId: asSourceId('s'),
        sourceKind: 'folder',
        sourceName: 's',
        sourcePath: path,
        sourceFileName: 'DSC_1.jpg',
        path,
        fileName: 'frame_001.jpg',
        size: 1,
        mtimeMs: 1,
        sha256: '',
        seq: 1,
      };
      await expect(hook(info)).rejects.toThrowError(/database is locked/);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.scope).toBe('index');
      expect(reports[0]?.message).toContain('frame_001.jpg');
      expect(reports[0]?.message).toContain(path);
      expect(reports[0]?.message).toContain('database is locked');
    } finally {
      await exiftool.close();
    }
  });
});

describe('ingest hook for JPEG files', () => {
  it('records the displayed size of a rotated JPEG and writes previews', async () => {
    const dir = await tempDir();
    const path = join(dir, 'turned.jpg');
    await sharp({ create: { width: 600, height: 400, channels: 3, background: '#468' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(path);
    const exiftool = new ExifToolService();
    const added: Photo[] = [];
    const previews = new PreviewCache(join(dir, 'thumb'), join(dir, 'preview'));
    try {
      const hook = createOnFileIngested(
        {
          photos: { hasPath: () => false, add: (photo: Photo) => added.push(photo) } as never,
          previews,
          metadata: {} as never,
          edits: {} as never,
          exiftool,
          report: (event) => {
            throw new Error(event.message);
          },
        },
        {},
        'fillEmpty',
      );
      await hook({
        photoId: asPhotoId('turned'),
        jobId: asJobId('j'),
        sourceId: asSourceId('s'),
        sourceKind: 'folder',
        sourceName: 's',
        sourcePath: path,
        sourceFileName: 'turned.jpg',
        path,
        fileName: 'turned.jpg',
        size: 1,
        mtimeMs: 1,
        sha256: '',
        seq: 1,
      });
      expect(added[0]).toMatchObject({ width: 400, height: 600 });
      expect(await previews.has('thumb', asPhotoId('turned'))).toBe(true);
    } finally {
      await exiftool.close();
    }
  });
});

describe('findUnindexed', () => {
  it('lists image files below the folder that are not known, skipping temp files', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'a', 'b'), { recursive: true });
    await writeFile(join(dir, 'x_002.jpg'), '');
    await writeFile(join(dir, 'a', 'b', 'x_001.NEF'), '');
    await writeFile(join(dir, 'known.jpg'), '');
    await writeFile(join(dir, 'x_002.xmp'), '');
    await writeFile(join(dir, '.x_003.jpg.part'), '');
    expect(await findUnindexed(dir, new Set([join(dir, 'known.jpg')]))).toEqual([
      join(dir, 'a', 'b', 'x_001.NEF'),
      join(dir, 'x_002.jpg'),
    ]);
    expect(await findUnindexed(join(dir, 'missing'), new Set())).toEqual([]);
  });
});

describe('startup reconciliation', () => {
  it('indexes files that were copied but never indexed, once', async () => {
    const root = await tempDir();
    const userData = join(root, 'userdata');
    const destination = join(root, 'ingest');
    await mkdir(join(destination, 'cardA'), { recursive: true });
    const options = {
      userDataDir: userData,
      appVersion: 'test',
      homeDir: root,
      getSecret: async () => ({}),
    };

    // First run: point ingest at the folder, then stop with nothing indexed.
    const events: { channel: string; payload: unknown }[] = [];
    const first = await createBackend({ ...options, emit: () => {} });
    const { ingest } = await (first.handlers as IpcHandlers)['settings:get']();
    await (first.handlers as IpcHandlers)['settings:set']({
      ingest: { ...ingest, destination: { path: destination } },
    });
    await first.dispose();

    // Files that "landed" while the process died before indexing them.
    await jpeg(join(destination, 'cardA', 'cardA_001.jpg'), '#a44');
    await writeFile(join(destination, 'cardA', '.cardA_002.jpg.part'), 'half a copy');
    const nef = fixtureNefs()[0];
    if (nef) copyInto(nef, join(destination, 'cardA', 'cardA_002.NEF'));
    const expected = nef ? 2 : 1;

    const second = await createBackend({
      ...options,
      emit: (channel, payload) => events.push({ channel, payload }),
    });
    try {
      await second.reconciled;
      const photos = await (second.handlers as IpcHandlers)['photos:list']();
      expect(photos.map((p) => p.fileName)).toEqual(
        ['cardA_001.jpg', 'cardA_002.NEF'].slice(0, expected),
      );
      for (const photo of photos) {
        expect(photo.sourceId).toBe('recovered');
        expect(photo.status.ingest).toBe('done');
        const thumb = join(second.layout.thumbDir, `${photo.id}.jpg`);
        expect((await stat(thumb)).isFile()).toBe(true);
      }
      expect(events.filter((e) => e.channel === 'photos:added')).toHaveLength(expected);

      // Running it again finds nothing new, and the partial copy was never touched.
      expect(await second.reconcile()).toBe(0);
      expect(await (second.handlers as IpcHandlers)['photos:list']()).toHaveLength(expected);
      expect(await readdir(join(destination, 'cardA'))).toContain('.cardA_002.jpg.part');
    } finally {
      await second.dispose();
    }
    // A third start does not duplicate them either.
    const third = await createBackend({ ...options, emit: () => {} });
    try {
      await third.reconciled;
      expect((await (third.handlers as IpcHandlers)['photos:list']()) as Photo[]).toHaveLength(
        expected,
      );
    } finally {
      await third.dispose();
    }
  }, 60_000);
});
