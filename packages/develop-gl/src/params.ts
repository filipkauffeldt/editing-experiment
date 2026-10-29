import type { EditParams, LinearImageHeader, SliderParam } from '@ee/contracts';
import { SLIDER_SPECS } from '@ee/contracts';
import { contrastGamma, exposureGain, lookupCurve, type ToneParams } from './ops';
import { cropGeometry, isUsableCrop } from './crop';
import { isIdentityCurve, sampleCurve } from './spline';
import { resolveCalibration, type Calibration } from './color/calibration';
import { resolveColorGrading, type ColorGrading } from './color/grading';
import { resolveColorMixer, type ColorMixer } from './color/mixer';
import { buildParametricLut } from './color/parametric';
import { resolveGrain, resolveVignette, type GrainField, type Vignette } from './color/effects';
import { clamp01 } from './color/common';
import { TUNING } from './tuning';
import { resolveLens, type LensImage, type MeasuredCa } from './lens/resolve';
import type { LensUniforms } from './lens/model';
import { resolveWhiteBalance, type ResolvedWhiteBalance, type WhiteBalanceCamera } from './wb';

/** The header fields the develop pipeline reads. */
export type DevelopCamera = Pick<LinearImageHeader, 'cameraToSrgb' | 'width' | 'height'> &
  Partial<Pick<LinearImageHeader, 'lens'>> &
  WhiteBalanceCamera;

/** Everything the shader / CPU reference needs for one render; no further lookups into `EditParams`. */
export interface DevelopUniforms {
  /** White balance gains applied to camera RGB (and used for its highlight clip level). */
  multipliers: [number, number, number];
  /** Row-major 3x3, white-balanced camera RGB to linear Rec.709 (`cameraToSrgb`). */
  colorMatrix: number[];
  /** Linear gain, `2^Exposure2012`. */
  exposureGain: number;
  /** False when every tone slider is neutral, so the tone stage can be skipped. */
  toneActive: boolean;
  tone: ToneParams;
  vibrance: number;
  saturation: number;
  /**
   * Tone curve table, `TUNING.curveLutSize` RGBA float entries over encoded input 0..1
   * (alpha unused). The master curve is applied first, then the red/green/blue curves.
   * Null when all curves are identity.
   */
  curveLut: Float32Array | null;
  /** The white balance that was resolved, for slider display. */
  whiteBalance: ResolvedWhiteBalance;
  /** Camera Calibration, applied right after the camera matrix. */
  calibration: Calibration;
  mixer: ColorMixer;
  grading: ColorGrading;
  vignette: Vignette | null;
  grain: GrainField | null;
  /** Lens corrections: where the corrected frame is recorded, lateral CA, vignetting gain. */
  lens: LensUniforms;
}

const sliderValue = (params: EditParams, name: SliderParam): number => {
  const spec = SLIDER_SPECS[name];
  const raw = params[name];
  const value = raw === undefined || !Number.isFinite(raw) ? (spec.neutral ?? 0) : raw;
  return Math.min(spec.max, Math.max(spec.min, value));
};

let memo: { key: string; lut: Float32Array | null } | undefined;

/**
 * Builds the combined RGBA curve table, or null when every curve is identity.
 * The last result is memoised so dragging an unrelated slider keeps returning
 * the same array (callers can compare by reference to skip re-uploading it).
 */
export function buildCurveLut(params: EditParams): Float32Array | null {
  const key = JSON.stringify([
    params.ToneCurvePV2012,
    params.ToneCurvePV2012Red,
    params.ToneCurvePV2012Green,
    params.ToneCurvePV2012Blue,
    params.ParametricShadows,
    params.ParametricDarks,
    params.ParametricLights,
    params.ParametricHighlights,
    params.ParametricShadowSplit,
    params.ParametricMidtoneSplit,
    params.ParametricHighlightSplit,
  ]);
  if (memo?.key !== key) memo = { key, lut: computeCurveLut(params, TUNING.curveLutSize) };
  return memo.lut;
}

export function computeCurveLut(params: EditParams, size: number): Float32Array | null {
  const curves = [
    params.ToneCurvePV2012,
    params.ToneCurvePV2012Red,
    params.ToneCurvePV2012Green,
    params.ToneCurvePV2012Blue,
  ];
  const parametric = buildParametricLut(params, size);
  if (parametric === null && curves.every(isIdentityCurve)) return null;
  const master = sampleCurve(params.ToneCurvePV2012, size);
  const channels = [
    params.ToneCurvePV2012Red,
    params.ToneCurvePV2012Green,
    params.ToneCurvePV2012Blue,
  ].map((points) => sampleCurve(points, size));
  const lut = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    // The parametric curve sits between the basic tone stage and the point
    // curve, as in Lightroom and RAWmakase.
    const afterParametric = parametric ? (parametric[i] ?? 0) : i / (size - 1);
    const afterMaster = lookupCurve(master, 0, 1, clamp01(afterParametric));
    for (let c = 0; c < 3; c++) {
      lut[i * 4 + c] = lookupCurve(channels[c] ?? master, 0, 1, afterMaster);
    }
    lut[i * 4 + 3] = 1;
  }
  return lut;
}

/** Resolves `EditParams` (any subset, values clamped to `SLIDER_SPECS`) against the image's colour data. */
export interface ResolveOptions {
  /** Stable per-photo grain seed. Preview and export must use the same value. */
  grainSeed?: number;
  /** The measured lateral CA, when `AutoLateralCA` is on (see `lens/auto-ca.ts`). */
  measuredCa?: MeasuredCa | null;
}

/** The crop's full-resolution output size, which the vignette is relative to. */
function logicalOutputSize(
  camera: DevelopCamera,
  params: EditParams,
): { width: number; height: number } {
  const crop = params.crop;
  if (crop && isUsableCrop(crop)) {
    const geometry = cropGeometry(crop, { width: camera.width, height: camera.height });
    return {
      width: Math.max(1, Math.round(geometry.width)),
      height: Math.max(1, Math.round(geometry.height)),
    };
  }
  return { width: camera.width, height: camera.height };
}

export function resolveUniforms(
  camera: DevelopCamera,
  params: EditParams,
  options: ResolveOptions = {},
): DevelopUniforms {
  const whiteBalance = resolveWhiteBalance(camera, params);
  const m = whiteBalance.multipliers;

  const contrast = sliderValue(params, 'Contrast2012') / 100;
  const tone: ToneParams = {
    contrastGamma: contrastGamma(contrast),
    highlights: sliderValue(params, 'Highlights2012') / 100,
    shadows: sliderValue(params, 'Shadows2012') / 100,
    whites: sliderValue(params, 'Whites2012') / 100,
    blacks: sliderValue(params, 'Blacks2012') / 100,
  };

  const logical = logicalOutputSize(camera, params);
  return {
    calibration: resolveCalibration(params),
    mixer: resolveColorMixer(params),
    grading: resolveColorGrading(params),
    vignette: resolveVignette(params, logical),
    grain: resolveGrain(params, Math.max(camera.width, camera.height), options.grainSeed ?? 0),
    lens: resolveLens(camera as LensImage, params, options.measuredCa).uniforms,
    multipliers: [m.r, m.g, m.b],
    colorMatrix: camera.cameraToSrgb,
    exposureGain: exposureGain(sliderValue(params, 'Exposure2012')),
    toneActive:
      contrast !== 0 ||
      tone.highlights !== 0 ||
      tone.shadows !== 0 ||
      tone.whites !== 0 ||
      tone.blacks !== 0,
    tone,
    vibrance: sliderValue(params, 'Vibrance') / 100,
    saturation: sliderValue(params, 'Saturation') / 100,
    curveLut: buildCurveLut(params),
    whiteBalance,
  };
}
