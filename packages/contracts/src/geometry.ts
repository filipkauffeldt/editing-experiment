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
