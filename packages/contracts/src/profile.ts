import type { PhotoId } from './ids';

/**
 * Camera profiles, the way Lightroom and Camera Raw render a raw: a DNG Camera Profile (`.dcp`)
 * carries the colour matrices and the HueSatMap / LookTable / tone curve, an XMP profile (a "look",
 * e.g. Adobe Color) adds a table and a curve on top of one. The user supplies the files (they are
 * Adobe's; see `docs/ARCHITECTURE.md`, "Camera profiles"), the app never ships any.
 *
 * Everything here is plain data (numbers, strings, arrays) so it crosses IPC and the render worker
 * boundary unchanged.
 */

/**
 * A DNG HueSatMap or LookTable: a 3D table over hue, saturation and value (HSV of linear ProPhoto
 * RGB) holding, for each node, the hue shift in degrees and the saturation and value scales.
 */
export interface ProfileTable {
  hueDivisions: number;
  satDivisions: number;
  valDivisions: number;
  /** True when the value axis is sRGB encoded (`ProfileHueSatMapEncoding` / `ProfileLookTableEncoding` = 1). */
  srgbEncoding: boolean;
  /**
   * `hueDivisions * satDivisions * valDivisions` nodes of `[hueShift, satScale, valScale]`, flat.
   * Node order is the DNG one: value (outermost), then hue, then saturation.
   */
  data: number[];
}

/** A camera profile as read from a `.dcp`. */
export interface CameraProfileData {
  /** `ProfileName`, e.g. `Adobe Standard` or `Camera Standard`. */
  name: string;
  /** `UniqueCameraModel`, e.g. `Nikon Z 6`. */
  camera: string;
  /** `ProfileCopyright`. */
  copyright: string;
  /**
   * The colour temperature (K) of `CalibrationIlluminant1` and `2`, ascending. `colorMatrices` and
   * `forwardMatrices` (3x3 row-major, one or two) belong to these, in the same order. One matrix
   * means the profile does not depend on the white balance.
   */
  illuminants: number[];
  /** `ColorMatrix1/2`: XYZ (relative to the illuminant) to unbalanced camera RGB. Empty when absent. */
  colorMatrices: number[][];
  /** `ForwardMatrix1/2`: white-balanced camera RGB to XYZ D50. Empty when the profile has none. */
  forwardMatrices: number[][];
  /** `ProfileHueSatMapData1/2`, one per illuminant (or one for both). */
  hueSatMaps: ProfileTable[];
  /** `ProfileLookTable*`. */
  look?: ProfileTable;
  /** `ProfileToneCurve` as `[x0, y0, x1, y1, ...]` in 0..1; absent means the DNG default (ACR 3) curve. */
  toneCurve?: number[];
  /** `BaselineExposureOffset`, in stops. */
  baselineExposureOffset: number;
  /** `DefaultBlackRender`: `none` keeps the camera's blacks. Parsed; not applied (see ARCHITECTURE). */
  defaultBlackRender: 'auto' | 'none';
  /** `ProfileEmbedPolicy`: 0 allow copying, 1 embed if used, 2 embed never, 3 no restrictions. */
  embedPolicy: number;
}

/** The develop settings a look carries inside itself (added to the user's sliders at its Amount). */
export const LOOK_SETTING_KEYS = [
  'Highlights2012',
  'Shadows2012',
  'Contrast2012',
  'Blacks2012',
  'Clarity2012',
] as const;
export type LookSettingKey = (typeof LOOK_SETTING_KEYS)[number];

/** An XMP profile ("look", Lightroom's Adobe Raw group: Adobe Color, Landscape, Portrait, ...). */
export interface LookProfileData {
  /** `crs:Name`. */
  name: string;
  /** `crs:UUID`. */
  uuid: string;
  /** `crs:Group`, e.g. `Profiles`. */
  group: string;
  /** `crs:CameraProfile`: the camera profile the look is made for (`Adobe Standard`). */
  base: string;
  /** `crs:CameraModelRestriction`; empty for any camera. */
  restriction: string;
  copyright: string;
  /** `crs:SupportsAmount`: the Amount slider applies. */
  supportsAmount: boolean;
  /** The HSV look table (applied after the camera profile's LookTable). */
  table?: ProfileTable;
  /** The range a version 2 table lets its Amount move between (1, 1 for a version 1 table). */
  tableBounds: [min: number, max: number];
  /** `crs:ToneCurvePV2012` as `[x0, y0, ...]` in 0..1, applied like a point curve. Absent when identity. */
  curve?: number[];
  /** Develop settings inside the look, in the slider's own units. */
  settings: Partial<Record<LookSettingKey, number>>;
}

/** What the render needs of a profile choice: the camera profile and the look over it, if any. */
export interface ResolvedProfile {
  camera: CameraProfileData;
  look?: LookProfileData;
  /** The look's Amount as a fraction (1 = 100 %); ignored when the look does not support it. */
  amount: number;
}

/** Where Lightroom lists a profile. */
export type ProfileGroup = 'adobe-raw' | 'camera-matching' | 'other';

/** One profile found in the profile folders. */
export interface ProfileListing {
  /** Stable id: the file path (a file holds one profile). */
  id: string;
  /** `ProfileName` of a `.dcp`, `crs:Name` of an XMP look. */
  name: string;
  kind: 'camera' | 'look';
  group: ProfileGroup;
  /** `UniqueCameraModel` of a DCP; the look's camera restriction (empty = any camera). */
  camera: string;
  /** A look's base profile name. */
  base?: string;
  /** The look's UUID. */
  uuid?: string;
  supportsAmount?: boolean;
  path: string;
}

/** A file in a profile folder that could not be used, and why. */
export interface ProfileProblem {
  path: string;
  reason: string;
}

/** Result of scanning the profile folders. */
export interface ProfileIndex {
  profiles: ProfileListing[];
  problems: ProfileProblem[];
  /** The folders that were scanned (platform defaults that exist, plus the user's). */
  folders: string[];
}

/** The profile choice stored in a sidecar, as the renderer asks the backend to resolve it. */
export interface ProfileRequest {
  photoId: PhotoId;
  /** `crs:CameraProfile`. */
  profile?: string;
  /** `crs:LookName` and `crs:LookUUID`. */
  lookName?: string;
  lookUuid?: string;
  /** `crs:LookAmount`, 1 = 100 %. */
  lookAmount?: number;
}

/** Answer to {@link ProfileRequest}: the profile, or why it is not used. */
export type ProfileResolution =
  | { status: 'none' }
  | { status: 'ok'; profile: ResolvedProfile }
  | { status: 'missing'; reason: string };

/** `profiles:list`: what the Develop panel's profile select offers for one photo. */
export interface PhotoProfiles {
  /** The photo's camera model as profiles are matched against it. */
  camera: string;
  profiles: ProfileListing[];
}
