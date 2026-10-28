import type { CropParams } from '@ee/contracts';

/**
 * Crop and straighten geometry, matching Adobe Camera Raw / Lightroom's `crs:`
 * crop model.
 *
 * Adobe's definition (John Rellis, "SDK: Computing the corners of a crop
 * rectangle", Adobe Community, 2022; and the `crs:` namespace docs):
 *
 * - `CropLeft/Top/Right/Bottom` are normalized 0..1 in the *unrotated* develop
 *   coordinate system (the stored pixel array, origin top-left), and name the
 *   upper-left and lower-right corners of the crop rectangle.
 * - `CropAngle` is the clockwise rotation of that rectangle about its centre.
 *   The four numbers above are therefore the two opposite corners *after*
 *   rotation; the crop's output is the rectangle "leveled" by the angle.
 *
 * darktable's Lightroom importer reads the same tags and applies the same
 * rotation: `dt_lightroom_import` in
 * https://github.com/darktable-org/darktable/blob/master/src/develop/lightroom.c
 * takes `CropLeft/Top/Right/Bottom` as edge coordinates relative to the image
 * centre, rotates the rectangle about that centre by `CropAngle`, and stores
 * `pc.angle = -CropAngle` because darktable's clipping angle runs the other
 * way. `test/crop.test.ts` mirrors that conversion and checks our stored
 * corners against it.
 *
 * RawTherapee and ART do not import Adobe `crs:` crops (their
 * `rtengine/metadata.cc` / `src/engine/metadata.cc` only handle EXIF/IPTC/XMP
 * capture metadata), so there is no third implementation to cross-check.
 *
 * This app's linear image is already EXIF-orientation corrected, so the
 * "develop coordinate system" here is the oriented image; for the common
 * orientation (`AB`, no mirror/rotation) that is byte-for-byte Lightroom's.
 *
 * All functions are pure and work in pixels unless a name says `normalized`.
 * The angle is in degrees, positive = clockwise on screen (y down).
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The displayed (leveled) crop: centre and unrotated size in source pixels. */
export interface CropGeometry {
  /** Crop centre in source pixels. */
  centerX: number;
  centerY: number;
  /** Output width in pixels (the leveled rectangle's width). */
  width: number;
  /** Output height in pixels (the leveled rectangle's height). */
  height: number;
  /** Clockwise straighten angle in degrees. */
  angle: number;
}

const DEG = Math.PI / 180;

const cosSin = (angle: number): { cos: number; sin: number } => {
  const radians = angle * DEG;
  return { cos: Math.cos(radians), sin: Math.sin(radians) };
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Clockwise rotation in screen coordinates (x right, y down). */
export function rotatePoint(x: number, y: number, angle: number): Point {
  const { cos, sin } = cosSin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** Inverse of {@link rotatePoint}: rotates by `-angle`. */
export function unrotatePoint(x: number, y: number, angle: number): Point {
  const { cos, sin } = cosSin(angle);
  return { x: x * cos + y * sin, y: -x * sin + y * cos };
}

/**
 * Recovers the displayed (axis-aligned) crop rectangle from the stored crop
 * corners. `CropLeft/Top` and `CropRight/Bottom` are opposite corners of the
 * rotated rectangle, so un-rotating their delta gives the output dimensions.
 */
export function cropGeometry(crop: CropParams, image: Size): CropGeometry {
  const ulx = crop.left * image.width;
  const uly = crop.top * image.height;
  const lrx = crop.right * image.width;
  const lry = crop.bottom * image.height;
  const half = unrotatePoint((lrx - ulx) / 2, (lry - uly) / 2, crop.angle);
  return {
    centerX: (ulx + lrx) / 2,
    centerY: (uly + lry) / 2,
    width: Math.max(0, half.x * 2),
    height: Math.max(0, half.y * 2),
    angle: crop.angle,
  };
}

/** Builds the stored crop corners from a displayed rectangle (inverse of {@link cropGeometry}). */
export function cropFromGeometry(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  angle: number,
  image: Size,
): CropParams {
  const half = rotatePoint(width / 2, height / 2, angle);
  const ul = rotatePoint(-width / 2, -height / 2, angle);
  return {
    left: (centerX + ul.x) / image.width,
    top: (centerY + ul.y) / image.height,
    right: (centerX + half.x) / image.width,
    bottom: (centerY + half.y) / image.height,
    angle,
  };
}

/** Output size of the crop in pixels at the image's full resolution (not rounded). */
export function cropOutputSize(crop: CropParams, image: Size): Size {
  const geometry = cropGeometry(crop, image);
  return { width: geometry.width, height: geometry.height };
}

/** Output size of the crop in whole pixels, at least 1x1. */
export function cropOutputPixels(crop: CropParams, image: Size): Size {
  const size = cropOutputSize(crop, image);
  return {
    width: Math.max(1, Math.round(size.width)),
    height: Math.max(1, Math.round(size.height)),
  };
}

/** Pixel aspect ratio (width / height) of the crop's output. */
export function cropAspect(crop: CropParams, image: Size): number {
  const size = cropOutputSize(crop, image);
  return size.height > 0 ? size.width / size.height : 1;
}

/** The crop rectangle's four corners in source pixels, clockwise from its display top-left. */
export function cropCorners(crop: CropParams, image: Size): [Point, Point, Point, Point] {
  const geometry = cropGeometry(crop, image);
  const corner = (x: number, y: number): Point => {
    const rotated = rotatePoint(x, y, geometry.angle);
    return { x: geometry.centerX + rotated.x, y: geometry.centerY + rotated.y };
  };
  const u = geometry.width / 2;
  const v = geometry.height / 2;
  return [corner(-u, -v), corner(u, -v), corner(u, v), corner(-u, v)];
}

/** Maps a point in cropped output pixels (0..output size) to source pixels. */
export function croppedToSourcePixels(crop: CropParams, image: Size, point: Point): Point {
  const geometry = cropGeometry(crop, image);
  const rotated = rotatePoint(
    point.x - geometry.width / 2,
    point.y - geometry.height / 2,
    geometry.angle,
  );
  return { x: geometry.centerX + rotated.x, y: geometry.centerY + rotated.y };
}

/** Maps a point in source pixels to cropped output pixels. */
export function sourceToCroppedPixels(crop: CropParams, image: Size, point: Point): Point {
  const geometry = cropGeometry(crop, image);
  const local = unrotatePoint(
    point.x - geometry.centerX,
    point.y - geometry.centerY,
    geometry.angle,
  );
  return { x: local.x + geometry.width / 2, y: local.y + geometry.height / 2 };
}

/** Maps normalized output coordinates (0..1 of the cropped result) to the uncropped normalized image. */
export function croppedToSource(crop: CropParams, image: Size, point: Point): Point {
  const pixels = croppedToSourcePixels(crop, image, {
    x: point.x * cropOutputSize(crop, image).width,
    y: point.y * cropOutputSize(crop, image).height,
  });
  return { x: pixels.x / image.width, y: pixels.y / image.height };
}

/** Maps normalized coordinates of the uncropped image to normalized cropped output coordinates. */
export function sourceToCropped(crop: CropParams, image: Size, point: Point): Point {
  const output = cropOutputSize(crop, image);
  const pixels = sourceToCroppedPixels(crop, image, {
    x: point.x * image.width,
    y: point.y * image.height,
  });
  return { x: pixels.x / output.width, y: pixels.y / output.height };
}

/**
 * The largest crop with `aspect` (pixel width / height; default: the image's
 * own aspect) that fits inside the image rotated by `angle`, centred on the
 * image. This is Lightroom's "constrain to image" starting point: a rotated
 * image has black corners, so a full-frame crop has to shrink.
 */
export function largestCropForAspect(
  image: Size,
  angle: number,
  aspect?: number,
  center?: Point,
): CropParams {
  const ratio =
    aspect !== undefined && Number.isFinite(aspect) && aspect > 0
      ? aspect
      : image.width / image.height;
  const { cos, sin } = cosSin(angle);
  const a = Math.abs(cos);
  const b = Math.abs(sin);
  const halfHeight = Math.min(
    image.width / 2 / (ratio * a + b),
    image.height / 2 / (ratio * b + a),
  );
  const halfWidth = ratio * halfHeight;
  const crop = cropFromGeometry(
    center?.x ?? image.width / 2,
    center?.y ?? image.height / 2,
    Math.max(1, halfWidth * 2),
    Math.max(1, halfHeight * 2),
    angle,
    image,
  );
  return center ? constrainCrop(crop, image) : crop;
}

/** A drag handle on the crop rectangle, named by its position. */
export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/**
 * Resizes a crop from a handle dragged to `point` (source pixels). The
 * opposite corner/edge stays put. `aspect` (pixel width / height) locks the
 * ratio when present.
 *
 * When the dragged edge would leave the image, it is clamped *along that
 * edge* (binary search towards the old position); the crop is not scaled
 * around its centre, so the opposite edge does not move.
 */
export function resizeCropFromHandle(
  crop: CropParams,
  image: Size,
  handle: CropHandle,
  point: Point,
  aspect?: number,
): CropParams {
  const geometry = cropGeometry(crop, image);
  const proposed = unrotatePoint(
    point.x - geometry.centerX,
    point.y - geometry.centerY,
    geometry.angle,
  );
  const oldLeft = -geometry.width / 2;
  const oldRight = geometry.width / 2;
  const oldTop = -geometry.height / 2;
  const oldBottom = geometry.height / 2;
  const minSize = Math.max(2, Math.min(image.width, image.height) * 0.005);
  const handleX = handle.includes('w') ? oldLeft : handle.includes('e') ? oldRight : 0;
  const handleY = handle.includes('n') ? oldTop : handle.includes('s') ? oldBottom : 0;

  const build = (localX: number, localY: number): CropParams => {
    let left = oldLeft;
    let right = oldRight;
    let top = oldTop;
    let bottom = oldBottom;
    if (handle.includes('w')) left = Math.min(localX, right - minSize);
    if (handle.includes('e')) right = Math.max(localX, left + minSize);
    if (handle.includes('n')) top = Math.min(localY, bottom - minSize);
    if (handle.includes('s')) bottom = Math.max(localY, top + minSize);

    let width = right - left;
    let height = bottom - top;
    if (aspect !== undefined && Number.isFinite(aspect) && aspect > 0) {
      const horizontal = handle === 'e' || handle === 'w' || handle.length === 2;
      if (horizontal && handle.length === 2) {
        height = width / aspect;
        if (handle.includes('n')) top = bottom - height;
        else bottom = top + height;
      } else if (horizontal) {
        height = width / aspect;
        const centerY = (top + bottom) / 2;
        top = centerY - height / 2;
        bottom = centerY + height / 2;
      } else {
        width = height * aspect;
        const centerX = (left + right) / 2;
        left = centerX - width / 2;
        right = centerX + width / 2;
      }
      width = right - left;
      height = bottom - top;
    }

    const center = rotatePoint((left + right) / 2, (top + bottom) / 2, geometry.angle);
    return cropFromGeometry(
      geometry.centerX + center.x,
      geometry.centerY + center.y,
      Math.max(minSize, width),
      Math.max(minSize, height),
      geometry.angle,
      image,
    );
  };

  const epsilon = 1e-6;
  const fits = (candidate: CropParams): boolean =>
    cropCorners(candidate, image).every(
      (corner) =>
        corner.x >= -epsilon &&
        corner.x <= image.width + epsilon &&
        corner.y >= -epsilon &&
        corner.y <= image.height + epsilon,
    );

  const atEnd = build(proposed.x, proposed.y);
  if (fits(atEnd)) return atEnd;
  if (!fits(crop)) return constrainCrop(crop, image);

  // Keep the old position as the anchor and move only the dragged edges.
  let best = crop;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const middle = (low + high) / 2;
    const candidate = build(
      handleX + (proposed.x - handleX) * middle,
      handleY + (proposed.y - handleY) * middle,
    );
    if (fits(candidate)) {
      low = middle;
      best = candidate;
    } else {
      high = middle;
    }
  }
  return best;
}

/**
 * Shrinks and moves a crop so its rotated rectangle lies inside the image.
 * Translation is applied after scaling; the aspect ratio and angle are kept.
 * A degenerate (zero-size) crop is clamped to a minimal 1 px rectangle at the
 * same centre/angle rather than being replaced by the full frame.
 */
export function constrainCrop(crop: CropParams, image: Size): CropParams {
  const geometry = cropGeometry(crop, image);
  const angle = Number.isFinite(geometry.angle) ? geometry.angle : 0;
  const width = Number.isFinite(geometry.width) && geometry.width > 0 ? geometry.width : 1;
  const height = Number.isFinite(geometry.height) && geometry.height > 0 ? geometry.height : 1;
  const centerX = Number.isFinite(geometry.centerX) ? geometry.centerX : image.width / 2;
  const centerY = Number.isFinite(geometry.centerY) ? geometry.centerY : image.height / 2;
  const { cos, sin } = cosSin(angle);
  const a = Math.abs(cos);
  const b = Math.abs(sin);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  // Axis-aligned bounding box of the rotated crop.
  const extentX = halfWidth * a + halfHeight * b;
  const extentY = halfWidth * b + halfHeight * a;
  const scale = Math.min(
    1,
    extentX > 0 ? image.width / 2 / extentX : 1,
    extentY > 0 ? image.height / 2 / extentY : 1,
  );
  const fittedWidth = Math.max(1, width * scale);
  const fittedHeight = Math.max(1, height * scale);
  const scaledExtentX = (fittedWidth / 2) * a + (fittedHeight / 2) * b;
  const scaledExtentY = (fittedWidth / 2) * b + (fittedHeight / 2) * a;
  const fittedCenterX = clamp(
    centerX,
    scaledExtentX,
    Math.max(scaledExtentX, image.width - scaledExtentX),
  );
  const fittedCenterY = clamp(
    centerY,
    scaledExtentY,
    Math.max(scaledExtentY, image.height - scaledExtentY),
  );
  return cropFromGeometry(fittedCenterX, fittedCenterY, fittedWidth, fittedHeight, angle, image);
}

/** EXIF orientation, 1..8 (1 = stored pixels are already upright). */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Orientations that mirror the image, so a clockwise angle becomes counter-clockwise. */
const MIRRORED_ORIENTATIONS = new Set<number>([2, 4, 5, 7]);
/** Orientations that swap the stored width and height. */
const SWAPPED_ORIENTATIONS = new Set<number>([5, 6, 7, 8]);

/** Normalises an EXIF orientation value; unknown values mean 1 (no transform). */
export function normalizeOrientation(orientation: number | undefined): ExifOrientation {
  return orientation !== undefined &&
    Number.isInteger(orientation) &&
    orientation >= 1 &&
    orientation <= 8
    ? (orientation as ExifOrientation)
    : 1;
}

/** Size of the stored (pre-orientation) pixel array for an oriented image. */
export function storedSizeForOrientation(oriented: Size, orientation: number): Size {
  return SWAPPED_ORIENTATIONS.has(normalizeOrientation(orientation))
    ? { width: oriented.height, height: oriented.width }
    : { width: oriented.width, height: oriented.height };
}

/** Normalized oriented point -> normalized stored point (EXIF orientation applied). */
export function orientedToStoredPoint(point: Point, orientation: number): Point {
  switch (normalizeOrientation(orientation)) {
    case 2:
      return { x: 1 - point.x, y: point.y };
    case 3:
      return { x: 1 - point.x, y: 1 - point.y };
    case 4:
      return { x: point.x, y: 1 - point.y };
    case 5:
      return { x: point.y, y: point.x };
    case 6:
      return { x: point.y, y: 1 - point.x };
    case 7:
      return { x: 1 - point.y, y: 1 - point.x };
    case 8:
      return { x: 1 - point.y, y: point.x };
    default:
      return { x: point.x, y: point.y };
  }
}

/** Normalized stored point -> normalized oriented point. */
export function storedToOrientedPoint(point: Point, orientation: number): Point {
  switch (normalizeOrientation(orientation)) {
    case 2:
      return { x: 1 - point.x, y: point.y };
    case 3:
      return { x: 1 - point.x, y: 1 - point.y };
    case 4:
      return { x: point.x, y: 1 - point.y };
    case 5:
      return { x: point.y, y: point.x };
    case 6:
      return { x: 1 - point.y, y: point.x };
    case 7:
      return { x: 1 - point.y, y: 1 - point.x };
    case 8:
      return { x: point.y, y: 1 - point.x };
    default:
      return { x: point.x, y: point.y };
  }
}

/**
 * Oriented-space crop (the app's `EditParams.crop`) -> Lightroom's stored-space
 * `crs:Crop*`. EXIF orientations 5..8 swap the crop's width/height (a portrait
 * crop in the displayed image is landscape in the stored sensor array), and
 * mirrored orientations (2, 4, 5, 7) negate the clockwise angle. This matches
 * darktable's orientation handling in `dt_lightroom_import`.
 */
export function cropOrientedToStored(
  crop: CropParams,
  oriented: Size,
  orientation: number,
): CropParams {
  const normalised = normalizeOrientation(orientation);
  if (normalised === 1) return { ...crop };
  const stored = storedSizeForOrientation(oriented, normalised);
  const geometry = cropGeometry(crop, oriented);
  const center = orientedToStoredPoint(
    { x: geometry.centerX / oriented.width, y: geometry.centerY / oriented.height },
    normalised,
  );
  const swapped = SWAPPED_ORIENTATIONS.has(normalised);
  return cropFromGeometry(
    center.x * stored.width,
    center.y * stored.height,
    swapped ? geometry.height : geometry.width,
    swapped ? geometry.width : geometry.height,
    MIRRORED_ORIENTATIONS.has(normalised) ? -geometry.angle : geometry.angle,
    stored,
  );
}

/** Stored-space `crs:Crop*` -> oriented-space crop (inverse of {@link cropOrientedToStored}). */
export function cropStoredToOriented(
  crop: CropParams,
  oriented: Size,
  orientation: number,
): CropParams {
  const normalised = normalizeOrientation(orientation);
  if (normalised === 1) return { ...crop };
  const stored = storedSizeForOrientation(oriented, normalised);
  const geometry = cropGeometry(crop, stored);
  const center = storedToOrientedPoint(
    { x: geometry.centerX / stored.width, y: geometry.centerY / stored.height },
    normalised,
  );
  const swapped = SWAPPED_ORIENTATIONS.has(normalised);
  return cropFromGeometry(
    center.x * oriented.width,
    center.y * oriented.height,
    swapped ? geometry.height : geometry.width,
    swapped ? geometry.width : geometry.height,
    MIRRORED_ORIENTATIONS.has(normalised) ? -geometry.angle : geometry.angle,
    oriented,
  );
}

/** True when the crop covers the whole image and does not straighten it. */
export function isFullCrop(crop: CropParams): boolean {
  const epsilon = 1e-9;
  return (
    Math.abs(crop.angle) < epsilon &&
    Math.abs(crop.left) < epsilon &&
    Math.abs(crop.top) < epsilon &&
    Math.abs(crop.right - 1) < epsilon &&
    Math.abs(crop.bottom - 1) < epsilon
  );
}

/** Clamps a crop parameter object to sane finite values (not to the image, see {@link constrainCrop}). */
export function sanitizeCrop(crop: CropParams, maxAngle = 45): CropParams {
  const finite = (value: number, fallback: number): number =>
    Number.isFinite(value) ? value : fallback;
  return {
    left: clamp(finite(crop.left, 0), 0, 1),
    top: clamp(finite(crop.top, 0), 0, 1),
    right: clamp(finite(crop.right, 1), 0, 1),
    bottom: clamp(finite(crop.bottom, 1), 0, 1),
    angle: clamp(finite(crop.angle, 0), -maxAngle, maxAngle),
  };
}

/**
 * Crops and rotates an already-developed (sRGB 8-bit RGBA) buffer with the
 * same bilinear sampling as the shader. Used by the export path so a mosaic
 * can be applied in source space *before* the rotation.
 *
 * This is CPU work: a 45 MP source plus a full-size output buffer is ~360 MB
 * of RGBA traffic and one bilinear sample per output pixel. It only runs when
 * a mosaic needs source-space ordering; a crop without retouch stays on the
 * GPU path.
 */
export function cropDevelopedRgba(
  source: Uint8Array,
  image: Size,
  crop: CropParams,
  output: Size = cropOutputPixels(crop, image),
): Uint8Array {
  const width = Math.max(1, Math.round(output.width));
  const height = Math.max(1, Math.round(output.height));
  if (source.length < image.width * image.height * 4) {
    throw new RangeError(
      `cropDevelopedRgba: source has ${source.length} bytes for ${image.width}x${image.height}`,
    );
  }
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const point = croppedToSourcePixels(crop, image, { x: x + 0.5, y: y + 0.5 });
      const fx = point.x - 0.5;
      const fy = point.y - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const wx = fx - x0;
      const wy = fy - y0;
      const xa = clamp(x0, 0, image.width - 1);
      const xb = clamp(x0 + 1, 0, image.width - 1);
      const ya = clamp(y0, 0, image.height - 1);
      const yb = clamp(y0 + 1, 0, image.height - 1);
      const o = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const top =
          (source[(ya * image.width + xa) * 4 + channel] ?? 0) * (1 - wx) +
          (source[(ya * image.width + xb) * 4 + channel] ?? 0) * wx;
        const bottom =
          (source[(yb * image.width + xa) * 4 + channel] ?? 0) * (1 - wx) +
          (source[(yb * image.width + xb) * 4 + channel] ?? 0) * wx;
        out[o + channel] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return out;
}
