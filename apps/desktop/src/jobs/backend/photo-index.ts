import type {
  LibraryFolderInfo,
  Photo,
  PhotoFacets,
  PhotoId,
  PhotoQueryFilter,
  SourceId,
} from '@ee/contracts';
import { mkdirSync } from 'node:fs';
import { dirname, sep } from 'node:path';
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

/** The flat columns the index queries read, filled from the photo on every save. */
interface PhotoColumns {
  folder: string;
  fileName: string;
  captureTime: string | null;
  tagged: number;
  rating: number;
  colorClass: number;
  edited: number;
  upload: string;
  metadataDiffers: number;
  cameraKey: string;
}

/** A page of photos plus the counts the list needs. */
export interface PhotoQueryResult {
  photos: Photo[];
  total: number;
  scopeTotal: number;
  /** Position of the first photo in the filtered order. */
  offset: number;
}

export interface PhotoQueryOptions {
  folder?: string;
  filter?: PhotoQueryFilter;
  sort?: 'filename' | 'capture-time';
  offset?: number;
  limit?: number;
  anchorId?: PhotoId;
  /** With no anchor, take the last page of the order. */
  fromEnd?: boolean;
  /** Restrict to these ids (a search result); applied after the SQL filter. */
  ids?: ReadonlySet<PhotoId>;
}

const CHUNK = 400;

const placeholders = (count: number): string => Array.from({ length: count }, () => '?').join(', ');

function columnsOf(photo: Photo): PhotoColumns {
  const camera = photo.camera;
  // Rows written by an older app can lack status and versions; they are still indexed.
  const status = photo.status ?? {
    ingest: 'done',
    edited: false,
    metadataDiffersFromTemplate: false,
    export: 'none',
    upload: 'none',
  };
  const versions = photo.versions ?? [];
  return {
    folder: dirname(photo.path),
    fileName: photo.fileName,
    captureTime: photo.captureTime ?? null,
    tagged: photo.tagged === true ? 1 : 0,
    rating: Number.isInteger(photo.rating) ? photo.rating : 0,
    colorClass: Number.isInteger(photo.colorClass) ? photo.colorClass : 0,
    edited: status.edited || versions.some((version) => version.kind === 'retouch') ? 1 : 0,
    upload: status.upload ?? 'none',
    metadataDiffers: status.metadataDiffersFromTemplate ? 1 : 0,
    cameraKey: camera
      ? `${camera.model ?? camera.make ?? 'Unknown'}|${camera.serialNumber ?? ''}`
      : '',
  };
}

const normaliseFolder = (folder: string): string => {
  const trimmed = folder.replace(/[\\/]+$/, '');
  return trimmed === '' && folder !== '' ? sep : trimmed;
};

/**
 * The photo index in `node:sqlite`. It is a cache: sidecars hold the metadata
 * and edits, so losing the file loses the film strip order and ingest status,
 * never a photo's data. Rows keep insertion order, which is ingest order.
 *
 * Flat columns mirror what the Library queries need (folder, labels, status,
 * camera and capture time), so a 60,000 photo index answers a folder or filter
 * query from an index instead of parsing every JSON row. `save` keeps them in
 * step with the stored photo; an older file gets them filled once in the
 * migration.
 */
export class PhotoIndex {
  private readonly db: DatabaseSync;
  private readonly upsertStatement: StatementSync;
  private readonly getStatement: StatementSync;
  private readonly listStatement: StatementSync;
  private readonly listBySourceStatement: StatementSync;
  private readonly listFolderStatement: StatementSync;
  private readonly countStatement: StatementSync;
  private readonly folderCountsStatement: StatementSync;
  private readonly folderTreeCountStatement: StatementSync;
  private readonly templateStatement: StatementSync;
  private readonly pathsStatement: StatementSync;
  private readonly hasPathStatement: StatementSync;
  private readonly removeStatement: StatementSync;
  private readonly pathOfStatement: StatementSync;
  private readonly excludeStatement: StatementSync;
  private readonly includeStatement: StatementSync;
  private readonly excludedStatement: StatementSync;
  private readonly addFolderStatement: StatementSync;
  private readonly removeFolderStatement: StatementSync;
  private readonly foldersStatement: StatementSync;
  private readonly searchRowsStatement: StatementSync;
  private readonly setSearchStatement: StatementSync;
  /** A search result too large for one `IN (...)` is joined through a temporary table. */
  private useIdTable = false;

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS photos (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        folder TEXT,
        file_name TEXT,
        capture_time TEXT,
        tagged INTEGER,
        rating INTEGER,
        color_class INTEGER,
        edited INTEGER,
        upload TEXT,
        metadata_differs INTEGER,
        camera_key TEXT,
        template_path TEXT,
        source_path TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS photos_source ON photos (source_id, seq);
      CREATE INDEX IF NOT EXISTS photos_path ON photos (path);
      -- Paths the user removed from the Library while the file may still be on disk.
      CREATE TABLE IF NOT EXISTS removed_paths (path TEXT PRIMARY KEY);
      -- Folders the user added to the Library in place; nothing rescans them by itself.
      CREATE TABLE IF NOT EXISTS added_folders (path TEXT PRIMARY KEY);
    `);
    // An index made before these columns existed gets them, keeping every row.
    const columns = this.db.prepare('PRAGMA table_info(photos)').all() as unknown as {
      name: string;
    }[];
    const add = (name: string, type: string): void => {
      if (!columns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE photos ADD COLUMN ${name} ${type}`);
      }
    };
    add('source_path', 'TEXT');
    add('search_text', 'TEXT');
    add('folder', 'TEXT');
    add('file_name', 'TEXT');
    add('capture_time', 'TEXT');
    add('tagged', 'INTEGER');
    add('rating', 'INTEGER');
    add('color_class', 'INTEGER');
    add('edited', 'INTEGER');
    add('upload', 'TEXT');
    add('metadata_differs', 'INTEGER');
    add('camera_key', 'TEXT');
    this.migrateFlatColumns();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS photos_folder ON photos (folder, capture_time, file_name);
      CREATE INDEX IF NOT EXISTS photos_capture ON photos (capture_time, file_name);
      CREATE INDEX IF NOT EXISTS photos_labels ON photos (tagged, rating, color_class);
      CREATE INDEX IF NOT EXISTS photos_upload ON photos (upload);
    `);
    this.upsertStatement = this.db.prepare(
      `INSERT INTO photos (
         id, source_id, path, folder, file_name, capture_time, tagged, rating, color_class,
         edited, upload, metadata_differs, camera_key, template_path, source_path, json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         json = excluded.json,
         source_id = excluded.source_id,
         path = excluded.path,
         folder = excluded.folder,
         file_name = excluded.file_name,
         capture_time = excluded.capture_time,
         tagged = excluded.tagged,
         rating = excluded.rating,
         color_class = excluded.color_class,
         edited = excluded.edited,
         upload = excluded.upload,
         metadata_differs = excluded.metadata_differs,
         camera_key = excluded.camera_key`,
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
    this.listFolderStatement = this.db.prepare(
      'SELECT json, template_path, source_path FROM photos WHERE folder = ? ORDER BY seq',
    );
    this.countStatement = this.db.prepare('SELECT COUNT(*) AS count FROM photos');
    this.folderCountsStatement = this.db.prepare(
      'SELECT folder AS path, COUNT(*) AS count FROM photos GROUP BY folder ORDER BY folder',
    );
    this.folderTreeCountStatement = this.db.prepare(
      'SELECT COUNT(*) AS count FROM photos WHERE folder = ? OR folder LIKE ? ESCAPE ?',
    );
    this.templateStatement = this.db.prepare('UPDATE photos SET template_path = ? WHERE id = ?');
    this.removeStatement = this.db.prepare('DELETE FROM photos WHERE id = ?');
    this.pathOfStatement = this.db.prepare('SELECT path FROM photos WHERE id = ?');
    this.excludeStatement = this.db.prepare(
      'INSERT OR IGNORE INTO removed_paths (path) VALUES (?)',
    );
    this.includeStatement = this.db.prepare('DELETE FROM removed_paths WHERE path = ?');
    this.excludedStatement = this.db.prepare('SELECT path FROM removed_paths');
    this.addFolderStatement = this.db.prepare(
      'INSERT OR IGNORE INTO added_folders (path) VALUES (?)',
    );
    this.removeFolderStatement = this.db.prepare('DELETE FROM added_folders WHERE path = ?');
    this.foldersStatement = this.db.prepare('SELECT path FROM added_folders ORDER BY rowid');
    this.searchRowsStatement = this.db.prepare(
      "SELECT id, json_extract(json, '$.fileName') AS file_name, search_text FROM photos ORDER BY seq",
    );
    this.setSearchStatement = this.db.prepare('UPDATE photos SET search_text = ? WHERE id = ?');
    this.hasPathStatement = this.db.prepare('SELECT 1 FROM photos WHERE path = ? LIMIT 1');
    this.pathsStatement = this.db.prepare(
      "SELECT json_extract(json, '$.path') AS path FROM photos",
    );
  }

  /**
   * Fill the flat columns of rows written before they existed. One transaction, so an
   * interrupted migration leaves every row as it was and the next start fills them again.
   */
  private migrateFlatColumns(): void {
    const rows = this.db
      .prepare('SELECT id, json FROM photos WHERE folder IS NULL')
      .all() as unknown as { id: string; json: string }[];
    if (rows.length === 0) return;
    const update = this.db.prepare(
      `UPDATE photos SET folder = ?, file_name = ?, capture_time = ?, tagged = ?, rating = ?,
         color_class = ?, edited = ?, upload = ?, metadata_differs = ?, camera_key = ?
       WHERE id = ?`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        let photo: Photo;
        try {
          photo = JSON.parse(row.json) as Photo;
        } catch {
          // A corrupt row is left alone; it cannot be shown anyway.
          continue;
        }
        const columns = columnsOf({
          ...photo,
          tagged: photo.tagged ?? false,
          colorClass: photo.colorClass ?? 0,
          rating: photo.rating ?? 0,
          versions: photo.versions ?? [],
          status: photo.status ?? {
            ingest: 'done',
            edited: false,
            metadataDiffersFromTemplate: false,
            export: 'none',
            upload: 'none',
          },
        });
        update.run(
          columns.folder,
          columns.fileName,
          columns.captureTime,
          columns.tagged,
          columns.rating,
          columns.colorClass,
          columns.edited,
          columns.upload,
          columns.metadataDiffers,
          columns.cameraKey,
          row.id,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Insert, or replace the stored photo while keeping its position. */
  save(photo: Photo, templatePath?: string, sourcePath?: string): void {
    const columns = columnsOf(photo);
    this.upsertStatement.run(
      photo.id,
      photo.sourceId,
      photo.path,
      columns.folder,
      columns.fileName,
      columns.captureTime,
      columns.tagged,
      columns.rating,
      columns.colorClass,
      columns.edited,
      columns.upload,
      columns.metadataDiffers,
      columns.cameraKey,
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

  /** The photos directly in a folder, in index order. */
  listFolder(folder: string): Photo[] {
    const rows = this.listFolderStatement.all(normaliseFolder(folder)) as unknown as Row[];
    return rows.map((row) => toRecord(row).photo);
  }

  /** The photos whose status says edited, without parsing the rest of the index. */
  listEdited(): Photo[] {
    const rows = this.db
      .prepare('SELECT json, template_path, source_path FROM photos WHERE edited = 1 ORDER BY seq')
      .all() as unknown as Row[];
    return rows.map((row) => toRecord(row).photo);
  }

  /** How many photos the whole index holds. */
  count(): number {
    const row = this.countStatement.get() as unknown as { count: number };
    return Number(row.count);
  }

  /** Ids of the photos directly in a folder, or below it too. */
  idsInFolder(folder: string, subfolders: boolean): PhotoId[] {
    const path = normaliseFolder(folder);
    const rows = (subfolders
      ? this.db
          .prepare('SELECT id FROM photos WHERE folder = ? OR folder LIKE ? ESCAPE ?')
          .all(path, `${escapeLike(path)}${sep}%`, '\\')
      : this.db.prepare('SELECT id FROM photos WHERE folder = ?').all(path)) as unknown as {
      id: string;
    }[];
    return rows.map((row) => row.id as PhotoId);
  }

  /** The folders that hold photos with their exact counts, then the added roots. */
  folders(addedFolders: readonly string[]): LibraryFolderInfo[] {
    const rows = this.folderCountsStatement.all() as unknown as { path: string; count: number }[];
    const folders = new Map<string, LibraryFolderInfo>();
    for (const row of rows) {
      if (row.path === null || row.path === undefined) continue;
      folders.set(row.path, { path: row.path, count: Number(row.count) });
    }
    for (const root of addedFolders) {
      const folder = normaliseFolder(root);
      const count = Number(
        (
          this.folderTreeCountStatement.get(
            folder,
            `${escapeLike(folder)}${sep}%`,
            '\\',
          ) as unknown as { count: number }
        ).count,
      );
      const existing = folders.get(root) ?? folders.get(folder);
      if (existing) {
        existing.count = count;
        existing.root = true;
      } else {
        folders.set(folder, { path: folder, count, root: true });
      }
    }
    return [...folders.values()].sort((left, right) =>
      left.path.localeCompare(right.path, undefined, { numeric: true }),
    );
  }

  /** The photos of the index matching a query, a page at a time. */
  query(options: PhotoQueryOptions): PhotoQueryResult {
    const large = (options.ids?.size ?? 0) > 5_000;
    if (!large) return this.queryNow(options);
    this.useIdTable = true;
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS query_ids (id TEXT PRIMARY KEY)');
    this.db.exec('DELETE FROM query_ids');
    const ids = [...(options.ids ?? [])];
    const insert = this.db.prepare('INSERT OR IGNORE INTO query_ids (id) VALUES (?)');
    for (const id of ids) insert.run(id);
    try {
      return this.queryNow(options);
    } finally {
      this.db.exec('DROP TABLE IF EXISTS query_ids');
      this.useIdTable = false;
    }
  }

  private queryNow(options: PhotoQueryOptions): PhotoQueryResult {
    const where = this.filterSql(options);
    const scope = this.scope(options);
    const scopeTotal = Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS count FROM photos${scope.sql}`)
          .get(...scope.params) as unknown as { count: number }
      ).count,
    );
    const total = Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS count FROM photos${where.sql}`)
          .get(...where.params) as unknown as { count: number }
      ).count,
    );

    const order = this.order(options.sort);
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));
    let offset = options.offset ?? 0;
    if (options.anchorId !== undefined) {
      const position = this.position(options.anchorId, where, order);
      if (position !== undefined) offset = Math.max(0, position - Math.floor(limit / 2));
    } else if (options.fromEnd) {
      offset = Math.max(0, total - limit);
    }
    const rows = this.db
      .prepare(
        `SELECT json, template_path, source_path FROM photos${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...where.params, limit, offset) as unknown as Row[];
    return { photos: rows.map((row) => toRecord(row).photo), total, scopeTotal, offset };
  }

  /**
   * What the filter bar's options would show for the current scope. One aggregate query with
   * conditional sums, so the numbers stay true when only a page is in the renderer.
   */
  facets(options: PhotoQueryOptions): PhotoFacets {
    const large = (options.ids?.size ?? 0) > 5_000;
    if (!large) return this.facetsNow(options);
    this.useIdTable = true;
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS query_ids (id TEXT PRIMARY KEY)');
    this.db.exec('DELETE FROM query_ids');
    const insert = this.db.prepare('INSERT OR IGNORE INTO query_ids (id) VALUES (?)');
    for (const id of options.ids ?? []) insert.run(id);
    try {
      return this.facetsNow(options);
    } finally {
      this.db.exec('DROP TABLE IF EXISTS query_ids');
      this.useIdTable = false;
    }
  }

  private facetsNow(options: PhotoQueryOptions): PhotoFacets {
    const scope = this.scope(options);
    const filter = options.filter ?? {};
    const rest = this.filterSql({
      filter: { ...filter, tag: undefined, statuses: [] },
      ...(options.ids === undefined ? {} : { ids: options.ids }),
    });
    const restSql = rest.sql === '' ? '1' : rest.sql.replace(/^ WHERE /, '');
    const ticked = filter.statuses ?? [];
    const statusCondition = (status: NonNullable<PhotoQueryFilter['statuses']>[number]): string => {
      if (status === 'not-sent') return "COALESCE(upload, 'none') != 'done'";
      if (status === 'failed') return "upload = 'failed'";
      if (status === 'edited') return 'edited = 1';
      return 'metadata_differs = 1';
    };
    const all = (conditions: readonly string[]): string =>
      conditions.length === 0 ? '1' : conditions.join(' AND ');
    const allStatus = all(ticked.map(statusCondition));
    const tagOk =
      filter.tag === 'tagged'
        ? 'tagged = 1'
        : filter.tag === 'untagged'
          ? 'COALESCE(tagged, 0) = 0'
          : '1';

    const params: (string | number)[] = [];
    const sums: string[] = [];
    const sum = (conditions: readonly string[], alias: string): void => {
      sums.push(`SUM(CASE WHEN ${restSql} AND ${all(conditions)} THEN 1 ELSE 0 END) AS ${alias}`);
      params.push(...rest.params);
    };
    sum([allStatus], 'tag_all');
    sum([allStatus, 'tagged = 1'], 'tag_tagged');
    sum([allStatus, 'COALESCE(tagged, 0) = 0'], 'tag_untagged');
    sum([allStatus, tagOk], 'shown');
    const statusKeys = ['not-sent', 'failed', 'edited', 'metadata-differs'] as const;
    for (const status of statusKeys) {
      const others = ticked.filter((candidate) => candidate !== status).map(statusCondition);
      sum([tagOk, ...others, statusCondition(status)], `status_${status.replace('-', '_')}`);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS scope_total, ${sums.join(', ')} FROM photos${scope.sql}`)
      .get(...params, ...scope.params) as unknown as Record<string, number>;

    const cameraRest = this.filterSql({
      filter: { ...filter, camera: undefined, tag: undefined, statuses: [] },
      ...(options.ids === undefined ? {} : { ids: options.ids }),
    });
    const cameraWhere =
      cameraRest.sql === ''
        ? scope.sql === ''
          ? " WHERE camera_key != ''"
          : `${scope.sql} AND camera_key != ''`
        : scope.sql === ''
          ? `${cameraRest.sql} AND camera_key != ''`
          : `${scope.sql} AND ${cameraRest.sql.replace(/^ WHERE /, '')} AND camera_key != ''`;
    const cameraRows = this.db
      .prepare(
        `SELECT camera_key AS key, COUNT(*) AS count FROM photos${cameraWhere} GROUP BY camera_key ORDER BY camera_key`,
      )
      .all(...scope.params, ...cameraRest.params) as unknown as { key: string; count: number }[];

    return {
      shown: Number(row.shown ?? 0),
      scopeTotal: Number(row.scope_total ?? 0),
      tag: {
        all: Number(row.tag_all ?? 0),
        tagged: Number(row.tag_tagged ?? 0),
        untagged: Number(row.tag_untagged ?? 0),
      },
      status: {
        'not-sent': Number(row.status_not_sent ?? 0),
        failed: Number(row.status_failed ?? 0),
        edited: Number(row.status_edited ?? 0),
        'metadata-differs': Number(row.status_metadata_differs ?? 0),
      },
      cameras: cameraRows.map((camera) => {
        const [model, serial] = camera.key.split('|');
        return {
          key: camera.key,
          label: serial ? `${model} · ${serial}` : (model ?? camera.key),
          count: Number(camera.count),
        };
      }),
    };
  }

  /** The 0-based position of `photoId` in the query's order, when it matches the filter. */
  private position(
    photoId: PhotoId,
    where: { sql: string; params: (string | number)[] },
    order: string,
  ): number | undefined {
    const row = this.db
      .prepare(
        `WITH filtered AS (
           SELECT id, ROW_NUMBER() OVER (ORDER BY ${order}) - 1 AS position
           FROM photos${where.sql}
         )
         SELECT position FROM filtered WHERE id = ?`,
      )
      .get(...where.params, photoId) as unknown as { position: number } | undefined;
    return row === undefined ? undefined : Number(row.position);
  }

  private scope(options: PhotoQueryOptions): { sql: string; params: (string | number)[] } {
    return options.folder === undefined
      ? { sql: '', params: [] }
      : { sql: ' WHERE folder = ?', params: [normaliseFolder(options.folder)] };
  }

  private filterSql(options: PhotoQueryOptions): { sql: string; params: (string | number)[] } {
    const parts: string[] = [];
    const params: (string | number)[] = [];
    if (options.folder !== undefined) {
      parts.push('folder = ?');
      params.push(normaliseFolder(options.folder));
    }
    if (options.ids !== undefined) {
      if (this.useIdTable) {
        parts.push('id IN (SELECT id FROM query_ids)');
      } else {
        const ids = [...options.ids];
        parts.push(ids.length === 0 ? '0' : `id IN (${placeholders(ids.length)})`);
        params.push(...ids);
      }
    }
    const filter = options.filter;
    if (filter) {
      if (filter.tag === 'tagged') parts.push('tagged = 1');
      else if (filter.tag === 'untagged') parts.push('COALESCE(tagged, 0) = 0');
      if (filter.minRating !== undefined && filter.minRating > 0) {
        parts.push('rating >= ?');
        params.push(filter.minRating);
      }
      if (filter.colorClasses !== undefined && filter.colorClasses.length > 0) {
        parts.push(`color_class IN (${placeholders(filter.colorClasses.length)})`);
        params.push(...filter.colorClasses);
      }
      if (filter.camera !== undefined) {
        parts.push('camera_key = ?');
        params.push(filter.camera);
      }
      if (filter.sourceId !== undefined) {
        parts.push('source_id = ?');
        params.push(filter.sourceId);
      }
      for (const status of filter.statuses ?? []) {
        if (status === 'not-sent') parts.push("COALESCE(upload, 'none') != 'done'");
        else if (status === 'failed') parts.push("upload = 'failed'");
        else if (status === 'edited') parts.push('edited = 1');
        else if (status === 'metadata-differs') parts.push('metadata_differs = 1');
      }
    }
    return {
      sql: parts.length === 0 ? '' : ` WHERE ${parts.join(' AND ')}`,
      params,
    };
  }

  private order(sort: PhotoQueryOptions['sort']): string {
    return sort === 'filename'
      ? 'file_name COLLATE NOCASE, seq'
      : 'capture_time IS NULL, capture_time, file_name COLLATE NOCASE, seq';
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
   * Drop many entries and remember their paths as removed, in one transaction. Returns the ids
   * that were there. The index is touched once, so removing a 3,000 photo folder is quick.
   */
  removeManyAndExclude(photoIds: readonly PhotoId[]): PhotoId[] {
    const unique = [...new Set(photoIds)];
    if (unique.length === 0) return [];
    const removed: PhotoId[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (let at = 0; at < unique.length; at += CHUNK) {
        const chunk = unique.slice(at, at + CHUNK);
        const rows = this.db
          .prepare(`SELECT id, path FROM photos WHERE id IN (${placeholders(chunk.length)})`)
          .all(...chunk) as unknown as { id: string; path: string }[];
        for (const row of rows) {
          this.excludeStatement.run(row.path);
        }
        this.db
          .prepare(`DELETE FROM photos WHERE id IN (${placeholders(chunk.length)})`)
          .run(...chunk);
        for (const row of rows) removed.push(row.id as PhotoId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return removed;
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

  /** Remember a folder added to the Library in place. */
  addAddedFolder(path: string): void {
    this.addFolderStatement.run(path);
  }

  removeAddedFolder(path: string): void {
    this.removeFolderStatement.run(path);
  }

  /** Folders added in place, in the order they were added. */
  addedFolders(): string[] {
    const rows = this.foldersStatement.all() as unknown as { path: string }[];
    return rows.map((row) => row.path);
  }

  close(): void {
    this.db.close();
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
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
