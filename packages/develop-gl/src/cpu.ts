import type { EditParams, LinearImageHeader } from '@ee/contracts';
import { toFloat32Samples, type LinearImageBuffer } from './image';
import {
  clipHighlights,
  lookupCurve,
  shoulder,
  srgbEncode,
  toneRgb,
  vibranceSaturation,
} from './ops';
import { resolveUniforms, type DevelopUniforms } from './params';

/**
 * CPU reference of the develop pipeline: the exact maths of the shaders, on
 * float32 samples (computed in double precision per pixel). Used by the tests
 * and usable as an export fallback when WebGL2 is unavailable.
 */

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** One pixel: camera RGB (unity white balance) to display-referred sRGB-encoded RGB in 0..1. */
export function developPixel(
  r: number,
  g: number,
  b: number,
  u: DevelopUniforms,
): [number, number, number] {
  const m = u.colorMatrix as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const k = u.exposureGain;
  const [wr, wg, wb] = clipHighlights([r, g, b], u.multipliers);
  let lr = (m[0] * wr + m[1] * wg + m[2] * wb) * k;
  let lg = (m[3] * wr + m[4] * wg + m[5] * wb) * k;
  let lb = (m[6] * wr + m[7] * wg + m[8] * wb) * k;

  if (u.toneActive) [lr, lg, lb] = toneRgb(lr, lg, lb, u.tone);

  let er = srgbEncode(shoulder(lr));
  let eg = srgbEncode(shoulder(lg));
  let eb = srgbEncode(shoulder(lb));

  if (u.curveLut) {
    er = lookupCurve(u.curveLut, 0, 4, er);
    eg = lookupCurve(u.curveLut, 1, 4, eg);
    eb = lookupCurve(u.curveLut, 2, 4, eb);
  }
  if (u.vibrance !== 0 || u.saturation !== 0) {
    [er, eg, eb] = vibranceSaturation(er, eg, eb, u.vibrance, u.saturation);
  }
  return [clamp01(er), clamp01(eg), clamp01(eb)];
}

export interface RenderSize {
  width: number;
  height: number;
}

/**
 * Renders to float RGBA (encoded values in 0..1, alpha 1), resampling bilinearly
 * from the camera data when `size` differs from the image. Pixel centres and
 * edge clamping match the GPU's `LINEAR` / `CLAMP_TO_EDGE` sampling.
 */
export function renderCpuFloat(
  header: LinearImageHeader,
  data: LinearImageBuffer,
  params: EditParams,
  size: RenderSize = header,
): Float32Array {
  const samples = toFloat32Samples(header, data);
  const u = resolveUniforms(header, params);
  const { width: sw, height: sh } = header;
  const out = new Float32Array(size.width * size.height * 4);
  const sx = sw / size.width;
  const sy = sh / size.height;
  const same = size.width === sw && size.height === sh;

  const px = [0, 0, 0];
  for (let y = 0; y < size.height; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const y0 = Math.floor(fy);
    const wy = fy - y0;
    const ya = Math.min(sh - 1, Math.max(0, y0));
    const yb = Math.min(sh - 1, Math.max(0, y0 + 1));
    for (let x = 0; x < size.width; x++) {
      if (same) {
        const i = (y * sw + x) * 4;
        px[0] = samples[i] ?? 0;
        px[1] = samples[i + 1] ?? 0;
        px[2] = samples[i + 2] ?? 0;
      } else {
        const fx = (x + 0.5) * sx - 0.5;
        const x0 = Math.floor(fx);
        const wx = fx - x0;
        const xa = Math.min(sw - 1, Math.max(0, x0));
        const xb = Math.min(sw - 1, Math.max(0, x0 + 1));
        for (let c = 0; c < 3; c++) {
          const top =
            (samples[(ya * sw + xa) * 4 + c] ?? 0) * (1 - wx) +
            (samples[(ya * sw + xb) * 4 + c] ?? 0) * wx;
          const bottom =
            (samples[(yb * sw + xa) * 4 + c] ?? 0) * (1 - wx) +
            (samples[(yb * sw + xb) * 4 + c] ?? 0) * wx;
          px[c] = top * (1 - wy) + bottom * wy;
        }
      }
      const [r, g, b] = developPixel(px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, u);
      const o = (y * size.width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 1;
    }
  }
  return out;
}

/** Like {@link renderCpuFloat} but 8-bit RGBA, row 0 at the top (what `renderToRGBA` returns). */
export function renderCpu(
  header: LinearImageHeader,
  data: LinearImageBuffer,
  params: EditParams,
  size: RenderSize = header,
): Uint8Array {
  const f = renderCpuFloat(header, data, params, size);
  const out = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.round(clamp01(f[i] ?? 0) * 255);
  return out;
}
