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

/** The smallest crop edge in pixels a resize or a drawn crop may produce. */
export function minCropSize(image: Size): number {
  return Math.max(2, Math.min(image.width, image.height) * 0.005);
}

const validAspect = (aspect: number | undefined): aspect is number =>
  aspect !== undefined && Number.isFinite(aspect) && aspect > 0;

/** True when all four corners of the (rotated) crop are inside the image. */
export function cropFitsImage(crop: CropParams, image: Size): boolean {
  const epsilon = 1e-6;
  return cropCorners(crop, image).every(
    (corner) =>
      corner.x >= -epsilon &&
      corner.x <= image.width + epsilon &&
      corner.y >= -epsilon &&
      corner.y <= image.height + epsilon,
  );
}

/**
 * Finds the candidate closest to `t = 1` that `fits`, by bisection on `t` in
 * 0..1. `candidate(0)` is the starting position; when even that does not fit,
 * returns `fallback`.
 */
function furthestFit<T>(candidate: (t: number) => T, fits: (value: T) => boolean, fallback: T): T {
  const end = candidate(1);
  if (fits(end)) return end;
  let best = fallback;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const middle = (low + high) / 2;
    const value = candidate(middle);
    if (fits(value)) {
      low = middle;
      best = value;
    } else {
      high = middle;
    }
  }
  return best;
}

/**
 * Resizes a crop from a handle dragged to `point` (source pixels). The
 * opposite corner/edge stays put, or the centre when `symmetric` (Alt).
 * `aspect` (pixel width / height) locks the ratio when present: an edge handle
 * resizes the other dimension about the frame centre, a corner handle grows
 * the frame until it reaches the pointer in both directions.
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
  symmetric = false,
): CropParams {
  const geometry = cropGeometry(crop, image);
  const proposed = unrotatePoint(
    point.x - geometry.centerX,
    point.y - geometry.centerY,
    geometry.angle,
  );
  const halfWidth = geometry.width / 2;
  const halfHeight = geometry.height / 2;
  const minSize = minCropSize(image);
  const movesLeft = handle.includes('w');
  const movesRight = handle.includes('e');
  const movesTop = handle.includes('n');
  const movesBottom = handle.includes('s');
  const movesX = movesLeft || movesRight;
  const movesY = movesTop || movesBottom;
  const handleX = movesLeft ? -halfWidth : movesRight ? halfWidth : 0;
  const handleY = movesTop ? -halfHeight : movesBottom ? halfHeight : 0;

  // Edges in the crop's local (leveled) frame, relative to the crop centre.
  const build = (localX: number, localY: number): CropParams => {
    let left = -halfWidth;
    let right = halfWidth;
    let top = -halfHeight;
    let bottom = halfHeight;
    if (symmetric) {
      if (movesX) {
        const half = Math.max(minSize / 2, movesRight ? localX : -localX);
        left = -half;
        right = half;
      }
      if (movesY) {
        const half = Math.max(minSize / 2, movesBottom ? localY : -localY);
        top = -half;
        bottom = half;
      }
    } else {
      if (movesLeft) left = Math.min(localX, right - minSize);
      if (movesRight) right = Math.max(localX, left + minSize);
      if (movesTop) top = Math.min(localY, bottom - minSize);
      if (movesBottom) bottom = Math.max(localY, top + minSize);
    }

    if (validAspect(aspect)) {
      let width = right - left;
      let height = bottom - top;
      if (movesX && movesY) {
        width = Math.max(width, height * aspect);
        height = width / aspect;
      } else if (movesX) {
        height = width / aspect;
      } else {
        width = height * aspect;
      }
      if (symmetric) {
        left = -width / 2;
        right = width / 2;
        top = -height / 2;
        bottom = height / 2;
      } else {
        // The dragged side moves; the opposite side stays. An axis the handle
        // does not touch is centred on the old centre.
        if (movesLeft) left = right - width;
        else if (movesRight) right = left + width;
        else {
          left = -width / 2;
          right = width / 2;
        }
        if (movesTop) top = bottom - height;
        else if (movesBottom) bottom = top + height;
        else {
          top = -height / 2;
          bottom = height / 2;
        }
      }
    }

    const center = rotatePoint((left + right) / 2, (top + bottom) / 2, geometry.angle);
    return cropFromGeometry(
      geometry.centerX + center.x,
      geometry.centerY + center.y,
      Math.max(minSize, right - left),
      Math.max(minSize, bottom - top),
      geometry.angle,
      image,
    );
  };

  if (!cropFitsImage(crop, image)) return constrainCrop(crop, image);
  // Move the dragged edges from their old position towards the pointer; the
  // opposite edges are the anchor.
  return furthestFit(
    (t) => build(handleX + (proposed.x - handleX) * t, handleY + (proposed.y - handleY) * t),
    (candidate) => cropFitsImage(candidate, image),
    crop,
  );
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

/**
 * Lightroom-style display model for crop mode.
 *
 * While cropping, the frame is axis-aligned on screen and the *image* is
 * rotated underneath it by `-angle` (the stored crop is rotated by `+angle`;
 * levelling it means turning the image the other way). "View" coordinates are
 * screen coordinates in source-pixel units, with the frame centre at `pivot`:
 *
 *   view = pivot + R(-angle) * (image - crop centre)
 *
 * The pivot is session state: panning and rotating keep it (the frame does not
 * move on screen), resizing moves it (the image does not move on screen).
 */

/** Source-image point -> view point. */
export function cropImageToView(geometry: CropGeometry, pivot: Point, point: Point): Point {
  const local = unrotatePoint(
    point.x - geometry.centerX,
    point.y - geometry.centerY,
    geometry.angle,
  );
  return { x: pivot.x + local.x, y: pivot.y + local.y };
}

/** View point -> source-image point (inverse of {@link cropImageToView}). */
export function cropViewToImage(geometry: CropGeometry, pivot: Point, point: Point): Point {
  const rotated = rotatePoint(point.x - pivot.x, point.y - pivot.y, geometry.angle);
  return { x: geometry.centerX + rotated.x, y: geometry.centerY + rotated.y };
}

/** Largest straighten angle in degrees, either way. */
export const MAX_CROP_ANGLE = 45;

/**
 * Clockwise on-screen angle in degrees, in (-180, 180], that the pointer swept
 * around `pivot` going from `from` to `to`.
 */
export function pointerAngleDelta(pivot: Point, from: Point, to: Point): number {
  const before = Math.atan2(from.y - pivot.y, from.x - pivot.x);
  const after = Math.atan2(to.y - pivot.y, to.x - pivot.x);
  let delta = (after - before) / DEG;
  while (delta > 180) delta -= 360;
  while (delta <= -180) delta += 360;
  return delta;
}

/** Rounds an angle to 0.1 degrees (1 degree when `snap`) and limits it to +-45. */
export function quantizeAngle(angle: number, snap = false): number {
  const finite = Number.isFinite(angle) ? angle : 0;
  const rounded = snap ? Math.round(finite) : Math.round(finite * 10) / 10;
  return clamp(rounded, -MAX_CROP_ANGLE, MAX_CROP_ANGLE) + 0;
}

/**
 * The crop angle that levels a line drawn between two view points while the
 * crop currently has `currentAngle`. The line is measured on screen, so it
 * already includes the displayed rotation.
 */
export function straightenAngleFromLine(currentAngle: number, from: Point, to: Point): number {
  let slope = Math.atan2(to.y - from.y, to.x - from.x) / DEG;
  while (slope > 90) slope -= 180;
  while (slope <= -90) slope += 180;
  return quantizeAngle(currentAngle + slope);
}

/**
 * True when the stored corners describe a crop at all: finite numbers and two
 * distinct corners. The corners are opposite corners of the *rotated* rectangle,
 * so near +-45 degrees they are legitimately "inverted" (right < left or
 * bottom < top for a wide frame tilted one way); the angle disambiguates, so
 * order is not a validity test.
 */
export function isUsableCrop(crop: CropParams): boolean {
  return (
    [crop.left, crop.top, crop.right, crop.bottom, crop.angle].every(Number.isFinite) &&
    (crop.right !== crop.left || crop.bottom !== crop.top)
  );
}

/**
 * Pans the image under the fixed frame: the image moves by `delta` (view
 * units) and the crop follows, clamped so the frame stays inside the image.
 * Each axis is clamped on its own, so dragging along an edge still slides.
 */
export function panCrop(crop: CropParams, image: Size, delta: Point): CropParams {
  const geometry = cropGeometry(crop, image);
  const shift = rotatePoint(delta.x, delta.y, geometry.angle);
  return constrainCrop(
    cropFromGeometry(
      geometry.centerX - shift.x,
      geometry.centerY - shift.y,
      geometry.width,
      geometry.height,
      geometry.angle,
      image,
    ),
    image,
  );
}

/**
 * Scales the crop down about its own centre (aspect, angle and centre kept)
 * until its rotated rectangle is inside the image. This is "constrain to
 * image" while the frame stays where it is on screen. A crop that already fits
 * is returned unchanged.
 */
export function shrinkCropToImage(crop: CropParams, image: Size): CropParams {
  const geometry = cropGeometry(crop, image);
  const centerX = clamp(geometry.centerX, 0, image.width);
  const centerY = clamp(geometry.centerY, 0, image.height);
  const { cos, sin } = cosSin(geometry.angle);
  const a = Math.abs(cos);
  const b = Math.abs(sin);
  const extentX = (geometry.width / 2) * a + (geometry.height / 2) * b;
  const extentY = (geometry.width / 2) * b + (geometry.height / 2) * a;
  const scale = Math.min(
    1,
    extentX > 0 ? Math.min(centerX, image.width - centerX) / extentX : 1,
    extentY > 0 ? Math.min(centerY, image.height - centerY) / extentY : 1,
  );
  if (scale >= 1 && centerX === geometry.centerX && centerY === geometry.centerY) return crop;
  return cropFromGeometry(
    centerX,
    centerY,
    Math.max(1, geometry.width * scale),
    Math.max(1, geometry.height * scale),
    geometry.angle,
    image,
  );
}

/**
 * Straightens the crop to `angle` about the frame centre. The frame keeps its
 * aspect ratio and shrinks just enough that the rotated image still covers it;
 * this works all the way to +-45 degrees, never refusing. Pass the size the user asked for as `desired` so the frame grows back when
 * the angle returns (otherwise a drag back and forth would ratchet it down).
 */
export function rotateCrop(
  crop: CropParams,
  image: Size,
  angle: number,
  desired?: Size,
): CropParams {
  const geometry = cropGeometry(crop, image);
  const size = desired ?? { width: geometry.width, height: geometry.height };
  return shrinkCropToImage(
    cropFromGeometry(
      geometry.centerX,
      geometry.centerY,
      size.width,
      size.height,
      quantizeAngle(angle),
      image,
    ),
    image,
  );
}

/**
 * {@link rotateCrop} for the view model: the image turns about `pivot` (the
 * frame centre on screen). Normally the crop centre does not change and neither
 * does the pivot; if the centre had to be pulled back into the image, the frame
 * follows it, so the image keeps turning about the old pivot instead of jumping.
 */
export function rotateCropInView(
  crop: CropParams,
  image: Size,
  pivot: Point,
  angle: number,
  desired?: Size,
): DrawnCrop {
  const before = cropGeometry(crop, image);
  const next = rotateCrop(crop, image, angle, desired);
  const after = cropGeometry(next, image);
  const dx = after.centerX - before.centerX;
  const dy = after.centerY - before.centerY;
  // Rounding in the corner round trip is not a move.
  const shift = Math.hypot(dx, dy) > 1e-6 ? unrotatePoint(dx, dy, after.angle) : { x: 0, y: 0 };
  return { crop: next, pivot: { x: pivot.x + shift.x, y: pivot.y + shift.y } };
}

/** A freshly drawn crop and the view position of its centre. */
export interface DrawnCrop {
  crop: CropParams;
  pivot: Point;
}

/**
 * Lightroom's crop-frame tool: the user drags a new axis-aligned frame over the
 * displayed (rotated) image from `anchor` to `point` (view points). The angle is
 * kept. `aspect` locks the ratio (the frame grows to reach the pointer on both
 * axes), `symmetric` draws about the anchor instead of from it. The frame is
 * limited to the image by pulling the pointer back towards the anchor.
 * Returns undefined when the anchor is not on the image.
 */
export function drawCrop(
  crop: CropParams,
  image: Size,
  pivot: Point,
  anchor: Point,
  point: Point,
  aspect?: number,
  symmetric = false,
): DrawnCrop | undefined {
  const geometry = cropGeometry(crop, image);
  const minSize = minCropSize(image);
  const signX = point.x < anchor.x ? -1 : 1;
  const signY = point.y < anchor.y ? -1 : 1;
  const build = (t: number): DrawnCrop => {
    const reach = symmetric ? 2 : 1;
    let width = Math.abs(point.x - anchor.x) * t * reach;
    let height = Math.abs(point.y - anchor.y) * t * reach;
    if (validAspect(aspect)) {
      width = Math.max(width, height * aspect, minSize, minSize * aspect);
      height = width / aspect;
    } else {
      width = Math.max(width, minSize);
      height = Math.max(height, minSize);
    }
    const center = symmetric
      ? anchor
      : { x: anchor.x + (signX * width) / 2, y: anchor.y + (signY * height) / 2 };
    const imageCenter = cropViewToImage(geometry, pivot, center);
    return {
      crop: cropFromGeometry(imageCenter.x, imageCenter.y, width, height, geometry.angle, image),
      pivot: center,
    };
  };
  const fits = (drawn: DrawnCrop): boolean => cropFitsImage(drawn.crop, image);
  const start = build(0);
  if (!fits(start)) return undefined;
  return furthestFit(build, fits, start);
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

/** Most samples per axis averaged for one output pixel when a crop is drawn smaller than its own size. */
const MAX_CROP_TAPS = 8;

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
  // `output` may differ from the crop's own pixel size (a thumbnail): scale the
  // sample positions to match, and average a few taps per pixel when shrinking
  // so the result is not aliased. At the natural size both are exactly 1.
  const natural = cropOutputPixels(crop, image);
  const exact = width === natural.width && height === natural.height;
  const size = cropOutputSize(crop, image);
  const scaleX = exact ? 1 : size.width / width;
  const scaleY = exact ? 1 : size.height / height;
  const tapsX = Math.min(MAX_CROP_TAPS, Math.max(1, Math.ceil(scaleX)));
  const tapsY = Math.min(MAX_CROP_TAPS, Math.max(1, Math.ceil(scaleY)));
  const sum = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sum.fill(0);
      for (let ty = 0; ty < tapsY; ty++) {
        for (let tx = 0; tx < tapsX; tx++) {
          const point = croppedToSourcePixels(crop, image, {
            x: (x + (tx + 0.5) / tapsX) * scaleX,
            y: (y + (ty + 0.5) / tapsY) * scaleY,
          });
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
          for (let channel = 0; channel < 4; channel++) {
            const top =
              (source[(ya * image.width + xa) * 4 + channel] ?? 0) * (1 - wx) +
              (source[(ya * image.width + xb) * 4 + channel] ?? 0) * wx;
            const bottom =
              (source[(yb * image.width + xa) * 4 + channel] ?? 0) * (1 - wx) +
              (source[(yb * image.width + xb) * 4 + channel] ?? 0) * wx;
            sum[channel]! += top * (1 - wy) + bottom * wy;
          }
        }
      }
      const o = (y * width + x) * 4;
      const taps = tapsX * tapsY;
      for (let channel = 0; channel < 4; channel++) {
        out[o + channel] = Math.round(sum[channel]! / taps);
      }
    }
  }
  return out;
}
