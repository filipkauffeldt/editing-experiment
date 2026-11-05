import type { Photo, PhotoId, SourceId } from '@ee/contracts';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** An indexed photo plus the bookkeeping that is not part of the `Photo` contract. */
export interface PhotoRecord {
  photo: Photo;
  /** The metadata template applied at ingest (or last applied by the user). */
  templatePath?: string;
  /**
   * The file the photo was ingested from, as ingest saw it (a path on the server for a remote
   * source). Absent for photos found by the startup scan and for photos indexed before this was
   * recorded.
   */
  sourcePath?: string;
}

interface Row {
  json: string;
  template_path: string | null;
  source_path: string | null;
}

/**
 * The photo index in `node:sqlite`. It is a cache: sidecars hold the metadata
 * and edits, so losing the file loses the film strip order and ingest status,
 * never a photo's data. Rows keep insertion order, which is ingest order.
 */
export class PhotoIndex {
  private readonly db: DatabaseSync;
  private readonly upsertStatement: StatementSync;
  private readonly getStatement: StatementSync;
  private readonly listStatement: StatementSync;
  private readonly listBySourceStatement: StatementSync;
  private readonly templateStatement: StatementSync;
  private readonly pathsStatement: StatementSync;
  private readonly hasPathStatement: StatementSync;
  private readonly removeStatement: StatementSync;
  private readonly pathOfStatement: StatementSync;
  private readonly excludeStatement: StatementSync;
  private readonly includeStatement: StatementSync;
  private readonly excludedStatement: StatementSync;
  private readonly searchRowsStatement: StatementSync;
  private readonly setSearchStatement: StatementSync;

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS photos (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        template_path TEXT,
        source_path TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS photos_source ON photos (source_id, seq);
      CREATE INDEX IF NOT EXISTS photos_path ON photos (path);
      -- Paths the user removed from the Library while the file may still be on disk.
      CREATE TABLE IF NOT EXISTS removed_paths (path TEXT PRIMARY KEY);
    `);
    // An index made before `source_path` existed gets the column; its rows have none.
    const columns = this.db.prepare('PRAGMA table_info(photos)').all() as unknown as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === 'source_path')) {
      this.db.exec('ALTER TABLE photos ADD COLUMN source_path TEXT');
    }
    // Caption and keywords for search, as `normalizeForSearch` makes them. NULL means "not read
    // yet": the search index fills it in the background. A cache like the rest of the file.
    if (!columns.some((column) => column.name === 'search_text')) {
      this.db.exec('ALTER TABLE photos ADD COLUMN search_text TEXT');
    }
    this.upsertStatement = this.db.prepare(
      `INSERT INTO photos (id, source_id, path, template_path, source_path, json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, source_id = excluded.source_id,
         path = excluded.path`,
    );
    this.getStatement = this.db.prepare(
      'SELECT json, template_path, source_path FROM photos WHERE id = ?',
    );
    this.listStatement = this.db.prepare(
      'SELECT json, template_path, source_path FROM photos ORDER BY seq',
    );
    this.listBySourceStatement = this.db.prepare(
      'SELECT json, template_path, source_path FROM photos WHERE source_id = ? ORDER BY seq',
    );
    this.templateStatement = this.db.prepare('UPDATE photos SET template_path = ? WHERE id = ?');
    this.removeStatement = this.db.prepare('DELETE FROM photos WHERE id = ?');
    this.pathOfStatement = this.db.prepare('SELECT path FROM photos WHERE id = ?');
    this.excludeStatement = this.db.prepare(
      'INSERT OR IGNORE INTO removed_paths (path) VALUES (?)',
    );
    this.includeStatement = this.db.prepare('DELETE FROM removed_paths WHERE path = ?');
    this.excludedStatement = this.db.prepare('SELECT path FROM removed_paths');
    this.searchRowsStatement = this.db.prepare(
      "SELECT id, json_extract(json, '$.fileName') AS file_name, search_text FROM photos ORDER BY seq",
    );
    this.setSearchStatement = this.db.prepare('UPDATE photos SET search_text = ? WHERE id = ?');
    this.hasPathStatement = this.db.prepare('SELECT 1 FROM photos WHERE path = ? LIMIT 1');
    this.pathsStatement = this.db.prepare(
      "SELECT json_extract(json, '$.path') AS path FROM photos",
    );
  }

  /** Insert, or replace the stored photo while keeping its position. */
  save(photo: Photo, templatePath?: string, sourcePath?: string): void {
    this.upsertStatement.run(
      photo.id,
      photo.sourceId,
      photo.path,
      templatePath ?? null,
      sourcePath ?? null,
      JSON.stringify(photo),
    );
  }

  setTemplatePath(photoId: PhotoId, templatePath: string | undefined): void {
    this.templateStatement.run(templatePath ?? null, photoId);
  }

  get(photoId: PhotoId): PhotoRecord | undefined {
    const row = this.getStatement.get(photoId) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(sourceId?: SourceId): Photo[] {
    const rows = (sourceId === undefined
      ? this.listStatement.all()
      : this.listBySourceStatement.all(sourceId)) as unknown as Row[];
    return rows.map((row) => toRecord(row).photo);
  }

  /** Every photo's file name and indexed search text (null until it has been read). */
  searchRows(): { id: PhotoId; fileName: string; text: string | null }[] {
    const rows = this.searchRowsStatement.all() as unknown as {
      id: string;
      file_name: string | null;
      search_text: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id as PhotoId,
      fileName: row.file_name ?? '',
      text: row.search_text,
    }));
  }

  setSearchText(photoId: PhotoId, text: string): void {
    this.setSearchStatement.run(text, photoId);
  }

  /** Drop a photo's entry. Returns whether there was one. */
  remove(photoId: PhotoId): boolean {
    return Number(this.removeStatement.run(photoId).changes) > 0;
  }

  /**
   * Drop a photo's entry and remember its path as removed, in one transaction, so that the
   * startup scan does not index the file again if it is still on disk.
   */
  removeAndExclude(photoId: PhotoId): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.pathOfStatement.get(photoId) as { path: string } | undefined;
      if (row) this.excludeStatement.run(row.path);
      const removed = Number(this.removeStatement.run(photoId).changes) > 0;
      this.db.exec('COMMIT');
      return removed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Paths removed from the Library; the startup scan leaves these files alone. */
  excludedPaths(): Set<string> {
    const rows = this.excludedStatement.all() as unknown as { path: string }[];
    return new Set(rows.map((row) => row.path));
  }

  /** A new file is indexed at this path: it is not the removed photo, so stop hiding it. */
  clearExcluded(path: string): void {
    this.includeStatement.run(path);
  }

  hasPath(path: string): boolean {
    return this.hasPathStatement.get(path) !== undefined;
  }

  /** Paths of every indexed photo, to find files on disk that are not indexed. */
  paths(): Set<string> {
    const rows = this.pathsStatement.all() as unknown as { path: string }[];
    return new Set(rows.map((row) => row.path));
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: Row): PhotoRecord {
  const stored = JSON.parse(row.json) as Photo;
  const photo: Photo = {
    ...stored,
    tagged: typeof stored.tagged === 'boolean' ? stored.tagged : false,
    colorClass:
      Number.isInteger(stored.colorClass) && stored.colorClass >= 0 && stored.colorClass <= 8
        ? stored.colorClass
        : 0,
    rating:
      Number.isInteger(stored.rating) && stored.rating >= 0 && stored.rating <= 5
        ? stored.rating
        : 0,
  };
  return {
    photo,
    ...(row.template_path === null ? {} : { templatePath: row.template_path }),
    ...(row.source_path === null ? {} : { sourcePath: row.source_path }),
  };
}
