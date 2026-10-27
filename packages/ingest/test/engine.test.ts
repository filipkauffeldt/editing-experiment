import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asSourceId, type FolderSource, type IngestConfig, type JobEvent } from '@ee/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { startIngest } from '../src/engine';
import { hashFile } from '../src/hash';
import { MemorySeenStore } from '../src/seen-store';
import type { FileCopier, IngestedFileInfo } from '../src/types';
import { cleanupTempDirs, makeTempDir } from './helpers/temp';

afterEach(cleanupTempDirs);

async function createFile(path: string, content = 'bytes'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

function folderSource(id: string, path: string, recursive = false): FolderSource {
  return { kind: 'folder', id: asSourceId(id), name: id, path, recursive };
}

function config(sources: FolderSource[], destination: string): IngestConfig {
  return {
    sources,
    destination: { path: destination },
    renameTemplate: '{filenamebase}_{seq:2}',
    codeReplacementPaths: [],
  };
}

describe('startIngest', () => {
  it('runs sources in parallel but copies each source in filename order', async () => {
    const root = await makeTempDir();
    const destination = join(root, 'destination');
    const sourceA = join(root, 'card-a');
    const sourceB = join(root, 'card-b');
    await createFile(join(sourceA, '101NCZ', '_DSC1.NEF'));
    await createFile(join(sourceA, '100NCZ', '_DSC10.NEF'));
    await createFile(join(sourceA, '100NCZ', '_DSC9.NEF'));
    await createFile(join(sourceB, '_DSC2.NEF'));
    await createFile(join(sourceB, '_DSC10.NEF'));

    const order = new Map<string, string[]>();
    let active = 0;
    let maxActive = 0;
    const handle = startIngest(
      config([folderSource('a', sourceA, true), folderSource('b', sourceB)], destination),
      {
        onFileIngested: async (info: IngestedFileInfo) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          const list = order.get(info.sourceId) ?? [];
          list.push(info.sourceFileName);
          order.set(info.sourceId, list);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
        },
      },
    );

    await handle.done;

    expect(order.get('a')).toEqual(['_DSC9.NEF', '_DSC10.NEF', '_DSC1.NEF']);
    expect(order.get('b')).toEqual(['_DSC2.NEF', '_DSC10.NEF']);
    expect(maxActive).toBeGreaterThanOrEqual(2);
    expect(handle.status().map((job) => job.state)).toEqual(['finished', 'finished']);
    expect(await readdir(destination)).toHaveLength(5);
  });

  it('writes a backup copy alongside the primary one', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    const backup = join(root, 'backup');
    await createFile(join(source, '_DSC1.NEF'), 'raw');
    await createFile(join(source, '_DSC1.xmp'), 'sidecar');

    const handle = startIngest(
      { ...config([folderSource('a', source)], destination), backupDestination: { path: backup } },
      {},
    );
    await handle.done;

    expect(await readFile(join(destination, '_DSC1_01.NEF'), 'utf8')).toBe('raw');
    expect(await readFile(join(backup, '_DSC1_01.NEF'), 'utf8')).toBe('raw');
    expect(await readFile(join(backup, '_DSC1_01.xmp'), 'utf8')).toBe('sidecar');
  });

  it('stops mid-ingest and leaves no partial files', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    for (let index = 1; index <= 5; index += 1) {
      await createFile(join(source, `_DSC${index}.NEF`), `raw-${index}`);
    }

    let releaseFirst: (() => void) | undefined;
    const firstHook = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const events: JobEvent[] = [];
    const handle = startIngest(config([folderSource('a', source)], destination), {
      onFileIngested: async () => {
        calls += 1;
        if (calls === 1) {
          await firstHook;
        }
      },
    });
    handle.on((event) => events.push(event));

    while (calls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const stopping = handle.stop();
    releaseFirst?.();
    await stopping;
    await handle.done;

    const job = handle.status()[0];
    expect(job?.state).toBe('stopped');
    expect(job?.filesDone).toBe(1);
    expect(calls).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'ingest.state', state: 'stopped' }),
    );
    expect(await readdir(destination)).toHaveLength(1);
  });

  it('skips already seen files and re-ingests a file whose mtime changed', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    const first = join(source, '_DSC1.NEF');
    await createFile(first);
    await createFile(join(source, '_DSC2.NEF'));
    const seenStore = new MemorySeenStore();
    let ingested: string[] = [];
    const hooks = {
      seenStore,
      onFileIngested: async (info: IngestedFileInfo) => {
        ingested.push(info.sourceFileName);
      },
    };

    await startIngest(config([folderSource('a', source)], destination), hooks).done;
    expect(ingested).toEqual(['_DSC1.NEF', '_DSC2.NEF']);

    ingested = [];
    await startIngest(config([folderSource('a', source)], destination), hooks).done;
    expect(ingested).toEqual([]);

    ingested = [];
    await utimes(first, new Date(), new Date());
    await startIngest(config([folderSource('a', source)], destination), hooks).done;
    expect(ingested).toEqual(['_DSC1.NEF']);
  });

  it('reports a verification failure without leaving a file behind', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await createFile(join(source, '_DSC1.NEF'));
    const corrupting: FileCopier = {
      async copy(from, to) {
        await writeFile(to, 'corrupted');
        return {
          sourceHash: await hashFile(from),
          destinationHash: await hashFile(to),
        };
      },
    };

    const events: JobEvent[] = [];
    const handle = startIngest(config([folderSource('a', source)], destination), {
      fileCopier: corrupting,
    });
    handle.on((event) => events.push(event));
    await handle.done;

    expect(handle.status()[0]?.state).toBe('failed');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'job.error',
        message: expect.stringContaining('Hash mismatch'),
      }),
    );
    expect(await readdir(destination)).toEqual([]);
  });

  it('fails a source when the rename template escapes the destination', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await createFile(join(source, '_DSC1.NEF'));

    const handle = startIngest(
      { ...config([folderSource('a', source)], destination), renameTemplate: '../escape' },
      {},
    );
    await handle.done;

    expect(handle.status()[0]?.state).toBe('failed');
    expect(handle.status()[0]?.error).toContain('path');
    expect(await readdir(destination).catch(() => [])).toEqual([]);
  });
});
