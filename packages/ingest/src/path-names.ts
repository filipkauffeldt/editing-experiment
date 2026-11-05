// No Node imports: the renderer shows the same file and folder names ingest will create
// (see destination-path.ts), so the checks have to run in a browser as well.
import { PathTraversalError } from './errors';

export interface SplitName {
  /** Original file name extension including the dot, or `''`. */
  extension: string;
  /** File name without its extension. */
  base: string;
}

/**
 * Splits a file name like `path.extname` does for a name without separators: a leading dot
 * (`.hidden`) is not an extension, `..` has none, and a trailing dot is one (`a.` -> `.`).
 */
export function splitName(fileName: string): SplitName {
  const dot = fileName.lastIndexOf('.');
  const extension = dot <= 0 || fileName === '..' ? '' : fileName.slice(dot);
  return { base: extension ? fileName.slice(0, -extension.length) : fileName, extension };
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32);
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
  if (hasControlCharacters(trimmed)) {
    throw new PathTraversalError('Rename template produced a file name with control characters');
  }
  return trimmed;
}

/**
 * The folder names of a destination subfolder template, checked to stay inside the destination.
 * Empty when the template expands to nothing.
 */
export function safeSubfolderParts(value: string): string[] {
  if (/^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) {
    throw new PathTraversalError(`Subfolder template must be relative: ${value}`);
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (normalized.length === 0) {
    return [];
  }
  const parts = normalized.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      throw new PathTraversalError(`Subfolder template escapes the destination: ${value}`);
    }
    if (part.includes(':') || hasControlCharacters(part)) {
      throw new PathTraversalError(`Subfolder template contains an invalid segment: ${value}`);
    }
  }
  return parts;
}
