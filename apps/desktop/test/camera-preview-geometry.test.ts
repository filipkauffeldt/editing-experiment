// @vitest-environment node
import { decodeJpeg, decodeLinear, extractPreview, resizeRgba } from '@ee/core';
import { ExifToolService, readLensShot } from '@ee/metadata';
import { renderCpu } from '@ee/develop-gl';
import { afterAll, describe, expect, it } from 'vitest';
import { fixtureNefs } from './helpers/fixtures';

/**
 * Face detection reads the camera's embedded preview and the face boxes are mapped through the
 * built-in lens correction on the assumption that Nikon corrected that preview. This checks the
 * assumption on real files: near the corners the preview agrees far better with a render of the
 * raw with the camera's correction than with one without it (edge maps, normalised correlation).
 */

const WIDTH = 1200;

const luminance = (rgba: Uint8Array, count: number): Float32Array => {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = 0.3 * rgba[i * 4]! + 0.59 * rgba[i * 4 + 1]! + 0.11 * rgba[i * 4 + 2]!;
  }
  return out;
};

const gradient = (l: Float32Array, w: number, h: number): Float32Array => {
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      g[y * w + x] = Math.hypot(
        l[y * w + x + 1]! - l[y * w + x - 1]!,
        l[(y + 1) * w + x]! - l[(y - 1) * w + x]!,
      );
    }
  }
  return g;
};

function correlation(
  a: Float32Array,
  b: Float32Array,
  w: number,
  area: [number, number, number, number],
): number {
  const [x0, y0, x1, y1] = area;
  let sa = 0;
  let sb = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sa += a[y * w + x]!;
      sb += b[y * w + x]!;
      n++;
    }
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = a[y * w + x]! - ma;
      const q = b[y * w + x]! - mb;
      num += p * q;
      da += p * p;
      db += q * q;
    }
  }
  return num / Math.sqrt(da * db);
}

const files = fixtureNefs().filter((file) => /z6ii_CZP_0299|z30_14bit/.test(file));

describe.skipIf(files.length === 0)('the embedded preview of a Nikon Z raw', () => {
  const exiftool = new ExifToolService();
  afterAll(() => exiftool.close());

  it.each(files.map((file) => [file.split('/').pop(), file] as const))(
    'is distortion corrected by the camera (%s)',
    async (_name, path) => {
      const preview = await decodeJpeg((await extractPreview(path)).jpeg);
      const small = await resizeRgba(preview.rgba, preview.width, preview.height, {
        maxEdge: WIDTH,
      });
      const linear = await decodeLinear(path, { maxEdge: WIDTH, sampleType: 'f32' });
      const lens = await readLensShot(
        path,
        { width: linear.header.sourceWidth, height: linear.header.sourceHeight },
        exiftool,
      );
      expect(lens?.builtin).toBeDefined();
      const header = { ...linear.header, lens };
      const size = { width: small.width, height: small.height };
      const w = size.width;
      const h = size.height;
      const reference = gradient(luminance(small.rgba, w * h), w, h);
      const corners: [number, number, number, number][] = [
        [4, 4, Math.round(w * 0.25), Math.round(h * 0.25)],
        [w - Math.round(w * 0.25), h - Math.round(h * 0.25), w - 4, h - 4],
      ];
      const score = (enabled: boolean): number[] => {
        const rendered = renderCpu(
          header,
          linear.data,
          { LensProfileEnable: enabled, Contrast2012: 30 },
          size,
        );
        const edges = gradient(luminance(rendered, w * h), w, h);
        return corners.map((area) => correlation(reference, edges, w, area));
      };
      const off = score(false);
      const on = score(true);
      for (let i = 0; i < corners.length; i++) {
        expect(on[i]!, `corner ${i}: ${on[i]} vs ${off[i]}`).toBeGreaterThan(off[i]! + 0.05);
      }
    },
    60_000,
  );
});
