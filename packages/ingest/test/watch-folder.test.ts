import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asSourceId, type FolderSource, type IngestConfig, type JobEvent } from '@ee/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { startIngest } from '../src/engine';
import type { MemorySeenStore } from '../src/seen-store';
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
    ingested: IngestedFileInfo[];
    events: JobEvent[];
    seenStore?: MemorySeenStore;
  },
): IngestHandle {
  const handle = startIngest(config(source, destination), {
    watchIntervalMs: options.watchIntervalMs,
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
      watchIntervalMs: 20,
      ingested,
      events,
    });

    await waitFor(() => ingested.length === 1, 'the first photo');
    expect(handle.status()[0]).toMatchObject({ state: 'watching', filesDone: 1 });

    await createFile(join(source, '_DSC10.NEF'), 'ten');
    await createFile(join(source, '_DSC9.NEF'), 'nine');
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

  it('copies a file written in slow chunks once, and only when it has stopped changing', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(source);
    const file = join(source, '_DSC1.NEF');
    const ingested: IngestedFileInfo[] = [];
    const handle = watch(folderSource('watch', source, true), destination, {
      watchIntervalMs: 200,
      ingested,
      events: [],
    });
    await waitFor(() => handle.status()[0]?.state === 'watching', 'the first look');

    await writeFile(file, 'chunk-one-');
    await delay(100);
    await appendFile(file, 'chunk-two');

    await waitFor(() => ingested.length === 1, 'the complete file');
    await delay(300);

    expect(ingested).toHaveLength(1);
    expect(await readFile(ingested[0]!.path, 'utf8')).toBe('chunk-one-chunk-two');
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
      watchIntervalMs: 500,
      ingested,
      events,
    });
    await waitFor(() => handle.status()[0]?.state === 'watching', 'the first look');

    await createFile(removed, 'gone');
    await waitFor(() => handle.status()[0]?.filesScanned === 1, 'the file to be seen once');
    await rm(removed);

    await delay(700);

    expect(ingested).toEqual([]);
    expect(events.some((event) => event.type === 'job.error')).toBe(false);
    expect(handle.status()[0]).toMatchObject({ state: 'watching', filesDone: 0 });
  });

  it('finds a photo dropped into a new subfolder when the source is recursive', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(source);
    const ingested: IngestedFileInfo[] = [];
    const handle = watch(folderSource('watch', source, true), destination, {
      watchIntervalMs: 20,
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
