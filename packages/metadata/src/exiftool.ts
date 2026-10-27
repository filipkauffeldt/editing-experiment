import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultExiftoolArgs, ExifTool } from 'exiftool-vendored';
import { MetadataError } from './errors';

/**
 * XMP property used for retouch versions. ExifTool does not know the `ee:`
 * namespace, so it is registered at launch through a generated user config
 * (`-config` must be the first command-line option, hence `exiftoolArgs`).
 */
export const EE_CONFIG = String.raw`%Image::ExifTool::UserDefined = (
  'Image::ExifTool::XMP::Main' => {
    ee => {
      SubDirectory => {
        TagTable => 'Image::ExifTool::UserDefined::ee',
        Namespace => 'http://ns.editing-experiment/1.0/',
      },
    },
  },
);
%Image::ExifTool::UserDefined::ee = (
  GROUPS => { 0 => 'XMP', 1 => 'XMP-ee', 2 => 'Image' },
  NAMESPACE => { 'ee' => 'http://ns.editing-experiment/1.0/' },
  WRITE_PROC => \&Image::ExifTool::XMP::WriteXMP,
  RetouchVersions => { Writable => 'string' },
);
1;
`;

/** A tag value accepted by {@link ExifToolService.write}. `null` deletes the tag. */
export type ExifToolTagValue = string | number | boolean | readonly string[] | null;
export type ExifToolTags = Readonly<Record<string, ExifToolTagValue>>;

export interface ExifToolServiceOptions {
  /**
   * Maximum number of tasks our API lets queue up at once. The underlying
   * ExifTool process is single (`-stay_open`, `maxProcs: 1`); this bound keeps
   * callers from piling an unbounded number of promises on top of it.
   */
  maxConcurrent?: number;
  /** Path to an existing ExifTool binary. Defaults to the vendored one. */
  exiftoolPath?: string;
}

const DEFAULT_MAX_CONCURRENT = 4;

class Semaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  constructor(count: number) {
    this.#available = count;
  }

  async acquire(): Promise<() => void> {
    const release = (): void => {
      const next = this.#waiters.shift();
      if (next === undefined) {
        this.#available += 1;
        return;
      }
      // Hand the slot straight to the next waiter instead of bumping the
      // counter, so late arrivals cannot jump the queue.
      next();
    };
    if (this.#available > 0) {
      this.#available -= 1;
      return release;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    return release;
  }
}

/**
 * One long-lived ExifTool process in `-stay_open` mode.
 *
 * Create one instance per process and call {@link close} on shutdown. Reads
 * use group family 1 (`-G1`) so schemas stay distinguishable (`XMP-dc:Subject`
 * versus `IPTC:Keywords`).
 */
export class ExifToolService {
  readonly #et: ExifTool;
  readonly #semaphore: Semaphore;
  readonly #configDir: string;
  #closed = false;

  constructor(options: ExifToolServiceOptions = {}) {
    this.#configDir = mkdtempSync(join(tmpdir(), 'ee-exiftool-'));
    const configPath = join(this.#configDir, 'ee.config');
    writeFileSync(configPath, EE_CONFIG, 'utf8');

    this.#semaphore = new Semaphore(Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
    this.#et = new ExifTool({
      maxProcs: 1,
      // `-config` has to be first on the command line, so it belongs in the
      // launch args rather than per-task write args.
      exiftoolArgs: ['-config', configPath, ...DefaultExiftoolArgs],
      ...(options.exiftoolPath === undefined ? {} : { exiftoolPath: options.exiftoolPath }),
    });
  }

  /** Read every tag, keyed by `Family1:Tag` (e.g. `XMP-dc:Description`). */
  async read(path: string): Promise<Record<string, unknown>> {
    return this.#withLimit(async () => {
      const tags = await this.#et.read(path, { readArgs: ['-G1'] });
      return tags as unknown as Record<string, unknown>;
    });
  }

  /** Write tags to `path`, creating/updating the file's metadata in place. */
  async write(path: string, tags: ExifToolTags): Promise<void> {
    const encoded: Record<string, ExifToolTagValue> = {};
    for (const [key, value] of Object.entries(tags)) {
      if (value === undefined) continue;
      encoded[key] = Array.isArray(value) ? [...value] : value;
    }
    if (Object.keys(encoded).length === 0) return;
    await this.#withLimit(async () => {
      // ExifTool otherwise leaves `<file>_original` backups next to the user's
      // photos/sidecars.
      await this.#et.write(path, encoded, { writeArgs: ['-overwrite_original'] });
    });
  }

  /** Stop the ExifTool process and remove the generated config. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#et.end();
    } finally {
      rmSync(this.#configDir, { recursive: true, force: true });
    }
  }

  async #withLimit<T>(task: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      throw new MetadataError('EXIFTOOL', 'ExifTool service is closed');
    }
    const release = await this.#semaphore.acquire();
    try {
      return await task();
    } catch (cause) {
      throw new MetadataError('EXIFTOOL', `ExifTool task failed: ${String(cause)}`, {
        cause,
      });
    } finally {
      release();
    }
  }
}

let sharedService: ExifToolService | undefined;

/** Process-wide service used by the convenience functions in this package. */
export function getExifToolService(): ExifToolService {
  sharedService ??= new ExifToolService();
  return sharedService;
}

/** Close the process-wide service (the jobs process calls this on shutdown). */
export async function closeExifTool(): Promise<void> {
  const service = sharedService;
  sharedService = undefined;
  if (service !== undefined) await service.close();
}
