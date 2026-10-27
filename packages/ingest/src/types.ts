import type {
  CredentialSecret,
  IngestJobInfo,
  JobEvent,
  JobId,
  PhotoId,
  SourceConfig,
  SourceId,
} from '@ee/contracts';
import type { SeenStore } from './seen-store';
import type { ExpandTemplate } from './template';

/** A local file selected for ingest, in the order it will be copied. */
export interface SourceFile {
  /** Absolute path on the source volume. */
  path: string;
  name: string;
  /** Folder relative to the source root; used for stable ordering. */
  relativeFolder: string;
  extension: string;
  size: number;
  mtimeMs: number;
}

export interface CopyOutcome {
  /** Hash of the bytes read from the source. */
  sourceHash: string;
  /** Hash of the bytes written to the destination, computed by reading it back. */
  destinationHash: string;
}

/** Seam for tests that need to corrupt a copy mid-flight. */
export interface FileCopier {
  copy(
    source: string,
    destination: string,
    options: { signal?: AbortSignal },
  ): Promise<CopyOutcome>;
}

/** What the rest of the app receives once a photo (and its sidecar) is on disk. */
export interface IngestedFileInfo {
  photoId: PhotoId;
  jobId: JobId;
  sourceId: SourceId;
  sourceKind: SourceConfig['kind'];
  sourceName: string;
  /** Absolute source path for local sources, path on the server for remote ones. */
  sourcePath: string;
  sourceFileName: string;
  /** Absolute path of the primary copy. */
  path: string;
  fileName: string;
  sidecarPath?: string;
  backupPath?: string;
  backupSidecarPath?: string;
  size: number;
  sidecarSize?: number;
  mtimeMs: number;
  sha256: string;
  seq: number;
}

export type OnFileIngested = (info: IngestedFileInfo) => Promise<void>;
export type GetSecret = (credentialRef: string) => Promise<CredentialSecret>;

/** Injected services from the metadata, preview and index workstreams. */
export interface IngestHooks {
  /** Rename and subfolder variables. Defaults to the small built-in. */
  expandTemplate?: ExpandTemplate;
  /** Called after a photo and its sidecar are verified in the destination. */
  onFileIngested?: OnFileIngested;
  /** Required for FTP/SFTP sources. */
  getSecret?: GetSecret;
  /** Reuse one store across runs to skip already-ingested files. */
  seenStore?: SeenStore;
  /** Convenience: open a SQLite seen-store at this path when `seenStore` is absent. */
  seenStorePath?: string;
  /** Test seam for copy verification failures. */
  fileCopier?: FileCopier;
  /** Deterministic clock for tests and `{date}` fallbacks. */
  now?: () => Date;
  /** First retry delay for remote connections. Defaults to 250 ms. */
  retryBaseDelayMs?: number;
  /** Maximum retry delay for remote connections. Defaults to 5 s. */
  retryMaxDelayMs?: number;
}

/** The running ingest. Remote sources keep watching until `stop()` is called. */
export interface IngestHandle {
  /** Resolves when every source reached a terminal state. */
  readonly done: Promise<void>;
  /** Stop one source, or all of them when `sourceId` is omitted. Idempotent. */
  stop(sourceId?: SourceId): Promise<void>;
  /** Snapshot of every source's progress. */
  status(): IngestJobInfo[];
  /** Subscribe to job events. Returns an unsubscribe function. */
  on(listener: (event: JobEvent) => void): () => void;
}
