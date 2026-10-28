import type { CropParams, MosaicOp, Rect } from '@ee/contracts';
import { constrainCrop, cropOutputPixels, croppedToSourcePixels } from '@ee/develop-gl';
import { blockSizeForShape } from '@ee/retouch';
import { describe, expect, it } from 'vitest';
import { composeDevelopedRgba } from '../src/renderer/develop-render';

const WIDTH = 240;
const HEIGHT = 160;

function gradient(): Uint8Array {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      rgba[i] = (x * 7) % 256;
      rgba[i + 1] = (y * 11) % 256;
      rgba[i + 2] = (x + y) % 256;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function blockAverage(
  source: Uint8Array,
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
      const i = (y * WIDTH + x) * 4;
      r += source[i] ?? 0;
      g += source[i + 1] ?? 0;
      b += source[i + 2] ?? 0;
    }
  }
  const count = (x1 - x0) * (y1 - y0);
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

describe('composeDevelopedRgba', () => {
  it('mosaics in source space before a 5 degree straighten and crop', () => {
    const source = gradient();
    const face: Rect = { type: 'rect', x: 0.4, y: 0.32, w: 0.2, h: 0.26 };
    const op: MosaicOp = { type: 'mosaic', shapes: [face], blockSizeRel: 0.02 };
    const crop: CropParams = constrainCrop(
      { left: 0.12, top: 0.1, right: 0.88, bottom: 0.92, angle: 5 },
      { width: WIDTH, height: HEIGHT },
    );
    const output = cropOutputPixels(crop, { width: WIDTH, height: HEIGHT });
    const rendered = composeDevelopedRgba({
      params: { crop },
      ops: [op],
      width: output.width,
      height: output.height,
      source: { width: WIDTH, height: HEIGHT },
      render: () => source.slice(),
    });
    expect(rendered).toHaveLength(output.width * output.height * 4);

    const block = blockSizeForShape(face, op.blockSizeRel, WIDTH, HEIGHT);
    const faceLeft = face.x * WIDTH;
    const faceTop = face.y * HEIGHT;
    const faceRight = (face.x + face.w) * WIDTH;
    const faceBottom = (face.y + face.h) * HEIGHT;
    const margin = 1.25;

    let checked = 0;
    for (let y = 0; y < output.height; y++) {
      for (let x = 0; x < output.width; x++) {
        const sourcePoint = croppedToSourcePixels(
          crop,
          { width: WIDTH, height: HEIGHT },
          {
            x: x + 0.5,
            y: y + 0.5,
          },
        );
        if (
          sourcePoint.x < faceLeft + margin ||
          sourcePoint.x > faceRight - margin ||
          sourcePoint.y < faceTop + margin ||
          sourcePoint.y > faceBottom - margin
        ) {
          continue;
        }
        const blockX = Math.floor(sourcePoint.x / block) * block;
        const blockY = Math.floor(sourcePoint.y / block) * block;
        // Bilinear taps reach half a pixel; stay clear of the block edge.
        if (
          sourcePoint.x < blockX + margin ||
          sourcePoint.x > blockX + block - margin ||
          sourcePoint.y < blockY + margin ||
          sourcePoint.y > blockY + block - margin
        ) {
          continue;
        }
        const [r, g, b] = blockAverage(
          source,
          blockX,
          blockY,
          Math.min(WIDTH, blockX + block),
          Math.min(HEIGHT, blockY + block),
        );
        const index = (y * output.width + x) * 4;
        expect(rendered[index]).toBe(r);
        expect(rendered[index + 1]).toBe(g);
        expect(rendered[index + 2]).toBe(b);
        expect(rendered[index + 3]).toBe(255);
        checked += 1;
      }
    }
    // The crop covers the face with plenty of interior pixels; the gradient
    // would vary wildly here without the mosaic.
    expect(checked).toBeGreaterThan(20);
  });
});
