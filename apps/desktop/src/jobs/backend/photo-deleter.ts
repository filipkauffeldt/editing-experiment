import {
  type DeletePhotosArgs,
  type DeletePhotosResult,
  type Photo,
  type PhotoId,
  type RemoveFromLibraryArgs,
  type RemoveFromLibraryResult,
  type SourceConfig,
  IpcError,
} from '@ee/contracts';
import { sidecarPathFor } from '@ee/metadata';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { normalizeExportPath } from './exported-files';
import { RECOVERED_SOURCE } from './reconcile';
import type { PhotoLibrary } from './photo-library';
import type { SettingsStore } from './settings-store';

/**
 * Moves one file to the system trash. Electron's `shell.trashItem` lives in the main process,
 * which the jobs process reaches over a message (see `shared/trash-bridge.ts`). It must reject
 * when the file could not be trashed: there is no fallback to a permanent delete.
 */
export type TrashItem = (path: string) => Promise<void>;

export interface PhotoDeleterDeps {
  photos: PhotoLibrary;
  /** The configured sources, read fresh for every delete. */
  settings: Pick<SettingsStore, 'listSources'>;
  trash: TrashItem;
  /**
   * Called once the entry is gone, for the state other services keep about the photo (cached
   * previews, queued exports, ...). A failure is logged: the photo is deleted either way.
   */
  onRemoved(photoId: PhotoId): Promise<void>;
  warn(message: string): void;
  /** Waits before each retry of a trash that failed for a lock: its length is the number of retries. */
  retryDelaysMs?: readonly number[];
}

/** Three attempts in all, about 450 ms: long enough for an antivirus scan or a preview to let go. */
export const TRASH_RETRY_DELAYS_MS: readonly number[] = [150, 300];

/** The files of a photo that go to the trash, sidecar first (see {@link PhotoDeleter}). */
interface Targets {
  sidecar?: string;
  photo: string;
}

/**
 * A failed trash worth trying again: a lock another program holds for a moment (Windows
 * reports `EBUSY`, `EPERM` or `EACCES` for a file that is open elsewhere). An error with another
 * code (`ENOSPC`, `EXDEV`, the bridge's `ETIMEDOUT`, ...) is final. One with no code is retried
 * too: Electron's `shell.trashItem` rejects with a plain `Error` such as "Failed to perform delete
 * operation", and the bridge only passes its message on, so the cause cannot be told. That is
 * safe because a failed trash leaves the file where it was, each attempt looks first whether the
 * file is still there, and the last failure is reported as before.
 */
function isTransientTrashFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === undefined || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `child` is strictly below `parent`. Paths are absolute and already normalised. */
function isBelow(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** The real location of `directory`, or the directory itself when it does not exist (yet). */
async function realDirectory(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return directory;
    throw error;
  }
}

/**
 * Deletes photos: file and sidecar to the system trash, then the Library entry and the data the
 * app keeps for it. Also removes photos from the Library alone ({@link PhotoDeleter.removeFromLibrary}).
 *
 * Safety (AGENTS.md: never modify or delete an original on a source):
 * - It takes photo ids and resolves the paths from the index itself.
 * - Every indexed photo was indexed as a copy under an ingest destination (by ingest, or by the
 *   startup scan of that folder), and the destination changes from job to job, so the current
 *   destination setting is not consulted. What is refused: a path inside any configured card or
 *   folder source (written path and real path, so a symlink cannot lead into one), and a photo
 *   whose path is the very file it was ingested from (the index records the source file of
 *   every ingested photo; those found by the startup scan have none and are copies by
 *   construction). The sidecar must be the photo itself or its sibling `<name>.xmp`, and
 *   nothing may be a folder.
 *
 * Order, per photo and under the photo's lock so no edit lands half way:
 * 1. the XMP sidecar to the trash, then the photo file. A sidecar left behind would be picked up
 *    by the next ingested file of the same name, so it must not be what is left over: if the
 *    sidecar cannot be trashed nothing has happened yet and the photo stays complete;
 * 2. only then the entry and its data are dropped. If anything failed the entry stays and the
 *    photo is reported, so a failed trash never makes a photo vanish from the Library;
 * 3. a file that is already missing counts as trashed, so retrying finishes a half-done delete.
 */
export class PhotoDeleter {
  constructor(private readonly deps: PhotoDeleterDeps) {}

  async delete(args: DeletePhotosArgs): Promise<DeletePhotosResult> {
    return this.each('photos:delete', args, (photoId) => this.deleteOne(photoId));
  }

  /**
   * Drops photos from the Library without touching a file: for photos that were deleted outside
   * the app, so it does not look at the disk at all (not even to see whether the file is there,
   * which could hang or fail on an unplugged drive). The entry and the app's data go the same
   * way as in {@link delete}, under the photo's lock; additionally the photo's path is
   * remembered so the startup scan does not index a file that is still there.
   */
  async removeFromLibrary(args: RemoveFromLibraryArgs): Promise<RemoveFromLibraryResult> {
    return this.each('photos:removeFromLibrary', args, (photoId) => this.removeOne(photoId));
  }

  private async each(
    channel: string,
    args: { photoIds: PhotoId[] },
    one: (photoId: PhotoId) => Promise<void>,
  ): Promise<DeletePhotosResult> {
    if (!Array.isArray(args?.photoIds) || args.photoIds.some((id) => typeof id !== 'string')) {
      throw new IpcError('invalid_argument', `${channel} needs a list of photo ids`);
    }
    const result: DeletePhotosResult = { deleted: [], failed: [] };
    for (const photoId of new Set(args.photoIds)) {
      try {
        await one(photoId);
        result.deleted.push(photoId);
      } catch (error) {
        result.failed.push({ photoId, message: messageOf(error) });
      }
    }
    return result;
  }

  private removeOne(photoId: PhotoId): Promise<void> {
    const { photos } = this.deps;
    return photos.withLock(photoId, async () => {
      let name: string;
      try {
        name = photos.get(photoId).fileName;
      } catch (error) {
        // Not in the index: already removed (a repeated request, another window).
        if (error instanceof IpcError && error.code === 'not_found') return;
        throw error;
      }
      photos.removeAndExclude(photoId);
      await this.cleanUp(photoId, name);
    });
  }

  /** Clear what other services keep about a photo whose entry is gone. A failure is only logged. */
  private async cleanUp(photoId: PhotoId, name: string): Promise<void> {
    try {
      await this.deps.onRemoved(photoId);
    } catch (error) {
      this.deps.warn(`${name}: could not clear its cached data: ${messageOf(error)}`);
    }
  }

  private deleteOne(photoId: PhotoId): Promise<void> {
    const { photos } = this.deps;
    return photos.withLock(photoId, async () => {
      let photo: Photo;
      let sourcePath: string | undefined;
      try {
        ({ photo, sourcePath } = photos.record(photoId));
      } catch (error) {
        // Not in the index: already deleted (a repeated request, another window).
        if (error instanceof IpcError && error.code === 'not_found') return;
        throw error;
      }
      const targets = await this.resolveTargets(photo, sourcePath);
      if (targets.sidecar !== undefined)
        await this.trashIfPresent(targets.sidecar, photo, 'sidecar');
      await this.trashIfPresent(targets.photo, photo, 'photo');

      photos.remove(photoId);
      await this.cleanUp(photoId, photo.fileName);
    });
  }

  private async trashIfPresent(
    path: string,
    photo: Photo,
    what: 'photo' | 'sidecar',
  ): Promise<void> {
    if (!(await exists(path))) return;
    const delays = this.deps.retryDelaysMs ?? TRASH_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.deps.trash(path);
        return;
      } catch (error) {
        // Gone by now (something else moved it): the goal is reached.
        if (!(await exists(path))) return;
        const delay = delays[attempt];
        if (delay !== undefined && isTransientTrashFailure(error)) {
          // Only this photo's lock waits; other photos are not held up. Never a permanent delete.
          await sleep(delay);
          continue;
        }
        const moved = what === 'photo' && photo.sidecarPath !== photo.path;
        throw new Error(
          `${photo.fileName} could not be moved to the trash${
            moved ? ' (its sidecar already was; delete again to finish)' : ''
          }: ${messageOf(error)}`,
          { cause: error },
        );
      }
    }
  }

  /**
   * The files to trash for a photo, or an error naming why not. Everything is
   * checked before the first file moves.
   */
  private async resolveTargets(photo: Photo, sourcePath: string | undefined): Promise<Targets> {
    const name = photo.fileName;
    const refuse = (why: string): never => {
      throw new Error(`${name} was not deleted: ${why}`);
    };
    if (!isAbsolute(photo.path)) return refuse('its path is not absolute');

    const path = resolve(photo.path);
    const sidecar = resolve(photo.sidecarPath);
    // A raw's sidecar is the sibling `<name>.xmp`; any other photo carries its metadata inside.
    if (sidecar !== path && sidecar !== sidecarPathFor(path)) {
      return refuse('its sidecar is not next to it');
    }

    const sourceRoots = await this.roots(
      localSourcePaths(this.deps.settings.listSources()).filter(
        (source) => source !== '' && isAbsolute(source),
      ),
    );
    const check = async (file: string): Promise<void> => {
      const locations = await this.roots([dirname(file)]);
      const real = join(locations[locations.length - 1]!, basename(file));
      for (const candidate of new Set([normalize(file), normalize(real)])) {
        const source = sourceRoots.find((root) => candidate === root || isBelow(root, candidate));
        if (source !== undefined) {
          return refuse('it is inside a card or folder source, which is never changed');
        }
      }
      try {
        if ((await lstat(file)).isDirectory()) return refuse('it is a folder');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    };

    // The original is not a copy. Recovered photos record themselves as their own source.
    if (
      sourcePath !== undefined &&
      photo.sourceId !== RECOVERED_SOURCE &&
      normalize(resolve(sourcePath)) === normalize(path)
    ) {
      return refuse('it is the original file it was ingested from, not an ingested copy');
    }
    await check(path);
    if (sidecar !== path) await check(sidecar);
    return { ...(sidecar === path ? {} : { sidecar }), photo: path };
  }

  /** Each folder as written and as it really is (symlinks resolved), normalised for comparing. */
  private async roots(folders: string[]): Promise<string[]> {
    const roots: string[] = [];
    for (const folder of folders) {
      roots.push(normalize(resolve(folder)));
      roots.push(normalize(await realDirectory(resolve(folder))));
    }
    return [...new Set(roots)];
  }
}

const normalize = (path: string): string => normalizeExportPath(path);

/** The local folders of the sources that must never be changed: folder and card sources. */
export function localSourcePaths(sources: readonly SourceConfig[]): string[] {
  const paths: string[] = [];
  for (const source of sources) {
    if (source.kind === 'folder') paths.push(source.path);
    else if (source.kind === 'card') paths.push(source.mountPath);
  }
  return paths;
}
