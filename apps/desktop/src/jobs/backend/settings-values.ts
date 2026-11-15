import {
  IpcError,
  asPresetId,
  type AppSettings,
  type DestinationId,
  type ExportPreset,
  type FileNamingMode,
  type SourceConfig,
  type TemplateApplyMode,
} from '@ee/contracts';
import {
  DEFAULT_FILE_NAMING,
  DEFAULT_TEMPLATE_MODE,
  sanitizeCopyMetadataFields,
  sanitizeCopySettingGroups,
} from '../../shared/settings';
import {
  DEFAULT_FOLDER_TEMPLATE,
  LEGACY_DEFAULT_FOLDER_TEMPLATE,
} from '../../shared/export-folder';
import { sanitizePanelWidths } from '../../shared/panel-widths';

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isTemplateApplyMode = (value: unknown): value is TemplateApplyMode =>
  value === 'replace' || value === 'fillEmpty';

export const isFileNamingMode = (value: unknown): value is FileNamingMode =>
  value === 'keep' || value === 'rename';

/**
 * Settings written before the explicit choice always renamed. Keep the
 * template untouched so switching back to Rename restores it.
 */
export function migratePresetNaming(value: unknown): { preset: ExportPreset; migrated: boolean } {
  if (!isObject(value)) return { preset: value as ExportPreset, migrated: false };
  if (isFileNamingMode(value.fileNaming)) {
    return { preset: value as unknown as ExportPreset, migrated: false };
  }
  return { preset: { ...value, fileNaming: 'rename' } as unknown as ExportPreset, migrated: true };
}

/**
 * A preset that still has exactly the old default folder template moves to the new default
 * (next to the photo). Only an exact match: any edit, even a space, was a choice.
 */
export function migratePresetFolder(preset: ExportPreset): {
  preset: ExportPreset;
  migrated: boolean;
} {
  if (!isObject(preset) || preset.folderTemplate !== LEGACY_DEFAULT_FOLDER_TEMPLATE) {
    return { preset, migrated: false };
  }
  return { preset: { ...preset, folderTemplate: DEFAULT_FOLDER_TEMPLATE }, migrated: true };
}

export function migratePreset(value: unknown): { preset: ExportPreset; migrated: boolean } {
  const naming = migratePresetNaming(value);
  const folder = migratePresetFolder(naming.preset);
  return { preset: folder.preset, migrated: naming.migrated || folder.migrated };
}

/**
 * Local sources used to have a single `lockedOnly` boolean. It maps to the
 * lock filter now, and the old key is dropped so it is not persisted again.
 */
export function migrateSource(value: unknown): SourceConfig {
  if (!isObject(value) || (value.kind !== 'folder' && value.kind !== 'card')) {
    return value as SourceConfig;
  }
  const { lockedOnly, ...rest } = value;
  if (lockedOnly === true && rest.lockFilter === undefined) {
    rest.lockFilter = 'locked';
  }
  return rest as unknown as SourceConfig;
}

export function assertIngest(value: unknown): asserts value is AppSettings['ingest'] {
  if (
    !isObject(value) ||
    !isObject(value.destination) ||
    typeof value.destination.path !== 'string' ||
    value.destination.path === '' ||
    typeof value.renameTemplate !== 'string' ||
    !isFileNamingMode(value.fileNaming) ||
    (value.fileNaming === 'rename' && value.renameTemplate.trim() === '') ||
    (value.metadataTemplateMode !== undefined &&
      !isTemplateApplyMode(value.metadataTemplateMode)) ||
    (value.developPresetId !== undefined && typeof value.developPresetId !== 'string')
  ) {
    throw new IpcError(
      'invalid_argument',
      'ingest settings need destination.path and fileNaming, plus a rename template when renaming',
    );
  }
}

function isQuality(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100;
}

export function assertExportPreset(value: unknown): asserts value is ExportPreset {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    value.id === '' ||
    typeof value.name !== 'string' ||
    value.name.trim() === '' ||
    typeof value.folderTemplate !== 'string' ||
    value.folderTemplate.trim() === '' ||
    !isFileNamingMode(value.fileNaming) ||
    typeof value.fileNameTemplate !== 'string' ||
    (value.fileNaming === 'rename' && value.fileNameTemplate.trim() === '') ||
    !['suffix', 'overwrite', 'skip'].includes(String(value.ifExists)) ||
    value.format !== 'jpeg' ||
    !isQuality(value.quality) ||
    value.colorSpace !== 'srgb' ||
    !isObject(value.resize) ||
    !['none', 'longEdge', 'shortEdge', 'megapixels'].includes(String(value.resize.mode)) ||
    !isObject(value.outputSharpening) ||
    !['none', 'screen', 'matte', 'glossy'].includes(String(value.outputSharpening.target)) ||
    !['low', 'standard', 'high'].includes(String(value.outputSharpening.amount)) ||
    !['all', 'iptc', 'copyright', 'none'].includes(String(value.metadata)) ||
    typeof value.stripGps !== 'boolean' ||
    !['top', 'develop'].includes(String(value.version)) ||
    !Array.isArray(value.sendTo)
  ) {
    throw new IpcError(
      'invalid_argument',
      'export presets need id, name, templates, ifExists, format, quality, colorSpace, ' +
        'resize, outputSharpening, metadata, stripGps, version and sendTo',
    );
  }
  if (value.version === 'develop' && value.sendTo.length > 0) {
    throw new IpcError(
      'invalid_argument',
      'a develop-only export preset cannot have send targets; use the top retouch version',
    );
  }
}

export function isPathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((path) => typeof path === 'string' && path.trim() !== '')
  );
}

export function pathList(value: unknown): string[] | undefined {
  if (!isPathList(value)) return undefined;
  return [...new Set(value)];
}

function assertStringList(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new IpcError('invalid_argument', `${name} must be a list of strings`);
  }
}

export function assertSettingsPatch(patch: Partial<AppSettings>): void {
  if (patch.ingest !== undefined) assertIngest(patch.ingest);
  if (
    patch.exportRoot !== undefined &&
    (typeof patch.exportRoot !== 'string' || patch.exportRoot === '')
  ) {
    throw new IpcError('invalid_argument', 'exportRoot must be a non-empty path');
  }
  if (patch.exportPresets !== undefined) {
    if (!Array.isArray(patch.exportPresets) || patch.exportPresets.length === 0) {
      throw new IpcError('invalid_argument', 'exportPresets must be a non-empty array');
    }
    for (const preset of patch.exportPresets) assertExportPreset(preset);
  }
  if (patch.activePresetId !== undefined && typeof patch.activePresetId !== 'string') {
    throw new IpcError('invalid_argument', 'activePresetId must be a preset id');
  }
  if (
    patch.profileFolders !== undefined &&
    (!Array.isArray(patch.profileFolders) ||
      patch.profileFolders.some((folder) => typeof folder !== 'string' || folder === ''))
  ) {
    throw new IpcError('invalid_argument', 'profileFolders must be a list of folder paths');
  }
  if (
    patch.presetFolders !== undefined &&
    (!Array.isArray(patch.presetFolders) ||
      patch.presetFolders.some((folder) => typeof folder !== 'string' || folder === ''))
  ) {
    throw new IpcError('invalid_argument', 'presetFolders must be a list of folder paths');
  }
  if (patch.metadataTemplates !== undefined && !isPathList(patch.metadataTemplates)) {
    throw new IpcError('invalid_argument', 'metadataTemplates must be a list of file paths');
  }
  if (patch.codeReplacementPaths !== undefined && !isPathList(patch.codeReplacementPaths)) {
    throw new IpcError('invalid_argument', 'codeReplacementPaths must be a list of file paths');
  }
  if (patch.copyMetadataFields !== undefined) {
    assertStringList(patch.copyMetadataFields, 'copyMetadataFields');
  }
  if (patch.copySettingGroups !== undefined) {
    assertStringList(patch.copySettingGroups, 'copySettingGroups');
  }
  if (patch.panelWidths !== undefined && !isObject(patch.panelWidths)) {
    throw new IpcError('invalid_argument', 'panelWidths must be an object of panel widths');
  }
}

/** The old single-action settings shape, kept only to migrate it. */
export interface LegacyFinishAction {
  exportPreset?: {
    maxEdge?: unknown;
    quality?: unknown;
    metadata?: unknown;
  };
  destinations?: unknown;
}

/** Turn the old FinishAction into a preset, keeping its destinations and size limit. */
export function presetFromFinishAction(
  legacy: LegacyFinishAction,
  fallback: ExportPreset,
): ExportPreset {
  const old = isObject(legacy.exportPreset) ? legacy.exportPreset : {};
  const destinations = Array.isArray(legacy.destinations)
    ? legacy.destinations.filter((id): id is DestinationId => typeof id === 'string')
    : [];
  const metadata = ['all', 'iptc', 'none'].includes(String(old.metadata))
    ? (old.metadata as ExportPreset['metadata'])
    : 'all';
  const maxEdge =
    typeof old.maxEdge === 'number' && Number.isInteger(old.maxEdge) && old.maxEdge > 0
      ? old.maxEdge
      : undefined;
  return {
    ...fallback,
    id: asPresetId('migrated-default'),
    name: 'Default',
    quality: isQuality(old.quality) ? old.quality : fallback.quality,
    resize: maxEdge === undefined ? { mode: 'none' } : { mode: 'longEdge', pixels: maxEdge },
    metadata,
    sendTo: destinations,
  };
}

export {
  DEFAULT_FILE_NAMING,
  DEFAULT_TEMPLATE_MODE,
  sanitizeCopyMetadataFields,
  sanitizeCopySettingGroups,
  sanitizePanelWidths,
};
