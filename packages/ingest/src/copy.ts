import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, rm, stat } from 'node:fs/promises';
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

export interface CopyPhotoOptions {
  copier?: FileCopier;
  signal?: AbortSignal;
}

/**
 * Chooses a base name that exists in none of the destination directories, for
 * the photo and its sidecar together. Never overwrites.
 */
export async function chooseCollisionFreeBase(
  desiredBase: string,
  extension: string,
  directories: readonly string[],
  hasSidecar: boolean,
): Promise<string> {
  for (let suffix = 0; suffix < MAX_COLLISION_SUFFIX; suffix += 1) {
    const candidate = withCollisionSuffix(desiredBase, suffix);
    const paths = directories.flatMap((directory) => {
      const names = [join(directory, `${candidate}${extension}`)];
      if (hasSidecar) {
        names.push(join(directory, `${candidate}.xmp`));
      }
      return names;
    });
    let conflict = false;
    for (const path of paths) {
      if (await fileExists(path)) {
        conflict = true;
        break;
      }
    }
    if (!conflict) {
      return candidate;
    }
  }
  throw new CollisionError(`No free file name for ${desiredBase}${extension}`);
}

/**
 * Copies through a temp name in the destination directory, verifies the bytes,
 * then hard-links the temp file into place so the final name is never partial
 * and never overwrites an existing file.
 */
async function copyVerifiedToFinal(
  source: string,
  finalPath: string,
  copier: FileCopier,
  signal?: AbortSignal,
): Promise<{ sha256: string; size: number }> {
  throwIfAborted(signal);
  await mkdir(dirname(finalPath), { recursive: true });
  const tempPath = join(dirname(finalPath), `.${randomUUID()}-${basename(finalPath)}.ingest-tmp`);
  try {
    const outcome = await copier.copy(source, tempPath, { signal });
    if (outcome.sourceHash !== outcome.destinationHash) {
      throw new VerificationError(
        `Hash mismatch while copying ${basename(source)}: source ${outcome.sourceHash}, destination ${outcome.destinationHash}`,
      );
    }
    try {
      await link(tempPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CollisionError(`Destination already exists: ${finalPath}`);
      }
      throw error;
    }
    const info = await stat(finalPath);
    return { sha256: outcome.destinationHash, size: info.size };
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Copies a photo (and its XMP sidecar when present) to the primary and optional
 * backup destinations. Any failure removes the copies made by this call.
 */
export async function copyPhotoLocal(
  request: CopyPhotoRequest,
  options: CopyPhotoOptions = {},
): Promise<CopyPhotoResult> {
  const copier = options.copier ?? nodeFileCopier;
  const { signal } = options;
  const { extension } = splitName(request.sourceFileName);
  const hasSidecar = request.sidecarSourcePath !== undefined;
  const directories = request.backupDirectory
    ? [request.primaryDirectory, request.backupDirectory]
    : [request.primaryDirectory];

  throwIfAborted(signal);
  const base = await chooseCollisionFreeBase(request.finalBase, extension, directories, hasSidecar);
  const fileName = `${base}${extension}`;

  const primaryPath = join(request.primaryDirectory, fileName);
  const backupPath = request.backupDirectory
    ? join(request.backupDirectory, fileName)
    : undefined;
  const sidecarPath = hasSidecar ? join(request.primaryDirectory, `${base}.xmp`) : undefined;
  const backupSidecarPath =
    hasSidecar && request.backupDirectory
      ? join(request.backupDirectory, `${base}.xmp`)
      : undefined;

  const placed: string[] = [];
  try {
    const primary = await copyVerifiedToFinal(request.sourcePath, primaryPath, copier, signal);
    placed.push(primaryPath);

    if (backupPath) {
      await copyVerifiedToFinal(request.sourcePath, backupPath, copier, signal);
      placed.push(backupPath);
    }

    if (request.sidecarSourcePath && sidecarPath) {
      await copyVerifiedToFinal(request.sidecarSourcePath, sidecarPath, copier, signal);
      placed.push(sidecarPath);
    }
    if (request.sidecarSourcePath && backupSidecarPath) {
      await copyVerifiedToFinal(request.sidecarSourcePath, backupSidecarPath, copier, signal);
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
