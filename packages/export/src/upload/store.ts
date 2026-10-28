import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  asDestinationId,
  asPhotoId,
  asUploadId,
  type Destination,
  type UploadItem,
  type UploadItemState,
} from '@ee/contracts';
import type { StoredUploadItem } from './types';

interface UploadRow {
  id: string;
  photo_id: string;
  destination_id: string;
  destination_json: string;
  local_path: string;
  remote_path: string;
  state: string;
  bytes_sent: number;
  bytes_total: number;
  attempts: number;
  error: string | null;
  claim_token: string | null;
  created_at: number;
  next_attempt_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS upload_items (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  local_path TEXT NOT NULL,
  remote_path TEXT NOT NULL,
  state TEXT NOT NULL,
  bytes_sent INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT
);
CREATE INDEX IF NOT EXISTS upload_items_pending
  ON upload_items (state, next_attempt_at, created_at);
`;

/**
 * Durable upload queue in `node:sqlite`. It is a cache: losing it only loses
 * progress, never originals.
 */
export class UploadStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.ensureClaimTokenColumn();
    this.requeueUploading();
  }

  list(): StoredUploadItem[] {
    return this.db
      .prepare('SELECT * FROM upload_items ORDER BY created_at ASC, id ASC')
      .all()
      .map((row) => toItem(row as unknown as UploadRow));
  }

  get(id: string): StoredUploadItem | undefined {
    const row = this.db.prepare('SELECT * FROM upload_items WHERE id = ?').get(id);
    return row === undefined ? undefined : toItem(row as unknown as UploadRow);
  }

  insert(item: StoredUploadItem, createdAt: number): void {
    this.db
      .prepare(
        `INSERT INTO upload_items (
           id, photo_id, destination_id, destination_json, local_path, remote_path,
           state, bytes_sent, bytes_total, attempts, error, created_at, updated_at, next_attempt_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.photoId,
        item.destinationId,
        JSON.stringify(item.destination),
        item.localPath,
        item.remotePath,
        item.state,
        item.bytesSent,
        item.bytesTotal,
        item.attempts,
        item.error ?? null,
        createdAt,
        createdAt,
        item.nextAttemptAt,
      );
  }

  /** Atomically moves a queued row to `uploading` and counts the attempt. */
  claim(id: string, token: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE upload_items
           SET state = 'uploading', attempts = attempts + 1, error = NULL,
               claim_token = ?, updated_at = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .run(token, now, id);
    return result.changes > 0;
  }

  setProgress(id: string, token: string, bytesSent: number, now: number): void {
    this.db
      .prepare(
        `UPDATE upload_items SET bytes_sent = ?, updated_at = ?
         WHERE id = ? AND state = 'uploading' AND claim_token = ?`,
      )
      .run(Math.max(0, Math.floor(bytesSent)), now, id, token);
  }

  markDone(id: string, token: string, bytesTotal: number, now: number): void {
    this.db
      .prepare(
        `UPDATE upload_items
           SET state = 'done', bytes_sent = ?, bytes_total = ?, error = NULL,
               claim_token = NULL, updated_at = ?
         WHERE id = ? AND state = 'uploading' AND claim_token = ?`,
      )
      .run(bytesTotal, bytesTotal, now, id, token);
  }

  markFailed(id: string, token: string, error: string, now: number): void {
    this.db
      .prepare(
        `UPDATE upload_items SET state = 'failed', error = ?, claim_token = NULL, updated_at = ?
         WHERE id = ? AND state = 'uploading' AND claim_token = ?`,
      )
      .run(error, now, id, token);
  }

  scheduleRetry(id: string, token: string, nextAttemptAt: number, now: number): void {
    this.db
      .prepare(
        `UPDATE upload_items
           SET state = 'queued', bytes_sent = 0, error = NULL, claim_token = NULL,
               next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND state = 'uploading' AND claim_token = ?`,
      )
      .run(nextAttemptAt, now, id, token);
  }

  markCancelled(id: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE upload_items
           SET state = 'cancelled', error = NULL, claim_token = NULL, updated_at = ?
         WHERE id = ? AND state IN ('queued', 'uploading', 'failed')`,
      )
      .run(now, id);
    return result.changes > 0;
  }

  /** Marks a run cancelled only while it still owns the row. */
  markCancelledForClaim(id: string, token: string, now: number): void {
    this.db
      .prepare(
        `UPDATE upload_items
           SET state = 'cancelled', error = NULL, claim_token = NULL, updated_at = ?
         WHERE id = ? AND state = 'uploading' AND claim_token = ?`,
      )
      .run(now, id, token);
  }

  retry(id: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE upload_items
           SET state = 'queued', attempts = 0, bytes_sent = 0, error = NULL,
               claim_token = NULL, next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND state IN ('failed', 'cancelled')`,
      )
      .run(now, now, id);
    return result.changes > 0;
  }

  queued(now: number): StoredUploadItem[] {
    return this.db
      .prepare(
        `SELECT * FROM upload_items
         WHERE state = 'queued' AND next_attempt_at <= ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(now)
      .map((row) => toItem(row as unknown as UploadRow));
  }

  /** Earliest future retry time; due rows are driven by slot releases, not timers. */
  nextQueuedAt(after: number): number | undefined {
    const row = this.db
      .prepare(
        "SELECT MIN(next_attempt_at) AS next FROM upload_items WHERE state = 'queued' AND next_attempt_at > ?",
      )
      .get(after) as { next: number | null } | undefined;
    return row?.next === null || row?.next === undefined ? undefined : row.next;
  }

  /** Requeues rows left in `uploading` by a crash or a hard shutdown. */
  requeueUploading(): string[] {
    const ids = this.db
      .prepare("SELECT id FROM upload_items WHERE state = 'uploading' ORDER BY created_at ASC")
      .all()
      .map((row) => String((row as { id: unknown }).id));
    this.db
      .prepare(
        `UPDATE upload_items
           SET state = 'queued', bytes_sent = 0, next_attempt_at = 0,
               claim_token = NULL, updated_at = ?
         WHERE state = 'uploading'`,
      )
      .run(Date.now());
    return ids;
  }

  pendingCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM upload_items WHERE state IN ('queued', 'uploading')")
      .get() as { count: number };
    return Number(row.count);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private ensureClaimTokenColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(upload_items)').all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === 'claim_token')) {
      this.db.exec('ALTER TABLE upload_items ADD COLUMN claim_token TEXT');
    }
  }
}

export function toUploadItem(item: StoredUploadItem): UploadItem {
  return {
    id: item.id,
    photoId: item.photoId,
    destinationId: item.destinationId,
    localPath: item.localPath,
    remotePath: item.remotePath,
    state: item.state,
    bytesSent: item.bytesSent,
    bytesTotal: item.bytesTotal,
    attempts: item.attempts,
    ...(item.error === undefined ? {} : { error: item.error }),
  };
}

function toItem(row: UploadRow): StoredUploadItem {
  return {
    id: asUploadId(row.id),
    photoId: asPhotoId(row.photo_id),
    destinationId: asDestinationId(row.destination_id),
    destination: JSON.parse(row.destination_json) as Destination,
    localPath: row.local_path,
    remotePath: row.remote_path,
    state: row.state as UploadItemState,
    bytesSent: Number(row.bytes_sent),
    bytesTotal: Number(row.bytes_total),
    attempts: Number(row.attempts),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.claim_token === null ? {} : { claimToken: row.claim_token }),
    nextAttemptAt: Number(row.next_attempt_at),
  };
}
