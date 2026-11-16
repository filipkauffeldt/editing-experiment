import {
  IpcError,
  type EventChannel,
  type LibraryFolderInfo,
  type LibraryOverview,
  type Photo,
  type PhotoId,
  type SourceId,
} from '@ee/contracts';
import type { PhotoIndex, PhotoQueryResult, PhotoRecord } from './photo-index';
import { normalizeExportPath } from './exported-files';
import type { SearchIndex } from './search-index';

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
    /** Caption and keyword search; absent in tests that do not need it. */
    private readonly search?: SearchIndex,
  ) {}

  list(sourceId?: SourceId): Photo[] {
    return this.index.list(sourceId);
  }

  /** The photos directly in a folder. */
  listFolder(folder: string): Photo[] {
    return this.index.listFolder(folder);
  }

  /** The photos whose status says edited. */
  listEdited(): Photo[] {
    return this.index.listEdited();
  }

  /** Ids of the photos in a folder, or below it too. */
  idsInFolder(folder: string, subfolders: boolean): PhotoId[] {
    return this.index.idsInFolder(folder, subfolders);
  }

  /** The folder tree with counts, without loading the photos. */
  overview(): LibraryOverview {
    return { total: this.index.count(), folders: this.folders() };
  }

  folders(): LibraryFolderInfo[] {
    return this.index.folders(this.index.addedFolders());
  }

  query(options: Parameters<PhotoIndex['query']>[0]): PhotoQueryResult {
    return this.index.query(options);
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

  /** Paths removed from the Library by the user (`removeFromLibrary`). */
  excludedPaths(): Set<string> {
    return this.index.excludedPaths();
  }

  /** Folders the user added to the Library in place, in the order they were added. */
  addedFolders(): string[] {
    return this.index.addedFolders();
  }

  addAddedFolder(path: string): void {
    this.index.addAddedFolder(path);
  }

  /** Forget a folder added in place; paths compare without regard to case on macOS and Windows. */
  removeAddedFolder(path: string): void {
    const stored = this.index
      .addedFolders()
      .find((folder) => normalizeExportPath(folder) === normalizeExportPath(path));
    if (stored !== undefined) this.index.removeAddedFolder(stored);
  }

  /** Index a newly ingested photo and announce it. */
  add(photo: Photo, templatePath?: string, sourcePath?: string): void {
    this.index.save(photo, templatePath, sourcePath);
    // A new file at a path the user had removed is a new photo, not the one they removed.
    this.index.clearExcluded(photo.path);
    this.search?.track(photo);
    this.emit('photos:added', photo);
  }

  /** The photo's caption or keywords may have changed on disk: search reads them again. */
  searchRefresh(photoId: PhotoId): void {
    this.search?.refresh(photoId);
  }

  /** Replace a photo with the result of `change`, announce it, and return it. */
  update(photoId: PhotoId, change: (photo: Photo) => Photo): Photo {
    const next = change(this.get(photoId));
    this.index.save(next);
    this.emit('photos:updated', next);
    return next;
  }

  /**
   * Drop a photo from the index and announce it. Callers hold the photo's lock, so no edit is
   * half done; one queued behind it finds no photo (`not_found`) instead of writing.
   */
  remove(photoId: PhotoId): boolean {
    const removed = this.index.remove(photoId);
    if (removed) {
      this.search?.forget(photoId);
      this.emit('photos:removed', { photoId });
    }
    return removed;
  }

  /**
   * Like {@link remove}, for a photo the user dropped from the Library with its file left in
   * place: the path is remembered so the startup scan does not index the file again.
   */
  removeAndExclude(photoId: PhotoId): boolean {
    const removed = this.index.removeAndExclude(photoId);
    if (removed) {
      this.search?.forget(photoId);
      this.emit('photos:removed', { photoId });
    }
    return removed;
  }

  /**
   * Like {@link removeAndExclude} for many photos, in one index transaction and with one event.
   * Used by Remove folder from Library, where 3,000 single events would flood the renderer.
   */
  removeManyAndExclude(photoIds: readonly PhotoId[]): PhotoId[] {
    const removed = this.index.removeManyAndExclude(photoIds);
    for (const photoId of removed) this.search?.forget(photoId);
    if (removed.length > 0) this.emit('photos:removedMany', { photoIds: removed });
    return removed;
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
