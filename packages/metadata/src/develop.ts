import {
  DETAIL_DEFAULT_PARAMS,
  RAW_DETAIL_DEFAULTS,
  SLIDER_SPECS,
  type CropParams,
  type EditParams,
  type ToneCurvePoint,
} from '@ee/contracts';
import { cropOrientedToStored, cropStoredToOriented, isUsableCrop } from '@ee/develop-gl/crop';
import { MetadataError } from './errors';
import { getExifToolService, type ExifToolService, type ExifToolTagValue } from './exiftool';
import {
  ensureMetadataTarget,
  fileExists,
  isRawPath,
  metadataTargetFor,
  sidecarPathFor,
} from './paths';
import { asBoolean, asNumber, asString, asStringList } from './values';

/**
 * `EditParams` ↔ Camera Raw `crs:` XMP properties.
 *
 * `crs:Temperature` is ExifTool's `XMP-crs:ColorTemperature` tag: the XML
 * property is `crs:Temperature`, but ExifTool exposes the writable tag under
 * its display name. Verified against ExifTool 13.59 (`XMP.pm`, crs table).
 */
const SCALAR_TAGS: Readonly<Record<ScalarKey, string>> = {
  ProcessVersion: 'XMP-crs:ProcessVersion',
  WhiteBalance: 'XMP-crs:WhiteBalance',
  Temperature: 'XMP-crs:ColorTemperature',
  Tint: 'XMP-crs:Tint',
  Exposure2012: 'XMP-crs:Exposure2012',
  Contrast2012: 'XMP-crs:Contrast2012',
  Highlights2012: 'XMP-crs:Highlights2012',
  Shadows2012: 'XMP-crs:Shadows2012',
  Whites2012: 'XMP-crs:Whites2012',
  Blacks2012: 'XMP-crs:Blacks2012',
  Vibrance: 'XMP-crs:Vibrance',
  Saturation: 'XMP-crs:Saturation',
  HueAdjustmentRed: 'XMP-crs:HueAdjustmentRed',
  SaturationAdjustmentRed: 'XMP-crs:SaturationAdjustmentRed',
  LuminanceAdjustmentRed: 'XMP-crs:LuminanceAdjustmentRed',
  HueAdjustmentOrange: 'XMP-crs:HueAdjustmentOrange',
  SaturationAdjustmentOrange: 'XMP-crs:SaturationAdjustmentOrange',
  LuminanceAdjustmentOrange: 'XMP-crs:LuminanceAdjustmentOrange',
  HueAdjustmentYellow: 'XMP-crs:HueAdjustmentYellow',
  SaturationAdjustmentYellow: 'XMP-crs:SaturationAdjustmentYellow',
  LuminanceAdjustmentYellow: 'XMP-crs:LuminanceAdjustmentYellow',
  HueAdjustmentGreen: 'XMP-crs:HueAdjustmentGreen',
  SaturationAdjustmentGreen: 'XMP-crs:SaturationAdjustmentGreen',
  LuminanceAdjustmentGreen: 'XMP-crs:LuminanceAdjustmentGreen',
  HueAdjustmentAqua: 'XMP-crs:HueAdjustmentAqua',
  SaturationAdjustmentAqua: 'XMP-crs:SaturationAdjustmentAqua',
  LuminanceAdjustmentAqua: 'XMP-crs:LuminanceAdjustmentAqua',
  HueAdjustmentBlue: 'XMP-crs:HueAdjustmentBlue',
  SaturationAdjustmentBlue: 'XMP-crs:SaturationAdjustmentBlue',
  LuminanceAdjustmentBlue: 'XMP-crs:LuminanceAdjustmentBlue',
  HueAdjustmentPurple: 'XMP-crs:HueAdjustmentPurple',
  SaturationAdjustmentPurple: 'XMP-crs:SaturationAdjustmentPurple',
  LuminanceAdjustmentPurple: 'XMP-crs:LuminanceAdjustmentPurple',
  HueAdjustmentMagenta: 'XMP-crs:HueAdjustmentMagenta',
  SaturationAdjustmentMagenta: 'XMP-crs:SaturationAdjustmentMagenta',
  LuminanceAdjustmentMagenta: 'XMP-crs:LuminanceAdjustmentMagenta',
  ColorGradeShadowHue: 'XMP-crs:SplitToningShadowHue',
  ColorGradeShadowSat: 'XMP-crs:SplitToningShadowSaturation',
  ColorGradeShadowLum: 'XMP-crs:ColorGradeShadowLum',
  ColorGradeMidtoneHue: 'XMP-crs:ColorGradeMidtoneHue',
  ColorGradeMidtoneSat: 'XMP-crs:ColorGradeMidtoneSat',
  ColorGradeMidtoneLum: 'XMP-crs:ColorGradeMidtoneLum',
  ColorGradeHighlightHue: 'XMP-crs:SplitToningHighlightHue',
  ColorGradeHighlightSat: 'XMP-crs:SplitToningHighlightSaturation',
  ColorGradeHighlightLum: 'XMP-crs:ColorGradeHighlightLum',
  ColorGradeGlobalHue: 'XMP-crs:ColorGradeGlobalHue',
  ColorGradeGlobalSat: 'XMP-crs:ColorGradeGlobalSat',
  ColorGradeGlobalLum: 'XMP-crs:ColorGradeGlobalLum',
  ColorGradeBlending: 'XMP-crs:ColorGradeBlending',
  ColorGradeBalance: 'XMP-crs:SplitToningBalance',
  ShadowTint: 'XMP-crs:ShadowTint',
  RedHue: 'XMP-crs:RedHue',
  RedSaturation: 'XMP-crs:RedSaturation',
  GreenHue: 'XMP-crs:GreenHue',
  GreenSaturation: 'XMP-crs:GreenSaturation',
  BlueHue: 'XMP-crs:BlueHue',
  BlueSaturation: 'XMP-crs:BlueSaturation',
  ParametricShadows: 'XMP-crs:ParametricShadows',
  ParametricDarks: 'XMP-crs:ParametricDarks',
  ParametricLights: 'XMP-crs:ParametricLights',
  ParametricHighlights: 'XMP-crs:ParametricHighlights',
  ParametricShadowSplit: 'XMP-crs:ParametricShadowSplit',
  ParametricMidtoneSplit: 'XMP-crs:ParametricMidtoneSplit',
  ParametricHighlightSplit: 'XMP-crs:ParametricHighlightSplit',
  PostCropVignetteAmount: 'XMP-crs:PostCropVignetteAmount',
  PostCropVignetteMidpoint: 'XMP-crs:PostCropVignetteMidpoint',
  PostCropVignetteRoundness: 'XMP-crs:PostCropVignetteRoundness',
  PostCropVignetteFeather: 'XMP-crs:PostCropVignetteFeather',
  PostCropVignetteHighlights: 'XMP-crs:PostCropVignetteHighlightContrast',
  PostCropVignetteStyle: 'XMP-crs:PostCropVignetteStyle',
  GrainAmount: 'XMP-crs:GrainAmount',
  GrainSize: 'XMP-crs:GrainSize',
  GrainFrequency: 'XMP-crs:GrainFrequency',
  Texture: 'XMP-crs:Texture',
  Clarity2012: 'XMP-crs:Clarity2012',
  Dehaze: 'XMP-crs:Dehaze',
  Sharpness: 'XMP-crs:Sharpness',
  SharpenRadius: 'XMP-crs:SharpenRadius',
  SharpenDetail: 'XMP-crs:SharpenDetail',
  SharpenEdgeMasking: 'XMP-crs:SharpenEdgeMasking',
  LuminanceSmoothing: 'XMP-crs:LuminanceSmoothing',
  LuminanceNoiseReductionDetail: 'XMP-crs:LuminanceNoiseReductionDetail',
  LuminanceNoiseReductionContrast: 'XMP-crs:LuminanceNoiseReductionContrast',
  ColorNoiseReduction: 'XMP-crs:ColorNoiseReduction',
  ColorNoiseReductionDetail: 'XMP-crs:ColorNoiseReductionDetail',
  ColorNoiseReductionSmoothness: 'XMP-crs:ColorNoiseReductionSmoothness',
};

type LegacySplitToningKey =
  | 'SplitToningShadowHue'
  | 'SplitToningShadowSaturation'
  | 'SplitToningHighlightHue'
  | 'SplitToningHighlightSaturation'
  | 'SplitToningBalance';

/** Model keys written as `crs:` scalars (legacy split toning is folded into Color Grade). */
type ScalarKey = Exclude<keyof EditParams, 'crop' | ToneCurveKey | LegacySplitToningKey>;

type ToneCurveKey =
  'ToneCurvePV2012' | 'ToneCurvePV2012Red' | 'ToneCurvePV2012Green' | 'ToneCurvePV2012Blue';

const TONE_CURVE_TAGS: Readonly<Record<ToneCurveKey, string>> = {
  ToneCurvePV2012: 'XMP-crs:ToneCurvePV2012',
  ToneCurvePV2012Red: 'XMP-crs:ToneCurvePV2012Red',
  ToneCurvePV2012Green: 'XMP-crs:ToneCurvePV2012Green',
  ToneCurvePV2012Blue: 'XMP-crs:ToneCurvePV2012Blue',
};

const CROP_TAGS = {
  left: 'XMP-crs:CropLeft',
  top: 'XMP-crs:CropTop',
  right: 'XMP-crs:CropRight',
  bottom: 'XMP-crs:CropBottom',
  angle: 'XMP-crs:CropAngle',
} as const;

/** Oriented image geometry needed to convert `crs:Crop*` to/from stored pixel space. */
export interface CropSpace {
  /** EXIF orientation (1..8) of the stored original. */
  orientation?: number;
  /** Oriented image width in pixels. */
  width?: number;
  /** Oriented image height in pixels. */
  height?: number;
}

const DEFAULT_PROCESS_VERSION = '11.0';

const VIGNETTE_STYLES: readonly NonNullable<EditParams['PostCropVignetteStyle']>[] = [
  'Highlight Priority',
  'Color Priority',
  'Paint Overlay',
];

function usableCropSpace(space: CropSpace | undefined): space is CropSpace & {
  width: number;
  height: number;
} {
  return (
    space !== undefined &&
    space.width !== undefined &&
    space.height !== undefined &&
    space.width > 0 &&
    space.height > 0
  );
}

/** Lightroom stores crop corners in the pre-orientation array; the app uses oriented coordinates. */
function toOrientedCrop(crop: CropParams, space: CropSpace | undefined): CropParams {
  if (!usableCropSpace(space)) return crop;
  return cropStoredToOriented(
    crop,
    { width: space.width, height: space.height },
    space.orientation ?? 1,
  );
}

function toStoredCrop(crop: CropParams, space: CropSpace | undefined): CropParams {
  if (!usableCropSpace(space)) return crop;
  return cropOrientedToStored(
    crop,
    { width: space.width, height: space.height },
    space.orientation ?? 1,
  );
}

async function readTargetTags(
  path: string,
  service: ExifToolService,
): Promise<Record<string, unknown> | undefined> {
  const target = isRawPath(path) ? sidecarPathFor(path) : metadataTargetFor(path);
  if (!(await fileExists(target))) {
    if (isRawPath(path)) return undefined;
    throw new MetadataError('EXIFTOOL', `Metadata file not found: ${target}`);
  }
  return service.read(target);
}

/**
 * Read develop settings from the sidecar (raws) or embedded XMP (JPEG/TIFF).
 *
 * Raw files are never parsed themselves: Nikon NEFs embed a `crd:`
 * camera-raw-defaults packet (with `crd:Exposure2012` etc.) that must not be
 * mistaken for user edits. Only `<basename>.xmp` is read for raws.
 */
export async function readEditParams(
  path: string,
  service: ExifToolService = getExifToolService(),
  cropSpace?: CropSpace,
): Promise<EditParams> {
  const tags = await readTargetTags(path, service);
  if (tags === undefined) return {};

  const params: EditParams = {};

  for (const [key, tag] of Object.entries(SCALAR_TAGS) as Array<[ScalarKey, string]>) {
    const raw = tags[tag];
    if (key === 'PostCropVignetteStyle') {
      const text = asString(raw)?.trim();
      const byCode = (
        { 1: 'Highlight Priority', 2: 'Color Priority', 3: 'Paint Overlay' } as Record<
          string,
          NonNullable<EditParams['PostCropVignetteStyle']>
        >
      )[text ?? ''];
      const style =
        byCode ??
        VIGNETTE_STYLES.find((candidate) => candidate.toLowerCase() === text?.toLowerCase());
      if (style) params.PostCropVignetteStyle = style;
      continue;
    }
    if (key === 'ProcessVersion' || key === 'WhiteBalance') {
      const text = asString(raw);
      if (text !== undefined && text !== '') {
        if (key === 'ProcessVersion') {
          // ExifTool treats the version as a number, so JSON gives 11 for the
          // Lightroom value "11.0". Restore the conventional major.minor form.
          params.ProcessVersion = /^\d+$/.test(text) ? `${text}.0` : text;
        } else {
          params.WhiteBalance = text as EditParams['WhiteBalance'];
        }
      }
      continue;
    }
    const value = asNumber(raw);
    if (value !== undefined) {
      (params as Record<string, unknown>)[key] = value;
    }
  }

  for (const [key, tag] of Object.entries(TONE_CURVE_TAGS) as Array<[ToneCurveKey, string]>) {
    const points = parseToneCurve(tags[tag]);
    if (points.length > 0) params[key] = points;
  }

  // A sidecar with split-toning tags but no modern ColorGrade tags is a legacy
  // split-tone edit, which Lightroom renders as grading at Blending 100.
  const hasSplitToning = Object.values(SCALAR_TAGS).some(
    (tag) => tag.startsWith('XMP-crs:SplitToning') && tags[tag] !== undefined,
  );
  const hasModernGrading = [
    'XMP-crs:ColorGradeMidtoneHue',
    'XMP-crs:ColorGradeMidtoneSat',
    'XMP-crs:ColorGradeMidtoneLum',
    'XMP-crs:ColorGradeShadowLum',
    'XMP-crs:ColorGradeHighlightLum',
    'XMP-crs:ColorGradeGlobalHue',
    'XMP-crs:ColorGradeGlobalSat',
    'XMP-crs:ColorGradeGlobalLum',
  ].some((tag) => tags[tag] !== undefined);
  if (hasSplitToning && !hasModernGrading && params.ColorGradeBlending === undefined) {
    params.ColorGradeBlending = 100;
  }

  // Lightroom's `crs:HasCrop` gates the rectangle: stale coordinates from a
  // reset crop must not come back. Missing `HasCrop` is tolerated for files
  // written by other tools, but an explicit false always wins.
  const hasCrop = asBoolean(tags['XMP-crs:HasCrop']);
  if (hasCrop !== false) {
    const left = asNumber(tags[CROP_TAGS.left]);
    const top = asNumber(tags[CROP_TAGS.top]);
    const right = asNumber(tags[CROP_TAGS.right]);
    const bottom = asNumber(tags[CROP_TAGS.bottom]);
    const angle = asNumber(tags[CROP_TAGS.angle]) ?? 0;
    if (
      left !== undefined &&
      top !== undefined &&
      right !== undefined &&
      bottom !== undefined &&
      isUsableCrop({ left, top, right, bottom, angle })
    ) {
      params.crop = toOrientedCrop({ left, top, right, bottom, angle }, cropSpace);
    }
  }

  return params;
}

function parseToneCurve(raw: unknown): ToneCurvePoint[] {
  const parts = asStringList(raw);
  if (parts.length === 0) return [];
  const points: ToneCurvePoint[] = [];
  let sawPairedValue = false;
  for (const part of parts) {
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(part);
    if (match === null) continue;
    points.push([Number(match[1]), Number(match[2])]);
    sawPairedValue = true;
  }
  if (sawPairedValue) return points;

  // Some ExifTool paths flatten an rdf:Seq into "0, 0, 255, 255".
  const numbers = parts
    .join(', ')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
  if (numbers.length >= 4 && numbers.length % 2 === 0) {
    for (let i = 0; i < numbers.length; i += 2) {
      points.push([numbers[i] as number, numbers[i + 1] as number]);
    }
  }
  return points;
}

export interface WriteEditParamsOptions {
  service?: ExifToolService;
  /** Oriented size and EXIF orientation of the original, to write Lightroom's stored-space crop. */
  cropSpace?: CropSpace;
}

/**
 * Replace the modelled develop settings. Supported `crs:` properties that are
 * absent from `params` are removed; unmodelled Camera Raw properties (history,
 * local adjustments, ...) are left untouched.
 */
export async function writeEditParams(
  path: string,
  params: EditParams,
  options: WriteEditParamsOptions = {},
): Promise<void> {
  const service = options.service ?? getExifToolService();
  const tags: Record<string, ExifToolTagValue> = {};
  let anySetting = false;

  for (const [key, tag] of Object.entries(SCALAR_TAGS) as Array<[ScalarKey, string]>) {
    const value = params[key];
    if (value === undefined) {
      tags[tag] = null;
      continue;
    }
    tags[tag] = value;
    anySetting = true;
  }

  if (anySetting && params.ProcessVersion === undefined) {
    tags['XMP-crs:ProcessVersion'] = DEFAULT_PROCESS_VERSION;
  }

  for (const [key, tag] of Object.entries(TONE_CURVE_TAGS) as Array<[ToneCurveKey, string]>) {
    const curve = params[key];
    if (curve === undefined || curve.length === 0) {
      tags[tag] = null;
      continue;
    }
    tags[tag] = curve.map(([x, y]) => `${x}, ${y}`);
    anySetting = true;
  }

  if (params.crop === undefined) {
    for (const tag of Object.values(CROP_TAGS)) tags[tag] = null;
    tags['XMP-crs:HasCrop'] = null;
  } else {
    writeCrop(tags, toStoredCrop(params.crop, options.cropSpace));
    anySetting = true;
  }

  tags['XMP-crs:HasSettings'] = anySetting ? true : null;

  if (!anySetting && isRawPath(path) && !(await fileExists(sidecarPathFor(path)))) return;
  const writePath = await ensureMetadataTarget(path);
  await service.write(writePath, tags);
}

function writeCrop(tags: Record<string, ExifToolTagValue>, crop: CropParams): void {
  // Not `right > left`: the corners are opposite corners of the rotated rectangle,
  // so a wide frame tilted far one way stores them inverted (see isUsableCrop).
  if (!isUsableCrop(crop)) {
    throw new MetadataError(
      'INVALID_XMP',
      `crop needs finite, distinct corners, got ${JSON.stringify(crop)}`,
    );
  }
  tags[CROP_TAGS.left] = crop.left;
  tags[CROP_TAGS.top] = crop.top;
  tags[CROP_TAGS.right] = crop.right;
  tags[CROP_TAGS.bottom] = crop.bottom;
  tags[CROP_TAGS.angle] = crop.angle;
  tags['XMP-crs:HasCrop'] = true;
}

/**
 * The detail settings Lightroom starts a raw file with: its fixed defaults, each
 * replaced by the camera's `crd:` (camera-raw-defaults) value when the file
 * carries one (Nikon NEFs embed them). Empty for anything that is not a raw.
 * Read-only: the raw file is never written, and these values are not edits.
 */
export async function readRawDefaults(
  path: string,
  service: ExifToolService = getExifToolService(),
): Promise<EditParams> {
  if (!isRawPath(path)) return {};
  const defaults: Record<string, number> = { ...RAW_DETAIL_DEFAULTS };
  const tags = await service.read(path);
  for (const name of DETAIL_DEFAULT_PARAMS) {
    const value = asNumber(tags[`XMP-crd:${name}`]);
    if (value === undefined) continue;
    const spec = SLIDER_SPECS[name];
    defaults[name] = Math.min(spec.max, Math.max(spec.min, value));
  }
  return defaults as EditParams;
}
