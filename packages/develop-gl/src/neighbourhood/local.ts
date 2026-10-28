import { luminance } from '../ops';
import { TUNING } from '../tuning';
import { dehazeOmega, type NeighbourhoodParams } from './params';
import { makePlane, sampleBlur, type Plane } from './pyramid';
import { CLARITY, DEHAZE, MAX_LEVEL, TEXTURE } from './tuning';

/**
 * Texture, Clarity and Dehaze, as pure functions over an analysis pyramid
 * (the log2 luminance of the image, see `pyramid.ts`). `glsl.ts` mirrors them.
 * Positions `(px, py)` are output pixels with the centre of pixel `x` at `x + 0.5`.
 */

/** How the output relates to the full-resolution photo, for the ops whose sizes are in photo pixels. */
export interface LocalGeometry {
  /** log2 of output pixels per full-resolution pixel. */
  logScale: number;
  /** Long edge of the whole frame (not just the crop) in output pixels. */
  fullLongEdge: number;
}

/** The log2 luminance the pyramid is made of. */
export const analysisValue = (r: number, g: number, b: number): number =>
  Math.log2(Math.max(luminance(r, g, b), TUNING.luminanceFloor));

/**
 * Texture's band-pass detail in log2 units for a strength of 1: six bands of
 * the pyramid, each `G(l) - G(l + 1)` at fractional levels that follow the
 * output scale (so band `l` is `2^l` full-resolution pixels at any resolution),
 * compressed where strong and weighted.
 */
export function textureDetail(
  levels: readonly Plane[],
  px: number,
  py: number,
  geometry: LocalGeometry,
): number {
  let sum = 0;
  let upper = sampleBlur(levels, geometry.logScale, px, py);
  for (let l = 0; l < TEXTURE.weights.length; l++) {
    const lower = sampleBlur(levels, geometry.logScale + l + 1, px, py);
    const band = upper - lower;
    const x = band / (TEXTURE.thresholds[l] as number);
    sum += ((TEXTURE.weights[l] as number) * band) / (1 + x * x);
    upper = lower;
  }
  return sum;
}

/** Fractional pyramid level and tap spacing (output pixels) of Clarity's blur `scale`. */
export function clarityLevel(scale: number, geometry: LocalGeometry): number {
  const sigma = (CLARITY.scales[scale] as number) * geometry.fullLongEdge;
  return Math.min(MAX_LEVEL, Math.max(0, Math.log2(Math.max(sigma, 1e-3) / CLARITY.sigmaPerLevel)));
}

/** Edge-aware blur of the analysis plane around `a` (the pixel's own value) at fractional level `lambda`. */
export function edgeAwareBlur(
  levels: readonly Plane[],
  lambda: number,
  px: number,
  py: number,
  a: number,
): number {
  const r = 2 ** lambda;
  let sum = 0;
  let norm = 0;
  for (const tap of CLARITY.taps) {
    const v = sampleBlur(levels, lambda, px + tap.x * r, py + tap.y * r);
    const d = (v - a) / CLARITY.range;
    const w = tap.w / (1 + d * d);
    sum += w * v;
    norm += w;
  }
  return sum / norm;
}

/**
 * Clarity's log2 gain at a pixel with analysis value `a`: the weighted sum of
 * `a - blur` over the four scales, the weights read at the local base level
 * (the coarsest blur) relative to the photo's `key`.
 */
export function clarityGain(
  levels: readonly Plane[],
  px: number,
  py: number,
  a: number,
  weights: Float32Array,
  key: number,
  geometry: LocalGeometry,
): number {
  const scales = CLARITY.scales.length;
  const blurs: number[] = [];
  for (let s = 0; s < scales; s++) {
    blurs.push(edgeAwareBlur(levels, clarityLevel(s, geometry), px, py, a));
  }
  const base = blurs[scales - 1] as number;
  const step = (CLARITY.knotHigh - CLARITY.knotLow) / (CLARITY.knots - 1);
  const u = Math.min(CLARITY.knots - 1, Math.max(0, (base - key - CLARITY.knotLow) / step));
  const k = Math.min(CLARITY.knots - 2, Math.floor(u));
  const t = u - k;
  let gain = 0;
  for (let s = 0; s < scales; s++) {
    const row = s * CLARITY.knots;
    const w = (weights[row + k] as number) * (1 - t) + (weights[row + k + 1] as number) * t;
    gain += w * (a - (blurs[s] as number));
  }
  return Math.min(CLARITY.maxGain, Math.max(-CLARITY.maxGain, gain));
}

/**
 * Dehaze for one pixel `p` (linear RGB, exposure applied). `gain` is everything
 * applied to the photo since the measurement (exposure and the local gain), so
 * the airlight is scaled the same. Positive amounts remove `density` of haze as
 * `J = (p - A) / t + A`; negative ones blend towards the airlight.
 */
export function dehazePixel(
  p: readonly [number, number, number],
  gain: number,
  airlight: readonly [number, number, number],
  density: number,
  amount: number,
): [number, number, number] {
  if (amount < 0) {
    const k = DEHAZE.veilStrength * -amount;
    return [
      p[0] + (gain * airlight[0] - p[0]) * k,
      p[1] + (gain * airlight[1] - p[1]) * k,
      p[2] + (gain * airlight[2] - p[2]) * k,
    ];
  }
  const t = Math.max(1 - dehazeOmega(amount) * density, DEHAZE.transmissionFloor);
  const j = p.map((v, c) => {
    const a = gain * (airlight[c] as number);
    return (v - a) / t + a;
  }) as [number, number, number];
  const yp = luminance(p[0], p[1], p[2]);
  const ratio = yp > 1e-6 ? Math.max(0, luminance(j[0], j[1], j[2]) / yp) : 0;
  return [
    Math.max(j[0], DEHAZE.channelFloor * p[0] * ratio),
    Math.max(j[1], DEHAZE.channelFloor * p[1] * ratio),
    Math.max(j[2], DEHAZE.channelFloor * p[2] * ratio),
  ];
}

export interface LocalInputs {
  /** Linear RGB (exposure applied) in `.rgb`, and the analysis value in `.a`: 4 channels. */
  image: Plane;
  /** Pyramid of the analysis plane, levels `0..MAX_LEVEL`. */
  levels: readonly Plane[];
  geometry: LocalGeometry;
  exposureGain: number;
  /** Clarity key level in log2 luminance with exposure applied. */
  key: number;
  airlight: readonly [number, number, number];
  /** Haze density at an output pixel (0 outside Dehaze). */
  densityAt: (px: number, py: number) => number;
}

/** Applies Texture, Clarity then Dehaze to `image`; returns a new 3-channel RGB plane. */
export function applyLocal(n: NeighbourhoodParams, input: LocalInputs): Plane {
  const { image, levels, geometry } = input;
  const out = makePlane(image.w, image.h, 3);
  for (let y = 0; y < image.h; y++) {
    for (let x = 0; x < image.w; x++) {
      const i = (y * image.w + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;
      const a = image.data[i + 3] as number;
      let gain = 0;
      if (n.texture !== 0) gain += n.texture * textureDetail(levels, px, py, geometry);
      if (n.clarity) {
        gain += clarityGain(levels, px, py, a, n.clarity, input.key, geometry);
      }
      gain = Math.min(CLARITY.maxGain, Math.max(-CLARITY.maxGain, gain));
      const k = 2 ** gain;
      let rgb: [number, number, number] = [
        (image.data[i] as number) * k,
        (image.data[i + 1] as number) * k,
        (image.data[i + 2] as number) * k,
      ];
      if (n.dehaze !== 0) {
        rgb = dehazePixel(
          rgb,
          input.exposureGain * k,
          input.airlight,
          input.densityAt(px, py),
          n.dehaze,
        );
      }
      out.data[(y * image.w + x) * 3] = rgb[0];
      out.data[(y * image.w + x) * 3 + 1] = rgb[1];
      out.data[(y * image.w + x) * 3 + 2] = rgb[2];
    }
  }
  return out;
}
