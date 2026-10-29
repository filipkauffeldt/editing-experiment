import type { LinearImageHeader } from '@ee/contracts';
import { floatToHalf, halfToFloat } from '../src/image';
import { multipliersFromTemperatureTint } from '../src/wb';

/** Nikon Z 6 colour matrix (Adobe ColorMatrix2, D65), the kind of matrix LibRaw reports as `cam_xyz`. */
export const Z6_XYZ_TO_CAMERA = [
  0.821, -0.2534, -0.0683, -0.5355, 1.3338, 0.2212, -0.1143, 0.193, 0.6464,
];

/** Z 6-like camera -> sRGB matrix (rows sum to 1 so camera white after WB is sRGB white). */
export const Z6_CAMERA_TO_SRGB = [1.7, -0.5, -0.2, -0.2, 1.4, -0.2, 0.05, -0.55, 1.5];

export function makeHeader(
  width: number,
  height: number,
  sampleType: 'f16' | 'f32' = 'f16',
  asShot = multipliersFromTemperatureTint(Z6_XYZ_TO_CAMERA, 5600, 8),
): LinearImageHeader {
  return {
    width,
    height,
    sourceWidth: width,
    sourceHeight: height,
    sampleType,
    asShotMultipliers: asShot,
    cameraToSrgb: Z6_CAMERA_TO_SRGB,
    xyzToCamera: Z6_XYZ_TO_CAMERA,
  };
}

/** Deterministic pseudo random numbers in 0..1. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Synthetic camera-RGB test chart in white-balance-neutral camera space (so the
 * as-shot multipliers have to be applied by the pipeline): a luminance ramp with
 * superwhites, coloured patches and noise-like detail. Values are exact half floats.
 */
export function makeChart(
  width: number,
  height: number,
): { header: LinearImageHeader; data: Uint16Array; samples: Float32Array } {
  const header = makeHeader(width, height, 'f16');
  const m = header.asShotMultipliers;
  const rand = rng(7);
  const samples = new Float32Array(width * height * 4);
  const data = new Uint16Array(samples.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const u = x / Math.max(1, width - 1);
      const v = y / Math.max(1, height - 1);
      // Top half: exposure ramp from deep shadow to 4x sensor white, tinted by the as-shot neutral.
      // Bottom half: hue sweep of varying saturation at mid brightness.
      let rgb: [number, number, number];
      if (v < 0.5) {
        const level = 0.002 * Math.pow(2000, u);
        rgb = [level / m.r, level / m.g, level / m.b];
      } else {
        const hue = u * 6;
        const sat = 0.1 + 0.9 * ((v - 0.5) * 2);
        const k = (n: number): number => {
          const t = Math.abs(((hue + n) % 6) - 3) - 1;
          return Math.min(1, Math.max(0, t));
        };
        const base = 0.35;
        rgb = [
          (base * (1 - sat + sat * k(0))) / m.r,
          (base * (1 - sat + sat * k(4))) / m.g,
          (base * (1 - sat + sat * k(2))) / m.b,
        ];
      }
      const noise = 1 + (rand() - 0.5) * 0.05;
      for (let c = 0; c < 3; c++) {
        const half = floatToHalf((rgb[c] ?? 0) * noise);
        data[i + c] = half;
      }
      data[i + 3] = floatToHalf(1);
    }
  }
  for (let i = 0; i < data.length; i++) samples[i] = halfToFloat(data[i] ?? 0);
  return { header, data, samples };
}

/** Largest absolute difference between two byte arrays (RGBA, alpha included). */
export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`length mismatch ${a.length} vs ${b.length}`);
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return max;
}

/** A camera that is already linear sRGB with unity white balance, so camera RGB passes straight through. */
export function identityHeader(
  width: number,
  height: number,
  sourceWidth = width,
  sourceHeight = height,
): LinearImageHeader {
  return {
    ...makeHeader(width, height, 'f32', { r: 1, g: 1, b: 1 }),
    sourceWidth,
    sourceHeight,
    cameraToSrgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };
}

/** Builds an f32 linear image from `fn(x, y)` returning linear RGB. */
export function makeImage(
  width: number,
  height: number,
  fn: (x: number, y: number) => [number, number, number],
  sourceWidth = width,
  sourceHeight = height,
): { header: LinearImageHeader; data: Float32Array } {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      data.set([r, g, b, 1], (y * width + x) * 4);
    }
  }
  return { header: identityHeader(width, height, sourceWidth, sourceHeight), data };
}

/** Mean and variance of channel `c` of a float RGBA render over a rectangle. */
export function stats(
  rgba: Float32Array,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
  c = 1,
): { mean: number; variance: number } {
  let sum = 0;
  let sumSq = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const v = rgba[(y * width + x) * 4 + c] ?? 0;
      sum += v;
      sumSq += v * v;
    }
  }
  const n = rect.w * rect.h;
  const mean = sum / n;
  return { mean, variance: Math.max(0, sumSq / n - mean * mean) };
}

/** Deterministic hash noise in -0.5..0.5 for integer coordinates. */
export function hashNoise(x: number, y: number, seed = 0): number {
  let h = Math.imul(x + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(y + seed, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 0x100000000 - 0.5;
}

/**
 * A scene as a function of the unit square, so it can be sampled at any resolution:
 * large light/dark swells, medium and fine texture, a specular disc that sets
 * Clarity's key level, a hazy band and some colour. `noise` adds per-pixel
 * noise (which is not resolution independent).
 */
export function sceneAt(u: number, v: number): [number, number, number] {
  const tau = Math.PI * 2;
  let lum = 0.05 * 2 ** (1.5 * Math.sin(tau * (2 * u + 1.3 * v)));
  lum *= 1 + 0.3 * Math.sin(tau * 40 * u) * Math.sin(tau * 30 * v);
  lum *= 1 + 0.15 * Math.sin(tau * 9 * u + 2) * Math.sin(tau * 7 * v);
  if (Math.hypot(u - 0.78, (v - 0.3) * 0.7) < 0.1) lum = 2.5;
  if (v < 0.22) lum = lum * 0.4 + 0.55 * 0.6;
  const tint = 0.3 * Math.sin(tau * (3 * u - 2 * v));
  return [lum * (1 + tint), lum, lum * (1 - tint)];
}

/** `sceneAt` rendered at `width` x `height`; `sourceWidth` tells the header how big the full-resolution photo is. */
export function makeScene(
  width: number,
  height: number,
  options: {
    noise?: number;
    chromaNoise?: number;
    sourceWidth?: number;
    sourceHeight?: number;
  } = {},
): { header: LinearImageHeader; data: Float32Array } {
  const noise = options.noise ?? 0;
  return makeImage(
    width,
    height,
    (x, y) => {
      const [r, g, b] = sceneAt((x + 0.5) / width, (y + 0.5) / height);
      const n = 1 + noise * hashNoise(x, y);
      const c = 1 + (options.chromaNoise ?? noise * 0.5) * hashNoise(x, y, 7);
      return [r * n * c, g * n, (b * n) / c];
    },
    options.sourceWidth ?? width,
    options.sourceHeight ?? height,
  );
}
