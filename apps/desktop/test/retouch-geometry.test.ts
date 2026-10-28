import { describe, expect, it } from 'vitest';
import { padFaceBox } from '../src/renderer/retouch-geometry';

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
