import { IpcError } from '@ee/contracts';
import type { EventChannel, InvokeChannel } from '@ee/contracts';
import { utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import type {
  AppBackendResponse,
  JobsAppRequestMessage,
  JobsIncomingMessage,
  JobsInvokeMessage,
  JobsOutgoingMessage,
  JobsSecretPortMessage,
  JobsShutdownMessage,
} from '../shared/jobs-protocol';

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
  private readonly exitWaiters: (() => void)[] = [];

  constructor(
    private readonly onEvent: (channel: EventChannel, payload: unknown) => void,
    options: { mock: boolean; appVersion: string; userDataDir: string },
  ) {
    this.child = utilityProcess.fork(join(import.meta.dirname, 'jobs.js'), [], {
      serviceName: 'ee-jobs',
      stdio: 'inherit',
      env: {
        ...process.env,
        EE_MOCK: options.mock ? '1' : '',
        EE_APP_VERSION: options.appVersion,
        EE_USER_DATA_DIR: options.userDataDir,
      },
    });
    this.child.on('message', (message: JobsOutgoingMessage) => this.receive(message));
    this.child.on('exit', (code) => {
      this.exited = true;
      const error = new IpcError('internal', `jobs process exited with code ${code}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      for (const waiter of this.exitWaiters.splice(0)) waiter();
    });
  }

  /** Run a channel handler in the jobs process. Rejects with an {@link IpcError}. */
  async invoke(channel: InvokeChannel, args: unknown[]): Promise<unknown> {
    const message: JobsInvokeMessage = { kind: 'invoke', id: this.nextId++, channel, args };
    return this.request(message);
  }

  /** Have the jobs process answer an `app://` request. */
  async resolveApp(url: string): Promise<AppBackendResponse> {
    const message: JobsAppRequestMessage = { kind: 'app-request', id: this.nextId++, url };
    return (await this.request(message)) as AppBackendResponse;
  }

  /** Give the jobs process its end of the private secrets channel. */
  sendSecretPort(port: MessagePortMain): void {
    const message: JobsSecretPortMessage = { kind: 'secret-port' };
    this.child.postMessage(message satisfies JobsIncomingMessage, [port]);
  }

  /**
   * Ask the jobs process to close its services (ExifTool, upload queue, databases)
   * and exit; kill it if it has not done so within `timeoutMs`.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    const message: JobsShutdownMessage = { kind: 'shutdown' };
    this.child.postMessage(message satisfies JobsIncomingMessage);
    const timer = setTimeout(() => this.child.kill(), timeoutMs);
    await exited;
    clearTimeout(timer);
  }

  private request(message: JobsInvokeMessage | JobsAppRequestMessage): Promise<unknown> {
    if (this.exited) return Promise.reject(new IpcError('internal', 'jobs process is not running'));
    const reply = new Promise<unknown>((resolve, reject) =>
      this.pending.set(message.id, { resolve, reject }),
    );
    this.child.postMessage(message satisfies JobsIncomingMessage);
    return reply;
  }

  private receive(message: JobsOutgoingMessage): void {
    if (message.kind === 'event') {
      this.onEvent(message.channel, message.payload);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.kind === 'app-result') {
      pending.resolve(message.response);
      return;
    }
    if (message.result.ok) pending.resolve(message.result.value);
    else pending.reject(new IpcError(message.result.error.code, message.result.error.message));
  }
}
