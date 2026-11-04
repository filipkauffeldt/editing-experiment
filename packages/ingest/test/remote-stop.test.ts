import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { asSourceId, type FtpSource, type IngestJobState } from '@ee/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileCopier } from '../src/copy';
import { IngestAbortError } from '../src/errors';
import { pollRemoteSource, type RemotePollerDeps } from '../src/remote/poller';
import type { RemoteConnection, RemoteEntry } from '../src/remote/types';
import { MemorySeenStore } from '../src/seen-store';
import { defaultExpandTemplate } from '../src/template';
import { ingestConfig, pathExists, waitFor } from './helpers/engine';
import { cleanupTempDirs, makeTempDir } from './helpers/temp';

afterEach(cleanupTempDirs);

const entry: RemoteEntry = {
  name: '_DSC1.NEF',
  path: '/_DSC1.NEF',
  size: 'raw-bytes'.length,
  mtimeMs: 1,
  isDirectory: false,
};

function source(): FtpSource {
  return {
    kind: 'ftp',
    id: asSourceId('remote'),
    name: 'Remote',
    host: '127.0.0.1',
    port: 21,
    username: 'user',
    remotePath: '/',
    pollIntervalMs: 20,
    deleteAfterDownload: false,
    security: 'none',
  };
}

interface FakeConnection {
  connection: RemoteConnection;
  closed: () => boolean;
}

function normalConnection(): FakeConnection {
  let closed = false;
  return {
    connection: {
      async list() {
        return [entry];
      },
      async stat() {
        return { size: entry.size, mtimeMs: entry.mtimeMs };
      },
      async download(_remotePath, localPath) {
        await writeFile(localPath, 'raw-bytes');
      },
      async delete() {
        throw new Error('delete should not be called');
      },
      async close() {
        closed = true;
      },
    },
    closed: () => closed,
  };
}

function gatedConnection(started: () => void): FakeConnection & { partialPath: () => string } {
  let closed = false;
  let partial: string | undefined;
  return {
    connection: {
      async list() {
        return [entry];
      },
      async stat() {
        return { size: entry.size, mtimeMs: entry.mtimeMs };
      },
      async download(_remotePath, localPath, signal) {
        partial = localPath;
        await writeFile(localPath, 'partial');
        started();
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => reject(new IngestAbortError());
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
        });
      },
      async delete() {
        throw new Error('delete should not be called');
      },
      async close() {
        closed = true;
      },
    },
    closed: () => closed,
    partialPath: () => {
      if (!partial) throw new Error('download did not start');
      return partial;
    },
  };
}

function deps(
  destination: string,
  signal: AbortSignal,
  seenStore: MemorySeenStore,
  connect: () => Promise<RemoteConnection>,
  states: IngestJobState[],
): RemotePollerDeps {
  const remote = source();
  let seq = 0;
  return {
    jobId: 'remote-job' as RemotePollerDeps['jobId'],
    source: remote,
    credentials: {},
    signal,
    config: ingestConfig(remote, destination),
    hooks: {},
    seenStore,
    expandTemplate: defaultExpandTemplate,
    copier: nodeFileCopier,
    now: () => new Date(),
    baseNames: new Map(),
    nextSeq: () => {
      seq += 1;
      return seq;
    },
    connect,
    callbacks: {
      setState: (state) => states.push(state),
      reportProgress: () => undefined,
      reportFileDone: () => undefined,
      reportError: () => undefined,
    },
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 20,
  };
}

describe('stopping a watching remote source', () => {
  it('cleans up a partial download and downloads it on the next run', async () => {
    const root = await makeTempDir();
    const destination = join(root, 'destination');
    const seenStore = new MemorySeenStore();
    let downloadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    const first = gatedConnection(downloadStarted);
    const abort = new AbortController();
    const states: IngestJobState[] = [];
    const run = pollRemoteSource(
      deps(destination, abort.signal, seenStore, async () => first.connection, states),
    );

    await started;
    await waitFor(() => states.includes('watching'), 'the poller to watch');
    const partialPath = first.partialPath();
    expect(await pathExists(partialPath)).toBe(true);
    expect(await pathExists(dirname(partialPath))).toBe(true);

    abort.abort();
    await run;

    expect(first.closed()).toBe(true);
    // The downloaded temp file and the temp directory it lived in are gone.
    expect(await pathExists(partialPath)).toBe(false);
    expect(await pathExists(dirname(partialPath))).toBe(false);
    expect(await pathExists(join(destination, '_DSC1_01.NEF'))).toBe(false);
    expect(
      seenStore.has({
        sourceId: 'remote',
        path: entry.path,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      }),
    ).toBe(false);

    const second = normalConnection();
    const secondAbort = new AbortController();
    const secondRun = pollRemoteSource(
      deps(destination, secondAbort.signal, seenStore, async () => second.connection, []),
    );
    await waitFor(
      () => pathExists(join(destination, '_DSC1_01.NEF')),
      'the file to download again',
    );
    secondAbort.abort();
    await secondRun;

    expect(second.closed()).toBe(true);
    expect(await pathExists(join(destination, '_DSC1_01.NEF'))).toBe(true);
    expect(
      seenStore.has({
        sourceId: 'remote',
        path: entry.path,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      }),
    ).toBe(true);
  });
});
