import type { PhotoId } from '@ee/contracts';
import { decodeJpeg, encodeJpeg, extractPreview, type RawPreview } from '@ee/core';
import { isRawPath } from '@ee/metadata';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { decodeOrientedRgba } from './image-ops';

/** What {@link FullImageCache} needs to know of a photo. */
export interface FullImageSource {
  id: PhotoId;
  path: string;
  /** EXIF orientation (1..8) of a JPEG's stored pixels; absent means upright. */
  orientation?: number;
}

export interface FullImageEntry {
  file: string;
  bytes: number;
}

export interface FullImageCacheOptions {
  dir: string;
  /** Most files kept. Default 32. */
  maxEntries?: number;
  /** Most bytes kept. Default 512 MiB. */
  maxBytes?: number;
  /** Test seam. */
  extract?: (path: string) => Promise<RawPreview>;
}

/** A photo whose format has no JPEG to zoom into (TIFF, PNG, HEIF …). */
export class NoFullImageError extends Error {}

const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe']);
const REENCODE_QUALITY = 92;

/**
 * The camera's own full-size JPEG of each photo, upright, in files under `cache/full` that main
 * streams like the other `app://` images. A raw gives its largest embedded preview (LibRaw reads
 * it, nothing is decoded from sensor data) and a JPEG gives the file itself. The bytes are kept
 * as they are when they are already upright, so a landscape frame costs one read and one write;
 * a turned frame is decoded and encoded once, and the result is cached like the rest.
 *
 * It holds the camera's pixels, undeveloped and uncropped. {@link AppResources} only asks for it
 * for a photo without retouching, so what a retouch hides never leaves through here.
 *
 * Bounded: at most `maxEntries` files and `maxBytes` bytes, least recently used first. The
 * directory is emptied on {@link init}, so leftovers of a crashed run are never tracked.
 */
export class FullImageCache {
  private readonly entries = new Map<PhotoId, FullImageEntry>();
  private readonly inFlight = new Map<PhotoId, Promise<FullImageEntry>>();
  /** Builds of a deleted photo: their result is thrown away when they finish. */
  private readonly discarded = new Set<PhotoId>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly extract: NonNullable<FullImageCacheOptions['extract']>;

  constructor(private readonly options: FullImageCacheOptions) {
    this.maxEntries = options.maxEntries ?? 32;
    this.maxBytes = options.maxBytes ?? 512 * 1024 ** 2;
    this.extract = options.extract ?? extractPreview;
  }

  async init(): Promise<void> {
    await rm(this.options.dir, { recursive: true, force: true });
    await mkdir(this.options.dir, { recursive: true });
  }

  /** The cached file of a photo, built first when it is not there yet. */
  ensure(photo: FullImageSource): Promise<FullImageEntry> {
    const cached = this.entries.get(photo.id);
    if (cached) {
      // Re-insert to mark it most recently used.
      this.entries.delete(photo.id);
      this.entries.set(photo.id, cached);
      return Promise.resolve(cached);
    }
    const pending = this.inFlight.get(photo.id);
    if (pending) return pending;
    const run = this.build(photo).finally(() => {
      this.inFlight.delete(photo.id);
      this.discarded.delete(photo.id);
    });
    this.inFlight.set(photo.id, run);
    return run;
  }

  /** The photo was deleted: drop its file, and discard a build that is still running. */
  async forget(photoId: PhotoId): Promise<void> {
    if (this.inFlight.has(photoId)) this.discarded.add(photoId);
    const entry = this.entries.get(photoId);
    if (!entry) return;
    this.entries.delete(photoId);
    await rm(entry.file, { force: true }).catch(() => undefined);
  }

  /** Photos with a file now, oldest use first. */
  cached(): PhotoId[] {
    return [...this.entries.keys()];
  }

  private async build(photo: FullImageSource): Promise<FullImageEntry> {
    const file = join(this.options.dir, `${photo.id}.jpg`);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.options.dir, { recursive: true });
      await this.write(photo, temp);
      if (this.discarded.has(photo.id)) throw new Error('the photo was deleted');
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    const entry: FullImageEntry = { file, bytes: (await stat(file)).size };
    this.entries.set(photo.id, entry);
    await this.evict(photo.id);
    return entry;
  }

  private async write(photo: FullImageSource, target: string): Promise<void> {
    if (isRawPath(photo.path)) {
      const preview = await this.extract(photo.path);
      if (preview.orientation >= 2 && preview.orientation <= 8) {
        // Embedded previews are stored in sensor orientation, and the browser is told to ignore
        // any tag in them (`image-orientation: none`), so a turned frame is turned here.
        const upright = await decodeOrientedRgba(preview.jpeg, preview.orientation);
        await writeFile(
          target,
          await encodeJpeg(upright.rgba, upright.width, upright.height, {
            quality: REENCODE_QUALITY,
            chroma: '420',
            iccSrgb: true,
          }),
        );
        return;
      }
      await writeFile(target, preview.jpeg);
      return;
    }
    if (!JPEG_EXTENSIONS.has(extname(photo.path).toLowerCase())) {
      throw new NoFullImageError(
        `${extname(photo.path) || 'this format'} has no JPEG to zoom into`,
      );
    }
    const orientation = photo.orientation ?? 1;
    if (orientation >= 2 && orientation <= 8) {
      // The decoder applies the file's own tag, and the copy carries none.
      const upright = await decodeJpeg(await readFile(photo.path));
      await writeFile(
        target,
        await encodeJpeg(upright.rgba, upright.width, upright.height, {
          quality: REENCODE_QUALITY,
          chroma: '420',
          iccSrgb: true,
        }),
      );
      return;
    }
    await copyFile(photo.path, target);
  }

  /** Drop least recently used files until the limits hold. The file just asked for stays. */
  private async evict(keep: PhotoId): Promise<void> {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    for (const [id, entry] of [...this.entries]) {
      if (this.entries.size <= this.maxEntries && total <= this.maxBytes) break;
      if (id === keep) continue;
      this.entries.delete(id);
      total -= entry.bytes;
      // A reader may still be streaming it; on Windows that delete fails and the file is
      // removed with the whole directory at next start.
      await rm(entry.file, { force: true }).catch(() => undefined);
    }
  }
}
