import type { PhotoId } from './ids';

/**
 * Header describing a decoded linear image served at
 * `app://linear/<photoId>?maxEdge=N`.
 *
 * Wire format: the response body is `width * height * 4` samples (RGBA,
 * row-major, row 0 at the top, little-endian), already rotated to display
 * orientation. Samples are linear light in Rec.709/sRGB primaries, **without**
 * white balance applied and not clipped to 0..1 (highlights may exceed 1).
 * Alpha is always 1. This header is sent as JSON in the
 * {@link LINEAR_IMAGE_HEADER} HTTP response header.
 */
export interface LinearImageHeader {
  /** Pixel size of the returned buffer. */
  width: number;
  height: number;
  /** Pixel size of the full-resolution image, so callers can derive the scale. */
  sourceWidth: number;
  sourceHeight: number;
  /** `f16` = IEEE half float (2 bytes/sample), `f32` = float32 (4 bytes/sample). */
  sampleType: 'f16' | 'f32';
  /** As-shot white balance multipliers, normalized so `g` is 1. Apply as `rgb * wb`. */
  whiteBalance: { r: number; g: number; b: number };
  /** As-shot colour temperature (Kelvin) and tint, when the decoder could derive them. */
  asShotTemperature?: number;
  asShotTint?: number;
}

/** Name of the response header carrying the JSON-encoded {@link LinearImageHeader}. */
export const LINEAR_IMAGE_HEADER = 'x-ee-linear-image';

/** Scheme of the custom protocol that serves cached images to the renderer. */
export const APP_PROTOCOL = 'app';

/** Builders for the `app://` URLs; keeps the URL scheme in one place. */
export const appUrl = {
  /** Small cached JPEG for the film strip. */
  thumb: (photoId: PhotoId): string => `${APP_PROTOCOL}://thumb/${encodeURIComponent(photoId)}`,
  /** Larger cached JPEG preview (embedded or rendered). */
  preview: (photoId: PhotoId): string => `${APP_PROTOCOL}://preview/${encodeURIComponent(photoId)}`,
  /** Decoded linear image, see {@link LinearImageHeader}. */
  linear: (photoId: PhotoId, maxEdge?: number): string =>
    `${APP_PROTOCOL}://linear/${encodeURIComponent(photoId)}${
      maxEdge === undefined ? '' : `?maxEdge=${Math.round(maxEdge)}`
    }`,
} as const;
