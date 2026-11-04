import type {
  AppSettings,
  DevelopSettingGroupId,
  ExportPreset,
  FileNamingMode,
  IptcFields,
  TemplateApplyMode,
} from '@ee/contracts';
import { DEVELOP_SETTING_GROUPS, IPTC_FIELD_NAMES, asPresetId } from '@ee/contracts';
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
