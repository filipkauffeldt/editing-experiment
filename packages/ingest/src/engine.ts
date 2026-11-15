import {
  asJobId,
  type CredentialSecret,
  type FtpSource,
  type IngestConfig,
  type IngestJobInfo,
  type IngestJobState,
  type JobEvent,
  type JobId,
  type SourceConfig,
  type SourceId,
} from '@ee/contracts';
import { stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nodeFileCopier } from './copy';
import { IngestError, errorMessage, isAbortError, redactSecrets } from './errors';
import { ingestFile } from './ingest-file';
import { filterSourceFiles, sourceRoot } from './filters';
import { connectRemote } from './remote';
import { pollRemoteSource } from './remote/poller';
import { MemorySeenStore, SqliteSeenStore, type SeenFile, type SeenStore } from './seen-store';
import { findSidecar, listSourceFiles } from './sources';
import { sleep } from './sleep';
import { defaultExpandTemplate, type ExpandTemplate } from './template';
import type { FileCopier, IngestHooks, IngestHandle, SourceFile } from './types';

interface JobRuntime {
  jobId: JobId;
  source: SourceConfig;
  state: IngestJobState;
  filesTotal: number;
  filesDone: number;
  bytesDone: number;
  filesScanned?: number;
  filesSkipped?: number;
  error?: string;
  warning?: string;
  seq: number;
  secretValues: string[];
  readonly controller: AbortController;
}

/** One source file that is still to be copied, with its seen-store keys. */
interface LocalEntry {
  file: SourceFile;
  seq: number;
  key: SeenFile;
  legacyKey: SeenFile;
}

/** A look at a local source after the type and lock filters and the seen store. */
interface LocalScan {
  pending: LocalEntry[];
  skipped: number;
  warning?: string;
}

/**
 * How long the folder watcher waits between scans. Short enough that a photo
 * arrives while the game is still on, long enough that a scan costs little.
 */
const DEFAULT_WATCH_INTERVAL_MS = 1_000;

function isRemoteSource(
  source: SourceConfig,
): source is FtpSource | Extract<SourceConfig, { kind: 'sftp' }> {
  return source.kind === 'ftp' || source.kind === 'sftp';
}

function jobInfo(job: JobRuntime): IngestJobInfo {
  const info: IngestJobInfo = {
    jobId: job.jobId,
    sourceId: job.source.id,
    state: job.state,
    filesTotal: job.filesTotal,
    filesDone: job.filesDone,
    bytesDone: job.bytesDone,
    ...(job.filesScanned === undefined ? {} : { filesScanned: job.filesScanned }),
    ...(job.filesSkipped === undefined ? {} : { filesSkipped: job.filesSkipped }),
  };
  if (job.error !== undefined) {
    info.error = job.error;
  }
  if (job.warning !== undefined) {
    info.warning = job.warning;
  }
  return info;
}

/**
 * Starts every source at once. Each source copies its own files sequentially in
 * filename order; sources never wait for each other.
 */
export function startIngest(config: IngestConfig, hooks: IngestHooks = {}): IngestHandle {
  const listeners = new Set<(event: JobEvent) => void>();
  const now = hooks.now ?? (() => new Date());
  const expandTemplate: ExpandTemplate = hooks.expandTemplate ?? defaultExpandTemplate;
  const copier: FileCopier = hooks.fileCopier ?? nodeFileCopier;
  const retryBaseDelayMs = hooks.retryBaseDelayMs ?? 250;
  const retryMaxDelayMs = hooks.retryMaxDelayMs ?? 5_000;
  /** Keep-mode names chosen in this run, shared by every source racing for them. */
  const baseNames = new Map<string, string>();

  let ownedStore: SqliteSeenStore | undefined;
  let seenStore: SeenStore;
  if (hooks.seenStore) {
    seenStore = hooks.seenStore;
  } else if (hooks.seenStorePath) {
    ownedStore = new SqliteSeenStore(hooks.seenStorePath);
    seenStore = ownedStore;
  } else {
    seenStore = new MemorySeenStore();
  }

  const emit = (event: JobEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A broken consumer must not stop ingest.
      }
    }
  };

  const jobs: JobRuntime[] = config.sources.map((source) => ({
    jobId: asJobId(randomUUID()),
    source,
    state: 'running',
    filesTotal: 0,
    filesDone: 0,
    bytesDone: 0,
    seq: 0,
    secretValues: [],
    controller: new AbortController(),
  }));

  const setState = (job: JobRuntime, state: IngestJobState): void => {
    if (job.state === state) {
      return;
    }
    job.state = state;
    emit({
      type: 'ingest.state',
      at: now().getTime(),
      jobId: job.jobId,
      sourceId: job.source.id,
      state,
      ...(job.warning === undefined ? {} : { warning: job.warning }),
    });
  };

  const emitProgress = (job: JobRuntime, currentFile?: string): void => {
    emit({
      type: 'ingest.progress',
      at: now().getTime(),
      jobId: job.jobId,
      sourceId: job.source.id,
      filesTotal: job.filesTotal,
      filesDone: job.filesDone,
      bytesDone: job.bytesDone,
      ...(job.filesScanned === undefined ? {} : { filesScanned: job.filesScanned }),
      ...(job.filesSkipped === undefined ? {} : { filesSkipped: job.filesSkipped }),
      ...(currentFile ? { currentFile } : {}),
    });
  };

  const recordError = (job: JobRuntime, error: unknown): void => {
    const message = redactSecrets(errorMessage(error), job.secretValues);
    if (job.error === undefined) {
      job.error = message;
    }
    emit({
      type: 'job.error',
      at: now().getTime(),
      jobId: job.jobId,
      scope: 'ingest',
      message,
    });
  };

  const runLocalJob = async (
    job: JobRuntime,
    source: Extract<SourceConfig, { kind: 'folder' | 'card' }>,
  ): Promise<void> => {
    const signal = job.controller.signal;
    let failed = false;

    const incremental = source.incremental ?? true;
    // A card is remembered by its path below the mount point: the same card comes back as
    // `E:\` or `NIKON Z 61`. The absolute path is still honoured for what older runs recorded.
    const seenPath = (path: string): string =>
      source.kind === 'card' ? relative(source.mountPath, path).split(sep).join('/') : path;
    const entryFor = (file: SourceFile, seq: number): LocalEntry => ({
      file,
      seq,
      key: {
        sourceId: source.id,
        path: seenPath(file.path),
        size: file.size,
        mtimeMs: file.mtimeMs,
      },
      legacyKey: { sourceId: source.id, path: file.path, size: file.size, mtimeMs: file.mtimeMs },
    });

    /** One look at the source: filter, then drop what the seen store already has. */
    const scan = async (): Promise<LocalScan> => {
      const files = await listSourceFiles(source);
      const filtered = await filterSourceFiles(files, {
        ...(source.fileTypes === undefined ? {} : { fileTypes: source.fileTypes }),
        ...(source.lockFilter === undefined ? {} : { lockFilter: source.lockFilter }),
        probeDirectory: sourceRoot(source),
        ...(hooks.isDirectoryWritable ? { isDirectoryWritable: hooks.isDirectoryWritable } : {}),
      });
      job.filesScanned = filtered.scanned;
      if (filtered.warning !== undefined) {
        return { pending: [], skipped: 0, warning: filtered.warning };
      }
      const entries = filtered.files.map((file, index) => entryFor(file, index + 1));
      const pending = incremental
        ? entries.filter(
            (entry) =>
              !seenStore.has(entry.key) &&
              !(source.kind === 'card' && seenStore.has(entry.legacyKey)),
          )
        : entries;
      return { pending, skipped: entries.length - pending.length };
    };

    const copyOne = async (entry: LocalEntry): Promise<void> => {
      const { file, key } = entry;
      job.seq = entry.seq;

      emitProgress(job, file.name);
      const sidecar = await findSidecar(file);
      const sidecarInfo = sidecar ? await stat(sidecar) : undefined;
      const info = await ingestFile(
        {
          jobId: job.jobId,
          source,
          sourcePath: file.path,
          sourceFileName: file.name,
          sourceDisplayPath: file.path,
          ...(sidecar ? { sidecarSourcePath: sidecar } : {}),
          ...(sidecarInfo ? { sidecarSize: sidecarInfo.size } : {}),
          seq: job.seq,
          size: file.size,
          mtimeMs: file.mtimeMs,
          ...(sidecarInfo ? { sidecarMtimeMs: sidecarInfo.mtimeMs } : {}),
        },
        {
          ...(hooks.onWarning ? { onWarning: hooks.onWarning } : {}),
          config,
          expandTemplate,
          copier,
          signal,
          now: now(),
          baseNames,
        },
      );

      seenStore.add(key);
      if (sidecar && sidecarInfo) {
        seenStore.add({
          sourceId: source.id,
          path: seenPath(sidecar),
          size: sidecarInfo.size,
          mtimeMs: sidecarInfo.mtimeMs,
        });
      }

      job.filesDone += 1;
      job.bytesDone += info.size + (info.sidecarSize ?? 0);
      emitProgress(job);

      if (hooks.onFileIngested) {
        try {
          await hooks.onFileIngested(info);
        } catch (error) {
          failed = true;
          recordError(job, error);
        }
      }
    };

    const watch = source.kind === 'folder' && source.watchForNewFiles === true;
    if (!watch) {
      let result: LocalScan;
      try {
        result = await scan();
      } catch (error) {
        recordError(job, error);
        setState(job, 'failed');
        return;
      }
      if (result.warning !== undefined) {
        job.warning = result.warning;
        job.filesTotal = 0;
        emitProgress(job);
        setState(job, 'failed');
        return;
      }
      job.filesTotal = result.pending.length;
      job.filesSkipped = result.skipped;
      emitProgress(job);
      setState(job, 'running');

      for (const entry of result.pending) {
        if (signal.aborted) {
          return;
        }
        try {
          await copyOne(entry);
        } catch (error) {
          if (isAbortError(error) || signal.aborted) {
            return;
          }
          failed = true;
          recordError(job, error);
        }
      }

      setState(job, failed ? 'failed' : 'finished');
      return;
    }

    /**
     * A file is copied only after two looks a moment apart saw the same size and
     * modified time, so a file another program is still writing is left for the
     * next look instead of copied half done. A file that changes keeps missing
     * that test and is never attempted, so it cannot fail the run.
     */
    const observed = new Map<string, { size: number; mtimeMs: number }>();
    /** A file whose copy failed is not tried again until it changes; its error stays on the row. */
    const failedFiles = new Set<string>();
    const signature = (file: SourceFile): string =>
      `${file.path}\u0000${file.size}\u0000${file.mtimeMs}`;
    const unchangedOnDisk = async (file: SourceFile): Promise<boolean> => {
      try {
        const info = await stat(file.path);
        return info.isFile() && info.size === file.size && info.mtimeMs === file.mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    };
    const watchIntervalMs = hooks.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    /** Paths already added to `filesTotal` in this run, so a slow file is counted once. */
    const counted = new Set<string>();
    let firstLook = true;
    let scanFailureReported = false;

    try {
      while (!signal.aborted) {
        let result: LocalScan;
        try {
          result = await scan();
        } catch (error) {
          if (isAbortError(error) || signal.aborted) {
            return;
          }
          if (firstLook) {
            recordError(job, error);
            setState(job, 'failed');
            return;
          }
          // A folder on a network share can go away for a while; keep watching.
          if (!scanFailureReported) {
            recordError(job, error);
            scanFailureReported = true;
          }
          setState(job, 'watching');
          await sleep(watchIntervalMs, signal);
          continue;
        }
        firstLook = false;
        scanFailureReported = false;

        if (result.warning !== undefined) {
          job.warning = result.warning;
          job.filesTotal = 0;
          emitProgress(job);
          setState(job, 'failed');
          return;
        }

        job.filesSkipped = result.skipped;
        const current = new Map(result.pending.map((entry) => [entry.file.path, entry.file]));
        const stable = result.pending.filter((entry) => {
          const previous = observed.get(entry.file.path);
          return (
            entry.file.size > 0 &&
            previous?.size === entry.file.size &&
            previous.mtimeMs === entry.file.mtimeMs
          );
        });
        // Forget files that left the folder, so one that comes back is observed afresh.
        for (const path of observed.keys()) {
          if (!current.has(path)) {
            observed.delete(path);
          }
        }
        for (const entry of result.pending) {
          observed.set(entry.file.path, {
            size: entry.file.size,
            mtimeMs: entry.file.mtimeMs,
          });
        }

        const candidates = stable.filter((entry) => !failedFiles.has(signature(entry.file)));
        const newcomers = result.pending.filter((entry) => !counted.has(entry.file.path));
        for (const entry of newcomers) {
          counted.add(entry.file.path);
        }
        job.filesTotal += newcomers.length;
        if (candidates.length > 0) {
          setState(job, 'running');
        }
        emitProgress(job);

        for (const candidate of candidates) {
          if (signal.aborted) {
            return;
          }
          try {
            // The two looks are a moment old now; the file must still be that file.
            if (!(await unchangedOnDisk(candidate.file))) {
              continue;
            }
            job.seq += 1;
            await copyOne({ ...candidate, seq: job.seq });
            // A file that changes later is a new copy and gets counted again.
            counted.delete(candidate.file.path);
          } catch (error) {
            if (isAbortError(error) || signal.aborted) {
              return;
            }
            failedFiles.add(signature(candidate.file));
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              // The photo was removed between the look and the copy: skip it, not the run.
              continue;
            }
            recordError(job, error);
          }
        }

        if (signal.aborted) {
          return;
        }
        setState(job, 'watching');
        await sleep(watchIntervalMs, signal);
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        return;
      }
      throw error;
    }
  };

  const runRemoteJob = async (
    job: JobRuntime,
    source: FtpSource | Extract<SourceConfig, { kind: 'sftp' }>,
  ): Promise<void> => {
    const signal = job.controller.signal;
    const anonymous = source.kind === 'ftp' && !source.credentialRef;
    if (!anonymous && !hooks.getSecret) {
      recordError(
        job,
        new IngestError('Remote source requires a getSecret hook', 'missing-secret'),
      );
      setState(job, 'failed');
      return;
    }

    let credentials: CredentialSecret = {};
    try {
      if (!anonymous) credentials = await hooks.getSecret!(source.credentialRef!);
    } catch (error) {
      recordError(job, error);
      setState(job, 'failed');
      return;
    }
    job.secretValues = [
      credentials.password,
      credentials.privateKey,
      credentials.passphrase,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    await pollRemoteSource({
      jobId: job.jobId,
      source,
      credentials,
      signal,
      config,
      hooks,
      seenStore,
      expandTemplate,
      copier,
      now,
      baseNames,
      nextSeq: () => {
        job.seq += 1;
        return job.seq;
      },
      connect: connectRemote,
      retryBaseDelayMs,
      retryMaxDelayMs,
      callbacks: {
        setState: (state) => setState(job, state),
        reportProgress: (filesTotal, currentFile) => {
          job.filesTotal = filesTotal;
          emitProgress(job, currentFile);
        },
        reportFileDone: (bytes) => {
          job.filesDone += 1;
          job.bytesDone += bytes;
          emitProgress(job);
        },
        reportError: (error) => recordError(job, error),
      },
    });
  };

  const runJob = async (job: JobRuntime): Promise<void> => {
    try {
      if (isRemoteSource(job.source)) {
        await runRemoteJob(job, job.source);
      } else {
        await runLocalJob(job, job.source);
      }
    } catch (error) {
      if (isAbortError(error) || job.controller.signal.aborted) {
        return;
      }
      recordError(job, error);
      setState(job, 'failed');
    } finally {
      if (job.controller.signal.aborted && job.state !== 'failed' && job.state !== 'stopped') {
        setState(job, 'stopped');
      }
    }
  };

  const jobRuns = new Map<JobRuntime, Promise<void>>();
  const runs = jobs.map((job) => {
    const run = runJob(job);
    jobRuns.set(job, run);
    return run;
  });
  const done = Promise.all(runs)
    .then(() => {
      ownedStore?.close();
      ownedStore = undefined;
    })
    .catch(() => {
      ownedStore?.close();
      ownedStore = undefined;
    });

  return {
    done,
    async stop(sourceId?: SourceId): Promise<void> {
      const targets = sourceId ? jobs.filter((job) => job.source.id === sourceId) : jobs;
      if (targets.length === 0) {
        return;
      }
      for (const job of targets) {
        job.controller.abort();
      }
      await Promise.all(
        targets.map((job) => jobRuns.get(job)).filter((run): run is Promise<void> => Boolean(run)),
      );
      if (!sourceId) {
        await done;
      }
    },
    status(): IngestJobInfo[] {
      return jobs.map(jobInfo);
    },
    on(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
