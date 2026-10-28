import {
  IpcError,
  type EventChannel,
  type Photo,
  type PhotoId,
  type SourceId,
} from '@ee/contracts';
import type { PhotoIndex, PhotoRecord } from './photo-index';

export type Emit = (channel: EventChannel, payload: unknown) => void;

/**
 * The index plus change notification and per-photo locking. Everything that
 * changes a photo goes through here so the renderer hears about it.
 */
export class PhotoLibrary {
  private readonly locks = new Map<PhotoId, Promise<unknown>>();

  constructor(
    private readonly index: PhotoIndex,
    private readonly emit: Emit,
  ) {}

  list(sourceId?: SourceId): Photo[] {
    return this.index.list(sourceId);
  }

  record(photoId: PhotoId): PhotoRecord {
    const record = this.index.get(photoId);
    if (!record) throw new IpcError('not_found', `no photo ${photoId}`);
    return record;
  }

  get(photoId: PhotoId): Photo {
    return this.record(photoId).photo;
  }

  hasPath(path: string): boolean {
    return this.index.hasPath(path);
  }

  /** Index a newly ingested photo and announce it. */
  add(photo: Photo, templatePath?: string): void {
    this.index.save(photo, templatePath);
    this.emit('photos:added', photo);
  }

  /** Replace a photo with the result of `change`, announce it, and return it. */
  update(photoId: PhotoId, change: (photo: Photo) => Photo): Photo {
    const next = change(this.get(photoId));
    this.index.save(next);
    this.emit('photos:updated', next);
    return next;
  }

  setTemplatePath(photoId: PhotoId, templatePath: string | undefined): void {
    this.index.setTemplatePath(photoId, templatePath);
  }

  /**
   * Run `task` after earlier tasks for the same photo. Sidecar edits are
   * read-modify-write, so two at once could lose one.
   */
  async withLock<T>(photoId: PhotoId, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(photoId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.locks.set(photoId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(photoId) === tail) this.locks.delete(photoId);
    }
  }
}
