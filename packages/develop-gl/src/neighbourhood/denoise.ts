import type { ChromaDenoise, LumaDenoise } from './params';
import { buildPyramid, makePlane, sampleAt, type Plane } from './pyramid';
import { DENOISE } from './tuning';

/**
 * Noise reduction on a Laplacian-style pyramid of the image in square-root
 * space, where sensor noise is about the same at every brightness. Ported from
 * RAWmakase `luminance_noise.rs` and `color_noise.rs` with the same
 * decomposition for both (our pyramid is the box/bilinear one of `pyramid.ts`,
 * not their binomial one) and one noise measurement for all bands.
 *
 * Channels are `Y = (r + 2g + b) / 4`, `c1 = r - g`, `c2 = b - g` of the square
 * roots. Band `l` is `P_l - up(P_{l+1})`; the output of level `l` is
 * `up(output of l+1) + gain * band`, where the gain keeps a band where it
 * stands out from the noise. The coarsest level is left alone.
 */

/** Linear RGB(A) to the square-root space planes (3 channels). */
export function toSqrtSpace(rgba: Float32Array, w: number, h: number, stride: number): Plane {
  const out = makePlane(w, h, 3);
  for (let i = 0; i < w * h; i++) {
    const r = Math.sqrt(Math.max(0, rgba[i * stride] as number));
    const g = Math.sqrt(Math.max(0, rgba[i * stride + 1] as number));
    const b = Math.sqrt(Math.max(0, rgba[i * stride + 2] as number));
    out.data[i * 3] = (r + 2 * g + b) / 4;
    out.data[i * 3 + 1] = r - g;
    out.data[i * 3 + 2] = b - g;
  }
  return out;
}

/** Back to linear RGB (3 channels). */
export function fromSqrtSpace(p: Plane): Plane {
  const out = makePlane(p.w, p.h, 3);
  for (let i = 0; i < p.w * p.h; i++) {
    const y = p.data[i * 3] as number;
    const c1 = p.data[i * 3 + 1] as number;
    const c2 = p.data[i * 3 + 2] as number;
    const g = y - (c1 + c2) / 4;
    out.data[i * 3] = Math.max(0, g + c1) ** 2;
    out.data[i * 3 + 1] = Math.max(0, g) ** 2;
    out.data[i * 3 + 2] = Math.max(0, g + c2) ** 2;
  }
  return out;
}

/** Top-left corners of the noise measurement blocks, evenly spread over a `w` x `h` output. */
export function blockGrid(w: number, h: number): { xs: number[]; ys: number[] } {
  const axis = (n: number, max: number): number[] => {
    const count = Math.min(max, Math.floor(n / DENOISE.block));
    if (count < 1) return [];
    if (count === 1) return [0];
    return Array.from({ length: count }, (_, i) =>
      Math.floor((i * (n - DENOISE.block)) / (count - 1)),
    );
  };
  return { xs: axis(w, DENOISE.maxBlocksX), ys: axis(h, DENOISE.maxBlocksY) };
}

/** `P_l - up(P_{l+1})` of one channel at pixel `(x, y)` of level `l`. */
export const bandAt = (fine: Plane, coarse: Plane, x: number, y: number, ch: number): number =>
  (fine.data[(y * fine.w + x) * fine.c + ch] as number) -
  sampleAt(coarse, (x + 0.5) / 2, (y + 0.5) / 2, ch);

/**
 * RMS of the finest band's luminance and chroma detail in every measurement
 * block (`[luma, chroma]` pairs, one per block, row-major over `blockGrid`).
 */
export function blockNoise(p0: Plane, p1: Plane): Float32Array {
  const { xs, ys } = blockGrid(p0.w, p0.h);
  const out = new Float32Array(xs.length * ys.length * 2);
  const n = DENOISE.block * DENOISE.block;
  let k = 0;
  for (const y0 of ys) {
    for (const x0 of xs) {
      let luma = 0;
      let chroma = 0;
      for (let y = y0; y < y0 + DENOISE.block; y++) {
        for (let x = x0; x < x0 + DENOISE.block; x++) {
          luma += bandAt(p0, p1, x, y, 0) ** 2;
          chroma += bandAt(p0, p1, x, y, 1) ** 2 + bandAt(p0, p1, x, y, 2) ** 2;
        }
      }
      out[k++] = Math.sqrt(luma / n);
      out[k++] = Math.sqrt(chroma / n);
    }
  }
  return out;
}

export interface NoiseLevels {
  luma: number;
  chroma: number;
}

/** The noise of the finest band: the `blockPercentile` smoothest block's RMS, for luma and chroma. */
export function estimateNoise(blocks: ArrayLike<number>): NoiseLevels {
  const count = Math.floor(blocks.length / 2);
  if (count === 0) return { luma: 0, chroma: 0 };
  const pick = (channel: number): number => {
    const v = new Float32Array(count);
    for (let i = 0; i < count; i++) v[i] = blocks[i * 2 + channel] as number;
    v.sort();
    return v[Math.floor(count * DENOISE.blockPercentile)] as number;
  };
  return { luma: pick(0), chroma: pick(1) };
}

export interface BandThresholds {
  luma: number[];
  chroma: number[];
}

/** Per-band thresholds (finest first) in square-root units; 0 disables a band's channel. */
export function bandThresholds(
  noise: NoiseLevels,
  luma: LumaDenoise | null,
  chroma: ChromaDenoise | null,
): BandThresholds {
  const out: BandThresholds = { luma: [], chroma: [] };
  for (let l = 0; l < DENOISE.levels; l++) {
    const decay = DENOISE.coarserNoise ** l;
    let tl = 0;
    if (luma) {
      const L = DENOISE.luma;
      const detail = 2 ** ((0.5 - luma.detail) * (l === 0 ? L.detailFine : L.detailCoarse));
      const contrast = 1 - luma.contrast * (l === 0 ? 0 : L.contrastCoarse);
      tl = noise.luma * decay * L.scale * luma.amount ** L.amountPower * detail * contrast;
    }
    let tc = 0;
    if (chroma) {
      const c = DENOISE.chroma;
      tc =
        (chroma.thresholds[l] as number) *
        noise.chroma *
        decay *
        (noise.chroma / c.referenceNoise) ** (c.noiseExponent[l] as number);
    }
    out.luma.push(tl);
    out.chroma.push(tc);
  }
  return out;
}

export const lumaGain = (threshold: number, energy: number): number =>
  threshold <= 0
    ? 1
    : 1 / (1 + ((threshold * threshold) / Math.max(energy, 1e-20)) ** DENOISE.lumaSteepness);

export const chromaGain = (threshold: number, size: number): number =>
  threshold <= 0
    ? 1
    : 1 / (1 + ((threshold * threshold) / Math.max(size, 1e-20)) ** DENOISE.chroma.steepness);

/** Denoises `p0` (square-root space) with the given band thresholds. */
export function denoise(p0: Plane, thresholds: BandThresholds): Plane {
  const pyramid = buildPyramid(p0, DENOISE.levels);
  let result = pyramid[DENOISE.levels] as Plane;
  for (let l = DENOISE.levels - 1; l >= 0; l--) {
    const fine = pyramid[l] as Plane;
    const coarse = pyramid[l + 1] as Plane;
    const band = makePlane(fine.w, fine.h, 3);
    for (let y = 0; y < fine.h; y++) {
      for (let x = 0; x < fine.w; x++) {
        for (let ch = 0; ch < 3; ch++) {
          band.data[(y * fine.w + x) * 3 + ch] = bandAt(fine, coarse, x, y, ch);
        }
      }
    }
    const out = makePlane(fine.w, fine.h, 3);
    const tl = thresholds.luma[l] as number;
    const tc = thresholds.chroma[l] as number;
    for (let y = 0; y < fine.h; y++) {
      for (let x = 0; x < fine.w; x++) {
        let energy = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = Math.min(fine.h - 1, Math.max(0, y + dy));
            const xx = Math.min(fine.w - 1, Math.max(0, x + dx));
            energy += (band.data[(yy * fine.w + xx) * 3] as number) ** 2 / 9;
          }
        }
        const i = (y * fine.w + x) * 3;
        const b0 = band.data[i] as number;
        const b1 = band.data[i + 1] as number;
        const b2 = band.data[i + 2] as number;
        const gl = lumaGain(tl, energy);
        const gc = chromaGain(tc, b1 * b1 + b2 * b2);
        const u = (c: number): number => sampleAt(result, (x + 0.5) / 2, (y + 0.5) / 2, c);
        out.data[i] = u(0) + b0 * gl;
        out.data[i + 1] = u(1) + b1 * gc;
        out.data[i + 2] = u(2) + b2 * gc;
      }
    }
    result = out;
  }
  return result;
}
