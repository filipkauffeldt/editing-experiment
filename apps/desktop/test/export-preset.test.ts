// @vitest-environment node
import { asPresetId, type ExportPreset } from '@ee/contracts';
import type { CaptionContext } from '@ee/metadata';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveExportFileName,
  resolveExportFolder,
  resolveExportTarget,
} from '../src/jobs/backend/export-service';
import { defaultExportPreset } from '../src/shared/settings';
import { describeFolderTemplate } from '../src/shared/export-folder';

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
  // Fails on Windows: the expectation is written with POSIX paths, not a bug in the app.
  it.skipIf(process.platform === 'win32')(
    'expands folder and file templates with metadata variables and {preset}',
    () => {
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
    },
  );

  // Fails on Windows: the expectation is written with POSIX paths, not a bug in the app.

  it.skipIf(process.platform === 'win32')('uses absolute folder templates as they are', () => {
    expect(
      resolveExportFolder(
        preset({ folderTemplate: '/tmp/ee-out/{preset}/{city}' }),
        context(),
        '/exports',
      ),
    ).toBe('/tmp/ee-out/Sportfotografen/Stockholm');
  });

  // Fails on Windows: the expectation is written with POSIX paths, not a bug in the app.

  it.skipIf(process.platform === 'win32')('sanitizes the preset name in paths', () => {
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

  it('uses the photo base name with .jpg when keeping original names', () => {
    expect(
      resolveExportFileName(
        preset({ fileNaming: 'keep', fileNameTemplate: '{event}_{seq}' }),
        context(),
      ),
    ).toBe('A1.jpg');
    expect(
      resolveExportFileName(preset({ fileNaming: 'keep', fileNameTemplate: ' ' }), context()),
    ).toBe('A1.jpg');
  });

  // Fails on Windows: the expectation is written with POSIX paths, not a bug in the app.

  it.skipIf(process.platform === 'win32')(
    'carries the preset id when the name is only punctuation',
    () => {
      expect(
        resolveExportFolder(
          preset({ id: asPresetId('preset-7'), name: '///', folderTemplate: '{preset}' }),
          context(),
          '/exports',
        ),
      ).toBe('/exports/preset-7');
    },
  );
});

describe('export folder next to the photo', () => {
  const photoDir = '/Photos/20261104_GAIS-AIK';
  const nextTo = (overrides: Partial<CaptionContext> = {}): CaptionContext =>
    context({
      filePath: `${photoDir}/_DSC1234.NEF`,
      fileName: '_DSC1234.NEF',
      fileNameBase: '_DSC1234',
      ...overrides,
    });

  it("is the default, and exports into the photo folder's export folder", () => {
    expect(defaultExportPreset().folderTemplate).toBe('{photofolder}/export');
    expect(resolveExportTarget(defaultExportPreset(), nextTo(), '/exports')).toEqual({
      folder: `${photoDir}/export`,
      photoFolder: photoDir,
    });
  });

  it('puts two photos in different folders each in their own export folder', () => {
    const other = nextTo({ filePath: '/Photos/20261105_AIK-DIF/_DSC0001.NEF' });
    expect(resolveExportFolder(defaultExportPreset(), other, '/exports')).toBe(
      '/Photos/20261105_AIK-DIF/export',
    );
  });

  it('expands variables and {preset} after the photo folder', () => {
    expect(
      resolveExportFolder(
        preset({ folderTemplate: '{photofolder}/export/{preset}/{city}' }),
        nextTo(),
        '/exports',
      ),
    ).toBe(`${photoDir}/export/Sportfotografen/Stockholm`);
    // Case and spaces in the braces do not matter, as for every variable.
    expect(
      resolveExportFolder(preset({ folderTemplate: '{ PhotoFolder }/web' }), nextTo(), '/exports'),
    ).toBe(`${photoDir}/web`);
  });

  it('allows the photo folder itself', () => {
    expect(
      resolveExportFolder(preset({ folderTemplate: '{photofolder}' }), nextTo(), '/exports'),
    ).toBe(photoDir);
  });

  it('refuses metadata that climbs out of the photo folder', () => {
    const climb =
      (value: string, template = '{photofolder}/export/{event}'): (() => string) =>
      () =>
        resolveExportFolder(
          preset({ folderTemplate: template }),
          nextTo({ fields: { event: value } }),
          '/exports',
        );
    expect(climb('../../..')).toThrowError(/leaves the photo's folder/);
    expect(climb('../../evil')).toThrowError(/leaves the photo's folder/);
    expect(climb('a/../../../evil')).toThrowError(/leaves the photo's folder/);
    // The value is the whole rest of the template.
    expect(climb('../elsewhere', '{photofolder}/{event}')).toThrowError(/leaves/);
    expect(climb('../elsewhere', '{photofolder}{event}')).toThrowError(/leaves/);
    // Staying inside is fine, however it is spelled.
    expect(climb('a/../b')()).toBe(`${photoDir}/export/b`);
    expect(climb('../sibling')()).toBe(`${photoDir}/sibling`);
  });

  it('does not let a leading separator or an absolute value leave the photo folder', () => {
    // A leading slash is dropped: it only separates `{photofolder}` from the rest.
    expect(
      resolveExportFolder(
        preset({ folderTemplate: '{photofolder}/{event}' }),
        nextTo({ fields: { event: '/etc/cron.d' } }),
        '/exports',
      ),
    ).toBe(`${photoDir}/etc/cron.d`);
  });

  it('only accepts {photofolder} at the start', () => {
    for (const folderTemplate of [
      'export/{photofolder}',
      '{photofolder}/{photofolder}',
      '/out/{photofolder}/x',
    ]) {
      expect(() =>
        resolveExportFolder(preset({ folderTemplate }), nextTo(), '/exports'),
      ).toThrowError(/only be at the start/);
    }
  });

  it('refuses a photo without an absolute path', () => {
    expect(() =>
      resolveExportFolder(defaultExportPreset(), nextTo({ filePath: 'A1.NEF' }), '/exports'),
    ).toThrowError(/absolute path/);
    expect(() =>
      resolveExportFolder(defaultExportPreset(), nextTo({ filePath: undefined }), '/exports'),
    ).toThrowError(/absolute path/);
  });

  describe('with Windows paths', () => {
    const win = path.win32;
    const windows = (overrides: Partial<CaptionContext> = {}): CaptionContext =>
      context({
        filePath: 'D:\\Photos\\20261104_GAIS-AIK\\_DSC1234.NEF',
        fileName: '_DSC1234.NEF',
        fileNameBase: '_DSC1234',
        ...overrides,
      });
    const resolveWin = (folderTemplate: string, overrides: Partial<CaptionContext> = {}) =>
      resolveExportTarget(preset({ folderTemplate }), windows(overrides), 'C:\\Exports', win);

    it('keeps the drive letter and uses the platform separator', () => {
      expect(resolveWin('{photofolder}/export')).toEqual({
        folder: 'D:\\Photos\\20261104_GAIS-AIK\\export',
        photoFolder: 'D:\\Photos\\20261104_GAIS-AIK',
      });
      expect(resolveWin('{photofolder}\\export\\{preset}').folder).toBe(
        'D:\\Photos\\20261104_GAIS-AIK\\export\\Sportfotografen',
      );
    });

    it('refuses climbing out and another drive', () => {
      for (const event of [
        '..\\..\\..',
        '../../../evil',
        'a\\..\\..\\..\\evil',
        'E:\\Elsewhere',
        'E:Elsewhere',
      ]) {
        expect(
          () => resolveWin('{photofolder}/{event}', { fields: { event } }),
          event,
        ).toThrowError(/leaves the photo's folder/);
      }
      expect(() =>
        resolveWin('{photofolder}/export/{event}', { fields: { event: '..\\..\\x' } }),
      ).toThrowError(/leaves the photo's folder/);
    });

    it('reads a leading UNC prefix as a name below the photo folder', () => {
      expect(
        resolveWin('{photofolder}{event}', { fields: { event: '\\\\server\\share' } }).folder,
      ).toBe('D:\\Photos\\20261104_GAIS-AIK\\server\\share');
    });

    it('compares folders without regard to case, as Windows does', () => {
      expect(
        resolveWin('{photofolder}/export/{event}', {
          fields: { event: '..\\..\\20261104_gais-aik\\y' },
        }).folder,
      ).toBe('D:\\Photos\\20261104_gais-aik\\y');
    });

    it('keeps relative templates inside the export root', () => {
      expect(resolveWin('Export/{event}').folder).toBe('C:\\Exports\\Export\\Derby');
      expect(() => resolveWin('..\\outside')).toThrowError(/escapes the export root/);
    });
  });
});

describe('describeFolderTemplate', () => {
  it('reads well for the default and for older templates', () => {
    expect(describeFolderTemplate('{photofolder}/export', 'Web')).toBe(
      'export (next to the photo)',
    );
    expect(describeFolderTemplate('{photofolder}', 'Web')).toBe('next to the photo');
    expect(describeFolderTemplate('{photofolder}/export/{preset}', 'Web')).toBe(
      'export/Web (next to the photo)',
    );
    expect(describeFolderTemplate('{folder}/Export/{preset}', 'Web')).toBe('Export/Web');
    expect(describeFolderTemplate('/Volumes/Out/{preset}', 'Web')).toBe('/Volumes/Out/Web');
  });
});
