import type { EditParams } from '@ee/contracts';
import { SLIDER_SPECS, type SliderParam } from '@ee/contracts';
import { clamp, clamp01 } from './common';
import { srgbDecode, srgbEncode } from '../ops';
import { COLOR_TUNING as C } from './tuning';

/**
 * Lightroom's parametric tone curve.
 *
 * RAWmakase (`develop/parametric.rs`, MIT) applies Shadows below the midtone
 * split and Highlights above it, then Darks and Lights, in gamma-2.2 encoded
 * space, followed by a monotone pass. Its exact region shapes come from measured
 * binary tables; this port keeps the same region placement, split behaviour and
 * monotonicity but uses smooth analytic bumps instead of those tables.
 */

const value = (params: EditParams, name: SliderParam): number => {
  const raw = params[name];
  const neutral = SLIDER_SPECS[name].neutral ?? 0;
  if (raw === undefined || !Number.isFinite(raw)) return neutral;
  return Math.min(SLIDER_SPECS[name].max, Math.max(SLIDER_SPECS[name].min, raw));
};

export interface ParametricSplit {
  shadow: number;
  midtone: number;
  highlight: number;
}

/** Split points in encoded units 0..1, kept in order. */
export function parametricSplits(params: EditParams): ParametricSplit {
  const shadow = value(params, 'ParametricShadowSplit') / 100;
  const midtone = value(params, 'ParametricMidtoneSplit') / 100;
  const highlight = value(params, 'ParametricHighlightSplit') / 100;
  return {
    shadow: clamp(shadow, 0, 0.98),
    midtone: clamp(midtone, shadow + 0.005, 0.995),
    highlight: clamp(highlight, midtone + 0.005, 1),
  };
}

/** True when any parametric region slider is non-zero. */
export function parametricActive(params: EditParams): boolean {
  return (
    value(params, 'ParametricShadows') !== 0 ||
    value(params, 'ParametricDarks') !== 0 ||
    value(params, 'ParametricLights') !== 0 ||
    value(params, 'ParametricHighlights') !== 0
  );
}

/** sin^2 bump over `from..to`, zero at both ends. */
const bump = (x: number, from: number, to: number): number => {
  if (to <= from || x <= from || x >= to) return 0;
  const s = Math.sin((Math.PI * (x - from)) / (to - from));
  return s * s;
};

/** The curve's output at encoded value `x` (before the monotone pass). */
export function parametricCurveAt(params: EditParams, x: number): number {
  if (!parametricActive(params)) return clamp01(x);
  const splits = parametricSplits(params);
  const gamma = C.parametricGamma;
  // Work in the gamma-2.2 encoded domain, as RAWmakase does: the pipeline's
  // curves are sRGB-encoded, so decode to linear first, then gamma-2.2 encode.
  const w = Math.pow(clamp01(srgbDecode(clamp01(x))), 1 / gamma);
  const shadows = value(params, 'ParametricShadows') / 100;
  const darks = value(params, 'ParametricDarks') / 100;
  const lights = value(params, 'ParametricLights') / 100;
  const highlights = value(params, 'ParametricHighlights') / 100;
  const delta =
    shadows * C.parametricStrength.shadows * bump(w, 0, splits.midtone) +
    darks * C.parametricStrength.darks * bump(w, splits.shadow, splits.midtone) +
    lights * C.parametricStrength.lights * bump(w, splits.midtone, splits.highlight) +
    highlights * C.parametricStrength.highlights * bump(w, splits.midtone, 1);
  const y = clamp01(w + delta);
  return srgbEncode(clamp01(Math.pow(y, gamma)));
}

/**
 * Samples the parametric curve into a monotone table of `size` entries over
 * encoded 0..1, or null when every region is neutral.
 */
export function buildParametricLut(params: EditParams, size: number): Float32Array | null {
  if (!parametricActive(params)) return null;
  const lut = new Float32Array(size);
  let max = 0;
  for (let i = 0; i < size; i++) {
    const y = parametricCurveAt(params, i / (size - 1));
    max = Math.max(max, y);
    lut[i] = max;
  }
  return lut;
}
