// @vitest-environment node
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isAbsolutePathFromEitherSystem,
  relativeToSettingsFolder,
  resolveSettingsPath,
  resolveUnderSettingsFolder,
} from '../src/jobs/backend/settings-paths';

describe('settings paths', () => {
  it('stores a file below the settings folder with forward slashes under both path rules', () => {
    expect(
      relativeToSettingsFolder(
        '/home/filip/settings',
        '/home/filip/settings/templates/a.XMP',
        posix,
      ),
    ).toBe('templates/a.XMP');
    expect(
      relativeToSettingsFolder(
        'C:\\Users\\filip\\settings',
        'C:\\Users\\filip\\settings\\templates\\a.XMP',
        win32,
      ),
    ).toBe('templates/a.XMP');
  });

  it('resolves a stored relative path below the settings folder under both path rules', () => {
    expect(resolveUnderSettingsFolder('/home/filip/settings', 'templates/a.XMP', posix)).toBe(
      '/home/filip/settings/templates/a.XMP',
    );
    expect(resolveUnderSettingsFolder('C:\\Users\\filip\\settings', 'templates/a.XMP', win32)).toBe(
      'C:\\Users\\filip\\settings\\templates\\a.XMP',
    );
    expect(resolveSettingsPath('/home/filip/settings', { folder: 'a/b.txt' }, {}, posix)).toBe(
      '/home/filip/settings/a/b.txt',
    );
    expect(
      resolveSettingsPath('C:\\Users\\filip\\settings', { folder: 'a/b.txt' }, {}, win32),
    ).toBe('C:\\Users\\filip\\settings\\a\\b.txt');
  });

  it('does not store a path outside the folder, or one on a parent', () => {
    expect(
      relativeToSettingsFolder('/home/filip/settings', '/home/filip/other/a.XMP', posix),
    ).toBeUndefined();
    expect(relativeToSettingsFolder('/home/filip/settings', '/home/filip/settings', posix)).toBe(
      undefined,
    );
    expect(
      relativeToSettingsFolder('/home/filip/settings', '/home/filip/settings-other/a.XMP', posix),
    ).toBeUndefined();
    expect(
      relativeToSettingsFolder('/home/filip/settings', '/home/filip/settings/../x.XMP', posix),
    ).toBeUndefined();
  });

  it('never resolves a path of the other operating system', () => {
    expect(
      relativeToSettingsFolder('/home/filip/settings', 'C:\\Users\\filip\\templates\\a.XMP', posix),
    ).toBeUndefined();
    expect(
      relativeToSettingsFolder('C:\\Users\\filip\\settings', '/home/filip/templates/a.XMP', win32),
    ).toBeUndefined();
    // A stored machine path is handed back untouched: no join with either folder.
    expect(
      resolveSettingsPath(
        '/home/filip/settings',
        { machine: 'other' },
        { other: 'C:\\Users\\filip\\templates\\a.XMP' },
        posix,
      ),
    ).toBe('C:\\Users\\filip\\templates\\a.XMP');
    expect(
      resolveSettingsPath(
        'C:\\Users\\filip\\settings',
        { machine: 'other' },
        { other: '/home/filip/templates/a.XMP' },
        win32,
      ),
    ).toBe('/home/filip/templates/a.XMP');
  });

  it('refuses an escaping relative path', () => {
    expect(resolveUnderSettingsFolder('/home/filip/settings', '../a.XMP', posix)).toBeUndefined();
    expect(resolveUnderSettingsFolder('/home/filip/settings', '/etc/a.XMP', posix)).toBeUndefined();
    expect(resolveUnderSettingsFolder('C:\\settings', 'C:\\a.XMP', win32)).toBeUndefined();
    expect(resolveUnderSettingsFolder('C:\\settings', '..\\a.XMP', win32)).toBeUndefined();
  });

  it('recognises an absolute path of either system', () => {
    expect(isAbsolutePathFromEitherSystem('/a')).toBe(true);
    expect(isAbsolutePathFromEitherSystem('C:\\a')).toBe(true);
    expect(isAbsolutePathFromEitherSystem('\\\\server\\share\\a')).toBe(true);
    expect(isAbsolutePathFromEitherSystem('a/b')).toBe(false);
  });
});
