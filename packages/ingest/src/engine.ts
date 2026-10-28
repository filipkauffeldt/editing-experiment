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
import { randomUUID } from 'node:crypto';
import { nodeFileCopier } from './copy';
import { IngestError, errorMessage, isAbortError, redactSecrets } from './errors';
import { ingestFile } from './ingest-file';
import { connectRemote } from './remote';
import { pollRemoteSource } from './remote/poller';
import { MemorySeenStore, SqliteSeenStore, type SeenStore } from './seen-store';
import { findSidecar, listSourceFiles } from './sources';
import { defaultExpandTemplate, type ExpandTemplate } from './template';
import type { FileCopier, IngestHooks, IngestHandle, SourceFile } from './types';

interface JobRuntime {
  jobId: JobId;
  source: SourceConfig;
  state: IngestJobState;
  filesTotal: number;
  filesDone: number;
  bytesDone: number;
  error?: string;
  seq: number;
  secretValues: string[];
  readonly controller: AbortController;
}

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
  };
  if (job.error !== undefined) {
    info.error = job.error;
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

    let files: SourceFile[];
    try {
      files = await listSourceFiles(source);
    } catch (error) {
      recordError(job, error);
      setState(job, 'failed');
      return;
    }

    job.filesTotal = files.length;
    emitProgress(job);
    setState(job, 'running');

    for (const file of files) {
      if (signal.aborted) {
        return;
      }
      job.seq += 1;
      const key = {
        sourceId: source.id,
        path: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
      };
      if (seenStore.has(key)) {
        continue;
      }

      try {
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
          },
          {
            config,
            expandTemplate,
            copier,
            signal,
            now: now(),
          },
        );

        seenStore.add(key);
        if (sidecar && sidecarInfo) {
          seenStore.add({
            sourceId: source.id,
            path: sidecar,
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
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          return;
        }
        failed = true;
        recordError(job, error);
      }
    }

    setState(job, failed ? 'failed' : 'finished');
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
