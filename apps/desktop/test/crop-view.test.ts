import { describe, expect, it } from 'vitest';
import {
  cropLayout,
  cursorFor,
  fitWithin,
  frameRect,
  guideSegments,
  hitTestFrame,
  screenToView,
  viewToScreen,
} from '../src/renderer/crop-view';

describe('crop layout', () => {
  it('fits the image into the stage minus a margin and centres it', () => {
    const layout = cropLayout({ width: 1000, height: 800 }, { width: 6000, height: 4000 });
    // 968 x 768 available: width limited, 3:2.
    expect(6000 * layout.scale).toBeCloseTo(968, 6);
    expect(layout.offset.x).toBeCloseTo(16, 6);
    expect(layout.offset.y).toBeCloseTo((800 - 968 / 1.5) / 2, 6);
  });

  it('fits a portrait image by its height', () => {
    const fit = fitWithin({ width: 1000, height: 800 }, 4000 / 6000);
    expect(fit.height).toBeCloseTo(768, 6);
    expect(fit.width).toBeCloseTo(512, 6);
  });

  it('round-trips between view and screen', () => {
    const layout = cropLayout({ width: 1200, height: 700 }, { width: 4000, height: 6000 });
    const back = screenToView(layout, viewToScreen(layout, { x: 1234, y: 4321 }));
    expect(back.x).toBeCloseTo(1234, 9);
    expect(back.y).toBeCloseTo(4321, 9);
  });

  it('places the frame around its centre', () => {
    const layout = { scale: 0.1, offset: { x: 10, y: 20 } };
    expect(frameRect(layout, { x: 1000, y: 500 }, 400, 200)).toEqual({
      left: 90,
      top: 60,
      right: 130,
      bottom: 80,
    });
  });
});

describe('hitTestFrame', () => {
  const rect = { left: 100, top: 100, right: 500, bottom: 400 };

  it('grabs the corners', () => {
    expect(hitTestFrame(rect, { x: 104, y: 97 })).toBe('nw');
    expect(hitTestFrame(rect, { x: 505, y: 97 })).toBe('ne');
    expect(hitTestFrame(rect, { x: 95, y: 410 })).toBe('sw');
    expect(hitTestFrame(rect, { x: 500, y: 400 })).toBe('se');
  });

  it('grabs an edge anywhere along it, not only at the middle', () => {
    expect(hitTestFrame(rect, { x: 180, y: 102 })).toBe('n');
    expect(hitTestFrame(rect, { x: 420, y: 396 })).toBe('s');
    expect(hitTestFrame(rect, { x: 97, y: 330 })).toBe('w');
    expect(hitTestFrame(rect, { x: 503, y: 150 })).toBe('e');
  });

  it('pans inside the frame and rotates anywhere outside it', () => {
    expect(hitTestFrame(rect, { x: 300, y: 250 })).toBe('move');
    expect(hitTestFrame(rect, { x: 120, y: 120 })).toBe('move');
    expect(hitTestFrame(rect, { x: 40, y: 250 })).toBe('rotate');
    expect(hitTestFrame(rect, { x: 300, y: 600 })).toBe('rotate');
    // Just outside the grab strip of a corner.
    expect(hitTestFrame(rect, { x: 80, y: 80 })).toBe('rotate');
  });

  it('keeps the inside reachable on a tiny frame', () => {
    const tiny = { left: 100, top: 100, right: 118, bottom: 112 };
    expect(hitTestFrame(tiny, { x: 109, y: 106 })).toBe('move');
  });
});

describe('guideSegments', () => {
  const rect = { left: 0, top: 0, right: 300, bottom: 150 };

  it('draws the rule of thirds', () => {
    const segments = guideSegments('thirds', rect, false);
    expect(segments).toHaveLength(4);
    const vertical = segments.filter((s) => s.x1 === s.x2).map((s) => s.x1);
    const horizontal = segments.filter((s) => s.y1 === s.y2).map((s) => s.y1);
    expect(vertical).toEqual([100, 200]);
    expect(horizontal).toEqual([50, 100]);
  });

  it('draws golden ratio lines at 0.382 and 0.618', () => {
    const xs = guideSegments('golden', rect, false)
      .filter((s) => s.x1 === s.x2)
      .map((s) => s.x1 / 300);
    expect(xs[0]).toBeCloseTo(0.382, 3);
    expect(xs[1]).toBeCloseTo(0.618, 3);
  });

  it('shows a finer grid while rotating, whatever the guide', () => {
    const thirds = guideSegments('thirds', rect, false).length;
    expect(guideSegments('thirds', rect, true).length).toBeGreaterThan(thirds);
    expect(guideSegments('golden', rect, true)).toEqual(guideSegments('grid', rect, false));
  });

  it('draws nothing for "none", even while rotating', () => {
    expect(guideSegments('none', rect, true)).toEqual([]);
  });

  it('keeps every line inside the frame', () => {
    for (const kind of ['thirds', 'grid', 'golden'] as const) {
      for (const segment of guideSegments(kind, rect, kind === 'grid')) {
        for (const x of [segment.x1, segment.x2]) expect(x).toBeGreaterThanOrEqual(0);
        for (const x of [segment.x1, segment.x2]) expect(x).toBeLessThanOrEqual(300);
        for (const y of [segment.y1, segment.y2]) expect(y).toBeGreaterThanOrEqual(0);
        for (const y of [segment.y1, segment.y2]) expect(y).toBeLessThanOrEqual(150);
      }
    }
  });
});

describe('cursorFor', () => {
  it('uses resize cursors for handles, a hand to pan and a rotate cursor outside', () => {
    expect(cursorFor('nw', false)).toBe('nwse-resize');
    expect(cursorFor('sw', false)).toBe('nesw-resize');
    expect(cursorFor('n', false)).toBe('ns-resize');
    expect(cursorFor('e', false)).toBe('ew-resize');
    expect(cursorFor('move', false)).toBe('grab');
    expect(cursorFor('move', true)).toBe('grabbing');
    expect(cursorFor('rotate', false)).toBe('rotate');
  });
});
