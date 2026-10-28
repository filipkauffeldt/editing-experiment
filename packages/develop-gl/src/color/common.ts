import { COLOR_TUNING as C } from './tuning';

/** Clamp to 0..1. */
export const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);

export const clamp = (x: number, lo: number, hi: number): number =>
  x <= lo ? lo : x >= hi ? hi : x;

/** Smoothstep with the usual zero derivative at both edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** HSV (h in turns 0..1, s and v 0..1) to RGB in the same range. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hh = (h - Math.floor(h)) * 6;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const rgb: [number, number, number] =
    hh < 1
      ? [c, x, 0]
      : hh < 2
        ? [x, c, 0]
        : hh < 3
          ? [0, c, x]
          : hh < 4
            ? [0, x, c]
            : hh < 5
              ? [x, 0, c]
              : [c, 0, x];
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

/** RGB 0..1 to HSV; hue is in turns 0..1. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = (g - b) / d / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    h -= Math.floor(h);
  }
  return [h, mx > 0 ? d / mx : 0, mx];
}

/** Smooth weight of one hue band for a hue in turns. */
export function bandWeight(hue: number, centerDegrees: number): number {
  let distance = Math.abs(hue * 360 - centerDegrees);
  distance = Math.min(distance, 360 - distance);
  const t = clamp(1 - distance / C.bandHalfWidth, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Luma of encoded RGB (Rec. 709 weights, as elsewhere in the pipeline). */
export const encodedLuma = (r: number, g: number, b: number): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Piecewise-linear lookup over a sorted xs/ys table clamped at both ends. */
export function interpolate(
  x: number,
  xs: ReadonlyArray<number>,
  ys: ReadonlyArray<number>,
): number {
  if (x <= xs[0]!) return ys[0]!;
  const last = xs.length - 1;
  if (x >= xs[last]!) return ys[last]!;
  let i = 1;
  while (i < last && xs[i]! <= x) i++;
  const x0 = xs[i - 1]!;
  const x1 = xs[i]!;
  const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
  return ys[i - 1]! + (ys[i]! - ys[i - 1]!) * t;
}
