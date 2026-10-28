import type { EditParams } from '@ee/contracts';
import { SLIDER_SPECS, type SliderParam } from '@ee/contracts';
import { CLARITY, DEHAZE, DENOISE, SHARPEN, TEXTURE } from './tuning';

/** Piecewise linear interpolation of `ys` over increasing `xs`, clamped at both ends. */
export function interpolate(x: number, xs: readonly number[], ys: readonly number[]): number {
  const last = xs.length - 1;
  if (x <= (xs[0] ?? 0)) return ys[0] ?? 0;
  if (x >= (xs[last] ?? 0)) return ys[last] ?? 0;
  let i = 1;
  while (i < last && (xs[i] ?? 0) <= x) i++;
  const x0 = xs[i - 1] ?? 0;
  const x1 = xs[i] ?? 0;
  const t = (x - x0) / (x1 - x0);
  const y0 = ys[i - 1] ?? 0;
  return y0 + ((ys[i] ?? 0) - y0) * t;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** A slider value from `params`, clamped to its range, or its neutral value when absent. */
export function slider(params: EditParams, name: SliderParam): number {
  const spec = SLIDER_SPECS[name];
  const raw = params[name];
  const value = raw === undefined || !Number.isFinite(raw) ? (spec.neutral ?? 0) : raw;
  return Math.min(spec.max, Math.max(spec.min, value));
}

export interface LumaDenoise {
  amount: number;
  detail: number;
  contrast: number;
}

export interface ChromaDenoise {
  /** Each band's threshold as a multiple of that band's noise (finest first), before the noise-dependent factor. */
  thresholds: number[];
}

export interface Sharpen {
  /** Gaussian sigma in full-resolution pixels. */
  sigma: number;
  gain: number;
  threshold: number;
  halo: number;
  dark: number;
  /** Amount, 0..1 (Lightroom's Sharpness / 150). */
  amount: number;
}

/** The neighbourhood controls resolved from `EditParams`; each field is null/0 when its control is neutral. */
export interface NeighbourhoodParams {
  /** log2 strength of Texture (0 = off). */
  texture: number;
  /** Clarity weights, `CLARITY.scales.length * CLARITY.knots`, scale-major; null = off. */
  clarity: Float32Array | null;
  /** Dehaze, -1..1 (0 = off). */
  dehaze: number;
  luma: LumaDenoise | null;
  chroma: ChromaDenoise | null;
  sharpen: Sharpen | null;
}

/** Texture's log2 strength for a slider value in -1..1. */
export const textureStrength = (amount: number): number =>
  interpolate(amount, TEXTURE.amounts, TEXTURE.strength);

/**
 * Clarity weights at `amount` (-1..1): linear from 0 to the fit at +-0.5, then
 * between the fits at +-0.5 and +-1 (RAWmakase `clarity.rs`).
 */
export function clarityWeights(amount: number): Float32Array {
  const a = Math.min(1, Math.max(-1, amount));
  const half = a < 0 ? CLARITY.weightsMinus50 : CLARITY.weightsPlus50;
  const full = a < 0 ? CLARITY.weightsMinus100 : CLARITY.weightsPlus100;
  const m = Math.abs(a);
  const out = new Float32Array(CLARITY.scales.length * CLARITY.knots);
  for (let s = 0; s < CLARITY.scales.length; s++) {
    for (let k = 0; k < CLARITY.knots; k++) {
      const h = half[s]?.[k] ?? 0;
      const f = full[s]?.[k] ?? 0;
      out[s * CLARITY.knots + k] = m <= 0.5 ? (h * m) / 0.5 : h + ((f - h) * (m - 0.5)) / 0.5;
    }
  }
  return out;
}

/** Dehaze's `omega` (how much of the measured haze is removed) at `|amount|`, 0..1. */
export const dehazeOmega = (amount: number): number =>
  interpolate(Math.abs(amount), DEHAZE.omegaAmounts, DEHAZE.omega);

/** Value of a quarter-spaced table (0, 25, 50, 75, 100) at `v` in 0..1. */
function atQuarters(table: readonly number[], v: number): number {
  const x = clamp01(v) * 4;
  const i = Math.min(3, Math.floor(x));
  const a = table[i] ?? 0;
  return a + ((table[i + 1] ?? 0) - a) * (x - i);
}

export function resolveChroma(amount: number, detail: number, smoothness: number): ChromaDenoise {
  const c = DENOISE.chroma;
  const thresholds: number[] = [];
  for (let l = 0; l < DENOISE.levels; l++) {
    const row = c.thresholds[l] ?? [];
    // Linear from none at Amount 0 up to the first measured amount, then between measured amounts.
    const a = clamp01(amount);
    const base =
      a <= (c.amounts[0] ?? 0.1)
        ? ((row[0] ?? 0) * a) / (c.amounts[0] ?? 0.1)
        : interpolate(a, c.amounts, row);
    thresholds.push(
      base * atQuarters(c.detail[l] ?? [], detail) * atQuarters(c.smoothness[l] ?? [], smoothness),
    );
  }
  return { thresholds };
}

export function resolveSharpen(
  sharpness: number,
  radius: number,
  detail: number,
  masking: number,
): Sharpen | null {
  const amount = sharpness / SHARPEN.sliderMax;
  if (!(amount > 0)) return null;
  return {
    sigma: interpolate(radius, SHARPEN.radius, SHARPEN.radiusSigma),
    gain:
      SHARPEN.gain *
      interpolate(radius, SHARPEN.radius, SHARPEN.radiusGain) *
      interpolate(detail, SHARPEN.unit, SHARPEN.detailGain),
    threshold: interpolate(masking, SHARPEN.unit, SHARPEN.maskingThreshold),
    halo: SHARPEN.halo * interpolate(detail, SHARPEN.unit, SHARPEN.detailHalo),
    dark: SHARPEN.dark,
    amount: Math.min(1, amount),
  };
}

export function resolveNeighbourhood(params: EditParams): NeighbourhoodParams {
  const texture = slider(params, 'Texture') / 100;
  const clarity = slider(params, 'Clarity2012') / 100;
  const luma = slider(params, 'LuminanceSmoothing') / 100;
  const color = slider(params, 'ColorNoiseReduction') / 100;
  return {
    texture: textureStrength(texture),
    clarity: clarity === 0 ? null : clarityWeights(clarity),
    dehaze: slider(params, 'Dehaze') / 100,
    luma:
      luma > 0
        ? {
            amount: luma,
            detail: slider(params, 'LuminanceNoiseReductionDetail') / 100,
            contrast: slider(params, 'LuminanceNoiseReductionContrast') / 100,
          }
        : null,
    chroma:
      color > 0
        ? resolveChroma(
            color,
            slider(params, 'ColorNoiseReductionDetail') / 100,
            slider(params, 'ColorNoiseReductionSmoothness') / 100,
          )
        : null,
    sharpen: resolveSharpen(
      slider(params, 'Sharpness'),
      slider(params, 'SharpenRadius'),
      slider(params, 'SharpenDetail') / 100,
      slider(params, 'SharpenEdgeMasking') / 100,
    ),
  };
}

export const hasLocalContrast = (n: NeighbourhoodParams): boolean =>
  n.texture !== 0 || n.clarity !== null || n.dehaze !== 0;
export const hasDenoise = (n: NeighbourhoodParams): boolean => n.luma !== null || n.chroma !== null;
