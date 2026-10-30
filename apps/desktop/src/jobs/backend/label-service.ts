import { IpcError, type Photo, type SetPhotoLabelsArgs } from '@ee/contracts';
import { writePhotoLabels, type ExifToolService } from '@ee/metadata';
import type { PhotoLibrary } from './photo-library';

/**
 * Tag, colour-class and rating changes. The index stores the fields and the
 * sidecar (or the JPEG's embedded XMP) is written first, so a failed write does
 * not leave the UI claiming a label that was never persisted.
 */
export class LabelService {
  constructor(
    private readonly photos: PhotoLibrary,
    private readonly exiftool: ExifToolService,
  ) {}

  async setLabels(args: SetPhotoLabelsArgs): Promise<Photo[]> {
    const { tagged, colorClass, rating } = args;
    if (tagged === undefined && colorClass === undefined && rating === undefined) {
      throw new IpcError('invalid_argument', 'photos:setLabels needs tagged, colorClass or rating');
    }
    if (
      colorClass !== undefined &&
      (!Number.isInteger(colorClass) || colorClass < 0 || colorClass > 8)
    ) {
      throw new IpcError('invalid_argument', 'colorClass must be 0..8');
    }
    if (rating !== undefined && (!Number.isInteger(rating) || rating < 0 || rating > 5)) {
      throw new IpcError('invalid_argument', 'rating must be 0..5');
    }
    if (args.photoIds.length === 0) return [];

    const updated: Photo[] = [];
    for (const photoId of args.photoIds) {
      updated.push(
        await this.photos.withLock(photoId, async () => {
          const photo = this.photos.get(photoId);
          await writePhotoLabels(
            photo.path,
            {
              ...(tagged === undefined ? {} : { tagged }),
              ...(colorClass === undefined ? {} : { colorClass }),
              ...(rating === undefined ? {} : { rating }),
            },
            { service: this.exiftool },
          );
          return this.photos.update(photoId, (current) => ({
            ...current,
            ...(tagged === undefined ? {} : { tagged }),
            ...(colorClass === undefined ? {} : { colorClass }),
            ...(rating === undefined ? {} : { rating }),
          }));
        }),
      );
    }
    return updated;
  }
}
