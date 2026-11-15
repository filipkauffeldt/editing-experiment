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
import { ExportError, isNonRetryableUploadError } from '../errors';
import { createPathTemplateContext, resolveExpandPathTemplate, type ExportHooks } from '../hooks';
import {
  createConnector,
  getDestinationSecret,
  testDestination as probeDestination,
} from './connectors';
import { connectionOutage, outageReason, type ConnectionOutage } from './outage';
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
  /** Attempts per item before it is marked failed. A connection outage does not count. Default 5. */
  maxAttempts?: number;
  /** First retry or outage-probe delay; doubles per failure. Default 1000 ms. */
  retryBaseDelayMs?: number;
  /** Longest wait between outage probes. Default 30 000 ms. */
  retryMaxDelayMs?: number;
  /** Injectable connector registry (tests, future destination kinds). */
  connectorFactory?: ConnectorFactory;
  /** Clock override for tests. */
  now?: () => number;
}

interface ActiveUpload {
  controller: AbortController;
  destinationId: string;
  claimToken: string;
  promise: Promise<void>;
}

/** A destination that could not be reached, remembered for this session only. */
interface DestinationOutage {
  reason: string;
  kind: ConnectionOutage;
  /** One probe goes out at this time; every other row of the destination stays put. */
  nextProbeAt: number;
  /** Consecutive failed probes, which grow the wait between them. */
  probes: number;
  /** Claim token of the probe that is currently testing the connection, if any. */
  probeClaim?: string;
}

/**
 * Durable, per-destination-limited upload queue.
 *
 * Rows are written before a transfer starts, progress is persisted, and rows
 * left `uploading` by a crash are requeued when a queue is reopened.
 *
 * A connection outage (the destination cannot be reached) parks the item and
 * the rest of its destination as `waiting` instead of using up an attempt. One
 * probe at a time tests whether the connection is back; other destinations
 * keep sending.
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
  /** Time of the latest scan for due rows; the retry timer must pick up where that scan stopped. */
  private lastScanAt: number | undefined;
  private readonly active = new Map<string, ActiveUpload>();
  private readonly activePerDestination = new Map<string, number>();
  private readonly outages = new Map<string, DestinationOutage>();
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
    const items: StoredUploadItem[] = prepared.map(({ destination, remotePath }) => {
      // A destination that is down keeps a new file waiting with the rest of its queue.
      const outage = this.outages.get(destination.id);
      return {
        id: asUploadId(randomUUID()),
        photoId,
        destinationId: destination.id,
        destination,
        localPath,
        remotePath,
        state: outage === undefined ? 'queued' : 'waiting',
        bytesSent: 0,
        bytesTotal: fileInfo.size,
        attempts: 0,
        nextAttemptAt: outage === undefined ? now : Math.max(now, outage.nextProbeAt),
        ...(outage === undefined ? {} : { error: outage.reason }),
      };
    });

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
    if (this.active.has(id)) {
      throw new ExportError('upload_invalid_state', `Upload ${id} is still in progress`);
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
    // Nothing left to probe for: the next export to that destination may try at once.
    if (this.store.pendingForDestination(item.destinationId) === 0) {
      this.outages.delete(item.destinationId);
    }
    this.pump();
    this.notifyIfIdle();
  }

  /** Probes a destination, scrubbing credentials from failures. */
  testDestination(destination: Destination): Promise<DestinationTestResult> {
    return probeDestination(destination, this.hooks, this.connectorFactory);
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
        this.lastScanAt = now;
        // Destinations already down: only their oldest row probes, once per wait.
        const probed = new Set<string>();
        for (const item of this.store.due(now)) {
          if (this.active.has(item.id)) continue;
          const active = this.activePerDestination.get(item.destinationId) ?? 0;
          if (active >= this.concurrency) continue;
          const outage = this.outages.get(item.destinationId);
          let probing = false;
          if (outage !== undefined) {
            if (active > 0 || probed.has(item.destinationId)) continue;
            if (now < outage.nextProbeAt) continue;
            probed.add(item.destinationId);
            probing = true;
          }
          const claimToken = randomUUID();
          if (!this.store.claim(item.id, claimToken, now)) continue;
          if (probing && outage !== undefined) outage.probeClaim = claimToken;

          const controller = new AbortController();
          this.activePerDestination.set(
            item.destinationId,
            (this.activePerDestination.get(item.destinationId) ?? 0) + 1,
          );
          const promise = this.runItem(item, controller, claimToken).finally(() => {
            const active = this.active.get(item.id);
            if (active?.claimToken !== claimToken) return;
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
            claimToken,
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

  private async runItem(
    item: StoredUploadItem,
    controller: AbortController,
    claimToken: string,
  ): Promise<void> {
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
        this.store.setProgress(item.id, claimToken, sent, now);
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
        uploadId: item.id,
        claimToken,
        localPath: item.localPath,
        remotePath: item.remotePath,
        bytesTotal: item.bytesTotal,
        secret,
        signal: controller.signal,
        report,
      });

      if (this.closed) return;
      const current = this.store.get(item.id);
      if (current === undefined || !ownsRun(current, claimToken)) return;

      const now = this.now();
      this.store.markDone(item.id, claimToken, item.bytesTotal, now);
      const updated = this.store.get(item.id);
      if (updated !== undefined) this.emitState(updated, now);
      this.recoverDestination(item.destinationId);
    } catch (error) {
      if (this.closed) return;

      const current = this.store.get(item.id);
      if (current === undefined || !ownsRun(current, claimToken)) return;

      if (controller.signal.aborted) {
        this.store.markCancelledForClaim(item.id, claimToken, this.now());
        const updated = this.store.get(item.id);
        if (updated !== undefined) this.emitState(updated, this.now());
        return;
      }

      const outage = connectionOutage(error);
      if (outage !== undefined) {
        this.enterOutage(item, claimToken, outage);
        return;
      }

      // The destination answered this time, whatever it said: the outage is over
      // for the other rows, which may now take their turn.
      this.recoverDestination(item.destinationId);

      const message = safeErrorMessage(error, secret, [
        item.destination.kind === 'folder' ? undefined : item.destination.username,
      ]);
      const now = this.now();
      if (isNonRetryableUploadError(error) || current.attempts >= this.maxAttempts) {
        this.store.markFailed(item.id, claimToken, message, now);
        const updated = this.store.get(item.id);
        if (updated !== undefined) this.emitState(updated, now);
        return;
      }

      const delay = Math.min(
        this.retryBaseDelayMs * 2 ** Math.max(0, current.attempts - 1),
        this.retryMaxDelayMs,
      );
      this.store.scheduleRetry(item.id, claimToken, now + delay, now);
      const updated = this.store.get(item.id);
      if (updated !== undefined) this.emitState(updated, now);
      this.scheduleRetryTimer();
    }
  }

  /**
   * Parks the failed row and the rest of its destination until the next probe.
   * The wait doubles per failed probe and stops at `retryMaxDelayMs`. A
   * transfer that was already running when the outage started is not a probe,
   * so two concurrent failures still count as one failed probe.
   */
  private enterOutage(item: StoredUploadItem, claimToken: string, kind: ConnectionOutage): void {
    const now = this.now();
    const previous = this.outages.get(item.destinationId);
    const isProbe = previous === undefined || previous.probeClaim === claimToken;
    const probes = isProbe ? (previous?.probes ?? 0) + 1 : (previous?.probes ?? 0);
    const delay = Math.min(
      this.retryBaseDelayMs * 2 ** Math.max(0, probes - 1),
      this.retryMaxDelayMs,
    );
    const nextProbeAt = isProbe ? now + delay : (previous?.nextProbeAt ?? now + delay);
    const reason = outageReason(kind);
    this.outages.set(item.destinationId, {
      kind,
      reason,
      nextProbeAt,
      probes,
      ...(isProbe ? {} : { probeClaim: previous?.probeClaim }),
    });
    // The other rows are still `queued` or `waiting`, so they are parked first;
    // the row that just failed is still `uploading` and becomes `waiting` after.
    const parked = this.store.markDestinationWaiting(item.destinationId, reason, nextProbeAt, now);
    this.store.markWaiting(item.id, claimToken, reason, nextProbeAt, now);
    this.emitStates(parked, now);
    const updated = this.store.get(item.id);
    if (updated !== undefined) this.emitState(updated, now);
    this.scheduleRetryTimer();
  }

  /** The destination answered again: put its waiting rows back in line, oldest first. */
  private recoverDestination(destinationId: string): void {
    if (!this.outages.delete(destinationId)) return;
    const now = this.now();
    this.emitStates(this.store.releaseWaiting(destinationId, now), now);
  }

  private emitStates(ids: readonly string[], at: number): void {
    for (const id of ids) {
      const item = this.store.get(id);
      if (item !== undefined) this.emitState(item, at);
    }
  }

  private scheduleRetryTimer(): void {
    this.clearRetryTimer();
    if (!this.started || this.closed) return;
    // Rows that became due after the last scan but before this call must get a timer
    // (with a zero delay). Looking them up from the current time would skip them, and
    // nothing else would ever wake the queue for them.
    const next = this.store.nextDueAt(this.lastScanAt ?? this.now());
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

function ownsRun(item: StoredUploadItem, claimToken: string): boolean {
  return item.state === 'uploading' && item.claimToken === claimToken;
}
