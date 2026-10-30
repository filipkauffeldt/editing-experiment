import { describe, expect, it } from 'vitest';
import { outputSizeForResize, resizeMaxEdge } from '../src/output-size';

describe('outputSizeForResize', () => {
  it('leaves the pixels alone for none', () => {
    expect(outputSizeForResize(6000, 4000, { mode: 'none' })).toEqual({
      width: 6000,
      height: 4000,
    });
  });

  it('fits the long edge, both orientations, and never upscales', () => {
    expect(outputSizeForResize(6000, 4000, { mode: 'longEdge', pixels: 1600 })).toEqual({
      width: 1600,
      height: 1067,
    });
    expect(outputSizeForResize(4000, 6000, { mode: 'longEdge', pixels: 1600 })).toEqual({
      width: 1067,
      height: 1600,
    });
    expect(outputSizeForResize(1200, 800, { mode: 'longEdge', pixels: 1600 })).toEqual({
      width: 1200,
      height: 800,
    });
  });

  it('fits the short edge', () => {
    expect(outputSizeForResize(6000, 4000, { mode: 'shortEdge', pixels: 1000 })).toEqual({
      width: 1500,
      height: 1000,
    });
    expect(outputSizeForResize(4000, 6000, { mode: 'shortEdge', pixels: 1000 })).toEqual({
      width: 1000,
      height: 1500,
    });
    expect(outputSizeForResize(800, 600, { mode: 'shortEdge', pixels: 1000 })).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('fits a megapixel budget', () => {
    expect(outputSizeForResize(6000, 4000, { mode: 'megapixels', megapixels: 2 })).toEqual({
      width: 1732,
      height: 1155,
    });
    expect(outputSizeForResize(1000, 800, { mode: 'megapixels', megapixels: 2 })).toEqual({
      width: 1000,
      height: 800,
    });
  });
});

describe('resizeMaxEdge', () => {
  it('is undefined when the image is already the output size', () => {
    expect(resizeMaxEdge(1600, 1067, { mode: 'longEdge', pixels: 1600 })).toBeUndefined();
    expect(resizeMaxEdge(1500, 1000, { mode: 'shortEdge', pixels: 1000 })).toBeUndefined();
    expect(resizeMaxEdge(1732, 1155, { mode: 'megapixels', megapixels: 2 })).toBeUndefined();
  });

  it('is the output long edge when a resize is needed', () => {
    expect(resizeMaxEdge(6000, 4000, { mode: 'longEdge', pixels: 1600 })).toBe(1600);
    expect(resizeMaxEdge(6000, 4000, { mode: 'shortEdge', pixels: 1000 })).toBe(1500);
    expect(resizeMaxEdge(6000, 4000, { mode: 'megapixels', megapixels: 2 })).toBe(1732);
  });
});
