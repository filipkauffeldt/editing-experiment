import { chmod, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  asSourceId,
  type FileTypeFilter,
  type FolderSource,
  type IngestConfig,
  type LockFilter,
} from '@ee/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { startIngest } from '../src/engine';
import {
  READ_ONLY_WARNING,
  filterSourceFiles,
  isDirectoryWritable,
  isLockedFile,
  matchesFileType,
} from '../src/filters';
import { MemorySeenStore } from '../src/seen-store';
import { listImageFiles } from '../src/sources';
import type { SourceFile } from '../src/types';
import { cleanupTempDirs, makeTempDir } from './helpers/temp';

afterEach(cleanupTempDirs);

async function write(path: string, content = 'bytes'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

async function lock(path: string): Promise<void> {
  await chmod(path, 0o444);
}

function source(
  path: string,
  filters: { fileTypes?: FileTypeFilter; lockFilter?: LockFilter; incremental?: boolean } = {},
): FolderSource {
  return { kind: 'folder', id: asSourceId('filters'), name: 'filters', path, ...filters };
}

function config(one: FolderSource, destination: string): IngestConfig {
  return {
    sources: [one],
    destination: { path: destination },
    renameTemplate: '{filenamebase}',
    codeReplacementPaths: [],
  };
}

/** RAW+JPEG pairs in every lock combination, singles, and files only `both` includes. */
async function fixtureCard(): Promise<string> {
  const root = await makeTempDir();
  for (const name of [
    'pair_both.NEF',
    'pair_both.JPG',
    'pair_jpeg.NEF',
    'pair_raw.NEF',
    'single_locked.NEF',
    'single_unlocked.NEF',
    'single.JPG',
    'still.heic',
    'still.tif',
  ]) {
    await write(join(root, name));
  }
  await write(join(root, 'pair_jpeg.JPG'));
  await write(join(root, 'pair_raw.JPG'));
  await write(join(root, 'single_locked.JPG'));
  await lock(join(root, 'pair_both.NEF'));
  await lock(join(root, 'pair_both.JPG'));
  await lock(join(root, 'pair_jpeg.JPG'));
  await lock(join(root, 'pair_raw.NEF'));
  await lock(join(root, 'single_locked.NEF'));
  await lock(join(root, 'single_locked.JPG'));
  await lock(join(root, 'still.heic'));
  return root;
}

describe('isLockedFile', () => {
  it('reads the read-only attribute from POSIX and Windows-style modes', async () => {
    const root = await makeTempDir();
    const large = join(root, 'large.NEF');
    const open = join(root, 'open.NEF');
    const windowsLocked = join(root, 'windows-locked.NEF');
    const windowsOpen = join(root, 'windows-open.NEF');
    for (const path of [large, open, windowsLocked, windowsOpen]) await write(path);
    await chmod(large, 0o400);
    await chmod(open, 0o644);
    await chmod(windowsLocked, 0o444);
    await chmod(windowsOpen, 0o666);

    expect(isLockedFile({ mode: 0o100400 })).toBe(true);
    expect(isLockedFile({ mode: 0o100444 })).toBe(true);
    expect(isLockedFile({ mode: 0o444 })).toBe(true);
    expect(isLockedFile({ mode: 0o100644 })).toBe(false);
    expect(isLockedFile({ mode: 0o666 })).toBe(false);
    expect(isLockedFile({ mode: 0o100755 })).toBe(false);
  });
  it('detects a non-writable directory without writing to it', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const root = await makeTempDir();
    expect(await isDirectoryWritable(root)).toBe(true);
    await chmod(root, 0o555);
    expect(await isDirectoryWritable(root)).toBe(false);
    await chmod(root, 0o755);
    expect(await isDirectoryWritable(root)).toBe(true);
  });
});

describe('file type filter', () => {
  it('includes HEIF/TIFF only with both', () => {
    expect(matchesFileType('photo.NEF', 'raw')).toBe(true);
    expect(matchesFileType('photo.JPG', 'raw')).toBe(false);
    expect(matchesFileType('photo.jpeg', 'jpeg')).toBe(true);
    expect(matchesFileType('photo.JPG', 'jpeg')).toBe(true);
    expect(matchesFileType('photo.NEF', 'jpeg')).toBe(false);
    expect(matchesFileType('photo.HEIC', 'both')).toBe(true);
    expect(matchesFileType('photo.TIF', 'both')).toBe(true);
    expect(matchesFileType('photo.HEIC', 'raw')).toBe(false);
    expect(matchesFileType('photo.TIF', 'jpeg')).toBe(false);
  });
});

describe('lock filter and pair rule', () => {
  it('covers every file type × lock filter combination', async () => {
    const card = await fixtureCard();
    const expected: Record<string, string[]> = {
      'raw:locked': ['pair_both.NEF', 'pair_jpeg.NEF', 'pair_raw.NEF', 'single_locked.NEF'],
      'raw:unlocked': ['single_unlocked.NEF'],
      'raw:all': [
        'pair_both.NEF',
        'pair_jpeg.NEF',
        'pair_raw.NEF',
        'single_locked.NEF',
        'single_unlocked.NEF',
      ],
      'jpeg:locked': ['pair_both.JPG', 'pair_jpeg.JPG', 'pair_raw.JPG', 'single_locked.JPG'],
      'jpeg:unlocked': ['single.JPG'],
      'jpeg:all': [
        'pair_both.JPG',
        'pair_jpeg.JPG',
        'pair_raw.JPG',
        'single.JPG',
        'single_locked.JPG',
      ],
      'both:locked': [
        'pair_both.NEF',
        'pair_both.JPG',
        'pair_jpeg.NEF',
        'pair_jpeg.JPG',
        'pair_raw.NEF',
        'pair_raw.JPG',
        'single_locked.NEF',
        'single_locked.JPG',
        'still.heic',
      ],
      'both:unlocked': ['single_unlocked.NEF', 'single.JPG', 'still.tif'],
      'both:all': [
        'pair_both.NEF',
        'pair_both.JPG',
        'pair_jpeg.JPG',
        'pair_jpeg.NEF',
        'pair_raw.NEF',
        'pair_raw.JPG',
        'single.JPG',
        'single_locked.JPG',
        'single_locked.NEF',
        'single_unlocked.NEF',
        'still.heic',
        'still.tif',
      ],
    };

    for (const fileTypes of ['raw', 'jpeg', 'both'] as const) {
      for (const lockFilter of ['locked', 'unlocked', 'all'] as const) {
        const destination = join(card, `out-${fileTypes}-${lockFilter}`);
        const handle = startIngest(config(source(card, { fileTypes, lockFilter }), destination));
        await handle.done;
        expect(handle.status()[0]?.state, `${fileTypes}/${lockFilter}`).toBe('finished');
        expect((await readdir(destination)).sort(), `${fileTypes}/${lockFilter}`).toEqual(
          [...expected[`${fileTypes}:${lockFilter}`]!].sort(),
        );
      }
    }
  });

  it('decides the pair lock before the type filter, so a locked JPEG keeps RAW only', async () => {
    const card = await fixtureCard();
    const destination = join(card, 'out-pair-rule');
    const handle = startIngest(
      config(source(card, { fileTypes: 'raw', lockFilter: 'locked' }), destination),
    );
    await handle.done;

    const names = await readdir(destination);
    expect(names).toContain('pair_jpeg.NEF');
    expect(names).not.toContain('pair_jpeg.JPG');
    expect(names).not.toContain('pair_raw.JPG');
  });

  it('copies sidecars of raws that pass the filter', async () => {
    const root = await makeTempDir();
    const destination = join(root, 'out-sidecar');
    await write(join(root, 'photo.NEF'), 'raw');
    await write(join(root, 'photo.xmp'), 'sidecar');
    await lock(join(root, 'photo.NEF'));

    await startIngest(config(source(root, { fileTypes: 'raw', lockFilter: 'locked' }), destination))
      .done;

    expect((await readdir(destination)).sort()).toEqual(['photo.NEF', 'photo.xmp']);
    expect(await readFile(join(destination, 'photo.xmp'), 'utf8')).toBe('sidecar');
  });

  it('warns and copies nothing when the volume is read-only', async () => {
    const card = await fixtureCard();
    const destination = join(card, 'out-read-only');
    const events: string[] = [];
    const handle = startIngest(config(source(card, { lockFilter: 'locked' }), destination), {
      isDirectoryWritable: async () => false,
    });
    handle.on((event) => {
      if (event.type === 'ingest.state' && event.warning) events.push(event.warning);
    });
    await handle.done;

    const job = handle.status()[0];
    expect(job?.state).toBe('failed');
    expect(job?.warning).toBe(READ_ONLY_WARNING);
    expect(job?.filesScanned).toBe(12);
    expect(job?.filesTotal).toBe(0);
    expect(events).toContain(READ_ONLY_WARNING);
    expect(await readdir(destination).catch(() => [])).toEqual([]);
  });

  it('injects the probe without writing to the source directory', async () => {
    const card = await fixtureCard();
    let probes = 0;
    const handle = startIngest(
      config(source(card, { lockFilter: 'unlocked' }), join(card, 'out-probe')),
      {
        isDirectoryWritable: async () => {
          probes += 1;
          return true;
        },
      },
    );
    await handle.done;
    expect(probes).toBe(1);
    expect(handle.status()[0]?.state).toBe('finished');
  });
});

describe('incremental ingest', () => {
  it('skips seen files, reports the counts, and copies everything with suffixes when off', async () => {
    const root = await makeTempDir();
    const destination = join(root, 'out');
    const first = join(root, 'a.NEF');
    const second = join(root, 'b.NEF');
    await write(first, 'first');
    await write(second, 'second');
    const seenStore = new MemorySeenStore();

    const run = async (incremental: boolean) => {
      const handle = startIngest(config(source(root, { incremental }), destination), { seenStore });
      await handle.done;
      return handle.status()[0]!;
    };

    const one = await run(true);
    expect(one).toMatchObject({ filesScanned: 2, filesTotal: 2, filesSkipped: 0, filesDone: 2 });

    const two = await run(true);
    expect(two).toMatchObject({ filesScanned: 2, filesTotal: 0, filesSkipped: 2, filesDone: 0 });
    expect((await readdir(destination)).sort()).toEqual(['a.NEF', 'b.NEF']);

    await write(first, 'first changed');
    await utimes(first, new Date(), new Date());
    const three = await run(false);
    expect(three).toMatchObject({ filesScanned: 2, filesTotal: 2, filesSkipped: 0, filesDone: 2 });

    const names = (await readdir(destination)).sort();
    expect(names).toEqual(['a.NEF', 'a_1.NEF', 'b.NEF', 'b_1.NEF']);
    expect(await readFile(join(destination, 'a.NEF'), 'utf8')).toBe('first');
    expect(await readFile(join(destination, 'a_1.NEF'), 'utf8')).toBe('first changed');
  });
});

describe('filterSourceFiles', () => {
  it('returns the scan count before filtering and the filtered files in order', async () => {
    const card = await fixtureCard();
    const files = await listImageFiles(card);
    const result = await filterSourceFiles(files, { fileTypes: 'jpeg', lockFilter: 'locked' });
    expect(result.scanned).toBe(files.length);
    expect(result.files.map((file: SourceFile) => file.name).sort()).toEqual([
      'pair_both.JPG',
      'pair_jpeg.JPG',
      'pair_raw.JPG',
      'single_locked.JPG',
    ]);
  });

  it('does not probe the volume when the lock filter is all', async () => {
    const files: SourceFile[] = [
      {
        path: '/x/a.NEF',
        name: 'a.NEF',
        relativeFolder: '',
        extension: '.NEF',
        size: 1,
        mtimeMs: 1,
      },
    ];
    let probes = 0;
    const result = await filterSourceFiles(files, {
      lockFilter: 'all',
      isDirectoryWritable: async () => {
        probes += 1;
        return false;
      },
    });
    expect(probes).toBe(0);
    expect(result.files).toHaveLength(1);
  });
});
