import {
  IpcError,
  type EditParams,
  type PhotoId,
  type PhotoVersion,
  type RenderedImage,
  type RetouchOp,
  type Photo,
  type SetEditedPreviewArgs,
} from '@ee/contracts';
import { createHash } from 'node:crypto';
import { encodeEditedJpegs } from './image-ops';
import type { PhotoLibrary } from './photo-library';
import type { PreviewCache } from './previews';

/**
 * The retouch ops that previews and export apply: the newest retouch version's.
 * Mirrors `topRetouchVersion` in the renderer store.
 */
export function topRetouchOps(versions: PhotoVersion[]): RetouchOp[] {
  for (let i = versions.length - 1; i >= 0; i--) {
    const version = versions[i];
    if (version?.kind === 'retouch') return version.ops;
  }
  return [];
}

/**
 * Identity of what a photo's retouching hides, '' when it hides nothing. A
 * cached render is only valid for the exact ops it was drawn with.
 */
export function retouchKey(versions: PhotoVersion[]): string {
  const ops = topRetouchOps(versions);
  return ops.length === 0 ? '' : JSON.stringify(ops);
}

/** Order-independent fingerprint of develop params, for comparing what was drawn with what was saved. */
function paramsKey(params: EditParams): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(([, item]) => item !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical(params)))
    .digest('base64url');
}

function assertImage(name: string, image: RenderedImage | undefined): void {
  if (
    !(image?.rgba instanceof Uint8Array) ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0 ||
    image.rgba.length !== image.width * image.height * 4
  ) {
    throw new IpcError('invalid_argument', `${name} must be width*height*4 bytes of RGBA`);
  }
}

/**
 * Thumbnails and previews that show a photo as edited. The renderer draws them
 * (it has the develop pipeline); this stores them next to the camera previews,
 * keeps `Photo.previewRevision` honest for cache busting, and goes back to the
 * camera preview when a photo ends up without edits.
 */
export class EditedPreviews {
  /** Newest renderer revision stored per photo, to drop a render that arrives late. */
  private readonly newest = new Map<PhotoId, number>();
  /** Fingerprint of the develop params last saved per photo this session. */
  private readonly saved = new Map<PhotoId, string>();

  constructor(
    private readonly photos: PhotoLibrary,
    private readonly cache: PreviewCache,
  ) {}

  /** The develop params of a photo were just saved (called under the photo lock). */
  noteParams(photoId: PhotoId, params: EditParams): void {
    this.saved.set(photoId, paramsKey(params));
  }

  /** Store a render, unless it is out of date. Resolves with the photo as it is now. */
  async set(args: SetEditedPreviewArgs): Promise<Photo> {
    assertImage('thumb', args.thumb);
    assertImage('preview', args.preview);
    if (!Number.isFinite(args.revision)) {
      throw new IpcError('invalid_argument', 'revision must be a number');
    }
    // Same lock as the sidecar writes, so the checks below see every edit that landed first.
    return this.photos.withLock(args.photoId, async () => {
      const photo = this.photos.get(args.photoId);
      // Edits removed meanwhile: the camera preview is already back, keep it.
      if (!photo.status.edited) return photo;
      if (args.revision < (this.newest.get(photo.id) ?? -Infinity)) return photo;
      // Drawn from retouch ops that are no longer the photo's: it could show a face the
      // current mosaic covers, or hide one it no longer does.
      if (JSON.stringify(args.retouchOps) !== JSON.stringify(topRetouchOps(photo.versions))) {
        return photo;
      }
      // Drawn from slider values that were replaced since. Nothing saved yet this
      // session (an edit made earlier, a Lightroom sidecar) means nothing to compare.
      const saved = this.saved.get(photo.id);
      if (saved !== undefined && saved !== paramsKey(args.params)) return photo;
      const jpegs = await encodeEditedJpegs(args);
      await this.cache.writeEdited(photo.id, jpegs, {
        revision: args.revision,
        retouchKey: retouchKey(photo.versions),
      });
      this.newest.set(photo.id, args.revision);
      return this.photos.update(photo.id, (current) => ({
        ...current,
        previewRevision: (current.previewRevision ?? 0) + 1,
        previewStale: false,
      }));
    });
  }

  /**
   * Called when a photo's versions changed (inside the photo lock). Returns the
   * preview fields to merge into the new photo: the previews are out of date
   * while edits exist, and the camera preview comes back when none do.
   */
  async afterVersionsChanged(
    before: Photo,
    versions: PhotoVersion[],
    edited: boolean,
  ): Promise<Pick<Photo, 'previewRevision' | 'previewStale'>> {
    let bump = retouchKey(before.versions) !== retouchKey(versions);
    if (!edited) {
      const hadEdited = (await this.cache.readEditedMeta(before.id)) !== undefined;
      await this.cache.removeEdited(before.id);
      this.newest.delete(before.id);
      bump ||= hadEdited;
    }
    const revision = (before.previewRevision ?? 0) + (bump ? 1 : 0);
    return {
      ...(revision === 0 ? {} : { previewRevision: revision }),
      previewStale: edited,
    };
  }
}
