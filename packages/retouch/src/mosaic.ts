import type { MosaicOp, Shape } from '@ee/contracts';
import { clamp, shapeBounds, shapesBounds } from './geometry';
import { maskBounds, rasterizePolygonPixels, rasterizeRectPixels, type Mask } from './mask';

export const MIN_BLOCK_SIZE = 8;
/** At most this many blocks across the short side of any shape. */
export const MAX_BLOCKS_ACROSS = 8;

export interface MosaicOptions {
  /** Write into the input buffer instead of returning a copy. Default false. */
  inPlace?: boolean;
}

function validateBlockSizeRel(blockSizeRel: number): void {
  if (!Number.isFinite(blockSizeRel) || blockSizeRel <= 0) {
    throw new RangeError(`applyMosaic: blockSizeRel must be positive, got ${blockSizeRel}`);
  }
}

function requestedBlockSize(blockSizeRel: number, width: number, height: number): number {
  return Math.max(MIN_BLOCK_SIZE, Math.round(blockSizeRel * Math.max(width, height)));
}

/**
 * Block size for one shape.
 *
 * `blockSizeRel` is relative to the longer image edge and never gives blocks
 * smaller than 8 px. On top of that, the block is enlarged so this shape is
 * covered by at most 8 blocks across its short side: a 40 px face with 8 px
 * blocks would still be recognisable, a 5-block face is not.
 */
export function blockSizeForShape(
  shape: Shape,
  blockSizeRel: number,
  width: number,
  height: number,
): number {
  validateBlockSizeRel(blockSizeRel);
  const requested = requestedBlockSize(blockSizeRel, width, height);
  const bounds = shapeBounds(shape);
  if (bounds.w <= 0 || bounds.h <= 0) return requested;
  const shortSide = Math.min(bounds.w * width, bounds.h * height);
  return Math.max(requested, Math.ceil(shortSide / MAX_BLOCKS_ACROSS), 1);
}

/** Largest block required by any shape in the op (diagnostics/tests). */
export function effectiveBlockSize(
  op: Pick<MosaicOp, 'shapes' | 'blockSizeRel'>,
  width: number,
  height: number,
): number {
  validateBlockSizeRel(op.blockSizeRel);
  let size = requestedBlockSize(op.blockSizeRel, width, height);
  for (const shape of op.shapes) {
    size = Math.max(size, blockSizeForShape(shape, op.blockSizeRel, width, height));
  }
  return size;
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

function mosaicShapes(
  source: Uint8Array,
  destination: Uint8Array,
  width: number,
  height: number,
  shapes: readonly Shape[],
  blockSize: number,
): void {
  const bounds = shapesBounds(shapes);
  if (!bounds) return;
  const imageX0 = clamp(Math.floor(bounds.x * width), 0, width);
  const imageY0 = clamp(Math.floor(bounds.y * height), 0, height);
  const imageX1 = clamp(Math.ceil((bounds.x + bounds.w) * width), 0, width);
  const imageY1 = clamp(Math.ceil((bounds.y + bounds.h) * height), 0, height);
  if (imageX1 <= imageX0 || imageY1 <= imageY0) return;

  const localWidth = imageX1 - imageX0;
  const localHeight = imageY1 - imageY0;
  const mask: Mask = new Uint8Array(localWidth * localHeight);
  for (const shape of shapes) {
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
  if (!masked) return;
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
      const [r, g, b, a] = readAverage(source, width, x0, y0, x1, y1);
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
}

/**
 * Pixelate the union of `op.shapes` in place or into a copy.
 *
 * Blocks are aligned to the image grid, not to the shapes, so preview and
 * full-resolution renders have the same block layout. Each shape gets its own
 * block size (so a small face beside a large one keeps fine blocks), and shapes
 * with the same block size share one image-aligned grid. Every block average
 * covers the whole block (including pixels outside the selection) before the
 * average is written only to selected pixels; otherwise the original edge
 * pixels would leak into the mosaic.
 *
 * Size classes are processed smallest block first. Where classes overlap, the
 * later (coarser) mosaic wins; both are privacy-preserving averages of the
 * original, and the result is deterministic.
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
  validateBlockSizeRel(op.blockSizeRel);
  // In-place writes can land in a different size class, so always average from
  // the untouched input.
  const source = options.inPlace ? rgba.slice() : rgba;
  const destination = options.inPlace ? rgba : rgba.slice();

  const groups = new Map<number, Shape[]>();
  for (const shape of op.shapes) {
    const blockSize = blockSizeForShape(shape, op.blockSizeRel, width, height);
    const group = groups.get(blockSize);
    if (group) group.push(shape);
    else groups.set(blockSize, [shape]);
  }
  const classes = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  for (const [blockSize, shapes] of classes) {
    mosaicShapes(source, destination, width, height, shapes, blockSize);
  }
  return destination;
}
