import { rename, rm } from 'node:fs/promises';

/**
 * Renames without ever exposing a partial file under the final name.
 *
 * POSIX rename replaces atomically. Windows refuses to replace an existing
 * file, so remove the previous export first; the source photo is never touched.
 */
export async function atomicReplace(tempPath: string, finalPath: string): Promise<void> {
  try {
    await rename(tempPath, finalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
    await rm(finalPath, { force: true });
    await rename(tempPath, finalPath);
  }
}
