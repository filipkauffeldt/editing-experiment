import type { AppSettings, TemplateApplyMode } from '@ee/contracts';
import { join } from 'node:path';

/** Settings used until the user changes them. */
export function defaultSettings(homeDir: string): AppSettings {
  return {
    ingest: {
      destination: { path: join(homeDir, 'Pictures', 'ee-ingest') },
      renameTemplate: '{date}_{seq:4}',
      codeReplacementPaths: [],
    },
    finishAction: {
      exportPreset: { quality: 90, metadata: 'all' },
      destinations: [],
    },
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
