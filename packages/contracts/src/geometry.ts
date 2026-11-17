/** A point in normalized image coordinates: both axes run 0..1 from the top-left corner. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Axis-aligned rectangle in normalized image coordinates (0..1, origin top-left,
 * relative to the oriented, uncropped image).
 */
export interface Rect {
  type: 'rect';
  x: number;
  y: number;
  /** Width, 0..1. */
  w: number;
  /** Height, 0..1. */
  h: number;
}

/** Closed polygon in normalized image coordinates; the last point connects back to the first. */
export interface Polygon {
  type: 'polygon';
  points: Point[];
}

/** A selection shape, discriminated by `type`. */
export type Shape = Rect | Polygon;

/** One clockwise quarter turn of the picture, on a normalized point: the right edge becomes the bottom. */
const turnPoint = (point: Point): Point => ({ x: 1 - point.y, y: point.x });

const turnRect = (rect: Rect): Rect => ({
  type: 'rect',
  x: 1 - (rect.y + rect.h),
  y: rect.x,
  w: rect.h,
  h: rect.w,
});

/**
 * A shape in normalized image coordinates after the picture is turned `turns` quarter turns
 * clockwise (negative turns go counter-clockwise). The shape keeps covering the same picture
 * content, whose width and height trade places on an odd number of turns.
 */
export function rotateShape(shape: Shape, turns: number): Shape {
  const quarter = ((Math.round(turns) % 4) + 4) % 4;
  let moved: Shape = shape;
  for (let i = 0; i < quarter; i++) {
    moved =
      moved.type === 'rect'
        ? turnRect(moved)
        : { type: 'polygon', points: moved.points.map(turnPoint) };
  }
  return moved;
}
