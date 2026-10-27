import type { EditParams, EditPreset, ToneCurvePoint, WhiteBalanceMode } from '@ee/contracts';
import { asPresetId, SLIDER_SPECS, type SliderParam } from '@ee/contracts';
import { normalizeCurvePoints } from '../spline';

/** Thrown when a file is not a parsable Lightroom/Camera Raw preset. */
export class PresetParseError extends Error {
  override readonly name = 'PresetParseError';
}

/** A setting as read from a preset file, before it is interpreted. */
export type RawSetting =
  | { kind: 'scalar'; value: string }
  | { kind: 'curve'; points: ToneCurvePoint[] }
  /** Structured content we do not interpret (parametric curves, masks, ...). */
  | { kind: 'other' };

export interface PresetMeta {
  /** Display name from the file, if it has one. */
  name?: string;
  uuid?: string;
}

export interface ParsedPreset {
  preset: EditPreset;
  /**
   * `crs:` settings the file sets that this app does not implement (names without
   * the namespace prefix, in file order). Settings at their zero/empty default are
   * not listed. Lets the UI say "N settings not supported".
   */
  unsupported: string[];
}

export interface ParseOptions {
  /** Path the text was read from; stored in the preset and used for its name and id when the file has none. */
  path?: string;
}

const WHITE_BALANCE_MODES: readonly WhiteBalanceMode[] = [
  'As Shot',
  'Auto',
  'Daylight',
  'Cloudy',
  'Shade',
  'Tungsten',
  'Fluorescent',
  'Flash',
  'Custom',
];

const CURVE_KEYS = {
  ToneCurvePV2012: 'ToneCurvePV2012',
  ToneCurvePV2012Red: 'ToneCurvePV2012Red',
  ToneCurvePV2012Green: 'ToneCurvePV2012Green',
  ToneCurvePV2012Blue: 'ToneCurvePV2012Blue',
} as const;

const SLIDER_NAMES = Object.keys(SLIDER_SPECS) as SliderParam[];

/** Preset bookkeeping that is not a develop setting, so it is neither applied nor reported as unsupported. */
const METADATA_KEYS = new Set([
  'PresetType',
  'Cluster',
  'UUID',
  'CameraModelRestriction',
  'Copyright',
  'ContactInfo',
  'Version',
  'ProcessVersion',
  'HasSettings',
  'Name',
  'ShortName',
  'SortName',
  'Group',
  'Description',
  'RequiresRGBTables',
  'ToneCurveName2012',
  'id',
  'internalName',
  'title',
  'type',
  'version',
]);

const isMetadata = (key: string): boolean => METADATA_KEYS.has(key) || key.startsWith('Supports');

/** A zero, empty or "False" value changes nothing, so it is not worth reporting as unsupported. */
function isDefaultValue(setting: RawSetting): boolean {
  if (setting.kind !== 'scalar') return false;
  const v = setting.value.trim();
  return v === '' || /^(false|none)$/i.test(v) || (Number.isFinite(Number(v)) && Number(v) === 0);
}

/** FNV-1a, so presets without a UUID still get a stable id. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

const baseName = (path: string): string => {
  const file = path.split(/[\\/]/).pop() ?? path;
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
};

/** Interprets raw settings: keeps what `EditParams` supports (clamped to `SLIDER_SPECS`) and lists the rest. */
export function settingsToPreset(
  settings: ReadonlyMap<string, RawSetting>,
  meta: PresetMeta,
  options: ParseOptions,
): ParsedPreset {
  const params: EditParams = {};
  const unsupported: string[] = [];

  for (const [key, setting] of settings) {
    if (isMetadata(key)) continue;

    if (key === 'WhiteBalance' && setting.kind === 'scalar') {
      const mode = WHITE_BALANCE_MODES.find(
        (m) => m.toLowerCase() === setting.value.trim().toLowerCase(),
      );
      if (mode) params.WhiteBalance = mode;
      else unsupported.push(key);
    } else if ((SLIDER_NAMES as string[]).includes(key) && setting.kind === 'scalar') {
      const n = Number(setting.value);
      const spec = SLIDER_SPECS[key as SliderParam];
      if (Number.isFinite(n))
        params[key as SliderParam] = Math.min(spec.max, Math.max(spec.min, n));
      else unsupported.push(key);
    } else if (key in CURVE_KEYS && setting.kind === 'curve') {
      const points = normalizeCurvePoints(setting.points);
      if (points.length >= 2) params[key as keyof typeof CURVE_KEYS] = points;
    } else if (!isDefaultValue(setting)) {
      unsupported.push(key);
    }
  }

  const processVersion = settings.get('ProcessVersion');
  if (processVersion?.kind === 'scalar' && processVersion.value.trim() !== '') {
    params.ProcessVersion = processVersion.value.trim();
  }
  // "As Shot" only restates the camera's own values; keeping them would pin a stale temperature.
  if (params.WhiteBalance === 'As Shot' || params.WhiteBalance === 'Auto') {
    delete params.Temperature;
    delete params.Tint;
  }

  const path = options.path ?? '';
  const name = meta.name?.trim() || (path ? baseName(path) : 'Untitled preset');
  return {
    preset: {
      id: asPresetId(meta.uuid?.trim() || `preset-${hash(path || name)}`),
      name,
      path,
      params,
    },
    unsupported: [...new Set(unsupported)],
  };
}

/**
 * Applies a preset on top of the current parameters: the preset's values win,
 * everything it does not mention stays. A preset that resets white balance to
 * "As Shot" also drops any manual temperature/tint.
 */
export function applyPreset(current: EditParams, preset: EditPreset): EditParams {
  const next: EditParams = { ...current, ...preset.params };
  if (preset.params.WhiteBalance === 'As Shot' || preset.params.WhiteBalance === 'Auto') {
    if (preset.params.Temperature === undefined) delete next.Temperature;
    if (preset.params.Tint === undefined) delete next.Tint;
  }
  return next;
}
