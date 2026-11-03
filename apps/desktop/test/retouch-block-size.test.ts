import { applyMosaic, effectiveBlockSize } from '@ee/retouch';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_SIZE_PX,
  blockSizePxRange,
  blockSizePxToRel,
  blockSizeRelToPx,
  photoLongEdge,
} from '../src/renderer/retouch-block-size';

describe('block size in pixels', () => {
  it('uses the longer edge of the full-resolution photo, in either orientation', () => {
    expect(photoLongEdge({ width: 6048, height: 4032 })).toBe(6048);
    expect(photoLongEdge({ width: 4032, height: 6048 })).toBe(6048);
    expect(photoLongEdge({ width: 6048 })).toBeUndefined();
    expect(photoLongEdge({ width: 0, height: 0 })).toBeUndefined();
  });

  it('converts a stored fraction to whole pixels and back', () => {
    expect(blockSizeRelToPx(0.012, 6000)).toBe(72);
    expect(blockSizePxToRel(48, 6000)).toBeCloseTo(0.008);
    for (const edge of [3000, 6048, 8256]) {
      for (let px = BLOCK_SIZE_PX.min; px <= BLOCK_SIZE_PX.max; px += 7) {
        expect(blockSizeRelToPx(blockSizePxToRel(px, edge), edge)).toBe(px);
      }
    }
  });

  it('never gives a block under one pixel', () => {
    expect(blockSizeRelToPx(0.00001, 6000)).toBe(1);
    expect(blockSizePxToRel(0, 6000)).toBeCloseTo(1 / 6000);
  });

  it('stretches the slider to a saved size outside the fixed range', () => {
    expect(blockSizePxRange(72)).toEqual({ min: 8, max: 256, step: 1 });
    expect(blockSizePxRange(330).max).toBe(330);
    expect(blockSizePxRange(5).min).toBe(5);
  });

  it('keeps the look when the export renders at another size', () => {
    // 48 px on a 6000 px photo is stored as a fraction; a 1500 px render of the same photo gets
    // a block a quarter as wide, so the mosaic covers the same share of the picture.
    const rel = blockSizePxToRel(48, 6000);
    // Small enough that the at-most-8-blocks rule does not enlarge the block.
    const shape = { type: 'rect' as const, x: 0.1, y: 0.1, w: 0.3, h: 0.08 };
    const op = { type: 'mosaic' as const, shapes: [shape], blockSizeRel: rel };
    expect(effectiveBlockSize(op, 6000, 4000)).toBe(48);
    expect(effectiveBlockSize(op, 1500, 1000)).toBe(12);
    const rgba = new Uint8Array(1500 * 1000 * 4).fill(200);
    expect(() => applyMosaic(rgba, 1500, 1000, op)).not.toThrow();
  });
});
