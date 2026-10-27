import { randomUUID } from 'node:crypto';
import { rename as fsRename, rm as fsRm } from 'node:fs/promises';

/** Low-level file operations, injectable so the Windows branch is testable. */
export interface AtomicFsOps {
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  randomId(): string;
}

const defaultOps: AtomicFsOps = {
  rename: fsRename,
  rm: fsRm,
  randomId: randomUUID,
};

/**
 * Renames without ever exposing a partial file under the final name.
 *
 * POSIX rename replaces atomically. Windows refuses to replace an existing
 * file (`EEXIST`) or may report `EPERM`; in that case the old file is moved
 * aside, the new file is renamed into place, and the old file is restored if
 * that fails. The target is never deleted.
 */
export async function atomicReplace(
  tempPath: string,
  finalPath: string,
  ops: AtomicFsOps = defaultOps,
): Promise<void> {
  try {
    await ops.rename(tempPath, finalPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') throw error;

    const backupPath = `${finalPath}.${ops.randomId()}.bak`;
    try {
      await ops.rename(finalPath, backupPath);
    } catch {
      // The target could not be moved aside (e.g. it does not exist and the
      // failure was something else). Fail rather than delete anything.
      throw error;
    }

    try {
      await ops.rename(tempPath, finalPath);
    } catch (swapError) {
      try {
        await ops.rename(backupPath, finalPath);
      } catch (restoreError) {
        throw new AggregateError(
          [swapError, restoreError],
          `Could not replace ${finalPath}; the previous file is at ${backupPath}`,
        );
      }
      throw swapError;
    }

    await ops.rm(backupPath, { force: true }).catch(() => undefined);
  }
}
