import type { EditParams, LinearImageHeader, SliderParam } from '@ee/contracts';
import { SLIDER_SPECS } from '@ee/contracts';
import { scaleColumns } from './mat3';
import { contrastGamma, exposureGain, lookupCurve, type ToneParams } from './ops';
import { isIdentityCurve, sampleCurve } from './spline';
import { TUNING } from './tuning';
import { resolveWhiteBalance, type ResolvedWhiteBalance, type WhiteBalanceCamera } from './wb';

/** The header fields the develop pipeline reads. */
export type DevelopCamera = Pick<LinearImageHeader, 'cameraToSrgb'> & WhiteBalanceCamera;

/** Everything the shader / CPU reference needs for one render; no further lookups into `EditParams`. */
export interface DevelopUniforms {
  /** Row-major 3x3: `cameraToSrgb * diag(whiteBalanceMultipliers)`, camera RGB to linear Rec.709. */
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
}

const sliderValue = (params: EditParams, name: SliderParam): number => {
  const spec = SLIDER_SPECS[name];
  const raw = params[name];
  const value = raw === undefined || !Number.isFinite(raw) ? (spec.neutral ?? 0) : raw;
  return Math.min(spec.max, Math.max(spec.min, value));
};

/** Builds the combined RGBA curve table, or null when every curve is identity. */
export function buildCurveLut(params: EditParams, size = TUNING.curveLutSize): Float32Array | null {
  const curves = [
    params.ToneCurvePV2012,
    params.ToneCurvePV2012Red,
    params.ToneCurvePV2012Green,
    params.ToneCurvePV2012Blue,
  ];
  if (curves.every(isIdentityCurve)) return null;
  const master = sampleCurve(params.ToneCurvePV2012, size);
  const channels = [params.ToneCurvePV2012Red, params.ToneCurvePV2012Green, params.ToneCurvePV2012Blue].map(
    (points) => sampleCurve(points, size),
  );
  const lut = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const afterMaster = master[i] ?? 0;
    for (let c = 0; c < 3; c++) {
      lut[i * 4 + c] = lookupCurve(channels[c] ?? master, 0, 1, afterMaster);
    }
    lut[i * 4 + 3] = 1;
  }
  return lut;
}

/** Resolves `EditParams` (any subset, values clamped to `SLIDER_SPECS`) against the image's colour data. */
export function resolveUniforms(camera: DevelopCamera, params: EditParams): DevelopUniforms {
  const whiteBalance = resolveWhiteBalance(camera, params);
  const m = whiteBalance.multipliers;
  const colorMatrix = scaleColumns(camera.cameraToSrgb, [m.r, m.g, m.b]);

  const contrast = sliderValue(params, 'Contrast2012') / 100;
  const tone: ToneParams = {
    contrastGamma: contrastGamma(contrast),
    highlights: sliderValue(params, 'Highlights2012') / 100,
    shadows: sliderValue(params, 'Shadows2012') / 100,
    whites: sliderValue(params, 'Whites2012') / 100,
    blacks: sliderValue(params, 'Blacks2012') / 100,
  };

  return {
    colorMatrix,
    exposureGain: exposureGain(sliderValue(params, 'Exposure2012')),
    toneActive:
      contrast !== 0 || tone.highlights !== 0 || tone.shadows !== 0 || tone.whites !== 0 || tone.blacks !== 0,
    tone,
    vibrance: sliderValue(params, 'Vibrance') / 100,
    saturation: sliderValue(params, 'Saturation') / 100,
    curveLut: buildCurveLut(params),
    whiteBalance,
  };
}
