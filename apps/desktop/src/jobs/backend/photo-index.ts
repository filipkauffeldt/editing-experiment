import type { Photo, PhotoId, SourceId } from '@ee/contracts';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** An indexed photo plus the bookkeeping that is not part of the `Photo` contract. */
export interface PhotoRecord {
  photo: Photo;
  /** The metadata template applied at ingest (or last applied by the user). */
  templatePath?: string;
}

interface Row {
  json: string;
  template_path: string | null;
}

/**
 * The photo index in `node:sqlite`. It is a cache: sidecars hold the metadata
 * and edits, so losing the file loses the film strip order and ingest status,
 * never a photo's data. Rows keep insertion order, which is ingest order.
 *
 * TODO: tagged / colour class. The contract has no field for them yet (the UI
 * keeps them in renderer state); add a column here once `Photo` grows one.
 */
export class PhotoIndex {
  private readonly db: DatabaseSync;
  private readonly upsertStatement: StatementSync;
  private readonly getStatement: StatementSync;
  private readonly listStatement: StatementSync;
  private readonly listBySourceStatement: StatementSync;
  private readonly templateStatement: StatementSync;

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS photos (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL,
        template_path TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS photos_source ON photos (source_id, seq);
    `);
    this.upsertStatement = this.db.prepare(
      `INSERT INTO photos (id, source_id, template_path, json) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, source_id = excluded.source_id`,
    );
    this.getStatement = this.db.prepare('SELECT json, template_path FROM photos WHERE id = ?');
    this.listStatement = this.db.prepare('SELECT json, template_path FROM photos ORDER BY seq');
    this.listBySourceStatement = this.db.prepare(
      'SELECT json, template_path FROM photos WHERE source_id = ? ORDER BY seq',
    );
    this.templateStatement = this.db.prepare('UPDATE photos SET template_path = ? WHERE id = ?');
  }

  /** Insert, or replace the stored photo while keeping its position. */
  save(photo: Photo, templatePath?: string): void {
    this.upsertStatement.run(photo.id, photo.sourceId, templatePath ?? null, JSON.stringify(photo));
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

  close(): void {
    this.db.close();
  }
}

function toRecord(row: Row): PhotoRecord {
  return {
    photo: JSON.parse(row.json) as Photo,
    ...(row.template_path === null ? {} : { templatePath: row.template_path }),
  };
}
