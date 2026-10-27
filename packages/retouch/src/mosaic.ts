import type { MosaicOp } from '@ee/contracts';
import { clamp, shapesBounds } from './geometry';
import { maskBounds, rasterizePolygonPixels, rasterizeRectPixels, type Mask } from './mask';

export const MIN_BLOCK_SIZE = 8;
/** At most this many blocks across the short side of any shape. */
export const MAX_BLOCKS_ACROSS = 8;

export interface MosaicOptions {
  /** Write into the input buffer instead of returning a copy. Default false. */
  inPlace?: boolean;
}

/**
 * The edge length actually used for mosaic blocks.
 *
 * `blockSizeRel` is relative to the longer image edge and never gives blocks
 * smaller than 8 px. On top of that, the block is enlarged so no shape is
 * covered by more than 8 blocks across its short side: a 40 px face with 8 px
 * blocks would still be recognisable, a 5-block face is not.
 */
export function effectiveBlockSize(
  op: Pick<MosaicOp, 'shapes' | 'blockSizeRel'>,
  width: number,
  height: number,
): number {
  if (!Number.isFinite(op.blockSizeRel) || op.blockSizeRel <= 0) {
    throw new RangeError(`applyMosaic: blockSizeRel must be positive, got ${op.blockSizeRel}`);
  }
  const requested = Math.max(MIN_BLOCK_SIZE, Math.round(op.blockSizeRel * Math.max(width, height)));
  let shapeMinimum = 0;
  for (const shape of op.shapes) {
    const bounds = shapesBounds([shape]);
    if (!bounds) continue;
    const shortSide = Math.min(bounds.w * width, bounds.h * height);
    shapeMinimum = Math.max(shapeMinimum, Math.ceil(shortSide / MAX_BLOCKS_ACROSS));
  }
  return Math.max(requested, shapeMinimum, 1);
}

function readAverage(
  rgba: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let y = y0; y < y1; y++) {
    let index = (y * width + x0) * 4;
    for (let x = x0; x < x1; x++, index += 4) {
      r += rgba[index]!;
      g += rgba[index + 1]!;
      b += rgba[index + 2]!;
      a += rgba[index + 3]!;
    }
  }
  const pixels = (x1 - x0) * (y1 - y0);
  return [
    Math.round(r / pixels),
    Math.round(g / pixels),
    Math.round(b / pixels),
    Math.round(a / pixels),
  ];
}

/**
 * Pixelate the union of `op.shapes` in place or into a copy.
 *
 * Blocks are aligned to the image grid, not to the shapes, so preview and
 * full-resolution renders have the same block layout. Every block average
 * covers the whole block (including pixels outside the selection) before the
 * average is written only to selected pixels; otherwise the original edge
 * pixels would leak into the mosaic.
 */
export function applyMosaic(
  rgba: Uint8Array,
  width: number,
  height: number,
  op: MosaicOp,
  options: MosaicOptions = {},
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`applyMosaic: invalid size ${width}x${height}`);
  }
  if (rgba.length < width * height * 4) {
    throw new RangeError(
      `applyMosaic: RGBA buffer is too small (${rgba.length} < ${width * height * 4})`,
    );
  }
  if (!Number.isFinite(op.blockSizeRel) || op.blockSizeRel <= 0) {
    throw new RangeError(`applyMosaic: blockSizeRel must be positive, got ${op.blockSizeRel}`);
  }
  const destination = options.inPlace ? rgba : rgba.slice();
  const bounds = shapesBounds(op.shapes);
  if (!bounds || op.shapes.length === 0) return destination;

  const imageX0 = clamp(Math.floor(bounds.x * width), 0, width);
  const imageY0 = clamp(Math.floor(bounds.y * height), 0, height);
  const imageX1 = clamp(Math.ceil((bounds.x + bounds.w) * width), 0, width);
  const imageY1 = clamp(Math.ceil((bounds.y + bounds.h) * height), 0, height);
  if (imageX1 <= imageX0 || imageY1 <= imageY0) return destination;

  const localWidth = imageX1 - imageX0;
  const localHeight = imageY1 - imageY0;
  const mask: Mask = new Uint8Array(localWidth * localHeight);
  for (const shape of op.shapes) {
    if (shape.type === 'rect') {
      rasterizeRectPixels(
        {
          x: shape.x * width,
          y: shape.y * height,
          w: shape.w * width,
          h: shape.h * height,
        },
        localWidth,
        localHeight,
        mask,
        imageX0,
        imageY0,
      );
    } else {
      rasterizePolygonPixels(
        shape.points.map((point) => ({ x: point.x * width, y: point.y * height })),
        localWidth,
        localHeight,
        mask,
        imageX0,
        imageY0,
      );
    }
  }

  const masked = maskBounds(mask, localWidth, localHeight);
  if (!masked) return destination;
  const blockSize = effectiveBlockSize(op, width, height);
  const regionX0 = imageX0 + masked.x;
  const regionY0 = imageY0 + masked.y;
  const regionX1 = regionX0 + masked.w;
  const regionY1 = regionY0 + masked.h;

  for (
    let blockY = Math.floor(regionY0 / blockSize) * blockSize;
    blockY < regionY1;
    blockY += blockSize
  ) {
    for (
      let blockX = Math.floor(regionX0 / blockSize) * blockSize;
      blockX < regionX1;
      blockX += blockSize
    ) {
      const x0 = Math.max(0, blockX);
      const y0 = Math.max(0, blockY);
      const x1 = Math.min(width, blockX + blockSize);
      const y1 = Math.min(height, blockY + blockSize);
      if (x1 <= x0 || y1 <= y0) continue;
      const [r, g, b, a] = readAverage(rgba, width, x0, y0, x1, y1);
      const writeX0 = Math.max(x0, imageX0);
      const writeY0 = Math.max(y0, imageY0);
      const writeX1 = Math.min(x1, imageX1);
      const writeY1 = Math.min(y1, imageY1);
      if (writeX1 <= writeX0 || writeY1 <= writeY0) continue;
      for (let y = writeY0; y < writeY1; y++) {
        const maskRow = (y - imageY0) * localWidth - imageX0;
        let index = (y * width + writeX0) * 4;
        for (let x = writeX0; x < writeX1; x++, index += 4) {
          if (!mask[maskRow + x]) continue;
          destination[index] = r;
          destination[index + 1] = g;
          destination[index + 2] = b;
          destination[index + 3] = a;
        }
      }
    }
  }
  return destination;
}
