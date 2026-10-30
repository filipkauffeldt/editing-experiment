import type { CropParams, MosaicOp, Rect, Shape } from '@ee/contracts';
import { constrainCrop, cropMosaicOp, cropOutputPixels } from '@ee/develop-gl';
import { outputSizeForResize } from '@ee/export/output-size';
import {
  blockSizeForShape,
  MAX_BLOCKS_ACROSS,
  MIN_BLOCK_SIZE,
  pointInPolygon,
  shapeBounds,
} from '@ee/retouch';
import { describe, expect, it } from 'vitest';
import { composeDevelopedRgba } from '../src/renderer/develop-render';

const SOURCE = { width: 6000, height: 4000 };

/** High-frequency test pattern in the coordinates of the requested output. */
function pattern(size: { width: number; height: number }): Uint8Array {
  const rgba = new Uint8Array(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const i = (y * size.width + x) * 4;
      rgba[i] = (x * 13 + y * 7) % 256;
      rgba[i + 1] = (x * 3 + y * 17) % 256;
      rgba[i + 2] = (x * 11 + y * 5) % 256;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function inside(shape: Shape, x: number, y: number, size: { width: number; height: number }) {
  if (shape.type === 'rect') {
    return (
      x >= shape.x * size.width &&
      x < (shape.x + shape.w) * size.width &&
      y >= shape.y * size.height &&
      y < (shape.y + shape.h) * size.height
    );
  }
  return pointInPolygon(
    { x, y },
    shape.points.map((p) => ({ x: p.x * size.width, y: p.y * size.height })),
  );
}

function blockAverage(
  rgba: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      r += rgba[i] ?? 0;
      g += rgba[i + 1] ?? 0;
      b += rgba[i + 2] ?? 0;
    }
  }
  const count = (x1 - x0) * (y1 - y0);
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

describe('composeDevelopedRgba', () => {
  it('mosaics a 2048 px output through a 5 degree crop, block-constant and fully covered', () => {
    const face: Rect = { type: 'rect', x: 0.36, y: 0.34, w: 0.22, h: 0.28 };
    const op: MosaicOp = { type: 'mosaic', shapes: [face], blockSizeRel: 0.01 };
    const crop: CropParams = constrainCrop(
      { left: 0.08, top: 0.06, right: 0.92, bottom: 0.94, angle: 5 },
      SOURCE,
    );
    const size = outputSizeForResize(
      cropOutputPixels(crop, SOURCE).width,
      cropOutputPixels(crop, SOURCE).height,
      { mode: 'longEdge', pixels: 2048 },
    );
    const rendered = composeDevelopedRgba({
      params: { crop },
      ops: [op],
      width: size.width,
      height: size.height,
      source: SOURCE,
      render: () => pattern(size),
    });
    const plain = pattern(size);
    const mapped = cropMosaicOp(op, crop, SOURCE, size);
    const mappedShape = mapped.shapes[0]!;
    const block = blockSizeForShape(mappedShape, mapped.blockSizeRel, size.width, size.height);

    // Same privacy rule as at full resolution, now at the smaller output size.
    expect(block).toBeGreaterThanOrEqual(MIN_BLOCK_SIZE);
    const bounds = shapeBounds(mappedShape);
    const shortSide = Math.min(bounds.w * size.width, bounds.h * size.height);
    expect(block).toBeGreaterThanOrEqual(Math.ceil(shortSide / MAX_BLOCKS_ACROSS));

    const blocks = new Map<string, { values: number[]; expected: [number, number, number] }>();
    let changedPixels = 0;
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        if (!inside(mappedShape, x + 0.5, y + 0.5, size)) continue;
        const blockX = Math.floor(x / block) * block;
        const blockY = Math.floor(y / block) * block;
        const key = `${blockX},${blockY}`;
        const index = (y * size.width + x) * 4;
        const entry = blocks.get(key) ?? {
          values: [],
          expected: blockAverage(
            plain,
            size.width,
            size.height,
            blockX,
            blockY,
            Math.min(size.width, blockX + block),
            Math.min(size.height, blockY + block),
          ),
        };
        entry.values.push(rendered[index]!, rendered[index + 1]!, rendered[index + 2]!);
        blocks.set(key, entry);
        if (rendered[index] !== plain[index]) changedPixels += 1;
      }
    }

    expect(blocks.size).toBeGreaterThan(20);
    for (const { values, expected } of blocks.values()) {
      for (let channel = 0; channel < 3; channel++) {
        const channelValues = values.filter((_, index) => index % 3 === channel);
        expect(Math.max(...channelValues) - Math.min(...channelValues)).toBe(0);
        expect(channelValues[0]).toBe(expected[channel]);
      }
    }
    // The pattern is high-frequency, so a covered face cannot be the original pixels.
    expect(changedPixels).toBeGreaterThan(0);
  });

  it('keeps rects axis-aligned when the crop is not rotated', () => {
    const op: MosaicOp = {
      type: 'mosaic',
      shapes: [{ type: 'rect', x: 0.2, y: 0.2, w: 0.2, h: 0.2 }],
      blockSizeRel: 0.02,
    };
    const mapped = cropMosaicOp(
      op,
      { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, angle: 0 },
      SOURCE,
      { width: 1000, height: 1000 },
    );
    expect(mapped.shapes[0]?.type).toBe('rect');
  });

  it('turns a rect into a polygon under a straighten', () => {
    const op: MosaicOp = {
      type: 'mosaic',
      shapes: [{ type: 'rect', x: 0.2, y: 0.2, w: 0.2, h: 0.2 }],
      blockSizeRel: 0.02,
    };
    const mapped = cropMosaicOp(
      op,
      { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, angle: 5 },
      SOURCE,
      { width: 1000, height: 1000 },
    );
    expect(mapped.shapes[0]?.type).toBe('polygon');
  });
});
