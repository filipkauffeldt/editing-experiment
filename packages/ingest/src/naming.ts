import { join, normalize, sep } from 'node:path';
import { PathTraversalError } from './errors';
import { safeFileBase, safeSubfolderParts, splitName, type SplitName } from './path-names';

// The checks live in a module without Node imports so the Ingest view can run them too.
export { safeFileBase, splitName, type SplitName };

const DIGITS = /\d+/;

/**
 * Compares two names the way a photographer expects: `_DSC9` sorts before
 * `_DSC10`. Numeric runs are compared by value, everything else by code unit.
 */
export function naturalCompare(a: string, b: string): number {
  let indexA = 0;
  let indexB = 0;
  while (indexA < a.length && indexB < b.length) {
    const remainingA = a.slice(indexA);
    const remainingB = b.slice(indexB);
    const matchA = DIGITS.exec(remainingA);
    const matchB = DIGITS.exec(remainingB);
    const startsWithDigitA = matchA?.index === 0;
    const startsWithDigitB = matchB?.index === 0;

    if (startsWithDigitA && startsWithDigitB && matchA && matchB) {
      const numberA = matchA[0];
      const numberB = matchB[0];
      const trimmedA = numberA.replace(/^0+(?=\d)/, '');
      const trimmedB = numberB.replace(/^0+(?=\d)/, '');
      if (trimmedA.length !== trimmedB.length) {
        return trimmedA.length - trimmedB.length;
      }
      if (trimmedA !== trimmedB) {
        return trimmedA < trimmedB ? -1 : 1;
      }
      if (numberA.length !== numberB.length) {
        return numberA.length - numberB.length;
      }
      indexA += numberA.length;
      indexB += numberB.length;
      continue;
    }

    const charA = a[indexA] ?? '';
    const charB = b[indexB] ?? '';
    const lowerA = charA.toLowerCase();
    const lowerB = charB.toLowerCase();
    if (lowerA !== lowerB) {
      return lowerA < lowerB ? -1 : 1;
    }
    if (charA !== charB) {
      return charA < charB ? -1 : 1;
    }
    indexA += 1;
    indexB += 1;
  }
  return a.length - b.length;
}

const TEMP_SUFFIXES = ['.tmp', '.part', '.partial', '.crdownload'];

/**
 * Editors write through names like `.IMG_0001.NEF.part` or `IMG_0001.NEF~`.
 * Those must never be ingested as if they were complete photographs.
 */
export function isTemporaryName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('.')) {
    return true;
  }
  if (lower.endsWith('~')) {
    return true;
  }
  return TEMP_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Every folder the app exports into holds a file of this name. Ingest and the startup scan
 * leave such a folder (and what is below it) alone: exports live below the ingest
 * destination, and an exported JPEG is not a photo to ingest or recover. The marker lives with
 * the folder, so it still works when the index, the exported-files list or the settings are gone.
 */
export const EXPORT_MARKER_NAME = '.ee-export';

export const EXPORT_MARKER_TEXT =
  'Exported by the editing app. The app ignores this folder when it ingests or looks for photos.\n';

/** True when a directory listing contains the export marker. */
export function hasExportMarker(entryNames: Iterable<string>): boolean {
  for (const name of entryNames) if (name === EXPORT_MARKER_NAME) return true;
  return false;
}

/** Normalizes a destination subfolder template to a safe relative path. */
export function safeSubfolder(value: string): string {
  const parts = safeSubfolderParts(value);
  if (parts.length === 0) {
    return '';
  }
  const joined = join(...parts);
  const resolved = normalize(joined);
  if (resolved.startsWith('..') || resolved.startsWith(sep)) {
    throw new PathTraversalError(`Subfolder template escapes the destination: ${value}`);
  }
  return resolved;
}

/** `IMG_0001.NEF` with suffix 2 becomes `IMG_0001_2.NEF`. */
export function withCollisionSuffix(base: string, suffix: number): string {
  return suffix === 0 ? base : `${base}_${suffix}`;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const INVALID_FILE_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) {
      break;
    }
    result += character;
    bytes += size;
  }
  return result;
}

/**
 * Makes a remote file name safe to create as a local temp file on every
 * platform: strips path segments, replaces Windows-invalid characters, avoids
 * reserved device names, and keeps the whole name below the filesystem limit.
 */
export function safeLocalFileName(name: string, maxBytes = 240): string {
  const leaf = name.split(/[\\/]/).pop() ?? '';
  let cleaned = '';
  for (const character of leaf) {
    if (character.charCodeAt(0) < 32) {
      cleaned += '_';
    } else {
      cleaned += INVALID_FILE_CHARS.has(character) ? '_' : character;
    }
  }
  cleaned = cleaned.replace(/[. ]+$/, '');
  if (cleaned.length === 0) {
    cleaned = 'file';
  }
  if (WINDOWS_RESERVED.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  const { base, extension } = splitName(cleaned);
  const ext = truncateUtf8(extension, Math.max(0, maxBytes - 1));
  const maxBaseBytes = Math.max(1, maxBytes - Buffer.byteLength(ext));
  const shortened = truncateUtf8(base, maxBaseBytes);
  return `${shortened || 'file'}${ext}`;
}
