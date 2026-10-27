import { basename, extname, join, normalize, sep } from 'node:path';
import { PathTraversalError } from './errors';

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

export function comparePathsByFolderThenName(
  folderA: string,
  nameA: string,
  folderB: string,
  nameB: string,
): number {
  return naturalCompare(folderA, folderB) || naturalCompare(nameA, nameB);
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

export interface SplitName {
  /** Original file name extension including the dot, or `''`. */
  extension: string;
  /** File name without its extension. */
  base: string;
}

export function splitName(fileName: string): SplitName {
  const extension = extname(fileName);
  return { base: extension ? fileName.slice(0, -extension.length) : fileName, extension };
}

/**
 * A rename template produces a file name, never a path. Reject anything that
 * could write outside the chosen destination directory.
 */
export function safeFileBase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new PathTraversalError('Rename template produced an empty file name');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new PathTraversalError(`Rename template produced an invalid file name: ${value}`);
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\u0000')) {
    throw new PathTraversalError(`Rename template produced a path, not a file name: ${value}`);
  }
  if (/[\u0000-\u001f]/.test(trimmed)) {
    throw new PathTraversalError('Rename template produced a file name with control characters');
  }
  return trimmed;
}

/** Normalizes a destination subfolder template to a safe relative path. */
export function safeSubfolder(value: string): string {
  if (/^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) {
    throw new PathTraversalError(`Subfolder template must be relative: ${value}`);
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (normalized.length === 0) {
    return '';
  }
  const parts = normalized.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      throw new PathTraversalError(`Subfolder template escapes the destination: ${value}`);
    }
    if (part.includes(':') || /[\u0000-\u001f]/.test(part)) {
      throw new PathTraversalError(`Subfolder template contains an invalid segment: ${value}`);
    }
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

export function fileNameOf(path: string): string {
  return basename(path);
}
