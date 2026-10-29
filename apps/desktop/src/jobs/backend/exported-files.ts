import { existsSync, readFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJsonAtomic } from './atomic-json';

const FILE_VERSION = 1;
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

/** Absolute, case-folded on platforms where file names are case-insensitive. */
export function normalizeExportPath(path: string): string {
  const absolute = resolve(path);
  return CASE_INSENSITIVE ? absolute.toLowerCase() : absolute;
}

interface StoredExports {
  version: number;
  files: string[];
}

/**
 * Paths this app has exported. `ifExists: 'overwrite'` may only replace one of
 * these; anything else could be an ingested original or a file the user cares
 * about. The list survives restarts, so overwriting an old export still works.
 */
export class ExportedFileStore {
  private readonly files: Set<string>;

  constructor(
    private readonly file: string | undefined,
    onWarning: (message: string) => void = () => {},
  ) {
    this.files = new Set();
    if (file === undefined || !existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredExports>;
      if (!Array.isArray(parsed.files)) throw new Error('files is not an array');
      for (const entry of parsed.files) {
        if (typeof entry === 'string') this.files.add(normalizeExportPath(entry));
      }
    } catch (error) {
      const aside = `${file}.corrupt-${Date.now()}`;
      renameSync(file, aside);
      onWarning(
        `exported files could not be read (${error instanceof Error ? error.message : String(error)}); moved to ${aside}`,
      );
    }
  }

  has(path: string): boolean {
    return this.files.has(normalizeExportPath(path));
  }

  add(path: string): void {
    const normalized = normalizeExportPath(path);
    if (this.files.has(normalized)) return;
    this.files.add(normalized);
    this.save();
  }

  private save(): void {
    if (this.file === undefined) return;
    writeJsonAtomic(this.file, {
      version: FILE_VERSION,
      files: [...this.files].sort(),
    } satisfies StoredExports);
  }
}
