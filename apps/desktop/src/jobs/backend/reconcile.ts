import { asJobId, asPhotoId, asSourceId, type SourceId } from '@ee/contracts';
import {
  isImageFileName,
  isTemporaryName,
  naturalCompare,
  type IngestedFileInfo,
  type OnFileIngested,
} from '@ee/ingest';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Source id of photos that were found on disk without an index entry. */
export const RECOVERED_SOURCE: SourceId = asSourceId('recovered');

/**
 * Image files below `directory` that are not in `known`. Ingest marks a file as
 * seen before it is indexed, so a crash (or an index write that failed) between
 * the copy and the index entry would otherwise leave the photo on disk forever
 * without a film strip entry.
 */
export async function findUnindexed(
  directory: string,
  known: ReadonlySet<string>,
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
    for (const entry of entries) {
      if (isTemporaryName(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && isImageFileName(entry.name) && !known.has(path)) found.push(path);
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
  /** The normal per-file ingest hook: previews, template, index. */
  index: OnFileIngested;
  signal?: AbortSignal;
  /** Called for a file that could not be indexed; the rest are still tried. */
  onError(path: string, error: unknown): void;
}

/** Index every unindexed image file below the ingest destination. Returns how many were added. */
export async function reconcileDestination(options: ReconcileOptions): Promise<number> {
  let added = 0;
  for (const path of await findUnindexed(options.directory, options.known)) {
    if (options.signal?.aborted) break;
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
