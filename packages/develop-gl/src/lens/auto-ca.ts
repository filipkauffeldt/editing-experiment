import type { LinearImageHeader } from '@ee/contracts';
import { halfToFloat, samplesView, type LinearImageBuffer } from '../image';
import type { MeasuredCa } from './resolve';

/**
 * Remove Chromatic Aberration (`crs:AutoLateralCA`): lateral CA measured on the photo itself, so
 * it needs no lens data. The idea is RAWmakase's (`src/lens/auto_ca.rs`, MIT), rewritten here:
 *
 *   1. tiles of about 1/90 of the long edge are scored by their green edge strength; tiles near
 *      the centre, flat tiles and tiles with clipped pixels are left out; the strongest are kept;
 *   2. in each tile red and blue are matched to green along the radial direction: a search over
 *      whole-pixel shifts, then Gauss-Newton steps on the linearised difference, on z-scored
 *      samples (the channels have different gains);
 *   3. the shifts, as a fraction of the tile's radius, are fitted by a robust (Tukey) weighted
 *      polynomial `1 + a + b q + c q^2` of the radius over the half diagonal (a constant `a` is
 *      a plain magnification difference, the commonest lateral CA).
 *
 * The result is a scale of red and blue about the image centre. It is evaluated at the recorded
 * green radius, which is what was measured.
 */

const MIN_RADIUS = 0.3;
const MAX_TILES = 800;
/** Largest shift searched, as a fraction of the long edge (6 px on 6000). */
const SEARCH = 0.001;
/** Correlation below which a tile's fit is not trusted. */
const MIN_CORRELATION = 0.6;
/** Clipped channel value (raw white is 1). */
const CLIPPED = 0.95;
/** Nothing is corrected below this displacement at the corner, in pixels of a 6000 px long edge. */
const NEGLIGIBLE = 0.08;
/** The scale of a channel never differs from green's by more than this. */
const MAX_SCALE_ERROR = 0.01;

interface Tile {
  /** Top-left of the tile's local copy (core plus margin) in the image. */
  x: number;
  y: number;
  q: number;
  /** Unit vector from the image centre towards the tile. */
  ux: number;
  uy: number;
  /** Radius of the tile centre in pixels. */
  r: number;
  strength: number;
  /** Local copy, `side` x `side`, three planes (r, g, b), with a margin for the search. */
  planes: [Float32Array, Float32Array, Float32Array];
}

function reader(header: LinearImageHeader, data: LinearImageBuffer): (i: number) => number {
  const view = samplesView(header, data);
  return view instanceof Uint16Array
    ? (i): number => halfToFloat(view[i] ?? 0)
    : (i): number => view[i] ?? 0;
}

/** Bilinear sample of a square plane, edge clamped. */
function bilinear(plane: Float32Array, side: number, x: number, y: number): number {
  const fx = Math.min(side - 1.001, Math.max(0, x));
  const fy = Math.min(side - 1.001, Math.max(0, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const wx = fx - x0;
  const wy = fy - y0;
  const i = y0 * side + x0;
  return (
    ((plane[i] ?? 0) * (1 - wx) + (plane[i + 1] ?? 0) * wx) * (1 - wy) +
    ((plane[i + side] ?? 0) * (1 - wx) + (plane[i + side + 1] ?? 0) * wx) * wy
  );
}

/** z-scored samples of `plane` at `(x + shift * ux, y + shift * uy)` for the core pixels of a tile. */
function sampleCore(
  plane: Float32Array,
  side: number,
  margin: number,
  core: number,
  ux: number,
  uy: number,
  shift: number,
  out: Float32Array,
  step: number,
): void {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = 0; y < core; y += step) {
    for (let x = 0; x < core; x += step) {
      const v = bilinear(plane, side, margin + x + shift * ux, margin + y + shift * uy);
      out[n++] = v;
      sum += v;
      sumSq += v * v;
    }
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(sumSq / n - mean * mean, 1e-20));
  for (let i = 0; i < n; i++) out[i] = ((out[i] ?? 0) - mean) / sd;
}

/** The shift (pixels, along the tile's radial direction) that matches `channel` to green, and how well. */
function matchChannel(
  tile: Tile,
  channel: 0 | 2,
  side: number,
  margin: number,
  core: number,
  search: number,
): { shift: number; correlation: number } {
  const green = tile.planes[1];
  const moving = tile.planes[channel];
  const count = core * core;
  const g = new Float32Array(count);
  const m = new Float32Array(count);
  sampleCore(green, side, margin, core, 0, 0, 0, g, 1);

  const correlationAt = (shift: number): number => {
    sampleCore(moving, side, margin, core, tile.ux, tile.uy, shift, m, 1);
    let sum = 0;
    for (let i = 0; i < count; i++) sum += (g[i] ?? 0) * (m[i] ?? 0);
    return sum / count;
  };

  // Whole-pixel search, then a parabola through the best three for the start.
  let best = 0;
  let bestValue = -Infinity;
  const values: number[] = [];
  for (let s = -search; s <= search; s++) {
    const value = correlationAt(s);
    values.push(value);
    if (value > bestValue) {
      bestValue = value;
      best = s;
    }
  }
  let shift = best;
  const at = best + search;
  const left = values[at - 1];
  const right = values[at + 1];
  if (left !== undefined && right !== undefined) {
    const denominator = left - 2 * bestValue + right;
    if (denominator < 0)
      shift += Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denominator));
  }

  // Gauss-Newton on the linearised difference of the z-scored samples.
  const derivative = new Float32Array(count);
  for (let iteration = 0; iteration < 4; iteration++) {
    sampleCore(moving, side, margin, core, tile.ux, tile.uy, shift, m, 1);
    sampleCore(moving, side, margin, core, tile.ux, tile.uy, shift + 0.5, derivative, 1);
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < count; i++) {
      const slope = ((derivative[i] ?? 0) - (m[i] ?? 0)) / 0.5;
      numerator += ((g[i] ?? 0) - (m[i] ?? 0)) * slope;
      denominator += slope * slope;
    }
    if (denominator < 1e-9) break;
    const step = Math.max(-0.75, Math.min(0.75, numerator / denominator));
    shift += step;
    if (Math.abs(step) < 0.01) break;
  }
  return { shift, correlation: correlationAt(shift) };
}

/** Weighted least squares of `y` on `[1, q, q^2]` (the first `terms`) with Tukey reweighting; returns `[a, b, c]`. */
export function fitScale(
  samples: { q: number; y: number }[],
  terms: number,
): [number, number, number] | undefined {
  if (samples.length < terms * 4) return undefined;
  const weights = samples.map(() => 1);
  let result: number[] = [];
  for (let round = 0; round < 6; round++) {
    // Normal equations.
    const a = Array.from({ length: terms }, () => new Array<number>(terms + 1).fill(0));
    samples.forEach((s, i) => {
      const basis = Array.from({ length: terms }, (_, k) => s.q ** k);
      for (let r = 0; r < terms; r++) {
        for (let c = 0; c < terms; c++) a[r]![c]! += (weights[i] ?? 0) * basis[r]! * basis[c]!;
        a[r]![terms]! += (weights[i] ?? 0) * basis[r]! * s.y;
      }
    });
    // Gaussian elimination.
    for (let col = 0; col < terms; col++) {
      let pivot = col;
      for (let r = col + 1; r < terms; r++) {
        if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
      }
      if (Math.abs(a[pivot]![col]!) < 1e-18) return undefined;
      [a[col], a[pivot]] = [a[pivot]!, a[col]!];
      for (let r = col + 1; r < terms; r++) {
        const f = a[r]![col]! / a[col]![col]!;
        for (let c = col; c <= terms; c++) a[r]![c]! -= f * a[col]![c]!;
      }
    }
    result = new Array<number>(terms).fill(0);
    for (let r = terms - 1; r >= 0; r--) {
      let sum = a[r]![terms]!;
      for (let c = r + 1; c < terms; c++) sum -= a[r]![c]! * result[c]!;
      result[r] = sum / a[r]![r]!;
    }
    const residuals = samples.map((s) => {
      let fit = 0;
      result.forEach((k, i) => (fit += k * s.q ** i));
      return Math.abs(s.y - fit);
    });
    const scale = 4.685 * 1.4826 * (median(residuals) || 1e-9);
    samples.forEach((_, i) => {
      const u = (residuals[i] ?? 0) / scale;
      weights[i] = u < 1 ? (1 - u * u) ** 2 : 0;
    });
  }
  return [result[0] ?? 0, result[1] ?? 0, result[2] ?? 0];
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/**
 * Measures the lateral CA of a decoded image. Null when there is nothing to correct or too little
 * to measure with (a flat or dark picture, a crop with no edges away from the centre).
 */
export function measureLateralCa(
  header: LinearImageHeader,
  data: LinearImageBuffer,
): MeasuredCa | null {
  const { width, height } = header;
  const longEdge = Math.max(width, height);
  const core = Math.max(16, Math.round(longEdge / 90));
  const search = Math.max(1, Math.round(longEdge * SEARCH));
  const margin = search + 2;
  const side = core + 2 * margin;
  const get = reader(header, data);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.hypot(cx, cy);

  const tiles: Tile[] = [];
  for (let ty = margin; ty + core + margin <= height; ty += core) {
    for (let tx = margin; tx + core + margin <= width; tx += core) {
      const mx = tx + core / 2 - cx;
      const my = ty + core / 2 - cy;
      const r = Math.hypot(mx, my);
      if (r / radius < MIN_RADIUS) continue;
      let strength = 0;
      let mean = 0;
      let clipped = false;
      for (let y = ty; y < ty + core && !clipped; y++) {
        for (let x = tx; x < tx + core; x++) {
          const i = (y * width + x) * 4;
          const g = get(i + 1);
          if (get(i) > CLIPPED || g > CLIPPED || get(i + 2) > CLIPPED) {
            clipped = true;
            break;
          }
          mean += g;
          strength += Math.abs(get(i + 1 + 4) - g) + Math.abs(get(i + 1 + width * 4) - g);
        }
      }
      if (clipped) continue;
      mean /= core * core;
      // Relative edge strength, so dark tiles are not favoured or ruled out by exposure.
      if (mean <= 1e-4 || strength / (core * core * mean) < 0.05) continue;
      tiles.push({
        x: tx - margin,
        y: ty - margin,
        q: r / radius,
        ux: mx / r,
        uy: my / r,
        r,
        strength: strength / mean,
        planes: [new Float32Array(0), new Float32Array(0), new Float32Array(0)],
      });
    }
  }
  tiles.sort((a, b) => b.strength - a.strength);
  tiles.length = Math.min(tiles.length, MAX_TILES);
  if (tiles.length < 24) return null;

  const red: { q: number; y: number }[] = [];
  const blue: { q: number; y: number }[] = [];
  for (const tile of tiles) {
    const planes: [Float32Array, Float32Array, Float32Array] = [
      new Float32Array(side * side),
      new Float32Array(side * side),
      new Float32Array(side * side),
    ];
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const i = ((tile.y + y) * width + tile.x + x) * 4;
        for (let c = 0; c < 3; c++) planes[c]![y * side + x] = get(i + c);
      }
    }
    tile.planes = planes;
    const r = matchChannel(tile, 0, side, margin, core, search);
    const b = matchChannel(tile, 2, side, margin, core, search);
    if (r.correlation >= MIN_CORRELATION && Math.abs(r.shift) < search) {
      red.push({ q: tile.q, y: r.shift / tile.r });
    }
    if (b.correlation >= MIN_CORRELATION && Math.abs(b.shift) < search) {
      blue.push({ q: tile.q, y: b.shift / tile.r });
    }
    tile.planes = [new Float32Array(0), new Float32Array(0), new Float32Array(0)];
  }

  const terms = (samples: { q: number }[]): number => {
    const spread = Math.max(...samples.map((s) => s.q)) - Math.min(...samples.map((s) => s.q));
    return samples.length >= 120 && spread > 0.35
      ? 3
      : samples.length >= 60 && spread > 0.25
        ? 2
        : 1;
  };
  const fit = (samples: { q: number; y: number }[]): number[] | undefined => {
    if (samples.length < 12) return undefined;
    const k = fitScale(samples, terms(samples));
    return k ? [1 + k[0], k[1], k[2], 0] : undefined;
  };
  const redFit = fit(red);
  const blueFit = fit(blue);
  if (!redFit && !blueFit) return null;
  const result = { red: redFit ?? [1, 0, 0, 0], blue: blueFit ?? [1, 0, 0, 0] };

  // Largest departure from green over the frame, in pixels of a 6000 px long edge.
  let worst = 0;
  for (let q = 0; q <= 1.0001; q += 0.05) {
    for (const k of [result.red, result.blue]) {
      const scale = (k[0] ?? 1) + (k[1] ?? 0) * q + (k[2] ?? 0) * q * q + (k[3] ?? 0) * q ** 3;
      if (Math.abs(scale - 1) > MAX_SCALE_ERROR) return null;
      worst = Math.max(worst, Math.abs(scale - 1) * q * 3000);
    }
  }
  return worst < NEGLIGIBLE ? null : result;
}

const memo = new WeakMap<object, MeasuredCa | null>();

/** {@link measureLateralCa}, once per buffer: renders at other sizes and settings reuse it. */
export function measuredLateralCa(
  header: LinearImageHeader,
  data: LinearImageBuffer,
): MeasuredCa | null {
  const known = memo.get(data);
  if (known !== undefined) return known;
  const measured = measureLateralCa(header, data);
  memo.set(data, measured);
  return measured;
}
