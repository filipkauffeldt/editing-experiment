import {
  type DeletePhotosArgs,
  type DeletePhotosResult,
  type Photo,
  type PhotoId,
  type SourceConfig,
  IpcError,
} from '@ee/contracts';
import { sidecarPathFor } from '@ee/metadata';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { normalizeExportPath } from './exported-files';
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
  /** The ingest destination and the configured sources, read fresh for every delete. */
  settings: Pick<SettingsStore, 'get' | 'listSources'>;
  trash: TrashItem;
  /**
   * Called once the entry is gone, for the state other services keep about the photo (cached
   * previews, queued exports, ...). A failure is logged: the photo is deleted either way.
   */
  onRemoved(photoId: PhotoId): Promise<void>;
  warn(message: string): void;
}

/** The files of a photo that go to the trash, sidecar first (see {@link PhotoDeleter}). */
interface Targets {
  sidecar?: string;
  photo: string;
}

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
 * app keeps for it.
 *
 * Safety (AGENTS.md: never modify or delete an original on a source):
 * - It takes photo ids and resolves the paths from the index itself.
 * - A path is only trashed when it lies inside the ingest destination (real path, so a symlinked
 *   folder cannot point out of it) and not inside any configured card or folder source.
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
    if (!Array.isArray(args?.photoIds)) {
      throw new IpcError('invalid_argument', 'photos:delete needs photoIds');
    }
    const result: DeletePhotosResult = { deleted: [], failed: [] };
    for (const photoId of new Set(args.photoIds)) {
      try {
        await this.deleteOne(photoId);
        result.deleted.push(photoId);
      } catch (error) {
        result.failed.push({ photoId, message: messageOf(error) });
      }
    }
    return result;
  }

  private deleteOne(photoId: PhotoId): Promise<void> {
    const { photos } = this.deps;
    return photos.withLock(photoId, async () => {
      let photo: Photo;
      try {
        photo = photos.get(photoId);
      } catch (error) {
        // Not in the index: already deleted (a repeated request, another window).
        if (error instanceof IpcError && error.code === 'not_found') return;
        throw error;
      }
      const targets = await this.resolveTargets(photo);
      if (targets.sidecar !== undefined)
        await this.trashIfPresent(targets.sidecar, photo, 'sidecar');
      await this.trashIfPresent(targets.photo, photo, 'photo');

      photos.remove(photoId);
      try {
        await this.deps.onRemoved(photoId);
      } catch (error) {
        this.deps.warn(`${photo.fileName}: could not clear its cached data: ${messageOf(error)}`);
      }
    });
  }

  private async trashIfPresent(
    path: string,
    photo: Photo,
    what: 'photo' | 'sidecar',
  ): Promise<void> {
    if (!(await exists(path))) return;
    try {
      await this.deps.trash(path);
    } catch (error) {
      // Gone by now (something else moved it): the goal is reached.
      if (!(await exists(path))) return;
      const moved = what === 'photo' && photo.sidecarPath !== photo.path;
      throw new Error(
        `${photo.fileName} could not be moved to the trash${
          moved ? ' (its sidecar already was; delete again to finish)' : ''
        }: ${messageOf(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * The files to trash for a photo, or an error naming why not. Everything is
   * checked before the first file moves.
   */
  private async resolveTargets(photo: Photo): Promise<Targets> {
    const name = photo.fileName;
    const refuse = (why: string): never => {
      throw new Error(`${name} was not deleted: ${why}`);
    };
    const { settings } = this.deps;
    const destination = settings.get().ingest.destination.path;
    if (destination === '' || !isAbsolute(destination)) {
      return refuse('the ingest destination is not a folder on this computer');
    }
    if (!isAbsolute(photo.path)) return refuse('its path is not absolute');

    const path = resolve(photo.path);
    const sidecar = resolve(photo.sidecarPath);
    // A raw's sidecar is the sibling `<name>.xmp`; any other photo carries its metadata inside.
    if (sidecar !== path && sidecar !== sidecarPathFor(path)) {
      return refuse('its sidecar is not next to it');
    }

    const destinationRoots = await this.roots([destination]);
    const sourceRoots = await this.roots(
      localSourcePaths(settings.listSources()).filter(
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
        if (!destinationRoots.some((root) => isBelow(root, candidate))) {
          return refuse('it is not inside the ingest destination');
        }
      }
      try {
        if ((await lstat(file)).isDirectory()) return refuse('it is a folder');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    };

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
