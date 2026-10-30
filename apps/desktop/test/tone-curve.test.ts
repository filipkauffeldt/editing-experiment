import type { EditParams, ToneCurvePoint } from '@ee/contracts';
import { buildParametricLut, createMonotoneSpline, sampleCurve } from '@ee/develop-gl';
import { describe, expect, it } from 'vitest';
import {
  addCurvePoint,
  clampCurveCoordinate,
  curveValueAt,
  isCurveEndpoint,
  moveCurvePoint,
  moveParametricSplit,
  parametricCurvePath,
  parametricRegionAt,
  parametricSplitValues,
  pointCurvePath,
  removeCurvePoint,
} from '../src/renderer/tone-curve';

const points: ToneCurvePoint[] = [
  [0, 0],
  [64, 70],
  [128, 140],
  [255, 255],
];

describe('tone curve points', () => {
  it('adds points sorted by input and inside 0..255', () => {
    expect(
      addCurvePoint(
        [
          [0, 0],
          [255, 255],
        ],
        300,
        -20,
      ),
    ).toEqual([
      [0, 0],
      [255, 0],
    ]);
    const added = addCurvePoint(
      [
        [0, 0],
        [255, 255],
      ],
      128,
      140,
    );
    expect(added).toEqual([
      [0, 0],
      [128, 140],
      [255, 255],
    ]);
    expect(clampCurveCoordinate(Number.NaN)).toBe(0);
  });

  it('moves a point without crossing its neighbours', () => {
    const right = moveCurvePoint(points, 1, 250, 80);
    expect(right[1]).toEqual([127, 80]);
    const left = moveCurvePoint(points, 2, -50, 300);
    expect(left[2]).toEqual([65, 255]);
    expect(left.map(([x]) => x)).toEqual([0, 64, 65, 255]);
    for (let index = 0; index < right.length; index++) {
      expect(right[index]?.[0]).toBeGreaterThanOrEqual(0);
      expect(right[index]?.[0]).toBeLessThanOrEqual(255);
      if (index > 0) expect(right[index]?.[0]).toBeGreaterThan(right[index - 1]?.[0] ?? 0);
    }
  });

  it('moves endpoints but never deletes them', () => {
    const moved = moveCurvePoint(points, 0, 20, 5);
    expect(moved[0]).toEqual([20, 5]);
    expect(removeCurvePoint(points, 0)).toEqual(points);
    expect(removeCurvePoint(points, points.length - 1)).toEqual(points);
    expect(removeCurvePoint(points, 1)).toEqual([
      [0, 0],
      [128, 140],
      [255, 255],
    ]);
    expect(isCurveEndpoint(points, 0)).toBe(true);
    expect(isCurveEndpoint(points, 1)).toBe(false);
  });
});

describe('drawn curve', () => {
  it('equals the engine spline at every sample', () => {
    const drawn = pointCurvePath(points, 256)
      .split(' ')
      .map((part) => part.replace(/^[ML]/, ''))
      .map(Number);
    const xs = drawn.filter((_, index) => index % 2 === 0);
    const ys = drawn.filter((_, index) => index % 2 === 1);
    const engine = sampleCurve(points, 256);
    expect(xs).toHaveLength(256);
    for (let index = 0; index < engine.length; index++) {
      expect(xs[index]).toBeCloseTo(index, 5);
      expect(255 - (ys[index] ?? 0)).toBeCloseTo((engine[index] ?? 0) * 255, 2);
    }
    const spline = createMonotoneSpline(points);
    for (const x of [0, 1, 17, 63, 64, 70, 127, 128, 200, 255]) {
      expect(curveValueAt(points, x)).toBeCloseTo(spline.evaluate(x), 6);
    }
  });

  it('draws the same parametric curve as the engine LUT', () => {
    const params: EditParams = {
      ParametricShadows: 30,
      ParametricDarks: -20,
      ParametricLights: 15,
      ParametricHighlights: -10,
      ParametricShadowSplit: 20,
      ParametricMidtoneSplit: 55,
      ParametricHighlightSplit: 80,
    };
    const lut = buildParametricLut(params, 256);
    const ys = parametricCurvePath(params, 256)
      .split(' ')
      .map((part) => part.replace(/^[ML]/, ''))
      .map(Number)
      .filter((_, index) => index % 2 === 1);
    for (let index = 0; index < 256; index++) {
      expect(255 - (ys[index] ?? 0)).toBeCloseTo((lut?.[index] ?? index / 255) * 255, 2);
    }
  });
});

describe('parametric splits', () => {
  it('keeps the three split points in order', () => {
    expect(parametricSplitValues({})).toEqual([25, 50, 75]);
    expect(moveParametricSplit([25, 50, 75], 0, 60)).toEqual([48, 50, 75]);
    expect(moveParametricSplit([25, 50, 75], 1, 0)).toEqual([25, 27, 75]);
    expect(moveParametricSplit([25, 50, 75], 2, 200)).toEqual([25, 50, 100]);
    expect(moveParametricSplit([25, 50, 75], 1, 60)).toEqual([25, 60, 75]);
  });

  it('places the region boundary at the split input', () => {
    expect(parametricRegionAt([25, 50, 75], 10)).toBe(0);
    expect(parametricRegionAt([25, 50, 75], 63)).toBe(0);
    expect(parametricRegionAt([25, 50, 75], 90)).toBe(1);
    expect(parametricRegionAt([25, 50, 75], 127)).toBe(1);
    expect(parametricRegionAt([25, 50, 75], 160)).toBe(2);
    expect(parametricRegionAt([25, 50, 75], 191)).toBe(2);
    expect(parametricRegionAt([25, 50, 75], 220)).toBe(3);
  });
});
