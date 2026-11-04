import { readdir, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import type { DetectedCard } from '@ee/contracts';
import { isImageFileName } from './formats';
import { isTemporaryName, naturalCompare } from './naming';

export interface CardEntry {
  name: string;
  isDirectory: boolean;
  /**
   * True for a symbolic link. Such an entry is never a mounted card; on macOS it
   * is the boot volume (`/Volumes/Macintosh HD` points at `/`).
   */
  isSymlink?: boolean;
}

/** Minimal filesystem surface, injectable so each platform path can be tested anywhere. */
export interface CardFileSystem {
  list(path: string): Promise<CardEntry[]>;
  isDirectory(path: string): Promise<boolean>;
}

/**
 * What Windows reports about one drive root (`E:\`): the shape of `readDriveInfo` in `@ee/core`.
 * `driveType` is the `GetDriveTypeW` value (1 no volume, 2 removable, 3 fixed, 4 network,
 * 5 optical); `errorCode` is the Win32 error of reading the volume, absent on success.
 */
export interface DriveInfo {
  root: string;
  driveType: number;
  label?: string;
  errorCode?: number;
}

/** Looks up the type and label of drive roots. Resolves to nothing where that is not supported. */
export type ReadDriveInfo = (roots: string[]) => Promise<DriveInfo[]>;

export interface DetectCardsOptions {
  platform?: NodeJS.Platform;
  /** User name used in the Linux mount roots. */
  user?: string;
  /**
   * Parent folders whose subfolders are the volumes, on any platform. Replaces
   * the per-platform defaults (`/media/<user>`, `/run/media/<user>`, `/media`,
   * `/Volumes`) and, on Windows, the drive probing.
   */
  mountRoots?: string[];
  /** Windows drives to probe; defaults to D: through Z:. */
  windowsDrives?: string[];
  /**
   * Windows only: reads a drive's type and volume label (the native core provides it). Without
   * it, or when a lookup fails or times out, a drive is named "Drive E". A drive that is not
   * removable or fixed (network, optical, no volume) is not scanned at all once it is known to be.
   */
  readDriveInfo?: ReadDriveInfo;
  fs?: CardFileSystem;
  /** How long one filesystem probe may take before its answer is "unknown". Default 2000. */
  probeTimeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2000;

const DRIVE_REMOVABLE = 2;
const DRIVE_FIXED = 3;
// Win32 errors for a card reader slot without a card (or a card Windows cannot mount). The
// volume is not there to be a card, and probing its DCIM folder through Node could still wake
// the "There is no disk in the drive" dialog, so such a drive is skipped.
const ERROR_NOT_READY = 21;
const ERROR_UNRECOGNIZED_VOLUME = 1005;
const ERROR_NO_MEDIA_IN_DRIVE = 1112;
const NO_VOLUME_ERRORS: ReadonlySet<number> = new Set([
  ERROR_NOT_READY,
  ERROR_UNRECOGNIZED_VOLUME,
  ERROR_NO_MEDIA_IN_DRIVE,
]);

const nodeCardFs: CardFileSystem = {
  async list(path) {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      }));
    } catch (error) {
      // Only "not there" is an answer. A listing that fails for another reason (EACCES, EIO on a
      // busy reader) says nothing about which cards are mounted, so it must not look like "none".
      if (isNotThere(error)) {
        return [];
      }
      throw error;
    }
  },
  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch (error) {
      if (isNotThere(error)) {
        return false;
      }
      throw error;
    }
  },
};

function isNotThere(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? '';
  }
}

function defaultMountRoots(platform: NodeJS.Platform, user: string): string[] {
  if (platform === 'linux') {
    // `/media/<user>` is udisks on Debian/Ubuntu, `/run/media/<user>` on Fedora/Arch,
    // plain `/media` is for volumes mounted by hand or by an automounter.
    return [posix.join('/media', user), posix.join('/run/media', user), '/media'];
  }
  if (platform === 'darwin') {
    return ['/Volumes'];
  }
  return [];
}

function defaultWindowsDrives(): string[] {
  return Array.from(
    { length: 23 },
    (_, index) => `${String.fromCharCode('D'.charCodeAt(0) + index)}:`,
  );
}

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

async function countImages(
  fs: CardFileSystem,
  dcim: string,
  platform: NodeJS.Platform,
): Promise<number> {
  const path = pathApi(platform);
  let count = 0;
  const pending = [dcim];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      break;
    }
    let entries: CardEntry[];
    try {
      entries = await fs.list(directory);
    } catch (error) {
      // A card must show a count even if one subfolder is unreadable; only DCIM itself has to list.
      if (directory === dcim) {
        throw error;
      }
      continue;
    }
    for (const entry of entries) {
      if (isTemporaryName(entry.name)) {
        continue;
      }
      if (entry.isDirectory) {
        pending.push(path.join(directory, entry.name));
      } else if (isImageFileName(entry.name)) {
        count += 1;
      }
    }
  }
  return count;
}

interface Volume {
  mountPath: string;
  volumeLabel: string;
  /** The folder it was listed in; absent for a Windows drive. */
  root?: string;
}

/** What a probe learned: an answer, or nothing (timed out, still pending, or failed). */
type Probed<T> = { known: true; value: T } | { known: false };

type ImageCount =
  | { state: 'pending'; settled: Promise<void> }
  | { state: 'done'; count: number }
  | { state: 'failed' };

/**
 * Finds mounted volumes that look like camera cards, without native modules or
 * platform tools, and counts their images once in the background.
 *
 * - Linux scans `/media/<user>`, `/run/media/<user>` and `/media`.
 * - macOS scans `/Volumes` and ignores the boot volume (a symlink to `/`).
 * - Windows probes the drive letters D: to Z: concurrently. Node has no volume label API, so
 *   the label comes from the injected `readDriveInfo` (the native core), one drive at a time
 *   under the same timeout as every other probe, and is "Drive D" when that is missing, empty,
 *   failed or too slow. Network, optical and empty drives are left out before any `DCIM` probe.
 *
 * A volume is a card when it has a `DCIM` folder. Every filesystem probe has a
 * timeout, so a dead network drive or a stalled automount cannot hang a scan. A probe
 * that timed out is not issued again while it is still pending, so a dead drive
 * holds at most one libuv thread however often the scan runs.
 *
 * Only the Linux roots run against a real filesystem in CI; the other platforms use
 * the same code with injected roots and filesystem.
 */
export class CardScanner {
  readonly #platform: NodeJS.Platform;
  readonly #fs: CardFileSystem;
  readonly #roots: string[];
  readonly #drives: string[];
  readonly #timeoutMs: number;
  readonly #user: string;
  readonly #readDriveInfo: ReadDriveInfo | undefined;
  readonly #counts = new Map<string, ImageCount>();
  /** Cards found so far, kept while a later probe of them is unknown. */
  readonly #cards = new Map<string, Volume>();
  readonly #inflight = new Map<string, Promise<Probed<unknown>>>();

  constructor(options: DetectCardsOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#fs = options.fs ?? nodeCardFs;
    this.#user = options.user ?? currentUser();
    this.#timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#roots = options.mountRoots ?? defaultMountRoots(this.#platform, this.#user);
    this.#drives = options.windowsDrives ?? defaultWindowsDrives();
    this.#readDriveInfo = options.readDriveInfo;
  }

  /**
   * The cards that are mounted now. A card whose images are not counted yet is returned
   * without `imageCount`: the list never waits for a count.
   *
   * - `recount` starts a new count for every card that answered, so the numbers are never
   *   older than this scan. A card appearing for the first time is counted either way.
   * - `waitForCounts` returns once the counts that are running have finished, for the
   *   caller that wants the numbers after it showed the list.
   *
   * A card that was found before leaves the result only on a definite answer: its `DCIM`
   * folder is not there, or a completed listing of its root no longer has it. A probe that
   * timed out, is still pending or failed is "unknown", and the card stays listed (with
   * its last count), because a busy USB reader can stall a `stat` for seconds and a card
   * that drops out loses the user's pick. A volume never seen before needs a positive
   * answer to appear. Nothing scans by itself; the app scans when the Ingest view opens and
   * on request.
   */
  async scan(
    options: { recount?: boolean; waitForCounts?: boolean } = {},
  ): Promise<DetectedCard[]> {
    const path = pathApi(this.#platform);
    const { volumes, unknownRoots } = await this.#volumes();

    const candidates = new Map<string, Volume>();
    for (const volume of volumes) {
      if (!candidates.has(volume.mountPath)) {
        candidates.set(volume.mountPath, volume);
      }
    }
    // A root that could not be listed says nothing about its cards; ask each one directly.
    for (const [mountPath, volume] of this.#cards) {
      if (volume.root !== undefined && unknownRoots.has(volume.root)) {
        candidates.set(mountPath, volume);
      }
    }

    const probed = await Promise.all(
      [...candidates.values()].map(async (volume) => ({
        volume,
        result: await this.#probe(`dcim:${volume.mountPath}`, () =>
          this.#fs.isDirectory(path.join(volume.mountPath, 'DCIM')),
        ),
      })),
    );

    const found = new Map<string, Volume>();
    const answered = new Set<string>();
    for (const { volume, result } of probed) {
      const previous = this.#cards.get(volume.mountPath);
      if (result.known) {
        if (result.value) {
          this.#cards.set(volume.mountPath, volume);
          found.set(volume.mountPath, volume);
          answered.add(volume.mountPath);
        } else {
          this.#cards.delete(volume.mountPath);
        }
      } else if (previous) {
        found.set(volume.mountPath, previous);
      }
    }
    // Known cards that no candidate mentioned (listed, then absent from a completed listing) are gone.
    for (const mountPath of this.#cards.keys()) {
      if (!candidates.has(mountPath)) {
        this.#cards.delete(mountPath);
      }
    }

    // A card that left is forgotten, so putting it back counts again.
    for (const mountPath of this.#counts.keys()) {
      if (!found.has(mountPath)) {
        this.#counts.delete(mountPath);
      }
    }
    for (const mountPath of found.keys()) {
      // A card that did not answer this time is not read again for a number it cannot give.
      if (!this.#counts.has(mountPath) || (options.recount && answered.has(mountPath))) {
        this.#startCount(mountPath);
      }
    }

    if (options.waitForCounts) {
      await Promise.all(
        [...this.#counts.values()].map((count) =>
          count.state === 'pending' ? count.settled : undefined,
        ),
      );
    }

    return [...found.values()]
      .map((volume): DetectedCard => {
        const count = this.#counts.get(volume.mountPath);
        return {
          mountPath: volume.mountPath,
          volumeLabel: volume.volumeLabel,
          ...(count?.state === 'done' ? { imageCount: count.count } : {}),
        };
      })
      .sort((a, b) => naturalCompare(a.mountPath, b.mountPath));
  }

  async #volumes(): Promise<{ volumes: Volume[]; unknownRoots: Set<string> }> {
    const unknownRoots = new Set<string>();
    if (this.#platform === 'win32' && this.#roots.length === 0) {
      const drives = await Promise.all(this.#drives.map((drive) => this.#windowsVolume(drive)));
      return {
        volumes: drives.filter((volume): volume is Volume => volume !== undefined),
        unknownRoots,
      };
    }
    const path = pathApi(this.#platform);
    const lists = await Promise.all(
      [...new Set(this.#roots)].map(async (root) => ({
        root,
        listed: await this.#probe(`list:${root}`, () => this.#fs.list(root)),
      })),
    );
    const volumes: Volume[] = [];
    for (const { root, listed } of lists) {
      if (!listed.known) {
        unknownRoots.add(root);
        continue;
      }
      for (const entry of [...listed.value].sort((a, b) => naturalCompare(a.name, b.name))) {
        // `/media` also holds the per-user folder that is a root of its own.
        if (
          !entry.isDirectory ||
          entry.isSymlink === true ||
          isTemporaryName(entry.name) ||
          (this.#platform === 'linux' && root === '/media' && entry.name === this.#user)
        ) {
          continue;
        }
        volumes.push({ mountPath: path.join(root, entry.name), volumeLabel: entry.name, root });
      }
    }
    return { volumes, unknownRoots };
  }

  /**
   * One Windows drive as a candidate card, or nothing when it is known not to be one. Each
   * drive is asked separately, so a drive that stalls delays only itself, by the probe timeout.
   *
   * - Not removable or fixed (network, optical, no volume): not a candidate, and never touched
   *   again, so a network share is not read. Fixed counts because many USB and CFexpress readers
   *   present a card as a fixed disk.
   * - No medium (an empty reader slot): not a candidate.
   * - Unknown (no lookup, native failure, timeout): "Drive E", or the label the card had when it
   *   was last found, and the `DCIM` probe decides as it always did.
   */
  async #windowsVolume(drive: string): Promise<Volume | undefined> {
    const letter = drive.replace(/[:\\]+$/, '');
    const mountPath = `${letter}:\\`;
    const generic = `Drive ${letter}`;
    const read = this.#readDriveInfo;
    if (!read) {
      return { mountPath, volumeLabel: generic };
    }
    const probed = await this.#probe(`drive:${mountPath}`, async () => {
      const info = (await read([mountPath])).find((entry) => entry.root === mountPath);
      if (!info) {
        throw new Error(`no drive information for ${mountPath}`);
      }
      return info;
    });
    if (!probed.known) {
      return { mountPath, volumeLabel: this.#cards.get(mountPath)?.volumeLabel ?? generic };
    }
    const { driveType, label, errorCode } = probed.value;
    if (driveType !== DRIVE_REMOVABLE && driveType !== DRIVE_FIXED) {
      return undefined;
    }
    if (errorCode !== undefined && NO_VOLUME_ERRORS.has(errorCode)) {
      return undefined;
    }
    return { mountPath, volumeLabel: label ?? generic };
  }

  /** Runs a filesystem call with a timeout. A timeout or an error is "unknown", never "not there". */
  #probe<T>(key: string, run: () => Promise<T>): Promise<Probed<T>> {
    let pending = this.#inflight.get(key) as Promise<Probed<T>> | undefined;
    if (!pending) {
      // A stalled call cannot be cancelled, so it stays registered until it settles.
      // `run` may throw before it returns a promise (e.g. the native core is not built): that is a failure too.
      pending = (async () => run())().then(
        (value): Probed<T> => ({ known: true, value }),
        (): Probed<T> => ({ known: false }),
      );
      this.#inflight.set(key, pending);
      void pending.then(() => {
        if (this.#inflight.get(key) === pending) {
          this.#inflight.delete(key);
        }
      });
    }
    return withTimeout(pending, this.#timeoutMs);
  }

  #startCount(mountPath: string): void {
    const path = pathApi(this.#platform);
    // A newer count replaces this one; the older result is then ignored.
    const entry: ImageCount = { state: 'pending', settled: Promise.resolve() };
    const settle = (next: ImageCount): void => {
      if (this.#counts.get(mountPath) === entry) {
        this.#counts.set(mountPath, next);
      }
    };
    entry.settled = countImages(this.#fs, path.join(mountPath, 'DCIM'), this.#platform).then(
      (count) => settle({ state: 'done', count }),
      () => settle({ state: 'failed' }),
    );
    this.#counts.set(mountPath, entry);
  }
}

function withTimeout<T>(promise: Promise<Probed<T>>, ms: number): Promise<Probed<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ known: false }), ms);
    timer.unref();
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** One-shot detection that waits for the image counts. The app keeps a {@link CardScanner} instead. */
export function detectCards(options: DetectCardsOptions = {}): Promise<DetectedCard[]> {
  return new CardScanner(options).scan({ waitForCounts: true });
}
