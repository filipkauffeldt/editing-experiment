/**
 * The lens correction as the shader and the CPU reference evaluate it: radial polynomials about an
 * optical centre, resolved for one image size. Everything is in pixels of the (decoded) image.
 *
 * A corrected-frame position `p` (what the crop and straighten map produces) is turned into the
 * recorded position that is sampled:
 *
 *   1. manual distortion, about the image centre: `p' = c + (p - c) * (1 + k * (1 - r^2))`,
 *      `r` over the half diagonal (RAWmakase's fit of Camera Raw);
 *   2. profile distortion about the optical centre: `p'' = o + (p' - o) * g(|p' - o| / unit)`;
 *   3. lateral CA: red and blue sample `o + (p'' - o) * t(q)` instead (green stays at `p''`);
 *
 * and the light there is multiplied by the vignetting gain at the green recorded position. The
 * polynomials have ascending powers; the sizes are fixed because the shader uses arrays.
 */

export const DISTORTION_TERMS = 6;
export const CA_TERMS = 4;
export const VIGNETTE_NUMERATOR_TERMS = 9;
export const VIGNETTE_DENOMINATOR_TERMS = 7;

export interface ManualVignette {
  /** -1..1 */
  amount: number;
  scale: number;
  power: number;
  knee: number;
}

export interface LensUniforms {
  /** Distortion, CA, vignetting or manual settings change the picture. */
  active: boolean;
  /** Sampling positions move (distortion or CA), so the source must be sampled bilinearly. */
  geometry: boolean;
  /** Optical centre. */
  centre: [number, number];
  /** Image centre and half diagonal, for the manual settings. */
  frame: { x: number; y: number; radius: number };
  /** Green's recorded radius over the corrected radius (`DISTORTION_TERMS` coefficients), `q = r / unit`. */
  distortion: { coefficients: number[]; unit: number } | null;
  /** The manual distortion constant `k` (0 = off). */
  manualDistortion: number;
  /** Red and blue radius over green's (`CA_TERMS` coefficients each). */
  ca: { red: number[]; blue: number[]; unit: number; atSource: boolean } | null;
  /** Gain `(numerator(v) / denominator(v)) ^ exponent`, `v = r / unit`, `r` from the optical centre. */
  vignette: {
    numerator: number[];
    denominator: number[];
    unit: number;
    exponent: number;
  } | null;
  manualVignette: ManualVignette | null;
}

/** `LensUniforms` with nothing to do. */
export const NO_LENS: LensUniforms = {
  active: false,
  geometry: false,
  centre: [0, 0],
  frame: { x: 0, y: 0, radius: 1 },
  distortion: null,
  manualDistortion: 0,
  ca: null,
  vignette: null,
  manualVignette: null,
};

/** Horner evaluation of ascending coefficients. */
export function polynomial(coefficients: readonly number[], x: number): number {
  let sum = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) sum = sum * x + (coefficients[i] ?? 0);
  return sum;
}

/** Lightroom's Amount (-100..100) and Midpoint (0..100) as the gain constants (RAWmakase's fit of Camera Raw 18.7). */
export function manualVignette(amount: number, midpoint: number): ManualVignette | null {
  if (amount === 0) return null;
  const m = Math.min(100, Math.max(0, midpoint));
  return {
    amount: Math.min(1, Math.max(-1, amount / 100)),
    scale: 2.206 + 0.001321 * m,
    power: 2.11 + 0.077 * m,
    knee: 0.6184 + 0.001916 * m,
  };
}

/** The manual distortion constant for Lightroom's amount: positive corrects barrel, negative pincushion. */
export function manualDistortionConstant(amount: number): number {
  return (amount / 100) * (amount > 0 ? 0.4 : 0.5);
}

/** Recorded positions of green, red and blue for a corrected-frame position. */
export interface LensSample {
  gx: number;
  gy: number;
  rx: number;
  ry: number;
  bx: number;
  by: number;
}

/** Position after manual and profile distortion (green). */
function greenPosition(
  u: LensUniforms,
  x: number,
  y: number,
  out: { x: number; y: number; qOut: number },
): void {
  let px = x;
  let py = y;
  if (u.manualDistortion !== 0) {
    const dx = px - u.frame.x;
    const dy = py - u.frame.y;
    const r = Math.hypot(dx, dy) / u.frame.radius;
    const m = 1 + u.manualDistortion * (1 - r * r);
    px = u.frame.x + dx * m;
    py = u.frame.y + dy * m;
  }
  const dx = px - u.centre[0];
  const dy = py - u.centre[1];
  out.qOut = u.ca ? Math.hypot(dx, dy) / u.ca.unit : 0;
  if (u.distortion) {
    const g = polynomial(u.distortion.coefficients, Math.hypot(dx, dy) / u.distortion.unit);
    px = u.centre[0] + dx * g;
    py = u.centre[1] + dy * g;
  }
  out.x = px;
  out.y = py;
}

const scratch = { x: 0, y: 0, qOut: 0 };

/** Where each channel of the corrected-frame position `(x, y)` is recorded. */
export function lensSample(u: LensUniforms, x: number, y: number, out: LensSample): void {
  greenPosition(u, x, y, scratch);
  out.gx = out.rx = out.bx = scratch.x;
  out.gy = out.ry = out.by = scratch.y;
  if (!u.ca) return;
  const dx = scratch.x - u.centre[0];
  const dy = scratch.y - u.centre[1];
  const q = u.ca.atSource ? Math.hypot(dx, dy) / u.ca.unit : scratch.qOut;
  const tr = polynomial(u.ca.red, q);
  const tb = polynomial(u.ca.blue, q);
  out.rx = u.centre[0] + dx * tr;
  out.ry = u.centre[1] + dy * tr;
  out.bx = u.centre[0] + dx * tb;
  out.by = u.centre[1] + dy * tb;
}

/** Multiplier for the light recorded at the green position `(sx, sy)`. */
export function lensGain(u: LensUniforms, sx: number, sy: number): number {
  let gain = 1;
  if (u.vignette) {
    const v = Math.hypot(sx - u.centre[0], sy - u.centre[1]) / u.vignette.unit;
    const ratio =
      polynomial(u.vignette.numerator, v) / Math.max(polynomial(u.vignette.denominator, v), 1e-4);
    gain = u.vignette.exponent === 1 ? ratio : Math.max(ratio, 1e-4) ** u.vignette.exponent;
  }
  const m = u.manualVignette;
  if (m) {
    const r = Math.hypot(sx - u.frame.x, sy - u.frame.y) / u.frame.radius;
    const t = r ** m.power;
    gain *= Math.exp((m.amount * m.scale * t) / (1 + m.knee * t));
  }
  return gain;
}

/**
 * The corrected-frame position whose green sample is recorded at `(sx, sy)`: the inverse of the
 * distortion maps, for moving things that live in recorded coordinates (retouch shapes) into the
 * corrected picture. The maps are radial and close to the identity, so the fixed point
 * iteration `p += s - F(p)` converges quickly.
 */
export function lensCorrectedPosition(
  u: LensUniforms,
  sx: number,
  sy: number,
): { x: number; y: number } {
  if (!u.geometry) return { x: sx, y: sy };
  const probe = { x: 0, y: 0, qOut: 0 };
  let px = sx;
  let py = sy;
  for (let i = 0; i < 60; i++) {
    greenPosition(u, px, py, probe);
    const ex = sx - probe.x;
    const ey = sy - probe.y;
    px += ex;
    py += ey;
    if (Math.abs(ex) < 1e-5 && Math.abs(ey) < 1e-5) break;
  }
  return { x: px, y: py };
}
