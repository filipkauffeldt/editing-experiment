import { describe, expect, it } from 'vitest';
import { rotateRetouchOps, rotateShape, type MosaicOp, type Rect } from '../src';

const rect = (x: number, y: number, w: number, h: number): Rect => ({ type: 'rect', x, y, w, h });

describe('rotateShape', () => {
  it('keeps a rectangle on the same content through a right turn', () => {
    // A box in the top left of a landscape picture ends up in the top right of the portrait one.
    expect(rotateShape(rect(0.1, 0.2, 0.3, 0.1), 1)).toMatchObject({
      type: 'rect',
      x: 0.7,
      y: 0.1,
      w: 0.1,
      h: 0.3,
    });
  });

  it('turns a polygon corner by corner', () => {
    const turned = rotateShape(
      {
        type: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0.5, y: 0.25 },
        ],
      },
      1,
    );
    expect(turned).toEqual({
      type: 'polygon',
      points: [
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0.75, y: 0.5 },
      ],
    });
  });

  it('is the identity after four turns and undone by the opposite turn', () => {
    const shape = rect(0.12, 0.34, 0.2, 0.15);
    expect(rotateShape(shape, 4)).toEqual(shape);
    const there = rotateShape(rotateShape(shape, 1), -1) as Rect;
    expect(there.x).toBeCloseTo(0.12, 12);
    expect(there.y).toBeCloseTo(0.34, 12);
    expect(there.w).toBeCloseTo(0.2, 12);
    expect(there.h).toBeCloseTo(0.15, 12);
  });
});

describe('rotateRetouchOps', () => {
  const op: MosaicOp = {
    type: 'mosaic',
    blockSizeRel: 0.02,
    shapes: [rect(0.1, 0.2, 0.3, 0.1)],
    areas: [
      {
        shape: rect(0.1, 0.2, 0.3, 0.1),
        face: { box: rect(0.15, 0.22, 0.2, 0.06), score: 0.9 },
      },
      { shape: rect(0.5, 0.5, 0.2, 0.2), mode: 'subtract', enabled: false },
    ],
    facePadding: 0.3,
  };

  it('moves every area, the shapes next to them and the box a face keeps', () => {
    const [turned] = rotateRetouchOps([op], 1) as [MosaicOp];
    expect(turned.shapes).toEqual([rotateShape(rect(0.1, 0.2, 0.3, 0.1), 1)]);
    expect(turned.areas?.[0]?.shape).toEqual(rotateShape(rect(0.1, 0.2, 0.3, 0.1), 1));
    expect(turned.areas?.[0]?.face?.box).toEqual(rotateShape(rect(0.15, 0.22, 0.2, 0.06), 1));
    expect(turned.areas?.[0]?.face?.score).toBe(0.9);
    expect(turned.areas?.[1]).toMatchObject({ mode: 'subtract', enabled: false });
    expect(turned.blockSizeRel).toBe(0.02);
    expect(turned.facePadding).toBe(0.3);
  });

  it('leaves an op saved without areas as shapes only', () => {
    const [turned] = rotateRetouchOps(
      [{ type: 'mosaic', blockSizeRel: 0.01, shapes: [rect(0, 0, 0.5, 0.5)] }],
      2,
    );
    expect(turned).toEqual({
      type: 'mosaic',
      blockSizeRel: 0.01,
      shapes: [rect(0.5, 0.5, 0.5, 0.5)],
    });
  });
});
