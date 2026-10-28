import {
  APP_PROTOCOL,
  LINEAR_IMAGE_HEADER,
  IpcError,
  asPhotoId,
  type LinearImageHeader,
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
import { join } from 'node:path';
import type { AppBackendResponse } from '../../shared/jobs-protocol';
import { retouchKey } from './edited-previews';
import type { PhotoLibrary } from './photo-library';
import { SAFE_PHOTO_ID, type PreviewCache, type PreviewKind, type ServedFile } from './previews';

const text = (status: number, body: string): AppBackendResponse => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body,
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
  /** Most decoded images kept. Default 4. */
  maxEntries?: number;
  /** Most bytes of decoded images kept. Default 1.5 GiB. */
  maxBytes?: number;
  /** Test seam. */
  decode?: (path: string, options: DecodeLinearOptions) => Promise<LinearImage>;
}

/**
 * Answers `app://thumb|preview|linear/<photoId>` for the main process.
 *
 * Decoded linear images are written to files under the cache directory (a small
 * LRU of them) and returned by path: main streams the file to the renderer, so
 * a 35 MB image never goes through main's heap or a message, and the decode runs
 * off the main process entirely.
 */
export class AppResources {
  private readonly entries = new Map<string, LinearEntry>();
  private readonly inFlight = new Map<string, Promise<LinearEntry>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly decode: NonNullable<AppResourcesOptions['decode']>;

  constructor(private readonly options: AppResourcesOptions) {
    this.maxEntries = options.maxEntries ?? 4;
    this.maxBytes = options.maxBytes ?? 1.5 * 1024 ** 3;
    this.decode = options.decode ?? decodeLinear;
  }

  /** Start with an empty linear cache: leftovers of a crashed run are not tracked. */
  async init(): Promise<void> {
    await rm(this.options.linearDir, { recursive: true, force: true });
    await mkdir(this.options.linearDir, { recursive: true });
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
    if (kind === 'linear') return this.linear(photoId, url.searchParams.get('maxEdge'));
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
      served = await previews.resolve(kind, photoId, retouchKey(photos.get(photoId).versions));
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

  private async linear(
    photoId: ReturnType<typeof asPhotoId>,
    maxEdgeParam: string | null,
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
    try {
      const entry = await this.linearEntry(`${photoId}|${maxEdge ?? 'full'}`, path, maxEdge);
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
    }
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
      const entry: LinearEntry = { file, bytes: image.data.byteLength, header: image.header };
      this.entries.set(key, entry);
      await this.evict(entry);
      return entry;
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
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
