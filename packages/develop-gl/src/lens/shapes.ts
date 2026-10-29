import type { EditParams, Point, Polygon, Shape } from '@ee/contracts';
import { lensCorrectedPosition } from './model';
import { resolveLens, type LensImage } from './resolve';

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

/**
 * `shapes` moved into the corrected picture for these settings. Unchanged (the same objects) when
 * the settings do not move any pixel.
 */
export function correctedShapes(
  shapes: readonly Shape[],
  image: LensImage,
  params: EditParams,
): Shape[] {
  const { uniforms } = resolveLens(image, params);
  if (!uniforms.geometry) return [...shapes];
  const { width, height } = image;
  return shapes.map((shape): Polygon => {
    const outline: Point[] =
      shape.type === 'rect'
        ? [
            { x: shape.x, y: shape.y },
            { x: shape.x + shape.w, y: shape.y },
            { x: shape.x + shape.w, y: shape.y + shape.h },
            { x: shape.x, y: shape.y + shape.h },
          ]
        : shape.points;
    const moved = densify(outline, width, height).map((p) => {
      const q = lensCorrectedPosition(uniforms, p.x * width, p.y * height);
      return { x: q.x, y: q.y };
    });
    // Out from the centroid of the outline (in pixels), so the polygon only ever grows.
    const cx = moved.reduce((s, p) => s + p.x, 0) / moved.length;
    const cy = moved.reduce((s, p) => s + p.y, 0) / moved.length;
    return {
      type: 'polygon',
      points: moved.map((p) => {
        const d = Math.hypot(p.x - cx, p.y - cy) || 1;
        return {
          x: (p.x + ((p.x - cx) / d) * MARGIN) / width,
          y: (p.y + ((p.y - cy) / d) * MARGIN) / height,
        };
      }),
    };
  });
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
