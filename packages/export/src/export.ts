import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExportPreset, PhotoId, RenderedImage } from '@ee/contracts';
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
  hooks?: ExportHooks;
}

export interface ExportedPhoto {
  path: string;
  bytes: number;
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
  // Encode before creating the temp file so invalid input never touches disk.
  const encoded = await encodeJpeg(image, preset);

  const finalPath = path.join(outputDir, fileName);
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
