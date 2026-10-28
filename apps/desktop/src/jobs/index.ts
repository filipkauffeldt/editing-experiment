import {
  IpcError,
  toIpcResult,
  type EventChannel,
  type InvokeChannel,
  type IpcHandlers,
} from '@ee/contracts';
import type { JobsIncomingMessage, JobsOutgoingMessage } from '../shared/jobs-protocol';
import { createSecretClient, electronSecretPort, type SecretPort } from '../shared/secret-port';
import { createBackend, type Backend } from './backend/backend';
import { createJobsHandlers } from './handlers';

/**
 * Entry of the "jobs" utility process: ingest, metadata, export encode and the
 * upload queue run here so the main process stays responsive. It serves the
 * channels routed to `jobs` (see `shared/routing.ts`) over `parentPort`.
 *
 * Mock mode (`EE_MOCK=1`) serves generated data; otherwise the real backend runs
 * against the Electron `userData` directory.
 */
const parentPort = process.parentPort;
const send = (message: JobsOutgoingMessage): void => parentPort.postMessage(message);
const emit = (channel: EventChannel, payload: unknown): void =>
  send({ kind: 'event', channel, payload });

const mock = process.env.EE_MOCK === '1';
const appVersion = process.env.EE_APP_VERSION ?? '0.0.0';

// Main delivers the secrets port right after starting this process.
let deliverSecretPort: (port: SecretPort) => void = () => {};
const secretPort = new Promise<SecretPort>((resolve) => {
  deliverSecretPort = resolve;
});

let backend: Promise<Backend> | undefined;
let mockHandlers: Partial<IpcHandlers> | undefined;
if (mock) {
  mockHandlers = createJobsHandlers({ mock, appVersion, emit, simulate: true });
} else {
  const userDataDir = process.env.EE_USER_DATA_DIR;
  backend = userDataDir
    ? createBackend({ userDataDir, appVersion, emit, getSecret: createSecretClient(secretPort) })
    : Promise.reject(new Error('EE_USER_DATA_DIR is not set'));
  // Surface a failed start on every request instead of as an unhandled rejection.
  backend.catch((error: unknown) => console.error('jobs backend failed to start:', error));
}

async function handlersFor(): Promise<Partial<IpcHandlers>> {
  if (mockHandlers) return mockHandlers;
  try {
    return (await backend!).handlers;
  } catch (error) {
    throw new IpcError('internal', `jobs backend failed to start: ${(error as Error).message}`);
  }
}

parentPort.on(
  'message',
  ({ data, ports }: { data: JobsIncomingMessage; ports: Electron.MessagePortMain[] }) => {
    switch (data.kind) {
      case 'secret-port': {
        const [port] = ports;
        if (port) deliverSecretPort(electronSecretPort(port));
        return;
      }
      case 'invoke': {
        void toIpcResult(async () => {
          const handler = (await handlersFor())[data.channel as InvokeChannel] as
            ((...args: unknown[]) => Promise<unknown>) | undefined;
          if (!handler) {
            throw new IpcError('not_implemented', `${data.channel} is not implemented yet`);
          }
          return handler(...data.args);
        }).then((result) => send({ kind: 'result', id: data.id, result }));
        return;
      }
      case 'app-request': {
        void (async () => {
          const response = await (
            await backend!
          )
            .resolveAppRequest(data.url)
            .catch((error: unknown) => ({
              status: 500,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
              body: error instanceof Error ? error.message : String(error),
            }));
          send({ kind: 'app-result', id: data.id, response });
        })();
        return;
      }
      case 'shutdown': {
        void (async () => {
          try {
            await (await backend)?.dispose();
          } finally {
            process.exit(0);
          }
        })();
        return;
      }
    }
  },
);
