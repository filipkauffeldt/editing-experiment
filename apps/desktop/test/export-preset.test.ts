// @vitest-environment node
import { asPresetId, type ExportPreset } from '@ee/contracts';
import type { CaptionContext } from '@ee/metadata';
import { describe, expect, it } from 'vitest';
import { resolveExportFileName, resolveExportFolder } from '../src/jobs/backend/export-service';
import { defaultExportPreset } from '../src/shared/settings';

const preset = (overrides: Partial<ExportPreset> = {}): ExportPreset => ({
  ...defaultExportPreset(),
  name: 'Sportfotografen',
  ...overrides,
});

const context = (overrides: Partial<CaptionContext> = {}): CaptionContext => ({
  filePath: '/cards/NIKON_Z9/A1.NEF',
  fileName: 'A1.NEF',
  fileNameBase: 'A1',
  captureTime: '2026-10-24T14:10:07',
  fields: { event: 'Derby', city: 'Stockholm' },
  now: new Date('2026-10-25T12:00:00'),
  ...overrides,
});

describe('export preset paths', () => {
  it('expands folder and file templates with metadata variables and {preset}', () => {
    expect(
      resolveExportFolder(
        preset({ folderTemplate: '{folder}/Export/{preset}' }),
        context(),
        '/exports',
      ),
    ).toBe('/exports/NIKON_Z9/Export/Sportfotografen');

    expect(
      resolveExportFileName(
        preset({ fileNameTemplate: '{filenamebase}-{event}-{date}' }),
        context(),
      ),
    ).toBe('A1-Derby-2026-10-24.jpg');
  });

  it('uses absolute folder templates as they are', () => {
    expect(
      resolveExportFolder(
        preset({ folderTemplate: '/tmp/ee-out/{preset}/{city}' }),
        context(),
        '/exports',
      ),
    ).toBe('/tmp/ee-out/Sportfotografen/Stockholm');
  });

  it('sanitizes the preset name in paths', () => {
    expect(
      resolveExportFolder(
        preset({ name: 'Press/Web: 2400', folderTemplate: '{preset}' }),
        context(),
        '/exports',
      ),
    ).toBe('/exports/Press-Web- 2400');
  });

  it('refuses to escape the export root', () => {
    expect(() =>
      resolveExportFolder(preset({ folderTemplate: '../outside' }), context(), '/exports'),
    ).toThrowError(/escapes/);
  });

  it('keeps an extension the template already has and adds .jpg otherwise', () => {
    expect(
      resolveExportFileName(preset({ fileNameTemplate: '{filenamebase}.JPG' }), context()),
    ).toBe('A1.JPG');
    expect(resolveExportFileName(preset({ fileNameTemplate: '{filenamebase}' }), context())).toBe(
      'A1.jpg',
    );
    expect(() =>
      resolveExportFileName(preset({ fileNameTemplate: '../{filenamebase}' }), context()),
    ).toThrowError(/file name/i);
  });

  it('carries the preset id when the name is only punctuation', () => {
    expect(
      resolveExportFolder(
        preset({ id: asPresetId('preset-7'), name: '///', folderTemplate: '{preset}' }),
        context(),
        '/exports',
      ),
    ).toBe('/exports/preset-7');
  });
});
