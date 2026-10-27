import type { EditParams, LinearImageHeader, WhiteBalanceMode } from '@ee/contracts';
import { SLIDER_SPECS } from '@ee/contracts';
import { invert, mulMatVec, type Mat3 } from '../mat3';
import {
  temperatureTintToXY,
  xyToTemperatureTint,
  type TemperatureTint,
  type XY,
} from './temperature';

export { temperatureTintToXY, xyToTemperatureTint } from './temperature';
export type { TemperatureTint, XY } from './temperature';

/** The parts of {@link LinearImageHeader} white balance needs. */
export type WhiteBalanceCamera = Pick<
  LinearImageHeader,
  'asShotMultipliers' | 'xyzToCamera' | 'asShotTemperature' | 'asShotTint'
>;

export interface Multipliers {
  r: number;
  g: number;
  b: number;
}

export interface ResolvedWhiteBalance extends TemperatureTint {
  /** Gains to apply to camera RGB, normalised so `g` is 1. */
  multipliers: Multipliers;
}

/**
 * Fixed temperature/tint of the Lightroom named white balances for raw files
 * (Adobe's generic values; Lightroom itself refines them per camera).
 * `As Shot`, `Auto` and `Custom` are not fixed and are absent here.
 */
export const WHITE_BALANCE_PRESETS: Readonly<Partial<Record<WhiteBalanceMode, TemperatureTint>>> = {
  Daylight: { temperature: 5500, tint: 10 },
  Cloudy: { temperature: 6500, tint: 10 },
  Shade: { temperature: 7500, tint: 10 },
  Tungsten: { temperature: 2850, tint: 0 },
  Fluorescent: { temperature: 3800, tint: 21 },
  Flash: { temperature: 5500, tint: 0 },
};

/** XYZ (D65) to linear sRGB; stands in for cameras that ship no usable matrix. */
const XYZ_TO_SRGB: readonly number[] = [
  3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259,
  1.0572252,
];

function usableMatrix(m: readonly number[]): Mat3 {
  if (m.length === 9 && m.every(Number.isFinite)) {
    try {
      invert(m);
      return m;
    } catch {
      // fall through
    }
  }
  return XYZ_TO_SRGB;
}

const xyToXYZ = ({ x, y }: XY): [number, number, number] => [x / y, 1, (1 - x - y) / y];

/** Camera neutral (what the camera records for a white surface under `xy`), scaled so g = 1. */
export function xyToCameraNeutral(xyzToCamera: Mat3, xy: XY): Multipliers {
  const [r, g, b] = mulMatVec(usableMatrix(xyzToCamera), xyToXYZ(xy));
  return { r: r / g, g: 1, b: b / g };
}

/**
 * Chromaticity of the illuminant that produces camera neutral `neutral`.
 *
 * The DNG SDK iterates because it interpolates two colour matrices by
 * temperature; LibRaw gives us one (D65-referenced) matrix, so one inversion
 * is exact.
 */
export function cameraNeutralToXY(xyzToCamera: Mat3, neutral: Multipliers): XY {
  const [X, Y, Z] = mulMatVec(invert(usableMatrix(xyzToCamera)), [neutral.r, neutral.g, neutral.b]);
  const sum = X + Y + Z;
  return { x: X / sum, y: Y / sum };
}

/** Temperature/tint to multipliers (`camera * multipliers` renders that illuminant neutral). */
export function multipliersFromTemperatureTint(
  xyzToCamera: Mat3,
  temperature: number,
  tint: number,
): Multipliers {
  const n = xyToCameraNeutral(xyzToCamera, temperatureTintToXY({ temperature, tint }));
  // The white balance gain is the reciprocal of the neutral; g stays 1.
  return { r: 1 / n.r, g: 1, b: 1 / n.b };
}

/** Multipliers back to temperature/tint (inverse of {@link multipliersFromTemperatureTint}). */
export function temperatureTintFromMultipliers(xyzToCamera: Mat3, m: Multipliers): TemperatureTint {
  const neutral = { r: m.g / m.r, g: 1, b: m.g / m.b };
  return xyToTemperatureTint(cameraNeutralToXY(xyzToCamera, neutral));
}

/** As-shot temperature/tint for slider display, derived from `asShotMultipliers`. */
export function asShotTemperatureTint(camera: WhiteBalanceCamera): TemperatureTint {
  const m = camera.asShotMultipliers;
  if (m.r > 0 && m.g > 0 && m.b > 0) {
    try {
      return temperatureTintFromMultipliers(camera.xyzToCamera, m);
    } catch {
      // fall through to the decoder-provided values
    }
  }
  return { temperature: camera.asShotTemperature ?? 5500, tint: camera.asShotTint ?? 0 };
}

const clampSlider = (name: 'Temperature' | 'Tint', value: number): number =>
  Math.min(SLIDER_SPECS[name].max, Math.max(SLIDER_SPECS[name].min, value));

/**
 * Resolves the white balance of `params`:
 * - `Temperature` / `Tint` set: use them (an absent one keeps its as-shot value);
 * - else a named `WhiteBalance` (Daylight, ...): its fixed temperature/tint;
 * - else (absent, `As Shot`, `Auto`): the as-shot multipliers, untouched.
 */
export function resolveWhiteBalance(
  camera: WhiteBalanceCamera,
  params: Pick<EditParams, 'WhiteBalance' | 'Temperature' | 'Tint'>,
): ResolvedWhiteBalance {
  const asShot = asShotTemperatureTint(camera);
  const named = params.WhiteBalance ? WHITE_BALANCE_PRESETS[params.WhiteBalance] : undefined;
  const temperature = params.Temperature ?? named?.temperature;
  const tint = params.Tint ?? named?.tint;

  if (temperature === undefined && tint === undefined) {
    return { ...asShot, multipliers: { ...camera.asShotMultipliers } };
  }
  const t = clampSlider('Temperature', temperature ?? asShot.temperature);
  const ti = clampSlider('Tint', tint ?? asShot.tint);
  return {
    temperature: t,
    tint: ti,
    multipliers: multipliersFromTemperatureTint(camera.xyzToCamera, t, ti),
  };
}
