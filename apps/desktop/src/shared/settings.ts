import type { AppSettings, ExportPreset, FileNamingMode, TemplateApplyMode } from '@ee/contracts';
import { asPresetId } from '@ee/contracts';
import { join } from 'node:path';

/** The preset used until the user changes one, and after a FinishAction migration. */
export function defaultExportPreset(): ExportPreset {
  return {
    id: asPresetId('default'),
    name: 'Sportfotografen',
    folderTemplate: '{folder}/Export/{preset}',
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
