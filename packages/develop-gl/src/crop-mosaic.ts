import type { CropParams, MosaicOp, Point, Shape } from '@ee/contracts';
import { cropOutputPixels, sourceToCroppedPixels, type Size } from './crop';

/** Points are normalized, so rounding to this many decimals keeps the payload small. */
const PRECISION = 1e9;

/**
 * Rewrite a source-space mosaic op for a rendered crop.
 *
 * Shapes are stored in normalized coordinates of the uncropped image while an
 * export render is already cropped and straightened. Mapping each shape into
 * the crop's output keeps the mosaic over the same pixels; a straighten turns a
 * rectangle into a polygon, which the mosaic rasteriser already supports. The
 * block size stays relative to the image edge, so it scales with the output.
 */
export function cropMosaicOp(op: MosaicOp, crop: CropParams, source: Size, output: Size): MosaicOp {
  const natural = cropOutputPixels(crop, source);
  const toOutput = (point: Point): Point => {
    const mapped = sourceToCroppedPixels(crop, source, {
      x: point.x * source.width,
      y: point.y * source.height,
    });
    return {
      x: round(mapped.x / natural.width),
      y: round(mapped.y / natural.height),
    };
  };
  const shapes = op.shapes.map((shape) => mapShape(shape, toOutput, output));
  return { ...op, shapes };
}

function mapShape(shape: Shape, toOutput: (point: Point) => Point, output: Size): Shape {
  if (shape.type === 'polygon') {
    return { type: 'polygon', points: shape.points.map(toOutput) };
  }
  const corners = [
    { x: shape.x, y: shape.y },
    { x: shape.x + shape.w, y: shape.y },
    { x: shape.x + shape.w, y: shape.y + shape.h },
    { x: shape.x, y: shape.y + shape.h },
  ].map(toOutput);
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  // A straighten tilts the rectangle; keep it exact as a polygon then. The
  // half-pixel tolerance absorbs floating-point noise at angle 0.
  const tilted =
    Math.abs(corners[0]!.y - corners[1]!.y) > 0.5 / output.height ||
    Math.abs(corners[1]!.x - corners[2]!.x) > 0.5 / output.width;
  if (tilted) return { type: 'polygon', points: corners };
  return { type: 'rect', x: left, y: top, w: right - left, h: bottom - top };
}

function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}
