import { asPresetId, type ExportPreset } from '@ee/contracts';

/** A valid preset for tests that only care about one or two fields. */
export function testPreset(overrides: Partial<ExportPreset> = {}): ExportPreset {
  return {
    id: asPresetId('test-preset'),
    name: 'Test',
    folderTemplate: 'Export/{preset}',
    fileNameTemplate: '{filenamebase}',
    ifExists: 'overwrite',
    format: 'jpeg',
    quality: 90,
    colorSpace: 'srgb',
    resize: { mode: 'none' },
    outputSharpening: { target: 'none', amount: 'standard' },
    metadata: 'all',
    stripGps: false,
    version: 'top',
    sendTo: [],
    ...overrides,
  };
}
