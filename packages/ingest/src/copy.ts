import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CollisionError, VerificationError, throwIfAborted } from './errors';
import { hashFile } from './hash';
import { splitName, withCollisionSuffix } from './naming';
import type { FileCopier } from './types';

const MAX_COLLISION_SUFFIX = 10_000;

export const nodeFileCopier: FileCopier = {
  async copy(source, destination, { signal }) {
    throwIfAborted(signal);
    const sourceHash = createHash('sha256');
    const read = createReadStream(source, signal ? { signal } : undefined);
    read.on('data', (chunk) => sourceHash.update(chunk as Buffer));
    if (signal) {
      await pipeline(read, createWriteStream(destination), { signal });
    } else {
      await pipeline(read, createWriteStream(destination));
    }
    return {
      sourceHash: sourceHash.digest('hex'),
      destinationHash: await hashFile(destination, signal),
    };
  },
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export interface CopyPhotoRequest {
  /** Local file to copy, or a fully downloaded temp file for remote sources. */
  sourcePath: string;
  /** Original source name; its extension is used for the destination. */
  sourceFileName: string;
  sidecarSourcePath?: string;
  /** Expanded rename template, without extension. */
  finalBase: string;
  primaryDirectory: string;
  backupDirectory?: string;
}

export interface CopyPhotoResult {
  path: string;
  fileName: string;
  sha256: string;
  size: number;
  sidecarPath?: string;
  backupPath?: string;
  backupSidecarPath?: string;
}

export interface PlacementOperations {
  link(source: string, target: string): Promise<void>;
  createExclusive(path: string): Promise<void>;
  rename(source: string, target: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export const nodePlacementOperations: PlacementOperations = {
  link,
  async createExclusive(path) {
    const handle = await open(path, 'wx');
    await handle.close();
  },
  rename,
  remove(path) {
    return rm(path, { force: true });
  },
};

export interface CopyPhotoOptions {
  copier?: FileCopier;
  signal?: AbortSignal;
  placement?: PlacementOperations;
}

async function hasConflict(
  base: string,
  extension: string,
  directories: readonly string[],
  hasSidecar: boolean,
): Promise<boolean> {
  for (const directory of directories) {
    if (await fileExists(join(directory, `${base}${extension}`))) {
      return true;
    }
    if (hasSidecar && (await fileExists(join(directory, `${base}.xmp`)))) {
      return true;
    }
  }
  return false;
}

/**
 * Copies through a temp name in the destination directory, verifies the bytes,
 * then hard-links the temp file into place so the final name is never partial
 * and never overwrites an existing file.
 */
function isFallbackCode(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EXDEV';
}

async function publishVerifiedTemp(
  tempPath: string,
  finalPath: string,
  placement: PlacementOperations,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await placement.link(tempPath, finalPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new CollisionError(`Destination already exists: ${finalPath}`);
    }
    if (!isFallbackCode(code)) {
      throw error;
    }
  }

  // Hard links are not available on every filesystem a photographer may use
  // (exFAT, some network shares, cross-device mounts). Reserve the final name
  // with an exclusive placeholder, then rename the already-verified temp file
  // over it. The placeholder is never a partial copy, and anything we created
  // is removed if publishing fails.
  throwIfAborted(signal);
  let reserved = false;
  try {
    try {
      await placement.createExclusive(finalPath);
      reserved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CollisionError(`Destination already exists: ${finalPath}`);
      }
      throw error;
    }
    throwIfAborted(signal);
    await placement.rename(tempPath, finalPath);
    reserved = false;
  } finally {
    if (reserved) {
      await placement.remove(finalPath).catch(() => undefined);
    }
  }
}

async function copyVerifiedToFinal(
  source: string,
  finalPath: string,
  copier: FileCopier,
  placement: PlacementOperations,
  signal?: AbortSignal,
): Promise<{ sha256: string; size: number }> {
  throwIfAborted(signal);
  await mkdir(dirname(finalPath), { recursive: true });
  const tempPath = join(dirname(finalPath), `.${randomUUID()}.ingest-tmp`);
  try {
    const outcome = await copier.copy(source, tempPath, { signal });
    if (outcome.sourceHash !== outcome.destinationHash) {
      throw new VerificationError(
        `Hash mismatch while copying ${basename(source)}: source ${outcome.sourceHash}, destination ${outcome.destinationHash}`,
      );
    }
    await publishVerifiedTemp(tempPath, finalPath, placement, signal);
    const info = await stat(finalPath);
    return { sha256: outcome.destinationHash, size: info.size };
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function copyWithBase(
  base: string,
  request: CopyPhotoRequest,
  extension: string,
  hasSidecar: boolean,
  copier: FileCopier,
  placement: PlacementOperations,
  signal?: AbortSignal,
): Promise<CopyPhotoResult> {
  const fileName = `${base}${extension}`;
  const primaryPath = join(request.primaryDirectory, fileName);
  const backupPath = request.backupDirectory ? join(request.backupDirectory, fileName) : undefined;
  const sidecarPath = hasSidecar ? join(request.primaryDirectory, `${base}.xmp`) : undefined;
  const backupSidecarPath =
    hasSidecar && request.backupDirectory
      ? join(request.backupDirectory, `${base}.xmp`)
      : undefined;

  const placed: string[] = [];
  try {
    const primary = await copyVerifiedToFinal(
      request.sourcePath,
      primaryPath,
      copier,
      placement,
      signal,
    );
    placed.push(primaryPath);

    if (backupPath) {
      await copyVerifiedToFinal(request.sourcePath, backupPath, copier, placement, signal);
      placed.push(backupPath);
    }

    if (request.sidecarSourcePath && sidecarPath) {
      await copyVerifiedToFinal(request.sidecarSourcePath, sidecarPath, copier, placement, signal);
      placed.push(sidecarPath);
    }
    if (request.sidecarSourcePath && backupSidecarPath) {
      await copyVerifiedToFinal(
        request.sidecarSourcePath,
        backupSidecarPath,
        copier,
        placement,
        signal,
      );
      placed.push(backupSidecarPath);
    }

    return {
      path: primaryPath,
      fileName,
      sha256: primary.sha256,
      size: primary.size,
      ...(sidecarPath ? { sidecarPath } : {}),
      ...(backupPath ? { backupPath } : {}),
      ...(backupSidecarPath ? { backupSidecarPath } : {}),
    };
  } catch (error) {
    await Promise.all(placed.map((path) => rm(path, { force: true }).catch(() => undefined)));
    throw error;
  }
}

/**
 * Copies a photo (and its XMP sidecar when present) to the primary and optional
 * backup destinations. Any failure removes the copies made by this call.
 *
 * Two sources can resolve to the same name at the same moment. The pre-flight
 * check avoids the common case; if a concurrent writer still wins the race at
 * link time, the next numeric suffix is tried instead of overwriting.
 */
export async function copyPhotoLocal(
  request: CopyPhotoRequest,
  options: CopyPhotoOptions = {},
): Promise<CopyPhotoResult> {
  const copier = options.copier ?? nodeFileCopier;
  const placement = options.placement ?? nodePlacementOperations;
  const { signal } = options;
  const { extension } = splitName(request.sourceFileName);
  const hasSidecar = request.sidecarSourcePath !== undefined;
  const directories = request.backupDirectory
    ? [request.primaryDirectory, request.backupDirectory]
    : [request.primaryDirectory];

  for (let suffix = 0; suffix < MAX_COLLISION_SUFFIX; suffix += 1) {
    throwIfAborted(signal);
    const base = withCollisionSuffix(request.finalBase, suffix);
    if (await hasConflict(base, extension, directories, hasSidecar)) {
      continue;
    }
    try {
      return await copyWithBase(base, request, extension, hasSidecar, copier, placement, signal);
    } catch (error) {
      if (error instanceof CollisionError) {
        continue;
      }
      throw error;
    }
  }
  throw new CollisionError(`No free file name for ${request.finalBase}${extension}`);
}
