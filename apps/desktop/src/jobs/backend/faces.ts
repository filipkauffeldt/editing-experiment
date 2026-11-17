import { IpcError, type DetectFacesArgs, type FaceDetection } from '@ee/contracts';
import { extractPreview } from '@ee/core';
import { isRawPath } from '@ee/metadata';
import { YUNET_MODEL_FILE, decodeImageFile, detectFaces } from '@ee/retouch/faces';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeOrientedRgba, turnPixels } from './image-ops';
import type { PhotoLibrary } from './photo-library';

/**
 * Where the YuNet model is: `EE_YUNET_MODEL_PATH`, else `models/` in a packaged app's
 * `resources`, else `fixtures/models` found by walking up from this file (works from source and
 * from the electron-vite output).
 */
export function findYuNetModel(from: string): string | undefined {
  const configured = process.env['EE_YUNET_MODEL_PATH'];
  if (configured) return configured;
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  if (resources) {
    const packaged = join(resources, 'models', YUNET_MODEL_FILE);
    if (existsSync(packaged)) return packaged;
  }
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'fixtures', 'models', YUNET_MODEL_FILE);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** Face detection for the retouch mode. */
export class FaceService {
  private disposed = false;
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    private readonly photos: PhotoLibrary,
    private readonly modelPath: string | undefined,
  ) {}

  /**
   * Detect faces in a photo (or in `region` of it). Raws are read through their
   * full-size embedded preview: it is already demosaiced and rotated by the
   * camera, and decoding it is far cheaper than developing the sensor data.
   */
  async detect(args: DetectFacesArgs): Promise<FaceDetection[]> {
    if (this.disposed) throw new IpcError('cancelled', 'the app is shutting down');
    const run = this.run(args);
    this.running.add(run);
    try {
      return await run;
    } finally {
      this.running.delete(run);
    }
  }

  /** Refuse new detections and wait for the running ones, so quitting does not cut one off. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.running]);
  }

  private async run({ photoId, region }: DetectFacesArgs): Promise<FaceDetection[]> {
    if (!this.modelPath || !existsSync(this.modelPath)) {
      throw new IpcError(
        'not_found',
        'face detection model not found; run `pnpm fetch-retouch` or set EE_YUNET_MODEL_PATH',
      );
    }
    // Under the photo's lock: a delete waits for the decode, and one that came first leaves
    // no photo to read (a file open during a trash fails on Windows).
    const image = await this.photos.withLock(photoId, async () => {
      const photo = this.photos.get(photoId);
      // Boxes are in the picture as shown, so the user's rotation is applied before the search.
      const upright = isRawPath(photo.path)
        ? await decodeEmbeddedPreview(photo.path)
        : await decodeImageFile(photo.path);
      if (!photo.rotation) return upright;
      const turned = turnPixels(upright.rgba, upright.width, upright.height, 4, photo.rotation);
      return { rgba: turned.data, width: turned.width, height: turned.height };
    });
    return detectFaces(image.rgba, image.width, image.height, region, {
      modelPath: this.modelPath,
    });
  }
}

async function decodeEmbeddedPreview(
  path: string,
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  const preview = await extractPreview(path);
  return decodeOrientedRgba(preview.jpeg, preview.orientation);
}
