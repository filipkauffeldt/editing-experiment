import { IpcError } from '@ee/contracts';
import type { EventChannel, InvokeChannel } from '@ee/contracts';
import { utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { RestartPolicy, type RestartPolicyOptions } from './restart-policy';
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

export interface JobsClientOptions {
  mock: boolean;
  appVersion: string;
  userDataDir: string;
  /**
   * Called after every start of the process, including restarts, so the owner can
   * hand it things that die with it (the secrets port).
   */
  onStart?: (client: JobsClient) => void;
  restart?: RestartPolicyOptions;
}

/**
 * Main-side handle on the "jobs" utility process: request/response plus event
 * forwarding. If the process dies unexpectedly it is started again (with
 * backoff, and not at all after repeated crashes); requests that were in flight
 * fail, later ones wait for the new process.
 */
export class JobsClient {
  private child!: UtilityProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly policy: RestartPolicy;
  private nextId = 1;
  private exited = false;
  private shuttingDown = false;
  private gaveUp = false;
  /** Resolves when the process is up; replaced while a restart is pending. */
  private ready: Promise<void> = Promise.resolve();
  private readonly exitWaiters: (() => void)[] = [];

  constructor(
    private readonly onEvent: (channel: EventChannel, payload: unknown) => void,
    private readonly options: JobsClientOptions,
  ) {
    this.policy = new RestartPolicy(options.restart);
    this.start();
  }

  private start(): void {
    this.exited = false;
    const child = utilityProcess.fork(join(import.meta.dirname, 'jobs.js'), [], {
      serviceName: 'ee-jobs',
      stdio: 'inherit',
      env: {
        ...process.env,
        EE_MOCK: this.options.mock ? '1' : '',
        EE_APP_VERSION: this.options.appVersion,
        EE_USER_DATA_DIR: this.options.userDataDir,
      },
    });
    this.child = child;
    child.on('message', (message: JobsOutgoingMessage) => this.receive(message));
    child.on('exit', (code) => this.handleExit(child, code));
    this.options.onStart?.(this);
  }

  private handleExit(child: UtilityProcess, code: number): void {
    if (child !== this.child) return;
    this.exited = true;
    const error = new IpcError('internal', `jobs process exited with code ${code}`);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.exitWaiters.splice(0)) waiter();
    if (this.shuttingDown) return;

    const delay = this.policy.onCrash(Date.now());
    if (delay === undefined) {
      this.gaveUp = true;
      this.report('The background process keeps crashing and was not restarted. Restart the app.');
      return;
    }
    this.report(
      `The background process stopped unexpectedly (exit code ${code}) and is restarting. ` +
        'Running ingests and uploads were interrupted.',
    );
    this.ready = new Promise<void>((resolve) =>
      setTimeout(() => {
        if (!this.shuttingDown) this.start();
        resolve();
      }, delay),
    );
  }

  private report(message: string): void {
    this.onEvent('jobs:event', { type: 'job.error', at: Date.now(), scope: 'jobs', message });
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
   * and exit; kill it if it has not done so within `timeoutMs`. No restart follows.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    this.shuttingDown = true;
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    const message: JobsShutdownMessage = { kind: 'shutdown' };
    this.child.postMessage(message satisfies JobsIncomingMessage);
    const timer = setTimeout(() => this.child.kill(), timeoutMs);
    await exited;
    clearTimeout(timer);
  }

  /** Test hook: pid of the current jobs process. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  private async request(message: JobsInvokeMessage | JobsAppRequestMessage): Promise<unknown> {
    if (this.gaveUp) throw new IpcError('internal', 'jobs process is not running');
    await this.ready;
    if (this.exited) throw new IpcError('internal', 'jobs process is not running');
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
