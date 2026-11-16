import type { PhotoId } from '@ee/contracts';
import { encodeJpeg } from '@ee/core';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiskCache } from './disk-cache';
import {
  makePreviewJpegs,
  makeThumbnailJpeg,
  type PreviewJpegs,
  type PreviewSource,
} from './image-ops';

/**
 * Photo ids are UUIDs minted at ingest. Anything else (separators, `..`, absolute
 * paths) must never reach the file system.
 */
export const SAFE_PHOTO_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type PreviewKind = 'thumb' | 'preview';

/**
 * Bumped whenever a change to the raw defaults makes pixels drawn with the old
 * ones wrong. Caches from before it was tracked have no `defaultsVersion`.
 */
export const EDITED_PREVIEW_DEFAULTS_VERSION = 1;

/**
 * What the edited JPEGs of a photo were rendered from. Written last, so its
 * presence means both JPEGs are complete.
 */
export interface EditedPreviewMeta {
  /** Renderer revision of the render that produced the files. */
  revision: number;
  /** `retouchKey` of the retouch ops baked into the pixels; '' when none. */
  retouchKey: string;
  /**
   * The default camera profile (`defaultKey`) the pixels went through; absent when they went
   * through none or a profile the settings name. Files drawn before the default existed have none,
   * which is what they were drawn with.
   */
  defaultProfile?: string;
  /** Raw-defaults version the pixels were drawn with; absent in older caches. */
  defaultsVersion?: number;
}

/** True when the pixels were drawn with the current raw defaults. */
export function hasCurrentDefaults(meta: EditedPreviewMeta): boolean {
  return meta.defaultsVersion === EDITED_PREVIEW_DEFAULTS_VERSION;
}

/** Plain mid-grey shown instead of an image that would reveal what a retouch hides. */
const PLACEHOLDER_NAME = '_placeholder.jpg';

/**
 * Disk cache of per-photo JPEGs served over `app://thumb|preview`.
 *
 * The camera's embedded preview (`<id>.jpg`) is written once at ingest and never
 * replaced; the rendered, edited version lives next to it (`<id>.edited.jpg`).
 * Keeping both lets "reset edits" go back to the original. The `.edited` names
 * cannot collide with photo ids, which never contain a dot.
 */
export class PreviewCache {
  /**
   * The edited marker of recently served photos. A grid scroll asks for the same small set
   * again and again; reading the marker file each time would be one file read per thumbnail.
   */
  private readonly metaCache = new Map<PhotoId, EditedPreviewMeta | undefined>();
  private static readonly META_CACHE_ENTRIES = 5_000;

  constructor(
    private readonly thumbDir: string,
    private readonly previewDir: string,
    /** Optional size-bounded store in front of the same files. */
    private readonly cache?: DiskCache,
  ) {}

  pathFor(kind: PreviewKind, photoId: PhotoId): string {
    if (!SAFE_PHOTO_ID.test(photoId)) throw new Error(`unsafe photo id "${photoId}"`);
    return join(kind === 'thumb' ? this.thumbDir : this.previewDir, `${photoId}.jpg`);
  }

  editedPath(kind: PreviewKind, photoId: PhotoId): string {
    return this.pathFor(kind, photoId).replace(/\.jpg$/, '.edited.jpg');
  }

  private metaPath(photoId: PhotoId): string {
    return this.pathFor('preview', photoId).replace(/\.jpg$/, '.edited.json');
  }

  async has(kind: PreviewKind, photoId: PhotoId): Promise<boolean> {
    try {
      await access(this.pathFor(kind, photoId));
      return true;
    } catch {
      return false;
    }
  }

  /** Write the ~2560px preview and the ~320px thumbnail for a photo. */
  async generate(photoId: PhotoId, source: PreviewSource): Promise<void> {
    await Promise.all([
      mkdir(this.thumbDir, { recursive: true }),
      mkdir(this.previewDir, { recursive: true }),
    ]);
    const { preview, thumb } = await makePreviewJpegs(source);
    const previewFile = this.pathFor('preview', photoId);
    const thumbFile = this.pathFor('thumb', photoId);
    await writeAtomic(previewFile, preview);
    await writeAtomic(thumbFile, thumb);
    await Promise.all([
      this.cache?.added(previewFile, 'preview'),
      this.cache?.added(thumbFile, 'thumb'),
    ]);
  }

  /** Only the thumbnail, for an evicted file in the grid. */
  async generateThumb(photoId: PhotoId, source: PreviewSource): Promise<void> {
    await mkdir(this.thumbDir, { recursive: true });
    const file = this.pathFor('thumb', photoId);
    await writeAtomic(file, await makeThumbnailJpeg(source));
    await this.cache?.added(file, 'thumb');
  }

  /** Store the edited JPEGs. The original embedded previews stay untouched. */
  async writeEdited(
    photoId: PhotoId,
    { thumb, preview }: PreviewJpegs,
    meta: Omit<EditedPreviewMeta, 'defaultsVersion'>,
  ): Promise<void> {
    await Promise.all([
      mkdir(this.thumbDir, { recursive: true }),
      mkdir(this.previewDir, { recursive: true }),
    ]);
    const stored: EditedPreviewMeta = {
      ...meta,
      defaultsVersion: EDITED_PREVIEW_DEFAULTS_VERSION,
    };
    // The meta goes last: on a first write the files are not served until it exists.
    const previewFile = this.editedPath('preview', photoId);
    const thumbFile = this.editedPath('thumb', photoId);
    await writeAtomic(previewFile, preview);
    await writeAtomic(thumbFile, thumb);
    await writeAtomic(this.metaPath(photoId), Buffer.from(JSON.stringify(stored)));
    this.metaCache.delete(photoId);
    this.metaCache.set(photoId, stored);
    await Promise.all([
      this.cache?.added(previewFile, 'preview'),
      this.cache?.added(thumbFile, 'thumb'),
    ]);
  }

  async readEditedMeta(photoId: PhotoId): Promise<EditedPreviewMeta | undefined> {
    if (this.metaCache.has(photoId)) {
      const known = this.metaCache.get(photoId);
      // Re-insert as the newest entry; Map iteration order is the eviction order.
      this.metaCache.delete(photoId);
      this.metaCache.set(photoId, known);
      return known;
    }
    const remember = (meta: EditedPreviewMeta | undefined): EditedPreviewMeta | undefined => {
      this.metaCache.set(photoId, meta);
      if (this.metaCache.size > PreviewCache.META_CACHE_ENTRIES) {
        const oldest = this.metaCache.keys().next().value;
        if (oldest !== undefined) this.metaCache.delete(oldest);
      }
      return meta;
    };
    try {
      const parsed = JSON.parse(await readFile(this.metaPath(photoId), 'utf8')) as unknown;
      const meta = parsed as Partial<EditedPreviewMeta>;
      if (typeof meta.revision !== 'number' || typeof meta.retouchKey !== 'string') {
        return remember(undefined);
      }
      return remember({
        revision: meta.revision,
        retouchKey: meta.retouchKey,
        ...(typeof meta.defaultProfile === 'string' && meta.defaultProfile !== ''
          ? { defaultProfile: meta.defaultProfile }
          : {}),
        ...(typeof meta.defaultsVersion === 'number'
          ? { defaultsVersion: meta.defaultsVersion }
          : {}),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
        return remember(undefined);
      }
      throw error;
    }
  }

  /** Drop the edited JPEGs so the original embedded previews are served again. */
  async removeEdited(photoId: PhotoId): Promise<void> {
    this.metaCache.delete(photoId);
    this.metaCache.set(photoId, undefined);
    const files = [
      this.metaPath(photoId),
      this.editedPath('thumb', photoId),
      this.editedPath('preview', photoId),
    ];
    await Promise.all(files.map((file) => rm(file, { force: true })));
    await Promise.all(files.map((file) => this.cache?.removed(file)));
  }

  /** Drop every cached JPEG of a photo: camera previews, edited ones and the marker. */
  async removeAll(photoId: PhotoId): Promise<void> {
    await this.removeEdited(photoId);
    const files = [this.pathFor('thumb', photoId), this.pathFor('preview', photoId)];
    await Promise.all(files.map((file) => rm(file, { force: true })));
    await Promise.all(files.map((file) => this.cache?.removed(file)));
  }

  /**
   * The file to serve for a photo. `retouchKey` is what the photo's retouching
   * is now ('' when it has none); `raw` says whether the raw defaults were part
   * of the render.
   *
   * The camera preview shows the unretouched image, so it is only ever served
   * for a photo without retouching. A photo with retouching gets the edited
   * JPEGs, and only when they were rendered with the current retouch ops; until
   * then a grey placeholder, never the original and never an older render
   * (whose mosaic may cover other regions). A raw render drawn with older raw
   * defaults is not served either.
   */
  async resolve(
    kind: PreviewKind,
    photoId: PhotoId,
    retouchKey: string,
    raw: boolean,
  ): Promise<ServedFile> {
    const meta = await this.readEditedMeta(photoId);
    const defaultsMatch = !raw || (meta !== undefined && hasCurrentDefaults(meta));
    // Edited files whose mosaic is now gone (version deleted) are merely out of date.
    if (meta && defaultsMatch && (retouchKey === '' || meta.retouchKey === retouchKey)) {
      return { file: this.editedPath(kind, photoId), placeholder: false };
    }
    if (retouchKey !== '') return { file: await this.placeholderFile(), placeholder: true };
    return { file: this.pathFor(kind, photoId), placeholder: false };
  }

  /** The grey stand-in a retouched photo shows until its edited render exists. */
  async placeholder(): Promise<string> {
    return this.placeholderFile();
  }

  private async placeholderFile(): Promise<string> {
    const file = join(this.previewDir, PLACEHOLDER_NAME);
    if (await exists(file)) return file;
    await mkdir(this.previewDir, { recursive: true });
    const size = 16;
    const rgba = Buffer.alloc(size * size * 4, 0x80);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    await writeAtomic(
      file,
      await encodeJpeg(rgba, size, size, { quality: 80, chroma: '420', iccSrgb: true }),
    );
    return file;
  }
}

/** A cached file chosen for a request. */
export interface ServedFile {
  file: string;
  /** The grey stand-in: must not be cached by the browser. */
  placeholder: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, data: Buffer): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
