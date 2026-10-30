import type { CameraProfileData, LookProfileData, ProfileTable, ResolvedProfile } from '@ee/contracts';
import { invert, mulMat, mulMatVec, type Mat3 } from '../mat3';
import { srgbDecode, srgbEncode } from '../ops';
import { createMonotoneSpline } from '../spline';
import {
  resolveWhiteBalance,
  temperatureTintToXY,
  type ResolvedWhiteBalance,
  type WhiteBalanceCamera,
  type XY,
} from '../wb';
import type { EditParams } from '@ee/contracts';
import { DEFAULT_TONE_CURVE } from './default-tone';

/**
 * The maths of a DNG camera profile on the CPU. `glsl/profile.ts` mirrors every function that runs
 * per pixel; the browser parity test keeps the two together.
 *
 * Follows the Adobe DNG SDK (`dng_color_spec`, `dng_hue_sat_map`, `dng_render`; permissive licence,
 * (c) Adobe Systems Incorporated) and RAWmakase (MIT, `camera_profiles/mod.rs`):
 *
 *   white-balanced camera RGB
 *     -> ForwardMatrix (interpolated by the white's temperature) -> XYZ D50 -> linear ProPhoto
 *     -> HueSatMap (HSV table, interpolated by temperature) -> BaselineExposureOffset
 *     -> [the develop pipeline: calibration, exposure, tone, in linear Rec.709]
 *     -> LookTable (HSV table) -> XMP look table -> ProfileToneCurve -> XMP look curve -> sRGB
 */

/** XYZ D50 to linear ProPhoto RGB (ROMM RGB; Lindbloom). */
const PROPHOTO_TO_XYZ: readonly number[] = [
  0.7976749, 0.1351917, 0.0313534, 0.2880402, 0.7118741, 0.0000857, 0, 0, 0.82521,
];
const XYZ_TO_PROPHOTO: readonly number[] = invert(PROPHOTO_TO_XYZ);
/** XYZ D50 to linear sRGB primaries, Bradford adapted (Lindbloom). */
const XYZ_D50_TO_SRGB: readonly number[] = [
  3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914,
  1.4052427,
];
export const PROPHOTO_TO_SRGB: readonly number[] = mulMat(XYZ_D50_TO_SRGB, PROPHOTO_TO_XYZ);
export const SRGB_TO_PROPHOTO: readonly number[] = invert(PROPHOTO_TO_SRGB);

const D50_XYZ: readonly [number, number, number] = [0.9642, 1, 0.8249];
const D50_XY: XY = { x: 0.3457, y: 0.3585 };

/** Samples of a tone curve table: `TONE_TABLE_SIZE` over input 0..1. */
export const TONE_TABLE_SIZE = 4097;

// --- temperature interpolation (DNG specification, DNG SDK dng_color_spec) -------------------------

/**
 * Weight of the second (warmer to cooler: higher temperature) calibration illuminant at a white of
 * `kelvin`: linear in inverse temperature, clamped to the two illuminants. 0 with one illuminant.
 * DNG SDK `FindXYZtoCamera`: `(1/T - 1/T1) / (1/T2 - 1/T1)`.
 */
export function illuminantWeight(kelvin: number, illuminants: readonly number[]): number {
  const t1 = illuminants[0];
  const t2 = illuminants[1];
  if (t1 === undefined || t2 === undefined || t1 === t2) return 0;
  if (kelvin <= t1) return 0;
  if (kelvin >= t2) return 1;
  return (1 / kelvin - 1 / t1) / (1 / t2 - 1 / t1);
}

/** `a (1 - w) + b w` of two same-length number arrays; one array is returned as it is. */
export function blendNumbers(list: readonly (readonly number[])[], w: number): number[] {
  const a = list[0];
  if (!a) return [];
  const b = list[1];
  if (!b || w === 0) return [...a];
  return a.map((v, i) => v * (1 - w) + (b[i] ?? v) * w);
}

// --- chromatic adaptation --------------------------------------------------------------------------

const BRADFORD: readonly number[] = [
  0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296,
];

/** The Bradford matrix taking XYZ under white `from` to XYZ under white `to`. */
export function bradfordAdaptation(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): number[] {
  const src = mulMatVec(BRADFORD, from);
  const dst = mulMatVec(BRADFORD, to);
  const scale = [dst[0] / src[0], 0, 0, 0, dst[1] / src[1], 0, 0, 0, dst[2] / src[2]];
  return mulMat(invert(BRADFORD), mulMat(scale, BRADFORD));
}

const xyToXYZ = ({ x, y }: XY): [number, number, number] => [x / y, 1, (1 - x - y) / y];

// --- tables ----------------------------------------------------------------------------------------

/** A table as the CPU and the GPU read it. The object identity is the GPU upload cache key. */
export interface TableData {
  hue: number;
  sat: number;
  val: number;
  srgb: boolean;
  /** `[hueShift, satScale, valScale]` per node, value-major then hue then saturation. */
  data: Float32Array;
}

export function tableData(table: ProfileTable): TableData {
  return {
    hue: table.hueDivisions,
    sat: table.satDivisions,
    val: table.valDivisions,
    srgb: table.srgbEncoding,
    data: Float32Array.from(table.data),
  };
}

/** The table at `strength` of its effect (1 unchanged, 0 identity), as the Profile Amount scales it. */
export function scaledTable(table: TableData, strength: number): TableData {
  if (strength === 1) return table;
  const data = new Float32Array(table.data.length);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = (table.data[i] ?? 0) * strength;
    data[i + 1] = Math.max(0, 1 + ((table.data[i + 1] ?? 1) - 1) * strength);
    data[i + 2] = Math.max(0, 1 + ((table.data[i + 2] ?? 1) - 1) * strength);
  }
  return { ...table, data };
}

/**
 * Trilinear lookup of the node values at hue `h` (0..1, wrapping), saturation `s` and value `v`
 * (0..1, clamped; `v` is already in the table's value encoding). Result `[shift, satScale, valScale]`.
 */
export function lookupTable(
  t: TableData,
  h: number,
  s: number,
  v: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const hc = (h - Math.floor(h)) * t.hue;
  const sc = Math.min(1, Math.max(0, s)) * (t.sat - 1);
  const vc = Math.min(1, Math.max(0, v)) * (t.val - 1);
  const h0 = Math.min(Math.floor(hc), t.hue - 1);
  const s0 = Math.floor(sc);
  const v0 = Math.floor(vc);
  const fh = hc - h0;
  const fs = sc - s0;
  const fv = vc - v0;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  for (let dv = 0; dv < 2; dv++) {
    for (let dh = 0; dh < 2; dh++) {
      for (let ds = 0; ds < 2; ds++) {
        const iv = Math.min(v0 + dv, t.val - 1);
        const ih = (h0 + dh) % t.hue;
        const is = Math.min(s0 + ds, t.sat - 1);
        const w = (dv ? fv : 1 - fv) * (dh ? fh : 1 - fh) * (ds ? fs : 1 - fs);
        const at = ((iv * t.hue + ih) * t.sat + is) * 3;
        out[0] += (t.data[at] ?? 0) * w;
        out[1] += (t.data[at + 1] ?? 1) * w;
        out[2] += (t.data[at + 2] ?? 1) * w;
      }
    }
  }
  return out;
}

const scratchA: [number, number, number] = [0, 0, 0];
const scratchB: [number, number, number] = [0, 0, 0];

/**
 * Applies a HueSatMap / LookTable to a linear RGB triple: to HSV (hue 0..1), look up the shift and
 * scales (blending a second table by `weight`), apply them, back to RGB. Negative channels are
 * treated as 0; values above 1 keep their headroom (the lookup clamps, the scale applies).
 */
export function applyTable(
  r: number,
  g: number,
  b: number,
  a: TableData,
  second: TableData | null,
  weight: number,
): [number, number, number] {
  r = Math.max(r, 0);
  g = Math.max(g, 0);
  b = Math.max(b, 0);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d >= 1e-9) {
    if (max === r) h = (((g - b) / d) % 6 + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  const sat = max > 0 ? d / max : 0;
  const encoded = a.srgb && a.val > 1;
  const v = encoded ? srgbEncode(max) : max;
  const delta = lookupTable(a, h, sat, v, scratchA);
  if (second && weight > 0) {
    const other = lookupTable(second, h, sat, v, scratchB);
    for (let c = 0; c < 3; c++) delta[c] = (delta[c] ?? 0) * (1 - weight) + (other[c] ?? 0) * weight;
  }
  let hh = h + (delta[0] ?? 0) / 360;
  hh = (hh - Math.floor(hh)) * 6;
  const ss = Math.min(1, Math.max(0, sat * (delta[1] ?? 1)));
  const vv = encoded ? srgbDecode(v * (delta[2] ?? 1)) : v * (delta[2] ?? 1);
  const c = vv * ss;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = vv - c;
  switch (Math.floor(hh) % 6) {
    case 0:
      return [c + m, x + m, m];
    case 1:
      return [x + m, c + m, m];
    case 2:
      return [m, c + m, x + m];
    case 3:
      return [m, x + m, c + m];
    case 4:
      return [x + m, m, c + m];
    default:
      return [c + m, m, x + m];
  }
}

// --- tone curves -----------------------------------------------------------------------------------

/** The DNG default curve resampled to {@link TONE_TABLE_SIZE} entries. */
function defaultToneTable(): Float32Array {
  const out = new Float32Array(TONE_TABLE_SIZE);
  const last = DEFAULT_TONE_CURVE.length - 1;
  for (let i = 0; i < TONE_TABLE_SIZE; i++) {
    const p = (i / (TONE_TABLE_SIZE - 1)) * last;
    const i0 = Math.min(Math.floor(p), last - 1);
    const a = DEFAULT_TONE_CURVE[i0] ?? 0;
    out[i] = a + ((DEFAULT_TONE_CURVE[i0 + 1] ?? a) - a) * (p - i0);
  }
  return out;
}

/**
 * Samples a curve given as `[x0, y0, x1, y1, ...]` in 0..1 into a table over input 0..1. The points are
 * joined by a monotone cubic spline (the DNG SDK solves its own cubic spline through them; the two
 * differ by far less than a table step on the dense curves Adobe ships).
 */
export function sampleToneCurve(points: readonly number[]): Float32Array {
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    pairs.push([(points[i] ?? 0) * 255, (points[i + 1] ?? 0) * 255]);
  }
  const spline = createMonotoneSpline(pairs);
  const out = new Float32Array(TONE_TABLE_SIZE);
  for (let i = 0; i < TONE_TABLE_SIZE; i++) {
    out[i] = Math.min(1, Math.max(0, spline.evaluate((i / (TONE_TABLE_SIZE - 1)) * 255) / 255));
  }
  return out;
}

/** Linear interpolation in a tone table; input is clamped to 0..1. */
export function lookupTone(table: ArrayLike<number>, offset: number, x: number): number {
  const p = Math.min(1, Math.max(0, x)) * (TONE_TABLE_SIZE - 1);
  const i0 = Math.min(Math.floor(p), TONE_TABLE_SIZE - 2);
  const a = table[offset + i0] ?? 0;
  return a + ((table[offset + i0 + 1] ?? a) - a) * (p - i0);
}

/**
 * The DNG tone curve on an RGB triple, hue-preserving as the SDK's RGB tone: the curve maps the
 * darkest and the brightest channel and the middle one keeps its relative position. Channels are
 * clamped to 0..1 first.
 */
export function applyToneCurve(
  table: ArrayLike<number>,
  offset: number,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  r = Math.min(1, Math.max(0, r));
  g = Math.min(1, Math.max(0, g));
  b = Math.min(1, Math.max(0, b));
  const low = Math.min(r, g, b);
  const high = Math.max(r, g, b);
  const a = lookupTone(table, offset, low);
  if (high - low <= 1e-8) return [a, a, a];
  const c = lookupTone(table, offset, high);
  const k = (c - a) / (high - low);
  return [a + (r - low) * k, a + (g - low) * k, a + (b - low) * k];
}

/** The XMP look's curve is applied to sRGB-encoded values, in the same hue-preserving way. */
export function applyLookCurve(
  table: ArrayLike<number>,
  offset: number,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const [er, eg, eb] = [r, g, b].map((v) => srgbEncode(Math.min(1, Math.max(0, v)))) as [
    number,
    number,
    number,
  ];
  const [cr, cg, cb] = applyToneCurve(table, offset, er, eg, eb);
  return [srgbDecode(cr), srgbDecode(cg), srgbDecode(cb)];
}

// --- the prepared profile --------------------------------------------------------------------------

/** Everything about a profile choice that does not depend on the white balance, computed once. */
export interface PreparedProfile {
  /** Changes with the profile choice and amount; part of the render caches' keys. */
  key: string;
  camera: CameraProfileData;
  hueSat: { first: TableData; second: TableData | null } | null;
  look: TableData | null;
  lookXmp: TableData | null;
  /** The base tone curve (row 0) and the XMP look's curve (row 1) as one table of two rows. */
  tone: Float32Array;
  hasLookCurve: boolean;
  /** `2^BaselineExposureOffset`. */
  baselineGain: number;
  /** The look's settings at its amount, in slider units. */
  settings: Partial<Record<LookSettingName, number>>;
}

type LookSettingName = keyof LookProfileData['settings'];

let nextKey = 1;
const prepared = new WeakMap<ResolvedProfile, PreparedProfile>();

/** The look's amount, as a fraction, honouring whether the look supports one. */
export function effectiveAmount(profile: ResolvedProfile): number {
  const look = profile.look;
  if (!look?.supportsAmount) return 1;
  return Math.min(2, Math.max(0, Number.isFinite(profile.amount) ? profile.amount : 1));
}

/** Scale of the look's internal develop settings: in proportion up to 100 %, half as fast above (Camera Raw). */
const settingScale = (amount: number): number => (amount > 1 ? 1 + (amount - 1) * 0.5 : amount);

function lookCurveTable(points: readonly number[], amount: number): Float32Array {
  const base = sampleToneCurve(points);
  const out = new Float32Array(TONE_TABLE_SIZE);
  for (let i = 0; i < TONE_TABLE_SIZE; i++) {
    const x = i / (TONE_TABLE_SIZE - 1);
    const y = base[i] ?? x;
    // Up to 100 % a blend with no change; above, the curve is applied again at the excess.
    out[i] = amount > 1 ? y + (lookupTone(base, 0, y) - y) * (amount - 1) : x + (y - x) * amount;
  }
  return out;
}

/** Converts a profile choice into what the pipeline reads. Cached per object, so keep the object stable. */
export function prepareProfile(profile: ResolvedProfile): PreparedProfile {
  const cached = prepared.get(profile);
  if (cached) return cached;
  const camera = profile.camera;
  const look = profile.look;
  const amount = effectiveAmount(profile);

  const maps = camera.hueSatMaps.map(tableData);
  const first = maps[0];
  const tone = new Float32Array(TONE_TABLE_SIZE * 2);
  tone.set(camera.toneCurve ? sampleToneCurve(camera.toneCurve) : defaultToneTable(), 0);
  if (look?.curve) tone.set(lookCurveTable(look.curve, amount), TONE_TABLE_SIZE);

  const strength = look
    ? Math.min(look.tableBounds[1], Math.max(look.tableBounds[0], amount))
    : 1;
  const settings: PreparedProfile['settings'] = {};
  if (look) {
    for (const [key, value] of Object.entries(look.settings)) {
      settings[key as LookSettingName] = value * settingScale(amount);
    }
  }

  const result: PreparedProfile = {
    key: `${nextKey++}`,
    camera,
    hueSat: first ? { first, second: maps[1] ?? null } : null,
    look: camera.look ? tableData(camera.look) : null,
    lookXmp: look?.table ? scaledTable(tableData(look.table), strength) : null,
    tone,
    hasLookCurve: look?.curve !== undefined,
    baselineGain: Math.pow(2, camera.baselineExposureOffset),
    settings,
  };
  prepared.set(profile, result);
  return result;
}

/** `params` with the look's internal develop settings added to the user's sliders. */
export function withLookSettings(params: EditParams, profile: ResolvedProfile | null): EditParams {
  if (!profile?.look) return params;
  const settings = prepareProfile(profile).settings;
  const keys = Object.keys(settings) as LookSettingName[];
  if (keys.length === 0) return params;
  const next: EditParams = { ...params };
  for (const key of keys) {
    const base = params[key] ?? 0;
    next[key] = base + (settings[key] ?? 0);
  }
  return next;
}

// --- per render ------------------------------------------------------------------------------------

/** The profile as the shader and the CPU reference read it, for one white balance. */
export interface ProfileUniforms {
  prepared: PreparedProfile;
  /** Weight of the second HueSatMap at the white's temperature. */
  hueSatWeight: number;
  /** ProPhoto to the working linear Rec.709, and back. */
  proToWorking: readonly number[];
  workingToPro: readonly number[];
  /** Part of the base-pass cache key: everything here that changes the base image. */
  baseKey: string;
}

/** The XYZ to camera matrix of a profile for a white of `kelvin`, or undefined when it has no ColorMatrix. */
export function colorMatrixAt(camera: CameraProfileData, kelvin: number): Mat3 | undefined {
  if (camera.colorMatrices.length === 0) return undefined;
  return blendNumbers(camera.colorMatrices, illuminantWeight(kelvin, camera.illuminants));
}

/**
 * White balance through a profile: the profile's ColorMatrix (by temperature) decides the
 * multipliers for a chosen temperature and tint, and the as-shot temperature. A profile without a
 * ColorMatrix (forward matrix only) falls back to the decoder's matrix.
 */
export function resolveProfileWhiteBalance(
  profile: PreparedProfile,
  camera: WhiteBalanceCamera,
  params: Pick<EditParams, 'WhiteBalance' | 'Temperature' | 'Tint'>,
): ResolvedWhiteBalance {
  if (profile.camera.colorMatrices.length === 0) return resolveWhiteBalance(camera, params);
  return resolveWhiteBalance(camera, params, (kelvin) => {
    return colorMatrixAt(profile.camera, kelvin) ?? camera.xyzToCamera;
  });
}

/**
 * White-balanced camera RGB (g = 1 multipliers) to linear ProPhoto RGB. With a ForwardMatrix that is
 * the matrix at the white's temperature, scaled so the white that is neutral stays white; without
 * one it is the inverse ColorMatrix, adapted from the white to D50 with Bradford (DNG SDK
 * `dng_color_spec`).
 */
export function cameraToProPhoto(
  profile: PreparedProfile,
  wb: ResolvedWhiteBalance,
): { matrix: number[]; weight: number } {
  const cam = profile.camera;
  const weight = illuminantWeight(wb.temperature, cam.illuminants);
  const m = wb.multipliers;
  const forward = cam.forwardMatrices.length > 0 ? blendNumbers(cam.forwardMatrices, weight) : null;
  let toXyzD50: number[];
  if (forward) {
    // The forward matrix expects the neutral at (1, 1, 1) scaled so its largest channel is 1.
    const scale = 1 / Math.min(m.r, m.g, m.b);
    toXyzD50 = forward.map((v) => v * scale);
  } else {
    const color = blendNumbers(cam.colorMatrices, weight);
    const neutral: [number, number, number] = [1 / m.r, 1 / m.g, 1 / m.b];
    const inverse = invert(color);
    const white = mulMatVec(inverse, neutral);
    const scene = mulMat(inverse, [neutral[0], 0, 0, 0, neutral[1], 0, 0, 0, neutral[2]]);
    const adapt = bradfordAdaptation(
      xyToXYZ(temperatureTintToXY({ temperature: wb.temperature, tint: wb.tint })),
      D50_XYZ,
    );
    // Y of the white is 1 for the PCS: scale so the neutral lands on it.
    toXyzD50 = mulMat(adapt, scene).map((v) => v / white[1]);
    // `scene` maps white-balanced values; dividing by the white's luminance keeps it at Y = 1.
  }
  return { matrix: mulMat(XYZ_TO_PROPHOTO, toXyzD50), weight };
}

export function resolveProfileUniforms(
  profile: PreparedProfile,
  weight: number,
): ProfileUniforms {
  return {
    prepared: profile,
    hueSatWeight: weight,
    proToWorking: PROPHOTO_TO_SRGB,
    workingToPro: SRGB_TO_PROPHOTO,
    baseKey: `${profile.key}|${weight}`,
  };
}

/** White-balanced, clipped camera RGB to linear Rec.709 through the profile: matrix, HueSatMap, baseline. */
export function profileBase(
  p: ProfileUniforms,
  matrix: readonly number[],
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  let [pr, pg, pb] = mulMatVec(matrix, [r, g, b]);
  const maps = p.prepared.hueSat;
  if (maps) [pr, pg, pb] = applyTable(pr, pg, pb, maps.first, maps.second, p.hueSatWeight);
  const k = p.prepared.baselineGain;
  return mulMatVec(p.proToWorking, [pr * k, pg * k, pb * k]);
}

/**
 * Linear Rec.709 after calibration, exposure and the tone sliders to the sRGB-encoded colour:
 * LookTable, XMP look table, tone curve, XMP look curve. Replaces the highlight shoulder, which
 * stands in for the tone curve when there is no profile.
 */
export function profileFinish(
  p: ProfileUniforms,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const pre = p.prepared;
  let [pr, pg, pb] = mulMatVec(p.workingToPro, [r, g, b]);
  if (pre.look) [pr, pg, pb] = applyTable(pr, pg, pb, pre.look, null, 0);
  if (pre.lookXmp) {
    [pr, pg, pb] = applyTable(
      Math.min(1, Math.max(0, pr)),
      Math.min(1, Math.max(0, pg)),
      Math.min(1, Math.max(0, pb)),
      pre.lookXmp,
      null,
      0,
    );
  }
  [pr, pg, pb] = applyToneCurve(pre.tone, 0, pr, pg, pb);
  if (pre.hasLookCurve) [pr, pg, pb] = applyLookCurve(pre.tone, TONE_TABLE_SIZE, pr, pg, pb);
  const [lr, lg, lb] = mulMatVec(p.proToWorking, [pr, pg, pb]);
  return [srgbEncode(lr), srgbEncode(lg), srgbEncode(lb)];
}
