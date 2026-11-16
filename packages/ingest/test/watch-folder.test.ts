import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asSourceId, type FolderSource, type IngestConfig, type JobEvent } from '@ee/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { startIngest } from '../src/engine';
import { MemorySeenStore } from '../src/seen-store';
import type { IngestHandle, IngestedFileInfo } from '../src/types';
import { delay, waitFor } from './helpers/engine';
import { cleanupTempDirs, makeTempDir } from './helpers/temp';

const handles: IngestHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await cleanupTempDirs();
});

function folderSource(id: string, path: string, watchForNewFiles: boolean): FolderSource {
  return { kind: 'folder', id: asSourceId(id), name: id, path, recursive: true, watchForNewFiles };
}

function config(source: FolderSource, destination: string): IngestConfig {
  return {
    sources: [source],
    destination: { path: destination },
    fileNaming: 'rename',
    renameTemplate: '{filenamebase}_{seq:2}',
  };
}

async function createFile(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

function watch(
  source: FolderSource,
  destination: string,
  options: {
    watchIntervalMs: number;
    watchQuietPeriodMs: number;
    ingested: IngestedFileInfo[];
    events: JobEvent[];
    seenStore?: MemorySeenStore;
  },
): IngestHandle {
  const handle = startIngest(config(source, destination), {
    watchIntervalMs: options.watchIntervalMs,
    watchQuietPeriodMs: options.watchQuietPeriodMs,
    ...(options.seenStore ? { seenStore: options.seenStore } : {}),
    onFileIngested: async (info) => {
      options.ingested.push(info);
    },
  });
  handle.on((event) => options.events.push(event));
  handles.push(handle);
  return handle;
}

describe('a folder source that watches for new files', () => {
  it('copies files that appear after the first pass, in filename order', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await createFile(join(source, '_DSC1.NEF'), 'one');
    const ingested: IngestedFileInfo[] = [];
    const events: JobEvent[] = [];
    const handle = watch(folderSource('watch', source, true), destination, {
      watchIntervalMs: 300,
      watchQuietPeriodMs: 60,
      ingested,
      events,
    });

    await waitFor(() => ingested.length === 1, 'the first photo');
    expect(handle.status()[0]).toMatchObject({ state: 'watching', filesDone: 1 });

    await Promise.all([
      createFile(join(source, '_DSC10.NEF'), 'ten'),
      createFile(join(source, '_DSC9.NEF'), 'nine'),
    ]);
    await waitFor(() => ingested.length === 3, 'the new photos');

    expect(ingested.map((info) => info.sourceFileName)).toEqual([
      '_DSC1.NEF',
      '_DSC9.NEF',
      '_DSC10.NEF',
    ]);
    expect(handle.status()[0]).toMatchObject({ state: 'watching', filesDone: 3, filesTotal: 3 });
    expect(events.some((event) => event.type === 'job.error')).toBe(false);
    expect((await readdir(destination)).sort()).toEqual([
      '_DSC10_03.NEF',
      '_DSC1_01.NEF',
      '_DSC9_02.NEF',
    ]);
  });

  it('copies one file once with incremental off', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await createFile(join(source, '_DSC1.NEF'), 'one');
    const ingested: IngestedFileInfo[] = [];
    const handle = watch(
      { ...folderSource('watch', source, true), incremental: false },
      destination,
      {
        watchIntervalMs: 50,
        watchQuietPeriodMs: 100,
        ingested,
        events: [],
      },
    );

    await waitFor(() => ingested.length === 1, 'the only copy');
    await delay(400);

    expect(ingested).toHaveLength(1);
    expect(await readdir(destination)).toEqual(['_DSC1_01.NEF']);
    expect(handle.status()[0]).toMatchObject({
      state: 'watching',
      filesDone: 1,
      filesTotal: 1,
    });
  });

  it('leaves a stalled transfer alone and copies it once when it finishes', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(source);
    const file = join(source, '_DSC1.NEF');
    const ingested: IngestedFileInfo[] = [];
    const handle = watch(folderSource('watch', source, true), destination, {
      watchIntervalMs: 50,
      watchQuietPeriodMs: 400,
      ingested,
      events: [],
    });
    await waitFor(() => handle.status()[0]?.state === 'watching', 'the first look');

    await writeFile(file, 'chunk-one-');
    // Longer than a scan interval, shorter than the quiet period: a stall mid-file.
    await delay(150);
    expect(ingested).toEqual([]);

    await appendFile(file, 'chunk-two');
    await waitFor(() => ingested.length === 1, 'the complete file');
    await delay(600);

    expect(ingested).toHaveLength(1);
    expect(await readFile(ingested[0]!.path, 'utf8')).toBe('chunk-one-chunk-two');
    expect(await readdir(destination)).toEqual([ingested[0]!.fileName]);
  });

  it('counts a file replaced after it was copied as a new file', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(source);
    const file = join(source, '_DSC1.NEF');
    const ingested: IngestedFileInfo[] = [];
    const handle = watch(folderSource('watch', source, true), destination, {
      watchIntervalMs: 50,
      watchQuietPeriodMs: 60,
      ingested,
      events: [],
    });
    await waitFor(() => handle.status()[0]?.state === 'watching', 'the first look');

    await writeFile(file, 'first version');
    await waitFor(() => ingested.length === 1, 'the first copy');

    await writeFile(file, 'replacement version');
    await waitFor(() => ingested.length === 2, 'the replacement');
    await delay(200);

    expect(await readFile(ingested[1]!.path, 'utf8')).toBe('replacement version');
    expect(handle.status()[0]).toMatchObject({ state: 'watching', filesDone: 2, filesTotal: 2 });
    expect((await readdir(destination)).sort()).toEqual(['_DSC1_01.NEF', '_DSC1_02.NEF']);
  });

  it('counts a file seen half written once in the totals', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(source);
    const file = join(source, '_DSC1.NEF');
    const ingested: IngestedFileInfo[] = [];
    const handle = watch(folderSource('watch', source, true), destination, {
      watchIntervalMs: 50,
      watchQuietPeriodMs: 400,
      ingested,
      events: [],
    });
    await waitFor(() => handle.status()[0]?.state === 'watching', 'the first look');

    await writeFile(file, 'chunk-one-');
    // A scan sees the partial file before the quiet period lets it be copied.
    await waitFor(() => handle.status()[0]?.filesTotal === 1, 'the partial file to be counted');
    await appendFile(file, 'chunk-two');

    await waitFor(() => ingested.length === 1, 'the complete file');
    await delay(600);

    expect(ingested).toHaveLength(1);
    expect(await readFile(ingested[0]!.path, 'utf8')).toBe('chunk-one-chunk-two');
    expect(handle.status()[0]).toMatchObject({ state: 'watching', filesDone: 1, filesTotal: 1 });
    expect(await readdir(destination)).toEqual([ingested[0]!.fileName]);
  });

  it('skips a file removed between two looks without failing the run', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(source);
    const removed = join(source, '_DSC1.NEF');
    const ingested: IngestedFileInfo[] = [];
    const events: JobEvent[] = [];
    const handle = watch(folderSource('watch', source, true), destination, {
      watchIntervalMs: 100,
      watchQuietPeriodMs: 1_000,
      ingested,
      events,
    });
    await waitFor(() => handle.status()[0]?.state === 'watching', 'the first look');

    await createFile(removed, 'gone');
    await waitFor(() => handle.status()[0]?.filesScanned === 1, 'the file to be seen once');
    await rm(removed);

    await delay(400);

    expect(ingested).toEqual([]);
    expect(events.some((event) => event.type === 'job.error')).toBe(false);
    expect(handle.status()[0]).toMatchObject({ state: 'watching', filesDone: 0 });
  });

  it('counts only files ingested before the run as already ingested', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    const already = join(source, '_DSC0.NEF');
    await createFile(already, 'old');
    await createFile(join(source, '_DSC1.NEF'), 'one');
    const info = await stat(already);
    const seenStore = new MemorySeenStore();
    seenStore.add({ sourceId: 'watch', path: already, size: info.size, mtimeMs: info.mtimeMs });
    const ingested: IngestedFileInfo[] = [];
    const handle = watch(folderSource('watch', source, true), destination, {
      watchIntervalMs: 30,
      watchQuietPeriodMs: 60,
      ingested,
      events: [],
      seenStore,
    });

    await waitFor(() => ingested.length === 1, 'the new file');
    await waitFor(() => handle.status()[0]?.filesSkipped === 1, 'the skipped count');
    await delay(100);
    expect(handle.status()[0]).toMatchObject({
      state: 'watching',
      filesDone: 1,
      filesTotal: 1,
      filesSkipped: 1,
    });

    await createFile(join(source, '_DSC2.NEF'), 'two');
    await waitFor(() => ingested.length === 2, 'the second arrival');
    await delay(100);

    expect(handle.status()[0]).toMatchObject({
      state: 'watching',
      filesDone: 2,
      filesTotal: 2,
      filesSkipped: 1,
    });
    expect(await readdir(destination)).toHaveLength(2);
  });

  it('keeps watching when the folder goes away, and copies it when it comes back', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(source);
    const ingested: IngestedFileInfo[] = [];
    const handle = watch(folderSource('watch', source, true), destination, {
      watchIntervalMs: 50,
      watchQuietPeriodMs: 60,
      ingested,
      events: [],
    });
    await waitFor(() => handle.status()[0]?.state === 'watching', 'the first look');

    await rm(source, { recursive: true, force: true });
    await waitFor(
      () => handle.status()[0]?.error?.includes('does not exist') === true,
      'the scan error',
    );
    expect(handle.status()[0]?.state).toBe('watching');

    await mkdir(source);
    await createFile(join(source, '_DSC1.NEF'), 'one');
    await waitFor(() => ingested.length === 1, 'the photo after the folder came back');

    expect(handle.status()[0]).toMatchObject({ state: 'watching', filesDone: 1 });
    // The run keeps its first error on the row, as every ingest run does.
    expect(handle.status()[0]?.error).toContain('does not exist');
  });

  it('finds a photo dropped into a new subfolder when the source is recursive', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(source);
    const ingested: IngestedFileInfo[] = [];
    const handle = watch(folderSource('watch', source, true), destination, {
      watchIntervalMs: 20,
      watchQuietPeriodMs: 50,
      ingested,
      events: [],
    });
    await waitFor(() => handle.status()[0]?.state === 'watching', 'the first look');

    await createFile(join(source, '100NCZ', '_DSC1.NEF'), 'one');
    await waitFor(() => ingested.length === 1, 'the photo in the new subfolder');

    expect(ingested[0]?.sourceFileName).toBe('_DSC1.NEF');
    expect(await readdir(destination)).toEqual([ingested[0]!.fileName]);
  });

  it('ends the watch when stopped, without waiting for the interval', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(source);
    const handle = watch(folderSource('watch', source, true), destination, {
      watchIntervalMs: 10_000,
      watchQuietPeriodMs: 50,
      ingested: [],
      events: [],
    });
    await waitFor(() => handle.status()[0]?.state === 'watching', 'the watch');

    const startedAt = Date.now();
    await handle.stop();
    const elapsed = Date.now() - startedAt;
    await handle.done;

    expect(elapsed).toBeLessThan(1_000);
    expect(handle.status()[0]?.state).toBe('stopped');
  });

  it('does not watch after its run stopped, nor when a new run starts without the option', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(source);
    const ingested: IngestedFileInfo[] = [];
    const watchRun = watch(folderSource('watch', source, true), destination, {
      watchIntervalMs: 20,
      watchQuietPeriodMs: 50,
      ingested,
      events: [],
    });
    await waitFor(() => watchRun.status()[0]?.state === 'watching', 'the watch');
    await watchRun.stop();
    handles.splice(handles.indexOf(watchRun), 1);
    await watchRun.done;

    await createFile(join(source, '_DSC1.NEF'), 'one');
    await delay(150);
    expect(ingested).toEqual([]);
    expect(await readdir(destination).catch(() => [])).toEqual([]);

    // A restart of the app holds the source but no run, and an ordinary run ends after one pass.
    const ordinary = startIngest(config(folderSource('watch', source, false), destination), {
      onFileIngested: async (info) => {
        ingested.push(info);
      },
    });
    handles.push(ordinary);
    await ordinary.done;

    expect(ordinary.status()[0]?.state).toBe('finished');
    await createFile(join(source, '_DSC2.NEF'), 'two');
    await delay(150);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.sourceFileName).toBe('_DSC1.NEF');
  });
});
