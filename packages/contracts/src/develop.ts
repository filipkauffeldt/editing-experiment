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

/** Lightroom's post-crop vignette styles, as written by `crs:PostCropVignetteStyle`. */
export type VignetteStyle = 'Highlight Priority' | 'Color Priority' | 'Paint Overlay';

/** One colour mixer band, in Lightroom's order. */
export type ColorMixerBand =
  'Red' | 'Orange' | 'Yellow' | 'Green' | 'Aqua' | 'Blue' | 'Purple' | 'Magenta';

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
  /** -100..100. Local contrast over fine to medium detail. */
  Texture?: number;
  /** -100..100. Local contrast over coarse detail. */
  Clarity2012?: number;
  /** -100..100. */
  Dehaze?: number;
  /** Sharpening amount, 0..150. */
  Sharpness?: number;
  /** Sharpening radius in pixels of the full-resolution image, 0.5..3. */
  SharpenRadius?: number;
  /** 0..100. */
  SharpenDetail?: number;
  /** 0..100. */
  SharpenEdgeMasking?: number;
  /** Luminance noise reduction amount, 0..100. */
  LuminanceSmoothing?: number;
  /** 0..100. */
  LuminanceNoiseReductionDetail?: number;
  /** 0..100. */
  LuminanceNoiseReductionContrast?: number;
  /** Colour noise reduction amount, 0..100. */
  ColorNoiseReduction?: number;
  /** 0..100. */
  ColorNoiseReductionDetail?: number;
  /** 0..100. */
  ColorNoiseReductionSmoothness?: number;
  /** Master (RGB) tone curve. Absent or empty = linear. */
  ToneCurvePV2012?: ToneCurvePoint[];
  ToneCurvePV2012Red?: ToneCurvePoint[];
  ToneCurvePV2012Green?: ToneCurvePoint[];
  ToneCurvePV2012Blue?: ToneCurvePoint[];

  /** Color Mixer (HSL): hue, saturation and luminance shift per band, -100..100. */
  HueAdjustmentRed?: number;
  SaturationAdjustmentRed?: number;
  LuminanceAdjustmentRed?: number;
  HueAdjustmentOrange?: number;
  SaturationAdjustmentOrange?: number;
  LuminanceAdjustmentOrange?: number;
  HueAdjustmentYellow?: number;
  SaturationAdjustmentYellow?: number;
  LuminanceAdjustmentYellow?: number;
  HueAdjustmentGreen?: number;
  SaturationAdjustmentGreen?: number;
  LuminanceAdjustmentGreen?: number;
  HueAdjustmentAqua?: number;
  SaturationAdjustmentAqua?: number;
  LuminanceAdjustmentAqua?: number;
  HueAdjustmentBlue?: number;
  SaturationAdjustmentBlue?: number;
  LuminanceAdjustmentBlue?: number;
  HueAdjustmentPurple?: number;
  SaturationAdjustmentPurple?: number;
  LuminanceAdjustmentPurple?: number;
  HueAdjustmentMagenta?: number;
  SaturationAdjustmentMagenta?: number;
  LuminanceAdjustmentMagenta?: number;

  /** Color grading: hue 0..360, saturation 0..100, luminance -100..100. */
  ColorGradeShadowHue?: number;
  ColorGradeShadowSat?: number;
  ColorGradeShadowLum?: number;
  ColorGradeMidtoneHue?: number;
  ColorGradeMidtoneSat?: number;
  ColorGradeMidtoneLum?: number;
  ColorGradeHighlightHue?: number;
  ColorGradeHighlightSat?: number;
  ColorGradeHighlightLum?: number;
  ColorGradeGlobalHue?: number;
  ColorGradeGlobalSat?: number;
  ColorGradeGlobalLum?: number;
  /** 0..100; 50 is Lightroom's default. */
  ColorGradeBlending?: number;
  /** -100..100. */
  ColorGradeBalance?: number;
  /** Legacy split toning, read from old presets when no ColorGrade* values are present. */
  SplitToningShadowHue?: number;
  SplitToningShadowSaturation?: number;
  SplitToningHighlightHue?: number;
  SplitToningHighlightSaturation?: number;
  SplitToningBalance?: number;

  /** Camera Calibration. */
  ShadowTint?: number;
  RedHue?: number;
  RedSaturation?: number;
  GreenHue?: number;
  GreenSaturation?: number;
  BlueHue?: number;
  BlueSaturation?: number;

  /** Parametric tone curve regions and their split points (0..100). */
  ParametricShadows?: number;
  ParametricDarks?: number;
  ParametricLights?: number;
  ParametricHighlights?: number;
  ParametricShadowSplit?: number;
  ParametricMidtoneSplit?: number;
  ParametricHighlightSplit?: number;

  /** Post-crop vignette. */
  PostCropVignetteAmount?: number;
  PostCropVignetteMidpoint?: number;
  PostCropVignetteRoundness?: number;
  PostCropVignetteFeather?: number;
  PostCropVignetteHighlights?: number;
  PostCropVignetteStyle?: VignetteStyle;

  /** Grain. Amount, Size and Frequency are 0..100. */
  GrainAmount?: number;
  GrainSize?: number;
  GrainFrequency?: number;

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
  'HueAdjustmentRed',
  'SaturationAdjustmentRed',
  'LuminanceAdjustmentRed',
  'HueAdjustmentOrange',
  'SaturationAdjustmentOrange',
  'LuminanceAdjustmentOrange',
  'HueAdjustmentYellow',
  'SaturationAdjustmentYellow',
  'LuminanceAdjustmentYellow',
  'HueAdjustmentGreen',
  'SaturationAdjustmentGreen',
  'LuminanceAdjustmentGreen',
  'HueAdjustmentAqua',
  'SaturationAdjustmentAqua',
  'LuminanceAdjustmentAqua',
  'HueAdjustmentBlue',
  'SaturationAdjustmentBlue',
  'LuminanceAdjustmentBlue',
  'HueAdjustmentPurple',
  'SaturationAdjustmentPurple',
  'LuminanceAdjustmentPurple',
  'HueAdjustmentMagenta',
  'SaturationAdjustmentMagenta',
  'LuminanceAdjustmentMagenta',
  'ColorGradeShadowHue',
  'ColorGradeShadowSat',
  'ColorGradeShadowLum',
  'ColorGradeMidtoneHue',
  'ColorGradeMidtoneSat',
  'ColorGradeMidtoneLum',
  'ColorGradeHighlightHue',
  'ColorGradeHighlightSat',
  'ColorGradeHighlightLum',
  'ColorGradeGlobalHue',
  'ColorGradeGlobalSat',
  'ColorGradeGlobalLum',
  'ColorGradeBlending',
  'ColorGradeBalance',
  'RedHue',
  'RedSaturation',
  'GreenHue',
  'GreenSaturation',
  'BlueHue',
  'BlueSaturation',
  'ShadowTint',
  'ParametricShadows',
  'ParametricDarks',
  'ParametricLights',
  'ParametricHighlights',
  'ParametricShadowSplit',
  'ParametricMidtoneSplit',
  'ParametricHighlightSplit',
  'PostCropVignetteAmount',
  'PostCropVignetteMidpoint',
  'PostCropVignetteRoundness',
  'PostCropVignetteFeather',
  'PostCropVignetteHighlights',
  'GrainAmount',
  'GrainSize',
  'GrainFrequency',
  'Texture',
  'Clarity2012',
  'Dehaze',
  'Sharpness',
  'SharpenRadius',
  'SharpenDetail',
  'SharpenEdgeMasking',
  'LuminanceSmoothing',
  'LuminanceNoiseReductionDetail',
  'LuminanceNoiseReductionContrast',
  'ColorNoiseReduction',
  'ColorNoiseReductionDetail',
  'ColorNoiseReductionSmoothness',
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
  HueAdjustmentRed: { min: -100, max: 100, step: 1, neutral: 0 },
  SaturationAdjustmentRed: { min: -100, max: 100, step: 1, neutral: 0 },
  LuminanceAdjustmentRed: { min: -100, max: 100, step: 1, neutral: 0 },
  HueAdjustmentOrange: { min: -100, max: 100, step: 1, neutral: 0 },
  SaturationAdjustmentOrange: { min: -100, max: 100, step: 1, neutral: 0 },
  LuminanceAdjustmentOrange: { min: -100, max: 100, step: 1, neutral: 0 },
  HueAdjustmentYellow: { min: -100, max: 100, step: 1, neutral: 0 },
  SaturationAdjustmentYellow: { min: -100, max: 100, step: 1, neutral: 0 },
  LuminanceAdjustmentYellow: { min: -100, max: 100, step: 1, neutral: 0 },
  HueAdjustmentGreen: { min: -100, max: 100, step: 1, neutral: 0 },
  SaturationAdjustmentGreen: { min: -100, max: 100, step: 1, neutral: 0 },
  LuminanceAdjustmentGreen: { min: -100, max: 100, step: 1, neutral: 0 },
  HueAdjustmentAqua: { min: -100, max: 100, step: 1, neutral: 0 },
  SaturationAdjustmentAqua: { min: -100, max: 100, step: 1, neutral: 0 },
  LuminanceAdjustmentAqua: { min: -100, max: 100, step: 1, neutral: 0 },
  HueAdjustmentBlue: { min: -100, max: 100, step: 1, neutral: 0 },
  SaturationAdjustmentBlue: { min: -100, max: 100, step: 1, neutral: 0 },
  LuminanceAdjustmentBlue: { min: -100, max: 100, step: 1, neutral: 0 },
  HueAdjustmentPurple: { min: -100, max: 100, step: 1, neutral: 0 },
  SaturationAdjustmentPurple: { min: -100, max: 100, step: 1, neutral: 0 },
  LuminanceAdjustmentPurple: { min: -100, max: 100, step: 1, neutral: 0 },
  HueAdjustmentMagenta: { min: -100, max: 100, step: 1, neutral: 0 },
  SaturationAdjustmentMagenta: { min: -100, max: 100, step: 1, neutral: 0 },
  LuminanceAdjustmentMagenta: { min: -100, max: 100, step: 1, neutral: 0 },
  ColorGradeShadowHue: { min: 0, max: 360, step: 1, neutral: 0 },
  ColorGradeShadowSat: { min: 0, max: 100, step: 1, neutral: 0 },
  ColorGradeShadowLum: { min: -100, max: 100, step: 1, neutral: 0 },
  ColorGradeMidtoneHue: { min: 0, max: 360, step: 1, neutral: 0 },
  ColorGradeMidtoneSat: { min: 0, max: 100, step: 1, neutral: 0 },
  ColorGradeMidtoneLum: { min: -100, max: 100, step: 1, neutral: 0 },
  ColorGradeHighlightHue: { min: 0, max: 360, step: 1, neutral: 0 },
  ColorGradeHighlightSat: { min: 0, max: 100, step: 1, neutral: 0 },
  ColorGradeHighlightLum: { min: -100, max: 100, step: 1, neutral: 0 },
  ColorGradeGlobalHue: { min: 0, max: 360, step: 1, neutral: 0 },
  ColorGradeGlobalSat: { min: 0, max: 100, step: 1, neutral: 0 },
  ColorGradeGlobalLum: { min: -100, max: 100, step: 1, neutral: 0 },
  ColorGradeBlending: { min: 0, max: 100, step: 1, neutral: 50 },
  ColorGradeBalance: { min: -100, max: 100, step: 1, neutral: 0 },
  RedHue: { min: -100, max: 100, step: 1, neutral: 0 },
  RedSaturation: { min: -100, max: 100, step: 1, neutral: 0 },
  GreenHue: { min: -100, max: 100, step: 1, neutral: 0 },
  GreenSaturation: { min: -100, max: 100, step: 1, neutral: 0 },
  BlueHue: { min: -100, max: 100, step: 1, neutral: 0 },
  BlueSaturation: { min: -100, max: 100, step: 1, neutral: 0 },
  ShadowTint: { min: -100, max: 100, step: 1, neutral: 0 },
  ParametricShadows: { min: -100, max: 100, step: 1, neutral: 0 },
  ParametricDarks: { min: -100, max: 100, step: 1, neutral: 0 },
  ParametricLights: { min: -100, max: 100, step: 1, neutral: 0 },
  ParametricHighlights: { min: -100, max: 100, step: 1, neutral: 0 },
  ParametricShadowSplit: { min: 0, max: 100, step: 1, neutral: 25 },
  ParametricMidtoneSplit: { min: 0, max: 100, step: 1, neutral: 50 },
  ParametricHighlightSplit: { min: 0, max: 100, step: 1, neutral: 75 },
  PostCropVignetteAmount: { min: -100, max: 100, step: 1, neutral: 0 },
  PostCropVignetteMidpoint: { min: 0, max: 100, step: 1, neutral: 50 },
  PostCropVignetteRoundness: { min: -100, max: 100, step: 1, neutral: 0 },
  PostCropVignetteFeather: { min: 0, max: 100, step: 1, neutral: 50 },
  PostCropVignetteHighlights: { min: 0, max: 100, step: 1, neutral: 0 },
  GrainAmount: { min: 0, max: 100, step: 1, neutral: 0 },
  GrainSize: { min: 0, max: 100, step: 1, neutral: 25 },
  GrainFrequency: { min: 0, max: 100, step: 1, neutral: 50 },
  Texture: { min: -100, max: 100, step: 1, neutral: 0 },
  Clarity2012: { min: -100, max: 100, step: 1, neutral: 0 },
  Dehaze: { min: -100, max: 100, step: 1, neutral: 0 },
  // Absent sharpening and noise reduction mean "off" (Lightroom's own raw defaults, Sharpness 40
  // and colour noise reduction 25, are not applied); the detail sliders' neutrals are Lightroom's.
  Sharpness: { min: 0, max: 150, step: 1, neutral: 0 },
  SharpenRadius: { min: 0.5, max: 3, step: 0.1, neutral: 1 },
  SharpenDetail: { min: 0, max: 100, step: 1, neutral: 25 },
  SharpenEdgeMasking: { min: 0, max: 100, step: 1, neutral: 0 },
  LuminanceSmoothing: { min: 0, max: 100, step: 1, neutral: 0 },
  LuminanceNoiseReductionDetail: { min: 0, max: 100, step: 1, neutral: 50 },
  LuminanceNoiseReductionContrast: { min: 0, max: 100, step: 1, neutral: 0 },
  ColorNoiseReduction: { min: 0, max: 100, step: 1, neutral: 0 },
  ColorNoiseReductionDetail: { min: 0, max: 100, step: 1, neutral: 50 },
  ColorNoiseReductionSmoothness: { min: 0, max: 100, step: 1, neutral: 50 },
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
