import type { PresetId } from './ids';

/**
 * Develop parameters. Names and value ranges deliberately mirror the Adobe
 * Camera Raw / Lightroom `crs:` XMP namespace so presets and sidecars
 * round-trip without a translation table. An absent field means "not touched":
 * the neutral value applies (for white balance, the as-shot value).
 */

/** White balance mode as written by Lightroom in `crs:WhiteBalance`. */
export type WhiteBalanceMode =
  | 'As Shot'
  | 'Auto'
  | 'Daylight'
  | 'Cloudy'
  | 'Shade'
  | 'Tungsten'
  | 'Fluorescent'
  | 'Flash'
  | 'Custom';

/** One tone-curve control point: `[input, output]`, both 0..255 (as in `crs:ToneCurvePV2012`). */
export type ToneCurvePoint = readonly [input: number, output: number];

/** Crop rectangle in normalized coordinates of the oriented image, plus straighten angle. */
export interface CropParams {
  /** Left edge, 0..1. */
  left: number;
  /** Top edge, 0..1. */
  top: number;
  /** Right edge, 0..1 (greater than `left`). */
  right: number;
  /** Bottom edge, 0..1 (greater than `top`). */
  bottom: number;
  /** Straighten angle in degrees, positive = clockwise. */
  angle: number;
}

/** Develop settings for one photo version. All fields optional; see module comment. */
export interface EditParams {
  /** Camera Raw process version, e.g. `'11.0'`. Only the 2012+ model is supported. */
  ProcessVersion?: string;
  WhiteBalance?: WhiteBalanceMode;
  /** Kelvin for raws (2000..50000). Absent = as shot. */
  Temperature?: number;
  /** -150..150. Absent = as shot. */
  Tint?: number;
  /** Exposure in stops, -5..5. */
  Exposure2012?: number;
  /** -100..100. */
  Contrast2012?: number;
  /** -100..100. */
  Highlights2012?: number;
  /** -100..100. */
  Shadows2012?: number;
  /** -100..100. */
  Whites2012?: number;
  /** -100..100. */
  Blacks2012?: number;
  /** -100..100. */
  Vibrance?: number;
  /** -100..100. */
  Saturation?: number;
  /** Master (RGB) tone curve. Absent or empty = linear. */
  ToneCurvePV2012?: ToneCurvePoint[];
  ToneCurvePV2012Red?: ToneCurvePoint[];
  ToneCurvePV2012Green?: ToneCurvePoint[];
  ToneCurvePV2012Blue?: ToneCurvePoint[];
  crop?: CropParams;
}

/** The scalar slider parameters of {@link EditParams}, in the order the right panel shows them. */
export const SLIDER_PARAMS = [
  'Exposure2012',
  'Temperature',
  'Tint',
  'Contrast2012',
  'Highlights2012',
  'Shadows2012',
  'Whites2012',
  'Blacks2012',
  'Vibrance',
  'Saturation',
] as const satisfies readonly (keyof EditParams)[];

/** Name of a scalar slider parameter. */
export type SliderParam = (typeof SLIDER_PARAMS)[number];

/** Range and neutral value of one slider. */
export interface SliderSpec {
  min: number;
  max: number;
  step: number;
  /** Neutral value, or `null` when the neutral state is "as shot" (temperature/tint). */
  neutral: number | null;
}

/** Slider ranges, shared by the UI and the preset parser (which clamps to them). */
export const SLIDER_SPECS: Readonly<Record<SliderParam, SliderSpec>> = {
  Exposure2012: { min: -5, max: 5, step: 0.01, neutral: 0 },
  Temperature: { min: 2000, max: 50000, step: 1, neutral: null },
  Tint: { min: -150, max: 150, step: 1, neutral: null },
  Contrast2012: { min: -100, max: 100, step: 1, neutral: 0 },
  Highlights2012: { min: -100, max: 100, step: 1, neutral: 0 },
  Shadows2012: { min: -100, max: 100, step: 1, neutral: 0 },
  Whites2012: { min: -100, max: 100, step: 1, neutral: 0 },
  Blacks2012: { min: -100, max: 100, step: 1, neutral: 0 },
  Vibrance: { min: -100, max: 100, step: 1, neutral: 0 },
  Saturation: { min: -100, max: 100, step: 1, neutral: 0 },
};

/** A develop preset imported from a Lightroom/Camera Raw `.xmp` file. */
export interface EditPreset {
  id: PresetId;
  /** Display name (`crs:PresetName`, falling back to the file name). */
  name: string;
  /** Path of the file it was imported from. */
  path: string;
  /** Only the parameters the preset sets; apply by spreading over the current params. */
  params: EditParams;
}
