import { stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';
import type { CredentialSecret, IngestConfig, IngestJobState, JobId } from '@ee/contracts';
import { IngestAbortError, IngestError, isAbortError, throwIfAborted } from '../errors';
import { isImageFileName, isRawFileName } from '../formats';
import { ingestFile } from '../ingest-file';
import { isTemporaryName, naturalCompare, splitName } from '../naming';
import type { SeenStore } from '../seen-store';
import type { ExpandTemplate } from '../template';
import type { FileCopier, IngestHooks } from '../types';
import type { RemoteConnection, RemoteConnectionFactory, RemoteEntry, RemoteSource } from './types';

const MAX_FILE_ATTEMPTS = 5;

interface FileFailure {
  attempts: number;
  nextAttemptAt: number;
}

export interface RemotePollerCallbacks {
  setState(state: IngestJobState): void;
  /** `filesTotal` is the number of image files discovered so far. */
  reportProgress(filesTotal: number, currentFile?: string): void;
  reportFileDone(bytes: number): void;
  reportError(error: unknown): void;
}

export interface RemotePollerDeps {
  jobId: JobId;
  source: RemoteSource;
  credentials: CredentialSecret;
  signal: AbortSignal;
  config: IngestConfig;
  hooks: IngestHooks;
  seenStore: SeenStore;
  expandTemplate: ExpandTemplate;
  copier: FileCopier;
  now: () => Date;
  nextSeq(): number;
  connect: RemoteConnectionFactory;
  callbacks: RemotePollerCallbacks;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new IngestAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sidecarFor(
  entries: ReadonlyMap<string, RemoteEntry>,
  stable: ReadonlySet<string>,
  raw: RemoteEntry,
): { entry?: RemoteEntry; waiting: boolean } {
  if (!isRawFileName(raw.name)) {
    return { waiting: false };
  }
  const directory = posix.dirname(raw.path);
  const wanted = `${splitName(raw.name).base}.xmp`.toLowerCase();
  for (const entry of entries.values()) {
    if (
      posix.dirname(entry.path) === directory &&
      posix.basename(entry.path).toLowerCase() === wanted
    ) {
      if (!stable.has(entry.path)) {
        return { waiting: true };
      }
      return { entry, waiting: false };
    }
  }
  return { waiting: false };
}

async function downloadVerified(
  connection: RemoteConnection,
  entry: RemoteEntry,
  localPath: string,
  signal: AbortSignal,
): Promise<void> {
  await connection.download(entry.path, localPath, signal);
  const info = await stat(localPath);
  if (info.size !== entry.size) {
    throw new IngestError(
      `Downloaded size ${info.size} does not match listed size ${entry.size} for ${entry.path}`,
      'size-mismatch',
    );
  }
}

async function ingestRemoteEntry(
  deps: RemotePollerDeps,
  connection: RemoteConnection,
  entry: RemoteEntry,
  sidecar: RemoteEntry | undefined,
): Promise<void> {
  throwIfAborted(deps.signal);
  const tempDirectory = await mkdtemp(join(tmpdir(), 'ee-ingest-remote-'));
  try {
    const localMain = join(tempDirectory, basename(entry.name));
    await downloadVerified(connection, entry, localMain, deps.signal);

    let localSidecar: string | undefined;
    if (sidecar) {
      localSidecar = join(tempDirectory, basename(sidecar.name));
      await downloadVerified(connection, sidecar, localSidecar, deps.signal);
    }

    const info = await ingestFile(
      {
        jobId: deps.jobId,
        source: deps.source,
        sourcePath: localMain,
        sourceFileName: entry.name,
        sourceDisplayPath: entry.path,
        ...(localSidecar ? { sidecarSourcePath: localSidecar } : {}),
        ...(sidecar ? { sidecarDisplayPath: sidecar.path } : {}),
        seq: deps.nextSeq(),
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      },
      {
        config: deps.config,
        expandTemplate: deps.expandTemplate,
        copier: deps.copier,
        signal: deps.signal,
        now: deps.now(),
      },
    );

    deps.seenStore.add({
      sourceId: deps.source.id,
      path: entry.path,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
    });
    if (sidecar) {
      deps.seenStore.add({
        sourceId: deps.source.id,
        path: sidecar.path,
        size: sidecar.size,
        mtimeMs: sidecar.mtimeMs,
      });
    }

    deps.callbacks.reportFileDone(info.size + (info.sidecarSize ?? 0));

    if (deps.hooks.onFileIngested) {
      try {
        await deps.hooks.onFileIngested(info);
      } catch (error) {
        deps.callbacks.reportError(error);
      }
    }

    if (deps.source.deleteAfterDownload) {
      const toDelete = sidecar ? [entry, sidecar] : [entry];
      try {
        const current = await Promise.all(
          toDelete.map(async (candidate) => ({
            candidate,
            stat: await connection.stat(candidate.path),
          })),
        );
        const changed = current.find(
          ({ candidate, stat }) =>
            stat.size !== candidate.size ||
            (candidate.mtimeMs > 0 &&
              stat.mtimeMs !== undefined &&
              stat.mtimeMs !== candidate.mtimeMs),
        );
        if (changed) {
          deps.callbacks.reportError(
            new IngestError(
              `Remote file changed before deletion: ${changed.candidate.path}`,
              'remote-changed',
            ),
          );
        } else {
          for (const candidate of toDelete) {
            await connection.delete(candidate.path);
          }
        }
      } catch (error) {
        deps.callbacks.reportError(error);
      }
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Polls a remote directory until stopped. A file is only downloaded after its
 * size stayed the same across two polls, and temp names are ignored.
 */
export async function pollRemoteSource(deps: RemotePollerDeps): Promise<void> {
  const { signal, source, callbacks } = deps;
  const observed = new Map<string, number>();
  const discovered = new Set<string>();
  const failures = new Map<string, FileFailure>();
  let connection: RemoteConnection | undefined;
  let backoff = deps.retryBaseDelayMs;

  try {
    while (!signal.aborted) {
      try {
        callbacks.setState('running');
        connection ??= await deps.connect(source, deps.credentials, signal);
        const entries = await connection.list(source.remotePath);
        backoff = deps.retryBaseDelayMs;

        const current = new Map<string, RemoteEntry>();
        for (const entry of entries) {
          if (entry.isDirectory || isTemporaryName(entry.name)) {
            continue;
          }
          current.set(entry.path, entry);
        }

        const stable = new Set<string>();
        for (const [path, entry] of current) {
          const previousSize = observed.get(path);
          if (previousSize === entry.size) {
            stable.add(path);
          } else if (previousSize !== undefined) {
            failures.delete(path);
          }
          observed.set(path, entry.size);
        }
        for (const path of observed.keys()) {
          if (!current.has(path)) {
            observed.delete(path);
            failures.delete(path);
          }
        }

        const images = [...current.values()].filter((entry) => isImageFileName(entry.name));
        for (const image of images) {
          discovered.add(image.path);
        }
        callbacks.reportProgress(discovered.size);

        const candidates = images
          .filter((entry) => stable.has(entry.path))
          .filter(
            (entry) =>
              !deps.seenStore.has({
                sourceId: source.id,
                path: entry.path,
                size: entry.size,
                mtimeMs: entry.mtimeMs,
              }),
          )
          .filter((entry) => {
            const failure = failures.get(entry.path);
            if (!failure) {
              return true;
            }
            return failure.attempts < MAX_FILE_ATTEMPTS && Date.now() >= failure.nextAttemptAt;
          })
          .sort((a, b) => naturalCompare(a.path, b.path));

        for (const entry of candidates) {
          if (signal.aborted) {
            break;
          }
          const sidecar = sidecarFor(current, stable, entry);
          if (sidecar.waiting) {
            continue;
          }
          callbacks.reportProgress(discovered.size, entry.path);
          try {
            await ingestRemoteEntry(deps, connection, entry, sidecar.entry);
            failures.delete(entry.path);
          } catch (error) {
            if (isAbortError(error) || signal.aborted) {
              throw error;
            }
            const attempts = (failures.get(entry.path)?.attempts ?? 0) + 1;
            const delay = Math.min(
              deps.retryBaseDelayMs * 2 ** (attempts - 1),
              deps.retryMaxDelayMs,
            );
            failures.set(entry.path, { attempts, nextAttemptAt: Date.now() + delay });
            callbacks.reportError(error);
          }
        }

        callbacks.setState('watching');
        await sleep(source.pollIntervalMs, signal);
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          return;
        }
        if (
          error instanceof IngestError &&
          (error.code === 'missing-host-key' || error.code === 'unsupported-source')
        ) {
          throw error;
        }
        callbacks.reportError(error);
        callbacks.setState('watching');
        if (connection) {
          await connection.close().catch(() => undefined);
          connection = undefined;
        }
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, deps.retryMaxDelayMs);
      }
    }
  } finally {
    if (connection) {
      await connection.close().catch(() => undefined);
    }
  }
}
