import { constants, type Stats } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CardSource, FileTypeFilter, FolderSource, LockFilter } from '@ee/contracts';
import { extensionOf, isImageFileName, isRawFileName } from './formats';
import { splitName } from './naming';
import type { SourceFile } from './types';

/** Default when a local source does not specify a file type filter. */
export const DEFAULT_FILE_TYPES: FileTypeFilter = 'both';
/** Default when a local source does not specify a lock filter. */
export const DEFAULT_LOCK_FILTER: LockFilter = 'all';
/** Default when a local source does not specify incremental ingest. */
export const DEFAULT_INCREMENTAL = true;

/**
 * A camera card mounted read-only makes every file look locked, so the lock
 * filter cannot distinguish protected photos from the rest.
 */
export const READ_ONLY_WARNING = "Card is mounted read-only; can't tell locked photos apart";

/** `.jpg`/`.jpeg` are the JPEG filter; `both` also accepts the other image types. */
const JPEG_EXTENSIONS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'jpe']);

/**
 * Whether a file carries the camera's protect flag.
 *
 * Nikon (and other cameras) implement protect as the FAT/exFAT read-only
 * attribute. Node exposes it as missing write permission bits on every
 * platform:
 *  - Linux vfat/exfat and macOS msdos/exfat report the attribute through the
 *    mode bits;
 *  - Windows maps `FILE_ATTRIBUTE_READONLY` to a mode without write bits.
 *
 * A file is locked when it has no write bits at all. This says nothing about
 * the volume: on a read-only mount every file has this shape, which is why
 * callers must probe the volume before trusting the result.
 */
export function isLockedFile(stat: Pick<Stats, 'mode'> | { mode: number }): boolean {
  return (stat.mode & 0o222) === 0;
}

/** The directory whose writability tells whether the source volume is read-only. */
export function sourceRoot(source: FolderSource | CardSource): string {
  return source.kind === 'card' ? join(source.mountPath, 'DCIM') : source.path;
}

/**
 * Checks a directory for write permission without writing to it. On a
 * read-only mount `access(dir, W_OK)` fails with EROFS (and with EACCES/EPERM
 * for a directory that is merely not writable), so both mean we cannot tell
 * locked photos apart.
 */
export async function isDirectoryWritable(directory: string): Promise<boolean> {
  try {
    await access(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether a file name survives the selected file type filter. */
export function matchesFileType(fileName: string, fileTypes: FileTypeFilter): boolean {
  if (fileTypes === 'both') return isImageFileName(fileName);
  if (fileTypes === 'raw') return isRawFileName(fileName);
  return JPEG_EXTENSIONS.has(extensionOf(fileName));
}

function isPairMember(fileName: string): boolean {
  return isRawFileName(fileName) || JPEG_EXTENSIONS.has(extensionOf(fileName));
}

/**
 * RAW and JPEG share a group when they have the same base name in the same
 * folder; other files are alone. The pair is decided on the full listing,
 * before the type filter, so `raw` still sees a pair locked through its JPEG.
 */
function groupKey(file: SourceFile): string {
  if (!isPairMember(file.name)) return `file:${file.path}`;
  return `pair:${file.relativeFolder}\u0000${splitName(file.name).base.toLowerCase()}`;
}

export interface FilterSourceFilesOptions {
  fileTypes?: FileTypeFilter;
  lockFilter?: LockFilter;
  /** Directory to probe before trusting lock bits; defaults to the first file's folder. */
  probeDirectory?: string;
  /** Test seam for the read-only volume probe. */
  isDirectoryWritable?: (directory: string) => Promise<boolean>;
}

export interface FilterSourceFilesResult {
  files: SourceFile[];
  /** Image files found before the type and lock filters. */
  scanned: number;
  /** Set when the lock filter cannot be applied because the volume is read-only. */
  warning?: string;
}

/**
 * Applies the type and lock filters. Lock state is computed per RAW+JPEG pair
 * first (either file locked means the pair is locked), then the type filter
 * picks the members to copy. A read-only volume returns no files and a
 * warning: copying everything or nothing silently would be a wrong result.
 */
export async function filterSourceFiles(
  files: readonly SourceFile[],
  options: FilterSourceFilesOptions = {},
): Promise<FilterSourceFilesResult> {
  const fileTypes = options.fileTypes ?? DEFAULT_FILE_TYPES;
  const lockFilter = options.lockFilter ?? DEFAULT_LOCK_FILTER;
  const scanned = files.length;
  if (lockFilter === 'all') {
    return { files: files.filter((file) => matchesFileType(file.name, fileTypes)), scanned };
  }
  if (files.length === 0) return { files: [], scanned };

  const probeDirectory = options.probeDirectory ?? dirname(files[0]!.path);
  const probe = options.isDirectoryWritable ?? isDirectoryWritable;
  if (!(await probe(probeDirectory))) {
    return { files: [], scanned, warning: READ_ONLY_WARNING };
  }

  const locked = new Map<string, boolean>();
  for (const file of files) {
    const key = groupKey(file);
    const fileLocked = file.mode !== undefined && isLockedFile({ mode: file.mode });
    locked.set(key, (locked.get(key) ?? false) || fileLocked);
  }

  return {
    files: files.filter((file) => {
      const isGroupLocked = locked.get(groupKey(file)) ?? false;
      return isGroupLocked === (lockFilter === 'locked') && matchesFileType(file.name, fileTypes);
    }),
    scanned,
  };
}
