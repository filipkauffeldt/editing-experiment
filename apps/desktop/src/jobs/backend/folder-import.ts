import {
  IpcError,
  asJobId,
  asPhotoId,
  asSourceId,
  type FolderImportInfo,
  type FolderImportMode,
  type JobEvent,
  type JobId,
  type SourceId,
} from '@ee/contracts';
import type { CardScanner, IngestedFileInfo, OnFileIngested } from '@ee/ingest';
import { isRawPath, sidecarPathFor } from '@ee/metadata';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative } from 'node:path';
import { normalizeExportPath } from './exported-files';
import type { PhotoLibrary } from './photo-library';
import { findUnindexed } from './reconcile';
import type { SettingsStore } from './settings-store';

/** Source id of photos in folders the user added in place. */
export const IN_PLACE_SOURCE: SourceId = asSourceId('in-place');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `child` is `parent` or strictly below it. Both paths are absolute and normalised. */
function isSameOrBelow(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/**
 * The path as written and as it really is (symlinks resolved), normalised and case-folded on
 * macOS and Windows, so a comparison can not be fooled by a link or a case difference.
 */
async function pathVariants(path: string): Promise<string[]> {
  const written = normalizeExportPath(path);
  const real = await realpath(path).then(
    (value) => normalizeExportPath(value),
    () => written,
  );
  return [...new Set([written, real])];
}

export interface FolderImportDeps {
  photos: PhotoLibrary;
  /** The configured sources, read fresh for every validation. */
  settings: Pick<SettingsStore, 'listSources'>;
  /** The same scanner the Ingest view uses, so both agree on what is a card. */
  cards: CardScanner;
  userDataDir: string;
  cacheDir: string;
  /** Files the app exported; they are not photos. */
  isExported(path: string): boolean;
  /** The per-file work after ingest's copy, with no metadata template or develop preset. */
  onFileIngested: OnFileIngested;
  emit(event: JobEvent): void;
  warn(message: string): void;
}

interface Run {
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Opens existing folders in place. Every supported image below an added folder is indexed as it
 * is, with the same per-file work ingest does after its copy (camera data, previews, labels and
 * existing develop/retouch versions). Nothing is copied, moved or renamed; raws are never written.
 *
 * A folder is refused when it is inside or around a configured source, on a memory card, or in
 * the app's data or cache, so a source can never be written through an added folder. Added roots
 * live in the index database; nothing rescans them by itself.
 */
export class FolderImportService {
  private readonly runs = new Map<JobId, Run>();

  constructor(private readonly deps: FolderImportDeps) {}

  async addFolder(path: string): Promise<FolderImportInfo> {
    const root = await this.availableFolder(path);
    await this.assertSafe(root);
    this.deps.photos.addAddedFolder(root);
    return this.start(root, 'add');
  }

  async rescanFolder(path: string): Promise<FolderImportInfo> {
    const root = this.addedRoot(path);
    if (root === undefined) {
      throw new IpcError('invalid_argument', `${path} is not a folder added to the Library`);
    }
    await this.availableFolder(root);
    await this.assertSafe(root);
    return this.start(root, 'rescan');
  }

  async stop(jobId: JobId): Promise<void> {
    const run = this.runs.get(jobId);
    if (run === undefined) return;
    run.controller.abort();
    await run.done;
  }

  /** Stop every run and wait until they have wound down. */
  async dispose(): Promise<void> {
    const runs = [...this.runs.values()];
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.done));
  }

  private addedRoot(path: string): string | undefined {
    const wanted = normalizeExportPath(path);
    return this.deps.photos.addedFolders().find((folder) => normalizeExportPath(folder) === wanted);
  }

  /** The folder's real path, or a clear error. Never creates anything. */
  private async availableFolder(path: string): Promise<string> {
    if (typeof path !== 'string' || path.trim() === '' || !isAbsolute(path)) {
      throw new IpcError('invalid_argument', 'a folder path must be absolute');
    }
    try {
      const info = await stat(path);
      if (!info.isDirectory()) {
        throw new IpcError('invalid_argument', `${path} is not a folder`);
      }
      return await realpath(path);
    } catch (error) {
      if (error instanceof IpcError) throw error;
      throw new IpcError(
        'not_found',
        `The folder ${path} is not available. Connect the drive and try again.`,
        { cause: error },
      );
    }
  }

  /**
   * Refuses a folder that must never be opened in place. Every check compares the written path
   * and the real path, so a symlink cannot lead into a protected folder.
   */
  private async assertSafe(folder: string): Promise<void> {
    const target = await pathVariants(folder);
    const inside = (left: string[], right: string[]): boolean =>
      left.some((a) => right.some((b) => isSameOrBelow(b, a)));

    const source = this.deps.settings.listSources();
    for (const configured of source) {
      const configuredPath =
        configured.kind === 'folder'
          ? configured.path
          : configured.kind === 'card'
            ? configured.mountPath
            : undefined;
      if (configuredPath === undefined || configuredPath === '') continue;
      const protectedPaths = await pathVariants(configuredPath);
      if (inside(target, protectedPaths)) {
        throw new IpcError(
          'invalid_argument',
          `${folder} is inside the ${configured.kind} source "${configured.name}". Ingest copies from a source; add a folder that is not a source, or use the Ingest view.`,
        );
      }
      if (inside(protectedPaths, target)) {
        throw new IpcError(
          'invalid_argument',
          `${folder} contains the ${configured.kind} source "${configured.name}". Choose a folder that does not include a source, or use the Ingest view.`,
        );
      }
    }

    // The app's own files include the cache thumbnails, and the index and seen databases.
    for (const owned of [this.deps.userDataDir, this.deps.cacheDir]) {
      const ownedPaths = await pathVariants(owned);
      if (inside(target, ownedPaths)) {
        throw new IpcError(
          'invalid_argument',
          `${folder} is the app's data or cache folder and cannot be added to the Library.`,
        );
      }
      if (inside(ownedPaths, target)) {
        throw new IpcError(
          'invalid_argument',
          `${folder} contains the app's data or cache folder and cannot be added to the Library.`,
        );
      }
    }

    // A volume with a DCIM folder at its root is a card. CardScanner found the mounted ones.
    const cards = await this.deps.cards.scan();
    for (const card of cards) {
      const cardPaths = await pathVariants(card.mountPath);
      if (inside(target, cardPaths)) {
        throw new IpcError(
          'invalid_argument',
          `${folder} is on the memory card ${card.mountPath}. Cards are never opened in place; ingest the card on the Ingest view.`,
        );
      }
      if (inside(cardPaths, target)) {
        throw new IpcError(
          'invalid_argument',
          `${folder} contains the memory card ${card.mountPath}. Choose a folder that does not include a card, or use the Ingest view.`,
        );
      }
    }
  }

  private start(root: string, mode: FolderImportMode): FolderImportInfo {
    const info: FolderImportInfo = {
      jobId: asJobId(randomUUID()),
      root,
      mode,
      state: 'running',
      filesTotal: 0,
      filesDone: 0,
      filesImported: 0,
      filesSkipped: 0,
    };
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.run(info, controller.signal))
      .catch((error: unknown) => {
        info.state = 'failed';
        info.error = messageOf(error);
        this.emitState(info);
      })
      .finally(() => {
        this.runs.delete(info.jobId);
      });
    this.runs.set(info.jobId, { controller, done });
    this.emitState(info);
    return { ...info };
  }

  private async run(info: FolderImportInfo, signal: AbortSignal): Promise<void> {
    const { photos } = this.deps;
    const known = new Set(photos.list().map((photo) => photo.path));
    const excluded = photos.excludedPaths();
    const files = (
      await findUnindexed(info.root, known, {
        isExported: (path) => this.deps.isExported(path),
        skipRoot: true,
      })
    ).filter((path) => !excluded.has(path));

    info.filesTotal = files.length;
    this.emitProgress(info);

    let seq = 0;
    for (const path of files) {
      if (signal.aborted) break;
      info.currentFile = basename(path);
      this.emitProgress(info);
      try {
        // A file the process cannot read is skipped, not turned into a Library entry.
        await access(path, constants.R_OK);
        const { size, mtimeMs } = await stat(path);
        const raw = isRawPath(path);
        const ingested: IngestedFileInfo = {
          photoId: asPhotoId(randomUUID()),
          jobId: info.jobId,
          sourceId: IN_PLACE_SOURCE,
          sourceKind: 'folder',
          sourceName: basename(info.root),
          sourcePath: path,
          sourceFileName: basename(path),
          path,
          fileName: basename(path),
          sidecarPath: raw ? sidecarPathFor(path) : path,
          size,
          mtimeMs,
          sha256: '',
          seq: (seq += 1),
          inPlace: true,
        };
        await this.deps.onFileIngested(ingested);
        info.filesImported += 1;
      } catch (error) {
        info.filesSkipped += 1;
        this.deps.warn(`${path}: ${messageOf(error)}`);
      }
      info.filesDone += 1;
      this.emitProgress(info);
    }

    info.currentFile = undefined;
    info.state = signal.aborted ? 'stopped' : 'finished';
    this.emitState(info);
  }

  private emitProgress(info: FolderImportInfo): void {
    this.deps.emit({ type: 'library.progress', at: Date.now(), ...info });
  }

  private emitState(info: FolderImportInfo): void {
    this.deps.emit({ type: 'library.state', at: Date.now(), ...info });
  }
}
