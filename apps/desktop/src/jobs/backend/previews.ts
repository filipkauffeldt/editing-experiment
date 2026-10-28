import type { PhotoId } from '@ee/contracts';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makePreviewJpegs, type PreviewSource } from './image-ops';

/**
 * Photo ids are UUIDs minted at ingest. Anything else (separators, `..`, absolute
 * paths) must never reach the file system.
 */
export const SAFE_PHOTO_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type PreviewKind = 'thumb' | 'preview';

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
    const { preview, thumb } = await makePreviewJpegs(source);
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
