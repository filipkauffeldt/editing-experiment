import type {
  AppSettings,
  DevelopSettingGroupId,
  ExportPreset,
  FileNamingMode,
  IptcFields,
  PhotoStatusFilter,
  SavedFilter,
  StoredFilter,
  TemplateApplyMode,
} from '@ee/contracts';
import {
  DEVELOP_SETTING_GROUPS,
  IPTC_FIELD_NAMES,
  MAX_SAVED_FILTER_NAME,
  asPresetId,
  asSourceId,
} from '@ee/contracts';
import { join } from 'node:path';
import { DEFAULT_FOLDER_TEMPLATE } from './export-folder';
import { defaultPanelWidths } from './panel-widths';

/** The preset used until the user changes one, and after a FinishAction migration. */
export function defaultExportPreset(): ExportPreset {
  return {
    id: asPresetId('default'),
    name: 'Sportfotografen',
    folderTemplate: DEFAULT_FOLDER_TEMPLATE,
    fileNaming: 'rename',
    fileNameTemplate: '{filenamebase}',
    ifExists: 'suffix',
    format: 'jpeg',
    quality: 90,
    colorSpace: 'srgb',
    resize: { mode: 'none' },
    outputSharpening: { target: 'none', amount: 'standard' },
    metadata: 'all',
    stripGps: false,
    version: 'top',
    sendTo: [],
  };
}

/** Settings used until the user changes them. */
export function defaultSettings(homeDir: string): AppSettings {
  const preset = defaultExportPreset();
  return {
    ingest: {
      destination: { path: join(homeDir, 'Pictures', 'ee-ingest') },
      fileNaming: 'rename',
      renameTemplate: '{date}_{seq:4}',
      metadataTemplateMode: 'replace',
    },
    exportRoot: join(homeDir, 'Pictures', 'ee-exports'),
    exportPresets: [preset],
    activePresetId: preset.id,
    metadataTemplates: [],
    codeReplacementPaths: [],
    panelWidths: defaultPanelWidths(),
  };
}

/**
 * Merge mode used for the ingest template when settings do not say. Replace is
 * the default: cameras often write their own copyright/artist, and the template
 * must correct those fields.
 */
export const DEFAULT_TEMPLATE_MODE: TemplateApplyMode = 'replace';

/**
 * Naming used when settings do not say, and by a fresh install. Ingest and
 * export renamed by template before the explicit choice existed.
 */
export const DEFAULT_FILE_NAMING: FileNamingMode = 'rename';

/**
 * Keep only known ids, so a selection saved by an older version does not fail
 * when a field or group is renamed or removed. Values that are not an array at
 * all are treated as "nothing remembered" (undefined), not as an empty tick list.
 */
function knownIds<T extends string>(value: unknown, known: readonly T[]): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<string>(known);
  const ids: T[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item) || ids.some((id) => id === item)) continue;
    ids.push(item as T);
  }
  return ids;
}

export function sanitizeCopyMetadataFields(value: unknown): (keyof IptcFields)[] | undefined {
  return knownIds(value, IPTC_FIELD_NAMES);
}

export function sanitizeCopySettingGroups(value: unknown): DevelopSettingGroupId[] | undefined {
  return knownIds(
    value,
    DEVELOP_SETTING_GROUPS.map((group) => group.id),
  );
}

const STATUS_IDS: readonly PhotoStatusFilter[] = [
  'not-sent',
  'not-exported',
  'exported',
  'failed',
  'edited',
  'metadata-differs',
];
const RATING_MODES: readonly StoredFilter['ratingMode'][] = ['min', 'exact', 'max', 'unrated'];
const TAGS: readonly StoredFilter['tag'][] = ['all', 'tagged', 'untagged'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const colourList = (value: unknown): number[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter((item): item is number => Number.isInteger(item) && item >= 1 && item <= 8),
        ),
      ]
    : [];

/**
 * A stored filter, with whatever is unusable dropped or reset: a file written by another version
 * or edited by hand must never stop the filter bar. Not an object at all means no filter.
 */
export function sanitizeStoredFilter(value: unknown): StoredFilter | undefined {
  if (!isRecord(value)) return undefined;
  const stars = value.ratingStars;
  const mode = RATING_MODES.find((candidate) => candidate === value.ratingMode) ?? 'min';
  const tag = TAGS.find((candidate) => candidate === value.tag) ?? 'all';
  const colorClasses = colourList(value.colorClasses);
  // A colour is never both shown and hidden; shown wins, as it did when the filter was saved.
  const excludedColors = colourList(value.excludedColors).filter(
    (colour) => !colorClasses.includes(colour),
  );
  return {
    tag,
    ratingStars:
      Number.isInteger(stars) && (stars as number) >= 0 && (stars as number) <= 5
        ? (stars as number)
        : 0,
    ratingMode: mode,
    colorClasses,
    excludedColors,
    statuses: Array.isArray(value.statuses)
      ? [...new Set(value.statuses)].filter((status): status is PhotoStatusFilter =>
          STATUS_IDS.some((known) => known === status),
        )
      : [],
    ...(typeof value.camera === 'string' && value.camera !== '' ? { camera: value.camera } : {}),
    ...(typeof value.sourceId === 'string' && value.sourceId !== ''
      ? { sourceId: asSourceId(value.sourceId) }
      : {}),
    search: typeof value.search === 'string' ? value.search : '',
  };
}

/** Saved filters with a usable id, name and filter; the first of two equal ids wins. */
export function sanitizeSavedFilters(value: unknown): SavedFilter[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const result: SavedFilter[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name =
      typeof item.name === 'string' ? item.name.trim().slice(0, MAX_SAVED_FILTER_NAME) : '';
    const filter = sanitizeStoredFilter(item.filter);
    if (typeof item.id !== 'string' || item.id === '' || name === '' || !filter) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push({ id: item.id, name, filter });
  }
  return result;
}
