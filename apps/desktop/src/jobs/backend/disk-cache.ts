import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The shared limit for the thumbnail and preview caches. */
export const DEFAULT_CACHE_LIMIT_BYTES = 20 * 1024 ** 3;

export type CacheKind = 'thumb' | 'preview';

interface Entry {
  kind: CacheKind;
  size: number;
  usedAt: number;
}

/** Keep the newest files even when a burst of writes goes over the limit in one go. */
const PROTECT_MS = 10_000;
/** How often batched reads are written to the usage file. */
const FLUSH_MS = 60_000;
const USAGE_FILE = 'cache-usage.json';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Size limits for `cache/thumb` and `cache/preview` with least-recently-used eviction.
 *
 * Reads only touch an in-memory map; the map is written to `cache/cache-usage.json` in
 * batches, never once per served image. Previews are evicted before thumbnails: the
 * 2560 px previews are what fill a disk, and keeping the small thumbnails makes the grid
 * pleasant after a long shoot. Every file here is disposable and made again on demand.
 */
export class DiskCache {
  private readonly entries = new Map<string, Entry>();
  private limitBytes: number;
  private scan: Promise<void> | undefined;
  private eviction: Promise<void> | undefined;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private scanTimer: ReturnType<typeof setTimeout> | undefined;
  private scanDelayResolve: (() => void) | undefined;
  private evictTimer: ReturnType<typeof setTimeout> | undefined;
  private total = 0;
  private dirty = false;
  private closed = false;

  private readonly protectMs: number;
  private readonly scanDelayMs: number;

  constructor(
    private readonly dirs: Record<CacheKind, string>,
    limitBytes: number,
    private readonly warn: (message: string) => void = () => undefined,
    options: { protectMs?: number; scanDelayMs?: number } = {},
  ) {
    this.limitBytes = limitBytes;
    this.protectMs = options.protectMs ?? PROTECT_MS;
    this.scanDelayMs = options.scanDelayMs ?? 30_000;
  }

  /** Read the usage file and add files the index does not know yet. Runs in the background. */
  init(): void {
    if (this.scan) return;
    this.scan = (async () => {
      // Usage first (a small file), the directory scan later: a 100,000 file cache must not
      // compete with the first Library paint.
      await this.loadUsage();
      // A 100,000 file cache is scanned once the first Library paint and the first folder
      // switch are over; new files are counted as they are written.
      if (this.scanDelayMs > 0) {
        await new Promise<void>((resolve) => {
          this.scanDelayResolve = resolve;
          this.scanTimer = setTimeout(() => {
            this.scanTimer = undefined;
            this.scanDelayResolve = undefined;
            resolve();
          }, this.scanDelayMs);
        });
      }
      if (this.closed) return;
      for (const kind of Object.keys(this.dirs) as CacheKind[]) {
        await this.scanDir(kind, this.dirs[kind]);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await this.evict();
    })().catch((error: unknown) => this.warn(`cache scan failed: ${messageOf(error)}`));
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();
  }

  /** Wait for the initial scan (tests and statistics). */
  async ready(): Promise<void> {
    await this.scan;
  }

  stats(): { bytes: number; thumbBytes: number; previewBytes: number; limitBytes: number } {
    let thumbBytes = 0;
    let previewBytes = 0;
    for (const entry of this.entries.values()) {
      if (entry.kind === 'thumb') thumbBytes += entry.size;
      else previewBytes += entry.size;
    }
    return {
      bytes: this.total,
      thumbBytes,
      previewBytes,
      limitBytes: this.limitBytes,
    };
  }

  /** A read: cheap in memory, flushed in batches. */
  touch(file: string): void {
    const entry = this.entries.get(file);
    if (!entry) return;
    entry.usedAt = Date.now();
    this.dirty = true;
  }

  /** A file was written (or found): its size counts towards the limit. */
  async added(file: string, kind: CacheKind): Promise<void> {
    try {
      const { size } = await stat(file);
      const previous = this.entries.get(file);
      if (previous) this.total -= previous.size;
      this.entries.set(file, { kind, size, usedAt: Date.now() });
      this.total += size;
      this.dirty = true;
      await this.evict();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`cache: could not stat ${file}: ${messageOf(error)}`);
      }
    }
  }

  async removed(file: string): Promise<void> {
    const entry = this.entries.get(file);
    if (!entry) return;
    this.entries.delete(file);
    this.total -= entry.size;
    this.dirty = true;
  }

  async setLimit(limitBytes: number): Promise<void> {
    this.limitBytes = Math.max(0, Math.floor(limitBytes));
    await this.evict();
    await this.flush();
  }

  /** Delete every cached thumbnail and preview. They are remade on demand. */
  async clear(): Promise<void> {
    this.entries.clear();
    this.total = 0;
    for (const kind of Object.keys(this.dirs) as CacheKind[]) {
      await rm(this.dirs[kind], { recursive: true, force: true });
      await mkdir(this.dirs[kind], { recursive: true });
    }
    this.dirty = false;
    await rm(join(dirname(this.dirs.preview), USAGE_FILE), { force: true });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer !== undefined) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    if (this.scanTimer !== undefined) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    if (this.evictTimer !== undefined) clearTimeout(this.evictTimer);
    this.evictTimer = undefined;
    this.scanDelayResolve?.();
    this.scanDelayResolve = undefined;
    await this.scan;
    await this.flush();
  }

  private async loadUsage(): Promise<void> {
    const file = join(dirname(this.dirs.preview), USAGE_FILE);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (!Array.isArray(item) || item.length !== 4) continue;
        const [kind, path, size, usedAt] = item as unknown[];
        if (
          (kind !== 'thumb' && kind !== 'preview') ||
          typeof path !== 'string' ||
          typeof size !== 'number' ||
          typeof usedAt !== 'number'
        ) {
          continue;
        }
        this.entries.set(path, { kind, size, usedAt });
        this.total += size;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        this.warn(`cache usage file could not be read: ${messageOf(error)}`);
      }
    }
  }

  private async scanDir(kind: CacheKind, directory: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    // Small batches between event-loop turns: the jobs process stays responsive to the
    // first folder switch while a large cache is being inventoried.
    for (let at = 0; at < names.length; at += 250) {
      if (this.closed) return;
      await Promise.all(
        names.slice(at, at + 250).map(async (name) => {
          if (name.endsWith('.tmp') || name === '_placeholder.jpg') return;
          const file = join(directory, name);
          if (this.entries.has(file)) return;
          try {
            const info = await stat(file);
            if (info.isFile()) {
              this.entries.set(file, { kind, size: info.size, usedAt: info.mtimeMs });
              this.total += info.size;
            }
          } catch {
            // Gone between readdir and stat: nothing to account for.
          }
        }),
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const rows = [...this.entries].map(([path, entry]) => [
      entry.kind,
      path,
      entry.size,
      entry.usedAt,
    ]);
    const file = join(dirname(this.dirs.preview), USAGE_FILE);
    const temp = `${file}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(rows));
      await rename(temp, file);
    } catch (error) {
      this.dirty = true;
      this.warn(`cache usage file could not be written: ${messageOf(error)}`);
    }
  }

  /**
   * Evict until the total fits. Previews go first, oldest first; thumbnails are only
   * touched when no preview is left. Files written moments ago are kept, so a render
   * that is still being handed to the browser is never deleted underneath it.
   */
  private async evict(): Promise<void> {
    if (this.eviction) return this.eviction;
    this.eviction = (async () => {
      let total = this.total;
      if (total <= this.limitBytes) return;
      const now = Date.now();
      const candidates = [...this.entries]
        .filter(
          ([path, entry]) =>
            !path.endsWith('_placeholder.jpg') && now - entry.usedAt >= this.protectMs,
        )
        .sort((left, right) => {
          const [leftPath, a] = left;
          const [rightPath, b] = right;
          if (a.kind !== b.kind) return a.kind === 'preview' ? -1 : 1;
          if (a.usedAt !== b.usedAt) return a.usedAt - b.usedAt;
          return leftPath.localeCompare(rightPath);
        });
      for (const [path, entry] of candidates) {
        if (total <= this.limitBytes) break;
        try {
          await rm(path, { force: true });
          this.entries.delete(path);
          total -= entry.size;
          this.total = total;
          this.dirty = true;
        } catch (error) {
          this.warn(`cache: could not evict ${path}: ${messageOf(error)}`);
        }
      }
      if (total > this.limitBytes && this.evictTimer === undefined) {
        // Everything left was written moments ago; look again once it is no longer protected.
        this.evictTimer = setTimeout(() => {
          this.evictTimer = undefined;
          void this.evict();
        }, this.protectMs + 1_000);
        this.evictTimer.unref?.();
      }
    })().finally(() => {
      this.eviction = undefined;
    });
    return this.eviction;
  }
}
