import { IpcError } from '@ee/contracts';
import type { EventChannel, InvokeChannel } from '@ee/contracts';
import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import type { JobsInvokeMessage, JobsOutgoingMessage } from '../shared/jobs-protocol';

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** Main-side handle on the "jobs" utility process: request/response plus event forwarding. */
export class JobsClient {
  private readonly child: UtilityProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exited = false;

  constructor(
    private readonly onEvent: (channel: EventChannel, payload: unknown) => void,
    options: { mock: boolean; appVersion: string },
  ) {
    this.child = utilityProcess.fork(join(import.meta.dirname, 'jobs.js'), [], {
      serviceName: 'ee-jobs',
      stdio: 'inherit',
      env: {
        ...process.env,
        EE_MOCK: options.mock ? '1' : '',
        EE_APP_VERSION: options.appVersion,
      },
    });
    this.child.on('message', (message: JobsOutgoingMessage) => this.receive(message));
    this.child.on('exit', (code) => {
      this.exited = true;
      const error = new IpcError('internal', `jobs process exited with code ${code}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  /** Run a channel handler in the jobs process. Rejects with an {@link IpcError}. */
  async invoke(channel: InvokeChannel, args: unknown[]): Promise<unknown> {
    if (this.exited) throw new IpcError('internal', 'jobs process is not running');
    const id = this.nextId++;
    const reply = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    const message: JobsInvokeMessage = { kind: 'invoke', id, channel, args };
    this.child.postMessage(message);
    return reply;
  }

  stop(): void {
    this.child.kill();
  }

  private receive(message: JobsOutgoingMessage): void {
    if (message.kind === 'event') {
      this.onEvent(message.channel, message.payload);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.result.ok) pending.resolve(message.result.value);
    else pending.reject(new IpcError(message.result.error.code, message.result.error.message));
  }
}
