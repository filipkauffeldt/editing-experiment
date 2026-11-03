import { describe, expect, it } from 'vitest';
import { polygonBounds } from '@ee/retouch';
import { facesInLasso, padFaceBox } from '../src/renderer/retouch-geometry';

describe('padFaceBox', () => {
  it('adds more padding above the face than below', () => {
    const padded = padFaceBox({ type: 'rect', x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 0.25);
    expect(padded.x).toBeCloseTo(0.35);
    expect(padded.w).toBeCloseTo(0.3);
    // 25% of the width horizontally, 35% of the height vertically, 65% of that above.
    expect(padded.y).toBeCloseTo(0.3545, 4);
    expect(padded.h).toBeCloseTo(0.27);
    expect(0.4 - padded.y).toBeGreaterThan(padded.y + padded.h - 0.6);
  });

  it('clamps to the image and handles zero padding', () => {
    const box = { type: 'rect' as const, x: 0.9, y: 0.05, w: 0.2, h: 0.1 };
    const unchanged = padFaceBox(box, 0);
    expect(unchanged.x).toBeCloseTo(0.9);
    expect(unchanged.y).toBeCloseTo(0.05);
    expect(unchanged.w).toBeCloseTo(0.1);
    expect(unchanged.h).toBeCloseTo(0.1);
    const clamped = padFaceBox(box, 0.5);
    expect(clamped.x).toBeGreaterThanOrEqual(0);
    expect(clamped.x + clamped.w).toBeLessThanOrEqual(1);
    expect(clamped.y).toBeGreaterThanOrEqual(0);
    expect(clamped.y + clamped.h).toBeLessThanOrEqual(1);
  });
});

describe('facesInLasso', () => {
  const face = (x: number, y: number, size = 0.1) => ({
    box: { type: 'rect' as const, x, y, w: size, h: size },
  });
  // An L-shaped outline: the bounding box is (0.1, 0.1)-(0.7, 0.7) but the top right is outside.
  const lShape = [
    { x: 0.1, y: 0.1 },
    { x: 0.4, y: 0.1 },
    { x: 0.4, y: 0.4 },
    { x: 0.7, y: 0.4 },
    { x: 0.7, y: 0.7 },
    { x: 0.1, y: 0.7 },
  ];

  it('keeps the faces centred inside the outline and drops the others in its bounding box', () => {
    const inTop = face(0.15, 0.15);
    const inBottomRight = face(0.55, 0.55);
    const inBoundsOutside = face(0.5, 0.15);
    const outsideBounds = face(0.8, 0.8);
    const bounds = polygonBounds(lShape);
    for (const candidate of [inTop, inBottomRight, inBoundsOutside]) {
      expect(candidate.box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(candidate.box.x + candidate.box.w).toBeLessThanOrEqual(bounds.x + bounds.w);
    }

    const kept = facesInLasso(
      [inTop, inBottomRight, inBoundsOutside, outsideBounds],
      lShape,
      undefined,
    );

    expect(kept).toEqual([inTop, inBottomRight]);
  });

  it('decides by the box centre, not by overlap', () => {
    const triangle = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.2, y: 0.8 },
    ];
    // The box straddles the hypotenuse; its centre (0.55, 0.55) is outside, (0.4, 0.4) is inside.
    const centreOutside = face(0.5, 0.5, 0.1);
    const centreInside = face(0.35, 0.35, 0.1);
    expect(facesInLasso([centreOutside, centreInside], triangle, undefined)).toEqual([
      centreInside,
    ]);
  });

  it('returns nothing for a degenerate outline', () => {
    expect(
      facesInLasso(
        [face(0.4, 0.4)],
        [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.9 },
        ],
        undefined,
      ),
    ).toEqual([]);
  });
});
