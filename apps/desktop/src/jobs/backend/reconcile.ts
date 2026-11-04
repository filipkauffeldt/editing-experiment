import { asJobId, asPhotoId, asSourceId, type SourceId } from '@ee/contracts';
import {
  hasExportMarker,
  isImageFileName,
  isTemporaryName,
  naturalCompare,
  type IngestedFileInfo,
  type OnFileIngested,
} from '@ee/ingest';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { EXPORT_FOLDER_NAME } from '../../shared/export-folder';

/** Source id of photos that were found on disk without an index entry. */
export const RECOVERED_SOURCE: SourceId = asSourceId('recovered');

export interface FindUnindexedOptions {
  /** A file the app exported (`exported-files.json`); it is never a photo. */
  isExported?(path: string): boolean;
}

/**
 * A folder below the destination whose files are exports, not photos:
 * - it holds the marker the app writes into every folder it exports to, or
 * - it has the name of the default export folder. The marker can be lost (a copy that skips
 *   dotfiles, a cleanup); the name stops a bare `export` folder from filling the Library with
 *   "Recovered" exports. A real photo ingested into a folder of that name is not recovered
 *   either, which only matters when the index was lost.
 * The destination itself is never skipped: it is where the user pointed ingest.
 */
function isExportFolder(name: string, entryNames: readonly string[]): boolean {
  return name.toLowerCase() === EXPORT_FOLDER_NAME || hasExportMarker(entryNames);
}

/**
 * Image files below `directory` that are not in `known`. Ingest marks a file as
 * seen before it is indexed, so a crash (or an index write that failed) between
 * the copy and the index entry would otherwise leave the photo on disk forever
 * without a film strip entry. Exports are below the destination too (next to the
 * photos), so export folders and files the app exported are left out.
 */
export async function findUnindexed(
  directory: string,
  known: ReadonlySet<string>,
  options: FindUnindexedOptions = {},
): Promise<string[]> {
  const found: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      // The destination may not exist yet (nothing ingested).
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (
      current !== directory &&
      isExportFolder(
        basename(current),
        entries.map((entry) => entry.name),
      )
    ) {
      continue;
    }
    for (const entry of entries) {
      if (isTemporaryName(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (
        entry.isFile() &&
        isImageFileName(entry.name) &&
        !known.has(path) &&
        options.isExported?.(path) !== true
      ) {
        found.push(path);
      }
    }
  }
  return found.sort(naturalCompare);
}

async function recoveredInfo(
  path: string,
  sidecarPath: string | undefined,
): Promise<IngestedFileInfo> {
  const { size, mtimeMs } = await stat(path);
  return {
    photoId: asPhotoId(randomUUID()),
    jobId: asJobId('reconcile'),
    sourceId: RECOVERED_SOURCE,
    sourceKind: 'folder',
    sourceName: 'Recovered',
    sourcePath: path,
    sourceFileName: basename(path),
    path,
    fileName: basename(path),
    ...(sidecarPath === undefined ? {} : { sidecarPath }),
    size,
    mtimeMs,
    sha256: '',
    seq: 0,
  };
}

export interface ReconcileOptions {
  directory: string;
  known: ReadonlySet<string>;
  /**
   * Paths the user removed from the Library while the file stayed on disk. They are not photos
   * without an entry by accident, so they are not brought back.
   */
  excluded?: ReadonlySet<string>;
  /** Files the app exported; see {@link FindUnindexedOptions.isExported}. */
  isExported?(path: string): boolean;
  /** The normal per-file ingest hook: previews, template, index. */
  index: OnFileIngested;
  signal?: AbortSignal;
  /** Called for a file that could not be indexed; the rest are still tried. */
  onError(path: string, error: unknown): void;
}

/** Index every unindexed image file below the ingest destination. Returns how many were added. */
export async function reconcileDestination(options: ReconcileOptions): Promise<number> {
  let added = 0;
  for (const path of await findUnindexed(options.directory, options.known, {
    ...(options.isExported === undefined ? {} : { isExported: options.isExported }),
  })) {
    if (options.signal?.aborted) break;
    if (options.excluded?.has(path)) continue;
    try {
      const sidecar = path.replace(/\.[^./\\]+$/, '.xmp');
      const hasSidecar = await stat(sidecar).then(
        () => true,
        () => false,
      );
      await options.index(await recoveredInfo(path, hasSidecar ? sidecar : undefined));
      added += 1;
    } catch (error) {
      options.onError(path, error);
    }
  }
  return added;
}
