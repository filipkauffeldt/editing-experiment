import { describe, expect, it } from 'vitest';
import {
  applyWheelDrag,
  clampSaturation,
  hueSatFromPoint,
  normalizeHue,
  pointFromHueSat,
  wheelDragMode,
} from '../src/renderer/grading-wheel';

describe('colour wheel maths', () => {
  it('maps the four directions to hue and the radius to saturation', () => {
    expect(hueSatFromPoint(10, 0, 10)).toEqual({ hue: 0, sat: 100 });
    expect(hueSatFromPoint(0, -10, 10)).toEqual({ hue: 90, sat: 100 });
    expect(hueSatFromPoint(-10, 0, 10)).toEqual({ hue: 180, sat: 100 });
    expect(hueSatFromPoint(0, 10, 10)).toEqual({ hue: 270, sat: 100 });
    expect(hueSatFromPoint(5, 0, 10)).toEqual({ hue: 0, sat: 50 });
    expect(hueSatFromPoint(0, 0, 10)).toEqual({ hue: 0, sat: 0 });
    expect(hueSatFromPoint(20, 0, 10)).toEqual({ hue: 0, sat: 100 });
  });

  it('wraps hue around 0 and 360', () => {
    expect(hueSatFromPoint(10, 0.1, 10).hue).toBe(359);
    expect(hueSatFromPoint(10, -0.1, 10).hue).toBe(1);
    expect(normalizeHue(360)).toBe(0);
    expect(normalizeHue(-1)).toBe(359);
    expect(normalizeHue(359.6)).toBe(0);
    expect(pointFromHueSat(360, 50, 10).x).toBeCloseTo(pointFromHueSat(0, 50, 10).x, 6);
    expect(pointFromHueSat(360, 50, 10).y).toBeCloseTo(pointFromHueSat(0, 50, 10).y, 6);
    // 359 is one degree below the positive x axis, not the same point.
    expect(pointFromHueSat(359, 50, 10).y).toBeGreaterThan(0);
  });

  it('round-trips hue and saturation through the puck position', () => {
    const centre = pointFromHueSat(45, 0, 20);
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.y).toBeCloseTo(0, 6);
    for (const hue of [0, 45, 90, 179, 245, 300, 359]) {
      for (const sat of [25, 100]) {
        const point = pointFromHueSat(hue, sat, 20);
        const back = hueSatFromPoint(point.x, point.y, 20);
        expect(back.hue).toBe(hue);
        expect(back.sat).toBe(sat);
      }
    }
    expect(clampSaturation(-5)).toBe(0);
    expect(clampSaturation(120)).toBe(100);
  });

  it('reads Shift as saturation only and Ctrl/Cmd as hue only', () => {
    expect(wheelDragMode({ shiftKey: true })).toBe('sat');
    expect(wheelDragMode({ ctrlKey: true })).toBe('hue');
    expect(wheelDragMode({ metaKey: true })).toBe('hue');
    expect(wheelDragMode({})).toBe('both');
    // AltGr is Ctrl+Alt on Windows and Linux, so it must not become a hue drag.
    expect(wheelDragMode({ ctrlKey: true, altKey: true })).toBe('both');
    expect(wheelDragMode({ altGraph: true, ctrlKey: true })).toBe('both');
  });

  it('keeps the frozen coordinate exactly during a modified drag', () => {
    const start = { hue: 215, sat: 30 };
    const saturation = applyWheelDrag(start, 10, 0, 20, 'sat');
    expect(saturation.hue).toBe(215);
    expect(saturation.sat).toBe(50);

    const hue = applyWheelDrag(start, 0, -20, 20, 'hue');
    expect(hue.hue).toBe(90);
    expect(hue.sat).toBe(30);
  });
});
