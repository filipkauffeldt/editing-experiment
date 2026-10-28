/**
 * Image pyramid shared by the neighbourhood ops (CPU reference; the shaders
 * build the same thing with one bilinear tap per output pixel).
 *
 * Level `k+1` pixel `(i, j)` is the mean of the 2x2 block `(2i..2i+1, 2j..2j+1)` of
 * level `k`, with coordinates clamped at the border, so a level is `ceil(n / 2)`
 * wide. Sampling uses texel coordinates in which pixel `i` has its centre at
 * `i + 0.5` (the GL convention), with bilinear weights and clamp-to-edge.
 */

export interface Plane {
  w: number;
  h: number;
  /** Interleaved channels per pixel. */
  c: number;
  data: Float32Array;
}

export const makePlane = (w: number, h: number, c: number): Plane => ({
  w,
  h,
  c,
  data: new Float32Array(w * h * c),
});

/** 2x2 box mean, half the size rounded up. */
export function downsample(p: Plane): Plane {
  const w = Math.ceil(p.w / 2);
  const h = Math.ceil(p.h / 2);
  const out = makePlane(w, h, p.c);
  for (let y = 0; y < h; y++) {
    const y0 = 2 * y;
    const y1 = Math.min(p.h - 1, y0 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = 2 * x;
      const x1 = Math.min(p.w - 1, x0 + 1);
      for (let ch = 0; ch < p.c; ch++) {
        out.data[(y * w + x) * p.c + ch] =
          ((p.data[(y0 * p.w + x0) * p.c + ch] ?? 0) +
            (p.data[(y0 * p.w + x1) * p.c + ch] ?? 0) +
            (p.data[(y1 * p.w + x0) * p.c + ch] ?? 0) +
            (p.data[(y1 * p.w + x1) * p.c + ch] ?? 0)) *
          0.25;
      }
    }
  }
  return out;
}

/** Bilinear sample of channel `ch` at texel coordinates `(u, v)` (pixel centres at `i + 0.5`), clamped to the edge. */
export function sampleAt(p: Plane, u: number, v: number, ch: number): number {
  const fx = u - 0.5;
  const fy = v - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = Math.min(p.w - 1, Math.max(0, x0));
  const xb = Math.min(p.w - 1, Math.max(0, x0 + 1));
  const ya = Math.min(p.h - 1, Math.max(0, y0));
  const yb = Math.min(p.h - 1, Math.max(0, y0 + 1));
  const at = (x: number, y: number): number => p.data[(y * p.w + x) * p.c + ch] ?? 0;
  const top = at(xa, ya) * (1 - tx) + at(xb, ya) * tx;
  const bottom = at(xa, yb) * (1 - tx) + at(xb, yb) * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Levels `0..count` (inclusive, so `count + 1` planes); level 0 is `base` itself. */
export function buildPyramid(base: Plane, count: number): Plane[] {
  const levels = [base];
  for (let k = 0; k < count; k++) levels.push(downsample(levels[k] as Plane));
  return levels;
}

/** Level `k` of a pyramid sampled at output pixel position `(px, py)` (pixel centres at `x + 0.5`). */
export function sampleLevel(levels: readonly Plane[], k: number, px: number, py: number): number {
  const s = 2 ** k;
  return sampleAt(levels[k] as Plane, px / s, py / s, 0);
}

/** The pyramid at fractional level `lambda` (clamped to the available levels): a mix of two bilinear levels. */
export function sampleBlur(
  levels: readonly Plane[],
  lambda: number,
  px: number,
  py: number,
): number {
  const top = levels.length - 1;
  const l = Math.min(top, Math.max(0, lambda));
  const k = Math.min(top - 1, Math.floor(l));
  const f = l - k;
  const a = sampleLevel(levels, k, px, py);
  if (f === 0) return a;
  return a + (sampleLevel(levels, k + 1, px, py) - a) * f;
}
