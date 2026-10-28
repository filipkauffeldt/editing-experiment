import type { PhotoId } from '@ee/contracts';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { trace } from './trace';

/** Longest edge of the cached preview shown in the main view. */
export const PREVIEW_MAX_EDGE = 2560;
/** Longest edge of the film strip thumbnail. */
export const THUMB_MAX_EDGE = 320;

const PREVIEW_QUALITY = 85;
const THUMB_QUALITY = 80;

/**
 * Photo ids are UUIDs minted at ingest. Anything else (separators, `..`, absolute
 * paths) must never reach the file system.
 */
export const SAFE_PHOTO_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type PreviewKind = 'thumb' | 'preview';

/**
 * Apply an EXIF orientation (1..8) to a sharp pipeline. Embedded raw previews
 * are stored in sensor orientation and carry no tag we can rely on, so the
 * orientation reported by the raw decoder is applied explicitly.
 *
 * The transposed cases (5, 7) are a rotation plus a mirror; sharp always rotates
 * before it mirrors, hence "rotate, then flop". The unit test checks all eight
 * against sharp's own EXIF auto-orient.
 */
export function applyOrientation(image: Sharp, orientation: number): Sharp {
  switch (orientation) {
    case 2:
      return image.flop();
    case 3:
      return image.rotate(180);
    case 4:
      return image.flip();
    case 5:
      return image.rotate(270).flop();
    case 6:
      return image.rotate(90);
    case 7:
      return image.rotate(90).flop();
    case 8:
      return image.rotate(270);
    default:
      return image;
  }
}

/** What the preview is made from: JPEG bytes in sensor orientation, or an image file with its own EXIF tag. */
export type PreviewSource = { jpeg: Buffer; orientation: number } | { file: string };

/** Disk cache of per-photo JPEGs served over `app://thumb|preview`. */
export class PreviewCache {
  constructor(
    private readonly thumbDir: string,
    private readonly previewDir: string,
  ) {}

  pathFor(kind: PreviewKind, photoId: PhotoId): string {
    if (!SAFE_PHOTO_ID.test(photoId)) throw new Error(`unsafe photo id "${photoId}"`);
    return join(kind === 'thumb' ? this.thumbDir : this.previewDir, `${photoId}.jpg`);
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
    trace('generate: build pipeline');
    const input =
      'file' in source
        ? sharp(source.file, { failOn: 'none' }).rotate()
        : applyOrientation(sharp(source.jpeg, { failOn: 'none' }), source.orientation);
    // sharp drops metadata unless asked to keep it, so the cached files carry none.
    trace('generate: preview encode');
    const preview = await input
      .resize({
        width: PREVIEW_MAX_EDGE,
        height: PREVIEW_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: PREVIEW_QUALITY })
      .toBuffer();
    trace('generate: thumb encode');
    const thumb = await sharp(preview)
      .resize({
        width: THUMB_MAX_EDGE,
        height: THUMB_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: THUMB_QUALITY })
      .toBuffer();
    trace('generate: write');
    await writeAtomic(this.pathFor('preview', photoId), preview);
    await writeAtomic(this.pathFor('thumb', photoId), thumb);
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
