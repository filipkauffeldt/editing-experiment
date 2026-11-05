import { extname } from 'node:path';
import { asSourceId } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { joinDisplayPath, previewIngestPath } from '../src/destination-path';
import { splitName } from '../src/path-names';
import { createTemplateContext, defaultExpandTemplate, type ExpandTemplate } from '../src/template';

// The built-in expander has no source variables; the app's own one is tested in apps/desktop.
const expand: ExpandTemplate = (template, ctx) =>
  defaultExpandTemplate(template.replaceAll('{sourceName}', ctx.sourceName), ctx);

const context = (fileName = '_DSC9694.NEF') =>
  createTemplateContext({
    sourceId: asSourceId('card-1'),
    sourceName: 'NIKON Z 6',
    sourcePath: '/media/NIKON Z 6',
    fileName,
    seq: 1,
    mtimeMs: new Date(2026, 10, 4, 19, 30).getTime(),
    now: new Date(2026, 10, 5),
  });

const preview = (
  input: Partial<Parameters<typeof previewIngestPath>[0]> & { destinationPath: string },
) => {
  const { destinationPath, ...rest } = input;
  return previewIngestPath({
    destination: { path: destinationPath },
    fileNaming: 'keep',
    renameTemplate: '',
    context: context(),
    expandTemplate: expand,
    ...rest,
  });
};

describe('splitName', () => {
  it('splits like path.extname for names without separators', () => {
    const alphabet = ['a', 'b', '.'];
    const names = ['', ...alphabet];
    for (let length = 1; length < 5; length += 1) {
      for (const name of [...names]) {
        for (const next of alphabet) names.push(name + next);
      }
      names.splice(0, names.length, ...new Set(names));
    }
    for (const name of names) {
      const { base, extension } = splitName(name);
      expect(extension, JSON.stringify(name)).toBe(extname(name));
      expect(base + extension).toBe(name);
    }
  });
});

describe('previewIngestPath', () => {
  it('keeps the original name and puts it in the subfolder', () => {
    expect(
      preview({
        destinationPath: '/Photos',
        destination: { path: '/Photos', subfolderTemplate: '{date:YYYYMMDD}_GAIS-AIK' },
      }),
    ).toEqual({
      ok: true,
      directory: '/Photos/20261104_GAIS-AIK',
      fileName: '_DSC9694.NEF',
      path: '/Photos/20261104_GAIS-AIK/_DSC9694.NEF',
    });
  });

  it('renames with the template and keeps the extension as it was', () => {
    expect(
      preview({
        destinationPath: '/Photos/',
        fileNaming: 'rename',
        renameTemplate: '{date:YYYYMMDD}_{sourceName}_{seq:4}',
      }),
    ).toMatchObject({ ok: true, path: '/Photos/20261104_NIKON Z 6_0001.NEF' });
  });

  it('writes a Windows destination with backslashes', () => {
    expect(
      preview({
        destinationPath: 'E:\\Photos',
        destination: { path: 'E:\\Photos', subfolderTemplate: '{date:YYYY}/{sourceName}' },
      }),
    ).toMatchObject({
      ok: true,
      directory: 'E:\\Photos\\2026\\NIKON Z 6',
      path: 'E:\\Photos\\2026\\NIKON Z 6\\_DSC9694.NEF',
    });
  });

  it('says why ingest would refuse the templates', () => {
    expect(
      preview({
        destinationPath: '/Photos',
        destination: { path: '/Photos', subfolderTemplate: '../elsewhere' },
      }),
    ).toEqual({ ok: false, message: expect.stringContaining('escapes the destination') });
    expect(
      preview({ destinationPath: '/Photos', fileNaming: 'rename', renameTemplate: 'a/{seq:4}' }),
    ).toEqual({ ok: false, message: expect.stringContaining('a path, not a file name') });
    expect(preview({ destinationPath: ' ' })).toEqual({
      ok: false,
      message: 'Choose a destination folder.',
    });
  });
});

describe('joinDisplayPath', () => {
  it.each([
    ['/Photos', ['a', 'b.NEF'], '/Photos/a/b.NEF'],
    ['/', ['a'], '/a'],
    ['C:\\', ['a'], 'C:\\a'],
    ['C:/Photos', ['a'], 'C:\\Photos\\a'],
    ['\\\\server\\share\\', ['a'], '\\\\server\\share\\a'],
    ['/Photos/', [], '/Photos'],
  ])('%s + %j', (base, names, expected) => {
    expect(joinDisplayPath(base, names)).toBe(expected);
  });
});
