import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  asSourceId,
  type CardSource,
  type FolderSource,
  type IngestConfig,
  type JobEvent,
} from '@ee/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileCopier } from '../src/copy';
import { startIngest } from '../src/engine';
import { IngestAbortError } from '../src/errors';
import { hashFile } from '../src/hash';
import { naturalCompare, splitName } from '../src/naming';
import { MemorySeenStore } from '../src/seen-store';
import type { FileCopier, IngestedFileInfo } from '../src/types';
import { waitFor } from './helpers/engine';
import { cleanupTempDirs, makeTempDir } from './helpers/temp';

afterEach(cleanupTempDirs);

async function createFile(path: string, content = 'bytes'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

function folderSource(id: string, path: string, recursive = false): FolderSource {
  return { kind: 'folder', id: asSourceId(id), name: id, path, recursive };
}

function config(sources: Array<FolderSource | CardSource>, destination: string): IngestConfig {
  return {
    sources,
    destination: { path: destination },
    fileNaming: 'rename',
    renameTemplate: '{filenamebase}_{seq:2}',
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) return Promise.reject(new Error('test copier needs an abort signal'));
  return new Promise((_resolve, reject) => {
    const abort = (): void => reject(new IngestAbortError());
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Copies normally until `callToGate`; that copy writes a partial temp file and
 * waits for the run's abort, so a stop lands in the middle of a file.
 */
function gatedCopierAt(callToGate: number): { copier: FileCopier; started: Promise<void> } {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  return {
    started: startedPromise,
    copier: {
      async copy(from, to, { signal }) {
        calls += 1;
        if (calls !== callToGate) return nodeFileCopier.copy(from, to, { signal });
        await writeFile(to, 'partial-bytes');
        started();
        await waitForAbort(signal);
        return { sourceHash: '', destinationHash: '' };
      },
    },
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

  it.each([1, 2, 3, 4])(
    'stopping while copy %i runs leaves no partial, temp or half photo set',
    async (gate) => {
      const root = await makeTempDir();
      const source = join(root, 'source');
      const destination = join(root, 'destination');
      const backup = join(root, 'backup');
      await Promise.all([
        mkdir(destination, { recursive: true }),
        mkdir(backup, { recursive: true }),
      ]);
      const raw = join(source, '_DSC1.NEF');
      const sidecar = join(source, '_DSC1.xmp');
      await createFile(raw, 'raw-bytes');
      await createFile(sidecar, '<xmp>sidecar</xmp>');
      const shot = new Date('2026-05-01T10:00:00Z');
      await utimes(raw, shot, shot);
      await utimes(sidecar, shot, shot);
      const rawBefore = await stat(raw);
      const sidecarBefore = await stat(sidecar);
      const { copier, started } = gatedCopierAt(gate);
      const events: JobEvent[] = [];
      const handle = startIngest(
        {
          ...config([folderSource('a', source)], destination),
          backupDestination: { path: backup },
        },
        { fileCopier: copier },
      );
      handle.on((event) => events.push(event));

      await started;
      await handle.stop();
      await handle.done;

      expect(handle.status()[0]).toMatchObject({
        state: 'stopped',
        filesDone: 0,
        filesTotal: 1,
      });
      expect(events.some((event) => event.type === 'job.error')).toBe(false);
      // No final name, no `.ingest-tmp` file, and no primary left without its backup or sidecar.
      expect(await readdir(destination)).toEqual([]);
      expect(await readdir(backup)).toEqual([]);
      expect(await readFile(raw, 'utf8')).toBe('raw-bytes');
      expect(await readFile(sidecar, 'utf8')).toBe('<xmp>sidecar</xmp>');
      expect((await stat(raw)).mtimeMs).toBe(rawBefore.mtimeMs);
      expect((await stat(sidecar)).mtimeMs).toBe(sidecarBefore.mtimeMs);
    },
  );

  it('re-copies the interrupted photo and skips the ones completed before the stop', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    const first = join(source, '_DSC1.NEF');
    const second = join(source, '_DSC2.NEF');
    await createFile(first, 'raw-one');
    await createFile(second, 'raw-two');
    const firstInfo = await stat(first);
    const secondInfo = await stat(second);
    const seenStore = new MemorySeenStore();
    const ingested: string[] = [];
    const { copier, started } = gatedCopierAt(2);
    const hooks = {
      seenStore,
      onFileIngested: async (info: IngestedFileInfo) => {
        ingested.push(info.sourceFileName);
      },
    };

    const stopped = startIngest(config([folderSource('a', source)], destination), {
      ...hooks,
      fileCopier: copier,
    });
    await started;
    await stopped.stop();
    await stopped.done;

    expect(stopped.status()[0]).toMatchObject({ state: 'stopped', filesDone: 1 });
    expect(ingested).toEqual(['_DSC1.NEF']);
    expect(await readdir(destination)).toEqual(['_DSC1_01.NEF']);
    expect(
      seenStore.has({
        sourceId: 'a',
        path: first,
        size: firstInfo.size,
        mtimeMs: firstInfo.mtimeMs,
      }),
    ).toBe(true);
    expect(
      seenStore.has({
        sourceId: 'a',
        path: second,
        size: secondInfo.size,
        mtimeMs: secondInfo.mtimeMs,
      }),
    ).toBe(false);

    ingested.length = 0;
    const again = startIngest(config([folderSource('a', source)], destination), hooks);
    await again.done;

    expect(again.status()[0]?.state).toBe('finished');
    expect(ingested).toEqual(['_DSC2.NEF']);
    expect((await readdir(destination)).sort()).toEqual(['_DSC1_01.NEF', '_DSC2_02.NEF']);
  });

  it('stops only the chosen source while the other finishes', async () => {
    const root = await makeTempDir();
    const sourceA = join(root, 'source-a');
    const sourceB = join(root, 'source-b');
    const destination = join(root, 'destination');
    for (const file of ['_DSC1.NEF', '_DSC2.NEF']) {
      await createFile(join(sourceA, file), `a-${file}`);
      await createFile(join(sourceB, file), `b-${file}`);
    }

    let releaseA!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let gatedA = false;
    const copier: FileCopier = {
      async copy(from, to, { signal }) {
        if (from.startsWith(sourceA) && !gatedA) {
          gatedA = true;
          await writeFile(to, 'partial-a');
          releaseA();
          await waitForAbort(signal);
        }
        return nodeFileCopier.copy(from, to, { signal });
      },
    };
    const handle = startIngest(
      config([folderSource('a', sourceA), folderSource('b', sourceB)], destination),
      { fileCopier: copier },
    );

    await aStarted;
    await waitFor(
      () => handle.status().find((info) => info.sourceId === 'b')?.state === 'finished',
      'source b to finish',
    );
    await handle.stop(asSourceId('a'));
    await handle.done;

    const status = new Map(handle.status().map((info) => [info.sourceId, info]));
    expect(status.get(asSourceId('a'))?.state).toBe('stopped');
    expect(status.get(asSourceId('b'))?.state).toBe('finished');
    expect((await readdir(destination)).sort()).toEqual(['_DSC1_01.NEF', '_DSC2_02.NEF']);
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

  it('keeps the pre-copy sidecar stat in the seen store', async () => {
    const root = await makeTempDir();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    const raw = join(source, '_DSC1.NEF');
    const sidecar = join(source, '_DSC1.xmp');
    await createFile(raw, 'raw');
    await createFile(sidecar, 'sidecar-bytes');
    const seenStore = new MemorySeenStore();
    const ingested: IngestedFileInfo[] = [];
    let copies = 0;
    const deletingCopier: FileCopier = {
      async copy(from, to, options) {
        copies += 1;
        const outcome = await nodeFileCopier.copy(from, to, options);
        if (from.endsWith('.xmp')) {
          await rm(from, { force: true });
        }
        return outcome;
      },
    };
    const hooks = {
      seenStore,
      fileCopier: deletingCopier,
      onFileIngested: async (info: IngestedFileInfo) => {
        ingested.push(info);
      },
    };

    const first = startIngest(config([folderSource('a', source)], destination), hooks);
    await first.done;
    expect(first.status()[0]?.state).toBe('finished');
    expect(ingested[0]?.sidecarSize).toBe('sidecar-bytes'.length);

    const copiesAfterFirst = copies;
    await startIngest(config([folderSource('a', source)], destination), hooks).done;

    expect(copies).toBe(copiesAfterFirst);
    expect(ingested).toHaveLength(1);
    expect(await readdir(destination)).toHaveLength(2);
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

  it('keeps every file when several sources target the same name', async () => {
    const root = await makeTempDir();
    const destination = join(root, 'destination');
    const sourceCount = 4;
    const filesPerSource = 10;
    const rounds = 3;
    const sources: FolderSource[] = [];
    const expected = new Map<string, number>();

    for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
      const source = join(root, `source-${sourceIndex}`);
      sources.push(folderSource(`source-${sourceIndex}`, source));
      for (let fileIndex = 0; fileIndex < filesPerSource; fileIndex += 1) {
        const content = `source-${sourceIndex}-file-${fileIndex}`;
        await createFile(join(source, `_DSC${fileIndex + 1}.NEF`), content);
        expected.set(content, 1);
      }
    }

    const ingest = { ...config(sources, destination), renameTemplate: 'same' };
    for (let round = 0; round < rounds; round += 1) {
      const handle = startIngest(ingest, {});
      await handle.done;
      expect(handle.status().every((job) => job.state === 'finished')).toBe(true);
      expect(await readdir(destination)).toHaveLength(sourceCount * filesPerSource * (round + 1));
    }

    const names = await readdir(destination);
    expect(names.filter((name) => name.endsWith('.ingest-tmp'))).toEqual([]);
    const actual = new Map<string, number>();
    for (const name of names) {
      const content = await readFile(join(destination, name), 'utf8');
      actual.set(content, (actual.get(content) ?? 0) + 1);
    }
    expect(actual).toEqual(
      new Map([...expected].map(([content, count]) => [content, count * rounds])),
    );
    expect(names).toHaveLength(sourceCount * filesPerSource * rounds);
  });

  it('keeps original names from two sources with the same shot, pairing each sidecar', async () => {
    const root = await makeTempDir();
    const destination = join(root, 'destination');
    const sources: FolderSource[] = [];
    for (const card of ['a', 'b']) {
      const source = join(root, `card-${card}`);
      sources.push(folderSource(`card-${card}`, source));
      await createFile(join(source, '_DSC1.JPG'), `jpeg-${card}`);
      await createFile(join(source, '_DSC1.NEF'), `raw-${card}`);
      await createFile(join(source, '_DSC1.xmp'), `sidecar-${card}`);
    }

    const handle = startIngest(
      { ...config(sources, destination), fileNaming: 'keep', renameTemplate: 'ignored_{seq}' },
      {},
    );
    await handle.done;
    expect(handle.status().map((job) => job.state)).toEqual(['finished', 'finished']);

    const names = (await readdir(destination)).sort(naturalCompare);
    expect(names).toEqual([
      '_DSC1.JPG',
      '_DSC1.NEF',
      '_DSC1.xmp',
      '_DSC1_1.JPG',
      '_DSC1_1.NEF',
      '_DSC1_1.xmp',
    ]);

    // Whichever card won the plain name, its raw, JPEG and sidecar stay one set.
    for (const base of ['_DSC1', '_DSC1_1']) {
      const card = (await readFile(join(destination, `${base}.NEF`), 'utf8')).slice('raw-'.length);
      expect(await readFile(join(destination, `${base}.JPG`), 'utf8')).toBe(`jpeg-${card}`);
      expect(await readFile(join(destination, `${base}.xmp`), 'utf8')).toBe(`sidecar-${card}`);
      expect(splitName(`${base}.NEF`).base).toBe(base);
    }
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

  describe('a card pulled out before ingest starts', () => {
    it('fails with a message naming the card while the other sources carry on', async () => {
      const root = await makeTempDir();
      const destination = join(root, 'destination');
      const present = join(root, 'media', 'EOS_DIGITAL');
      const gone = join(root, 'media', 'NIKON Z 6');
      const folder = join(root, 'folder');
      await createFile(join(present, 'DCIM', '100EOS', 'IMG_1.CR3'));
      await createFile(join(folder, '_DSC1.NEF'));
      const ingested: string[] = [];

      const handle = startIngest(
        config(
          [
            { kind: 'card', id: asSourceId('eos'), name: 'EOS_DIGITAL', mountPath: present },
            { kind: 'card', id: asSourceId('nikon'), name: 'NIKON Z 6', mountPath: gone },
            folderSource('folder', folder),
          ],
          destination,
        ),
        {
          onFileIngested: async (info: IngestedFileInfo) => {
            ingested.push(info.sourceFileName);
          },
        },
      );
      await handle.done;

      const status = new Map(handle.status().map((info) => [info.sourceId, info]));
      expect(status.get(asSourceId('nikon'))?.state).toBe('failed');
      expect(status.get(asSourceId('nikon'))?.error).toContain('NIKON Z 6');
      expect(status.get(asSourceId('nikon'))?.error).toContain(gone);
      expect(status.get(asSourceId('eos'))?.state).toBe('finished');
      expect(status.get(asSourceId('folder'))?.state).toBe('finished');
      expect(ingested.sort()).toEqual(['IMG_1.CR3', '_DSC1.NEF']);
    });
  });

  describe('a card that comes back', () => {
    const cardAt = (mountPath: string): CardSource => ({
      kind: 'card',
      id: asSourceId('nikon'),
      name: 'NIKON Z 6',
      mountPath,
    });

    it('is still incremental when it is mounted under a different path', async () => {
      const root = await makeTempDir();
      const destination = join(root, 'destination');
      const first = join(root, 'media', 'NIKON Z 6');
      const second = join(root, 'media', 'NIKON Z 61');
      const frame = '100NCZ/_DSC1.NEF';
      const shot = new Date('2026-05-01T10:00:00Z');
      await createFile(join(first, 'DCIM', frame));
      await utimes(join(first, 'DCIM', frame), shot, shot);
      const seenStore = new MemorySeenStore();
      let ingested: string[] = [];
      const hooks = {
        seenStore,
        onFileIngested: async (info: IngestedFileInfo) => {
          ingested.push(info.sourceFileName);
        },
      };

      await startIngest(config([cardAt(first)], destination), hooks).done;
      expect(ingested).toEqual(['_DSC1.NEF']);

      // The same card mounted elsewhere: the same file with the same timestamp.
      await createFile(join(second, 'DCIM', frame));
      await utimes(join(second, 'DCIM', frame), shot, shot);
      await createFile(join(second, 'DCIM', '100NCZ/_DSC2.NEF'));
      ingested = [];
      await startIngest(config([cardAt(second)], destination), hooks).done;

      expect(ingested).toEqual(['_DSC2.NEF']);
    });

    it('honours files an older run recorded by absolute path', async () => {
      const root = await makeTempDir();
      const destination = join(root, 'destination');
      const mount = join(root, 'media', 'NIKON Z 6');
      const file = join(mount, 'DCIM', '100NCZ', '_DSC1.NEF');
      await createFile(file);
      const info = await stat(file);
      const seenStore = new MemorySeenStore();
      seenStore.add({ sourceId: 'nikon', path: file, size: info.size, mtimeMs: info.mtimeMs });
      const ingested: string[] = [];

      await startIngest(config([cardAt(mount)], destination), {
        seenStore,
        onFileIngested: async (done: IngestedFileInfo) => {
          ingested.push(done.sourceFileName);
        },
      }).done;

      expect(ingested).toEqual([]);
    });
  });
});
