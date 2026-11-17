import {
  IpcError,
  rotateRetouchOps,
  type Photo,
  type RotatePhotosArgs,
  type RotatePhotosResult,
} from '@ee/contracts';
import { normalizeTurns } from '@ee/develop-gl/crop';
import { extractPreview } from '@ee/core';
import {
  isRawPath,
  orientationAfterTurns,
  readRetouchVersions,
  writeRetouchVersions,
  writeXmpOrientation,
  type ExifToolService,
} from '@ee/metadata';
import type { EditService } from './edit-service';
import type { PhotoLibrary } from './photo-library';
import type { PreviewCache } from './previews';
import type { PreviewSource } from './image-ops';

export interface RotateServiceDeps {
  photos: PhotoLibrary;
  exiftool: ExifToolService;
  edits: EditService;
  previews: PreviewCache;
  /** Drops what other caches hold of the photo's old rotation (decoded images, the zoom JPEG). */
  onRotated(photoId: string): Promise<void>;
  warn?(message: string): void;
}

/**
 * Turns photos by quarter turns. A rotation is an edit: the original is never written. The
 * orientation goes to the XMP of the photo the way Lightroom writes it (see `writeXmpOrientation`),
 * the retouch areas are turned with the picture, and the crop needs nothing because it is stored
 * in the sensor's pixel space. The cached camera previews are drawn again, turned; the edited ones
 * are dropped and the renderer draws them again.
 */
export class RotateService {
  constructor(private readonly deps: RotateServiceDeps) {}

  async rotate(args: RotatePhotosArgs): Promise<RotatePhotosResult> {
    if (!Number.isInteger(args.turns) || normalizeTurns(args.turns) === 0) {
      throw new IpcError(
        'invalid_argument',
        'turns must be a whole number of quarter turns that is not a multiple of four',
      );
    }
    const result: RotatePhotosResult = { updated: [], failed: [] };
    for (const photoId of new Set(args.photoIds)) {
      try {
        result.updated.push(
          await this.deps.photos.withLock(photoId, () => this.rotateOne(photoId, args.turns)),
        );
      } catch (cause) {
        result.failed.push({
          photoId,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return result;
  }

  private async rotateOne(photoId: Photo['id'], turns: number): Promise<Photo> {
    const { photos, exiftool, edits } = this.deps;
    const photo = photos.get(photoId);
    const before = normalizeTurns(photo.rotation ?? 0);
    const after = normalizeTurns(before + turns);

    // The orientation first: it is one small write, and the retouch write below can undo it.
    await writeXmpOrientation(
      photo.path,
      after === 0 ? undefined : orientationAfterTurns(photo.orientation, after),
      { service: exiftool },
    );
    try {
      const retouch = await readRetouchVersions(photo.path, exiftool);
      if (retouch.some((version) => version.ops.length > 0)) {
        await writeRetouchVersions(
          photo.path,
          retouch.map((version) => ({ ...version, ops: rotateRetouchOps(version.ops, turns) })),
          { service: exiftool },
        );
      }
    } catch (cause) {
      await writeXmpOrientation(
        photo.path,
        before === 0 ? undefined : orientationAfterTurns(photo.orientation, before),
        { service: exiftool },
      ).catch(() => undefined);
      throw cause;
    }

    const swapped = normalizeTurns(turns) % 2 === 1;
    photos.update(photoId, (current) => {
      const rest: Photo = { ...current };
      delete rest.rotation;
      return {
        ...rest,
        ...(after === 0 ? {} : { rotation: after }),
        ...(swapped && current.width !== undefined && current.height !== undefined
          ? { width: current.height, height: current.width }
          : {}),
      };
    });

    await this.drawCameraPreviews(photos.get(photoId));
    await this.deps.onRotated(photoId);
    return edits.afterRotation(photoId);
  }

  /** The thumbnail and preview of the camera's picture, turned. A failure leaves the old ones. */
  private async drawCameraPreviews(photo: Photo): Promise<void> {
    const rotation = photo.rotation ? { rotation: photo.rotation } : {};
    try {
      let source: PreviewSource;
      if (isRawPath(photo.path)) {
        const preview = await extractPreview(photo.path);
        source = { jpeg: preview.jpeg, orientation: preview.orientation, ...rotation };
      } else {
        source = { file: photo.path, ...rotation };
      }
      await this.deps.previews.generate(photo.id, source);
    } catch (cause) {
      (this.deps.warn ?? console.warn)(
        `could not draw the previews of ${photo.fileName} again after turning it: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }
}
