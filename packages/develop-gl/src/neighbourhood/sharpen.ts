import { TUNING } from '../tuning';
import type { Sharpen } from './params';
import { makePlane, type Plane } from './pyramid';
import { SHARPEN } from './tuning';

/** Sharpening on encoded RGB (0..1): an unsharp mask of luma, shaped as in RAWmakase `sharpening.rs`. */

/** Gaussian taps for `sigma` output pixels, normalised; empty when the blur would change nothing. */
export function gaussianKernel(sigma: number): Float32Array {
  if (!(sigma >= 0.2)) return new Float32Array(0);
  const radius = Math.min(SHARPEN.maxRadius, Math.ceil(SHARPEN.cutoffSigmas * sigma));
  const taps = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    taps[i + radius] = w;
    sum += w;
  }
  for (let i = 0; i < taps.length; i++) taps[i] = (taps[i] as number) / sum;
  return taps;
}

/** Luminance change for high-pass `d` (luma minus its blur). */
export function sharpenDelta(d: number, s: Sharpen): number {
  const mask = s.threshold === 0 ? 1 : Math.min(1, Math.max(0, Math.abs(d) / s.threshold));
  const k = s.amount * s.gain * mask;
  const shaped = d / (1 + (Math.abs(d) / s.halo) ** 3);
  return k * (shaped < 0 ? shaped * s.dark : shaped);
}

/** Sharpens a 3-channel plane in place's copy. `scale` is output pixels per full-resolution pixel. */
export function sharpenPlane(p: Plane, s: Sharpen, scale: number): Plane {
  const taps = gaussianKernel(s.sigma * scale);
  if (taps.length === 0) return p;
  const r = (taps.length - 1) / 2;
  const [wr, wg, wb] = TUNING.luma;
  const luma = new Float32Array(p.w * p.h);
  for (let i = 0; i < luma.length; i++) {
    luma[i] =
      wr * (p.data[i * 3] as number) +
      wg * (p.data[i * 3 + 1] as number) +
      wb * (p.data[i * 3 + 2] as number);
  }
  const horizontal = new Float32Array(luma.length);
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      let sum = 0;
      for (let d = -r; d <= r; d++) {
        sum +=
          (taps[d + r] as number) *
          (luma[y * p.w + Math.min(p.w - 1, Math.max(0, x + d))] as number);
      }
      horizontal[y * p.w + x] = sum;
    }
  }
  const out = makePlane(p.w, p.h, 3);
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      let blur = 0;
      for (let d = -r; d <= r; d++) {
        blur +=
          (taps[d + r] as number) *
          (horizontal[Math.min(p.h - 1, Math.max(0, y + d)) * p.w + x] as number);
      }
      const i = y * p.w + x;
      const delta = sharpenDelta((luma[i] as number) - blur, s);
      for (let c = 0; c < 3; c++) {
        out.data[i * 3 + c] = Math.min(1, Math.max(0, (p.data[i * 3 + c] as number) + delta));
      }
    }
  }
  return out;
}
