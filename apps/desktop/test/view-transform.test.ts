import { describe, expect, it } from 'vitest';
import {
  FIT_VIEW,
  MAX_ZOOM,
  PAN_MARGIN,
  ZOOM_STEP,
  clampPan,
  fitCentre,
  imageToScreen,
  levelScale,
  overPicture,
  panBy,
  reclamp,
  screenToImage,
  screenToUnit,
  viewLayout,
  wheelZoomFactor,
  zoomBy,
  zoomPercent,
  zoomTo,
  type ViewLayout,
  type ZoomContext,
} from '../src/renderer/view-transform';

// A 4000 x 3000 picture fitted into a 1000 x 600 viewport: 800 x 600 on screen, centred.
const image = { width: 4000, height: 3000 };
const viewport = { width: 1000, height: 600 };
const base: ViewLayout = { scale: 0.2, offset: { x: 100, y: 0 } };
const context: ZoomContext = { base, image, viewport, dpr: 1 };

const pictureUnder = (view: Parameters<typeof viewLayout>[0], point: { x: number; y: number }) =>
  screenToImage(viewLayout(view, base, image), point);

describe('layout and mapping', () => {
  it('is the fit layout at Fit', () => {
    expect(viewLayout(FIT_VIEW, base, image)).toBe(base);
    expect(fitCentre(base, image)).toEqual({ x: 500, y: 300 });
  });

  it('maps picture pixels to the screen and back', () => {
    const layout: ViewLayout = { scale: 0.5, offset: { x: -120, y: 40 } };
    const screen = imageToScreen(layout, { x: 1000, y: 2000 });
    expect(screen).toEqual({ x: 380, y: 1040 });
    expect(screenToImage(layout, screen)).toEqual({ x: 1000, y: 2000 });
  });

  it('gives the unit coordinate of a screen point on the picture', () => {
    expect(screenToUnit(base, image, { x: 500, y: 300 })).toEqual({ x: 0.5, y: 0.5 });
    expect(screenToUnit(base, image, { x: 100, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('knows when a point is over the picture', () => {
    expect(overPicture(base, image, { x: 500, y: 300 })).toBe(true);
    expect(overPicture(base, image, { x: 50, y: 300 })).toBe(false);
  });
});

describe('zooming about a point', () => {
  it('keeps the picture point under the anchor where it is, from Fit', () => {
    const anchor = { x: 300, y: 150 };
    const before = pictureUnder(FIT_VIEW, anchor);
    const zoomed = zoomTo(FIT_VIEW, context, anchor, 1);
    expect(zoomed.scale).toBe(1);
    const after = pictureUnder(zoomed, anchor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('keeps it fixed again when zooming further in and back out', () => {
    const first = zoomTo(FIT_VIEW, context, { x: 640, y: 420 }, 0.5);
    const anchor = { x: 200, y: 100 };
    for (const scale of [0.8, 2]) {
      const next = zoomTo(first, context, anchor, scale);
      expect(next.scale).toBe(scale);
      expect(pictureUnder(next, anchor).x).toBeCloseTo(pictureUnder(first, anchor).x, 6);
      expect(pictureUnder(next, anchor).y).toBeCloseTo(pictureUnder(first, anchor).y, 6);
    }
  });

  it('zooms about the centre of the picture when the anchor is its centre', () => {
    const zoomed = zoomTo(FIT_VIEW, context, fitCentre(base, image), 0.5);
    const layout = viewLayout(zoomed, base, image);
    expect(imageToScreen(layout, { x: 2000, y: 1500 })).toEqual({ x: 500, y: 300 });
  });

  it('never goes below Fit and returns Fit there', () => {
    expect(zoomTo(FIT_VIEW, context, { x: 500, y: 300 }, 0.05)).toEqual(FIT_VIEW);
    const zoomed = zoomTo(FIT_VIEW, context, { x: 500, y: 300 }, 1);
    expect(zoomBy(zoomed, context, { x: 500, y: 300 }, 0.1)).toEqual(FIT_VIEW);
  });

  it('stops at the largest zoom, in device pixels', () => {
    const zoomed = zoomTo(FIT_VIEW, { ...context, dpr: 2 }, { x: 500, y: 300 }, 100);
    expect(zoomed.scale).toBe(MAX_ZOOM / 2);
  });

  it('steps by a fixed factor', () => {
    const one = zoomTo(FIT_VIEW, context, { x: 500, y: 300 }, 1);
    const stepped = zoomBy(one, context, { x: 500, y: 300 }, ZOOM_STEP);
    expect(stepped.scale).toBeCloseTo(1.25, 9);
  });

  it('converts a level to CSS pixels by the device pixel ratio', () => {
    expect(levelScale(1, 1)).toBe(1);
    expect(levelScale(1, 2)).toBe(0.5);
    expect(zoomPercent(0.5, 2)).toBe(100);
  });
});

describe('clamping the pan', () => {
  it('leaves a picture smaller than the viewport where Fit puts it', () => {
    // 800 x 600 on screen in a 1000 x 600 viewport: it cannot move on either axis.
    expect(clampPan({ x: 300, y: -200 }, 0.2, base, image, viewport)).toEqual({ x: 0, y: 0 });
  });

  it('stops a large picture with its edge a margin inside the viewport', () => {
    // 4000 x 3000 on screen at 100%.
    const far = clampPan({ x: 1e6, y: 1e6 }, 1, base, image, viewport);
    const layout = viewLayout({ scale: 1, pan: far }, base, image);
    // Top-left corner at the margin from the top-left of the viewport.
    expect(layout.offset.x).toBeCloseTo(PAN_MARGIN, 6);
    expect(layout.offset.y).toBeCloseTo(PAN_MARGIN, 6);
    const other = clampPan({ x: -1e6, y: -1e6 }, 1, base, image, viewport);
    const opposite = viewLayout({ scale: 1, pan: other }, base, image);
    expect(opposite.offset.x + 4000).toBeCloseTo(viewport.width - PAN_MARGIN, 6);
    expect(opposite.offset.y + 3000).toBeCloseTo(viewport.height - PAN_MARGIN, 6);
  });

  it('keeps part of the picture in view however far it is dragged', () => {
    for (const scale of [0.25, 1, 4]) {
      for (const pan of [
        { x: 9999, y: -9999 },
        { x: -9999, y: 9999 },
      ]) {
        const clamped = clampPan(pan, scale, base, image, viewport);
        const layout = viewLayout({ scale, pan: clamped }, base, image);
        const right = layout.offset.x + image.width * scale;
        const bottom = layout.offset.y + image.height * scale;
        expect(right).toBeGreaterThan(0);
        expect(bottom).toBeGreaterThan(0);
        expect(layout.offset.x).toBeLessThan(viewport.width);
        expect(layout.offset.y).toBeLessThan(viewport.height);
      }
    }
  });

  it('does not pan at Fit and pans by a delta when zoomed', () => {
    expect(panBy(FIT_VIEW, context, { x: 40, y: 40 })).toBe(FIT_VIEW);
    const zoomed = zoomTo(FIT_VIEW, context, { x: 500, y: 300 }, 1);
    const moved = panBy(zoomed, context, { x: 30, y: -10 });
    expect(moved.pan.x).toBeCloseTo(zoomed.pan.x + 30, 9);
    expect(moved.pan.y).toBeCloseTo(zoomed.pan.y - 10, 9);
  });

  it('falls back to Fit when the window grows past the zoom', () => {
    const zoomed = zoomTo(FIT_VIEW, context, { x: 500, y: 300 }, 0.3);
    const bigger: ZoomContext = {
      ...context,
      base: { scale: 0.4, offset: { x: 0, y: 0 } },
      viewport: { width: 1600, height: 1200 },
    };
    expect(reclamp(zoomed, bigger)).toEqual(FIT_VIEW);
  });
});

describe('wheel zoom factor', () => {
  it('is one step for a mouse notch, in and out', () => {
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0 })).toBeCloseTo(ZOOM_STEP, 6);
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0 })).toBeCloseTo(1 / ZOOM_STEP, 6);
  });

  it('zooms smoothly for the small deltas of a trackpad pinch', () => {
    const small = wheelZoomFactor({ deltaY: -4, deltaMode: 0 });
    expect(small).toBeGreaterThan(1);
    expect(small).toBeLessThan(1.06);
    expect(wheelZoomFactor({ deltaY: 4, deltaMode: 0 })).toBeCloseTo(1 / small, 9);
  });

  it('reads line-based wheels and caps one event', () => {
    expect(wheelZoomFactor({ deltaY: -3, deltaMode: 1 })).toBeCloseTo(ZOOM_STEP, 1);
    expect(wheelZoomFactor({ deltaY: -100000, deltaMode: 0 })).toBeLessThan(1.32);
  });
});
