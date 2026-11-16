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
import { fileExists, isRawPath, sidecarPathFor } from '@ee/metadata';
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

/**
 * Files of one added folder that are read, rendered and indexed at the same time. The per-file
 * work is I/O and a native preview extraction; four keeps a large folder moving without loading
 * dozens of raws at once. `photos:added` is still emitted in file-name order by the run's gates.
 */
export const FOLDER_INDEX_CONCURRENCY = 4;

interface IndexHooks {
  beforeIndex(info: IngestedFileInfo): Promise<void>;
  afterIndex(info: IngestedFileInfo): void;
}

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

interface Gate {
  wait: Promise<void>;
  release(): void;
}

/** One turn per file, each waiting for the one before it. `release` is safe to call twice. */
function orderGates(count: number): Gate[] {
  const gates: Gate[] = [];
  let previous = Promise.resolve();
  for (let index = 0; index < count; index += 1) {
    let release = (): void => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.push({ wait: previous, release });
    previous = promise;
  }
  return gates;
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
  createIngestHook(hooks: IndexHooks): OnFileIngested;
  emit(event: JobEvent): void;
  warn(message: string): void;
}

interface Run {
  info: FolderImportInfo;
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
    this.assertNoRun(root);
    await this.assertSafe(root);
    this.deps.photos.addAddedFolder(root);
    return this.start(root, 'add');
  }

  async rescanFolder(path: string): Promise<FolderImportInfo> {
    const root = this.addedRoot(path);
    if (root === undefined) {
      throw new IpcError('invalid_argument', `${path} is not a folder added to the Library`);
    }
    this.assertNoRun(root);
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

  private assertNoRun(root: string): void {
    const wanted = normalizeExportPath(root);
    const active = [...this.runs.values()].find(
      (run) => normalizeExportPath(run.info.root) === wanted,
    );
    if (active === undefined) return;
    throw new IpcError(
      'invalid_argument',
      `The folder ${root} is already being ${active.info.mode === 'add' ? 'added' : 'rescanned'}. Stop that run first.`,
    );
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
    this.assertNoRun(root);
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
    this.runs.set(info.jobId, { info, controller, done });
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

    // Each file has a turn to write its index row (and announce `photos:added`). Reads and
    // previews run concurrently; the adds stay in file-name order.
    const gates = orderGates(files.length);
    const ingest = this.deps.createIngestHook({
      beforeIndex: async (ingested) => gates[ingested.seq - 1]?.wait,
      afterIndex: (ingested) => gates[ingested.seq - 1]?.release(),
    });

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= files.length || signal.aborted) return;
        await this.indexFile(info, files[index] as string, index + 1, ingest, gates[index]!);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FOLDER_INDEX_CONCURRENCY, files.length) }, worker),
    );

    info.currentFile = undefined;
    info.state = signal.aborted ? 'stopped' : 'finished';
    this.emitState(info);
  }

  private async indexFile(
    info: FolderImportInfo,
    path: string,
    seq: number,
    ingest: OnFileIngested,
    gate: { release(): void },
  ): Promise<void> {
    info.currentFile = basename(path);
    this.emitProgress(info);
    try {
      // A file the process cannot read is skipped, not turned into a Library entry.
      await access(path, constants.R_OK);
      const { size, mtimeMs } = await stat(path);
      const raw = isRawPath(path);
      // A raw with no sidecar has no edits to read, and no file is invented for it. An in-place
      // JPEG carries its metadata itself.
      const metadataPath = raw ? sidecarPathFor(path) : path;
      const sidecarPath = raw
        ? (await fileExists(metadataPath))
          ? metadataPath
          : undefined
        : path;
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
        ...(sidecarPath === undefined ? {} : { sidecarPath }),
        size,
        mtimeMs,
        sha256: '',
        seq,
        inPlace: true,
      };
      await ingest(ingested);
      info.filesImported += 1;
    } catch (error) {
      info.filesSkipped += 1;
      this.deps.warn(`${path}: ${messageOf(error)}`);
    } finally {
      // A skipped file must not hold back the files after it.
      gate.release();
      info.filesDone += 1;
      this.emitProgress(info);
    }
  }

  private emitProgress(info: FolderImportInfo): void {
    this.deps.emit({ type: 'library.progress', at: Date.now(), ...info });
  }

  private emitState(info: FolderImportInfo): void {
    this.deps.emit({ type: 'library.state', at: Date.now(), ...info });
  }
}
