import type { AppSettings, Destination, ExportPreset, PresetId, SourceConfig } from '@ee/contracts';
import type { LegacyFinishAction } from './settings-values';
import {
  DEFAULT_FILE_NAMING,
  DEFAULT_TEMPLATE_MODE,
  isFileNamingMode,
  isObject,
  isTemplateApplyMode,
  migratePreset,
  migrateSource,
  pathList,
  presetFromFinishAction,
  sanitizeCopyMetadataFields,
  sanitizeCopySettingGroups,
  sanitizePanelWidths,
} from './settings-values';

/** What one combined `settings.json` (version 1 or 2) says, before it is split. */
export interface LegacySettings {
  settings: AppSettings;
  sources: SourceConfig[];
  destinations: Destination[];
  migrated: boolean;
}

/**
 * Read the one-file settings an older version wrote. It keeps every migration that file
 * needs: finish action to preset, ingest templates to the global lists, template mode,
 * file naming, preset folder defaults, copy selections, panel widths and `lockedOnly`.
 */
export function readLegacySettings(parsed: unknown, defaults: AppSettings): LegacySettings {
  if (!isObject(parsed)) throw new Error('settings file is not an object');
  const fallbackPreset = defaults.exportPresets[0];
  if (!fallbackPreset) throw new Error('default settings have no export preset');
  let migrated = false;
  let presets: ExportPreset[];
  if (Array.isArray(parsed.exportPresets) && parsed.exportPresets.length > 0) {
    const migratedPresets = parsed.exportPresets.map(migratePreset);
    presets = migratedPresets.map((entry) => entry.preset);
    if (migratedPresets.some((entry) => entry.migrated)) migrated = true;
  } else if (isObject(parsed.finishAction)) {
    presets = [presetFromFinishAction(parsed.finishAction as LegacyFinishAction, fallbackPreset)];
    migrated = true;
  } else {
    presets = defaults.exportPresets;
  }
  const activePresetId =
    typeof parsed.activePresetId === 'string'
      ? (parsed.activePresetId as PresetId)
      : (presets[0]?.id ?? defaults.activePresetId);
  const storedIngest = isObject(parsed.ingest) ? parsed.ingest : undefined;
  let ingest: AppSettings['ingest'];
  let legacyTemplatePath: string | undefined;
  let legacyCodePaths: string[] | undefined;
  if (storedIngest === undefined) {
    ingest = defaults.ingest;
  } else {
    // Code replacement files used to live under ingest. They are global now.
    const { codeReplacementPaths: legacyPaths, ...rest } = storedIngest;
    legacyCodePaths = pathList(legacyPaths);
    if (legacyCodePaths !== undefined) migrated = true;
    if (typeof rest.metadataTemplatePath === 'string' && rest.metadataTemplatePath.trim() !== '') {
      legacyTemplatePath = rest.metadataTemplatePath.trim();
    }
    // Settings written before the mode existed mean Replace: a camera-written
    // copyright/artist must be corrected by the template, not kept.
    // Settings written before the naming choice existed mean Rename: templates
    // have always decided the name, and nothing may change silently.
    ingest = {
      ...(rest as unknown as AppSettings['ingest']),
      metadataTemplateMode: isTemplateApplyMode(rest.metadataTemplateMode)
        ? rest.metadataTemplateMode
        : DEFAULT_TEMPLATE_MODE,
      fileNaming: isFileNamingMode(rest.fileNaming) ? rest.fileNaming : DEFAULT_FILE_NAMING,
    };
    if (!isTemplateApplyMode(rest.metadataTemplateMode) || !isFileNamingMode(rest.fileNaming)) {
      migrated = true;
    }
  }

  // The single ingest template becomes part of the global template list, and
  // stays selected for ingest.
  const storedTemplates = pathList(parsed.metadataTemplates) ?? [];
  const metadataTemplates = [
    ...new Set([
      ...storedTemplates,
      ...(legacyTemplatePath === undefined ? [] : [legacyTemplatePath]),
    ]),
  ];
  if (legacyTemplatePath !== undefined && !storedTemplates.includes(legacyTemplatePath)) {
    migrated = true;
  }
  const codeReplacementPaths =
    pathList(parsed.codeReplacementPaths) ?? legacyCodePaths ?? defaults.codeReplacementPaths ?? [];

  const copyMetadataFields = sanitizeCopyMetadataFields(parsed.copyMetadataFields);
  const copySettingGroups = sanitizeCopySettingGroups(parsed.copySettingGroups);
  // Rewrite a selection that lost a removed field/group or was not a list at
  // all, so the file keeps only what the dialog can tick.
  if (
    parsed.copyMetadataFields !== undefined &&
    JSON.stringify(copyMetadataFields) !== JSON.stringify(parsed.copyMetadataFields)
  ) {
    migrated = true;
  }
  if (
    parsed.copySettingGroups !== undefined &&
    JSON.stringify(copySettingGroups) !== JSON.stringify(parsed.copySettingGroups)
  ) {
    migrated = true;
  }
  // A dragged width from an older version is clamped to what today's panel
  // can show; unknown panels and non-numbers are dropped.
  const panelWidths = sanitizePanelWidths(parsed.panelWidths);
  if (
    parsed.panelWidths !== undefined &&
    JSON.stringify(panelWidths) !== JSON.stringify(parsed.panelWidths)
  ) {
    migrated = true;
  }

  const rawSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  if (rawSources.some((source) => isObject(source) && 'lockedOnly' in source)) {
    migrated = true;
  }

  const settings: AppSettings = {
    ingest,
    exportRoot:
      typeof parsed.exportRoot === 'string' && parsed.exportRoot !== ''
        ? parsed.exportRoot
        : defaults.exportRoot,
    exportPresets: presets,
    ...(activePresetId === undefined ? {} : { activePresetId }),
    ...(Array.isArray(parsed.profileFolders)
      ? {
          profileFolders: parsed.profileFolders.filter(
            (folder): folder is string => typeof folder === 'string' && folder !== '',
          ),
        }
      : {}),
    ...(Array.isArray(parsed.presetFolders)
      ? {
          presetFolders: parsed.presetFolders.filter(
            (folder): folder is string => typeof folder === 'string' && folder !== '',
          ),
        }
      : {}),
    metadataTemplates,
    codeReplacementPaths,
    ...(copyMetadataFields === undefined ? {} : { copyMetadataFields }),
    ...(copySettingGroups === undefined ? {} : { copySettingGroups }),
    ...(panelWidths === undefined ? {} : { panelWidths }),
  };
  return {
    settings,
    sources: rawSources.map(migrateSource),
    destinations: Array.isArray(parsed.destinations) ? (parsed.destinations as Destination[]) : [],
    migrated,
  };
}
