import {
  APP_PROTOCOL,
  LINEAR_IMAGE_HEADER,
  IpcError,
  asPhotoId,
  type LinearImageHeader,
} from '@ee/contracts';
import { decodeLinear, type DecodeLinearOptions, type LinearImage } from '@ee/core';
import { isRawPath } from '@ee/metadata';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppBackendResponse } from '../../shared/jobs-protocol';
import type { PhotoLibrary } from './photo-library';
import type { PreviewCache, PreviewKind } from './previews';

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
    const photoId = asPhotoId(decodeURIComponent(url.pathname.replace(/^\//, '')));

    if (kind === 'thumb' || kind === 'preview') return this.cachedJpeg(kind, photoId);
    if (kind === 'linear') return this.linear(photoId, url.searchParams.get('maxEdge'));
    return text(404, `unknown app:// resource "${kind}"`);
  }

  private async cachedJpeg(
    kind: PreviewKind,
    photoId: ReturnType<typeof asPhotoId>,
  ): Promise<AppBackendResponse> {
    const file = this.options.previews.pathFor(kind, photoId);
    try {
      const { size } = await stat(file);
      return {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(size),
          'cache-control': 'private, max-age=60',
        },
        file,
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
    if (!isRawPath(path)) return text(415, 'the linear image is only available for raw files');

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
      const image = await this.decode(path, {
        sampleType: 'f16',
        ...(maxEdge === undefined ? {} : { maxEdge }),
      });
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
