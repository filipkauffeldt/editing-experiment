import { readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import {
  CodeReplacementSet,
  parseCodeReplacementFile,
  type CodeReplacementSetOptions,
  type CodeReplacementTable,
} from './code-replacement-tokens';
import { MetadataError } from './errors';

/**
 * Photo Mechanic writes these files as UTF-8, but its users also keep Latin-1 and UTF-16
 * files. Decoding those as UTF-8 silently turns Swedish letters into replacement characters,
 * so pick the encoding from the BOM first and fall back to Windows-1252 (a Latin-1 superset).
 */
export function decodeCodeReplacementFile(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export async function loadCodeReplacementFile(path: string): Promise<CodeReplacementTable> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw new MetadataError('INVALID_CODE_REPLACEMENTS', `Cannot read ${path}`, { cause });
  }
  return parseCodeReplacementFile(decodeCodeReplacementFile(bytes));
}

/** Load files in order and merge them into one set. */
export async function loadCodeReplacements(
  paths: readonly string[],
  options: CodeReplacementSetOptions = {},
): Promise<CodeReplacementSet> {
  const tables: CodeReplacementTable[] = [];
  for (const path of paths) tables.push(await loadCodeReplacementFile(path));
  return new CodeReplacementSet(tables, options);
}
