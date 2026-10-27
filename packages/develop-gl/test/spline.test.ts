import { describe, expect, it } from 'vitest';
import {
  createMonotoneSpline,
  isIdentityCurve,
  normalizeCurvePoints,
  sampleCurve,
} from '../src/spline';

describe('tone curve spline', () => {
  it('passes through its control points', () => {
    const points = [
      [0, 10],
      [64, 40],
      [128, 140],
      [200, 210],
      [255, 250],
    ] as const;
    const s = createMonotoneSpline(points);
    for (const [x, y] of points) expect(s.evaluate(x)).toBeCloseTo(y, 9);
  });

  it('is the identity for two end points on the diagonal and for no points', () => {
    expect(
      createMonotoneSpline([
        [0, 0],
        [255, 255],
      ]).evaluate(77),
    ).toBeCloseTo(77, 9);
    expect(createMonotoneSpline([]).evaluate(77)).toBe(77);
    expect(isIdentityCurve(undefined)).toBe(true);
    expect(isIdentityCurve([])).toBe(true);
    expect(
      isIdentityCurve([
        [0, 0],
        [255, 255],
      ]),
    ).toBe(true);
    expect(
      isIdentityCurve([
        [0, 0],
        [128, 140],
        [255, 255],
      ]),
    ).toBe(false);
  });

  it('is flat outside the first and last control point', () => {
    const s = createMonotoneSpline([
      [20, 50],
      [200, 220],
    ]);
    expect(s.evaluate(0)).toBe(50);
    expect(s.evaluate(255)).toBe(220);
  });

  it('never overshoots a sharp knee (monotone input gives monotone output within the data range)', () => {
    const s = createMonotoneSpline([
      [0, 0],
      [100, 5],
      [110, 240],
      [255, 255],
    ]);
    let last = -Infinity;
    for (let x = 0; x <= 255; x += 0.25) {
      const y = s.evaluate(x);
      expect(y).toBeGreaterThanOrEqual(last - 1e-9);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(255);
      last = y;
    }
  });

  it('keeps a plateau flat', () => {
    const s = createMonotoneSpline([
      [0, 0],
      [80, 100],
      [160, 100],
      [255, 255],
    ]);
    expect(s.evaluate(120)).toBeCloseTo(100, 9);
  });

  it('sorts, clamps and de-duplicates points', () => {
    expect(
      normalizeCurvePoints([
        [300, 300],
        [0, -4],
        [128, 100],
        [128, 120],
        [Number.NaN, 5],
      ]),
    ).toEqual([
      [0, 0],
      [128, 120],
      [255, 255],
    ]);
  });

  it('samples into a 0..1 table', () => {
    const table = sampleCurve(
      [
        [0, 255],
        [255, 0],
      ],
      5,
    );
    expect(Array.from(table)).toEqual([1, 0.75, 0.5, 0.25, 0].map((v) => Math.fround(v)));
  });
});
