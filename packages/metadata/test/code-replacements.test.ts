import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expandCaption } from '../src/caption';
import {
  CodeReplacementSet,
  expandCodeReplacements,
  loadCodeReplacements,
  parseCodeReplacementFile,
} from '../src/code-replacements';
import { cleanupTempDirs, makeTempDir } from './helpers';

const sample = [
  '// player codes',
  'wc8\tAlex Ovechkin\tAlex Ovechkin, Left wing\tOvi',
  'pt18\tJulio Cascante\tCascante\tCB',
  'ff\tstaff\tJane Smith\tWilson Oluo',
  'with space\tspaced code',
  '',
].join('\r\n');

describe('code replacements', () => {
  afterEach(cleanupTempDirs);

  it('parses tab-delimited files with multiple columns and comments', () => {
    const table = parseCodeReplacementFile(sample);
    expect(table.lookup('wc8')).toEqual(['Alex Ovechkin', 'Alex Ovechkin, Left wing', 'Ovi']);
    expect(table.lookup('pt18')?.[2]).toBe('CB');
    expect(table.lookup('with space')).toEqual(['spaced code']);
    expect(table.lookup('// player codes')).toBeUndefined();
  });

  it('defaults to = and expands the default column, #1 and other columns', () => {
    const set = new CodeReplacementSet([parseCodeReplacementFile(sample)]);
    expect(set.delimiter).toBe('=');
    expect(expandCodeReplacements('=wc8=', set)).toEqual({
      text: 'Alex Ovechkin',
      unknownCodes: [],
    });
    expect(expandCodeReplacements('=wc8#1=', set).text).toBe('Alex Ovechkin');
    expect(expandCodeReplacements('=wc8#2=', set).text).toBe('Alex Ovechkin, Left wing');
    expect(expandCodeReplacements('=wc8#3=', set).text).toBe('Ovi');
  });

  it('leaves unknown codes verbatim and reports them', () => {
    const set = new CodeReplacementSet([parseCodeReplacementFile(sample)]);
    expect(expandCodeReplacements('Hi =nope= and =wc8#9=', set)).toEqual({
      text: 'Hi =nope= and =wc8#9=',
      unknownCodes: ['nope', 'wc8#9'],
    });
  });

  it('uses a configured default replacement for unknown codes', () => {
    const set = new CodeReplacementSet([parseCodeReplacementFile(sample)], {
      defaultReplacement: 'UNKNOWN',
    });
    expect(expandCodeReplacements('Hi =nope=', set)).toEqual({
      text: 'Hi UNKNOWN',
      unknownCodes: ['nope'],
    });
  });

  it('does not treat an empty pair or an unpaired delimiter as a code', () => {
    const set = new CodeReplacementSet([parseCodeReplacementFile(sample)]);
    expect(expandCodeReplacements('==', set)).toEqual({ text: '==', unknownCodes: [] });
    expect(expandCodeReplacements('one = two', set)).toEqual({
      text: 'one = two',
      unknownCodes: [],
    });
  });

  it('leaves backslashes in ordinary text untouched with the default delimiter', () => {
    const set = new CodeReplacementSet([parseCodeReplacementFile(sample)]);
    expect(expandCodeReplacements('C:\\a\\b', set)).toEqual({
      text: 'C:\\a\\b',
      unknownCodes: [],
    });
  });

  it('lets later files override earlier ones', async () => {
    const dir = await makeTempDir();
    const first = join(dir, 'first.txt');
    const second = join(dir, 'second.txt');
    await writeFile(first, '\uFEFFcode\tfrom first\r\nother\tkept\r\n', 'utf8');
    await writeFile(second, 'code\tfrom second\r\n', 'utf8');

    const set = await loadCodeReplacements([first, second]);
    expect(set.size).toBe(2);
    expect(expandCodeReplacements('=code= =other=', set).text).toBe('from second kept');
  });

  it('supports a custom delimiter', () => {
    const set = new CodeReplacementSet([parseCodeReplacementFile(sample)], { delimiter: '\\' });
    expect(expandCodeReplacements('\\wc8\\ and \\\\', set)).toEqual({
      text: 'Alex Ovechkin and \\\\',
      unknownCodes: [],
    });
  });

  it('expands variables in the code before lookup and in the replacement after', () => {
    const months = parseCodeReplacementFile('July\tJulio\nmydate\t{day} {monthname} {year4}');
    const result = expandCaption('={monthname}= on =mydate=', {
      codeReplacements: [months],
      captureTime: '2024-07-06T12:00:00',
    });
    expect(result.text).toBe('Julio on 6 July 2024');
    expect(result.unknownCodes).toEqual([]);
    expect(result.unknownVariables).toEqual([]);
  });

  it('reports unknown codes and variables together, with delimiters intact', () => {
    const set = new CodeReplacementSet([parseCodeReplacementFile(sample)]);
    const result = expandCaption('=nope= {nosuch}', {
      codeReplacementSet: set,
      fields: {},
    });
    expect(result.text).toBe('=nope= {nosuch}');
    expect(result.unknownCodes).toEqual(['nope']);
    expect(result.unknownVariables).toEqual(['nosuch']);
    expect(result.unresolved).toEqual(['=nope=', '{nosuch}']);
  });
});
