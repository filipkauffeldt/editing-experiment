import type { DestinationId, ExportJobId, JobId, PhotoId, SourceId, UploadId } from './ids';
import type { ExportJob, ExportRenderRequest, UploadItemState } from './export';

/** Common fields of every {@link JobEvent}. */
interface JobEventBase {
  /** Epoch milliseconds when the event was emitted. */
  at: number;
}

/** Progress of one source's ingest run. */
export interface IngestProgressEvent extends JobEventBase {
  type: 'ingest.progress';
  jobId: JobId;
  sourceId: SourceId;
  /** Files selected for copying: after the type/lock filters and seen-store skip. */
  filesTotal: number;
  filesDone: number;
  bytesDone: number;
  /** Image files found before the type/lock filters. */
  filesScanned?: number;
  /** Selected files already ingested earlier, so skipped by incremental ingest. */
  filesSkipped?: number;
  /** File being copied right now. */
  currentFile?: string;
}

/** An ingest run changed state. */
export interface IngestStateEvent extends JobEventBase {
  type: 'ingest.state';
  jobId: JobId;
  sourceId: SourceId;
  state: IngestJobState;
  /** A condition the user must know about, e.g. a read-only volume. */
  warning?: string;
}

/** Progress of one upload. */
export interface UploadProgressEvent extends JobEventBase {
  type: 'upload.progress';
  uploadId: UploadId;
  photoId: PhotoId;
  destinationId: DestinationId;
  bytesSent: number;
  bytesTotal: number;
}

/** An upload queue entry changed state. */
export interface UploadStateEvent extends JobEventBase {
  type: 'upload.state';
  uploadId: UploadId;
  photoId: PhotoId;
  destinationId: DestinationId;
  state: UploadItemState;
  error?: string;
}

/** A background failure that is not tied to a single request. */
export interface JobErrorEvent extends JobEventBase {
  type: 'job.error';
  jobId?: JobId;
  /** Machine-readable origin, e.g. `ingest`, `upload`, `metadata`. */
  scope: string;
  message: string;
}

/** The jobs process asks the renderer to render one photo for an export job. */
export interface ExportRenderEvent extends JobEventBase, ExportRenderRequest {
  type: 'export.render';
}

/** One photo inside an export job changed state. */
export interface ExportProgressEvent extends JobEventBase {
  type: 'export.progress';
  jobId: ExportJobId;
  photoId: PhotoId;
  job: ExportJob;
}

/** An export job changed state (queued, running, done, failed, cancelled). */
export interface ExportStateEvent extends JobEventBase {
  type: 'export.state';
  jobId: ExportJobId;
  state: ExportJob['state'];
  job: ExportJob;
}

/** Stream of background work updates, delivered on the `jobs:event` channel. */
export type JobEvent =
  | IngestProgressEvent
  | IngestStateEvent
  | UploadProgressEvent
  | UploadStateEvent
  | JobErrorEvent
  | ExportRenderEvent
  | ExportProgressEvent
  | ExportStateEvent;

/** State of one source's ingest run. `watching` = remote source idle between polls. */
export type IngestJobState = 'running' | 'watching' | 'stopped' | 'finished' | 'failed';

/** Snapshot of one source's ingest run, as returned by `ingest:start` and `ingest:status`. */
export interface IngestJobInfo {
  jobId: JobId;
  sourceId: SourceId;
  state: IngestJobState;
  /** Files selected for copying: after the type/lock filters and seen-store skip. */
  filesTotal: number;
  filesDone: number;
  bytesDone: number;
  /** Image files found before the type/lock filters. */
  filesScanned?: number;
  /** Selected files already ingested earlier, so skipped by incremental ingest. */
  filesSkipped?: number;
  error?: string;
  /** A condition the user must know about, e.g. a read-only volume. */
  warning?: string;
}
