import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  asUploadId,
  type CredentialSecret,
  type Destination,
  type PhotoId,
  type UploadId,
  type UploadItem,
} from '@ee/contracts';
import { ExportError } from '../errors';
import { createPathTemplateContext, resolveExpandPathTemplate, type ExportHooks } from '../hooks';
import {
  createConnector,
  getDestinationSecret,
  testDestination as probeDestination,
} from './connectors';
import { normalizeRemotePath, resolveFolderDestinationPath } from './paths';
import { JobEventEmitter } from './events';
import { safeErrorMessage } from './redact';
import { toUploadItem, UploadStore } from './store';
import type { ConnectorFactory, DestinationTestResult, StoredUploadItem } from './types';

export interface UploadQueueOptions {
  /** SQLite file or `:memory:`. */
  dbPath: string;
  hooks?: ExportHooks;
  /** Parallel transfers per destination. Default 2. */
  concurrencyPerDestination?: number;
  /** Attempts per item before it is marked failed. Default 5. */
  maxAttempts?: number;
  /** First retry delay; doubles per attempt. Default 1000 ms. */
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Injectable connector registry (tests, future destination kinds). */
  connectorFactory?: ConnectorFactory;
  /** Clock override for tests. */
  now?: () => number;
}

interface ActiveUpload {
  controller: AbortController;
  destinationId: string;
  promise: Promise<void>;
}

/**
 * Durable, per-destination-limited upload queue.
 *
 * Rows are written before a transfer starts, progress is persisted, and rows
 * left `uploading` by a crash are requeued when a queue is reopened.
 */
export class UploadQueue {
  readonly events = new JobEventEmitter();

  private readonly store: UploadStore;
  private readonly hooks: ExportHooks | undefined;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly connectorFactory: ConnectorFactory;
  private readonly now: () => number;

  private started = false;
  private closed = false;
  private pumping = false;
  private repump = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly active = new Map<string, ActiveUpload>();
  private readonly activePerDestination = new Map<string, number>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: UploadQueueOptions) {
    this.store = new UploadStore(options.dbPath);
    this.hooks = options.hooks;
    this.concurrency = Math.max(1, options.concurrencyPerDestination ?? 2);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 1_000);
    this.retryMaxDelayMs = Math.max(this.retryBaseDelayMs, options.retryMaxDelayMs ?? 30_000);
    this.connectorFactory = options.connectorFactory ?? createConnector;
    this.now = options.now ?? Date.now;
  }

  /** Starts processing queued rows. Idempotent. */
  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.pump();
  }

  /** Pauses scheduling; in-flight transfers finish normally. */
  stop(): void {
    this.started = false;
    this.clearRetryTimer();
  }

  /**
   * Adds one row per destination. Remote paths are expanded here so later
   * template changes do not move a file that is already queued.
   */
  async enqueue(
    photoId: PhotoId,
    localPath: string,
    destinations: Destination[],
  ): Promise<UploadItem[]> {
    if (this.closed) throw new ExportError('upload_invalid_state', 'Upload queue is closed');
    if (destinations.length === 0) return [];

    const fileInfo = await stat(localPath);
    if (!fileInfo.isFile()) {
      throw new ExportError('invalid_path', `Not a file: ${localPath}`);
    }

    const expand = resolveExpandPathTemplate(this.hooks);
    const baseContext = createPathTemplateContext(
      basename(localPath),
      photoId,
      new Date(this.now()),
    );
    const prepared = destinations.map((destination) => {
      const remotePath = expand(destination.remotePathTemplate, {
        ...baseContext,
        destinationId: destination.id,
        destinationName: destination.name,
      });
      // Validate before inserting anything so a bad template cannot leave a
      // partially enqueued photo.
      const normalized =
        destination.kind === 'folder'
          ? resolveFolderDestinationPath(destination.path, remotePath)
          : normalizeRemotePath(remotePath);
      return { destination, remotePath: destination.kind === 'folder' ? remotePath : normalized };
    });

    const now = this.now();
    const items: StoredUploadItem[] = prepared.map(({ destination, remotePath }) => ({
      id: asUploadId(randomUUID()),
      photoId,
      destinationId: destination.id,
      destination,
      localPath,
      remotePath,
      state: 'queued',
      bytesSent: 0,
      bytesTotal: fileInfo.size,
      attempts: 0,
      nextAttemptAt: now,
    }));

    for (const item of items) this.store.insert(item, now);
    for (const item of items) this.emitState(item, now);
    this.pump();
    return items.map(toUploadItem);
  }

  list(): UploadItem[] {
    return this.store.list().map(toUploadItem);
  }

  /** Requeues a failed or cancelled item, resetting its attempt counter. */
  retry(id: UploadId): void {
    const item = this.store.get(id);
    if (item === undefined) {
      throw new ExportError('upload_not_found', `Upload ${id} does not exist`);
    }
    if (item.state === 'done') {
      throw new ExportError('upload_invalid_state', `Upload ${id} has already completed`);
    }
    if (item.state !== 'failed' && item.state !== 'cancelled') return;

    this.store.retry(id, this.now());
    const updated = this.store.get(id);
    if (updated !== undefined) this.emitState(updated, this.now());
    this.pump();
  }

  /** Cancels a queued or in-flight item. Idempotent for terminal states. */
  cancel(id: UploadId): void {
    const item = this.store.get(id);
    if (item === undefined) {
      throw new ExportError('upload_not_found', `Upload ${id} does not exist`);
    }
    if (item.state === 'done' || item.state === 'cancelled') return;

    const changed = this.store.markCancelled(id, this.now());
    this.active.get(id)?.controller.abort();
    if (changed) {
      const updated = this.store.get(id);
      if (updated !== undefined) this.emitState(updated, this.now());
    }
    this.notifyIfIdle();
  }

  /** Probes a destination, scrubbing credentials from failures. */
  testDestination(destination: Destination): Promise<DestinationTestResult> {
    return probeDestination(destination, this.hooks);
  }

  /** Resolves when no queued or uploading rows remain. */
  waitForIdle(timeoutMs = 30_000): Promise<void> {
    if (this.store.pendingCount() === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.idleWaiters.delete(waiter);
        resolve();
      };
      this.idleWaiters.add(waiter);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.idleWaiters.delete(waiter);
          reject(new Error(`Upload queue did not become idle within ${timeoutMs} ms`));
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }

  /**
   * Stops scheduling, aborts in-flight transfers and closes the database.
   * Aborted rows stay `uploading` on disk so reopening requeues them; this is
   * the same path a crash takes.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.clearRetryTimer();

    const active = [...this.active.values()];
    for (const upload of active) upload.controller.abort();
    await Promise.allSettled(active.map((upload) => upload.promise));

    this.resolveIdleWaiters();
    this.store.close();
  }

  private pump(): void {
    if (!this.started || this.closed) return;
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      let progressed = true;
      while (progressed && this.started && !this.closed) {
        progressed = false;
        const now = this.now();
        for (const item of this.store.queued(now)) {
          if ((this.activePerDestination.get(item.destinationId) ?? 0) >= this.concurrency) {
            continue;
          }
          if (!this.store.claim(item.id, now)) continue;

          const controller = new AbortController();
          this.activePerDestination.set(
            item.destinationId,
            (this.activePerDestination.get(item.destinationId) ?? 0) + 1,
          );
          const promise = this.runItem(item, controller).finally(() => {
            this.active.delete(item.id);
            const remaining = (this.activePerDestination.get(item.destinationId) ?? 1) - 1;
            if (remaining <= 0) this.activePerDestination.delete(item.destinationId);
            else this.activePerDestination.set(item.destinationId, remaining);
            this.notifyIfIdle();
            this.pump();
          });
          this.active.set(item.id, {
            controller,
            destinationId: item.destinationId,
            promise,
          });
          this.emitState(
            { ...item, state: 'uploading', attempts: item.attempts + 1, error: undefined },
            now,
          );
          progressed = true;
        }
      }
    } finally {
      this.pumping = false;
    }

    if (this.repump) {
      this.repump = false;
      queueMicrotask(() => this.pump());
    }
    this.scheduleRetryTimer();
    this.notifyIfIdle();
  }

  private async runItem(item: StoredUploadItem, controller: AbortController): Promise<void> {
    let secret: CredentialSecret = {};
    let lastSent = -1;
    let lastPersisted = 0;
    let lastEmitted = 0;

    const report = (bytesSent: number): void => {
      const sent = Math.max(0, Math.min(Math.floor(bytesSent), item.bytesTotal));
      if (sent === lastSent) return;
      lastSent = sent;
      const now = this.now();
      if (
        sent === item.bytesTotal ||
        sent - lastPersisted >= Math.max(1, Math.floor(item.bytesTotal / 20)) ||
        now - lastEmitted >= 100
      ) {
        lastPersisted = sent;
        lastEmitted = now;
        this.store.setProgress(item.id, sent, now);
        this.events.emit({
          type: 'upload.progress',
          at: now,
          uploadId: item.id,
          photoId: item.photoId,
          destinationId: item.destinationId,
          bytesSent: sent,
          bytesTotal: item.bytesTotal,
        });
      }
    };

    try {
      secret = await getDestinationSecret(item.destination, this.hooks);
      if (controller.signal.aborted) throw new Error('aborted');

      const connector = this.connectorFactory(item.destination);
      await connector.upload({
        destination: item.destination,
        localPath: item.localPath,
        remotePath: item.remotePath,
        bytesTotal: item.bytesTotal,
        secret,
        signal: controller.signal,
        report,
      });

      if (this.closed) return;
      const current = this.store.get(item.id);
      if (current === undefined || current.state !== 'uploading') return;

      const now = this.now();
      this.store.markDone(item.id, item.bytesTotal, now);
      const updated = this.store.get(item.id);
      if (updated !== undefined) this.emitState(updated, now);
    } catch (error) {
      if (this.closed) return;

      const current = this.store.get(item.id);
      if (current === undefined || current.state !== 'uploading') return;

      if (controller.signal.aborted) {
        this.store.markCancelled(item.id, this.now());
        const updated = this.store.get(item.id);
        if (updated !== undefined) this.emitState(updated, this.now());
        return;
      }

      const message = safeErrorMessage(error, secret, [
        item.destination.kind === 'folder' ? undefined : item.destination.username,
      ]);
      const now = this.now();
      if (current.attempts >= this.maxAttempts) {
        this.store.markFailed(item.id, message, now);
        const updated = this.store.get(item.id);
        if (updated !== undefined) this.emitState(updated, now);
        return;
      }

      const delay = Math.min(
        this.retryBaseDelayMs * 2 ** Math.max(0, current.attempts - 1),
        this.retryMaxDelayMs,
      );
      this.store.scheduleRetry(item.id, now + delay, now);
      const updated = this.store.get(item.id);
      if (updated !== undefined) this.emitState(updated, now);
      this.scheduleRetryTimer();
    }
  }

  private scheduleRetryTimer(): void {
    this.clearRetryTimer();
    if (!this.started || this.closed) return;
    const next = this.store.nextQueuedAt();
    if (next === undefined) return;
    const delay = Math.max(0, next - this.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.pump();
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private notifyIfIdle(): void {
    if (this.closed || this.store.pendingCount() !== 0) return;
    this.resolveIdleWaiters();
  }

  private resolveIdleWaiters(): void {
    for (const waiter of [...this.idleWaiters]) waiter();
  }

  private emitState(item: StoredUploadItem, at: number): void {
    this.events.emit({
      type: 'upload.state',
      at,
      uploadId: item.id,
      photoId: item.photoId,
      destinationId: item.destinationId,
      state: item.state,
      ...(item.error === undefined ? {} : { error: item.error }),
    });
  }
}
