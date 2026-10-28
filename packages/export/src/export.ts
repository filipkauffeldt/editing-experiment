import { randomUUID } from 'node:crypto';
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExportIfExists, ExportPreset, PhotoId, RenderedImage } from '@ee/contracts';
import { atomicReplace } from './atomic';
import { assertSafeFileName } from './upload/paths';
import { encodeJpeg } from './jpeg/encode';
import { assertNoEmbeddedPreviews } from './jpeg/previews';
import type { ExportHooks } from './hooks';

export interface ExportPhotoOptions {
  image: RenderedImage;
  preset: ExportPreset;
  outputDir: string;
  fileName: string;
  photoId: PhotoId;
  /** Default `overwrite`, matching the original single-photo finish action. */
  ifExists?: ExportIfExists;
  hooks?: ExportHooks;
}

export interface ExportedPhoto {
  path: string;
  bytes: number;
  /** True when `ifExists: 'skip'` found an existing file and wrote nothing. */
  skipped?: boolean;
}

/**
 * Encodes, embeds metadata, verifies that no preview leaked, and atomically
 * publishes the file.
 *
 * Ordering matters: `writeMetadata` runs on the temp file, then the preview
 * check runs on that same bytes, so a metadata hook that copies an EXIF or XMP
 * thumbnail fails the export and the final path is never created.
 */
export async function exportPhoto(options: ExportPhotoOptions): Promise<ExportedPhoto> {
  const { image, preset, outputDir, fileName, photoId, hooks } = options;
  assertSafeFileName(fileName);

  await mkdir(outputDir, { recursive: true });
  const target = await resolveTarget(outputDir, fileName, options.ifExists ?? 'overwrite');
  if (target.skip)
    return { path: target.path, bytes: (await stat(target.path)).size, skipped: true };

  // Encode before creating the temp file so invalid input never touches disk.
  const encoded = await encodeJpeg(image, preset);

  const finalPath = target.path;
  const tempPath = path.join(outputDir, `.${fileName}.${randomUUID()}.tmp`);
  let published = false;

  try {
    await writeFile(tempPath, encoded.data, { flag: 'wx' });

    if (preset.metadata !== 'none' && hooks?.writeMetadata !== undefined) {
      await hooks.writeMetadata(tempPath, photoId);
    }

    await assertNoEmbeddedPreviews(tempPath);
    await atomicReplace(tempPath, finalPath);
    published = true;
  } finally {
    if (!published) await rm(tempPath, { force: true }).catch(() => undefined);
  }

  const finalStat = await stat(finalPath);
  return { path: finalPath, bytes: finalStat.size };
}

/**
 * Pick the file to publish to. `suffix` leaves existing exports alone and adds
 * `-1`, `-2`, ... before the extension; `skip` refuses to write at all.
 */
async function resolveTarget(
  outputDir: string,
  fileName: string,
  policy: ExportIfExists,
): Promise<{ path: string; skip?: boolean }> {
  const direct = path.join(outputDir, fileName);
  if (policy === 'overwrite' || !(await exists(direct))) return { path: direct };
  if (policy === 'skip') return { path: direct, skip: true };

  const extension = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - extension.length);
  for (let index = 1; index < 10_000; index++) {
    const candidate = path.join(outputDir, `${base}-${index}${extension}`);
    if (!(await exists(candidate))) return { path: candidate };
  }
  throw new Error(`could not find a free file name for ${fileName}`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
