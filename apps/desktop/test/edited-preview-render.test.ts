import { describe, expect, it } from 'vitest';
import { editedPreviewSize } from '../src/renderer/edited-preview-render';

describe('editedPreviewSize', () => {
  const source = { width: 2560, height: 1707 };

  it('fits the long edge and keeps the aspect ratio', () => {
    expect(editedPreviewSize({}, source, 320)).toEqual({ width: 320, height: 213 });
  });

  it('never upscales a small source', () => {
    expect(editedPreviewSize({}, { width: 200, height: 100 }, 2560)).toEqual({
      width: 200,
      height: 100,
    });
  });

  it('takes the shape of the crop, so a 1:1 crop gives a square thumbnail', () => {
    const crop = { left: 0.25, top: 0, right: 0.75, bottom: 1, angle: 0 };
    // 1280 x 1707 of the source: a portrait crop.
    expect(editedPreviewSize({ crop }, source, 320)).toEqual({ width: 240, height: 320 });

    const square = { left: 0.2, top: 0, right: 0.2 + 1707 / 2560, bottom: 1, angle: 0 };
    const size = editedPreviewSize({ crop: square }, source, 320);
    expect(size.width).toBe(size.height);
  });

  it('is at most the edge for a straightened crop too', () => {
    const crop = { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, angle: 5 };
    const size = editedPreviewSize({ crop }, source, 2560);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2560);
    expect(size.width).toBeGreaterThan(0);
  });
});
