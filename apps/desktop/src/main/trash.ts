import { mkdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * What the jobs process's trash requests run: Electron's `shell.trashItem`, which puts the file
 * in the system trash (and rejects when it cannot, e.g. on a volume without one).
 *
 * `EE_TRASH_DIR` replaces it with a move into that folder. It exists so end-to-end tests do not
 * fill the developer's real trash; the app never sets it. It is still a move, never a delete.
 */
export function createTrashItem(
  systemTrash: (path: string) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): (path: string) => Promise<void> {
  const directory = env.EE_TRASH_DIR;
  if (!directory) return systemTrash;
  let count = 0;
  return async (path) => {
    await mkdir(directory, { recursive: true });
    await rename(path, join(directory, `${Date.now()}-${++count}-${basename(path)}`));
  };
}
