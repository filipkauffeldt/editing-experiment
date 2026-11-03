import type { LensShotInfo, Rect, Shape } from '@ee/contracts';
import { previewShapesToRecorded, recordedRegionToPreview } from '@ee/develop-gl';
import { pointInPolygon, shapeBounds } from '@ee/retouch';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Padding around a detected face, as a fraction of its width. Height padding is
 * 1.4x wider and biased upward (65% above, 35% below) so hair and chins are
 * covered without swallowing much more of the frame.
 */
export const FACE_PADDING_VERTICAL = 1.4;
export const FACE_PADDING_UP_BIAS = 0.65;

/** Expand a normalized face box, clamped to the image. */
export function padFaceBox(box: Rect, padding: number): Rect {
  const horizontal = Math.max(0, box.w * padding);
  const vertical = Math.max(0, box.h * padding * FACE_PADDING_VERTICAL);
  const up = vertical * FACE_PADDING_UP_BIAS;
  const left = clamp(box.x - horizontal, 0, 1);
  const top = clamp(box.y - up, 0, 1);
  const right = clamp(box.x + box.w + horizontal, left, 1);
  const bottom = clamp(box.y + box.h + vertical - up, top, 1);
  return { type: 'rect', x: left, y: top, w: right - left, h: bottom - top };
}

/** What the lens corrections know about the photo on screen (see `AppState.photoLens`). */
export interface PhotoLensContext {
  lens: LensShotInfo | undefined;
  /** Size of the decoded image the lens facts were resolved for; only its shape matters. */
  width: number;
  height: number;
}

/**
 * The shape a detected face is stored as. Detection runs on the camera's embedded preview, which
 * Nikon has already corrected for lens distortion, but retouch shapes live in the recorded
 * picture; the padded box is taken through the lens map as a densified outline (distortion bends
 * its edges), so a face near a corner is covered where it really is.
 */
export function faceStoredShape(
  box: Rect,
  padding: number,
  context: PhotoLensContext | undefined,
): Shape {
  const padded = padFaceBox(box, padding);
  if (!context?.lens) return padded;
  return previewShapesToRecorded([padded], context)[0] ?? padded;
}

/** A search region drawn on the recorded picture, as the part of the embedded preview that holds it. */
export function detectionRegion(region: Rect, context: PhotoLensContext | undefined): Rect {
  return context?.lens ? recordedRegionToPreview(region, context) : region;
}

interface NormalizedPoint {
  x: number;
  y: number;
}

/** Centre of a detected face on the recorded picture, where the lasso was drawn. */
function faceCentre(box: Rect, context: PhotoLensContext | undefined): NormalizedPoint {
  const bounds = shapeBounds(faceStoredShape(box, 0, context));
  return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
}

/**
 * The faces whose box centre lies inside a lasso. Detection searches the lasso's bounding box, so
 * faces beside the outline are found too; the centre test drops those. Boxes are the detector's
 * raw boxes (preview space) and the lasso is on the recorded picture, like every retouch shape.
 */
export function facesInLasso<T extends { box: Rect }>(
  faces: readonly T[],
  lasso: readonly NormalizedPoint[],
  context: PhotoLensContext | undefined,
): T[] {
  return faces.filter((face) => pointInPolygon(faceCentre(face.box, context), lasso));
}
