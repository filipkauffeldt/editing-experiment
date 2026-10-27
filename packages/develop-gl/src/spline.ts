import type { ToneCurvePoint } from '@ee/contracts';

/**
 * Monotone cubic Hermite spline (Fritsch-Carlson) through `points`, so a curve
 * whose control points are increasing never overshoots between them.
 * Points are `[input, output]` on 0..255 like `crs:ToneCurvePV2012`. Outside the
 * first/last point the curve is flat, as in Lightroom.
 */
export interface Spline {
  evaluate(x: number): number;
}

/** Sort by x, drop non-finite points and duplicates in x (the last one wins), clamp to 0..255. */
export function normalizeCurvePoints(points: readonly ToneCurvePoint[]): [number, number][] {
  const byX = new Map<number, number>();
  for (const [x, y] of points) {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      byX.set(Math.min(255, Math.max(0, x)), Math.min(255, Math.max(0, y)));
    }
  }
  return [...byX.entries()].sort((a, b) => a[0] - b[0]);
}

export function createMonotoneSpline(points: readonly ToneCurvePoint[]): Spline {
  const pts = normalizeCurvePoints(points);
  const n = pts.length;
  if (n === 0) return { evaluate: (x) => x };
  if (n === 1) {
    const only = pts[0]?.[1] ?? 0;
    return { evaluate: () => only };
  }

  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push((xs[i + 1] ?? 0) - (xs[i] ?? 0));
    delta.push(((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / (h[i] ?? 1));
  }

  // Tangents: average of the neighbouring secants, zero at a local extremum.
  const m: number[] = new Array<number>(n).fill(0);
  m[0] = delta[0] ?? 0;
  m[n - 1] = delta[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    const a = delta[i - 1] ?? 0;
    const b = delta[i] ?? 0;
    m[i] = a * b <= 0 ? 0 : (a + b) / 2;
  }
  // Fritsch-Carlson limiter keeps each segment monotone.
  for (let i = 0; i < n - 1; i++) {
    const d = delta[i] ?? 0;
    if (d === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const alpha = (m[i] ?? 0) / d;
    const beta = (m[i + 1] ?? 0) / d;
    const s = alpha * alpha + beta * beta;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * alpha * d;
      m[i + 1] = tau * beta * d;
    }
  }

  const firstX = xs[0] ?? 0;
  const lastX = xs[n - 1] ?? 255;
  return {
    evaluate(x: number): number {
      if (x <= firstX) return ys[0] ?? 0;
      if (x >= lastX) return ys[n - 1] ?? 0;
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((xs[mid] ?? 0) <= x) lo = mid;
        else hi = mid;
      }
      const hh = h[lo] ?? 1;
      const t = (x - (xs[lo] ?? 0)) / hh;
      const t2 = t * t;
      const t3 = t2 * t;
      return (
        (2 * t3 - 3 * t2 + 1) * (ys[lo] ?? 0) +
        (t3 - 2 * t2 + t) * hh * (m[lo] ?? 0) +
        (-2 * t3 + 3 * t2) * (ys[lo + 1] ?? 0) +
        (t3 - t2) * hh * (m[lo + 1] ?? 0)
      );
    },
  };
}

/** True when the curve is absent or maps every input to itself (e.g. `[[0,0],[255,255]]`). */
export function isIdentityCurve(points: readonly ToneCurvePoint[] | undefined): boolean {
  if (!points || points.length === 0) return true;
  const spline = createMonotoneSpline(points);
  for (let x = 0; x <= 255; x += 5) if (Math.abs(spline.evaluate(x) - x) > 1e-6) return false;
  return true;
}

/** Samples a curve into `size` values in 0..1 over input 0..1. */
export function sampleCurve(
  points: readonly ToneCurvePoint[] | undefined,
  size: number,
): Float32Array {
  const spline = createMonotoneSpline(points ?? []);
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = Math.min(1, Math.max(0, spline.evaluate((i / (size - 1)) * 255) / 255));
  }
  return out;
}
