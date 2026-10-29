import type { EditParams, Point, Polygon, Rect, Shape } from '@ee/contracts';
import { lensCorrectedPosition, lensSample, type LensSample, type LensUniforms } from './model';
import { previewGeometry, resolveLens, type LensImage } from './resolve';

/**
 * Retouch shapes are stored in the recorded (uncorrected) picture's normalised coordinates. Once
 * the lens correction resamples the picture, a shape has to follow it: each outline point is moved
 * to where the correction puts that recorded point. The maps are smooth and radial, so a straight
 * edge becomes a curve; edges are cut into short pieces (no more than {@link MAX_PIECE} pixels
 * long, whatever the picture's size) so the polygon stays within a hundredth of a pixel of the
 * true outline, and the outline is then pushed out by {@link MARGIN} pixels so resampling cannot
 * expose a pixel the shape covered.
 */
const MAX_PIECE = 8;
const MAX_PIECES_PER_EDGE = 96;
const MARGIN = 1.5;

function densify(points: readonly Point[], width: number, height: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const pieces = Math.min(
      MAX_PIECES_PER_EDGE,
      Math.max(1, Math.ceil(Math.hypot((b.x - a.x) * width, (b.y - a.y) * height) / MAX_PIECE)),
    );
    for (let k = 0; k < pieces; k++) {
      const t = k / pieces;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** The outline of a shape as normalised points, a rectangle as its four corners. */
const outlineOf = (shape: Shape): Point[] =>
  shape.type === 'rect'
    ? [
        { x: shape.x, y: shape.y },
        { x: shape.x + shape.w, y: shape.y },
        { x: shape.x + shape.w, y: shape.y + shape.h },
        { x: shape.x, y: shape.y + shape.h },
      ]
    : shape.points;

/**
 * Moves every outline through `move` (pixels to pixels): the outline is cut into short pieces so
 * the polygon follows the curved image of a straight edge, and then pushed out from its centroid
 * by {@link MARGIN} pixels so the polygon only ever grows. `clamp` keeps the points on the picture.
 */
function moveShapes(
  shapes: readonly Shape[],
  width: number,
  height: number,
  move: (x: number, y: number) => { x: number; y: number },
  clamp: boolean,
): Polygon[] {
  return shapes.map((shape): Polygon => {
    const moved = densify(outlineOf(shape), width, height).map((p) =>
      move(p.x * width, p.y * height),
    );
    const cx = moved.reduce((s, p) => s + p.x, 0) / moved.length;
    const cy = moved.reduce((s, p) => s + p.y, 0) / moved.length;
    const fit = (value: number, extent: number): number =>
      clamp ? Math.min(1, Math.max(0, value / extent)) : value / extent;
    return {
      type: 'polygon',
      points: moved.map((p) => {
        const d = Math.hypot(p.x - cx, p.y - cy) || 1;
        return {
          x: fit(p.x + ((p.x - cx) / d) * MARGIN, width),
          y: fit(p.y + ((p.y - cy) / d) * MARGIN, height),
        };
      }),
    };
  });
}

/**
 * `shapes` moved into the corrected picture for these settings. Unchanged when the settings do
 * not move any pixel.
 */
export function correctedShapes(
  shapes: readonly Shape[],
  image: LensImage,
  params: EditParams,
): Shape[] {
  const { uniforms } = resolveLens(image, params);
  if (!uniforms.geometry) return [...shapes];
  return moveShapes(
    shapes,
    image.width,
    image.height,
    (x, y) => lensCorrectedPosition(uniforms, x, y),
    false,
  );
}

const sample: LensSample = { gx: 0, gy: 0, rx: 0, ry: 0, bx: 0, by: 0 };
const recordedOf = (u: LensUniforms, x: number, y: number): { x: number; y: number } => {
  lensSample(u, x, y, sample);
  return { x: sample.gx, y: sample.gy };
};

/**
 * Shapes found on the camera's embedded preview (face detection) moved into the recorded picture,
 * where retouch shapes are stored. Nikon has already applied its distortion correction to the
 * preview, so a box there is in the corrected frame and its recorded outline is bent: every edge is
 * cut into short pieces and each point is taken through the lens map (corrected to recorded).
 * Unchanged for a picture whose preview is as recorded.
 */
export function previewShapesToRecorded(shapes: readonly Shape[], image: LensImage): Shape[] {
  const u = previewGeometry(image);
  if (!u) return [...shapes];
  return moveShapes(shapes, image.width, image.height, (x, y) => recordedOf(u, x, y), true);
}

/**
 * A search region drawn on the recorded picture as the rectangle of the embedded preview that holds
 * it: the bounds of its outline through the inverse lens map, so a face the region reaches is
 * inside the area the detector looks at.
 */
export function recordedRegionToPreview(region: Rect, image: LensImage): Rect {
  const u = previewGeometry(image);
  if (!u) return region;
  const { width, height } = image;
  const outline = densify(outlineOf(region), width, height).map((p) =>
    lensCorrectedPosition(u, p.x * width, p.y * height),
  );
  const x0 = Math.max(0, Math.min(...outline.map((p) => p.x)) / width);
  const y0 = Math.max(0, Math.min(...outline.map((p) => p.y)) / height);
  const x1 = Math.min(1, Math.max(...outline.map((p) => p.x)) / width);
  const y1 = Math.min(1, Math.max(...outline.map((p) => p.y)) / height);
  return { type: 'rect', x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * `params` without the settings that move pixels (profile, manual distortion, lateral CA): the
 * picture as recorded, in which retouch shapes are drawn and stored.
 */
export function withoutLensGeometry(params: EditParams): EditParams {
  const next: EditParams = { ...params, LensProfileEnable: false };
  delete next.LensManualDistortionAmount;
  delete next.AutoLateralCA;
  return next;
}
