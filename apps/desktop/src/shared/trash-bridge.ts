import { isAbsolute } from 'node:path';
import type { JobsTrashRequestMessage, JobsTrashResultMessage } from './jobs-protocol';

const DEFAULT_TIMEOUT_MS = 2 * 60_000;

interface Pending {
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Jobs side of "move this file to the trash": Electron's `shell.trashItem` only exists in the
 * main process, so a request goes up and the answer comes back by id. It rejects when main
 * could not trash the file, and when main does not answer in time (the file may still be
 * trashed later; the photo deleter treats a file that is gone as done on the next try).
 */
export class TrashBridge {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(
    private readonly send: (message: JobsTrashRequestMessage) => void,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  trash(path: string): Promise<void> {
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A code of its own, so the photo deleter does not retry a request that may still run.
        reject(
          Object.assign(new Error('the system trash did not answer in time'), {
            code: 'ETIMEDOUT',
          }),
        );
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ kind: 'trash-request', id, path });
    });
  }

  handleResult(message: JobsTrashResultMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error === undefined) pending.resolve();
    else pending.reject(new Error(message.error));
  }
}

/**
 * Main side: run one request through `trash` (Electron's `shell.trashItem`) and build the
 * answer. A relative path is refused rather than resolved against whatever main's working
 * directory is; there is no other check here because the jobs process is trusted code that took
 * the path from its own index and already refused anything outside the ingest destination.
 */
export async function serveTrashRequest(
  request: JobsTrashRequestMessage,
  trash: (path: string) => Promise<void>,
): Promise<JobsTrashResultMessage> {
  try {
    if (!isAbsolute(request.path)) throw new Error('only absolute paths can be trashed');
    await trash(request.path);
    return { kind: 'trash-result', id: request.id };
  } catch (error) {
    return {
      kind: 'trash-result',
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
