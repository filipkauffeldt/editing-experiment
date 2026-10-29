import {
  IpcError,
  asExportJobId,
  type ExportJob,
  type ExportJobId,
  type ExportPhotoProgress,
  type ExportPreset,
  type ExportRenderRequest,
  type JobEvent,
  type RenderedImage,
  type StartExportArgs,
} from '@ee/contracts';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { writeJsonAtomic } from './atomic-json';

const FILE_VERSION = 1;
const DEFAULT_RENDER_TIMEOUT_MS = 5 * 60_000;
const MAX_STORED_JOBS = 50;

interface PersistedJobs {
  version: number;
  jobs: ExportJob[];
}

export interface ExportQueueOptions {
  /** JSON file for resumable jobs; omit to keep jobs only in memory. */
  file?: string;
  getPreset(presetId: ExportPreset['id']): ExportPreset | undefined;
  /** Key of the retouch ops a render for this version must apply ('' for develop). */
  getOpsKey(photoId: ExportJob['photoIds'][number], version: ExportJob['version']): string;
  exportPhoto(args: {
    photoId: ExportJob['photoIds'][number];
    preset: ExportPreset;
    rendered: RenderedImage;
  }): Promise<{ path: string; fileName: string; skipped?: boolean }>;
  enqueue(args: {
    photoId: ExportJob['photoIds'][number];
    path: string;
    destinations: ExportJob['send'];
  }): Promise<unknown>;
  /** Drop per-export state when an export is cancelled before it is sent. */
  discard?(photoId: ExportJob['photoIds'][number]): void;
  emit(event: JobEvent): void;
  renderTimeoutMs?: number;
  now?: () => number;
  newJobId?: () => ExportJobId;
  newRequestId?: () => string;
  onWarning?: (message: string) => void;
}

interface PendingRender {
  jobId: ExportJobId;
  request: ExportRenderRequest;
  expectedOpsKey: string;
  resolve(rendered: RenderedImage): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Owns export batches. Photos are processed one at a time; the renderer is
 * asked for each full-resolution render (it owns the GL pipeline) and the jobs
 * process then encodes, writes metadata and enqueues the exported file for
 * upload. Jobs are persisted so queued photos survive a restart.
 */
export class ExportQueue {
  private readonly jobs: ExportJob[] = [];
  private readonly renderTimeoutMs: number;
  private readonly now: () => number;
  private readonly newJobId: () => ExportJobId;
  private readonly newRequestId: () => string;
  private rendererReady = false;
  private pumping = false;
  private closed = false;
  private pendingRender: PendingRender | undefined;

  constructor(private readonly options: ExportQueueOptions) {
    this.renderTimeoutMs = Math.max(1, options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS);
    this.now = options.now ?? Date.now;
    this.newJobId = options.newJobId ?? (() => asExportJobId(randomUUID()));
    this.newRequestId = options.newRequestId ?? (() => randomUUID());
    this.load();
  }

  start(args: StartExportArgs): ExportJobId {
    if (this.closed) throw new IpcError('internal', 'the export queue is closed');
    if (!Array.isArray(args.photoIds) || args.photoIds.length === 0) {
      throw new IpcError('invalid_argument', 'select at least one photo to export');
    }
    const preset = this.options.getPreset(args.presetId);
    if (!preset) throw new IpcError('not_found', `no export preset ${args.presetId}`);
    const unique = [...new Set(args.photoIds)];
    const send = args.send ?? preset.sendTo;
    // A send must never deliver a mosaic-less render of a retouched photo.
    const version: ExportJob['version'] =
      args.forceTop === true || send.length > 0 ? 'top' : preset.version;
    const job: ExportJob = {
      id: this.newJobId(),
      presetId: preset.id,
      photoIds: unique,
      send,
      state: 'queued',
      version,
      photos: unique.map((photoId) => ({ photoId, state: 'queued' })),
      createdAt: this.now(),
    };
    this.jobs.push(job);
    this.rendererReady = true;
    this.changed(job, 'state');
    void this.pump();
    return job.id;
  }

  list(): ExportJob[] {
    return [...this.jobs].reverse().map(cloneJob);
  }

  cancel(jobId: ExportJobId): void {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new IpcError('not_found', `no export job ${jobId}`);
    if (terminal(job.state)) return;

    job.state = 'cancelled';
    job.finishedAt = this.now();
    for (const photo of job.photos) {
      if (terminalPhoto(photo.state)) continue;
      photo.state = 'cancelled';
    }
    if (this.pendingRender?.jobId === jobId) {
      const pending = this.pendingRender;
      this.pendingRender = undefined;
      clearTimeout(pending.timer);
      pending.reject(new Error('cancelled'));
    }
    this.changed(job, 'state');
  }

  /** The renderer is listening again (after a reload or an app restart). */
  markRendererReady(): void {
    this.rendererReady = true;
    if (this.pendingRender) {
      // The previous renderer may have died before answering.
      this.options.emit({
        type: 'export.render',
        at: this.now(),
        ...this.pendingRender.request,
      });
      return;
    }
    void this.pump();
  }

  /** Reply to an `export.render` event. Unknown/stale replies are ignored. */
  deliverRender(args: {
    jobId: ExportJobId;
    requestId: string;
    rendered?: RenderedImage;
    opsKey?: string;
    error?: string;
  }): void {
    const pending = this.pendingRender;
    if (!pending || pending.jobId !== args.jobId || pending.request.requestId !== args.requestId) {
      return;
    }
    if (args.error !== undefined) {
      this.pendingRender = undefined;
      clearTimeout(pending.timer);
      pending.reject(new Error(args.error));
      return;
    }
    // The renderer proves what it drew; the photo must still have the same ops now,
    // in case a retouch commit landed while the render was in flight.
    const currentOpsKey = this.options.getOpsKey(pending.request.photoId, pending.request.version);
    if (
      args.opsKey === undefined ||
      args.opsKey !== pending.expectedOpsKey ||
      currentOpsKey !== pending.expectedOpsKey
    ) {
      this.pendingRender = undefined;
      clearTimeout(pending.timer);
      pending.reject(new Error('the render does not match the current retouch version'));
      return;
    }
    if (args.rendered === undefined) {
      this.pendingRender = undefined;
      clearTimeout(pending.timer);
      pending.reject(new Error('the renderer returned no image'));
      return;
    }
    this.pendingRender = undefined;
    clearTimeout(pending.timer);
    pending.resolve(args.rendered);
  }

  /** Stop processing. The current photo stays renderable after a restart. */
  close(): void {
    this.closed = true;
    if (this.pendingRender) {
      const pending = this.pendingRender;
      const job = this.jobs.find((candidate) => candidate.id === pending.jobId);
      const photo = job?.photos.find((candidate) => candidate.photoId === pending.request.photoId);
      if (photo && !terminalPhoto(photo.state)) photo.state = 'queued';
      this.pendingRender = undefined;
      clearTimeout(pending.timer);
      pending.reject(new Error('the export queue is closing'));
    }
    this.persist();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closed || !this.rendererReady) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.closed) break;
        const job = this.jobs.find(
          (candidate) => candidate.state === 'queued' || candidate.state === 'running',
        );
        if (!job) break;
        if (job.state === 'queued') {
          job.state = 'running';
          this.changed(job, 'state');
        }
        const photo = job.photos.find((candidate) => candidate.state === 'queued');
        if (!photo) {
          this.finish(job);
          continue;
        }
        await this.processPhoto(job, photo);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async processPhoto(job: ExportJob, photo: ExportPhotoProgress): Promise<void> {
    const preset = this.options.getPreset(job.presetId);
    if (!preset) {
      photo.state = 'failed';
      photo.error = `no export preset ${job.presetId}`;
      this.changed(job, 'progress', photo.photoId);
      return;
    }

    photo.state = 'rendering';
    this.changed(job, 'progress', photo.photoId);

    let rendered: RenderedImage;
    try {
      rendered = await this.requestRender(job, photo.photoId);
    } catch (error) {
      if (this.closed) {
        photo.state = 'queued';
        this.persist();
        return;
      }
      if (job.state === 'cancelled') {
        photo.state = 'cancelled';
      } else {
        photo.state = 'failed';
        photo.error = messageOf(error);
      }
      this.changed(job, 'progress', photo.photoId);
      return;
    }

    if (job.state === 'cancelled') {
      photo.state = 'cancelled';
      this.changed(job, 'progress', photo.photoId);
      return;
    }

    photo.state = 'exporting';
    this.changed(job, 'progress', photo.photoId);

    let exported: { path: string; fileName: string; skipped?: boolean };
    try {
      exported = await this.options.exportPhoto({ photoId: photo.photoId, preset, rendered });
    } catch (error) {
      photo.state = 'failed';
      photo.error = messageOf(error);
      this.changed(job, 'progress', photo.photoId);
      return;
    }
    photo.path = exported.path;

    if (this.closed) {
      this.options.discard?.(photo.photoId);
      photo.state = 'queued';
      delete photo.path;
      this.persist();
      return;
    }

    if (this.isCancelled(job)) {
      this.options.discard?.(photo.photoId);
      photo.state = 'cancelled';
      this.changed(job, 'progress', photo.photoId);
      return;
    }

    if (exported.skipped === true) {
      this.options.discard?.(photo.photoId);
      photo.state = 'skipped';
      this.changed(job, 'progress', photo.photoId);
      return;
    }

    if (job.send.length > 0) {
      photo.state = 'sending';
      this.changed(job, 'progress', photo.photoId);
      try {
        await this.options.enqueue({
          photoId: photo.photoId,
          path: exported.path,
          destinations: job.send,
        });
      } catch (error) {
        photo.state = 'failed';
        photo.error = messageOf(error);
        this.changed(job, 'progress', photo.photoId);
        return;
      }
    }

    photo.state = 'done';
    this.changed(job, 'progress', photo.photoId);
  }

  private requestRender(
    job: ExportJob,
    photoId: ExportPhotoProgress['photoId'],
  ): Promise<RenderedImage> {
    const opsKey = this.options.getOpsKey(photoId, job.version);
    const request: ExportRenderRequest = {
      jobId: job.id,
      requestId: this.newRequestId(),
      photoId,
      presetId: job.presetId,
      version: job.version,
      opsKey,
    };
    return new Promise<RenderedImage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRender?.request.requestId !== request.requestId) return;
        this.pendingRender = undefined;
        reject(new Error('the renderer did not answer in time'));
      }, this.renderTimeoutMs);
      timer.unref?.();
      this.pendingRender = {
        jobId: job.id,
        request,
        expectedOpsKey: opsKey,
        resolve,
        reject,
        timer,
      };
      this.options.emit({ type: 'export.render', at: this.now(), ...request });
    });
  }

  private isCancelled(job: ExportJob): boolean {
    return job.state === 'cancelled';
  }

  private finish(job: ExportJob): void {
    if (terminal(job.state)) return;
    const failed = job.photos.some((photo) => photo.state === 'failed');
    job.state = failed ? 'failed' : 'done';
    job.finishedAt = this.now();
    this.changed(job, 'state');
  }

  private changed(
    job: ExportJob,
    kind: 'state' | 'progress',
    photoId?: ExportPhotoProgress['photoId'],
  ): void {
    this.persist();
    if (kind === 'state') {
      this.options.emit({
        type: 'export.state',
        at: this.now(),
        jobId: job.id,
        state: job.state,
        job: cloneJob(job),
      });
      return;
    }
    this.options.emit({
      type: 'export.progress',
      at: this.now(),
      jobId: job.id,
      photoId: photoId ?? job.photos[0]?.photoId ?? job.photoIds[0]!,
      job: cloneJob(job),
    });
  }

  private load(): void {
    const file = this.options.file;
    if (file === undefined || !existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedJobs>;
      if (!Array.isArray(parsed.jobs)) throw new Error('jobs is not an array');
      for (const job of parsed.jobs as ExportJob[]) {
        if (typeof job?.id !== 'string' || !Array.isArray(job.photos)) continue;
        // A crash left running work behind: keep the photos queued, not lost.
        if (job.state === 'running' || job.state === 'queued') job.state = 'queued';
        if (job.version !== 'develop') job.version = 'top';
        for (const photo of job.photos) {
          if (
            photo.state === 'rendering' ||
            photo.state === 'exporting' ||
            photo.state === 'sending'
          ) {
            photo.state = 'queued';
            delete photo.path;
            delete photo.error;
          }
        }
        this.jobs.push(job);
      }
      for (const job of this.jobs) {
        if (!terminal(job.state) && job.photos.every((photo) => terminalPhoto(photo.state))) {
          this.finish(job);
        }
      }
    } catch (error) {
      const aside = `${file}.corrupt-${Date.now()}`;
      renameSync(file, aside);
      this.options.onWarning?.(
        `export jobs could not be read (${messageOf(error)}); moved to ${aside}`,
      );
    }
  }

  private persist(): void {
    const file = this.options.file;
    if (file === undefined) return;
    const terminalJobs = this.jobs.filter((job) => terminal(job.state));
    if (terminalJobs.length > MAX_STORED_JOBS) {
      const drop = new Set(
        terminalJobs
          .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt))
          .slice(0, terminalJobs.length - MAX_STORED_JOBS),
      );
      for (let index = this.jobs.length - 1; index >= 0; index--) {
        if (drop.has(this.jobs[index]!)) this.jobs.splice(index, 1);
      }
    }
    writeJsonAtomic(file, { version: FILE_VERSION, jobs: this.jobs } satisfies PersistedJobs);
  }
}

const terminal = (state: ExportJob['state']): boolean =>
  state === 'done' || state === 'failed' || state === 'cancelled';

const terminalPhoto = (state: ExportPhotoProgress['state']): boolean =>
  state === 'done' || state === 'skipped' || state === 'failed' || state === 'cancelled';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneJob(job: ExportJob): ExportJob {
  return {
    ...job,
    photoIds: [...job.photoIds],
    send: [...job.send],
    photos: job.photos.map((photo) => ({ ...photo })),
  };
}
