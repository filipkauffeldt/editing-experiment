import type { Point } from '@ee/contracts';
import type { Size } from './crop-view';

/**
 * Zoom and pan of the main photo view, as pure maths (no DOM, no GL).
 *
 * A *layout* says where the picture sits in the viewport: `css = offset + scale * image`, with
 * `image` in pixels of the picture being shown (the full-resolution crop output, or the whole
 * oriented image in crop and retouch modes). The Fit layout is computed by the caller (it
 * depends on the mode's margins); a {@link ZoomView} moves away from it.
 */

/** Where a picture sits in the viewport: `css = offset + scale * image`. */
export interface ViewLayout {
  /** CSS pixels per picture pixel. */
  scale: number;
  /** CSS position of the picture's top-left corner. */
  offset: Point;
}

/**
 * The view state. `scale: null` is Fit (the caller's layout, whatever the window size); a number
 * is an absolute zoom in CSS pixels per picture pixel. `pan` is how far the picture's centre
 * has moved from where Fit puts it, in CSS pixels.
 */
export interface ZoomView {
  scale: number | null;
  pan: Point;
}

export const FIT_VIEW: ZoomView = { scale: null, pan: { x: 0, y: 0 } };

/** The levels in the footer, in device pixels per picture pixel (1 = 100%, one-to-one). */
export const ZOOM_LEVELS: readonly number[] = [0.5, 1, 2];
export const DEFAULT_ZOOM_LEVEL = 1;
/** The most the view zooms in, in device pixels per picture pixel. */
export const MAX_ZOOM = 8;
/** One Ctrl/Cmd + or - step. */
export const ZOOM_STEP = 1.25;
/** How much empty room panning may show past the picture's edge, in CSS pixels. */
export const PAN_MARGIN = 64;

export const isFit = (view: ZoomView): boolean => view.scale === null;

/** The layout the view gives: Fit is `base` itself; otherwise the picture is scaled about its centre and panned. */
export function viewLayout(view: ZoomView, base: ViewLayout, image: Size): ViewLayout {
  if (view.scale === null) return base;
  const centre = fitCentre(base, image);
  return {
    scale: view.scale,
    offset: {
      x: centre.x + view.pan.x - (image.width * view.scale) / 2,
      y: centre.y + view.pan.y - (image.height * view.scale) / 2,
    },
  };
}

/** Where Fit puts the picture's centre. */
export function fitCentre(base: ViewLayout, image: Size): Point {
  return {
    x: base.offset.x + (image.width * base.scale) / 2,
    y: base.offset.y + (image.height * base.scale) / 2,
  };
}

/** Picture pixels to CSS pixels in the viewport. */
export const imageToScreen = (layout: ViewLayout, point: Point): Point => ({
  x: layout.offset.x + point.x * layout.scale,
  y: layout.offset.y + point.y * layout.scale,
});

/** CSS pixels in the viewport to picture pixels. */
export const screenToImage = (layout: ViewLayout, point: Point): Point => ({
  x: (point.x - layout.offset.x) / layout.scale,
  y: (point.y - layout.offset.y) / layout.scale,
});

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/**
 * Keeps the picture from being dragged out of view. A picture smaller than the viewport on an
 * axis stays where Fit puts it; a larger one can be panned until its edge is `PAN_MARGIN` inside
 * the viewport, so there is always something left to grab.
 */
export function clampPan(
  pan: Point,
  scale: number,
  base: ViewLayout,
  image: Size,
  viewport: Size,
): Point {
  const centre = fitCentre(base, image);
  const axis = (value: number, centreAt: number, extent: number, room: number): number => {
    if (extent <= room) return 0;
    const half = extent / 2;
    const at = clamp(centreAt + value, room - half - PAN_MARGIN, half + PAN_MARGIN);
    return at - centreAt;
  };
  return {
    x: axis(pan.x, centre.x, image.width * scale, viewport.width),
    y: axis(pan.y, centre.y, image.height * scale, viewport.height),
  };
}

export interface ZoomContext {
  base: ViewLayout;
  image: Size;
  viewport: Size;
  /** Device pixels per CSS pixel, which turns {@link MAX_ZOOM} into CSS pixels. */
  dpr: number;
}

/** The smallest and largest scale the view allows, in CSS pixels per picture pixel. */
export const scaleLimits = (context: ZoomContext): { min: number; max: number } => ({
  min: context.base.scale,
  max: Math.max(context.base.scale, MAX_ZOOM / Math.max(0.01, context.dpr)),
});

/** A zoom level (device pixels per picture pixel) in CSS pixels per picture pixel. */
export const levelScale = (level: number, dpr: number): number => level / Math.max(0.01, dpr);

/** The zoom shown to the user, in percent of one-to-one device pixels. */
export const zoomPercent = (scale: number, dpr: number): number => scale * dpr * 100;

/**
 * Zooms to `scale`, keeping the picture point under `anchor` (CSS pixels in the viewport) where
 * it is. Below Fit (or within a hair of it) the result is Fit.
 */
export function zoomTo(
  view: ZoomView,
  context: ZoomContext,
  anchor: Point,
  scale: number,
): ZoomView {
  const { min, max } = scaleLimits(context);
  const next = clamp(scale, min, max);
  if (next <= min * 1.002) return FIT_VIEW;
  const current = viewLayout(view, context.base, context.image);
  const ratio = next / current.scale;
  const offset = {
    x: anchor.x - (anchor.x - current.offset.x) * ratio,
    y: anchor.y - (anchor.y - current.offset.y) * ratio,
  };
  const centre = fitCentre(context.base, context.image);
  const pan = {
    x: offset.x + (context.image.width * next) / 2 - centre.x,
    y: offset.y + (context.image.height * next) / 2 - centre.y,
  };
  return {
    scale: next,
    pan: clampPan(pan, next, context.base, context.image, context.viewport),
  };
}

/** Zooms by a factor (a step or a wheel tick) about `anchor`. */
export function zoomBy(
  view: ZoomView,
  context: ZoomContext,
  anchor: Point,
  factor: number,
): ZoomView {
  const current = viewLayout(view, context.base, context.image);
  return zoomTo(view, context, anchor, current.scale * factor);
}

/** Moves the picture by a screen-space delta, clamped. Fit does not pan. */
export function panBy(view: ZoomView, context: ZoomContext, delta: Point): ZoomView {
  if (view.scale === null) return view;
  return {
    scale: view.scale,
    pan: clampPan(
      { x: view.pan.x + delta.x, y: view.pan.y + delta.y },
      view.scale,
      context.base,
      context.image,
      context.viewport,
    ),
  };
}

/** Re-applies the limits after the window or the picture changed size. */
export function reclamp(view: ZoomView, context: ZoomContext): ZoomView {
  if (view.scale === null) return view;
  return zoomTo(view, context, fitCentre(context.base, context.image), view.scale);
}

/** Whether the screen point is on the picture. */
export function overPicture(layout: ViewLayout, image: Size, point: Point): boolean {
  const local = screenToImage(layout, point);
  return local.x >= 0 && local.y >= 0 && local.x <= image.width && local.y <= image.height;
}

/**
 * The zoom factor of one wheel event. A mouse notch (|deltaY| around 100) is one {@link ZOOM_STEP};
 * a trackpad pinch, which Chromium sends as a stream of small Ctrl+wheel deltas, zooms smoothly.
 */
export function wheelZoomFactor(event: { deltaY: number; deltaMode: number }): number {
  // DOM_DELTA_LINE (a notch is three lines) and DOM_DELTA_PAGE, in the pixels of a mouse notch.
  const pixels =
    event.deltaMode === 1
      ? event.deltaY * 33
      : event.deltaMode === 2
        ? event.deltaY * 100
        : event.deltaY;
  const notch = Math.abs(pixels) >= 50;
  const clamped = clamp(pixels, -120, 120);
  return Math.exp(-clamped * (notch ? Math.log(ZOOM_STEP) / 100 : 0.01));
}

/** The stage-relative picture coordinate (0..1) of a screen point; used by the overlays. */
export function screenToUnit(layout: ViewLayout, image: Size, point: Point): Point {
  const local = screenToImage(layout, point);
  return { x: local.x / image.width, y: local.y / image.height };
}
