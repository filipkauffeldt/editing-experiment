import type {
  EditParams,
  Photo,
  PhotoId,
  RenderedImage,
  RetouchOp,
  SetEditedPreviewArgs,
} from '@ee/contracts';

export interface EditedPreviewRenderer {
  (
    photo: Photo,
    params: EditParams,
    ops: RetouchOp[],
  ): Promise<{
    thumb: RenderedImage;
    preview: RenderedImage;
  }>;
}

export interface EditedPreviewDeps {
  render: EditedPreviewRenderer;
  /** The newest copy of the photo, or undefined when it is gone. */
  getPhoto(photoId: PhotoId): Photo | undefined;
  /** Resolves once the photo's slider/crop changes have reached its sidecar. */
  settle(photoId: PhotoId): Promise<void>;
  /** The develop params as the user last left them, including unsaved ones. */
  getParams(photoId: PhotoId): Promise<EditParams>;
  /** The retouch ops the preview must show (the top retouch version's). */
  getRetouchOps(photo: Photo): RetouchOp[];
  store(args: SetEditedPreviewArgs): Promise<Photo>;
  /** The photo as the backend has it after a render was stored (or refused). */
  onStored?(photo: Photo): void;
  onError(photo: Photo, error: unknown): void;
  /** Quiet time after the last edit before rendering. Default 750 ms. */
  debounceMs?: number;
  /** Pause between two background renders of photos nobody edited. Default 250 ms. */
  backgroundGapMs?: number;
  /** After a failed background render the photo is left alone this long. Default 30 s. */
  failureBackoffMs?: number;
  /** Times a render the backend refused because the edits moved on is tried again. Default 3. */
  maxRefusals?: number;
}

type Priority = 'urgent' | 'edit' | 'background';

interface Job {
  photoId: PhotoId;
  /** Grows with every edit; a render of an older one is thrown away. */
  revision: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Waiting for its turn, with this priority. */
  queued: Priority | undefined;
  refusals: number;
}

const RANK: Record<Priority, number> = { urgent: 0, edit: 1, background: 2 };

/** True when the develop params differ from a freshly ingested photo (see `hasDevelopEdits` in the backend). */
export function hasDevelopEdits(params: EditParams): boolean {
  return Object.entries(params).some(([key, value]) => {
    if (value === undefined || key === 'ProcessVersion') return false;
    return !(key === 'WhiteBalance' && value === 'As Shot');
  });
}

/**
 * Keeps each edited photo's thumbnail and preview up to date.
 *
 * - `schedule` (an edit) waits for the edits to settle, then renders. Edits to the
 *   same photo coalesce into one render and restart the wait.
 * - `scheduleNow` (a retouch commit) skips the wait: a face must not stay visible.
 * - `ensure` (a photo is viewed or in the film strip) renders photos whose edits
 *   never made it into the cache, one at a time with pauses between.
 *
 * Renders run one at a time so the GPU and the IPC stay free for the sliders. A
 * pending photo is kept when the user selects another one, so its thumbnail still
 * gets made. Nothing here blocks a caller; errors go to `onError`.
 */
export class EditedPreviewScheduler {
  private readonly jobs = new Map<PhotoId, Job>();
  private readonly failedAt = new Map<PhotoId, number>();
  private lastRevision = 0;
  private running: PhotoId | undefined;
  private finishedAt = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private idle: (() => void)[] = [];

  constructor(private readonly deps: EditedPreviewDeps) {}

  /** An edit happened: render once things have been quiet for the debounce. */
  schedule(photoId: PhotoId): void {
    if (this.disposed) return;
    const job = this.job(photoId);
    job.revision = this.nextRevision();
    job.refusals = 0;
    job.queued = undefined;
    this.failedAt.delete(photoId);
    if (job.timer !== undefined) clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      job.timer = undefined;
      this.enqueue(job, 'edit');
    }, this.deps.debounceMs ?? 750);
  }

  /** Render as soon as the renderer is free, ahead of everything else. */
  scheduleNow(photoId: PhotoId): void {
    if (this.disposed) return;
    const job = this.job(photoId);
    job.revision = this.nextRevision();
    job.refusals = 0;
    this.failedAt.delete(photoId);
    this.enqueue(job, 'urgent');
  }

  /** Skip the rest of the wait for a photo whose edit is still settling. */
  promote(photoId: PhotoId): void {
    const job = this.jobs.get(photoId);
    if (!job || job.timer === undefined || this.disposed) return;
    this.enqueue(job, 'edit');
  }

  /**
   * The photo is on screen: make sure its cached images show its edits. Only
   * photos the backend reports as stale are rendered (edited in Lightroom before
   * ingest, edited before the app quit mid-debounce, a wiped cache).
   */
  ensure(photoId: PhotoId): void {
    if (this.disposed) return;
    const photo = this.deps.getPhoto(photoId);
    if (!photo?.status.edited || !photo.previewStale) return;
    const existing = this.jobs.get(photoId);
    if (existing && (existing.timer !== undefined || existing.queued !== undefined)) return;
    if (this.running === photoId) return;
    const failed = this.failedAt.get(photoId);
    if (failed !== undefined && Date.now() - failed < (this.deps.failureBackoffMs ?? 30_000)) {
      return;
    }
    const job = this.job(photoId);
    job.revision = this.nextRevision();
    job.refusals = 0;
    this.enqueue(job, 'background');
  }

  /** Render everything that is waiting now, and resolve when the queue is empty. */
  async flush(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.timer !== undefined) this.enqueue(job, 'edit');
    }
    if (this.running === undefined && !this.hasQueued()) return;
    await new Promise<void>((resolve) => this.idle.push(resolve));
  }

  /** Drop everything that has not started. A render in flight is not stored. */
  dispose(): void {
    this.disposed = true;
    for (const job of this.jobs.values()) {
      if (job.timer !== undefined) clearTimeout(job.timer);
    }
    if (this.pumpTimer !== undefined) clearTimeout(this.pumpTimer);
    this.jobs.clear();
    for (const resolve of this.idle.splice(0)) resolve();
  }

  private nextRevision(): number {
    // Wall-clock based so revisions keep growing across app restarts, which the
    // backend compares against what it already stored.
    this.lastRevision = Math.max(this.lastRevision + 1, Date.now());
    return this.lastRevision;
  }

  private job(photoId: PhotoId): Job {
    let job = this.jobs.get(photoId);
    if (!job) {
      job = { photoId, revision: 0, timer: undefined, queued: undefined, refusals: 0 };
      this.jobs.set(photoId, job);
    }
    return job;
  }

  private enqueue(job: Job, priority: Priority): void {
    if (job.timer !== undefined) {
      clearTimeout(job.timer);
      job.timer = undefined;
    }
    if (job.queued === undefined || RANK[priority] < RANK[job.queued]) job.queued = priority;
    this.pump();
  }

  private hasQueued(): boolean {
    for (const job of this.jobs.values()) if (job.queued !== undefined) return true;
    return false;
  }

  private next(): Job | undefined {
    let best: Job | undefined;
    for (const job of this.jobs.values()) {
      if (job.queued === undefined) continue;
      if (!best || RANK[job.queued] < RANK[best.queued!]) best = job;
    }
    return best;
  }

  private pump(): void {
    if (this.disposed || this.running !== undefined) return;
    const job = this.next();
    if (!job) {
      for (const resolve of this.idle.splice(0)) resolve();
      return;
    }
    if (job.queued === 'background') {
      const wait = (this.deps.backgroundGapMs ?? 250) - (Date.now() - this.finishedAt);
      if (wait > 0) {
        this.pumpTimer ??= setTimeout(() => {
          this.pumpTimer = undefined;
          this.pump();
        }, wait);
        return;
      }
    }
    const priority = job.queued;
    job.queued = undefined;
    this.running = job.photoId;
    void this.run(job, priority!).finally(() => {
      this.running = undefined;
      this.finishedAt = Date.now();
      this.pump();
    });
  }

  private async run(job: Job, priority: Priority): Promise<void> {
    const { deps } = this;
    const revision = job.revision;
    const superseded = (): boolean => job.revision !== revision || this.disposed;
    let photo = deps.getPhoto(job.photoId);
    if (!photo) return;
    try {
      await deps.settle(job.photoId);
      if (superseded()) return;
      // Read after settling: a retouch commit may have replaced the photo meanwhile.
      photo = deps.getPhoto(job.photoId) ?? photo;
      const [params, ops] = [await deps.getParams(job.photoId), deps.getRetouchOps(photo)];
      // Nothing to show: the backend already went back to the camera preview.
      if (!hasDevelopEdits(params) && ops.length === 0) return;
      const images = await deps.render(photo, params, ops);
      // A newer edit made this render obsolete; its own render follows.
      if (superseded()) return;
      const stored = await deps.store({
        photoId: job.photoId,
        revision,
        retouchOps: ops,
        ...images,
      });
      deps.onStored?.(stored);
      if (superseded()) return;
      // Still stale: the sidecar or the retouch ops changed under the render.
      if (stored.previewStale && job.refusals < (deps.maxRefusals ?? 3)) {
        job.refusals += 1;
        job.revision = this.nextRevision();
        // Give the news of the newer edit time to arrive before drawing again.
        job.timer = setTimeout(() => {
          job.timer = undefined;
          this.enqueue(job, priority === 'background' ? 'background' : 'edit');
        }, deps.debounceMs ?? 750);
      }
    } catch (error) {
      if (this.disposed) return;
      this.failedAt.set(job.photoId, Date.now());
      deps.onError(photo, error);
    }
  }
}
