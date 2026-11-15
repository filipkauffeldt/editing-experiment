import {
  APP_PROTOCOL,
  LINEAR_IMAGE_HEADER,
  IpcError,
  asPhotoId,
  type LensShotInfo,
  type LinearImageHeader,
  type Photo,
} from '@ee/contracts';
import {
  decodeJpeg,
  decodeLinear,
  resizeRgba,
  type DecodeLinearOptions,
  type LinearImage,
} from '@ee/core';
import { isRawPath } from '@ee/metadata';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppBackendResponse } from '../../shared/jobs-protocol';
import { retouchKey } from './edited-previews';
import { FullImageCache, NoFullImageError } from './full-images';
import type { PhotoLibrary } from './photo-library';
import { SAFE_PHOTO_ID, type PreviewCache, type PreviewKind, type ServedFile } from './previews';

const text = (status: number, body: string): AppBackendResponse => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body,
});

/** Most decodes waiting ahead of time: the next photo and the previous one. */
const WARM_PENDING = 2;

interface WarmRequest {
  key: string;
  path: string;
  maxEdge: number | undefined;
  answer: (response: AppBackendResponse) => void;
}

const warmAnswer = (state: 'ready' | 'dropped' | 'failed'): AppBackendResponse => ({
  status: 204,
  headers: { 'x-ee-warm': state },
});

interface LinearEntry {
  file: string;
  bytes: number;
  header: LinearImageHeader;
}

export interface AppResourcesOptions {
  photos: PhotoLibrary;
  previews: PreviewCache;
  /** Directory for decoded linear images; emptied on {@link AppResources.init}. */
  linearDir: string;
  /** Directory for the camera's full-size JPEGs; defaults to `full` next to `linearDir`. */
  fullDir?: string;
  /** Most decoded images kept. Default 6: the open photo's two sizes and its neighbours'. */
  maxEntries?: number;
  /** Most bytes of decoded images kept. Default 1.5 GiB. */
  maxBytes?: number;
  /**
   * Lens facts of a raw (EXIF lens, focal length, the camera's own correction), for the lens
   * corrections in the develop pipeline. `frame` is the full-resolution size of the decoded image.
   * Failing or returning nothing leaves the header without lens data.
   */
  lensShot?: (
    path: string,
    frame: { width: number; height: number },
  ) => Promise<LensShotInfo | undefined>;
  /** Test seam. */
  decode?: (path: string, options: DecodeLinearOptions) => Promise<LinearImage>;
  /** Test seam: the embedded preview of a raw. */
  extract?: ConstructorParameters<typeof FullImageCache>[0]['extract'];
}

/**
 * Answers `app://thumb|preview|full|linear/<photoId>` for the main process.
 *
 * Decoded linear images are written to files under the cache directory (a small
 * LRU of them) and returned by path: main streams the file to the renderer, so
 * a 35 MB image never goes through main's heap or a message, and the decode runs
 * off the main process entirely.
 */
export class AppResources {
  private readonly entries = new Map<string, LinearEntry>();
  private readonly inFlight = new Map<string, Promise<LinearEntry>>();
  /** In-flight decodes of a deleted photo: their result is thrown away when they finish. */
  private readonly discarded = new Set<string>();
  private readonly lensShots = new Map<string, Promise<LensShotInfo | undefined>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly decode: NonNullable<AppResourcesOptions['decode']>;
  private readonly fullImages: FullImageCache;
  /** Decodes asked for by the photo on screen that are still running. */
  private liveDecodes = 0;
  /** Decodes asked for ahead of time, waiting for the photo on screen to be served first. */
  private readonly warmQueue: WarmRequest[] = [];
  private warming = false;

  constructor(private readonly options: AppResourcesOptions) {
    this.fullImages = new FullImageCache({
      dir: options.fullDir ?? join(dirname(options.linearDir), 'full'),
      ...(options.extract === undefined ? {} : { extract: options.extract }),
    });
    this.maxEntries = options.maxEntries ?? 6;
    this.maxBytes = options.maxBytes ?? 1.5 * 1024 ** 3;
    this.decode = options.decode ?? decodeLinear;
  }

  /** Start with an empty linear cache: leftovers of a crashed run are not tracked. */
  async init(): Promise<void> {
    await rm(this.options.linearDir, { recursive: true, force: true });
    await mkdir(this.options.linearDir, { recursive: true });
    await this.fullImages.init();
  }

  /**
   * The photo was deleted: drop its decoded images and discard decodes still running, so a late
   * one cannot leave a cache file (or an entry) behind for a photo that no longer exists.
   */
  async forget(photoId: string): Promise<void> {
    await this.fullImages.forget(asPhotoId(photoId));
    const prefix = `${photoId}|`;
    for (const key of this.inFlight.keys()) if (key.startsWith(prefix)) this.discarded.add(key);
    for (const [key, entry] of [...this.entries]) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      await rm(entry.file, { force: true }).catch(() => undefined);
    }
  }

  async resolve(rawUrl: string): Promise<AppBackendResponse> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return text(400, 'malformed app:// URL');
    }
    if (url.protocol !== `${APP_PROTOCOL}:`) return text(400, 'not an app:// URL');
    const kind = url.hostname;
    let rawId: string;
    try {
      rawId = decodeURIComponent(url.pathname.replace(/^\//, ''));
    } catch {
      return text(400, 'malformed photo id');
    }
    // Checked before the id reaches any file path: `..%2F`, `%5C`, absolute paths.
    if (!SAFE_PHOTO_ID.test(rawId)) return text(400, 'invalid photo id');
    const photoId = asPhotoId(rawId);

    if (kind === 'thumb' || kind === 'preview') return this.cachedJpeg(kind, photoId);
    if (kind === 'full') return this.full(photoId);
    if (kind === 'linear') {
      return this.linear(
        photoId,
        url.searchParams.get('maxEdge'),
        url.searchParams.get('warm') === '1',
      );
    }
    return text(404, `unknown app:// resource "${kind}"`);
  }

  private async cachedJpeg(
    kind: PreviewKind,
    photoId: ReturnType<typeof asPhotoId>,
  ): Promise<AppBackendResponse> {
    const { previews, photos } = this.options;
    let served: ServedFile;
    try {
      // The index decides which JPEG may be shown (see `PreviewCache.resolve`). A
      // file for a photo the index does not know cannot be retouched.
      const photo = photos.get(photoId);
      served = await previews.resolve(
        kind,
        photoId,
        retouchKey(photo.versions),
        isRawPath(photo.path),
      );
    } catch (error) {
      if (!(error instanceof IpcError) || error.code !== 'not_found') throw error;
      served = { file: previews.pathFor(kind, photoId), placeholder: false };
    }
    try {
      const { size } = await stat(served.file);
      return {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(size),
          // A placeholder stands in until the render arrives under a new `?v=`.
          'cache-control': served.placeholder ? 'no-store' : 'private, max-age=60',
        },
        file: served.file,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return text(404, `no ${kind} for photo "${photoId}"`);
      }
      throw error;
    }
  }

  /**
   * The camera's full-size JPEG, for zooming. The camera's pixels show what a retouch hides, so a
   * photo whose newest retouch version has ops gets exactly what `app://preview` gives it (the
   * edited render, or the grey placeholder until it exists) and never the camera JPEG.
   */
  private async full(photoId: ReturnType<typeof asPhotoId>): Promise<AppBackendResponse> {
    let photo: Photo;
    try {
      photo = this.options.photos.get(photoId);
    } catch (error) {
      if (error instanceof IpcError && error.code === 'not_found') {
        return text(404, `no such photo "${photoId}"`);
      }
      throw error;
    }
    if (retouchKey(photo.versions) !== '') return this.cachedJpeg('preview', photoId);
    try {
      const entry = await this.fullImages.ensure(photo);
      return {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(entry.bytes),
          'cache-control': 'private, max-age=300',
        },
        file: entry.file,
      };
    } catch (error) {
      if (error instanceof NoFullImageError) return text(404, error.message);
      return text(
        500,
        `could not read the full-size image of ${photoId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async linear(
    photoId: ReturnType<typeof asPhotoId>,
    maxEdgeParam: string | null,
    warm: boolean,
  ): Promise<AppBackendResponse> {
    let maxEdge: number | undefined;
    if (maxEdgeParam !== null) {
      maxEdge = Number(maxEdgeParam);
      if (!Number.isInteger(maxEdge) || maxEdge < 16 || maxEdge > 32768) {
        return text(400, 'maxEdge must be an integer between 16 and 32768');
      }
    }
    let path: string;
    try {
      path = this.options.photos.get(photoId).path;
    } catch (error) {
      if (error instanceof IpcError && error.code === 'not_found') {
        return text(404, `no such photo "${photoId}"`);
      }
      throw error;
    }
    const key = `${photoId}|${maxEdge ?? 'full'}`;
    if (warm) return this.warmLinear(key, path, maxEdge);
    this.liveDecodes += 1;
    try {
      const entry = await this.linearEntry(key, path, maxEdge);
      return {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(entry.bytes),
          [LINEAR_IMAGE_HEADER]: JSON.stringify(entry.header),
          'cache-control': 'no-store',
        },
        file: entry.file,
      };
    } catch (error) {
      return text(
        500,
        `could not decode ${photoId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.liveDecodes -= 1;
      this.pumpWarm();
    }
  }

  /**
   * `?warm=1`: decode ahead of time so the next request for the same image is a cache hit, and
   * answer 204 without a body. Never at the expense of the photo on screen: a warm decode starts
   * only while no other decode is running, one at a time, and at most {@link WARM_PENDING} wait.
   * A newer request pushes the oldest waiting one out (answered `x-ee-warm: dropped`), so what
   * belonged to a selection the user has moved on from is dropped, not decoded. A decode that has
   * started finishes into the bounded cache.
   */
  private warmLinear(
    key: string,
    path: string,
    maxEdge: number | undefined,
  ): Promise<AppBackendResponse> {
    if (this.entries.has(key)) return Promise.resolve(warmAnswer('ready'));
    return new Promise((answer) => {
      this.warmQueue.push({ key, path, maxEdge, answer });
      while (this.warmQueue.length > WARM_PENDING)
        this.warmQueue.shift()?.answer(warmAnswer('dropped'));
      this.pumpWarm();
    });
  }

  private pumpWarm(): void {
    if (this.warming || this.liveDecodes > 0) return;
    const next = this.warmQueue.shift();
    if (!next) return;
    this.warming = true;
    this.linearEntry(next.key, next.path, next.maxEdge)
      .then(() => next.answer(warmAnswer('ready')))
      .catch(() => next.answer(warmAnswer('failed')))
      .finally(() => {
        this.warming = false;
        this.pumpWarm();
      });
  }

  private linearEntry(
    key: string,
    path: string,
    maxEdge: number | undefined,
  ): Promise<LinearEntry> {
    const cached = this.entries.get(key);
    if (cached) {
      // Re-insert to mark it most recently used.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return Promise.resolve(cached);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const run = (async (): Promise<LinearEntry> => {
      const image = isRawPath(path)
        ? await this.decode(path, {
            sampleType: 'f16',
            ...(maxEdge === undefined ? {} : { maxEdge }),
          })
        : await decodeJpegLinear(path, maxEdge);
      const file = join(this.options.linearDir, `${randomUUID()}.bin`);
      const temp = `${file}.tmp`;
      await writeFile(temp, image.data);
      await rename(temp, file);
      const lens = await this.lensShot(path, image.header);
      const header = lens === undefined ? image.header : { ...image.header, lens };
      if (this.discarded.delete(key)) {
        await rm(file, { force: true }).catch(() => undefined);
        throw new IpcError('not_found', 'the photo was deleted');
      }
      const entry: LinearEntry = { file, bytes: image.data.byteLength, header };
      this.entries.set(key, entry);
      await this.evict(entry);
      return entry;
    })().finally(() => {
      this.inFlight.delete(key);
      this.discarded.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  /** The lens facts of a raw, read once per file and size; a failure only means no lens correction. */
  private lensShot(path: string, header: LinearImageHeader): Promise<LensShotInfo | undefined> {
    const read = this.options.lensShot;
    if (!read || !isRawPath(path)) return Promise.resolve(undefined);
    const frame = {
      width: header.sourceWidth || header.width,
      height: header.sourceHeight || header.height,
    };
    const key = `${path}|${frame.width}x${frame.height}`;
    let known = this.lensShots.get(key);
    if (!known) {
      known = read(path, frame).catch((error: unknown) => {
        console.warn(`lens data of ${path} could not be read: ${String(error)}`);
        return undefined;
      });
      this.lensShots.set(key, known);
      // A small memo, not an archive.
      if (this.lensShots.size > 64) {
        const oldest = this.lensShots.keys().next().value;
        if (oldest !== undefined) this.lensShots.delete(oldest);
      }
    }
    return known;
  }

  /** Drop least recently used files until the limits hold. The newest entry always stays. */
  private async evict(keep: LinearEntry): Promise<void> {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && total <= this.maxBytes) break;
      if (entry === keep) continue;
      this.entries.delete(key);
      total -= entry.bytes;
      // A reader may still be streaming it; on Windows that delete fails and the
      // file is removed with the whole directory at next start.
      await rm(entry.file, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * JPEGs have no sensor data to develop, so serve their pixels as linear sRGB
 * with an identity camera matrix. That keeps the renderer, preview and export
 * pipeline identical for raws and JPEGs (and makes the retouch demo's JPEG
 * export work).
 */
async function decodeJpegLinear(path: string, maxEdge?: number): Promise<LinearImage> {
  const file = await readFile(path);
  const decoded = await decodeJpeg(file);
  const fitted =
    maxEdge !== undefined && Math.max(decoded.width, decoded.height) > maxEdge
      ? await resizeRgba(decoded.rgba, decoded.width, decoded.height, { maxEdge })
      : decoded;
  const samples = new Float32Array(fitted.width * fitted.height * 4);
  for (let i = 0; i < fitted.width * fitted.height; i++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = (fitted.rgba[i * 4 + channel] ?? 0) / 255;
      samples[i * 4 + channel] =
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }
    samples[i * 4 + 3] = 1;
  }
  return {
    data: Buffer.from(samples.buffer),
    header: {
      width: fitted.width,
      height: fitted.height,
      sourceWidth: decoded.width,
      sourceHeight: decoded.height,
      sampleType: 'f32',
      asShotMultipliers: { r: 1, g: 1, b: 1 },
      cameraToSrgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      xyzToCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    },
  };
}
