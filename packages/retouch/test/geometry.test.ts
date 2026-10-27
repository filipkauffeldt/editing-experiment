import type { Point, Rect } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  clampRect,
  expandRect,
  pointInPolygon,
  polygonBounds,
  rectToPolygon,
  rectToPixels,
  pixelRectToNormalized,
  shapesBounds,
  simplifyPolygon,
  simplifyPolyline,
} from '../src/index';

const rect = (x: number, y: number, w: number, h: number): Rect => ({ type: 'rect', x, y, w, h });

function expectRect(actual: Rect | undefined, expected: Rect): void {
  expect(actual?.type).toBe('rect');
  if (!actual || actual.type !== 'rect') return;
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
  expect(actual.w).toBeCloseTo(expected.w, 10);
  expect(actual.h).toBeCloseTo(expected.h, 10);
}

describe('pointInPolygon', () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];

  it('accepts points inside and rejects points outside', () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 1.5, y: 0.5 }, square)).toBe(false);
    expect(pointInPolygon({ x: 0.5, y: -0.1 }, square)).toBe(false);
  });

  it('handles concave polygons', () => {
    const notch: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0.75, y: 1 },
      { x: 0.75, y: 0.25 },
      { x: 0.25, y: 0.25 },
      { x: 0.25, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, notch)).toBe(false);
    expect(pointInPolygon({ x: 0.1, y: 0.5 }, notch)).toBe(true);
    expect(pointInPolygon({ x: 0.9, y: 0.5 }, notch)).toBe(true);
  });
});

describe('coordinate mapping', () => {
  it('maps normalised rects to pixels and back', () => {
    const input = rect(0.5, 0.25, 0.25, 0.5);
    const pixels = rectToPixels(input, { width: 800, height: 400 });
    expect(pixels).toEqual({ x: 400, y: 100, w: 200, h: 200 });
    expect(pixelRectToNormalized(pixels, { width: 800, height: 400 })).toEqual(input);
  });

  it('converts a rect to a clockwise polygon', () => {
    const polygon = rectToPolygon(rect(0.1, 0.2, 0.3, 0.4));
    expect(polygon.type).toBe('polygon');
    const expected = [
      { x: 0.1, y: 0.2 },
      { x: 0.4, y: 0.2 },
      { x: 0.4, y: 0.6 },
      { x: 0.1, y: 0.6 },
    ];
    expect(polygon.points).toHaveLength(expected.length);
    expected.forEach((point, index) => {
      expect(polygon.points[index]!.x).toBeCloseTo(point.x, 10);
      expect(polygon.points[index]!.y).toBeCloseTo(point.y, 10);
    });
  });
});

describe('rect helpers', () => {
  it('expands around the centre and clamps at the image edge', () => {
    expectRect(expandRect(rect(0.4, 0.4, 0.2, 0.2), 1.5), rect(0.35, 0.35, 0.3, 0.3));
    expectRect(expandRect(rect(0, 0, 0.2, 0.2), 2), rect(0, 0, 0.4, 0.4));
    expectRect(expandRect(rect(0.9, 0.9, 0.1, 0.1), 2), rect(0.8, 0.8, 0.2, 0.2));
  });

  it('clamps rectangles into the unit square', () => {
    expectRect(clampRect(rect(-0.1, -0.2, 0.5, 0.5)), rect(0, 0, 0.4, 0.3));
    expectRect(clampRect(rect(0.8, 0.8, 0.5, 0.5)), rect(0.8, 0.8, 0.2, 0.2));
  });

  it('unions shape bounds', () => {
    const polygon = {
      type: 'polygon' as const,
      points: [
        { x: 0.5, y: 0.5 },
        { x: 0.7, y: 0.5 },
        { x: 0.7, y: 0.8 },
      ],
    };
    expectRect(shapesBounds([rect(0.1, 0.2, 0.2, 0.2), polygon]), rect(0.1, 0.2, 0.6, 0.6));
    expect(shapesBounds([])).toBeUndefined();
    expectRect(polygonBounds(polygon.points), rect(0.5, 0.5, 0.2, 0.3));
  });
});

describe('polyline simplification', () => {
  it('removes collinear points but keeps corners', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 0.25, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 1 },
    ];
    expect(simplifyPolyline(line, 0.001)).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0.5, y: 1 },
    ]);
  });

  it('keeps the endpoints and respects the epsilon', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.01 },
      { x: 1, y: 0 },
    ];
    expect(simplifyPolyline(points, 0.001)).toHaveLength(3);
    expect(simplifyPolyline(points, 0.1)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
  });

  it('simplifies a closed ring without dropping the closure', () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 0.5 },
      { x: 1, y: 1 },
      { x: 0.5, y: 1 },
      { x: 0, y: 1 },
      { x: 0, y: 0.5 },
    ];
    const simplified = simplifyPolygon(ring, 0.01);
    expect(simplified).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
  });
});
