import type { PhotoId } from '@ee/contracts';
import { encodeJpeg } from '@ee/core';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makePreviewJpegs, type PreviewJpegs, type PreviewSource } from './image-ops';

/**
 * Photo ids are UUIDs minted at ingest. Anything else (separators, `..`, absolute
 * paths) must never reach the file system.
 */
export const SAFE_PHOTO_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type PreviewKind = 'thumb' | 'preview';

/**
 * What the edited JPEGs of a photo were rendered from. Written last, so its
 * presence means both JPEGs are complete.
 */
export interface EditedPreviewMeta {
  /** Renderer revision of the render that produced the files. */
  revision: number;
  /** `retouchKey` of the retouch ops baked into the pixels; '' when none. */
  retouchKey: string;
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
  constructor(
    private readonly thumbDir: string,
    private readonly previewDir: string,
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
    await writeAtomic(this.pathFor('preview', photoId), preview);
    await writeAtomic(this.pathFor('thumb', photoId), thumb);
  }

  /** Store the edited JPEGs. The original embedded previews stay untouched. */
  async writeEdited(
    photoId: PhotoId,
    { thumb, preview }: PreviewJpegs,
    meta: EditedPreviewMeta,
  ): Promise<void> {
    await Promise.all([
      mkdir(this.thumbDir, { recursive: true }),
      mkdir(this.previewDir, { recursive: true }),
    ]);
    // The meta goes last: on a first write the files are not served until it exists.
    await writeAtomic(this.editedPath('preview', photoId), preview);
    await writeAtomic(this.editedPath('thumb', photoId), thumb);
    await writeAtomic(this.metaPath(photoId), Buffer.from(JSON.stringify(meta)));
  }

  async readEditedMeta(photoId: PhotoId): Promise<EditedPreviewMeta | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.metaPath(photoId), 'utf8')) as unknown;
      const meta = parsed as Partial<EditedPreviewMeta>;
      return typeof meta.revision === 'number' && typeof meta.retouchKey === 'string'
        ? { revision: meta.revision, retouchKey: meta.retouchKey }
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  /** Drop the edited JPEGs so the original embedded previews are served again. */
  async removeEdited(photoId: PhotoId): Promise<void> {
    await rm(this.metaPath(photoId), { force: true });
    await Promise.all([
      rm(this.editedPath('thumb', photoId), { force: true }),
      rm(this.editedPath('preview', photoId), { force: true }),
    ]);
  }

  /**
   * The file to serve for a photo. `retouchKey` is what the photo's retouching
   * is now ('' when it has none).
   *
   * The camera preview shows the unretouched image, so it is only ever served
   * for a photo without retouching. A photo with retouching gets the edited
   * JPEGs, and only when they were rendered with the current retouch ops; until
   * then a grey placeholder, never the original and never an older render
   * (whose mosaic may cover other regions).
   */
  async resolve(kind: PreviewKind, photoId: PhotoId, retouchKey: string): Promise<ServedFile> {
    const meta = await this.readEditedMeta(photoId);
    // Edited files whose mosaic is now gone (version deleted) are merely out of date.
    if (meta && (retouchKey === '' || meta.retouchKey === retouchKey)) {
      return { file: this.editedPath(kind, photoId), placeholder: false };
    }
    if (retouchKey !== '') return { file: await this.placeholderFile(), placeholder: true };
    return { file: this.pathFor(kind, photoId), placeholder: false };
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
