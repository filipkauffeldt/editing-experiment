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
import { copySize, densityAtUv, measureHaze } from './neighbourhood/haze';
import { analysisValue, applyLocal } from './neighbourhood/local';
import {
  bandThresholds,
  blockNoise,
  denoise,
  estimateNoise,
  fromSqrtSpace,
  toSqrtSpace,
} from './neighbourhood/denoise';
import {
  hasDenoise,
  hasLocalContrast,
  resolveNeighbourhood,
  type NeighbourhoodParams,
} from './neighbourhood/params';
import { buildPyramid, downsample, makePlane, type Plane } from './neighbourhood/pyramid';
import { sharpenPlane } from './neighbourhood/sharpen';
import { MAX_LEVEL } from './neighbourhood/tuning';
import { lensGain, lensSample, type LensSample, type LensUniforms } from './lens/model';

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

/**
 * Camera RGB (unity white balance) to linear Rec.709 with white balance, highlight
 * clipping, calibration and exposure applied: the scene-referred image the
 * neighbourhood ops (Texture, Clarity, Dehaze, noise reduction) work on.
 */
export function basePixel(
  r: number,
  g: number,
  b: number,
  u: DevelopUniforms,
  gain = 1,
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
  const clipped = clipHighlights([r, g, b], u.multipliers);
  // The lens vignetting gain applies to the clipped, neutralised light, so blown corners brighten too.
  const wr = clipped[0] * gain;
  const wg = clipped[1] * gain;
  const wb = clipped[2] * gain;
  let lr = m[0] * wr + m[1] * wg + m[2] * wb;
  let lg = m[3] * wr + m[4] * wg + m[5] * wb;
  let lb = m[6] * wr + m[7] * wg + m[8] * wb;
  // Calibration sits next to the camera matrix, before exposure and tone.
  [lr, lg, lb] = applyCalibration([lr, lg, lb], u.calibration);
  return [lr * k, lg * k, lb * k];
}

/** Linear light (after {@link basePixel}) to sRGB-encoded colour: tone, curves, colour. Not clamped. */
export function colorPixel(
  lr: number,
  lg: number,
  lb: number,
  u: DevelopUniforms,
): [number, number, number] {
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
  return applyColorGrading(er, eg, eb, u.grading);
}

/** Vignette and grain, the last stage (after sharpening). Not clamped. */
export function effectsPixel(
  er: number,
  eg: number,
  eb: number,
  u: DevelopUniforms,
  position?: PixelPosition,
): [number, number, number] {
  if (!position) return [er, eg, eb];
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
  return [er, eg, eb];
}

/** One pixel: camera RGB (unity white balance) to display-referred sRGB-encoded RGB in 0..1. */
export function developPixel(
  r: number,
  g: number,
  b: number,
  u: DevelopUniforms,
  position?: PixelPosition,
  gain = 1,
): [number, number, number] {
  const [lr, lg, lb] = basePixel(r, g, b, u, gain);
  const [cr, cg, cb] = colorPixel(lr, lg, lb, u);
  const [er, eg, eb] = effectsPixel(cr, cg, cb, u, position);
  return [clamp01(er), clamp01(eg), clamp01(eb)];
}

export interface RenderSize {
  width: number;
  height: number;
}

/** Bilinear sample of the camera RGB at source position `(sx, sy)` (pixel centres at +0.5), edge clamped. */
function sampleSource(
  samples: Float32Array,
  sw: number,
  sh: number,
  sx: number,
  sy: number,
  px: number[],
): void {
  const fx = sx - 0.5;
  const fy = sy - 0.5;
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

const lensScratch: LensSample = { gx: 0, gy: 0, rx: 0, ry: 0, bx: 0, by: 0 };
const channelScratch = [0, 0, 0];

/**
 * Camera RGB for the corrected-frame position `(sx, sy)` through the lens correction: green at the
 * recorded position, red and blue displaced by the lateral CA. Returns the vignetting gain.
 */
export function sampleLensed(
  samples: Float32Array,
  sw: number,
  sh: number,
  lens: LensUniforms,
  sx: number,
  sy: number,
  px: number[],
): number {
  if (!lens.active) {
    sampleSource(samples, sw, sh, sx, sy, px);
    return 1;
  }
  // The corrected frame repeats its edge outside the picture, as the shader clamps.
  lensSample(lens, Math.min(sw, Math.max(0, sx)), Math.min(sh, Math.max(0, sy)), lensScratch);
  sampleSource(samples, sw, sh, lensScratch.gx, lensScratch.gy, px);
  if (lens.ca) {
    sampleSource(samples, sw, sh, lensScratch.rx, lensScratch.ry, channelScratch);
    px[0] = channelScratch[0] ?? 0;
    sampleSource(samples, sw, sh, lensScratch.bx, lensScratch.by, channelScratch);
    px[2] = channelScratch[2] ?? 0;
  }
  const sourceX = Math.min(sw, Math.max(0, lensScratch.gx));
  const sourceY = Math.min(sh, Math.max(0, lensScratch.gy));
  return lensGain(lens, sourceX, sourceY);
}

/** Taps per axis of the measurement copy when it is smaller than the photo (the GPU uses the same). */
export const MEASURE_TAPS = 4;

/**
 * The measurement copy of the whole photo for Dehaze and Clarity: linear RGB at
 * Exposure 0 with white balance applied, `MEASURE_TAPS`^2 bilinear taps per
 * copy pixel. 4 channels, alpha unused.
 */
export function measureCopy(
  header: LinearImageHeader,
  samples: Float32Array,
  u: DevelopUniforms,
): Plane {
  const { width: sw, height: sh } = header;
  const size = copySize(sw, sh);
  const taps = size.width < sw || size.height < sh ? MEASURE_TAPS : 1;
  const unit = { ...u, exposureGain: 1 };
  const copy = makePlane(size.width, size.height, 4);
  const px = [0, 0, 0];
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const sum = [0, 0, 0];
      for (let b = 0; b < taps; b++) {
        for (let a = 0; a < taps; a++) {
          const gain = sampleLensed(
            samples,
            sw,
            sh,
            u.lens,
            ((x + (a + 0.5) / taps) * sw) / size.width,
            ((y + (b + 0.5) / taps) * sh) / size.height,
            px,
          );
          const lin = basePixel(px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, unit, gain);
          for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (lin[c] ?? 0);
        }
      }
      const o = (y * size.width + x) * 4;
      for (let c = 0; c < 3; c++) copy.data[o + c] = (sum[c] ?? 0) / (taps * taps);
      copy.data[o + 3] = 1;
    }
  }
  return copy;
}

/**
 * Renders to float RGBA (encoded values in 0..1, alpha 1), resampling bilinearly
 * from the camera data when `size` differs from the image. Pixel centres and
 * edge clamping match the GPU's `LINEAR` / `CLAMP_TO_EDGE` sampling.
 *
 * Order (see ARCHITECTURE.md): base (white balance, exposure) -> noise reduction
 * -> Texture, Clarity, Dehaze -> tone, curves, colour -> sharpening. The
 * neighbourhood stages are whole-image here; the GPU renderer tiles them with halos.
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
  const n = resolveNeighbourhood(params);
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

  /** Source position (pixels) of output pixel centre `(x + 0.5, y + 0.5)`. */
  const sourceOf = (x: number, y: number): [number, number] => {
    const dx = (x + 0.5) * scaleX - logicalWidth / 2;
    const dy = (y + 0.5) * scaleY - logicalHeight / 2;
    return [centerX + cos * dx - sin * dy, centerY + sin * dx + cos * dy];
  };
  const px = [0, 0, 0];
  let gain = 1;
  const fetch = (x: number, y: number): void => {
    if (u.lens.active) {
      const [srcX, srcY] = sourceOf(x, y);
      gain = sampleLensed(samples, sw, sh, u.lens, srcX, srcY, px);
    } else if (same) {
      const i = (y * sw + x) * 4;
      px[0] = samples[i] ?? 0;
      px[1] = samples[i + 1] ?? 0;
      px[2] = samples[i + 2] ?? 0;
    } else {
      const [srcX, srcY] = sourceOf(x, y);
      sampleSource(samples, sw, sh, srcX, srcY, px);
    }
  };

  /** Where output pixel `(x, y)` is, for the vignette and the grain. */
  const positionOf = (x: number, y: number): PixelPosition => {
    const [srcX, srcY] = sourceOf(x, y);
    return {
      nx: ((x + 0.5) / size.width) * 2 - 1,
      ny: ((y + 0.5) / size.height) * 2 - 1,
      srcX,
      srcY,
      scale: scaleX,
    };
  };

  const neighbourhood = hasLocalContrast(n) || hasDenoise(n);
  if (!neighbourhood && !n.sharpen) {
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        fetch(x, y);
        const [r, g, b] = developPixel(
          px[0] ?? 0,
          px[1] ?? 0,
          px[2] ?? 0,
          u,
          positionOf(x, y),
          gain,
        );
        const o = (y * size.width + x) * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = 1;
      }
    }
    return out;
  }

  // Output pixels per header pixel, and per full-resolution pixel (the unit the radii are in).
  const perHeader = size.width / logicalWidth;
  const geometryOut = {
    scale: perHeader * (sw / (header.sourceWidth || sw)),
    fullLongEdge: Math.max(sw, sh) * perHeader,
  };

  // Base: linear light with white balance at Exposure 0. The neighbourhood stages are
  // exposure invariant (they work on ratios and on log values), which lets the GPU cache
  // them while the exposure moves; the exposure is applied after them.
  const unit = { ...u, exposureGain: 1 };
  let lin = makePlane(size.width, size.height, 3);
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      fetch(x, y);
      const rgb = basePixel(px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, unit, gain);
      lin.data.set(rgb, (y * size.width + x) * 3);
    }
  }

  if (hasDenoise(n)) lin = denoiseLinear(lin, n);
  if (hasLocalContrast(n)) {
    lin = localContrast(lin, n, header, samples, u, geometryOut, sourceOf);
  } else {
    for (let i = 0; i < lin.data.length; i++) lin.data[i] = (lin.data[i] ?? 0) * u.exposureGain;
  }

  // Colour. Sharpening needs the clamped picture; without it the effects see the unclamped colour,
  // exactly as in the single develop pass.
  let enc = makePlane(size.width, size.height, 3);
  for (let i = 0; i < size.width * size.height; i++) {
    const [r, g, b] = colorPixel(
      lin.data[i * 3] ?? 0,
      lin.data[i * 3 + 1] ?? 0,
      lin.data[i * 3 + 2] ?? 0,
      u,
    );
    enc.data[i * 3] = r;
    enc.data[i * 3 + 1] = g;
    enc.data[i * 3 + 2] = b;
  }
  if (n.sharpen) {
    for (let i = 0; i < enc.data.length; i++) enc.data[i] = clamp01(enc.data[i] ?? 0);
    enc = sharpenPlane(enc, n.sharpen, geometryOut.scale);
  }
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const i = y * size.width + x;
      const [r, g, b] = effectsPixel(
        enc.data[i * 3] ?? 0,
        enc.data[i * 3 + 1] ?? 0,
        enc.data[i * 3 + 2] ?? 0,
        u,
        positionOf(x, y),
      );
      out[i * 4] = clamp01(r);
      out[i * 4 + 1] = clamp01(g);
      out[i * 4 + 2] = clamp01(b);
      out[i * 4 + 3] = 1;
    }
  }
  return out;
}

/** Noise reduction of a linear RGB plane, measuring the noise on the plane itself. */
function denoiseLinear(lin: Plane, n: NeighbourhoodParams): Plane {
  const p0 = toSqrtSpace(lin.data, lin.w, lin.h, 3);
  const noise = estimateNoise(blockNoise(p0, downsample(p0)));
  return fromSqrtSpace(denoise(p0, bandThresholds(noise, n.luma, n.chroma)));
}

function localContrast(
  lin: Plane,
  n: NeighbourhoodParams,
  header: LinearImageHeader,
  samples: Float32Array,
  u: DevelopUniforms,
  geometry: { scale: number; fullLongEdge: number },
  sourceOf: (x: number, y: number) => [number, number],
): Plane {
  const analysis = makePlane(lin.w, lin.h, 1);
  const image = makePlane(lin.w, lin.h, 4);
  for (let i = 0; i < lin.w * lin.h; i++) {
    const r = lin.data[i * 3] ?? 0;
    const g = lin.data[i * 3 + 1] ?? 0;
    const b = lin.data[i * 3 + 2] ?? 0;
    const a = analysisValue(r, g, b);
    analysis.data[i] = a;
    image.data.set([r, g, b, a], i * 4);
  }
  const levels = buildPyramid(analysis, MAX_LEVEL);

  const needsMeasure = n.clarity !== null || n.dehaze !== 0;
  const haze = needsMeasure ? measureHaze(measureCopy(header, samples, u)) : undefined;
  return applyLocal(n, {
    image,
    levels,
    geometry: { logScale: Math.log2(geometry.scale), fullLongEdge: geometry.fullLongEdge },
    exposureGain: u.exposureGain,
    key: haze?.key ?? 0,
    airlight: haze?.airlight ?? [0, 0, 0],
    densityAt: (px, py) => {
      if (!haze || n.dehaze <= 0) return 0;
      const [sx, sy] = sourceOf(px - 0.5, py - 0.5);
      return densityAtUv(
        haze.density,
        Math.min(1, Math.max(0, sx / header.width)),
        Math.min(1, Math.max(0, sy / header.height)),
      );
    },
  });
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
