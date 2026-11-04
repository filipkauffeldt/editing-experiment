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
  fs?: CardFileSystem;
  /** How long one filesystem probe may take before the volume is treated as absent. Default 2000. */
  probeTimeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2000;

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
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
        return [];
      }
      throw error;
    }
  },
  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
};

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
    for (const entry of await fs.list(directory)) {
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
}

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
 * - Windows probes the drive letters D: to Z: concurrently. Windows exposes no volume
 *   label without a native module or a shell tool, so the label is "Drive D".
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
  readonly #counts = new Map<string, ImageCount>();
  readonly #inflight = new Map<string, Promise<unknown>>();

  constructor(options: DetectCardsOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#fs = options.fs ?? nodeCardFs;
    this.#user = options.user ?? currentUser();
    this.#timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#roots = options.mountRoots ?? defaultMountRoots(this.#platform, this.#user);
    this.#drives = options.windowsDrives ?? defaultWindowsDrives();
  }

  /**
   * The cards that are mounted now. A card whose images are not counted yet is
   * returned without `imageCount`; a later scan has it. With `waitForCounts` the
   * result waits for every count instead.
   */
  async scan(options: { waitForCounts?: boolean } = {}): Promise<DetectedCard[]> {
    const path = pathApi(this.#platform);
    const volumes = await this.#volumes();
    const probed = await Promise.all(
      volumes.map(async (volume) => ({
        volume,
        isCard: await this.#probe(`dcim:${volume.mountPath}`, () =>
          this.#fs.isDirectory(path.join(volume.mountPath, 'DCIM')),
        ),
      })),
    );

    const found = new Map<string, Volume>();
    for (const { volume, isCard } of probed) {
      if (isCard === true && !found.has(volume.mountPath)) {
        found.set(volume.mountPath, volume);
      }
    }

    // A card that left is forgotten, so putting it back counts again.
    for (const mountPath of this.#counts.keys()) {
      if (!found.has(mountPath)) {
        this.#counts.delete(mountPath);
      }
    }
    for (const mountPath of found.keys()) {
      if (!this.#counts.has(mountPath)) {
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

  async #volumes(): Promise<Volume[]> {
    if (this.#platform === 'win32' && this.#roots.length === 0) {
      return this.#drives.map((drive) => {
        const letter = drive.replace(/[:\\]+$/, '');
        return { mountPath: `${letter}:\\`, volumeLabel: `Drive ${letter}` };
      });
    }
    const path = pathApi(this.#platform);
    const lists = await Promise.all(
      [...new Set(this.#roots)].map(async (root) => ({
        root,
        entries: (await this.#probe(`list:${root}`, () => this.#fs.list(root))) ?? [],
      })),
    );
    const volumes: Volume[] = [];
    for (const { root, entries } of lists) {
      for (const entry of [...entries].sort((a, b) => naturalCompare(a.name, b.name))) {
        // `/media` also holds the per-user folder that is a root of its own.
        if (
          !entry.isDirectory ||
          entry.isSymlink === true ||
          isTemporaryName(entry.name) ||
          (this.#platform === 'linux' && root === '/media' && entry.name === this.#user)
        ) {
          continue;
        }
        volumes.push({ mountPath: path.join(root, entry.name), volumeLabel: entry.name });
      }
    }
    return volumes;
  }

  /** Runs a filesystem call with a timeout; `undefined` when it timed out or failed. */
  #probe<T>(key: string, run: () => Promise<T>): Promise<T | undefined> {
    let pending = this.#inflight.get(key) as Promise<T | undefined> | undefined;
    if (!pending) {
      // A stalled call cannot be cancelled, so it stays registered until it settles.
      pending = run().then(
        (value) => value,
        // A vanished card or unreadable folder is "not there", not an error to report on every poll.
        () => undefined,
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
    const settled = countImages(this.#fs, path.join(mountPath, 'DCIM'), this.#platform).then(
      (count) => {
        if (this.#counts.get(mountPath)?.state === 'pending') {
          this.#counts.set(mountPath, { state: 'done', count });
        }
      },
      () => {
        if (this.#counts.get(mountPath)?.state === 'pending') {
          this.#counts.set(mountPath, { state: 'failed' });
        }
      },
    );
    this.#counts.set(mountPath, { state: 'pending', settled });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
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
