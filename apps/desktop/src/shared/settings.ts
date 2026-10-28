import type { AppSettings, ExportPreset, TemplateApplyMode } from '@ee/contracts';
import { asPresetId } from '@ee/contracts';
import { join } from 'node:path';

/** The preset used until the user changes one, and after a FinishAction migration. */
export function defaultExportPreset(): ExportPreset {
  return {
    id: asPresetId('default'),
    name: 'Sportfotografen',
    folderTemplate: '{folder}/Export/{preset}',
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
      renameTemplate: '{date}_{seq:4}',
      codeReplacementPaths: [],
    },
    exportRoot: join(homeDir, 'Pictures', 'ee-exports'),
    exportPresets: [preset],
    activePresetId: preset.id,
  };
}

/**
 * Ingest options as the real backend persists them. `IngestConfig` has no field
 * for how the metadata template merges at ingest, so it is kept alongside the
 * other ingest settings (see "Contract concerns" in the PR).
 */
export type BackendIngestSettings = AppSettings['ingest'] & {
  metadataTemplateMode?: TemplateApplyMode;
};

/** Merge mode used for the ingest template when settings do not say. */
export const DEFAULT_TEMPLATE_MODE: TemplateApplyMode = 'fillEmpty';
