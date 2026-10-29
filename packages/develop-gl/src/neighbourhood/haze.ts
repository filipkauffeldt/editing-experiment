import { luminance } from '../ops';
import { TUNING } from '../tuning';
import { makePlane, sampleAt, type Plane } from './pyramid';
import { DEHAZE } from './tuning';

/**
 * What Dehaze and Clarity need to know about the whole photo, measured on a
 * small copy of it (long edge at most `DEHAZE.copyEdge`) at Exposure 0:
 * the dark channel prior airlight and haze density (RAWmakase, "Positive
 * Dehaze" in `docs/scene-tone-stage.md`) and the key level of Clarity.
 * Pure CPU code on a copy the GPU reads back, so both renderers share it.
 */
export interface HazeMeasure {
  /** Atmospheric light per channel, linear RGB at Exposure 0. */
  airlight: [number, number, number];
  /** log2 luminance of the photo's brightest levels at Exposure 0. */
  key: number;
  /** Haze density 0..1 over the copy (1 channel). */
  density: Plane;
}

/** Size of the measurement copy of a `width` x `height` photo. */
export function copySize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= DEHAZE.copyEdge) return { width, height };
  const f = DEHAZE.copyEdge / long;
  return { width: Math.max(1, Math.round(width * f)), height: Math.max(1, Math.round(height * f)) };
}

/** Minimum over the (2r+1)^2 window, clamped at the border, separably. */
function windowMin(p: Plane, r: number): Plane {
  const tmp = makePlane(p.w, p.h, 1);
  const out = makePlane(p.w, p.h, 1);
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      let m = Infinity;
      for (let d = -r; d <= r; d++) {
        m = Math.min(m, p.data[y * p.w + Math.min(p.w - 1, Math.max(0, x + d))] as number);
      }
      tmp.data[y * p.w + x] = m;
    }
  }
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      let m = Infinity;
      for (let d = -r; d <= r; d++) {
        m = Math.min(m, tmp.data[Math.min(p.h - 1, Math.max(0, y + d)) * p.w + x] as number);
      }
      out.data[y * p.w + x] = m;
    }
  }
  return out;
}

/** Mean over the (2r+1)^2 window, normalised by the pixels inside the image. */
function boxMean(p: Plane, r: number): Plane {
  const tmp = makePlane(p.w, p.h, 1);
  const out = makePlane(p.w, p.h, 1);
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      let sum = 0;
      let n = 0;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= p.w) continue;
        sum += p.data[y * p.w + xx] as number;
        n++;
      }
      tmp.data[y * p.w + x] = sum / n;
    }
  }
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      let sum = 0;
      let n = 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= p.h) continue;
        sum += tmp.data[yy * p.w + x] as number;
        n++;
      }
      out.data[y * p.w + x] = sum / n;
    }
  }
  return out;
}

/** Guided filter of `p` with itself as the guide: edge-preserving smoothing of radius `r`. */
function guidedSelf(p: Plane, r: number, eps: number): Plane {
  const mean = boxMean(p, r);
  const sq = makePlane(p.w, p.h, 1);
  for (let i = 0; i < sq.data.length; i++) sq.data[i] = (p.data[i] as number) ** 2;
  const meanSq = boxMean(sq, r);
  const a = makePlane(p.w, p.h, 1);
  const b = makePlane(p.w, p.h, 1);
  for (let i = 0; i < a.data.length; i++) {
    const m = mean.data[i] as number;
    const variance = Math.max(0, (meanSq.data[i] as number) - m * m);
    const ai = variance / (variance + eps);
    a.data[i] = ai;
    b.data[i] = m - ai * m;
  }
  const ma = boxMean(a, r);
  const mb = boxMean(b, r);
  const out = makePlane(p.w, p.h, 1);
  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = (ma.data[i] as number) * (p.data[i] as number) + (mb.data[i] as number);
  }
  return out;
}

const percentile = (sorted: ArrayLike<number>, q: number): number =>
  sorted[Math.floor((sorted.length - 1) * q)] as number;

/** Measures a copy of the photo: linear RGB at Exposure 0 with white balance applied, 3 or 4 channels. */
export function measureHaze(copy: Plane): HazeMeasure {
  const n = copy.w * copy.h;
  const rgb = (i: number, c: number): number => copy.data[i * copy.c + c] as number;

  const dark = makePlane(copy.w, copy.h, 1);
  const logs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    dark.data[i] = Math.max(0, Math.min(rgb(i, 0), rgb(i, 1), rgb(i, 2)));
    logs[i] = Math.log2(
      Math.max(luminance(rgb(i, 0), rgb(i, 1), rgb(i, 2)), TUNING.luminanceFloor),
    );
  }
  const r = Math.max(1, Math.round(DEHAZE.windowFraction * Math.max(copy.w, copy.h)));
  const darkChannel = windowMin(dark, r);

  const sortedDark = Float32Array.from(darkChannel.data).sort();
  const threshold = percentile(sortedDark, DEHAZE.airlightPercentile);
  const airlight: [number, number, number] = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < n; i++) {
    if ((darkChannel.data[i] as number) < threshold) continue;
    for (let c = 0; c < 3; c++) airlight[c] = (airlight[c] as number) + rgb(i, c);
    count++;
  }
  for (let c = 0; c < 3; c++) airlight[c] = Math.max((airlight[c] as number) / count, 1e-4);

  const ratio = makePlane(copy.w, copy.h, 1);
  for (let i = 0; i < n; i++) {
    ratio.data[i] = Math.min(
      rgb(i, 0) / airlight[0],
      rgb(i, 1) / airlight[1],
      rgb(i, 2) / airlight[2],
    );
  }
  const density = guidedSelf(windowMin(ratio, r), 2 * r, DEHAZE.guidedEps);
  for (let i = 0; i < n; i++) {
    density.data[i] = Math.min(1, Math.max(0, density.data[i] as number));
  }

  const sortedLogs = logs.sort();
  const key =
    (DEHAZE.keyWeights[0] as number) * percentile(sortedLogs, DEHAZE.keyPercentiles[0] as number) +
    (DEHAZE.keyWeights[1] as number) * percentile(sortedLogs, DEHAZE.keyPercentiles[1] as number);
  return { airlight, key, density };
}

/** Density at source position `(u, v)` in 0..1 of the photo, bilinear. */
export const densityAtUv = (density: Plane, u: number, v: number): number =>
  sampleAt(density, u * density.w, v * density.h, 0);
