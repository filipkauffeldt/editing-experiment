import type { CropParams, MosaicOp } from '@ee/contracts';
import { cropFromGeometry } from '@ee/develop-gl';
import { describe, expect, it } from 'vitest';
import {
  WHOLE_IMAGE,
  linearEdgeFor,
  mosaicZoomedView,
  pictureSize,
  pictureViewTransform,
} from '../src/renderer/zoom-render';

const image = { width: 6000, height: 4000 };

describe('pictureSize', () => {
  it('is the whole image without a crop, and the crop output with one', () => {
    expect(pictureSize(undefined, image)).toEqual(image);
    const crop: CropParams = { left: 0.25, top: 0, right: 0.75, bottom: 0.5, angle: 0 };
    expect(pictureSize(crop, image)).toEqual({ width: 3000, height: 2000 });
  });

  it('uses the straightened output size, not the corners', () => {
    const crop = cropFromGeometry(3000, 2000, 2400, 1600, 10, image);
    const size = pictureSize(crop, image);
    expect(size.width).toBeCloseTo(2400, 6);
    expect(size.height).toBeCloseTo(1600, 6);
  });
});

describe('pictureViewTransform', () => {
  const outside: [number, number, number] = [0, 0, 0];

  it('puts the frame where the layout puts the picture, and draws nothing outside it', () => {
    const layout = { scale: 0.5, offset: { x: -300, y: 40 } };
    const view = pictureViewTransform({
      crop: WHOLE_IMAGE,
      image,
      uploadedWidth: 2400,
      layout,
      bufferRatio: 2,
      outside,
    });
    // The frame is the whole picture on screen, in buffer pixels.
    expect(view.frame).toEqual({ x: -600, y: 80, w: 6000, h: 4000 });
    expect(view.pivot).toEqual({ x: -600 + 3000, y: 80 + 2000 });
    expect(view.dim).toBe(0);
    // Buffer pixels per pixel of the uploaded image: the 2400 px texture stands for 6000 px.
    expect(view.scale).toBeCloseTo(0.5 * 2 * (6000 / 2400), 9);
  });

  it('frames a committed crop at the crop size', () => {
    const crop = cropFromGeometry(3000, 2000, 2000, 1000, 0, image);
    const layout = { scale: 1, offset: { x: 10, y: 20 } };
    const view = pictureViewTransform({
      crop,
      image,
      uploadedWidth: 6000,
      layout,
      bufferRatio: 1,
      outside,
    });
    expect(view.frame.x).toBeCloseTo(10, 6);
    expect(view.frame.y).toBeCloseTo(20, 6);
    expect(view.frame.w).toBeCloseTo(2000, 6);
    expect(view.frame.h).toBeCloseTo(1000, 6);
    expect(view.crop).toBe(crop);
  });
});

describe('linearEdgeFor', () => {
  it('asks for a preview-sized image when only a little of the picture is covered', () => {
    expect(linearEdgeFor(0.2, 6000)).toBe(2560);
  });

  it('steps up with the zoom, so wheel steps do not refetch every time', () => {
    expect(linearEdgeFor(0.5, 6000)).toBe(4096);
    expect(linearEdgeFor(0.6, 6000)).toBe(4096);
    expect(linearEdgeFor(0.8, 6000)).toBeUndefined();
  });

  it('is the full decode (undefined) once the picture is covered one to one', () => {
    expect(linearEdgeFor(1, 6000)).toBeUndefined();
    expect(linearEdgeFor(4, 6000)).toBeUndefined();
    expect(linearEdgeFor(2, 8256)).toBeUndefined();
  });

  it('never asks for more pixels than the image has', () => {
    expect(linearEdgeFor(0.9, 3200)).toBeUndefined();
    expect(linearEdgeFor(0.9, 2000)).toBeUndefined();
  });
});

describe('mosaicZoomedView', () => {
  const buffer = { width: 400, height: 300 };

  /** A buffer where every pixel is its own colour, so a mosaic is visible as lost detail. */
  const gradient = (): Uint8Array => {
    const rgba = new Uint8Array(buffer.width * buffer.height * 4);
    for (let y = 0; y < buffer.height; y++) {
      for (let x = 0; x < buffer.width; x++) {
        const at = (y * buffer.width + x) * 4;
        rgba[at] = x % 256;
        rgba[at + 1] = y % 256;
        rgba[at + 2] = (x * 7 + y * 13) % 256;
        rgba[at + 3] = 255;
      }
    }
    return rgba;
  };

  const changedBounds = (before: Uint8Array, after: Uint8Array) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < buffer.height; y++) {
      for (let x = 0; x < buffer.width; x++) {
        const at = (y * buffer.width + x) * 4;
        if (
          before[at] !== after[at] ||
          before[at + 1] !== after[at + 1] ||
          before[at + 2] !== after[at + 2]
        ) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    return maxX < 0 ? undefined : { minX, minY, maxX, maxY };
  };

  const op = (shapes: MosaicOp['shapes'], blockSizeRel = 0.005): MosaicOp => ({
    type: 'mosaic',
    shapes,
    blockSizeRel,
  });

  it('pixelates the buffer pixels the image region covers, and no others', () => {
    // 100% zoom: one image pixel per buffer pixel, the picture's top-left 1000 px left of the buffer.
    const layout = { scale: 1, offset: { x: -1000, y: -500 } };
    // Image region x 1100..1220, y 600..700 (6000 x 4000 image) -> buffer x 100..220, y 100..200.
    const region = {
      type: 'rect' as const,
      x: 1100 / 6000,
      y: 600 / 4000,
      w: 120 / 6000,
      h: 100 / 4000,
    };
    const before = gradient();
    const rgba = before.slice();
    mosaicZoomedView(rgba, buffer, {
      op: op([region]),
      crop: undefined,
      image,
      picture: image,
      layout,
      bufferRatio: 1,
    });
    const bounds = changedBounds(before, rgba);
    expect(bounds).toBeDefined();
    expect(bounds!.minX).toBeGreaterThanOrEqual(100);
    expect(bounds!.minY).toBeGreaterThanOrEqual(100);
    expect(bounds!.maxX).toBeLessThan(220);
    expect(bounds!.maxY).toBeLessThan(200);
    // And it reaches the region's edges, to within the first block.
    expect(bounds!.minX).toBeLessThanOrEqual(104);
    expect(bounds!.maxX).toBeGreaterThanOrEqual(215);
  });

  it('follows the layout: the same region pans and scales with the picture', () => {
    const region = { type: 'rect' as const, x: 0.2, y: 0.25, w: 0.1, h: 0.1 };
    const zoomedIn = { scale: 0.1, offset: { x: -100, y: -50 } };
    const before = gradient();
    const rgba = before.slice();
    mosaicZoomedView(rgba, buffer, {
      op: op([region], 0.002),
      crop: undefined,
      image,
      picture: image,
      layout: zoomedIn,
      bufferRatio: 1,
    });
    // x: 0.2 * 6000 * 0.1 - 100 = 20 .. 80; y: 0.25 * 4000 * 0.1 - 50 = 50 .. 90.
    const bounds = changedBounds(before, rgba);
    expect(bounds).toBeDefined();
    expect(bounds!.minX).toBeGreaterThanOrEqual(20);
    expect(bounds!.maxX).toBeLessThan(80);
    expect(bounds!.minY).toBeGreaterThanOrEqual(50);
    expect(bounds!.maxY).toBeLessThan(90);
  });

  it('draws a shape that runs off the buffer, without leaving it', () => {
    const layout = { scale: 1, offset: { x: -1000, y: -500 } };
    const before = gradient();
    const rgba = before.slice();
    mosaicZoomedView(rgba, buffer, {
      op: op([{ type: 'rect', x: 0.1, y: 0.1, w: 0.8, h: 0.8 }]),
      crop: undefined,
      image,
      picture: image,
      layout,
      bufferRatio: 1,
    });
    const bounds = changedBounds(before, rgba);
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: buffer.width - 1, maxY: buffer.height - 1 });
  });

  it('leaves the buffer alone when the shape is off screen', () => {
    const layout = { scale: 1, offset: { x: -3000, y: -3000 } };
    const before = gradient();
    const rgba = before.slice();
    mosaicZoomedView(rgba, buffer, {
      op: op([{ type: 'rect', x: 0.1, y: 0.1, w: 0.05, h: 0.05 }]),
      crop: undefined,
      image,
      picture: image,
      layout,
      bufferRatio: 1,
    });
    expect(changedBounds(before, rgba)).toBeUndefined();
  });

  it('moves a shape through the committed crop', () => {
    // The crop keeps the right half; the picture is 3000 x 4000, its top-left at the buffer's origin.
    const crop: CropParams = { left: 0.5, top: 0, right: 1, bottom: 1, angle: 0 };
    const picture = pictureSize(crop, image);
    const layout = { scale: 0.1, offset: { x: 0, y: 0 } };
    // Source x 0.6..0.7 is the crop's 0.2..0.4 of 3000 px: 600..1200 px, 60..120 on screen.
    const region = { type: 'rect' as const, x: 0.6, y: 0.5, w: 0.1, h: 0.1 };
    const before = gradient();
    const rgba = before.slice();
    mosaicZoomedView(rgba, buffer, {
      op: op([region], 0.002),
      crop,
      image,
      picture,
      layout,
      bufferRatio: 1,
    });
    const bounds = changedBounds(before, rgba);
    expect(bounds).toBeDefined();
    expect(bounds!.minX).toBeGreaterThanOrEqual(60);
    expect(bounds!.maxX).toBeLessThan(120);
    // y: 0.5 * 4000 * 0.1 = 200 .. 240.
    expect(bounds!.minY).toBeGreaterThanOrEqual(200);
    expect(bounds!.maxY).toBeLessThan(240);
  });
});
