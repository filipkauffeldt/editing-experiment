import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * Identity of a file that has already been ingested. Deliberately includes the
 * size and modification time: a file replaced in place under the same path is a
 * new file and must be ingested again.
 */
export interface SeenFile {
  sourceId: string;
  /** Absolute local path, or the path on the remote server. */
  path: string;
  size: number;
  mtimeMs: number;
}

/** Remembers files that have already been copied so a re-run can skip them. */
export interface SeenStore {
  has(file: SeenFile): boolean;
  add(file: SeenFile): void;
}

const keyOf = (file: SeenFile): string =>
  `${file.sourceId}\u0000${file.path}\u0000${file.size}\u0000${file.mtimeMs}`;

/** In-memory implementation, for tests and short-lived jobs. */
export class MemorySeenStore implements SeenStore {
  readonly #files = new Set<string>();

  has(file: SeenFile): boolean {
    return this.#files.has(keyOf(file));
  }

  add(file: SeenFile): void {
    this.#files.add(keyOf(file));
  }

  get size(): number {
    return this.#files.size;
  }
}

/**
 * Durable seen-store backed by Node's built-in SQLite. No native module, so it
 * does not need to be rebuilt per Electron ABI.
 */
export class SqliteSeenStore implements SeenStore {
  readonly #db: DatabaseSync;
  readonly #hasStatement: StatementSync;
  readonly #addStatement: StatementSync;

  constructor(filePath: string) {
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.#db = new DatabaseSync(filePath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS seen_files (
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        ingested_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, path, size, mtime_ms)
      );
    `);
    this.#hasStatement = this.#db.prepare(
      `SELECT 1 FROM seen_files
       WHERE source_id = ? AND path = ? AND size = ? AND mtime_ms = ?
       LIMIT 1`,
    );
    this.#addStatement = this.#db.prepare(
      `INSERT OR IGNORE INTO seen_files (source_id, path, size, mtime_ms, ingested_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
  }

  has(file: SeenFile): boolean {
    return this.#hasStatement.get(file.sourceId, file.path, file.size, file.mtimeMs) !== undefined;
  }

  add(file: SeenFile): void {
    this.#addStatement.run(file.sourceId, file.path, file.size, file.mtimeMs, Date.now());
  }

  close(): void {
    this.#db.close();
  }
}
