import type { EditParams, LinearImageHeader } from '@ee/contracts';
import { cropGeometry, cropOutputSize, isUsableCrop } from './crop';
import { toFloat32Samples, type LinearImageBuffer } from './image';
import {
  clipHighlights,
  lookupCurve,
  shoulder,
  srgbEncode,
  toneRgb,
  vibranceSaturation,
} from './ops';
import { resolveUniforms, type DevelopUniforms, type ResolveOptions } from './params';
import { applyCalibration } from './color/calibration';
import { applyColorMixer } from './color/mixer';
import { applyColorGrading } from './color/grading';
import { applyVignette, grainNoise } from './color/effects';

/**
 * CPU reference of the develop pipeline: the exact maths of the shaders, on
 * float32 samples (computed in double precision per pixel). Used by the tests
 * and usable as an export fallback when WebGL2 is unavailable.
 */

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Where a pixel sits, for the spatial effects; omitted by callers that only need colour. */
export interface PixelPosition {
  /** Output position normalized to -1..1 (the crop output, not the preview buffer). */
  nx: number;
  ny: number;
  /** Source pixel position, as the shader samples it. */
  srcX: number;
  srcY: number;
  /** Full-resolution source pixels per rendered pixel (1 for a full-size render). */
  scale: number;
}

/** One pixel: camera RGB (unity white balance) to display-referred sRGB-encoded RGB in 0..1. */
export function developPixel(
  r: number,
  g: number,
  b: number,
  u: DevelopUniforms,
  position?: PixelPosition,
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
  let lr = m[0] * wr + m[1] * wg + m[2] * wb;
  let lg = m[3] * wr + m[4] * wg + m[5] * wb;
  let lb = m[6] * wr + m[7] * wg + m[8] * wb;
  // Calibration sits next to the camera matrix, before exposure and tone.
  [lr, lg, lb] = applyCalibration([lr, lg, lb], u.calibration);
  lr *= k;
  lg *= k;
  lb *= k;

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
  [er, eg, eb] = applyColorMixer(er, eg, eb, u.mixer);
  [er, eg, eb] = applyColorGrading(er, eg, eb, u.grading);
  if (position) {
    if (u.vignette) [er, eg, eb] = applyVignette(er, eg, eb, u.vignette, position.nx, position.ny);
    if (u.grain) {
      const noise = grainNoise(
        u.grain,
        position.srcX,
        position.srcY,
        position.scale,
        0.2126 * er + 0.7152 * eg + 0.0722 * eb,
      );
      er += noise;
      eg += noise;
      eb += noise;
    }
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
  options: ResolveOptions = {},
): Float32Array {
  const samples = toFloat32Samples(header, data);
  const u = resolveUniforms(header, params, options);
  const { width: sw, height: sh } = header;
  const out = new Float32Array(size.width * size.height * 4);
  // Same crop mapping as the shader: output pixel -> source point around the
  // crop centre, then bilinear sampling (pixel centres, edge clamp).
  const crop = params.crop;
  const geometry =
    crop && isUsableCrop(crop) ? cropGeometry(crop, { width: sw, height: sh }) : undefined;
  const radians = ((geometry?.angle ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = geometry?.centerX ?? sw / 2;
  const centerY = geometry?.centerY ?? sh / 2;
  const cropOutput = geometry
    ? cropOutputSize(crop as Exclude<typeof crop, undefined>, { width: sw, height: sh })
    : undefined;
  const logicalWidth = cropOutput ? Math.max(1, Math.round(cropOutput.width)) : sw;
  const logicalHeight = cropOutput ? Math.max(1, Math.round(cropOutput.height)) : sh;
  const scaleX = logicalWidth / size.width;
  const scaleY = logicalHeight / size.height;
  const same = geometry === undefined && size.width === sw && size.height === sh;

  const px = [0, 0, 0];
  for (let y = 0; y < size.height; y++) {
    const dy = (y + 0.5) * scaleY - logicalHeight / 2;
    for (let x = 0; x < size.width; x++) {
      if (same) {
        const i = (y * sw + x) * 4;
        px[0] = samples[i] ?? 0;
        px[1] = samples[i + 1] ?? 0;
        px[2] = samples[i + 2] ?? 0;
      } else {
        const dx = (x + 0.5) * scaleX - logicalWidth / 2;
        const srcX = centerX + cos * dx - sin * dy;
        const srcY = centerY + sin * dx + cos * dy;
        const fx = srcX - 0.5;
        const fy = srcY - 0.5;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const wx = fx - x0;
        const wy = fy - y0;
        const xa = Math.min(sw - 1, Math.max(0, x0));
        const xb = Math.min(sw - 1, Math.max(0, x0 + 1));
        const ya = Math.min(sh - 1, Math.max(0, y0));
        const yb = Math.min(sh - 1, Math.max(0, y0 + 1));
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
      // The shader's `src` is exactly the position the bilinear tap used (for
      // the identity path, source pixel centre x + 0.5).
      const srcX = same
        ? x + 0.5
        : centerX +
          cos * ((x + 0.5) * scaleX - logicalWidth / 2) -
          sin * ((y + 0.5) * scaleY - logicalHeight / 2);
      const srcY = same
        ? y + 0.5
        : centerY +
          sin * ((x + 0.5) * scaleX - logicalWidth / 2) +
          cos * ((y + 0.5) * scaleY - logicalHeight / 2);
      const [r, g, b] = developPixel(px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, u, {
        nx: ((x + 0.5) / size.width) * 2 - 1,
        ny: ((y + 0.5) / size.height) * 2 - 1,
        srcX,
        srcY,
        scale: scaleX,
      });
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
  options: ResolveOptions = {},
): Uint8Array {
  const f = renderCpuFloat(header, data, params, size, options);
  const out = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.round(clamp01(f[i] ?? 0) * 255);
  return out;
}
