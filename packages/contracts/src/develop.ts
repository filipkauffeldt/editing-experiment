import type { PhotoId, PresetId } from './ids';

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

  /**
   * Lens Corrections. Absent means the camera's own default: on for lenses the camera marks as
   * needing software correction (Nikon "Required"), otherwise off.
   */
  LensProfileEnable?: boolean;
  /** Read only: the Adobe profile Lightroom picked. Kept for round trips, never applied or written for our choice. */
  LensProfileName?: string;
  /** Read only, as {@link EditParams.LensProfileName}. */
  LensProfileFilename?: string;
  /** Profile distortion correction amount, 0..200 (100 = the profile as measured). */
  LensProfileDistortionScale?: number;
  /** Profile vignetting correction amount, 0..200. */
  LensProfileVignettingScale?: number;
  /** Remove Chromatic Aberration: measured from the photo, needs no lens data. */
  AutoLateralCA?: boolean;
  /** Manual distortion, -100..100; positive corrects barrel distortion. */
  LensManualDistortionAmount?: number;
  /** Manual lens vignette (before the crop, unlike the post-crop vignette), -100..100; positive lightens the corners. */
  VignetteAmount?: number;
  /** 0..100. */
  VignetteMidpoint?: number;
  /** Defringe amounts 0..20 and hue ranges 0..100 (`crs:Defringe*`). */
  DefringePurpleAmount?: number;
  DefringePurpleHueLo?: number;
  DefringePurpleHueHi?: number;
  DefringeGreenAmount?: number;
  DefringeGreenHueLo?: number;
  DefringeGreenHueHi?: number;
  /**
   * Our own lens profile choice (`ee:LensProfile`): `'builtin'` for the camera's data in the file, or
   * `'lensfun:<index key>'` for a Lensfun lens. Absent = automatic (built-in when the file has it,
   * else the best Lensfun match). Not a `crs:` name, because Lightroom would look for an Adobe
   * profile of that name.
   */
  LensProfileChoice?: string;

  /**
   * Camera profile (`crs:CameraProfile`): the name of a DNG camera profile (`Adobe Standard`,
   * `Camera Standard`, ...). Absent means no profile: colour comes from the decoder's camera matrix.
   * The name is kept when the file is not on this machine (the panel says so).
   */
  CameraProfile?: string;
  /** `crs:CameraProfileDigest`; kept for round trips, never computed. */
  CameraProfileDigest?: string;
  /** Lightroom 7+ look over the camera profile (`crs:Look`): its name (flattened `crs:LookName`) ... */
  LookName?: string;
  /** ... its UUID (`crs:LookUUID`) ... */
  LookUUID?: string;
  /** ... and its Amount, 1 = 100 % (`crs:LookAmount`, 0..2). Absent means 1. */
  LookAmount?: number;

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
  'LensProfileDistortionScale',
  'LensProfileVignettingScale',
  'LensManualDistortionAmount',
  'VignetteAmount',
  'VignetteMidpoint',
  'DefringePurpleAmount',
  'DefringePurpleHueLo',
  'DefringePurpleHueHi',
  'DefringeGreenAmount',
  'DefringeGreenHueLo',
  'DefringeGreenHueHi',
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
  LensProfileDistortionScale: { min: 0, max: 200, step: 1, neutral: 100 },
  LensProfileVignettingScale: { min: 0, max: 200, step: 1, neutral: 100 },
  LensManualDistortionAmount: { min: -100, max: 100, step: 1, neutral: 0 },
  VignetteAmount: { min: -100, max: 100, step: 1, neutral: 0 },
  VignetteMidpoint: { min: 0, max: 100, step: 1, neutral: 50 },
  DefringePurpleAmount: { min: 0, max: 20, step: 1, neutral: 0 },
  DefringePurpleHueLo: { min: 0, max: 100, step: 1, neutral: 30 },
  DefringePurpleHueHi: { min: 0, max: 100, step: 1, neutral: 70 },
  DefringeGreenAmount: { min: 0, max: 20, step: 1, neutral: 0 },
  DefringeGreenHueLo: { min: 0, max: 100, step: 1, neutral: 40 },
  DefringeGreenHueHi: { min: 0, max: 100, step: 1, neutral: 60 },
};

/**
 * The sharpening and noise reduction settings Lightroom applies to **raw** files
 * when the sidecar does not set them (Sharpness 40, colour noise reduction 25),
 * each overridden by the camera's own `crd:` camera-raw-defaults when the file
 * carries them. Absent means "the default"; an explicit `0` is off. Never applied
 * to JPEG or TIFF, and never written to the sidecar.
 */
export const DETAIL_DEFAULT_PARAMS = [
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
] as const satisfies readonly SliderParam[];

export type DetailDefaultParam = (typeof DETAIL_DEFAULT_PARAMS)[number];

/** Lightroom's raw defaults for the detail settings, before any `crd:` override. */
export const RAW_DETAIL_DEFAULTS: Readonly<Partial<Record<DetailDefaultParam, number>>> = {
  Sharpness: 40,
  SharpenRadius: 1,
  SharpenDetail: 25,
  SharpenEdgeMasking: 0,
  ColorNoiseReduction: 25,
  ColorNoiseReductionDetail: 50,
  ColorNoiseReductionSmoothness: 50,
};

/** `params` over `defaults`: the settings a renderer should use. Never written back. */
export function withDefaults(params: EditParams, defaults: EditParams | undefined): EditParams {
  if (!defaults || Object.keys(defaults).length === 0) return params;
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as EditParams;
}

// ---------------------------------------------------------------------------
// Copying settings between photos
// ---------------------------------------------------------------------------

/**
 * A group of develop settings, as Lightroom's Copy/Sync Settings dialog shows
 * them. Every `EditParams` field belongs to exactly one group; the test in
 * `test/develop.test.ts` fails when a new field is not assigned.
 */
export interface DevelopSettingGroup {
  id: string;
  label: string;
  fields: readonly (keyof EditParams)[];
}

/** The groups, in the order the Copy Settings dialog shows them. */
export const DEVELOP_SETTING_GROUPS = [
  {
    id: 'whiteBalance',
    label: 'White Balance',
    fields: ['WhiteBalance', 'Temperature', 'Tint'],
  },
  {
    id: 'basicTone',
    label: 'Basic Tone',
    fields: [
      'ProcessVersion',
      'Exposure2012',
      'Contrast2012',
      'Highlights2012',
      'Shadows2012',
      'Whites2012',
      'Blacks2012',
    ],
  },
  {
    id: 'presence',
    label: 'Presence',
    fields: ['Texture', 'Clarity2012', 'Dehaze', 'Vibrance', 'Saturation'],
  },
  {
    id: 'toneCurve',
    label: 'Tone Curve',
    fields: [
      'ToneCurvePV2012',
      'ToneCurvePV2012Red',
      'ToneCurvePV2012Green',
      'ToneCurvePV2012Blue',
      'ParametricShadows',
      'ParametricDarks',
      'ParametricLights',
      'ParametricHighlights',
      'ParametricShadowSplit',
      'ParametricMidtoneSplit',
      'ParametricHighlightSplit',
    ],
  },
  {
    id: 'colorMixer',
    label: 'Color Mixer',
    fields: [
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
    ],
  },
  {
    id: 'colorGrading',
    label: 'Color Grading',
    fields: [
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
      'SplitToningShadowHue',
      'SplitToningShadowSaturation',
      'SplitToningHighlightHue',
      'SplitToningHighlightSaturation',
      'SplitToningBalance',
    ],
  },
  {
    id: 'detail',
    label: 'Detail',
    fields: [
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
    ],
  },
  {
    id: 'lensCorrections',
    label: 'Lens Corrections',
    fields: [
      'LensProfileEnable',
      'LensProfileName',
      'LensProfileFilename',
      'LensProfileDistortionScale',
      'LensProfileVignettingScale',
      'AutoLateralCA',
      'LensManualDistortionAmount',
      'VignetteAmount',
      'VignetteMidpoint',
      'DefringePurpleAmount',
      'DefringePurpleHueLo',
      'DefringePurpleHueHi',
      'DefringeGreenAmount',
      'DefringeGreenHueLo',
      'DefringeGreenHueHi',
      'LensProfileChoice',
    ],
  },
  {
    id: 'effects',
    label: 'Effects',
    fields: [
      'PostCropVignetteAmount',
      'PostCropVignetteMidpoint',
      'PostCropVignetteRoundness',
      'PostCropVignetteFeather',
      'PostCropVignetteHighlights',
      'PostCropVignetteStyle',
      'GrainAmount',
      'GrainSize',
      'GrainFrequency',
    ],
  },
  {
    id: 'calibration',
    label: 'Calibration',
    fields: [
      'ShadowTint',
      'RedHue',
      'RedSaturation',
      'GreenHue',
      'GreenSaturation',
      'BlueHue',
      'BlueSaturation',
    ],
  },
  {
    id: 'crop',
    label: 'Crop',
    fields: ['crop'],
  },
] as const satisfies readonly DevelopSettingGroup[];

/** Id of one group in {@link DEVELOP_SETTING_GROUPS}. */
export type DevelopSettingGroupId = (typeof DEVELOP_SETTING_GROUPS)[number]['id'];

/** Groups copied by default: everything except Crop. */
export const DEFAULT_COPY_SETTING_GROUPS: readonly DevelopSettingGroupId[] =
  DEVELOP_SETTING_GROUPS.filter((group) => group.id !== 'crop').map((group) => group.id);

/**
 * Every `EditParams` field, in declaration order. The type below fails to
 * compile when a field is added to `EditParams` without being listed here, and
 * the test fails when a listed field is not assigned to a group.
 */
export const EDIT_PARAM_KEYS = [
  'ProcessVersion',
  'WhiteBalance',
  'Temperature',
  'Tint',
  'Exposure2012',
  'Contrast2012',
  'Highlights2012',
  'Shadows2012',
  'Whites2012',
  'Blacks2012',
  'Vibrance',
  'Saturation',
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
  'ToneCurvePV2012',
  'ToneCurvePV2012Red',
  'ToneCurvePV2012Green',
  'ToneCurvePV2012Blue',
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
  'SplitToningShadowHue',
  'SplitToningShadowSaturation',
  'SplitToningHighlightHue',
  'SplitToningHighlightSaturation',
  'SplitToningBalance',
  'ShadowTint',
  'RedHue',
  'RedSaturation',
  'GreenHue',
  'GreenSaturation',
  'BlueHue',
  'BlueSaturation',
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
  'PostCropVignetteStyle',
  'GrainAmount',
  'GrainSize',
  'GrainFrequency',
  'LensProfileEnable',
  'LensProfileName',
  'LensProfileFilename',
  'LensProfileDistortionScale',
  'LensProfileVignettingScale',
  'AutoLateralCA',
  'LensManualDistortionAmount',
  'VignetteAmount',
  'VignetteMidpoint',
  'DefringePurpleAmount',
  'DefringePurpleHueLo',
  'DefringePurpleHueHi',
  'DefringeGreenAmount',
  'DefringeGreenHueLo',
  'DefringeGreenHueHi',
  'LensProfileChoice',
  'crop',
] as const satisfies readonly (keyof EditParams)[];

/** Compile-time guard: every `EditParams` field must appear in `EDIT_PARAM_KEYS`. */
export type UnlistedEditParam = Exclude<keyof EditParams, (typeof EDIT_PARAM_KEYS)[number]>;
export const ALL_EDIT_PARAMS_ARE_LISTED: [UnlistedEditParam] extends [never] ? true : never = true;

/** The group with this id, or `undefined` for an unknown id. */
export function developSettingGroup(id: string): DevelopSettingGroup | undefined {
  return DEVELOP_SETTING_GROUPS.find((group) => group.id === id);
}

/** Every field covered by the given groups, in group order. */
export function developSettingFields(
  groupIds: readonly DevelopSettingGroupId[],
): (keyof EditParams)[] {
  const fields: (keyof EditParams)[] = [];
  for (const id of groupIds) {
    const group = developSettingGroup(id);
    if (group) fields.push(...group.fields);
  }
  return fields;
}

/**
 * Copy the selected groups from `source` onto `target`. A field the source does
 * not set is removed from the target, so pasting a neutral group resets it
 * rather than leaving the target's old value in place. Unselected groups are
 * left untouched.
 */
export function applyDevelopSettingGroups(
  target: EditParams,
  source: EditParams,
  groupIds: readonly DevelopSettingGroupId[],
): EditParams {
  const next: Record<string, unknown> = { ...target };
  for (const field of developSettingFields(groupIds)) {
    const value = source[field];
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  return next as EditParams;
}

/** Arguments of `develop:applySettings`. */
export interface ApplyDevelopSettingsArgs {
  photoIds: PhotoId[];
  /** The source photo's settings (as shown, including raw defaults). */
  params: EditParams;
  /** Groups to take from `params`; every other field stays as the photo has it. */
  groups: DevelopSettingGroupId[];
}

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
