import type { Point, Polygon, Rect, Shape } from '@ee/contracts';

/** A pixel dimension pair. */
export interface Size {
  width: number;
  height: number;
}

/** Continuous pixel-space rectangle (x/y may be fractional). */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Even-odd point-in-polygon test. Points exactly on an edge are not guaranteed
 * to be reported consistently; rasterisation samples pixel centres instead.
 */
export function pointInPolygon(point: Point, points: readonly Point[]): boolean {
  if (points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j]!;
    const b = points[i]!;
    if (b.y > point.y !== a.y > point.y) {
      const x = ((a.x - b.x) * (point.y - b.y)) / (a.y - b.y) + b.x;
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

/** Normalised (0..1) coordinate to continuous pixel coordinate. */
export function toPixel(value: number, extent: number): number {
  return value * extent;
}

/** Continuous pixel coordinate to normalised (0..1) coordinate. */
export function toNormalized(value: number, extent: number): number {
  return value / extent;
}

export function pointToPixel(point: Point, size: Size): Point {
  return { x: point.x * size.width, y: point.y * size.height };
}

export function pointToNormalized(point: Point, size: Size): Point {
  return { x: point.x / size.width, y: point.y / size.height };
}

export function rectToPixels(rect: Rect, size: Size): PixelRect {
  return {
    x: rect.x * size.width,
    y: rect.y * size.height,
    w: rect.w * size.width,
    h: rect.h * size.height,
  };
}

export function pixelRectToNormalized(rect: PixelRect, size: Size): Rect {
  return {
    type: 'rect',
    x: rect.x / size.width,
    y: rect.y / size.height,
    w: rect.w / size.width,
    h: rect.h / size.height,
  };
}

/** The four corners of a rect, clockwise from the top-left. */
export function rectToPolygon(rect: Rect): Polygon {
  return {
    type: 'polygon',
    points: [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h },
    ],
  };
}

export function polygonBounds(points: readonly Point[]): Rect {
  if (points.length === 0) return { type: 'rect', x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { type: 'rect', x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function shapeBounds(shape: Shape): Rect {
  return shape.type === 'rect' ? shape : polygonBounds(shape.points);
}

/** Bounds of the union of all shapes, in normalised coordinates. */
export function shapesBounds(shapes: readonly Shape[]): Rect | undefined {
  let bounds: Rect | undefined;
  for (const shape of shapes) {
    const next = shapeBounds(shape);
    if (next.w <= 0 || next.h <= 0) continue;
    if (!bounds) {
      bounds = { ...next };
    } else {
      const x = Math.min(bounds.x, next.x);
      const y = Math.min(bounds.y, next.y);
      const right = Math.max(bounds.x + bounds.w, next.x + next.w);
      const bottom = Math.max(bounds.y + bounds.h, next.y + next.h);
      bounds = { type: 'rect', x, y, w: right - x, h: bottom - y };
    }
  }
  return bounds;
}

/**
 * Expand a rect around its centre by `factor` (1 = unchanged, 1.5 = 50%
 * larger on both axes). The result is clamped to the unit square.
 */
export function expandRect(rect: Rect, factor: number): Rect {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new RangeError(`expandRect: factor must be a positive number, got ${factor}`);
  }
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const w = Math.min(1, rect.w * factor);
  const h = Math.min(1, rect.h * factor);
  return {
    type: 'rect',
    x: clamp(cx - w / 2, 0, 1 - w),
    y: clamp(cy - h / 2, 0, 1 - h),
    w,
    h,
  };
}

/** Clamp a rect so it lies inside the unit square; a zero-size rect stays zero. */
export function clampRect(rect: Rect): Rect {
  const x = clamp(rect.x, 0, 1);
  const y = clamp(rect.y, 0, 1);
  const right = clamp(rect.x + rect.w, x, 1);
  const bottom = clamp(rect.y + rect.h, y, 1);
  return { type: 'rect', x, y, w: right - x, h: bottom - y };
}

function squaredDistanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    const px = point.x - a.x;
    const py = point.y - a.y;
    return px * px + py * py;
  }
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  const px = point.x - (a.x + t * dx);
  const py = point.y - (a.y + t * dy);
  return px * px + py * py;
}

/**
 * Ramer–Douglas–Peucker simplification for an open polyline. Endpoints are
 * always kept. Epsilon is in the same units as the points.
 */
export function simplifyPolyline(points: readonly Point[], epsilon: number): Point[] {
  if (!Number.isFinite(epsilon) || epsilon < 0) {
    throw new RangeError(`simplifyPolyline: epsilon must be >= 0, got ${epsilon}`);
  }
  if (points.length <= 2) return points.map((point) => ({ ...point }));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const epsilonSquared = epsilon * epsilon;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let farthestSquared = 0;
    for (let i = first + 1; i < last; i++) {
      const distance = squaredDistanceToSegment(points[i]!, points[first]!, points[last]!);
      if (distance > farthestSquared) {
        farthestSquared = distance;
        farthest = i;
      }
    }
    if (farthest !== -1 && farthestSquared > epsilonSquared) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push({ ...points[i]! });
  }
  return result;
}

/**
 * Simplify a closed ring. The duplicate closing point is tolerated and the
 * closing edge is considered when choosing the split line.
 */
export function simplifyPolygon(points: readonly Point[], epsilon: number): Point[] {
  if (points.length <= 3) return points.map((point) => ({ ...point }));
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const closed = first.x === last.x && first.y === last.y;
  const ring = closed ? points.slice(0, -1) : points.slice();
  if (ring.length <= 3) return ring.map((point) => ({ ...point }));
  let farthest = 0;
  let farthestSquared = -1;
  for (let i = 1; i < ring.length; i++) {
    const dx = ring[i]!.x - ring[0]!.x;
    const dy = ring[i]!.y - ring[0]!.y;
    const distance = dx * dx + dy * dy;
    if (distance > farthestSquared) {
      farthestSquared = distance;
      farthest = i;
    }
  }
  const a = simplifyPolyline(ring.slice(0, farthest + 1), epsilon);
  const b = simplifyPolyline([...ring.slice(farthest), ring[0]!], epsilon);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
