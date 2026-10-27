import { readdir, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import type { DetectedCard } from '@ee/contracts';
import { isImageFileName } from './formats';
import { isTemporaryName, naturalCompare } from './naming';

export interface CardEntry {
  name: string;
  isDirectory: boolean;
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
  /** Overrides the parent folders scanned on Linux/macOS, or drives on Windows. */
  mountRoots?: string[];
  /** Windows drives to probe; defaults to D: through Z:. */
  windowsDrives?: string[];
  fs?: CardFileSystem;
}

const nodeCardFs: CardFileSystem = {
  async list(path) {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
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
    return [posix.join('/media', user), posix.join('/run/media', user)];
  }
  if (platform === 'darwin') {
    return ['/Volumes'];
  }
  return [];
}

function defaultWindowsDrives(): string[] {
  return Array.from({ length: 23 }, (_, index) => `${String.fromCharCode('D'.charCodeAt(0) + index)}:`);
}

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

async function countImages(fs: CardFileSystem, dcim: string, platform: NodeJS.Platform): Promise<number> {
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

/**
 * Finds mounted volumes that look like camera cards, without native modules.
 *
 * Linux scans `/media/<user>` and `/run/media/<user>`, macOS scans `/Volumes`,
 * Windows probes drive letters D: to Z:. Only the Linux roots are exercised on
 * CI; the other paths take the same code with injected roots and filesystem.
 */
export async function detectCards(options: DetectCardsOptions = {}): Promise<DetectedCard[]> {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? nodeCardFs;
  const path = pathApi(platform);
  const user = options.user ?? currentUser();

  const volumes: Array<{ mountPath: string; volumeLabel: string }> = [];
  if (platform === 'win32') {
    const drives = options.mountRoots ?? options.windowsDrives ?? defaultWindowsDrives();
    for (const drive of drives) {
      volumes.push({
        mountPath: drive.endsWith('\\') ? drive : `${drive}\\`,
        volumeLabel: drive.replace(/\\$/, ''),
      });
    }
  } else {
    const roots = options.mountRoots ?? defaultMountRoots(platform, user);
    for (const root of roots) {
      const entries = await fs.list(root);
      for (const entry of entries.sort((a, b) => naturalCompare(a.name, b.name))) {
        if (entry.isDirectory && !isTemporaryName(entry.name)) {
          volumes.push({
            mountPath: path.join(root, entry.name),
            volumeLabel: entry.name,
          });
        }
      }
    }
  }

  const cards: DetectedCard[] = [];
  const seen = new Set<string>();
  for (const volume of volumes) {
    if (seen.has(volume.mountPath)) {
      continue;
    }
    const dcim = path.join(volume.mountPath, 'DCIM');
    if (!(await fs.isDirectory(dcim))) {
      continue;
    }
    seen.add(volume.mountPath);
    cards.push({
      mountPath: volume.mountPath,
      volumeLabel: volume.volumeLabel,
      imageCount: await countImages(fs, dcim, platform),
    });
  }
  return cards.sort((a, b) => naturalCompare(a.mountPath, b.mountPath));
}
