import { TUNING } from './tuning';

/**
 * The develop operations as small pure functions (CPU reference). `glsl.ts`
 * mirrors each one with the same name; `test/parity.browser.test.ts` keeps the
 * two in agreement. Scalars named `e` are sRGB-encoded ("perceptual") values,
 * `y` / `x` are linear light. Slider arguments are normalised to -1..1.
 */

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** sRGB OETF; extends smoothly above 1 and is 0 for negative input. */
export function srgbEncode(x: number): number {
  if (x <= 0.0031308) return Math.max(x, 0) * 12.92;
  return 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** Inverse of {@link srgbEncode}; negative input gives 0. */
export function srgbDecode(e: number): number {
  if (e <= 0.04045) return Math.max(e, 0) / 12.92;
  return Math.pow((e + 0.055) / 1.055, 2.4);
}

export function luminance(r: number, g: number, b: number): number {
  const [wr, wg, wb] = TUNING.luma;
  return wr * r + wg * g + wb * b;
}

/** Exposure: a gain of `2^stops` on linear light. */
export function exposureGain(stops: number): number {
  return Math.pow(2, stops);
}

/**
 * Highlights and Shadows as a change in stops that fades in and out over the
 * tonal range (a luminance mask, no local tone mapping). Multiplying keeps black
 * at black and lets a negative Highlights pull values above 1.0 back down.
 * Returns the luminance after both adjustments. The masks read the input
 * luminance so the two sliders do not interact.
 */
export function highlightsShadows(y: number, highlights: number, shadows: number): number {
  const e = srgbEncode(y);
  const h = TUNING.highlightsMask;
  const s = TUNING.shadowsMask;
  const stops =
    highlights * TUNING.highlightsStops * smoothstep(h.from, h.to, e) +
    shadows * TUNING.shadowsStops * (1 - smoothstep(s.from, s.to, e));
  return y * Math.pow(2, stops);
}

/** Exponent of the contrast curve for a contrast slider value. */
export function contrastGamma(contrast: number): number {
  return Math.pow(2, TUNING.contrastExponent * contrast);
}

/**
 * Contrast: an S-curve on encoded luminance that pins black, white (1.0) and the
 * mid-grey pivot and bends the two halves with `gamma` (>1 = more contrast).
 * Each half is a power curve, so the curve is C1 at the pivot and invertible
 * (gamma < 1 is the exact inverse S). Above 1.0 it is the identity.
 */
export function contrastCurve(e: number, gamma: number): number {
  const m = srgbEncode(TUNING.midGrey);
  if (e >= 1) return e;
  if (e <= m) return m * Math.pow(e / m, gamma);
  return 1 - (1 - m) * Math.pow((1 - e) / (1 - m), gamma);
}

/**
 * Whites and Blacks: move the two ends of the encoded range. Each adds a shift
 * weighted by `(distance from that end)^falloff`, so it is strongest at the end
 * point and leaves the middle alone. Positive Whites brightens the top (pushes
 * towards clipping), negative pulls white down; positive Blacks lifts black,
 * negative crushes it.
 */
export function whitesBlacks(e: number, whites: number, blacks: number): number {
  const c = clamp(e, 0, 1);
  return (
    e +
    whites * TUNING.whitesStrength * Math.pow(c, TUNING.endpointFalloff) +
    blacks * TUNING.blacksStrength * Math.pow(1 - c, TUNING.endpointFalloff)
  );
}

export interface ToneParams {
  contrastGamma: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
}

/**
 * Tone luminance mapping: Highlights/Shadows, then Contrast, then Whites/Blacks
 * (so the end points the user sets are not moved by the contrast curve).
 * Returns the new linear luminance for input luminance `y`.
 */
export function toneLuminance(y: number, t: ToneParams): number {
  const y1 = highlightsShadows(y, t.highlights, t.shadows);
  const e2 = contrastCurve(srgbEncode(y1), t.contrastGamma);
  const e3 = whitesBlacks(e2, t.whites, t.blacks);
  return srgbDecode(e3);
}

/**
 * Applies the tone mapping to an RGB pixel as a gain on luminance, which keeps
 * hue and the RGB ratios. The gain is computed from a floored luminance so
 * near-black noise is not amplified.
 */
export function toneRgb(r: number, g: number, b: number, t: ToneParams): [number, number, number] {
  const y = Math.max(luminance(r, g, b), TUNING.luminanceFloor);
  const gain = toneLuminance(y, t) / y;
  return [r * gain, g * gain, b * gain];
}

/**
 * Highlight roll-off for one channel of linear light: identity up to the knee,
 * then an extended-Reinhard shoulder (C1 at the knee) that reaches exactly 1 at
 * `shoulderWhite`. Negative input is clamped to 0.
 */
export function shoulder(x: number): number {
  const k = TUNING.shoulderKnee;
  if (x <= k) return Math.max(x, 0);
  if (x >= TUNING.shoulderWhite) return 1;
  const t = (x - k) / (1 - k);
  const w = (TUNING.shoulderWhite - k) / (1 - k);
  return k + (1 - k) * ((t * (1 + t / (w * w))) / (1 + t));
}

/** Looks up a tone curve table (`size` values in 0..1) at encoded value `e` with linear interpolation. */
export function lookupCurve(
  table: ArrayLike<number>,
  offset: number,
  stride: number,
  e: number,
): number {
  const size = Math.floor(table.length / stride);
  const p = clamp(e, 0, 1) * (size - 1);
  const i0 = Math.min(Math.floor(p), size - 2);
  const f = p - i0;
  const a = table[offset + i0 * stride] ?? 0;
  const b = table[offset + (i0 + 1) * stride] ?? 0;
  return a + (b - a) * f;
}

/** Hue in degrees (0..360) of an RGB triple, 0 for greys. */
export function hueDegrees(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  if (d <= 0) return 0;
  let h: number;
  if (mx === r) h = (g - b) / d;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * Vibrance and Saturation on sRGB-encoded RGB (0..1). Saturation scales the
 * chroma around luma uniformly. Vibrance scales it by `1 + vibrance * w` where
 * `w` is large for muted colours and small for saturated ones, and is damped
 * around skin hues so portraits do not turn orange.
 */
export function vibranceSaturation(
  r: number,
  g: number,
  b: number,
  vibrance: number,
  saturation: number,
): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const s = mx > 0 ? (mx - mn) / mx : 0;
  let dh = Math.abs(hueDegrees(r, g, b) - TUNING.skinHue);
  dh = Math.min(dh, 360 - dh);
  const skin = 1 - smoothstep(0, TUNING.skinHueWidth, dh);
  const weight = (1 - s) * (1 - TUNING.skinProtection * skin);
  const factor = Math.max(0, (1 + vibrance * weight) * (1 + saturation));
  const l = luminance(r, g, b);
  return [l + (r - l) * factor, l + (g - l) * factor, l + (b - l) * factor];
}
