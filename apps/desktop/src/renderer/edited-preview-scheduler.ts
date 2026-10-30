import type {
  EditParams,
  Photo,
  PhotoId,
  RenderedImage,
  ResolvedProfile,
  RetouchOp,
  SetEditedPreviewArgs,
} from '@ee/contracts';

export interface EditedPreviewRenderer {
  (
    photo: Photo,
    params: EditParams,
    ops: RetouchOp[],
    options?: { profile?: ResolvedProfile | null },
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
  /** The photo turned out to have no edits at all; its stale flag can be cleared locally. */
  onNoEdits?(photo: Photo): void;
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
  /** When it was queued; background jobs go newest first. */
  queuedSeq: number;
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
 * - `setSelected` / `setVisible` (the photo on screen, the film strip's frames) render
 *   photos whose edits never made it into the cache, one at a time with pauses
 *   between. Only what is on screen counts: when the strip scrolls on, queued photos
 *   that left it are dropped, and the rest go selected first, then newest first.
 *
 * Renders run one at a time so the GPU and the IPC stay free for the sliders. A
 * pending edit is kept when the user selects another photo, so its thumbnail still
 * gets made. Finished jobs are forgotten, so a long session does not accumulate
 * state per photo. Nothing here blocks a caller; errors go to `onError`.
 */
export class EditedPreviewScheduler {
  private readonly jobs = new Map<PhotoId, Job>();
  private readonly failedAt = new Map<PhotoId, number>();
  /** Photos found to have no edits since their last edit; not looked at again. */
  private readonly noEdits = new Set<PhotoId>();
  private visible: ReadonlySet<PhotoId> = new Set();
  private selected: PhotoId | undefined;
  private lastRevision = 0;
  private seq = 0;
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
    this.noEdits.delete(photoId);
    this.enqueue(job, 'urgent');
  }

  /** Skip the rest of the wait for a photo whose edit is still settling. */
  promote(photoId: PhotoId): void {
    const job = this.jobs.get(photoId);
    if (!job || job.timer === undefined || this.disposed) return;
    this.enqueue(job, 'edit');
  }

  /** The photo in the main view. Its edits are drawn before those of the film strip. */
  setSelected(photoId: PhotoId | undefined): void {
    if (this.disposed) return;
    this.selected = photoId;
    if (photoId === undefined) return;
    // A retouched photo that could not be drawn has a placeholder instead of an image
    // until it is; whoever opens it should not wait out the backoff.
    const photo = this.deps.getPhoto(photoId);
    if (photo && this.deps.getRetouchOps(photo).length > 0) this.failedAt.delete(photoId);
    this.ensure(photoId);
  }

  /**
   * The frames the film strip shows now (the strip reports its whole window, not
   * only the stale ones). Queued background renders of photos that scrolled out of
   * view are dropped; the ones in view are queued, newest first.
   */
  setVisible(photoIds: readonly PhotoId[]): void {
    if (this.disposed) return;
    this.visible = new Set(photoIds);
    for (const job of [...this.jobs.values()]) {
      if (job.queued === 'background' && !this.wanted(job.photoId)) {
        job.queued = undefined;
        this.forget(job);
      }
    }
    for (const photoId of photoIds) this.ensure(photoId);
  }

  private wanted(photoId: PhotoId): boolean {
    return photoId === this.selected || this.visible.has(photoId);
  }

  /**
   * Make sure an on-screen photo's cached images show its edits. Only photos the
   * backend reports as stale are rendered (edited in Lightroom before ingest, edited
   * before the app quit mid-debounce, a wiped cache).
   */
  private ensure(photoId: PhotoId): void {
    if (!this.wanted(photoId)) return;
    const photo = this.deps.getPhoto(photoId);
    if (!photo?.status.edited || !photo.previewStale) return;
    const existing = this.jobs.get(photoId);
    if (existing && (existing.timer !== undefined || existing.queued !== undefined)) return;
    if (this.running === photoId || this.noEdits.has(photoId)) return;
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

  private noteFailure(photoId: PhotoId): void {
    const now = Date.now();
    this.failedAt.set(photoId, now);
    if (this.failedAt.size <= 100) return;
    const backoff = this.deps.failureBackoffMs ?? 30_000;
    for (const [id, at] of this.failedAt) if (now - at >= backoff) this.failedAt.delete(id);
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
      job = {
        photoId,
        revision: 0,
        timer: undefined,
        queued: undefined,
        queuedSeq: 0,
        refusals: 0,
      };
      this.jobs.set(photoId, job);
    }
    return job;
  }

  private enqueue(job: Job, priority: Priority): void {
    if (job.timer !== undefined) {
      clearTimeout(job.timer);
      job.timer = undefined;
    }
    if (job.queued === undefined || RANK[priority] < RANK[job.queued]) {
      job.queued = priority;
      job.queuedSeq = ++this.seq;
    }
    this.pump();
  }

  /** Drop a job that has nothing left to do, so state does not pile up per photo. */
  private forget(job: Job): void {
    if (job.timer !== undefined || job.queued !== undefined || this.running === job.photoId) return;
    if (this.jobs.get(job.photoId) === job) this.jobs.delete(job.photoId);
  }

  private hasQueued(): boolean {
    for (const job of this.jobs.values()) if (job.queued !== undefined) return true;
    return false;
  }

  /** Urgent before edits before background; the selected photo first; background newest first. */
  private goesBefore(a: Job, b: Job): boolean {
    const [rankA, rankB] = [RANK[a.queued!], RANK[b.queued!]];
    if (rankA !== rankB) return rankA < rankB;
    const selectedA = a.photoId === this.selected;
    if (selectedA !== (b.photoId === this.selected)) return selectedA;
    return a.queued === 'background' ? a.queuedSeq > b.queuedSeq : a.queuedSeq < b.queuedSeq;
  }

  private next(): Job | undefined {
    let best: Job | undefined;
    for (const job of this.jobs.values()) {
      if (job.queued === undefined) continue;
      if (!best || this.goesBefore(job, best)) best = job;
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
      this.forget(job);
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
      if (!hasDevelopEdits(params) && ops.length === 0) {
        // Nothing to show: the camera preview is right. Remember it, so scrolling
        // past this photo does not read its params again and again.
        this.noEdits.add(job.photoId);
        if (photo.previewStale) deps.onNoEdits?.(photo);
        return;
      }
      const images = await deps.render(photo, params, ops);
      // A newer edit made this render obsolete; its own render follows.
      if (superseded()) return;
      const stored = await deps.store({
        photoId: job.photoId,
        revision,
        retouchOps: ops,
        params,
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
      this.noteFailure(job.photoId);
      deps.onError(photo, error);
    }
  }
}
