import { IpcError, type DetectFacesArgs, type FaceDetection } from '@ee/contracts';
import { extractPreview } from '@ee/core';
import { isRawPath } from '@ee/metadata';
import { YUNET_MODEL_FILE, decodeImageFile, detectFaces } from '@ee/retouch/faces';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { applyOrientation } from './previews';
import type { PhotoLibrary } from './photo-library';

/**
 * Where the YuNet model is: `EE_YUNET_MODEL_PATH`, else `fixtures/models` found by
 * walking up from this file (works from source and from the electron-vite output).
 * Packaging must ship the model and set the variable; see the PR notes.
 */
export function findYuNetModel(from: string): string | undefined {
  const configured = process.env['EE_YUNET_MODEL_PATH'];
  if (configured) return configured;
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'fixtures', 'models', YUNET_MODEL_FILE);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** Face detection for the retouch mode. */
export class FaceService {
  constructor(
    private readonly photos: PhotoLibrary,
    private readonly modelPath: string | undefined,
  ) {}

  /**
   * Detect faces in a photo (or in `region` of it). Raws are read through their
   * full-size embedded preview: it is already demosaiced and rotated by the
   * camera, and decoding it is far cheaper than developing the sensor data.
   */
  async detect({ photoId, region }: DetectFacesArgs): Promise<FaceDetection[]> {
    if (!this.modelPath || !existsSync(this.modelPath)) {
      throw new IpcError(
        'not_found',
        'face detection model not found; run `pnpm fetch-retouch` or set EE_YUNET_MODEL_PATH',
      );
    }
    const photo = this.photos.get(photoId);
    const image = isRawPath(photo.path)
      ? await decodeEmbeddedPreview(photo.path)
      : await decodeImageFile(photo.path);
    return detectFaces(image.rgba, image.width, image.height, region, {
      modelPath: this.modelPath,
    });
  }
}

async function decodeEmbeddedPreview(
  path: string,
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  const preview = await extractPreview(path);
  const { data, info } = await applyOrientation(
    sharp(preview.jpeg, { failOn: 'none' }),
    preview.orientation,
  )
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}
