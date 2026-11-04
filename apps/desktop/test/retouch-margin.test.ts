import { describe, expect, it } from 'vitest';
import {
  HIT_MARGIN,
  clampToPicture,
  isOnPicture,
  overlayFrame,
} from '../src/renderer/retouch-margin';

describe('clampToPicture', () => {
  it('keeps a point on the picture and pulls one off it to the nearest edge', () => {
    expect(clampToPicture({ x: 0.3, y: 0.7 })).toEqual({ x: 0.3, y: 0.7 });
    expect(clampToPicture({ x: -0.02, y: 0.5 })).toEqual({ x: 0, y: 0.5 });
    expect(clampToPicture({ x: 1.4, y: -3 })).toEqual({ x: 1, y: 0 });
  });
});

describe('isOnPicture', () => {
  it('counts the edge as on the picture', () => {
    expect(isOnPicture({ x: 0, y: 1 })).toBe(true);
    expect(isOnPicture({ x: 0.5, y: 0.5 })).toBe(true);
    expect(isOnPicture({ x: -0.001, y: 0.5 })).toBe(false);
    expect(isOnPicture({ x: 0.5, y: 1.001 })).toBe(false);
  });
});

describe('overlayFrame', () => {
  const viewBox = (text: string): number[] => text.split(' ').map(Number);

  it('adds the hit margin on every side of a picture that has room around it', () => {
    // A 400 x 300 picture at Fit in a 500 x 400 canvas area: the stage starts 50 px in.
    const frame = overlayFrame({ x: 0, y: 0, w: 400, h: 300 }, { x: -50, y: -50, w: 500, h: 400 });
    expect(frame.box).toEqual({ x: -HIT_MARGIN, y: -HIT_MARGIN, w: 448, h: 348 });
    const [x, y, w, h] = viewBox(frame.viewBox);
    expect(x).toBeCloseTo(-HIT_MARGIN / 400, 9);
    expect(y).toBeCloseTo(-HIT_MARGIN / 300, 9);
    expect(w).toBeCloseTo(448 / 400, 9);
    expect(h).toBeCloseTo(348 / 300, 9);
  });

  it('stops at the canvas area where the gap is smaller than the margin', () => {
    // 10 px of room to the left and right of the picture, 5 px above and below.
    const frame = overlayFrame({ x: 0, y: 0, w: 400, h: 300 }, { x: -10, y: -5, w: 420, h: 310 });
    expect(frame.box).toEqual({ x: -10, y: -5, w: 420, h: 310 });
  });

  it('has no margin on a side where the picture is bigger than the canvas', () => {
    // Zoomed: the stage is the canvas (0..800 x 0..600) and the picture spills over its left and bottom.
    const frame = overlayFrame(
      { x: -300, y: 100, w: 2000, h: 1500 },
      { x: 0, y: 0, w: 800, h: 600 },
    );
    expect(frame.box).toEqual({ x: 0, y: 76, w: 800, h: 524 });
    const [x, y, w, h] = viewBox(frame.viewBox);
    // The viewBox starts 300 px into the picture and shows 800 px of it.
    expect(x).toBeCloseTo(300 / 2000, 9);
    expect(w).toBeCloseTo(800 / 2000, 9);
    expect(y).toBeCloseTo(-24 / 1500, 9);
    expect(h).toBeCloseTo(524 / 1500, 9);
  });
});
