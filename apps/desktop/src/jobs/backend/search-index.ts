import type { IptcFields, Photo, PhotoId, SearchPhotosResult } from '@ee/contracts';
import { matchesSearch, searchTerms, searchTextOf } from '@ee/metadata';
import type { PhotoIndex } from './photo-index';

interface Entry {
  fileName: string;
  /** Caption and keywords, normalised; null until they have been read. */
  text: string | null;
  /** Changed since `text` was read: still searchable, but counted as pending. */
  stale?: boolean;
}

/**
 * Search over the whole Library by file name, caption and keywords.
 *
 * The renderer only has caption and keywords for the photo it has open (`metadata:read`), so
 * the text lives here. It is kept in memory (a few hundred bytes per photo) and mirrored into
 * the photo index database as a cache, so a restart does not read thousands of sidecars again.
 * A query is then a substring test per photo, a few milliseconds for tens of thousands.
 *
 * A photo is read once when it is added (or when its metadata changes), by a small background
 * queue, so ingest and typing never wait for it. The sidecar stays the source of truth: a
 * caption changed by another program is picked up when that photo is next written here.
 */
export class SearchIndex {
  private readonly entries = new Map<PhotoId, Entry>();
  private readonly queue = new Set<PhotoId>();
  private running: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly index: PhotoIndex,
    /** Reads the IPTC fields of a photo's file or sidecar. */
    private readonly read: (photo: Photo) => Promise<Pick<IptcFields, 'caption' | 'keywords'>>,
    private readonly warn: (message: string) => void = () => undefined,
    private readonly concurrency = 2,
  ) {
    for (const row of index.searchRows()) {
      this.entries.set(row.id, { fileName: row.fileName, text: row.text });
      if (row.text === null) this.queue.add(row.id);
    }
  }

  /** Start reading whatever has no text yet (everything, for an index made before search). */
  start(): void {
    this.drain();
  }

  /** A photo was indexed: its file name is searchable now, its text when it has been read. */
  track(photo: Photo): void {
    this.entries.set(photo.id, { fileName: photo.fileName, text: null });
    this.refresh(photo.id);
  }

  /** The photo's caption or keywords may have changed: read them again. */
  refresh(photoId: PhotoId): void {
    if (this.closed) return;
    const entry = this.entries.get(photoId);
    if (entry) entry.stale = true;
    this.queue.add(photoId);
    this.drain();
  }

  forget(photoId: PhotoId): void {
    this.entries.delete(photoId);
    this.queue.delete(photoId);
  }

  search(query: string): SearchPhotosResult {
    const terms = searchTerms(query);
    const photoIds: PhotoId[] = [];
    let pending = 0;
    for (const [id, entry] of this.entries) {
      if (entry.text === null || entry.stale === true) pending += 1;
      if (matchesSearch(entry.fileName, entry.text ?? '', terms)) photoIds.push(id);
    }
    return { photoIds, pending };
  }

  /** Resolves when every photo queued so far has been read (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.clear();
    await this.idle();
  }

  private drain(): void {
    if (this.running || this.closed || this.queue.size === 0) return;
    this.running = this.work().finally(() => {
      this.running = undefined;
      // Something was queued while the last read finished.
      if (this.queue.size > 0) this.drain();
    });
  }

  private async work(): Promise<void> {
    const worker = async (): Promise<void> => {
      while (!this.closed) {
        const next = this.queue.values().next();
        if (next.done) return;
        this.queue.delete(next.value);
        await this.load(next.value);
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
  }

  private async load(photoId: PhotoId): Promise<void> {
    const entry = this.entries.get(photoId);
    const record = this.index.get(photoId);
    if (!entry || !record) return;
    let text: string;
    try {
      text = searchTextOf(await this.read(record.photo));
    } catch (error) {
      // An unreadable file must not stay "pending" for ever; its name still matches.
      this.warn(
        `search: could not read ${record.photo.fileName}: ${error instanceof Error ? error.message : String(error)}`,
      );
      text = '';
    }
    // Forgotten or removed while the read was going.
    if (this.closed || this.entries.get(photoId) !== entry || !this.index.get(photoId)) return;
    entry.text = text;
    // Changed again while this read was going: it is queued once more and stays pending.
    if (!this.queue.has(photoId)) entry.stale = false;
    this.index.setSearchText(photoId, text);
  }
}
