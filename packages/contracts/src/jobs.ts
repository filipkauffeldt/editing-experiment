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

/** Whether a folder is being added to the Library or looked through again. */
export type FolderImportMode = 'add' | 'rescan';

/** State of one added-folder run. */
export type FolderImportState = 'running' | 'finished' | 'stopped' | 'failed';

/** Snapshot of one added-folder run, as returned by `photos:addFolder` and `photos:rescanFolder`. */
export interface FolderImportInfo {
  jobId: JobId;
  /** Absolute folder path. */
  root: string;
  mode: FolderImportMode;
  state: FolderImportState;
  /** Image files to index: not already in the Library and not in a removed path. */
  filesTotal: number;
  /** Files looked at so far, including the ones that could not be read. */
  filesDone: number;
  /** Photos that reached the index. */
  filesImported: number;
  /** Files skipped because they could not be read or indexed. */
  filesSkipped: number;
  /** File being indexed right now. */
  currentFile?: string;
  error?: string;
}

/** Progress of an added-folder run. */
export interface FolderImportProgressEvent extends JobEventBase, FolderImportInfo {
  type: 'library.progress';
}

/** An added-folder run changed state. */
export interface FolderImportStateEvent extends JobEventBase, FolderImportInfo {
  type: 'library.state';
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
  | FolderImportProgressEvent
  | FolderImportStateEvent
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
