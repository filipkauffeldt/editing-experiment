import type { CropParams, MosaicOp, Rect, Shape } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { composeDevelopedRgba } from '../src/renderer/develop-render';
import { renderMosaicPreview } from '../src/renderer/retouch-preview';

/**
 * The mosaic reaches the screen three ways: the canvas preview (`renderMosaicPreview`), and the
 * export and the film strip thumbnail, which both go through `composeDevelopedRgba`. All of them
 * hand the op to `applyMosaic`, so an add, a subtract, a re-add and an area that is off must
 * cover the same pixels in each.
 */

const rect = (x: number, y: number, w: number, h: number): Rect => ({ type: 'rect', x, y, w, h });
const triangle: Shape = {
  type: 'polygon',
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.7, y: 0.15 },
    { x: 0.3, y: 0.7 },
  ],
};

const SIZE = { width: 320, height: 240 };

/** A high-frequency pattern, so a mosaicked pixel is never the original by chance. */
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

const op = (areas: NonNullable<MosaicOp['areas']>): MosaicOp => ({
  type: 'mosaic',
  shapes: [],
  areas,
  blockSizeRel: 0.04,
});

const CASES: Record<string, MosaicOp> = {
  'one add': op([{ shape: rect(0.1, 0.1, 0.6, 0.6) }]),
  'add then subtract': op([
    { shape: rect(0.05, 0.05, 0.9, 0.9) },
    { shape: rect(0.3, 0.3, 0.3, 0.3), mode: 'subtract' },
  ]),
  'a later add covers the hole again': op([
    { shape: rect(0.05, 0.05, 0.9, 0.9) },
    { shape: rect(0.3, 0.3, 0.3, 0.3), mode: 'subtract' },
    { shape: rect(0.4, 0.4, 0.1, 0.1) },
  ]),
  'a lasso hole in a rectangle': op([
    { shape: rect(0.05, 0.05, 0.9, 0.9) },
    { shape: triangle, mode: 'subtract' },
  ]),
  'areas that are off': op([
    { shape: rect(0.05, 0.05, 0.9, 0.9) },
    { shape: rect(0.3, 0.3, 0.3, 0.3), mode: 'subtract', enabled: false },
    { shape: rect(0.6, 0.6, 0.3, 0.3), enabled: false },
  ]),
};

const render = (_params: unknown, size: { width: number; height: number }): Uint8Array =>
  pattern(size);

const preview = (mosaic: MosaicOp, params: { crop?: CropParams }, output = SIZE): Uint8Array =>
  renderMosaicPreview({ op: mosaic, params, source: SIZE, output, render });

const exported = (mosaic: MosaicOp, params: { crop?: CropParams }, output = SIZE): Uint8Array =>
  composeDevelopedRgba({
    params,
    ops: [mosaic],
    width: output.width,
    height: output.height,
    source: SIZE,
    render,
  });

describe('add and subtract in the preview, the export and the thumbnail', () => {
  for (const [name, mosaic] of Object.entries(CASES)) {
    it(`${name}: the canvas preview and the export are the same pixels`, () => {
      expect(preview(mosaic, {})).toEqual(exported(mosaic, {}));
    });

    it(`${name}: a smaller thumbnail covers the same share of the picture`, () => {
      const thumb = { width: 160, height: 120 };
      const covered = (rgba: Uint8Array, size: { width: number; height: number }): boolean[] => {
        const plain = pattern(size);
        const out: boolean[] = [];
        // One sample per 16th of the picture, away from block edges, so grid differences between
        // sizes cannot matter.
        for (let gy = 0; gy < 16; gy++) {
          for (let gx = 0; gx < 16; gx++) {
            const x = Math.floor(((gx + 0.5) / 16) * size.width);
            const y = Math.floor(((gy + 0.5) / 16) * size.height);
            const i = (y * size.width + x) * 4;
            out.push(rgba[i] !== plain[i] || rgba[i + 1] !== plain[i + 1]);
          }
        }
        return out;
      };
      const full = covered(exported(mosaic, {}), SIZE);
      const small = covered(exported(mosaic, {}, thumb), thumb);
      const differing = full.filter((value, i) => value !== small[i]).length;
      // Blocks are a fixed share of the long edge, so cells only disagree where a block straddles
      // a shape boundary; the pattern must still agree almost everywhere.
      expect(differing).toBeLessThanOrEqual(10);
    });
  }

  it('a subtract hole shows the original pixels through a straightened crop, in both paths', () => {
    const crop: CropParams = { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, angle: 0 };
    const mosaic = CASES['add then subtract']!;
    const output = { width: 256, height: 192 };
    const plainPreview = preview(op([]), { crop }, output);
    const plainExport = exported(op([]), { crop }, output);
    const shown = (rgba: Uint8Array, plain: Uint8Array, x: number, y: number): boolean => {
      const i = (y * output.width + x) * 4;
      return rgba[i] === plain[i] && rgba[i + 1] === plain[i + 1] && rgba[i + 2] === plain[i + 2];
    };
    const withMosaicPreview = preview(mosaic, { crop }, output);
    const withMosaicExport = exported(mosaic, { crop }, output);
    // The hole is the middle 30 % of the source; in the crop it is around the centre.
    const centre = { x: Math.round(output.width / 2), y: Math.round(output.height / 2) };
    expect(shown(withMosaicPreview, plainPreview, centre.x, centre.y)).toBe(true);
    expect(shown(withMosaicExport, plainExport, centre.x, centre.y)).toBe(true);
    // Outside the hole, inside the add area, both paths cover the picture.
    const covered = { x: Math.round(output.width * 0.08), y: Math.round(output.height * 0.08) };
    expect(shown(withMosaicPreview, plainPreview, covered.x, covered.y)).toBe(false);
    expect(shown(withMosaicExport, plainExport, covered.x, covered.y)).toBe(false);
  });
});
