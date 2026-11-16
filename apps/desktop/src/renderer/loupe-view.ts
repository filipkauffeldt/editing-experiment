import { appUrl, type Photo } from '@ee/contracts';
import { fitWithin, type Size } from './crop-view';
import type { ViewLayout } from './view-transform';

/**
 * What the Library loupe shows and where, as pure functions. The loupe zooms with the same model
 * as Develop (`view-transform.ts`, `zoom-view.ts`), over a *frame*: the picture in pixels that
 * 100% counts. Zoomed, it draws the camera's full-size JPEG into that frame.
 */

/** The loupe's zoom belongs to the loupe, not to a photo, so it carries from one photo to the next. */
export const LOUPE_ZOOM_KEY = 'loupe';

/** Room kept around the photo at Fit, both sides together (the 16 px the stage always had). */
export const LOUPE_FIT_MARGIN = 32;

/**
 * Whether the newest retouch version has ops. Such a photo must never show camera pixels, which
 * show what the retouch hides (the same rule as `PreviewCache.resolve`, which enforces it).
 */
export function hasRetouchOps(photo: Photo): boolean {
  for (let i = photo.versions.length - 1; i >= 0; i--) {
    const version = photo.versions[i];
    if (version?.kind === 'retouch') return version.ops.length > 0;
  }
  return false;
}

export interface LoupeFrameInput {
  photo: Photo;
  /** Natural size of the full-size JPEG once it has loaded. */
  full: Size | undefined;
  /** Natural size of the preview once it has loaded. */
  preview: Size | undefined;
}

/**
 * The picture 100% is measured in. For a photo without retouching it is the camera JPEG's own
 * pixels, so 100% is one of them per device pixel. A retouched photo only has its edited preview,
 * which is drawn into a frame of the camera's size (when known), so zoom levels and a carried
 * zoom mean the same part of the frame as on the photos around it, at the resolution it has.
 */
export function loupeFrame({ photo, full, preview }: LoupeFrameInput): Size {
  const known =
    photo.width !== undefined && photo.height !== undefined && photo.width > 0 && photo.height > 0
      ? { width: photo.width, height: photo.height }
      : undefined;
  if (hasRetouchOps(photo)) {
    if (preview === undefined) return known ?? { width: 4, height: 3 };
    if (known === undefined) return preview;
    // The edited preview may be cropped, so only its long edge is matched to the camera's.
    const k = Math.max(known.width, known.height) / Math.max(preview.width, preview.height);
    return { width: preview.width * k, height: preview.height * k };
  }
  return full ?? known ?? preview ?? { width: 4, height: 3 };
}

/** Fit: the frame as large as the stage allows, centred. */
export function loupeBase(container: Size, frame: Size): ViewLayout {
  const fit = fitWithin(container, frame.width / frame.height, LOUPE_FIT_MARGIN);
  return {
    scale: fit.width / frame.width,
    offset: { x: (container.width - fit.width) / 2, y: (container.height - fit.height) / 2 },
  };
}

export interface LoupeUrls {
  /** What Fit shows: the edited preview, or the camera's. */
  preview: string;
  /** What zooming shows: the camera's full-size JPEG, or for a retouched photo its edited preview. */
  full: string;
}

/**
 * `previewRevision` busts the browser's cache when the edited render changes. The camera JPEG of a
 * photo without retouching never changes, so its URL stays put while develop edits come and go.
 */
export function loupeUrls(photo: Photo): LoupeUrls {
  return {
    preview: appUrl.preview(photo.id, photo.previewRevision),
    full: appUrl.full(photo.id, hasRetouchOps(photo) ? (photo.previewRevision ?? 0) : undefined),
  };
}

/** The image a photo needs now: the preview at Fit, the full-size JPEG when zoomed. */
export const neededUrl = (photo: Photo, zoomed: boolean): string => {
  const urls = loupeUrls(photo);
  return zoomed ? urls.full : urls.preview;
};

/** The photos next to the active one, the one an arrow press reaches first (the next) leading. */
export function neighbours(photos: readonly Photo[], activeId: string | undefined): Photo[] {
  const index = photos.findIndex((photo) => photo.id === activeId);
  if (index < 0) return [];
  return [photos[index + 1], photos[index - 1]].filter(
    (photo): photo is Photo => photo !== undefined,
  );
}
