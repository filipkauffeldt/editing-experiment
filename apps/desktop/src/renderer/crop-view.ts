import type { Point } from '@ee/contracts';
import type { CropHandle } from '@ee/develop-gl';
import type { CropOverlayKind } from './store';

/**
 * Screen-side geometry of crop mode. The store works in "view" coordinates
 * (source-pixel units, see `cropImageToView`); the canvas draws them at
 * `offset + scale * view` CSS pixels. Everything here is pure so it can be
 * tested without a DOM.
 */

export interface Size {
  width: number;
  height: number;
}

/** Margin around the fitted image, in CSS pixels. */
const FIT_MARGIN = 32;

/** The largest `aspect` rectangle that fits in the container minus a margin. */
export function fitWithin(container: Size, aspect: number): Size {
  const availableWidth = Math.max(50, container.width - FIT_MARGIN);
  const availableHeight = Math.max(50, container.height - FIT_MARGIN);
  if (availableWidth / availableHeight > aspect) {
    const height = availableHeight;
    return { width: height * aspect, height };
  }
  const width = availableWidth;
  return { width, height: width / aspect };
}

/** How view coordinates sit in the crop-mode stage: `css = offset + scale * view`. */
export interface CropLayout {
  scale: number;
  offset: Point;
}

/** The unrotated image centred in the stage, as large as the margin allows. */
export function cropLayout(stage: Size, image: Size): CropLayout {
  const fit = fitWithin(stage, image.width / image.height);
  return {
    scale: fit.width / image.width,
    offset: { x: (stage.width - fit.width) / 2, y: (stage.height - fit.height) / 2 },
  };
}

export function viewToScreen(layout: CropLayout, point: Point): Point {
  return {
    x: layout.offset.x + point.x * layout.scale,
    y: layout.offset.y + point.y * layout.scale,
  };
}

export function screenToView(layout: CropLayout, point: Point): Point {
  return {
    x: (point.x - layout.offset.x) / layout.scale,
    y: (point.y - layout.offset.y) / layout.scale,
  };
}

/** A rectangle in CSS pixels. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The axis-aligned crop frame on screen, from its view centre and size in source pixels. */
export function frameRect(
  layout: CropLayout,
  pivot: Point,
  width: number,
  height: number,
): ScreenRect {
  const center = viewToScreen(layout, pivot);
  const halfWidth = (width * layout.scale) / 2;
  const halfHeight = (height * layout.scale) / 2;
  return {
    left: center.x - halfWidth,
    top: center.y - halfHeight,
    right: center.x + halfWidth,
    bottom: center.y + halfHeight,
  };
}

/** What a pointer press at a position would do. */
export type FrameHit = CropHandle | 'move' | 'rotate';

export interface HitTolerance {
  /** Half-size of the square grab area around each corner, in CSS pixels. */
  corner: number;
  /** Half-width of the grab strip along each edge. */
  edge: number;
}

export const DEFAULT_HIT_TOLERANCE: HitTolerance = { corner: 12, edge: 7 };

/**
 * Lightroom's pointer zones: corners and edges resize, inside pans the image,
 * anywhere outside rotates. The grab areas shrink on tiny frames so the
 * inside stays reachable.
 */
export function hitTestFrame(
  rect: ScreenRect,
  point: Point,
  tolerance: HitTolerance = DEFAULT_HIT_TOLERANCE,
): FrameHit {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const smallest = Math.min(width, height);
  const corner = Math.min(tolerance.corner, smallest / 3);
  const edge = Math.min(tolerance.edge, smallest / 4);

  const nearLeft = Math.abs(point.x - rect.left) <= corner;
  const nearRight = Math.abs(point.x - rect.right) <= corner;
  const nearTop = Math.abs(point.y - rect.top) <= corner;
  const nearBottom = Math.abs(point.y - rect.bottom) <= corner;
  if (nearTop && nearLeft) return 'nw';
  if (nearTop && nearRight) return 'ne';
  if (nearBottom && nearLeft) return 'sw';
  if (nearBottom && nearRight) return 'se';

  const withinX = point.x >= rect.left - edge && point.x <= rect.right + edge;
  const withinY = point.y >= rect.top - edge && point.y <= rect.bottom + edge;
  if (withinX && Math.abs(point.y - rect.top) <= edge) return 'n';
  if (withinX && Math.abs(point.y - rect.bottom) <= edge) return 's';
  if (withinY && Math.abs(point.x - rect.left) <= edge) return 'w';
  if (withinY && Math.abs(point.x - rect.right) <= edge) return 'e';

  const inside =
    point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom;
  return inside ? 'move' : 'rotate';
}

/** A line segment in CSS pixels. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;
/** Spacing of the fine grid shown while rotating, in CSS pixels at most. */
const FINE_GRID_TARGET = 36;

function lines(rect: ScreenRect, xs: number[], ys: number[]): Segment[] {
  return [
    ...xs.map((x) => ({ x1: x, y1: rect.top, x2: x, y2: rect.bottom })),
    ...ys.map((y) => ({ x1: rect.left, y1: y, x2: rect.right, y2: y })),
  ];
}

/**
 * The composition guide inside the frame. While rotating, any guide but "none"
 * turns into a fine grid, like Lightroom's, so the horizon can be judged against it.
 */
export function guideSegments(
  kind: CropOverlayKind,
  rect: ScreenRect,
  rotating: boolean,
): Segment[] {
  if (kind === 'none') return [];
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0) return [];
  if (rotating || kind === 'grid') {
    const columns = Math.max(3, Math.round(width / FINE_GRID_TARGET));
    const rows = Math.max(3, Math.round(height / FINE_GRID_TARGET));
    const xs = Array.from(
      { length: columns - 1 },
      (_, i) => rect.left + (width * (i + 1)) / columns,
    );
    const ys = Array.from({ length: rows - 1 }, (_, i) => rect.top + (height * (i + 1)) / rows);
    return lines(rect, xs, ys);
  }
  if (kind === 'golden') {
    const near = 1 / (GOLDEN_RATIO * GOLDEN_RATIO);
    const far = 1 / GOLDEN_RATIO;
    return lines(
      rect,
      [rect.left + width * near, rect.left + width * far],
      [rect.top + height * near, rect.top + height * far],
    );
  }
  return lines(
    rect,
    [rect.left + width / 3, rect.left + (width * 2) / 3],
    [rect.top + height / 3, rect.top + (height * 2) / 3],
  );
}

/** CSS cursor for a hit, or the pointer tool. */
export function cursorFor(hit: FrameHit, dragging: boolean): string {
  switch (hit) {
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'move':
      return dragging ? 'grabbing' : 'grab';
    case 'rotate':
      return 'rotate';
  }
}
