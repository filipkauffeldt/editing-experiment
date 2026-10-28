import { describe, expect, it } from 'vitest';
import { PathTraversalError } from '../src/errors';
import {
  isTemporaryName,
  naturalCompare,
  safeFileBase,
  safeLocalFileName,
  safeSubfolder,
  splitName,
} from '../src/naming';

describe('naturalCompare', () => {
  it('sorts numbered camera file names by value', () => {
    const names = ['_DSC10.NEF', '_DSC9.NEF', '_DSC100.NEF', '_DSC1.NEF'];
    expect(names.sort(naturalCompare)).toEqual([
      '_DSC1.NEF',
      '_DSC9.NEF',
      '_DSC10.NEF',
      '_DSC100.NEF',
    ]);
  });
});

describe('isTemporaryName', () => {
  it.each(['.hidden.NEF', 'IMG_0001.NEF.tmp', 'IMG_0001.NEF.part', 'IMG_0001.NEF~'])(
    'rejects %s',
    (name) => {
      expect(isTemporaryName(name)).toBe(true);
    },
  );

  it('accepts normal photo names', () => {
    expect(isTemporaryName('_DSC9.NEF')).toBe(false);
    expect(isTemporaryName('shot 01.JPG')).toBe(false);
  });
});

describe('splitName', () => {
  it('keeps the original extension', () => {
    expect(splitName('_DSC0009.NEF')).toEqual({ base: '_DSC0009', extension: '.NEF' });
    expect(splitName('no-extension')).toEqual({ base: 'no-extension', extension: '' });
  });
});

describe('safe names', () => {
  it('rejects paths in rename results', () => {
    expect(() => safeFileBase('../escape')).toThrow(PathTraversalError);
    expect(() => safeFileBase('folder/name')).toThrow(PathTraversalError);
    expect(safeFileBase('  good-name_1  ')).toBe('good-name_1');
  });

  it('normalizes safe subfolders and rejects traversal', () => {
    expect(safeSubfolder('2026-10-27/card')).toBe('2026-10-27/card');
    expect(() => safeSubfolder('../outside')).toThrow(PathTraversalError);
    expect(() => safeSubfolder('/absolute')).toThrow(PathTraversalError);
    expect(() => safeSubfolder('a//b')).toThrow(PathTraversalError);
  });
});

describe('safeLocalFileName', () => {
  it('strips path segments and Windows-invalid characters', () => {
    expect(safeLocalFileName('..\\evil:name?.NEF')).toBe('evil_name_.NEF');
    expect(safeLocalFileName('folder/photo.NEF')).toBe('photo.NEF');
  });

  it('avoids Windows reserved device names', () => {
    expect(safeLocalFileName('CON.NEF')).toBe('_CON.NEF');
    expect(safeLocalFileName('lpt1')).toBe('_lpt1');
  });

  it('keeps the name below the filesystem limit, preserving the extension', () => {
    const safe = safeLocalFileName(`${'a'.repeat(300)}.NEF`);
    expect(Buffer.byteLength(safe)).toBeLessThan(255);
    expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(240);
    expect(safe.endsWith('.NEF')).toBe(true);

    const multibyte = safeLocalFileName(`${'é'.repeat(300)}.NEF`);
    expect(Buffer.byteLength(multibyte)).toBeLessThanOrEqual(240);
  });
});
