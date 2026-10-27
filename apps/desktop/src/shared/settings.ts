import type { AppSettings } from '@ee/contracts';
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
