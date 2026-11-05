import type { PresetProblem } from '@ee/contracts';
import { parsePreset } from '@ee/develop-gl/preset';
import { readdir, readFile, stat } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { StoredPreset } from './presets';

/**
 * Develop presets found in Adobe's folders and the user's: `.xmp` and `.lrtemplate` files read where
 * they are. **This module only reads**: `readdir`, `stat` and `readFile` are the only filesystem calls
 * it makes, and nothing it finds is copied into userData. A changed file is read again (its stamp is
 * its modified time and size), a removed one is gone from the next scan.
 */

/**
 * Where Adobe's apps keep a user's develop presets on this platform, if they are installed: Camera Raw
 * (shared with Lightroom Classic's current presets) and Lightroom's own `Develop Presets`. The path
 * rules of the platform asked about are used, so Windows paths come out right on any host.
 */
export function defaultPresetFolders(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  if (platform === 'darwin') {
    const support = path.posix.join(home, 'Library', 'Application Support', 'Adobe');
    return [
      path.posix.join(support, 'CameraRaw', 'Settings'),
      path.posix.join(support, 'Lightroom', 'Develop Presets'),
    ];
  }
  if (platform === 'win32') {
    const roaming = env['APPDATA'] || path.win32.join(home, 'AppData', 'Roaming');
    return [
      path.win32.join(roaming, 'Adobe', 'CameraRaw', 'Settings'),
      path.win32.join(roaming, 'Adobe', 'Lightroom', 'Develop Presets'),
    ];
  }
  // TODO(linux): Adobe has no Linux installer, so there is no default folder to scan; the user
  // copies the folders over and adds them in Settings → Presets.
  return [];
}

const MAX_DEPTH = 8;
/** Develop presets are a few kilobytes; a bigger file is not one, and is not read. */
const MAX_PRESET_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
/** A file modified less than this long before it is read may change again without a new stamp. */
const RACY_MS = 2500;

/** A filesystem call that did not answer in time: a dead network share, an unplugged drive. */
class NotAnswering extends Error {
  override readonly name = 'NotAnswering';
}

/**
 * Runs filesystem calls with a timeout, so one that never returns cannot hold a scan. A call that
 * timed out is still pending, and asking for it again joins it instead of starting another one, so
 * repeated scans of a dead drive do not use up the thread pool.
 */
class Guard {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly timeoutMs: number) {}

  run<T>(key: string, call: () => Promise<T>): Promise<T> {
    let pending = this.inflight.get(key) as Promise<T> | undefined;
    if (!pending) {
      const started = call();
      pending = started;
      this.inflight.set(key, started);
      const forget = (): void => {
        if (this.inflight.get(key) === started) this.inflight.delete(key);
      };
      started.then(forget, forget);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new NotAnswering(`did not answer within ${this.timeoutMs / 1000} s`)),
        this.timeoutMs,
      );
      pending.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}

/** What reading one file gave; kept while the file's stamp stays the same. */
type Parsed =
  | { kind: 'preset'; stored: StoredPreset }
  /** Valid, but not a develop preset: a profile look, or another preset type. Not listed. */
  | { kind: 'other' }
  | { kind: 'problem'; reason: string };

export interface FoundPreset {
  stored: StoredPreset;
  /** `xmp` presets win over `lrtemplate` ones with the same id. */
  format: 'xmp' | 'lrtemplate';
}

export interface PresetScan {
  found: FoundPreset[];
  problems: PresetProblem[];
  /** The folders that exist (a folder that is not there is neither scanned nor a problem). */
  folders: string[];
}

export interface PresetFoldersOptions {
  /** The user's extra folders (settings). */
  folders: () => readonly string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** The longest a single filesystem call may take (tests shorten it). */
  timeoutMs?: number;
  /** The filesystem calls; tests replace them to simulate a drive that never answers. */
  fs?: Pick<typeof FsPromises, 'readdir' | 'readFile' | 'stat'>;
}

export class PresetFolders {
  private readonly guard: Guard;
  private readonly fs: NonNullable<PresetFoldersOptions['fs']>;
  /** Parses by file path; only files seen in the latest scan are kept. */
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly options: PresetFoldersOptions) {
    this.guard = new Guard(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.fs = options.fs ?? { readdir, readFile, stat };
  }

  /** Folders that are scanned: Adobe's own where they exist, then the user's, without repeats. */
  folders(): string[] {
    const defaults = defaultPresetFolders(
      this.options.platform,
      this.options.env,
      this.options.home,
    );
    return [...new Set([...defaults, ...this.options.folders()])];
  }

  /** Reads every folder. Never throws: whatever cannot be read becomes a problem. */
  async scan(): Promise<PresetScan> {
    const roots = this.folders();
    // Folders are scanned side by side, so a slow one does not hold up the others.
    const results = await Promise.all(roots.map((root) => this.scanRoot(root)));
    const seen = new Map<string, CacheEntry>();
    const found: FoundPreset[] = [];
    const problems: PresetProblem[] = [];
    const folders: string[] = [];
    const claimed = new Set<string>();
    results.forEach((result, index) => {
      if (result === 'missing') return;
      folders.push(roots[index] as string);
      if ('problem' in result) {
        problems.push(result.problem);
        return;
      }
      for (const file of result.files) {
        // One entry per file, however many folders reach it; the first folder's group counts.
        if (claimed.has(file.path)) continue;
        claimed.add(file.path);
        seen.set(file.path, file.entry);
        const { parsed } = file.entry;
        if (parsed.kind === 'problem') problems.push({ path: file.path, reason: parsed.reason });
        else if (parsed.kind === 'preset') {
          const group = parsed.stored.group ?? file.folderGroup;
          found.push({
            stored: { ...parsed.stored, ...(group ? { group } : {}) },
            format: file.path.toLowerCase().endsWith('.xmp') ? 'xmp' : 'lrtemplate',
          });
        }
      }
    });
    this.cache = seen;
    return { found, problems, folders };
  }

  private async scanRoot(
    root: string,
  ): Promise<
    | 'missing'
    | { problem: PresetProblem }
    | { files: { path: string; folderGroup: string; entry: CacheEntry }[] }
  > {
    const files: { path: string; folderGroup: string; entry: CacheEntry }[] = [];
    try {
      await this.walk(root, root, 0, files);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
      return { problem: { path: root, reason: describe(error) } };
    }
    return { files };
  }

  private async walk(
    root: string,
    folder: string,
    depth: number,
    out: { path: string; folderGroup: string; entry: CacheEntry }[],
  ): Promise<void> {
    const entries = await this.guard.run(`readdir\0${folder}`, () =>
      this.fs.readdir(folder, { withFileTypes: true }),
    );
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        try {
          await this.walk(root, file, depth + 1, out);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // A folder that disappeared or cannot be opened must not hide the rest; a drive that
          // does not answer stops the scan of this root.
          if (error instanceof NotAnswering) throw error;
          if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') throw error;
        }
      } else if (entry.isFile() && /\.(xmp|lrtemplate)$/i.test(entry.name)) {
        if (entry.name.startsWith('._')) continue;
        const parsed = await this.read(file);
        if (parsed === undefined) continue;
        out.push({ path: file, folderGroup: groupOfFolder(root, folder), entry: parsed });
      }
    }
  }

  private async read(file: string): Promise<CacheEntry | undefined> {
    try {
      const info = await this.guard.run(`stat\0${file}`, () => this.fs.stat(file));
      const stamp = `${info.mtimeMs}:${info.size}`;
      const cached = this.cache.get(file);
      if (cached?.stamp === stamp && !cached.racy) return cached;
      if (info.size > MAX_PRESET_BYTES) {
        return { stamp, parsed: { kind: 'problem', reason: 'Too large to be a preset' } };
      }
      const text = await this.guard.run(`read\0${file}`, () => this.fs.readFile(file, 'utf8'));
      const racy = Date.now() - info.mtimeMs < RACY_MS;
      return { stamp, parsed: parseFile(text, file), ...(racy ? { racy } : {}) };
    } catch (error) {
      if (error instanceof NotAnswering) throw error;
      // Gone between the listing and the read: it is not there any more.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return { stamp: '', parsed: { kind: 'problem', reason: describe(error) } };
    }
  }
}

interface CacheEntry {
  stamp: string;
  parsed: Parsed;
  /**
   * Read within a moment of the file's own modified time. Timestamps are coarse (a kernel tick, a
   * second on HFS+, two on exFAT), so a second edit of the same length right after could carry the
   * same stamp; such an entry is read again by the next scan, whatever its stamp says.
   */
  racy?: boolean;
}

/** The folder below the scanned root, as the group: `Sport/Fotboll`. The root itself has none. */
function groupOfFolder(root: string, folder: string): string {
  return path
    .relative(root, folder)
    .split(/[\\/]/)
    .filter((part) => part !== '')
    .join('/');
}

function parseFile(text: string, file: string): Parsed {
  const isXmp = file.toLowerCase().endsWith('.xmp');
  // Camera Raw's profile looks (Adobe Color, Vivid…) are `.xmp` files too. They belong to the profile
  // list, so they are neither presets nor problems, and are recognised before any parse.
  if (isXmp && /PresetType\s*=\s*["']Look["']/.test(text)) return { kind: 'other' };
  try {
    const { preset, unsupported, presetType } = parsePreset(text, { path: file });
    if (presetType !== undefined && presetType.toLowerCase() !== 'normal') return { kind: 'other' };
    return { kind: 'preset', stored: { ...preset, unsupported } };
  } catch (error) {
    return { kind: 'problem', reason: describe(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
