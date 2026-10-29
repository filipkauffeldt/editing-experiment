import type { PhotoId } from './ids';

/**
 * Header describing a decoded image served at `app://linear/<photoId>?maxEdge=N`.
 *
 * Wire format: the response body is `width * height * 4` samples (RGBA,
 * row-major, row 0 at the top, little-endian), already rotated to display
 * orientation. Samples are **demosaiced camera RGB**: linear light in the
 * camera's own primaries (LibRaw `output_color = 0`), black level subtracted,
 * scaled so the sensor's white level is 1.0, **unity** white balance multipliers,
 * no auto-brightening, not clipped (highlights may exceed 1). Alpha is always 1.
 * This header is sent as JSON in the {@link LINEAR_IMAGE_HEADER} HTTP response header.
 *
 * Why camera space: white balance is a per-channel gain that is only
 * meaningful in the camera's primaries, so it must be applied before the
 * camera → sRGB matrix, otherwise temperature/tint cannot behave correctly.
 *
 * The develop pipeline order is:
 *
 * ```
 * camera RGB * multipliers -> cameraToSrgb -> develop ops -> sRGB OETF
 * ```
 *
 * where `multipliers` are `asShotMultipliers` or, once the user moves
 * temperature/tint, multipliers derived from them with `xyzToCamera`
 * (as in the DNG SDK), and "develop ops" are exposure, tone, tone curve,
 * vibrance and saturation in linear Rec.709/sRGB primaries.
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
  /** As-shot white balance multipliers, normalized so `g` is 1. Apply as `cameraRgb * multipliers`. */
  asShotMultipliers: { r: number; g: number; b: number };
  /**
   * 3x3 row-major matrix taking **white-balanced** linear camera RGB to linear
   * sRGB / Rec.709 primaries (the 3x3 part of LibRaw `rgb_cam`). Apply it after
   * the multipliers: `srgb = cameraToSrgb * (cameraRgb * multipliers)`. Length 9.
   */
  cameraToSrgb: number[];
  /**
   * 3x3 row-major matrix taking CIE XYZ (D65) to linear camera RGB (the 3x3 part
   * of LibRaw `cam_xyz`, which like dcraw's matrices is D65-referenced). Used to convert temperature/tint to and from white balance
   * multipliers the way the DNG SDK does. Length 9.
   */
  xyzToCamera: number[];
  /** As-shot colour temperature (Kelvin) and tint, when the decoder could derive them. */
  asShotTemperature?: number;
  asShotTint?: number;
  /** What the lens correction needs to know about the shot. Absent for JPEGs and files without lens data. */
  lens?: LensShotInfo;
}

/**
 * Lens facts of one shot, read in the jobs process (ExifTool and the Nikon maker data) and carried
 * in the linear image header, so every render path (canvas, edited previews, export workers) sees
 * the same lens without further lookups.
 */
export interface LensShotInfo {
  /** EXIF `Make` / `Model` of the body, as written by the camera. */
  cameraMake?: string;
  cameraModel?: string;
  /** EXIF `LensModel`, e.g. `NIKKOR Z 24-70mm f/4 S`. */
  lensModel?: string;
  /** mm. */
  focalLength?: number;
  /** 35 mm equivalent focal length; with `focalLength` it gives the crop mode (DX on an FX body). */
  focalLength35?: number;
  fNumber?: number;
  /** Metres; absent when unknown or at infinity. */
  focusDistance?: number;
  /** The camera's own correction. */
  builtin?: BuiltinLensCorrection;
}

/**
 * The correction a camera stores for its shot: radial polynomials of the normalised radius
 * `q = r / unit`, `r` being the distance in pixels from the optical centre. Nikon Z: NEFInfo
 * records 5 to 8 (see `docs/ARCHITECTURE.md`, "Lens corrections").
 */
export interface BuiltinLensCorrection {
  source: 'Nikon built-in';
  /** True when the camera says the lens needs the correction (Camera Raw applies it whatever the user chose). */
  required: boolean;
  /** Optical centre as a fraction of the image size from the image centre (x of the width, y of the height). */
  centre: { x: number; y: number };
  /** `q = 1` at this fraction of the image half diagonal. */
  unit: number;
  /** Green's recorded radius over the corrected radius, ascending powers of `q` from `q^0` (the framing scale included). */
  distortion?: number[];
  /** Vignetting gain, ascending powers of `q` from `q^0`. */
  vignetting?: number[];
  /** Red's and blue's radius over green's, ascending powers of `q` from `q^0`. */
  red?: number[];
  blue?: number[];
}

/** Name of the response header carrying the JSON-encoded {@link LinearImageHeader}. */
export const LINEAR_IMAGE_HEADER = 'x-ee-linear-image';

/** Scheme of the custom protocol that serves cached images to the renderer. */
export const APP_PROTOCOL = 'app';

const revisionQuery = (revision: number | undefined): string =>
  revision === undefined || revision === 0 ? '' : `?v=${Math.round(revision)}`;

/** Builders for the `app://` URLs; keeps the URL scheme in one place. */
export const appUrl = {
  /** Small cached JPEG for the film strip. `revision` is `Photo.previewRevision`; it busts the image cache. */
  thumb: (photoId: PhotoId, revision?: number): string =>
    `${APP_PROTOCOL}://thumb/${encodeURIComponent(photoId)}${revisionQuery(revision)}`,
  /** Larger cached JPEG preview (embedded or rendered). `revision` is `Photo.previewRevision`. */
  preview: (photoId: PhotoId, revision?: number): string =>
    `${APP_PROTOCOL}://preview/${encodeURIComponent(photoId)}${revisionQuery(revision)}`,
  /** Decoded linear image, see {@link LinearImageHeader}. */
  linear: (photoId: PhotoId, maxEdge?: number): string =>
    `${APP_PROTOCOL}://linear/${encodeURIComponent(photoId)}${
      maxEdge === undefined ? '' : `?maxEdge=${Math.round(maxEdge)}`
    }`,
} as const;
